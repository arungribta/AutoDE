# AutoDE — Technical Design Document

**Last Updated:** 2026-10-15
**Version:** 0.30.0
**Scope:** HOW AutoDE is built — architecture, modules, data formats, algorithms and design trade-offs. What AutoDE must do and why: [requirements.md](requirements.md) and the forward specifications. Order and status: [roadmap.md](roadmap.md). Release history (moved out of this document on 2026-10-15): [CHANGELOG.md](../CHANGELOG.md). Document map: [README.md](README.md).

> Restructured on 2026-10-15: sections 1, 2, 5, 7, 10.1–10.2, 11 and 12 were rewritten against the code at v0.30.0; the others were carried over with paths updated for the v0.26.0 move to `src/engine/`, and some still describe their version's design in narrative form. The historical phase list (old §10) was removed — release history is in CHANGELOG.md. Where this document and the code disagree, the code and the latest CHANGELOG entry win; corrections are tracked in the roadmap.

---


---

## Table of Contents

1. [Overview & Architecture](#1-overview--architecture)
2. [Repository Layout & Persistence](#2-repository-layout--persistence)
3. [Business Problem Specification & Lifecycle](#3-business-problem-specification--lifecycle)
4. [UI Architecture](#4-ui-architecture)
5. [Context Layer](#5-context-layer)
6. [Data Platforms](#6-data-platforms)
7. [Agent Orchestration](#7-agent-orchestration)
8. [LLM Integration](#8-llm-integration)
9. [Deterministic Execution Core & Pipeline Specification](#9-deterministic-execution-core--pipeline-specification)
10. [Extension Architecture](#10-extension-architecture)
11. [Testing & Evaluation](#11-testing--evaluation)
12. [Source Tree](#12-source-tree)
13. [Design Decisions & Trade-offs](#13-design-decisions--trade-offs)
[Appendix A: Webview Message Reference](#appendix-a-webview-message-reference)
[Appendix B: CSS Variable Reference](#appendix-b-css-variable-reference)

---

## 1. Overview & Architecture

### 1.1 What this document covers

How AutoDE is built: its processes and layers, where state lives, and how each capability in [requirements.md](requirements.md) is implemented. Requirement IDs (`GRD-4`, `ORC-3` …) and principles (P1–P7, C1–C9) are defined there and only referenced here.

### 1.2 Design principles (implementation level)

The product principles are in requirements.md §2. These are the implementation rules that follow from them:

| Rule | Rationale |
|---|---|
| **Engine / host split.** Deterministic logic lives in `src/engine/**` and never imports `vscode` (lint-enforced, and a test loads every engine module in plain Node). Host concerns — UI, secrets, settings, watchers, file writes through `vscode.workspace.fs` — stay in `src/core`, `src/context`, `src/agents`. | The same engine is exposed over MCP (phases 3–5) and runs in tests and the eval harness without VS Code. |
| **Conversation-first UI.** The chat is the spine; context, settings and workflow state are surfaced beside it, not in separate tabs. | Requirements UI-1. |
| **Platform-agnostic agents.** Agents ask *what* (extract metadata, run a query); adapters know *how* (system tables, dialects, execution backends). | One agent works on every platform. |
| **One shared context object per call.** Every LLM call gets its context from `ContextFileManager.buildContextPack()` (or the hub's provider for plan steps), never from ad-hoc string assembly at the call site. | C5; a single place to scope, budget and record context. |
| **Revision-checked, atomic writes.** Every `.ai-context` document is written through a temp file and rename, and refused if it changed on disk since it was read (§2.3). | NFR-2, WS-4. |
| **Orchestrator-enforced gates.** `AgentHub` re-checks every lifecycle precondition itself; the UI only reflects it. | P3, ORC-3. |
| **No silent fallbacks that change meaning.** A missing CLI, consent or credential produces an actionable error, not a quiet switch to another path. | LLM-3, PLT-4. |

### 1.3 High-level architecture

```
┌──────────────────────── VS Code extension host ─────────────────────────┐
│  extension.ts (activate, commands)     webviewProvider.ts (UI bridge)   │
│                     agentHub.ts (orchestrator, LLM calls, gates)        │
│  ┌───────────── host layer: src/core, src/context, src/agents ────────┐ │
│  │ ConfigManager · LLM adapters (7 providers) · SecretStorage creds   │ │
│  │ Spec/Plan/Source/Target/Mapping managers · ArtifactWriter          │ │
│  │ ContextFileManager (ledger sync, projection, packs) · GraphManager │ │
│  │ Agents (discover/model/build/validate, tool skills)                │ │
│  └──────────────────────────────┬─────────────────────────────────────┘ │
│  ┌───────────── engine: src/engine/** (no vscode imports) ────────────┐ │
│  │ context/  assertions, ledger, projection, conflicts, retrieval,   │ │
│  │           contextPack, contextGaps, contextStore, fileIngestion   │ │
│  │ grounding/ sqlGrounding, manifest                                  │ │
│  │ transforms/ primitives (Tier 1 code, Tier 2 declarative)           │ │
│  │ pipelineSpec/ validator, compiler, design doc                      │ │
│  │ platform/ ConnectionManager, adapters, execution backends, creds   │ │
│  │ skills/   interview skills, tool skills, allow-lists               │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ postMessage
                     ┌─────────────▼─────────────┐
                     │ media/sidebar.html        │  chat · context drawer ·
                     │ (single-file webview)     │  workflow palette · settings
                     └───────────────────────────┘
Planned (phases 3–5): src/mcp/server.ts exposes the engine over MCP stdio;
the extension and external agents (Claude Code, Copilot agent mode, Cursor)
become clients of the same server — see mcp-engine-requirements.md §3.
```

---

## 2. Repository Layout & Persistence

### 2.1 `.ai-context/` layout

Everything AutoDE keeps lives under `.ai-context/` in the open workspace. Problem-scoped documents live under the active business problem's folder (`contextRoot`); shared knowledge lives at the workspace level.

```
.ai-context/
├── active-problem.json              # pointer: which problem is active (absent = clean slate)
├── problems/<problem-id>/           # one folder per business problem (slug + 4-char suffix)
│   ├── spec/business-problem.yaml   #   Business Problem Specification (+ spec/history/)
│   ├── spec/pipeline.yaml           #   Pipeline Specification (+ history)
│   ├── plan/plan.yaml               #   persisted plan (+ plan/history/)
│   ├── context/                     #   target-context.yaml, source-context.yaml,
│   │                                #   mapping-context.yaml, semantic-layer.yaml
│   │                                #   (+ .snapshot.json), history/
│   ├── attachments/<id>.yaml        #   attachment content + structured extract
│   └── artifacts/<phase>/<specId>.v<n>/…   # generated deliverables, each with
│                                    #   <file>.grounding.json, and history/ archives
├── problems/_unscoped/              # root for commands run with no active problem
├── context/                         # shared, human-owned (committed)
│   ├── business-context.yaml        #   glossary terms + business rules
│   ├── verified-queries.yaml
│   └── snapshots/<specId>.v<n>.md   #   readable record of context at plan time
├── ledger/                          # assertion ledger — system of record (committed)
│   ├── <yyyy-mm-dd>.<sessionUlid>.jsonl
│   └── snapshot.json                #   optional, written by compaction
├── derived/graph.json               # projection cache (git-ignored, rebuildable)
├── schema-graph.json                # last live extraction (input to the next reindex)
├── sources.yaml                     # registered business-context source files
├── skills/                          # interview-skill overrides; tool-skills/<id>/ imports
├── primitives/                      # Tier-2 primitive overrides (+ history/)
├── chats/                           # chat sessions (git-ignored) + carryover/
└── target-environment.yaml          # tool-preference profiles (TargetConfigManager)
```

Planned: `.ai-context/estate.yaml` and `.ai-context/catalog/<system>/<environment>/` (Phase K); `.ai-context/profiles/` (C4a).

**Committed vs ignored.** Specifications, context documents, the ledger and artifacts are deliverables and are committed; `derived/`, `chats/` and temp files are git-ignored (`.gitignore`).

### 2.2 Atomic writes and archives

Every manager writes through a dot-prefixed temp file beside the target and renames it over (`writeFileAtomic`, `src/engine/context/contextStore.ts`). Managers that version a document (`SpecManager`, `PipelineSpecManager`, `PlanManager`, `Source/Target/MappingContextManager`, `SemanticLayerManager`) archive the previous revision to a `history/` folder before replacing an approved one; the version number bumps only when an *approved* predecessor is revised. `ArtifactWriter` archives an artifact (and its manifest) before a rerun overwrites it.

### 2.3 Revision-checked persistence and external edits (WS-4)

- **`ContextStore` / `RevisionedFile`** (`src/engine/context/contextStore.ts`): a *revision* is the SHA-256 of a file's bytes. A write states the revision it expects to replace and is refused with `RevisionConflictError` when the file changed on disk since it was last read or written; the refused change is not adopted in memory (managers write *before* updating their cached copy). An unparseable external edit keeps the loaded copy and leaves the expected revision stale, so the next save asks rather than clobbering a hand edit in progress.
- **`FileIo`** abstracts file access: `nodeFileIo` (engine default, MCP server, tests) and `createVscodeFileIo(vscode)` (`src/context/vscodeFileIo.ts`, extension), so remote and virtual workspaces keep working. The ledger additionally uses the optional `listDir` / `deleteFile`.
- **`ContextFileWatcher`** (`src/context/ContextFileWatcher.ts`): one recursive watcher over `.ai-context/**/*.{yaml,yml,json}`, debounced per path, ignoring temp files and `history/`. `webviewProvider.onContextFileChanged` routes each path to its owner's `reload()`; AutoDE's own writes are filtered out because the revision still matches. A spec or Pipeline Spec change during execution calls `AgentHub.pauseForExternalChange()` (ORC-6). A refused save raises a Reload from Disk / Overwrite prompt through a module-level conflict handler.
- **Known gap:** `ContextFileManager`'s own business-context reload is driven by a separate, non-recursive watcher on top-level `.ai-context/*.{yaml,json}`, so edits under `.ai-context/context/` need a reload (CTX-5; roadmap §2).

---

## 3. Business Problem Specification & Lifecycle

> **North star.** This section defines AutoDE's governing flow. It supersedes the earlier "objective → plan" model. `docs/requirements.md` remains the authoritative requirements source.

### 3.1 Principle

AutoDE is **conversation-driven and specification-driven**. The user describes a business problem in natural language; AutoDE transforms it into a structured, reviewable, versioned **Business Problem Specification (BPS)**. The BPS — not the raw prompt — is the **system of record** for the repository and governs all subsequent activity.

### 3.2 The Business Problem Specification artifact

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

### 3.3 Spec-driven flow

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

### 3.4 Traceability

Every `GeneratedArtifact`, context node (`Origin`), and workflow phase carries `specId` + `specVersion`.

### 3.5 Phase inference (no manual step selection)

From the approved BPS, AutoDE determines which phases (discover / model / build / validate) are required and their dependencies. The user does **not** select workflow steps; the workflow is inferred and continuously adapted.

**Implemented (v0.6.0).** `src/core/phaseInference.ts` is a pure, deterministic module:
- `inferPhases(spec)` — keyword evidence across the problem statement / objectives / success criteria / scope / constraints / assumptions / domain / key entities marks a phase required; `scope.out` exclusions veto a phase; an underspecified-but-approved spec defaults to the full workflow; a build (transformation) phase implies discovery when source evidence exists.
- `buildPhaseDependencies(required)` — the natural predecessor chain (discover → model → build → validate) is pruned to the required set, so a phase depends only on required predecessors.
- `computePhaseStatuses(phases, steps, currentPhase)` — derives live status per phase from the plan: `completed`, `in-progress` (running or partially done), `blocked` (a dependency is unsatisfied or a step failed), `pending`, or `unrequired`.
- Orchestration integration in `AgentHub`: `inferPhasesFromSpec()` is invoked on spec approval, on work-space load with an approved spec, and on reset; `buildPlanPrompt` receives the required phases so the LLM only plans steps for those phases; every step is tagged with its phase at plan time; every state emit recomputes phase statuses.

### 3.6 Continuous context creation

Context layers (industry / enterprise / domain / system / definitions / queries / artifacts) are built **automatically** from the BPS + repository assets + registered sources + platform metadata — not a manual step. `SourceRegistry` + `SynthesisPipeline` (Phase 2) are the foundation; the spec drives *what* to build.

### 3.7 Workflow Palette as status view

The palette shows (top → bottom): BPS summary (read-only + status + approve/regenerate) → phase status (completed / in-progress / blocked / pending) → next action. It is a **transparent view**, not a manual launcher.

**Implemented (v0.6.0).** The palette's four phase rows are driven by `PlanState.inferredPhases` on every `stateUpdate`: each row shows a status badge, the deterministic inference reason, and the dependency chain; unrequired phases are dimmed and show no run buttons; completed phases disable their run buttons; the surfaced agents are read from the selected phase only.

### 3.8 Agentic Specification Generation (SpecOps)

The BPS draft is produced by an **agentic, DE-tailored requirements flow** inspired by the Superpowers SDLC (skills + explicit phases + review gates), rather than a single-shot prompt.

**Skills.** `skills/*.json` define composable DE skills — Requirements Discovery, Source Catalog, Data Flow, Transformations, Quality & Acceptance, Constraints & Assumptions, and Synthesis. Each carries a system prompt, question guidance, and the spec fields it owns. `SkillRegistry` (`src/engine/skills/skillRegistry.ts`) loads bundled skills plus optional user overrides in `.ai-context/skills/` (later entries win).

**Engine.** `SpecOpsEngine` (`src/core/specOps.ts`) is a deterministic state machine (`discovery → synthesizing → draft → refining → approved`) that tracks per-field coverage and a turn budget, and validates the prompt-schema **actions** the LLM returns each turn (`ask` / `ask_many` / `synthesize` / `done`). No native tool-calling is used — actions are JSON, validated deterministically, so the loop works on Copilot's `vscode.lm` and the Claude Code CLI as well as OpenAI/Anthropic/Ollama.

**Loop.** `AgentHub.discoverNextAction` renders the discovery prompt (`specOpsPrompts.ts`) and returns a validated action. The webview renders a single question as a chat bubble or a batch (`ask_many` with 2+) as a dynamic multi-field intake form (`specQuestions` / `submitSpecAnswers`). When coverage is complete or the turn budget is exhausted, `AgentHub.synthesizeComprehensiveSpec` assembles the comprehensive v2 spec (business requirements, data flows, transformations, dependencies, acceptance criteria, implementation considerations, source catalog) with per-field provenance, which is persisted by `SpecManager` and shown in the review card.

### 3.9 Revising an approved specification

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

**Known gaps (BPS-6, BPS-7; roadmap §2):** `IntakeSession` (including the new `previousSpec`/`changeRequest`/`attachments` fields) is still in-memory only — lost on reload. The emergency fallback on a comprehensive-synthesis failure still re-drafts via the older v1-only `generateSpec`, which doesn't carry v2 fields.

### 3.10 Versioning & governance (Phase B, v0.9.0)

**Design choice:** lean on git as the version/audit log rather than build a parallel in-app version store — `.ai-context/spec/` is already meant to be committed, so a second source of version truth would only drift from it.

- **`src/context/ArtifactWriter.ts`** now writes every spec-stamped artifact under a `<specId>.v<version>` folder (`ArtifactWriter.specTag(artifact)`), inserted **above** the artifact's own relative path — so a multi-file artifact (e.g. the dbt scaffold) keeps every filename a tool like dbt expects (`dbt_project.yml` stays `dbt_project.yml`); only a folder is added, never a filename prefix. Artifacts with no `specId` (legacy pre-Phase-B writes, or generated with no spec set) land directly under the phase directory as before.
- **`src/context/ArtifactStalenessScanner.ts`** (`scanArtifactStaleness(workspaceRoot, currentSpec?)`) walks `.ai-context/artifacts/<phase>/*`, recognizes `<specId>.v<version>` folder names via regex, and classifies each as `current` (matches the approved spec's id+version), `stale` (same id, older version), or `unknown-spec` (different id, or no spec currently approved). Files sitting directly under a phase dir (no version folder) are counted separately as `untaggedFileCount` — this is *why* the folder scheme exists: `PlanState.artifacts` (which also carries `specId`/`specVersion`) is in-memory only and gone after a reload, so the filesystem path is the only durable record.
- **UI:** opening the Workflow Palette posts `checkArtifactStaleness`; the response renders a small "Generated Artifacts" section above the phase rows — a warning banner + list for `stale` groups, a quiet green line per `current` group, and a note for untagged/unknown files. Nothing is deleted or regenerated automatically.
- **"🕓 History"** on the spec card posts `viewSpecHistory` → `git log --follow -p -- <spec path>` (via `child_process.execFile`, `cwd` = workspace root) rendered as a chat message. Not a git repo, or no history yet → a clear message, not a crash.

### 3.11 Chat Sessions & Lifecycle (Phase F, v0.9.0)

**Design choice:** chat session identity is deliberately independent of BPS identity (confirmed via clarifying question) — a session can span several specs, and a spec can be discussed across several sessions, so `ChatSessionMeta.specId`/`specVersion` are a breadcrumb recorded at creation time, not a live foreign key kept in sync.

**`ChatSessionManager` (`src/context/ChatSessionManager.ts`).** One class, mirrors the rest of `src/context/`'s pattern (atomic metadata writes, one class per concern):
- `.ai-context/chats/<id>.meta.json` — `{ id, createdAt, updatedAt, status: 'active'|'archived'|'discarded', specId?, specVersion?, llmProvider?, title? }`, written via the same temp-file→`rename` pattern as `SpecManager`/`SourceRegistry`.
- `.ai-context/chats/<id>.jsonl` — one `ChatMessage` (`{ role: 'user'|'ai'|'log', content, at }`) per line. `vscode.workspace.fs` has no append primitive, so `appendMessage` is read-modify-write (whole file re-read, message appended, whole file rewritten) — an accepted cost at realistic chat lengths rather than an engineered-around one.
- Exactly one session is `status: 'active'` at a time; `getActiveSession()` is `listSessions().find(s => s.status === 'active')`.
- Gitignored (`.ai-context/chats/`) — unlike the committed BPS, transcripts are local/exploratory by explicit decision.

**`webviewProvider.ts` wiring.**
- On `resolveWebviewView()`, after the spec manager initializes: construct `ChatSessionManager`, `initialize()`, `getActiveSession()` or `createSession()` if none exists, load its transcript. **Changed in v0.13.0:** if that transcript is non-empty, the session is folded (`startNewChat()` — archived, never discarded, and a fresh empty one takes its place) rather than posted as-is; only an empty session is posted directly via `chatSessionLoaded` (`{ meta, transcript }`). A reload/restart therefore never silently resumes a prior conversation into view — see CHT-2.
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

**Superseded by C4b (chat extraction):** a "distill this chat" Context Memory curation pass (LLM extraction of a transcript into graph nodes with `origin.source: 'chat'` provenance) is a separate concern from session persistence and has not been built; a fuller in-sidebar chat browser (search/tag/export/reopen) was scoped out of this pass, with the message-handling plumbing already in place for it.

### 3.12 Context Sync, Implementation Type & Plan Persistence (v0.10.0)

**Design choice:** reuse existing machinery rather than build parallel systems — spec→context sync reuses `SynthesisPipeline`/`GraphManager` (already built for registered-source ingestion), implementation-type classification reuses the deterministic keyword-evidence pattern `phaseInference.ts` already established, and plan persistence reuses `SpecManager`'s exact atomic-write-plus-history shape.

- **Context sync (closes the gap where nothing fed the approved spec's own content into the Context Layer).** `SynthesisPipeline.synthesizeFromSpec(spec)` maps `objectives`/`businessRequirements`/`dependencies` to `business_term` nodes and `constraints`/`assumptions` to `business_rule` nodes (STRICT / RECOMMENDED respectively), each stamped with `Origin.specId`/`specVersion`. It first calls `GraphManager.removeNodesBySourceRef('spec:' + spec.id)` so re-synthesizing on a later revision **replaces** the prior version's derived nodes rather than accumulating stale ones alongside them. Runs automatically inside the `approveSpec` handler — before `generatePlanFromSpec` is ever reachable — so the Context Layer is always current for the spec version a plan is about to be generated from. A durable, human-readable record is also written to `.ai-context/context/snapshots/<specId>.v<version>.md` (committed, unlike the transient `.ai-context/derived/graph.json`), capturing exactly what fed plan generation for that spec version.
- **`generatePlan`'s prompt now actually reads the Context Layer.** Previously only `chat`, `discoverNextAction`, and `synthesizeComprehensiveSpec` merged in `contextFileManager.buildContextPrompt()`; the `generatePlan` webview case passed the caller's raw (usually empty) `schemaContext` straight through. It now merges `buildContextPrompt()` the same way `chat` does, and `generatePlanFromSpec` does the same before delegating to `generatePlan`.
- **Implementation type (`src/core/implementationType.ts`).** `classifyImplementationType(spec)` scans the same spec-text corpus `phaseInference.ts` uses for keyword evidence of existing-system language (`existing`, `legacy`, `migrate`, `as-is`, …) vs. new-build language (`greenfield`, `from scratch`, `net new`, …); mixed evidence defaults to `brownfield` (the higher-risk assumption), no evidence defaults to `greenfield`. Computed at every spec draft/revision/synthesis point (`webviewProvider.applyImplementationType`), unless the user has explicitly overridden it (`setImplementationType` message → `implementationTypeOverridden: true`, preserved across later revisions rather than silently reclassified). Surfaced as a badge with a one-click flip in both the chat spec card and the Workflow Palette.
- **Phase applicability now considers implementation type and context.** `inferPhases(spec, implementationType?, contextSummary?)` — both new parameters are optional so existing callers are unaffected. A `brownfield` classification forces `discover` required by default (existing systems need assessment even absent explicit spec language) unless `scope.out` explicitly excludes it, which still wins. Note the **`unrequired` `PhaseStatus`** (§3.5) already *is* the Non-Applicable state the palette renders (dimmed, "⊘ Non-Applicable", with its `reason` string) — this section only widens what feeds the classification, it does not introduce a new status.
- **Plan persistence (`src/context/PlanManager.ts`).** Mirrors `SpecManager` exactly: atomic writes to `.ai-context/plan/plan.yaml`, every version-on-change archived to `plan/history/plan.v<n>.<status>.yaml`, restored into `AgentHub`'s in-memory `PlanState` on extension activation (`hub.loadPersistedPlan`) so the generated steps, inferred phases, status, and implementation type survive a VS Code reload — previously `PlanState` had no on-disk representation at all. `PlanState.artifacts` (execution-produced `GeneratedArtifact[]`) is **not** part of the persisted shape and remains in-memory-only, per §3.10's existing rationale for the artifact-folder spec-tagging scheme.
- **Artifact-level version history.** `ArtifactWriter.write()` now archives whatever previously sat at a given path to a `history/` subfolder before overwriting it, so re-running a step within the *same* `<specId>.v<version>` folder no longer silently discards the prior output — only cross-version staleness was tracked before (§3.10).

### 3.13 Multi-business-problem workspace (WS-2)

- **Identity.** A problem's folder is an auto-generated slug (`src/core/problemSlug.ts#generateProblemSlug`): the first five non-stop-words of the problem statement, kebab-cased, at most 48 characters, plus a 4-character random suffix, collision-checked against existing slugs. Creation is lazy: the folder is created on the first spec draft, because it can't be named before a problem statement exists.
- **`ActiveProblemManager`** (`src/context/ActiveProblemManager.ts`) owns `active-problem.json` (`{ problemId, activatedAt }`, atomic write) and `listProblems()`, a scan of every `problems/<id>/spec/business-problem.yaml` (id, statement, status, version, updated, active), newest first, skipping unreadable folders.
- **Context roots.** `SpecManager`, `PlanManager`, `TargetContextManager`, `SourceContextManager`, `MappingContextManager`, `SemanticLayerManager`, `PipelineSpecManager`, `AttachmentStore` and `ArtifactWriter` take an already-resolved `contextRoot`; the caller passes the active problem's folder (or `_unscoped`). `ContextFileManager`, `SourceRegistry`, `ChatSessionManager` and the ledger stay workspace-level.
- **Activation** (`webviewProvider.activateProblem`, at startup and on start/switch): `hub.resetForNewProblem()` (clears spec identity, inferred phases, implementation type — fuller than `resetPlan()`), removes the previous problem's spec-derived graph nodes, sets the context manager's active spec id (spec-scoped assertions of other problems stay in the ledger but are not projected, §5.5), re-points the hub's `PlanManager`/`ArtifactWriter` via `extension.ts#applyProblemRoot`, then initialises the problem's managers and re-synthesises an approved spec into the graph.
- **Webview actions:** `startNewBusinessProblem` (clears the pointer, full reset, archives the current chat, starts a new one), `switchBusinessProblem`, `listBusinessProblems` → `businessProblemsList` (palette's Business Problem section).

### 3.14 Lifecycle gates (ORC-3)

`AgentHub` is the single enforcement point; the UI only reflects state.
- `generatePlan(objective, schemaContext)` — reachable from several entry points — requires `state.specId` and `state.contextGateReady` before anything else; its body is `generatePlanInternal()`, which `generatePlanFromSpec()` calls after checking its own stricter preconditions (spec approved, business problem confirmed, context gate ready).
- `executePlan()` requires `state.planApproved` and `state.stagesConfirmed`. Both reset to `false` whenever a plan is generated, the inferred phase set changes (`inferPhasesFromSpec`) or a phase is overridden (`setPhaseOverride`).
- `approvePlan()` / `confirmStages()` persist through `PlanManager.patchGates()` (in place, not a new plan version).
- `BusinessProblemSpec.problemStatementApproved` is reset by every draft or revision synthesis; `approveBusinessProblem` sets it; `approveSpec` rejects while it is false.
- The context gate is `webviewProvider.computeContextGateStatus(spec)`: target context approved, and source context ready or not applicable; pushed to the hub with `setContextGateReady()` on every recomputation.
- UI: the palette's action button and the chat's contextual actions step through Confirm Business Problem → Approve → Approve Plan → Confirm Applicable Stages → Generate Artifacts as the flags change.

### 3.15 Discovery progress (BPS-2)

`src/core/discoveryProgress.ts#buildDiscoveryProgress(session, skills)` returns `{ turnCount, turnBudget, coveredFields, totalFields, skills: [{ id, name, status }] }`; `skillNameForField()` resolves a question's owning skill from `SkillDefinition.specFields`, not from the LLM's optional label. Every `specQuestion`/`specQuestions` message carries a `progress` snapshot and a `skillLabel` per question; the sidebar renders a topic line and progress bar per question bubble, and the palette shows a live per-skill checklist while discovery is active and no draft exists yet.

---

## 4. UI Architecture

### 4.1 Layout: Single-Column, Section-Based

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

### 4.2 Top Status Bar

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

### 4.3 Chat Stream

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

### 4.4 Context Drawer

A persistent, collapsible panel between the chat stream and input area:

- **Collapsed state**: 32px header showing summary stats
- **Expanded state**: Up to 260px showing entity chips organized by category
- **Categories**: Database Metadata, Business Context, Verified Queries
- **Chips**: Clickable pill-shaped elements that insert `@entityname` into the chat input
- **Actions**: Re-index button, Open .ai-context folder button

### 4.5 Slide-Out Settings Panel

Accessible via the ⚙ icon. Slides in from the right with a semi-transparent overlay.

**Inner tabs:**
- 🤖 **LLM Provider**: Card-based selection (Copilot, Claude Code, OpenAI, Anthropic, Azure OpenAI, Gemini, Ollama). Selecting a card auto-saves `activeLlmProvider` and updates the header pill immediately. The Copilot (`vscode.lm`) and Claude Code (CLI) cards are both no-API-key and share a consent toggle (auto-saves `languageModelProgrammaticConsent`); each card's **Test** button tests *that* provider regardless of which is active. Copilot adds Handoff; Claude Code adds a Detect button and an optional CLI-path field.
- 🔌 **Connections**: Platform cards (Snowflake, Databricks, BigQuery, Redshift, Synapse) with credential fields, Connect button, and Source Assessment button.
- ⚙ **Preferences**: Read-only mode, auto-documentation, telemetry, cache duration, query timeout.

### 4.6 Workflow Palette (Phase 3a)

Accessible via a 🧰 icon. Phase-organized action cards:

| Phase | Agents |
|-------|--------|
| 🔍 **Discover** | Source Assessment, Data Lineage, Quality Profiler, Current-State Architecture |
| 🎨 **Model** | STTM Mapper, Data Modeler, Business Glossary |
| 🔨 **Build** | Ingestion Pipeline, Transform Scaffold, DDL Generator, Orchestration |
| ✅ **Validate & Document** | SQL Validator, Test Generator, Documentation, Future-State Architecture |

Each card shows: icon, name, description, `[▶ Run]` button. Cards are disabled if prerequisites aren't met.

### 4.7 @-Mention System

Typing `@` in the chat input triggers an autocomplete dropdown populated from the context layer:

- `@orders` → resolves to `RAW_DB.PUBLIC.ORDERS`
- `@MRR` → resolves to the business term definition
- `@daily_active_users` → inserts the reference SQL

### 4.8 Slash Commands

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

### 4.9 CSS Design System

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

## 5. Context Layer

Requirements: CTX-*, GRD-*, STC-7 – STC-9; principles C1–C9. Engine code is in `src/engine/context/` and `src/engine/grounding/`; the host side is `ContextFileManager`, `GraphManager` and the context managers in `src/context/`.

### 5.1 Data model

**Graph nodes** (`src/engine/context/types.ts`) share an envelope: `id`, `type`, `label`, `description?`, `metadata`, `version`, optional `layer`, `status`, `aliases`, `tags`, `origin`, timestamps, and `supportedBy?` (assertion ids, set only by the projection).

| Node type | Interface | Notes |
|---|---|---|
| `table`, `semantic_view` | `TableNode` | `database`, `schema`, `fqn`, `isView` |
| `column` | `ColumnNode` | `dataType`, `isNullable`, `isPrimaryKey`, `isForeignKey` |
| `business_term` | `BusinessTermNode` | `formula?`, `mappedNodeIds` |
| `business_rule` | `BusinessRuleNode` | `ruleText`, `enforcementLevel` (`STRICT` \| `RECOMMENDED`) |
| `verified_query` | `VerifiedQueryNode` | `sql`, `dialect`, `tablesUsed`, `author?` |
| `metric` | `BaseNode` | first produced by the projection from live metric assertions (v0.29.0) |

Edges (`GraphEdge`): `contains` (table → column), `foreign_key`, `maps_to` (term → table), `uses_table` (query → table), `constrained_by` (rule → table), `derives_from` (declared, not yet produced — lineage is M1), `related_to` (projected relationships).

**`Origin`** (provenance on nodes and edges): `source` (`user | derived | system | llm | template`), `sourceRef`, `confidence?` (filled from trust by the projection), `extractor?`, `extractedAt?`, `specId?`/`specVersion?`, `environment?` (`source | target`), `connectionId?`, `reliability?` (`live-verified | best-effort-inferred`), `lastVerifiedAt?`.

**Current node ids** — `table-<fqn>` and `col-<fqn>.<column>` (sanitised), `biz-term-<slug>`, `biz-rule-<n>`, `verified-query-<slug>`, `spec-term-<specId>-…`/`spec-rule-<specId>-…`, `term:<slug>`/`metric:<slug>`/`rule:<assertionId>`/`rel:<assertionId>` for projected definitions. Phase K replaces these with namespaced, system-qualified ids and an alias map.

**Assertions** (`src/engine/context/assertions.ts`): `{ id (ULID), kind, subject[], predicate, value, statement, status, trust, evidence[], supersedes?, supersededBy?, validFrom, validTo?, verification?, specId?, createdBy, createdAt, flags?, reviewReason? }`. Kinds: `schema_fact, data_fact, key, grain, relationship, business_term, metric, business_rule, mapping, quality_expectation, decision, assumption, constraint, naming_convention, verified_query`. Each kind's `value` has an Ajv schema (`assertionSchemas.ts`; `validateAssertion()`). Trust → confidence: verified 1.0, confirmed 0.9, documented 0.8, inferred 0.5.

**Context documents** loaded from files are validated against `docs/schemas/context-envelope.schema.json`; `ContextValidator` dispatches the per-kind `definitions` on `kind` and reports content problems as warnings, never failures (CTX-6).

### 5.2 Loading and reindexing (`ContextFileManager`)

`src/context/ContextFileManager.ts`, constructed per workspace by `webviewProvider`. `loadAllFiles()`:
1. Clears the graph and loads the ledger. If the ledger has content, the graph starts as its projection; otherwise from `derived/graph.json` (the one-time migration source).
2. If `schema-graph.json` is newer than `derived/graph.json` (a live extraction happened), merges it: nodes with the same id or the same `origin.sourceRef` are replaced, everything else is kept. *(Keying by bare platform name is why a second schema of the same platform replaces the first — fixed in K.)*
3. Drops nodes previously loaded from business-context and verified-query files, and re-reads `context/business-context.yaml` and `context/verified-queries.yaml` (legacy root as fallback): terms keyed by name (`biz-term-<slug>`), rules by position, queries by name; `maps_to`/`constrained_by`/`uses_table` edges to tables found by fqn or label.
4. Calls `persistCompiledGraph()` (§5.3).

`SynthesisPipeline` (`src/context/SynthesisPipeline.ts`) adds nodes from registered sources (`sources.yaml`, rule-based extraction) and from an approved spec (`synthesizeFromSpec`: objectives, requirements and dependencies → terms; constraints and assumptions → rules; all with `origin.specId/specVersion`, replacing the previous version's nodes). Runtime facts (`setRuntimeFact`, e.g. connection status) are an in-memory, never-persisted slot rendered at the top of every pack.

### 5.3 Ledger, sync and projection (C1, C2; CTX-2)

- **Ledger** (`ledger.ts`, `AssertionLedger`): one JSONL file per writer session; event types `asserted, confirmed, rejected, superseded, verified, verification_failed, flagged_needs_review`, each with `id` (monotonic ULID), `assertionId`, `at`, `actor`, `causedBy`. `foldEvents()` sorts by event id and applies events on top of an optional snapshot — pure and deterministic, so file read order never matters. Mutators: `assert`, `confirm`, `reject`, `supersede`, `recordVerification`, `flag`; `compact({ prune })` writes `snapshot.json` and deletes event files only when pruning.
- **Sync** (`projection.ts#syncGraphToLedger`): every node and edge producers put in the graph is recorded as a *mirror* assertion (predicate `node`/`edge`, the node or edge itself as value). Trust comes from provenance (`live-verified` → verified, `llm` → inferred, from an approved spec → confirmed, otherwise documented); evidence from the origin (introspection, spec field, file). New → `asserted`; changed (comparing without timestamps and confidence) → new assertion with `supersedes` plus a `superseded` event; vanished → `rejected` with "no longer present in …"; a newer `lastVerifiedAt` from a live extraction → `verified`. Live business assertions about a changed or removed node are flagged for review (dependency walk). Unchanged graphs append nothing (idempotent migration).
- **Spec scoping:** an assertion with a `specId` is in scope only while that problem is active (`inSpecScope`): out-of-scope assertions are neither retracted by a sync nor projected.
- **Projection** (`projectGraph`): nodes and edges from live (`active`, `needs_review`) mirror assertions, in assertion-id order; live non-mirror terms, metrics, rules and relationships add `term:`/`metric:`/`rule:` nodes and `related_to` edges (or support an existing node). Each node/edge gets `supportedBy` and `origin.confidence` from its strongest supporter, and `lastVerifiedAt` from an introspection verification.
- **Choke point:** `ContextFileManager.persistCompiledGraph()` = sync → detect + flag conflicts → re-project into `GraphManager` → write `derived/graph.json`. Live discovery and Source Assessment (via the reindex after `schema-graph.json`), file ingestion (`ingestFileIntoGraph`), spec synthesis and the business-context files all reach the ledger through it. A ledger failure is logged; the graph is persisted regardless.
- **Subject resolution** (`createSubjectResolver`): node id, `term:`/`metric:` name, table fqn, `<fqn>.<column>`, or a label naming exactly one table; anything else stays as given and is flagged `unresolved_subject`.

### 5.4 Conflict detection (CTX-3)

`conflicts.ts#detectConflicts()` over `active`, `proposed` and `needs_review` assertions:
- **definition** — two definitions of the same business name (glossary-term mirrors, `business_term` and `metric` assertions; name normalised to letters and digits) whose formula/definition text differs after whitespace and operator normalisation;
- **value** — same kind + subject + predicate with different values (key/grain column lists compared case-insensitively);
- **declared_key** — a `key`/`primary` assertion whose columns differ from the table's declared primary-key columns.

`flagConflicts()` sends every *active* participant to `needs_review` once (idempotent); a declared schema fact is never flagged in a declared-key conflict. Conflicts are recomputed on every persist, not stored.

### 5.5 Context packs and retrieval (C5; GRD-1, GRD-2)

- **Retrieval** (`retrieval.ts`): `resolveText(text, graph)` finds qualified names, `<table>.<column>`, schema mentions ("the shop and crm schemas" → all their tables), table labels in prose (n-grams up to three words, singular/plural-insensitive; ambiguous labels match every candidate) and term/metric names. `expandNeighborhood()` is a BFS over edges in both directions with distance decay; `GraphManager.traverseNeighborhood()` delegates to it.
- **Pack building** (`contextPack.ts#buildContextPack(request, sources)`): seeds = explicit ids ∪ resolved text. No seeds → the project overview (byte-for-byte the pre-v0.30.0 dump: STRICT rules, first 20 tables, all terms, five query labels), which `ContextFileManager.buildContextPrompt()` returns. With seeds: hops per purpose (step 2, otherwise 1); score = relevance × trust weight (verified 1.0, confirmed 0.95, documented 0.7, inferred 0.4); mandatory sections first — warnings (conflicts and `needs_review` items touching the scope, context gaps), STRICT rules linked to the scope or naming a seed table or one of its columns, keys/grain on seed tables — then seed tables with columns, neighbours collapsed, relationships among tables in the pack, terms, verified queries. Budget per purpose (step 3000, plan and QA 2500, chat and spec 2000, interview 1500 tokens, estimated as characters ÷ 4); what doesn't fit is counted in `truncated`.
- **Manifest** (`PackManifest`): `packId` (content hash), purpose, mode, seeds, node ids, assertions with `assertionRevision()` (hash of content and status), truncation counts, token count, gaps, warnings.
- **Callers:** `webviewProvider.contextPackText(purpose, query, title)` for chat, plan, spec drafting/refinement/synthesis, phase inference, interview turns, Pipeline Spec synthesis and tool skills; `AgentHub` builds one per plan step through its `ContextPackProvider` (§7.4). `ContextFileManager` keeps the last 50 packs for "What the Agent Saw" (`renderPackManifest`).

### 5.6 Context gaps (C3; GRD-3)

`contextGaps.ts#detectRelationshipGaps()` looks for combination phrases between resolved tables — "<A> per/by/for each <B>", "join <A> to/with <B>", "<A> joined to <B>" — and computes the best join path (≤ 3 hops; the trust of a path is its weakest edge) over foreign-key and projected relationship edges plus proposed relationship assertions (as inferred). No path → gap `absent`; a path below the required trust (default confirmed) → `below_trust`. `describeGap()` phrases it as a question. Gaps are rendered as warnings in the pack and logged; decision gaps come from manifests (§5.7). Steps are not paused yet (C4b).

### 5.7 Grounding manifests, checks and staleness (C6; GRD-4 – GRD-7)

`src/engine/grounding/manifest.ts`:
- **`backDecisions(use, graph, assertions)`** — for each decision-bearing primitive parameter (name matches key/partition/grain/orderBy/incremental/watermark/join/dedup/merge), resolves the source table from `params.sourceObject` and finds the backing: a live key or grain assertion with the same columns, else the declared primary key's column mirror (key-like parameters); a live `decision` assertion naming the column (ordering/incremental). Records `backedBy`, `belowTrust` (keys need confirmed, other decisions documented) or `unbacked`.
- **`checkRules(content, rules, knownColumns)`** — STRICT masking rules naming known columns are machine-checked (every reference must sit inside a hash/mask function, or be an alias of one); other STRICT rules are `manual_review`.
- **`buildGroundingManifest()`** — artifact path, spec id/version/revision, step, agent, generation method, primitives, pack id, assertions with `usedFor` (decision parameter or `context`), decisions, overrides, gaps (pack gaps + decision gaps), and checks: identifiers and type compatibility via `sqlGrounding.ts` (pattern scanner, §11.2), decision counts, rule checks, warnings (`GROUNDING_UNRESOLVED`, `GROUNDING_TYPE`, `GROUNDING_UNBACKED`, `RULE_VIOLATION`).
- **`manifestStaleReasons()`** — a relied-on assertion that is superseded, rejected, under review or gone; **`explainManifest()`** — artifact → decisions → assertions → evidence; **`renderGroundingReport()`** — per-run summary.
- **Host side:** `ArtifactWriter.writeManifest()` writes `<file>.grounding.json` beside the artifact (archived like it); `webviewProvider.reportFactStaleness()` walks the problem's artifact folder for manifests (skipping `history/`) whenever staleness is checked and logs/posts `artifactFactStaleness`; spec-version staleness stays in `ArtifactStalenessScanner` (folder names `<specId>.v<n>`). Commands: `AutoDE: What the Agent Saw`, `AutoDE: Explain This Artifact`.

### 5.8 Source, target and mapping context (STC-1 – STC-9)

- **`SourceContext`** (`src/engine/types.ts`): one container per spec version with `sources: SourceContextEntry[]` (each with `connectionId`, method `connected`/`described`, connection summary); a pre-v0.19.0 flat file is migrated on load. **`TargetContext`**: platform, modelling approach, tools, naming, environment, location. Both are built from fixed question sequences (`src/core/targetContextQuestions.ts`, `sourceContextQuestions.ts`) whose answers carry keyword-evidence suggested defaults, and go `pending → built → approved`. Approving target context is the sole source of `AgentHub.setTargetEnvironment()`; greenfield marks source context not applicable automatically.
- **Versioning**: `version` bumps only when revising an approved predecessor of the same spec lineage; predecessors are archived to `context/history/{source,target,mapping}-context.spec<N>.v<M>.yaml`.
- **`MappingContext`** (`MappingContextManager`): `EntityMapping { id, sourceEntityId, sourceFqn, targetEntityId?, targetName, columns[{sourceColumn, targetColumn, transformExpression?}], notes? }` with pinned source/target context versions; `upsertMapping`/`removeMapping` drop an approved set back to `built`. `AutoDE: Create Mapping` picks source and target tables from the graph (or a typed target name for greenfield) and auto-matches columns by name.
- **Semantic layer snapshot** (`SemanticLayerManager`): an explicit, spec-pinned, versioned capture of graph content (`semantic-layer.yaml` + `.snapshot.json`, both archived together). Becomes the semantic model in C5.
- **Reliability** (STC-9): live extraction sets `confidence 1.0`, `reliability: 'live-verified'`, `lastVerifiedAt`; file ingestion sets `best-effort-inferred`; packs annotate file-derived tables. `AutoDE: Re-verify Source Schema` re-runs extraction and diffs source-tagged table fqns before/after (present, new, missing) without deleting anything.

### 5.9 File ingestion (STC-7)

`src/engine/context/fileIngestion.ts`, no dependencies, structural only:
- **CSV** — header + type inference from up to 200 rows (INTEGER, FLOAT, BOOLEAN, TIMESTAMP, STRING); quoted fields with commas and `""` escapes (no embedded newlines).
- **JSON** — an array of objects or one object; columns are the union of keys over up to 200 records (missing key → nullable).
- **DDL** — `CREATE TABLE` statements after stripping `--` and `/* */` comments; qualified names keep their schema/database (`shop.customers` ≠ `crm.customers`; unqualified → `ddl.<name>`); column defs split on top-level commas; constraint lines skipped; table-level `[CONSTRAINT x] PRIMARY KEY (a, b)` marks key columns.

Nodes carry `extractor: 'file-ingestion'`, `reliability: 'best-effort-inferred'`. `AutoDE: Ingest File as Source Context` parses, adds to the shared graph and persists through `ingestFileIntoGraph()` → `persistCompiledGraph()`.

### 5.10 Graph manager

`src/context/GraphManager.ts`: maps of nodes and edges with fqn, label and type indexes; a promise-chain mutex serialises mutations; `serializeSnapshot()`/`loadSnapshot()`; `removeNodesBySourceRef()`/`removeNodesWhere()`; `traverseNeighborhood()` (§5.5). The graph is a projection: the ledger is the system of record.

---

## 6. Data Platforms

### 6.1 Design Rationale

Different data platforms have fundamentally different:
- **Metadata tables**: Snowflake's `INFORMATION_SCHEMA` vs Databricks' `system.information_schema` vs BigQuery's region-qualified `INFORMATION_SCHEMA`
- **SQL dialects**: Snowflake SQL vs Spark SQL vs GoogleSQL vs T-SQL
- **Authentication**: Key-pair, OAuth, tokens, service accounts, external browser
- **Capabilities**: Column profiling, lineage extraction, CDC, streaming

The adapter pattern isolates these differences behind a common interface, so sub-agents never need platform-specific code.

### 6.2 IDataSourceAdapter Interface

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

### 6.3 BaseDataSourceAdapter (Abstract Class)

**File:** `src/engine/platform/BaseAdapter.ts`

Provides:
- Common `extractMetadata()` orchestration (tables → columns → FKs → profiling)
- `snapshotToGraph()` conversion (SchemaSnapshot → knowledge graph nodes/edges)
- Atomic `persistSchemaContext()` (temp file → rename)
- Abstract methods that each platform adapter must implement

### 6.4 Platform-Specific Adapters

#### SnowflakeAdapter (`src/engine/platform/adapters/SnowflakeAdapter.ts`)

| Aspect | Detail |
|--------|--------|
| Metadata | `INFORMATION_SCHEMA.TABLES`, `.COLUMNS`, `.REFERENTIAL_CONSTRAINTS`, `.VIEWS` |
| Lineage | `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` (optional) |
| Profiling | Per-column `COUNT(DISTINCT)`, null count, `MIN`, `MAX` |
| Auth | Key-pair, OAuth, username/password, external browser, MCP |
| Capabilities | metadata ✓, profiling ✓, lineage ✓, CDC ✓, streaming ✓, DDL ✓ |
| Dialect | Snowflake SQL (native) |

#### DatabricksAdapter (`src/engine/platform/adapters/DatabricksAdapter.ts`)

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

### 6.5 ConnectionManager

**File:** `src/engine/platform/ConnectionManager.ts`

| Method | Description |
|--------|-------------|
| `connect(platform, credentials)` | Disconnect existing, instantiate correct adapter, connect |
| `getActiveAdapter()` | Return current adapter or null |
| `extractMetadata(options?)` | Delegate to active adapter |
| `executeQuery(sql)` | Delegate to active adapter |
| `getCapabilities()` | Return active adapter's capabilities |
| `dispose()` | Disconnect and clean up |

Uses a `Map<DataPlatformProvider, AdapterFactory>` for adapter registration.

### 6.6 Type Definitions

**File:** `src/engine/platform/types.ts`

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

### 6.7 Target Environment Configuration (Phase 3b)

#### 6.7.1 Design Rationale

Data engineering workflows are inherently source→target. The source is discovered via the adapter layer (Phase 3a), but the target stack — platform, modeling approach, transformation tool, orchestration tool — must be defined by the user and maintained as a stable internal structure that all sub-agents can reference.

#### 6.7.2 TargetEnvironment Type

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

#### 6.7.3 Profile-Based Configuration

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

#### 6.7.4 Target Extraction

The orchestrator uses a dedicated LLM call to extract target stack details from user messages. If critical fields are missing, it prompts the user for clarification. Once extracted, the target config is persisted to `.ai-context/target-environment.yaml` and injected into all sub-agent execution contexts.

#### 6.7.5 Target-Aware Prompt Assembly

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

#### 6.7.6 Files

| File | Purpose |
|------|---------|
| `src/engine/types.ts` | `TargetEnvironment`, `TargetProfile`, `TargetConfigFile`, `GeneratedArtifact` types |
| `src/context/TargetConfigManager.ts` | Read/write/validate `target-environment.yaml` with profile inheritance |
| `src/core/agentHub.ts` | `extractTargetFromMessage()`, `buildTargetFromPartial()`, target-aware prompt assembly |
| `src/agents/build/IngestionPipelineAgent.ts` | Uses `targetEnvironment` for target-side DDL |
| `src/agents/model/SttmMapperAgent.ts` | Uses `targetEnvironment` for mapping output |
| `src/agents/validate/DocumentationAgent.ts` | Uses `targetEnvironment` for architecture docs |

### 6.8 Platform Onboarding & Credential Architecture (Phase 3a-i and 3a-ii implemented v0.16.0)

An architecture review (2026-09-17), deliberately done before the real-adapter work (CHANGELOG 0.15.0–0.17.0), designed how AutoDE discovers/reuses a locally-installed platform CLI (`snow`, `databricks`) and falls back gracefully otherwise — for both an interactive developer and a headless service account — without coupling the mechanism to Snowflake/Databricks specifically. Grounded directly in two existing facts: `src/core/claudeCodeAdapter.ts#resolve()` already implements the exact detection shape needed (3-tier cascade: explicit setting → PATH → bundled-extension; structured result, never throws), and `snowflake-sdk` (already a dependency) already reads the Snowflake CLI's own `connections.toml` natively via `createConnection()` called with no options. Both the credential-resolution foundation (Phase 3a-i) and the interactive onboarding UX (Phase 3a-ii) are now implemented, in `src/engine/platform/credentials/` and `webviewProvider.ts#connectToDataPlatform()` respectively. Phase 3b (real `snowflake-sdk`/Databricks-driver execution) is still not started.

**Two principals, one abstraction — implemented.** An interactive user at a workstation and a headless service account (CI, a scheduled job, a future server deployment) need different default paths, designed in together rather than one bolted onto the other later:

```typescript
// src/engine/types.ts
type PrincipalType = 'interactive-user' | 'service-account';
interface AuthModeDescriptor { mode: string; principalTypes: PrincipalType[]; }

// src/engine/platform/credentials/types.ts
interface CredentialReference {           // stored in settings/Target Context — never the secret itself
  platform: DataPlatformProvider;
  principalType: PrincipalType;
  ref: string;                            // a CLI connection/profile name, an env-var prefix, a secrets-manager path
  resolverId: string;                     // 'cli' | 'env' | 'vscode-secret-storage' | 'keyvault' | ...
}

interface CredentialResolver {
  readonly id: string;
  readonly supportedPrincipalTypes: PrincipalType[];
  resolve(reference: CredentialReference): Promise<Record<string, string> | undefined>;
}
```

`ConnectionManager.connect()`'s existing `Record<string,string>` credentials contract (§6.5) is **unchanged** — a resolver becomes the thing that *produces* it, upstream of where `ConnectionManager.getCredentialsFromSettings()` does today (that migration itself is Phase 3b's job, not this sub-phase's — see below). `src/engine/platform/credentials/registry.ts` implements the module-level `registerCredentialResolver()`/`unregisterCredentialResolver()`/`resolveCredential()` extension point; `src/engine/platform/credentials/index.ts#registerDefaultCredentialResolvers()` wires the three built-ins up once, from `extension.ts activate()`:

- **`EnvVarCredentialResolver`** — documented `AUTODE_<PLATFORM>_<FIELD>` env vars (optionally `AUTODE_<PLATFORM>_<PROFILE>_<FIELD>` for a named profile), the simplest service-account path — no AutoDE-specific CI infrastructure, zero VS Code dependency. Full variable table in `engineering-onboarding-guide.md`'s Secrets section.
- **`CliConfigResolver`** — both platforms. For Snowflake, reuses `snowflake-sdk`'s native `connections.toml` loading rather than re-implementing a TOML parser: it only confirms the named connection exists (scanning for its `[name]` table header) and returns a `{connectionName, authMode: 'connections-toml'}` pointer, never the underlying field values. For Databricks (Phase 3a-ii), no vendor Node SDK with native `.databrickscfg` loading is chosen yet (that's Phase 3b's "new dependency"), so — for consistency with Snowflake's pointer-only contract — it likewise only confirms the named profile exists in `.databrickscfg` and returns `{profile, authMode: 'databrickscfg'}`, never the file's `host`/`token` values.
- **`VsCodeSecretStorageResolver`** — generalizes `ConfigurationManager`'s 3 hardcoded secrets (all Snowflake/LLM-specific) into one key scheme, `autoDataEngineeringHub.secret.<platform>.<principalType>.<profileOrRef>.<field>` (`secretStorageKey()`), covering whichever fields of a platform's credential set are actual secrets (e.g. Snowflake: `password`/`privateKey`/`privateKeyPassphrase`; Databricks: `token`/`clientSecret`). Additive alongside — not a replacement for — the 3 existing bespoke methods, which still serve today's settings-driven flow untouched.

Enterprise secrets managers (Key Vault, AWS Secrets Manager, Vault) are the documented `registerCredentialResolver()` extension point, not a shipped implementation — ship the interface, not every vendor; a unit test registers a fake resolver and drives it through `resolveCredential()` with no changes to `ConnectionManager`/either adapter.

**CLI detection (Phase 3a-ii — implemented)**, one `PlatformCliDescriptor` per platform (`src/engine/platform/credentials/PlatformCliDescriptor.ts`), same shape as `ClaudeCodeAdapter.resolve()` minus its "bundled with a VS Code extension" tier (there's no equivalent for a data-platform CLI):

```typescript
interface PlatformCliDescriptor {
  readonly platform: DataPlatformProvider;
  readonly binaryNames: { win32: string; default: string };
  detect(explicitPathSetting?: string): Promise<{ found: boolean; cliPath?: string; version?: string; source: 'setting'|'path'|'well-known-location'|'none'; error?: string }>;
  listConnections(cliPath: string): Promise<{ name: string }[]>;   // enumeration only — never opens a real connection
}
```

`cliDetection.ts#detectCliBinary()` implements the shared setting→PATH→well-known-directory cascade both descriptors use (the third tier added in §6.9 alongside live CLI testing); `cliRegistry.ts#getCliDescriptor(platform)` looks one up. **`SnowflakeCli`** shells out to `snow connection list --format json` purely to populate a picker — gated behind the new `dataPlatformCliConsent` setting, since (unlike detection's harmless version check) this actually invokes the vendor CLI; the *real* connection still goes through `snowflake-sdk`'s native `connections.toml` loading, never re-implemented by AutoDE. **`DatabricksCli`** deliberately sidesteps the unverified Databricks CLI subcommand surface entirely: `listConnections()` reads `.databrickscfg` directly (`databricksCfg.ts#readDatabricksCfgProfiles()`, a small ~40-line INI parser respecting `DATABRICKS_CONFIG_FILE`) instead of shelling out at all — no consent gate applies, since it's a local file read, not external-process execution. `detect()` (CLI presence/version) is still implemented independently for guided-install messaging.

**New command "AutoDE: Connect to Data Platform"** (`webviewProvider.ts#connectToDataPlatform()`, exposed via `triggerConnectToDataPlatform()`) — for the `interactive-user` principal type, requires an active business problem (`TargetContext` is spec-scoped): platform QuickPick → `detect()` → (Snowflake only) a one-time CLI-consent prompt → `listConnections()` → a QuickPick of found connections (or "enter credentials manually", falling back to the pre-existing Settings-panel/`testConnection` path) → resolves the chosen connection through the Phase 3a-i `cli` resolver → `ConnectionManager.connect()` for an immediate, staged-feedback test (`postLog` messages at every step, never a bare "Connection failed") → on success, saves platform + a new `TargetContext.credentialRef: {resolverId, ref}` pointer (merged onto any existing Target Context answers, `status` reset to `'built'`) via the pre-existing `TargetContextManager` — proving onboarding is a front door onto that model, not a parallel one. Choices use native VS Code QuickPicks, not a new bespoke webview wizard; staged feedback reuses the same `postLog`/`postMessage` channel every other chat-visible flow in `webviewProvider.ts` already uses.

**Service-account configuration (Phase 3a-ii — implemented)** is deliberately un-fancy: the `autoDataEngineeringHub.serviceAccountCredentialRef` setting (a JSON `{platform, resolverId, ref}` string) plus "AutoDE: Test Service Account Credential" to verify it resolves — no chat, no QuickPicker, no CLI-detection dialog, matching "a platform team scripts this once."

**Consent gating (decided):** `autoDataEngineeringHub.dataPlatformCliConsent` — a parallel, dedicated setting (not a broadened `languageModelProgrammaticConsent`), gating only an actual CLI shell-out (`SnowflakeCli.listConnections()`). CLI *detection* (a version-check shell-out) is exempt, mirroring `ClaudeCodeAdapter`'s own unguarded `--version` probe; `DatabricksCli.listConnections()` needs no gate at all since it reads a local file, never invoking an external process.

**`providerRegistry.ts` (§6.6-adjacent) is now consumed — implemented (Phase 3a-i).** Confirmed unconsumed anywhere outside its own module before this phase; `authModes` is now `AuthModeDescriptor[]`, and `getAuthModesForPrincipal(provider, principalType)` partitions by principal type (e.g. Snowflake `key-pair` → both, `oauth` → service-account, `external-browser`/`username-password`/`mcp` → interactive-user; Databricks `oauth-m2m`/`service-principal-token` → service-account, `oauth-u2m`/`personal-access-token` → interactive-user).

**A small, deliberate touch to two Phase-3b-owned stub files:** `SnowflakeAdapter.connect()`/`DatabricksAdapter.connect()` (`src/engine/platform/adapters/`) now also accept a CLI-derived, pointer-only credential (`connectionName` / `profile`) without requiring account/username/database or workspaceUrl/token — otherwise the CLI-derived onboarding path above could never demonstrate a working "connected" state today, since `CliConfigResolver` deliberately withholds those field values until Phase 3b's real execution reads them from the vendor's own config. `executeQuery()` on both adapters is untouched and still a stub.

**Known verification gap:** neither `snow` nor `databricks` was installed in the environment this phase was implemented in, so the "CLI found, real detection" path (`detect()` returning `found: true` against a genuine installed CLI) is implemented per each vendor's documented behavior but not verified against a live install. The "CLI not found" cascade, `.databrickscfg` parsing, and the Snowflake `connections.toml` presence-check are all verified against real files/mocked process output. The Databricks CLI-subcommand risk flagged in the original design is sidestepped by design (reading the stable config file instead of shelling out), not resolved by verification.

Requirement PLT-7; scheduled as phase DRV (roadmap).

### 6.9 Real Snowflake/Databricks Execution (Phase 3b, core implemented v0.17.0; on-demand driver + onboarding UI not yet implemented)

The original Phase 3b plan was to wire the pre-existing `snowflake-sdk` dependency and a new `@databricks/sql` driver into the stub adapters. That plan was revised twice, in-session, on concrete evidence: measuring `@databricks/sql`'s real transitive footprint (Thrift, Apache Arrow, Winston, OpenID Connect client, 8 platform-specific native "kernel" binaries) alongside `snowflake-sdk`'s (the full AWS SDK, Azure Identity/Storage, Google auth — for bulk-load staging AutoDE never uses) put the combined dependency-tree cost at **~120MB**, not the few MB first assumed. Direct REST access was then evaluated as the replacement — until real-world feedback surfaced two problems with making REST the *default*: Snowflake's SQL API v2 measurably underperforms for large-scale catalog metadata extraction (AutoDE's core workflow), and it's a distinct REST surface a real slice of enterprises disable or network-restrict separately from Snowflake's native protocol (the wire path Snowsight, JDBC/ODBC, and the `snow` CLI all use instead).

**Net design: neither SDK is a dependency. A priority cascade, not a single default:**

1. **CLI-derived connection, native protocol (Snowflake only)** — a `connectionName`-bearing credential (`CliConfigResolver`, §6.8) shells out to `snow sql -c <connection> --format JSON_EXT -q "<sql>"` (`src/engine/platform/executionBackends/SnowflakeCliBackend.ts`), gated behind `dataPlatformCliConsent` (the same setting §6.8 already gates connection *listing* with — now also gates connection *execution*). This rides Snowflake's native protocol, not the separate SQL API, so it isn't subject to the network restriction above, and carries zero bundle weight. **Databricks has no equivalent** — its CLI is a thin wrapper over the exact same Statement Execution REST endpoint used below, confirmed by research — so a `profile`-derived Databricks credential is rejected with an explanation (`DatabricksAdapter.connect()`) rather than silently failing on a missing workspace URL.
2. **On-demand native driver, opt-in — not yet implemented.** The planned second tier: fetch `snowflake-sdk`/`@databricks/sql` from the npm registry's own metadata API (authoritative latest version + integrity hash, never a hardcoded version or an LLM-guessed one) into extension global storage, only for a user who explicitly opts in via a platform-onboarding UI. This is what gives a Databricks user without CLI access — or a Snowflake user on a locked-down machine — a native-protocol option beyond REST. See the plan file for the full design; not built in this pass.
3. **Direct REST call (the always-available fallback)** — `src/engine/platform/executionBackends/SnowflakeRestBackend.ts` (SQL API v2 — PAT/OAuth bearer token, or a key-pair JWT built with `crypto.sign('RSA-SHA256', ...)` alone, `src/engine/platform/adapters/snowflakeJwt.ts`, no signing dependency) and `src/engine/platform/executionBackends/DatabricksRestBackend.ts` (Statement Execution API — PAT/OAuth bearer, `warehouse_id` derived from the configured HTTP Path's last path segment). Both poll a non-terminal (`202` / `PENDING`/`RUNNING`) response to a genuinely terminal state rather than checking once and assuming success — a real bug pattern found in a public Airflow-provider issue during research, deliberately avoided here.

Each adapter's `connect()` picks the backend once (CLI-derived credential → tier 1; direct credential → tier 3 today) and stores it behind a small shared `ExecutionBackend` interface (`src/engine/platform/executionBackends/types.ts`) that `executeQuery()` delegates to — nothing downstream (`BaseDataSourceAdapter.extractMetadata()`, `ConnectionManager`) knows which backend is active. `connect()` also now runs a real validation query (`SELECT CURRENT_DATABASE()...` / `SELECT current_catalog()...`) and fails fast with a clear error on a bad credential, rather than the previous stub's unconditional "connected" response.

**New Databricks settings surface** (previously nonexistent — `ConnectionManager.getCredentialsFromSettings()`'s databricks case referenced a settings key, `workspaceUrl`, that was never declared in `DataAgentHubSettings`): `defaultDatabricksWorkspaceUrl`, `defaultDatabricksHttpPath` (the SQL warehouse's HTTP Path — also the source `warehouse_id` is parsed from), `defaultDatabricksCatalog`, `defaultDatabricksSchema`, plus a proper `databricksToken` secret (`SECRET_KEYS`, `ConfigurationManager.getDatabricksToken()`/`setDatabricksToken()`) replacing an ad hoc raw-string secret key used in a few places. `extension.ts`'s `testConnection` and `webviewProvider.ts`'s `runSourceConnectionCheck()` both overlay it now (previously only `runSourceConnectionCheck()` did — a real, pre-existing asymmetry, fixed alongside this).

`ConnectionManager.getSupportedPlatforms()` (new) reads `providerRegistry.ts` intersected with which platforms have a registered adapter factory — `providerRegistry.ts`'s second real consumer after §6.8's `getAuthModesForPrincipal()`.

`src/spokes/snowflakeExecutor.ts` no longer hardcodes `username: 'DATA_AGENT_USER'` or duplicates connection logic against `snowflake-sdk` directly — it builds credentials the same way `testConnection` does and delegates to `SnowflakeAdapter`, so it automatically gets the same tier cascade.

**Known verification gap, same discipline as §6.8:** no live Snowflake/Databricks account is available in this environment — the REST/CLI backends are implemented against the confirmed, current API/CLI contracts (see the plan file's research citations) and covered by tests using mocked `fetch`/`child_process`, not a real warehouse. A real large-schema extraction to confirm the tier-1-vs-tier-3 performance difference reported during design is flagged as a follow-up, not done here.

**Live-verified against a real production Azure Databricks workspace** (the user's own, via `.databrickscfg` — credentials never left that process, never logged). This surfaced and fixed three real bugs no amount of documentation-reading would have caught: (1) Unity Catalog's `information_schema` lives at `<catalog>.information_schema.*`, not `<catalog>.system.information_schema.*` as originally written; (2) `information_schema.views` has no `comment` column, unlike `.tables`/`.columns`; (3) the Statement Execution API's `manifest.schema.columns[].type_name` is Spark's internal type name, not SQL type text — a `BIGINT` column reports `type_name: "LONG"`, which `DatabricksRestBackend`'s value-casting now accounts for. Full `connect()` → `extractMetadata()` (with profiling) verified end-to-end against a real Unity Catalog catalog.

**Catalog-type handling is explicit-first, not silently inferred.** The same live workspace has both a legacy `hive_metastore` catalog (no `information_schema` support at all — confirmed live; only `SHOW TABLES` works, and Spark SQL can't reshape a `SHOW` command's output via `SELECT`/`WITH`, so bulk column/FK/view introspection isn't expressible as a single static query there) *and* dozens of real Unity Catalog catalogs, side by side. Rather than always inferring which shape applies from the catalog name, `defaultDatabricksCatalogType` (`'auto' | 'unity' | 'hive_metastore'`) lets a user state it explicitly per connection — `'auto'` (default) still infers from the reserved `hive_metastore` name for zero-config use, but an explicit setting always wins, and doubles as a manual escape hatch for any other catalog (a Lakehouse Federation catalog, an attached external Iceberg REST catalog, etc.) that turns out to share the legacy catalog's limitations, without AutoDE needing to special-case it by name. `BaseDataSourceAdapter.assembleTables()` also now recognizes Databricks' native `SHOW TABLES` column names (`database`/`tableName`) as a fallback, and `extractMetadata()`'s table/column listing steps are non-fatal (matching the FK/view/lineage steps' existing resilience) rather than aborting the whole extraction.

**On Polaris/Iceberg-federated catalogs specifically:** not independently live-verified (no such catalog was available to test against), but by design, any catalog that Unity Catalog or Snowflake itself manages — including an external Iceberg REST catalog (Apache Polaris, Snowflake Open Catalog) attached via Lakehouse Federation or a Snowflake Catalog Integration — is unified into that platform's own normal catalog/database model from a SQL client's perspective, so the existing Unity Catalog / Snowflake `INFORMATION_SCHEMA` queries should apply unchanged. `defaultDatabricksCatalogType`'s `'hive_metastore'` setting is available as an override if a specific federated catalog turns out not to behave that way in practice.

**Chat had zero awareness of a live connection, and the top status pill never updated after a successful connect — both real, both fixed.** Two separate "Connect" actions exist: the settings-panel "Connect" (`testConnection`) only proves connectivity; a full schema extraction only happens via the separate "Source Assessment" button, or via the Palette's "Connect to Data Platform"/`runSourceConnectionCheck` flow (which does both in one step). A user who only clicks the first "Connect" — the natural first thing to try — gets a real connection but a chat that still has nothing to say, since (a) `sidebar.html`'s `sendMessage()`/`generatePlan` slash command both hardcoded `schemaContext: ''` unconditionally, always, regardless of anything the user did (dead parameter — real schema context, once extracted, actually reaches chat through `ContextFileManager.buildContextPrompt()`'s `repositoryContext` instead, fed by `.ai-context/schema-graph.json` via a `FileSystemWatcher`-triggered reindex), and (b) nothing at all told the LLM a live connection even existed short of a full extraction, so it answered as if AutoDE had no database capability whatsoever. Fixed with a new `DataAgentHubWebviewProvider.connectionStatus` field, set via a public `notifyConnectionStatus()` called from `extension.ts`'s `testConnection`/`sourceAssessment` commands and from `runSourceConnectionCheck()` — driving both the top-of-panel status pill (`connDot`/`connLabel`, previously grabbed via `$()` but never once updated after being declared — confirmed dead UI) and a new always-included one-line chat context fact ("Connected to X, no schema extracted yet — suggest Source Assessment" when `ContextFileManager.getContextStats().tables === 0`, or the real detail once it's non-zero). This doesn't merge the two "Connect" actions or replace `repositoryContext` as the real schema-carrying channel — it just makes the gap between "connected" and "schema known" visible and self-explanatory instead of silent.

**A pasted folder path was silently accepted as if it were the binary, then failed with a confusing `ENOENT`.** Once the field above existed, live testing immediately hit it: `fs.existsSync()` can't tell a directory from a file, so an explicit `snowflakeCliPath` pointing at the CLI's *folder* (a completely natural thing to paste — e.g. from Explorer's address bar) was accepted as "found," and `spawnSync` then tried to execute the directory itself. `detectCliBinary()`'s explicit-setting branch now uses `fs.statSync()` first: a file is used as-is (unchanged behavior); a directory is auto-completed to `<folder>/<binName>` and re-checked as a file before being accepted.

**A configured `snowflakeCliPath` never actually reached the settings-panel connection flow — two real, separate drops, both fixed, plus a UI field added.** The setting itself (used correctly by the "Connect to Data Platform" QuickPick flow) was silently absent from `ConnectionManager.getCredentialsFromSettings()`'s snowflake case, so `SnowflakeAdapter.createCliBackend()`'s `this.credentials['snowflakeCliPath']` was always empty via the settings-panel "Connect" button, regardless of what was configured. It was also missing from `webviewProvider.ts`'s `updateSettings` field whitelist, so even a value the webview *did* send would have been silently dropped rather than persisted. Both fixed, and `media/sidebar.html`'s Snowflake card gained a "Snowflake CLI path (only if not found automatically)" field — directly closing the gap surfaced by this session's own CLI-detection work (§6.9): a real install on a non-default drive (`D:\Program Files\Snowflake CLI\`) is exactly the case the well-known-directory tier can't reach, and until now the only way to supply the explicit path was hand-editing Settings JSON.

**Consent gate now offers to fix itself instead of sending the user to Settings JSON.** Username/password auth's CLI path (below) needs the same `dataPlatformCliConsent` a CLI-derived connection already required — live testing hit exactly that on a first attempt. `extension.ts`'s `testConnection` command now recognizes that specific error and offers a `showErrorMessage` action, "Enable CLI Consent & Retry", that flips the setting via `configManager.updateSettings()` and immediately re-invokes the command — no manual Settings-search round trip.

**Non-secret fields already prepopulate on load (confirmed, not a gap); a secret field's *presence* now does too, without ever exposing its value.** `settingsLoaded`'s payload (now built once via a shared `buildSettingsMessagePayload()`, previously duplicated across two call sites) adds `snowflakeHasPassword: boolean` — computed from whether `configManager.getSnowflakePassword()` returns a value, never the value itself. `sidebar.html`'s password field placeholder changes accordingly ("Password already saved — leave blank to keep it..." vs the generic prompt), so a returning user can tell a password is on file without it ever being rendered back into the page — the write-only design (§ above) is preserved, only its *presence* is now visible.

**Three real bugs found live-testing the settings-panel "Connect" button, all fixed.** (0) "Connect" (`testConnBtn`) fired the `testConnection` command directly, which only ever reads already-*saved* VS Code settings — so typing Account/Username/Password into the form and clicking Connect without a separate "Save Settings" click first always failed with a stale "Missing credentials" error, even with the fields visibly filled in. Fixed by having "Connect" save first and chain off the extension's existing `settingsSaved` acknowledgment (not a fixed delay, which would race the actual persistence) before firing `testConnection` — `media/sidebar.html`'s `pendingTestConnectionAfterSave` flag. (1) The webview's "Connecting to database…" chat message was never followed up: the `testConnection` VS Code command it invokes only ever reported outcomes via native `showErrorMessage`/`showInformationMessage` popups, which the webview has no way to see — so the chat bubble looked permanently stuck regardless of whether the connection actually succeeded or failed. Fixed by adding `DataAgentHubWebviewProvider.logToChat()` (a thin public wrapper around the existing private `postLog()`) and having `extension.ts`'s `testConnection` command call it alongside each native notification, and by threading it through as `ConnectionManager`'s own log callback so in-progress connection messages reach the chat too, not just the final result. (2) Both `extension.ts`'s `testConnection` and `webviewProvider.ts`'s `runSourceConnectionCheck()` hardcoded Warehouse *and* Database as always-required for Snowflake — stale duplicated validation that never matched `SnowflakeAdapter`'s actual requirements (Database matters only for the REST tier; Warehouse isn't required by any path, since Snowflake falls back to the account's default warehouse) and drifted further out of sync once the username/password CLI path below was added. Narrowed both to only Account + Username — the two fields every Snowflake path genuinely needs — and left everything else to `SnowflakeAdapter.connect()`'s own accurate, path-specific error.

**Username/password auth, wired end-to-end through the UI into SecretStorage into a real execution path.** A `sfPassword` field was added to the Snowflake card in `media/sidebar.html` (the "Username + Password" auth mode already existed in the dropdown, but had no password input at all — a real, pre-existing gap). It's write-only by design: never re-populated from `settingsLoaded` (which only ever carries `ConfigurationManager.getSettings()`'s plain settings, never a secret value), and only included in the `updateSettings` message when non-empty, so an untouched blank field on a later save can never overwrite an already-stored password with an empty string. `webviewProvider.ts`'s existing (previously dead — nothing in the UI called it) `message.snowflakePassword` handler stores it via `configManager.setSnowflakePassword()`, i.e. VS Code `SecretStorage` — the same mechanism `VsCodeSecretStorageResolver` (§6.8) already generalizes for other platforms/principal types. On the execution side: since Snowflake's SQL API (tier 3) categorically cannot authenticate with a plain username/password, `SnowflakeAdapter.connect()` now routes a `username-password`-mode credential with a stored password to a **new tier-1 variant** — `SnowflakeCliBackend` accepts either a named `connections.toml` connection or an ad-hoc `{account, username, password, warehouse?, database?, schema?, role?}` spec, shelling out to `snow sql --account ... --user ... --password ... -q "<sql>"` instead of `-c <connection>`. This still rides the native protocol and the same `dataPlatformCliConsent` gate as the named-connection path — it does not touch REST at all, since REST has no way to accept this auth mode. The one caveat, stated plainly rather than hidden: `--password` on a command line is briefly visible to anything on the same machine that can list process command lines (Task Manager/`ps`) for the life of that one short-lived `snow` process — an inherent property of the CLI's own supported flag, not something AutoDE introduces; the password is never logged, written to disk, or included in an error message by AutoDE itself, and still lives only in `SecretStorage` between runs. A credential with `authMode: 'username-password'` but no password yet stored falls through to REST and gets an explicit, actionable rejection naming exactly what's missing, rather than a silent or generic failure.

**Live-verified against a real installed Snowflake CLI, and a real CLI-detection gap fixed as a result.** `SnowflakeCli.listConnections()`'s `connection_name`-based parsing was confirmed byte-for-byte against real `snow connection list --format json` output. Executing a query via `SnowflakeCliBackend` against a real account then hit a genuine, legitimate Snowflake network policy — `"Incoming request with IP/Token ... is not allowed to access Snowflake"` — correctly surfaced as an actionable error rather than something to route around; it independently confirms this session's own rationale for preferring the CLI-native-protocol tier (a restricted network path is exactly the real-world condition tier 1 is designed around, whichever specific surface a given enterprise restricts). This same test exposed that `detectCliBinary()` (§6.8) only ever checked an explicit setting or `PATH` — a real install in a standard location (e.g. Snowflake's own Windows installer default, `Program Files\Snowflake CLI\`) went undetected with neither configured. Fixed by adding a third, bounded tier: `detectCliBinary()` now accepts a `wellKnownDirs?: string[]` list of specific, documented install directories to check (not a filesystem or drive scan) between the `PATH` and `none` outcomes, reported as `source: 'well-known-location'`. `SnowflakeCli` supplies `%ProgramFiles%`/`%ProgramFiles(x86)%`/`%LOCALAPPDATA%\Snowflake CLI` on Windows and `/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin` on macOS/Linux; `DatabricksCli` supplies only the Unix paths, since no Windows default install location has been independently confirmed for it (guessing one would be worse than leaving it to `PATH`/the explicit setting). This deliberately does **not** cover every case — the real install verified here happened to be on a non-default drive (`D:\Program Files\...`, where `%ProgramFiles%` itself resolves to `C:\Program Files`), which only the explicit `snowflakeCliPath`/`databricksCliPath` setting reaches; that's an intentional boundary, not a gap, since a genuine directory/drive scan would be slow, unpredictable, and needlessly invasive for a VS Code extension to perform. Also fixed alongside: `SnowflakeCliBackend`'s error-detail extraction previously took the *first* 2000 characters of the CLI's combined output; live testing showed the CLI can emit a long, noisy internal traceback before its actual error box, which was getting truncated away. It now takes the *last* 2000 characters instead, so the actionable message survives truncation.

The on-demand driver acquisition tier and platform-onboarding checklist UI (Phase 3b-iv) remain not yet built — see this section's own notes above for what's implemented vs. deferred.

### 6.10 Runtime Context Unification (v0.18.0)

Live UI testing of the Phase 3b connectivity work above surfaced a structural bug, not a one-off: a successful live connection produced a chat response denying any database access, and the top status pill never updated. Root cause: "what does the LLM currently know" was assembled independently in ~7 different places (chat, `/plan`, `generatePlanFromSpec`, `generateSpec`/`refineSpec`, SpecOps discovery, codegen agents, `ToolSkillAgent`), each with its own gaps — two of the worst being a client-supplied `schemaContext` parameter `media/sidebar.html` hardcoded to `''` on every single chat/plan message (so it could never carry anything), and `generateSpec`/`refineSpec` including *no* context of any kind, not even repository content.

**Design: extend the existing `ContextFileManager.buildContextPrompt()` — already the closest thing to a unifying context object, since 5 of the 7 call sites already call it — with a generic, in-memory "runtime facts" slot**, rather than building a second, parallel context system:

```typescript
export interface RuntimeFact { label: string; text: string; }
// ContextFileManager.setRuntimeFact(key, fact | null) — never persisted to .ai-context/,
// cleared on reload by construction; buildContextPrompt() renders these under a new
// "## Live Session Facts" heading, ahead of the existing Enterprise Context Layer section.
```

`ContextFileManager` stays domain-agnostic — it doesn't know what "Snowflake" or "a connection" is, just generic `{label, text}` facts keyed by a caller-chosen string. This is the decoupling point: a fact *producer* (a connection command) and a fact *consumer* (a prompt-building call site) only need to know about this one shared object, never about each other. Because most call sites already call `buildContextPrompt()`, they gained runtime-fact awareness with zero code changes of their own.

**Connection status is now role-keyed (`source`/`target`), closing a second real gap found in the same investigation:** `ConnectionManager` (`src/engine/platform/ConnectionManager.ts`) is a strict single-connection-at-a-time model, and connection status used to be a single unlabeled slot that `connectToDataPlatform()` (the actual *target*-connection-test flow, tied to `TargetContext`) never even updated. `webviewProvider.ts`'s `notifyConnectionStatus(role, status)` now writes to both a `Record<'source'|'target', {...}>` (driving two status pills in `media/sidebar.html`'s top bar — `connPill`/`targetConnPill`) and `contextFileManager.setRuntimeFact('connection:'+role, ...)` (the LLM-facing side), from all four places a connection outcome becomes known: `extension.ts`'s `testConnection`/`sourceAssessment` (source), `webviewProvider.ts`'s `runSourceConnectionCheck()` (source), and `connectToDataPlatform()` (target — previously silent). A source-role fact also states plainly when no schema has been extracted yet, pointing at "Source Assessment," so chat can no longer claim it has zero database access while a connection is genuinely live.

**Also extended to two call sites that had the biggest gaps**, since the mechanism made it cheap: `AgentHub.generateSpec()` (used by both `generateSpec`/`refineSpec`) gained an optional `context?: string` parameter, now populated from `contextFileManager.buildContextPrompt()` by both webview call sites — previously these built a prompt from user input alone. `ToolSkillAgent.buildSkillSystemPrompt()` now includes `context.schemaContext` (previously ignored entirely by tool-executing skills), fed via a new optional `liveContext` parameter on `AgentHub.runToolSkill()` rather than the stale, plan-generation-scoped `this.state.schemaContext` it silently fell back to before. `generateWithLlm`/codegen agents' use of `AgentExecutionContext.schemaContext` was deliberately left untouched — it's plan-approval-scoped by design (captures schema *as of* plan approval), a different, intentionally-non-live semantic.

No generic pub/sub `EventEmitter` bus was introduced — confirmed zero usages anywhere in `src/` before this change, and none were added. The concrete problem (N prompt-builders reinventing context assembly) is solved by "N producers write one shared object, already-existing consumers read it," which is real decoupling without a new framework; a formal event bus remains a valid future layer if a second, non-prompt-building subscriber ever needs one.

**Files:** `src/context/ContextFileManager.ts` (`RuntimeFact`, `setRuntimeFact()`, `buildContextPrompt()` rendering), `src/core/webviewProvider.ts` (`connectionStatus` now role-keyed, `notifyConnectionStatus(role, status)`, `chat`/`generatePlan` cases simplified to a single `buildContextPrompt()` call, `draftSpec()`/`reviseSpec()`/`runToolSkill` call sites), `src/extension.ts` (`testConnection`/`sourceAssessment` pass `'source'`), `src/core/agentHub.ts` (`generateSpec(userInput, previous?, context?)`, `runToolSkill(skillId, instruction, liveContext?)`), `src/agents/build/ToolSkillAgent.ts` (`buildSkillSystemPrompt(skill, context)`), `media/sidebar.html` (dual `connPill`/`targetConnPill`, dead `schemaContext: ''` removed from `chat`/`/plan` messages).

**Two further real bugs found live-testing this mechanism end-to-end, both structural, both fixed at the source rather than patched around:**

1. **`ContextFileManager.loadAllFiles()`'s derived-graph/legacy-schema precedence was existence-based, not freshness-based — meaning a live extraction could never be read again after the very first extension activation, ever.** `persistCompiledGraph()` unconditionally (re)writes `derived/graph.json` at the end of *every* reindex, including the first one on a completely fresh workspace with zero nodes. The old logic was `if (exists(derived/graph.json)) use it; else fall back to schema-graph.json` — since `derived/graph.json` exists after that very first reindex, `schema-graph.json` (what `BaseAdapter.persistSchemaContext()` — i.e. Source Assessment — actually writes) became permanently unreachable from that point on, for any workspace, regardless of how many times a real extraction ran afterward. Fixed by comparing mtimes instead: whichever file is newer wins, so a fresh Source Assessment's `schema-graph.json` correctly wins over a stale compiled cache and gets folded back into `derived/graph.json` on the same pass.
2. **The Snowflake card's "Source Assessment" button was wired to a second, parallel, fake implementation that never touched a live connection at all.** `webviewProvider.ts`'s `case 'sourceAssessment':` didn't call `ConnectionManager.extractMetadata()`/`persistSchemaContext()` — it just disposed and re-initialized `ContextFileManager` (re-reading whatever was already on disk) and unconditionally reported success. The *real* implementation lived only in `extension.ts`'s `sourceAssessment` command, reachable from the Command Palette but never from the button a user would actually click. This is the same class of bug `testConnection`'s webview case had already been fixed for earlier in this session (delegate to the one real command, don't duplicate it) — `sourceAssessment` had simply never received the same fix. Fixed by making the command itself return its real outcome (`{success, tableCount?, viewCount?, error?}` instead of `void`) and having the webview case delegate via `vscode.commands.executeCommand()`, then force an immediate `ContextFileManager` reindex on success (rather than waiting on the debounced file watcher) so the freshly-extracted schema is available to the very next chat message.

**New: "AutoDE: Disconnect Data Platform" command + a Disconnect button** next to Connect/Source Assessment in the Snowflake card. Calls `ConnectionManager.disconnect()` and then `notifyConnectionStatus('source', {connected: false})` unconditionally (even if the adapter's own `disconnect()` throws, since the local handle is gone either way) — which, via the same mechanism as everything above, both flips the status pill red and clears the `connection:source` runtime fact, so chat immediately stops claiming a connection that no longer exists.

See the architecture plan (`after-phase-3b-are-graceful-lagoon.md`, Part 1) for the full context inventory and design rationale this implementation followed.

---

## 7. Agent Orchestration

### 7.1 The orchestrator (`AgentHub`)

`src/core/agentHub.ts` (`DataAgentHubHub`) owns plan state, LLM calls and the lifecycle gates (§3.14).

| Responsibility | Implementation |
|---|---|
| Plan generation | `buildPlanPrompt()` → LLM → `validatePlanResponse()` (unknown agents, duplicate ids, dangling or circular dependencies — topological sort — and steps outside the inferred required phases are rejected) |
| Dispatch | `AGENT_EXECUTORS: Record<AgentType, executor>` — a fixed table; the LLM chooses an agent type, never which function runs |
| Phase per agent | `AGENT_PHASE`: `sourceAssessmentAgent` → discover; `dataModelerAgent`, `sttmAgent` → model; `ingestionAgent`, `transformScaffoldAgent`, `snowflakeExecutor`, `toolSkillAgent` → build; `architectureAgent` → validate |
| Planner allow-list | `VALID_AGENT_TYPES` excludes `toolSkillAgent` (skills run only when invoked, SKL-3) |
| State | `PlanState` (steps, status, running step, artifacts, inferred phases, gates), persisted by `PlanManager` |
| Context per call | `ContextPackProvider` set by the webview (§7.4); falls back to the plan-time context string when none is set (tests, headless use) |

### 7.2 Agents

| Agent type | Module | Produces |
|---|---|---|
| `sourceAssessmentAgent` | `src/agents/discover/SourceAssessmentAgent.ts` | Discovery report; live extraction + persistence when connected (through `context.host`), otherwise a context-derived assessment |
| `dataModelerAgent` | `src/agents/model/DataModelerAgent.ts` | Target data model |
| `sttmAgent` | `src/agents/model/SttmMapperAgent.ts` | Source-to-target mapping |
| `ingestionAgent` | `src/agents/build/IngestionPipelineAgent.ts` | Ingestion code |
| `transformScaffoldAgent` | `src/agents/build/TransformationScaffolderAgent.ts` | dbt project scaffold |
| `architectureAgent` | `src/agents/validate/DocumentationAgent.ts` | Architecture document, data dictionary, DDL |
| `snowflakeExecutor` | `src/spokes/snowflakeExecutor.ts` | Executes SQL through `SnowflakeAdapter` |
| `toolSkillAgent` | `src/agents/build/ToolSkillAgent.ts` | Whatever an imported skill does (§7.6) |

Codegen agents use three tiers (GEN-1, GEN-2): `generateViaPrimitiveOrFallback()` (`src/agents/llmParamSelector.ts`) first asks the LLM to choose and parameterise a primitive (§9), then falls back to a freehand LLM call (`src/agents/llmCodegen.ts#generateWithLlm`), then to a fixed template. Primitive tiers are wired into the ingestion, STTM and transformation agents; the data model and marts are deliberately not forced into single-source primitives. (`src/spokes/{architectureAgent,ingestionAgent,sttmAgent}.ts` are not imported anywhere — leftovers to remove.)

### 7.3 Execution context and result

```typescript
interface AgentExecutionContext {
  objective: string;
  schemaContext?: string;              // the step's context pack + supplementary Source/Target Context
  sourceProvider?: DataPlatformProvider;
  targetEnvironment?: TargetEnvironment;
  settings: DataAgentHubSettings;
  configManager: { getSecret(key): Promise<string | undefined>; getSettings(): DataAgentHubSettings };
  log(message: string): void;
  addArtifact?(artifact: GeneratedArtifact): void;
  currentPhase?: WorkflowPhase;
  callLlm?(prompt: string, systemPrompt?: string): Promise<string>;
  runWithTools?(prompt: string, opts: AgentToolRunOptions): Promise<{ text; audit; provider }>;
  host?: AgentHost;                    // { workspaceRoot, confirm(message, actionLabel), fileIo }
  recordGeneration?(use: PrimitiveUse): void;   // called by the shared codegen path only
  transformSpec?: TransformSpec;       // compile this instead of asking the LLM
  workspaceRoot?: string; skillId?: string; skillInstruction?: string;   // tool skills
}
interface AgentExecutionResult { success: boolean; message: string; details?: Record<string, unknown>; error?: string; artifacts?: GeneratedArtifact[] }
```

`AgentHost` (built by `AgentHub.buildAgentHost()`) is how agents reach the host without importing `vscode` (§10.2).

### 7.4 Plan execution

`executePlan()`:
1. Checks the gates (§3.14); resets step statuses, step packs and run manifests.
2. Repeatedly picks a ready step (all dependencies completed). If none is ready but steps remain, marks every blocked step failed and stops. Honours a pause request before each step.
3. For the step: `contextProvider.buildPack({ purpose: 'step', query: step.taskDescription, stepId })`; records the pack (`getStepPack`, and the webview's recent-packs list); logs its context gaps; sets `schemaContext` = pack text + `contextProvider.supplementary()` (approved Source/Target Context).
4. Runs `AGENT_EXECUTORS[step.assignedAgent](step, context)`; generation records arrive through `recordGeneration`.
5. On failure: marks the step failed and continues with independent steps (ORC-5). On success: for each returned artifact — stamps phase and spec; replaces an entry the agent already added through `addArtifact()` instead of duplicating it; writes it with `ArtifactWriter`; builds a grounding manifest (§5.7) against the provider's sources, with the spec revision and model, and writes `<file>.grounding.json`; logs manifest warnings.
6. At the end — success or failure — writes the per-run Grounding Report (validation phase) when any manifest was produced, then sets the plan status; on failure, `handleFailure()` offers a re-plan.

`ContextPackProvider` (`src/engine/context/contextPack.ts`) = `{ buildPack, sources, supplementary?, specRevision? }`; the webview implements it over `ContextFileManager`, `SpecManager` and the Source/Target context managers (`createContextPackProvider()`), and the eval harness implements it over the same classes.

### 7.5 Phase inference and implementation type

`src/core/phaseInference.ts` (pure): `inferPhases(spec, implementationType?, contextSummary?)` marks phases required from keyword evidence across the spec's text fields, honours `scope.out` exclusions, and forces discover for brownfield unless excluded; `buildPhaseDependencies()` prunes the discover → model → build → validate chain to the required set; `computePhaseStatuses()` derives live status (`completed`, `in-progress`, `blocked`, `pending`, `pending-review`, `unrequired`). Manual overrides (`setPhaseOverride`) are re-applied after every inference and cleared by `resetPlan()`. `src/core/implementationType.ts#classifyImplementationType()` uses the same evidence technique; a user override survives revisions.

### 7.6 Tool-executing skills (SKL-1 – SKL-4)

- **Import:** `AutoDE: Import Tool Skill` copies a folder containing `SKILL.md` into `.ai-context/skills/tool-skills/<id>/`; `src/engine/skills/toolSkills.ts` parses it leniently (optional YAML frontmatter: `name`, `description`, `allowed-tools`; the body becomes the instructions) into a `ToolSkillDefinition`.
- **One execution path for every provider (v0.28.0):** `ToolSkillAgent` builds the prompt (skill instructions, resources list, step context) and calls `context.runWithTools()`, which `AgentHub.runConfiguredLlmWithTools()` implements as one `getLlmAdapter(provider).complete(...)` with a tool mode. Each adapter runs its own loop (§8): OpenAI-compatible (OpenAI, Azure OpenAI, Ollama), Anthropic, Gemini and Copilot loops execute AutoDE's tools; Claude Code runs its CLI loop.
- **Allow-list:** `src/engine/skills/toolAllowList.ts#resolveAllowedToolNames()` maps declared `allowed-tools` (e.g. `Read`, `Grep`, `Bash(git:*)`) onto AutoDE tools (`autode_read_file`, `autode_search_files`, `autode_list_dir`, `autode_write_file`, `autode_run_command`). Nothing declared → no extra restriction; declared but unrecognised → no tools. `toolModeCeiling()` never grants `full` to a skill with no write/exec tool. `toolSpecsForMode(mode, allowed)` (`src/core/agenticTools.ts`) builds the offered tools; `executeAgenticTool` refuses (and audits as `denied`) any call to a tool the run wasn't offered.
- **Sandbox and approval:** paths resolve against the workspace root and are rejected if they escape it; commands run with the workspace as cwd; each write or command on an AutoDE-owned loop asks for confirmation. Every call is appended to `LlmCompleteOptions.auditSink` and returned as `details.audit`.
- **Claude Code:** the CLI's `--tools` list is narrowed to the allow-list (`autode_read_file` → `Read`, `autode_search_files` → `Grep`, `autode_list_dir` → `Glob`, `autode_write_file` → `Edit` + `Write`, `autode_run_command` → `Bash`); `--permission-mode acceptEdits` only when a write tool remains. The whole run is approved once with caller-supplied text (`approvalPrompt`) stating that individual calls can't be audited or blocked.
- **Invocation:** `/skill <id> <instruction>` in chat, or `AutoDE: Run Tool Skill`; `AgentHub.runToolSkill()` runs it as a single step outside the DAG, with a `step`-purpose pack built from the instruction.

---

## 8. LLM Integration

### 8.1 Adapter Registry (Phase C, v0.9.0)

**Problem this replaced:** adding or changing an LLM provider used to mean editing an if/else chain in `agentHub.callConfiguredLlm` (~90 lines mixing dispatch, consent-gating, and per-provider request shaping) *and* keeping a separate, already-drifted-stale metadata table (`providerRegistry.ts`'s `LLM_PROVIDER_REGISTRY` — still said `claude: 'Claude (VS Code)'` after that provider became the Claude Code CLI) in sync by hand.

**What's there now:**
- **`src/core/llmAdapter.ts`** — the `LlmAdapter` interface (`id`, `displayName`, `requiresApiKey`, `supportsCustomEndpoint`, optional `supportsToolExecution`, and `complete(prompt, opts, ctx)`), the `LlmAdapterContext` interface (the narrow slice of extension-host services an adapter needs — `getSettings`/`getLlmApiKey`/`getExtensionContext`/`getWorkspaceRoot`/`log` — decoupled from `DataAgentHubHub` so adapters are constructible/testable standalone), and the shared `extractJsonText()` helper (moved out of `agentHub.ts`, still used by both the adapters and by `agentHub`'s own JSON-parsing call sites for discovery/synthesis actions).
- **`src/core/llmProviders.ts`** — one small class per provider implementing `LlmAdapter`. `CopilotLlmAdapter`/`ClaudeLlmAdapter` delegate to `languageModelAdapter.ts`/`claudeCodeAdapter.ts` (unchanged internals — this refactor only touched the *dispatch*, not the transports); the five `fetch()`-based providers were moved verbatim out of `agentHub.ts`. `LLM_ADAPTERS: Record<LlmProvider, LlmAdapter>` + `getLlmAdapter(provider)` (falls back to `ollama` for an unrecognized provider — preserving the old chain's implicit default) are the **single source of truth** for "which LLM providers exist."
- **`agentHub.callConfiguredLlm`** is now: resolve settings → `getLlmAdapter(provider).complete(prompt, {model, systemPrompt, justification, allowTools}, this.buildLlmContext())` — a lookup, not a branch. `providerRegistry.ts`'s LLM-facing functions are now thin deprecated wrappers reading `LLM_ADAPTERS` (nothing in `src/` actually calls them — flagged, not removed, in case a future caller wants that shape).
- **Deliberately not done** (per the scoping decision): the UI (`media/sidebar.html`'s hand-authored provider cards), the `package.json` settings-schema enum, and `webviewProvider`'s settings-validation guard were **not** unified into this registry — adding a provider still touches those three by hand (GEN-3). Also not attempted: a fully config-driven "describe a new REST provider in JSON, zero code" mechanism — `copilot`/`claude` fundamentally need code (in-process API / subprocess), so a generic template would only cover a subset of providers while adding its own abstraction cost.

### 8.2 Multi-Provider Model

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

### 8.3 LanguageModelAdapter (provider `copilot`)

**File:** `src/core/languageModelAdapter.ts` (`src/core/copilotAdapter.ts` = re-export shim; `CopilotAdapter` is a back-compat alias)

| Feature | Implementation |
|---------|---------------|
| Detection | Searches for the `github.copilot-chat` extension |
| Model selection | `vscode.lm.selectChatModels({ vendor: 'copilot' })`; preferred model matched loosely against `activeLlmModel` |
| Consent gate | `languageModelProgrammaticConsent` (legacy `copilotProgrammaticConsent` honored as fallback) |
| Request | `model.sendRequest(messages, { justification })`; system prompt sent as a leading Assistant message |
| Timeout | 30s default / 60s from `callConfiguredLlm` via `Promise.race` |
| Enumerate | `listAll()` → every `vscode.lm` model + vendor (used by `listLanguageModels`) |

### 8.4 ClaudeCodeAdapter (provider `claude`)

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

### 8.5 Chat vs. Plan Routing

| Path | Method | Prompt Style | Response Handling |
|------|--------|-------------|-------------------|
| **Chat** | `hub.chat()` | Conversational assistant | Raw text returned to UI |
| **Plan** | `hub.generatePlan()` | Strict JSON DAG format | Parsed + validated as `PlanStep[]` |

### 8.6 Prompt Engineering

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
`requiredPhases` — both previously deferred to execution time or unenforced entirely (v0.10.0).

### 8.7 Tool loops and audit (v0.28.0)

Tool use goes through one interface: `LlmCompleteOptions` carries a tool mode, `allowedToolNames` (the allow-list, §7.6), an `auditSink` that every loop appends each `ToolCallAuditEntry` to, and an optional `approvalPrompt` for runs the provider can't audit per call. The OpenAI-compatible loop (OpenAI, Azure OpenAI, Ollama), the Anthropic, Gemini and Copilot loops all use `toolSpecsForMode(mode, allowed)` and `executeAgenticTool` from `src/core/agenticTools.ts`; the result's `details.audit` carries the audit. Claude Code runs its own CLI loop: AutoDE narrows `--tools` and records nothing per call.

---

## 9. Deterministic Execution Core & Pipeline Specification

v0.14.0. Requirements: P1, P2, GEN-2 – GEN-4.

### 9.1 The problem this closes

Before this phase, plan-step *dispatch* was deterministic (a fixed `AGENT_EXECUTORS` lookup table, §7.4) but step *content* was entirely LLM-freehand (`src/agents/llmCodegen.ts#generateWithLlm` — an LLM writes the actual SQL/dbt text, a generic non-schema-aware template only as a last-resort fallback), and AutoDE had no artifact playing the role of a compile-ready, per-entity spec — the BPS (§3) is a requirements document, not one.

### 9.2 Transform primitives (`src/engine/transforms/`)

```typescript
interface TransformPrimitive<TParams = Record<string, unknown>> {
  kind: PrimitiveKind;                 // 'rename_cast' | 'dedup' | 'incremental_load' | (string & {})
  description: string;
  paramSchema: object;                 // Ajv JSON Schema
  status?: PrimitiveLifecycleStatus;   // Tier 2 only — see 12.5
  version?: number;                    // Tier 2 only — see 12.5
  compile(params: TParams, target: TargetEnvironmentSummary, dialect: SqlDialect): CompiledArtifact;  // pure, no LLM call
}
```

`PrimitiveKind` is an "open union" (`'rename_cast' | 'dedup' | 'incremental_load' | (string & {})`) — keeps autocomplete for the 3 Tier-1 kinds while accepting any runtime-loaded Tier-2 `kind`.

**Two tiers, one interface, one registry (`registry.ts`):**
- **Tier 1** (code, reviewed): `rename_cast` (staging casts/renames, plus a `dbt_model` output mode), `dedup` (`ROW_NUMBER()`, dialect-aware `EXCLUDE`/`EXCEPT`), `incremental_load` (keyed `MERGE`). Registered at module load into `TRANSFORM_PRIMITIVES: Record<string, TransformPrimitive<any>>`.
- **Tier 2** (declarative, `declarative/`): a `PrimitiveDefinition` YAML (`kind`/`version`/`status`/`paramSchema`/`platformTemplates`/`previewParams`/`outputChecks`) whose `compile()` is a rendered template, not code — `templateEngine.ts` is a hand-rolled, deliberately constrained engine (`{{param}}`, `{{join arr ", "}}`, `{{#each}}...{{/each}}`, no `eval`/`Function()`) so a definition author cannot smuggle code execution into the compile path. `loadPrimitiveDefinitionsFromDirectory()` + `mergePrimitiveDefinitions()` mirror `skillRegistry.ts#loadSkillsFromDirectory` exactly — bundled `primitive-definitions/` + `.ai-context/primitives/` override, later wins. `registerPrimitives()` merges Tier 2 into the same `TRANSFORM_PRIMITIVES` map; Tier 1 always wins a `kind` collision.

**Selection (`src/agents/llmParamSelector.ts`):** `selectTransformSpec(context, step, candidateKinds, fixedParams?)` asks the LLM for *only* `{kind, params}` JSON against the candidate primitives' schemas, Ajv-validates, and returns `undefined` (never throws) on any failure — `fixedParams` (object names the caller already computed deterministically) are merged in *after* the LLM's response so they can't be overridden. `generateViaPrimitiveOrFallback()` wraps this as tier 0 ahead of the *unmodified* existing tier 1 (freehand LLM) / tier 2 (hardcoded template) fallback chain in `IngestionPipelineAgent`, `SttmMapperAgent`, and `TransformationScaffolderAgent`'s staging model — the 3 of 5 codegen agents where a single-source primitive is a genuine fit (not `DataModelerAgent`'s multi-table schema design, nor the marts model's multi-source joins).

### 9.3 The Pipeline Spec (`src/engine/pipelineSpec/`)

The compile-ready artifact the BPS was never meant to be. `additionalProperties: false` at **every** nesting level (top-level, each entity, `source`/`target`/`transforms`/`quality`/`governance` blocks) — the same recursive-strict Ajv pattern already used by `renameCast.ts`'s `paramSchema`, not the deliberately-open `context-envelope.schema.json` family (§5.1/context-envelope is for flexible knowledge-graph content; this is a machine-compile contract, a different lineage).

```yaml
specVersion: 1        # schema-of-the-schema version — separate from the document's own `version`
id: pipeline-<slug>
version: 1
status: draft | approved
derivedFromBpsId: bps-...
derivedFromBpsVersion: 2
targetPlatform: snowflake | databricks | ...
entities:
  - name: customers
    source: { object: RAW_DB.PUBLIC.raw_customers, type: table }
    transforms: [{ kind: rename_cast, params: {...}, primitiveVersion: 1 }]   # TransformSpec, §9.2, unchanged
    target: { object: CURATED_DB.STAGING.stg_customers, materialization: view }
    quality: { rules: [] }        # forward slot — Phase 6
    governance: { columns: [] }   # forward slot — Phase 6
```

- **`compiler.ts#compilePipelineSpec(spec, dialect)`** — the AutoDE analogue of the sibling framework's `interpreter.py`: runs each entity's `transforms[]` through the existing `compileTransformSpec()` (§9.2) in order, zero LLM calls. Deliberately **no freehand fallback** here (unlike §9.2's tiered chain) — a compile failure is a bug in an already-approved, already-Ajv-validated spec, not a coverage gap.
- **`designDocGenerator.ts#generateDesignDoc(spec)`** — a pure function producing Markdown (with a Mermaid `flowchart LR` lineage diagram) from a validated spec; same input always produces the same output, so the YAML and its Markdown projection cannot drift apart.
- **`context/PipelineSpecManager.ts`** — persistence modeled function-for-function on `SpecManager.ts` (§3): `.ai-context/problems/<id>/spec/pipeline.yaml` + `spec/history/pipeline.v<version>.<status>.yaml`, atomic temp-then-rename writes, `approve()` doesn't bump version (a draft v1 becomes approved v1), a new revision from an approved predecessor does. A document whose `specVersion` doesn't match `CURRENT_PIPELINE_SPEC_VERSION` loads leniently (a logged warning, not a thrown error) — schema evolution must never brick an already-approved pipeline.
- **Synthesis (`src/agents/pipelineSpecSynthesis.ts` + `AgentHub.synthesizePipelineSpec()`)** — grounded in the approved BPS, the approved Target Context (platform/naming/tooling feed `targetPlatform` directly — confirmed via test that swapping Target Context's platform changes the generated spec with no BPS change at all), the approved Source Context, the Context Layer graph, and attachment extracts (§9.4). Retries up to 3 times, feeding the previous attempt's Ajv errors back into the next prompt (`buildPipelineSpecSynthesisPrompt(inputs, validationErrors?)`) — the same discipline `selectTransformSpec` (§9.2) already uses for one primitive, now applied to the whole document. Also the first real consumer of `BusinessProblemSpec.provenance` (§3.2): a field tagged `source: 'assumption'` is called out in the prompt for conservative treatment.
- **New command, "AutoDE: Generate Pipeline Spec"** — additive, not a replacement for §3.3's existing plan flow; gated on the same `computeContextGateStatus()` (§3.12) Generate Plan already requires.

### 9.4 Attachment structured extraction

Closes a real gap in the pre-existing `attachSpecFile` flow (§3.9): raw attachment text was appended verbatim to a prompt, never persisted past the discovery session, never tagged with provenance.

- **`core/attachmentExtraction.ts`** — `buildAttachmentExtractionPrompt()`/`parseAttachmentExtract()`, pure (mirrors the `specOpsPrompts.ts`/`specSynthesis.ts` split for the BPS itself) — `AgentHub.extractAttachmentFacts()` owns the actual LLM call and never throws, falling back to `fallbackAttachmentExtract()` (a plain text summary, `confidence: 'low'`) on any failure. Deliberately not a rigid, format-specific parser — an attachment could be a schema dump, a memo, anything.
- **`context/AttachmentStore.ts`** — persists `{raw content, extract}` to `.ai-context/problems/<id>/attachments/<id>.yaml`, atomic write, surviving past the ephemeral `IntakeSession` that created it.
- **`SpecProvenance.source`** gains `'attachment'` (+ `attachmentId`) — `specSynthesis.ts#buildProvenance` tags `sourceCatalog`/`dataFlows` this way when an entity-extracting attachment exists and no direct question already covers the field (a narrow, honest heuristic — there's no per-field attribution signal from the LLM's synthesis output for anything broader).

### 9.5 Primitive lifecycle & governance

```typescript
type PrimitiveLifecycleStatus = 'draft' | 'published' | 'deprecated' | 'retired';
```

- **UI:** sidebar Workflow Palette gains a "Primitives" section (`palettePrimitives`/`renderPalettePrimitives`) — chosen over a new panel or a 6th custom editor because the Dashboard panel has zero manager wiring and none of the 5 existing custom editors support write-back, whereas the palette's `paletteProblems`/`paletteSpec`/`paletteArtifacts` pattern (§4.6) already does exactly this shape of work. **Preview** is a plain `compileTransformSpec()` call — confirmed to need neither an LLM call nor `agenticTools.ts`'s agentic loop (§7.6), since rendering a template against sample params isn't LLM-directed at all.
- **Selectability:** `isSelectable(primitive)` = `!primitive.status || primitive.status === 'published'` — `selectTransformSpec()` (§9.2) filters `candidateKinds` through this before building the LLM's catalog and again before accepting its response. `compileTransformSpec()` is **not** filtered — a deprecated/retired primitive still compiles for anything that already references it; selectability only gates the LLM's future choice.
- **Version pinning:** `TransformSpec.primitiveVersion?: number`; `registry.ts` keeps a second map, `VERSIONED_PRIMITIVES: Map<kind, Map<version, TransformPrimitive>>`, independent of the live `TRANSFORM_PRIMITIVES` catalog. `resolvePrimitive(spec)` prefers an exact-version match when pinned, falling back to the live entry otherwise. `webviewProvider.ts#ensurePrimitivesLoaded()` also loads `.ai-context/primitives/history/` into this map (never into the live catalog) so an approved Pipeline Spec's pinned reference keeps resolving after a newer version is published.
- **Publish/deprecate (`declarative/lifecycle.ts`):** `publishPrimitiveDefinition()` — a first publish keeps `version` as-is (mirrors `SpecManager.approve()`'s "draft v1 becomes approved v1"); republishing an already-published definition bumps `version` and archives the prior revision to `history/`, same convention as `SpecManager`/`PipelineSpecManager`. Gated by `autoDataEngineeringHub.primitiveManagementEnabled` (default `false`, same opt-in pattern as `languageModelProgrammaticConsent`, §8.1) — the sidebar hides Publish/Deprecate entirely, not just disables them, when off.

### 9.6 Files

| File | Purpose |
|------|---------|
| `src/engine/transforms/{types,registry}.ts` | `TransformPrimitive` contract; the merged Tier 1 + Tier 2 catalog, version-pinned resolution |
| `src/engine/transforms/primitives/*.ts` | Tier 1: `renameCast.ts`, `dedup.ts`, `incrementalLoad.ts` |
| `src/engine/transforms/declarative/*.ts` | Tier 2: `types.ts`, `schema.ts`, `templateEngine.ts`, `loader.ts`, `adapter.ts`, `lifecycle.ts` |
| `src/agents/llmParamSelector.ts` | `selectTransformSpec()`, `generateViaPrimitiveOrFallback()` |
| `src/engine/pipelineSpec/*.ts` | `types.ts`, `schema.ts`, `validator.ts`, `compiler.ts`, `designDocGenerator.ts` |
| `src/context/PipelineSpecManager.ts` | Pipeline Spec persistence/versioning |
| `src/agents/pipelineSpecSynthesis.ts` | Prompt-building + response-parsing for Pipeline Spec synthesis |
| `src/core/attachmentExtraction.ts`, `src/context/AttachmentStore.ts` | Attachment structured extraction + persistence |
| `src/core/disposables.ts` | `DisposableRegistry` — real `deactivate()` (§8) |
| `docs/schemas/primitive-definition.schema.json` | `yamlValidation` contribution target for live-editing Tier-2 definitions |

---

## 10. Extension Architecture

### 10.1 Activation and lifecycle

`src/extension.ts#activate`:
1. Creates `ConfigurationManager` and the orchestrator (`DataAgentHubHub`); registers credential resolvers (`registerDefaultCredentialResolvers(context.secrets)`: environment, CLI configuration, VS Code SecretStorage).
2. Defines `applyProblemRoot(contextRoot)` — re-points the hub's `PlanManager` and `ArtifactWriter` at a problem folder — and applies `problems/_unscoped` until a problem is activated, so command-palette entry points work before the sidebar resolves.
3. Creates the sidebar provider (`DataAgentHubWebviewProvider`) and the parked dashboard panel; source and target `ConnectionManager`s are created lazily per role and disposed through the `DisposableRegistry`.
4. Registers every command (the full list is `contributes.commands` in `package.json`, all prefixed `autoDataEngineeringHub.`): plan and pipeline-spec generation, execution, reset; source/target connect, browse, assess, re-verify, disconnect; file ingestion; mapping and semantic-layer snapshot; ledger compaction; What the Agent Saw; Explain This Artifact; language-model tests and listings; Copilot handoff; tool-skill import/run; chat new/history/discard; Connect to Data Platform; service-account test.

The sidebar's `resolveWebviewView` then builds the context layer (`ContextFileManager`, `ContextFileWatcher`), registers the hub's `ContextPackProvider`, activates the problem named by `active-problem.json`, and folds a non-empty active chat into history (CHT-2).

`deactivate()` → `disposableRegistry.disposeAll()` (`src/core/disposables.ts`): watchers, connection managers and other resources registered during activation.

### 10.2 Engine boundary (v0.26.0)

- **Rule:** nothing under `src/engine/**` imports `vscode` — not even types (`.eslintrc.cjs`); a functional test loads every `dist/engine/**` module in plain Node. The engine is what the MCP server will expose (mcp-engine-requirements §4).
- **Host concerns pass in as parameters or interfaces:** `FileIo` for files (§2.3); `AgentHost { workspaceRoot, confirm(message, actionLabel), fileIo }` for agents; `AbortSignal` instead of VS Code cancellation tokens in platform `QueryOptions`/`ExtractOptions`; Snowflake CLI consent as a constructor option; the VS Code SecretStorage credential resolver lives in `src/core/credentials/`, the engine registers only `env` and `cli`.
- **Persistence of live schema** moved from the adapter into `ConnectionManager.persistSchemaContext(snapshot, workspaceRoot, io)` (writes `schema-graph.json`; `snapshotToGraph()` is public).
- **Mocks in tests:** modules that import `vscode` capture the mock at load time; shared helpers that need the VS Code API take it as a parameter (e.g. `createVscodeFileIo(vscode)`) so per-module mocks don't leak.


### 10.3 WebviewProvider Message Protocol

**File:** `src/core/webviewProvider.ts`

| Message (Webview → Extension) | Handler | Description |
|------------------------------|---------|-------------|
| `chat` | `hub.chat()` | Conversational message |
| `generatePlan` | `hub.generatePlan()` | Generate execution plan — orchestrator-gated (ORC-3, v0.13.0): requires an active, context-ready business problem, or throws |
| `executePlan` | `hub.executePlan()` | Execute current plan — orchestrator-gated (ORC-3, v0.13.0): requires `planApproved` and `stagesConfirmed`, or throws |
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

### 10.4 Configuration Management

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

### 10.5 Registered Configuration Properties

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

## 11. Testing & Evaluation

### 11.1 Functional tests (NFR-9)

`npm test` compiles and runs `test/functional.test.cjs`: one runner (241 tests at v0.30.0) that loads the compiled `dist/` modules with a per-test `vscode` mock (`createMock()`, `withMock()`; modules are re-required with `fresh()` because they capture the mock at load time). Engine modules are tested in plain Node with no mock, which doubles as the engine-boundary check (§10.2). Coverage spans the context store and watchers, ledger/projection/conflicts, packs/gaps/manifests, file ingestion, the Snowflake/Databricks adapters and execution backends (mocked processes and `fetch`), credential resolvers and CLI detection, LLM adapters and tool loops (mocked models), the spec engine and synthesis, phase inference, plan validation and execution, managers' versioning/archiving, and the primitive registry and Pipeline Spec compiler. `npm run lint` must report no errors.

### 11.2 Evaluation harness (GRD-9; C7)

`npm run eval` (`test/eval/run-eval.cjs`) measures AutoDE on the reference problem in `test/reference/retail-orders/` (README there describes the fixtures and the five traps).

- **Runs real code headlessly:** `test/eval/lib/vscodeHost.cjs` is a `vscode` stand-in backed by the real file system (interactive prompts resolve to "declined"); AutoDE's compiled `dist/` modules run unchanged.
- **Systems under test** (`test/eval/sut/`): `baseline.cjs` (v0.26.0 behaviour: global dump), `ledger.cjs` (C2: ledger + conflict detection; proposes each scripted turn's facts from `golden/assertions.yaml` with outcome fields withheld, standing in for C4 extraction), `packs.cjs` (default, C3: per-step and per-question packs, the hub's context provider, an `ArtifactWriter` so manifests are written). A new phase adds an adapter and is scored on identical inputs; `--sut` selects one, which doubles as the ablation.
- **LLM routing** (`test/eval/lib/llmRouter.cjs`) wraps `LLM_ADAPTERS`: `offline` (calls refused, deterministic fallbacks), `record` (real provider, saves a cassette), `replay` (answers from the cassette, misses counted).
- **Measures:** ingestion fidelity; context per plan step (relevant and noise tables named, tokens, column detail) with the noise schema imported last and first; answerability per question from the context layer; QA accuracy (replay/record); trap detection; identifier grounding and type checks of generated SQL (`src/engine/grounding/sqlGrounding.ts` — a pattern scanner over `FROM`/`JOIN` targets, aliases and qualified columns, not a SQL parser); expected artifact properties (checked on code with comments removed); decision backing and stale-fact use from manifests.
- **Outputs:** `eval-report.md` and `eval-results.json` (rolling, git-ignored); frozen per-release copies in `baselines/`.

---

## 12. Source Tree

Generated from `git ls-files src` (2026-10-15). `src/engine/**` never imports `vscode` (§10.2).

```
src/    # activation and command registration
  extension.ts
src/agents/    # shared codegen paths (primitive selection, freehand, Pipeline Spec synthesis)
  llmCodegen.ts, llmParamSelector.ts, pipelineSpecSynthesis.ts
src/agents/build/
  IngestionPipelineAgent.ts, ToolSkillAgent.ts, TransformationScaffolderAgent.ts
src/agents/discover/
  SourceAssessmentAgent.ts
src/agents/model/
  DataModelerAgent.ts, SttmMapperAgent.ts
src/agents/validate/
  DocumentationAgent.ts
src/context/    # host-side managers: specs, plans, context documents, artifacts, chats, graph, watchers
  ActiveProblemManager.ts, ArtifactStalenessScanner.ts, ArtifactWriter.ts, AttachmentStore.ts, ChatSessionManager.ts, ContextFileManager.ts, ContextFileWatcher.ts, GraphManager.ts, GraphPersistence.ts, MappingContextManager.ts, PipelineSpecManager.ts, PlanManager.ts, SemanticLayerManager.ts, SourceContextManager.ts, SourceRegistry.ts, SpecManager.ts, SynthesisPipeline.ts, TargetConfigManager.ts, TargetContextManager.ts, vscodeFileIo.ts
src/core/    # orchestrator, webview/panel providers, LLM adapters and tools, spec engine, configuration
  agentHub.ts, agenticTools.ts, attachmentExtraction.ts, claudeCodeAdapter.ts, configManager.ts, copilotAdapter.ts, discoveryProgress.ts, disposables.ts, extensionIdentity.ts, implementationType.ts, languageModelAdapter.ts, llmAdapter.ts, llmProviders.ts, panelProvider.ts, phaseInference.ts, problemSlug.ts, sourceContextQuestions.ts, specOps.ts, specOpsPrompts.ts, specSynthesis.ts, targetContextQuestions.ts, tokenBudget.ts, webviewProvider.ts, webviewSecurity.ts
src/core/credentials/    # VS Code SecretStorage credential resolver
  VsCodeSecretStorageResolver.ts, index.ts
src/editors/    # custom editors
  DataModelEditorProvider.ts, DocEditorProvider.ts, GraphEditorProvider.ts, ProfileEditorProvider.ts, SttmEditorProvider.ts
src/engine/    # shared types
  types.ts
src/engine/context/    # assertions, ledger, projection, conflicts, retrieval, packs, gaps, persistence, ingestion, validation
  ContextValidator.ts, Yaml.ts, assertionSchemas.ts, assertions.ts, conflicts.ts, contextGaps.ts, contextPack.ts, contextStore.ts, fileIngestion.ts, ledger.ts, projection.ts, retrieval.ts, types.ts
src/engine/grounding/    # SQL grounding checks, manifests, reports
  manifest.ts, sqlGrounding.ts
src/engine/pipelineSpec/    # Pipeline Specification
  compiler.ts, designDocGenerator.ts, schema.ts, types.ts, validator.ts
src/engine/platform/    # connections and adapters
  BaseAdapter.ts, ConnectionManager.ts, providerRegistry.ts, types.ts
src/engine/platform/adapters/
  DatabricksAdapter.ts, SnowflakeAdapter.ts, snowflakeJwt.ts
src/engine/platform/credentials/    # credential resolvers and CLI detection
  CliConfigResolver.ts, DatabricksCli.ts, EnvVarCredentialResolver.ts, PlatformCliDescriptor.ts, SnowflakeCli.ts, cliDetection.ts, cliRegistry.ts, databricksCfg.ts, index.ts, registry.ts, types.ts
src/engine/platform/executionBackends/    # CLI and REST execution
  DatabricksRestBackend.ts, SnowflakeCliBackend.ts, SnowflakeRestBackend.ts, types.ts
src/engine/skills/    # interview skills, tool skills, allow-lists
  skillRegistry.ts, toolAllowList.ts, toolSkills.ts
src/engine/transforms/    # primitive registry
  platformDialect.ts, registry.ts, types.ts
src/engine/transforms/declarative/    # Tier 2 declarative primitives
  adapter.ts, lifecycle.ts, loader.ts, schema.ts, templateEngine.ts, types.ts
src/engine/transforms/primitives/    # Tier 1 primitives
  dedup.ts, incrementalLoad.ts, renameCast.ts
src/spokes/    # Snowflake executor (other files unused)
  architectureAgent.ts, ingestionAgent.ts, snowflakeExecutor.ts, sttmAgent.ts
```

Outside `src/`: `media/` (webviews: `sidebar.html`, `panel.html`, `editors/`), `skills/` (bundled interview skills), `primitive-definitions/` (bundled Tier-2 primitives), `docs/schemas/` (JSON Schemas), `test/` (`functional.test.cjs`, `eval/`, `reference/`).

---

## 13. Design Decisions & Trade-offs

### 13.1 Why Conversation-First Over Tab-Based?

**Decision:** Single scrollable workspace with slide-out panels instead of multiple tabs.

**Rationale:**
- No tab switching during the core workflow (describe → plan → execute → refine)
- Context is always visible — users can expand the context drawer to see exactly what semantic metadata is being included
- Settings and connections move to a slide-out panel — not a tab competing for attention
- Cline's success validates this pattern: one unified conversation surface where configuration, context, and execution flow naturally from the chat

### 13.2 Why Adapter Pattern Over Code Generation?

**Decision:** Abstract `BaseDataSourceAdapter` with platform-specific implementations.

**Rationale:**
- Each platform has fundamentally different system tables, SQL dialects, and authentication
- Code generation would require maintaining templates for every platform × operation combination
- Adapter pattern allows adding new platforms by implementing one class
- Sub-agents stay clean and platform-agnostic
- The `PlatformCapabilities` model allows graceful degradation (e.g., Databricks doesn't support lineage extraction)

### 13.3 Why Phase-Organized Palette Over Source/Target Split?

**Decision:** Workflow palette organized by phase (Discover → Model → Build → Validate) rather than source vs. target sections.

**Rationale:**
- Real data engineering is iterative, not linear: Source Assessment → STTM → Modeling → back to Source for more profiling
- Rigid source/target separation forces context switching
- Phase organization matches how engineers think about their workflow
- The orchestrating agent understands which phase the user is in and suggests the next logical action

### 13.4 Why Atomic Writes for .ai-context/?

**Decision:** All writes use temporary staging + atomic rename.

**Rationale:**
- Prevents corruption if VS Code crashes mid-write
- The `schema-graph.json` file is always in a valid state
- On next boot, the engine loads the previous valid snapshot
- Implemented via `vscode.workspace.fs.writeFile(tempFile)` → `vscode.workspace.fs.rename(tempFile, targetFile, { overwrite: true })`

### 13.5 Why Single-File Webview (sidebar.html)?

**Decision:** All HTML, CSS, and JavaScript in one file.

**Rationale:**
- VS Code webviews have restrictions on loading external resources
- Single-file simplifies the build process (no bundler needed)
- The file is read via `fs.readFileSync` and injected directly
- For a sidebar-sized UI, the complexity doesn't yet warrant a framework
- Can be split later if the UI grows significantly

### 13.6 YAML Parsing Strategy

**Original decision:** Lightweight custom parser for `.ai-context/` YAML files.

**Original rationale:**
- Avoids adding a native dependency that complicates VSIX packaging
- The YAML structures needed (business-context.yaml, verified-queries.yaml) are simple and flat
- A full YAML parser would be overkill for these specific file formats

**Superseded (v0.8.0):** the hand-rolled parsers were replaced with the **`yaml`** library (pure JS, no native bindings → still VSIX-safe) via `src/engine/context/Yaml.ts` (`parseYaml`/`stringifyYaml`). Structure validation uses **`ajv`** (`src/engine/context/ContextValidator.ts`) against `docs/schemas/context-envelope.schema.json`. Every manager now parses YAML through it (verified 2026-10-15).

### 13.7 Why an assertion ledger instead of editing the graph in place (v0.29.0)

The graph used to be rebuilt by deleting and re-adding nodes, so a change left no trace and a contradiction overwrote whatever came first. Recording every fact as an assertion in an append-only, per-session JSONL ledger makes history, supersession and conflicts first-class (C1, C2), merges cleanly when a team shares a workspace, and keeps the graph a disposable projection. The existing producers were left unchanged and *mirrored* into the ledger, which made the migration exactly graph-equivalent; typed assertions arrive with the producers that need them (C4, C5).

### 13.8 Why task-scoped packs without embeddings (v0.30.0)

Lexical, alias and graph-neighbourhood retrieval is deterministic, provider-independent (P4), dependency-free (P6) and reproducible in the eval harness; the measured effect at v0.30.0 was answerability 5/26 → 13/26 and no unrelated tables in any step. Embeddings stay an optional signal (phase RET) for vocabulary mismatch that deterministic signals can't fix (GRD-8).

---

## Appendix A: Webview Message Reference

### Webview → Extension

| Message Type | Payload | Handler |
|-------------|---------|---------|
| `chat` | `{ message: string, schemaContext?: string }` | `hub.chat()` — merges `contextFileManager.buildContextPrompt()` with `schemaContext` before calling `hub.chat()` |
| `generatePlan` | `{ objective: string, schemaContext?: string }` | `hub.generatePlan()` — same Context Layer merge as `chat` (v0.10.0; previously passed `schemaContext` through unmerged) |
| `approveSpec` | `{}` | `specManager.approve()` → automatically runs `syncContextFromApprovedSpec()` (spec → Context Layer sync + durable snapshot, v0.10.0) → `hub.inferPhasesFromSpec(spec, contextSummary)` → responds `specApproved` |
| `generatePlanFromSpec` | `{}` | Requires an approved spec; `hub.generatePlanFromSpec(spec, contextFileManager.buildContextPrompt())` — the spec-driven counterpart to `generatePlan`, and the primary trigger from the "📋 Generate Plan" UI actions (§3.5) |
| `setImplementationType` | `{ value: 'greenfield' \| 'brownfield' }` | User override of the deterministic Greenfield/Brownfield classification (§3.12); persists `implementationTypeOverridden: true` on the spec so future revisions don't silently reclassify it |
| `setPhaseRequired` | `{ phase: WorkflowPhase, required: boolean }` | `hub.setPhaseOverride(phase, required)` (ORC-1) — manual Applicable/Non-Applicable override on the palette, survives a subsequent re-plan, does not retroactively edit an already-generated plan's steps (the palette flags it as possibly stale instead) |
| `startTargetContext` / `reviseTargetContext` | `{}` | Posts `targetContextQuestions` — the fixed 8-question Target Context form (STC-3) |
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
| `startRevision` | `{}` | Arms `pendingRevision` (only if the current spec is `approved`); the next `chat` message becomes the change request (§3.9) |
| `attachSpecFile` | `{}` | Opens a file picker; attaches the picked file to the active `SpecOpsEngine` session as reference material (§3.9) |
| `refineSpec` | `{ refinement: string }` | Approved spec → full revision interview (§3.9); draft spec → single-shot `reviseSpec()` |
| `checkArtifactStaleness` | `{}` | `scanArtifactStaleness()` → responds with `artifactStaleness` (§3.10) |
| `runToolSkill` | `{ skillId: string, instruction: string }` | `hub.runToolSkill(skillId, instruction)` → responds with `chatResponse` (§7.6, Phase D) |
| `viewSpecHistory` | `{}` | `git log --follow -p` on the spec file → responds with `specHistory` (§3.10) |
| `newChat` | `{}` | Archives the current session (folding in any partial interview), starts a new one → responds with `chatSessionLoaded` (§3.11, Phase F) |
| `listChatSessions` | `{}` | `ChatSessionManager.listSessions()` → responds with `chatSessionsList` (§3.11, Phase F) — drives the sidebar's Chat History dropdown (v0.13.0) |
| `openChatSession` | `{ chatId: string }` | **Resumes** the given session as the live active one (v0.13.0 — previously a read-only preview): archives whatever's currently active, reactivates the target, responds with `chatSessionLoaded` (not `chatSessionViewed`, which is retired) |
| `discardChat` | `{ chatId: string }` | Permanently deletes a session (caller confirms first) (§3.11, Phase F) |
| `startNewBusinessProblem` | `{}` | Clears the active-problem pointer, fully resets (`hub.resetForNewProblem()`), archives the current chat and starts a new one → responds with `activeProblemChanged` (WS-2, v0.12.0) |
| `listBusinessProblems` | `{}` | `ActiveProblemManager.listProblems()` → responds with `businessProblemsList` (WS-2, v0.12.0) |
| `switchBusinessProblem` | `{ problemId: string }` | Activates a different existing business problem (same reset sequence as above), archives the current chat and starts a new one → responds with `activeProblemChanged` (WS-2, v0.12.0) |
| `approveBusinessProblem` | `{}` | Sets `spec.problemStatementApproved = true` (ORC-3, v0.13.0) — required before `approveSpec` will accept the spec |
| `approvePlan` | `{}` | `hub.approvePlan()` — explicit Plan Approval gate (ORC-3, v0.13.0), required (alongside `confirmStages`) before `executePlan` will run |
| `confirmStages` | `{}` | `hub.confirmStages()` — explicit "confirm applicable stages" gate (ORC-3, v0.13.0), required (alongside `approvePlan`) before `executePlan` will run |

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
| `chatSessionLoaded` | `{ meta: ChatSessionMeta, transcript: ChatMessage[] }` | Active/new session to render (§3.11, Phase F) |
| `chatSessionsList` | `{ sessions: ChatSessionMeta[], activeChatId?: string }` | All sessions (§3.11, Phase F) — populates the sidebar's Chat History dropdown (v0.13.0) |
| `specLoaded` | `{ spec: BusinessProblemSpec \| undefined }` | Current spec (including `implementationType`/`implementationTypeReason`, v0.10.0), sent on load and after every spec mutation |
| `specQuestion` | `{ question: SpecIntakeQuestion & { skillLabel?: string }, progress?: DiscoveryProgress }` | One discovery-turn question (`'ask'`) — chat bubble. `skillLabel`/`progress` added v0.13.0 (`discoveryProgress.ts`) so the interview reads as a bounded, structured process rather than opaque back-and-forth (§8.13) |
| `specQuestions` | `{ questions: Array<SpecIntakeQuestion & { skillLabel?: string }>, progress?: DiscoveryProgress }` | A batch of discovery-turn questions (`'ask_many'`, 2+) — dynamic intake form. Same v0.13.0 additions as `specQuestion` |
| `specDrafted` | `{ spec: BusinessProblemSpec, revised: boolean }` | A new draft (or revision) was synthesized |
| `specApproved` | `{ spec: BusinessProblemSpec }` | The spec was approved; Context Layer sync has already completed by the time this is posted (§3.12) |
| `contextGateStatus` | `{ targetStatus, sourceApplicable, sourceStatus, canGeneratePlan, blockingReasons, targetContext?, sourceContext? }` | The single source of truth for whether Generate Plan is unblocked (STC-3) — posted after every context-affecting action |
| `targetContextQuestions` / `sourceContextQuestions` | `{ questions: ContextQuestion[], answers: Record<string,string> }` | The fixed Q&A form to render, pre-filled with any prior answers |
| `targetContextBuilt` / `sourceContextBuilt` | `{ context: TargetContext \| SourceContext }` | Answers saved (status `built`) — awaiting `approve*Context` |
| `targetContextApproved` / `sourceContextApproved` | `{ context: TargetContext \| SourceContext }` | Approved — Target Context is now live in `hub.state.targetEnvironment` |
| `activeProblemChanged` | `{ problemId: string \| undefined, spec?: BusinessProblemSpec }` | Posted after `activateProblem()` completes (startup, switch, or new-problem reset); `problemId: undefined` is the genuinely clean "no active business problem" state (WS-2, v0.12.0) |
| `businessProblemsList` | `{ problems: BusinessProblemSummary[] }` | Every saved business problem in the workspace, newest-first, for the Workflow Palette's switcher (WS-2, v0.12.0) |

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