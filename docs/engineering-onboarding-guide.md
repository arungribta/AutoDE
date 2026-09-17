# AutoDE — Engineering Mental Model & Onboarding Guide

> **Audience:** A newly hired AI/Data Engineer joining the AutoDE team.
> **Goal:** Give you enough of a mental model to navigate, debug, extend, and operate AutoDE without tribal knowledge.
> **Status of this doc:** Updated 2026-09-16 against the codebase through `docs/requirements.md` §8.12 / `docs/technical-design.md` v0.13.0 (lifecycle orchestration + multi-business-problem workspace). Previously reverse-engineered at commit `9a6b672` (v0.8.0) and left unrevised through v0.9.0–v0.12.0 — this pass corrects the accumulated drift; anything the reviser was not fully certain about is marked **⚠ FLAG FOR REVIEW** inline rather than silently asserted. Where the code and the docs disagree, this guide follows the **code** and calls out the difference.
> **Legend:** 🟩 = implemented & wired · 🟨 = partial / stubbed · 🟥 = declared but not implemented · 💡 = assumption/inference (not stated anywhere, deduced from code) · ⚠ = flagged for author review (see below).

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Repository Overview](#2-repository-overview)
3. [Directory Breakdown](#3-directory-breakdown)
4. [System Architecture](#4-system-architecture)
5. [Runtime Execution Flows](#5-runtime-execution-flows)
6. [Data Flow Maps](#6-data-flow-maps)
7. [AI/ML Components](#7-aiml-components)
8. [Prompt Inventory](#8-prompt-inventory)
9. [Configuration Guide](#9-configuration-guide)
10. [Dependency Analysis](#10-dependency-analysis)
11. [Production Operations](#11-production-operations)
12. [Developer Mental Model](#12-developer-mental-model)
13. [Recommended Learning Path](#13-recommended-learning-path)
14. [Important Files to Read](#14-important-files-to-read)
15. [Knowledge Graph](#15-knowledge-graph)
16. [Risks & Technical Debt](#16-risks--technical-debt)
17. [Extension Guide](#17-extension-guide)
18. [Glossary of Domain Terms](#18-glossary-of-domain-terms)
19. [FAQ for New Engineers](#19-faq-for-new-engineers)
20. [Update Log (2026-09-16 revision)](#20-update-log-2026-09-16-revision)

---

## 1. Executive Summary

**AutoDE ("Auto Data Engineering Hub")** is a **single VS Code extension** — not a service, not a microservice mesh, not a deployed app. It runs entirely inside the VS Code Extension Host process on the engineer's laptop. There is no server, no database, no container, no cloud infrastructure of its own. Everything it persists is plain files inside the currently-open repository.

### What problem does it solve?

Data engineers spend a lot of time turning a vague business ask ("we need sales insights across product, customer and transaction data") into a concrete pipeline: discovering source schemas, designing a target model, writing DDL / dbt / ingestion code, and documenting it. AutoDE tries to **compress that loop** by:

1. Turning the natural-language ask into a **structured, versioned, reviewable Business Problem Specification (BPS)** — the "system of record" that governs everything downstream.
2. **Deterministically inferring** which workflow phases (discover → model → build → validate) the problem actually needs.
3. Using an **LLM-driven orchestrator** to decompose the objective into a dependency-ordered plan (a DAG of steps).
4. Routing each step to a **specialized sub-agent** that emits an artifact (SQL, dbt project, mapping, docs).
5. Writing those artifacts into a visible `.ai-context/artifacts/` folder in the repo, organized by phase.
6. Grounding every LLM prompt in an **Enterprise Context Layer** (`.ai-context/`) — a knowledge graph of tables, columns, business terms, rules and verified queries.

### The one-sentence mental model

> AutoDE is a **spec-driven, LLM-orchestrated code generator for data-engineering artifacts**, packaged as a provider-agnostic (Snowflake-first) VS Code extension, where the chat is the UI, the BPS is the source of truth, and everything is a file in the user's repo.

### Honest state of the system (v0.13.0)

| Area | State |
|---|---|
| Spec generation (BPS + agentic SpecOps) | 🟩 Working end-to-end, including revising an **approved** spec (v0.9.0) — full re-interview, never edited in place, always a new draft `version+1`. Since v0.13.0, a draft also carries a **Business Problem checkpoint** (`problemStatementApproved`) that must be explicitly confirmed before the full spec can be approved — see §5.2. |
| Phase inference | 🟩 Working, deterministic, unit-tested. Runs at spec-approval time (before Context Building) and scopes plan generation to the inferred phases; a separate, explicit **Stage Confirmation** gate (v0.13.0) is required before artifacts can be generated, even though the phases themselves were computed earlier — see §5.3. |
| Spec versioning & artifact traceability | 🟩 Git is the version/audit log (`.ai-context/problems/<id>/spec/` committed, as of v0.12.0) + a "🕓 History" action; artifacts are written under a durable `<specId>.v<version>` folder and flagged stale in the palette if superseded (v0.9.0, Phase B). No in-app diff/compare UI. |
| Multi-business-problem workspace | 🟩 One workspace can hold several business problems, each fully isolated under `.ai-context/problems/<id>/{spec,plan,context,artifacts}/` (v0.12.0). `.ai-context/active-problem.json` names the current one; the palette has a "Business Problem" picker (＋ New / ⇄ Switch). Source registry, the compiled Context Layer graph, and chat sessions stay shared/workspace-level. |
| Lifecycle orchestration (approval gates) | 🟩 `AgentHub` is the single enforcement point (v0.13.0) — `generatePlan()` requires an active, context-ready business problem; `executePlan()` requires two new explicit gates, **Plan Approval** and **Stage Confirmation**, neither of which existed before this pass. Closes a finding that at least 7 UI entry points (Command Palette commands, the AutoDE Dashboard panel's Quick Actions, `/plan` with no spec, re-plan buttons) could previously reach plan generation/execution without ever touching a spec or context approval. See §5.3, §16 (new entry). |
| Source & Target Context (v0.11.0) | 🟩 First-class, spec-tied, reviewed/approved objects (`TargetContextManager`/`SourceContextManager`) distinct from the older `TargetConfigManager` (a generic, workspace-level tool-preference profile). Built through a fixed Q&A (`targetContextQuestions.ts`/`sourceContextQuestions.ts`), gate `generatePlanFromSpec` server-side. Source auto-marked Not Applicable for Greenfield. |
| Chat processing feedback | 🟩 Every chat-initiated request shows one evolving pending bubble (spinner + context-derived status), updated in place by existing `logEntry` checkpoints, until the terminal response arrives; send is disabled meanwhile (v0.9.0, Phase E — frontend-only, `media/sidebar.html`). |
| Chat sessions & lifecycle | 🟩 Chat is a persisted, first-class session (`ChatSessionManager`, `.ai-context/chats/`, gitignored, workspace-level — shared across business problems), independent of BPS identity (v0.9.0, Phase F). "🗨 New Chat" archives (never silently discards) the current session, folding any in-flight interview's partial answers into the Context Layer first; `AutoDE: Chat History`/`AutoDE: Discard Chat` (Command Palette) round out the lifecycle. 🟨 No in-sidebar browse/search/tag UI yet — Command-Palette-only this pass. Context Memory curation ("distill this chat" into graph nodes) is a separate, not-yet-started concern (Phase G). |
| Tool-executing skills (`toolSkillAgent`) | 🟨 Import a Claude Agent Skill (`SKILL.md`) and run it with real tool access — implemented narrower than originally scoped (v0.9.0, Phase D). `claude`: real, verified end-to-end for Read/Grep/Glob/Edit/Write (Bash unverified); one whole-run confirmation, not per-call. `copilot`: a real `vscode.lm` tool-calling loop with true per-call approval + audit — logic correct, **not exercised against a live Copilot session**. Not native Claude Code plugin loading; not a hard OS sandbox. Not reachable from the auto-planner (explicit invocation only). See requirements.md §9a. |
| LLM orchestration + plan DAG + execution | 🟩 Working, now gated (see "Lifecycle orchestration" above) |
| LLM providers | 🟩 `copilot` (GitHub Copilot via `vscode.lm`, no key) + `claude` (the **Claude Code CLI**, headless, no key — `claudeCodeAdapter.ts` shells out to `claude -p`), plus OpenAI/Anthropic/Azure/Gemini/Ollama via `fetch`. |
| Sub-agents (7 leaf executors + 1 tool-executing skill runner) | 🟨 **Updated, v0.11.0 — no longer purely template-based.** 5 of the 7 leaf agents (`ingestionAgent`, `transformScaffoldAgent`, `dataModelerAgent`, `sttmAgent`, `architectureAgent`) now try an LLM call first (`AgentExecutionContext.callLlm` → `src/agents/llmCodegen.ts#generateWithLlm`), grounded in the task/objective/context/target environment, falling back to the original fixed templates only when no LLM is configured or the call fails (or returns an unfenced/malformed response — never shipped as artifact content). `sourceAssessmentAgent` and `snowflakeExecutor` are a different category (real I/O, not codegen). The §7.5/§16 R5 framing below ("sub-agents ignore schemaContext") is **now only partially true** — flagging for author review whether to soften that language further. |
| Context Layer (graph + YAML loading + AJV) | 🟨 In-memory (workspace-level, shared across business problems); loads authoritative files; the spec-derived layer is swapped per active business problem (v0.12.0) to prevent cross-problem leakage. Still no retriever, no embeddings, no token budgeting. |
| Data platform adapters (Snowflake / Databricks) | 🟥 **Stubs, unchanged since v0.8.0.** `connect()` validates params but opens no connection; `executeQuery()` returns `[]`. End-to-end metadata extraction does not work. ⚠ FLAG FOR REVIEW — no work landed on Phase 4 during v0.9.0–v0.13.0; confirm this is still deliberately deprioritized. |
| `snowflake-sdk` real execution | 🟥 Only `src/spokes/snowflakeExecutor.ts` imports it, with a **hardcoded username** bug (unchanged — still open, see §16 R2) |
| Vector engine / worker threads / `js-tiktoken` | 🟥 Not implemented |
| `deactivate()` cleanup | 🟥 Empty (unchanged — still open, see §16 R6) |
| Tests | 🟩 90 functional tests, all in one file (`test/functional.test.cjs`) — up from 52 at v0.8.0. Now also covers: Target/Source Context managers, multi-business-problem workspace (`ActiveProblemManager`, `problemSlug`, `resetForNewProblem`), and the v0.13.0 orchestrator gates (`generatePlan`/`generatePlanFromSpec`/`executePlan` preconditions, `approvePlan`/`confirmStages`, `PlanManager.patchGates`). |
| AutoDE Dashboard panel (`panel.html`/`panelProvider.ts`) | 🟥 **Explicitly parked, v0.13.0.** Its "📋 Generate Plan"/"🏗 Generate Artifacts" Quick Actions route through the same Command Palette commands the orchestrator gate now covers, so they're safe — but the panel's own `projectList`/`getProjects`/multi-project rendering is dead: nothing in `panelProvider.ts` ever populates it, so it always shows "No active project." Revisiting it is deliberately deferred, not forgotten — see §16 (new entry). |

**Bottom line for you:** the *spec → business-problem-confirm → phases → context → context-approve → plan → plan-approve → stages-confirm → artifact* pipeline is real, gated end-to-end, and demoable with an LLM (Copilot or Claude works with zero API key). The *live database connectivity* is still not real — that hasn't changed since v0.8.0. Most "Phase 4+" backlog work is about making the adapters real; most v0.9.0–v0.13.0 work has instead been about making the *governed lifecycle* (spec → context → plan → artifacts, and now multiple business problems within one workspace) consistent, persisted, and impossible to accidentally bypass.

---

## 2. Repository Overview

| Attribute | Value |
|---|---|
| **Project name** | `auto-data-engineering-hub` (display: "AutoDE — Data Engineering Workspace") |
| **Type** | VS Code extension (`engines.vscode ^1.90.0`), CommonJS, TypeScript 5.5, `strict` |
| **Entry point** | `dist/extension.js` ← compiled from `src/extension.ts` |
| **Build** | `tsc -p ./` (no bundler, no webpack/esbuild). `npm run compile` / `npm run watch`. |
| **Publisher** | "Arun Gribta" · MIT license · repo `github.com/arungribta/AutoDE` |
| **Runtime deps** | `ajv` (schema validation), `yaml` (parsing), `snowflake-sdk` (declared, barely used) |
| **Dev deps** | `@types/node`, `@types/vscode`, `typescript` — that's it. No ESLint config, no test framework. |
| **Total tracked files** | 92 (`git ls-files \| wc -l`, 2026-09-16); 58 TypeScript source files under `src/` (`git ls-files '*.ts'`, dist/ excluded — up from "~30" claimed at v0.8.0, which undercounted even then) |

### Target users

Data / analytics engineers who already use VS Code and (ideally) already have GitHub Copilot. Secondary: platform teams standardizing how pipelines get designed.

### Core capabilities (what a user can actually do today)

1. Describe a business problem in chat → get an **agentic requirements interview** → confirm the **Business Problem checkpoint** (v0.13.0) → get a **comprehensive BPS** written to `.ai-context/problems/<id>/spec/business-problem.yaml` (multi-business-problem workspace, v0.12.0 — a single-problem workspace before that had it at the now-superseded `.ai-context/spec/business-problem.yaml`).
2. Review/approve the BPS in the Workflow Palette → AutoDE **infers the required phases** and classifies **Greenfield vs. Brownfield**.
3. Build and approve **Source Context** (Brownfield only, or explicitly Not Applicable for Greenfield) and **Target Context** (always) — v0.11.0; both gate the next step server-side.
4. Generate an execution **plan** (DAG) constrained to the inferred phases → explicitly **approve the plan** → explicitly **confirm the applicable stages** (v0.13.0 — two new gates, neither existed before this pass).
5. **Execute** the plan → sub-agents emit artifacts (5 of 7 try an LLM call first, v0.11.0; 2 more are stubbed/real-SQL) → written to `.ai-context/problems/<id>/artifacts/0X-<phase>/`.
6. Register repo files as **context sources** (shared across business problems) → rule-based synthesis into the knowledge graph.
7. Chat, grounded in the BPS + context graph + Source/Target Context + (would-be) schema context.
8. Open generated artifacts in **custom editors** (data model, STTM, graph, profile, doc).
9. Multi-LLM: Copilot (default, no key, via `vscode.lm`) and Claude (no key, via the local **Claude Code CLI**) — plus OpenAI, Anthropic (direct API key), Azure OpenAI, Gemini, Ollama.
10. Hold **more than one business problem** in the same workspace, each fully isolated, switchable from the palette's picker (v0.12.0).

### Major technical domains involved

| Domain | Present? | Where |
|---|---|---|
| LLM orchestration | 🟩 | `src/core/agentHub.ts` |
| Agentic workflows | 🟩 | `src/core/specOps.ts`, `src/agents/**` |
| Spec-driven development | 🟩 | `src/core/phaseInference.ts`, `src/context/SpecManager.ts` |
| Knowledge graph / semantic layer | 🟨 | `src/context/GraphManager.ts` |
| RAG / retrieval | 🟥 (naive concat only) | `ContextFileManager.buildContextPrompt()` |
| Data ingestion / transformation / modeling | 🟨 (templated codegen) | `src/agents/**` |
| Metadata extraction | 🟥 (stubbed) | `src/dqm/**` |
| Fine-tuning / model serving | ❌ Not in scope | — |
| Observability | 🟥 (`console.log` + `telemetryEnabled` flag that does nothing) | — |
| API layer | ❌ (it's an extension, not a service) | — |
| UI / Frontend | 🟩 | `media/*.html` (single-file webviews) |

---

## 3. Directory Breakdown

```
AutoDE/
├── src/                         # All TypeScript source (compiles to dist/) — 58 files
│   ├── extension.ts             # ★ Activation entry point, command + provider registration
│   ├── core/                    # Orchestration, LLM, config, webview bridge, spec engine (19 files)
│   ├── context/                 # Enterprise Context Layer: graph, YAML, spec, plan, context, artifacts (12 files)
│   ├── dqm/                     # "Data Quality/Query Mgmt" — data-platform adapter layer
│   ├── agents/                  # ★ The 7 wired sub-agents (discover/model/build/validate) + llmCodegen.ts
│   ├── editors/                 # 5 custom text editors (webview-backed)
│   ├── spokes/                  # LEGACY agents — only snowflakeExecutor.ts is still wired
│   └── features/                # DEAD CODE — near-duplicate of spokes/, nothing imports it
├── media/                       # Single-file HTML webviews (no framework, no bundler)
│   ├── sidebar.html             # ★ The main "DE Agent Workspace" UI (1611 lines as of v0.13.0, up from ~980 at v0.8.0)
│   ├── panel.html               # Bottom-panel dashboard (~318 lines) — ⚠ parked/stale, see §1, §16
│   └── editors/*.html           # One HTML per custom editor
├── skills/                      # ★ 7 JSON skill definitions for the SpecOps interview
├── docs/
│   ├── requirements.md          # ★ Authoritative requirements (read §8–§8.12, §16)
│   ├── technical-design.md      # ★ Design doc (kept in closer sync since Phase C; check its top changelog for the current version)
│   ├── engineering-onboarding-guide.md   # This document
│   └── schemas/context-envelope.schema.json   # AJV schema for context objects
├── test/functional.test.cjs     # The entire test suite (runs against dist/) — 90 tests as of v0.13.0
├── .ai-context/                 # Runtime: shared context layer + per-business-problem spec/plan/context/artifacts
│   │                             #   (multi-business-problem workspace, v0.12.0 — committed except derived/, chats/)
│   ├── active-problem.json      # Pointer naming the currently active business problem (absent = none active)
│   ├── sources.yaml             # Registered context source files — SHARED across all business problems
│   ├── context/                 # Authoritative business-context.yaml / verified-queries.yaml — SHARED
│   ├── derived/graph.json       # Compiled graph snapshot — SHARED, gitignored
│   ├── chats/                   # Chat sessions — SHARED, gitignored
│   └── problems/<id>/           # One folder per business problem, auto-slugged from its problem statement
│       ├── spec/business-problem.yaml (+ history/)
│       ├── plan/plan.yaml (+ history/)
│       ├── context/target-context.yaml, source-context.yaml (+ snapshots/)
│       └── artifacts/0X-<phase>/[<specId>.v<version>/]
├── .vscode/launch.json          # F5 config — note --disable-extension=saoudrizwan.claude-dev
├── package.json                 # ★ contributes.* = all commands (20), views, editors, settings
├── tsconfig.json                # rootDir src, outDir dist, strict, CommonJS, ES2022
└── *.vsix                       # Pre-built package artifacts (two, from different names)
```

> ⚠ FLAG FOR REVIEW — this repository's own local `.ai-context/` (2026-09-16) still has **pre-migration, single-problem-layout files on disk** (`.ai-context/spec/business-problem.yaml`, `.ai-context/derived/graph.json`) that predate the v0.12.0 multi-business-problem change and are no longer referenced by the app (no `active-problem.json` exists, so `ActiveProblemManager.listProblems()` finds nothing under `.ai-context/problems/`). They're untracked (`git status` shows `.ai-context/spec/` as `??`) except the already-tracked `.ai-context/sources.yaml`, so nothing committed is at risk — but worth a conscious decision (migrate into a `problems/<id>/` folder, or delete) rather than leaving them as silent dead weight.

### `src/core/` — the brain

| File | Why it exists | Called by | Depends on |
|---|---|---|---|
| `agentHub.ts` (`DataAgentHubHub`) | **Central orchestrator.** Owns `PlanState`, does all LLM calls, spec drafting, phase inference invocation, plan generation + validation, DAG execution, target-env extraction. **Since v0.13.0, also the lifecycle's single enforcement point** — `generatePlan()` requires an active, context-ready business problem (`state.contextGateReady`, pushed by `webviewProvider`) before doing anything, and `executePlan()` requires the new `approvePlan()`/`confirmStages()` gates. See §5.3. | `extension.ts`, `webviewProvider.ts`, `panelProvider.ts` | every `src/agents/*` executor, `phaseInference`, `implementationType`, `specOps`, `specSynthesis`, `languageModelAdapter`, `configManager`, `PlanManager` |
| `webviewProvider.ts` (`DataAgentHubWebviewProvider`) | **Message bridge** between `sidebar.html` and the extension host. Owns the spec-driven chat routing state machine, wires up all context-layer services, and (v0.12.0) owns business-problem activation/switching (`activateProblem`/`ensureActiveProblem`) — the single largest file in `src/core/` at 1445 lines (`agentHub.ts` is second, at 1321). | `extension.ts` (registered as webview view provider) | hub, `ContextFileManager`, `SourceRegistry`, `SynthesisPipeline`, `SpecManager`, `PlanManager`, `TargetContextManager`, `SourceContextManager`, `ActiveProblemManager`, `SpecOpsEngine`, `SkillRegistry` |
| `configManager.ts` (`ConfigurationManager`) | Read/write VS Code settings; store/retrieve **secrets** via `context.secrets` (SecretStorage). | hub, webviewProvider, extension | `extensionIdentity` (secret keys) |
| `languageModelAdapter.ts` (`LanguageModelAdapter`) | Wraps `vscode.lm` to use **GitHub Copilot with no API key** (provider `copilot`). Detection, model selection, consent gate, timeout via `Promise.race`, `listAll()` for the debug command. `copilotAdapter.ts` is a re-export shim; `CopilotAdapter` is a back-compat alias. | hub (`callConfiguredLlm`), extension (commands), webviewProvider (status) | `vscode.lm` |
| `claudeCodeAdapter.ts` (`ClaudeCodeAdapter`) | Runs the **Claude Code CLI** headless (`claude -p --output-format json`) for provider `claude` — no API key, uses the user's existing Claude Code login. `resolve()` locates the binary: `claudeCodePath` setting → PATH → the binary bundled in the `Anthropic.claude-code` extension (`resources/native-binary/claude(.exe)`). `complete()` spawns via `child_process`, pipes the prompt on stdin, parses the JSON `result`. Tools off for JSON calls; `Read`/`Grep`/`Glob` allowed for grounded chat (`allowTools`). | hub (`callConfiguredLlm`), extension (commands), webviewProvider (status) | `child_process`, `fs`, the Claude Code CLI |
| `phaseInference.ts` | **Pure, dependency-free** module. `inferPhases(spec)`, `buildPhaseDependencies()`, `computePhaseStatuses()`. Keyword evidence + `scope.out` vetoes. Unit-tested. | hub | nothing (no `vscode` import — deliberate) |
| `implementationType.ts` (v0.10.0) | **Pure.** `classifyImplementationType(spec)` — deterministic Greenfield/Brownfield keyword-evidence classification, same technique as `phaseInference`. User can always override (`spec.implementationTypeOverridden`). | `webviewProvider.ts` (`applyImplementationType`) | nothing |
| `targetContextQuestions.ts` / `sourceContextQuestions.ts` (v0.11.0) | **Pure.** `buildTargetContextQuestions(spec)` / `buildSourceContextQuestions(spec)` — the fixed (non-adaptive) Q&A each Context checkpoint asks, each question carrying a keyword-evidence `suggestedDefault` so the form isn't blank. | `webviewProvider.ts` (`startTargetContext`/`chooseSourceContextMethod`) | nothing |
| `problemSlug.ts` (v0.12.0) | **Pure.** `generateProblemSlug(problemStatement, existingSlugs)` — derives a business problem's folder slug (first 5 non-stop-words, kebab-cased, + a 4-char random suffix, collision-checked). Called once, lazily, on the first spec draft for a new business problem. | `webviewProvider.ts` (`ensureActiveProblem`) | nothing |
| `specOps.ts` (`SpecOpsEngine`) | **Deterministic state machine** for the agentic requirements interview. Tracks per-field coverage, turn budget, validates LLM "actions" (`ask`/`ask_many`/`synthesize`/`done`). | webviewProvider | `types` only |
| `specOpsPrompts.ts` | Pure prompt-assembly functions for the discovery + synthesis turns. | hub, webviewProvider | `types` |
| `discoveryProgress.ts` (v0.13.0) | **Pure.** `buildDiscoveryProgress(session, skills)` — turns `IntakeSession.coverage`/`turnCount`/`turnBudget` into a UI-ready progress snapshot; `skillNameForField(field, skills)` — deterministic skill resolution for a question's topic label. Added so the discovery interview's real (server-side) structure is visible client-side — see §5.2, §8.13 of `requirements.md`. | webviewProvider | `types` |
| `specSynthesis.ts` | Parses/validates the LLM's comprehensive (v2) spec JSON → `BusinessProblemSpec`. Builds provenance. Pure. | hub | `types` |
| `skillRegistry.ts` | Loads `skills/*.json` (bundled) + `.ai-context/skills/*.json` (user overrides, win on id collision). | webviewProvider | `fs` |
| `toolSkills.ts` | Phase D. Parses an imported Claude Agent Skill (`SKILL.md` + resources) — lenient YAML frontmatter + Markdown body — into a `ToolSkillDefinition`; `loadToolSkillsFromDirectory()` scans `.ai-context/skills/tool-skills/*/`. A structurally different concept from `skillRegistry.ts`'s interview skills, deliberately kept separate. | `extension.ts` (import command), `ToolSkillAgent.ts` | `fs`, `../context/Yaml` |
| `providerRegistry.ts` | Static metadata table for **data platforms** (display names, capabilities, auth modes) — `PROVIDER_REGISTRY`. LLM provider metadata was moved to `llmProviders.ts` in Phase C; the LLM-facing functions here (`getLlmProviderDefinition`, `getSupportedLlmProviders`) are thin deprecated wrappers that just read `LLM_ADAPTERS`. | Note: nothing in `src/` actually imports `PROVIDER_REGISTRY` either — this whole file is currently unreferenced dead code, LLM half included. |
| `llmAdapter.ts` | The `LlmAdapter`/`LlmAdapterContext`/`LlmCompleteOptions` interfaces + the shared `extractJsonText()` helper (Phase C, v0.9.0). | `llmProviders.ts`, `agentHub.ts` | `types` |
| `llmProviders.ts` | One `LlmAdapter` class per provider (`copilot`/`claude` delegate to `languageModelAdapter.ts`/`claudeCodeAdapter.ts`; `openai`/`anthropic`/`azure-openai`/`gemini`/`ollama` are `fetch()`-based, moved verbatim out of `agentHub.ts`) + `LLM_ADAPTERS` registry + `getLlmAdapter()`. **The single source of truth for "which LLM providers exist."** | `agentHub.ts` (`callConfiguredLlm`), `providerRegistry.ts` | `llmAdapter`, `languageModelAdapter`, `claudeCodeAdapter` |
| `panelProvider.ts` | Bottom-panel dashboard webview; mostly proxies commands. | extension | hub |
| `webviewSecurity.ts` | `applyCspNonce()` — injects a CSP `<meta>` + nonce onto every `<script>` so inline JS runs under VS Code's default CSP. Applied to **all** webviews. | every webview provider + editor | nothing |
| `extensionIdentity.ts` | Constants: `EXTENSION_ID`, view IDs, editor view types, `CONFIG_SECTION`, `SECRET_KEYS`. | everywhere | `vscode` |
| `types.ts` | **The type dictionary.** `BusinessProblemSpec`, `PlanState`, `PlanStep`, `AgentType`, `TargetEnvironment`, `GeneratedArtifact`, `IntakeSession`, `SpecEngineAction`, `DataAgentHubSettings`, … | everywhere | — |

### `src/context/` — the Enterprise Context Layer

| File | Purpose | Notes |
|---|---|---|
| `GraphManager.ts` | In-memory knowledge graph: `Map<id,node>` + `Map<id,edge>` + FQN/label/type indexes + a `Promise`-chain mutex + BFS traversal with decay scoring + snapshot serialization. Implements `vscode.Disposable`. | `traverseNeighborhood()` returns `formattedContext: ''` and `tokenCount: 0` — the retriever that would fill those doesn't exist. `getDiagnostics().isWorkerReady` is hardcoded `true`. |
| `ContextFileManager.ts` | Loads `.ai-context/context/**` (authoritative) + `derived/graph.json` (compiled) into the graph. File watcher with 300ms debounce. `buildContextPrompt()` formats a Markdown context block for prompts. | Legacy fallbacks: root-level `business-context.yaml`, `verified-queries.yaml`, `schema-graph.json`. AJV validation is best-effort. |
| `Yaml.ts` | Thin wrapper over the `yaml` npm library (`parseYaml`/`stringifyYaml`). Replaced the old hand-rolled parsers. | Pure JS → VSIX-safe (no native bindings). |
| `GraphPersistence.ts` | `writeJsonAtomic()` (temp + rename), `readGraphSnapshot()` / `writeGraphSnapshot()` for `derived/graph.json`. | Node `fs`, not `vscode.workspace.fs`. |
| `ContextValidator.ts` | AJV wrapper. Validates a context object against `context-envelope.schema.json`. | Per-`kind` `content` schemas are **deferred** — only the envelope is checked. |
| `SpecManager.ts` | **Persists the BPS.** Atomic writes to `<contextRoot>/spec/business-problem.yaml` — since v0.12.0, `contextRoot` is a business problem's own folder (`.ai-context/problems/<id>/`), not the workspace root directly; the constructor takes the already-resolved root. Archives prior revisions to `spec/history/`. Approval does **not** bump version; a material re-draft of an approved spec does (`vN` → `vN+1`). Reads legacy flat-format (`scopeIn:`) + legacy `comprehensive:` JSON blocks. Since v0.13.0 also persists `implementationType`/`implementationTypeReason`/`implementationTypeOverridden` (previously silently dropped — a bug fixed in the same pass, see §16) and `problemStatementApproved` (the Business Problem checkpoint). | The single most important persistence class. |
| `PlanManager.ts` (v0.10.0) | **Persists the plan.** Mirrors `SpecManager` exactly: atomic writes to `<contextRoot>/plan/plan.yaml`, version-on-change history. New in v0.13.0: `patchGates()` — updates `planApproved`/`stagesConfirmed` (+ timestamps) on the current version **without** bumping it, the same in-place-patch pattern `patchInferredPhases()` already used for phase overrides. | Restored into `hub`'s in-memory `PlanState` on activation (`hub.loadPersistedPlan`). |
| `TargetContextManager.ts` / `SourceContextManager.ts` (v0.11.0) | **Persist Target/Source Context** — spec-tied, reviewed/approved objects distinct from `TargetConfigManager` below. One current record per spec version (no history), `<contextRoot>/context/target-context.yaml` / `source-context.yaml`. `isApprovedFor(specId, specVersion)` / `isReadyFor(...)` are what `webviewProvider.computeContextGateStatus()` checks before allowing `generatePlanFromSpec`. | Built through the fixed Q&A in `targetContextQuestions.ts`/`sourceContextQuestions.ts`, not SpecOps-style adaptive questioning. |
| `ActiveProblemManager.ts` (v0.12.0) | Owns `.ai-context/active-problem.json` (the pointer naming the currently active business problem) and `listProblems()` (a lightweight scan of every `problems/<id>/spec/business-problem.yaml`, for the palette's picker). | Workspace-level — the one manager here that is *not* itself scoped to a `contextRoot`, since its job is to say which `contextRoot` is active. |
| `SourceRegistry.ts` | `.ai-context/sources.yaml` — path → `{kind, layer, owner}`. `kind ∈ {business_context, verified_queries, data_definitions}`. Workspace-level, shared across business problems (v0.12.0 decision). | Small CRUD class. |
| `SynthesisPipeline.ts` | **Rule-based** (not LLM) extraction: reads registered source files, parses bullets / SQL fences → `BusinessTermNode` / `VerifiedQueryNode` / `BusinessRuleNode` with `origin` provenance → adds to the graph. Also `synthesizeFromSpec(spec)` (v0.10.0) — maps the approved spec's own objectives/constraints/etc. into graph nodes, swapped out (`GraphManager.removeNodesBySourceRef`) and resynthesized on every spec revision *and* every business-problem switch (v0.12.0), so one business problem's spec-derived nodes can't leak into another's prompts. | LLM-assisted extraction is a planned enhancement. |
| `TargetConfigManager.ts` | `.ai-context/target-environment.yaml` — dev/staging/prod **tool-preference** profiles (platform/dialect/naming defaults) with `inherits` inheritance. Distinct from `TargetContextManager` above (spec-tied, approved, gates planning) — this one is a generic, workspace-level default that is **no longer auto-seeded** into `hub` (a v0.10.0 auto-seed was identified as a regression in v0.11.0 and removed; `TargetContextManager`'s approved context is now the sole source of `hub.state.targetEnvironment`). Still instantiated in `extension.ts` for a future profile-switcher UI that doesn't exist yet. | ⚠ FLAG FOR REVIEW — §15's knowledge-graph tree previously called this "[orphaned from runtime]" while §16 R11 said it was resolved; that was an internal contradiction in the v0.8.0-era doc, now corrected here and in §15. |
| `ArtifactWriter.ts` | Writes `GeneratedArtifact.content` to `<contextRoot>/artifacts/<NN-phase>/[<specId>.v<version>/]<path>` — `contextRoot` is a business problem's folder as of v0.12.0 (previously always `.ai-context/`). Atomic. Static `resolveArtifactDirectory()` reads the `artifactDirectory` setting (default changed from `.ai-context/artifacts` to `artifacts` in v0.12.0, since it's now relative to the problem folder); static `specTag()` computes the `<specId>.v<version>` folder name (Phase B, v0.9.0) — inserted above the artifact's own relative path so multi-file artifacts (dbt scaffold) keep filenames external tools expect. | Phase dirs: `01-discover`, `02-model`, `03-build`, `04-validate`, `00-uncategorized`. Artifacts with no `specId` skip the version folder. |
| `ArtifactStalenessScanner.ts` | `scanArtifactStaleness(contextRoot, currentSpec?)` walks `<contextRoot>/artifacts/<phase>/*` (problem-scoped since v0.12.0), classifies each `<specId>.v<version>` folder `current`/`stale`/`unknown-spec` against the approved spec, and counts untagged files. Drives the palette's "Generated Artifacts" section. | Filesystem-driven because `PlanState.artifacts` is in-memory only and doesn't survive reload — the folder name is the only durable record. |
| `ChatSessionManager.ts` | **Phase F (v0.9.0).** Persists chat sessions: `.ai-context/chats/<id>.meta.json` (atomic) + `<id>.jsonl` transcript. `createSession`/`getActiveSession`/`appendMessage`/`loadTranscript`/`archiveSession`/`discardSession`/`updateMeta`. Workspace-level, shared across business problems (v0.12.0 decision — a chat can span problems). | Gitignored — local/exploratory, unlike the committed BPS. Session identity is independent of `specId`/`specVersion` (recorded as a breadcrumb, not kept in sync). Transcript writes are read-modify-write, not a true append (`vscode.workspace.fs` has no append primitive). |
| `types.ts` | Context node/edge types + the unified `Origin` (provenance) envelope + `RetrievalOptions` / `SubgraphResult` / `ContextEngineDiagnostics`. | `BaseNode` is `readonly`-heavy by design. |

### `src/dqm/` — data-platform adapter layer ("dqm" 💡 likely "data query manager")

| File | Purpose | State |
|---|---|---|
| `types.ts` | `IDataSourceAdapter` interface, `PlatformCapabilities`, `SchemaSnapshot`, `TableMetadata`, `ColumnProfile`, `PlatformMetadataQueries`, `SqlDialect`, … | Complete & sound design. |
| `BaseAdapter.ts` (`BaseDataSourceAdapter`) | Platform-agnostic `extractMetadata()` orchestration (tables → columns → FKs → views → profiling → lineage), `snapshotToGraph()` conversion, atomic `persistSchemaContext()` → `.ai-context/schema-graph.json`. | Real logic, but fed by stub `executeQuery()`. |
| `ConnectionManager.ts` | Owns the active adapter. `Map<provider, factory>`. `connect()` disconnects the old adapter first. `getCredentialsFromSettings()` maps settings → creds. | Wired into `extension.ts` commands + `SourceAssessmentAgent`. |
| `adapters/SnowflakeAdapter.ts` | `INFORMATION_SCHEMA` metadata queries, key-pair/OAuth/etc. capability flags, lineage via `ACCOUNT_USAGE.QUERY_HISTORY`. | 🟥 `connect()` builds a plain object; `executeQuery()` returns `{rows:[]}`. |
| `adapters/DatabricksAdapter.ts` | `system.information_schema` queries, Spark-SQL→Snowflake/GoogleSQL `translateDialect()`, no lineage. | 🟥 Same stub pattern. |

### `src/agents/` — the wired sub-agents

All export a single `execute<Name>Agent(step, context)` function returning `AgentExecutionResult` (`{success, message, details?, error?, artifacts?}`).

| File | `AgentType` key | Phase | What it does |
|---|---|---|---|
| `discover/SourceAssessmentAgent.ts` | `sourceAssessmentAgent` | discover | The only agent that touches `ConnectionManager` — connects, `extractMetadata`, `persistSchemaContext`. (Blocked by adapter stubs — but as of v0.11.0 degrades gracefully to a context-derived report instead of failing outright when there's no connection, so a missing Snowflake connection no longer blocks the rest of the plan.) |
| `model/SttmMapperAgent.ts` | `sttmAgent` | model | **Since v0.11.0: tries an LLM call first** (`generateWithLlm`, grounded in the task/objective/schemaContext/target environment), falling back to the original templated `CREATE OR REPLACE VIEW ... AS SELECT col AS mapped_n` mapping if no LLM is available or the call fails. |
| `model/DataModelerAgent.ts` | `dataModelerAgent` | model | **Since v0.11.0: LLM-first**, falling back to full DDL for dimensional / data-vault / OBT / 3NF models from hardcoded column templates, honoring `namingConvention`. |
| `build/IngestionPipelineAgent.ts` | `ingestionAgent` | build | **Since v0.11.0: LLM-first**, falling back to templated `CREATE TABLE ... ; COPY INTO ... FROM @STAGE` SQL. |
| `build/TransformationScaffolderAgent.ts` | `transformScaffoldAgent` | build | **Since v0.11.0: LLM-generates only its two most-visible models** (staging, marts) via `generateWithLlm`; project config/intermediate model/tests/macros stay templated as genuinely domain-independent boilerplate. Falls back to a fully templated **6-file dbt project** (dbt_project.yml, staging/intermediate/marts models, schema.yml tests, generic test, macro) if the LLM call fails. |
| `validate/DocumentationAgent.ts` | `architectureAgent` | validate | **Since v0.11.0: LLM-first** for both the DDL artifact and the Markdown architecture doc, falling back to templates. |
| `../spokes/snowflakeExecutor.ts` | `snowflakeExecutor` | build (💡) | The **only** agent importing `snowflake-sdk`. Opens a real connection and runs `SELECT '<step>' ...`. **Has a hardcoded `username: 'DATA_AGENT_USER'`** (bug — ignores the configured username, still open, see §16 R2). As of v0.11.0, also degrades gracefully (skips validation rather than failing) when there's no connection. |
| `build/ToolSkillAgent.ts` | `toolSkillAgent` | build | **New in Phase D (v0.9.0) — the exception to the note below.** Runs an imported Claude Agent Skill with real tool access via `claude` (Claude Code's own tool loop) or `copilot` (a real `vscode.lm` tool-calling loop AutoDE owns). Not auto-planner-reachable — only `/skill <id> <instruction>` or the "Run Tool Skill" command invoke it, via `AgentHub.runToolSkill()`. |

> **Updated realization (v0.11.0 — corrects the v0.8.0-era claim below it in the interest of the repo's history, since the "Key realization" callout used to say none of these agents call an LLM):** 5 of the 7 leaf agents (`sttmAgent`, `dataModelerAgent`, `ingestionAgent`, `transformScaffoldAgent`, `architectureAgent`) now try an LLM call first via `src/agents/llmCodegen.ts#generateWithLlm`, and only fall back to their original fixed-schema templates when no LLM is configured, the call fails, or — deliberately, a correctness guard added during v0.11.0 development — the response isn't wrapped in the requested fenced code block (an unfenced response is treated as a failed generation, never shipped as artifact content). `sourceAssessmentAgent` (blocked by adapter stubs) and `snowflakeExecutor` (real SQL, not codegen) are unchanged. `toolSkillAgent` remains the only agent with real tool access. The "AI" in AutoDE is therefore concentrated in the **orchestrator** (planning), the **spec engine** (interview + synthesis), the **5 LLM-first leaf agents**, and `toolSkillAgent` — narrower than "every artifact is LLM-generated," since the template fallback is still real and still used whenever the LLM path can't run, but materially broader than the original v0.8.0 "pure string templates" characterization.

### `src/editors/` — custom editors

Five `CustomTextEditorProvider`s (DataModel `*.sql`, STTM `*.yaml`, Graph `*.json`, Profile `*.md`, Doc `*.md`), each registered with `priority: "option"` (opt-in, not default). Each reads its `media/editors/*.html`, string-substitutes `{{CONTENT}}`/`{{FILENAME}}`, and applies the CSP nonce. Read-oriented visualizers; the `.md`/`.yaml`/`.json` selectors overlap so a user picks the editor explicitly.

### `src/spokes/` and `src/features/` — legacy / dead

- `src/spokes/{architectureAgent,ingestionAgent,sttmAgent}.ts` — **superseded** by `src/agents/**`. Nothing imports them. Still compiled (tsconfig `include: src/**/*.ts`).
- `src/spokes/snowflakeExecutor.ts` — **still wired** (imported by `agentHub.ts`).
- `src/features/**` — a near-verbatim copy of `spokes/` under a deeper path. **Entirely dead.** No imports anywhere. Safe to delete once you confirm with `grep -rn "features/" src/`.

---

## 4. System Architecture

### 4.1 It is a monolith-in-a-plugin

There are **no services, no IPC, no network hops inside AutoDE**. Everything is method calls inside one Node process (the VS Code Extension Host). The only "remote" calls are outbound HTTPS to LLM providers (and, in the aspirational future, to Snowflake/Databricks).

### 4.2 Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│  WEBVIEW (browser sandbox inside VS Code)                             │
│  media/sidebar.html  ·  media/panel.html  ·  media/editors/*.html     │
│  - Single-file HTML/CSS/JS, no framework                              │
│  - Talks to the host ONLY via postMessage({type, ...})               │
└───────────────▲──────────────────────────────────┬───────────────────┘
                │ Extension → Webview               │ Webview → Extension
                │ (stateUpdate, chatResponse,       │ (chat, generatePlan,
                │  logEntry, specLoaded, ...)        │  approveSpec, runAgent, ...)
┌───────────────┴──────────────────────────────────▼───────────────────┐
│  MESSAGE BRIDGE                                                       │
│  webviewProvider.ts  (sidebar)   ·   panelProvider.ts  (panel)        │
│  - Owns spec-driven chat routing (no spec → interview,               │
│    draft → revise, approved → grounded chat)                         │
└───────────────┬─────────────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────────────┐
│  ORCHESTRATION LAYER                                                 │
│  agentHub.ts (DataAgentHubHub)  — single stateful object            │
│  - PlanState (objective, steps, status, artifacts, inferredPhases,  │
│    contextGateReady, planApproved, stagesConfirmed — v0.13.0)       │
│  - generateSpec / discoverNextAction / synthesizeComprehensiveSpec  │
│  - inferPhasesFromSpec  → phaseInference.ts (pure)                  │
│  - generatePlan → buildPlanPrompt → LLM → validatePlanResponse      │
│    ★ v0.13.0: generatePlan() itself now GATES on contextGateReady;  │
│      generatePlanFromSpec() gates on spec+business-problem+context  │
│  - executePlan → GATES on planApproved && stagesConfirmed → DAG     │
│    loop → AGENT_EXECUTORS[step.assignedAgent]                       │
│  - resetForNewProblem() — full reset when switching business        │
│    problems (v0.12.0), vs. resetPlan() — same-spec re-plan only     │
│  - callConfiguredLlm → provider fan-out                             │
└──────┬───────────────────┬──────────────────┬─────────────────┬─────┘
       │                   │                  │                 │
┌──────▼──────┐   ┌────────▼────────┐  ┌──────▼───────┐  ┌──────▼──────────┐
│ SPEC ENGINE │   │  SUB-AGENTS     │  │ CONTEXT LAYER │  │  LLM PROVIDERS  │
│ specOps.ts  │   │ src/agents/**   │  │ GraphManager  │  │ languageModel + │
│             │   │                 │  │               │  │ claudeCode adpt │
│ skills/*.json│  │ (5 of 7 LLM-    │  │ ContextFile   │  │ + fetch() to    │
│ specSynthesis│  │  first w/       │  │  Manager      │  │ OpenAI/Anthropic│
│              │   │  template       │  │ SpecManager   │  │ /Azure/Gemini/  │
│              │   │  fallback,      │  │ PlanManager   │  │ Ollama          │
│              │   │  v0.11.0)       │  │ TargetContext │  │                 │
│              │   │ + snowflake     │  │  /SourceContext│ │                 │
│              │   │   Executor      │  │  Manager (v0.11)│ │                │
│              │   │                 │  │ SourceRegistry│  │                 │
└─────────────┘   └────────┬────────┘  └──────┬───────┘  └─────────────────┘
                           │                  │
                  ┌────────▼────────┐  ┌──────▼──────────┐
                  │  ADAPTER LAYER  │  │  PERSISTENCE     │
                  │  src/dqm/**     │  │  .ai-context/    │
                  │  (STUBBED)      │  │  (shared root +  │
                  │  Snowflake      │  │  problems/<id>/, │
                  │  Databricks     │  │  v0.12.0)         │
                  │                 │  │  VS Code settings│
                  │                 │  │  SecretStorage   │
                  └─────────────────┘  └─────────────────┘
```

### 4.3 Request flow (chat message → response)

```
User types in sidebar.html
   → postMessage({type:'chat', message, schemaContext})
   → webviewProvider.handleMessage('chat')
       ├─ specOpsEngine already active?          → handleSpecDiscovery(message)  (continue interview —
       │                                            fresh discovery OR an in-progress revision)
       ├─ specManager.getSpec() == undefined?    → handleSpecDiscovery(message)  (start a fresh interview)
       ├─ spec.status == 'draft'?                → reviseSpec()                  (LLM re-draft, in place)
       ├─ spec.status == 'approved' &&
       │  pendingRevision (armed by "↻ Revise")? → handleSpecDiscovery(message, previousSpec=spec)
       │                                            (starts a FULL revision interview — v0.9.0, §2.9 of
       │                                             technical-design.md — never edits the approved spec
       │                                             in place; always produces a new draft version+1)
       └─ spec.status == 'approved', otherwise?  → hub.chat(message, repoContext + schemaContext)
                                                     → buildChatContextBlock (BPS + source env + plan + target env)
                                                     → callConfiguredLlm(prompt, CHAT_SYSTEM_PROMPT)
                                                         → copilot | claude | openai | anthropic | azure | gemini | ollama
                                                     → postMessage({type:'chatResponse', message})
```

### 4.4 Dependency flow (who constructs whom)

```
extension.activate(context)
 ├─ new ConfigurationManager(context)
 ├─ new DataAgentHubHub(configManager)
 ├─ applyProblemRoot(unscopedRoot)   ★ v0.12.0 — a callback extension.ts passes into the sidebar
 │    provider; constructs a fresh ArtifactWriter/PlanManager scoped to whatever
 │    contextRoot is currently active, and (re)wires them into hub. Called once at
 │    startup against `.ai-context/problems/_unscoped/` as a fallback, then again
 │    every time `webviewProvider.activateProblem()` runs.
 ├─ new DataAgentHubWebviewProvider(context, configManager, hub, applyProblemRoot)
 │    ├─ new GraphManager()                          — workspace-level, shared
 │    └─ (on resolveWebviewView)
 │         ├─ new ActiveProblemManager(workspaceRoot, log)
 │         ├─ new ContextFileManager(root, graph, log, ContextValidator?)   — workspace-level
 │         ├─ new SourceRegistry(root, log)                                 — workspace-level
 │         ├─ new SynthesisPipeline(root, graph, log)                       — workspace-level
 │         ├─ activateProblem(activeProblemManager.getActiveProblemId())   ★ v0.12.0
 │         │    ├─ hub.resetForNewProblem()  (always runs first — closes the
 │         │    │    stale-state bug where a previous business problem's spec
 │         │    │    stayed visible after "starting a new one")
 │         │    ├─ graphManager.removeNodesBySourceRef('spec:' + prevSpecId)
 │         │    └─ if a problem is active: contextRoot = problems/<id>/
 │         │         ├─ applyProblemRoot(contextRoot)  → new PlanManager/ArtifactWriter
 │         │         ├─ new SpecManager(contextRoot, log)
 │         │         ├─ new TargetContextManager(contextRoot, log)
 │         │         └─ new SourceContextManager(contextRoot, log)
 │         └─ (lazy) new SkillRegistry(...) , new SpecOpsEngine(...)
 ├─ new DataAgentHubPanelProvider(context, hub)   — ⚠ parked, see §1/§16; unaffected by
 │                                                   the multi-problem change since it never
 │                                                   held its own spec/context state
 └─ (lazy, per command) new ConnectionManager(log)
```

Note: `DataAgentHubHub` is a **singleton for the session**; its `PlanState` is the live, in-memory working copy `AgentHub` mutates step-by-step, but (v0.10.0) the steps, status, inferred phases, target environment, and implementation type are now also persisted by `PlanManager` (`<contextRoot>/plan/plan.yaml`, mirroring `SpecManager`'s atomic-write + version-history pattern) and restored on activation (`hub.loadPersistedPlan`) — reload VS Code and the plan is back, alongside the approved spec. Only `PlanState.artifacts` (execution-produced `GeneratedArtifact[]`) remains in-memory-only; artifact durability is instead handled by the `<specId>.v<version>` folder scheme (§2.10 of the technical design). Since v0.12.0, `PlanManager`/`ArtifactWriter`/`SpecManager`/`TargetContextManager`/`SourceContextManager` are all **re-constructed** every time the active business problem changes (not just once at startup) — see the `applyProblemRoot`/`activateProblem` flow above.

### 4.5 Architectural patterns in play

| Pattern | Where | Why (inferred) |
|---|---|---|
| **Orchestrator / hub-and-spoke** | `DataAgentHubHub` + `AGENT_EXECUTORS` map | One coordinator decomposes work and routes to interchangeable, contract-bound workers. |
| **Adapter pattern** | `IDataSourceAdapter` / `BaseDataSourceAdapter` / concrete adapters | Isolate per-platform system tables, dialects, auth so sub-agents stay platform-agnostic. |
| **Strategy / registry** | `AGENT_EXECUTORS`, `AGENT_PHASE`, `PROVIDER_REGISTRY`, `adapterFactories`, `SkillRegistry` | Add a capability by adding a map entry, not editing a switch. (Partially — plan validation still has an allow-list.) |
| **State machine** | `SpecOpsEngine` (`discovery → synthesizing → draft → refining → approved`), spec-driven chat routing | The interview needs a deterministic stop condition that works on plain text LLMs (no tool-calling). |
| **Pure core + imperative shell** | `phaseInference.ts`, `specOps.ts`, `specOpsPrompts.ts`, `specSynthesis.ts` have **no `vscode` import** | Unit-testable in plain Node (the whole test suite depends on this). |
| **Repository pattern (lite)** | `SpecManager`, `PlanManager`, `TargetContextManager`, `SourceContextManager`, `SourceRegistry`, `TargetConfigManager`, `ArtifactWriter` | Each owns one file, atomic writes, parse/serialize. As of v0.12.0, the first five take a caller-resolved `contextRoot` rather than assuming the workspace root — the same pattern, applied at a different (per-business-problem) granularity. |
| **Message-passing UI** | webview ↔ host `postMessage` | VS Code sandboxes webviews; this is the only channel. |
| **Spec-driven / DDD-flavored** | BPS as "system of record", `specId`/`specVersion` stamped on artifacts and phases | Traceability: every artifact can be traced to the spec version that motivated it. |
| **DAG / workflow engine (lite)** | `PlanStep.dependsOn`, `executePlan()` ready-step loop | Steps run when dependencies are `completed`; cycle/missing-dep detection at validate time. |
| **Single enforcement point / guard clause** (v0.13.0) | `AgentHub.generatePlan()`/`executePlan()` throw on unmet preconditions (`contextGateReady`, `planApproved`, `stagesConfirmed`) rather than trusting each caller to check first | Closed a finding where at least 7 UI entry points (Command Palette, the parked Dashboard panel, `/plan`, re-plan buttons) could reach plan generation/execution without ever touching a spec or context approval — see §5.3, §16. |

**Not present:** microservices, event bus / pub-sub, CQRS, hexagonal ports/adapters (the adapter layer is classic adapter, not hexagonal), message queues, actor model.

---

## 5. Runtime Execution Flows

### 5.1 Activation

**Entry:** `activate(context)` in `src/extension.ts` — triggered by any of the `activationEvents` (opening a view or running a command).

```
activate
 ├─ construct ConfigManager, Hub, SidebarProvider, PanelProvider
 ├─ applyProblemRoot(unscopedRoot)  ★ v0.12.0 — see §4.4; constructs the initial
 │    ArtifactWriter/PlanManager before any webview has resolved
 ├─ register 20 commands (openSidebar, generatePlan, executePlan, resetSession,
 │   testConnection, sourceAssessment, syncMetadata, reindex, testLanguageModel,
 │   listLanguageModelInfo, listLanguageModels, testCopilot, listCopilotInfo,
 │   debugListExtensions, copilotHandoff, importToolSkill, runToolSkill,
 │   newChat, chatHistory, discardChat — up from 15 at v0.8.0; importToolSkill/
 │   runToolSkill added Phase D, newChat/chatHistory/discardChat added Phase F)
 └─ context.subscriptions.push( webviewViewProvider×2, customEditorProvider×5, ...commands )
```

Side effects: none on disk until a webview resolves or a command runs — except the `applyProblemRoot(unscopedRoot)` call above, which is a no-op until something actually writes through the `ArtifactWriter`/`PlanManager` it constructs. `deactivate()` is **still empty** — watchers and the graph are not disposed (🟥 backlog item, `requirements.md` §16.4, unchanged since v0.8.0).

⚠ **Note on the two Generate Plan / Execute Plan commands specifically:** as of v0.13.0 these are no longer "always works, ungated" — `hub.generatePlan()`/`hub.executePlan()` (which these commands call directly) now throw if there's no active, context-ready business problem, or no approved plan / confirmed stages, respectively. See §5.3.

### 5.2 Workflow: Business Problem → Approved Spec (the agentic interview)

**Entry point:** first chat message when no business problem is active yet (`ActiveProblemManager.getActiveProblemId()` returns nothing — v0.12.0; before that it was keyed off whether `.ai-context/spec/business-problem.yaml` existed at all).

```
webviewProvider.handleMessage('chat')  [no spec]
 → handleSpecDiscovery(message)
     ├─ first message: new SpecOpsEngine(createIntakeSession(message, {fields: allSpecFields}))
     │     coverage seeded 'missing' for every field the skills own
     └─ runDiscoveryTurn()
         ├─ engine.shouldSynthesize()?  (turnCount ≥ turnBudget[=12]  OR  coverage complete)
         │     → synthesizeFromSession()
         └─ else:
             hub.discoverNextAction(session, skills)
               → buildDiscoveryTurnPrompt(session, skills)   [DISCOVERY_SYSTEM_PROMPT]
               → callConfiguredLlm → JSON action
               → SpecOpsEngine.validateAction(parsed)   ['ask'|'ask_many'|'synthesize'|'done']
             ├─ 'ask'      → post {type:'specQuestion', progress}   → chat bubble
             ├─ 'ask_many' → post {type:'specQuestions', progress}  → dynamic intake FORM (2+ fields)
             └─ 'synthesize'|'done' → synthesizeFromSession()

★ v0.13.0 follow-up: both posts above now also carry a `progress` snapshot
  (`discoveryProgress.ts#buildDiscoveryProgress` — turn count/budget, coverage,
  per-skill status) and each question gets a deterministically-resolved
  `skillLabel`. Previously the payload was just the bare question and the
  palette showed nothing at all during discovery — real orchestration existed
  server-side but was invisible client-side (found via dev-host testing:
  "asking valid questions" but not reading as "a cohesive, grounded, controlled
  orchestrator"). The chat bubbles now show a topic + progress readout, and the
  Workflow Palette shows a live "discovery in progress" card instead of "No
  Business Problem Specification yet" for the whole interview.

user answers → submitSpecAnswers / next chat message
 → engine.answer(...) for each  → coverage field → 'partial'
 → runDiscoveryTurn()  (loop)

synthesizeFromSession()
 → engine.setState('synthesizing')
 → hub.synthesizeComprehensiveSpec(session, previous?)
     → buildSynthesisPrompt(session)   [SYNTHESIS_SYSTEM_PROMPT]
     → callConfiguredLlm → JSON
     → parseComprehensiveSpec(...)  → BusinessProblemSpec (v2, status:'draft')
         + buildProvenance(session)  (field → question|synthesis)
 → ensureActiveProblem(spec.problemStatement)   ★ v0.12.0 — lazy: this is the FIRST point a
     business problem's folder can be named, since a slug needs a problem statement to
     derive from. Creates .ai-context/problems/<slug>/, points active-problem.json at it,
     and (re)constructs SpecManager/PlanManager/TargetContextManager/SourceContextManager/
     ArtifactWriter scoped to that folder — see §4.4.
 → applyImplementationType(spec, previous)   ★ v0.13.0 — also sets spec.problemStatementApproved
     = false unconditionally (every fresh draft/revision needs its own confirmation), then
     either carries forward a prior manual Greenfield/Brownfield override or re-classifies
     via classifyImplementationType(spec) (implementationType.ts, keyword evidence)
 → specManager.saveSpec(spec)   → .ai-context/problems/<id>/spec/business-problem.yaml (atomic)
 → post {type:'specDrafted'}  → chat card + palette spec section
 (on any failure → fall back to a single-shot draftSpec(composeSynthesisPrompt(session)))
```

**Then, in order (v0.13.0 adds the first of these two steps — previously there was only the second):**

1. User clicks **✓ Confirm Business Problem** on the spec card (shown instead of "✓ Approve" while `problemStatementApproved` is `false`) → `approveBusinessProblem` message → sets `spec.problemStatementApproved = true`, saves. Refining instead of confirming is just the existing draft-revision chat flow (`reviseSpec`) — no separate mechanism.
2. User clicks **✓ Approve** → `approveSpec` message → **rejects with an error if `problemStatementApproved` is still `false`** (new precondition, v0.13.0) → otherwise `specManager.approve()` (status→approved, **no version bump**) → `hub.inferPhasesFromSpec(approved)`.

### 5.3 Workflow: Approved Spec → Context → Phase Inference → Plan → Approve → Confirm → Execution

Materially revised in v0.13.0 (`requirements.md` §8.12) — three new explicit gates (bold below) were added after fresh testing showed the previously-gated path coexisted with several **ungated** ones (Command Palette commands, the parked Dashboard panel, `/plan` with no spec, re-plan buttons) that could reach plan generation/execution without ever touching a spec or context approval. The fix moved enforcement **into `AgentHub` itself** rather than trusting each caller to check first.

```
approveSpec  (or reset with an approved spec, or workspace load with an approved spec)
 → hub.inferPhasesFromSpec(spec)
     → inferPhases(spec)   [pure, deterministic — src/core/phaseInference.ts]
         corpus = problemStatement + objectives + scope.in + constraints
                + successCriteria + assumptions + domain + keyEntities   (lowercased)
         for each phase in [discover, model, build, validate]:
             if scope.out matches an exclusion phrase → skip (veto)
             else if corpus matches a PHASE_KEYWORD → required
         if nothing matched → ALL FOUR required (underspecified default)
         if build required AND discover-keywords present → force discover
         dependsOn = natural chain (discover→model→build→validate) pruned to required set
 → PlanState.inferredPhases set; state.stagesConfirmed reset to false (v0.13.0 — a changed
     phase set invalidates any prior confirmation); palette renders live status rows

user builds/reviews **Target Context** (always) and **Source Context** (Brownfield only,
auto-marked Not Applicable for Greenfield) — v0.11.0, unchanged in shape this pass:
 startTargetContext/chooseSourceContextMethod → fixed Q&A (targetContextQuestions.ts/
 sourceContextQuestions.ts) → submitXContextAnswers (status 'built') → approveXContext
 (status 'approved') → webviewProvider.postContextGateStatus() recomputes
 computeContextGateStatus(spec).canGeneratePlan and pushes it into the orchestrator via
 hub.setContextGateReady(...) ★ v0.13.0 — this is the field generatePlan()/
 generatePlanFromSpec() actually gate on; previously this status only existed for the UI.

user clicks "Generate Plan" (or generatePlanFromSpec message)
 → hub.generatePlanFromSpec(spec, contextSummary)
     ★ GATE (v0.13.0): throws unless spec.status === 'approved' AND
       spec.problemStatementApproved === true AND state.contextGateReady === true
     → hub.inferPhasesFromSpec(spec, contextSummary)   (re-run — context may have changed)
     → hub.generatePlanInternal(buildObjectiveFromSpec(spec), schemaContext)
         (the old public generatePlan()'s body, moved private — see below)
         ├─ if no targetEnvironment: extractTargetFromMessage(objective)  [LLM JSON extraction]
         │     buildTargetFromPartial(partial, settings)  → hub.setTargetEnvironment(...)
         ├─ requiredPhases = inferredPhases.filter(required)
         ├─ buildPlanPrompt(objective, schemaContext, requiredPhases)
         │     "Create steps ONLY for the phases listed above."
         ├─ callConfiguredLlm(prompt)   [PLANNER_SYSTEM_PROMPT: "JSON array only"]
         ├─ validatePlanResponse(raw)
         │     - must be JSON array
         │     - each assignedAgent ∈ VALID_AGENT_TYPES (7)
         │     - taskDescription required
         │     - unique ids, no missing deps, no self-deps
         ├─ each step.phase = AGENT_PHASE[step.assignedAgent] ?? 'discover'
         ├─ state.planApproved = false; state.stagesConfirmed = false   ★ v0.13.0 — a fresh
         │     plan always needs its own approval + confirmation, whatever the prior plan had
         └─ PlanState.status = 'ready'; emitState() → post {type:'stateUpdate'}

★ NEW GATE 1 — user clicks "✓ Approve Plan" → hub.approvePlan() → state.planApproved = true
    (throws if there are no steps yet); persisted via PlanManager.patchGates() (in-place,
    doesn't bump the plan's version — same pattern as patchInferredPhases())

★ NEW GATE 2 — user clicks "✓ Confirm Applicable Stages" → hub.confirmStages() →
    state.stagesConfirmed = true (throws if there are no inferred phases yet); persisted
    the same way. Also reset to false by a subsequent setPhaseOverride() call — changing
    which phases apply after confirming invalidates the confirmation.

user clicks "🏗 Generate Artifacts" (the palette button/chat action only reaches this label
once both gates above are satisfied — see media/sidebar.html's updatePaletteContinue())
 → hub.executePlan()
     ★ GATE (v0.13.0): throws unless state.planApproved === true AND state.stagesConfirmed === true
     status = 'running'; reset all steps to 'pending'
     LOOP:
       readyStep = first step whose deps are all in completedIds
       if none & unfinished remain → mark blocked step 'failed', handleFailure() (offer Re-plan)
       if executionPaused → status 'paused', return
       readyStep.status = 'running'; emitState()
       build AgentExecutionContext { objective, schemaContext, sourceProvider,
                                     targetEnvironment, settings, configManager(getSecret),
                                     log, addArtifact, currentPhase, callLlm }
       result = AGENT_EXECUTORS[readyStep.assignedAgent](readyStep, context)
       if !result.success → step 'failed', handleFailure(), return
       for each result.artifact:
           artifact.phase / specId / specVersion stamped
           artifactWriter.write(artifact)  → <contextRoot>/artifacts/<NN-phase>/<file>  → artifact.filePath set
       readyStep.status = 'completed'; completedIds.add(id); emitState()
     status = 'completed'
```

**`emitState()`** always recomputes `computePhaseStatuses(inferredPhases, steps, currentPhase)` before pushing — so the palette's phase badges (completed / in-progress / blocked / pending / unrequired) update on every state change.

⚠ **Product decision worth knowing (2026-09-16), not a bug:** the *order* here — phase inference before Plan Generation, informing the plan prompt — was deliberately kept as-is rather than moved to run after Plan Generation, even though a literal reading of the "Business Problem → … → Plan Generation → Plan Approval → Stage Inference → User Review of Applicable Stages → Artifact Generation" lifecycle description would put it later. The tradeoff: inferring early lets the plan prompt be scoped to only relevant phases from the start; inferring late would let the LLM propose a full plan first, unconstrained. What was added instead is the discrete Stage Confirmation gate above — a one-time checkpoint, where before there was only continuous editability with no required sign-off.

### 5.4 Workflow: Source Assessment (Discover)

**Entries:** command `autoDataEngineeringHub.sourceAssessment`, palette "Run" on Source Assessment, or a plan step assigned to `sourceAssessmentAgent`.

```
executeSourceAssessmentAgent(step, context)
 → getCredentialsFromSettings('snowflake', settings)
 → validateCredentials → if missing → buildContextOnlyAssessment()  ★ v0.11.0, no longer a
     hard failure — falls back to a context-derived assessment artifact (the approved spec's
     source catalog / registered data-contract notes) instead of blocking the whole plan on
     connectivity. Same for a connection that fails once attempted.
 → getSecret(snowflakePassword / passphrase / databricksToken)
 → new ConnectionManager(log)
 → connectionManager.connect('snowflake', creds)      ← 🟥 STUB, unchanged: returns fake ConnectionInfo
 → connectionManager.extractMetadata({includeProfiling:true})
     → BaseAdapter.extractMetadata: runs listTables/listColumns/... via executeQuery ← 🟥 returns []
 → connectionManager.persistSchemaContext(snapshot, workspaceRoot)
     → snapshotToGraph(snapshot) → .ai-context/schema-graph.json  (atomic, workspace-level —
       ⚠ FLAG FOR REVIEW: this path was NOT moved under `problems/<id>/` in the v0.12.0
       multi-business-problem migration, unlike everything else spec/plan/context/artifact-
       related. Worth a deliberate decision on whether that's correct (source assessment
       arguably belongs to the source system, not any one business problem) or an oversight.)
 → returns success with a (currently empty, since the adapter is stubbed) summary
```

Because the adapter is a stub, this "succeeds" but produces an empty graph today. This is unchanged since v0.8.0 — no Phase 4 work landed in v0.9.0–v0.13.0.

### 5.5 Workflow: Register a context source → Synthesize

```
registerSource {path, kind, owner}
 → sourceRegistry.addSource(...)  → .ai-context/sources.yaml
synthesize
 → synthesisPipeline.synthesize(sources)
     for each source: read file → rule-based extract:
        business_context   → bullets "Term: description" → BusinessTermNode
        verified_queries   → ```sql fences``` → VerifiedQueryNode
        data_definitions   → "Name: definition" → BusinessRuleNode (RECOMMENDED)
     each node carries origin { source:'derived', sourceRef, extractor:'synthesis-pipeline', extractedAt }
     → graphManager.addNode / addEdge
 → post {type:'contextUpdate'}  (stats + entity lists for @-mention + drawer chips)
```

### 5.6 Workflow: New Chat (session lifecycle, Phase F)

```
"🗨 New Chat" (topbar) or command AutoDE: New Chat
 → post('newChat')
 → webviewProvider.startNewChat()
     if a SpecOpsEngine interview is in flight AND it collected ≥1 answer/insight:
       carryOverPartialInterview(session, workspaceRoot)
         → renders answers+insights as Markdown
         → writes .ai-context/chats/carryover/<sessionId>.md
         → sourceRegistry.addSource(path, 'business_context', 'autode')
         → synthesisPipeline.synthesize(sources)   ← becomes real graph nodes, not just a file
     tear down the SpecOpsEngine (never resumed as live Q&A)
     chatSessionManager.archiveSession(currentId)   ← never deleted
     chatSessionManager.createSession({specId, specVersion, llmProvider})
 → post('chatSessionLoaded', {meta, transcript: []})
     sidebar.html: loadChatSession() clears chatStream, resets discoveryActive/revisionArmed,
     shows the welcome block
```

Every sidebar resolve (extension reload, window reopen) runs `getActiveSession() ?? createSession()` to find/create the current session, so a reload never silently loses a conversation — it's already on disk, keyed by whichever session is `active`. **Changed in v0.13.0:** the resolved session is no longer posted into the chat window as-is. If it has any transcript content, `resolveWebviewView` calls this same `startNewChat()` — folding it (archived, never discarded) and creating a fresh empty one — *before* anything is posted, so the chat window always starts empty on activation, "as if it's a new session" (the exact behavior requested after dev-host testing found a restart resuming the old conversation confusing). Only a session that's already empty is posted directly.

**Resuming a folded session — new in v0.13.0.** The sidebar topbar gained a "🕓" Chat History icon next to "🗨 New Chat": `post('listChatSessions')` → `chatSessionsList` populates a dropdown of every session; clicking one `post('openChatSession', {chatId})`. This case in `webviewProvider.ts` **changed meaning** from a read-only preview to a real resume: it archives whatever's currently active (folding it the same way), reactivates the chosen session (`ChatSessionManager.updateMeta(chatId, {status:'active'})`), and responds with `chatSessionLoaded` — the resumed transcript renders exactly like any other active session, and new messages append to it normally. The old `chatSessionViewed` read-only response is retired (it had no client-side consumer anyway — see `requirements.md` §8a.4).

**Also calls `startNewChat()` since v0.12.0:** both `startNewBusinessProblem` and `switchBusinessProblem` (the palette's "＋ New"/"⇄ Switch" actions) run the same archive-and-create-fresh sequence above, right after `activateProblem()` resets `hub`/re-scopes the managers — a chat session belongs to whichever business problem was active when it was written, so switching problems always starts a new one rather than continuing the old transcript against different spec/context state.

---

## 6. Data Flow Maps

### 6.1 Data sources (inputs)

| Source | Kind | Read by | Notes |
|---|---|---|---|
| User chat text | interactive | webviewProvider → hub | The primary input. |
| VS Code settings (`autoDataEngineeringHub.*`) | config | `ConfigurationManager.getSettings()` | Global target (`ConfigurationTarget.Global`) — **not workspace-scoped**. 💡 potential surprise. |
| VS Code SecretStorage | secrets | `ConfigurationManager.getSecret()` | 3 keys: `llmApiKey`, `snowflakePassword`, `snowflakePrivateKeyPassphrase`. |
| `.ai-context/active-problem.json` | file (JSON) | `ActiveProblemManager` | Pointer to the active business problem (v0.12.0). |
| `.ai-context/problems/<id>/spec/business-problem.yaml` | file (YAML) | `SpecManager` | The BPS — per business problem since v0.12.0 (was `.ai-context/spec/business-problem.yaml`). |
| `.ai-context/problems/<id>/plan/plan.yaml` | file (YAML) | `PlanManager` | The persisted plan, including the v0.13.0 gate fields (`planApproved`, `stagesConfirmed`). |
| `.ai-context/problems/<id>/context/target-context.yaml` / `source-context.yaml` | files (YAML) | `TargetContextManager` / `SourceContextManager` | v0.11.0. |
| `.ai-context/sources.yaml` | file (YAML) | `SourceRegistry` | Registered source files — shared across business problems. |
| `.ai-context/context/**/*.yaml` | files (YAML) | `ContextFileManager` | Authoritative human-owned context (may not exist yet) — shared. |
| `.ai-context/derived/graph.json` | file (JSON) | `ContextFileManager` / `GraphPersistence` | Compiled graph snapshot (gitignored) — shared; its spec-derived layer is swapped per active business problem (v0.12.0). |
| `.ai-context/schema-graph.json` (legacy) | file (JSON) | `BaseAdapter` / `ContextFileManager` fallback | Written by source assessment. ⚠ Still workspace-level, not moved under `problems/<id>/` — see §5.4. |
| Registered repo files (e.g. `docs/glossary.md`) | files | `SynthesisPipeline` | Referenced, never copied. |
| `skills/*.json` + `.ai-context/skills/*.json` | files (JSON) | `SkillRegistry` | Interview skill definitions. |
| LLM provider APIs | HTTPS | `agentHub` | OpenAI/Anthropic/Azure/Gemini/Ollama via `fetch`; Copilot via `vscode.lm`. |
| Snowflake / Databricks | (would be) SQL over network | `src/dqm/**` | 🟥 not actually connected — unchanged since v0.8.0. |
| `docs/schemas/context-envelope.schema.json` | file (JSON) | `ContextValidator` (via webviewProvider) | Loaded once at webview resolve. |

### 6.2 Key transformations

| # | Transformation | Input | Output | Where | Validation |
|---|---|---|---|---|---|
| T1 | NL problem → BPS (single-shot) | user prompt string | `BusinessProblemSpec` (v1 fields) | `agentHub.generateSpec` → `parseSpecResponse` | `problemStatement`, `objectives`, `scope.in` must be non-empty; strings coerced, arrays flattened |
| T2 | Interview turn | `IntakeSession` + skills | `SpecEngineAction` | `agentHub.discoverNextAction` | `SpecOpsEngine.validateAction` — action enum, question `field`/`prompt`/`kind` |
| T3 | Interview → comprehensive BPS | `IntakeSession` (Q&A) | `BusinessProblemSpec` (v2: dataFlows, transformations, dependencies, acceptanceCriteria, sourceCatalog, provenance) | `agentHub.synthesizeComprehensiveSpec` → `parseComprehensiveSpec` | same non-empty rules + `SOURCE_TYPES` enum for catalog |
| T4 | BPS → required phases | `BusinessProblemSpec` | `InferredPhase[]` | `phaseInference.inferPhases` | pure; keyword regex with word-boundary matching |
| T5 | BPS → objective text | `BusinessProblemSpec` | prompt string | `agentHub.buildObjectiveFromSpec` | — |
| T6 | objective → plan DAG | objective + context + required phases | `PlanStep[]` | `agentHub.buildPlanPrompt` → LLM → `validatePlanResponse` | JSON array, agent allow-list, dep integrity, unique ids |
| T7 | message → partial target env | user message | `Partial<TargetEnvironment>` | `agentHub.extractTargetFromMessage` (LLM JSON) | best-effort; `{}` on parse failure |
| T8 | step → artifact(s) | `PlanStep` + `AgentExecutionContext` | `GeneratedArtifact[]` | `src/agents/**` | none (templates) |
| T9 | `SchemaSnapshot` → graph | adapter query results | `{nodes, edges}` | `BaseAdapter.snapshotToGraph` | key normalization across dialect column-name casings |
| T10 | source file → context nodes | file text | `BaseNode[]` with `Origin` | `SynthesisPipeline.extract*` | regex-based |
| T11 | graph → prompt block | `GraphManager` contents | Markdown string | `ContextFileManager.buildContextPrompt` | STRICT rules first, tables capped at 20, queries at 5; token estimate = `nodes × 50` (rough) |
| T12 (v0.10.0) | BPS → Greenfield/Brownfield | `BusinessProblemSpec` | `{implementationType, reason}` | `implementationType.classifyImplementationType` | pure; keyword evidence, same technique as T4 |
| T13 (v0.11.0) | BPS → Target/Source Context questions | `BusinessProblemSpec` | `ContextQuestion[]` (with `suggestedDefault`) | `targetContextQuestions.ts` / `sourceContextQuestions.ts` | pure; keyword-evidence defaults, every field still explicitly confirmed/changed by the user |
| T14 (v0.11.0) | step + context → LLM-generated artifact content | `PlanStep` + `AgentExecutionContext` | fenced code block → artifact content | `src/agents/llmCodegen.ts#generateWithLlm` | requires the response to be wrapped in the requested fence; unfenced ⇒ treated as failed, falls back to T8's template |
| T15 (v0.13.0) | plan + phase set → two approval flags | user action | `state.planApproved` / `state.stagesConfirmed` | `agentHub.approvePlan` / `confirmStages` | not a value transformation — an explicit user sign-off the orchestrator gates `executePlan()` on |

### 6.3 Schema: `BusinessProblemSpec` (the central artifact)

```
id: string                 # bps-<base36 timestamp>, stable across revisions
version: number            # bumped only when an APPROVED spec is materially re-drafted
status: draft | approved | superseded
problemStatement: string   # required
objectives: string[]       # required non-empty
successCriteria: string[]
scope: { in: string[](required non-empty), out: string[] }
constraints, assumptions: string[]
domain?: string ; stakeholders?, keyEntities?: string[]
createdAt, updatedAt: ISO ; approvedAt?, approvedBy?
# ── v2 (agentic synthesis) ──
businessRequirements?: string[]
dataFlows?: { id, source, target, description, transformations?, frequency? }[]
transformations?, dependencies?, acceptanceCriteria?, implementationConsiderations?: string[]
sourceCatalog?: { name, type: database|api|file|stream|saas|other, description?, availability? }[]
provenance?: { field, source: user|question|assumption|synthesis|skill, questionId?, skill? }[]
# ── implementation type classification (v0.10.0) ──
implementationType?: 'greenfield' | 'brownfield'
implementationTypeReason?: string
implementationTypeOverridden?: boolean   # true once the user manually overrides the classification
# ── Business Problem checkpoint (v0.13.0) ──
problemStatementApproved?: boolean       # gates approveSpec; reset to false on every fresh draft/revision
```

Persisted as native YAML (with a `# AutoDE Business Problem Specification` header). `SpecManager` also reads two **legacy** shapes: flat `scopeIn:`/`scopeOut:` and a `comprehensive: <JSON string>` block. ⚠ Worth knowing: the `implementationType*` fields existed on the type since v0.10.0 but were **not actually persisted to YAML until v0.13.0** — a bug (silently dropped by `serialize()`) found and fixed in the same pass that added `problemStatementApproved`; see §16.

**`PersistedPlan`** (`.ai-context/problems/<id>/plan/plan.yaml`, `PlanManager`) gained the mirror-image gate fields in v0.13.0: `planApproved?: boolean`, `planApprovedAt?: string`, `stagesConfirmed?: boolean`, `stagesConfirmedAt?: string` — updated in place via `PlanManager.patchGates()` without bumping the plan's version, the same pattern `patchInferredPhases()` already used for phase overrides.

### 6.4 Storage & retention

| Location | Contents | Committed to git? | Retention |
|---|---|---|---|
| `.ai-context/active-problem.json` | active business problem pointer (v0.12.0) | ✅ yes | current pointer only, no history |
| `.ai-context/problems/<id>/spec/business-problem.yaml` | current BPS for that business problem | ✅ yes | forever (git history is the version log) |
| `.ai-context/problems/<id>/spec/history/business-problem.v{N}.{status}.yaml` | archived prior revisions | ✅ yes | forever, written once per (version,status) |
| `.ai-context/problems/<id>/plan/plan.yaml` (+ `plan/history/`) | persisted plan, incl. gate fields (v0.13.0) | ✅ yes | version history, same pattern as spec |
| `.ai-context/problems/<id>/context/target-context.yaml` / `source-context.yaml` | Target/Source Context (v0.11.0) | ✅ yes | single current record per spec version — no history |
| `.ai-context/problems/<id>/artifacts/0X-<phase>/**` | generated artifacts for that business problem | ✅ yes (visible, meant to be committed/PR'd) | user-managed |
| `.ai-context/sources.yaml` | source registry — shared | ✅ yes | — |
| `.ai-context/context/**` | authoritative context — shared | ✅ yes | team-owned |
| `.ai-context/target-environment.yaml` | `TargetConfigManager`'s generic tool-preference profiles — shared, distinct from Target Context above | ✅ yes (per `.gitignore`) | — |
| `.ai-context/derived/**`, `state.json`, `*.tmp.*` | compiled graph, transient — shared | ❌ gitignored | regenerable |
| `.ai-context/chats/**` | chat sessions (Phase F) — shared | ❌ gitignored (local/exploratory) | grows unbounded, see §16 R20 |
| `.ai-context/schema-graph.json` | legacy schema graph | 💡 not gitignored (only `derived/`, `state.json`, `*.tmp.*`, `chats/` are) — watch for accidental commits; also not moved under `problems/<id>/`, see §5.4 | regenerable |
| VS Code Global settings | connection + LLM config | n/a (user profile) | — |
| SecretStorage | API keys, SF password/passphrase | n/a (OS keychain) | — |

There are **no databases, no vector indexes, no buckets, no queues, no event streams**. The `derived/embeddings/` directory is specified but never written.

---

## 7. AI/ML Components

### 7.1 Models used

AutoDE **does not host or train any models.** It calls external LLMs. There are no embedding models, classifiers, ranking models, or forecasting models in the codebase (the `GraphManager` "relevance scoring" is graph BFS with exponential decay, not ML).

| "Model" | Purpose | Input | Output | Invocation path |
|---|---|---|---|---|
| Configured LLM (`activeLlmProvider` / `activeLlmModel`, default `copilot` / `gpt-4o-mini`) | (a) draft/revise BPS, (b) run interview turns, (c) synthesize comprehensive BPS, (d) extract target env, (e) generate plan DAG, (f) grounded chat | assembled prompt string + system prompt + optional justification | text (JSON for a–e, prose for f) | `agentHub.callConfiguredLlm(prompt, systemPrompt?, justification?)` → `getLlmAdapter(provider)` (`llmProviders.ts`, Phase C) → `adapter.complete(...)` |
| GitHub Copilot models (`vscode.lm`) | same as above when provider = `copilot` | `LanguageModelChatMessage[]` (system prompt sent as a **leading Assistant message** — the LM API has no system role) | streamed text (concatenated) | `LanguageModelAdapter.complete()` → `model.sendRequest(...)` with 60s timeout via `Promise.race` |
| Claude Code CLI | same as above when provider = `claude` | prompt on **stdin**; system prompt via `--append-system-prompt`; `--model` when it looks like a Claude model | JSON envelope → `.result` text | `ClaudeCodeAdapter.complete()` → `spawn('claude', ['-p','--output-format','json', ...])` with a 90s/180s timeout |

**Provider fan-out — `src/core/llmProviders.ts` (Phase C, v0.9.0; each row below is one `LlmAdapter` class, looked up by `getLlmAdapter(provider)`):**

| Provider | Transport | Endpoint | Auth | Notes |
|---|---|---|---|---|
| `copilot` | `vscode.lm` | in-process | none (consent gate: `languageModelProgrammaticConsent` — or legacy `copilotProgrammaticConsent` — must be `true`) | Default. `require('./languageModelAdapter')` lazy-loaded; selects `vendor: 'copilot'`. |
| `claude` | `child_process` (`claude -p`) | local subprocess | none (same consent gate as `copilot`; uses the user's Claude Code login) | `ClaudeCodeAdapter` runs the Claude Code CLI headless (`--output-format json`). `activeLlmModel` → `--model` when it looks like a Claude model. No `vscode.lm`, so it never routes through Copilot. Prompt on stdin; JSON `result` parsed out. Tools off unless `allowTools` (grounded chat → `Read`/`Grep`/`Glob`). |
| `openai` | `fetch` | `api.openai.com/v1/chat/completions` | `Bearer` (SecretStorage `llmApiKey`) | `temperature: 0` |
| `anthropic` | `fetch` | `api.anthropic.com/v1/messages` | `x-api-key` + `anthropic-version: 2023-06-01` | `max_tokens: 4096`, `temperature: 0` |
| `azure-openai` | `fetch` | `settings.llmEndpoint` (or a placeholder) | `api-key` header | |
| `gemini` | `fetch` | `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=` | key in URL | |
| `ollama` | `fetch` | `localhost:11434/api/chat` | none | `format: 'json'`, `stream: false` |

Responses from the `fetch`-based providers pass through `extractJsonText()` which strips ```` ```json ```` fences **only if the payload looks like JSON** (so prose chat keeps its markdown). The `copilot` (`vscode.lm`) and `claude` (Claude Code CLI) paths return their text as-is — callers that need JSON still run it through `validatePlanResponse` / `parseComprehensiveSpec`.

### 7.2 Prompt engineering

There is **no native tool-calling anywhere.** Every "agentic" decision is the LLM returning a **JSON object matching a prompt-described schema**, which is then **validated deterministically** in code. This is a deliberate choice so the loop works on Copilot's text-only `vscode.lm` as well as every other provider (`technical-design.md` §2.8).

System prompts (all in `src/core/`):

| Prompt constant | File | Used for |
|---|---|---|
| `SPEC_SYSTEM_PROMPT` | `agentHub.ts` | Single-shot BPS draft/revise (T1). "Respond with a single valid JSON object only." |
| `CHAT_SYSTEM_PROMPT` | `agentHub.ts` | Grounded chat when spec is approved. "Never fabricate table names…" |
| `PLANNER_SYSTEM_PROMPT` | `agentHub.ts` | Default for `callConfiguredLlm` — "Respond with a JSON array only." |
| `DISCOVERY_SYSTEM_PROMPT` | `specOpsPrompts.ts` | Interview turn — describes the `ask`/`ask_many`/`synthesize`/`done` action schema. |
| `SYNTHESIS_SYSTEM_PROMPT` | `specOpsPrompts.ts` | Comprehensive BPS synthesis — describes the full v2 JSON shape. |
| (inline) target extraction prompt | `agentHub.extractTargetFromMessage` | Extract `{platform, database, schema, transformationTool, ...}` |
| (inline) plan prompt | `agentHub.buildPlanPrompt` | The DAG spec + the 7 valid `assignedAgent` values + phase constraint |

### 7.3 The "skills" system (SpecOps)

`skills/*.json` — 7 composable interview skills. Each has `id`, `order`, `systemPrompt`, `questionGuidance`, `specFields` (which BPS fields it owns), `exampleQuestions`.

| Skill (`order`) | Owns spec fields |
|---|---|
| `requirements-discovery` (1) | businessRequirements, objectives, successCriteria, scope, stakeholders, keyEntities |
| `source-catalog` (2) | sourceCatalog |
| `data-flow` (3) | dataFlows, dependencies |
| `transformations` (4) | transformations |
| `quality-acceptance` (5) | acceptanceCriteria, successCriteria |
| `constraints-assumptions` (6) | constraints, assumptions |
| `synthesis` (7) | *(none — it's the non-question finalizer)* |

The union of all `specFields` seeds the coverage map. The interview stops when **coverage is complete** OR **`turnCount ≥ turnBudget` (12)**. Users can override any skill by dropping a same-`id` JSON file in `.ai-context/skills/`.

### 7.4 RAG analysis

**There is no real RAG.** What exists:

- **Ingestion:** `SynthesisPipeline` (rule-based, regex) + `ContextFileManager` (YAML loaders) → `GraphManager` (in-memory).
- **Retrieval:** `ContextFileManager.buildContextPrompt()` does a **naive concatenation** of the whole graph (STRICT rules, first 20 tables, all terms, first 5 queries) into Markdown. No query, no vector search, no ranking, no token budget (just a `nodes × 50` estimate).
- **Generation:** that Markdown block is prepended to the chat/plan prompt.

`GraphManager.traverseNeighborhood()` implements seeded BFS with `relevance = seedScore × decay^hops` — the *machinery* for context retrieval exists, but nothing calls it, and it doesn't format or count tokens. The planned `ContextRetriever` + embedded vector engine (`requirements.md` §16.2) is the missing piece.

### 7.5 Agent framework analysis

| Aspect | Reality |
|---|---|
| **Agent roles** | Orchestrator (`DataAgentHubHub`, and since v0.13.0 also the lifecycle's enforcement point) + 7 leaf executors (5 LLM-first w/ template fallback since v0.11.0, 1 stubbed real-connection assessor, 1 real SQL runner) + `toolSkillAgent` (Phase D, real tool access, not auto-planner-reachable). |
| **Tools** | None in the LLM sense for the 7 planner-reachable agents. Leaf agents are plain functions, not tool schemas. `toolSkillAgent` is the one exception — real file/command tool access via `claude`'s own loop or a `vscode.lm` tool-calling loop AutoDE owns. |
| **Memory** | `PlanState` (in-memory working copy; steps/status/phases/implementation type persisted to disk by `PlanManager` as of v0.10.0, plus `planApproved`/`stagesConfirmed` as of v0.13.0 — `PlanState.artifacts` still in-memory-only) + `IntakeSession` (in-memory, lost on reload — 🟥 backlog) + BPS (on disk, per business problem since v0.12.0) + Target/Source Context (on disk, v0.11.0) + context graph (in-memory, workspace-level/shared, compiled snapshot on disk but gitignored/transient — a durable markdown snapshot per spec version is written on approval, v0.10.0; its spec-derived layer is swapped per active business problem, v0.12.0). |
| **Planning** | LLM produces a DAG once (`generatePlanFromSpec` → `generatePlanInternal`, v0.13.0's renamed/gated version of the old public `generatePlan`); re-planning is offered on step failure (`handleFailure` → `Re-plan` button → `generatePlan(replanObjective)` — now itself gated, see §5.3). Validation (v0.10.0) also runs a topological-sort cycle check and rejects steps outside the required phase set. A freshly generated plan always needs its own Plan Approval + Stage Confirmation before it can execute (v0.13.0). |
| **Routing** | `AGENT_EXECUTORS[step.assignedAgent]` — a static map. The LLM chooses the agent per step from a 7-value allow-list (`toolSkillAgent` deliberately excluded — see the note in §3's agent table). |
| **Decision logic** | Phase requirement = deterministic keyword rules, now also weighted by Greenfield/Brownfield classification and the synced Context Layer (v0.10.0, §2.12 of the technical design). Step ordering = LLM + dependency validation. Interview next-action = LLM JSON validated by `SpecOpsEngine`. Plan/stage approval = explicit user action, not inferred (v0.13.0). |

**Agent interaction map:**

```
                    ┌──────────────────────────┐
                    │  DataAgentHubHub          │
                    │  (orchestrator + since    │
                    │   v0.13.0, lifecycle gate)│
                    └──┬────────────────────┬───┘
       generatePlanFromSpec → LLM (DAG)      │ executePlan (GATED: planApproved
       ★ gated on spec+business-problem+     │  && stagesConfirmed, v0.13.0)
         context approval (v0.13.0)          ▼
        ┌────────────┬───────────┬──────────┼───────────┬──────────────┐
        ▼            ▼           ▼           ▼           ▼              ▼
 sourceAssessment  sttm     dataModeler  ingestion  transformScaffold architecture
   (discover)     (model)     (model)     (build)     (build)         (validate)
   [degrades      [LLM-first,  [LLM-first,  [LLM-first, [LLM-first,     [LLM-first,
    gracefully,    template    template     template    template       template
    v0.11.0]       fallback]   fallback]    fallback]   fallback,       fallback]
                                                          v0.11.0]
        │                                                                
        ▼ (only agent that calls out)                                    
 ConnectionManager → SnowflakeAdapter/DatabricksAdapter  [STUBS, unchanged since v0.8.0]
        │                                                                
        ▼                                                                
 .ai-context/schema-graph.json → GraphManager  [workspace-level — ⚠ see §5.4]

 snowflakeExecutor (build) ──→ snowflake-sdk ──→ real Snowflake  [hardcoded username bug,
                                                    still open — degrades gracefully on no
                                                    connection since v0.11.0]
```

---

## 8. Prompt Inventory

| # | Name | Location (file:symbol) | Trigger | Variables interpolated | Expected output | Consumer |
|---|---|---|---|---|---|---|
| P1 | Spec draft/revise (system) | `agentHub.ts:SPEC_SYSTEM_PROMPT` | first chat w/ no SpecOps, or `refineSpec` | *(system only)* | JSON object (v1 spec shape) | `parseSpecResponse` |
| P2 | Spec draft/revise (user) | `agentHub.generateSpec` | same | `trimmed` prompt, `previousBlock` (existing spec JSON) | — | — |
| P3 | Chat (system) | `agentHub.ts:CHAT_SYSTEM_PROMPT` | approved-spec chat | *(system)* | prose markdown | webview `chatResponse` |
| P4 | Chat (user) | `agentHub.chat` → `buildChatContextBlock` | approved-spec chat | BPS summary, `## Source Environment` (schemaContext), current plan summary, `## Target Environment` block, user message | prose | — |
| P5 | Planner (system) | `agentHub.ts:PLANNER_SYSTEM_PROMPT` | `callConfiguredLlm` default | *(system)* | JSON array | `validatePlanResponse` |
| P6 | Plan (user) | `agentHub.buildPlanPrompt` | `generatePlan` | `providerName`, `schemaContext`, `requiredPhases` (phase constraint), `targetBlock`, `objective`, the 7 valid agent keys, JSON step shape | JSON array of `{id, assignedAgent, taskDescription, status, dependsOn, validationRules}` | `validatePlanResponse` |
| P7 | Target extraction | `agentHub.extractTargetFromMessage` (inline) | `chat` / `generatePlan` when no target set | `message` | JSON `{platform, database, schema, transformationTool, orchestrationTool, modelingApproach, namingConvention}` | `buildTargetFromPartial` |
| P8 | Discovery turn (system) | `specOpsPrompts.ts:DISCOVERY_SYSTEM_PROMPT` (+ `REVISION_DISCOVERY_RULES` appended when revising) | `discoverNextAction` | *(system)* | JSON action | `SpecOpsEngine.validateAction` |
| P9 | Discovery turn (user) | `specOpsPrompts.buildDiscoveryTurnPrompt` | same | `problemStatement`, Q&A so far, `turnCount/turnBudget`, coverage gaps, question-skill guidance + one example each — plus, when revising: the requested change, `renderSpecSnapshot(previousSpec)`, registered repo context (`extraContext`), and attachments | — | — |
| P10 | Synthesis (system) | `specOpsPrompts.ts:SYNTHESIS_SYSTEM_PROMPT` (+ `REVISION_SYNTHESIS_RULES` appended when revising) | `synthesizeComprehensiveSpec` | *(system)* | JSON (full v2 shape) | `parseComprehensiveSpec` |
| P11 | Synthesis (user) | `specOpsPrompts.buildSynthesisPrompt` → `composeSynthesisPrompt` | same | `problemStatement` + all Q&A + insights — plus, when revising: requested change, previous-spec snapshot, registered repo context, attachments | — | — |
| P12 | Re-plan objective | `agentHub.handleFailure` (inline string) | step failure + user picks "Re-plan" | failed `step.id`, `step.assignedAgent`, `error` | (feeds P6) | `generatePlan` |
| P13 | Language model test | `LanguageModelAdapter.testCall` (copilot) / `ClaudeCodeAdapter.testCall` (claude) | `testLanguageModel` command — takes an optional `'copilot'`/`'claude'` arg so each settings card's Test button tests its own provider | *(fixed)* a "say hello" / "PONG" prompt | any text | info toast |

There are **no prompt templates on disk** (no `prompts/` folder, no `.prompt` files). All prompts are TypeScript string constants/builders. The `skills/*.json` files carry per-skill `systemPrompt` fragments but those are surfaced to the LLM only as *guidance text inside P9*, not sent as separate system prompts.

---

## 9. Configuration Guide

All settings live under `autoDataEngineeringHub.*` in `package.json → contributes.configuration`, read via `ConfigurationManager.getSettings()`, written to **`ConfigurationTarget.Global`** (user profile, not `.vscode/settings.json`).

| Configuration | Type / default | Purpose | Impact if wrong / unset |
|---|---|---|---|
| `defaultProvider` | enum, `snowflake` | Source data platform | Wrong adapter chosen; credential mapping mismatch |
| `defaultSnowflakeAccount` / `Username` / `Warehouse` / `Database` | string, `""` | Snowflake connection | Source assessment / snowflakeExecutor fail with "missing credentials" |
| `defaultSnowflakeSchema` | string, `PUBLIC` | default schema | metadata queries scoped wrong |
| `defaultSnowflakeRole` | string, `SYSADMIN` | connection role | permission errors (once adapters are real) |
| `defaultSnowflakeAuthMode` | enum, `key-pair` | auth strategy | `key-pair` requires a key path or password or `connect()` throws |
| `snowflakePrivateKeyPath` | string, `""` | key-pair auth | — |
| `metadataCachingDurationMinutes` | number, `15` | (declared) cache TTL | **not used anywhere yet** 💡 |
| `queryTimeoutSeconds` | number, `120` | (declared) query timeout | **not used in the wired path** (adapters hardcode `timeoutMs`) 💡 |
| `readOnlyMode` | boolean, `true` | restrict to read-only | **not enforced anywhere** 💡 |
| `enableSessionReuse` | boolean, `true` | reuse connections | **not used** 💡 |
| `autoDocumentationEnabled` | boolean, `true` | auto-gen docs | **not checked by any agent** 💡 |
| `telemetryEnabled` | boolean, `false` | opt-in telemetry | flag is read into settings but **no telemetry code exists** 🟥 |
| `activeLlmProvider` | enum, `copilot` (also `claude`, `openai`, `anthropic`, `azure-openai`, `gemini`, `ollama`) | which LLM | wrong provider → auth failure |
| `activeLlmModel` | string, `gpt-4o-mini` | model id/family | `copilot`/`claude`: matched loosely by family/id/name (empty = auto-pick); others: passed through |
| `llmEndpoint` | string, `""` | Azure OpenAI endpoint | Azure calls hit a placeholder URL and fail |
| `artifactDirectory` | string, `artifacts` (changed from `.ai-context/artifacts` in v0.12.0) | where artifacts are written, **relative to the active business problem's own folder** (`.ai-context/problems/<id>/`) since v0.12.0 — previously relative to the workspace root | leading/trailing slashes stripped; falls back to `artifacts` |
| `extensionDisplayName` / `extensionDescription` | string | cosmetic | — |
| `languageModelProgrammaticConsent` | boolean, `false` | **gate for programmatic local-LLM use** — GitHub Copilot (`vscode.lm`) *and* the Claude Code CLI | if `false` (and legacy `copilotProgrammaticConsent` also `false`), every `copilot`/`claude` LLM call throws "programmatic use … is not enabled" |
| `claudeCodePath` | string, `""` | explicit path to the `claude` CLI for provider `claude`; empty = auto-detect (PATH → bundled extension binary) | wrong path → "no runnable CLI was found there" |
| `copilotProgrammaticConsent` | boolean, `false` | _deprecated_ — legacy consent flag, still honored as a fallback | — |

### Secrets (VS Code SecretStorage — OS keychain, never in files)

| Secret key (`SECRET_KEYS`) | Set via | Used by |
|---|---|---|
| `autoDataEngineeringHub.llmApiKey` | settings panel → `setLlmApiKey` | OpenAI/Anthropic/Azure/Gemini calls |
| `autoDataEngineeringHub.snowflakePassword` | settings panel | `testConnection`, `SourceAssessmentAgent`, `snowflakeExecutor` |
| `autoDataEngineeringHub.snowflakePrivateKeyPassphrase` | settings panel | Snowflake key-pair auth |
| `autoDataEngineeringHub.databricksToken` | (referenced in `SourceAssessmentAgent`, **no UI to set it** 💡) | Databricks connect |

### Required to do anything useful

1. `activeLlmProvider` + either `languageModelProgrammaticConsent: true` (and, for `copilot`, Copilot Chat installed + signed in; for `claude`, the Claude Code CLI installed + signed in — run **AutoDE: List Language Models** to see where it resolves from) **or** an `llmApiKey` for a cloud provider **or** Ollama running locally.
2. For source assessment: Snowflake account/username/warehouse/database + password/key — **but it won't produce real data until Phase 4**.

### Common failure points

- **"Programmatic use of GitHub Copilot is not enabled"** → tick the consent box in Settings → LLM Provider.
- **"The LLM returned invalid JSON"** → the model wrapped the array in prose or fences; `extractJsonText` + `validatePlanResponse` are strict. Try a stronger model or provider.
- **Empty source assessment** → adapter stubs (expected until Phase 4).
- **Cline crashes the dev host (SIGABRT / exit 134)** → the F5 config disables `saoudrizwan.claude-dev`; if you launch another way, disable it manually.
- **`.vscodeignore` / packaging** → `vsce package`; two stale `.vsix` files in the repo root are from earlier names.

---

## 10. Dependency Analysis

### 10.1 External services

| Service | Why it exists | How it's used | Failure impact |
|---|---|---|---|
| **GitHub Copilot** (`github.copilot-chat` + `vscode.lm`) | Zero-API-key LLM, default provider | `LanguageModelAdapter.detect({provider:'copilot'})` finds the extension + `selectChatModels({vendor:'copilot'})`; `complete()` sends a request | All LLM features fail unless the user switches providers; detection returns a clear error |
| **Claude Code CLI** (`Anthropic.claude-code` extension, or a standalone `claude` install) | Zero-API-key LLM (`provider: 'claude'`) | `ClaudeCodeAdapter.resolve()`: `claudeCodePath` → PATH → `resources/native-binary/claude(.exe)` in the extension | Clear "CLI not found" error with install/setting guidance |
| **OpenAI / Anthropic / Azure OpenAI / Gemini** | Alternative LLMs | `fetch()` from the extension host | That provider's calls throw; user sees "LLM request failed: …" |
| **Ollama** (`localhost:11434`) | Local, private LLM | `fetch()` | Connection refused if not running |
| **Snowflake** | Primary target platform | *Intended*: `snowflake-sdk` in `SnowflakeAdapter` + `snowflakeExecutor`. *Actual*: only `snowflakeExecutor` connects (with a bug) | Source assessment / SQL execution unavailable |
| **Databricks** | Secondary platform | *Intended*: Databricks SQL connector. *Actual*: stub | metadata extraction unavailable |

No Kafka, Airflow, Redis, Postgres, Snowflake-as-metadata-store, or hosted vector DB — and `requirements.md` §13 explicitly **forbids** server dependencies to keep the VSIX self-contained.

### 10.2 npm dependencies

| Package | Role | Risk |
|---|---|---|
| `ajv` ^8 | JSON Schema validation (`ContextValidator`) | Low — pure JS |
| `yaml` ^2 | YAML parse/serialize (`src/context/Yaml.ts`) | Low — pure JS, chosen over hand-rolled parser for correctness |
| `snowflake-sdk` ^2 | Snowflake connectivity | **Native bindings** → VSIX packaging complexity; currently only used by one file |
| `typescript`, `@types/*` (dev) | build + types | — |

### 10.3 Internal dependency map (import direction)

```
extension.ts
  → core/agentHub ─────────────────────────────┐
  → core/configManager                          │
  → core/webviewProvider ──┐                    │
  → core/panelProvider     │                    │
  → dqm/ConnectionManager  │                    │
  → context/ArtifactWriter, context/PlanManager │       ★ constructed per-active-problem
  → context/ActiveProblemManager, core/problemSlug     │  via applyProblemRoot (v0.12.0)
  → editors/*              │                    │
                           ▼                    ▼
        webviewProvider → { agentHub, context/*, core/specOps,
                            core/skillRegistry, core/webviewSecurity,
                            core/implementationType, core/targetContextQuestions,
                            core/sourceContextQuestions }
                           │
        agentHub → { agents/**, agents/llmCodegen, spokes/snowflakeExecutor,
                     context/ArtifactWriter, context/PlanManager,
                     core/phaseInference, core/specOps, core/specOpsPrompts,
                     core/specSynthesis, core/languageModelAdapter (lazy require),
                     core/configManager, core/types }
                           │
        agents/discover/SourceAssessmentAgent → dqm/ConnectionManager → dqm/adapters/*
        agents/{ingestion,sttm,dataModeler,transformScaffold,architecture} → agents/llmCodegen
        agents/* → core/types  (only, plus the llmCodegen import above — v0.11.0)
                           │
        context/ContextFileManager → context/{GraphManager, Yaml, GraphPersistence, ContextValidator}
        context/SpecManager / PlanManager / TargetContextManager / SourceContextManager /
          SourceRegistry / TargetConfigManager / ActiveProblemManager → context/Yaml
        dqm/BaseAdapter → context/types (for node shapes)
```

**Coupling notes:**

- `core/types.ts` and `context/types.ts` are the two universal leaves. `phaseInference`, `specOps`, `specOpsPrompts`, `specSynthesis` depend on **nothing but types** — keep it that way (the tests rely on it).
- `agentHub.ts` is the **god object** — 1321 lines as of v0.13.0 (up from "~1040" claimed at v0.8.0, though the LLM provider fan-out was extracted to `llmProviders.ts` in Phase C in between; the growth since is the lifecycle-gate logic, business-problem-checkpoint handling, and phase/plan-state management added in v0.10.0–v0.13.0): orchestration + spec logic + target-env logic + JSON parsing helpers + (v0.13.0) the lifecycle enforcement gates. This is still the #1 refactor target. 💡
- `webviewProvider.ts` is now the **larger** of the two — 1445 lines, owning the spec-driven chat state machine, wiring 7 context/persistence services (up from 5), business-problem activation/switching (v0.12.0), and ~56 message-type case branches in `handleMessage` (up from "~25" at v0.8.0 — ⚠ recount worth re-verifying periodically as this grows further, this was a grep count, not hand-verified per-case).
- `agents/*` are cleanly decoupled (they only import `core/types`) — good.
- `dqm/BaseAdapter` reaching into `context/types` for `TableNode`/`ColumnNode` is a minor layering smell (adapter layer knows about the graph schema). 💡

### 10.4 Shared abstractions

- `AgentExecutionContext` / `AgentExecutionResult` — the sub-agent contract.
- `GeneratedArtifact` — the artifact contract (agents produce, `ArtifactWriter` consumes).
- `Origin` — provenance envelope on every derived context node.
- `applyCspNonce()` — used by every single webview provider + editor.
- Atomic-write idiom (temp file → `rename`) — reimplemented in `SpecManager`, `PlanManager`, `TargetContextManager`, `SourceContextManager`, `ActiveProblemManager`, `SourceRegistry`, `TargetConfigManager`, `ArtifactWriter`, `BaseAdapter`, `GraphPersistence`. 💡 Could be one helper — the count of places reimplementing it keeps growing (5 new callers added across v0.10.0–v0.12.0), which strengthens rather than weakens the case for extracting it.
- `contextRoot: vscode.Uri` constructor parameter (v0.12.0) — the pattern every business-problem-scoped manager (`SpecManager`, `PlanManager`, `TargetContextManager`, `SourceContextManager`, `ArtifactWriter`) now shares: the caller resolves and passes in the root, the manager never assumes it. Introduced specifically so the same manager code works whether the root is the workspace (pre-v0.12.0 behavior) or one business problem's folder — see §4.4.

---

## 11. Production Operations

### 11.1 Deployment model

**There is no deployment.** AutoDE ships as a `.vsix` that a user installs into VS Code (or would, from the Marketplace — `publisher: "Arun Gribta"`). "Production" = the user's laptop.

- **Build:** `npm run compile` (`tsc -p ./`) → `dist/**/*.js` (+ source maps).
- **Package:** `npm run package` (`vsce package`) → `.vsix`. `vscode:prepublish` runs compile.
- **Install:** `code --install-extension auto-data-engineering-hub-0.5.0.vsix` or drag into VS Code.
- **`main`:** `./dist/extension.js`.
- **What's shipped:** governed by `.vscodeignore` (not shown here — check it before packaging; `node_modules` for `ajv`/`yaml`/`snowflake-sdk` must be included or bundled).

### 11.2 CI/CD

**None in the repo.** No `.github/workflows/`, no CI config. Releases are manual (`vsce package` + `vsce publish`).

### 11.3 Tests

- **Command:** `node test/functional.test.cjs` (runs against `dist/`, so compile first). Not in `package.json scripts` — you run it directly.
- **Framework:** none — a hand-rolled runner + `node:assert` + a `require('vscode')` mock installed via `Module._load` override.
- **Coverage (90 tests as of v0.13.0, up from 52 at v0.8.0, all in one file):**
  - `LanguageModelAdapter` (Copilot) detect/complete + consent gating
  - `getLlmAdapter()` / `LLM_ADAPTERS` dispatch + fallback (Phase C); an OpenAI-adapter request/response round-trip via a mocked `global.fetch`; missing-API-key error surfacing
  - `ClaudeCodeAdapter` CLI resolution (setting / PATH / bundled-in-extension), `complete()` spawn + JSON parse, error surfacing (via a mocked `child_process`)
  - `toolSkills.parseSkillMarkdown` / `loadToolSkillsFromDirectory` — frontmatter parsing (lenient), resource-file listing, missing-SKILL.md skip (Phase D; real temp-directory fixture)
  - `phaseInference` — `inferPhases`, `computePhaseStatuses`
  - `classifyImplementationType()` (v0.10.0) — brownfield/greenfield/mixed evidence
  - `skillRegistry` — parse/order/field-mapping/directory-load
  - `SpecOpsEngine` — coverage, stop condition, action validation, `applyAction`
  - `specOpsPrompts.buildDiscoveryTurnPrompt` / `buildSynthesisPrompt`, including revision seeding (previous spec + change request + registered context + attachments)
  - `specSynthesis.parseComprehensiveSpec`, including revision field-preservation, provenance carry-forward, and version-bump-only-on-approved
  - `agentHub.generatePlan` / `generatePlanFromSpec` / `synthesizeComprehensiveSpec` (with a mock LM)
  - `generateWithLlm()` (v0.11.0) — only accepts a properly fenced response, falling back to `undefined` otherwise
  - `sourceAssessmentAgent`/`snowflakeExecutor` graceful degradation with no target connection (v0.11.0)
  - `buildTargetContextQuestions()` / `buildSourceContextQuestions()` (v0.11.0) — keyword-evidence defaults
  - `TargetContextManager` / `SourceContextManager` — persist/round-trip/approval-per-spec-version, Not Applicable tracking (v0.11.0)
  - `ArtifactWriter`/`ArtifactStalenessScanner` — spec-tagged folder writes + current/stale/untagged classification (real temp-directory fixture)
  - `Yaml`, `ContextValidator`, `GraphPersistence`
  - `SpecManager` / `SourceRegistry` / `TargetConfigManager` round-trips (incl. legacy formats); since v0.13.0 also `implementationType`/`problemStatementApproved` round-tripping
  - `PlanManager` — version history across versions and reload (v0.10.0)
  - `ContextFileManager` authoritative-load + atomic graph persist; `getContextStats()` source-environment-tagged node counts
  - `SynthesisPipeline.synthesizeFromSpec()` — spec-derived graph nodes with provenance, re-sync on revision (v0.10.0)
  - `generateProblemSlug()` / `ActiveProblemManager` / `resetForNewProblem()` (v0.12.0) — slug generation + collision avoidance, pointer round-trip, problem listing, full-reset state clearing
  - `generatePlan()` / `generatePlanFromSpec()` / `executePlan()` orchestrator gates, `setPhaseOverride()` invalidating Stage Confirmation, `PlanManager.patchGates()` round-trip (v0.13.0 — see `requirements.md` §8.12)
  - `discoveryProgress.buildDiscoveryProgress()` / `skillNameForField()` (v0.13.0 follow-up — §8.13) — per-skill status derivation, deterministic skill resolution

  **Notable gap:** `ToolSkillAgent.ts`'s tool-calling loop (Phase D) has **no automated test** — mocking `vscode.lm`'s streaming tool-call/tool-result protocol faithfully was judged lower-value than the time it would cost versus real verification. The Claude execution path was instead verified by hand against the actual bundled Claude Code CLI (confirmed `--permission-mode acceptEdits` is required and sufficient for a real file write); the Copilot path's tool-calling code compiles against the real `@types/vscode` definitions and follows the documented API, but has not been run against a live Copilot session.
  - `extension.activate()` registers subscriptions
- **Gaps (unchanged since v0.8.0):** `GraphManager` traversal correctness, `SynthesisPipeline`'s registered-source extractors' provenance (as opposed to `synthesizeFromSpec`'s, which is tested), adapter connect/query, per-kind AJV, the 5 LLM-first agents' *fallback template* output specifically (the LLM-first path itself is tested via `generateWithLlm`'s fencing behavior, but not each agent's individual template content). **New gap (v0.13.0):** no test exercises the webview-layer gates directly (`approveSpec`'s `problemStatementApproved` rejection, `approveBusinessProblem`) — only the `AgentHub`-level equivalents are covered; the webview cases were reasoned through by code inspection, matching the established pattern of testing orchestration logic at the hub level rather than the message-bridge level.

### 11.4 Monitoring / logging / tracing / alerting

| Concern | Reality |
|---|---|
| **Logging** | `console.log` in the extension host + `logListener` → `postMessage({type:'logEntry'})` → rendered in the chat stream (dimmed). No log levels, no file logs, no output channel (except `debugListExtensions` and a couple of ad-hoc ones). |
| **Metrics** | None. `getContextStats()` / `getDiagnostics()` are UI counters, not telemetry. |
| **Tracing** | None. |
| **Alerting** | `vscode.window.showErrorMessage` toasts for failures; `handleFailure` shows a "Re-plan"/"Close" dialog. |
| **Telemetry** | `telemetryEnabled` setting exists (default `false`); **no implementation** (🟥 `requirements.md` §16.4). |

### 11.5 Failure & recovery

- **LLM failure** → error surfaced to chat as `{chatResponse, error:true}` or thrown from `generatePlan` → toast.
- **Step failure** → step `failed`, `PlanState.status='failed'`, `handleFailure()` offers a Re-plan (which feeds the error back into a new plan prompt).
- **Blocked DAG** (unsatisfiable deps / cycle) → the first unfinished step is marked `failed` with a diagnostic message.
- **Corrupt `.ai-context` files** → logged and tolerated (`ContextFileManager` catches per-file), engine loads what it can.
- **Atomic writes** → a crash mid-write leaves the previous valid file (temp file is the casualty).
- **No auto-retry, no backoff, no circuit breaker.**

---

## 12. Developer Mental Model

### "If I Joined the Team Tomorrow"

#### Learn First (day 1–2)

1. **It's one process.** VS Code Extension Host + webviews. `postMessage` is the only IPC. No servers.
2. **The BPS is the center of gravity, one per business problem.** Since v0.12.0, a workspace can hold several business problems, each with its own `.ai-context/problems/<id>/spec/business-problem.yaml` — `active-problem.json` says which one is current. Everything keys off `specId`/`specVersion` and `status`. Read `SpecManager.ts` and `types.ts:BusinessProblemSpec`.
3. **The spec-driven chat router.** In `webviewProvider.handleMessage('chat')`: no active business problem → interview; draft → revise; approved → grounded chat. This is the single most confusing thing for newcomers ("why isn't my chat message answering me?" → because there's a draft spec waiting for confirmation/approval — see next point).
4. **The lifecycle now has real gates, not just a suggested order (v0.13.0).** Business Problem confirm → Spec approve → Target/Source Context approve → Plan approve → Stage confirm → Execute — each is an explicit action, and `AgentHub` itself (not just the UI) throws if you try to skip one. This replaced a state where at least 7 UI entry points could reach plan generation/execution ungated. Read `requirements.md` §8.12 and §5.3 of this doc before touching anything plan-related.
5. **Phase inference is deterministic and pure.** `phaseInference.ts`. Keyword evidence in the spec corpus, `scope.out` vetoes, natural dependency chain. No LLM. Fully unit-tested — read the tests.
6. **The orchestrator does most of the AI; the leaf agents now do some too (v0.11.0).** `agentHub.ts` calls the LLM for planning; 5 of the 7 `src/agents/**` executors now try an LLM call first and fall back to string templates — don't assume "leaf agent = template," but don't assume "leaf agent = always LLM-grounded" either; check `src/agents/llmCodegen.ts#generateWithLlm`'s callers.
7. **`callConfiguredLlm` is the single LLM chokepoint.** Provider fan-out lives there. Copilot is special (no key, consent gate, `vscode.lm`).
8. **Run the extension:** F5 (uses the launch config that disables Cline). Run tests: `npm run compile && node test/functional.test.cjs` (90 tests as of v0.13.0).

#### Learn Next (week 1–2)

9. The **SpecOps engine** (`specOps.ts`) + **skills** (`skills/*.json`) + the two-mode question UI (`specQuestion` bubble vs `specQuestions` form).
10. The **Context Layer**: `GraphManager` (nodes/edges/indexes/BFS, workspace-level/shared), `ContextFileManager` (loaders + `buildContextPrompt`), `SynthesisPipeline` (rule-based extraction + `synthesizeFromSpec`), the `.ai-context/` file hierarchy including the `problems/<id>/` split (`requirements.md` §8.11).
11. **Target/Source Context** (`TargetContextManager`/`SourceContextManager`, v0.11.0) — distinct from the older `TargetConfigManager`; the fixed Q&A in `targetContextQuestions.ts`/`sourceContextQuestions.ts`; how `computeContextGateStatus()` feeds `hub.setContextGateReady()`.
12. The **adapter layer** (`src/dqm/**`) — the interface is solid; the implementations are stubs. If you're doing Phase 4, this is your home.
13. The **artifact pipeline**: `GeneratedArtifact` → `context.addArtifact` / `result.artifacts` → `ArtifactWriter.write` → `<contextRoot>/artifacts/0X-<phase>/`.
14. The **webview message protocol** (both directions) — `technical-design.md` Appendix A is a good reference, but verify against `webviewProvider.handleMessage`.
15. The **custom editors** and their `media/editors/*.html`.
16. The **multi-business-problem workspace** (`ActiveProblemManager`, `problemSlug.ts`, `webviewProvider.activateProblem`/`ensureActiveProblem`) — `requirements.md` §8.11.

#### Ignore For Now

- `src/features/**` (dead code — candidate for deletion).
- `src/spokes/{architectureAgent,ingestionAgent,sttmAgent}.ts` (superseded; only `snowflakeExecutor.ts` matters).
- The two root `.vsix` files.
- `mock_activate.js` (gitignored dev scratch).
- CSS details in `sidebar.html` (~700 lines of it, though the file overall is now 1611) unless you're doing UI work.
- The AutoDE Dashboard panel (`panel.html`/`panelProvider.ts`) — parked, see §1/§16.
- Everything in the design doc marked "Future" / "Phase 3c/3d".

---

## 13. Recommended Learning Path

| Step | Do this | You'll understand |
|---|---|---|
| 1 | Read `README.md` + `docs/technical-design.md` §1–§2 | The pitch and the north-star flow |
| 2 | Read `src/core/types.ts` end to end | The vocabulary of the whole system |
| 3 | Read `src/extension.ts` | What's registered, activation, commands |
| 4 | Read `src/core/webviewProvider.ts:handleMessage` | The message protocol + spec-driven routing |
| 5 | Read `src/core/agentHub.ts` (skim the 6 `call*` methods, focus on `generateSpec`, `generatePlan`, `executePlan`, `buildPlanPrompt`) | The orchestrator |
| 6 | Read `src/core/phaseInference.ts` **and** its tests in `test/functional.test.cjs` | Deterministic phase logic |
| 7 | Read `src/core/specOps.ts` + `src/core/specOpsPrompts.ts` + one skill JSON | The agentic interview |
| 8 | Read one templated agent (`src/agents/build/TransformationScaffolderAgent.ts`) + `src/context/ArtifactWriter.ts` | How artifacts get made and written |
| 9 | Read `src/context/GraphManager.ts` + `src/context/ContextFileManager.ts` | The context layer |
| 10 | Read `src/dqm/types.ts` + `src/dqm/BaseAdapter.ts` + `SnowflakeAdapter.ts` | The adapter design + what's stubbed |
| 11 | Read `src/context/SpecManager.ts` | BPS persistence + versioning + legacy formats |
| 12 | F5 the extension, run the full flow with Copilot, watch `.ai-context/` (including `.ai-context/artifacts/`) populate | The whole thing, live |
| 13 | Read `docs/requirements.md` §16 (Pending Tasks Backlog) | What's next and why |

---

## 14. Important Files to Read (ranked)

| # | File | Why it matters | Time | What you learn |
|---|---|---|---|---|
| 1 | `src/core/agentHub.ts` | The orchestrator + all LLM I/O + spec/plan/execute logic + (v0.13.0) the lifecycle enforcement gates | 50 min | 60% of the system's behavior |
| 2 | `src/core/types.ts` | Every domain type | 20 min | The shared vocabulary |
| 3 | `src/core/webviewProvider.ts` | Message bridge + spec-driven chat router + service wiring + (v0.12.0) business-problem activation | 35 min | How the UI drives the backend |
| 4 | `src/core/phaseInference.ts` | Deterministic phase requirement + status | 15 min | The "no manual step selection" principle in code |
| 5 | `src/extension.ts` | Activation, commands, provider registration | 10 min | The entry point and surface area |
| 6 | `src/core/specOps.ts` | Interview state machine + action validation | 20 min | Agentic requirements without tool-calling |
| 7 | `src/core/specOpsPrompts.ts` | Discovery + synthesis prompt assembly | 15 min | Exact LLM contracts for the interview |
| 8 | `src/core/specSynthesis.ts` | Comprehensive BPS parsing + provenance | 15 min | How v2 spec fields + traceability are built |
| 9 | `src/context/SpecManager.ts` | BPS persistence, versioning, history, legacy formats | 20 min | The system of record on disk |
| 10 | `src/core/languageModelAdapter.ts` + `claudeCodeAdapter.ts` | `vscode.lm` (Copilot) and Claude Code CLI (`claude -p`) integration, consent, timeouts | 15 min | The no-API-key LLM paths |
| 11 | `src/context/GraphManager.ts` | In-memory graph + BFS relevance | 20 min | The context data structure |
| 12 | `src/context/ContextFileManager.ts` | Context file loading + `buildContextPrompt` | 20 min | How context reaches prompts (and its limits) |
| 13 | `src/dqm/BaseAdapter.ts` | Metadata extraction orchestration + `snapshotToGraph` | 20 min | The adapter design; what real Phase 4 needs |
| 14 | `src/dqm/types.ts` | Adapter interface + snapshot types | 10 min | The platform-abstraction contract |
| 15 | `src/dqm/adapters/SnowflakeAdapter.ts` | Snowflake metadata queries + capabilities | 15 min | What's stubbed vs real |
| 16 | `src/agents/build/TransformationScaffolderAgent.ts` + `src/agents/llmCodegen.ts` | The richest agent (6-file dbt project, 2 of them LLM-generated since v0.11.0) + the shared LLM-first/template-fallback helper every other codegen agent calls | 20 min | The agent contract + the v0.11.0 grounding pattern |
| 17 | `src/agents/discover/SourceAssessmentAgent.ts` | The only agent that calls the adapter layer; also the graceful-degradation pattern (v0.11.0) | 15 min | Discover-phase wiring |
| 18 | `src/context/SynthesisPipeline.ts` | Rule-based context extraction + provenance + `synthesizeFromSpec`/graph-swap-on-switch (v0.10.0/v0.12.0) | 20 min | How registered files *and* the spec itself become graph nodes |
| 19 | `src/context/PlanManager.ts` + `src/context/TargetContextManager.ts` | Plan persistence + gate fields (v0.10.0/v0.13.0); spec-tied Target Context, distinct from `TargetConfigManager` (v0.11.0) | 20 min | The two persistence classes most newcomers confuse with something else |
| 20 | `src/core/webviewProvider.ts:activateProblem` / `src/context/ActiveProblemManager.ts` | Multi-business-problem activation/switching, the pointer file, the graph-swap-on-switch fix | 20 min | Why "start a new business problem" is safe and how state doesn't leak between problems |
| 21 | `test/functional.test.cjs` | The entire test suite + the `vscode` mock pattern | 35 min | Executable spec of the pure modules; how to test here |
| 22 | `docs/requirements.md` §8–§8.12 + §16 | Spec/context/plan governance, multi-business-problem workspace, lifecycle orchestration, backlog | 40 min | The intended end state and the gap |

Runners-up: `package.json` (`contributes.*` is the extension's API surface), `src/core/configManager.ts`, `src/context/ArtifactWriter.ts`, `docs/technical-design.md` §2 + §5 + §6 + Appendix A.

---

## 15. Knowledge Graph

```
AutoDE (VS Code extension)
├─ Activation & Surface  (extension.ts, package.json contributes.*)
│   ├─ Commands (20 — was miscounted "13" pre-v0.9.0; see §5.1 for the full list)
│   ├─ Views: Sidebar webview, Panel webview (⚠ Panel parked, see below)
│   └─ Custom Editors (5, opt-in)
│
├─ UI Layer  (media/*.html)
│   ├─ Sidebar = DE Agent Workspace (chat, plan cards, context drawer, palette incl.
│   │   the v0.13.0 gate buttons and v0.12.0 business-problem picker, settings)
│   ├─ Panel = dashboard — ⚠ PARKED (v0.13.0): its own `projectList` rendering is
│   │   dead (nothing populates it), though its Quick Actions route through the
│   │   now-gated Command Palette commands so they're not a lifecycle-bypass risk
│   └─ Transport: postMessage protocol  (webviewProvider ⇄ sidebar.html)
│
├─ Orchestration  (core/agentHub.ts :: DataAgentHubHub)
│   ├─ PlanState (in-memory working copy; persisted by context/PlanManager.ts, v0.10.0;
│   │   gate fields planApproved/stagesConfirmed/contextGateReady, v0.13.0)
│   ├─ ★ Lifecycle gates (v0.13.0) — the single enforcement point:
│   │   ├─ generatePlan() — throws unless specId + contextGateReady
│   │   ├─ generatePlanFromSpec() — throws unless spec approved + business-problem
│   │   │     confirmed + contextGateReady; the only caller of generatePlanInternal()
│   │   │     that bypasses generatePlan()'s own guard, since it enforces its own
│   │   ├─ approvePlan() / confirmStages() — explicit gates, persisted via
│   │   │     PlanManager.patchGates()
│   │   └─ executePlan() — throws unless planApproved && stagesConfirmed
│   ├─ Spec lifecycle
│   │   ├─ generateSpec (single-shot)         → parseSpecResponse
│   │   ├─ discoverNextAction (interview turn) → SpecOpsEngine.validateAction
│   │   └─ synthesizeComprehensiveSpec         → parseComprehensiveSpec (+ provenance)
│   ├─ Business Problem checkpoint (v0.13.0) → spec.problemStatementApproved,
│   │     reset on every fresh draft/revision (webviewProvider.applyImplementationType)
│   ├─ Phase inference  → core/phaseInference.ts (pure)
│   │   ├─ inferPhases (keyword evidence + scope.out veto + default-all)
│   │   ├─ buildPhaseDependencies (natural chain, pruned)
│   │   └─ computePhaseStatuses (live badges)
│   ├─ Implementation-type classification (v0.10.0) → core/implementationType.ts (pure)
│   ├─ Planning  → buildPlanPrompt → LLM → validatePlanResponse → PlanStep[] (DAG)
│   ├─ Execution → executePlan ready-step loop → AGENT_EXECUTORS[assignedAgent]
│   ├─ Target env → extractTargetFromMessage (LLM) + buildTargetFromPartial
│   ├─ resetPlan() (same-spec re-plan) vs. resetForNewProblem() (full reset on
│   │     business-problem switch, v0.12.0) — do not confuse the two
│   └─ LLM I/O → callConfiguredLlm
│        ├─ copilot → LanguageModelAdapter (vscode.lm, consent gate)
│        ├─ claude  → ClaudeCodeAdapter (claude -p subprocess, consent gate)
│        └─ openai | anthropic | azure-openai | gemini | ollama  (fetch)
│
├─ Spec Engine  (core/specOps.ts + skills/*.json + core/skillRegistry.ts)
│   ├─ SpecOpsEngine state machine (discovery→synthesizing→draft→refining→approved)
│   ├─ IntakeSession (questions, answers, coverage, turnBudget=12)  [in-memory only]
│   └─ 7 skills own subsets of BPS fields; coverage seeds the stop condition
│
├─ Sub-Agents  (src/agents/**  + spokes/snowflakeExecutor.ts)
│   ├─ Discover: sourceAssessmentAgent  → ConnectionManager → adapters
│   │            (degrades gracefully with no connection, v0.11.0)
│   ├─ Model:    sttmAgent, dataModelerAgent            (LLM-first w/ template
│   │            fallback since v0.11.0, via agents/llmCodegen.ts)
│   ├─ Build:    ingestionAgent, transformScaffoldAgent (LLM-first w/ template
│   │            fallback since v0.11.0), toolSkillAgent (real tool access, Phase D)
│   │            snowflakeExecutor (real snowflake-sdk; hardcoded username bug;
│   │            degrades gracefully with no connection, v0.11.0)
│   └─ Validate: architectureAgent (LLM-first w/ template fallback since v0.11.0)
│        └─ all return AgentExecutionResult { success, message, artifacts? }
│
├─ Context Layer  (.ai-context/  +  src/context/**)  — since v0.12.0, split shared
│   │   (workspace-level) vs. per-business-problem (problems/<id>/)
│   ├─ GraphManager (nodes, edges, FQN/label/type indexes, BFS decay scoring) — SHARED;
│   │     spec-derived nodes swapped on business-problem switch (removeNodesBySourceRef)
│   ├─ ContextFileManager (loads context/**, derived/graph.json; buildContextPrompt) — SHARED
│   ├─ SynthesisPipeline (rule-based file → nodes; synthesizeFromSpec, v0.10.0) — SHARED
│   ├─ SourceRegistry (sources.yaml) — SHARED
│   ├─ ChatSessionManager (chats/*.jsonl, Phase F) — SHARED
│   ├─ ActiveProblemManager (active-problem.json, problem picker) — SHARED, v0.12.0
│   ├─ SpecManager (problems/<id>/spec/business-problem.yaml + history/, atomic,
│   │     versioned; now also persists implementationType* + problemStatementApproved
│   │     fields, v0.13.0 — a persistence bug fixed in the same pass) — PER-PROBLEM
│   ├─ PlanManager (problems/<id>/plan/plan.yaml + history/; patchGates(), v0.13.0) — PER-PROBLEM
│   ├─ TargetContextManager / SourceContextManager (context/target-context.yaml /
│   │     source-context.yaml, v0.11.0) — PER-PROBLEM
│   ├─ ArtifactWriter (GeneratedArtifact → problems/<id>/artifacts/0X-<phase>/) — PER-PROBLEM
│   ├─ ContextValidator (AJV, envelope only)
│   ├─ GraphPersistence (atomic derived/graph.json)
│   └─ TargetConfigManager (target-environment.yaml, generic tool-preference profiles) —
│         SHARED; instantiated but its default is NOT auto-seeded into hub (a v0.10.0
│         auto-seed was identified as a regression and removed in v0.11.0 — this line
│         previously said "[orphaned from runtime]" while §16 R11 said resolved; that
│         was a real self-contradiction in the v0.8.0-era doc, now reconciled)
│
├─ Adapter Layer  (src/dqm/**)   [interface real, impls STUBBED, unchanged since v0.8.0]
│   ├─ IDataSourceAdapter / BaseDataSourceAdapter (extractMetadata orchestration)
│   ├─ ConnectionManager (adapter factory registry, lifecycle)
│   ├─ SnowflakeAdapter (INFORMATION_SCHEMA queries, capabilities, lineage)
│   └─ DatabricksAdapter (system.information_schema, dialect translation)
│
└─ Config & Secrets  (core/configManager.ts)
    ├─ Settings → ConfigurationTarget.Global
    └─ Secrets → context.secrets (OS keychain): llmApiKey, snowflakePassword, passphrase
```

---

## 16. Risks & Technical Debt

| # | Problem | Impact | Suggested remediation |
|---|---|---|---|
| R1 | **Adapters are stubs.** `connect()` opens nothing; `executeQuery()` returns `[]`. | Source assessment, metadata extraction, and any "real data" story are non-functional. The whole Discover phase is theater. | Phase 4: wire `snowflake-sdk` (`requirements.md` §16.1) — real `connect()` with auth-mode branching, real `executeQuery()` with timeout + cancellation. Then Databricks SQL connector. |
| R2 | **`snowflakeExecutor.ts` hardcodes `username: 'DATA_AGENT_USER'`** (`src/spokes/snowflakeExecutor.ts:22`). | Any real Snowflake execution ignores the configured username → auth fails or runs as the wrong user. | Use `settings.defaultSnowflakeUsername`; add auth-mode handling; ideally fold this into `SnowflakeAdapter` and delete the spoke. |
| R3 | **`agentHub.ts` is a large god object** — orchestration + spec + target-env + JSON parsing + (v0.13.0) lifecycle gates, all in one class. **Partially addressed (Phase C, v0.9.0):** the LLM provider fan-out (was ~220 lines of if/else + 6 HTTP client methods) is now `llmAdapter.ts` + `llmProviders.ts`; `callConfiguredLlm` is a ~15-line lookup. **Grew again in v0.10.0–v0.13.0** (1321 lines now, vs. "~1040" claimed at v0.8.0) as spec-lifecycle, phase/plan-state, and now orchestrator-gate logic were added — the extraction below has not happened yet. | Hard to test in isolation, merge-conflict magnet, high cognitive load. Still true for spec-handling and target-env logic; now also true for the v0.13.0 gate logic. | Extract a `SpecService` and a `TargetEnvService` the same way; keep `agentHub` to state + flow control. The v0.13.0 gate checks are small and self-contained enough that they're a reasonable candidate for their own module too, if this refactor happens. |
| R4 | **No RAG / retriever / token budgeting.** `buildContextPrompt` concatenates the whole graph; `tokens = nodes × 50`. | Context can blow past model limits silently; irrelevant context dilutes prompts; STRICT-rule-survives-pruning invariant (`requirements.md` §10.6) is unenforced. | Implement `ContextRetriever` (`requirements.md` §16.2): `js-tiktoken` counting, relevance + centrality ranking, hard budget, STRICT rules pinned. Wire `GraphManager.traverseNeighborhood` (already built) into it. |
| R5 | 🟡 **Partially resolved (v0.11.0).** ~~Sub-agents are templates, not AI.~~ 5 of the 7 leaf agents (`sttmAgent`, `dataModelerAgent`, `ingestionAgent`, `transformScaffoldAgent`, `architectureAgent`) now try an LLM call first (`agents/llmCodegen.ts#generateWithLlm`), grounded in `objective`/`schemaContext`/`targetEnvironment`/`step.taskDescription`, falling back to the original hardcoded templates only when no LLM is configured or the call fails/returns unfenced content. `sourceAssessmentAgent` (blocked by adapter stubs — R1) and `snowflakeExecutor` (real SQL, not codegen) are unchanged. | Generated artifacts are now grounded when an LLM is available, but the fallback (still real, still reachable) remains generic boilerplate — the product pitch is closer to true but not fully realized, and there's no UI indication of which path a given artifact actually took. | Consider surfacing (in the artifact or its metadata) whether a given artifact was LLM-generated or template-fallback, so a "generic" artifact is recognizable as such rather than silently indistinguishable from a grounded one. |
| R6 | **`deactivate()` is empty** (`extension.ts:181`). Watchers (`ContextFileManager`, `TargetConfigManager`), the graph, and services are never disposed. | Leaked file watchers / handles on window reload; violates `requirements.md` §3.10 #3. | Track disposables, dispose all in `deactivate()` within 200ms. |
| R7 | **Dead / duplicate code:** `src/features/**` (entirely unused), `src/spokes/{architectureAgent,ingestionAgent,sttmAgent}.ts` (superseded). Both still compile. | Confuses newcomers ("which `sttmAgent` is real?"), bloats the VSIX, `grep` noise. | Delete `src/features/**`; delete the 3 superseded spokes; move `snowflakeExecutor` into `src/agents/` (or `src/dqm/`). |
| R8 | **`IntakeSession` is in-memory only.** A window reload mid-interview loses all Q&A. Since v0.9.0 this also covers *revision* interviews (`previousSpec`/`changeRequest`/`attachments`) — a revision spanning a reload is lost the same way. | Frustrating UX; long interviews (and revisions) are fragile. | Persist to `.ai-context/spec/intake.yaml` (`requirements.md` §16.5). |
| R9 | **Many settings are declared but unused:** `metadataCachingDurationMinutes`, `queryTimeoutSeconds`, `readOnlyMode`, `enableSessionReuse`, `autoDocumentationEnabled`, `telemetryEnabled`. | Users set them expecting behavior; nothing happens. `readOnlyMode: true` (default) especially implies a safety guarantee that doesn't exist. | Either implement or remove/hide. `readOnlyMode` should gate `snowflakeExecutor` and any future write path. |
| R10 | ✅ **Resolved (v0.10.0).** ~~LLM JSON parsing is brittle.~~ `validatePlanResponse` and `extractTargetFromMessage` now both run the same tolerant `extractJsonText` (fence-stripping) + brace/bracket-slice extraction the spec-parsing path already used, instead of a bare `JSON.parse`. No self-repair retry loop yet — a fenced or prose-wrapped response now parses, but a genuinely malformed one still fails outright. | — | Consider a self-repair retry (ask the model to fix its own JSON) if brittleness on weaker models persists. |
| R11 | ✅ **Resolved (v0.10.0).** ~~`TargetConfigManager` is orphaned.~~ Now instantiated in `extension.ts` alongside `PlanManager` (so it works with or without the sidebar resolving); its active profile seeds `hub.setTargetEnvironment()` at activation, and `generatePlan()`'s ad-hoc `extractTargetFromMessage()` LLM extraction is now only a fallback for a workspace with no persisted profile yet. The companion **source-environment** side (per product input, 2026-09-14: `TargetConfigManager`'s original intent was broader than target-only) reuses the existing Context Layer instead of a parallel store — `Origin.environment: 'source' \| 'target'` (`src/context/types.ts`) tags nodes as source-side facts; live schema introspection (`BaseAdapter.snapshotToGraph`) and registered-source-derived nodes (`SynthesisPipeline`'s three extractors) are tagged `'source'` automatically. Surfaced in the sidebar's Context Drawer as a "Source Environment Context" note, marked Non-Applicable for Greenfield. | — | Still open: no target-profile switcher UI (profile selection is currently file-edit-only); lineage edges from `SchemaSnapshot.lineage` aren't converted to graph edges yet (extracted and logged, then discarded) — tracked in `requirements.md` §16.3a. |
| R12 | **No CI, no lint, tests not in `npm test`.** | Regressions land silently; the pure-module invariant (no `vscode` import) can be broken unnoticed. | Add `"test": "tsc -p ./ && node test/functional.test.cjs"`, a GitHub Action, and an ESLint config. |
| R13 | **`.ai-context/schema-graph.json` is not gitignored** (only `derived/` is). | The legacy generated schema graph can get committed accidentally. | Add it to `.gitignore` or migrate fully to `derived/system/`. |
| R14 | **Secrets in prompts.** Chat/plan context blocks include `## Target Environment` with account names; `extractTargetFromMessage` sends the raw user message to the LLM. Consent covers "using Copilot" but the data-flow isn't surfaced per-call. | Potential leakage of environment identifiers to third-party LLMs; `requirements.md` §12 wants explicit data-flow disclosure. | Add the one-time consent modal (`requirements.md` §16.4), redact obvious secrets from context blocks, document what's sent. |
| R15 | **Per-kind AJV `content` schemas deferred.** Only the envelope is validated. | Malformed `content` in authoritative context files passes silently and can corrupt the graph. | Add per-`kind` schemas (`requirements.md` §16.6). |
| R16 | **Databricks token has no UI.** `SourceAssessmentAgent` reads `autoDataEngineeringHub.databricksToken` from secrets, but nothing stores it. | Databricks source assessment can never get credentials. | Add token fields to the connection panel (and `getCredentialsFromSettings` for databricks reads from settings keys that aren't registered). |
| R17 | **Tool-executing skills have no hard sandbox.** (`ToolSkillAgent.ts`, Phase D) The Copilot path checks that a path argument doesn't escape the workspace root and gates writes/exec on a confirmation dialog — but there's no OS-level jail; a user who approves an adversarial command (e.g. one reached via a prompt-injected instruction inside a skill's own resource file) can still act outside the workspace. The Claude path relies entirely on whatever Claude Code's own tools do. | A skill run that gets approved once can do more than the "workspace-scoped" framing implies. | A real sandbox (container, restricted OS user, seccomp, etc.) if this feature sees real use; until then, treat every approval prompt as "I trust this skill," not "this is contained." |
| R18 | **Claude-path tool-executing skills get one whole-run approval, not per-call.** (`ToolSkillAgent.ts`) Claude Code's documented `--permission-prompts host` + external-tool callback for per-call approval exists but its schema isn't published anywhere accessible; wiring it up would mean guessing at an undocumented contract. | A single "yes" at the start of a run implicitly approves every subsequent Edit/Write/Bash call Claude Code's own loop makes during that run — a real reduction in granularity versus the Copilot path's true per-call gate. | Revisit if/when Claude Code documents the permission-prompt-tool contract; until then this is a known, accepted gap, not an oversight. |
| R19 | **Bash execution via the Claude tool-skill path is unverified.** `--permission-mode acceptEdits` was confirmed (against the real CLI) to unblock file writes headlessly, but in the same testing, a forced "run this exact Bash command" instruction came back as descriptive text, not an actual tool invocation — for reasons not fully diagnosed (Windows tool-availability quirk, or model judgment). | A skill that needs to run shell commands via the `claude` provider may silently not execute them, with no explicit error — the model just narrates instead. | Test on a non-Windows host / investigate whether a different tool name or `--permission-mode bypassPermissions` changes this, before relying on Bash-via-Claude for anything. |
| R20 | **Chat transcripts are read-modify-write, unbounded, and never pruned.** (`ChatSessionManager.appendMessage`, Phase D) Every message re-reads and rewrites the whole `.jsonl` file; there's no size cap, rotation, or archival-of-old-sessions cleanup — `.ai-context/chats/` grows forever across every session ever created. | A very long-running chat gets linearly slower to append to; a workspace used for months accumulates an unbounded number of archived session files with no UI to clean them up (only per-session `AutoDE: Discard Chat`, one at a time). | Acceptable at current scale (per design note in `ChatSessionManager.ts`); revisit with a true append-oriented write and/or an auto-archival retention policy if chat sessions see heavy real-world use. |
| R21 | ✅ **Resolved (v0.13.0).** ~~The gated spec→context→plan lifecycle coexisted with a second, fully ungated path.~~ At least 7 UI entry points (Command Palette "Generate Plan"/"Execute Plan", the AutoDE Dashboard panel's Quick Actions — which route through those same commands, the `/plan` slash command with no approved spec, and two sidebar re-plan buttons) could reach `hub.generatePlan()`/`executePlan()` directly, without ever touching a spec, context, or approval — because gating had only ever been added to the *new* `generatePlanFromSpec` path, never retrofitted onto the older one sitting right beside it. Found via fresh user testing ("the solution is not consistently following a grounded execution workflow") and a code audit (`requirements.md` §8.12, audit Revision 6 §11). Fixed by moving the guard into `AgentHub.generatePlan()`/`executePlan()` themselves — see §5.3. | — | Consider whether `hub.generatePlan()`'s raw-objective signature should be retired/merged into `generatePlanFromSpec` entirely now that it's just a gated pass-through, rather than kept as a parallel method. |
| R22 | ✅ **Resolved (v0.13.0), found while fixing R21's adjacent work.** ~~`SpecManager` never persisted `implementationType`/`implementationTypeReason`/`implementationTypeOverridden`.~~ These fields existed on `BusinessProblemSpec` since v0.10.0 and were set correctly in memory, but `SpecManager.serialize()` silently omitted them from the written YAML — so a user's Greenfield/Brownfield classification, including any manual override, was reclassified from scratch on every reload (extension restart, or business-problem switch after v0.12.0). Fixed by adding them (and the new `problemStatementApproved`) to `serialize()`/`parse()`. | — | None — closed. A cautionary example for future fields added to `BusinessProblemSpec`: adding a field to the TypeScript type does **not** persist it; `SpecManager.serialize()`/`parse()` must be updated explicitly (unlike `PlanManager`, which serializes `PersistedPlan` generically). |
| R23 | **The AutoDE Dashboard panel (`panel.html`/`panelProvider.ts`) is stale and explicitly parked (v0.13.0).** Its `projectList`/`getProjects`/`phaseProgress` multi-project rendering is dead code — nothing in `panelProvider.ts` ever sends a `projectList` message, so the panel always shows "No active project," regardless of real state. Its Quick Actions ("📋 Generate Plan"/"🏗 Generate Artifacts") do still work, routing through the same Command Palette commands R21 gated — so this is stale UI, not a lifecycle-bypass risk. | Confusing for anyone who opens the bottom panel expecting it to reflect the sidebar's real state; dead code accumulates. | Deliberately deferred per product decision (2026-09-16) — "we will work on the legacy dashboard later." Options when revisited: wire it to real per-business-problem state, or retire it in favor of the sidebar palette, which already covers everything it was meant to show. |

---

## 17. Extension Guide

> General rule: sub-agents import **only** `core/types` (and, since v0.11.0, `agents/llmCodegen.ts` — which itself also imports only `core/types`, so the rule still holds transitively). Keep it that way. Pure modules (`phaseInference`, `implementationType`, `targetContextQuestions`, `sourceContextQuestions`, `specOps*`, `specSynthesis`) must **never** import `vscode`. **One deliberate exception (Phase D):** `build/ToolSkillAgent.ts` imports `vscode` and `node:child_process` directly, because it does real file I/O, process spawning, and approval dialogs — not deterministic templating like every other agent. Don't use it as a precedent for the other 7; if you're tempted to import `vscode` in a template agent, that's a sign the work belongs somewhere else.

### 17.1 Add a new sub-agent (e.g. `sqlValidatorAgent`)

1. `src/core/types.ts` → add `'sqlValidatorAgent'` to the `AgentType` union.
2. Create `src/agents/validate/SqlValidatorAgent.ts` exporting
   `export async function executeSqlValidatorAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult>`.
   If it should be LLM-grounded rather than purely templated (the v0.11.0 pattern — see `src/agents/llmCodegen.ts#generateWithLlm`), call it the same way the other 5 codegen agents do and keep a template fallback for when no LLM is available.
3. `src/core/agentHub.ts`:
   - import the executor;
   - add it to `AGENT_EXECUTORS`;
   - add it to `VALID_AGENT_TYPES`;
   - add `sqlValidatorAgent: 'validate'` to `AGENT_PHASE`;
   - add its key to the allow-list string in `buildPlanPrompt` ("Use only these assignedAgent values: …").
4. (Optional) surface it in `media/sidebar.html`'s palette for that phase.
5. Add a test in `test/functional.test.cjs` (mock a plan that assigns it, assert the artifact).
6. If it produces artifacts, return them in `result.artifacts` (the hub writes them via `ArtifactWriter` and stamps `phase`/`specId`/`specVersion`).

### 17.2 Add a new LLM provider

**Since Phase C (v0.9.0)** this is a dispatch-registry lookup, not an if/else chain — the old recipe (a `callXxx` method + a new branch in `agentHub.callConfiguredLlm`, per provider) is gone. Adding a provider now touches:

1. `src/core/types.ts` → add to `LlmProvider` union.
2. `src/core/llmProviders.ts` → write one `class XyzLlmAdapter implements LlmAdapter` (see the 5 `fetch()`-based ones for the shape — `id`/`displayName`/`requiresApiKey`/`supportsCustomEndpoint` + a `complete(prompt, opts, ctx)` method; call the shared `extractJsonText()` from `./llmAdapter` on the response text), then add one line to `LLM_ADAPTERS`. This is now the **single place** provider metadata + dispatch logic live — `providerRegistry.ts`'s `getLlmProviderDefinition`/`getSupportedLlmProviders` just read from `LLM_ADAPTERS` (kept only for any future caller; `agentHub.callConfiguredLlm` doesn't use them).
3. `package.json` → add to `activeLlmProvider` enum (+ `enumDescriptions`).
4. `src/core/webviewProvider.ts:updateSettings` → add the enum value to the `activeLlmProvider` guard (this hand-kept validator, and the `package.json` enum, are the two places *not* unified by Phase C — the user's decision was a backend-only registry, so the UI/settings-schema side stays hand-authored).
5. `media/sidebar.html` → add a provider card in the LLM settings tab.

If the new provider is `vscode.lm`-based (like Copilot) or a local subprocess (like Claude Code), it won't fit the plain `fetch()` shape — write it like `CopilotLlmAdapter`/`ClaudeLlmAdapter` in `llmProviders.ts` instead (delegating to a dedicated adapter module, e.g. `languageModelAdapter.ts` / `claudeCodeAdapter.ts`, for the actual transport).

### 17.3 Add a new data platform (e.g. BigQuery)

1. `src/dqm/adapters/BigQueryAdapter.ts` extends `BaseDataSourceAdapter`; implement `connect`, `disconnect`, `dispose`, `executeQuery`, `getCapabilities`, `getMetadataQueries`, `translateDialect`.
2. `src/dqm/ConnectionManager.ts` → `this.adapterFactories.set('bigquery', (creds, l) => new BigQueryAdapter(creds, l))` and a `getActivePlatform()` branch.
3. `src/dqm/ConnectionManager.getCredentialsFromSettings` → add a `case 'bigquery'`.
4. `package.json` → `defaultProvider` enum already includes `bigquery`; add BigQuery settings keys.
5. `src/core/agentHub.ts:buildTargetFromPartial` already has a `bigquery` branch — verify it matches your `platformConfig` shape.
6. `media/sidebar.html` → connection panel card.

### 17.4 Add a new context source kind

1. `src/context/SourceRegistry.ts` → add to `SourceKind` + `KIND_TO_LAYER`.
2. `src/context/SynthesisPipeline.ts` → add a `case` in `extract()` + an `extractXxx()` method that returns `{nodes, edges}` with `origin` provenance.
3. `src/core/webviewProvider.ts:registerSource` → add the kind to the guard.
4. `media/sidebar.html` → add the option to the source-registration form.

### 17.5 Add a new SpecOps skill

1. Create `skills/<id>.json` with `id`, `name`, `order`, `description`, `systemPrompt`, `questionGuidance`, `specFields`, `exampleQuestions`.
2. If it introduces new BPS fields, add them to `types.ts:BusinessProblemSpec` and handle them in `specSynthesis.parseComprehensiveSpec` + `SpecManager.serialize/parse`.
3. Users can override your skill by placing a same-`id` file in `.ai-context/skills/`.
4. No code change needed to *load* it — `SkillRegistry` reads the directory.

### 17.6 Add a new prompt

Prompts are TS string constants/builders in `src/core/`. Add a `static readonly XXX_SYSTEM_PROMPT` on `DataAgentHubHub` (or a builder in `specOpsPrompts.ts` if it's interview-related), pass it as the 2nd arg to `callConfiguredLlm(prompt, systemPrompt, justification)`. Keep response parsing strict and deterministic (see `parseJsonObject` / `validatePlanResponse` for the pattern).

### 17.7 Add a new webview message

1. `media/sidebar.html` → `vscode.postMessage({type:'myMessage', ...})`.
2. `src/core/webviewProvider.ts:handleMessage` → add a `case 'myMessage':`.
3. To reply: `this.postMessage('myResponse', {...})` and handle `myResponse` in the webview's `window.addEventListener('message', ...)`.

### 17.8 Add a new pipeline phase

This is invasive — the 4 phases are baked into `WorkflowPhase`, `PHASE_ORDER`, `PHASE_KEYWORDS`, `SCOPE_OUT_EXCLUSIONS`, `PHASE_LABELS`, `PHASE_DIRS`, `AGENT_PHASE`, and the palette. Touch all of them, plus `buildPhaseDependencies`'s `naturalPredecessors`. Add tests to `phaseInference` coverage. Consider whether you actually need a phase or just a new agent in an existing one.

### 17.9 Import and run a tool-executing skill (Phase D, v0.9.0)

1. Get (or write) a Claude Agent Skill folder: a `SKILL.md` (optional YAML frontmatter — `name`/`description`/`allowed-tools` — then a Markdown body of instructions) plus any bundled resources.
2. Command Palette → **AutoDE: Import Tool Skill** → pick the folder. It's copied into `.ai-context/skills/tool-skills/<id>/` and parsed; the toast reports what was found (name, resource-file count, declared tools).
3. Run it: `/skill <id> <instruction>` in chat, or Command Palette → **AutoDE: Run Tool Skill** (quick-pick + instruction input box).
4. Only works when `activeLlmProvider` is `claude` or `copilot`, and `languageModelProgrammaticConsent` is on. Approve the confirmation dialog(s) that follow — one whole-run dialog for `claude`, one dialog per file-write/command for `copilot`.
5. To add a new provider's execution path here, extend the `provider === ...` dispatch in `executeToolSkillAgent` (`src/agents/build/ToolSkillAgent.ts`) — but read requirements.md §9a first: only `claude`/`copilot` can run tools at all today, and adding a third path (one of the 5 `fetch()`-based providers) means building a tool-execution sandbox from scratch, not a small addition.

### 17.10 Extend chat session behavior (Phase F, v0.9.0)

1. New persisted fields on a session → add to `ChatSessionMeta` (`src/core/types.ts`), thread through `ChatSessionManager.createSession()`/`updateMeta()`. No schema migration exists — old `.meta.json` files simply parse with the new field `undefined`.
2. New message types the session should record → extend `recordAssistantMessage()`'s `if/else` chain in `webviewProvider.ts` (it maps a subset of `postMessage()` types to a `ChatMessage`); don't call `chatSessionManager.appendMessage()` directly from a new call site unless it's a user-authored message (mirroring the existing `case 'chat'`/`case 'submitSpecAnswers'` pattern).
3. A fuller in-sidebar browser (search/tag/export/reopen) → the server-side plumbing already exists (`listChatSessions`/`openChatSession` cases, `chatSessionsList`/`chatSessionViewed` responses in `webviewProvider.ts`); only `media/sidebar.html` needs a UI to consume them. See requirements.md §16.7.
4. "Distill this chat" / Context Memory curation is unbuilt — it would be a new `SynthesisPipeline` source kind (`chat_history`) plus a new user-initiated action, not an extension of `ChatSessionManager` itself, which is deliberately just CRUD + no LLM calls. See requirements.md §16.7.

### 17.11 Add a new business-problem-scoped persistence class (v0.12.0 pattern)

1. Constructor takes `(contextRoot: vscode.Uri, log: (msg: string) => void)` — never resolve `.ai-context/...` off the workspace root yourself; the caller decides whether `contextRoot` is a business problem's folder or the shared workspace root. Mirror `SpecManager`/`PlanManager`: atomic writes (temp file → `rename`), `serialize()`/`parse()` explicit field mapping (see R22 in §16 for what happens if you forget a field there), version-on-change `history/` archiving if the object should have one.
2. `webviewProvider.activateProblem()` is where every existing per-problem manager gets (re)constructed against the newly-active `contextRoot` — add yours there, alongside `SpecManager`/`TargetContextManager`/`SourceContextManager`. If command-palette actions (not just the sidebar) need it too, also wire it through the `applyProblemRoot` callback pattern `extension.ts` uses for `PlanManager`/`ArtifactWriter`.
3. Decide up front whether the new thing is genuinely per-business-problem (spec, plan, context, artifacts) or shared/workspace-level (source registry, the compiled graph, chat sessions) — see §6.4 for the current split and the reasoning behind it.

### 17.12 Add a new lifecycle gate (v0.13.0 pattern)

1. Add the gate's boolean (+ optional timestamp) fields to `PlanState` **and** `PersistedPlan` (`src/core/types.ts`) — see `planApproved`/`stagesConfirmed` for the shape.
2. Add the enforcement check as early as possible in the `AgentHub` method it should block — see `executePlan()`'s two `if (!state.xxx) throw new Error(...)` guards for the pattern. Prefer throwing from inside `AgentHub` itself over checking only in `webviewProvider`, so every caller (webview, Command Palette, a future third UI surface) is covered without having to remember to check — this is the exact gap R21 (§16) closed.
3. Add the explicit user action that flips the gate true (mirror `AgentHub.approvePlan()`/`confirmStages()`), persist it via a `patchGates()`-style in-place update (not a full new version) if it lives on an existing persisted object, and reset it to `false` wherever something happens that should invalidate it (a new plan, a changed phase set, etc. — see the reset call sites `setPhaseOverride()`/`inferPhasesFromSpec()`/`generatePlanInternal()` all have).
4. Add a `case` in `webviewProvider.handleMessage()` that just calls the new `AgentHub` method — no gate logic belongs in the webview layer itself, only in the orchestrator.
5. Wire the UI: a new button/label state (see `updatePaletteContinue()` and `renderContextActions()` in `media/sidebar.html` for how the v0.13.0 gates did this).

---

## 18. Glossary of Domain Terms

| Term | Meaning in AutoDE |
|---|---|
| **BPS / Business Problem Specification** | The structured, versioned YAML artifact (`.ai-context/problems/<id>/spec/business-problem.yaml` since v0.12.0) that is the system of record. Governs phase inference, planning, traceability. |
| **Business problem** | Since v0.12.0, the unit a workspace can have several of — each with its own fully isolated spec/plan/context/artifacts folder. Not the same thing as one *chat session* (which can span problems) or one *plan* (one business problem can be re-planned many times). |
| **Business Problem checkpoint** | A lightweight gate (v0.13.0, `spec.problemStatementApproved`) requiring the user to explicitly confirm the inferred/refined problem statement before the full specification can be approved — distinct from, and prior to, the full spec's own approve/revise cycle. |
| **Active business problem** | The one business problem `active-problem.json` currently points at; every problem-scoped manager (`SpecManager`, `PlanManager`, `TargetContextManager`, `SourceContextManager`, `ArtifactWriter`) is constructed against its folder. |
| **Lifecycle orchestration / orchestrator gate** | (v0.13.0) `AgentHub` enforcing that the workflow's stages and approval gates can't be skipped, regardless of which UI entry point is used — as opposed to gating being left to each caller to check (which is what let the pre-v0.13.0 ungated path exist — see §16 R21). |
| **Plan Approval** | (v0.13.0) An explicit user action (`AgentHub.approvePlan()`) required, alongside Stage Confirmation, before a generated plan can be executed. Not the same as the spec's own approval. |
| **Stage Confirmation** | (v0.13.0) An explicit user action (`AgentHub.confirmStages()`) confirming the currently-inferred/overridden applicable-phase set, required before execution. Distinct from Phase Inference itself (which still runs earlier, at spec-approval time) — this is the discrete sign-off, not the computation. |
| **Context gate / `contextGateReady`** | Whether Source Context (if applicable) and Target Context are both built and approved for the current spec version — computed by `webviewProvider.computeContextGateStatus()`, then pushed into `AgentHub` (v0.13.0) as the field `generatePlan()`/`generatePlanFromSpec()` actually check. |
| **SpecOps** | The agentic, skill-driven requirements-discovery flow that produces the BPS (inspired by "Superpowers" SDLC). |
| **Skill** | A JSON file (`skills/*.json`) defining a slice of the interview: which BPS fields it owns, its system prompt, question guidance. **Not the same thing as a "tool skill" below** — same word, two different concepts, kept deliberately separate. |
| **Tool skill / Claude Agent Skill** | An *imported* `SKILL.md` + resources (Phase D) — a tool-oriented capability, not an interview slice. Stored under `.ai-context/skills/tool-skills/<id>/`, run via `toolSkillAgent` with real file/command access. See §9a of requirements.md. |
| **Intake session** | The in-memory record of one SpecOps conversation (questions, answers, coverage, turn budget). |
| **Coverage** | Per-BPS-field status (`missing` / `partial` / `complete`) used as the interview's stop condition. |
| **Phase** | One of `discover`, `model`, `build`, `validate`. Inferred from the approved BPS, not chosen by the user. |
| **Phase inference** | Deterministic (`phaseInference.ts`) mapping from BPS text → required phase set + dependency chain. |
| **Plan / PlanStep / DAG** | LLM-generated ordered list of steps, each with `assignedAgent`, `dependsOn`. Executed by the hub's ready-step loop. |
| **Sub-agent / spoke** | A leaf executor function (`execute*Agent`) that produces artifacts for one step. |
| **Hub** | `DataAgentHubHub` — the orchestrator. |
| **Artifact / GeneratedArtifact** | A produced file (SQL/YAML/MD/PY/JSON) written to `.ai-context/problems/<id>/artifacts/0X-<phase>/` (since v0.12.0) — 5 of the 7 kinds are now LLM-generated when possible (v0.11.0), falling back to a template. |
| **Context Layer / Enterprise Context Layer** | The `.ai-context/` knowledge graph + files that ground LLM prompts. Workspace-level/shared (v0.12.0) — its spec-derived layer is swapped whenever the active business problem changes. |
| **Target Context / Source Context** | (v0.11.0) First-class, spec-tied, reviewed/approved objects (`TargetContextManager`/`SourceContextManager`) built through a fixed Q&A. **Not the same as** "Target environment" below — the environment is a generic tool-preference profile (`TargetConfigManager`); Target Context is the specific, approved, per-spec-version answer that actually feeds `hub.state.targetEnvironment` once approved. Source Context is Brownfield-only, auto-marked Not Applicable for Greenfield. |
| **Envelope** | The uniform metadata wrapper (`id`, `kind`, `layer`, `origin`, `version`, `content`) on every context object (`context-envelope.schema.json`). |
| **Origin** | Provenance sub-object: where a derived node came from (`source`, `sourceRef`, `confidence`, `extractor`). |
| **Layer** | `industry` / `enterprise` / `domain` / `system` / `definition` / `query` / `artifact` — the taxonomy of context content. |
| **Authoritative vs derived** | `context/**` = human-owned, committed; `derived/**` = machine-generated, gitignored, regenerable. |
| **FQN** | Fully-qualified name of a table: `db.schema.table`. |
| **STTM** | Source-to-Target Mapping (column-level mapping artifact). |
| **Adapter / DQM** | `src/dqm/**` — the platform-abstraction layer (Snowflake, Databricks, …). |
| **Verified query** | A "golden" reference SQL query stored in the context layer. |
| **Target environment** | The user's chosen output stack: platform + modeling approach + transformation tool + orchestration tool + naming convention. |
| **Handoff (Copilot)** | Opening a plain editor pre-seeded with a prompt so the user can drive Copilot interactively when programmatic consent isn't given. |
| **Consent gate** | `languageModelProgrammaticConsent` setting (legacy: `copilotProgrammaticConsent`) — must be `true` before the extension will call a local LLM (GitHub Copilot via `vscode.lm`, or the Claude Code CLI) programmatically. |
| **Provenance (spec)** | `SpecProvenance[]` on the BPS — which question/skill/assumption produced each field. |
| **Chat session** | A persisted, BPS-identity-independent unit of conversation (`ChatSessionMeta` + a `.jsonl` transcript, `ChatSessionManager`, Phase F). Exactly one is `active` at a time; "New Chat" archives the current one and starts another. |
| **Carryover (interview)** | The Markdown note (`.ai-context/chats/carryover/<sessionId>.md`) written when New Chat interrupts a live SpecOps interview — folds partial answers into the Context Layer instead of resuming or discarding them. |
| **Context Memory (curation)** | Proposed, **not built** (Phase G): an LLM extraction pass over a chat transcript into graph nodes tagged `origin.source: 'chat'` — distinct from raw transcript persistence. |

---

## 19. FAQ for New Engineers

**Q: I typed a message in the chat and it started asking me interview questions instead of answering. Why?**
A: There's no active business problem with an approved BPS yet. With no active business problem, chat starts SpecOps discovery (and lazily creates the business-problem folder the moment a draft spec exists, v0.12.0). With a draft spec, chat routes to "revise the spec". Only an **approved** spec makes chat behave conversationally — and since v0.13.0, approval itself requires first confirming the Business Problem checkpoint. Approve it in the Workflow Palette (🧰).

**Q: Where's the actual AI in the sub-agents?**
A: Since v0.11.0, some of it — 5 of the 7 leaf agents (`sttmAgent`, `dataModelerAgent`, `ingestionAgent`, `transformScaffoldAgent`, `architectureAgent`) now try an LLM call first, grounded in the task/objective/context/target environment, falling back to their original deterministic string templates if no LLM is available or the call fails. `sourceAssessmentAgent` (blocked by stubbed adapters) and `snowflakeExecutor` (real SQL) aren't part of this. The *orchestrator* (planning) and the *spec engine* (interview + synthesis) still do the bulk of the LLM work. See R5 in §16 for the nuance ("partially resolved," not fully).

**Q: I approved my plan / confirmed the stages but "Generate Artifacts" is still not clickable. Why?**
A: Both are required, independently (v0.13.0) — Plan Approval and Stage Confirmation. Check the Workflow Palette's bottom button label, which walks through "✓ Approve Plan" → "✓ Confirm Applicable Stages" → "🏗 Generate Artifacts" and tells you which one is still outstanding. Also check whether you re-planned or changed a phase's Applicable/Non-Applicable status since — either resets both gates, since a changed plan or phase set needs fresh sign-off (see `requirements.md` §8.12).

**Q: I ran "AutoDE: Generate Plan" from the Command Palette and got an error instead of the usual input box. Why?**
A: As of v0.13.0 this command (and "AutoDE: Execute Plan") is gated the same way the sidebar is — it now requires an active, context-ready business problem (and, for Execute, an approved+confirmed plan). Describe your business problem in the sidebar first and go through the guided workflow; these two commands are for driving an *already-set-up* business problem from outside the sidebar, not for starting one from scratch. See §5.1 and §16 R21.

**Q: I ran Source Assessment and got 0 tables even though my Snowflake creds are right.**
A: The adapters are stubs (`SnowflakeAdapter.executeQuery` returns `[]`). Real connectivity is Phase 4 (`requirements.md` §16.1). Nothing is wrong with your creds.

**Q: How do I run it without any API key?**
A: Use GitHub Copilot. Install "GitHub Copilot Chat", sign in, then Settings (⚙) → LLM Provider → tick "Allow programmatic use of local Copilot". Provider stays `copilot`.

**Q: How do I run the tests?**
A: `npm run compile && node test/functional.test.cjs`. There's no `npm test` script and no test framework — it's a hand-rolled runner with a `vscode` mock.

**Q: Why do `phaseInference.ts` / `specOps.ts` not import `vscode`?**
A: Deliberate. They're pure so the test suite can `require` them in plain Node without mocking VS Code. Don't add a `vscode` import to them.

**Q: There are two `sttmAgent.ts` files (and two `architectureAgent.ts`, etc.). Which is real?**
A: `src/agents/model/SttmMapperAgent.ts` is real (imported by `agentHub`). `src/spokes/sttmAgent.ts` and `src/features/agents/spokes/sttmAgent.ts` are dead. Only `src/spokes/snowflakeExecutor.ts` survives from the legacy dirs.

**Q: Where does generated output go?**
A: `.ai-context/problems/<id>/artifacts/01-discover/`, `02-model/`, `03-build/`, `04-validate/` (configurable folder name via `artifactDirectory`, default `artifacts`, relative to the active business problem's folder since v0.12.0 — see §6.4). The folder is created on first execution and is meant to be committed / PR'd.

**Q: Where's the BPS stored and how is it versioned?**
A: `.ai-context/problems/<id>/spec/business-problem.yaml` (since v0.12.0 — was `.ai-context/spec/business-problem.yaml` in a single-business-problem workspace before that). Git is the version history. `version` bumps only when an already-**approved** spec is materially re-drafted; approving a draft keeps its version. Prior revisions are archived to `.../spec/history/`.

**Q: What is a "business problem" here, and can a workspace have more than one?**
A: Yes, since v0.12.0 — one workspace, several business problems, each with its own isolated spec/plan/context/artifacts folder under `.ai-context/problems/<id>/`. `.ai-context/active-problem.json` says which one is current; the Workflow Palette has a picker ("＋ New" / "⇄ Switch"). The source registry, the compiled Context Layer graph, and chat sessions stay shared across all of them. See `requirements.md` §8.11.

**Q: Can I change settings per-workspace?**
A: Not via the extension UI — `updateSettings` always writes `ConfigurationTarget.Global`. You can hand-edit `.vscode/settings.json` and `getConfiguration` will pick it up (VS Code precedence), but the extension will overwrite to Global on the next save.

**Q: The dev host crashes on F5.**
A: Known issue with the Cline extension (`saoudrizwan.claude-dev`) — SIGABRT / exit 134. The launch config disables it. If you launch differently, add `--disable-extension=saoudrizwan.claude-dev`.

**Q: What's `dqm`?**
A: Undocumented acronym; 💡 "data query manager" / "data quality management" — the folder is the data-platform adapter layer.

**Q: How do I add a platform / provider / agent / skill?**
A: See §17. Short version: add to the relevant union in `types.ts`, add to the relevant registry/map, wire one function, add a test.

**Q: Is there a way to see what context is sent to the LLM?**
A: The context drawer in the sidebar shows counts/chips. The exact prompt block is `ContextFileManager.buildContextPrompt()` + `agentHub.buildChatContextBlock()`. There's no per-call prompt log today (worth adding — R10/R14).

---

*Originally generated by reverse-engineering the repository at v0.8.0; updated 2026-09-16 against v0.13.0 (lifecycle orchestration + multi-business-problem workspace) after going stale through v0.9.0–v0.12.0. Keep this doc next to `docs/requirements.md` and `docs/technical-design.md` — going forward, treat "sync this doc" as part of shipping any change that alters a documented flow, file, or count, rather than a periodic catch-up pass; the six-version drift corrected in this revision is the cost of not doing that. Update it when the adapter layer becomes real (Phase 4) — that will change §1, §5.4, §7, and §16 materially — and whenever the AutoDE Dashboard panel (currently parked, §1/§16 R23) is revisited.*

---

## 20. Update Log (2026-09-16 revision)

This section exists so a reader can see, in one place, what changed in this pass without diffing 1200+ lines against the v0.8.0 baseline. Delete or archive this section once the next update makes it stale in turn — it's a changelog for *this specific revision*, not a permanent fixture.

**Corrected drift from v0.9.0–v0.12.0 (previously undocumented in this file, though present in `requirements.md`):** agentic spec revision, phase-status extensions (`pending-review`, per-phase overrides), Greenfield/Brownfield classification, plan persistence, artifact version history, chat session lifecycle (Phase F), tool-executing skills (Phase D), Target/Source Context as gating objects (v0.11.0), LLM-first codegen agents (v0.11.0), and the multi-business-problem workspace (v0.12.0).

**New in v0.13.0, documented fresh in this pass:** the lifecycle orchestration gates (`contextGateReady`, Plan Approval, Stage Confirmation), the Business Problem checkpoint (`problemStatementApproved`), and the `SpecManager` `implementationType*` persistence bug fixed alongside them.

**⚠ Flagged for author review, not silently corrected — a deliberate choice given the request that stale information be surfaced rather than guessed at:**
- The stage-inference-ordering product decision (§5.3) — kept as-is rather than re-sequenced; worth re-confirming this reading of the 2026-09-16 decision is still right as the feature gets used.
- This repository's own local `.ai-context/` still has pre-migration, single-business-problem-layout files on disk (§3) — a conscious migrate-or-delete decision was never made.
- `.ai-context/schema-graph.json` was not moved under `problems/<id>/` in the v0.12.0 migration (§5.4, §6.4) — unclear whether that's deliberate (it arguably belongs to the source system, not one business problem) or an oversight.
- R5's remaining "partially resolved" framing (§16) — whether to track which artifacts came from the LLM path vs. the template fallback is a real open product question, not answered here.
- Several counts in this pass (file counts, line counts, test counts, command counts, message-case counts) were taken via `git ls-files`/`wc -l`/`grep -c` at a single point in time (2026-09-16) rather than hand-verified per item — treat them as accurate as of that date, not as permanently pinned.
