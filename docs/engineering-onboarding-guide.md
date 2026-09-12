# AutoDE — Engineering Mental Model & Onboarding Guide

> **Audience:** A newly hired AI/Data Engineer joining the AutoDE team.
> **Goal:** Give you enough of a mental model to navigate, debug, extend, and operate AutoDE without tribal knowledge.
> **Status of this doc:** Reverse-engineered from the repository at commit `9a6b672` (v0.8.0 code, docs at v0.8.0). Where the code and the docs disagree, this guide follows the **code** and calls out the difference.
> **Legend:** 🟩 = implemented & wired · 🟨 = partial / stubbed · 🟥 = declared but not implemented · 💡 = assumption/inference (not stated anywhere, deduced from code).

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

---

## 1. Executive Summary

**AutoDE ("Auto Data Engineering Hub")** is a **single VS Code extension** — not a service, not a microservice mesh, not a deployed app. It runs entirely inside the VS Code Extension Host process on the engineer's laptop. There is no server, no database, no container, no cloud infrastructure of its own. Everything it persists is plain files inside the currently-open repository.

### What problem does it solve?

Data engineers spend a lot of time turning a vague business ask ("we need sales insights across product, customer and transaction data") into a concrete pipeline: discovering source schemas, designing a target model, writing DDL / dbt / ingestion code, and documenting it. AutoDE tries to **compress that loop** by:

1. Turning the natural-language ask into a **structured, versioned, reviewable Business Problem Specification (BPS)** — the "system of record" that governs everything downstream.
2. **Deterministically inferring** which workflow phases (discover → model → build → validate) the problem actually needs.
3. Using an **LLM-driven orchestrator** to decompose the objective into a dependency-ordered plan (a DAG of steps).
4. Routing each step to a **specialized sub-agent** that emits an artifact (SQL, dbt project, mapping, docs).
5. Writing those artifacts into a visible `auto-de/` folder in the repo, organized by phase.
6. Grounding every LLM prompt in an **Enterprise Context Layer** (`.ai-context/`) — a knowledge graph of tables, columns, business terms, rules and verified queries.

### The one-sentence mental model

> AutoDE is a **spec-driven, LLM-orchestrated code generator for data-engineering artifacts**, packaged as a provider-agnostic (Snowflake-first) VS Code extension, where the chat is the UI, the BPS is the source of truth, and everything is a file in the user's repo.

### Honest state of the system (v0.8.0)

| Area | State |
|---|---|
| Spec generation (BPS + agentic SpecOps) | 🟩 Working end-to-end, including revising an **approved** spec (v0.9.0) — full re-interview, never edited in place, always a new draft `version+1` |
| Phase inference | 🟩 Working, deterministic, unit-tested |
| Spec versioning & artifact traceability | 🟩 Git is the version/audit log (`.ai-context/spec/` committed) + a "🕓 History" action; artifacts are written under a durable `<specId>.v<version>` folder and flagged stale in the palette if superseded (v0.9.0, Phase B). No in-app diff/compare UI. |
| Tool-executing skills (`toolSkillAgent`) | 🟨 Import a Claude Agent Skill (`SKILL.md`) and run it with real tool access — implemented narrower than originally scoped (v0.9.0, Phase D). `claude`: real, verified end-to-end for Read/Grep/Glob/Edit/Write (Bash unverified); one whole-run confirmation, not per-call. `copilot`: a real `vscode.lm` tool-calling loop with true per-call approval + audit — logic correct, **not exercised against a live Copilot session**. Not native Claude Code plugin loading; not a hard OS sandbox. Not reachable from the auto-planner (explicit invocation only). See requirements.md §9a. |
| LLM orchestration + plan DAG + execution | 🟩 Working |
| LLM providers | 🟩 `copilot` (GitHub Copilot via `vscode.lm`, no key) + `claude` (the **Claude Code CLI**, headless, no key — `claudeCodeAdapter.ts` shells out to `claude -p`), plus OpenAI/Anthropic/Azure/Gemini/Ollama via `fetch`. |
| Sub-agents (6 of them) | 🟨 Working but **template-based**, not truly "AI" — they string-interpolate DDL, they don't call an LLM |
| Context Layer (graph + YAML loading + AJV) | 🟨 In-memory only; loads authoritative files; no retriever, no embeddings, no token budgeting |
| Data platform adapters (Snowflake / Databricks) | 🟥 **Stubs.** `connect()` validates params but opens no connection; `executeQuery()` returns `[]`. End-to-end metadata extraction does not work. |
| `snowflake-sdk` real execution | 🟥 Only `src/spokes/snowflakeExecutor.ts` imports it, with a **hardcoded username** bug |
| Vector engine / worker threads / `js-tiktoken` | 🟥 Not implemented |
| `deactivate()` cleanup | 🟥 Empty |
| Tests | 🟨 ~51 functional tests, all in one file, mostly the pure modules + the `vscode.lm`/Claude Code adapters + artifact staleness + the tool-skill parser |

**Bottom line for you:** the *spec → phases → plan → artifact* pipeline is real and demoable with an LLM (Copilot or Claude works with zero API key). The *live database connectivity* is not. Most "Phase 4+" backlog work is about making the adapters real.

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
| **Total tracked files** | ~84 (small codebase; ~30 TypeScript source files) |

### Target users

Data / analytics engineers who already use VS Code and (ideally) already have GitHub Copilot. Secondary: platform teams standardizing how pipelines get designed.

### Core capabilities (what a user can actually do today)

