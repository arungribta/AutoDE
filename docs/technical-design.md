# AutoDE — Technical Design Document

**Last Updated:** 2026-09-16
**Version:** 0.13.0
**Status:** v0.8.0 code committed. Implemented:
- Single-workspace model (`ArtifactWriter`, `autoDE.artifactDirectory`; `ProjectManager` removed)
- Context Layer IA: unified envelope (`src/context/types.ts`, `docs/schemas/context-envelope.schema.json`), `SourceRegistry` (`sources.yaml`), `SynthesisPipeline`
- Webview CSP nonce fix, workflow palette rework, Cline dev-host workaround in `.vscode/launch.json`
- **Business Problem Specification (spec-driven orchestration)** — see §2. Implemented: BPS types + `SpecManager` persistence/versioning/history, `AgentHub.generateSpec` (LLM-based spec drafting/refining with version semantics), spec-aware chat routing (no-spec → draft, draft → revise, approved → grounded chat), palette + chat spec card review/approve/revise/open UI, `/spec` command, and `generatePlanFromSpec` (spec-driven plan generation).
- **Spec-driven phase inference + orchestration** — see §2.5/§2.7. Deterministic `inferPhases()` (keyword evidence + `scope.out` exclusions + dependency chaining) turns an approved BPS into a required-phase set; plan generation is constrained to those phases; the palette renders the live phase status view (completed / in-progress / blocked / pending / unrequired).
- **Agentic Specification Generation (SpecOps)** — see §2.8. A Superpowers-inspired, DE-tailored requirements flow: a `SpecOpsEngine` state machine + `skills/` registry drive an adaptive questioning conversation (chat bubbles + dynamic intake forms), then synthesize the comprehensive v2 spec (business requirements, data flows, transformations, dependencies, acceptance criteria, implementation considerations, source catalog, provenance).
- **Phase 3 (parts 1 & 2) — layered context loading** — see §10. Real YAML parser (`yaml` dep + `src/context/Yaml.ts`), AJV envelope validator (`src/context/ContextValidator.ts`), atomic compiled-graph persistence (`src/context/GraphPersistence.ts` → `derived/graph.json`); `ContextFileManager` layered loading (`context/**` + `derived/graph.json` via `GraphPersistence`, legacy fallbacks) with AJV envelope validation wired through `ContextValidator`; `SpecManager`/`SourceRegistry`/`TargetConfigManager` migrated to the real `yaml` library.
- **(v0.10.0)** Generate Plan audit follow-through — see §2.12. Context Layer synced from the approved spec automatically before planning (`SynthesisPipeline.synthesizeFromSpec`, durable snapshot per spec version); deterministic Greenfield/Brownfield classification (`src/core/implementationType.ts`) with user override, feeding phase inference; plan persistence (`src/context/PlanManager.ts`, mirrors `SpecManager`); artifact-level version history (`ArtifactWriter`); `validatePlanResponse` cycle detection + required-phase enforcement + tolerant JSON parsing (closes R10). Source/target environment context implemented — `Origin.environment` tags on the existing Context Layer, `TargetConfigManager` wired into `extension.ts` — see `requirements.md` §16.3a.
- **(v0.10.0, same day)** Workflow UX follow-through from hands-on testing — see §8.9 of `requirements.md`. Fixed a stale-status race that made plan generation look stuck after `generatePlanFromSpec`; added an explicit plan-ready confirmation with View Plan/Review Stages actions; new `pending-review` phase status + per-phase Applicable/Non-Applicable overrides on the palette; `executePlan`'s DAG loop no longer halts on the first step failure — independent steps keep running so a missing target connection doesn't block every other artifact; "Generate Artifacts" is now the consistent label everywhere plan execution is triggered; artifact storage moved from a sibling `auto-de/` folder to `.ai-context/artifacts/`.
- **(v0.11.0)** Source & Target Context are now mandatory, reviewed, gating objects — see §8.10 of `requirements.md`. `TargetContextManager`/`SourceContextManager` persist spec-tied records built through a fixed Q&A (`targetContextQuestions.ts`/`sourceContextQuestions.ts`); `generatePlanFromSpec` is blocked server-side until both are approved (Source auto-marked Non-Applicable for Greenfield); the Workflow Palette gained a "Source & Target Context" section. The 5 template codegen agents now try an LLM call first (`AgentExecutionContext.callLlm`, `src/agents/llmCodegen.ts`), grounded in the task/objective/context/target environment, falling back to their original templates — closing the "agents ignore schemaContext" finding (R5 / requirements.md §8's Revision 3 analysis). `TargetConfigManager`'s generic default is no longer auto-seeded into the hub (a regression from wiring it in during v0.10.0).
- **(v0.12.0)** Multi-business-problem workspace — see §8.11 of `requirements.md`. A single workspace can now hold more than one business problem, each fully isolated under `.ai-context/problems/<id>/{spec,plan,context,artifacts}/`, with `.ai-context/active-problem.json` naming the current one; `SpecManager`/`PlanManager`/`TargetContextManager`/`SourceContextManager`/`ArtifactWriter` were re-scoped to take a caller-resolved `contextRoot` instead of hardcoding `.ai-context/<thing>` off the workspace root. New `AgentHub.resetForNewProblem()` and `webviewProvider.activateProblem()` guarantee a genuinely clean in-memory state on every activation/switch — including swapping the shared Context Layer graph's spec-derived layer via `removeNodesBySourceRef`/`synthesizeFromSpec` — closing the stale-state bug where clearing chat and deleting `.ai-context` by hand still left the previous spec visible. New Workflow Palette "Business Problem" section (＋ New / ⇄ Switch) drives `startNewBusinessProblem`/`listBusinessProblems`/`switchBusinessProblem`.
- **(v0.13.0)** Lifecycle orchestration — see §8.12 of `requirements.md`. `AgentHub` is now the single enforcement point for the lifecycle's approval gates, closing a finding from the Generate Plan audit's Revision 6 (§11): at least seven UI entry points (Command Palette commands, the AutoDE Dashboard panel's Quick Actions, the `/plan` slash command, re-plan buttons) could reach plan generation/execution without ever touching a spec or context approval. `AgentHub.generatePlan()` now requires an active, context-ready business problem (`state.specId` + new `state.contextGateReady`, pushed by `webviewProvider.postContextGateStatus()`) before doing anything else; its old body moved to a private `generatePlanInternal()` that `generatePlanFromSpec()` calls after its own, stricter checks. Two new explicit approval gates before `executePlan()` will run: Plan Approval (`AgentHub.approvePlan()`) and Stage Confirmation (`AgentHub.confirmStages()`), both persisted via a new `PlanManager.patchGates()` and both reset whenever the plan or its inferred phases change. New lightweight Business Problem checkpoint (`BusinessProblemSpec.problemStatementApproved`) gates `approveSpec`. Also fixed in the same pass: `SpecManager` was silently dropping `implementationType`/`implementationTypeReason`/`implementationTypeOverridden` on every save, never actually persisting a user's Greenfield/Brownfield classification. The AutoDE Dashboard panel itself is explicitly parked (product decision, 2026-09-16) — future work.
- **(v0.13.0, same day)** Discovery progress surfacing — see §8.13 of `requirements.md`. Fresh dev-host testing found that even a fully orchestrated discovery interview *read* as ungrounded, unstructured chat, because `SpecOpsEngine`'s real per-field coverage/turn-budget/skill-ownership tracking never reached the webview — `specQuestion`/`specQuestions` payloads were just the bare question, and the Workflow Palette showed nothing during discovery at all. New pure module `src/core/discoveryProgress.ts` (`buildDiscoveryProgress`, `skillNameForField`) now feeds a `progress` snapshot + per-question `skillLabel` into both message types; the chat bubbles show a topic + progress readout, and the palette shows a live "discovery in progress" card (progress bar + per-skill checklist) instead of staying blank until synthesis.
- **(v0.13.0, same day)** Chat no longer auto-resumes on reload — see §8a.4 of `requirements.md`. A reload/restart previously reloaded whatever chat session was last active, transcript and all — confusing testers who expected a clean slate. Any session with real content is now folded on activation (archived via the existing `startNewChat()` path, never discarded) and a fresh empty one takes its place; a new "🕓" Chat History icon in the sidebar topbar lists past sessions and resumes one on click. `openChatSession`'s semantics changed from a read-only preview (`chatSessionViewed`, now retired) to a real resume (`chatSessionLoaded`, reactivating the session via `ChatSessionManager.updateMeta(id, {status:'active'})`) — this closed out the last piece of Phase F's chat-session plumbing that had no UI consumer.

Next: **Phase 4 — real data adapters** (wire `snowflake-sdk`/`Databricks`) and beyond — see §10. The remaining SpecOps polish (skills authoring guidance, intake-session persistence) is tracked in §10. The AutoDE Dashboard panel (parked in v0.13.0) is the next lifecycle-adjacent item.

---

## Table of Contents

1. [Overview & Architecture Philosophy](#1-overview--architecture-philosophy)
2. [Business Problem Specification & Spec-Driven Architecture](#2-business-problem-specification--spec-driven-architecture)
3. [UI Architecture](#3-ui-architecture)
4. [Context Layer](#4-context-layer)
5. [Multi-Platform Adapter Architecture](#5-multi-platform-adapter-architecture)
6. [Agent Orchestration](#6-agent-orchestration)
7. [LLM Integration](#7-llm-integration)
8. [Extension Architecture](#8-extension-architecture)
9. [File Structure](#9-file-structure)
10. [Implementation Phases](#10-implementation-phases)
11. [Design Decisions & Tradeoffs](#11-design-decisions--tradeoffs)

---

## 1. Overview & Architecture Philosophy

### 1.1 What is AutoDE?

AutoDE is an AI-augmented VS Code extension for Data Engineering. It provides:

- A **conversation-first workspace** for planning, executing, and refining data engineering pipelines
- A **production-grade context layer** (knowledge graph + vector search + token-aware retrieval) that grounds LLM prompts in actual database schemas and business context
- **Multi-platform adapter architecture** that abstracts away platform-specific metadata extraction, SQL dialects, and capabilities
- **Agent orchestration** with an orchestrating/planning agent that decomposes objectives into DAG-based execution plans and routes to specialized sub-agents

### 1.2 Core Design Principles

| Principle | Rationale |
|-----------|-----------|
| **Conversation-first** | The chat is the central nervous system. Everything else (context, settings, connection status) is surfaced within or adjacent to the conversation, not siloed in separate tabs. |
| **Platform-agnostic agents** | Sub-agents ask "what" (extract metadata, run query, generate DDL). Adapters know "how" (which system tables to query, which SQL dialect to use). |
| **Progressive disclosure** | Show essential status at a glance (top bar), reveal detail on demand (expandable panels, slide-outs). |
| **Context visibility** | The semantic layer (database schemas, business terms, verified queries) must be visible and interactive — users should see what context is being fed into each prompt. |
| **Atomic operations** | All writes to `.ai-context/` use temporary staging + atomic rename to prevent corruption. |
| **Zero UI blocking** | Heavy compute (embedding, graph traversal, large file parsing) runs off the Extension Host main thread. |

### 1.3 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     VS Code Extension Host                    │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ extension.ts │  │ agentHub.ts  │  │ webviewProvider.ts │  │
│  │ (activate)   │  │ (orchestrator│  │ (message bridge)   │  │
│  └──────┬───────┘  │ + LLM calls) │  └────────┬───────────┘  │
│         │          └──────┬───────┘           │              │
│         │                 │                   │              │
│  ┌──────┴─────────────────┴───────────────────┴──────────┐  │
│  │                  Core Services                         │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐  │  │
│  │  │ ConfigManager│ │ LM Adapter   │ │ProviderRegistry│  │  │
│  │  └──────────────┘ └──────────────┘ └───────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  Context Layer                         │  │
│  │  ┌──────────────┐ ┌──────────────────┐                │  │
│  │  │ GraphManager │ │ContextFileManager│                │  │
│  │  └──────────────┘ └──────────────────┘                │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │            Multi-Platform Adapter Layer                │  │
│  │  ┌────────────────┐ ┌───────────────────────────────┐ │  │
│  │  │ConnectionManager│ │BaseDataSourceAdapter (abstract)│ │  │
│  │  └────────────────┘ └───────────┬───────────────────┘ │  │
│  │                     ┌───────────┼───────────┐         │  │
│  │                     ▼           ▼           ▼         │  │
│  │              ┌──────────┐ ┌──────────┐ ┌──────────┐  │  │
│  │              │Snowflake │ │Databricks│ │ BigQuery │  │  │
│  │              │ Adapter  │ │ Adapter  │ │ Adapter  │  │  │
│  │              └──────────┘ └──────────┘ └──────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  Sub-Agents                            │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │  │
│  │  │ Discover │ │  Model   │ │  Build   │ │ Validate │ │  │
│  │  │  Agents  │ │  Agents  │ │  Agents  │ │  Agents  │ │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                     Webview (sidebar.html)                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Top Status Bar [Provider] [Connection] [Context] [Plan]│  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Chat Stream (messages, plan cards, context previews)   │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Context Drawer (collapsible)                           │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Chat Input + Action Bar                                │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Slide-Out Panels: Settings / Workflow Palette          │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Business Problem Specification & Spec-Driven Architecture

> **North star.** This section defines AutoDE's governing flow. It supersedes the earlier "objective → plan" model. `docs/requirements.md` remains the authoritative requirements source.

### 2.1 Principle

AutoDE is **conversation-driven and specification-driven**. The user describes a business problem in natural language; AutoDE transforms it into a structured, reviewable, versioned **Business Problem Specification (BPS)**. The BPS — not the raw prompt — is the **system of record** for the repository and governs all subsequent activity.

### 2.2 The Business Problem Specification artifact

| Field | Purpose |
|-------|---------|
| `id`, `version` | stable identity; version increments on each approval |
| `status` | `draft` → `approved` → `superseded` |
| `problemStatement` | refined statement (from the user's prompt) |
| `objectives` | measurable business outcomes |
| `successCriteria` | how we know it is solved |
| `scope.in` / `scope.out` | boundaries |
| `constraints`, `assumptions` | guardrails |
| `domain`, `stakeholders`, `keyEntities` | context hints for context-building |
| `targetEnvironment` | platform + modeling + transformation tooling |
| `createdAt/updatedAt/approvedAt/approvedBy` | audit |

Persisted and versioned in `.ai-context/spec/business-problem.yaml` (git is the version history).

### 2.3 Spec-driven flow

```
prompt ──(LLM analysis)──► BPS (draft)
                            │ user reviews → approves (or regenerates)
                            ▼
                       BPS (approved, vN)
                            │ (LLM assessment)
                            ▼
                    Phase plan (which phases + dependencies)
                            │
              ┌─────────────┴──────────────┐
              ▼                            ▼
   Continuous context creation      Orchestrated execution
   (repo assets + sources +         (agents in dependency order)
    platform metadata)                      │
              └─────────────┬──────────────┘
                            ▼
               Palette = live status view
```

### 2.4 Traceability

Every `GeneratedArtifact`, context node (`Origin`), and workflow phase carries `specId` + `specVersion`.

### 2.5 Phase inference (no manual step selection)

From the approved BPS, AutoDE determines which phases (discover / model / build / validate) are required and their dependencies. The user does **not** select workflow steps; the workflow is inferred and continuously adapted.

**Implemented (v0.6.0).** `src/core/phaseInference.ts` is a pure, deterministic module:
- `inferPhases(spec)` — keyword evidence across the problem statement / objectives / success criteria / scope / constraints / assumptions / domain / key entities marks a phase required; `scope.out` exclusions veto a phase; an underspecified-but-approved spec defaults to the full workflow; a build (transformation) phase implies discovery when source evidence exists.
- `buildPhaseDependencies(required)` — the natural predecessor chain (discover → model → build → validate) is pruned to the required set, so a phase depends only on required predecessors.
- `computePhaseStatuses(phases, steps, currentPhase)` — derives live status per phase from the plan: `completed`, `in-progress` (running or partially done), `blocked` (a dependency is unsatisfied or a step failed), `pending`, or `unrequired`.
- Orchestration integration in `AgentHub`: `inferPhasesFromSpec()` is invoked on spec approval, on work-space load with an approved spec, and on reset; `buildPlanPrompt` receives the required phases so the LLM only plans steps for those phases; every step is tagged with its phase at plan time; every state emit recomputes phase statuses.

### 2.6 Continuous context creation

Context layers (industry / enterprise / domain / system / definitions / queries / artifacts) are built **automatically** from the BPS + repository assets + registered sources + platform metadata — not a manual step. `SourceRegistry` + `SynthesisPipeline` (Phase 2) are the foundation; the spec drives *what* to build.

### 2.7 Workflow Palette as status view

The palette shows (top → bottom): BPS summary (read-only + status + approve/regenerate) → phase status (completed / in-progress / blocked / pending) → next action. It is a **transparent view**, not a manual launcher.

**Implemented (v0.6.0).** The palette's four phase rows are driven by `PlanState.inferredPhases` on every `stateUpdate`: each row shows a status badge, the deterministic inference reason, and the dependency chain; unrequired phases are dimmed and show no run buttons; completed phases disable their run buttons; the surfaced agents are read from the selected phase only.

### 2.8 Agentic Specification Generation (SpecOps)

The BPS draft is produced by an **agentic, DE-tailored requirements flow** inspired by the Superpowers SDLC (skills + explicit phases + review gates), rather than a single-shot prompt.

**Skills.** `skills/*.json` define composable DE skills — Requirements Discovery, Source Catalog, Data Flow, Transformations, Quality & Acceptance, Constraints & Assumptions, and Synthesis. Each carries a system prompt, question guidance, and the spec fields it owns. `SkillRegistry` (`src/core/skillRegistry.ts`) loads bundled skills plus optional user overrides in `.ai-context/skills/` (later entries win).

**Engine.** `SpecOpsEngine` (`src/core/specOps.ts`) is a deterministic state machine (`discovery → synthesizing → draft → refining → approved`) that tracks per-field coverage and a turn budget, and validates the prompt-schema **actions** the LLM returns each turn (`ask` / `ask_many` / `synthesize` / `done`). No native tool-calling is used — actions are JSON, validated deterministically, so the loop works on Copilot's `vscode.lm` and the Claude Code CLI as well as OpenAI/Anthropic/Ollama.

**Loop.** `AgentHub.discoverNextAction` renders the discovery prompt (`specOpsPrompts.ts`) and returns a validated action. The webview renders a single question as a chat bubble or a batch (`ask_many` with 2+) as a dynamic multi-field intake form (`specQuestions` / `submitSpecAnswers`). When coverage is complete or the turn budget is exhausted, `AgentHub.synthesizeComprehensiveSpec` assembles the comprehensive v2 spec (business requirements, data flows, transformations, dependencies, acceptance criteria, implementation considerations, source catalog) with per-field provenance, which is persisted by `SpecManager` and shown in the review card.

### 2.9 Revising an approved specification

**Implemented (v0.9.0, Phase A).** An approved spec is never mutated in place — every revision runs through the *same* SpecOps engine used for a brand-new spec, seeded with the approved content, and always produces a new draft `version + 1` that must be reviewed and re-approved.

**Entry points.**
- Spec card "↻ Revise" → webview posts `startRevision` → `DataAgentHubWebviewProvider` sets a one-shot `pendingRevision` flag (only when the current spec's `status === 'approved'`; a draft spec doesn't need it — its next message already revises in place, unchanged).
- The next `chat` message, while `pendingRevision` is set, calls `handleSpecDiscovery(message, previousSpec)` instead of `hub.chat()` — same function the fresh-discovery path uses, now revision-aware via an optional second argument.
- `/spec <change>` while the spec is `approved` routes through the same path (`case 'refineSpec'` in `webviewProvider.ts`) rather than the older single-shot `reviseSpec()`/`generateSpec()`, closing a second entry point into the same bug (see below).

**Session seeding (`createIntakeSession`, `src/core/specOps.ts`).** When `previousSpec` is supplied: the `problemStatement` argument is reinterpreted as `changeRequest`; the session's own `problemStatement` falls back to the previous spec's; `specId` is set from the previous spec. Coverage still starts all-`'missing'` (deliberately — see rationale below), so the LLM, not a coverage shortcut, decides how much to ask.

**Prompt visibility (`specOpsPrompts.ts`).** `renderSpecSnapshot(spec)` renders a compact textual snapshot of every populated field. `buildDiscoveryTurnPrompt`/`buildSynthesisPrompt` prepend it (plus the change request) when `session.previousSpec` is set, and append extra system-prompt rules (`REVISION_DISCOVERY_RULES` / `REVISION_SYNTHESIS_RULES`): only ask about what the change affects or what's still empty; the synthesis output must be the **full** spec, carrying forward everything untouched. Both prompt builders also accept an optional `extraContext` string — `AgentHub.discoverNextAction`/`synthesizeComprehensiveSpec` thread through `ContextFileManager.buildContextPrompt()` (registered sources) and `session.attachments` (ad-hoc files, see below) automatically.

*Why coverage isn't pre-seeded from the previous spec:* `SpecOpsEngine.shouldSynthesize()` treats "no field is `'missing'`" as license to skip straight to synthesis without ever asking the LLM. Seeding every populated field as `'partial'`/`'complete'` at session creation would trip that circuit-breaker on the very first turn, skipping discovery entirely. The turn-budget/coverage map stays a deterministic safety net; the *actual* "don't re-ask what's unchanged" behavior is a prompt instruction the LLM (already trusted to decide ask-vs-synthesize each turn) follows.

**Field-preservation safety net (`parseComprehensiveSpec`, `src/core/specSynthesis.ts`).** Independent of whether the prompt instruction is followed: every optional array/string field falls back to the previous spec's value when the new synthesis output leaves it empty (`orFallback`); the three required fields (`problemStatement`, `objectives`, `scope.in`) fall back the same way *before* their empty-value validation throws, so an under-specified revision turn can't spuriously fail. `buildProvenance` carries forward a field's *original* provenance entry (question id / skill) when the current session didn't address it, rather than relabeling it `'synthesis'`.

**Supplementary information.** A 📎 button next to the chat input posts `attachSpecFile`; the extension host shows `vscode.window.showOpenDialog`, reads the picked file via `vscode.workspace.fs` (capped at 200,000 bytes), and calls `SpecOpsEngine.addAttachment({path, content, attachedAt})` — rendered by both prompt builders as "Attached reference material." Works for any active `SpecOpsEngine` session (fresh discovery or revision), not revision-only.

**Known gaps (tracked in `requirements.md` §16.5):** `IntakeSession` (including the new `previousSpec`/`changeRequest`/`attachments` fields) is still in-memory only — lost on reload. The emergency fallback on a comprehensive-synthesis failure still re-drafts via the older v1-only `generateSpec`, which doesn't carry v2 fields.

### 2.10 Versioning & governance (Phase B, v0.9.0)

**Design choice:** lean on git as the version/audit log rather than build a parallel in-app version store — `.ai-context/spec/` is already meant to be committed, so a second source of version truth would only drift from it.

- **`src/context/ArtifactWriter.ts`** now writes every spec-stamped artifact under a `<specId>.v<version>` folder (`ArtifactWriter.specTag(artifact)`), inserted **above** the artifact's own relative path — so a multi-file artifact (e.g. the dbt scaffold) keeps every filename a tool like dbt expects (`dbt_project.yml` stays `dbt_project.yml`); only a folder is added, never a filename prefix. Artifacts with no `specId` (legacy pre-Phase-B writes, or generated with no spec set) land directly under the phase directory as before.
- **`src/context/ArtifactStalenessScanner.ts`** (`scanArtifactStaleness(workspaceRoot, currentSpec?)`) walks `.ai-context/artifacts/<phase>/*`, recognizes `<specId>.v<version>` folder names via regex, and classifies each as `current` (matches the approved spec's id+version), `stale` (same id, older version), or `unknown-spec` (different id, or no spec currently approved). Files sitting directly under a phase dir (no version folder) are counted separately as `untaggedFileCount` — this is *why* the folder scheme exists: `PlanState.artifacts` (which also carries `specId`/`specVersion`) is in-memory only and gone after a reload, so the filesystem path is the only durable record.
- **UI:** opening the Workflow Palette posts `checkArtifactStaleness`; the response renders a small "Generated Artifacts" section above the phase rows — a warning banner + list for `stale` groups, a quiet green line per `current` group, and a note for untagged/unknown files. Nothing is deleted or regenerated automatically.
- **"🕓 History"** on the spec card posts `viewSpecHistory` → `git log --follow -p -- <spec path>` (via `child_process.execFile`, `cwd` = workspace root) rendered as a chat message. Not a git repo, or no history yet → a clear message, not a crash.

### 2.11 Chat Sessions & Lifecycle (Phase F, v0.9.0)

**Design choice:** chat session identity is deliberately independent of BPS identity (confirmed via clarifying question) — a session can span several specs, and a spec can be discussed across several sessions, so `ChatSessionMeta.specId`/`specVersion` are a breadcrumb recorded at creation time, not a live foreign key kept in sync.

**`ChatSessionManager` (`src/context/ChatSessionManager.ts`).** One class, mirrors the rest of `src/context/`'s pattern (atomic metadata writes, one class per concern):
- `.ai-context/chats/<id>.meta.json` — `{ id, createdAt, updatedAt, status: 'active'|'archived'|'discarded', specId?, specVersion?, llmProvider?, title? }`, written via the same temp-file→`rename` pattern as `SpecManager`/`SourceRegistry`.
- `.ai-context/chats/<id>.jsonl` — one `ChatMessage` (`{ role: 'user'|'ai'|'log', content, at }`) per line. `vscode.workspace.fs` has no append primitive, so `appendMessage` is read-modify-write (whole file re-read, message appended, whole file rewritten) — an accepted cost at realistic chat lengths rather than an engineered-around one.
- Exactly one session is `status: 'active'` at a time; `getActiveSession()` is `listSessions().find(s => s.status === 'active')`.
- Gitignored (`.ai-context/chats/`) — unlike the committed BPS, transcripts are local/exploratory by explicit decision.

**`webviewProvider.ts` wiring.**
- On `resolveWebviewView()`, after the spec manager initializes: construct `ChatSessionManager`, `initialize()`, `getActiveSession()` or `createSession()` if none exists, load its transcript. **Changed in v0.13.0:** if that transcript is non-empty, the session is folded (`startNewChat()` — archived, never discarded, and a fresh empty one takes its place) rather than posted as-is; only an empty session is posted directly via `chatSessionLoaded` (`{ meta, transcript }`). A reload/restart therefore never silently resumes a prior conversation into view — see §8a.4 of `requirements.md`.
- `postMessage()` now also calls `recordAssistantMessage(type, payload)`, which maps the handful of assistant-facing message types (`chatResponse`, `specDrafted`, `specApproved`, `specQuestion`, `specQuestions`) to a `ChatMessage` and appends it to the active session — chat persistence is a side effect of the existing post path, not a parallel code path callers have to remember to invoke. User messages are appended directly at the `case 'chat'` / `case 'submitSpecAnswers'` handlers.
- New message cases: `newChat` → `startNewChat()`; `listChatSessions` → posts `chatSessionsList`; `openChatSession` → **(v0.13.0, changed from a read-only viewer)** archives whatever's currently active, reactivates the chosen session (`ChatSessionManager.updateMeta(chatId, {status:'active'})`), and posts `chatSessionLoaded` with its transcript — a real resume, not a preview; `discardChat` → `ChatSessionManager.discardSession` after the caller's own confirmation.
- `startNewChat()`: if a `SpecOpsEngine` interview is in flight, calls `carryOverPartialInterview()` first, then tears down the engine; archives the current session (`archiveSession`, never a delete); creates a new one seeded with the current spec's id/version and the active LLM provider; posts `chatSessionLoaded` with an empty transcript. Now also called from the startup-fold path above, not just the "🗨 New Chat" action.
- `carryOverPartialInterview(session, workspaceRoot)`: implements the exact behavior specified by the user in response to a clarifying question that rejected three alternative designs (resume as live Q&A / block New Chat / silently discard). Renders the session's collected `answers`/`insights` as Markdown, writes it to `.ai-context/chats/carryover/<sessionId>.md`, registers it via `SourceRegistry.addSource(..., 'business_context', 'autode')`, and runs `SynthesisPipeline.synthesize()` so the partial answers become graph nodes *before* the interview state is discarded. A no-op if the session collected nothing.

**Sidebar (`media/sidebar.html`).**
- "🗨 New Chat" topbar icon → `post('newChat')` (after `endPending()`, so an in-flight pending bubble doesn't leak into the new session's rendering).
- **New in v0.13.0:** "🕓" Chat History topbar icon, next to New Chat — opens a dropdown (`#chatHistoryDropdown`, styled like the `@mention` dropdown) populated by `listChatSessions`/`chatSessionsList`; clicking a row `post('openChatSession', {chatId})` to resume it. This is the "on need basis" counterpart to the startup fold.
- `case 'chatSessionLoaded': loadChatSession(msg.meta, msg.transcript)` — clears `chatStream`, resets client-side session flags (`discoveryActive`, `discoveryProgress`, `revisionArmed`, any pending bubble), shows the welcome block for an empty transcript, otherwise replays each `ChatMessage` through the existing `addMessage()`/`addLogEntry()` renderers keyed on `role`. Also now re-renders the Workflow Palette's spec section, so a stale "discovery in progress" view from a just-folded session doesn't linger.
- `case 'chatSessionsList': renderChatHistoryDropdown(msg.sessions, msg.activeChatId)` — new in v0.13.0. `chatSessionViewed` (the old read-only-preview response) is retired along with `openChatSession`'s old semantics; nothing posts or handles it anymore.

**Command Palette (`src/extension.ts`).** `AutoDE: New Chat` (`triggerNewChat()`), `AutoDE: Chat History` (`QuickPick` over `listSessions()`, opens the selected transcript read-only via `vscode.workspace.openTextDocument` — unchanged; this remains a read-only peek, distinct from the sidebar's new resume-capable picker above), `AutoDE: Discard Chat` (`QuickPick` + a modal `vscode.window.showWarningMessage` confirmation before `discardSession()` — irreversible, only ever behind this two-step flow).

**Explicitly deferred (see `requirements.md` §16.7):** a "distill this chat" Context Memory curation pass (LLM extraction of a transcript into graph nodes with `origin.source: 'chat'` provenance) is a separate concern from session persistence and has not been built; a fuller in-sidebar chat browser (search/tag/export/reopen) was scoped out of this pass, with the message-handling plumbing already in place for it.

### 2.12 Context Sync, Implementation Type & Plan Persistence (v0.10.0)

**Design choice:** reuse existing machinery rather than build parallel systems — spec→context sync reuses `SynthesisPipeline`/`GraphManager` (already built for registered-source ingestion), implementation-type classification reuses the deterministic keyword-evidence pattern `phaseInference.ts` already established, and plan persistence reuses `SpecManager`'s exact atomic-write-plus-history shape.

- **Context sync (closes the gap where nothing fed the approved spec's own content into the Context Layer).** `SynthesisPipeline.synthesizeFromSpec(spec)` maps `objectives`/`businessRequirements`/`dependencies` to `business_term` nodes and `constraints`/`assumptions` to `business_rule` nodes (STRICT / RECOMMENDED respectively), each stamped with `Origin.specId`/`specVersion`. It first calls `GraphManager.removeNodesBySourceRef('spec:' + spec.id)` so re-synthesizing on a later revision **replaces** the prior version's derived nodes rather than accumulating stale ones alongside them. Runs automatically inside the `approveSpec` handler — before `generatePlanFromSpec` is ever reachable — so the Context Layer is always current for the spec version a plan is about to be generated from. A durable, human-readable record is also written to `.ai-context/context/snapshots/<specId>.v<version>.md` (committed, unlike the transient `.ai-context/derived/graph.json`), capturing exactly what fed plan generation for that spec version.
- **`generatePlan`'s prompt now actually reads the Context Layer.** Previously only `chat`, `discoverNextAction`, and `synthesizeComprehensiveSpec` merged in `contextFileManager.buildContextPrompt()`; the `generatePlan` webview case passed the caller's raw (usually empty) `schemaContext` straight through. It now merges `buildContextPrompt()` the same way `chat` does, and `generatePlanFromSpec` does the same before delegating to `generatePlan`.
- **Implementation type (`src/core/implementationType.ts`).** `classifyImplementationType(spec)` scans the same spec-text corpus `phaseInference.ts` uses for keyword evidence of existing-system language (`existing`, `legacy`, `migrate`, `as-is`, …) vs. new-build language (`greenfield`, `from scratch`, `net new`, …); mixed evidence defaults to `brownfield` (the higher-risk assumption), no evidence defaults to `greenfield`. Computed at every spec draft/revision/synthesis point (`webviewProvider.applyImplementationType`), unless the user has explicitly overridden it (`setImplementationType` message → `implementationTypeOverridden: true`, preserved across later revisions rather than silently reclassified). Surfaced as a badge with a one-click flip in both the chat spec card and the Workflow Palette.
- **Phase applicability now considers implementation type and context.** `inferPhases(spec, implementationType?, contextSummary?)` — both new parameters are optional so existing callers are unaffected. A `brownfield` classification forces `discover` required by default (existing systems need assessment even absent explicit spec language) unless `scope.out` explicitly excludes it, which still wins. Note the **`unrequired` `PhaseStatus`** (§2.5) already *is* the Non-Applicable state the palette renders (dimmed, "⊘ Non-Applicable", with its `reason` string) — this section only widens what feeds the classification, it does not introduce a new status.
- **Plan persistence (`src/context/PlanManager.ts`).** Mirrors `SpecManager` exactly: atomic writes to `.ai-context/plan/plan.yaml`, every version-on-change archived to `plan/history/plan.v<n>.<status>.yaml`, restored into `AgentHub`'s in-memory `PlanState` on extension activation (`hub.loadPersistedPlan`) so the generated steps, inferred phases, status, and implementation type survive a VS Code reload — previously `PlanState` had no on-disk representation at all. `PlanState.artifacts` (execution-produced `GeneratedArtifact[]`) is **not** part of the persisted shape and remains in-memory-only, per §2.10's existing rationale for the artifact-folder spec-tagging scheme.
- **Artifact-level version history.** `ArtifactWriter.write()` now archives whatever previously sat at a given path to a `history/` subfolder before overwriting it, so re-running a step within the *same* `<specId>.v<version>` folder no longer silently discards the prior output — only cross-version staleness was tracked before (§2.10).

---

## 3. UI Architecture

### 2.1 Layout: Single-Column, Section-Based

The UI uses a single scrollable workspace with distinct sections. A thin, icon-based top bar provides quick navigation and status at a glance.

```
┌─────────────────────────────────┐
│ TOP STATUS BAR                  │  ← Provider, model, token usage, context stats
├─────────────────────────────────┤
│                                 │
│  CHAT / CONVERSATION STREAM     │  ← Primary interaction area
│  (scrollable)                   │
│    - User messages              │
│    - AI responses               │
│    - Embedded plan artifacts    │
│    - Execution progress cards   │
│    - Context assembly previews  │
│                                 │
├─────────────────────────────────┤
│  CONTEXT ASSEMBLY DRAWER        │  ← Collapsible: shows what context
│  (expandable)                   │     will be sent with next prompt
├─────────────────────────────────┤
│  CHAT INPUT + ACTION BAR        │  ← Message input, Send, Plan, Execute
└─────────────────────────────────┘
```

### 2.2 Top Status Bar

| Element | ID | Description |
|---------|-----|-------------|
| **Provider pill** | `providerPill` | Shows active LLM (e.g., "Copilot" or "Claude" with green dot). Clicking opens LLM settings. |
| **Connection pill** | `connPill` | Shows data platform connection status. Clicking opens connection settings. |
| **Context meter** | `ctxMetric` | Token/entity counter with mini progress bar. Clicking expands context drawer. |
| **Plan status** | `planMetric` | Shows plan step count and execution status. |
| **Refresh button** | `refreshBtn` | Triggers context re-index. |
| **Stop button** | `stopBtn` | Stops plan execution. |
| **Settings button** | `settingsBtn` | Opens slide-out settings panel. |
| **Workflow palette** | `paletteBtn` | (Phase 3a) Opens workflow palette. |

### 2.3 Chat Stream

The chat stream is the primary interaction surface. Every interaction — planning, execution, context queries — flows through this stream.

#### Message Types

| Type | CSS Class | Alignment | Description |
|------|-----------|-----------|-------------|
| User message | `.message.user` | Right | User's objective or follow-up. Accent-tinted background. |
| AI text response | `.message.ai` | Left | Markdown-rendered response with syntax-highlighted code blocks. |
| Plan artifact | `.plan-card` | Full-width | Interactive card with collapsible steps, timeline, and action buttons. |
| Context preview | `.ctx-preview` | Full-width | Collapsible block showing what context was used for a response. |
| Log entry | `.message.ai` (dimmed) | Left | System log messages at reduced opacity. Suppressed while a pending bubble is active — see below — routed into it instead. |
| Pending bubble | `.message.ai.pending` | Left | **Phase E, v0.9.0.** One per in-flight chat-initiated request (`beginPending()`/`updatePending()`/`endPending()` in `sidebar.html`). Animated `.typing-dots` + a `.pending-text` span updated in place by `logEntry` messages that arrive while it's active, removed by the terminal response (`chatResponse`, `specDrafted`, `specQuestion(s)`, `planUpdated`, `error`). Opening text is picked by `pendingLabelForChat()` from client-side state (`currentSpec`, `discoveryActive`, `revisionArmed`) — not a fixed string. `sendBtn` is disabled for the duration. |

#### Plan Card Structure

```
┌──────────────────────────────────────────────┐
│ 📋 EXECUTION PLAN                    [▼] [×] │
│                                              │
│ ○────●────◐────○  (execution timeline)       │
│                                              │
│ Step 1  ✅  Extract raw events from S3       │
│   Agent: ingestionAgent    Duration: 2.3s    │
│   └─ (expandable detail)                     │
│                                              │
│ Step 2  ⏳  Validate schema & null checks     │
│   Agent: sttmAgent         Depends on: Step 1│
│                                              │
│ [▶ Execute All]  [⏸ Pause]  [↻ Re-plan]     │
└──────────────────────────────────────────────┘
```

### 2.4 Context Drawer

A persistent, collapsible panel between the chat stream and input area:

- **Collapsed state**: 32px header showing summary stats
- **Expanded state**: Up to 260px showing entity chips organized by category
- **Categories**: Database Metadata, Business Context, Verified Queries
- **Chips**: Clickable pill-shaped elements that insert `@entityname` into the chat input
- **Actions**: Re-index button, Open .ai-context folder button

### 2.5 Slide-Out Settings Panel

Accessible via the ⚙ icon. Slides in from the right with a semi-transparent overlay.

**Inner tabs:**
- 🤖 **LLM Provider**: Card-based selection (Copilot, Claude Code, OpenAI, Anthropic, Azure OpenAI, Gemini, Ollama). Selecting a card auto-saves `activeLlmProvider` and updates the header pill immediately. The Copilot (`vscode.lm`) and Claude Code (CLI) cards are both no-API-key and share a consent toggle (auto-saves `languageModelProgrammaticConsent`); each card's **Test** button tests *that* provider regardless of which is active. Copilot adds Handoff; Claude Code adds a Detect button and an optional CLI-path field.
- 🔌 **Connections**: Platform cards (Snowflake, Databricks, BigQuery, Redshift, Synapse) with credential fields, Connect button, and Source Assessment button.
- ⚙ **Preferences**: Read-only mode, auto-documentation, telemetry, cache duration, query timeout.

### 2.6 Workflow Palette (Phase 3a)

Accessible via a 🧰 icon. Phase-organized action cards:

| Phase | Agents |
|-------|--------|
| 🔍 **Discover** | Source Assessment, Data Lineage, Quality Profiler, Current-State Architecture |
| 🎨 **Model** | STTM Mapper, Data Modeler, Business Glossary |
| 🔨 **Build** | Ingestion Pipeline, Transform Scaffold, DDL Generator, Orchestration |
| ✅ **Validate & Document** | SQL Validator, Test Generator, Documentation, Future-State Architecture |

Each card shows: icon, name, description, `[▶ Run]` button. Cards are disabled if prerequisites aren't met.

### 2.7 @-Mention System

Typing `@` in the chat input triggers an autocomplete dropdown populated from the context layer:

- `@orders` → resolves to `RAW_DB.PUBLIC.ORDERS`
- `@MRR` → resolves to the business term definition
- `@daily_active_users` → inserts the reference SQL

### 2.8 Slash Commands

| Command | Action |
|---------|--------|
| `/plan` | Generate execution plan |
| `/execute` | Execute current plan |
| `/context` | Expand context drawer |
| `/connect` | Open connection settings |
| `/settings` | Open settings panel |
| `/sync` | Sync database metadata |
| `/reindex` | Rebuild context index |
| `/clear` | Reset session |
| `/export` | Export plan (future) |

### 2.9 CSS Design System

All colors use VS Code theme CSS variables for native look and feel:

| Token | Usage |
|-------|-------|
| `--vscode-editor-background` | Main background |
| `--vscode-sideBar-background` | Cards, input areas, panels |
| `--vscode-panel-border` | Subtle separators |
| `--vscode-button-background` | Primary actions, accent elements |
| `--vscode-foreground` | Primary text |
| `--vscode-descriptionForeground` | Secondary text, labels |

**Semantic colors:**
- Success: `#2ea043` (green) — connected, completed, passed
- Warning: `#d29922` (amber) — pending, degraded, needs attention
- Error: `#f85149` (red) — failed, disconnected, error
- Info: `#58a6ff` (blue) — informational, links

**Spacing scale:** 4px base unit → 4, 8, 12, 16, 20px
**Border radius:** 4px (small), 6px (standard), 8px (cards), 999px (pills/chips)
**Font sizes:** 11px (captions), 12px (body), 13px (headings), 14px (icons)
**Transitions:** 120ms (fast), 200ms (normal), 300ms (slow)

---

## 4. Context Layer

### 3.1 Knowledge Graph (GraphManager)

**File:** `src/context/GraphManager.ts`

Thread-safe in-memory graph using maps and indexes:

| Feature | Implementation |
|---------|---------------|
| Node storage | `Map<string, BaseNode>` |
| Edge storage | `Map<string, GraphEdge>` |
| FQN index | `Map<string, string>` (fqn → nodeId) |
| Label index | `Map<string, Set<string>>` (label → nodeIds) |
| Type index | `Map<string, Set<string>>` (type → nodeIds) |
| Concurrency | Simple mutex (`Promise` chain) |
| Serialization | `serializeSnapshot()` / `loadSnapshot()` for worker transfer |
| Traversal | BFS with decay factor: `Relevance = SeedScore × (DecayFactor)^(HopDistance)` |
| Lifecycle | Implements `vscode.Disposable` |

#### Node Types

| Type | Interface | Description |
|------|-----------|-------------|
| `table` | `TableNode` | Database table with FQN, database, schema |
| `column` | `ColumnNode` | Table column with data type, nullability, PK/FK flags |
| `semantic_view` | `TableNode` (isView=true) | Database view |
| `business_term` | `BusinessTermNode` | Business glossary term with optional formula |
| `business_rule` | `BusinessRuleNode` | Rule with STRICT/RECOMMENDED enforcement |
| `verified_query` | `VerifiedQueryNode` | Reference SQL with dialect and table references |

#### Edge Types

| Type | Description |
|------|-------------|
| `contains` | Table → Column |
| `foreign_key` | Table → Table |
| `maps_to` | Business Term → Table |
| `uses_table` | Verified Query → Table |
| `constrained_by` | Business Rule → Table |

### 3.2 ContextFileManager

**File:** `src/context/ContextFileManager.ts`

Manages the `.ai-context/` directory:

| Feature | Implementation |
|---------|---------------|
| File watching | `vscode.workspace.createFileSystemWatcher` with 300ms debounce |
| YAML parsing | Custom lightweight parser (no external dependency) |
| Business context | Parses `business-context.yaml` → BusinessTermNode + BusinessRuleNode |
| Verified queries | Parses `verified-queries.yaml` → VerifiedQueryNode |
| Schema graph | Loads `schema-graph.json` snapshots |
| Mentionable entities | `getMentionableEntities()` returns all tables, terms, queries for @-mention |
| Context stats | `getContextStats()` returns counts + token estimates |
| Prompt assembly | `buildContextPrompt()` formats Markdown context block for LLM prompts |
| Lifecycle | Implements `vscode.Disposable` |

#### .ai-context/ Directory Layout

```
.ai-context/
├── schema-graph.json          # Generated: serialized knowledge graph
├── schema-graph.schema.json   # JSON Schema for validation
├── business-context.yaml      # Human-curated: business terms + rules
├── verified-queries.yaml      # Human-curated: reference SQL queries
├── sttm-mapping.yaml          # Generated: source-to-target mappings
└── architecture.md            # Generated: architecture documentation
```

### 3.3 Context Retrieval & Prompt Assembly

The `buildContextPrompt()` method formats context as compact Markdown:

```
## Enterprise Context Layer

### Business Rules (STRICT)
- **Rule name**: Rule text

### Database Tables
- `DB.SCHEMA.TABLE` — Description

### Business Terms
- **Term Name** (formula: ...): Description

### Verified SQL Queries
- **Query Name** (dialect)
```

Token budget enforcement and pruning will be implemented in a future `ContextRetriever` module.

---

## 5. Multi-Platform Adapter Architecture

### 4.1 Design Rationale

Different data platforms have fundamentally different:
- **Metadata tables**: Snowflake's `INFORMATION_SCHEMA` vs Databricks' `system.information_schema` vs BigQuery's region-qualified `INFORMATION_SCHEMA`
- **SQL dialects**: Snowflake SQL vs Spark SQL vs GoogleSQL vs T-SQL
- **Authentication**: Key-pair, OAuth, tokens, service accounts, external browser
- **Capabilities**: Column profiling, lineage extraction, CDC, streaming

The adapter pattern isolates these differences behind a common interface, so sub-agents never need platform-specific code.

### 4.2 IDataSourceAdapter Interface

```typescript
interface IDataSourceAdapter {
  connect(credentials: Record<string, string>): Promise<ConnectionInfo>;
  disconnect(): Promise<void>;
  extractMetadata(options?: ExtractOptions): Promise<SchemaSnapshot>;
  executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult>;
  getCapabilities(): PlatformCapabilities;
  translateDialect(sql: string, target: SqlDialect): string;
  getMetadataQueries(): PlatformMetadataQueries;
  persistSchemaContext(snapshot: SchemaSnapshot, uri: vscode.Uri): Promise<void>;
}
```

### 4.3 BaseDataSourceAdapter (Abstract Class)

**File:** `src/dqm/BaseAdapter.ts`

Provides:
- Common `extractMetadata()` orchestration (tables → columns → FKs → profiling)
- `snapshotToGraph()` conversion (SchemaSnapshot → knowledge graph nodes/edges)
- Atomic `persistSchemaContext()` (temp file → rename)
- Abstract methods that each platform adapter must implement

### 4.4 Platform-Specific Adapters

#### SnowflakeAdapter (`src/dqm/adapters/SnowflakeAdapter.ts`)

| Aspect | Detail |
|--------|--------|
| Metadata | `INFORMATION_SCHEMA.TABLES`, `.COLUMNS`, `.REFERENTIAL_CONSTRAINTS`, `.VIEWS` |
| Lineage | `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` (optional) |
| Profiling | Per-column `COUNT(DISTINCT)`, null count, `MIN`, `MAX` |
| Auth | Key-pair, OAuth, username/password, external browser, MCP |
| Capabilities | metadata ✓, profiling ✓, lineage ✓, CDC ✓, streaming ✓, DDL ✓ |
| Dialect | Snowflake SQL (native) |

#### DatabricksAdapter (`src/dqm/adapters/DatabricksAdapter.ts`)

| Aspect | Detail |
|--------|--------|
| Metadata | `system.information_schema.tables`, `.columns`, `.key_column_usage` |
| Profiling | `COUNT(DISTINCT)`, null count, `MIN`, `MAX` via Spark SQL |
| Auth | OAuth, personal access token |
| Capabilities | metadata ✓, profiling ✓, lineage ✗, CDC ✓ (Delta CDF), streaming ✓ |
| Dialect | Spark SQL — translates `UUID_STRING()` → `uuid()`, `ILIKE` → `lower() LIKE lower()` |

#### Future Adapters

| Adapter | Metadata Source | Key Differences |
|---------|----------------|-----------------|
| BigQuery | `region-us.INFORMATION_SCHEMA` | Region-qualified, different column types |
| Redshift | `PG_CATALOG` + `SVV_*` tables | PostgreSQL-based, different system tables |
| Synapse | `sys.tables`, `sys.columns` | T-SQL dialect, dedicated SQL pool vs serverless |

### 4.5 ConnectionManager

**File:** `src/dqm/ConnectionManager.ts`

| Method | Description |
|--------|-------------|
| `connect(platform, credentials)` | Disconnect existing, instantiate correct adapter, connect |
| `getActiveAdapter()` | Return current adapter or null |
| `extractMetadata(options?)` | Delegate to active adapter |
| `executeQuery(sql)` | Delegate to active adapter |
| `getCapabilities()` | Return active adapter's capabilities |
| `dispose()` | Disconnect and clean up |

Uses a `Map<DataPlatformProvider, AdapterFactory>` for adapter registration.

### 4.6 Type Definitions

**File:** `src/dqm/types.ts`

| Type | Purpose |
|------|---------|
| `PlatformCapabilities` | Boolean flags for metadata, profiling, lineage, CDC, streaming, DDL |
| `SqlDialect` | `'snowflake' \| 'spark_sql' \| 'google_sql' \| 'postgres' \| 'tsql' \| 'ansi'` |
| `ConnectionInfo` | Status, platform, database, schema, version, capabilities |
| `SchemaSnapshot` | Tables, views, columns, foreign keys, lineage edges |
| `TableMetadata` | FQN, type, row count, size, columns, comment |
| `ColumnMetadata` | Name, data type, nullability, PK/FK, ordinal, profile |
| `ColumnProfile` | Distinct count, null count, min/max, avg length |
| `ForeignKeyMetadata` | Source table/column → target table/column |
| `LineageEdge` | Column-level lineage with transform description |
| `PlatformMetadataQueries` | SQL query templates for metadata extraction |
| `QueryResult` | Columns, rows, row count, execution time |

---

## 4.7 Target Environment Configuration (Phase 3b)

### 4.7.1 Design Rationale

Data engineering workflows are inherently source→target. The source is discovered via the adapter layer (Phase 3a), but the target stack — platform, modeling approach, transformation tool, orchestration tool — must be defined by the user and maintained as a stable internal structure that all sub-agents can reference.

### 4.7.2 TargetEnvironment Type

```typescript
interface TargetEnvironment {
  platform: DataPlatformProvider;
  environmentProfile: 'development' | 'staging' | 'production';
  modelingApproach: 'dimensional' | 'data-vault' | 'obt' | '3nf' | 'raw-pass-through';
  namingConvention: 'snake_case' | 'camelCase' | 'PascalCase';
  transformationTool: 'dbt' | 'sqlmesh' | 'custom-sql' | 'stored-procedures' | 'none';
  orchestrationTool: 'airflow' | 'dagster' | 'prefect' | 'dbt-cloud' | 'manual' | 'none';
  outputFormats: ('ddl' | 'yaml' | 'markdown' | 'python' | 'sql')[];
  platformConfig: SnowflakeTargetConfig | DatabricksTargetConfig | BigQueryTargetConfig;
}
```

### 4.7.3 Profile-Based Configuration

Target environments support multiple profiles (dev/staging/prod) with inheritance:

```yaml
# .ai-context/target-environment.yaml
profiles:
  base:
    platform: snowflake
    modelingApproach: dimensional
    transformationTool: dbt
    orchestrationTool: airflow
  development:
    inherits: base
    platformConfig:
      database: DEV_DB
      schema: DEV_ANALYTICS
  production:
    inherits: base
    platformConfig:
      database: PROD_DB
      schema: ANALYTICS
      warehouse: WH_L
```

### 4.7.4 Target Extraction

The orchestrator uses a dedicated LLM call to extract target stack details from user messages. If critical fields are missing, it prompts the user for clarification. Once extracted, the target config is persisted to `.ai-context/target-environment.yaml` and injected into all sub-agent execution contexts.

### 4.7.5 Target-Aware Prompt Assembly

Plan prompts now separate source and target context:

```
## Source Environment
Platform: Snowflake (RAW_DB.PUBLIC)
Tables: orders, customers, products (15 total)

## Target Environment
Platform: Snowflake (CURATED_DB.ANALYTICS)
Transformation: dbt (dimensional modeling)
Orchestration: Airflow
Naming: snake_case
Output: DDL, YAML, Markdown
```

### 4.7.6 Files

| File | Purpose |
|------|---------|
| `src/core/types.ts` | `TargetEnvironment`, `TargetProfile`, `TargetConfigFile`, `GeneratedArtifact` types |
| `src/context/TargetConfigManager.ts` | Read/write/validate `target-environment.yaml` with profile inheritance |
| `src/core/agentHub.ts` | `extractTargetFromMessage()`, `buildTargetFromPartial()`, target-aware prompt assembly |
| `src/agents/build/IngestionPipelineAgent.ts` | Uses `targetEnvironment` for target-side DDL |
| `src/agents/model/SttmMapperAgent.ts` | Uses `targetEnvironment` for mapping output |
| `src/agents/validate/DocumentationAgent.ts` | Uses `targetEnvironment` for architecture docs |

---

## 6. Agent Orchestration

### 5.1 Orchestrating Agent (DataAgentHubHub)

**File:** `src/core/agentHub.ts`

The orchestrating agent is the central coordinator:

| Responsibility | Implementation |
|----------------|---------------|
| Intent understanding | LLM call with system prompt + context |
| Task decomposition | `buildPlanPrompt()` → LLM → `validatePlanResponse()` |
| Sub-agent routing | `AGENT_EXECUTORS` map: `AgentType → executor function` |
| Dependency resolution | DAG-based execution with `dependsOn` arrays |
| State management | `PlanState` with steps, status, runningStepId |
| Failure recovery | `handleFailure()` with re-plan option |
| Context injection | Passes schema context to LLM prompts |

### 5.2 Sub-Agent Catalog

#### Phase: Discover (Source-Side)

| Agent | Type Key | Description | Status |
|-------|----------|-------------|--------|
| Source Assessment | `sourceAssessmentAgent` | Extract schema metadata, profile columns, build knowledge graph | Phase 3a |
| Data Lineage Mapper | `lineageMapperAgent` | Trace column-level lineage across views/ETL | Future |
| Data Quality Profiler | `qualityProfilerAgent` | Run configurable quality checks | Future |
| Current-State Architect | `currentStateArchitectAgent` | Generate as-is architecture diagram | Future |

#### Phase: Model (Design)

| Agent | Type Key | Description | Status |
|-------|----------|-------------|--------|
| STTM Mapper | `sttmAgent` | Source-to-target mapping with column-level transformations | Enhanced in 3a |
| Data Modeler | `dataModelerAgent` | Dimensional/Data Vault/OBT model generation | Future |
| Business Glossary Builder | `glossaryBuilderAgent` | Extract/update business terms | Future |

#### Phase: Build (Target-Side)

| Agent | Type Key | Description | Status |
|-------|----------|-------------|--------|
| Ingestion Pipeline | `ingestionAgent` | Generate ingestion code (COPY, Python, Airbyte) | Enhanced in 3a |
| Transformation Scaffolder | `transformScaffoldAgent` | dbt project scaffolding | Future |
| DDL Generator | `ddlGeneratorAgent` | CREATE/ALTER statements | Future |
| Orchestration Generator | `orchestrationAgent` | Airflow/Dagster/Prefect DAGs | Future |

#### Phase: Validate & Document

| Agent | Type Key | Description | Status |
|-------|----------|-------------|--------|
| SQL Validator | `sqlValidatorAgent` | Validate SQL against schema graph | Future |
| Test Generator | `testGeneratorAgent` | dbt tests + custom quality tests | Future |
| Documentation Generator | `architectureAgent` | Data dictionary + architecture docs | Enhanced in 3a |
| Future-State Architect | `futureStateArchitectAgent` | To-be architecture diagram | Future |

### 5.3 Agent Execution Context

All sub-agents receive the same context:

```typescript
interface AgentExecutionContext {
  objective: string;
  schemaContext?: string;
  settings: DataAgentHubSettings;
  configManager: {
    getSecret: (key: string) => Promise<string | undefined>;
    getSettings: () => DataAgentHubSettings;
  };
  log: (message: string) => void;
  // toolSkillAgent-only (Phase D, v0.9.0) — every other executor ignores these:
  workspaceRoot?: string;
  extensionContext?: unknown;   // real vscode.ExtensionContext, cast where needed
  skillId?: string;
  skillInstruction?: string;
}
```

### 5.4 Agent Execution Result

All sub-agents return the same contract:

```typescript
interface AgentExecutionResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
  error?: string;
}
```

### 5.5 Plan Execution Flow

```
User describes objective
        │
        ▼
Orchestrator generates plan (LLM)
        │
        ▼
Plan displayed as interactive card
        │
        ▼
User clicks "Execute All" (or steps run automatically)
        │
        ▼
DAG execution: for each ready step:
  ├── Check dependencies satisfied
  ├── Set step status → 'running'
  ├── Invoke sub-agent via AGENT_EXECUTORS[step.assignedAgent]
  ├── On success: status → 'completed'
  └── On failure: status → 'failed', offer re-plan
        │
        ▼
All steps complete → status → 'completed'
```

### 5.6 Tool-Executing Skills (`toolSkillAgent`, Phase D, v0.9.0)

Two loops, nested, not parallel — the design settled on during the architecture review. The DAG/orchestrator loop above is **unchanged**; `toolSkillAgent` is one more entry in `AGENT_EXECUTORS` whose internals happen to run a multi-turn agentic conversation instead of a template render, exactly the way `snowflakeExecutor` already does something structurally different (real async DB I/O) without the outer loop needing to know or care:

```
ORCHESTRATOR LOOP (unchanged)
  for each ready step: AGENT_EXECUTORS[step.assignedAgent](step, context)
     ├─ 6 template agents + snowflakeExecutor → plain fn call (unchanged)
     └─ toolSkillAgent (NEW) → runs the loop below, returns ONE
                                AgentExecutionResult, same contract as any other agent
                                     │
                                     ▼ (only for a toolSkillAgent step)
TOOL-USE LOOP (src/agents/build/ToolSkillAgent.ts)
  claude  → Claude Code's own loop, opaque to AutoDE (ClaudeCodeAdapter, toolMode:'full')
  copilot → AutoDE-run: sendRequest(tools) → ToolCallPart → execute (sandboxed,
            approved, audited) → ToolResultPart → sendRequest again → ... (≤12 turns)
```

**Not reachable from the auto-planner.** `toolSkillAgent` is a full `AGENT_EXECUTORS` entry (so `hub.runToolSkill()` can invoke it) but is **excluded** from `VALID_AGENT_TYPES` and the planner's prompt allow-list — `generatePlan()`'s LLM has no visibility into which skills are imported and could hallucinate a `skillId`. The only entry points are `/skill <id> <instruction>` in chat and the `AutoDE: Run Tool Skill` command, both calling `AgentHub.runToolSkill(skillId, instruction)` directly — a one-off step built and executed outside the DAG, not queued into `PlanState.steps`.

**`AgentExecutionContext` gained four fields** for this one agent (every other executor ignores them):
```typescript
interface AgentExecutionContext {
  // ...unchanged fields...
  workspaceRoot?: string;        // sandbox boundary
  extensionContext?: unknown;    // real vscode.ExtensionContext, cast at the one call site that needs it
  skillId?: string;
  skillInstruction?: string;
}
```
`extensionContext` is typed `unknown` in the pure `core/types.ts` deliberately — importing `vscode` there would break the file's no-`vscode`-import rule; `ToolSkillAgent.ts` casts it back. That file is also the **one exception** to "sub-agents import only `core/types`" (§ Extension Guide) — it imports `vscode` and `node:child_process` directly, because it does real file I/O and process spawning, not deterministic templating.

**Import & storage:** `src/core/toolSkills.ts` (pure, mirrors `skillRegistry.ts`'s loading pattern) parses a `SKILL.md` (lenient YAML frontmatter + Markdown body) into a `ToolSkillDefinition`. `AutoDE: Import Tool Skill` copies a user-picked folder into `.ai-context/skills/tool-skills/<id>/`; `loadToolSkillsFromDirectory()` scans that directory at run time (no separate index file).

**Execution paths — see `requirements.md` §9a.2 for the full detail, verified findings, and what was deliberately not built** (native Claude Code plugin loading, per-call approval on the Claude path, and a hard OS-level sandbox on either path are all explicitly out of scope for this pass). In short: `claude` gets Claude Code's own tool loop (one whole-run confirmation, `--permission-mode acceptEdits` — verified against the real CLI to be required and sufficient for Read/Grep/Glob/Edit/Write; Bash unverified); `copilot` gets a real loop AutoDE owns against the documented `vscode.lm` tool-calling API (`LanguageModelChatRequestOptions.tools`, `LanguageModelToolCallPart`/`LanguageModelToolResultPart` — types confirmed against the installed `@types/vscode` before writing code), with true per-call approval + an audit log, but not exercised against a live Copilot session in this environment.

---

## 7. LLM Integration

### 6.0 Adapter Registry (Phase C, v0.9.0)

**Problem this replaced:** adding or changing an LLM provider used to mean editing an if/else chain in `agentHub.callConfiguredLlm` (~90 lines mixing dispatch, consent-gating, and per-provider request shaping) *and* keeping a separate, already-drifted-stale metadata table (`providerRegistry.ts`'s `LLM_PROVIDER_REGISTRY` — still said `claude: 'Claude (VS Code)'` after that provider became the Claude Code CLI) in sync by hand.

**What's there now:**
- **`src/core/llmAdapter.ts`** — the `LlmAdapter` interface (`id`, `displayName`, `requiresApiKey`, `supportsCustomEndpoint`, optional `supportsToolExecution`, and `complete(prompt, opts, ctx)`), the `LlmAdapterContext` interface (the narrow slice of extension-host services an adapter needs — `getSettings`/`getLlmApiKey`/`getExtensionContext`/`getWorkspaceRoot`/`log` — decoupled from `DataAgentHubHub` so adapters are constructible/testable standalone), and the shared `extractJsonText()` helper (moved out of `agentHub.ts`, still used by both the adapters and by `agentHub`'s own JSON-parsing call sites for discovery/synthesis actions).
- **`src/core/llmProviders.ts`** — one small class per provider implementing `LlmAdapter`. `CopilotLlmAdapter`/`ClaudeLlmAdapter` delegate to `languageModelAdapter.ts`/`claudeCodeAdapter.ts` (unchanged internals — this refactor only touched the *dispatch*, not the transports); the five `fetch()`-based providers were moved verbatim out of `agentHub.ts`. `LLM_ADAPTERS: Record<LlmProvider, LlmAdapter>` + `getLlmAdapter(provider)` (falls back to `ollama` for an unrecognized provider — preserving the old chain's implicit default) are the **single source of truth** for "which LLM providers exist."
- **`agentHub.callConfiguredLlm`** is now: resolve settings → `getLlmAdapter(provider).complete(prompt, {model, systemPrompt, justification, allowTools}, this.buildLlmContext())` — a lookup, not a branch. `providerRegistry.ts`'s LLM-facing functions are now thin deprecated wrappers reading `LLM_ADAPTERS` (nothing in `src/` actually calls them — flagged, not removed, in case a future caller wants that shape).
- **Deliberately not done** (per the scoping decision): the UI (`media/sidebar.html`'s hand-authored provider cards), the `package.json` settings-schema enum, and `webviewProvider`'s settings-validation guard were **not** unified into this registry — adding a provider still touches those three by hand (§17.2). Also not attempted: a fully config-driven "describe a new REST provider in JSON, zero code" mechanism — `copilot`/`claude` fundamentally need code (in-process API / subprocess), so a generic template would only cover a subset of providers while adding its own abstraction cost.

### 6.1 Multi-Provider Model

**File:** `src/core/llmProviders.ts` (`LLM_ADAPTERS`), dispatched from `src/core/agentHub.ts` (`callConfiguredLlm`)

| Provider | Key | Implementation |
|----------|-----|---------------|
| GitHub Copilot | `copilot` | VS Code Language Model API via `LanguageModelAdapter` (vendor `copilot`) — no API key |
| Claude Code | `claude` | Spawns the Claude Code CLI headless via `ClaudeCodeAdapter` (`claude -p --output-format json`) — no API key, uses the user's Claude Code login. **Not** `vscode.lm`. |
| OpenAI | `openai` | `fetch()` to `api.openai.com/v1/chat/completions` |
| Anthropic | `anthropic` | `fetch()` to `api.anthropic.com/v1/messages` (direct API key) |
| Azure OpenAI | `azure-openai` | `fetch()` to custom endpoint |
| Google Gemini | `gemini` | `fetch()` to `generativelanguage.googleapis.com` |
| Ollama (Local) | `ollama` | `fetch()` to `localhost:11434/api/chat` |

### 6.2a LanguageModelAdapter (provider `copilot`)

**File:** `src/core/languageModelAdapter.ts` (`src/core/copilotAdapter.ts` = re-export shim; `CopilotAdapter` is a back-compat alias)

| Feature | Implementation |
|---------|---------------|
| Detection | Searches for the `github.copilot-chat` extension |
| Model selection | `vscode.lm.selectChatModels({ vendor: 'copilot' })`; preferred model matched loosely against `activeLlmModel` |
| Consent gate | `languageModelProgrammaticConsent` (legacy `copilotProgrammaticConsent` honored as fallback) |
| Request | `model.sendRequest(messages, { justification })`; system prompt sent as a leading Assistant message |
| Timeout | 30s default / 60s from `callConfiguredLlm` via `Promise.race` |
| Enumerate | `listAll()` → every `vscode.lm` model + vendor (used by `listLanguageModels`) |

### 6.2b ClaudeCodeAdapter (provider `claude`)

**File:** `src/core/claudeCodeAdapter.ts`

| Feature | Implementation |
|---------|---------------|
| CLI discovery | `resolve()`: `claudeCodePath` setting → `claude`/`claude.exe` on `PATH` → `resources/native-binary/claude(.exe)` in the `Anthropic.claude-code` extension. `--version` probe. No hard-coded version. |
| Consent gate | Same as Copilot: `languageModelProgrammaticConsent` (legacy fallback) |
| Request | `spawn(cli, ['-p','--output-format','json', ...])`; prompt piped on **stdin**; `--append-system-prompt <sys>`; `--model <m>` only when `m` matches `/^(claude|sonnet|opus|haiku)/i` |
| Tools | JSON/orchestrator calls: `--tools "" --max-turns 1`. Grounded chat (`allowTools`): `--tools Read Grep Glob --permission-mode default --max-turns 16`, run in the workspace root. Never write/exec tools. |
| Output | Parses the JSON envelope; returns `.result`; treats `is_error` / non-`success` `subtype` as failure |
| Timeout | 90s (no tools) / 180s (tools); subprocess killed on timeout or cancellation |
| Test | `testCall()` → `"Reply with exactly the word: PONG"` |

### 6.3 Chat vs. Plan Routing

| Path | Method | Prompt Style | Response Handling |
|------|--------|-------------|-------------------|
| **Chat** | `hub.chat()` | Conversational assistant | Raw text returned to UI |
| **Plan** | `hub.generatePlan()` | Strict JSON DAG format | Parsed + validated as `PlanStep[]` |

### 6.4 Prompt Engineering

**Chat prompt:**
```
You are AutoDE, an expert data engineering assistant running inside VS Code.
You help users with data engineering tasks including pipeline design, SQL authoring,
schema analysis, data modeling, ETL/ELT workflows, and data platform operations.

Respond conversationally and helpfully. If the user asks you to generate a plan,
suggest they click the "Generate Plan" button or use the /plan command.

{context block}

User message: {message}
```

**Plan prompt** (`AgentHub.buildPlanPrompt`, current as of v0.10.0 — every block below is conditional and omitted when its input is empty):
```
You are an expert data engineering planning assistant. Create a strict execution DAG
for the following objective for the {provider} provider:

## Source Environment
{schemaContext — now includes the Context Layer, merged in by the caller}

## Required workflow phases (inferred from the approved business specification)
{requiredPhases.join(', ')}

Create steps ONLY for the phases listed above. Do not create steps that belong to an unlisted phase.

## Implementation type
Brownfield — this builds on an existing system. Plan steps should account for integrating
with, migrating from, or coexisting with what already exists.
(or, for greenfield: "Greenfield — no existing system to integrate with. Plan steps can
assume a clean build.")

## Target Environment
- Platform: {platform} ({database}.{schema})
- Profile: {environmentProfile}
- Modeling: {modelingApproach}
- Transformation: {transformationTool}
- Orchestration: {orchestrationTool}
- Naming: {namingConvention}
- Outputs: {outputFormats}

Objective: {objective}

Return only a valid JSON array of objects. Each object must include:
{"id":"step-1","assignedAgent":"ingestionAgent","taskDescription":"...",
 "status":"pending","dependsOn":[],"validationRules":["..."]}.

Use only these assignedAgent values: ingestionAgent, sttmAgent, architectureAgent,
snowflakeExecutor, sourceAssessmentAgent, dataModelerAgent, transformScaffoldAgent.
Order the DAG so each step is sequentially dependent. Make sure step ids are unique and
use a dependency list when appropriate. If a step touches Snowflake, use snowflakeExecutor
as the terminal step. Do not include markdown fences, comments, or extra text. This JSON
must be parseable by a strict JSON parser.
```
The returned array is validated by `validatePlanResponse`, which (v0.10.0) also runs a
topological-sort cycle check and rejects any step whose agent maps to a phase outside
`requiredPhases` — both previously deferred to execution time or unenforced entirely (§16 R10 follow-up).

---

## 8. Extension Architecture

### 7.1 Activation & Lifecycle

**File:** `src/extension.ts`

```
activate(context)
  ├── Create ConfigurationManager
  ├── Create DataAgentHubHub (orchestrator)
  ├── Create ConnectionManager (Phase 3a)
  ├── Create DataAgentHubWebviewProvider
  ├── Register commands:
  │   ├── openSidebar
  │   ├── generatePlan
  │   ├── executePlan
  │   ├── resetSession
  │   ├── testLanguageModel  (alias: testCopilot)
  │   ├── listLanguageModelInfo  (alias: listCopilotInfo)
  │   ├── listLanguageModels
  │   ├── debugListExtensions
  │   ├── copilotHandoff
  │   ├── testConnection (Phase 3a)
  │   └── sourceAssessment (Phase 3a)
  └── Register webview view provider

deactivate()
  └── (cleanup handled by disposables)
```

### 7.2 WebviewProvider Message Protocol

**File:** `src/core/webviewProvider.ts`

| Message (Webview → Extension) | Handler | Description |
|------------------------------|---------|-------------|
| `chat` | `hub.chat()` | Conversational message |
| `generatePlan` | `hub.generatePlan()` | Generate execution plan — orchestrator-gated (§8.12, v0.13.0): requires an active, context-ready business problem, or throws |
| `executePlan` | `hub.executePlan()` | Execute current plan — orchestrator-gated (§8.12, v0.13.0): requires `planApproved` and `stagesConfirmed`, or throws |
| `pausePlan` | `hub.pauseExecution()` | Pause execution |
| `resetPlan` | `hub.resetPlan()` | Reset session |
| `updateSettings` | `configManager.updateSettings()` | Save settings |
| `testLanguageModel` / `testCopilot` | Command proxy | Test the active local LLM (Copilot model, or Claude Code CLI) |
| `listLanguageModels` | Command proxy | Enumerate all `vscode.lm` models + report where the Claude Code CLI resolves from |
| `openCopilotHandoff` | Command proxy | Open handoff editor |
| `reindex` | Command proxy | Rebuild context index |
| `openContextFolder` | File system | Open .ai-context in OS |
| `testConnection` | `ConnectionManager.connect()` | Connect to data platform |
| `sourceAssessment` | `ConnectionManager.extractMetadata()` | Extract + persist metadata |
| `runAgent` | Agent routing | Run a specific sub-agent |
| `settingsLoaded` | Re-send settings | Webview initial load |
| `newChat` | `startNewChat()` | Archive current session (folding in any partial interview), start a fresh one (Phase F) |
| `listChatSessions` | `ChatSessionManager.listSessions()` | Enumerate all chat sessions |
| `openChatSession` | Archive current + reactivate + `loadTranscript()` | Resume a past session live (v0.13.0 — was read-only) |
| `discardChat` | `ChatSessionManager.discardSession()` | Permanently delete a session (caller confirms first) |

| Message (Extension → Webview) | Purpose |
|------------------------------|---------|
| `stateUpdate` | Push plan state changes |
| `planUpdated` | Push new plan |
| `logEntry` | Push log message |
| `settingsLoaded` | Push settings + active language model info (`languageModelInfo`, plus `copilotInfo` alias) |
| `settingsSaved` | Confirm settings saved |
| `error` | Push error message |
| `contextUpdate` | Push context stats + entities |
| `stepUpdate` | Push step status change |
| `chatResponse` | Push chat response |
| `agentStatus` | Push agent execution status |
| `sourceAssessmentComplete` | Push source assessment result |
| `chatSessionLoaded` | Push `{ meta, transcript }` for the active/new session (Phase F) — fires on every sidebar resolve and on New Chat |
| `chatSessionsList` | Push all session metadata (Phase F; consumed by the sidebar's Chat History dropdown since v0.13.0) |

### 7.3 Configuration Management

**File:** `src/core/configManager.ts`

| Method | Description |
|--------|-------------|
| `getSettings()` | Read all settings from VS Code configuration |
| `updateSettings(partial)` | Write settings to VS Code configuration |
| `setSecret(key, value)` | Store secret in VS Code secret storage |
| `getSecret(key)` | Retrieve secret from VS Code secret storage |
| `deleteSecret(key)` | Remove secret |
| `setLlmApiKey(value)` | Store LLM API key |
| `getLlmApiKey()` | Retrieve LLM API key |
| `setSnowflakePassword(value)` | Store Snowflake password |
| `getSnowflakePassword()` | Retrieve Snowflake password |

### 7.4 Registered Configuration Properties

All properties are under the `autoDataEngineeringHub` section:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `defaultProvider` | enum | `snowflake` | Default data platform |
| `defaultSnowflakeAccount` | string | `""` | Snowflake account |
| `defaultSnowflakeUsername` | string | `""` | Snowflake username |
| `defaultSnowflakeWarehouse` | string | `""` | Snowflake warehouse |
| `defaultSnowflakeDatabase` | string | `""` | Snowflake database |
| `defaultSnowflakeSchema` | string | `PUBLIC` | Snowflake schema |
| `defaultSnowflakeRole` | string | `SYSADMIN` | Snowflake role |
| `defaultSnowflakeAuthMode` | enum | `key-pair` | Auth mode |
| `snowflakePrivateKeyPath` | string | `""` | Key path |
| `metadataCachingDurationMinutes` | number | `15` | Cache duration |
| `queryTimeoutSeconds` | number | `120` | Query timeout |
| `readOnlyMode` | boolean | `true` | Read-only mode |
| `enableSessionReuse` | boolean | `true` | Session reuse |
| `autoDocumentationEnabled` | boolean | `true` | Auto-documentation |
| `telemetryEnabled` | boolean | `false` | Telemetry opt-in |
| `activeLlmProvider` | enum | `copilot` | Active LLM provider (`copilot`, `claude`, `openai`, `anthropic`, `azure-openai`, `gemini`, `ollama`) |
| `activeLlmModel` | string | `gpt-4o-mini` | LLM model name |
| `llmEndpoint` | string | `""` | Custom LLM endpoint |
| `languageModelProgrammaticConsent` | boolean | `false` | Consent to use a local LLM (Copilot via `vscode.lm`, or the Claude Code CLI) programmatically |
| `claudeCodePath` | string | `""` | Explicit path to the `claude` CLI for provider `claude`; empty = auto-detect |
| `copilotProgrammaticConsent` | boolean | `false` | _Deprecated_ — legacy consent flag, still honored as a fallback |
| `extensionDisplayName` | string | `Auto Data Engineering Hub` | Display name |
| `extensionDescription` | string | `...` | Description |

---

## 9. File Structure

```
AutoDE/
├── .ai-context/                          # Context layer (hidden, per-repo)
│   ├── sources.yaml                      # Source registry (user-identified files)
│   ├── context/                          # AUTHORITATIVE — human-owned, committed
│   │   ├── industry/
│   │   ├── enterprise/
│   │   ├── domain/
│   │   └── queries/
│   ├── derived/                          # DERIVED — generated, gitignored
│   │   ├── system/
│   │   ├── artifacts/
│   │   ├── graph.json                    # Compiled index (in-memory working set)
│   │   └── embeddings/
│   ├── spec/                             # Business Problem Specification
│   │   └── business-problem.yaml
│   ├── chats/                             # Chat sessions (Phase F) — gitignored
│   │   ├── <id>.meta.json
│   │   ├── <id>.jsonl
│   │   └── carryover/<sessionId>.md      # Abandoned-interview partial answers, folded into context
│   ├── target-environment.yaml           # Target env config
│   ├── state.json                        # Workspace state (objective + phase progress)
│   ├── plan/                             # Generated plan (v0.10.0) — mirrors spec/
│   │   ├── plan.yaml
│   │   └── history/plan.v<n>.<status>.yaml
│   └── artifacts/                        # Generated artifacts (v0.10.0 — visible, committed;
│       ├── 01-discover/                  #   previously a sibling auto-de/ folder)
│       ├── 02-model/
│       ├── 03-build/
│       └── 04-validate/
│
├── docs/
│   ├── requirements.md                   # Authoritative requirements
│   ├── technical-design.md               # THIS DOCUMENT
│   └── schemas/
│       └── context-envelope.schema.json  # Context envelope JSON Schema
│
├── media/
│   ├── logo.svg
│   ├── architecture.drawio
│   ├── sidebar.html                      # Workspace webview
│   ├── panel.html                        # Bottom panel dashboard
│   └── editors/                          # Custom editor webviews
│
├── skills/                               # DE spec-generation skills (JSON, user-overridable)
│
├── src/
│   ├── extension.ts                      # Activation, command registration
│   ├── core/
│   │   ├── agentHub.ts                   # Orchestrator + LLM calls
│   │   ├── configManager.ts              # Settings + secrets
│   │   ├── languageModelAdapter.ts       # GitHub Copilot via vscode.lm
│   │   ├── claudeCodeAdapter.ts          # provider 'claude' → Claude Code CLI (claude -p)
│   │   ├── copilotAdapter.ts             # re-export shim (back-compat)
│   │   ├── extensionIdentity.ts          # Constants (IDs, keys)
│   │   ├── phaseInference.ts             # Spec-driven phase inference + live status (pure module)
│   │   ├── implementationType.ts         # Deterministic Greenfield/Brownfield classification (pure module)
│   │   ├── targetContextQuestions.ts     # Fixed Target Context Q&A + keyword-evidence defaults (pure module) — v0.11.0
│   │   ├── sourceContextQuestions.ts     # Fixed Source Context Q&A + keyword-evidence defaults (pure module) — v0.11.0
│   │   ├── problemSlug.ts                # generateProblemSlug() — business-problem folder slugs (pure module) — v0.12.0
│   │   ├── skillRegistry.ts              # Spec skills registry + directory loader
│   │   ├── toolSkills.ts                 # Imported Claude Agent Skill (SKILL.md) parser — Phase D
│   │   ├── llmAdapter.ts                 # LlmAdapter/LlmAdapterContext interfaces + extractJsonText — Phase C
│   │   ├── llmProviders.ts               # LLM_ADAPTERS registry (one class per provider) — Phase C
│   │   ├── specOps.ts                    # SpecOpsEngine state machine + action validation
│   │   ├── specOpsPrompts.ts             # Discovery + synthesis prompt assembly
│   │   ├── specSynthesis.ts              # Comprehensive v2 spec parsing/validation
│   │   ├── panelProvider.ts              # Bottom panel provider
│   │   ├── providerRegistry.ts           # Platform + LLM definitions
│   │   ├── types.ts                      # Core type definitions
│   │   ├── webviewProvider.ts            # Webview message bridge
│   │   └── webviewSecurity.ts            # CSP nonce helper
│   ├── context/
│   │   ├── ActiveProblemManager.ts       # active-problem.json pointer + listProblems() for the picker — v0.12.0
│   │   ├── ArtifactWriter.ts             # Artifacts → <contextRoot>/artifacts/<phase>/[<specId>.v<version>/] (contextRoot = the active business problem's folder, v0.12.0)
│   │   ├── ArtifactStalenessScanner.ts   # Scans <contextRoot>/artifacts/ for <specId>.v<version> folders vs. the current approved spec
│   │   ├── ContextFileManager.ts         # .ai-context/ file management (workspace-level, shared across business problems)
│   │   ├── ContextValidator.ts           # AJV envelope validation (Phase 3 pt 1)
│   │   ├── GraphManager.ts               # In-memory knowledge graph (workspace-level; spec-derived layer swapped per active business problem — v0.12.0)
│   │   ├── GraphPersistence.ts           # Atomic derived/graph.json I/O (Phase 3 pt 1)
│   │   ├── ChatSessionManager.ts         # Chat session CRUD (.ai-context/chats/, workspace-level) — Phase F
│   │   ├── SourceRegistry.ts             # sources.yaml read/write (workspace-level)
│   │   ├── SpecManager.ts                # BPS persistence/versioning/history — constructed per active business problem (v0.12.0)
│   │   ├── PlanManager.ts                # Plan persistence/versioning/history — mirrors SpecManager; per active business problem (v0.12.0)
│   │   ├── TargetContextManager.ts       # Target Context persistence/approval — per active business problem (v0.12.0)
│   │   ├── SourceContextManager.ts       # Source Context persistence/approval — per active business problem (v0.12.0)
│   │   ├── SynthesisPipeline.ts          # Rule-based source → graph
│   │   ├── TargetConfigManager.ts        # Target env profiles (workspace-level tool-preference profile, distinct from TargetContext)
│   │   ├── types.ts                      # Context types + envelope
│   │   └── Yaml.ts                       # Real YAML parse/stringify (Phase 3 pt 1)
│   ├── dqm/
│   │   ├── BaseAdapter.ts
│   │   ├── ConnectionManager.ts
│   │   ├── types.ts
│   │   └── adapters/
│   │       ├── SnowflakeAdapter.ts
│   │       └── DatabricksAdapter.ts
│   ├── agents/
│   │   ├── discover/SourceAssessmentAgent.ts
│   │   ├── model/SttmMapperAgent.ts
│   │   ├── model/DataModelerAgent.ts
│   │   ├── build/IngestionPipelineAgent.ts
│   │   ├── build/TransformationScaffolderAgent.ts
│   │   ├── build/ToolSkillAgent.ts        # toolSkillAgent — Phase D; the one agent that imports vscode directly
│   │   └── validate/DocumentationAgent.ts
│   ├── editors/                          # Custom text editors
│   │   ├── DataModelEditorProvider.ts
│   │   ├── DocEditorProvider.ts
│   │   ├── GraphEditorProvider.ts
│   │   ├── ProfileEditorProvider.ts
│   │   └── SttmEditorProvider.ts
│   └── spokes/                           # Legacy spoke agents (to be migrated)
│       ├── architectureAgent.ts
│       ├── ingestionAgent.ts
│       ├── snowflakeExecutor.ts
│       └── sttmAgent.ts
│
├── test/
│   └── functional.test.cjs
├── package.json
├── tsconfig.json
└── README.md
```

---

## 10. Implementation Phases

> **Forward plan (spec-driven):** mirroring `docs/requirements.md` §10:
> 1. **Business Problem Specification** — ✅ DONE. Spec types + `SpecManager` persistence/versioning/history, `AgentHub.generateSpec`, spec-aware chat routing, review/approve UI, `/spec`, `generatePlanFromSpec`.
> 2. **Spec-driven phase inference + orchestration** — ✅ DONE (v0.6.0). Deterministic `inferPhases()` in `src/core/phaseInference.ts` infers the required phases + dependencies from the approved BPS; plan generation is constrained to those phases (`buildPlanPrompt`); the palette renders the live status view (completed / in-progress / blocked / pending / unrequired), and phase statuses recompute on every state emit.
> 2b. **Agentic Specification Generation (SpecOps)** — ✅ DONE (v0.7.0). Superpowers-inspired, DE-tailored requirements flow: `skills/` registry + `SpecOpsEngine` state machine + adaptive questioning (chat bubbles + dynamic intake forms) + comprehensive v2 synthesis with provenance. See §2.8.
> 3. **Phase 3** — layered context loading. ✅ PART 1 (v0.8.0): real YAML parser (`src/context/Yaml.ts`), AJV envelope validation (`src/context/ContextValidator.ts`), atomic graph persistence (`src/context/GraphPersistence.ts`). ✅ PART 2 (v0.8.0): `ContextFileManager` layered loading (`context/**` + `derived/graph.json` via `GraphPersistence`, legacy fallbacks), AJV envelope validation wired through `ContextValidator`; `SpecManager`/`SourceRegistry`/`TargetConfigManager` migrated to the real `yaml` library (legacy flat-format files still parse). Per-kind AJV content schemas remain deferred.
> 4. **Phase 4** — real Snowflake/Databricks adapters (wire `snowflake-sdk`).
> 5. **Phase 5** — ContextRetriever + vector engine (embedded, no server).
> 6. **Phase 6** — Local LLM (Copilot + Claude Code) consent UI, telemetry, unit/integration tests.

### Historical phases (committed)

### Phase 0: UI Restructure ✅ COMPLETE

- [x] Replace four-tab layout with single-column, section-based layout
- [x] Redesign top status bar with provider pill, connection pill, context meter, plan status
- [x] Move Settings and Connect into slide-out panel
- [x] Implement context assembly drawer (collapsible)
- [x] Polish all CSS to match design specifications
- [x] Add welcome/onboarding block

### Phase 1: Chat Routing Fix + Codebase Cleanup ✅ COMPLETE

- [x] Add conversational `chat()` method to agentHub
- [x] Route regular messages to `chat` instead of `generatePlan`
- [x] Add `chatResponse` handler in webview
- [x] Auto-save language model consent toggle (Copilot + Claude Code cards)
- [x] Register `languageModelProgrammaticConsent` configuration property (legacy `copilotProgrammaticConsent` kept as fallback)
- [x] Remove stale duplicate re-export files (`src/agentHub.ts`, etc.)
- [x] Fix broken imports in spoke agents
- [x] Add slash command support (`/plan`, `/execute`, `/context`, etc.)

### Phase 2: Context Visibility & Interaction ✅ COMPLETE

- [x] Create `ContextFileManager` with YAML parsing, file watching, atomic writes
- [x] Wire `ContextFileManager` into `webviewProvider`
- [x] Post `contextUpdate` messages with real stats and entity lists
- [x] Update @-mention system to use real context entities
- [x] Populate context drawer chips from context layer
- [x] Add "Source Assessment" button to connection panel
- [x] Add `sourceAssessment` message handler

### Phase 3a: Multi-Platform Adapter Architecture + Workflow Palette ✅ COMPLETE

- [x] Create `docs/technical-design.md` (this document)
- [x] Create `src/dqm/types.ts` — adapter type definitions
- [x] Create `src/dqm/BaseAdapter.ts` — abstract base class
- [x] Create `src/dqm/adapters/SnowflakeAdapter.ts` — Snowflake implementation
- [x] Create `src/dqm/adapters/DatabricksAdapter.ts` — Databricks implementation
- [x] Create `src/dqm/ConnectionManager.ts` — connection lifecycle
- [x] Move spoke agents to `src/agents/` directory
- [x] Create `src/agents/discover/SourceAssessmentAgent.ts`
- [x] Enhance STTM, Ingestion, Documentation agents
- [x] Update `src/core/agentHub.ts` imports
- [x] Update `src/extension.ts` with ConnectionManager
- [x] Update `src/core/webviewProvider.ts` with new handlers
- [x] Build Workflow Palette UI in `media/sidebar.html`
- [x] Add palette CSS + JS
- [x] Compile + test

### Phase 3b: Enhanced Sub-Agents

- [x] Data Modeler agent (dimensional + Data Vault) — `src/agents/model/DataModelerAgent.ts`
- [x] Transformation Scaffolder agent (dbt project generation) — `src/agents/build/TransformationScaffolderAgent.ts`
- [ ] Data Lineage Mapper agent
- [ ] Data Quality Profiler agent

### Phase 3c: New Sub-Agents

- [ ] DDL Generator agent
- [ ] Orchestration Generator agent (Airflow/Dagster/Prefect)
- [ ] SQL Validator agent
- [ ] Test Generator agent
- [ ] Business Glossary Builder agent

### Phase 3d: Orchestrator Intelligence

- [ ] Context-aware action suggestions in chat
- [ ] Auto-invocation of sub-agents based on intent
- [ ] Plan diff & iteration
- [ ] Onboarding flow for first-time users
- [ ] Results preview for executed SQL
- [ ] Export functionality (Markdown/YAML)

### Phase 4: Project System → SUPERSEDED (see requirements §7)

> The multi-project registry (`ProjectManager`, `.auto-de/projects.json`) is **superseded** by the single-workspace model: AutoDE operates on the open repository, and generated artifacts go to a visible `.ai-context/artifacts/` folder. See `docs/requirements.md` §7.

- [x] `src/context/TargetConfigManager.ts` — target environment profiles with inheritance (kept)
- [x] Workflow phases (discover → model → build → validate) and phase progress tracking (kept, workspace-scoped)
- [~] `ProjectManager` / `ProjectRegistry` — to be removed (superseded)

### Phase 5a: Bottom Panel Dashboard ✅ COMPLETE (v0.5.0)

- [x] `src/core/panelProvider.ts` + `media/panel.html` — project progress, stats, artifacts

### Phase 5b: Custom Editors ✅ COMPLETE (v0.5.1)

- [x] `src/editors/` — DataModel, STTM, Graph, Profile, Doc custom text editors

### Phase 6: Testing, telemetry & docs — PARTIAL

- [~] Functional tests — `test/functional.test.cjs` covers the Copilot `vscode.lm` adapter, the Claude Code CLI adapter (mocked `child_process`), plus the pure modules
- [ ] Context Layer / adapter / agent unit tests
- [~] Opt-in telemetry — config flag exists; no telemetry implementation
- [~] Docs — synced to v0.5.0 (this revision)

### Security fix (post-v0.5.1)

- [x] Webview CSP nonce injection — `src/core/webviewSecurity.ts` (`applyCspNonce`) applied to the sidebar, panel, and all 5 custom editors so inline scripts run under VS Code's default CSP.

> **⚠️ Implementation-status caveats (as of v0.5.0):**
> - `SnowflakeAdapter`/`DatabricksAdapter` `connect()` and `executeQuery()` are **stubs** — they do not perform real connections or queries (empty results). Metadata extraction is therefore non-functional end-to-end.
> - `GraphManager` is in-memory only: `isWorkerReady` is hardcoded `true`, and `traverseNeighborhood()` returns empty `formattedContext`/`tokenCount` (the ContextRetriever does not exist yet).
> - No worker threads, no vector/embedding engine, no `js-tiktoken` token counting, no `ajv` validation, and `deactivate()` is empty.

### Phase 7: Architecture review follow-through ✅ COMPLETE (v0.9.0)

- [x] **Phase A — Spec revision.** §2.9. Approved specs are never edited in place; full agentic revision interview seeded from the approved spec.
- [x] **Phase B — Versioning & governance.** §2.10. Git as the version/audit log; `<specId>.v<version>` artifact folders; staleness scanning.
- [x] **Phase C — LLM adapter registry.** §6.0. `LlmAdapter` registry replaces the `callConfiguredLlm` if/else chain.
- [x] **Phase D — Tool-executing Skills.** §5.6. `SKILL.md` import; Claude CLI tool loop + Copilot `vscode.lm` tool-calling loop, workspace-sandboxed.

### Phase 8: Usability follow-through ✅ COMPLETE (E–F) / ⏳ NOT STARTED (G) (v0.9.0)

- [x] **Phase E — Processing feedback.** §2.3 (pending bubble row). Single evolving pending chat bubble replaces static append-only log lines; send disabled while in flight.
- [x] **Phase F — Chat sessions & lifecycle.** §2.11. `ChatSessionManager` persists chat as BPS-identity-independent sessions; New Chat archives (never silently discards, folding partial interviews into context first); Chat History/Discard via Command Palette.
- [ ] **Phase G — Context Memory curation.** Not started — see `requirements.md` §16.7.

---

## 11. Design Decisions & Tradeoffs

### 10.1 Why Conversation-First Over Tab-Based?

**Decision:** Single scrollable workspace with slide-out panels instead of multiple tabs.

**Rationale:**
- No tab switching during the core workflow (describe → plan → execute → refine)
- Context is always visible — users can expand the context drawer to see exactly what semantic metadata is being included
- Settings and connections move to a slide-out panel — not a tab competing for attention
- Cline's success validates this pattern: one unified conversation surface where configuration, context, and execution flow naturally from the chat

### 10.2 Why Adapter Pattern Over Code Generation?

**Decision:** Abstract `BaseDataSourceAdapter` with platform-specific implementations.

**Rationale:**
- Each platform has fundamentally different system tables, SQL dialects, and authentication
- Code generation would require maintaining templates for every platform × operation combination
- Adapter pattern allows adding new platforms by implementing one class
- Sub-agents stay clean and platform-agnostic
- The `PlatformCapabilities` model allows graceful degradation (e.g., Databricks doesn't support lineage extraction)

### 10.3 Why Phase-Organized Palette Over Source/Target Split?

**Decision:** Workflow palette organized by phase (Discover → Model → Build → Validate) rather than source vs. target sections.

**Rationale:**
- Real data engineering is iterative, not linear: Source Assessment → STTM → Modeling → back to Source for more profiling
- Rigid source/target separation forces context switching
- Phase organization matches how engineers think about their workflow
- The orchestrating agent understands which phase the user is in and suggests the next logical action

### 10.4 Why Atomic Writes for .ai-context/?

**Decision:** All writes use temporary staging + atomic rename.

**Rationale:**
- Prevents corruption if VS Code crashes mid-write
- The `schema-graph.json` file is always in a valid state
- On next boot, the engine loads the previous valid snapshot
- Implemented via `vscode.workspace.fs.writeFile(tempFile)` → `vscode.workspace.fs.rename(tempFile, targetFile, { overwrite: true })`

### 10.5 Why Single-File Webview (sidebar.html)?

**Decision:** All HTML, CSS, and JavaScript in one file.

**Rationale:**
- VS Code webviews have restrictions on loading external resources
- Single-file simplifies the build process (no bundler needed)
- The file is read via `fs.readFileSync` and injected directly
- For a sidebar-sized UI, the complexity doesn't yet warrant a framework
- Can be split later if the UI grows significantly

### 10.6 YAML Parsing Strategy

**Original decision:** Lightweight custom parser for `.ai-context/` YAML files.

**Original rationale:**
- Avoids adding a native dependency that complicates VSIX packaging
- The YAML structures needed (business-context.yaml, verified-queries.yaml) are simple and flat
- A full YAML parser would be overkill for these specific file formats

**Superseded (v0.8.0, Phase 3 part 1):** the hand-rolled parsers are being replaced with the **`yaml`** library (pure JS, no native bindings → still VSIX-safe) via `src/context/Yaml.ts` (`parseYaml`/`stringifyYaml`). Structure validation uses **`ajv`** (`src/context/ContextValidator.ts`) against `docs/schemas/context-envelope.schema.json`. Remaining migration: `SpecManager`, `SourceRegistry`, `TargetConfigManager`, `ContextFileManager` (tracked in §10 Phase 3 part 2; requirements §16 #6).

---

## Appendix A: Webview Message Reference

### Webview → Extension

| Message Type | Payload | Handler |
|-------------|---------|---------|
| `chat` | `{ message: string, schemaContext?: string }` | `hub.chat()` — merges `contextFileManager.buildContextPrompt()` with `schemaContext` before calling `hub.chat()` |
| `generatePlan` | `{ objective: string, schemaContext?: string }` | `hub.generatePlan()` — same Context Layer merge as `chat` (v0.10.0; previously passed `schemaContext` through unmerged) |
| `approveSpec` | `{}` | `specManager.approve()` → automatically runs `syncContextFromApprovedSpec()` (spec → Context Layer sync + durable snapshot, v0.10.0) → `hub.inferPhasesFromSpec(spec, contextSummary)` → responds `specApproved` |
| `generatePlanFromSpec` | `{}` | Requires an approved spec; `hub.generatePlanFromSpec(spec, contextFileManager.buildContextPrompt())` — the spec-driven counterpart to `generatePlan`, and the primary trigger from the "📋 Generate Plan" UI actions (§2.5) |
| `setImplementationType` | `{ value: 'greenfield' \| 'brownfield' }` | User override of the deterministic Greenfield/Brownfield classification (§2.12); persists `implementationTypeOverridden: true` on the spec so future revisions don't silently reclassify it |
| `setPhaseRequired` | `{ phase: WorkflowPhase, required: boolean }` | `hub.setPhaseOverride(phase, required)` (§8.9) — manual Applicable/Non-Applicable override on the palette, survives a subsequent re-plan, does not retroactively edit an already-generated plan's steps (the palette flags it as possibly stale instead) |
| `startTargetContext` / `reviseTargetContext` | `{}` | Posts `targetContextQuestions` — the fixed 8-question Target Context form (§8.10) |
| `submitTargetContextAnswers` | `{ answers: [{questionId, value}] }` | Saves as `TargetContext` (status `built`); posts `targetContextBuilt` |
| `approveTargetContext` | `{}` | Marks approved, pushes into `hub.setTargetEnvironment()`; posts `targetContextApproved` |
| `chooseSourceContextMethod` | `{ method: 'connected' \| 'described' }` | `'connected'` runs a live connection check (`runSourceConnectionCheck`); `'described'` posts `sourceContextQuestions` (3 fixed questions) — Brownfield only |
| `runSourceConnectionCheck` | `{}` | Re-runs the live connection check (retry) |
| `submitSourceContextAnswers` | `{ answers: [...] }` | Saves as `SourceContext` (status `built`, method `described`); posts `sourceContextBuilt` |
| `approveSourceContext` / `reviseSourceContext` | `{}` | Approve marks approved and posts `sourceContextApproved`; revise re-opens the form (or re-runs the connection check for `method: 'connected'`) |
| `executePlan` | `{}` | `hub.executePlan()` |
| `pausePlan` | `{}` | `hub.pauseExecution()` |
| `resetPlan` | `{}` | `hub.resetPlan()` |
| `updateSettings` | `{ settings: Partial<DataAgentHubSettings> }` | `configManager.updateSettings()` |
| `testCopilot` / `testLanguageModel` | `{}` | Command proxy |
| `listLanguageModels` | `{}` | Command proxy |
| `openCopilotHandoff` | `{ prompt?: string }` | Command proxy |
| `reindex` | `{}` | Command proxy |
| `openContextFolder` | `{}` | File system |
| `testConnection` | `{}` | `ConnectionManager.connect()` |
| `sourceAssessment` | `{}` | `ConnectionManager.extractMetadata()` |
| `runAgent` | `{ agent: string }` | Agent routing |
| `settingsLoaded` | `{}` | Re-send settings |
| `startRevision` | `{}` | Arms `pendingRevision` (only if the current spec is `approved`); the next `chat` message becomes the change request (§2.9) |
| `attachSpecFile` | `{}` | Opens a file picker; attaches the picked file to the active `SpecOpsEngine` session as reference material (§2.9) |
| `refineSpec` | `{ refinement: string }` | Approved spec → full revision interview (§2.9); draft spec → single-shot `reviseSpec()` |
| `checkArtifactStaleness` | `{}` | `scanArtifactStaleness()` → responds with `artifactStaleness` (§2.10) |
| `runToolSkill` | `{ skillId: string, instruction: string }` | `hub.runToolSkill(skillId, instruction)` → responds with `chatResponse` (§5.6, Phase D) |
| `viewSpecHistory` | `{}` | `git log --follow -p` on the spec file → responds with `specHistory` (§2.10) |
| `newChat` | `{}` | Archives the current session (folding in any partial interview), starts a new one → responds with `chatSessionLoaded` (§2.11, Phase F) |
| `listChatSessions` | `{}` | `ChatSessionManager.listSessions()` → responds with `chatSessionsList` (§2.11, Phase F) — drives the sidebar's Chat History dropdown (v0.13.0) |
| `openChatSession` | `{ chatId: string }` | **Resumes** the given session as the live active one (v0.13.0 — previously a read-only preview): archives whatever's currently active, reactivates the target, responds with `chatSessionLoaded` (not `chatSessionViewed`, which is retired) |
| `discardChat` | `{ chatId: string }` | Permanently deletes a session (caller confirms first) (§2.11, Phase F) |
| `startNewBusinessProblem` | `{}` | Clears the active-problem pointer, fully resets (`hub.resetForNewProblem()`), archives the current chat and starts a new one → responds with `activeProblemChanged` (§8.11, v0.12.0) |
| `listBusinessProblems` | `{}` | `ActiveProblemManager.listProblems()` → responds with `businessProblemsList` (§8.11, v0.12.0) |
| `switchBusinessProblem` | `{ problemId: string }` | Activates a different existing business problem (same reset sequence as above), archives the current chat and starts a new one → responds with `activeProblemChanged` (§8.11, v0.12.0) |
| `approveBusinessProblem` | `{}` | Sets `spec.problemStatementApproved = true` (§8.12, v0.13.0) — required before `approveSpec` will accept the spec |
| `approvePlan` | `{}` | `hub.approvePlan()` — explicit Plan Approval gate (§8.12, v0.13.0), required (alongside `confirmStages`) before `executePlan` will run |
| `confirmStages` | `{}` | `hub.confirmStages()` — explicit "confirm applicable stages" gate (§8.12, v0.13.0), required (alongside `approvePlan`) before `executePlan` will run |

### Extension → Webview

| Message Type | Payload | Purpose |
|-------------|---------|---------|
| `stateUpdate` | `{ state: PlanState }` | Plan state changes |
| `planUpdated` | `{ plan: PlanStep[] }` | New plan generated |
| `logEntry` | `{ message: string }` | Log message |
| `settingsLoaded` | `{ ...DataAgentHubSettings, languageModelInfo, copilotInfo }` | Initial settings |
| `settingsSaved` | `{ success: boolean }` | Settings confirmation |
| `error` | `{ message: string }` | Error notification |
| `contextUpdate` | `{ stats, dbEntities, bizTerms, queries }` | Context data |
| `stepUpdate` | `{ stepId, status, details }` | Step status change |
| `chatResponse` | `{ message: string, error?: boolean }` | Chat response |
| `agentStatus` | `{ agent, status, result? }` | Agent execution status |
| `sourceAssessmentComplete` | `{ success: boolean, error? }` | Assessment result |
| `chatSessionLoaded` | `{ meta: ChatSessionMeta, transcript: ChatMessage[] }` | Active/new session to render (§2.11, Phase F) |
| `chatSessionsList` | `{ sessions: ChatSessionMeta[], activeChatId?: string }` | All sessions (§2.11, Phase F) — populates the sidebar's Chat History dropdown (v0.13.0) |
| `specLoaded` | `{ spec: BusinessProblemSpec \| undefined }` | Current spec (including `implementationType`/`implementationTypeReason`, v0.10.0), sent on load and after every spec mutation |
| `specQuestion` | `{ question: SpecIntakeQuestion & { skillLabel?: string }, progress?: DiscoveryProgress }` | One discovery-turn question (`'ask'`) — chat bubble. `skillLabel`/`progress` added v0.13.0 (`discoveryProgress.ts`) so the interview reads as a bounded, structured process rather than opaque back-and-forth (§8.13) |
| `specQuestions` | `{ questions: Array<SpecIntakeQuestion & { skillLabel?: string }>, progress?: DiscoveryProgress }` | A batch of discovery-turn questions (`'ask_many'`, 2+) — dynamic intake form. Same v0.13.0 additions as `specQuestion` |
| `specDrafted` | `{ spec: BusinessProblemSpec, revised: boolean }` | A new draft (or revision) was synthesized |
| `specApproved` | `{ spec: BusinessProblemSpec }` | The spec was approved; Context Layer sync has already completed by the time this is posted (§2.12) |
| `contextGateStatus` | `{ targetStatus, sourceApplicable, sourceStatus, canGeneratePlan, blockingReasons, targetContext?, sourceContext? }` | The single source of truth for whether Generate Plan is unblocked (§8.10) — posted after every context-affecting action |
| `targetContextQuestions` / `sourceContextQuestions` | `{ questions: ContextQuestion[], answers: Record<string,string> }` | The fixed Q&A form to render, pre-filled with any prior answers |
| `targetContextBuilt` / `sourceContextBuilt` | `{ context: TargetContext \| SourceContext }` | Answers saved (status `built`) — awaiting `approve*Context` |
| `targetContextApproved` / `sourceContextApproved` | `{ context: TargetContext \| SourceContext }` | Approved — Target Context is now live in `hub.state.targetEnvironment` |
| `activeProblemChanged` | `{ problemId: string \| undefined, spec?: BusinessProblemSpec }` | Posted after `activateProblem()` completes (startup, switch, or new-problem reset); `problemId: undefined` is the genuinely clean "no active business problem" state (§8.11, v0.12.0) |
| `businessProblemsList` | `{ problems: BusinessProblemSummary[] }` | Every saved business problem in the workspace, newest-first, for the Workflow Palette's switcher (§8.11, v0.12.0) |

---

## Appendix B: CSS Variable Reference

| Variable | Fallback | Usage |
|----------|----------|-------|
| `--bg` | `#1f1f1f` | Main background |
| `--surface` | `#252526` | Cards, panels, input areas |
| `--surface-hover` | `rgba(255,255,255,0.03)` | Hover state |
| `--surface-active` | `rgba(255,255,255,0.06)` | Active/selected state |
| `--surface-elevated` | `rgba(255,255,255,0.04)` | Elevated surfaces |
| `--border` | `rgba(255,255,255,0.12)` | Standard borders |
| `--border-soft` | `rgba(255,255,255,0.08)` | Subtle borders |
| `--border-subtle` | `rgba(255,255,255,0.05)` | Very subtle borders |
| `--text` | `#cccccc` | Primary text |
| `--text-muted` | `#9d9d9d` | Secondary text |
| `--text-dim` | `rgba(255,255,255,0.45)` | Dimmed text |
| `--accent` | `#0e639c` | Primary accent |
| `--accent-hover` | `#1177bb` | Accent hover |
| `--accent-subtle` | `rgba(14,99,156,0.12)` | Subtle accent background |
| `--accent-border` | `rgba(14,99,156,0.25)` | Accent border |
| `--text-on-accent` | `#ffffff` | Text on accent |
| `--success` | `#2ea043` | Success green |
| `--warning` | `#d29922` | Warning amber |
| `--error` | `#f85149` | Error red |
| `--info` | `#58a6ff` | Info blue |
| `--radius` | `8px` | Card border radius |
| `--radius-sm` | `6px` | Small border radius |
| `--radius-xs` | `4px` | Extra small border radius |
| `--radius-pill` | `999px` | Pill border radius |
| `--spacing-xs` | `4px` | Extra small spacing |
| `--spacing-sm` | `8px` | Small spacing |
| `--spacing-md` | `12px` | Medium spacing |
| `--spacing-lg` | `16px` | Large spacing |
| `--spacing-xl` | `20px` | Extra large spacing |
| `--font-size` | `12px` | Base font size |
| `--font-size-sm` | `11px` | Small font size |
| `--font-size-lg` | `13px` | Large font size |
| `--font-size-xl` | `14px` | Extra large font size |
| `--transition-fast` | `0.12s ease` | Fast transitions |
| `--transition-normal` | `0.2s ease` | Normal transitions |
| `--transition-slow` | `0.3s ease` | Slow transitions |

---

*This document is version-controlled and should be updated whenever design decisions change during implementation.*