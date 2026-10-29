# AutoDE — Technical Design Document

**Last Updated:** 2026-10-15
**Version:** 0.31.0
**Scope:** HOW AutoDE is built — architecture, modules, data formats, algorithms and design trade-offs. What AutoDE must do and why: [requirements.md](../requirements.md) and the forward specifications. Order and status: [roadmap.md](../roadmap.md). Release history (moved out of this document on 2026-10-15): [CHANGELOG.md](../../CHANGELOG.md). Document map: [README.md](../README.md).

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

How AutoDE is built: its processes and layers, where state lives, and how each capability in [requirements.md](../requirements.md) is implemented. Requirement IDs (`GRD-4`, `ORC-3` …) and principles (P1–P9, C1–C9) are defined there and only referenced here.

### 1.2 Design principles (implementation level)

The product principles are in requirements.md §2. These are the implementation rules that follow from them:

| Rule | Rationale |
|---|---|
| **Engine / host split.** Deterministic logic lives in `src/engine/**` and never imports `vscode` (lint-enforced, and a test loads every engine module in plain Node). Host concerns — UI, secrets, settings, watchers, file writes through `vscode.workspace.fs` — stay in `src/core`, `src/context`, `src/agents`. | The same engine is exposed over MCP (phases 3–5) and runs in tests and the eval harness without VS Code. |
| **Conversation-first UI.** The chat is the spine; context, settings and workflow state are surfaced beside it, not in separate tabs. | Requirements UI-1. |
| **Platform-agnostic agents.** Agents ask *what* (extract metadata, run a query); adapters know *how* (system tables, dialects, execution backends). | One agent works on every platform. |
| **One shared context object per call.** Every LLM call gets its context from `ContextFileManager.buildContextPack()` (or the hub's provider for plan steps), never from ad-hoc string assembly at the call site. | C5; a single place to scope, budget and record context. |
| **Revision-checked, atomic writes.** Every `.autode` document is written through a temp file and rename, and refused if it changed on disk since it was read (§2.4). | NFR-2, WS-4. |
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
│  │ context/  assertions, ledger, projection, conflicts, estate ids,  │ │
│  │           catalog, vocabulary, retrieval, contextPack, gaps,      │ │
│  │           pack, profiles, contracts, conformance, probes          │ │
│  │ grounding/ sqlGrounding, manifest                                  │ │
│  │ transforms/ primitives (Tier 1 code, Tier 2 declarative)           │ │
│  │ pipelineSpec/ validator, compiler, design doc                      │ │
│  │ platform/ ConnectionManager, adapters, execution backends, creds   │ │
│  │ skills/   interview skills, tool skills, allow-lists, trust tiers  │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ postMessage
                     ┌─────────────▼─────────────┐
                     │ media/sidebar.html        │  chat · context drawer ·
                     │ (single-file webview)     │  workflow palette · settings
                     └───────────────────────────┘

┌──── dist/mcp-server.js — src/mcp/** over src/engine/** (v0.35.0) ────┐
│  stdio MCP server, plain Node, read-only, no LLM calls: primitives,   │
│  Pipeline Spec, context tools, interview and skill prompts, resources │
└───────────────────────────────────────────────────────────────────────┘
        ▲ Claude Code · VS Code agent mode · Cursor (configured by hand,
          docs/guides/mcp-setup.md). Planned: the extension becomes a client of
          the same server and registers it (phase 5).
```

**Direction from v0.40.0 (PA1 shipped in v0.40.0: §7.7; the rest planned).** C4b (v0.41.0, §5.14) is built on it. The portable architecture of [mcp-engine.md §3.1](../specs/mcp-engine.md) changes this picture phase by phase:
- PA1 adds a decision store and proposal tools to the engine and the MCP server;
- PA2 ships the engine on its own with a CLI;
- phase 5 makes the extension a client of it;
- PA3 replaces `src/agents/**` and the flow logic in `agentHub.ts` / `webviewProvider.ts` with standard skills run by an in-process executor over deterministic tools;
- PA4 adds the Port-a-skill step.

Each phase's HOW is added to this document when it ships. Until then, the sections below describe the code as it is.

---

## 2. Repository Layout & Persistence

### 2.1 Workspace layout: `.autode/` and `autode-output/` (v0.36.0)

AutoDE keeps its working state in `.autode/`, grouped by lifecycle, and writes generated deliverables to a visible folder. Every path is defined once in `src/engine/workspaceLayout.ts` (`LAYOUT`, `layoutPath()`, `layoutRel()`); extension, engine and MCP server all use it. Problem-scoped documents live under the active business problem's folder (`contextRoot`); shared knowledge lives at the workspace level.

```
.autode/
├── .gitignore                       # written by AutoDE (ensureLayout): ignores local/
├── problems/<problem-id>/           # one folder per business problem (slug + 4-char suffix) — committed
│   ├── spec/business-problem.yaml   #   Business Problem Specification (+ spec/history/)
│   ├── spec/pipeline.yaml           #   Pipeline Specification (+ history)
│   ├── plan/plan.yaml               #   persisted plan (+ plan/history/)
│   ├── context/                     #   target-context.yaml, source-context.yaml,
│   │                                #   mapping-context.yaml, semantic-layer.yaml
│   │                                #   (+ .snapshot.json), history/
│   ├── attachments/<id>.yaml        #   attachment content + structured extract
│   └── pack/pack.yaml               #   business-problem pack: documents by path, role, authority, version (§5.13)
├── problems/_unscoped/              # root for commands run with no active problem
├── knowledge/                       # shared project knowledge — committed
│   ├── ledger/                      #   assertion ledger, the system of record
│   │   ├── <yyyy-mm-dd>.<sessionUlid>.jsonl
│   │   └── snapshot.json            #     optional, written by compaction
│   ├── estate.yaml                  #   systems, environments, roles; which connections/files feed them (§5.11)
│   ├── sources.yaml                 #   registered business-context source files
│   ├── profiles/<id>.yaml           #   interpretation profiles for house-format documents (§5.13)
│   ├── business-context.yaml        #   glossary terms + business rules (human-owned)
│   ├── verified-queries.yaml
│   ├── vocabulary.yaml              #   the customer's abbreviations and synonyms (§5.12)
│   └── snapshots/<specId>.v<n>.md   #   readable record of context at plan time
├── config/                          # team customisations — committed
│   ├── skills/                      #   interview-skill overrides (*.json); tool-skills/<id>/ imports
│   │                                #   (+ .autode-skill.json, .autode-history/v<N>/; §7.6)
│   ├── primitives/                  #   Tier-2 primitive overrides (+ history/)
│   └── connections.yaml             #   platform connections: pointers, settings, sample-data consent; never secrets (§6.12)
└── local/                           # per engineer, rebuildable — never committed
    ├── active-problem.json          #   pointer: which problem is active (absent = clean slate)
    ├── chats/                       #   chat sessions
    ├── derived/graph.json           #   projection cache
    ├── catalog/<system>/<environment>/catalog.json   # estate catalog, tiers 0–2 (§5.12)
    └── schema-graph.json            #   last live extraction (input to the next reindex)

autode-output/                       # setting `artifactDirectory` (workspace-relative) — committed
└── <problem-id>/<phase>/<specId>.v<n>/…   # generated deliverables, each with <file>.grounding.json,
                                     #   and history/ archives
```

**Committed vs ignored.** Everything in `.autode/` except `local/` is committed, and so is the output folder. `local/` holds what is per engineer (the active problem, chat transcripts) or rebuildable (derived graph, catalog, last extraction); AutoDE writes `.autode/.gitignore` itself, so this holds in any repository, not only this one. (Before v0.36.0 the "git-ignored" folders relied on the repository's own `.gitignore`, so in a customer repository transcripts and `active-problem.json` were committed unless someone added rules by hand.)

**Output folder.** `ArtifactWriter.resolveArtifactDirectory(problemRoot)` = `<workspace>/<artifactDirectory>/<problem-id>` via `outputDirSegments()`; the setting defaults to `autode-output`, and absolute paths or `..` fall back to the default so artifacts never leave the workspace. Deliverables are visible on purpose: they are what the customer receives, and hidden folders are skipped by file browsers and some tools.

### 2.2 Migration from `.ai-context/` (v0.36.0)

`src/engine/workspaceMigration.ts#migrateWorkspace(root, { artifactDirectory })` runs in `activate()` before any manager reads a path, for a local workspace that still has `.ai-context/`:
- **Moves only** (`fs.renameSync`), so ledger events, manifests and history stay byte-identical and git records renames. `problems/<id>/artifacts/**` → `<output>/<id>/**`; `problems/**` → `.autode/problems/**`; `ledger/`, `profiles/`, `estate.yaml`, `sources.yaml`, `context/**` (and legacy root `business-context.yaml`, `verified-queries.yaml`, `vocabulary.yaml`) → `knowledge/`; `skills/`, `primitives/`, `target-environment.yaml` → `config/`; `active-problem.json`, `chats/`, `derived/`, `catalog/`, `schema-graph.json`, `state.json` → `local/` (`mapLegacyPath()`).
- **Never overwrites:** a file already at its new place stays in `.ai-context/` and is reported as a conflict (a teammate migrated first; the committed copy wins). **Never guesses:** an entry no rule covers stays in `.ai-context/` and is reported. `.ai-context/` is removed only when it ends up empty.
- **Idempotent:** runs on every activation; a teammate who pulls a migrated repository gets their remaining local files (chats, caches) moved on next start.
- The result is summarised in a notification (`describeMigration()`), asking the engineer to commit the move.
- Evidence in the ledger that names the old business-context path (`context/business-context.yaml`) needs no rewrite: business-context facts are keyed by subject and re-read from the file on every load, so the first load after migration keeps every fact live, with none retracted or sent to review (tested).

### 2.3 Atomic writes and archives

Every manager writes through a dot-prefixed temp file beside the target and renames it over (`writeFileAtomic`, `src/engine/context/contextStore.ts`). Managers that version a document (`SpecManager`, `PipelineSpecManager`, `PlanManager`, `Source/Target/MappingContextManager`, `SemanticLayerManager`) archive the previous revision to a `history/` folder before replacing an approved one; the version number bumps only when an *approved* predecessor is revised. `ArtifactWriter` archives an artifact (and its manifest) before a rerun overwrites it.

### 2.4 Revision-checked persistence and external edits (WS-4)

- **`ContextStore` / `RevisionedFile`** (`src/engine/context/contextStore.ts`): a *revision* is the SHA-256 of a file's bytes. A write states the revision it expects to replace and is refused with `RevisionConflictError` when the file changed on disk since it was last read or written; the refused change is not adopted in memory (managers write *before* updating their cached copy). An unparseable external edit keeps the loaded copy and leaves the expected revision stale, so the next save asks rather than clobbering a hand edit in progress.
- **`FileIo`** abstracts file access: `nodeFileIo` (engine default, MCP server, tests) and `createVscodeFileIo(vscode)` (`src/context/vscodeFileIo.ts`, extension), so remote and virtual workspaces keep working. The ledger additionally uses the optional `listDir` / `deleteFile`.
- **`ContextFileWatcher`** (`src/context/ContextFileWatcher.ts`): one recursive watcher over `.autode/**/*.{yaml,yml,json}`, debounced per path, ignoring temp files and `history/`. `webviewProvider.onContextFileChanged` routes each path to its owner's `reload()`; AutoDE's own writes are filtered out because the revision still matches. A spec or Pipeline Spec change during execution calls `AgentHub.pauseForExternalChange()` (ORC-6). A refused save raises a Reload from Disk / Overwrite prompt through a module-level conflict handler.
- **Known gap:** `ContextFileManager`'s own business-context reload is driven by a separate, non-recursive watcher on top-level `.autode/*.{yaml,json}`, so edits under `.autode/knowledge/` need a reload (CTX-5; roadmap §2).

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

Persisted and versioned in `.autode/problems/<id>/spec/business-problem.yaml` (git is the version history).

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

**Removed in v0.45.9 (SIMP-3).** The plan of steps is gone; the workflow's stages replaced it (§7.9). This section records what it was.

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

**Skills.** `skills/*.json` define composable DE skills — Requirements Discovery, Source Catalog, Data Flow, Transformations, Quality & Acceptance, Constraints & Assumptions, and Synthesis. Each carries a system prompt, question guidance, and the spec fields it owns. `SkillRegistry` (`src/engine/skills/skillRegistry.ts`) loads bundled skills plus optional user overrides in `.autode/config/skills/` (later entries win).

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

**Design choice:** lean on git as the version/audit log rather than build a parallel in-app version store — `.autode/problems/<id>/spec/` is already meant to be committed, so a second source of version truth would only drift from it.

- **`src/context/ArtifactWriter.ts`** now writes every spec-stamped artifact under a `<specId>.v<version>` folder (`ArtifactWriter.specTag(artifact)`), inserted **above** the artifact's own relative path — so a multi-file artifact (e.g. the dbt scaffold) keeps every filename a tool like dbt expects (`dbt_project.yml` stays `dbt_project.yml`); only a folder is added, never a filename prefix. Artifacts with no `specId` (legacy pre-Phase-B writes, or generated with no spec set) land directly under the phase directory as before.
- **`src/context/ArtifactStalenessScanner.ts`** (`scanArtifactStaleness(problemRoot, currentSpec?)`) walks the problem's output folder (`autode-output/<problem-id>/<phase>/*`, §2.1; before v0.36.0 it was given the workspace root and looked where nothing was written), recognizes `<specId>.v<version>` folder names via regex, and classifies each as `current` (matches the approved spec's id+version), `stale` (same id, older version), or `unknown-spec` (different id, or no spec currently approved). Files sitting directly under a phase dir (no version folder) are counted separately as `untaggedFileCount` — this is *why* the folder scheme exists: `PlanState.artifacts` (which also carries `specId`/`specVersion`) is in-memory only and gone after a reload, so the filesystem path is the only durable record.
- **UI:** opening the Workflow Palette posts `checkArtifactStaleness`; the response renders a small "Generated Artifacts" section above the phase rows — a warning banner + list for `stale` groups, a quiet green line per `current` group, and a note for untagged/unknown files. Nothing is deleted or regenerated automatically.
- **"🕓 History"** on the spec card posts `viewSpecHistory` → `git log --follow -p -- <spec path>` (via `child_process.execFile`, `cwd` = workspace root) rendered as a chat message. Not a git repo, or no history yet → a clear message, not a crash.

### 3.11 Chat Sessions & Lifecycle (Phase F, v0.9.0)

**Design choice:** chat session identity is deliberately independent of BPS identity (confirmed via clarifying question) — a session can span several specs, and a spec can be discussed across several sessions, so `ChatSessionMeta.specId`/`specVersion` are a breadcrumb recorded at creation time, not a live foreign key kept in sync.

**`ChatSessionManager` (`src/context/ChatSessionManager.ts`).** One class, mirrors the rest of `src/context/`'s pattern (atomic metadata writes, one class per concern):
- `.autode/local/chats/<id>.meta.json` — `{ id, createdAt, updatedAt, status: 'active'|'archived'|'discarded', specId?, specVersion?, llmProvider?, title? }`, written via the same temp-file→`rename` pattern as `SpecManager`/`SourceRegistry`.
- `.autode/local/chats/<id>.jsonl` — one `ChatMessage` (`{ role: 'user'|'ai'|'log', content, at }`) per line. `vscode.workspace.fs` has no append primitive, so `appendMessage` is read-modify-write (whole file re-read, message appended, whole file rewritten) — an accepted cost at realistic chat lengths rather than an engineered-around one.
- Exactly one session is `status: 'active'` at a time; `getActiveSession()` is `listSessions().find(s => s.status === 'active')`.
- Gitignored (`.autode/local/chats/`) — unlike the committed BPS, transcripts are local/exploratory by explicit decision.

**`webviewProvider.ts` wiring.**
- On `resolveWebviewView()`, after the spec manager initializes: construct `ChatSessionManager`, `initialize()`, `getActiveSession()` or `createSession()` if none exists, load its transcript. **Changed in v0.13.0:** if that transcript is non-empty, the session is folded (`startNewChat()` — archived, never discarded, and a fresh empty one takes its place) rather than posted as-is; only an empty session is posted directly via `chatSessionLoaded` (`{ meta, transcript }`). A reload/restart therefore never silently resumes a prior conversation into view — see CHT-2.
- `postMessage()` now also calls `recordAssistantMessage(type, payload)`, which maps the handful of assistant-facing message types (`chatResponse`, `specDrafted`, `specApproved`, `specQuestion`, `specQuestions`) to a `ChatMessage` and appends it to the active session — chat persistence is a side effect of the existing post path, not a parallel code path callers have to remember to invoke. User messages are appended directly at the `case 'chat'` / `case 'submitSpecAnswers'` handlers.
- New message cases: `newChat` → `startNewChat()`; `listChatSessions` → posts `chatSessionsList`; `openChatSession` → **(v0.13.0, changed from a read-only viewer)** archives whatever's currently active, reactivates the chosen session (`ChatSessionManager.updateMeta(chatId, {status:'active'})`), and posts `chatSessionLoaded` with its transcript — a real resume, not a preview; `discardChat` → `ChatSessionManager.discardSession` after the caller's own confirmation.
- `startNewChat()`: archives the current session (`archiveSession`, never a delete); creates a new one seeded with the current spec's id/version and the active LLM provider; posts `chatSessionLoaded` with an empty transcript, then re-asks the open interview's questions. Also called from the startup-fold path above. Until v0.45.12 it ended an in-flight interview and folded its answers into context as a note (`carryOverPartialInterview()`, the owner's earlier choice over resuming); since v0.45.12 the interview is kept with the problem and resumes (PA3 §7, approved 2026-10-21), so the carry-over is gone.

**Sidebar (`media/sidebar.html`).**
- "🗨 New Chat" topbar icon → `post('newChat')` (after `endPending()`, so an in-flight pending bubble doesn't leak into the new session's rendering).
- **New in v0.13.0:** "🕓" Chat History topbar icon, next to New Chat — opens a dropdown (`#chatHistoryDropdown`, styled like the `@mention` dropdown) populated by `listChatSessions`/`chatSessionsList`; clicking a row `post('openChatSession', {chatId})` to resume it. This is the "on need basis" counterpart to the startup fold.
- `case 'chatSessionLoaded': loadChatSession(msg.meta, msg.transcript)` — clears `chatStream`, resets client-side session flags (`discoveryActive`, `discoveryProgress`, `revisionArmed`, any pending bubble), shows the welcome block for an empty transcript, otherwise replays each `ChatMessage` through the existing `addMessage()`/`addLogEntry()` renderers keyed on `role`. Also now re-renders the Workflow Palette's spec section, so a stale "discovery in progress" view from a just-folded session doesn't linger.
- `case 'chatSessionsList': renderChatHistoryDropdown(msg.sessions, msg.activeChatId)` — new in v0.13.0. `chatSessionViewed` (the old read-only-preview response) is retired along with `openChatSession`'s old semantics; nothing posts or handles it anymore.

**Command Palette (`src/extension.ts`).** `AutoDE: New Chat` (`triggerNewChat()`), `AutoDE: Chat History` (`QuickPick` over `listSessions()`, opens the selected transcript read-only via `vscode.workspace.openTextDocument` — unchanged; this remains a read-only peek, distinct from the sidebar's new resume-capable picker above), `AutoDE: Discard Chat` (`QuickPick` + a modal `vscode.window.showWarningMessage` confirmation before `discardSession()` — irreversible, only ever behind this two-step flow).

**Superseded by C4b (chat extraction):** a "distill this chat" Context Memory curation pass (LLM extraction of a transcript into graph nodes with `origin.source: 'chat'` provenance) is a separate concern from session persistence and has not been built; a fuller in-sidebar chat browser (search/tag/export/reopen) was scoped out of this pass, with the message-handling plumbing already in place for it.

### 3.12 Context Sync, Implementation Type & Plan Persistence (v0.10.0)

**Design choice:** reuse existing machinery rather than build parallel systems — spec→context sync reuses `SynthesisPipeline`/`GraphManager` (already built for registered-source ingestion), implementation-type classification reuses the deterministic keyword-evidence pattern `phaseInference.ts` already established, and plan persistence reuses `SpecManager`'s exact atomic-write-plus-history shape.

- **Context sync (closes the gap where nothing fed the approved spec's own content into the Context Layer).** `SynthesisPipeline.synthesizeFromSpec(spec)` maps `objectives`/`businessRequirements`/`dependencies` to `business_term` nodes and `constraints`/`assumptions` to `business_rule` nodes (STRICT / RECOMMENDED respectively), each stamped with `Origin.specId`/`specVersion`. It first calls `GraphManager.removeNodesBySourceRef('spec:' + spec.id)` so re-synthesizing on a later revision **replaces** the prior version's derived nodes rather than accumulating stale ones alongside them. Runs automatically inside the `approveSpec` handler — before `generatePlanFromSpec` is ever reachable — so the Context Layer is always current for the spec version a plan is about to be generated from. A durable, human-readable record is also written to `.autode/knowledge/snapshots/<specId>.v<version>.md` (committed, unlike the transient `.autode/local/derived/graph.json`), capturing exactly what fed plan generation for that spec version.
- **`generatePlan`'s prompt now actually reads the Context Layer.** Previously only `chat`, `discoverNextAction`, and `synthesizeComprehensiveSpec` merged in `contextFileManager.buildContextPrompt()`; the `generatePlan` webview case passed the caller's raw (usually empty) `schemaContext` straight through. It now merges `buildContextPrompt()` the same way `chat` does, and `generatePlanFromSpec` does the same before delegating to `generatePlan`.
- **Implementation type (`src/core/implementationType.ts`).** `classifyImplementationType(spec)` scans the same spec-text corpus `phaseInference.ts` uses for keyword evidence of existing-system language (`existing`, `legacy`, `migrate`, `as-is`, …) vs. new-build language (`greenfield`, `from scratch`, `net new`, …); mixed evidence defaults to `brownfield` (the higher-risk assumption), no evidence defaults to `greenfield`. Computed at every spec draft/revision/synthesis point (`webviewProvider.applyImplementationType`), unless the user has explicitly overridden it (`setImplementationType` message → `implementationTypeOverridden: true`, preserved across later revisions rather than silently reclassified). Surfaced as a badge with a one-click flip in both the chat spec card and the Workflow Palette.
- **Phase applicability now considers implementation type and context.** `inferPhases(spec, implementationType?, contextSummary?)` — both new parameters are optional so existing callers are unaffected. A `brownfield` classification forces `discover` required by default (existing systems need assessment even absent explicit spec language) unless `scope.out` explicitly excludes it, which still wins. Note the **`unrequired` `PhaseStatus`** (§3.5) already *is* the Non-Applicable state the palette renders (dimmed, "⊘ Non-Applicable", with its `reason` string) — this section only widens what feeds the classification, it does not introduce a new status.
- **Plan persistence (`src/context/PlanManager.ts`; removed in v0.45.9).** Mirrors `SpecManager` exactly: atomic writes to `.autode/problems/<id>/plan/plan.yaml`, every version-on-change archived to `plan/history/plan.v<n>.<status>.yaml`, restored into `AgentHub`'s in-memory `PlanState` on extension activation (`hub.loadPersistedPlan`) so the generated steps, inferred phases, status, and implementation type survive a VS Code reload — previously `PlanState` had no on-disk representation at all. `PlanState.artifacts` (execution-produced `GeneratedArtifact[]`) is **not** part of the persisted shape and remains in-memory-only, per §3.10's existing rationale for the artifact-folder spec-tagging scheme.
- **Artifact-level version history.** `ArtifactWriter.write()` now archives whatever previously sat at a given path to a `history/` subfolder before overwriting it, so re-running a step within the *same* `<specId>.v<version>` folder no longer silently discards the prior output — only cross-version staleness was tracked before (§3.10).

### 3.13 Multi-business-problem workspace (WS-2)

- **Identity.** A problem's folder is an auto-generated slug (`src/core/problemSlug.ts#generateProblemSlug`): the first five non-stop-words of the problem statement, kebab-cased, at most 48 characters, plus a 4-character random suffix, collision-checked against existing slugs. Creation is lazy: the folder is created on the first spec draft, because it can't be named before a problem statement exists.
- **`ActiveProblemManager`** (`src/context/ActiveProblemManager.ts`) owns `active-problem.json` (`{ problemId, activatedAt }`, atomic write) and `listProblems()`, a scan of every `problems/<id>/spec/business-problem.yaml` (id, statement, status, version, updated, active), newest first, skipping unreadable folders.
- **Context roots.** `SpecManager`, `PlanManager`, `TargetContextManager`, `SourceContextManager`, `MappingContextManager`, `SemanticLayerManager`, `PipelineSpecManager`, `AttachmentStore` and `ArtifactWriter` take an already-resolved `contextRoot`; the caller passes the active problem's folder (or `_unscoped`). `ArtifactWriter` derives the problem id and workspace from it and writes to the output folder, not inside it (§2.1). `ContextFileManager`, `SourceRegistry`, `ChatSessionManager` and the ledger stay workspace-level.
- **Activation** (`webviewProvider.activateProblem`, at startup and on start/switch): `hub.resetForNewProblem()` (clears spec identity, inferred phases, implementation type — fuller than `resetPlan()`), removes the previous problem's spec-derived graph nodes, sets the context manager's active spec id (spec-scoped assertions of other problems stay in the ledger but are not projected, §5.5), re-points the hub's `PlanManager`/`ArtifactWriter` via `extension.ts#applyProblemRoot`, then initialises the problem's managers and re-synthesises an approved spec into the graph.
- **Webview actions:** `startNewBusinessProblem` (clears the pointer, full reset, archives the current chat, starts a new one), `switchBusinessProblem`, `listBusinessProblems` → `businessProblemsList` (palette's Business Problem section).

### 3.14 Lifecycle gates (ORC-3)

**Since v0.45.9 (SIMP-3)** the gates are the workflow's: a workflow decision, then each stage's gate or document approval (§7.9). The plan gates below (plan approval, stage confirmation, `setContextGateReady`) were removed with the plan. The business-problem and specification gates still apply.

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
│  CONTEXT STATUS LINE            │  ← Counts + link to the Knowledge
│                                 │     Explorer (v0.50.0)
├─────────────────────────────────┤
│  CHAT INPUT + ACTION BAR        │  ← Message input, Send, Plan, Execute
└─────────────────────────────────┘
```

### 4.2 Top Status Bar

| Element | ID | Description |
|---------|-----|-------------|
| **Provider pill** | `providerPill` | Shows active LLM (e.g., "Copilot" or "Claude" with green dot). Clicking opens LLM settings. |
| **Connection pill** | `connPill` | Shows data platform connection status. Clicking opens connection settings. |
| **Context meter** | `ctxMetric` | Token/entity counter with mini progress bar. Clicking opens the Knowledge Explorer (v0.50.0). |
| **Plan status** | `planMetric` | Shows plan step count and execution status. |
| **Refresh button** | `refreshBtn` | Triggers context re-index. |
| **Stop** (activity card) | `.activity-stop` | v0.53.1: stops that run (`stopRun`); the old header `stopBtn` for plan execution is gone. |
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

### 4.4 Context status line

Since v0.50.0 (C5b) the former context drawer is one line between the chat stream and the input: counts of tables, terms and queries, and a *Knowledge Explorer* link (`post('openKnowledgeExplorer')`). Exploring what AutoDE knows happens in the Knowledge Explorer (§5.17); the drawer's controls for the older knowledge files are gone from the sidebar (their provider handlers remain, unreachable, until those files move into the ledger).

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
| `/context`, `/explore` | Open the Knowledge Explorer |
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

**Ids** (since v0.31.0, `src/engine/context/estate.ts`): physical objects `obj:<system>/<environment>/<fqn>[.<column>]` (lower-case); glossary terms `term:<slug>`, rules `rule:<slug of the first six words>`, verified queries `query:<slug>`, spec-derived `term:spec.<specId>.<suffix>` / `rule:spec.<specId>.<suffix>`; edges `edge:<type>:<source>-><target>`; projected definitions `term:`/`metric:<slug>`, `rule:<assertionId>`, `rel:<assertionId>`. Ids from before v0.31.0 (`table-…`, `col-…`, `biz-term-…`, `biz-rule-N`, `verified-query-…`, `spec-term-…`, `edge-…`) are re-keyed on load (§5.11). `Origin` carries `system` and `systemEnvironment` for physical objects.

**Assertions** (`src/engine/context/assertions.ts`): `{ id (ULID), kind, subject[], predicate, value, statement, status, trust, evidence[], supersedes?, supersededBy?, validFrom, validTo?, verification?, specId?, createdBy, createdAt, flags?, reviewReason? }`. Kinds: `schema_fact, data_fact, key, grain, relationship, business_term, metric, business_rule, mapping, quality_expectation, decision, assumption, constraint, naming_convention, verified_query`. Each kind's `value` has an Ajv schema (`assertionSchemas.ts`; `validateAssertion()`). Trust → confidence: verified 1.0, confirmed 0.9, documented 0.8, inferred 0.5.

**Context documents** loaded from files are validated against `docs/schemas/context-envelope.schema.json`; `ContextValidator` dispatches the per-kind `definitions` on `kind` and reports content problems as warnings, never failures (CTX-6).

### 5.2 Loading and reindexing (`ContextFileManager`)

`src/engine/context/contextFileManager.ts` (in `src/context/` before v0.43.2; a re-export remains there), constructed per workspace by `webviewProvider`, and by `openContext()` for the CLI and MCP ingest. It has no VS Code dependency: the extension injects its watcher of `.autode/knowledge/` (`KnowledgeWatcher`), and the CLI and the MCP server run without one. `loadAllFiles()`:
1. Clears the graph, loads `estate.yaml` and the ledger. If the ledger has content, the graph starts as its projection; otherwise from `derived/graph.json` (the one-time migration source). Legacy ids in the base graph are re-keyed (§5.11).
2. If `schema-graph.json` is newer than `derived/graph.json` (a live extraction happened), it is re-keyed if needed and merged *by scope*: existing tables in the same `(system, environment, database.schema)` — or the same `(connection, database.schema)`, should the connection have been re-bound — are replaced together with their columns; everything else is kept, so extracting a second schema never retracts the first.
3. Drops nodes previously loaded from business-context and verified-query files, and re-reads `context/business-context.yaml` and `context/verified-queries.yaml` (legacy root as fallback): terms keyed by name (`biz-term-<slug>`), rules by position, queries by name; `maps_to`/`constrained_by`/`uses_table` edges to tables found by fqn or label.
4. Calls `persistCompiledGraph()` (§5.3).

`SynthesisPipeline` (`src/context/SynthesisPipeline.ts`) adds nodes from registered sources (`sources.yaml`, rule-based extraction) and from an approved spec (`synthesizeFromSpec`: objectives, requirements and dependencies → terms; constraints and assumptions → rules; all with `origin.specId/specVersion`, replacing the previous version's nodes). Runtime facts (`setRuntimeFact`, e.g. connection status) are an in-memory, never-persisted slot rendered at the top of every pack.

### 5.3 Ledger, sync and projection (C1, C2; CTX-2)

- **Ledger** (`ledger.ts`, `AssertionLedger`): one JSONL file per writer session; event types `asserted, confirmed, rejected, superseded, verified, verification_failed, flagged_needs_review`, each with `id` (monotonic ULID), `assertionId`, `at`, `actor`, `causedBy`. `foldEvents()` sorts by event id and applies events on top of an optional snapshot — pure and deterministic, so file read order never matters. Mutators: `assert`, `confirm`, `reject`, `supersede`, `recordVerification`, `flag`; `compact({ prune })` writes `snapshot.json` and deletes event files only when pruning.
- **Sync** (`projection.ts#syncGraphToLedger`): every node and edge producers put in the graph is recorded as a *mirror* assertion (predicate `node`/`edge`, the node or edge itself as value). Trust comes from provenance (`live-verified` → verified, `llm` → inferred, from an approved spec → confirmed, otherwise documented); evidence from the origin (introspection, spec field, file). New → `asserted`; changed (comparing without timestamps and confidence) → new assertion with `supersedes` plus a `superseded` event; vanished → `rejected` with "no longer present in …"; a newer `lastVerifiedAt` from a live extraction → `verified`. Live business assertions about a changed or removed node are flagged for review (dependency walk). Unchanged graphs append nothing (idempotent migration).
- **Spec scoping:** an assertion with a `specId` is in scope only while that problem is active (`inSpecScope`): out-of-scope assertions are neither retracted by a sync nor projected.
- **Projection** (`projectGraph`): nodes and edges from live (`active`, `needs_review`) mirror assertions, in assertion-id order; live non-mirror terms, metrics, rules and relationships add `term:`/`metric:`/`rule:` nodes and `related_to` edges (or support an existing node). Each node/edge gets `supportedBy` and `origin.confidence` from its strongest supporter, and `lastVerifiedAt` from an introspection verification.
- **Re-keying** (v0.31.0): `sync` takes the alias map; a live mirror whose id was re-keyed is carried to the new id as an `asserted` (with `supersedes`) + `superseded` (reason `re-keyed`) pair — counted as `rekeyed`, not as a change or retraction, and dependents are not flagged. The ledger stores `aliased` events (`from`, `to`; `assertionId` = `alias:<from>`); `foldAliases()` resolves chains; `AssertionLedger.assertions()` reports non-mirror subjects under the current id; compaction keeps the map in `snapshot.json`.
- **Choke point:** `ContextFileManager.persistCompiledGraph()` = re-key legacy ids → record aliases → sync → detect + flag conflicts → re-project into `GraphManager` → write `derived/graph.json`. Live discovery and Source Assessment (via the reindex after `schema-graph.json`), file ingestion (`ingestFileIntoGraph`), spec synthesis and the business-context files all reach the ledger through it. A ledger failure is logged; the graph is persisted regardless.
- **Subject resolution** (`createSubjectResolver`): node id, `term:`/`metric:` name, table fqn, `<fqn>.<column>`, or a label naming exactly one table; anything else stays as given and is flagged `unresolved_subject`.

### 5.4 Conflict detection (CTX-3)

`conflicts.ts#detectConflicts()` over `active`, `proposed` and `needs_review` assertions:
- **definition** — two definitions of the same business name (glossary-term mirrors, `business_term` and `metric` assertions; name normalised to letters and digits) whose formula/definition text differs after whitespace and operator normalisation;
- **value** — same kind + subject + predicate with different values (key/grain column lists compared case-insensitively);
- **declared_key** — a `key`/`primary` assertion whose columns differ from the table's declared primary-key columns.

`flagConflicts()` sends every *active* participant to `needs_review` once (idempotent); a declared schema fact is never flagged in a declared-key conflict. Conflicts are recomputed on every persist, not stored.

### 5.5 Context packs and retrieval (C5; GRD-1, GRD-2)

- **Retrieval** (`retrieval.ts`): `resolveText(text, graph)` finds qualified names, `<table>.<column>`, schema mentions ("the shop and crm schemas" → all their tables), table labels in prose (n-grams up to three words, singular/plural-insensitive; ambiguous labels match every candidate) and term/metric names. `expandNeighborhood()` is a BFS over edges in both directions with distance decay; `GraphManager.traverseNeighborhood()` delegates to it.
- **Catalog retrieval** (v0.32.0, §5.12): when `sources.catalog` is set, the request is also searched in the estate catalog; the best few hits (`selectSeedHits`: within 75 % of the best score, at most three) are added as seeds. A hit outside the working set but with structure is merged into this pack's graph view and listed in `manifest.promoted`; a name-only hit becomes a `structure` gap; a hit hidden by grants is counted in a "Not visible" warning (`invisible:<fqn>` in `warnings`).
- **Pack building** (`contextPack.ts#buildContextPack(request, sources)`): seeds = explicit ids ∪ resolved text ∪ catalog hits. No seeds → the project overview (byte-for-byte the pre-v0.30.0 dump: STRICT rules, first 20 tables, all terms, five query labels), which `ContextFileManager.buildContextPrompt()` returns. With seeds: hops per purpose (step 2, otherwise 1); score = relevance × trust weight (verified 1.0, confirmed 0.95, documented 0.7, inferred 0.4); mandatory sections first — warnings (conflicts and `needs_review` items touching the scope, context gaps), STRICT rules linked to the scope or naming a seed table or one of its columns, keys/grain on seed tables — then seed tables with columns, neighbours collapsed, relationships among tables in the pack, terms, verified queries. Budget per purpose (step 3000, plan and QA 2500, chat and spec 2000, interview 1500 tokens, estimated as characters ÷ 4); what doesn't fit is counted in `truncated`.
- **Manifest** (`PackManifest`): `packId` (content hash), purpose, mode, seeds, node ids, assertions with `assertionRevision()` (hash of content and status), truncation counts, token count, gaps, warnings.
- **Callers:** `webviewProvider.contextPackText(purpose, query, title)` for chat, plan, spec drafting/refinement/synthesis, phase inference, interview turns, Pipeline Spec synthesis and tool skills; `AgentHub` builds one per plan step through its `ContextPackProvider` (§7.4). `ContextFileManager` keeps the last 50 packs for "What the Agent Saw" (`renderPackManifest`).

### 5.6 Context gaps (C3; GRD-3)

`contextGaps.ts#detectRelationshipGaps()` looks for combination phrases between resolved tables — "<A> per/by/for each <B>", "join <A> to/with <B>", "<A> joined to <B>" — and computes the best join path (≤ 3 hops; the trust of a path is its weakest edge) over foreign-key and projected relationship edges plus proposed relationship assertions (as inferred). No path → gap `absent`; a path below the required trust (default confirmed) → `below_trust`. `describeGap()` phrases it as a question. Class `structure` (v0.32.0) comes from catalog retrieval: a matched object whose structure is not loaded. Gaps are rendered as warnings in the pack (also when nothing else was seeded) and logged; decision gaps come from manifests (§5.7). Steps are not paused yet (C4b).

### 5.7 Grounding manifests, checks and staleness (C6; GRD-4 – GRD-7)

`src/engine/grounding/manifest.ts`:
- **`backDecisions(use, graph, assertions)`** — for each decision-bearing primitive parameter (name matches key/partition/grain/orderBy/incremental/watermark/join/dedup/merge), resolves the source table from `params.sourceObject` and finds the backing: a live key or grain assertion with the same columns, else the declared primary key's column mirror (key-like parameters); a live `decision` assertion naming the column (ordering/incremental). Records `backedBy`, `belowTrust` (keys need confirmed, other decisions documented) or `unbacked`.
- **`checkRules(content, rules, knownColumns)`** — STRICT masking rules naming known columns are machine-checked (every reference must sit inside a hash/mask function, or be an alias of one); other STRICT rules are `manual_review`.
- **`buildGroundingManifest()`** — artifact path, spec id/version/revision, catalog revisions (latest extraction per `system/environment`, `catalogWatermarks()`), step, agent, generation method, primitives, pack id, assertions with `usedFor` (decision parameter or `context`), decisions, overrides, gaps (pack gaps + decision gaps), and checks: identifiers and type compatibility via `sqlGrounding.ts` (pattern scanner, §11.2; objects the approved Pipeline Spec plans to create count as known), decision counts, rule checks, warnings (`GROUNDING_UNRESOLVED`, `GROUNDING_TYPE`, `GROUNDING_UNBACKED`, `RULE_VIOLATION`).
- **`manifestStaleReasons()`** — a relied-on assertion that is superseded, rejected, under review or gone; **`explainManifest()`** — artifact → decisions → assertions → evidence; **`renderGroundingReport()`** — per-run summary.
- **Host side:** `ArtifactWriter.writeManifest()` writes `<file>.grounding.json` beside the artifact (archived like it); `webviewProvider.reportFactStaleness()` walks the problem's artifact folder for manifests (skipping `history/`) whenever staleness is checked and logs/posts `artifactFactStaleness`; spec-version staleness stays in `ArtifactStalenessScanner` (folder names `<specId>.v<n>`). Commands: `AutoDE: What the Agent Saw`, `AutoDE: Explain This Artifact`.

### 5.8 Source, target and mapping context (STC-1 – STC-9)

- **`SourceContext`** (`src/engine/types.ts`): one container per spec version with `sources: SourceContextEntry[]` (each with `connectionId`, method `connected`/`described`, connection summary); a pre-v0.19.0 flat file is migrated on load. **`TargetContext`**: platform, modelling approach, tools, naming, environment, location. Both are built from fixed question sequences (`src/core/targetContextQuestions.ts`, `sourceContextQuestions.ts`) whose answers carry keyword-evidence suggested defaults, and go `pending → built → approved`. Approving target context is the sole source of `AgentHub.setTargetEnvironment()`; greenfield marks source context not applicable automatically.
- **Versioning**: `version` bumps only when revising an approved predecessor of the same spec lineage; predecessors are archived to `context/history/{source,target,mapping}-context.spec<N>.v<M>.yaml`.
- **`MappingContext`** (`MappingContextManager`): `EntityMapping { id, sourceEntityId, sourceFqn, targetEntityId?, targetName, columns[{sourceColumn, targetColumn, transformExpression?}], notes? }` with pinned source/target context versions; `upsertMapping`/`removeMapping` drop an approved set back to `built`. `AutoDE: Create Mapping` picks source and target tables from the graph (or a typed target name for greenfield) and auto-matches columns by name.
- **Semantic layer** (v0.49.0): replaced the earlier spec-pinned graph snapshot (`SemanticLayerManager`, retired); see §5.16.
- **Reliability** (STC-9): live extraction sets `confidence 1.0`, `reliability: 'live-verified'`, `lastVerifiedAt`; file ingestion sets `best-effort-inferred`; packs annotate file-derived tables. `AutoDE: Re-verify Source Schema` re-runs extraction and diffs source-tagged table fqns before/after (present, new, missing) without deleting anything.

### 5.9 File ingestion (STC-7)

`src/engine/context/fileIngestion.ts`, no dependencies, structural only:
- **CSV** — header + type inference from up to 200 rows (INTEGER, FLOAT, BOOLEAN, TIMESTAMP, STRING); quoted fields with commas and `""` escapes (no embedded newlines).
- **JSON** — an array of objects or one object; columns are the union of keys over up to 200 records (missing key → nullable).
- **Column dictionaries** (v0.31.0) — a CSV whose header is a Teradata `DBC.ColumnsV`, Oracle `ALL_TAB_COLUMNS` or `INFORMATION_SCHEMA.COLUMNS` export is read as a dictionary: rows grouped into tables by (catalog, schema, table), ordered by column position, types rendered with length/precision (Teradata type codes mapped, e.g. `CV` → `VARCHAR`), nullability from `Y/N` or `YES/NO`.
- **DDL** — `CREATE TABLE` statements after stripping `--` and `/* */` comments; qualified names keep their schema/database (`shop.customers` ≠ `crm.customers`; unqualified → `ddl.<name>`); column defs split on top-level commas outside quotes; constraint lines skipped; table-level `[CONSTRAINT x] PRIMARY KEY (a, b)` marks key columns. Since v0.32.0, `COMMENT ON TABLE|COLUMN x IS '…'` and inline `COMMENT '…'` become table and column descriptions (dictionary exports: `CommentString`/`COMMENTS`/`COMMENT`).

Every parser takes an `IngestIdentity { system?, environment?, role? }` (default: a system named after the file, environment `default`, role source); ids are `obj:` ids in that system. Nodes carry `extractor: 'file-ingestion'`, `reliability: 'best-effort-inferred'`, `origin.system`/`systemEnvironment`. `AutoDE: Ingest File as Source Context` asks which system the file describes (suggestion: its binding, or one named after the file), records the binding in `estate.yaml`, parses, and imports through `ingestFileIntoGraph()` → `ContextFileManager.ingestParsed()` (catalog, working set, ledger; §5.12).

### 5.10 Graph manager

`src/engine/context/graphManager.ts` (in `src/context/` before v0.43.2): maps of nodes and edges with fqn, label and type indexes; a promise-chain mutex serialises mutations; `serializeSnapshot()`/`loadSnapshot()`; `removeNodesBySourceRef()`/`removeNodesWhere()`; `traverseNeighborhood()` (§5.5). `getNodeById()` falls back through the ledger's alias map (`setAliases()`), so documents that store pre-v0.31.0 ids (mapping contexts) still resolve. The graph is a projection: the ledger is the system of record.

### 5.11 Estate identity (v0.31.0; STC-10, PLT-6)

- **Model** (`src/engine/context/estate.ts`): `Estate { systems: EstateSystem[]; bindings: EstateBinding[] }`; `EstateSystem { id (slug), name, role: source | target | both, schemaRoles? }` (a schema can override its system's role — in-place modernisation); `EstateBinding { connection? | file?, system, environment?, schemas? }`. `parseEstate()`/`serializeEstate()` over `.autode/knowledge/estate.yaml`.
- **Resolution:** `resolveIdentity(estate, { connection | file })` returns `{ system, environment, role }` from the binding (files match by name, case-insensitively); an unbound source gets a system named after it (connection id or file name), added to the estate. `ContextFileManager` owns the estate (`getEstate`, `bindToSystem`, `resolveConnection`, `resolveFile`) and writes it when it changes.
- **Live extraction:** `ConnectionManager.setEstateResolver(fn)` (set by the extension and by the webview's own connection checks) supplies the identity for `snapshotToGraph(snapshot, identity)` and the binding's `schemas` as `schemaFilter` when the caller names none. `Origin.environment` (source/target) follows the system's role.
- **Re-keying legacy ids:** `rekeyLegacyGraph(graph, identityOf)` is pure and idempotent: tables and columns get `obj:` ids from their origin's system (origin.system, else the connection's or file's binding, else `unassigned`), business kinds their namespaced ids, edges ids from their re-keyed endpoints; it returns the alias map. `ContextFileManager` applies it to the base graph on load and before every persist; the aliases go to the ledger (§5.3).
- **Commands:** `AutoDE: Open Estate (Systems & Environments)` opens (creating if needed) `estate.yaml`; Browse… lets the user pick several schemas, recorded on the connection's binding.

### 5.12 Catalog and working set (v0.32.0; NFR-1, NFR-6, NFR-8, GRD-8)

- **Why:** at 2 000 tables and 50 000 columns, mirroring everything into the ledger cost 713 MB of extension-host heap and a 2.1 s sync (measured before this change). The ledger is the record of what a *problem* relies on, not a copy of the estate (principle C9).
- **Catalog** (`src/engine/context/catalog.ts`, class `Catalog`): `CatalogEntry { id, system, environment, table (node without origin), origin, tier 0|1|2, columns?, edges? (foreign keys), visible?, loadedAt?, lastAltered?, lastUsedAt? }`. One JSON file per `system/environment` (written only when changed, atomic); the folder writes a `*` `.gitignore`. `entriesFromGraph()` / `entryToGraph()` convert losslessly to and from the producers' node shapes (`supportedBy` stripped). `upsert()` keeps usage data for unchanged entries, `upsertNames()` adds tier-0 names, `demote()` drops a live-sourced entry to tier 0, `markInvisible()`/`markChecked()` record refresh outcomes, `watermarks()` feeds manifest catalog revisions.
- **Retrieval index:** documents are entries; fields and weights — name 3, glossary alias 3, table comment 2, schema 0.5, column names and comments 0.5 — over *concepts* from `vocabulary.ts` (split on separators and camel case, singularised, abbreviations expanded from a default dictionary plus `context/vocabulary.yaml`, synonyms folded onto their group's first word). Score = Σ idf × field weight × (1 + share of the name's concepts the request covers); a hit needs at least one concept from a name, alias or comment. `buildIndex()` yields every 100 entries; `search()` uses the last index (building synchronously only if none exists). Glossary aliases come from business terms' `mapped_tables`, resolved against catalog names. `signals` switches exist for the eval's ablation only.
- **Working set** (`ContextFileManager`): the graph's physical tables. `admitObjects(nodes, edges)` upserts everything into the catalog and puts into the graph all of it when the working set stays within `maxTables`, otherwise only tables already there or referenced by a live business assertion. `ingestParsed()` = admit + persist. Live extractions (`schema-graph.json`) replace their scope in the catalog and are admitted the same way. `putInGraph()` replaces a table and its columns from the catalog and re-links glossary `maps_to` edges (`relinkGlossary()`). `persistCompiledGraph()` ends with `syncCatalog()`: the working set back into the catalog (this backfills workspaces from before v0.32.0), glossary aliases, index, save.
- **Promotion:** `buildContextPack()` touches seeds and rendered nodes (`lastUsedAt`) and queues `promote(manifest.promoted)` on a promise chain (`whenIdle()` awaits it).
- **Eviction:** on load, `selectEvictions()` picks working-set tables only while the set is over `maxTables`: not referenced by a live business assertion, unused for `evictAfterDays`, oldest first. They leave the graph; `persistCompiledGraph({ evicted })` passes them to `syncGraphToLedger`, which retracts their mirrors with the reason "left the working set (unused; still in the catalog)" and flags nothing.
- **Query-through and refresh on use:** `CatalogFetcher { covers(system, environment), fetchStructure(entries), lastAltered?(entries) }`, implemented by `ConnectionManager.catalogFetcher()` and set by the extension when a source connects (`webviewProvider.setCatalogFetcher`). `prepareContext(request)` (hub `prepare` before each step's pack; chat before its pack) loads the request's hits that are name-only or older than `schemaTtlDays`; `refreshWorkingSet()` (hub `beforeRun`) does the same for the working set. `refreshEntries()` asks for last-altered first and only re-reads changed tables; a table asked for and not returned is marked not visible; re-read working-set tables go back into the graph and the ledger sync records supersessions and flags dependents.
- **Settings:** `autoDataEngineeringHub.context.workingSetMaxTables` (200), `context.evictAfterDays` (30), `context.schemaTtlDays` (7), `discovery.profileQueryBudget` (50), `discovery.profileConcurrency` (4).
- **Measured** (eval, `baselines/v0.32.0-offline.md`): import of the 2 008-table fixture 302 ms, heap growth 24 MB, longest synchronous task 46 ms, packs ≤ 2.2 ms, catalog 11 MB on disk. No embedded database at this size (roadmap decision log).

### 5.13 Business-problem pack, conformance and probes (v0.33.0; BPS-1, BPS-3, BPS-10, CTX-3, CTX-9, SEC-5)

- **Pack** (`src/engine/context/pack.ts`): `PackDocument { id (slug of the file name), path (workspace-relative), role: contract | brd | kpi_definitions | mapping | data_dictionary | sample | other, authority: signed | draft, version, sha?, profileId?, table? (samples), bindings? (contract entity → table ids) }`, in `<problem>/pack/pack.yaml`. Documents are referenced, never copied. `clauseRef(path, clausePath, sha)` = `<file>#<path>@<sha12>`; `trustFor(signed) = confirmed`, `draft = documented`.
- **Interpretation profiles** (`profiles.ts`): `InterpretationProfile { id, status: proposed | confirmed, signature (top-level keys), entities: { each, name, description?, tables?, fields: { each, name, type?, required?/nullable?/unique? (FlagPath { path, yes[] }), columns? (object system/schema → column) }, rules?: { each, field, check, checkMap (document rule name → not_null | unique | accepted_values), values? } } }`, Ajv-validated, `.autode/knowledge/profiles/<id>.yaml`. `applyProfile(doc, profile)` is pure and reports unreadable entries as warnings. `buildProfileProposalPrompt()` sends only the document's skeleton (keys, first list element, values cut at 40 characters); `parseProfileProposal()` forces `status: proposed`. Only confirmed profiles are applied.
- **Contracts** (`contracts.ts`): clauses become `quality_expectation` assertions on `contract:<doc>/<entity>.<field>` — predicate `contract_schema` (value `{ check: 'schema', dataType?, isNullable?, columns? }`), `unique`, and one per rule — with `createdBy: pack:<doc>` and the clause ref as evidence. `reconcileContract()` keys clauses by subject|predicate: new → asserted, changed value or trust → superseded, missing → rejected ("no longer in <file> v<n>"), equal → untouched.
- **Conformance** (`conformance.ts`): `bindEntity()` — the pack's bindings, else the contract's table references matched by fqn or `schema.table` in every system/environment of the catalog; `physicalColumn()` — the field's `columns[system]`, `columns[schema]`, else its name. Per bound table: present, type family (`typeFamily()`: string, integer, number, timestamp, date, boolean; number accepts integer; unknown types are not verified), nullability (from the catalog), then unique and rule checks through probes. Status `pass | fail | not_verified`; `renderConformanceReport()` → discover-phase artifact `conformance-report.md` (`validation_report`).
- **Probes** (`probes.ts`): `ProbeSpec { check: unique | not_null | accepted_values | orphans | freshness, table { fqn, id }, columns, values?, to? }`. `renderProbeSql(spec, dialect, { sampleRows })` — fixed templates returning one row of aggregates (`row_count`, `distinct_count`, `null_count`, `violation_count`, `orphan_count`, `max_value`); identifiers must be plain (`[A-Za-z_][A-Za-z0-9_$]*` dotted) or the probe is refused; values are literals with quotes doubled; sampling `SAMPLE (n ROWS)` (Snowflake), `TABLESAMPLE (n ROWS)` (Spark SQL), `LIMIT` subquery (ANSI). `interpretProbe()` turns the aggregates into a verdict for both executors: `createSqlProbeExecutor()` (`ConnectionManager.probeExecutor()`, `maxRows: 1`, 60 s, 50 000-row sample, covers only its own system/environment) and `createSampleProbeExecutor()` (same aggregates over sample CSV rows; rows never leave it). `combineProbeExecutors()` tries live where it covers the table, then samples. `probesFor(assertion)` maps key/grain → unique, quality_expectation on a column → its check, relationship → orphans; contract subjects get none. `verifyAssertions()` records `verified` (trust → verified; status unchanged — confirming stays the engineer's) or `verification_failed` (→ needs_review, detail as reason).
- **Free text** (`documentExtraction.ts`): `splitSections()` (Markdown or numbered headings, else paragraphs; ranges end at the last non-blank line) → one prompt per document → `parseDocumentExtraction()`: facts must name a known section and validate per kind; subjects resolved with `createSubjectResolver()`, unresolved ones kept and flagged; `proposed` / `inferred`, `createdBy: extractor:<doc>`; `recordExtraction()` skips equal (kind, subject, predicate, value) proposals.
- **Discover → validate → ask** (`discoveryGaps.ts`): `knownFacts(graph, assertions, tables)` — declared PKs, confirmed/verified keys and grains, loaded structure; `answeredByDiscovery(question)` — conservative regex on what is asked (key, grain, join, columns) and every table the question names must have the fact; `filterInterviewQuestions()`. `webviewProvider.runDiscoveryTurn()` adds `knownFactsBlock()` to the interview context and drops answered questions (logged); if none remain, it moves on to synthesis.
- **Vocabulary capture:** `mineAbbreviations()` — a name token (2–6 letters, not already known, not itself a comment word) proposed for a comment word with the same first letter that contains its letters in order, ties left out; `buildVocabularyProposalPrompt()`/`parseVocabularyProposal()` for the LLM (synonyms must be single words — `concepts()` matches word by word, so a phrase is dropped rather than accepted as an entry that never applies); `mergeVocabularyFile()`; the engineer picks in a multi-select, then `ContextFileManager.reloadVocabulary()` re-indexes.
- **Host** (`src/context/BusinessPackManager.ts`, Node `fs`, takes a `ContextFileManager` getter and an optional `CompleteJson` — `AgentHub.completeJson()`): `addDocument`, `applyDocument` (structured → profile → reconcile, or proposes a profile; free text → extraction; samples → registered), `conformance`, `probeExecutor(live)`, `verifyClaims` (non-mirror key/grain/relationship/quality_expectation claims on physical subjects not yet verified), `proposeVocabulary`/`acceptVocabulary`, `clauseIds` (→ `BusinessProblemSpec.packRefs` at synthesis), `summary` (into the synthesis context). Commands: `AutoDE: Add Document to Business-Problem Pack`, `Apply Business-Problem Pack`, `Run Conformance Check`, `Verify Claims with Probes`, `Propose Vocabulary`; `extension.ts` passes the source connection's probe executor on connect (`setLiveProbes`).

---

### 5.14 Facts from conversation and the Context Inbox (v0.41.0; CHT-5, CTX-10, GRD-3)

**Extraction** (`src/engine/context/chatExtraction.ts`).
- `buildChatExtractionPrompt(turn, existing)`: kinds and value shapes, plus the facts already recorded about the subjects (up to 40, compact, with ids), the previous reply as context only, and the engineer's message.
- `parseChatExtraction(raw, turn, resolve)`: `CHAT_EXTRACTABLE` kinds, `validateAssertion()`, subjects resolved with `createSubjectResolver()` (unresolved ones kept and flagged `unresolved_subject`). Evidence is `chat_message` / `interview_answer` with the turn ref, plus `user_edit` entries for the turn's actions. Results are `proposed` / `inferred`, `createdBy: extractor:<source>`.
- `recordChatProposals()`: dedups on kind, subject (case-insensitive), predicate and value, where key and grain columns are compared case-insensitively and in any order. It then runs `linkCorrections()`: for `SINGLE_VALUED` predicates (key/primary, grain/grain, metric/defined_as, business_term/defined_as, constraint/platform), a proposal whose kind, subject and predicate match a live or proposed fact with a different value gets `supersedes` = the most recent one. Proposals are appended with `buildAsserted()`, so nothing is retired yet.
- `extractFromTurn()` wraps all of it and **never throws**: a model error, a garbled answer, a timeout (`timeoutMs`, default 120 s) or a ledger failure comes back in `error`. Slash commands are skipped.

**Capture without the model.** `parseCaptureCommand()` handles:
- `/define T = D` → `business_term` on `term:<slug>`, or the resolved node;
- `/rule` → `business_rule`, `STRICT` when it says must, never, always or shall;
- `/decide` → `decision`;
- `/assume` → `assumption`.

Each one is `proposed`, `createdBy: user:capture`, subject `project` where there is no entity.

**Ledger.**
- `AssertionLedger.confirm()` now also writes a `superseded` event for the confirmed fact's `supersedes` target when that target is still live or proposed. This is how a correction takes effect, and only once a person confirmed it.
- `detectConflicts()` leaves out a fact that a considered proposal supersedes, so a pending correction isn't reported as a value conflict.
- `createProbeResolver(graph)` moved from `BusinessPackManager` into `probes.ts`, shared by the extension and the MCP server.

**Citations.**
- `buildContextPack()` adds `### Facts (cite as [fact:<id>])`, listing up to 15 non-mirror live or proposed assertions from the pack, **for `purpose: 'chat'` only**, so step, QA and spec packs are unchanged.
- `CITATION_INSTRUCTION` is appended to the chat system prompt.
- `citedFactIds()` reads the ids back; the webview turns `[fact:<id>]` into hover chips with the fact's statement.

**AgentHub.**
- `chat()` returns `actions`, the turn's `ToolCallAuditEntry[]` through `auditSink`.
- `foldActionEntries()` folds transcript `log` entries into the preceding assistant turn for every provider, because history turns are strictly user/assistant.
- Context gaps (relationship, key, grain, structure) used to pause a plan step (`waitingForContext`, `continueDespiteGaps`). Since v0.45.9 they are listed in the stage's assignment instead (§7.9, `src/engine/agents/stageGaps.ts`), and nothing pauses on them.

**Extension** (`webviewProvider.ts`).
- The `chat` case first tries `captureFact()`. After every route (discovery, revision, answer) it schedules `extractFactsFromTurn()` without awaiting it. That uses `hub.completeJson()`, logs dropped items to the console, auto-verifies probeable proposals when `liveProbes` is set and `readOnlyMode` is on (§5.3), re-projects the graph and refreshes the Inbox.
- `describeActions()` turns the audit into `wrote <path>` and `ran <command>` lines, which are appended to the transcript as a `log` message and shown under the reply.
- **Inbox** (`inboxState()`): proposed and needs-review non-mirror facts (with stakes, the superseded fact's statement, verification and evidence), `detectConflicts()`, `waitingForContext` and `live`. Actions:
  - `reviewFact`: confirm, reject, or edit = `ledger.supersede()` with the edited statement and value (JSON), confirmed. An edited correction also retires its target.
  - `verifyFact`: `verifyAssertions()` with `liveProbes`.
  - `bulkConfirmFacts`: only `documented` proposals with one `createdBy`.
  - `continueDespiteGaps`.

  The PA1 Decisions section became the Context Inbox (`renderDecisions()` with `inboxState`).

**MCP** (`src/mcp/decisions.ts`, `catalogs.ts`).
- `autode_propose_assertion` now validates, resolves subjects against the workspace graph, and records through `recordChatProposals()` (dedup and correction linking). It is `createdBy: mcp:<client>[:skill:<s>][:model:<m>]` and returns the assertion, its stakes, and `corrects`. No decision file is written.
- `autode_review_assertion` confirms or rejects a **proposed, low-stakes** fact (`stakesFor('assertion', a)`); anything else is `PERMISSION_DENIED`.
- `autode_verify_assertion` builds a `createSqlProbeExecutor()` on the named connection (its dialect from the platform) with `createProbeResolver()`, and records the outcome.
- `autode_extract_assertions` (prompt) is the extraction prompt plus instructions to read existing facts with `autode_list_assertions` and submit with `autode_propose_assertion`.

### 5.15 Capture coverage and exploration mode (v0.48.0; CTX-13, ORC-11)

Capture coverage (context-layer §5.5) and exploration mode (§7.4). Deterministic everywhere except where a model reads text or guesses at a gap; every surface calls the same engine functions.

**Modules.**

| Module | Does |
|---|---|
| `src/engine/context/coverage.ts` | `inScopeTables` (the specification's text through `resolveText`, plus the mapping's sources), `specMetricNames` (fixed business nouns), `captureCoverage` → `CoverageReport` (items per table and metric, each with a status and an action), `renderCoverage`. |
| `src/engine/context/dataCandidates.ts` | `tableShapes`, `keyColumnCandidates`, `foreignKeyCandidates`, `changeColumnCandidates`, `knownKey`; `findCandidates` runs the probes; `recordCandidates` appends an `asserted` event and, when it passed, a `verified` event in one write. |
| `src/engine/context/capture.ts` | The per-problem wrappers the panel, CLI and MCP share: `problemCoverage`, `problemCandidates`, `packSampleExecutor`. |
| `src/engine/context/probes.ts` | New check `shape` (`VALUE_SHAPES.email`, `.phone`; regular expressions without backslashes so they mean the same in every dialect's literal; ANSI has only the e-mail `LIKE`). Pass at ≥ 80 % of non-null values. |
| `src/engine/context/documentExtraction.ts` | Prompt asks for `quote` per fact and a `sections` report; `parseDocumentExtraction` drops unsupported quotes (`normalizeQuote`) and returns `reread`; `agreeingReadings` (double reading); `parseDocumentDeterministic` (tables and phrases); `recordWithAgreement` (dedup by `factKey`, `corroborated` from another source). |
| `src/engine/context/sessionReview.ts` | `factCue`, `unrecordedStatements`, dismissals in `.autode/local/session-review.json`. |
| `src/engine/documents/problemMode.ts` | `problemMode`, `setProblemMode` (`<problem>/mode.yaml`), `admitForMode`, `recordAssumption`, `recordWarnedCheck` (`<problem>/exploration-warnings.jsonl`), `hardeningReport`, `explorationEnvironmentProblem`, `explorationHeader`. |

**Ledger.** Trust gains `assumed` between `documented` and `inferred` (ranks 5…1; `TRUST_TIERS`). `Assertion.model` and `NewAssertion.model` record the extracting model. A `corroborated` event adds evidence and the agreeing actor (`corroboratedBy`); older readers ignore it.

**Where the mode applies.**
- *Admission:* `BusinessPackManager` (documents), `recordChatProposals` and `extractFromTurn` (chat, `/review record`), the panel's capture commands, `autode_propose_assertion`, `recordCandidates` all take an `admit` function; `admitForMode` turns a proposed, non-person fact into an active one at `assumed` (a verified one keeps `verified`). Corrections are never admitted.
- *Gaps:* `stageGapsFrom(gaps, kind, mode)` drops a gap whose best trust is `assumed` or more in exploration; `renderStageGaps(gaps, mode)` tells the agent to stop and ask (governed) or to record an assumption and continue (exploration). `Assignment.mode` adds an *Exploration mode* section. `toolsForTier` grants `autode_record_assumption` to roles that may propose facts; the tool refuses in a governed problem.
- *Approval checks:* `documentApprovalCheck` splits each stage document's problems into hard (no document, no statement, no mappings, an invalid Pipeline Spec) and soft (another specification version, a source context with no source, unmasked or undeclared sensitive columns). Governed: all refuse. Exploration: soft ones warn, are recorded with `recordWarnedCheck`, and are named in the approval message.
- *One click:* the Workflow view and the panel skip their confirmation dialog; the CLI asks `[y/N]` for gate decisions and stage documents.
- *Never relaxed:* `approveRunbook` and `runStep` refuse a production environment for an exploration problem; nothing else in the runner, the policy, `gateQueryResult` or the connection checks reads the mode.
- *Labels:* `recordArtifact` prepends `explorationHeader(file)` and sets `GroundingManifest.exploration`; the sidebar and Workflow view show a banner from a `problemMode` message.

**Panel.** `WebviewProvider.switchProblemMode` (modal with the disclaimer; before the problem's folder exists the choice is held and applied in `ensureActiveProblem`), `reviewSession` (`/review`), `noteUnrecorded` (on *New Chat*), `captureCoverageMarkdown`, `findCandidatesFromData`; commands `captureCoverage`, `findCandidates`; setting `capture.doubleExtraction` read by `BusinessPackManager.applyDocument`, which also re-reads unaccounted sections once.

**CLI and MCP.** `autode coverage`, `autode capture candidates [--connection] [--record]`, `autode problems new --exploration`, `autode problems mode [exploration|governed]`, `autode problems hardening`. MCP: `autode_capture_coverage` and `autode_review_session` (read), `autode_find_candidates` (records proposals; probes), `autode_record_assumption` (exploration only); `autode_pack_reading` takes `sections`, `autode_pack_record_reading` takes `sections`, `reread` and `model`.

### 5.16 The semantic layer (v0.49.0; CTX-11, C5a)

Shared semantic models and composites (context-layer §6). Everything below is engine code under `src/engine/semantic/`, deterministic, shared by the editor, the CLI and MCP.

| Module | Does |
|---|---|
| `model.ts` | Types for Snowflake's semantic model YAML; `SEMANTIC_MODEL_SCHEMA` (Ajv, `additionalProperties: false`, `measures` accepted as the older name of `facts`); `validateSemanticModel` / `parseSemanticModel` (format, then unique names and relationship tables); `serializeSemanticModel` (fixed key order, empty lists dropped, optional `#` header); `semanticRevision` (SHA-256 of the LF-normalised text, 12 hex); `findElement`, `tableElements`. |
| `composite.ts` | The composite format (`autode: semantic-composite/1`), `parseComposite` (schema errors rewritten in the composite's terms), `resolveComposite(c, load)` → model + revisions + errors (subset, merge identical tables, collisions, additions, describes, then the result validated as a model), `serializeResolved`. |
| `draft.ts` | `draftSemanticModel({ graph, assertions, tableIds, name, database })` → model, `backing` (element → fact ids), `notes`. Only live facts at ≥ confirmed; declared keys and foreign keys from the estate. |
| `checks.ts` | `checkSemanticModel(model, { graph, assertions })` → findings (`error` / `warning`, `where`, `message`); `exprIdentifiers`. Base tables matched by `db.schema.table` or `schema.table`; keys via `dataCandidates.knownKey`. |
| `store.ts` | Paths (`semanticPaths`: the `artifactDirectory` setting from `.vscode/settings.json`, else `autode-output`; metadata under `LAYOUT.semantic` = `.autode/semantic/{shared,composites/<problem>}/`); `readShared` / `listShared` (status approved, changed, unapproved, invalid); `listComposites` / `readComposite` (resolved, stale with reasons, unresolved, invalid); `resolveCompositeFile` (writes only when the bytes change; records the revisions); `writeShared`, `writeDraft` (never overwrites); `approveShared`, `approveComposite` (mode-aware); `semanticWaiting`. |
| `editorState.ts` | `semanticFileKind` (by folder), `semanticEditorState` (the editor's whole state, with a composite's preview resolution and the checks), `applySemanticEdit` (set, add, remove → new text), `mergeDraft` (add-only), `newCompositeText`. |

**Decisions.** Kind `semantic_model` (`SemanticModelPayload { scope, name, content }`), subject `semantic:shared/<name>` or `semantic:<problem>/<name>` with the file's revision; applying a shared model writes it with the approver's approval, a composite writes and resolves it.

**Surfaces.** The editor: `SemanticModelEditorProvider` (custom text editor `autoDE.semanticModelEditor`, default for `**/semantic/*.yaml`) over `editorState`; host from `WebviewProvider.semanticEditorContext()`. Commands `newSemanticModel`, `newSemanticComposite`. *Waiting for you* gains kind `semantic` (opens the file). CLI `autode semantic …`; MCP `src/mcp/semanticTools.ts` (tools and `autode://semantic/...` resources) and `autode_propose_semantic_model` in `decisions.ts`.

### 5.17 The Knowledge Explorer; packs and grounding use the semantic layer (v0.50.0; C5b)

Context-layer §6.5, §6.10, §7.5. Engine code is deterministic and shared by the VS Code panel, the CLI and MCP.

**The approved layer.**
- `src/engine/semantic/layer.ts` (pure; imports only `model.ts`):
  - `indexSemanticLayer(loaded, { includeDrafts })` → `SemanticLayerIndex`, holding models, tables with their base `schema.table`, elements, relationships with base tables, `byBaseName` and `metricsByName` (names and synonyms). Drafts enter the index only with `includeDrafts`.
  - `definitionsFor(index, fqns)` and `semanticTablesFor`; matching is on schema and table, and the database is ignored.
  - Graph ids `sem:<model>`, `sem:<model>/<table>` and `sem:<model>/<table>/<element>`.
- `store.ts` adds `loadSemanticLayer(root, { problemId, includeDrafts })`. It reads shared models whose status is `approved`, and the problem's composites from their resolved files, approved when `approvalCurrent`. `semanticLayerFiles` serves cache keys.
- `layerGraph.ts`: `semanticGraph(index, graph)` → nodes (`semantic_model`, `semantic_table`, `metric`, `semantic_element`; `metadata.approved`; `supportedBy` from the sidecar's `backing`) and edges:
  - `contains`;
  - `maps_to` from a semantic table to its physical table;
  - `derives_from` from an element to each physical column its expression names (`exprIdentifiers`);
  - `related_to` for relationships.

**Packs.**
- `ContextPackSources.semantic` holds the approved index:
  - MCP: `EngineWorkspace.contextSources()`, keyed on the layer's files;
  - VS Code: `ContextFileManager.getPackSources()`, cached on mtimes.
- `renderSeeded` adds a mandatory *Semantic definitions* block for the seed tables, after relationships; if it doesn't fit the budget it counts as `truncated.semantic`.
- `PackManifest.semanticModels` records `name@revision`.

**Grounding.** `src/engine/grounding/semanticGrounding.ts`:
- `checkSemanticGrounding(artifacts, index, { knownMetrics })` → `{ checked, joinsChecked, joinsDefined, metricsChecked, metricsDefined, issues[{kind, detail, fix}], models }`.
- **Joins:** `alias.col = alias.col` inside `ON` clauses whose two aliases resolve to different base tables that both have approved semantic tables; the join must match a relationship's column pair in either orientation.
- **Metrics:** `AGG(...) AS name`, where the name is an approved metric or synonym; compared with `normalizeExpr` against the metric's expression and its form with the table's own elements expanded. A name in `knownMetricNames(assertions)` (live metric facts) that no approved model defines is also flagged.
- `buildGroundingManifest({ semantic })` stores `grounding.semantic` and a `GROUNDING_SEMANTIC` warning.
- `recordArtifact` runs the check before writing SQL. It throws in a governed problem; in an exploration problem it records the file with the warning.
- `autode_check_grounding` returns `semantic`.
- **Explainability:** `DecisionRecord.confidence = confidenceOf(trusts)` (the weakest tier, or `unbacked`). `GroundingManifest.sources` (`ManifestSources`) comes from the pack's models, the catalog revisions, primitives, classification facts used, and primitive lineage.

**Explore.** `src/engine/explore/`:

| Module | Does |
|---|---|
| `explore.ts` | `ExploreSources` (graph, assertions, conflicts, catalog, semantic index with drafts, `ArtifactUse[]`). A per-sources index (`WeakMap`): the graph plus the semantic overlay, edges out and in, columns and tables, facts by subject, classifications per column (`governanceFacts`), and cached `AssetSummary`s. `searchAssets` (text score over label, fqn, aliases and description, every word required; facts; catalog hits outside the working set; `resolveText` only when nothing matched, then `approximate`; facets before filters; offset and limit). `resolveAsset` and `getAssetContext` (`AssetContext`: overview, schema, meaning, lineage so far, governance, facts, memory, usedBy, conflicts, sources; facts and catalog-only tables have their own shapes). `exploreGraph` (BFS, 1–3 hops, edge types, columns on request, `cap` with `hidden` counts). `listFacts`, `exploreOverview`. |
| `sources.ts` | `artifactUses(root)` (reads every `*.grounding.json` under the deliverables folder, at most 5 000, skipping `history/`). `exploreSources(root, contextSources, problemId)`. `estateView` (estate.yaml systems and bindings, catalog tiers per system and environment, working-set counts, connections with `connectionStatus`). `ExploreRequest` and `handleExploreRequest`. |
| `render.ts` | Text renderings for the CLI and *Copy as Markdown*: `renderSearch`, `renderOverview`, `renderAssetMarkdown`, `renderGraph`. |

Measured on the large-estate fixture (§10.3; about 50 000 columns): with the whole estate in the graph, the index build takes about 90 ms and a search about 35 ms; with 200 tables in the working set, every request takes well under 100 ms.

**Surfaces.**
- **VS Code:** `src/core/knowledgeExplorer.ts` (panel `autodeKnowledgeExplorer`, command `openKnowledgeExplorer [assetId]`).
  - It reads through an `EngineWorkspace` (the CLI's and MCP's reader), re-reading the manifests and drafts at most every 2 s.
  - `knowledgeExplorerModel.ts` (no `vscode`) answers `ready`, `request`, `open` (workspace files only), `copyMarkdown` and `exportGraph`, and returns actions for the host.
  - `media/explorer.html` is a single file that loads `dist/cytoscape.min.js` through `asWebviewUri`. The CSP allows scripts only by nonce and from `cspSource`. There are no inline handlers. State lives in `vscode.setState`.
  - `WebviewProvider.openInbox()` posts `openInbox` to the sidebar.
- **CLI:** `autode explore [overview|search|asset|graph]`.
- **MCP:** `src/mcp/exploreTools.ts` provides `autode_search_assets`, `autode_get_asset_context` and `autode_explore_graph`, and the resources `autode://asset/{id}` (template), `autode://explore/overview` and `autode://explore/estate`. `readResource` is now async.

**v0.50.1.**
- `AssetSummary` carries:
  - `assetType` (see `ASSET_TYPE_LABELS`; semantic elements are typed by their list);
  - `platform`: from the connection id, a platform named in the source reference, else `file`, and `semantic layer` for `sem:` nodes;
  - `certification` (`certificationOf(trust)`, or from approval for the semantic layer), with `trust` kept as evidence;
  - `status` for assets and `reviewState` for knowledge facts;
  - `glossaryTerms`, from `business_term` assignments (`mappedNodeIds`, `maps_to`).
- `FACETS` lists the facets in catalog order, and `PENDING_FACETS` names domain, owner and tag.
- `exploreLandscape(sources, { system, schema, model, includeColumns, proposed, semantic, cap })` returns the tables in scope and lifts edges to them:
  - `foreign_key` and `related_to`, the latter as `relationship`;
  - proposed or needs-review relationship facts, as `proposed_relationship` resolved with `createSubjectResolver`;
  - the semantic layer's relationships, as `semantic_join` matched by `baseMatches` (`proposed` when the model is a draft).

  Each edge is labelled with its columns. The result also carries `total`, `capped` and `scopes`.
- Graph nodes carry `parent`, so the webview draws columns inside their tables (Cytoscape compound nodes).
- Request `landscape`; `autode_explore_graph` without `asset`; `autode explore graph` without an asset.
- The webview has one renderer, `drawGraph`, used by the asset tab and the Graph view, with a card, `expand` (adds a 1-hop slice in place and runs the layout with `fit: false`) and `findOn`.

**v0.50.2.**
- `SemanticLayerIndex` gains `verifiedQueries` and `instructions`.
- `semanticGraph` adds nodes, each contained in its model:
  - `semantic_relationship` (`sem:<model>#rel:<name>`; `uses_table` to both logical tables);
  - `verified_query` (`sem:<model>#vq:<name>`; `uses_table` to the logical tables its SQL names);
  - `semantic_instruction` (`sem:<model>#instructions`).
- `AssetSummary.layer` comes from `LAYER_OF[assetType]`. The `layer` facet comes first, and `SearchOptions.layers` filters by it.
- `semanticOverview(sources)` → models with their logical tables, metrics (with table and expression), relationships, verified queries and instructions.
- Request `semantic`; resource `autode://explore/semantic`; `autode explore semantic`; `renderSemantic`.
- A physical table's `usedBy.queries` follows `maps_to` to its logical tables.
- The webview gains a layer radiogroup (a shortcut for the layer facet), `renderSemanticHome`, and layer fills on graph nodes.

**v0.50.3 (identity, §6.4a).** `layer.ts`:
- `knownDatabase`, which treats `SET_DATABASE`, `ingested_files` and empty as unknown;
- `isFormatSchema`: ingestion's `ddl`, `csv` and `json` under an unknown database mean no schema;
- `PhysicalRef` and `physicalRef(tableNode)`, with parts lower-cased and `''` for unknown;
- `nameRef(sqlName)`;
- `physicalMatches(lt, ref)`: equal where both know a part, within `lt.binding`;
- `matchBase(lt, refs)` → `{ match?, candidates }`: one fit, or the one with a known equal database, else ambiguous;
- `LayerTable` gains `key` (`db|?.schema.table`), `baseDatabase` and `binding`; relationships use keys;
- `semanticTablesFor(index, ref, all?)` and `definitionsFor(index, refs, all?)`: with `all`, only the semantic tables that resolve to *this* table.

Callers:
- `layerGraph` links `maps_to` only on a unique match, and records `metadata.ambiguous`;
- the landscape's semantic joins use `matchBase`;
- `checkSemanticModel(model, { graph, assertions, binding? })` reports an ambiguous base table as an error that lists the candidates;
- `semanticGrounding` compares keys and `nameRef` parts.

The binding is `SharedMeta.binding` in `.autode/semantic/shared/<name>.yaml`. `DraftResult.binding` comes from the drafted tables' origins, and `writeDraft(…, binding)` records it. `logicalNames` escalates the name, then `schema_name`, then `db_schema_name`, then the id.

`explore.ts`:
- `containerGraph` adds `database` and `schema` nodes (`phys:<system>/<env>/<db>[/<schema>]`, lower-cased; labels keep the source's case) and `contains` edges;
- `AssetSummary.database` and `.schema` come from `containersOf`;
- `browseAssets(sources, parent?, limit)`; `AssetContext.contents` and `.ambiguousBase`;
- the `database` and `schema` facets.

Surfaces: request `browse`, `autode_browse_assets`, `autode explore browse`, and the webview's Filters/Browse tabs with a lazy tree. Fixture: `test/reference/realistic-estate/`.

**Build.** `scripts/bundle.cjs` copies `WEBVIEW_LIBRARIES` (`cytoscape/dist/cytoscape.min.js`) into `dist/` and adds their licences to `THIRD-PARTY-NOTICES.md`. `.vscodeignore` ships `dist/cytoscape.min.js` and `media/explorer.html`.

### 5.18 The metadata model and knowledge articles (v0.51.0; MM1)

Context-layer §6.11.

**Facts.**
- `AssertionKind` gains `classification` and `metadata`. A `metadata` fact's predicate is `tag` `{key, value?, group?}`, `owner` `{role, person}`, `domain` `{domain}`, `certification` `{status, note?}` or `property` `{name, value}`; schemas are in `assertionSchemas.ts`.
- `business_rule` gains `ruleType`, `modality`, `scope`, `domain` and `expression`. `business_term` gains `category`, `broader`, `narrower`, `related`, `steward`, `status`, `abbreviation` and `examples`. `quality_expectation` gains the checks `pattern` and `referential`, and `dimension`.
- `isLowStakesFact(kind, predicate)` (in `decisionStore.ts`) makes tags low stakes.
- `governance.ts` reads both classification forms, and `classifyColumn` writes the new kind.
- The projection derives a rule node's `enforcementLevel` from `ruleOf(a).modality`, and `metadata.ruleType`, `.modality` and `.scope` too.

**`src/engine/metadata/`.**

`model.ts` holds:
- the vocabularies: `OWNER_ROLES`, `CERTIFICATIONS_SET`, `RULE_TYPES`, `QUALITY_DIMENSIONS`;
- `parseMetadataConfig` and `loadMetadataConfig`, reading `LAYOUT.tagGroups`, `.customProperties` and `.domains`;
- `patternMatches` (`*` over the id and the fqn);
- `metadataBySubject`;
- `assetMetadata(facts, config, {id, fqn, model})`: facts first, then the domain from a pattern or a semantic model, owners inherited from the domain for missing roles, and data products by pattern;
- `checkMetadata` (controlled tag values, property types);
- `ruleOf` (stated, or inferred from the level and wording);
- `qualityDimension`;
- `isClassificationFact`.

`record.ts` holds:
- `setMetadata`, which supersedes the live fact with the same identity: a tag's key, an owner's role and person, a property's name, or the domain or certification;
- `removeMetadata` (rejects);
- `migrateMetadata`, an idempotent supersession by `system`. It turns `business_rule`/`classification` into the `classification` kind, and gives rules without a modality a `ruleType`, `modality` and `scope`. The panel runs it after initialising the context manager; the CLI runs it as `autode metadata migrate`.

**Knowledge articles.** `src/engine/knowledge/articles.ts`:
- `parseArticle` and `serializeArticle`: YAML front matter (`title`, `about`, `cites`, `status`, `author`, `domain`, `tags`, `approved {by, at, revision, channel}`), then Markdown;
- `articleRevision`: SHA-256 over the title, about, cites and body;
- `readArticle` and `listArticles` (state `draft`, `approved`, `changed` or `deprecated`);
- `checkArticle`: uncited `[fact:…]` or missing citations are errors; a superseded, rejected or under-review cited fact makes the article stale; a proposed fact is a warning;
- `writeArticle` (never overwrites without `overwrite`), `approveArticle` (refused while invalid or stale), `articlesAbout` and `articleSummary`.

Decision kind `article` (`ArticlePayload`, `validateArticleProposal`). Applying it writes the article and approves it at its revision by the approver; it is superseded if the file changed since the proposal.

**Packs.**
- `ContextPackSources.articles`: `EngineWorkspace.contextSources` (the fingerprint includes the articles folder) and `ContextFileManager.getPackSources`.
- A *Guidance* block: live `guidance` rules on the scope, and team-wide ones; at most 8; their ids go to the manifest.
- A *Knowledge articles* block: approved articles about the scope with their opening paragraph, and STALE with the reason. `PackManifest.knowledgeArticles` holds `slug@revision`, and the cited facts join `assertions`.

**Explore.**
- `ExploreSources.metadata` and `.articles`.
- `governanceNodes` adds `domain:<slug>`, `product:<domain>/<name>` and `article:<slug>` nodes (NodeTypes `domain`, `data_product`, `knowledge_article`; layer context).
- `metaOf` caches `assetMetadata` per asset.
- `AssetSummary` gains `domain`, `owners`, `tags` and `certifiedBy`; a person's certification overrides the derived one.
- The facets `domain`, `owner` and `tag` are live, and `PENDING_FACETS` is empty.
- `AssetContext` gains `metadata`, `quality` (by dimension), `articles` (with staleness) and `term` (the business term's value); rules carry their `ruleType`, `modality` and `scope`; domain and data-product pages list their members (`membersOf`).

**Surfaces.**
- **CLI:** `autode metadata show|set|remove|migrate` (setting and removing are a person's) and `autode articles list|show|new|check|approve`; `explore search` gains `--domain`, `--owner` and `--tag`.
- **MCP:** `autode_search_articles`, `autode_propose_article`, `autode_propose_assertion` with kind `metadata`, and the resources `autode://article/{slug}` (Markdown) and `autode://metadata/config`.
- **VS Code:**
  - the Explorer's *Set metadata…* (`editMetadata` → quick picks → `WebviewProvider.recordMetadata`, channel `panel`);
  - the *Quality* and *Knowledge* tabs, metadata rows with empty states, and *KPIs*;
  - the commands `newKnowledgeArticle` and `approveKnowledgeArticle`.

### 5.19 Knowledge maintenance and the two layer agents (v0.52.0; MM2)

Context-layer §5.6, §6.8.

**The queue is a function, not a store.** `maintenanceItems(input)` (`src/engine/maintenance/queue.ts`) runs the rules over the current state and returns items. `openMaintenanceItems` drops this engineer's dismissals. Nothing records "an event happened". So:
- an item's `key` is its cause (`<rule>:<what>[:<hash of the difference>]`): the same cause gives the same key, and a changed cause a new one;
- an item closes when its cause is gone, on every surface at once;
- the rules never call a model, under any policy.

The rules, in order:

| Rule | Reads | Agent |
|---|---|---|
| `semantic-contradiction`, `semantic-broken`, `semantic-ambiguous` | `checkSemanticModel` errors on shared models that are approved or changed since | semantic-modeler |
| `semantic-gap` | confirmed (`active`, trust confirmed or verified) metric, relationship and bound term facts with no counterpart in an approved model covering their tables (`semanticTablesFor`) | semantic-modeler |
| `article-stale` | `checkArticle(...).staleBecause` on articles not deprecated | knowledge-engineer |
| `glossary-structure` | live terms with no `category` (one item; the key hashes their ids) | knowledge-engineer |
| `document-reading` | pack documents whose content hash differs from the hash recorded at their last reading, deduplicated by hash across problems; documents in the last scan | context-curator |
| `unreviewed-turns` | `unreviewedTurns` (the C4c cues over recorded turns, minus cited and dismissed) | context-curator |
| `stage-stale` | `statusFor` stages with status `stale` (approved workflows only) | the stage's role |

Each rule is wrapped, so a rule that fails yields no items rather than breaking the list. Subjects carry asset ids, `sem:` ids, `article:<slug>`, `doc:<path>` and fact ids. `itemsTouching` matches them, treating a column's item as its table's too.

**Turns** (`turns.ts`). `recordHookTurn` takes Claude Code's UserPromptSubmit event, finds the workspace above `cwd` that has `.autode/`, and appends to `.autode/local/turns/<host>-<session>.jsonl` (ref `chat:<host>-<session>#<n>`). Slash commands and empty messages aren't recorded. `autode hook turn` calls it, writes nothing to stdout (on that event, stdout joins the context) and always exits 0. `guardHooks`/`mergeGuardHook` in `plugin.ts` carry both hooks; AutoDE's entries are found by their `hook guard|turn` command.

**Policy and state** (`policy.ts`). `.autode/config/maintenance.yaml` holds `policy` and `draft.runsPerDay`. `.autode/local/maintenance.json` holds dismissals (by, at, reason), the last scan and the draft runs. `draftRunsLeft` counts today's runs under `draft` (0 otherwise).

**The scan** (`scan.ts`). It walks the workspace for `.md`, `.markdown`, `.txt`, `.rst` and `.adoc` files no pack holds. It skips dot folders, `.autode`, `autode-output`, `node_modules`, `dist`, `out`, `build`, `target` and virtualenvs, and stops at 500 files, skipping files over 2 MB. It records the paths and hashes; the rule computes the rest.

**Work orders** (`brief.ts`). `maintenanceAssignment` renders the named role's template, its skills and the item, and lists the tools the role may call at the `propose` tier (`toolsForTier`: no hub-only or destructive tool). The same text serves `autode_maintenance_next` and the VS Code executor's `runMaintenance` (`src/core/agentExecutor.ts`, read-only file mode).

**Where it surfaces:**
- `waitingForYou` takes `maintenance` items (kind `maintenance`, low stakes); each caller computes them from its own sources;
- `exploreSources` computes them and `assetContext` lists those touching the asset;
- `autode_workflow_next` adds `maintenance` (`problemMaintenance`);
- `gateMaintenance` holds a governed gate. It is checked by the CLI (`workflow approve`, `decisions approve` of a gate) and by the panel (approve document, resolve gate); MCP never approves stages.

Under `draft`, the panel calls `draftAtStageBoundary` after a successful stage run.

**The chat as the front door** (v0.52.1; CHT-7; `src/engine/agents/chatFrontDoor.ts`).
- The panel chat creates an engine client (`chat (VS Code)`) per turn and offers the model `chatToolNames`: the read tier of `CHAT_TOOLS`.
- `chatFrontDoorPrompt` adds the agents' descriptions and the handover convention: a final `HANDOFF: <role> | <task>` line. `parseHandoff` strips it and accepts known roles only.
- `handoffFor` sends the layers' roles (no stage kind lists them) to `runHandoff` in `agentExecutor.ts`, which runs `workOrder` in `maintenance/brief.ts` at the propose tier. Stage roles are sent to the active problem's next open stage of that role.
- `parseMention` handles a leading `@<role>`.
- The chat never starts an agent itself: a click (*Run it*) or a mention does.
- `autode_work_order` gives hosts the same work order.

**Reply traces** (v0.52.2; CHT-8; `src/engine/agents/answerTrace.ts`).
- `executeAgenticTool` adds `toolResultSummary` to the audit entry of each successful AutoDE tool call: `found` (the first array's length in words), `sources` (facts, articles, assets and semantic models found by walking the JSON), and `proposed`.
- `buildAnswerTrace` turns the audit, the reply's citations (with trust, from the ledger) and the latest context pack's manifest into the trace. `stepText` words each step; `uncitedStatements` counts sentences of six words or more, excluding questions and lead-ins, that cite no fact.
- Activity (v0.52.5): every adapter reports tool calls through `LlmCompleteOptions.onStep` (`StepEvent`: running, then ok or error with `found` or `detail`). `executeAgenticTool` emits them for AutoDE's own loops; `ClaudeStreamParser` for Claude Code. The panel tags each run (`newRunId`) and posts `activity` messages (`step`, `note`, `end`, with `replace` when the reply's trace carries the steps); the webview keeps one card per run. `postEngineLog` sends the context engine's routine notices to the **AutoDE** Output channel and failures to the chat.
- ＋ New (v0.53.2): `startNewBusinessProblem` shows a modal (`workspaceKnowledge` + `knowledgeLine` from `src/engine/documents/problemOverlap.ts`) with *Start new problem* or *Open another folder…* (`vscode.openFolder`, new window). Then it clears the active problem, archives the chat and posts the prompt. `ensureActiveProblem` posts `problemOverlap(...).message` once the first statement creates the problem; the CLI's `problems new` and `autode_start_problem` return the same `overlap`.
- Stop (v0.53.1): `newRunId` registers an `AbortController` per run (`runs`), dropped at the run's `end`. The card's Stop and the progress notification's Cancel call `stopRun`. `runHost` puts the signal on `ExecutorHost.signal` and into `runAgentWithTools`; the chat passes it to `hub.chat`.
  - `LlmCompleteOptions.signal`: the fetch-based loops call `throwIfStopped` before each model call and tool call, and `fetchWithTimeout` aborts on it. Copilot and Claude Code get a `CancellationToken` from it (`tokenFor`). `endProcessTree` (`claudeCodeAdapter.ts`) runs `taskkill /T` on Windows.
  - A stop surfaces as `RunStoppedError`; `agentHub` re-throws it unwrapped.
  - `runStage` returns `stopped` with the files recorded since the run began and never calls `completeStage`; `runHandoff` and `runMaintenance` return `stopped`. The card's `end` status is `stopped`.
- LLM models (v0.52.4): `llmModels` holds a model per provider. `ConfigurationManager.getSettings` derives `activeLlmModel` for the active provider with `modelFor` (`src/core/llmModelChoice.ts`): the provider's entry, else the deprecated `activeLlmModel` when explicitly set and fitting the provider, else `PROVIDER_DEFAULT_MODEL`. Claude Code gets its instructions through `--append-system-prompt-file`, never as an argument (Windows' command-line limit).
- Claude Code (v0.52.3): `ClaudeLlmAdapter` writes a temp MCP config with `panelServerEntry` (this extension's bundle; `AUTODE_AGENT_NAME`, `AUTODE_TOOLS`) and runs the CLI with `--output-format stream-json --verbose --mcp-config … --strict-mcp-config --allowedTools mcp__autode__…`. `ClaudeStreamParser` (`src/core/claudeStream.ts`) turns `tool_use` and `tool_result` events into progress lines and audit entries, so traces are the same on every model. The server lists only `AUTODE_TOOLS` when set. The CLI's environment carries `AUTODE_PANEL_RUN=1`, which `autode hook turn` skips.
- The panel posts the trace with `chatResponse`, persists it on the transcript's `ai` message (`ChatMessage.trace`; history sent to the model uses `content` only) and redraws it on restore.

**Agents.** `agents/semantic-modeler.md` and `agents/knowledge-engineer.md` belong to no stage kind: they work items, and later a `semantic-foundation` workflow (ONT1). Their skills have `stageKinds: []`.

### 5.20 Lineage and impact (v0.53.0; CTX-15, LIN)

Context-layer §8.5. One deterministic graph, `buildGraph(sources)` in `src/engine/explore/lineage.ts`, cached per `ExploreSources` (WeakMap). It is built from the Explorer's index (`exploreIndexView`: the projected graph plus the semantic overlay, summaries and `resolveAsset`), so names and identities resolve exactly as on asset pages.

**Sources and where they are read:**

| Source | Read from | Level | Trust |
|---|---|---|---|
| observed | live `lineage` facts (`value.source: observed`) | as recorded | the fact's (`verified`) |
| designed | `ExploreSources.designs`: each problem's `mapping-context.yaml` and `spec/pipeline.yaml` (`problemDesigns` in `sources.ts`); `lineage` facts with `source: stated` | mapping: column (and table); spec: table, through each step's `params.targetObject` | approved → `confirmed`; otherwise `inferred`, `draft` |
| generated | `ArtifactUse` (grounding manifests): `subjects` (table level), subjects of `assertions` that are columns (column level) | both | `documented` |
| logical | the semantic overlay's edges: `derives_from` element → column, `maps_to` logical → physical table, `uses_table` verified query → logical table | column, table | approved model → `confirmed`, draft → `inferred` |

Edges run upstream → downstream (`from`, `to`), keyed `level|from|to`, and carry every `EdgeEvidence` (source, trust, draft, label, ref, and `via`: the mapping, pipeline, job or report the edge passes through). Column edges roll up to table edges (`rollup: true`), merged with a table edge of their own when one exists.

**Ends AutoDE doesn't hold:**
- `planned:<problem>/<last name part>` for targets a design plans. Keyed on the last part, so a mapping's `fct_orders` and a spec's `ANALYTICS.MARTS.fct_orders` are one target in a problem; its columns are `planned:…/<table>.<column>`.
- `ext:<name>` for a design's source that fits no table, or several. The note lists the candidates: never guessed.
- `artifact:<path>`, and `job:<system>/<environment>/<type>/<id>` (`entityNodeId`) for a platform's job, notebook or dashboard.
- Observed ends outside the working set keep their object id, labelled *outside the working set* or *in the estate catalog*.
`displayName` gives every node a name that reads on its own (fqn, else parent + label).

**Traversals.**
- `lineageOf(sources, ref, { direction, depth ≤ 10, level, cap ≤ 2000 })`: breadth-first with a visited set (cycles end), depth signed (upstream negative). From a table at column level, it starts from all its columns.
- `impactOf(sources, { kind, asset })`:
  - Column changes walk column edges (`direct`). Then they walk table edges from the column's table and from every table a direct hit lands in (`possible`). The first hop is only over table edges of their own (not roll-ups), and paths are prefixed with the path to the hit.
  - `remove_table` walks both levels as `direct`. `supersede_fact` lists the manifests, semantic nodes (`supportedBy`) and articles (`cites`) resting on the fact.
  - Each item's `via` carriers become mapping, pipeline and report items.
  - A possible table whose own columns are direct items is dropped, and so are the changed asset and its table.
  - Domains come from `summarize` (MM1); a column falls back to its table's.
  - Problems come from planned nodes, carriers, artifact paths (`problems/<id>/`) and semantic models' `problemId`.
- `lineageSummary` gives an asset page's one-hop counts (added by `handleExploreRequest`'s `asset` case, which avoids an import cycle with `explore.ts`).
- `coverage` notes which sources have no edges and how to add them.

**Observed lineage** (`src/engine/lineage/observed.ts`, platform-neutral).
- `recordObservedLineage(ledger, batch, identity)` turns each `ObservedEdge` into a `lineage` fact:
  - kind `lineage`, predicate `derives_from`, subject `[downstream, upstream]`;
  - `value { upstream, downstream, level, source: 'observed', method, connection, scope: system/environment, entity? }`;
  - trust `verified`, evidence `introspection` `<connection>:<method>`.
- Object ids come from `objectId` under the connection's estate identity (`recordLineageBatch` in `record.ts` resolves it), so ids match extraction.
- It is idempotent: an edge's key is method, ends and entity, and an unchanged value appends nothing.
- A `complete` batch rejects the live facts it covers (same scope and method, inside its databases) that it no longer contains, with the reason.
- Unqualified names and self-loops are skipped and reported. At most 20,000 edges per batch.
- Projection (`projection.ts`) adds a `derives_from` edge `lin:<id>` when both ends are graph nodes. `buildGraph` skips `lin:` edges and reads the facts directly.
- No adapter reads lineage (the old `QUERY_HISTORY` read was removed). Platform reads become platform operations that produce `ObservedBatch`es.

**Surfaces.** `ExploreRequest` has `lineage` and `impact` (`sources.ts`).
- CLI: `autode explore lineage | impact` and `autode lineage record <file.json> --connection --method [--complete]` (`src/cli/main.ts`).
- MCP: `autode_lineage`, `autode_impact` (`exploreTools.ts`) and `autode_record_observed_lineage` (`workspaceTools.ts`, answers under `result`).
- Renderers in `render.ts`: `renderLineage`, `renderImpactMarkdown`, `renderImpactCsv` (CRLF, quoted cells).
- The Explorer's Lineage tab (`media/explorer.html`):
  - `loadLineage` draws a Cytoscape `preset` layout, one column per hop (`layered`), edges coloured by their first source; or it shows the edge table.
  - `loadImpact` groups items by category.
  - *Export* posts `exportImpact`, which the host answers with `saveText` or `copy` (`knowledgeExplorerModel.ts`).

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
- Common `extractMetadata()` orchestration (tables → columns → FKs → profiling); `schemaFilter` (several schemas, v0.31.0) and `tableFilter` (query-through for a few tables, lineage skipped, v0.32.0) — the filter is pushed into the platform's queries via `getMetadataQueries(scope, tables)` and also applied client-side
- Profiling (v0.32.0, `profileTables()`): one sampled query per table where the platform has `profileTable` (Snowflake `SAMPLE (n ROWS)`, Databricks `TABLESAMPLE`), else one per column; bounded concurrency and a per-run query budget (`ExtractOptions.profile`); `SchemaSnapshot.profiling` reports queries issued and tables left out
- `readLastAltered(scope, tables)` for refresh on use (information_schema `last_altered`; Snowflake and Unity Catalog)
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

Oracle shipped in v0.38.0 (§6.13).

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
| `registerAdapterFactory(platform, factory)` | Add or replace a platform's adapter (v0.37.0; tests register fakes this way) |
| `allowsSampleData()` | The `sampleDataConsent` option for the active connection id (v0.37.0) |
| `probeExecutor()` | C4a probes on this connection; every probe statement passes `checkReadOnlySql()` first (v0.37.0) |

Uses a `Map<DataPlatformProvider, AdapterFactory>` for adapter registration. Since v0.37.0 `extractMetadata()` passes every snapshot through `sanitizeSnapshot(snapshot, sampleDataConsent(connectionId))` (§6.12); the option defaults to no consent, so a caller that doesn't wire it gets the safe behaviour.

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

### 6.7 Target and source contexts reference the workspace (v0.45.10, SIMP-4)

A problem's target and source contexts are its approved *choices*; what they point at is described once, in the workspace. (Until v0.45.10 the workspace also had `.autode/config/target-environment.yaml`, profiles with inheritance read by `TargetConfigManager`; nothing read it after v0.11.0, and it was removed. An existing file is left alone.)

| | Lives in | The problem's context holds |
|---|---|---|
| Target platform, account, warehouse, credentials | a named target connection (`connections.yaml`, role `target`) | `connectionId` (it decides `platform` and the default database) |
| Modelling approach, transformation and orchestration tools, naming, target database and schema | the problem's target context | the values, approved as the target stage's document |
| Source systems, environments, bindings, tables | the estate and the catalog | `sources[].system`: the estate systems in scope |
| Keys, grain, joins, quality rules | the ledger | nothing |
| A source with no connection yet | — | a `described` entry with its description |

`src/engine/context/problemContexts.ts`:
- `targetConnectionChoices(workspaceRoot)`; `TARGET_OPTIONS` (the allowed values).
- `targetDefaults({ assertions, workspaceRoot, problemId })`: project-wide, live ledger facts first (`naming_convention`; `decision` facts with predicate `modeling_approach`, `transformation_tool`, `orchestration_tool` or `target_platform`, value a string or `{ value }`), then the most recently approved target context of another problem. The target questions (`src/core/targetContextQuestions.ts`) suggest the specification's own words first, then these, then a built-in default.
- `targetChoiceErrors()` / `writeTargetContextDraft(workspaceRoot, problemRoot, choices, answers)`: validates (a named connection must exist and decides the platform; without one, the platform is required; every value from `TARGET_OPTIONS`), pins to the current specification, writes `built`, and on revising an approved revision bumps `version` and archives it to `context/history/target-context.spec<N>.v<M>.yaml`.
- `sourceSystemChoices(workspaceRoot)` (the estate's source systems, not the team's knowledge files, with their bindings) and `sourceEntryForSystem()` (connected when a connection feeds it, else from its file).
- `src/engine/agents/sourceContextDraft.ts#writeSourceContextDraft(..., workspaceRoot)` resolves every connected or file entry to its estate system (by `system`, its connection or file, or its id) and refuses one that isn't in the estate; it no longer writes `connectionSummary` / `fileSummary` (older files still read).

Which contexts a problem needs is the workflow's: the panel's gate asks for a target only when an included stage is `target-context`, and for a source only with a `source-assessment` stage. `runtime.ts#workflowNeedsSources(w)` (an included stage consumes `source-context`) makes a *not applicable* or empty source context a draft, never an approval (`documentState`, `documentApprovalProblems`). A re-opened stage records `reopenedAt`; its document approved before then reads as `superseded`, so the stage stays in progress until a new draft. A `per-source-system` stage's `systems` and `tasks` follow `sourceSystems()` until it is done.

Surfaces: the panel's Target Context form (a connection picker, then the decisions) and Source Context (*Pick from the Estate*, a multi-select of systems, or *Describe Source*); `autode_record_target_context` (no arguments: the choices) and `autode_record_source_context`; `autode context show|target|sources`. The panel's old settings-based "Connect to Source" check (`runSourceConnectionCheck`) is gone: sources come into the estate through ingestion or extraction. `environmentProfile` and `outputFormats` were dropped from `TargetContext` and `TargetEnvironment` (the runbook policy uses the connection's estate environment; nothing used the formats).

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

Requirement PLT-7. The on-demand driver design sketched here and in §6.9 was replaced in v0.38.0 by moderated installs (§6.13).

### 6.9 Real Snowflake/Databricks Execution (Phase 3b, core implemented v0.17.0; on-demand driver + onboarding UI not yet implemented)

The original Phase 3b plan was to wire the pre-existing `snowflake-sdk` dependency and a new `@databricks/sql` driver into the stub adapters. That plan was revised twice, in-session, on concrete evidence: measuring `@databricks/sql`'s real transitive footprint (Thrift, Apache Arrow, Winston, OpenID Connect client, 8 platform-specific native "kernel" binaries) alongside `snowflake-sdk`'s (the full AWS SDK, Azure Identity/Storage, Google auth — for bulk-load staging AutoDE never uses) put the combined dependency-tree cost at **~120MB**, not the few MB first assumed. Direct REST access was then evaluated as the replacement — until real-world feedback surfaced two problems with making REST the *default*: Snowflake's SQL API v2 measurably underperforms for large-scale catalog metadata extraction (AutoDE's core workflow), and it's a distinct REST surface a real slice of enterprises disable or network-restrict separately from Snowflake's native protocol (the wire path Snowsight, JDBC/ODBC, and the `snow` CLI all use instead).

**Net design: neither SDK is a dependency. A priority cascade, not a single default:**

1. **CLI-derived connection, native protocol (Snowflake only)** — a `connectionName`-bearing credential (`CliConfigResolver`, §6.8) shells out to `snow sql -c <connection> --format JSON_EXT -q "<sql>"` (`src/engine/platform/executionBackends/SnowflakeCliBackend.ts`), gated behind `dataPlatformCliConsent` (the same setting §6.8 already gates connection *listing* with — now also gates connection *execution*). This rides Snowflake's native protocol, not the separate SQL API, so it isn't subject to the network restriction above, and carries zero bundle weight. **Databricks has no equivalent** — its CLI is a thin wrapper over the exact same Statement Execution REST endpoint used below, confirmed by research — so a `profile`-derived Databricks credential is rejected with an explanation (`DatabricksAdapter.connect()`) rather than silently failing on a missing workspace URL.
2. **On-demand native driver, opt-in — not yet implemented.** The planned second tier: fetch `snowflake-sdk`/`@databricks/sql` from the npm registry's own metadata API (authoritative latest version + integrity hash, never a hardcoded version or an LLM-guessed one) into extension global storage, only for a user who explicitly opts in via a platform-onboarding UI. This is what gives a Databricks user without CLI access — or a Snowflake user on a locked-down machine — a native-protocol option beyond REST. See the plan file for the full design; not built in this pass.
3. **Direct REST call (the always-available fallback)** — `src/engine/platform/executionBackends/SnowflakeRestBackend.ts` (SQL API v2 — PAT/OAuth bearer token, or a key-pair JWT built with `crypto.sign('RSA-SHA256', ...)` alone, `src/engine/platform/adapters/snowflakeJwt.ts`, no signing dependency) and `src/engine/platform/executionBackends/DatabricksRestBackend.ts` (Statement Execution API — PAT/OAuth bearer, `warehouse_id` derived from the configured HTTP Path's last path segment). Both poll a non-terminal (`202` / `PENDING`/`RUNNING`) response to a genuinely terminal state rather than checking once and assuming success — a real bug pattern found in a public Airflow-provider issue during research, deliberately avoided here.

Each adapter's `connect()` picks the backend once (CLI-derived credential → tier 1; direct credential → tier 3 today) and stores it behind a small shared `ExecutionBackend` interface (`src/engine/platform/executionBackends/types.ts`) that `executeQuery()` delegates to — nothing downstream (`BaseDataSourceAdapter.extractMetadata()`, `ConnectionManager`) knows which backend is active. `connect()` also now runs a real validation query (`SELECT CURRENT_DATABASE()...` / `SELECT current_catalog()...`) and fails fast with a clear error on a bad credential, rather than the previous stub's unconditional "connected" response.

**New Databricks settings surface** (previously nonexistent — `ConnectionManager.getCredentialsFromSettings()`'s databricks case referenced a settings key, `workspaceUrl`, that was never declared in `DataAgentHubSettings`): `defaultDatabricksWorkspaceUrl`, `defaultDatabricksHttpPath` (the SQL warehouse's HTTP Path — also the source `warehouse_id` is parsed from), `defaultDatabricksCatalog`, `defaultDatabricksSchema`, plus a proper `databricksToken` secret (`SECRET_KEYS`, `ConfigurationManager.getDatabricksToken()`/`setDatabricksToken()`) replacing an ad hoc raw-string secret key used in a few places. `extension.ts`'s `testConnection` and `webviewProvider.ts`'s `runSourceConnectionCheck()` both overlay it now (previously only `runSourceConnectionCheck()` did — a real, pre-existing asymmetry, fixed alongside this).

`ConnectionManager.getSupportedPlatforms()` (new) reads `providerRegistry.ts` intersected with which platforms have a registered adapter factory — `providerRegistry.ts`'s second real consumer after §6.8's `getAuthModesForPrincipal()`.

`src/spokes/snowflakeExecutor.ts` (removed in v0.45.9 with the plan) no longer hardcoded `username: 'DATA_AGENT_USER'` or duplicates connection logic against `snowflake-sdk` directly — it builds credentials the same way `testConnection` does and delegates to `SnowflakeAdapter`, so it automatically gets the same tier cascade.

**Known verification gap, same discipline as §6.8:** no live Snowflake/Databricks account is available in this environment — the REST/CLI backends are implemented against the confirmed, current API/CLI contracts (see the plan file's research citations) and covered by tests using mocked `fetch`/`child_process`, not a real warehouse. A real large-schema extraction to confirm the tier-1-vs-tier-3 performance difference reported during design is flagged as a follow-up, not done here.

**Live-verified against a real production Azure Databricks workspace** (the user's own, via `.databrickscfg` — credentials never left that process, never logged). This surfaced and fixed three real bugs no amount of documentation-reading would have caught: (1) Unity Catalog's `information_schema` lives at `<catalog>.information_schema.*`, not `<catalog>.system.information_schema.*` as originally written; (2) `information_schema.views` has no `comment` column, unlike `.tables`/`.columns`; (3) the Statement Execution API's `manifest.schema.columns[].type_name` is Spark's internal type name, not SQL type text — a `BIGINT` column reports `type_name: "LONG"`, which `DatabricksRestBackend`'s value-casting now accounts for. Full `connect()` → `extractMetadata()` (with profiling) verified end-to-end against a real Unity Catalog catalog.

**Catalog-type handling is explicit-first, not silently inferred.** The same live workspace has both a legacy `hive_metastore` catalog (no `information_schema` support at all — confirmed live; only `SHOW TABLES` works, and Spark SQL can't reshape a `SHOW` command's output via `SELECT`/`WITH`, so bulk column/FK/view introspection isn't expressible as a single static query there) *and* dozens of real Unity Catalog catalogs, side by side. Rather than always inferring which shape applies from the catalog name, `defaultDatabricksCatalogType` (`'auto' | 'unity' | 'hive_metastore'`) lets a user state it explicitly per connection — `'auto'` (default) still infers from the reserved `hive_metastore` name for zero-config use, but an explicit setting always wins, and doubles as a manual escape hatch for any other catalog (a Lakehouse Federation catalog, an attached external Iceberg REST catalog, etc.) that turns out to share the legacy catalog's limitations, without AutoDE needing to special-case it by name. `BaseDataSourceAdapter.assembleTables()` also now recognizes Databricks' native `SHOW TABLES` column names (`database`/`tableName`) as a fallback, and `extractMetadata()`'s table/column listing steps are non-fatal (matching the FK/view/lineage steps' existing resilience) rather than aborting the whole extraction.

**On Polaris/Iceberg-federated catalogs specifically:** not independently live-verified (no such catalog was available to test against), but by design, any catalog that Unity Catalog or Snowflake itself manages — including an external Iceberg REST catalog (Apache Polaris, Snowflake Open Catalog) attached via Lakehouse Federation or a Snowflake Catalog Integration — is unified into that platform's own normal catalog/database model from a SQL client's perspective, so the existing Unity Catalog / Snowflake `INFORMATION_SCHEMA` queries should apply unchanged. `defaultDatabricksCatalogType`'s `'hive_metastore'` setting is available as an override if a specific federated catalog turns out not to behave that way in practice.

**Chat had zero awareness of a live connection, and the top status pill never updated after a successful connect — both real, both fixed.** Two separate "Connect" actions exist: the settings-panel "Connect" (`testConnection`) only proves connectivity; a full schema extraction only happens via the separate "Source Assessment" button, or via the Palette's "Connect to Data Platform"/`runSourceConnectionCheck` flow (which does both in one step). A user who only clicks the first "Connect" — the natural first thing to try — gets a real connection but a chat that still has nothing to say, since (a) `sidebar.html`'s `sendMessage()`/`generatePlan` slash command both hardcoded `schemaContext: ''` unconditionally, always, regardless of anything the user did (dead parameter — real schema context, once extracted, actually reaches chat through `ContextFileManager.buildContextPrompt()`'s `repositoryContext` instead, fed by `.autode/local/schema-graph.json` via a `FileSystemWatcher`-triggered reindex), and (b) nothing at all told the LLM a live connection even existed short of a full extraction, so it answered as if AutoDE had no database capability whatsoever. Fixed with a new `DataAgentHubWebviewProvider.connectionStatus` field, set via a public `notifyConnectionStatus()` called from `extension.ts`'s `testConnection`/`sourceAssessment` commands and from `runSourceConnectionCheck()` — driving both the top-of-panel status pill (`connDot`/`connLabel`, previously grabbed via `$()` but never once updated after being declared — confirmed dead UI) and a new always-included one-line chat context fact ("Connected to X, no schema extracted yet — suggest Source Assessment" when `ContextFileManager.getContextStats().tables === 0`, or the real detail once it's non-zero). This doesn't merge the two "Connect" actions or replace `repositoryContext` as the real schema-carrying channel — it just makes the gap between "connected" and "schema known" visible and self-explanatory instead of silent.

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
// ContextFileManager.setRuntimeFact(key, fact | null) — never persisted to .autode/,
// cleared on reload by construction; buildContextPrompt() renders these under a new
// "## Live Session Facts" heading, ahead of the existing Enterprise Context Layer section.
```

`ContextFileManager` stays domain-agnostic — it doesn't know what "Snowflake" or "a connection" is, just generic `{label, text}` facts keyed by a caller-chosen string. This is the decoupling point: a fact *producer* (a connection command) and a fact *consumer* (a prompt-building call site) only need to know about this one shared object, never about each other. Because most call sites already call `buildContextPrompt()`, they gained runtime-fact awareness with zero code changes of their own.

**Connection status is now role-keyed (`source`/`target`), closing a second real gap found in the same investigation:** `ConnectionManager` (`src/engine/platform/ConnectionManager.ts`) is a strict single-connection-at-a-time model, and connection status used to be a single unlabeled slot that `connectToDataPlatform()` (the actual *target*-connection-test flow, tied to `TargetContext`) never even updated. `webviewProvider.ts`'s `notifyConnectionStatus(role, status)` now writes to both a `Record<'source'|'target', {...}>` (driving two status pills in `media/sidebar.html`'s top bar — `connPill`/`targetConnPill`) and `contextFileManager.setRuntimeFact('connection:'+role, ...)` (the LLM-facing side), from all four places a connection outcome becomes known: `extension.ts`'s `testConnection`/`sourceAssessment` (source), `webviewProvider.ts`'s `runSourceConnectionCheck()` (source), and `connectToDataPlatform()` (target — previously silent). A source-role fact also states plainly when no schema has been extracted yet, pointing at "Source Assessment," so chat can no longer claim it has zero database access while a connection is genuinely live.

**Also extended to two call sites that had the biggest gaps**, since the mechanism made it cheap: `AgentHub.generateSpec()` (used by both `generateSpec`/`refineSpec`) gained an optional `context?: string` parameter, now populated from `contextFileManager.buildContextPrompt()` by both webview call sites — previously these built a prompt from user input alone. `ToolSkillAgent.buildSkillSystemPrompt()` now includes `context.schemaContext` (previously ignored entirely by tool-executing skills), fed via a new optional `liveContext` parameter on `AgentHub.runToolSkill()` rather than the stale, plan-generation-scoped `this.state.schemaContext` it silently fell back to before. `generateWithLlm`/codegen agents' use of `AgentExecutionContext.schemaContext` was deliberately left untouched — it's plan-approval-scoped by design (captures schema *as of* plan approval), a different, intentionally-non-live semantic.

No generic pub/sub `EventEmitter` bus was introduced — confirmed zero usages anywhere in `src/` before this change, and none were added. The concrete problem (N prompt-builders reinventing context assembly) is solved by "N producers write one shared object, already-existing consumers read it," which is real decoupling without a new framework; a formal event bus remains a valid future layer if a second, non-prompt-building subscriber ever needs one.

**Files:** `src/engine/context/contextFileManager.ts` (`RuntimeFact`, `setRuntimeFact()`, `buildContextPrompt()` rendering), `src/core/webviewProvider.ts` (`connectionStatus` now role-keyed, `notifyConnectionStatus(role, status)`, `chat`/`generatePlan` cases simplified to a single `buildContextPrompt()` call, `draftSpec()`/`reviseSpec()`/`runToolSkill` call sites), `src/extension.ts` (`testConnection`/`sourceAssessment` pass `'source'`), `src/core/agentHub.ts` (`generateSpec(userInput, previous?, context?)`, `runToolSkill(skillId, instruction, liveContext?)`), `src/agents/build/ToolSkillAgent.ts` (`buildSkillSystemPrompt(skill, context)`), `media/sidebar.html` (dual `connPill`/`targetConnPill`, dead `schemaContext: ''` removed from `chat`/`/plan` messages).

**Two further real bugs found live-testing this mechanism end-to-end, both structural, both fixed at the source rather than patched around:**

1. **`ContextFileManager.loadAllFiles()`'s derived-graph/legacy-schema precedence was existence-based, not freshness-based — meaning a live extraction could never be read again after the very first extension activation, ever.** `persistCompiledGraph()` unconditionally (re)writes `derived/graph.json` at the end of *every* reindex, including the first one on a completely fresh workspace with zero nodes. The old logic was `if (exists(derived/graph.json)) use it; else fall back to schema-graph.json` — since `derived/graph.json` exists after that very first reindex, `schema-graph.json` (what `BaseAdapter.persistSchemaContext()` — i.e. Source Assessment — actually writes) became permanently unreachable from that point on, for any workspace, regardless of how many times a real extraction ran afterward. Fixed by comparing mtimes instead: whichever file is newer wins, so a fresh Source Assessment's `schema-graph.json` correctly wins over a stale compiled cache and gets folded back into `derived/graph.json` on the same pass.
2. **The Snowflake card's "Source Assessment" button was wired to a second, parallel, fake implementation that never touched a live connection at all.** `webviewProvider.ts`'s `case 'sourceAssessment':` didn't call `ConnectionManager.extractMetadata()`/`persistSchemaContext()` — it just disposed and re-initialized `ContextFileManager` (re-reading whatever was already on disk) and unconditionally reported success. The *real* implementation lived only in `extension.ts`'s `sourceAssessment` command, reachable from the Command Palette but never from the button a user would actually click. This is the same class of bug `testConnection`'s webview case had already been fixed for earlier in this session (delegate to the one real command, don't duplicate it) — `sourceAssessment` had simply never received the same fix. Fixed by making the command itself return its real outcome (`{success, tableCount?, viewCount?, error?}` instead of `void`) and having the webview case delegate via `vscode.commands.executeCommand()`, then force an immediate `ContextFileManager` reindex on success (rather than waiting on the debounced file watcher) so the freshly-extracted schema is available to the very next chat message.

**New: "AutoDE: Disconnect Data Platform" command + a Disconnect button** next to Connect/Source Assessment in the Snowflake card. Calls `ConnectionManager.disconnect()` and then `notifyConnectionStatus('source', {connected: false})` unconditionally (even if the adapter's own `disconnect()` throws, since the local handle is gone either way) — which, via the same mechanism as everything above, both flips the status pill red and clears the `connection:source` runtime fact, so chat immediately stops claiming a connection that no longer exists.

See the architecture plan (`after-phase-3b-are-graceful-lagoon.md`, Part 1) for the full context inventory and design rationale this implementation followed.

### 6.11 Several schemas per connection (v0.31.0)

`getMetadataQueries(scope?)` takes `SCHEMA` or `DATABASE.SCHEMA` (Snowflake, Databricks); `BaseDataSourceAdapter.extractMetadata()` runs the per-scope extraction for every entry of `schemaFilter` and concatenates the results, reading account-wide lineage once. `getConnectionId()` is public so the host can look up the connection's binding.
Which system and environment a connection feeds, and its schema list, come from the estate (§5.11) through `ConnectionManager.setEstateResolver()`.

---

### 6.12 Connections file, read-only guard and sample-data consent (v0.37.0; MCP-1, SEC-5)

**Connections** (`src/engine/platform/connectionsConfig.ts`; the personal file, resolver `vscode` and writing since v0.39.0, §6.14). `.autode/config/connections.yaml` (`LAYOUT.connections`) lists `{ platform, role, credentials: { resolver: env|cli, ref }, allowSampleDataInPrompts, id?, …non-secret fields }`. `parseConnectionsConfig()` refuses an entry that carries a field from `SECRET_FIELDS`, an unsupported platform, an unknown resolver or a duplicate id, and reports each in `errors`; unknown non-secret keys are dropped with a warning. `connectionIdFor()` mirrors `BaseDataSourceAdapter.getConnectionId()` (CLI connection name, else account, else workspace URL), computed from the file plus, for `env` references, the non-secret `AUTODE_*` variables (`envCredentialVariable()`), so ids agree with estate bindings and with what the extension's connections report. With no matching entry, `AUTODE_SNOWFLAKE_ACCOUNT` / `AUTODE_DATABRICKS_WORKSPACE_URL` define an `environment` source connection, consent off. `resolveConnectionCredentials()` = file fields ⊕ the resolver's set (resolver wins); a `cli` reference that resolves to nothing is an error. The extension's own connections still come from settings; `sampleDataConsentFromWorkspace(root)` gives their `ConnectionManager`s the consent from this file by connection id (re-read per call).

**Read-only guard** (`src/engine/platform/sqlGuard.ts`). `lex()` skips `--` and `/* */` comments, quoted strings and identifiers, and splits on the remaining `;`. It runs twice: ANSI (no backslash escapes, no backticks, no `$$`) and Snowflake/Spark (backslash escapes, backtick identifiers, `$$` strings). Text is accepted only if both readings find exactly one non-empty statement with the same first keyword, so input that two dialects read differently (`'x\'' ; DROP …`) is refused, at the price of rejecting some valid but unusual quoting. Only `--` and `/* */` count as comments, and block comments don't nest: wherever the guard's reading differs from a platform's, the guard sees more code than the platform, never less. `checkSingleStatement()` classifies a statement as `query` (SELECT/WITH), `metadata` (SHOW/DESCRIBE/DESC/EXPLAIN) or `write` (any other first keyword, or a `WRITE_KEYWORDS` word anywhere outside literals: DML, DDL, GRANT, CALL, COPY, PUT, INTO, ANALYZE, USE, transaction control …); `checkReadOnlySql()` accepts `query` and `metadata`. `REPLACE`, `GET` and `SET` are deliberately not write words (they are also function names). Functions with side effects are invisible to it; the platform role is the boundary.

**Sample data** (`src/engine/platform/sampleData.ts`). `isPiiColumnName()` splits a name into snake_case words (camelCase is split first) and matches `PII_WORDS` and two-word `PII_PHRASES`; `looksLikePiiValue()` catches e-mail addresses and Luhn-valid 13–19-digit card numbers. `gateQueryResult()`: `metadata` results pass; without consent rows are dropped (`withheld` says why and how to allow it); with consent `maskRows()` replaces PII-named columns and PII-shaped values by `[masked]`. `sanitizeSnapshot()` drops (no consent) or masks (consent) profile `minValue`/`maxValue` and drops lineage `queryText` without consent; counts and structure stay. CSV ingestion (`fileIngestion.ts`) already kept only inferred types; a test pins that.

### 6.13 Platform prerequisites, driver store and Oracle (v0.38.0; PLT-1, PLT-7)

**Moderated installation.** AutoDE never downloads, bundles or hosts a driver.
- **Prerequisites** (`src/engine/platform/prerequisites.ts`): `checkPrerequisites()` returns, per platform, `Prerequisite { kind: cli|driver|client-library, required, state, version, detail, why, install }`. CLIs come from the existing `getCliDescriptor().detect()` and are optional (P7). The Oracle driver comes from `driverStatus()`. The `install` step carries the command, its folder, size, licence and notes, and `blocked` when `detectNpm()` (`npm --version` through the shell, fixed arguments) finds no npm. The check runs version probes, so it is only called from a command.
- **Driver store** (`src/engine/platform/driverStore.ts`): `DRIVERS.oracle` = `oracledb`, range `^6.0.0`, Thin-mode check. The root comes from `driversRoot(setting)`: the `driversDirectory` setting, then `AUTODE_DRIVERS_DIR`, then `~/.autode/drivers`. It is a user-level folder rather than VS Code's global storage because an MCP server started by another client must find it. `installCommand()` = `npm install --prefix "<root>/<id>" --ignore-scripts --no-audit --no-fund "<pkg>@<range>"`, with paths and range double-quoted for PowerShell, cmd and POSIX shells; a path containing `"` or a newline is refused. `verifyDriver()` loads the package with `createRequire(<folder>/package.json)`, checks the major version and the spec's `check()`, and writes `.autode-driver.json` `{ package, version, lockfileSha256, verifiedAt }`. `driverStatus()` reads files only and returns `missing | unsupported | unverified | changed | ready`; `changed` means the lockfile hash, version or package no longer match the record. `loadDriver()` throws `DriverNotReadyError` (with the next command to run) unless the status is `ready`, and caches the module per folder and version. Because the require path is only known at run time, esbuild leaves it alone and nothing of the driver enters a bundle.
- **Extension** (`src/core/platformPrerequisites.ts`, VS Code API passed in): **AutoDE: Check Platform Prerequisites** (a QuickPick of states; picking one installs, verifies or opens the vendor's guide), **AutoDE: Install Oracle Driver** (a modal with the command, folder, size, licence and notes, and the buttons *Run in AutoDE terminal* / *Copy command*; on Run it creates the folder, reuses or creates the terminal "AutoDE", sends the command, then offers *Verify*), **AutoDE: Verify Oracle Driver**, and **AutoDE: Set Oracle Password** (SecretStorage). Without npm, the modal offers the Node.js download or the `driversDirectory` setting. A test asserts no `spawn*`/`exec*`/`fetch` at activation or on connect, and that the command reaches a terminal only through the Run button.

**Oracle** (`src/engine/platform/adapters/OracleAdapter.ts`). It receives a `loadDriver` function (`ConnectionManager` passes `loadDriver(driversRoot(options.driversRoot()), 'oracle')`), so nothing loads before the first `connect()`. Connecting works as follows:
1. `resolveConnectString()` (`credentials/tnsnames.ts`) accepts Easy Connect as is. For an alias it finds `tnsnames.ora` (`configDir` → `TNS_ADMIN` → `$ORACLE_HOME/network/admin`), checks the alias case-insensitively (`parseTnsAliases()`: depth-0 `alias[, alias] =` entries, `#` comments, `IFILE` collected but not followed; with an `IFILE` an unknown alias is a warning, not an error), and passes the folder as `configDir`.
2. Then `getConnection({ user, password, connectString, configDir?, walletLocation?, walletPassword? })`; `fetchAsString` is set for CLOB/NCLOB. `NJS-138` (server older than 12.1) is rewritten into a "needs Thick mode" message.

Queries run with `outFormat: OBJECT`, `maxRows` and `callTimeout`. `Date` values become ISO strings, and a trailing `;` is stripped except for PL/SQL blocks. Metadata:
- `listTables`: `ALL_TABLES` (non-nested, non-secondary) ∪ `ALL_VIEWS`, with `ALL_TAB_COMMENTS` and `ALL_OBJECTS.LAST_DDL_TIME` as `last_altered`.
- `listColumns`: `ALL_TAB_COLUMNS` with formatted types (`VARCHAR2(n)`, `NUMBER(p,s)`, `RAW(n)`) and `ALL_COL_COMMENTS`.
- `listPrimaryKeys` (new optional query): `ALL_CONSTRAINTS` type `P`.
- `listForeignKeys`: type `R` joined by `position`.
- `listViews`: `ALL_VIEWS.TEXT`.
- `profileTable`: `FETCH FIRST n ROWS ONLY` over quoted identifiers.

All of it is filtered by `owner = '<SCHEMA>'` (the last part of the scope, upper-cased) with aliases quoted in lower case to match `assembleTables()`. `listDatabases()` returns the connected container (`CON_NAME`); `listSchemas()` lists `ALL_USERS WHERE ORACLE_MAINTAINED = 'N'`. Profiling skips LOB, LONG, RAW, XMLTYPE and spatial columns.

**Shared changes:**
- `BaseDataSourceAdapter.extractScope()` now sets `isPrimaryKey` from `listPrimaryKeys` and `isForeignKey` from the foreign keys it already read. Before this, both were always false on every platform.
- `getConnectionId()` and `connectionIdFor()` also use `connectString` (`oracle:PRODDB`).
- Probes gain dialect `oracle`: a `FETCH FIRST` sample, the subquery form for multi-column `unique`, and `1`/`0` for booleans.
- The read-only guard gains a third reading convention for `q'<d>…<d>'` / `nq'…'`.
- `connections.yaml` and the `AUTODE_ORACLE_*` variables accept `connectString`, `username`, `configDir`, `walletLocation`; `walletPassword` is a secret field; an Oracle entry without a connect string is refused.
- MCP: `--drivers <folder>`; `autode_explain_sql` runs `EXPLAIN PLAN FOR` then `DBMS_XPLAN.DISPLAY()`; `autode_test_connection` reads `CON_NAME`, `CURRENT_SCHEMA` and `PRODUCT_COMPONENT_VERSION`.
- Extension: the settings `defaultOracleConnectString`, `defaultOracleUsername`, `oracleConfigDir`, `oracleWalletLocation`, `driversDirectory`; `oracle` in `defaultProvider`; secrets `oraclePassword`, `oracleWalletPassword`; the connection test, Source Assessment and the source connection check handle Oracle (as a source only). The settings panel's UI for Oracle comes with DRV2 (§6.14).

### 6.14 Platform onboarding and named connections (v0.39.0; PLT-7, PLT-8)

**Two connection files** (`connectionsConfig.ts`). `LAYOUT.connections` (committed) and `LAYOUT.localConnections` = `.autode/local/connections.yaml` (gitignored). `parseConnectionsConfig(team, env, local)` parses team entries (`origin: 'file'`). Then each local item whose `id` matches a team entry goes through `applyPersonal()`: it merges fields and may replace `credentials`, the names it supplied are recorded in `entry.personal`, and secrets, `allowSampleDataInPrompts` and a different `platform` or `role` are refused with an error. Any other local item is a complete entry (`origin: 'local'`). A local item with an `id` but no team match and no `platform` is reported, not guessed. `PERSONAL_FIELDS` = `username`, `keyPath`, `snowflakeCliPath`, `configDir`, `walletLocation`. Snowflake's role is the file field `snowflakeRole`: `role` is the source/target key, which used to make an entry with a Snowflake `role` invalid. `adapterFields()` maps it back to the adapters' `role`. An Oracle target entry is refused.

**Resolver `vscode`.** `CONNECTION_RESOLVERS` = `env`, `cli`, `vscode`. `resolveConnectionCredentials(entry, env)` maps `vscode` to `VSCODE_SECRET_RESOLVER_ID` (`vscode-secret-storage`, registered only by the extension, `credentials/types.ts`). When that resolver isn't registered (the MCP server), the secret fields `secretFieldsFor(platform, fields)` comes from `envCredentialVariable(platform, ref, field)` instead (`envStandInVariables()`). If none is set and the auth mode needs one, it throws an error naming the variables. Snowflake key-pair needs none; the passphrase is optional. `VsCodeSecretStorageResolver` gains Oracle `password`/`walletPassword` and Snowflake `token`. `autode_list_connections` adds `secretFromEnv` for `vscode` entries, and `PlatformSession` passes its own `env` to the resolution.

**Writing.** `saveConnection(root, draft)` validates the draft (platform, known fields, no `SECRET_FIELDS`, resolver, Oracle source only), computes `connectionIdFor()`, then splits `PERSONAL_FIELDS` from shared fields. Both files are edited through the `yaml` Document API (`parseDocument`), so comments and order survive; a new file gets a header comment, and the write is tmp + rename.
- A new team entry is appended with an explicit `id`, flow-style `credentials` and `allowSampleDataInPrompts: false`.
- An existing team entry (matched by explicit or computed id) gets its shared fields replaced, and its personal keys and consent are left alone. If its credentials differ from the draft's, the draft's credentials go to the local item instead (`credentialsLocal`).
- `scope: 'personal'` writes the whole entry to the local file.

`removeConnection(root, id)` deletes the item from both files. `ensureLayout()` creates `.autode/.gitignore`.

**Readiness** (`src/engine/platform/connectionReadiness.ts`). `.autode/local/connection-readiness.json` = `{ connections: { [id]: { entryHash, checkedAt, ok, detail } } }`. `entryHash()` is a SHA-256 prefix over platform, role, the sorted fields and the credentials pointer, so any edit makes the record `stale`. `connectionStatus(entry, record)` gives `autode`: `ready | failed | unchecked | stale` and `mcp: { ready, note }`. MCP is ready only when AutoDE is ready, and a `vscode` entry whose auth mode needs a secret is never MCP-ready: the note names the stand-in variables. The note also says `env` entries need the same variables in the client, that Snowflake CLI paths need `--allow-cli`, and that Oracle needs the drivers folder.

**Databricks profiles.** `DatabricksAdapter.connect()` no longer rejects `profile`. `readProfile()` reads that `.databrickscfg` profile (`readDatabricksCfgProfiles()`, `DATABRICKS_CONFIG_FILE`) for `host` and `token` at connect time, so the resolver still returns only a pointer. A profile without a token (OAuth, Azure CLI auth types) is explained, not attempted, and `httpPath` must come from the entry.

**Extension** (`src/core/platformOnboarding.ts`, no `vscode` import: the host passes secret storage, settings, the two secret-key functions and a `ConnectionManager` factory). `PlatformOnboarding`:
- `state()`: the saved connections with status, the active ids, file errors, and `backends` (`backendFor()`: Snowflake SQL API / Snowflake CLI by auth mode, Databricks REST, Oracle Thin, each with its caveat).
- `prerequisites(platform)`: DRV1's `checkPrerequisites()` for one platform.
- `existing(platform)`: `connections.toml` names (`listSnowflakeConnectionNames()`, read from the file, no CLI run), `.databrickscfg` profiles (marked unusable without a token), or tnsnames aliases (`readTnsNames()`).
- `saveFromCard(platform, role, { cliRef?, scope })`: builds the draft from the card's settings (`getCredentialsFromSettings()`, filtered to `CONNECTION_FIELDS`), or `{ resolver: 'cli', ref }` with only the fields the CLI can't supply (Databricks `httpPath`, catalog, schema). It connects with a throwaway manager, and only if that passes does it store the card's secrets under `secretStorageKey(platform, 'interactive-user', ref, field)` (ref = the id without the platform), call `saveConnection()` and `recordReadiness(ok)`.
- `credentialsFor(id)`, `markChecked()`, `recheck(id)`, and `remove(id)`, which also deletes the stored secrets.

`extension.ts` builds it with the same `managerOptions()` as the connection test. `runConnectionTest(role)` first reads `activeSourceConnection` / `activeTargetConnection`: when set, platform and credentials come from `credentialsFor()` (the resolvers, as in the MCP server) and the outcome is recorded with `markChecked()`. Otherwise the settings path runs unchanged. The webview provider routes `platformsState`, `checkPrerequisites`, `prerequisiteAction` (Oracle install/verify through the DRV1 commands; `https:` guides only), `findExistingConnections`, `saveNamedConnection` (on success it also sets the role's active id), `useConnection` (set it, then run the role's Connect), `stopUsingConnection`, `recheckConnection` and `removeConnection` (modal confirm; clears an active id that pointed at it).

**Webview** (`media/sidebar.html`). `setupOnboarding()` injects into every source and target card a `.onb` block: an active-connection banner, *Check prerequisites* (items with Install… / Verify / Install guide, and the install command shown before it runs), the backend line, *Use an existing …* select with *Find existing* (an Oracle alias fills the connect string), plus a save row (*Save as named connection*, *Share with the team*). Save stores the card's settings first (`saveSettings(true)` keeps the panel open) and posts `saveNamedConnection` on the `settingsSaved` ack, the same ordering Connect uses. `renderPlatformsState()` draws *Saved connections* at the top of each tab: id, AutoDE and MCP badges (the MCP note is shown), origin, resolver, and *Use* / *Use card fields*, *Re-check*, *Remove*. There is a new Oracle source card; there is no Oracle target card.

## 7. Agent Orchestration

### 7.1 The model services (`AgentHub`)

`src/core/agentHub.ts` (`DataAgentHubHub`) holds the extension's model-facing services. Since v0.45.9 (SIMP-3) it has no plan of steps: the workflow is the only path (§7.9), and stages run from the Workflow view (`src/core/agentExecutor.ts`) or in a host agent.

| Responsibility | Implementation |
|---|---|
| Specification | `generateSpec()`, `discoverNextAction()`, `synthesizeComprehensiveSpec()`, `extractAttachmentFacts()`, `completeJson()` |
| Chat | `chat()`, grounded in the active specification and target (`buildChatContextBlock()`), with history windowing and rolling summaries |
| The model with tools | `runAgentWithTools()` (the stage executor), `runToolSkill()` (imported tool skills, §7.6) |
| Engine clients | `setEngineFactory()`, `createEngine(clientName)` (one per stage run, named after the role) |
| State | the active spec id and version, the objective and the target environment; `resetForNewProblem()` clears them |

### 7.2 Agents

Every AutoDE agent is a role template run against a stage assignment (§7.9). The one agent module left is `src/agents/build/ToolSkillAgent.ts`, which runs an imported tool skill (§7.6). Until v0.45.9 the plan dispatched `snowflakeExecutor` steps; until v0.45.4, codegen agents used three tiers (GEN-1, GEN-2: primitive, freehand, template).

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

### 7.4 Context gaps in assignments (v0.45.9)

A stage whose work rests on joins, keys and grain (mapping, modelling, build, quality rules, conformance, validate) gets the gaps in its context in its assignment. `src/engine/agents/stageGaps.ts`:
- `stageGapQuery(problemRoot, title)`: the problem's statement, objectives and key entities, and the stage title.
- `stageContextGaps(sources, { problemRoot, kind, title })`: a `step` context pack for that query; its relationship, key, grain and structure gaps, once each, with `describeGap()`'s question.
- `renderStageGaps()`: the assignment's *Context gaps* section. It tells the agent not to infer them: ask the person, propose the fact (`autode_propose_assertion`), or record the gap as open in the deliverable.

`autode_workflow_next` builds the pack from the server's context sources. Run agent (`agentExecutor.ts#stageGaps`) gets it through `autode_get_context_pack` and the same `stageGapsFrom()`. `Assignment.contextGaps` carries them; nothing pauses (the plan used to pause a step on them).

### 7.5 Implementation type

`src/core/implementationType.ts#classifyImplementationType()` classifies a specification as greenfield or brownfield from keyword evidence (`src/core/keywords.ts#matchesAnyKeyword`); a user override survives revisions. (Phase inference, `src/core/phaseInference.ts`, was removed in v0.45.9.)

### 7.6 Tool-executing skills (SKL-1 – SKL-5)

- **Import:** `AutoDE: Import Tool Skill` copies a folder containing `SKILL.md` into `.autode/config/skills/tool-skills/<id>/`; `src/engine/skills/toolSkills.ts` parses it leniently (optional YAML frontmatter: `name`, `description`, `allowed-tools`; the body becomes the instructions) into a `ToolSkillDefinition`.
- **One execution path for every provider (v0.28.0):** `ToolSkillAgent` builds the prompt (skill instructions, resources list, step context) and calls `context.runWithTools()`, which `AgentHub.runConfiguredLlmWithTools()` implements as one `getLlmAdapter(provider).complete(...)` with a tool mode. Each adapter runs its own loop (§8): OpenAI-compatible (OpenAI, Azure OpenAI, Ollama), Anthropic, Gemini and Copilot loops execute AutoDE's tools; Claude Code runs its CLI loop.
- **Allow-list:** `src/engine/skills/toolAllowList.ts#resolveAllowedToolNames()` maps declared `allowed-tools` (e.g. `Read`, `Grep`, `Bash(git:*)`) onto AutoDE tools (`autode_read_file`, `autode_search_files`, `autode_list_dir`, `autode_write_file`, `autode_run_command`). Nothing declared → no extra restriction; declared but unrecognised → no tools. `toolModeCeiling()` never grants `full` to a skill with no write/exec tool. `toolSpecsForMode(mode, allowed)` (`src/core/agenticTools.ts`) builds the offered tools; `executeAgenticTool` refuses (and audits as `denied`) any call to a tool the run wasn't offered.
- **Engine tools (v0.43.0, §10.9):** `ToolSkillAgent` asks `context.engine` (an `EngineClient`) for an `EngineToolSet` and passes it as `AgentToolRunOptions.engineTools` → `LlmCompleteOptions.engineTools`. `toolSpecsForMode(mode, allowed, engine)` appends its specs when the mode isn't `none`, and `executeAgenticTool(..., engine)` routes calls to them and audits them like file tools. Gemini gets the schemas through `geminiSchema()` (type, description, enum, items, properties, required). Selection (`selectEngineTools`): read-only tools in `read-only`; also non-destructive writes (the proposal tools, `autode_verify_assertion`) in `full`; never a `destructiveHint` tool (`autode_resolve_decision`, `autode_apply_decision`); narrowed by declared names (`autode_x`, `mcp__autode__autode_x`, `mcp__autode__*`). A declared engine write raises the mode ceiling (`toolModeCeiling(allowed, declaresEngineWrite)`), and the trust tier still caps it, so a reviewed skill never gets one. The Claude provider gets no engine set. The engine is disposed after the run.
- **Sandbox and approval:** paths resolve against the workspace root and are rejected if they escape it; commands run with the workspace as cwd; each write or command on an AutoDE-owned loop asks for confirmation. Every call is appended to `LlmCompleteOptions.auditSink` and returned as `details.audit`.
- **Claude Code:** the CLI's `--tools` list is narrowed to the allow-list (`autode_read_file` → `Read`, `autode_search_files` → `Grep`, `autode_list_dir` → `Glob`, `autode_write_file` → `Edit` + `Write`, `autode_run_command` → `Bash`); `--permission-mode acceptEdits` only when a write tool remains. The whole run is approved once with caller-supplied text (`approvalPrompt`) stating that individual calls can't be audited or blocked.
- **Invocation:** `/skill <id>[@<version>] <instruction>` in chat, or `AutoDE: Run Tool Skill`; `AgentHub.runToolSkill(id, instruction, context, version?)` runs it as a single step outside the DAG, with a `step`-purpose pack built from the instruction. `PlanStep.skillVersion` pins a version.
- **Lifecycle, provenance and trust (v0.34.0, SKL-5)** — `src/engine/skills/lifecycle.ts` (no `vscode`; the MCP server uses the same rules):
  - **Sidecar** `<skill>/.autode-skill.json`: `{ status: draft | published | deprecated | retired, version, provenance { source: local | git, repoUrl?, ref?, resolvedCommit?, subpath?, contentChecksum, importedAt }, trustTier, publishedChecksum?, transitions[] }`. `SKILL.md` is never modified. Import deletes any sidecar or `.autode-history/` the source folder brought, so a skill cannot ship its own trust.
  - **Checksum** `skillContentChecksum()`: SHA-256 over every file's relative path and bytes, sorted, excluding the sidecar and `.autode-history/`; text files with CRLF normalised so a `core.autocrlf` checkout keeps trust.
  - **Trust is per content**: each `review` (or `migrate`) transition records the checksum it applies to; `tierForChecksum()` = the last such transition for the current checksum, else `unreviewed`. `ToolSkillState.effectiveTier`, `changedSinceReview`.
  - **Migration** `migrateToolSkills()`: once per tool-skills folder (marker `.autode-skills-migrated`), skills without a sidecar get `published` v1 `trusted` for their content (transition `migrate`). Afterwards a folder without a sidecar is `unreviewed`.
  - **Gates**: `tierModeCeiling()` (unreviewed none, reviewed read-only, trusted full); `resolveToolExecutionMode(skill, allowed, tier)` = the lower of that and S1's `toolModeCeiling()`. `isClaudeCliEligible()` = trusted. `isSkillRunnable(state, { pinned })` = published (or deprecated when pinned) and not unreviewed; `isSkillExposable()` = published and not unreviewed (MCP `prompts/list`, phase 3). `notRunnableReason()` gives the user-facing reason. `ToolSkillAgent` checks all three before any LLM call and returns `skillVersion`, `trustTier`, `contentChecksum` in `details`.
  - **Versions**: `recordImport()` → `published` v1 (or `draft` with `toolSkillManagementEnabled`), unreviewed. `publishToolSkill()` keeps the version on a first publish and bumps it when the content differs from `publishedChecksum`; publishing unchanged content is refused; every published version is snapshotted (content + sidecar) to `.autode-history/v<N>/`. `resolveSkillVersion(dir, id, N)` uses the live folder while it is still exactly version N, else the snapshot, with the tier granted to that snapshot's checksum and the live status (retired applies to every version). `deprecateToolSkill()` (from published), `retireToolSkill()` (from any but retired).
  - **UI** (`extension.ts`): `AutoDE: Review Tool Skill` opens `buildSkillReviewDocument()` (status, effective tier, provenance, checksum, declared and granted tools, resource files, `SKILL.md` verbatim, history) and asks for a tier in a modal; `Publish/Deprecate/Retire Tool Skill` are hidden from the palette unless `autoDataEngineeringHub.toolSkillManagementEnabled`. The run picker lists only runnable skills. Transitions go to the sidecar (durable, with `by` = OS user name) and the `AutoDE: Tool Skills` output channel.

---

### 7.8 Workflow templates and runtime (v0.44.0; ORC-9, PA3a)

- **Stage kinds** (`src/engine/workflows/stageKinds.ts`). There are 17 kinds, each with roles, a permission ceiling (`TIERS`: read < propose < platform-read < workspace-write), `consumes` / `produces` artifacts (`ARTIFACTS`; `contract`, `legacy-code` and `estate` count as external) and default gates.
- **Templates** (`templates.ts`; bundled `workflows/*.yaml`, overridden by id from `.autode/config/workflows/`; schema `docs/schemas/workflow-template.schema.json`, registered under `yamlValidation`).
  - `parseTemplate()` reports every error.
  - `when:` uses `parseCondition()`: a fact (`estate.sources`, `estate.systems`, `pack.has_contract`, `estate.has_legacy_code`), `not <fact>`, or `<fact> <op> <n>`.
  - `after:` entries may end in `(approved)`.
  - `checkStructure()` enforces: specify then plan first and mandatory; dependencies known and acyclic (`findCycle()`); every consumed artifact has a producer.
  - `suggestTemplate()` scores `suggestWhen` keywords, plus the number of source systems for estate-merge.
- **Instance** (`instance.ts`; `.autode/problems/<id>/workflow.yaml`). `draftWorkflow()` builds a deterministic draft: mandatory and default stages; conditional ones from `workflowFacts()` (estate source systems, a contract in the pack); optional ones left out; repeated stages carry the source systems as tasks; each stage gets its kind's first role at the ceiling.
  - `checkWorkflow()` enforces the plan rules: mandatory stages and their gates kept; reasons for default and conditional stages left out and for added stages; roles and tiers allowed by the kind; included dependencies and producers.
  - `diffWorkflow()` gives the approver's summary.
- **Runtime** (`runtime.ts`), the hub. `syncWorkflow()` brings `record`s up to date.
  - **Document-backed stages** (specify, target context, source assessment, mapping, build) take their approval from their documents' `status` (specify also needs `problemStatementApproved`). The panel, CLI and MCP therefore can't disagree, and no panel handler was rewired.
  - **Other stages** are approved by a `gate` decision.
  - **Staleness.** On approval the stage records the revisions of its inputs: documents by content hash, gated artifacts by the approving decision. A later difference marks it `stale`, and a stale stage is approved again through a gate decision.
  - **Actions:** `startStage()` (working ahead is allowed, with a warning), `completeStage()` (named outputs must exist; with `check`, at least one is needed; with `approve`, a `gate` decision is created), `skipStage()` (never a mandatory stage, nor one whose output a later stage consumes), `reopenStage()` (everything downstream turns `stale`) and `nextAssignment()` (stage, role, tier, consumes, produces, instructions).
- **Service** (`service.ts`), shared by the panel, CLI and MCP: `ensureWorkflow()` drafts on first use, which also migrates older problems (brownfield to modernization), plus `redraft()`, `statusFor()`, `suggestFor()`, `proposeWorkflow()` (withdraws an older pending proposal) and `approveWorkflow()`.
- **Decisions.** New kinds: `workflow` (high stakes; `validateWorkflowProposal()` uses `ProposalContext.resourcesRoot` to load templates, and warns that a template change restarts; applying it writes the instance as approved, keeping stage records when the template is the same and resetting them otherwise) and `gate` (applied as a no-op; the runtime reads the decision).
- **Panel.** A Workflow section in the Workflow Palette (`workflowState` and `workflowAction` messages): draft and propose, then approve in the Context Inbox; hand in, skip, re-open. `computeContextGateStatus()` now requires the approved workflow, and takes "source context applies" from the workflow's source-assessment stage instead of the brownfield flag. `AgentHub`'s `contextGateReady` follows from it.
- **CLI:** `autode workflow templates | status | plan | next | start | complete | approve | skip | reopen | history`.
- **History and provenance (v0.44.1)** (`events.ts`; `.autode/problems/<id>/workflow-events.jsonl`, append-only, written only by the engine).
  - **Events:** `suggested`, `drafted`, `proposed`, `approved`, `rejected`, `started`, `handed-in`, `done`, `stale`, `skipped` and `reopened`. Each has an `Actor` (`engine` with its rule, `person`, or `agent` with its host), plus channel, reason, decision and files.
  - **Who writes them:** `syncWorkflow()` records approvals it observes, with the channel from the decision's resolving event, or `document` with the document's `approvedBy`, and staleness. The stage actions take an `Actor` and a channel. `draftFrom()` records the engine's suggestion, the draft and a person's choice of template. Applying a `workflow` decision records its approval.
  - **Provenance on the instance:** `provenance` holds `suggested` (template and rule), `chosenBy`, `draftedBy`, `refinedBy` (PA3b) and `proposedBy`.
  - **Reading:** `historyFor()` syncs first, then reads the log. `stageDetail()` adds the stage kind's rules, the record and the gate decision's trail.
- **Workflow view (v0.44.1)** (`src/core/workflowViewModel.ts`, no `vscode`; `src/core/workflowView.ts`; `media/workflow.html`).
  - **View model:** `buildWorkflowModel()` gives the provenance labels, a dependency depth per stage (the board's columns), and each stage's person actions (approve, hand-in, approve-again, skip, reopen).
  - **Tree:** `autoDataEngineeringHubWorkflow`. Context values carry the actions, and the menus match them with `(^| )action( |$)`.
  - **Editor tab:** `WorkflowPanel`, a CSP-locked webview with a nonce. Board, stage detail, decision trail and history; approvals are confirmed in a modal and go through `resolveFromView()` (the panel channel).
  - **Status bar:** `statusBarText()`.
  - **Refresh:** file watchers on `.autode/problems/**`, `decisions`, the active-problem pointer and the estate (debounced 300 ms; a refresh never throws).
  - **Today's agents:** an "AutoDE agents" box runs them through `agentsRunState()` and `runAgentsAction()` until PA3b.
  - **Palette:** its Phases, Agents and Continue Workflow sections are replaced by a link to the view.
- **Waiting for you** (v0.45.7, `src/engine/approvals/waiting.ts`): `waitingForYou()` lists pending decisions (each with where it opens and its terminal command: workflow, gate, runbook, or the decision file), the caller's Context Inbox facts as one item, the problem's document stages awaiting approval with no gate decision, and runbooks awaiting a second approver, sorted high stakes first. Surfaces: the Workflow tree's first group (`autoDataEngineeringHub.openWaiting`) and the status bar, `autode approvals`, `autode_approvals_list`. It approves nothing itself.
- **MCP** (`src/mcp/workflowTools.ts`): `autode_workflow_templates`, `_status`, `_next`, `_start_stage`, `_complete_stage`, `_skip_stage`, `_reopen_stage` and `autode_propose_workflow`. None of them approve.

### 7.9 Roles, skills and assignments (v0.45.0; SKL-6, PA3b)

- **Definitions** (`src/engine/agents/definitions.ts`):
  - role templates: `agents/<role>.md` (bundled) and `.autode/config/agents/<role>.md` (the workspace's, overriding by name). Frontmatter `name` (must equal the file name), `description`, `tools` (AutoDE tool names), `skills`; the body is the instructions;
  - skills: `skills/<id>/SKILL.md`, the Agent Skills format. `name` is lowercase words joined by dashes, at most 64 characters, and equals the folder; `description` is at most 1024 characters; the body is required;
  - `checkDefinitions()` flags a role that names a skill that doesn't exist.
- **Assignments** (`src/engine/agents/assignment.ts`): `assignmentFor(scope, stage, tools)` takes the stage's role (`agent.role`, else the kind's first role), its tier (`agent.tier` within the kind's ceiling, else the ceiling) and its skills (`agent.skills`, else the role's). It returns the tools, the file mode (read-only below workspace-write) and `text`, the full instructions.
- **Tools by tier:**
  - `toolTier()` reads the annotations: read-only → read; open-world → platform-read; anything else → propose; destructive → never;
  - `HUB_ONLY` excludes starting, handing in, skipping, re-opening and proposing the workflow, resolving and applying decisions, reviewing facts, and starting or selecting problems;
  - `autode_record_artifact` is allowed at any tier;
  - the role's tool list narrows the result.
- **Recording** (`src/engine/agents/artifacts.ts`): `recordArtifact()` writes under `outputDirSegments(problem)/<phase>/<stage>/` (phase from the stage kind), archives the previous revision to `history/`, writes `<file>.grounding.json` with `buildGroundingManifest()`, and appends a `recorded` event.
- **Surfaces:**
  - **MCP** (`src/mcp/workflowTools.ts`, `catalogs.ts`): `autode_workflow_next` adds `assignment` (or `noAssignment` with the reason); `autode_record_artifact`; prompts `autode_agent_<role>`;
  - **VS Code:** `runStage()` in `src/core/agentExecutor.ts`, from the Workflow view's `run` action. It uses `EngineClient` with `clientName` set to the role and `toolSetNamed()` for the exact tools, `AgentHub.runAgentWithTools()` for the model, then `completeStage()` as `{ kind: 'agent', name: role, host: 'VS Code' }`.
- **Hosts** (`src/engine/agents/plugin.ts`, `autode plugin`):
  - `buildPlugin()` builds Claude Code's layout, which Cortex Code also reads. Agents get `tools: Read, Grep, Glob, mcp__autode__…`;
  - `installPlugin()` writes each host's folders, renders Copilot agents as `*.agent.md` with `tools: ["read", "search", "autode/…"]`, and merges the project's `.mcp.json` for Claude Code. Elsewhere it returns the step to take;
  - `serverEntry()` uses `autode mcp` when it is on PATH, else node on the package's own bundle.

- **The source assessor and the mapper** (v0.45.2):
  - `autode_match_columns` (`src/engine/agents/columnMatch.ts`): `scorePair()` scores 1 for the same name, 0.95 for the same name apart from case and separators, 0.85 for the same name without the table prefix, 0.8 for the same vocabulary concepts, and 0.6 × Jaccard for words in common. An approved precedent adds 0.2 (`mappingPrecedents()` reads every problem's approved mapping document); types that don't convert halve the score. `matchColumns()` assigns greedily one-to-one at or above 0.5, with two runners-up per source column.
  - `autode_record_mapping` (`src/mcp/agentTools.ts`): `validateMappingProposal()` against the schema index, then `writeMappingUpsert()`, which now pins the document to the current spec (a new spec lineage starts afresh) and writes `pending` as `built`.
  - `autode_record_source_context`: `writeSourceContextDraft()` (`src/engine/agents/sourceContextDraft.ts`) checks each entry, pins to the spec, bumps the version after an approved revision (archived to `context/history/`) and writes `built`.
  - Both append a `recorded` event to the stage: the named one, else the first included stage of the kind.
  - **Role and skill choice** in `assignmentFor()`: among the planned role and the others the kind allows that have a definition, the first whose skills include the kind's skill (`KIND_SKILL`, else the kind's id), else the first defined. That role then gets only that skill.
  - **Executor:** a document stage awaiting approval (no gate decision) can be run again; a role-template run on a document stage is not handed in, because the document's approval completes the stage.
- **The data modeler** (v0.45.3, `src/engine/agents/modelDraft.ts`):
  - `draftModel()` takes the problem's mappings (`problemMappings()`), the schema index, the live assertions (active, proposed, needs review) and the target context (`targetSettings()`). It makes one entity per target name. Its kind comes from the name prefix. Grain and key come from facts on the target, else from the single source's facts mapped through the mapping, with provenance. Dimensions in a dimensional model get a surrogate `<name>_key`, with the fact key as the natural key. Foreign keys come from relationship facts whose two sources map to different entities.
  - `checkModel()` returns errors and warnings (see the changelog). `renderModelDdl()` writes `CREATE TABLE` statements in dependency order, qualified with the target's database and schema.
  - Tools: `autode_draft_model` and `autode_check_model` (`src/mcp/agentTools.ts`). The model is recorded with `autode_record_artifact` and approved at the stage's gate.
- **The runner** (v0.45.6, `src/engine/runner/`):
  - `runbook.ts`: `classifySql()` (`checkSingleStatement()` plus the destructive keywords), the CLI allowlist `CLI_ALLOWLIST`, `checkRunbook()` (classification, allowlist, `FORBIDDEN_FLAG` and `SECRET_VALUE` arguments, workspace paths, rollback, the environment's classes; it adds `--connection` or `--profile` from the entry), `runbookRevision()` (SHA-256 of the runbook), and the record `runbooks/<id>.yaml` with approvals bound to the revision (`approveRunbook()`, `runnableProblem()`).
  - `policy.ts`: `.autode/config/approvals.yaml` → `RunbookPolicy`. `environmentOf()` returns prod for an unlisted connection; prod is never unattended. Also `approverProblem()` and `approvalsNeeded()`.
  - `run.ts`: `runStep()` re-checks the runbook with today's connections and policy, enforces order, executes through a `RunnerHost`, redacts (`redactRun()`), logs, updates states and hands the stage in (`completeStage()`) when every step is done. `runRemaining()` runs the rest only where the environment is unattended.
  - `runLog.ts`: `appendRunLog()` and `verifyRunLog()` (each entry's `prev` is the previous `hash`; `hash` is the SHA-256 of the entry).
  - The decision kind `runbook` (`proposals.ts`): `validateRunbookProposal()`; applying writes the record and the first approval.
  - `src/mcp/runnerHost.ts`: `createRunnerHost()` uses a write-enabled `PlatformSession` for SQL (explain, read, approved change) and `spawn()` with no shell for commands.
  - VS Code: `src/core/runbookView.ts` (`RunbookPanel`, `autoDataEngineeringHub.openRunbook`) over `src/core/runbookViewModel.ts`, with `media/runbook.html`.
  - CLI: `cmdRunbook()`. MCP: `autode_propose_runbook` (`decisions.ts`) and `autode_runbook_status` (`agentTools.ts`).
- **Governance as code** (v0.47.0, GOV; SEC-4, SEC-5; `src/engine/governance/governance.ts`, no vscode):
  - **Facts:** `business_rule`, predicate `classification` (`CLASSIFICATION_PREDICATE`), value `{ classification, strategy?, level, text }` (the value schema now lists `classification`). `governanceFacts()` reads live ones, the latest per column with active before proposed; `splitColumnSubject()` reads `obj:<system>/<env>/<db.schema.table>.<column>` (or a plain `table.column`); `sameTable()` matches qualified and unqualified names. `classifyColumn()` (CLI and panel) asserts a confirmed fact, superseding the column's earlier one; `columnSubject()` finds the column's object id among the graph's nodes.
  - **Candidates** `governanceCandidates()`: `isPiiColumnName()` (from `sampleData.ts`), `SENSITIVE` for the sensitive suggestion, `defaultStrategy()` (redact for credentials, else hash). `personalDataInPlay()` (facts, column names, the statement's words).
  - **Primitive** `src/engine/transforms/primitives/mask.ts` (`maskPrimitive`, registered in `TRANSFORM_PRIMITIVES`): `maskExpression()` wraps each masked column in `CASE WHEN c IS NULL THEN NULL ELSE … END`; `sha256()` per dialect (`SHA2`, `sha2`, `TO_HEX(SHA256())`, `encode(sha256(convert_to()))`, `HASHBYTES('SHA2_256')` lowered); `SALT_EXPRESSION` validates the salt in the param schema.
  - **Checks:** `unmaskedSensitive()` runs inside `validatePipelineSpec()` once the schema passes. `governanceGaps()` maps fact columns through the entity's `rename_cast` (a column it doesn't project is ignored) and returns errors and warnings. It is called by `autode_record_pipeline_spec` (warnings returned) and by `documentApprovalProblems()` for `build`, which reads the ledger with the new `AssertionLedger.loadSync()`.
  - **Candidates for the build:** `primitiveCandidates()` adds a `mask` step after `rename_cast` (source = staging, target `<staging>_masked`, passthrough the other plain columns) and the entity's `governance` block; `dedup` and `incremental_load` read the masked view.
  - **Interview:** `SkillDefinition.askWhen`, `SkillMeta.interview.askWhen` (validated by `skillMeta()`), carried by `interviewPartFromSkill()`. `startInterview()` (optional `columns`) leaves out conditional parts' fields unless `personalDataInPlay()`; `summarizeInterview()` lists a conditional part only when its fields are covered.
  - **Specification:** `BusinessProblemSpec.governance` (`SpecGovernance`), `SourceEntry.sensitivity`, `DataFlow.sensitivity`; `parseSpecGovernance()` and `parseSensitivity()` in `problemDocuments.ts` and `specSynthesis.ts`; serialised, cloned by `SpecManager`, in the synthesis prompt (`specOpsPrompts.ts`).
  - **Sample rows:** `gateQueryResult()` takes `classified` column names; `autode_execute_query` passes the personal ones from the facts.
  - **Surfaces:** CLI `cmdGovernance()` (`governance show | classify`; options `--as`, `--strategy`). MCP `autode_governance_candidates` (`agentTools.ts`). VS Code `autoDataEngineeringHub.classifyPersonalData` (`extension.ts`) over `governanceCandidates()` and `classifyColumn()` on the panel provider.
- **Port a skill** (v0.46.0, PA4; SKL-5, SKL-7; `src/engine/skills/port.ts`, no vscode):
  - **Staging** `stageSource()`: a local or dbt folder is walked in place (`SOURCE_CAPS`: 2,000 files, 30 MB, 5 MB per file; symlinks refused). A Git source is `git clone --depth 1 --no-checkout` into `os.tmpdir()`, then `git ls-tree -r -l -z HEAD` is checked (paths with `..`, absolute or drive paths, mode `120000` links, `160000` submodules, the caps) before `git checkout`. `resolvedCommit` comes from `git rev-parse HEAD`. The `GitRunner` is injectable (tests use a fake hostile tree).
  - **Discovery** `discoverSkills()`: every folder with `SKILL.md`, six levels deep, `dbt_packages/*` included. **Analysis** `analyzeSkill()` reads `parseSkillMarkdown()` (now with `license`), maps `allowed-tools` through `resolveAllowedToolNames()`, collects `mcp__<server>__…` names, the CLIs in code blocks and inline code (`KNOWN_CLIS` → DRV1 guide ids), scripts (`SCRIPT_EXT` or `scripts/`), the licence (`detectLicence()`: frontmatter, then `LICENSE*` in the skill or the repository), overlaps (same id, or word overlap of at least 30% with an AutoDE skill's description), `metadata.stageKinds`, and the heuristic class (scripts, shell or write tools, CLIs or proposal tools make a procedure).
  - **Proposal** `buildPortAnalysisPrompt()`, `parsePortProposal()` (unknown AutoDE tools become `null`), `decideProposal()` (`by: model | person`). **Report** `capabilityReport()` (markdown).
  - **Import** `importSkill()` copies without AutoDE's own files, calls `recordImport()` (provenance gains `source: 'dbt'`, `location`, `licence`) and writes `.autode-port.json` (`ANALYSIS_FILENAME`, excluded from `skillContentChecksum()` and from resource files). **Update** `stageUpdate()` (from the recorded `repoUrl`/`ref` or `location`), `diffSkill()` with `lineDiff()` (LCS, capped), `applyUpdate()` (a `ToolSkillAction` `update` transition; `trustTier` back to `unreviewed`).
  - `lifecycle.actsOnItsOwn()` (scripts, or `Write`/`Edit`/`Bash`/`autode_write_file`/`autode_run_command`); `publishToolSkill()` refuses such a skill while its content is unreviewed. `writeSidecarFile()` is exported for updates.
  - **Knowledge skills:** `knowledgeSkills(workspaceRoot)` (published, not unreviewed, analysed as knowledge). `ContextPackSources.knowledgeSkills` → `matchKnowledgeSkills()` (two shared words, or one for a short question; best two) and `renderKnowledge()` under `## Team Knowledge` with `maxTokens / 4` reserved from the seeded budget; `PackManifest.knowledgeSkills`; `renderPackManifest()` lists them. `ContextFileManager.buildContextPack()` adds them (not `getPackSources()`, which nine callers use for the graph); `EngineWorkspace.contextSources()` adds them, with the tool-skills folder in its cache fingerprint.
  - **One lifecycle:** `teamSkillPack()` turns published, reviewed imported skills with known `metadata.stageKinds` into `PackSkill`s (scope `team`, platforms default `any`); `stageSkills()` = AutoDE's plus those. `assignmentFor()`, `validateWorkflowProposal()` and `autode_workflow_draft` use it; in `assignmentFor()` a `team` skill that fits joins like a platform skill. `skillCatalog()` gives workspace entries stage kinds, platforms, scope, `kind`, licence and source.
  - **Surfaces:** `portSource()`, `analysisContext()` and `managementEnabledIn()` are shared. CLI `cmdPortSkill()` (`src/cli/main.ts`; options `--skill`, `--replace`, `--tier`). MCP `autode_skills_analyze` (`src/mcp/agentTools.ts`). VS Code: `src/core/portSkillSession.ts` (`PortSkillSession`, the wizard's state and messages, no vscode; a test drives it) and `src/core/portSkillView.ts` (`PortSkillPanel`) with `media/port-skill.html`; `autoDataEngineeringHub.importToolSkill` opens it, `autoDataEngineeringHub.updateToolSkill` updates. The model's proposal uses `AgentHub.completeJson()`.
- **Code audit follow-ups** (v0.45.14; [code-audit-2026-10.md](code-audit-2026-10.md)):
  - **One path for the build stage:** `PRODUCE_LABEL` (`src/core/workflowViewModel.ts`) has no `build` entry, so a build stage offers Run agent, not Produce; its guide reads "Run agent (pipeline-engineer), then approve the Pipeline Spec". A stale `produce` message for a build stage runs the agent. Removed: `AgentHub.synthesizePipelineSpec()`, `src/agents/pipelineSpecSynthesis.ts`, the panel's `generatePipelineSpec()` and the command *AutoDE: Generate Pipeline Spec*.
  - **Source assessment from the platform card** (`autoDataEngineeringHub.sourceAssessment`, `src/extension.ts`):
    1. picks a named connection (source role first, from `loadConnectionsConfig()`);
    2. gets an `EngineAccess` from `hub.createEngine('autode-panel')`, through the new optional `EngineAccess.call()`;
    3. asks `autode_list_databases` and `autode_list_schemas`;
    4. runs `autode_ingest_metadata` with `profile: true`;
    5. calls `reloadContextLayer()`, the panel's context reload moved out of its message case, so `reVerifySourceSchema`, which calls the command, sees the new tables.

    It returns the same `{ success, tableCount }`.
  - **Refresh on use before a stage:**
    - the panel's Run agent calls `ContextFileManager.refreshWorkingSet()` first (logging what it fetched; a failure doesn't stop the run);
    - in hosts, `autode_refresh_working_set` (`src/mcp/workspaceTools.ts`, records) sets `estateFetcher()`, a `CatalogFetcher` over the named connections already bound to an estate system. It connects lazily per connection, reports unreachable ones, and never creates estate systems. Then it calls `refreshWorkingSet()`;
    - the orchestrator skill (v2) calls it before running an assignment;
    - `autode_workflow_next` stays read-only.
  - **Palette:** `testCopilot`, `listCopilotInfo` and `debugListExtensions` are no longer commands. The sidebar's `testCopilot` message still routes to `testLanguageModel`.
  - **Catalog:** `skillCatalog()` reports roles naming unknown skills through `checkDefinitions()`.
- **The context curator** (v0.45.13; SKL-6, BPS-1):
  - `BusinessPackManager` (`src/engine/context/businessPackManager.ts`) splits reading into deterministic halves around the model call:
    - `readingFor(id)` returns a `ReadingRequest`: `facts` (the sha, the section ids and headings from `splitSections()`, and `buildDocumentExtractionPrompt()`), `profile` (`buildProfileProposalPrompt()` for a structured document no confirmed profile reads), or `none` with the reason (sample, confirmed profile, a proposed profile waiting, unreadable);
    - `recordFacts(id, raw, sha?)` refuses structured documents and a changed sha, then runs `parseDocumentExtraction()` (sections, kinds, validation, subject resolution) and `recordExtraction()` (duplicates skipped);
    - `recordProfile(id, raw)` runs `parseProfileProposal()` (always `proposed`), refuses overwriting a confirmed profile, and writes it to `.autode/knowledge/profiles/`.

    `applyDocument()` calls them with the panel's `complete`, so both paths share the checks.
  - **MCP** (`src/mcp/workspaceTools.ts`): `autode_pack_reading` (read) and `autode_pack_record_reading` (records; `facts` with `sha`, or `profile`). The `needs_llm` and `needs_profile` reasons point to them.
  - **Role and skills:** `agents/context-curator.md`; `skills/autode-core-fact-extraction` (the chat-extraction kinds and values, as the `autode_extract_assertions` prompt), `autode-core-document-reading` and `autode-core-vocabulary` (`autode_mine_vocabulary`, then `autode_propose_vocabulary`). They have no stage kinds: AutoDE's own, like the orchestrator.
  - VS Code is unchanged: background extraction after each chat turn, and pack reading with the panel's LLM.
- **The interview on disk, the business analyst, the planner** (v0.45.12; BPS-7, BPS-1, SKL-6, ORC-9):
  - **Interview engine:** `SpecOpsEngine` and `createIntakeSession()` moved from `src/core/specOps.ts` to `src/engine/interview/specOps.ts`, unchanged, so every surface uses them.
  - **State** (`src/engine/interview/state.ts`):
    - `.autode/problems/<id>/interview/state.yaml` holds the `IntakeSession`. `IntakeAnswer` gains `by` and `channel` (`panel`, `mcp`, `cli`); `IntakeAttachment` gains `packDocument`; the session gains `feeds` (the spec id and version it produced).
    - `writeInterview()` writes atomically and leaves attachment text out; `readInterview()` reads it back from the file, bounded to 200,000 characters.
    - `isOpenInterview()`: no `feeds`, and state `discovery` or `synthesizing`.
    - `startInterview()` returns the open interview or starts one with the parts' fields as coverage.
    - `recordInterview()` validates questions (`SpecOpsEngine.validateQuestion`, field among the coverage keys) and answers (by question id; or by field, answering that field's latest open question, else recording a question from `prompt`), and reports errors item by item.
    - `summarizeInterview()` gives the parts (by `specFields`), open questions and answers.
    - `markInterviewFed()` closes the interview.
    - Attachment extracts stay in the interview; since v0.45.14 nothing else reads them (the documents reach later stages through the pack).
  - **Interview parts as skills:**
    - `skills/autode-de-interview-{requirements,sources,data-flow,transformations,quality,constraints}` and `autode-de-specification-authoring` replace `skills/*.json`, which were converted verbatim.
    - `skillMeta()` reads `metadata.interview` (the part's old id), `order` and `specFields` into `SkillMeta.interview`. A part must have `stageKinds: [specify]`.
    - `interviewPartFromSkill()` (`src/engine/skills/skillRegistry.ts`) rebuilds a `SkillDefinition`: the title is the name, the first paragraph is `systemPrompt`, `## What to ask` is `questionGuidance`, and `## Example questions` gives the examples.
    - `interviewSkills()` merges a workspace's `.autode/config/skills/*.json` by id. It is used by the panel (`ensureSkills()`), `EngineWorkspace.interviewSkills()` (the MCP prompts `autode_interview_<id>`) and the CLI.
    - In the catalog, the `interview` group now lists only the workspace's JSON parts.
  - **Panel** (`src/core/webviewProvider.ts`):
    - `handleSpecDiscovery()` calls `ensureActiveProblem()` before the first question and `startInterview()`;
    - `saveInterview()` runs after every ask, answer, attachment and the move to synthesis;
    - `activateProblem()` drops another problem's engine, then `resumeInterview()` restores the open interview and re-posts its open questions (`postPendingSpecQuestions()`, also after a chat is loaded);
    - `synthesizeFromSession()` marks the interview fed when the spec changed, else reopens it;
    - `startNewChat()` no longer ends the interview, and `carryOverPartialInterview()` is gone;
    - `attachSpecFile` copies a file from outside the workspace to `<problem>/pack/files/` and registers it with `packManager.addDocument()` (role `other`, authority `draft`);
    - `AttachmentStore` is removed.
  - **MCP:**
    - `autode_start_problem` starts the interview;
    - `autode_interview_state` (read) and `autode_interview_record_answer` (records, channel `mcp`) are in `src/mcp/workspaceTools.ts`;
    - `proposalTool` in `src/mcp/decisions.ts` marks the interview fed when a valid `spec_revision` is proposed.
  - **CLI:** `cmdInterview()` gives `autode interview show | answer`, and `problems new` starts the interview.
  - **Planner:**
    - `computeDraft()` (`src/engine/workflows/service.ts`) is `draftFrom()` without writing. `autode_workflow_draft` (`src/mcp/workflowTools.ts`) returns it with the current workflow and, per stage kind, its roles, ceiling, done-when and the skills that fit the target platform (`skillFits()`).
    - `checkWorkflow()` takes `{ skills }`. It refuses a brief that is empty, longer than `MAX_BRIEF` (1,500), or names `autode_*` tools or `autode-*-*` skills, and refuses `agent.skills` that are unknown or for other stage kinds. `validateWorkflowProposal()` passes `loadSkillPack()`.
    - `toolsForTier()` takes the stage kind: on a `plan` stage, `autode_propose_workflow` is exempt from `HUB_ONLY`.
    - Role templates `agents/business-analyst.md` and `agents/planner.md`, and the skill `skills/autode-core-workflow-planning`.
    - The Workflow view shows `StageView.brief`.
- **Platform skills** (v0.45.11; SKL-8, ORC-10; guide: [platform-skills.md](../guides/platform-skills.md)):
  - **Skills:** `skills/autode-{snowflake,databricks}-{ingestion,pipelines,governance,performance,deployment}`, `skills/autode-dbt-project` (scope `dbt`, platforms snowflake and databricks) and `skills/autode-de-reconciliation`. Each ends with a worked example on the reference problem, in fenced blocks labelled by kind:
    - ` ```sql ` (optionally with a file name);
    - ` ```yaml runbook `;
    - ` ```yaml <folder>/databricks.yml `;
    - ` ```yaml models/….yml ` for dbt.
  - **Selection:** `skillFits()` (`src/engine/agents/assignment.ts`) adds one rule to v0.45.5's: a `dbt`-scoped skill needs `transformationTool: dbt` in the target context (`targetField()`). The platform's fitting skills join the role's even when the role's own list has none for the kind. Roles: `agents/target-architect.md` (new; platform-setup), and the platform skills listed on `pipeline-engineer` and the reconciliation skill on `source-assessor`.
  - **Assignment text:** a section for installable vendor skills that aren't installed, with how a person installs them.
  - **The fixture check** (`test/platformSkillCheck.cjs`, run by `npm test`; `node test/platformSkillCheck.cjs` after a compile):
    - `skillBlocks()` extracts the blocks;
    - `referenceEstate()` parses `test/reference/retail-orders/sources/{shop,crm}.ddl` into a schema index;
    - `createdObjects()` collects every object the examples create, plus the model's planned tables;
    - `checkSkill()` runs: `checkSqlGrounding()`; `foreignDialect()`; `checkSingleStatement()` per statement (not in Jinja); the `-- lands <table>` column comparison; `checkRunbook()` in a temporary workspace with the example's bundle files, on two CLI-credential test connections; `${var.…}` declarations; and dbt source tables and columns against the estate.
  - **`autode_reconcile_plan`** (`src/engine/agents/reconcilePlan.ts`, tool in `src/mcp/agentTools.ts`): `reconcilePlan()` builds one `SELECT` per side:
    - `COUNT(*)`, distinct keys (`COUNT(DISTINCT a, b)` on Snowflake and Databricks, else concatenated with `COALESCE(CAST … AS VARCHAR(4000)), '~')`), and key nulls;
    - per column by `typeClassOf()`: `SUM` (numeric), `MIN`/`MAX` (temporal), `COUNT(DISTINCT)` (string), and nulls;
    - `HASH_AGG` or `SUM(CAST(xxhash64(…) AS DECIMAL(38, 0)))` when both sides share a platform, and `LEFT JOIN … IS NULL` counts when `sameConnection`.

    `comparisons` are `within-tolerance` for sums, `zero` for nulls and missing keys, and `equal` otherwise. The tool resolves both tables in the schema index, takes column pairs from the problem's mapping (`problemMappings()`) or same-named columns, maps string keys through the pairs, and defaults the target platform from the target context.
  - **Dialect markers** (`src/engine/platform/dialectMarkers.ts`): `dialectMarkers()` and `foreignDialect()` match short lists of unambiguous constructs per platform, after stripping comments and string literals (`/Volumes/` and `@stage` paths inside literals stay visible). `checkRunbook()` warns on a `sql` step with the other platform's markers. `DESTRUCTIVE` adds `VACUUM`. `CLI_ALLOWLIST` adds `snow dbt list | deploy | execute`, `databricks pipelines list-pipelines | get | start-update` and `databricks bundle summary`.
  - **Grounding** (`src/engine/grounding/sqlGrounding.ts`):
    - created objects include `dynamic`, `streaming`, `iceberg` and `external` tables, streams, and `CREATE OR ALTER` / `OR REFRESH`;
    - `STREAM(<table>) <alias>` resolves the table and the alias;
    - `FROM <name>(` (a table function) and `FROM STREAM <fn>(` are skipped;
    - `PLATFORM_CATALOG` names count as known;
    - `REVOKE … FROM` is rewritten before scanning.
  - **The host guard** (`src/engine/runner/hostGuard.ts`):
    - `shellWords()` tokenises with quotes; `&&`, `||`, `;`, `|`, `&`, `$(`, backticks and parentheses become separators, and a backslash escapes only quotes, spaces, backslashes, `$` and backticks, so Windows paths survive;
    - `guardShellCommand()` skips assignments and wrappers (`sudo`, `env`, `npx` …), recurses into `bash -c`, `pwsh -Command` and `cmd /c`, and classifies each `snow`/`databricks` call with `classifyCli()`. Value flags are skipped, `LOCAL` groups and `--help` are local, and `snow sql` is classified per statement from `-q` or `-f` (unreadable means blocked). `databricks api` is classified by its method, `bundle init|generate` is local, and `READ_VERBS` in the first three words means read. Everything else is a change;
    - `guardHookEvent()` takes Claude Code's `PreToolUse` JSON (shell tools only).

    `autode hook guard` (`hookCommand()` in `src/cli/main.ts`, dispatched before argument parsing) reads stdin (`CliIo.readStdin`), and exits 2 with the reason on stderr, or 0.
  - **Plugin** (`src/engine/agents/plugin.ts`):
    - `guardEntry()` is `serverEntry()` with `hook guard` in place of `mcp --workspace .`;
    - `guardHooks()` is the `PreToolUse` entry (matcher `Bash|PowerShell`, timeout 15 s);
    - `buildPlugin()` writes `hooks/hooks.json`;
    - for Claude Code, `installPlugin()` merges the entry into `<scope>/.claude/settings.json` with `mergeGuardHook()`. It replaces an earlier entry whose command ends in ` hook guard`, keeps others, and on invalid JSON returns an error with the entry instead of writing;
    - Cortex Code and Copilot get notes.
- **Install guidance as data** (v0.45.6): `loadToolGuides()` (`src/engine/platform/prerequisites.ts`) reads `prerequisites.yaml` and `.autode/config/prerequisites.yaml`; `probeOptions()` keeps the options for this OS and probes their package managers; `checkPrerequisites()` puts them in `install.options`. The prerequisites picker offers them and sends their commands to the AutoDE terminal on a click.
- **Skill catalog and naming** (v0.45.5):
  - `skillMeta()` (`src/engine/agents/definitions.ts`) checks a bundled skill's name against `AUTODE_SKILL_NAME` (`autode-<scope>-<capability>`, scopes in `SKILL_SCOPES`), and reads `metadata`: `scope` equal to the name's, `stageKinds` known, `platforms` from `SKILL_PLATFORMS` (a platform-scoped skill has exactly its platform), a whole-number `version`, and `maturity` `tested` or `preview`. `parseSkillMarkdown()` now returns `metadata` and `license`.
  - `assignmentFor()` selects with `fits()`: kind in `stageKinds`, and `any` or the target platform (`targetPlatform()`, from `context/target-context.yaml`) in `platforms`. The role is the first candidate with a fitting skill; it gets its own fitting skills plus the platform's.
  - Assignments also carry `externalSkills`: catalog references for the kind and platform, `installed` when found in `hostSkillDirs()`. The installed ones are listed in the text.
  - `skillCatalog()` (`src/engine/agents/skillCatalog.ts`) merges the pack, the workspace's tool skills (`loadToolSkillStates`), the interview packs and `externalCatalog()`. The latter is `skills/external.yaml` with `.autode/config/external-skills.yaml` merged by id; each entry is validated (a source, a described licence, an own-words summary, a known availability, an installer when installable, no "importable" without a licence allowing it).
  - `probeInstaller()` runs the version command and the probe through an injectable `Runner` (`spawnRunner`: no shell, 15 s timeout).
  - `renderCatalogMarkdown()` is used by `scripts/docs-generate.cjs` for `docs/guides/skills.md`.
  - **Surfaces:** `autode skills list | show | check | install` (`src/cli/main.ts`; install needs a TTY and a typed `install`, and is judged by detection afterwards); `autode_skills_list` (`src/mcp/agentTools.ts`); the Skills view (`src/core/skillsView.ts`: `autoDataEngineeringHubSkills`, Install in the AutoDE terminal after a probe and a modal).
  - **Plugin clean-up:** `pruneSkills()` in `src/engine/agents/plugin.ts` removes what `.autode-installed.json` lists that is no longer shipped, and `LEGACY_SKILLS` folders whose `SKILL.md` names `mcp__autode__`, then writes the manifest.
- **The pipeline engineer** (v0.45.4):
  - `primitiveCandidates()` (`src/engine/agents/primitiveCandidates.ts`) chains `rename_cast` (source → `stg_<schema>_<table>` view, the mapped columns without expressions), `dedup` (partition by the key fact's mapped columns, order by the first temporal column whose name looks like a change column, `DESC`) and `incremental_load` (MERGE into the target on the key, updating the other columns). Each step is validated with `validateTransformSpec()`. A key fact matches its table by fully qualified name, or by bare name only when unqualified.
  - `autode_record_pipeline_spec` (`src/mcp/agentTools.ts`) builds the `PipelineSpec` envelope (id `ps-<problem>`, version, lineage, `draft`), strips the candidates' reasons, validates it (schema and every step), then calls `writePipelineSpec()`.
  - Grounding manifests: `PrimitiveUse.lineage` names the estate table a step's columns trace to, and fact subjects are resolved before comparing (`isAbout()`).
  - The eval's offline build is `test/eval/lib/deterministicBuild.cjs`.
- **One path** (v0.45.1):
  - `stageRunner()` (`src/core/agentExecutor.ts`) gives the stage's role template, else `LEGACY_AGENTS[kind]` (source-assessment, modelling, build). `runStage()` runs the latter through `AgentHub.runStageSteps()`: a plan of only that stage's steps, the files written collected through `stageRunFiles`, and no `handleFailure` re-plan. They are recorded to the stage and handed in (document stages complete when their document is approved).
  - **Document approval** (`src/engine/workflows/documentApproval.ts`): `documentApprovalProblems()` checks the document (a specification statement; a context's spec id and version; at least one mapping; a valid Pipeline Spec), and `approveStageDocument()` writes `status: approved`, `approvedAt` and `approvedBy`, then appends an `approved` event. It is called from the Workflow view (after a modal) and from `autode workflow approve <stage>` (interactive terminal); no MCP tool calls it.
  - **View model:** `StageModel` has `guide` (the Next line), `runner`, `produceLabel`, `document`, `blockers`, and actions `approve-document`, `produce`, `open-document`. `WorkflowModel.proposal` is the pending workflow decision's stages with inclusion and reasons.
  - **Panel:** the plan messages opened the Workflow view; since v0.45.9 they are gone, and the sidebar's next step after the specification is Open Workflow (and `/plan`, `/execute`, `/workflow` open it).

### 7.7 Decisions and proposals (v0.40.0; ORC-8, MCP-2)

*Since v0.41.0 facts no longer become decisions: they use the ledger's gate (§5.14); the `assertion` kind remains for decisions recorded before.*

**Store** (`src/engine/decisions/decisionStore.ts`). `LAYOUT.decisions` = `.autode/decisions/` (committed).
- Each decision is `<id>.yaml` (`dec-<ULID>`), with its proposal in `<id>.proposal.json`.
- The YAML holds `{ kind, title, summary, stakes, status, problemId, subject { document, revision | connectionId }, proposedBy { host, client, skill, model }, evidence, validation { ok, errors, warnings, checks }, allowedChannels, resolution { decision, by, note }, events[] }` under a header comment that explains the file channel.
- `events` only grow (proposed, approved, rejected, applied, superseded, failed, withdrawn), and every write is tmp + rename.
- Kinds: `assertion`, `spec_revision`, `pipeline_spec`, `mapping`, `platform_change`, `connection` (v0.43.1: `validateConnectionProposal()` runs `validateConnectionDraft()`, warns on an existing id and on sample-data consent, and reports `credentialNeeds()`; it is applied with `saveConnection()` and not tested), plus `spec_approval` and `pipeline_spec_approval`, which record the panel's existing approvals (`recordResolved()`).

**Stakes and channels.**
- `stakesFor(kind, proposal)` is the only definition: `assertion` is low for `LOW_STAKES_ASSERTION_KINDS` (`business_term`, `naming_convention`, `assumption`), and everything else is high.
- `channelsFor()`: low = panel, cli, file, tool; high = panel, cli, file.
- `resolve()` **recomputes** stakes from the kind and the stored proposal instead of trusting the YAML, so an edited `stakes:` can't open the tool channel. A channel outside the allowed set throws `DecisionError('CHANNEL_NOT_ALLOWED')`.
- `syncFileResolutions()` turns a pending decision whose `resolution.decision` a person filled in into a `file` resolution; it requires `by`, and reports the decision as incomplete without it.

**Proposals** (`src/engine/decisions/proposals.ts`).
- **Validation.** `validateProposal(kind, payload, ctx)` per kind:
  - assertion: `validateAssertion()`;
  - spec revision: required fields, list fields, same id as the active spec;
  - Pipeline Spec: `validatePipelineSpec()`;
  - mapping: required fields, no target column twice, and source table and columns resolved in a `SchemaIndex` built from the graph. An unknown target table and an empty estate are warnings;
  - platform change: the connection exists, `checkSingleStatement()` finds one statement, and it is a `write`.
- **Proposing.** `propose()` throws `ProposalValidationError(report)` or creates the decision. Its `subject.revision` is the SHA-256 of the target document at proposal time.
- **Applying.** `applyDecision()` applies only `approved` decisions. If the target document's current revision differs from the recorded one, the decision is `superseded`, not applied. Per kind:
  - assertion: `AssertionLedger.assert()`, active / confirmed, `createdBy: decision:<id>`, `causedBy` = the decision id;
  - spec revision: the next draft (version + 1 if the current one is approved; `problemStatementApproved` carried over only when the problem statement is unchanged), through `writeBusinessProblemSpec()`, which archives like the manager;
  - Pipeline Spec: the next draft, through `writePipelineSpec()`;
  - mapping: `writeMappingUpsert()`;
  - platform change: only with `deps.executePlatformChange`.

  A failure marks the decision `failed`. `processResolved()` = `syncFileResolutions()`, then apply every approved decision this process can apply.

**Shared documents** (`src/engine/documents/problemDocuments.ts`). The serialisation, parsing, history names and revision rules of the Business Problem Specification, Pipeline Spec and Mapping Context moved here verbatim from `SpecManager`, `PipelineSpecManager` and `MappingContextManager`. Those managers delegate to it (`withMappingUpserted()`, `nextMappingContextRevision()`), and the engine's Node writers use the same functions, so the two paths can't drift.

**MCP** (`src/mcp/decisions.ts`, `decisionTools()`).
- **Proposal tools:** `autode_propose_assertion | spec_change | pipeline_spec | mapping | platform_change`. Annotations are `readOnlyHint: false, destructiveHint: false`, because they write only the pending decision. `proposedBy.client` comes from `getClientVersion()`; `skill`, `model` and `evidence` are optional arguments.
- **Decision tools:** `autode_list_decisions` and `autode_get_decision` (read-only; both run `processResolved()` first), `autode_resolve_decision` (tool channel; destructive), `autode_apply_decision` (approved platform changes; destructive; needs `--allow-write`).
- **Errors:** `ProposalValidationError` → `VALIDATION_FAILED` with `{ errors, warnings, checked }`; `CHANNEL_NOT_ALLOWED` → `PERMISSION_DENIED`.
- **Platform writes:** `autode_execute_query` refuses every write. Since v0.45.8 the only write path is an approved runbook's change step, through the runner's own write-enabled `PlatformSession` (`executeApprovedChange()`); the server's session never writes, and `--allow-write`, `autode_propose_platform_change` and `autode_apply_decision` are gone.

**Extension** (`webviewProvider.ts`).
- The approval handlers moved into `approveCurrentSpec()` and `approveCurrentPipelineSpec()`, which record a resolved decision.
- `resolveDecisionInPanel()` resolves with channel `panel` and `by` = the OS user, applies the decision, and runs `afterDecisionApplied()`: it reloads the changed document; for a spec or Pipeline Spec revision approved in the panel it continues into the usual approval (one click); for a fact it reloads the ledger and runs `persistCompiledGraph()`.
- `ContextFileWatcher` events under `.autode/decisions/` call `processDecisionFiles()`.
- The webview's *Decisions* section (Workflow Palette) lists pending and approved decisions with kind, stakes, proposer, warnings and evidence, with Approve / Reject and an optional note, plus recent outcomes.

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

**File:** `src/core/languageModelAdapter.ts` (`CopilotAdapter` is a back-compat alias; the `copilotAdapter.ts` re-export shim was removed in the 2026-10 code audit)

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

Respond conversationally and helpfully. If the user asks for an execution plan,
point them to the Workflow view: AutoDE works stage by stage.

{context block}

User message: {message}
```

**Plan prompt** (`AgentHub.buildPlanPrompt`; removed in v0.45.9 with the plan, kept here for history):
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
- Modeling: {modelingApproach}
- Transformation: {transformationTool}
- Orchestration: {orchestrationTool}
- Naming: {namingConvention}
- Outputs: {outputFormats}

Objective: {objective}

Return only a valid JSON array of objects. Each object must include:
{"id":"step-1","assignedAgent":"snowflakeExecutor","taskDescription":"...",
 "status":"pending","dependsOn":[],"validationRules":["..."]}.

Use only this assignedAgent value: snowflakeExecutor.
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
- **Tier 2** (declarative, `declarative/`): a `PrimitiveDefinition` YAML (`kind`/`version`/`status`/`paramSchema`/`platformTemplates`/`previewParams`/`outputChecks`) whose `compile()` is a rendered template, not code — `templateEngine.ts` is a hand-rolled, deliberately constrained engine (`{{param}}`, `{{join arr ", "}}`, `{{#each}}...{{/each}}`, no `eval`/`Function()`) so a definition author cannot smuggle code execution into the compile path. `loadPrimitiveDefinitionsFromDirectory()` + `mergePrimitiveDefinitions()` mirror `skillRegistry.ts#loadSkillsFromDirectory` exactly — bundled `primitive-definitions/` + `.autode/config/primitives/` override, later wins. `registerPrimitives()` merges Tier 2 into the same `TRANSFORM_PRIMITIVES` map; Tier 1 always wins a `kind` collision.

**Selection (until v0.45.4, `src/agents/llmParamSelector.ts`; since then `autode_primitive_candidates`, §7.9):** `selectTransformSpec(context, step, candidateKinds, fixedParams?)` asks the LLM for *only* `{kind, params}` JSON against the candidate primitives' schemas, Ajv-validates, and returns `undefined` (never throws) on any failure — `fixedParams` (object names the caller already computed deterministically) are merged in *after* the LLM's response so they can't be overridden. `generateViaPrimitiveOrFallback()` wraps this as tier 0 ahead of the *unmodified* existing tier 1 (freehand LLM) / tier 2 (hardcoded template) fallback chain in `IngestionPipelineAgent` and `TransformationScaffolderAgent`'s staging model (and, until v0.45.2, `SttmMapperAgent`) — the codegen agents where a single-source primitive is a genuine fit (not the data model, nor the marts model's multi-source joins).

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
- **`context/PipelineSpecManager.ts`** — persistence modeled function-for-function on `SpecManager.ts` (§3): `.autode/problems/<id>/spec/pipeline.yaml` + `spec/history/pipeline.v<version>.<status>.yaml`, atomic temp-then-rename writes, `approve()` doesn't bump version (a draft v1 becomes approved v1), a new revision from an approved predecessor does. A document whose `specVersion` doesn't match `CURRENT_PIPELINE_SPEC_VERSION` loads leniently (a logged warning, not a thrown error) — schema evolution must never brick an already-approved pipeline.

### 9.4 Attachment structured extraction

Closes a real gap in the pre-existing `attachSpecFile` flow (§3.9): raw attachment text was appended verbatim to a prompt, never persisted past the discovery session, never tagged with provenance.

- **`core/attachmentExtraction.ts`** — `buildAttachmentExtractionPrompt()`/`parseAttachmentExtract()`, pure (mirrors the `specOpsPrompts.ts`/`specSynthesis.ts` split for the BPS itself) — `AgentHub.extractAttachmentFacts()` owns the actual LLM call and never throws, falling back to `fallbackAttachmentExtract()` (a plain text summary, `confidence: 'low'`) on any failure. Deliberately not a rigid, format-specific parser — an attachment could be a schema dump, a memo, anything.
- **`context/AttachmentStore.ts`** — persists `{raw content, extract}` to `.autode/problems/<id>/attachments/<id>.yaml`, atomic write, surviving past the ephemeral `IntakeSession` that created it.
- **`SpecProvenance.source`** gains `'attachment'` (+ `attachmentId`) — `specSynthesis.ts#buildProvenance` tags `sourceCatalog`/`dataFlows` this way when an entity-extracting attachment exists and no direct question already covers the field (a narrow, honest heuristic — there's no per-field attribution signal from the LLM's synthesis output for anything broader).

### 9.5 Primitive lifecycle & governance

```typescript
type PrimitiveLifecycleStatus = 'draft' | 'published' | 'deprecated' | 'retired';
```

- **UI:** sidebar Workflow Palette gains a "Primitives" section (`palettePrimitives`/`renderPalettePrimitives`) — chosen over a new panel or a 6th custom editor because the Dashboard panel has zero manager wiring and none of the 5 existing custom editors support write-back, whereas the palette's `paletteProblems`/`paletteSpec`/`paletteArtifacts` pattern (§4.6) already does exactly this shape of work. **Preview** is a plain `compileTransformSpec()` call — confirmed to need neither an LLM call nor `agenticTools.ts`'s agentic loop (§7.6), since rendering a template against sample params isn't LLM-directed at all.
- **Selectability:** `isSelectable(primitive)` = `!primitive.status || primitive.status === 'published'` — `selectTransformSpec()` (§9.2) filters `candidateKinds` through this before building the LLM's catalog and again before accepting its response. `compileTransformSpec()` is **not** filtered — a deprecated/retired primitive still compiles for anything that already references it; selectability only gates the LLM's future choice.
- **Version pinning:** `TransformSpec.primitiveVersion?: number`; `registry.ts` keeps a second map, `VERSIONED_PRIMITIVES: Map<kind, Map<version, TransformPrimitive>>`, independent of the live `TRANSFORM_PRIMITIVES` catalog. `resolvePrimitive(spec)` prefers an exact-version match when pinned, falling back to the live entry otherwise. `webviewProvider.ts#ensurePrimitivesLoaded()` also loads `.autode/config/primitives/history/` into this map (never into the live catalog) so an approved Pipeline Spec's pinned reference keeps resolving after a newer version is published.
- **Publish/deprecate (`declarative/lifecycle.ts`):** `publishPrimitiveDefinition()` — a first publish keeps `version` as-is (mirrors `SpecManager.approve()`'s "draft v1 becomes approved v1"); republishing an already-published definition bumps `version` and archives the prior revision to `history/`, same convention as `SpecManager`/`PipelineSpecManager`. Gated by `autoDataEngineeringHub.primitiveManagementEnabled` (default `false`, same opt-in pattern as `languageModelProgrammaticConsent`, §8.1) — the sidebar hides Publish/Deprecate entirely, not just disables them, when off.

### 9.6 Files

| File | Purpose |
|------|---------|
| `src/engine/transforms/{types,registry}.ts` | `TransformPrimitive` contract; the merged Tier 1 + Tier 2 catalog, version-pinned resolution |
| `src/engine/transforms/primitives/*.ts` | Tier 1: `renameCast.ts`, `dedup.ts`, `incrementalLoad.ts` |
| `src/engine/transforms/declarative/*.ts` | Tier 2: `types.ts`, `schema.ts`, `templateEngine.ts`, `loader.ts`, `adapter.ts`, `lifecycle.ts` |
| `src/engine/agents/primitiveCandidates.ts` | `primitiveCandidates()`: primitives with parameters from facts (v0.45.4; replaced `llmParamSelector.ts`) |
| `src/engine/pipelineSpec/*.ts` | `types.ts`, `schema.ts`, `validator.ts`, `compiler.ts`, `designDocGenerator.ts` |
| `src/context/PipelineSpecManager.ts` | Pipeline Spec persistence/versioning |
| `src/core/attachmentExtraction.ts`, `src/context/AttachmentStore.ts` | Attachment structured extraction + persistence |
| `src/core/disposables.ts` | `DisposableRegistry` — real `deactivate()` (§8) |
| `docs/schemas/primitive-definition.schema.json` | `yamlValidation` contribution target for live-editing Tier-2 definitions |

---

## 10. Extension Architecture

### 10.1 Activation and lifecycle

`src/extension.ts#activate`:
1. Creates `ConfigurationManager` and the orchestrator (`DataAgentHubHub`); registers credential resolvers (`registerDefaultCredentialResolvers(context.secrets)`: environment, CLI configuration, VS Code SecretStorage).
2. Creates the sidebar provider (`DataAgentHubWebviewProvider`; the dashboard panel and `applyProblemRoot` were removed in v0.45.9 with the plan); source and target `ConnectionManager`s are created lazily per role and disposed through the `DisposableRegistry`.
3. Registers every command (the full list is `contributes.commands` in `package.json`, all prefixed `autoDataEngineeringHub.`): pipeline-spec generation; source/target connect, browse, assess, re-verify, disconnect; file ingestion; mapping and semantic-layer snapshot; ledger compaction; What the Agent Saw; Explain This Artifact; Open Estate; language-model tests and listings; Copilot handoff; tool-skill import/run; chat new/history/discard; Connect to Data Platform; service-account test.

The sidebar's `resolveWebviewView` then builds the context layer (`ContextFileManager`, `ContextFileWatcher`), activates the problem named by `active-problem.json`, and folds a non-empty active chat into history (CHT-2).

`deactivate()` → `disposableRegistry.disposeAll()` (`src/core/disposables.ts`): watchers, connection managers and other resources registered during activation.

### 10.2 Engine boundary (v0.26.0)

- **Rule:** nothing under `src/engine/**` or `src/mcp/**` imports `vscode` — not even types (`.eslintrc.cjs`); a functional test loads every `dist/engine/**` module in plain Node, and the MCP tests run the bundled server in a plain Node child process (§10.6).
- **Host concerns pass in as parameters or interfaces:** `FileIo` for files (§2.4); `AgentHost { workspaceRoot, confirm(message, actionLabel), fileIo }` for agents; `AbortSignal` instead of VS Code cancellation tokens in platform `QueryOptions`/`ExtractOptions`; Snowflake CLI consent as a constructor option; the VS Code SecretStorage credential resolver lives in `src/core/credentials/`, the engine registers only `env` and `cli`.
- **Persistence of live schema** moved from the adapter into `ConnectionManager.persistSchemaContext(snapshot, workspaceRoot, io)` (writes `schema-graph.json`; `snapshotToGraph()` is public).
- **Mocks in tests:** modules that import `vscode` capture the mock at load time; shared helpers that need the VS Code API take it as a parameter (e.g. `createVscodeFileIo(vscode)`) so per-module mocks don't leak.


### 10.3 WebviewProvider Message Protocol

**File:** `src/core/webviewProvider.ts`

| Message (Webview → Extension) | Handler | Description |
|------------------------------|---------|-------------|
| `chat` | `hub.chat()` | Conversational message |
| `updateSettings` | `configManager.updateSettings()` | Save settings |
| `testLanguageModel` / `testCopilot` | Command proxy | Test the active local LLM (Copilot model, or Claude Code CLI) |
| `listLanguageModels` | Command proxy | Enumerate all `vscode.lm` models + report where the Claude Code CLI resolves from |
| `openCopilotHandoff` | Command proxy | Open handoff editor |
| `reindex` | Command proxy | Rebuild context index |
| `openContextFolder` | File system | Open .autode in OS |
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
| `logEntry` | Push log message |
| `settingsLoaded` | Push settings + active language model info (`languageModelInfo`, plus `copilotInfo` alias) |
| `settingsSaved` | Confirm settings saved |
| `error` | Push error message |
| `contextUpdate` | Push context stats + entities |
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

### 10.5 Settings

All settings are under `autoDataEngineeringHub.`; the table is generated from `package.json` (`npm run docs:generate`; `npm test` fails when it is stale).

<!-- generated:settings -->
| Setting | Type | Default | What it does |
|---|---|---|---|
| `capture.doubleExtraction` | boolean | `false` | Read each business document twice and keep keys, grain and relationships only where the two readings agree (C4c). |
| `defaultProvider` | enum: `snowflake`, `databricks`, `oracle`, `bigquery`, `redshift`, `synapse`, `other` | `"snowflake"` | Default data platform provider. |
| `defaultDatabricksWorkspaceUrl` | string | `""` | Default Databricks workspace host (e.g. adb-1234567890123456.7.azuredatabricks.net). |
| `defaultDatabricksHttpPath` | string | `""` | The target SQL warehouse's HTTP Path (e.g. /sql/1.0/warehouses/0123456789abcdef), copied from its Connection Details page. |
| `defaultDatabricksCatalog` | string | `"main"` | Default Databricks (Unity Catalog) catalog. |
| `defaultDatabricksCatalogType` | enum: `auto`, `unity`, `hive_metastore` | `"auto"` | Which metadata-introspection shape to use for the configured catalog. 'auto' infers it from the catalog name (the reserved 'hivemetastore' name vs. everything else); set explicitly when a workspace has more than one catalog type, or as a manual override for another catalog that shares the legacy metastore's limitations (no bulk informationschema). |
| `defaultDatabricksSchema` | string | `"default"` | Default Databricks schema. |
| `defaultSnowflakeAccount` | string | `""` | Default Snowflake account identifier. |
| `defaultSnowflakeUsername` | string | `""` | Default Snowflake username. |
| `defaultSnowflakeWarehouse` | string | `""` | Default Snowflake warehouse. |
| `defaultSnowflakeDatabase` | string | `""` | Default Snowflake database. |
| `defaultSnowflakeSchema` | string | `"PUBLIC"` | Default Snowflake schema. |
| `defaultSnowflakeRole` | string | `"SYSADMIN"` | Default Snowflake role. |
| `defaultSnowflakeAuthMode` | enum: `key-pair`, `username-password`, `oauth`, `external-browser`, `mcp` | `"key-pair"` | Snowflake authentication mode. |
| `snowflakePrivateKeyPath` | string | `""` | Path to Snowflake private key. |
| `defaultTargetProvider` | enum: `snowflake`, `databricks`, `bigquery`, `redshift`, `synapse`, `other` | `"snowflake"` | Target data platform provider — independent of, and can be connected simultaneously with, the source platform above. |
| `defaultTargetDatabricksWorkspaceUrl` | string | `""` | Target Databricks workspace host (e.g. adb-1234567890123456.7.azuredatabricks.net). |
| `defaultTargetDatabricksHttpPath` | string | `""` | The target platform's SQL warehouse HTTP Path (e.g. /sql/1.0/warehouses/0123456789abcdef), copied from its Connection Details page. |
| `defaultTargetDatabricksCatalog` | string | `"main"` | Target Databricks (Unity Catalog) catalog. |
| `defaultTargetDatabricksCatalogType` | enum: `auto`, `unity`, `hive_metastore` | `"auto"` | Which metadata-introspection shape to use for the target's configured catalog. |
| `defaultTargetDatabricksSchema` | string | `"default"` | Target Databricks schema. |
| `defaultTargetSnowflakeAccount` | string | `""` | Target Snowflake account identifier — independent of, and can be connected simultaneously with, the source Snowflake account above. |
| `defaultTargetSnowflakeUsername` | string | `""` | Target Snowflake username. |
| `defaultTargetSnowflakeWarehouse` | string | `""` | Target Snowflake warehouse. |
| `defaultTargetSnowflakeDatabase` | string | `""` | Target Snowflake database. |
| `defaultTargetSnowflakeSchema` | string | `"PUBLIC"` | Target Snowflake schema. |
| `defaultTargetSnowflakeRole` | string | `"SYSADMIN"` | Target Snowflake role. |
| `defaultTargetSnowflakeAuthMode` | enum: `key-pair`, `username-password`, `oauth`, `external-browser`, `mcp` | `"key-pair"` | Target Snowflake authentication mode. |
| `targetSnowflakePrivateKeyPath` | string | `""` | Path to the target connection's Snowflake private key. |
| `targetSnowflakeCliPath` | string | `""` | Explicit path to the Snowflake CLI for the target connection (only if not found automatically). |
| `targetDatabricksCliPath` | string | `""` | Explicit path to the Databricks CLI for the target connection (only if not found automatically). |
| `metadataCachingDurationMinutes` | number | `15` | Metadata caching duration in minutes. |
| `queryTimeoutSeconds` | number | `120` | Default query timeout in seconds. |
| `readOnlyMode` | boolean | `true` | Restrict to read-only mode. |
| `enableSessionReuse` | boolean | `true` | Enable session reuse. |
| `autoDocumentationEnabled` | boolean | `true` | Auto-generate documentation. |
| `telemetryEnabled` | boolean | `false` | Allow telemetry (opt-in). |
| `activeLlmProvider` | enum: `azure-openai`, `openai`, `anthropic`, `gemini`, `ollama`, `copilot`, `claude` | `"copilot"` | Active LLM provider. |
| `activeLlmModel` | string | `"gpt-4o-mini"` | Deprecated (v0.52.4): use llmModels, a model per provider. |
| `llmModels` | object | `{}` | The model each LLM provider uses, e.g. { "copilot": "claude-sonnet-5-5", "claude": "opus" }. |
| `claudeCodePath` | string | `""` | Path to the Claude Code CLI ('claude' / 'claude.exe'). |
| `llmEndpoint` | string | `""` | Custom LLM endpoint. |
| `context.workingSetMaxTables` | number | `200` | Tables AutoDE keeps in its working set (the context graph and ledger). |
| `context.evictAfterDays` | number | `30` | While the working set is over its size, tables no task has used for this many days (and no confirmed fact is about) go back to the catalog. |
| `context.schemaTtlDays` | number | `7` | Schema facts older than this are re-checked against a connected source when a task uses them and before a stage's agent runs. |
| `discovery.profileQueryBudget` | number | `50` | Most profiling queries one Source Assessment may run (one sampled query per table). |
| `discovery.profileConcurrency` | number | `4` | Profiling queries run in parallel during Source Assessment. |
| `artifactDirectory` | string | `"autode-output"` | Workspace-relative folder where AutoDE writes generated deliverables, one subfolder per business problem (autode-output/<problem-id>/<phase>/...). |
| `extensionDisplayName` | string | `"AutoDE — Data Engineering Workspace"` | Extension display name. |
| `extensionDescription` | string | `"AI-powered data engineering workspace with agentic orchestration, multi-phase workflows, and rich artifact generation."` | Extension description. |
| `languageModelProgrammaticConsent` | boolean | `false` | Allow AutoDE to programmatically use a locally-installed language model for its LLM calls (opt-in): GitHub Copilot via the VS Code Language Model API, or the Claude Code CLI. |
| `copilotProgrammaticConsent` | boolean | `false` | Deprecated — use `languageModelProgrammaticConsent`. |
| `primitiveManagementEnabled` | boolean | `false` | Allow publishing/deprecating declarative (Tier 2) transform primitives from the Primitives palette (opt-in). |
| `toolSkillManagementEnabled` | boolean | `false` | Manage imported tool skills' lifecycle: imports start as drafts, and Publish/Deprecate/Retire Tool Skill keep numbered versions that plan steps can pin (opt-in). |
| `dataPlatformCliConsent` | boolean | `false` | Allow AutoDE to shell out to a data-platform CLI (currently: 'snow connection list') to enumerate configured connections for 'AutoDE: Connect to Data Platform' (opt-in). |
| `snowflakeCliPath` | string | `""` | Path to the Snowflake CLI ('snow' / 'snow.exe'). |
| `databricksCliPath` | string | `""` | Path to the Databricks CLI ('databricks' / 'databricks.exe'). |
| `defaultOracleConnectString` | string | `""` | Oracle source: a tnsnames.ora alias (e.g. |
| `defaultOracleUsername` | string | `""` | Oracle source: the database user. |
| `oracleConfigDir` | string | `""` | Folder containing tnsnames.ora. |
| `oracleWalletLocation` | string | `""` | Folder of an Oracle TLS wallet (e.g. for Autonomous Database). |
| `driversDirectory` | string | `""` | Where drivers you install with AutoDE's guidance live. |
| `activeSourceConnection` | string | `""` | Id of the named connection (from .autode/config/connections.yaml or .autode/local/connections.yaml) that Connect uses for the source, e.g. snowflake:prod. |
| `activeTargetConnection` | string | `""` | Id of the named connection that Connect uses for the target. |
| `serviceAccountCredentialRef` | string | `""` | A service-account credential pointer, set once by a platform team — deliberately a plain settings value, no interactive UI. |
<!-- /generated:settings -->

---

## 11. Testing & Evaluation

### 11.1 Functional tests (NFR-9)

`npm test` compiles (tsc + bundles) and runs `test/functional.test.cjs`: one runner (288 tests at v0.35.0) that loads the compiled `dist/` modules with a per-test `vscode` mock (`createMock()`, `withMock()`; modules are re-required with `fresh()` because they capture the mock at load time). Engine modules are tested in plain Node with no mock, which doubles as the engine-boundary check (§10.2). Coverage spans the context store and watchers, ledger/projection/conflicts, packs/gaps/manifests, file ingestion, the Snowflake/Databricks adapters and execution backends (mocked processes and `fetch`), credential resolvers and CLI detection, LLM adapters and tool loops (mocked models), the spec engine and synthesis, phase inference, plan validation and execution, managers' versioning/archiving, the primitive registry and Pipeline Spec compiler, the business-problem pack (profiles, contracts, conformance, probes), tool-skill lifecycle and trust, and the MCP server — the bundle is spawned in a plain Node child process and driven over stdio with the SDK client (contract tests, golden compile snapshots in `test/golden/mcp-compile/`, a no-writes check). A docs test fails when the generated sections of this document (§10.5, §12) are stale. `npm run lint` must report no errors.

### 11.2 Evaluation harness (GRD-9; C7)

`npm run eval` (`test/eval/run-eval.cjs`) measures AutoDE on the reference problem in `test/reference/retail-orders/` (README there describes the fixtures and the five traps).

- **Runs real code headlessly:** `test/eval/lib/vscodeHost.cjs` is a `vscode` stand-in backed by the real file system (interactive prompts resolve to "declined"); AutoDE's compiled `dist/` modules run unchanged.
- **Systems under test** (`test/eval/sut/`): `baseline.cjs` (v0.26.0 behaviour: global dump), `ledger.cjs` (C2: ledger + conflict detection; proposes each scripted turn's facts from `golden/assertions.yaml` with outcome fields withheld, standing in for C4 extraction), `packs.cjs` (default, C3: per-step and per-question packs, the hub's context provider, an `ArtifactWriter` so manifests are written). A new phase adds an adapter and is scored on identical inputs; `--sut` selects one, which doubles as the ablation.
- **LLM routing** (`test/eval/lib/llmRouter.cjs`) wraps `LLM_ADAPTERS`: `offline` (calls refused, deterministic fallbacks), `record` (real provider, saves a cassette), `replay` (answers from the cassette, misses counted).
- **Measures:** ingestion fidelity; context per plan step (relevant and noise tables named, tokens, column detail) with the noise schema imported last and first; answerability per question from the context layer; QA accuracy (replay/record); trap detection; identifier grounding and type checks of generated SQL (`src/engine/grounding/sqlGrounding.ts` — a pattern scanner over `FROM`/`JOIN` targets, aliases and qualified columns, not a SQL parser); expected artifact properties (checked on code with comments removed); decision backing and stale-fact use from manifests.
- **Business-problem pack** (v0.33.0): `measurePack()` copies the house-format contract, its confirmed profile, the BRD and the customer samples into a fresh workspace, applies them through `BusinessPackManager`, and scores `documents/pack/expected.yaml`: planted violations in source B found, false ones in source A, clauses superseded by revision 2, interview questions dropped or kept, BRD facts with section provenance (needs an LLM: replay/record), vocabulary proposals. The vocabulary-mismatch scenario then adds the customer's glossary (`documents/pack/glossary.md`) to a pack on the estate workspace, accepts every LLM proposal (offline: the stand-in `vocabulary-proposal.offline.json`) and re-measures all questions. Trap 3 runs through `capabilities.verify` (packs SUT): the chat-proposed key claim is probed over `sources/samples/loyalty_members.csv` and recorded in the ledger.
- **Scale and vocabulary** (v0.32.0): `lib/largeEstate.cjs` generates a deterministic estate (4 systems, 20 schemas, ~2 000 tables, ~50 000 columns, planted questions); `measureLargeEstate()` imports it through `ContextFileManager.ingestParsed()` and reports import time, heap growth (explicit `gc`), event-loop delay per stage (`monitorEventLoopDelay`, 10 ms resolution) plus directly timed parses and pack builds (the longest synchronous task), schemas per pack, promotion/sync and reload time, and catalog/ledger size. `vocabulary-questions.yaml` is scored per signal level by switching the catalog search's `signals` off one at a time. The ledger and packs SUTs import sources through `ingestParsed()` as the extension does.
- **Outputs:** `eval-report.md` and `eval-results.json` (rolling, git-ignored); frozen per-release copies in `baselines/`.

---
### 10.6 MCP server (v0.35.0; MCP-1)

- **Entry:** `src/mcp/server.ts`'s `main()`, started as `autode mcp --workspace <root> [--resources <extension root>] [--allow-cli] [--drivers <folder>]` from the CLI bundle `dist/autode.js` (§10.8; since v0.42.0). `dist/mcp-server.js` is a two-line shim for the same call, kept for existing client configurations. The module no longer starts itself on `require.main === module`, because in a bundle every inlined module sees that. `findResourcesRoot()` walks up from the bundle to the nearest `package.json` named `auto-data-engineering-hub` or `autode` (bundled `skills/`, `primitive-definitions/`, version). Uses the SDK's low-level `Server` with plain JSON Schemas (no zod in our code) over `StdioServerTransport`; stdout carries the protocol, logs go to stderr through `redact()`. `createAutodeServer(options)` is exported for in-process hosts (phase 5).
- **Reads through `EngineWorkspace`** (`src/mcp/workspace.ts`): `.autode/**` and the extension's resources, read only. Writes are limited to:
  - decisions (`.autode/decisions/`) and the engine applying an approved decision (§7.7, since v0.40.0);
  - since v0.43.2, the parity tools in `src/mcp/workspaceTools.ts`: `autode_start_problem` (a draft spec) and `autode_select_problem` (the local pointer) through `src/engine/documents/problems.ts`, and `autode_ingest_file` / `autode_ingest_metadata` (observed metadata) through `src/engine/context/estateIngest.ts`.

  Those tools are annotated `readOnlyHint: false, destructiveHint: false`. Tool skills load with `loadToolSkillStates(..., { migrate: false })` (an unmigrated pre-S2 skill is unreviewed here). Context: `contextSources()` loads the ledger, projects the graph for the active spec (`active-problem.json` → `spec/business-problem.yaml` `id`), detects conflicts, loads the catalog with vocabulary and `glossaryAliases()` and builds its index in memory — the same `ContextPackSources` the extension builds, minus runtime facts; packs do not promote into the working set. Each source is cached by a fingerprint of path + size + mtime of its files. Primitives are re-registered (bundled + `.autode/config/primitives` + `history/`) when those folders change.
- **Tools** (`src/mcp/tools.ts`, `TOOLS`): `autode_search_primitives`, `autode_describe_primitive`, `autode_validate_transform`, `autode_compile_transform` (registry, `getPrimitiveVersion()`); `autode_validate_pipeline_spec`, `autode_compile_pipeline_spec` (adds `suggestedPath` = `autode-output/<active problem>/03-build/<specId>.v<n>/<entity>/<nn>_<kind>.sql`, where `ArtifactWriter` puts build artifacts; the server assumes the default output folder), `autode_generate_design_doc`; `autode_resolve` (`resolveText` over the working set + `Catalog.search`), `autode_get_context_pack` (`buildContextPack`), `autode_list_assertions` (mirrors excluded unless `includeMirrors`), `autode_check_grounding` (`checkSqlGrounding` over `buildSchemaIndex(graph)`). All annotated `readOnlyHint: true, destructiveHint: false, idempotentHint: true`. Arguments are Ajv-validated against `inputSchema` before a handler runs (validators compiled per tool on first use, since platform tools' schemas are built per server). Workspace paths are refused if they leave the workspace.
- **Platform tools** (v0.37.0, `src/mcp/platform.ts`): `platformTools(session)` adds `autode_list_connections`, `autode_test_connection`, `autode_list_databases`, `autode_list_schemas`, `autode_extract_metadata` (`schemaFilter: ['<database>.<schema>']`, optional `tables`, `profile` → `includeProfiling`), `autode_explain_sql` (one statement via `checkSingleStatement()`, prefixed `EXPLAIN USING TEXT` on Snowflake and `EXPLAIN` on Databricks; writes may be explained, since EXPLAIN compiles without running) and `autode_execute_query` (`checkSingleStatement()` always, `checkReadOnlySql()` unless `--allow-write`; `maxRows` default 100, schema maximum 10 000; `timeoutSeconds` default 60; result through `gateQueryResult()` with the connection's current consent). All are `openWorldHint: true`; `autode_execute_query` is `readOnlyHint: false, destructiveHint: true` when the server allows writes, and the server's `instructions` say so. `PlatformSession` holds one `ConnectionManager` per connection id, opened on first use (a failed connect is forgotten so the next call retries; `autode_test_connection` reconnects), and disposes them when the transport closes; it registers the engine's built-in resolvers (`env`, `cli`) only, and passes `cliConsent: --allow-cli` and `sampleDataConsent` (the file, re-read per call). `classifyPlatformError()` maps failures to `AUTH_FAILED` / `PERMISSION_DENIED` / `TIMEOUT` / `CONNECTION_FAILED` (connect) / `PLATFORM_ERROR` (statement), with the raw text in `details`; a missing CLI consent becomes `PERMISSION_DENIED` naming `--allow-cli`.
- **Prompts and resources** (`src/mcp/catalogs.ts`): `autode_interview_<id>` (bundled skills overridden by `.autode/config/skills/*.json`; body = systemPrompt + questionGuidance + spec fields + examples + optional `answers_so_far`); `autode_skill_<id>` only when `isSkillExposable()` (S2) — the body states the declared tools and the tier's limits. Resources: `autode://spec/business-problem`, `spec/pipeline`, `context/{source,target,mapping,semantic-layer}` (listed only if the file exists) and `autode://primitives/{kind}` (also a resource template); contents carry `_meta.revision` (SHA-256 of the bytes) and are redacted.
- **Errors** (`src/mcp/errors.ts`): tool failures return `isError: true` with `{ code, message, retryable, details }` as `structuredContent` and text; codes are the §5.6 set plus `NOT_FOUND` and `INTERNAL_ERROR`; string details are truncated at 2 000 characters. Prompt and resource failures are JSON-RPC errors (`InvalidParams` / `InternalError`) carrying the envelope as `data`. `redact()` removes PEM private keys, bearer/basic tokens, JWTs, `key=value` secrets, URL credentials, Databricks PATs, GitHub/OpenAI/Anthropic/AWS-style keys and `AUTODE_*` credential variables; `redactValue()` also blanks values of secret-named keys.

### 10.7 Build and packaging (v0.35.0; NFR-5)

- `npm run compile` = `tsc -p ./` (every module to `dist/**`, used by tests and the eval) then `scripts/bundle.cjs` (esbuild, CJS, `node18`): `dist/extension.js` (external `vscode`; replaces tsc's file) and `dist/autode.js` (no externals, `#!/usr/bin/env node` banner; the CLI with the MCP server, §10.8). Since v0.42.0 `dist/mcp-server.js` is written as a shim that calls `require('./autode.js').main(['mcp', …])`. Development bundles are readable with linked maps; `vscode:prepublish` builds `--production` (minified, no maps): 776 KB and 554 KB (v0.38.0; 740 and 470 KB at v0.35.0). `--analyze` prints what each bundle contains.
- `.vscodeignore` is an **allowlist** (`**`, then `!` per shipped file): the bundles (`extension.js`, `autode.js`, the `mcp-server.js` shim) and `dist/THIRD-PARTY-NOTICES.md`, the icons (`media/autode-icon-256.png` marketplace, `media/autode-icon-64.png` MCP, `media/autode-activitybar.svg` single-colour glyph for the activity bar and panel), webviews, `skills/*.json`, `primitive-definitions/**`, `docs/schemas/*.json`, README, CHANGELOG and LICENSE — so local folders (`.claude/`, `.venv/`, `.autode/`) can never ship; no `node_modules/` (before v0.35.0 the package excluded `node_modules/` while `ajv` and `yaml` were runtime dependencies, so a packaged extension could not load). Package with `vsce package --no-dependencies`.
- **Licences of bundled code:** the bundles strip comments, so `scripts/bundle.cjs` writes `dist/THIRD-PARTY-NOTICES.md` from esbuild's metafile — every package actually bundled (innermost `node_modules/<pkg>` of each input), with its version, declared licence and full licence file.
- **Identity:** publisher `arun-gribta` (extension id `arun-gribta.auto-data-engineering-hub`); the MCP server reports `title: 'AutoDE'` and the 64 px icon as a data URI (`serverIcons()`).
- The `activate()` functional test loads the bundled `dist/extension.js`, so the bundle itself is smoke-tested on every `npm test`.

### 10.8 The `autode` CLI and package (v0.42.0; MCP-3, P9)

- **Entry:** `src/cli/main.ts` (no `vscode`, lint-enforced like `src/engine` and `src/mcp`). It is bundled to `dist/autode.js`, the only entry point of the bundle. `run(argv, io)` returns the exit code. `CliIo` carries stdout and stderr, env, cwd, `interactive` (stdin and stdout are TTYs), `prompt()` and an optional `platform` factory, so tests drive it in-process with a scripted terminal and fake adapters. Arguments are parsed with `node:util` `parseArgs` (strict; one option table for all commands). `mcp` is dispatched before parsing and hands its argv to `src/mcp/server.ts` `main()`.
- **Shared handlers:** `validate <path>`, `compile` and `grounding` call `TOOLS` handlers (`autode_validate_pipeline_spec`, `autode_compile_pipeline_spec`, `autode_check_grounding`) on an `EngineWorkspace`, so the CLI and the MCP server return the same results (a test compares them). `EngineWorkspace` gained `problemId` (overrides `.autode/local/active-problem.json`, which CI doesn't have) and `problemIds()`. Problem selection: `--problem`, else the active problem, else every problem. Commands that need a single problem refuse with exit 2 when several exist.
- **validate / check:** per problem, `parseBusinessProblemSpec`, `parsePipelineSpecDocument` + `validatePipelineSpec` (schema and primitive parameters, after `ensurePrimitives()`), and `parseMappingContext`. Workspace-wide: `primitiveLoadErrors()` and `loadConnectionsConfig().errors`. `check` then lists pending decisions whose `problemId` is in scope (or unset), drops those whose file `resolution` has a decision and a `by` (a person resolved it in a commit; nothing is synced or written), and keeps those whose stakes, **recomputed** with `stakesFor(kind, proposal)`, are high. Exit 1 outranks exit 3.
- **conformance / probe:** pack logic moved from `BusinessPackManager` into `src/engine/context/packChecks.ts` (`readPackFile`, `loadProfiles`, `profileFor`, `sampleProbeExecutor`, `packConformance`, `probeCandidates`); the manager delegates. The catalog is loaded from `.autode/knowledge/catalog/`. `--connection` adds `createSqlProbeExecutor` over a `PlatformSession` (read-only, `allowWrite: false`). `probe` uses the new `probeAssertions()` in `probes.ts`, which runs probes without recording; `verifyAssertions()` now calls it and records the outcomes.
- **doctor:** `checkPrerequisites()` for the platforms the connections use (all, if none), `connectionStatus()` per entry from `readReadiness()`, and the drivers folder. It fails only on config errors or a required prerequisite of a platform in use.
- **decisions:** `list` and `show` read `DecisionStore` without syncing file resolutions. `approve` and `reject` refuse with exit 4 when `CI` is set (anything but empty, `0` or `false`) or `io.interactive` is false. They print the decision and require the verb typed back, then call `DecisionStore.resolve(..., channel: 'cli')`. An approval is applied with `applyDecision()` against the decision's own problem folder. A `platform_change` stays approved; an `--allow-write` server applies it.
- **facts, pack, vocabulary, SQL (v0.43.3):**
  - **Fact review** moved out of `webviewProvider` into `src/engine/context/factReview.ts` (`inbox()`, `factView()`, `reviewFact()`, `bulkConfirmDocumented()`). The panel and `autode facts` call the same functions over `openContext()`'s ledger, then `persistCompiledGraph()`. `facts confirm | reject | edit` go through `requirePerson()`.
  - **Pack:** `BusinessPackManager` moved to `src/engine/context/businessPackManager.ts` (re-export at the old path). `pack add` needs a person; `pack apply` runs `applyDocument()`, which needs no model for structured documents with a confirmed profile.
  - **Vocabulary:** `vocabulary mine` uses `mineAbbreviations()` over the catalog; `accept` writes with `mergeVocabularyFile()`.
  - **SQL and documents:** `design-doc` calls the `autode_generate_design_doc` handler. `query` and `explain` call the `autode_execute_query` and `autode_explain_sql` handlers from `platformTools(session)`, so the read-only guard and `gateQueryResult()` are the server's own. `--version` is the global flag, so the pack's document version is `--doc-version`.
  - **MCP** (`src/mcp/workspaceTools.ts`): `autode_pack_list`, `autode_pack_add` (authority forced to `draft`), `autode_pack_apply`, `autode_check_conformance` (`packConformance()` with samples and optional live probes), `autode_mine_vocabulary`.
  - **New decision kind `vocabulary`:** low stakes in `stakesFor()`, validated by `validateVocabularyProposal()` (single-word synonyms), applied with `mergeVocabularyFile()`. Its tool is `autode_propose_vocabulary`.
- **problems and estate (v0.43.2):**
  - `problems list | new | use` call `listProblems()`, `startProblem()` (slug from `generateProblemSlug()`, now in `src/engine/documents/problemSlug.ts`; a v1 draft via `writeBusinessProblemSpec()`; then made active) and `setActiveProblem()` in `src/engine/documents/problems.ts`.
  - `estate show | ingest | extract` call `openContext()`, `ingestFile()` and `ingestConnection()` in `src/engine/context/estateIngest.ts`:
    - `ingestFile` optionally binds the file with `bindToSystem()`, takes `resolveFile()`'s identity, then runs `parseFile()` and `ingestParsed()`.
    - `ingestConnection` binds when asked, sets the manager's estate resolver to `resolveConnection()`, takes the schemas from the option or the binding, then runs `extractMetadata({ schemaFilter })` (sanitised for sample-data consent), `ConnectionManager.snapshotGraph()` (new) and `ingestParsed()`.

    This is the same catalog, working-set and ledger path as the panel. The panel's Source Assessment still goes through `schema-graph.json` and a re-index; the result is equivalent.
- **connections (v0.43.1):** `list` and `test <id>` (`PlatformSession.connect(entry, true)`, then `recordReadiness()` with the platform's raw reason on failure through `platformReason()`). `add` and `remove` go through `requirePerson()`, which is shared with `decisions approve`. `add` uses `src/engine/platform/connectionSetup.ts`:
  - `discoverCliConnections()` reads `connections.toml`, `.databrickscfg` and tnsnames aliases from the files, without running the CLIs;
  - `setupFields(platform, resolver)` gives the questions in order, with required and personal flags;
  - `draftEntry()` gives the entry to test before anything is written;
  - `credentialNeeds()` gives the resolver's source and the `AUTODE_*` variables with whether each is set.

  It then checks `validateConnectionDraft()` (extracted from `saveConnection()`, which now calls it), tests, asks for the typed confirmation, and calls `saveConnection()`. `--resolver vscode` is refused outside the extension.
- **Exit codes** (`EXIT`): 0 ok, 1 failed, 2 usage, 3 pending high-stakes decision, 4 refused, 5 not found, 6 platform, 70 internal. `EngineToolError` codes map onto them in `fail()`. The reference is docs/guides/cli.md.
- **Package** (`scripts/pack-cli.cjs`): `stage()` builds `dist/package/` from `dist/autode.js`, the shim, the notices, `skills/*.json`, `primitive-definitions/`, the 64 px icon and LICENSE. The README is docs/guides/cli.md with its relative links rewritten to the repository. It writes a `package.json` with name `autode`, the extension's version, `bin.autode`, `engines.node >= 18` and no dependencies. `pack()` runs `npm pack --json --pack-destination`. `npm run package:cli` = production bundle, stage, pack. The layout mirrors the extension's, so `findResourcesRoot()` works unchanged. Tests check the file list, that no file references `vscode`, the size budget (tarball < 600 KB, unpacked < 2 MB; 282 KB and 1.27 MB at v0.42.0 with development bundles), and that `autode mcp` from the staged package lists the same tools, prompts and resources and gives the same tool results as `dist/mcp-server.js`. Nothing is published.
- **Configure MCP** (`src/core/mcpConfig.ts`, command `autoDataEngineeringHub.configureMcpClaudeCode`): `chooseMcpEntry()` scans `PATH` (with `PATHEXT` on Windows; no process is spawned). An installed `autode` gives `autode mcp --workspace .` (`cmd /c autode …` on Windows, because native clients can't start npm's `.cmd` shim). Otherwise it uses `node <extension>/dist/autode.js mcp`, or VS Code's executable with `ELECTRON_RUN_AS_NODE=1` when there is no Node. `mergeMcpJson()` keeps other servers and keys. The command shows the command line in a modal and writes only on confirmation. At activation, `hintStaleMcpJson()` offers *Update .mcp.json* when the entry runs a bundle from another `auto-data-engineering-hub-<version>` folder; it never writes.

### 10.9 The extension as an MCP client; agent mode; stable server copy (v0.43.0; MCP-1, SKL-2)

Phase 5, restructured (roadmap decision log 2026-10-20).
- **`EngineClient`** (`src/core/engineClient.ts`, no `vscode`): `createAutodeServer()` and an SDK `Client` joined by `InMemoryTransport.createLinkedPair()`. That is the same protocol, tool list, Ajv validation, redaction and error envelope as `autode mcp`, with no child process. It connects on the first `listTools()`, `call()` or `toolSet()`; a failed connect is forgotten, and `dispose()` closes it, so the next call starts a fresh server. Its `PlatformSession` is created with `allowWrite: false`; `allowCli` (the `dataPlatformCliConsent` setting) and `driversRoot` are read at start. `resolver: vscode` connections work in-process because the extension's VS Code secret resolver is registered in the same process. `call()` turns `isError` into `EngineError(code, message, details)`. `AgentHub.setEngineFactory()` gives tool-skill contexts (`AgentExecutionContext.engine`, type `EngineAccess` in `src/engine/types.ts`) a new client per run; other agents get none.
- **Agent mode** (`registerMcpProvider()` in `src/core/mcpConfig.ts`; `contributes.mcpServerDefinitionProviders` id `autode`, activation event `onMcpCollection:autode`): feature-detected (`vscode.lm.registerMcpServerDefinitionProvider` and `McpStdioServerDefinition`, VS Code 1.101+), so `engines.vscode` stays ^1.90. `provideMcpServerDefinitions` returns one stdio definition for the first workspace folder: `process.execPath` (VS Code's runtime) with `ELECTRON_RUN_AS_NODE=1`, args `<extension>/dist/autode.js mcp --workspace <root>`, cwd the root, and the extension's version. `resolveMcpServerDefinition`, called only when VS Code starts the server, adds `vscodeSecretEnv()`: for each `resolver: vscode` entry in `connections.yaml`, the VS Code resolver's values mapped by `standInEnv()` (`src/engine/platform/connectionsConfig.ts`) onto the entry's own secret fields' `AUTODE_<P>_<REF>_<FIELD>` names. Secrets are therefore never in the listed definition. Workspace-folder changes fire `onDidChangeMcpServerDefinitions`.
- **Stable copy:** `ensureStableServer()` copies `SERVER_FILES` (the same list as `scripts/pack-cli.cjs` `CONTENT`; a test keeps them equal) into `<globalStorage>/autode-server/`. It writes a `package.json` named `autode` with the version (so `findResourcesRoot()` works) and swaps the folder in with one rename. `AutoDE: Configure MCP for Claude Code` creates the copy when `autode` isn't on `PATH`, and `chooseMcpEntry({ stableBundle })` then uses it (`source: 'stable'`). At activation, 3 s later and off the activation path, `refreshStableServer()` recopies an *existing* copy of another version; it never creates one.
- **Not built, by decision:** a supervised child process with version checks and backoff (§7.1); routing the built-in agents, the webview and the panel's approvals through the client (§7.3 and the PA1 channel model, decision log); the lint ban on engine value imports.

## 12. Source Tree

Generated from `src/` (`npm run docs:generate`; `npm test` fails when it is stale). `src/engine/**`, `src/mcp/**` and `src/cli/**` never import `vscode` (§10.2).

<!-- generated:source-tree -->
```
src/    # activation and command registration
  extension.ts
src/agents/build/    # the tool-skill runner
  ToolSkillAgent.ts
src/cli/    # the autode command line (no vscode; §10.8)
  main.ts
src/context/    # host-side managers: specs, plans, context documents, business-problem pack, artifacts, chats, graph, watchers
  ActiveProblemManager.ts, ArtifactStalenessScanner.ts, ArtifactWriter.ts, BusinessPackManager.ts, ChatSessionManager.ts, ContextFileManager.ts, ContextFileWatcher.ts, GraphManager.ts, MappingContextManager.ts, PipelineSpecManager.ts, SourceContextManager.ts, SourceRegistry.ts, SpecManager.ts, SynthesisPipeline.ts, TargetContextManager.ts, vscodeFileIo.ts
src/core/    # orchestrator, webview/panel providers, LLM adapters and tools, spec engine, configuration
  agentExecutor.ts, agentHub.ts, agenticTools.ts, attachmentExtraction.ts, claudeCodeAdapter.ts, claudeStream.ts, configManager.ts, discoveryProgress.ts, disposables.ts, engineClient.ts, extensionIdentity.ts, implementationType.ts, keywords.ts, knowledgeExplorer.ts, knowledgeExplorerModel.ts, languageModelAdapter.ts, llmAdapter.ts, llmModelChoice.ts, llmProviders.ts, mcpConfig.ts, platformOnboarding.ts, platformPrerequisites.ts, portSkillSession.ts, portSkillView.ts, problemSlug.ts, runbookView.ts, runbookViewModel.ts, skillsView.ts, sourceContextQuestions.ts, specOpsPrompts.ts, specSynthesis.ts, targetContextQuestions.ts, tokenBudget.ts, webviewProvider.ts, webviewSecurity.ts, workflowView.ts, workflowViewModel.ts
src/core/credentials/    # VS Code SecretStorage credential resolver
  index.ts, VsCodeSecretStorageResolver.ts
src/editors/    # custom editors
  DataModelEditorProvider.ts, DocEditorProvider.ts, GraphEditorProvider.ts, ProfileEditorProvider.ts, SemanticModelEditorProvider.ts, SttmEditorProvider.ts
src/engine/    # shared types (everything under src/engine/ is free of vscode)
  types.ts, workspaceLayout.ts, workspaceMigration.ts
src/engine/agents/    # role templates, skills, assignments, the skill catalog, the plugin, and the deterministic helpers agents build on
  answerTrace.ts, artifacts.ts, assignment.ts, chatFrontDoor.ts, columnMatch.ts, definitions.ts, modelDraft.ts, plugin.ts, primitiveCandidates.ts, reconcilePlan.ts, skillCatalog.ts, sourceContextDraft.ts, stageGaps.ts
src/engine/approvals/    # what waits for a person, gathered from every mechanism (SIMP-1)
  waiting.ts
src/engine/context/    # assertions, ledger, projection, conflicts, estate ids, catalog, vocabulary, retrieval, packs, gaps, business-problem pack, profiles, contracts, conformance, probes, persistence, ingestion
  assertions.ts, assertionSchemas.ts, businessPackManager.ts, capture.ts, catalog.ts, chatExtraction.ts, conflicts.ts, conformance.ts, contextFileManager.ts, contextGaps.ts, contextPack.ts, contextStore.ts, ContextValidator.ts, contracts.ts, coverage.ts, dataCandidates.ts, discoveryGaps.ts, documentExtraction.ts, estate.ts, estateIngest.ts, factReview.ts, fileIngestion.ts, graphManager.ts, graphPersistence.ts, ledger.ts, pack.ts, packChecks.ts, probes.ts, problemContexts.ts, profiles.ts, projection.ts, retrieval.ts, sessionReview.ts, sourceFiles.ts, types.ts, vocabulary.ts, Yaml.ts
src/engine/decisions/
  decisionStore.ts, proposals.ts
src/engine/documents/
  problemDocuments.ts, problemMode.ts, problemOverlap.ts, problems.ts, problemSlug.ts
src/engine/explore/
  explore.ts, lineage.ts, render.ts, sources.ts
src/engine/governance/
  governance.ts
src/engine/grounding/    # SQL grounding checks, manifests, reports
  manifest.ts, semanticGrounding.ts, sqlGrounding.ts
src/engine/interview/
  specOps.ts, state.ts
src/engine/knowledge/
  articles.ts
src/engine/lineage/
  observed.ts, record.ts
src/engine/maintenance/
  brief.ts, policy.ts, queue.ts, scan.ts, turns.ts
src/engine/metadata/
  model.ts, record.ts
src/engine/pipelineSpec/    # Pipeline Specification
  compiler.ts, designDocGenerator.ts, schema.ts, types.ts, validator.ts
src/engine/platform/    # connections and adapters
  BaseAdapter.ts, ConnectionManager.ts, connectionReadiness.ts, connectionsConfig.ts, connectionSetup.ts, dialectMarkers.ts, driverStore.ts, prerequisites.ts, providerRegistry.ts, sampleData.ts, sqlGuard.ts, types.ts
src/engine/platform/adapters/    # Snowflake and Databricks adapters
  DatabricksAdapter.ts, OracleAdapter.ts, SnowflakeAdapter.ts, snowflakeJwt.ts
src/engine/platform/credentials/    # credential resolvers and CLI detection
  CliConfigResolver.ts, cliDetection.ts, cliRegistry.ts, databricksCfg.ts, DatabricksCli.ts, EnvVarCredentialResolver.ts, index.ts, PlatformCliDescriptor.ts, registry.ts, SnowflakeCli.ts, tnsnames.ts, types.ts
src/engine/platform/executionBackends/    # CLI and REST execution
  DatabricksRestBackend.ts, SnowflakeCliBackend.ts, SnowflakeRestBackend.ts, types.ts
src/engine/runner/    # runbooks: checks, policy, the runner and its log
  hostGuard.ts, policy.ts, run.ts, runbook.ts, runLog.ts
src/engine/semantic/
  checks.ts, composite.ts, draft.ts, editorState.ts, layer.ts, layerGraph.ts, model.ts, store.ts
src/engine/skills/    # interview skills, tool skills, allow-lists, tool-skill lifecycle and trust
  lifecycle.ts, port.ts, skillRegistry.ts, toolAllowList.ts, toolSkills.ts
src/engine/transforms/    # primitive registry
  registry.ts, types.ts
src/engine/transforms/declarative/    # Tier 2 declarative primitives
  adapter.ts, lifecycle.ts, loader.ts, schema.ts, templateEngine.ts, types.ts
src/engine/transforms/primitives/    # Tier 1 primitives
  dedup.ts, incrementalLoad.ts, mask.ts, renameCast.ts
src/engine/workflows/    # workflow templates, instances, runtime, events, document approval
  documentApproval.ts, events.ts, instance.ts, readiness.ts, runtime.ts, service.ts, stageKinds.ts, templates.ts
src/mcp/    # MCP server (no vscode; §10.6)
  agentTools.ts, catalogs.ts, decisions.ts, errors.ts, exploreTools.ts, maintenanceTools.ts, platform.ts, runnerHost.ts, semanticTools.ts, server.ts, tools.ts, workflowTools.ts, workspace.ts, workspaceTools.ts
```
<!-- /generated:source-tree -->

Outside `src/`: `scripts/bundle.cjs` (esbuild, §10.7), `scripts/pack-cli.cjs` (the `autode` package, §10.8), `media/` (webviews: `sidebar.html`, `panel.html`, `editors/`), `skills/` (bundled interview skills), `primitive-definitions/` (bundled Tier-2 primitives — the loader reads it, none ship yet), `docs/schemas/` (JSON Schemas), `test/` (`functional.test.cjs`, `eval/`, `reference/`, `golden/mcp-compile/` — compile snapshots, rewritten with `AUTODE_UPDATE_GOLDEN=1`).

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

### 13.4 Why Atomic Writes for .autode/?

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

**Original decision:** Lightweight custom parser for `.autode/` YAML files.

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
| `approveSpec` | `{}` | `specManager.approve()` → automatically runs `syncContextFromApprovedSpec()` (spec → Context Layer sync + durable snapshot, v0.10.0) → `hub.inferPhasesFromSpec(spec, contextSummary)` → responds `specApproved` |
| `setImplementationType` | `{ value: 'greenfield' \| 'brownfield' }` | User override of the deterministic Greenfield/Brownfield classification (§3.12); persists `implementationTypeOverridden: true` on the spec so future revisions don't silently reclassify it |
| `startTargetContext` / `reviseTargetContext` | `{}` | Posts `targetContextQuestions` — the fixed 8-question Target Context form (STC-3) |
| `submitTargetContextAnswers` | `{ answers: [{questionId, value}] }` | Saves as `TargetContext` (status `built`); posts `targetContextBuilt` |
| `approveTargetContext` | `{}` | Marks approved, pushes into `hub.setTargetEnvironment()`; posts `targetContextApproved` |
| `chooseSourceContextMethod` | `{ method: 'connected' \| 'described' }` | `'connected'` runs a live connection check (`runSourceConnectionCheck`); `'described'` posts `sourceContextQuestions` (3 fixed questions) — Brownfield only |
| `runSourceConnectionCheck` | `{}` | Re-runs the live connection check (retry) |
| `submitSourceContextAnswers` | `{ answers: [...] }` | Saves as `SourceContext` (status `built`, method `described`); posts `sourceContextBuilt` |
| `approveSourceContext` / `reviseSourceContext` | `{}` | Approve marks approved and posts `sourceContextApproved`; revise re-opens the form (or re-runs the connection check for `method: 'connected'`) |
| `updateSettings` | `{ settings: Partial<DataAgentHubSettings> }` | `configManager.updateSettings()` |
| `testCopilot` / `testLanguageModel` | `{}` | Command proxy |
| `listLanguageModels` | `{}` | Command proxy |
| `openCopilotHandoff` | `{ prompt?: string }` | Command proxy |
| `reindex` | `{}` | Command proxy |
| `openContextFolder` | `{}` | File system |
| `testConnection` | `{}` | `ConnectionManager.connect()` |
| `sourceAssessment` | `{}` | `ConnectionManager.extractMetadata()` |
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

### Extension → Webview

| Message Type | Payload | Purpose |
|-------------|---------|---------|
| `logEntry` | `{ message: string }` | Log message |
| `settingsLoaded` | `{ ...DataAgentHubSettings, languageModelInfo, copilotInfo }` | Initial settings |
| `settingsSaved` | `{ success: boolean }` | Settings confirmation |
| `error` | `{ message: string }` | Error notification |
| `contextUpdate` | `{ stats, dbEntities, bizTerms, queries }` | Context data |
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
| `contextGateStatus` | `{ targetStatus, sourceApplicable, sourceStatus, canGeneratePlan, blockingReasons, targetContext?, sourceContext? }` | Whether the specification and its contexts are approved (the Pipeline Spec needs them); was the Generate Plan gate unblocked (STC-3) — posted after every context-affecting action |
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