1. Describe a business problem in chat → get an **agentic requirements interview** → get a **comprehensive BPS** written to `.ai-context/spec/business-problem.yaml`.
2. Review/approve the BPS in the Workflow Palette → AutoDE **infers the required phases**.
3. Generate an execution **plan** (DAG) constrained to those phases.
4. **Execute** the plan → sub-agents emit artifacts → written to `auto-de/0X-<phase>/`.
5. Register repo files as **context sources** → rule-based synthesis into the knowledge graph.
6. Chat, grounded in the BPS + context graph + (would-be) schema context.
7. Open generated artifacts in **custom editors** (data model, STTM, graph, profile, doc).
8. Multi-LLM: Copilot (default, no key, via `vscode.lm`) and Claude (no key, via the local **Claude Code CLI**) — plus OpenAI, Anthropic (direct API key), Azure OpenAI, Gemini, Ollama.

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
├── src/                         # All TypeScript source (compiles to dist/)
│   ├── extension.ts             # ★ Activation entry point, command + provider registration
│   ├── core/                    # Orchestration, LLM, config, webview bridge, spec engine
│   ├── context/                 # Enterprise Context Layer: graph, YAML, spec, artifacts
│   ├── dqm/                     # "Data Quality/Query Mgmt" — data-platform adapter layer
│   ├── agents/                  # ★ The 6 wired sub-agents (discover/model/build/validate)
│   ├── editors/                 # 5 custom text editors (webview-backed)
│   ├── spokes/                  # LEGACY agents — only snowflakeExecutor.ts is still wired
│   └── features/                # DEAD CODE — near-duplicate of spokes/, nothing imports it
├── media/                       # Single-file HTML webviews (no framework, no bundler)
│   ├── sidebar.html             # ★ The main "DE Agent Workspace" UI (~980 lines)
│   ├── panel.html               # Bottom-panel dashboard (~318 lines)
│   └── editors/*.html           # One HTML per custom editor
├── skills/                      # ★ 7 JSON skill definitions for the SpecOps interview
├── docs/
│   ├── requirements.md          # ★ Authoritative requirements (read §3, §8, §16)
│   ├── technical-design.md      # ★ Design doc (slightly ahead of / behind code in places)
│   └── schemas/context-envelope.schema.json   # AJV schema for context objects
├── test/functional.test.cjs     # The entire test suite (runs against dist/)
├── .ai-context/                 # Runtime: context layer for THIS repo (committed except derived/)
│   ├── sources.yaml             # Registered context source files (currently empty)
│   ├── spec/business-problem.yaml   # A real approved BPS lives here (the ETL demo)
│   └── derived/graph.json       # Compiled graph snapshot (gitignored)
├── auto-de/                     # Runtime: generated artifacts (created on first execution)
├── .vscode/launch.json          # F5 config — note --disable-extension=saoudrizwan.claude-dev
├── package.json                 # ★ contributes.* = all commands, views, editors, settings
├── tsconfig.json                # rootDir src, outDir dist, strict, CommonJS, ES2022
└── *.vsix                       # Pre-built package artifacts (two, from different names)
```

### `src/core/` — the brain

| File | Why it exists | Called by | Depends on |
|---|---|---|---|
| `agentHub.ts` (`DataAgentHubHub`) | **Central orchestrator.** Owns `PlanState`, does all LLM calls, spec drafting, phase inference invocation, plan generation + validation, DAG execution, target-env extraction. | `extension.ts`, `webviewProvider.ts`, `panelProvider.ts` | every `src/agents/*` executor, `phaseInference`, `specOps`, `specSynthesis`, `languageModelAdapter`, `configManager` |
| `webviewProvider.ts` (`DataAgentHubWebviewProvider`) | **Message bridge** between `sidebar.html` and the extension host. Owns the spec-driven chat routing state machine, wires up all context-layer services. | `extension.ts` (registered as webview view provider) | hub, `ContextFileManager`, `SourceRegistry`, `SynthesisPipeline`, `SpecManager`, `SpecOpsEngine`, `SkillRegistry` |
| `configManager.ts` (`ConfigurationManager`) | Read/write VS Code settings; store/retrieve **secrets** via `context.secrets` (SecretStorage). | hub, webviewProvider, extension | `extensionIdentity` (secret keys) |
| `languageModelAdapter.ts` (`LanguageModelAdapter`) | Wraps `vscode.lm` to use **GitHub Copilot with no API key** (provider `copilot`). Detection, model selection, consent gate, timeout via `Promise.race`, `listAll()` for the debug command. `copilotAdapter.ts` is a re-export shim; `CopilotAdapter` is a back-compat alias. | hub (`callConfiguredLlm`), extension (commands), webviewProvider (status) | `vscode.lm` |
| `claudeCodeAdapter.ts` (`ClaudeCodeAdapter`) | Runs the **Claude Code CLI** headless (`claude -p --output-format json`) for provider `claude` — no API key, uses the user's existing Claude Code login. `resolve()` locates the binary: `claudeCodePath` setting → PATH → the binary bundled in the `Anthropic.claude-code` extension (`resources/native-binary/claude(.exe)`). `complete()` spawns via `child_process`, pipes the prompt on stdin, parses the JSON `result`. Tools off for JSON calls; `Read`/`Grep`/`Glob` allowed for grounded chat (`allowTools`). | hub (`callConfiguredLlm`), extension (commands), webviewProvider (status) | `child_process`, `fs`, the Claude Code CLI |
| `phaseInference.ts` | **Pure, dependency-free** module. `inferPhases(spec)`, `buildPhaseDependencies()`, `computePhaseStatuses()`. Keyword evidence + `scope.out` vetoes. Unit-tested. | hub | nothing (no `vscode` import — deliberate) |
| `specOps.ts` (`SpecOpsEngine`) | **Deterministic state machine** for the agentic requirements interview. Tracks per-field coverage, turn budget, validates LLM "actions" (`ask`/`ask_many`/`synthesize`/`done`). | webviewProvider | `types` only |
| `specOpsPrompts.ts` | Pure prompt-assembly functions for the discovery + synthesis turns. | hub, webviewProvider | `types` |
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
| `SpecManager.ts` | **Persists the BPS.** Atomic writes to `.ai-context/spec/business-problem.yaml`. Archives prior revisions to `spec/history/`. Approval does **not** bump version; a material re-draft of an approved spec does (`vN` → `vN+1`). Reads legacy flat-format (`scopeIn:`) + legacy `comprehensive:` JSON blocks. | The single most important persistence class. |
| `SourceRegistry.ts` | `.ai-context/sources.yaml` — path → `{kind, layer, owner}`. `kind ∈ {business_context, verified_queries, data_definitions}`. | Small CRUD class. |
| `SynthesisPipeline.ts` | **Rule-based** (not LLM) extraction: reads registered source files, parses bullets / SQL fences → `BusinessTermNode` / `VerifiedQueryNode` / `BusinessRuleNode` with `origin` provenance → adds to the graph. | LLM-assisted extraction is a planned enhancement. |
| `TargetConfigManager.ts` | `.ai-context/target-environment.yaml` — dev/staging/prod profiles with `inherits` inheritance. Creates a default 3-profile config on first run. | **Note:** instantiated nowhere in the wired path — the hub builds `TargetEnvironment` ad-hoc via `extractTargetFromMessage()`. This class is currently orphaned in the runtime (still unit-tested). 💡 |
| `ArtifactWriter.ts` | Writes `GeneratedArtifact.content` to `auto-de/<NN-phase>/[<specId>.v<version>/]<path>`. Atomic. Static `resolveArtifactDirectory()` reads the `artifactDirectory` setting; static `specTag()` computes the `<specId>.v<version>` folder name (Phase B, v0.9.0) — inserted above the artifact's own relative path so multi-file artifacts (dbt scaffold) keep filenames external tools expect. | Phase dirs: `01-discover`, `02-model`, `03-build`, `04-validate`, `00-uncategorized`. Artifacts with no `specId` skip the version folder. |
| `ArtifactStalenessScanner.ts` | `scanArtifactStaleness(workspaceRoot, currentSpec?)` walks `auto-de/<phase>/*`, classifies each `<specId>.v<version>` folder `current`/`stale`/`unknown-spec` against the approved spec, and counts untagged files. Drives the palette's "Generated Artifacts" section. | Filesystem-driven because `PlanState.artifacts` is in-memory only and doesn't survive reload — the folder name is the only durable record. |
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
| `discover/SourceAssessmentAgent.ts` | `sourceAssessmentAgent` | discover | The only agent that touches `ConnectionManager` — connects, `extractMetadata`, `persistSchemaContext`. (Blocked by adapter stubs.) |
| `model/SttmMapperAgent.ts` | `sttmAgent` | model | Splits the task description into tokens, emits a templated `CREATE OR REPLACE VIEW ... AS SELECT col AS mapped_n` mapping. |
| `model/DataModelerAgent.ts` | `dataModelerAgent` | model | Emits full DDL for dimensional / data-vault / OBT / 3NF models from hardcoded column templates, honoring `namingConvention`. |
| `build/IngestionPipelineAgent.ts` | `ingestionAgent` | build | Emits `CREATE TABLE ... ; COPY INTO ... FROM @STAGE` templated SQL. |
| `build/TransformationScaffolderAgent.ts` | `transformScaffoldAgent` | build | Emits a **6-file dbt project** (dbt_project.yml, staging/intermediate/marts models, schema.yml tests, generic test, macro). |
| `validate/DocumentationAgent.ts` | `architectureAgent` | validate | Emits a DDL artifact + a Markdown architecture doc. |
| `../spokes/snowflakeExecutor.ts` | `snowflakeExecutor` | build (💡) | The **only** agent importing `snowflake-sdk`. Opens a real connection and runs `SELECT '<step>' ...`. **Has a hardcoded `username: 'DATA_AGENT_USER'`** (bug — ignores the configured username). |
| `build/ToolSkillAgent.ts` | `toolSkillAgent` | build | **New in Phase D (v0.9.0) — the exception to the realization below.** Runs an imported Claude Agent Skill with real tool access via `claude` (Claude Code's own tool loop) or `copilot` (a real `vscode.lm` tool-calling loop AutoDE owns). Not auto-planner-reachable — only `/skill <id> <instruction>` or the "Run Tool Skill" command invoke it, via `AgentHub.runToolSkill()`. |

> **Key realization (still true for the other 7 agents):** none of `src/agents/**`'s deterministic executors call an LLM — they are string templates. The "AI" in AutoDE is concentrated in the **orchestrator** (planning), the **spec engine** (interview + synthesis), and now `toolSkillAgent` (Phase D) — the first leaf agent that *does* call an LLM and act on its output. The design doc's aspiration ("Ingestion Pipeline Agent generates ingestion code") still overshoots the other 6.

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
│  - PlanState (objective, steps, status, artifacts, inferredPhases)  │
│  - generateSpec / discoverNextAction / synthesizeComprehensiveSpec  │
│  - inferPhasesFromSpec  → phaseInference.ts (pure)                  │
│  - generatePlan → buildPlanPrompt → LLM → validatePlanResponse      │
│  - executePlan → DAG loop → AGENT_EXECUTORS[step.assignedAgent]     │
│  - callConfiguredLlm → provider fan-out                             │
└──────┬───────────────────┬──────────────────┬─────────────────┬─────┘
       │                   │                  │                 │
┌──────▼──────┐   ┌────────▼────────┐  ┌──────▼───────┐  ┌──────▼──────────┐
│ SPEC ENGINE │   │  SUB-AGENTS     │  │ CONTEXT LAYER │  │  LLM PROVIDERS  │
│ specOps.ts  │   │ src/agents/**   │  │ GraphManager  │  │ languageModel + │
│             │   │                 │  │               │  │ claudeCode adpt │
│ skills/*.json│  │ (templated      │  │ ContextFile   │  │ + fetch() to    │
│ specSynthesis│  │  codegen)       │  │  Manager      │  │ OpenAI/Anthropic│
│              │   │ + snowflake     │  │ SpecManager   │  │ /Azure/Gemini/  │
│              │   │   Executor      │  │ SourceRegistry│  │ Ollama          │
└─────────────┘   └────────┬────────┘  └──────┬───────┘  └─────────────────┘
                           │                  │
                  ┌────────▼────────┐  ┌──────▼──────────┐
                  │  ADAPTER LAYER  │  │  PERSISTENCE     │
                  │  src/dqm/**     │  │  .ai-context/    │
                  │  (STUBBED)      │  │  auto-de/        │
                  │  Snowflake      │  │  VS Code settings│
                  │  Databricks     │  │  SecretStorage   │
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
 │    └─ (later) hub.setArtifactWriter(new ArtifactWriter(workspaceRoot, log))
 ├─ new DataAgentHubWebviewProvider(context, configManager, hub)
 │    ├─ new GraphManager()
 │    └─ (on resolveWebviewView)
 │         ├─ new ContextFileManager(root, graph, log, ContextValidator?)
 │         ├─ new SourceRegistry(root, log)
 │         ├─ new SynthesisPipeline(root, graph, log)
 │         ├─ new SpecManager(root, log)
 │         └─ (lazy) new SkillRegistry(...) , new SpecOpsEngine(...)
 ├─ new DataAgentHubPanelProvider(context, hub)
 └─ (lazy, per command) new ConnectionManager(log)
```

Note: `DataAgentHubHub` is a **singleton for the session** but its `PlanState` is a plain in-memory object with no persistence (except artifacts and the spec). Reload VS Code → plan/target-env are gone; the approved spec is reloaded from disk.

### 4.5 Architectural patterns in play

| Pattern | Where | Why (inferred) |
|---|---|---|
| **Orchestrator / hub-and-spoke** | `DataAgentHubHub` + `AGENT_EXECUTORS` map | One coordinator decomposes work and routes to interchangeable, contract-bound workers. |
| **Adapter pattern** | `IDataSourceAdapter` / `BaseDataSourceAdapter` / concrete adapters | Isolate per-platform system tables, dialects, auth so sub-agents stay platform-agnostic. |
| **Strategy / registry** | `AGENT_EXECUTORS`, `AGENT_PHASE`, `PROVIDER_REGISTRY`, `adapterFactories`, `SkillRegistry` | Add a capability by adding a map entry, not editing a switch. (Partially — plan validation still has an allow-list.) |
| **State machine** | `SpecOpsEngine` (`discovery → synthesizing → draft → refining → approved`), spec-driven chat routing | The interview needs a deterministic stop condition that works on plain text LLMs (no tool-calling). |
| **Pure core + imperative shell** | `phaseInference.ts`, `specOps.ts`, `specOpsPrompts.ts`, `specSynthesis.ts` have **no `vscode` import** | Unit-testable in plain Node (the whole test suite depends on this). |
| **Repository pattern (lite)** | `SpecManager`, `SourceRegistry`, `TargetConfigManager`, `ArtifactWriter` | Each owns one file, atomic writes, parse/serialize. |
| **Message-passing UI** | webview ↔ host `postMessage` | VS Code sandboxes webviews; this is the only channel. |
| **Spec-driven / DDD-flavored** | BPS as "system of record", `specId`/`specVersion` stamped on artifacts and phases | Traceability: every artifact can be traced to the spec version that motivated it. |
| **DAG / workflow engine (lite)** | `PlanStep.dependsOn`, `executePlan()` ready-step loop | Steps run when dependencies are `completed`; cycle/missing-dep detection at validate time. |

**Not present:** microservices, event bus / pub-sub, CQRS, hexagonal ports/adapters (the adapter layer is classic adapter, not hexagonal), message queues, actor model.

---

## 5. Runtime Execution Flows

### 5.1 Activation

**Entry:** `activate(context)` in `src/extension.ts` — triggered by any of the `activationEvents` (opening a view or running a command).

```
activate
 ├─ construct ConfigManager, Hub, SidebarProvider, PanelProvider
 ├─ new ArtifactWriter(workspaceRoot ?? extensionUri)  → hub.setArtifactWriter
 ├─ register 15 commands (openSidebar, generatePlan, executePlan, resetSession,
 │   testLanguageModel, listLanguageModelInfo, listLanguageModels,
 │   testCopilot, listCopilotInfo, debugListExtensions, copilotHandoff,
 │   testConnection, sourceAssessment, syncMetadata, reindex)
 └─ context.subscriptions.push( webviewViewProvider×2, customEditorProvider×5, ...commands )
```

Side effects: none on disk until a webview resolves or a command runs. `deactivate()` is **empty** — watchers and the graph are not disposed (🟥 backlog item, `requirements.md` §16.4).

### 5.2 Workflow: Business Problem → Approved Spec (the agentic interview)

**Entry point:** first chat message when `.ai-context/spec/business-problem.yaml` does not exist.

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
             ├─ 'ask'      → post {type:'specQuestion'}   → chat bubble
             ├─ 'ask_many' → post {type:'specQuestions'}  → dynamic intake FORM (2+ fields)
             └─ 'synthesize'|'done' → synthesizeFromSession()

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
 → specManager.saveSpec(spec)   → .ai-context/spec/business-problem.yaml (atomic)
 → post {type:'specDrafted'}  → chat card + palette spec section
 (on any failure → fall back to a single-shot draftSpec(composeSynthesisPrompt(session)))
```

**Then:** user clicks **Approve** in the palette → `approveSpec` message → `specManager.approve()` (status→approved, **no version bump**) → `hub.inferPhasesFromSpec(approved)`.

### 5.3 Workflow: Approved Spec → Phase Inference → Plan → Execution

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
 → PlanState.inferredPhases set; palette renders live status rows

user clicks "Generate Plan" (or generatePlanFromSpec message)
 → hub.generatePlanFromSpec(spec)
     → hub.generatePlan(buildObjectiveFromSpec(spec), schemaContext)
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
         └─ PlanState.status = 'ready'; emitState() → post {type:'stateUpdate'}

user clicks "Execute All"
 → hub.executePlan()
     status = 'running'; reset all steps to 'pending'
     LOOP:
       readyStep = first step whose deps are all in completedIds
       if none & unfinished remain → mark blocked step 'failed', handleFailure() (offer Re-plan)
       if executionPaused → status 'paused', return
       readyStep.status = 'running'; emitState()
       build AgentExecutionContext { objective, schemaContext, sourceProvider,
                                     targetEnvironment, settings, configManager(getSecret),
                                     log, addArtifact, currentPhase }
       result = AGENT_EXECUTORS[readyStep.assignedAgent](readyStep, context)
       if !result.success → step 'failed', handleFailure(), return
       for each result.artifact:
           artifact.phase / specId / specVersion stamped
           artifactWriter.write(artifact)  → auto-de/<NN-phase>/<file>  → artifact.filePath set
       readyStep.status = 'completed'; completedIds.add(id); emitState()
     status = 'completed'
```

**`emitState()`** always recomputes `computePhaseStatuses(inferredPhases, steps, currentPhase)` before pushing — so the palette's phase badges (completed / in-progress / blocked / pending / unrequired) update on every state change.

### 5.4 Workflow: Source Assessment (Discover)

**Entries:** command `autoDataEngineeringHub.sourceAssessment`, palette "Run" on Source Assessment, or a plan step assigned to `sourceAssessmentAgent`.

```
executeSourceAssessmentAgent(step, context)
 → getCredentialsFromSettings('snowflake', settings)
 → validateCredentials → if missing → fail with a clear message
 → getSecret(snowflakePassword / passphrase / databricksToken)
 → new ConnectionManager(log)
 → connectionManager.connect('snowflake', creds)      ← 🟥 STUB: returns fake ConnectionInfo
 → connectionManager.extractMetadata({includeProfiling:true})
     → BaseAdapter.extractMetadata: runs listTables/listColumns/... via executeQuery ← 🟥 returns []
 → connectionManager.persistSchemaContext(snapshot, workspaceRoot)
     → snapshotToGraph(snapshot) → .ai-context/schema-graph.json  (atomic)
 → returns success with a (currently empty) summary
```

Because the adapter is a stub, this "succeeds" but produces an empty graph today.

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

---

## 6. Data Flow Maps

### 6.1 Data sources (inputs)

| Source | Kind | Read by | Notes |
|---|---|---|---|
| User chat text | interactive | webviewProvider → hub | The primary input. |
| VS Code settings (`autoDataEngineeringHub.*`) | config | `ConfigurationManager.getSettings()` | Global target (`ConfigurationTarget.Global`) — **not workspace-scoped**. 💡 potential surprise. |
| VS Code SecretStorage | secrets | `ConfigurationManager.getSecret()` | 3 keys: `llmApiKey`, `snowflakePassword`, `snowflakePrivateKeyPassphrase`. |
| `.ai-context/spec/business-problem.yaml` | file (YAML) | `SpecManager` | The BPS. |
| `.ai-context/sources.yaml` | file (YAML) | `SourceRegistry` | Registered source files. |
| `.ai-context/context/**/*.yaml` | files (YAML) | `ContextFileManager` | Authoritative human-owned context (may not exist yet). |
| `.ai-context/derived/graph.json` | file (JSON) | `ContextFileManager` / `GraphPersistence` | Compiled graph snapshot (gitignored). |
| `.ai-context/schema-graph.json` (legacy) | file (JSON) | `BaseAdapter` / `ContextFileManager` fallback | Written by source assessment. |
| Registered repo files (e.g. `docs/glossary.md`) | files | `SynthesisPipeline` | Referenced, never copied. |
| `skills/*.json` + `.ai-context/skills/*.json` | files (JSON) | `SkillRegistry` | Interview skill definitions. |
| LLM provider APIs | HTTPS | `agentHub` | OpenAI/Anthropic/Azure/Gemini/Ollama via `fetch`; Copilot via `vscode.lm`. |
| Snowflake / Databricks | (would be) SQL over network | `src/dqm/**` | 🟥 not actually connected. |
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
```

Persisted as native YAML (with a `# AutoDE Business Problem Specification` header). `SpecManager` also reads two **legacy** shapes: flat `scopeIn:`/`scopeOut:` and a `comprehensive: <JSON string>` block.

### 6.4 Storage & retention

| Location | Contents | Committed to git? | Retention |
|---|---|---|---|
| `.ai-context/spec/business-problem.yaml` | current BPS | ✅ yes | forever (git history is the version log) |
| `.ai-context/spec/history/business-problem.v{N}.{status}.yaml` | archived prior revisions | ✅ yes | forever, written once per (version,status) |
| `.ai-context/sources.yaml` | source registry | ✅ yes | — |
| `.ai-context/context/**` | authoritative context | ✅ yes | team-owned |
| `.ai-context/target-environment.yaml` | target profiles | ✅ yes (per `.gitignore`) | — |
| `.ai-context/derived/**`, `state.json`, `*.tmp.*` | compiled graph, transient | ❌ gitignored | regenerable |
| `.ai-context/schema-graph.json` | legacy schema graph | 💡 not gitignored (only `derived/` is) — watch for accidental commits | regenerable |
| `auto-de/0X-<phase>/**` | generated artifacts | ✅ yes (visible, meant to be committed/PR'd) | user-managed |
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
| **Agent roles** | Orchestrator (`DataAgentHubHub`) + 7 leaf executors (6 templated codegen + 1 real SQL runner). |
| **Tools** | None in the LLM sense. Leaf agents are plain functions, not tool schemas. |
| **Memory** | `PlanState` (in-memory, session-scoped) + `IntakeSession` (in-memory, lost on reload — 🟥 backlog) + BPS (on disk) + context graph (in-memory). |
| **Planning** | LLM produces a DAG once (`generatePlan`); re-planning is offered on step failure (`handleFailure` → `Re-plan` button → `generatePlan(replanObjective)`). |
| **Routing** | `AGENT_EXECUTORS[step.assignedAgent]` — a static map. The LLM chooses the agent per step from a 7-value allow-list. |
| **Decision logic** | Phase requirement = deterministic keyword rules. Step ordering = LLM + dependency validation. Interview next-action = LLM JSON validated by `SpecOpsEngine`. |

**Agent interaction map:**

```
                    ┌──────────────────────────┐
                    │  DataAgentHubHub          │
                    │  (orchestrator)           │
                    └──┬────────────────────┬───┘
       generatePlan → LLM (DAG)             │ executePlan (DAG loop)
                                            ▼
        ┌────────────┬───────────┬──────────┼───────────┬──────────────┐
        ▼            ▼           ▼           ▼           ▼              ▼
 sourceAssessment  sttm     dataModeler  ingestion  transformScaffold architecture
   (discover)     (model)     (model)     (build)     (build)         (validate)
        │                                                                
        ▼ (only agent that calls out)                                    
 ConnectionManager → SnowflakeAdapter/DatabricksAdapter  [STUBS]          
        │                                                                
        ▼                                                                
 .ai-context/schema-graph.json → GraphManager                            

 snowflakeExecutor (build) ──→ snowflake-sdk ──→ real Snowflake  [hardcoded username bug]
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
| `artifactDirectory` | string, `auto-de` | where artifacts are written | leading/trailing slashes stripped; falls back to `auto-de` |
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
  → context/ArtifactWriter │                    │
  → editors/*              │                    │
                           ▼                    ▼
        webviewProvider → { agentHub, context/*, core/specOps,
                            core/skillRegistry, core/webviewSecurity }
                           │
        agentHub → { agents/**, spokes/snowflakeExecutor, context/ArtifactWriter,
                     core/phaseInference, core/specOps, core/specOpsPrompts,
                     core/specSynthesis, core/languageModelAdapter (lazy require),
                     core/configManager, core/types }
                           │
        agents/discover/SourceAssessmentAgent → dqm/ConnectionManager → dqm/adapters/*
        agents/* → core/types  (only)
                           │
        context/ContextFileManager → context/{GraphManager, Yaml, GraphPersistence, ContextValidator}
        context/SpecManager / SourceRegistry / TargetConfigManager → context/Yaml
        dqm/BaseAdapter → context/types (for node shapes)
```

**Coupling notes:**

- `core/types.ts` and `context/types.ts` are the two universal leaves. `phaseInference`, `specOps`, `specOpsPrompts`, `specSynthesis` depend on **nothing but types** — keep it that way (the tests rely on it).
- `agentHub.ts` is the **god object** (~1040 lines): orchestration + all 6 LLM provider HTTP clients + spec logic + target-env logic + JSON parsing helpers. This is the #1 refactor target. 💡
- `webviewProvider.ts` is a close second — it owns the spec-driven chat state machine *and* wires 5 context services *and* handles ~25 message types.
- `agents/*` are cleanly decoupled (they only import `core/types`) — good.
- `dqm/BaseAdapter` reaching into `context/types` for `TableNode`/`ColumnNode` is a minor layering smell (adapter layer knows about the graph schema). 💡

### 10.4 Shared abstractions

- `AgentExecutionContext` / `AgentExecutionResult` — the sub-agent contract.
- `GeneratedArtifact` — the artifact contract (agents produce, `ArtifactWriter` consumes).
- `Origin` — provenance envelope on every derived context node.
- `applyCspNonce()` — used by every single webview provider + editor.
- Atomic-write idiom (temp file → `rename`) — reimplemented in `SpecManager`, `SourceRegistry`, `TargetConfigManager`, `ArtifactWriter`, `BaseAdapter`, `GraphPersistence`. 💡 Could be one helper.

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
- **Coverage (~51 tests, all in one file):**
  - `LanguageModelAdapter` (Copilot) detect/complete + consent gating
  - `getLlmAdapter()` / `LLM_ADAPTERS` dispatch + fallback (Phase C); an OpenAI-adapter request/response round-trip via a mocked `global.fetch`; missing-API-key error surfacing
  - `ClaudeCodeAdapter` CLI resolution (setting / PATH / bundled-in-extension), `complete()` spawn + JSON parse, error surfacing (via a mocked `child_process`)
  - `toolSkills.parseSkillMarkdown` / `loadToolSkillsFromDirectory` — frontmatter parsing (lenient), resource-file listing, missing-SKILL.md skip (Phase D; real temp-directory fixture)
  - `phaseInference` — `inferPhases`, `computePhaseStatuses`
  - `skillRegistry` — parse/order/field-mapping/directory-load
  - `SpecOpsEngine` — coverage, stop condition, action validation, `applyAction`
  - `specOpsPrompts.buildDiscoveryTurnPrompt` / `buildSynthesisPrompt`, including revision seeding (previous spec + change request + registered context + attachments)
  - `specSynthesis.parseComprehensiveSpec`, including revision field-preservation, provenance carry-forward, and version-bump-only-on-approved
  - `agentHub.generatePlan` / `generatePlanFromSpec` / `synthesizeComprehensiveSpec` (with a mock LM)
  - `ArtifactWriter`/`ArtifactStalenessScanner` — spec-tagged folder writes + current/stale/untagged classification (real temp-directory fixture)
  - `Yaml`, `ContextValidator`, `GraphPersistence`
  - `SpecManager` / `SourceRegistry` / `TargetConfigManager` round-trips (incl. legacy formats)
  - `ContextFileManager` authoritative-load + atomic graph persist

  **Notable gap:** `ToolSkillAgent.ts`'s tool-calling loop (Phase D) has **no automated test** — mocking `vscode.lm`'s streaming tool-call/tool-result protocol faithfully was judged lower-value than the time it would cost versus real verification. The Claude execution path was instead verified by hand against the actual bundled Claude Code CLI (confirmed `--permission-mode acceptEdits` is required and sufficient for a real file write); the Copilot path's tool-calling code compiles against the real `@types/vscode` definitions and follows the documented API, but has not been run against a live Copilot session.
  - `extension.activate()` registers subscriptions
- **Gaps:** `GraphManager` traversal correctness, `SynthesisPipeline` provenance, `ArtifactWriter` atomicity, adapter connect/query, per-kind AJV, the sub-agents' output.

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
2. **The BPS is the center of gravity.** `.ai-context/spec/business-problem.yaml`. Everything keys off `specId`/`specVersion` and `status`. Read `SpecManager.ts` and `types.ts:BusinessProblemSpec`.
3. **The spec-driven chat router.** In `webviewProvider.handleMessage('chat')`: no spec → interview; draft → revise; approved → grounded chat. This is the single most confusing thing for newcomers ("why isn't my chat message answering me?" → because there's a draft spec waiting for approval).
4. **Phase inference is deterministic and pure.** `phaseInference.ts`. Keyword evidence in the spec corpus, `scope.out` vetoes, natural dependency chain. No LLM. Fully unit-tested — read the tests.
5. **The orchestrator does the AI; the leaf agents don't.** `agentHub.ts` calls the LLM for planning; `src/agents/**` are string templates. Don't expect the ingestion agent to "understand" anything.
6. **`callConfiguredLlm` is the single LLM chokepoint.** Provider fan-out lives there. Copilot is special (no key, consent gate, `vscode.lm`).
7. **Run the extension:** F5 (uses the launch config that disables Cline). Run tests: `npm run compile && node test/functional.test.cjs`.

#### Learn Next (week 1–2)

8. The **SpecOps engine** (`specOps.ts`) + **skills** (`skills/*.json`) + the two-mode question UI (`specQuestion` bubble vs `specQuestions` form).
9. The **Context Layer**: `GraphManager` (nodes/edges/indexes/BFS), `ContextFileManager` (loaders + `buildContextPrompt`), `SynthesisPipeline` (rule-based extraction), the `.ai-context/` file hierarchy (`requirements.md` §3.7).
10. The **adapter layer** (`src/dqm/**`) — the interface is solid; the implementations are stubs. If you're doing Phase 4, this is your home.
11. The **artifact pipeline**: `GeneratedArtifact` → `context.addArtifact` / `result.artifacts` → `ArtifactWriter.write` → `auto-de/0X-<phase>/`.
12. The **webview message protocol** (both directions) — `technical-design.md` Appendix A is a good reference, but verify against `webviewProvider.handleMessage`.
13. The **custom editors** and their `media/editors/*.html`.

#### Ignore For Now

- `src/features/**` (dead code — candidate for deletion).
- `src/spokes/{architectureAgent,ingestionAgent,sttmAgent}.ts` (superseded; only `snowflakeExecutor.ts` matters).
- `TargetConfigManager` (unit-tested but orphaned from the runtime path — the hub builds target env ad-hoc).
- The two root `.vsix` files.
- `mock_activate.js` (gitignored dev scratch).
- CSS details in `sidebar.html` (~700 lines of it) unless you're doing UI work.
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
| 12 | F5 the extension, run the full flow with Copilot, watch `.ai-context/` and `auto-de/` populate | The whole thing, live |
| 13 | Read `docs/requirements.md` §16 (Pending Tasks Backlog) | What's next and why |

---

## 14. Important Files to Read (ranked)

| # | File | Why it matters | Time | What you learn |
|---|---|---|---|---|
| 1 | `src/core/agentHub.ts` | The orchestrator + all LLM I/O + spec/plan/execute logic | 45 min | 60% of the system's behavior |
| 2 | `src/core/types.ts` | Every domain type | 20 min | The shared vocabulary |
| 3 | `src/core/webviewProvider.ts` | Message bridge + spec-driven chat router + service wiring | 30 min | How the UI drives the backend |
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
| 16 | `src/agents/build/TransformationScaffolderAgent.ts` | The richest templated agent (6-file dbt project) | 15 min | The agent contract + templating style |
| 17 | `src/agents/discover/SourceAssessmentAgent.ts` | The only agent that calls the adapter layer | 15 min | Discover-phase wiring |
| 18 | `src/context/SynthesisPipeline.ts` | Rule-based context extraction + provenance | 15 min | How registered files become graph nodes |
| 19 | `test/functional.test.cjs` | The entire test suite + the `vscode` mock pattern | 30 min | Executable spec of the pure modules; how to test here |
| 20 | `docs/requirements.md` §3 + §8 + §16 | Context-layer IA, BPS spec, backlog | 30 min | The intended end state and the gap |

Runners-up: `package.json` (`contributes.*` is the extension's API surface), `src/core/configManager.ts`, `src/context/ArtifactWriter.ts`, `docs/technical-design.md` §2 + §5 + §6.

---

## 15. Knowledge Graph

```
AutoDE (VS Code extension)
├─ Activation & Surface  (extension.ts, package.json contributes.*)
│   ├─ Commands (13)
│   ├─ Views: Sidebar webview, Panel webview
│   └─ Custom Editors (5, opt-in)
│
├─ UI Layer  (media/*.html)
│   ├─ Sidebar = DE Agent Workspace (chat, plan cards, context drawer, palette, settings)
│   ├─ Panel = dashboard
│   └─ Transport: postMessage protocol  (webviewProvider ⇄ sidebar.html)
│
├─ Orchestration  (core/agentHub.ts :: DataAgentHubHub)
│   ├─ PlanState (in-memory, session-scoped)
│   ├─ Spec lifecycle
│   │   ├─ generateSpec (single-shot)         → parseSpecResponse
│   │   ├─ discoverNextAction (interview turn) → SpecOpsEngine.validateAction
│   │   └─ synthesizeComprehensiveSpec         → parseComprehensiveSpec (+ provenance)
│   ├─ Phase inference  → core/phaseInference.ts (pure)
│   │   ├─ inferPhases (keyword evidence + scope.out veto + default-all)
│   │   ├─ buildPhaseDependencies (natural chain, pruned)
│   │   └─ computePhaseStatuses (live badges)
│   ├─ Planning  → buildPlanPrompt → LLM → validatePlanResponse → PlanStep[] (DAG)
│   ├─ Execution → executePlan ready-step loop → AGENT_EXECUTORS[assignedAgent]
│   ├─ Target env → extractTargetFromMessage (LLM) + buildTargetFromPartial
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
│   ├─ Model:    sttmAgent, dataModelerAgent            (templated DDL)
│   ├─ Build:    ingestionAgent, transformScaffoldAgent (templated SQL/dbt)
│   │            snowflakeExecutor (real snowflake-sdk; hardcoded username bug)
│   └─ Validate: architectureAgent (DDL + arch doc)
│        └─ all return AgentExecutionResult { success, message, artifacts? }
│
├─ Context Layer  (.ai-context/  +  src/context/**)
│   ├─ GraphManager (nodes, edges, FQN/label/type indexes, BFS decay scoring)
│   ├─ ContextFileManager (loads context/**, derived/graph.json; buildContextPrompt)
│   ├─ SynthesisPipeline (rule-based file → nodes with Origin provenance)
│   ├─ SourceRegistry (sources.yaml)
│   ├─ SpecManager (spec/business-problem.yaml + history/, atomic, versioned)
│   ├─ ContextValidator (AJV, envelope only)
│   ├─ GraphPersistence (atomic derived/graph.json)
│   ├─ ArtifactWriter (GeneratedArtifact → auto-de/0X-<phase>/)
│   └─ TargetConfigManager (target-environment.yaml)  [orphaned from runtime]
│
├─ Adapter Layer  (src/dqm/**)   [interface real, impls STUBBED]
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
| R3 | **`agentHub.ts` is a large god object** — orchestration + spec + target-env + JSON parsing, all in one class. **Partially addressed (Phase C, v0.9.0):** the LLM provider fan-out (was ~220 lines of if/else + 6 HTTP client methods) is now `llmAdapter.ts` + `llmProviders.ts`; `callConfiguredLlm` is a ~15-line lookup. | Hard to test in isolation, merge-conflict magnet, high cognitive load. Still true for spec-handling and target-env logic. | Extract a `SpecService` and a `TargetEnvService` the same way; keep `agentHub` to state + flow control. |
| R4 | **No RAG / retriever / token budgeting.** `buildContextPrompt` concatenates the whole graph; `tokens = nodes × 50`. | Context can blow past model limits silently; irrelevant context dilutes prompts; STRICT-rule-survives-pruning invariant (`requirements.md` §10.6) is unenforced. | Implement `ContextRetriever` (`requirements.md` §16.2): `js-tiktoken` counting, relevance + centrality ranking, hard budget, STRICT rules pinned. Wire `GraphManager.traverseNeighborhood` (already built) into it. |
| R5 | **Sub-agents are templates, not AI.** They ignore `schemaContext` and the context graph entirely; DDL columns are hardcoded (`dim_customer` etc.). | Generated artifacts are generic boilerplate, not grounded in the user's actual schema or spec. Misleading vs the product pitch. | Give each agent an LLM path that takes `objective + schemaContext + targetEnvironment + relevant context subgraph` and emits grounded SQL; keep the template as a fallback. |
| R6 | **`deactivate()` is empty** (`extension.ts:181`). Watchers (`ContextFileManager`, `TargetConfigManager`), the graph, and services are never disposed. | Leaked file watchers / handles on window reload; violates `requirements.md` §3.10 #3. | Track disposables, dispose all in `deactivate()` within 200ms. |
| R7 | **Dead / duplicate code:** `src/features/**` (entirely unused), `src/spokes/{architectureAgent,ingestionAgent,sttmAgent}.ts` (superseded). Both still compile. | Confuses newcomers ("which `sttmAgent` is real?"), bloats the VSIX, `grep` noise. | Delete `src/features/**`; delete the 3 superseded spokes; move `snowflakeExecutor` into `src/agents/` (or `src/dqm/`). |
| R8 | **`IntakeSession` is in-memory only.** A window reload mid-interview loses all Q&A. Since v0.9.0 this also covers *revision* interviews (`previousSpec`/`changeRequest`/`attachments`) — a revision spanning a reload is lost the same way. | Frustrating UX; long interviews (and revisions) are fragile. | Persist to `.ai-context/spec/intake.yaml` (`requirements.md` §16.5). |
| R9 | **Many settings are declared but unused:** `metadataCachingDurationMinutes`, `queryTimeoutSeconds`, `readOnlyMode`, `enableSessionReuse`, `autoDocumentationEnabled`, `telemetryEnabled`. | Users set them expecting behavior; nothing happens. `readOnlyMode: true` (default) especially implies a safety guarantee that doesn't exist. | Either implement or remove/hide. `readOnlyMode` should gate `snowflakeExecutor` and any future write path. |
| R10 | **LLM JSON parsing is brittle.** `validatePlanResponse` requires a bare JSON array; `parseJsonObject` tries a couple of slices. Weaker models frequently fail. | Plan generation fails opaquely; poor experience on non-frontier models. | Add a repair pass (ask the model to fix its own JSON), or use a tolerant JSON extractor; log the raw response for debugging. |
| R11 | **`TargetConfigManager` is orphaned.** The documented `.ai-context/target-environment.yaml` + profile inheritance flow (`technical-design.md` §4.7) isn't in the runtime path; the hub builds target env ad-hoc via an LLM extraction. | Doc/code mismatch; profile inheritance (dev/staging/prod) unavailable despite being built + tested. | Decide: wire `TargetConfigManager` into `webviewProvider` + `agentHub`, or delete it and update the docs. |
| R12 | **No CI, no lint, tests not in `npm test`.** | Regressions land silently; the pure-module invariant (no `vscode` import) can be broken unnoticed. | Add `"test": "tsc -p ./ && node test/functional.test.cjs"`, a GitHub Action, and an ESLint config. |
| R13 | **`.ai-context/schema-graph.json` is not gitignored** (only `derived/` is). | The legacy generated schema graph can get committed accidentally. | Add it to `.gitignore` or migrate fully to `derived/system/`. |
| R14 | **Secrets in prompts.** Chat/plan context blocks include `## Target Environment` with account names; `extractTargetFromMessage` sends the raw user message to the LLM. Consent covers "using Copilot" but the data-flow isn't surfaced per-call. | Potential leakage of environment identifiers to third-party LLMs; `requirements.md` §12 wants explicit data-flow disclosure. | Add the one-time consent modal (`requirements.md` §16.4), redact obvious secrets from context blocks, document what's sent. |
| R15 | **Per-kind AJV `content` schemas deferred.** Only the envelope is validated. | Malformed `content` in authoritative context files passes silently and can corrupt the graph. | Add per-`kind` schemas (`requirements.md` §16.6). |
| R16 | **Databricks token has no UI.** `SourceAssessmentAgent` reads `autoDataEngineeringHub.databricksToken` from secrets, but nothing stores it. | Databricks source assessment can never get credentials. | Add token fields to the connection panel (and `getCredentialsFromSettings` for databricks reads from settings keys that aren't registered). |
| R17 | **Tool-executing skills have no hard sandbox.** (`ToolSkillAgent.ts`, Phase D) The Copilot path checks that a path argument doesn't escape the workspace root and gates writes/exec on a confirmation dialog — but there's no OS-level jail; a user who approves an adversarial command (e.g. one reached via a prompt-injected instruction inside a skill's own resource file) can still act outside the workspace. The Claude path relies entirely on whatever Claude Code's own tools do. | A skill run that gets approved once can do more than the "workspace-scoped" framing implies. | A real sandbox (container, restricted OS user, seccomp, etc.) if this feature sees real use; until then, treat every approval prompt as "I trust this skill," not "this is contained." |
| R18 | **Claude-path tool-executing skills get one whole-run approval, not per-call.** (`ToolSkillAgent.ts`) Claude Code's documented `--permission-prompts host` + external-tool callback for per-call approval exists but its schema isn't published anywhere accessible; wiring it up would mean guessing at an undocumented contract. | A single "yes" at the start of a run implicitly approves every subsequent Edit/Write/Bash call Claude Code's own loop makes during that run — a real reduction in granularity versus the Copilot path's true per-call gate. | Revisit if/when Claude Code documents the permission-prompt-tool contract; until then this is a known, accepted gap, not an oversight. |
| R19 | **Bash execution via the Claude tool-skill path is unverified.** `--permission-mode acceptEdits` was confirmed (against the real CLI) to unblock file writes headlessly, but in the same testing, a forced "run this exact Bash command" instruction came back as descriptive text, not an actual tool invocation — for reasons not fully diagnosed (Windows tool-availability quirk, or model judgment). | A skill that needs to run shell commands via the `claude` provider may silently not execute them, with no explicit error — the model just narrates instead. | Test on a non-Windows host / investigate whether a different tool name or `--permission-mode bypassPermissions` changes this, before relying on Bash-via-Claude for anything. |

---

## 17. Extension Guide

> General rule: sub-agents import **only** `core/types`. Keep it that way. Pure modules (`phaseInference`, `specOps*`, `specSynthesis`) must **never** import `vscode`. **One deliberate exception (Phase D):** `build/ToolSkillAgent.ts` imports `vscode` and `node:child_process` directly, because it does real file I/O, process spawning, and approval dialogs — not deterministic templating like every other agent. Don't use it as a precedent for the other 7; if you're tempted to import `vscode` in a template agent, that's a sign the work belongs somewhere else.

### 17.1 Add a new sub-agent (e.g. `sqlValidatorAgent`)

1. `src/core/types.ts` → add `'sqlValidatorAgent'` to the `AgentType` union.
2. Create `src/agents/validate/SqlValidatorAgent.ts` exporting
   `export async function executeSqlValidatorAgent(step: PlanStep, context: AgentExecutionContext): Promise<AgentExecutionResult>`.
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

---

## 18. Glossary of Domain Terms

| Term | Meaning in AutoDE |
|---|---|
| **BPS / Business Problem Specification** | The structured, versioned YAML artifact (`.ai-context/spec/business-problem.yaml`) that is the system of record. Governs phase inference, planning, traceability. |
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
| **Artifact / GeneratedArtifact** | A produced file (SQL/YAML/MD/PY/JSON) written to `auto-de/0X-<phase>/`. |
| **Context Layer / Enterprise Context Layer** | The `.ai-context/` knowledge graph + files that ground LLM prompts. |
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

---

## 19. FAQ for New Engineers

**Q: I typed a message in the chat and it started asking me interview questions instead of answering. Why?**
A: There's no approved BPS yet. With no spec, chat routes to SpecOps discovery. With a draft spec, chat routes to "revise the spec". Only an **approved** spec makes chat behave conversationally. Approve it in the Workflow Palette (🧰).

**Q: Where's the actual AI in the sub-agents?**
A: There isn't any. `src/agents/**` are deterministic string templates. The LLM is used by the *orchestrator* (planning) and the *spec engine* (interview + synthesis). Making agents LLM-grounded is open work (R5).

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
A: `auto-de/01-discover/`, `02-model/`, `03-build/`, `04-validate/` (configurable via `artifactDirectory`). The folder is created on first execution and is meant to be committed / PR'd.

**Q: Where's the BPS stored and how is it versioned?**
A: `.ai-context/spec/business-problem.yaml`. Git is the version history. `version` bumps only when an already-**approved** spec is materially re-drafted; approving a draft keeps its version. Prior revisions are archived to `.ai-context/spec/history/`.

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

*Generated by reverse-engineering the repository. Keep this doc next to `docs/requirements.md` and `docs/technical-design.md`; update it when the adapter layer becomes real (Phase 4) — that will change §1, §5.4, §7, and §16 materially.*
