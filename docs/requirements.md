# AutoDE — Requirements Specification

This document is the authoritative reference for AutoDE's design, implementation, QA, and acceptance criteria. It covers: UI/UX, the Enterprise Context Layer (information architecture), the single-workspace artifact model, and local language model integration (GitHub Copilot via `vscode.lm`, and Claude Code via its CLI).

Last updated: 2026-09-16
Author: AutoDE Engineering

---

## 1. Overview & Goals

AutoDE is an AI-augmented VS Code extension for Data Engineering. Key functions:
- Provide a focused DE Agent Workspace webview (single-column, tabbed) as the primary UX for planning, executing, and refining data engineering pipelines.
- Transform a natural-language business problem into a structured, reviewable, versioned **Business Problem Specification (BPS)** — the system of record that governs all subsequent activity.
- Provide an **Enterprise Context Layer** — a persistent, evolving semantic understanding of the user's data environment stored in `.ai-context/` (used to ground prompts and LLM guidance).
- Generate data-engineering artifacts (DDL, dbt models, mappings, docs) into a visible, configurable folder (`.ai-context/artifacts/`) in the user's current repository.
- Offer optional integration with a locally-installed language model (GitHub Copilot via `vscode.lm`, or the Claude Code CLI) such that a user who already has one can opt-in to programmatically route LLM tasks to it with no API key.

Primary non-functional requirements:
- Zero UI blocking (offload heavy compute to worker threads / web workers).
- Strict type-safety, lifecycle / disposal, and atomic file operations for everything under `.ai-context/` (context layer and generated artifacts alike).
- Strong privacy and opt-in consent for any third-party LLM usage (Copilot or cloud providers).
- **Single-workspace model**: AutoDE operates on the currently open repository; there is no multi-project registry.
- **Spec-driven**: the BPS governs phase inference, context creation, orchestration, and end-to-end traceability.

---

## 2. UI & UX Requirements (DE Agent Workspace)

Goals:
- Modern, flat visual aesthetic: minimal heavy frames, subtle accents, consistent spacing, use of VS Code theme tokens where possible.
- Single-column main area containing the primary user flow: Objective → Plan → Chat/Refine → Execute.
- Tabbed organization: "DE Agent Workspace", "Data Integration", "LLM Settings".
- Top status strip: shows connected provider, active provider label, small token/plan metrics, and lightweight actions (stop/refresh). Avoid heavy boxed borders or boxed text in the top strip.
- Table/panel names should drop the redundant "Panel" suffix: use e.g. "DE Agent Workspace", "Data Integration", "LLM Settings".

Specific design decisions and behavior:
- Minimize the number of nested frames. Prefer subtle surface color changes and rounded containers over heavy surface borders for each object.
- Use pill-style status indicators (connected/disconnected) and token counters; avoid verbose text.
- Use responsive, accessible controls that follow VS Code font and color variables (prefers native CSS vars when available).
- Provide empty/placeholder states for unconnected providers and metadata.
- Provide UI elements to configure/choose LLM provider and model, and show local-LLM status (Copilot models / Claude Code CLI) and consent options in the LLM tab (see §9).
- Provide a "Context" section that surfaces the Enterprise Context Layer (layers, business terms, rules, verified queries, relationships) read-only from `.ai-context/`.
- Provide a "register source files" form so users can identify which repository files contain business context, verified queries, and data definitions.
- **Processing feedback (Phase E, v0.9.0).** Every chat-initiated request (plain chat, discovery/revision turns, `/plan`, `/skill`) shows a single evolving "pending" bubble (spinner + a context-derived opening line — e.g. "Starting requirements discovery…", "Continuing the requirements conversation…", "Building implementation plan…" — picked from what's actually about to run, not a canned rotation) from send until the terminal response arrives; existing backend `logEntry` checkpoints update that one bubble in place instead of appending separate static lines. The send control is disabled while a request is pending, closing a real reentrancy gap (the discovery engine isn't safe against two overlapping turns).
- **Chat sessions & lifecycle (Phase F, v0.9.0).** Chat is now a persisted, first-class session, independent of BPS identity (a session may span multiple specs; a spec may span multiple sessions). "🗨 New Chat" (topbar icon, and command palette `AutoDE: New Chat`) archives the current session — never discards it silently — and starts a fresh one. If an agentic discovery/revision interview is in flight, its partial answers are folded into the Enterprise Context Layer as a registered `business_context` source (never resumed as a live Q&A, per explicit product decision) before the session is archived. `AutoDE: Chat History` (Command Palette) lists archived + active sessions and opens a read-only transcript; `AutoDE: Discard Chat` permanently deletes one, gated by a modal confirmation, and only ever on explicit user request. See §8a.

Accessibility & polish:
- All controls accessible by keyboard and screen-reader friendly where practical.
- Use meaningful aria roles for tabs and tab panels.

Deliverables (UI):
- Updated webview HTML/CSS/JS with the polished layout (already present in `media/sidebar.html`).
- A short style guide describing color tokens and component rules.

---

## 3. Enterprise Context Layer — Information Architecture

Purpose: AutoDE maintains a persistent, evolving semantic understanding of the user's data environment in a hidden `.ai-context/` folder inside the repository. This folder holds **derived** knowledge (semantic understanding, metadata, relationships, provenance) — never raw copies of the user's source documents. It is the grounding source for LLM prompts.

### 3.1 Design principles

1. **Uniform envelope, layered content** — every context object shares one metadata envelope (identity, provenance, version, ownership); layer-specific detail lives in a typed `content` section.
2. **Authoritative vs. derived are physically separated** — human-owned knowledge and machine-generated knowledge live in different folders with different versioning rules.
3. **Sources are referenced, never copied** — `.ai-context/` holds derived understanding; original files stay where the user put them, linked via `sources.yaml` + `origin.sourceRef`.
4. **Stable, namespaced IDs** — collision-free, human-readable, stable across renames.
5. **Everything is schema-validated** — each `kind` maps to a JSON Schema validated with `ajv`.
6. **Compiled index for speed, granular files for humans** — many small authoritative files + one derived `graph.json` working set.

### 3.2 Storage decision

Store the context graph as **derived JSON/YAML files loaded into an in-memory index**. Do **not** require a server (Postgres/Neo4j). If node count exceeds ~50k or Cypher-style querying is required, swap the in-memory store for an embedded single-file graph DB (**Kùzu**) — the envelope/file model stays unchanged. Use an embedded vector store (HNSW / SQLite-vec / LanceDB) for embeddings; never a hosted vector DB.

### 3.3 Layer taxonomy

| # | Layer | Contains | Owner | Source | Git |
|---|-------|----------|-------|--------|-----|
| 1 | **industry** | cross-vertical patterns, regulatory templates | shared/template | template library | committed |
| 2 | **enterprise** | naming standards, governance, security rules, global KPIs | enterprise (user) | user files | committed |
| 3 | **domain** | business concepts, metrics, relationships | domain team (user) | user files | committed |
| 4 | **system** | databases, schemas, tables, columns, FKs, lineage | derived (AutoDE) | platform metadata | regenerable |
| 5 | **business definitions** | glossary terms, rules, metrics, formulas | user + derived | user files + extraction | committed |
| 6 | **verified queries** | golden SQL, approved patterns | user | user files | committed |
| 7 | **semantic artifacts** | lineage, mappings, data models, docs | derived (AutoDE) | generated | regenerable |

### 3.4 Unified metadata envelope (every object)

```yaml
id: "term:revenue"               # stable, namespaced (see 3.6)
kind: "business_term"            # node/entity type
layer: "domain"                  # industry|enterprise|domain|system|definition|query|artifact
label: "Revenue"
description: "Recognized revenue net of returns"
status: "active"                 # active | draft | deprecated
aliases: ["net revenue"]
tags: ["finance", "kpi"]

origin:                          # provenance / traceability
  source: "user"                 # user | derived | system | llm | template
  sourceRef: "docs/glossary.md#revenue"
  confidence: 0.95               # 0..1 for derived content
  extractor: "domain-extractor"
  extractedAt: "2026-09-08T..."

version: 3
createdAt: "..."
updatedAt: "..."
updatedBy: "finance-team"        # or "autode"

content:                         # layer-specific, validated by per-kind schema
  formula: "SUM(revenue_amt) - SUM(returns_amt)"
  grain: "day"
  dimensions: ["region", "channel"]
```

### 3.5 Relationship model

Relationships are first-class objects with the same envelope:

```yaml
id: "edge:maps_to:table:snowflake.RAW_DB.PUBLIC.sales:term:revenue"
type: "maps_to"                  # maps_to | contains | foreign_key | uses_table |
                                 #   constrained_by | derives_from | related_to
source: "table:snowflake.RAW_DB.PUBLIC.sales"
target: "term:revenue"
weight: 0.9
origin: { source: "llm", confidence: 0.82, extractor: "sttm-mapper" }
```

### 3.6 ID scheme

```text
term:<slug>                         # term:revenue
rule:<namespace>.<slug>             # rule:enterprise.pii_masking
metric:<domain>.<slug>              # metric:sales.daily_revenue
table:<platform>.<db>.<schema>.<t>  # table:snowflake.RAW_DB.PUBLIC.sales
column:<table-id>.<name>            # column:table:snowflake...sales:amount
query:<namespace>.<slug>            # query:golden.monthly_revenue
artifact:<type>.<slug>              # artifact:lineage.sales_to_finance
edge:<type>:<src>:<tgt>             # edge:maps_to:table:...:term:revenue
```

### 3.7 File hierarchy

```text
.ai-context/
├── sources.yaml                 # registry: source file path → {kind, layer, owner}
├── context/                     # AUTHORITATIVE — human-owned, committed, granular
│   ├── industry/<vertical>.yaml
│   ├── enterprise/standards.yaml
│   ├── enterprise/glossary.yaml
│   ├── domain/<domain>.yaml
│   ├── domain/metrics.yaml
│   └── queries/<query-name>.yaml
├── derived/                     # DERIVED — AutoDE-generated, regenerable, gitignored
│   ├── system/<platform>.schema.yaml
│   ├── artifacts/<type>/<name>.yaml
│   ├── graph.json               # compiled index: all nodes + edges (in-memory working set)
│   └── embeddings/              # vector embeddings (later)
├── target-environment.yaml      # config
└── state.json                   # workspace state (objective, phase progress)
```

### 3.8 Ownership & versioning

| Ownership | Where | Edited by | Versioned by | Regenerated |
|---|---|---|---|---|
| Authoritative | `context/` | user (UI or editor) | git + per-entity `version` | no |
| Derived | `derived/` | AutoDE | provenance (`extractor`, `extractedAt`, `sourceRef`) | yes, on source change |
| Config/state | `target-environment.yaml`, `state.json` | user + AutoDE | git / atomic writes | no |

`context/` is **committed** (team-shared); `derived/` is **gitignored** (regenerated from `sources.yaml` + platform metadata + `context/`).

### 3.9 Traceability

Every derived node/edge carries `origin.sourceRef` (the source file/fqn/run that produced it) and `origin.confidence`. This gives lineage-of-knowledge: a business term can be traced back to the source document it was extracted from, and stale/uncertain extractions can be flagged and re-run.

### 3.10 Operational constraints (non-negotiable)

1. **Thread isolation** — embedding, large-graph traversal, and large-file parsing run off the Extension Host main thread (`worker_threads` / web workers).
2. **Atomic file IO** — writes use temp staging + atomic rename (`vscode.workspace.fs`).
3. **Lifecycle/disposal** — graph and index implement `vscode.Disposable`; `deactivate()` disposes everything.
4. **Graceful degradation** — corrupted/partial `.ai-context` files are logged, tolerated, and repaired when safe.
5. **Token budgets** — tokenize (`js-tiktoken`), enforce budgets, prioritize by relevance + graph centrality.

### 3.11 Scalability & evolution

- **Now:** granular files + compiled `graph.json` + in-memory `GraphManager`.
- **Growth:** >~50k nodes or complex queries → **Kùzu** (embedded graph DB) behind the same envelope.
- **Embeddings:** `derived/embeddings/` + embedded vector store, keyed by node ID.
- **New layer:** add a folder + a `layer` value + a per-kind `content` JSON Schema — no envelope change.

---

## 4. Context Layer — Metadata Envelope & Type Definitions

Implement in `src/context/types.ts`. Strict TypeScript, readonly where possible.

Common envelope (every node/edge object):
- `id` — stable namespaced ID (§3.6)
- `kind` — node/edge type
- `layer` — `industry | enterprise | domain | system | definition | query | artifact`
- `label`, `description`, `status` (`active | draft | deprecated`), `aliases`, `tags`
- `origin` — `{ source, sourceRef, confidence?, extractor?, extractedAt? }` (provenance)
- `version`, `createdAt`, `updatedAt`, `updatedBy`

Node kinds (layer-specific `content`, discriminated by `kind`):
- `table`, `column`, `semantic_view` — database, schema, fqn, dataType, isNullable, keys
- `business_term` — formula, synonyms, relatedTerms, metrics
- `business_rule` — ruleText, enforcementLevel (`STRICT | RECOMMENDED`), appliesTo
- `metric` — definition, formula, grain, dimensions
- `verified_query` — sql, dialect, tablesUsed, author, parameters
- `semantic_artifact` — artifactType, content, filePath

Edge kinds:
- `contains`, `foreign_key`, `maps_to`, `uses_table`, `constrained_by`, `derives_from`, `related_to`

Extend the existing `BaseNode`/`TableNode`/`ColumnNode`/`BusinessTermNode`/`BusinessRuleNode`/`VerifiedQueryNode`/`GraphEdge`/`RetrievalOptions`/`SubgraphResult`/`ContextEngineDiagnostics` types with the envelope fields above (and a `content` union discriminated by `kind`).

---

## 5. Context Layer — Core Modules (`src/context/`)

Module A — SourceRegistry (NEW)
- Reads/writes `sources.yaml` (source file path → `{kind, layer, owner}`).
- Backed by the UI "register source files" form.

Module B — ContextFileManager
- Watches `.ai-context/` with a 300ms debounce.
- Loads authoritative `context/**` and the compiled `derived/graph.json`.
- Validates each file against per-kind JSON Schemas (ajv) before loading.
- Atomic writes (temp → rename) for derived artifacts.
- Structured diagnostics + repair on corruption.

Module C — GraphManager
- In-memory graph (Map-based indexes for FQN, label, type) — dependency-free (no `graphology`).
- BFS/neighborhood traversal with decay scoring.
- Snapshot serialization → `derived/graph.json`.
- `dispose()` lifecycle.

Module D — SynthesisPipeline (NEW)
- Ingests `sources.yaml` + platform metadata → derives nodes/edges.
- Extraction = rule-based parsing + LLM-assisted entity/relationship extraction.
- Writes provenance (`origin.sourceRef`, `confidence`, `extractor`).

Module E — ContextRetriever (future)
- Hybrid: graph traversal + (later) vector search + token pruning.
- Pruning hierarchy: STRICT rules → table/column → terms → verified queries.
- `js-tiktoken` budget enforcement → `SubgraphResult` (Markdown + tokenCount).

Module F — Vector Engine Worker (future)
- `worker_threads` embedding (Xenova/hosted) + embedded vector index (HNSW / SQLite-vec / LanceDB).
- IPC: `indexBatch`, `search`, `serializeIndex`, `loadIndex`.

Base DQM Adapter (`src/dqm/BaseAdapter.ts`) — feeds the system layer:
- `extractMetadata()` → nodes/edges; `persistSchemaContext()` → atomic write to `derived/system/`.

---

## 6. Prompt Assembly Formatter

ContextRetriever must format final prompt blocks as compact Markdown (low overhead) for agent system prompts. Example structure (must be token-budget cautious):
- Header: "ENTERPRISE CONTEXT LAYER (DATABASE & SEMANTIC METADATA)"
- BUSINESS RULES & CONSTRAINTS (STRICT)
- RELATIONAL SCHEMAS & SEMANTIC VIEWS (table sketches and columns)
- BUSINESS GLOSSARY & METRICS (with formulas)
- VERIFIED SQL REFERENCE EXAMPLES (few-shot)

Formatting constraints:
- Use simple Markdown bullets and short table metadata lines.
- Ensure tokenization boundaries are preserved; do not cut syntax mid-code or mid-JSON.
- Use js-tiktoken to count tokens and prune nodes until under the requested threshold.

---

## 7. Workspace Artifact Model (single workspace)

AutoDE operates on the user's currently open repository. There is no multi-project registry and no project-creation flow.

- **One workspace = one data-engineering effort.** The "objective" is what the user types to generate a plan; it is persisted in `.ai-context/state.json`.
- **Generated artifacts** (DDL, dbt models, mappings, docs) are written to a **visible, configurable folder** `.ai-context/artifacts/` (setting `autoDE.artifactDirectory`), organized by phase, and — since Phase B (v0.9.0) — by the specification revision that produced them:

  ```text
  .ai-context/artifacts/01-discover/
  .ai-context/artifacts/02-model/
  .ai-context/artifacts/03-build/
    <specId>.v<version>/        ← artifacts stamped with a spec (the common case)
      dbt_project.yml           ← filenames are untouched (dbt/tool conventions preserved);
      models/staging/...           only a folder is inserted, not a filename prefix
    <filename without a folder> ← artifacts with no spec stamp (legacy, or generated with no spec set)
  .ai-context/artifacts/04-validate/
  ```

- **Artifacts are committed to git** — they are deliverables, not transient state.
- **Artifact writes are atomic** (temp staging → rename).
- **Separating efforts** = git branches, not a project registry.
- **Stale-artifact detection** (Phase B): because `PlanState.artifacts` is in-memory only and doesn't survive a reload, the `<specId>.v<version>` folder name is the durable record of which spec revision produced a set of artifacts. The Workflow Palette scans this on open (`scanArtifactStaleness`, `src/context/ArtifactStalenessScanner.ts`) and flags any folder whose version doesn't match the currently approved spec — **it flags, it never auto-touches** the files.

Core module: ArtifactWriter (`src/context/ArtifactWriter.ts`) — persists a `GeneratedArtifact` → `.ai-context/artifacts/<phase>/[<specId>.v<version>/]<filename>`.

Removed (superseded by this model): `ProjectManager` / `ProjectRegistry`, the `newProject` command, project-list UI, and `setActiveProject`.

---

## 8. Business Problem Specification (spec-driven system of record)

AutoDE is **conversation-driven and specification-driven**. The user describes a business problem in natural language; AutoDE transforms it into a structured, reviewable, versioned **Business Problem Specification (BPS)**. The BPS — not the raw prompt — is the **system of record** for the repository and governs all subsequent activity (context creation, workflow inference, orchestration, artifact generation).

### 8.1 The BPS artifact

| Field | Purpose |
|-------|---------|
| `id`, `version` | stable identity; version increments only when an approved spec is revised |
| `status` | `draft` → `approved` (`superseded` for archived revisions) |
| `problemStatement` | refined, objective statement of the business problem |
| `objectives` | measurable business outcomes the solution must achieve |
| `successCriteria` | how success will be verified |
| `scope.in` / `scope.out` | explicitly included / excluded boundaries |
| `constraints`, `assumptions` | technical/regulatory limits; inferred facts the user must confirm |
| `domain`, `stakeholders`, `keyEntities` | context hints for context-building and grounding |
| `createdAt/updatedAt/approvedAt/approvedBy` | audit trail |

Persistence: `.ai-context/spec/business-problem.yaml` (atomic temp→rename). Prior revisions are archived to `.ai-context/spec/history/`. Git is the version history.

### 8.2 Spec-driven conversation routing

- **No spec exists** → the user's first message IS the business problem → the agentic discovery interview (§8.6) starts.
- **Spec is a draft** → the user's next message refines it → the BPS is revised in place (same id/version) via the single-shot `AgentHub.generateSpec`.
- **Spec is approved, no revision armed** → the user's messages are answered conversationally, grounded in the BPS + repository context.
- **Spec is approved, revision armed** (user clicked "↻ Revise", or used `/spec <change>`) → the user's next message is treated as a change request and **starts a full agentic revision interview** — same engine, same rigor as the original (§8.6.1). The approved spec is never mutated in place; a revision always produces a new draft `version + 1` that must be reviewed and re-approved.

### 8.6.1 Revising an approved specification

Implemented (v0.9.0). Clicking "↻ Revise" (or `/spec <change>` while approved) arms a one-shot flag; the next chat message becomes the `changeRequest` and seeds a new `IntakeSession` with `previousSpec` set to the current approved BPS (`SpecOpsEngine`/`createIntakeSession`, `src/core/specOps.ts`). From there it's the identical discovery→synthesis loop used for a brand-new spec (§8.6), with three differences:

- **The discovery and synthesis prompts render the existing approved specification** (`renderSpecSnapshot`, `src/core/specOpsPrompts.ts`) alongside the requested change, with explicit rules: only ask about fields the change plausibly affects or that are still empty; never re-ask about unaffected fields; the synthesis output must be the **full** specification (not a diff), carrying forward everything the conversation didn't touch.
- **`parseComprehensiveSpec` falls back to the previous spec's value for any optional/required field the LLM's synthesis output leaves empty** — a defensive guarantee (independent of prompt-following) that a revision can never silently wipe previously-approved content. Provenance for a carried-forward field keeps its original question/skill attribution instead of being relabeled "synthesis".
- **Supplementary information**: registered context sources (`ContextFileManager.buildContextPrompt()`) are threaded into both prompts automatically; the user can also attach an ad-hoc file mid-conversation (📎 button → `attachSpecFile` message → read via `vscode.workspace.fs`, capped at 200KB, stored on the session and rendered as "Attached reference material").

Version/id continuity (already correct pre-revision-fix): `id` is preserved, `version` increments only when `previous.status === 'approved'` (`parseComprehensiveSpec`, `src/core/specSynthesis.ts`).

**Known limitation:** if the comprehensive-synthesis LLM call itself throws (malformed JSON, provider error), the emergency fallback still uses the older single-shot `generateSpec`/`parseSpecResponse`, which only knows the v1 field shape — `id`/`version`/`status` continuity is preserved through it, but v2 fields (`dataFlows`, `businessRequirements`, etc.) are not. Flagged in code at the fallback call site; not yet fixed.

**Not yet implemented:** `IntakeSession` (the in-progress interview) is still in-memory only — a multi-turn revision spanning a VS Code reload loses progress, same pre-existing gap as the original discovery flow (§16.5).

### 8.7 Versioning & governance (Phase B, v0.9.0)

Per the decision to lean on git rather than build a parallel version store: `.ai-context/spec/business-problem.yaml` is meant to be committed, and git's own history **is** the audit trail. AutoDE adds one convenience on top rather than reimplementing it:

- **"🕓 History" action** on the spec card (palette and chat) posts `viewSpecHistory` → the extension host runs `git log --follow -p -- .ai-context/spec/business-problem.yaml` in the workspace root and renders the output as a chat message. If the workspace isn't a git repository, or the file has no commits yet, this surfaces as a clear error/empty-history message rather than failing silently.
- No in-app version-compare/diff UI was built — `git diff`/`git log -p` (via this action, or the user's own git tooling) is the comparison mechanism. `.ai-context/spec/history/` (already existed pre-Phase-B) remains as a filesystem-level archive independent of git.
- Artifact traceability to a spec version is now durable across reloads, not just in-memory — see §7's `<specId>.v<version>` folder scheme and the stale-artifact flagging in the palette.

### 8.3 Spec-driven workflow

1. User describes the business problem → `AgentHub.generateSpec` (LLM) returns a structured draft BPS.
2. Draft is presented in the chat + Workflow Palette for review; user **approves** (versioned) or replies with **revision** feedback.
3. Approved BPS drives `generatePlanFromSpec` — plan generation is derived from the specification (objective = synthesized BPS content), not the raw prompt.
4. All plans, artifacts, and context nodes are **traceable** to `specId`/`specVersion` (on `PlanState`, `GeneratedArtifact`, and `Origin`).

### 8.4 Workflow Palette alignment

- Palette shows the **current BPS summary** at the top (status badge, review/approve/revise/open actions) as a read-only window into the spec; the authoritative editable/versioned spec lives in `.ai-context/spec/business-problem.yaml`.
- Below it, the four **workflow phases** (Discover / Model / Build / Validate & Document) render as phase rows with their agent cards.
- ✅ **Implemented (v0.6.0):** the palette is a **live status view** of the auto-inferred workflow — each phase row shows completed / in-progress / blocked / pending / unrequired, the deterministic inference reason, and the dependency chain. Unrequired phases are dimmed and completed phases disable manual agent runs; the palette surfaces the agents of the selected (required) phase only.

### 8.5 Implemented

- BPS types + `SpecManager` (`src/context/SpecManager.ts`): initialize/save/approve + history archive + atomic writes.
- `AgentHub.generateSpec(userInput, previous)` + `parseSpecResponse` (LLM drafting/revising, version semantics).
- Spec-aware chat routing in `webviewProvider`; `/spec` slash command.
- Review/approve UI: chat spec card + palette spec section (approve / revise / open file / generate plan).
- Revising an **approved** spec starts a full agentic revision interview (§8.6.1) rather than being edited in place — a "↻ Revise" click or `/spec <change>` arms it, the next message is the change request.
- `AgentHub.generatePlanFromSpec(spec)` — spec-driven plan generation.
- Traceability: `specId`/`specVersion` on `PlanState`, `GeneratedArtifact`, `Origin`.
- **(v0.10.0)** Context Layer synced from the approved spec before Generate Plan is reachable; deterministic Greenfield/Brownfield classification with user override; plan persistence; artifact-level version history — see §8.8.

### 8.6 Agentic Specification Generation (SpecOps)

The draft BPS is produced by an **agentic, DE-tailored requirements flow** (Superpowers-inspired) rather than a single-shot prompt:

- **Skills** — `skills/*.json` define composable DE skills (Requirements Discovery, Source Catalog, Data Flow, Transformations, Quality & Acceptance, Constraints & Assumptions, Synthesis); `SkillRegistry` loads bundled skills plus optional `.ai-context/skills/` overrides.
- **Adaptive questioning** — `SpecOpsEngine` drives a `discovery → synthesizing → draft → refining → approved` state machine with per-field coverage and a turn budget; each turn the LLM returns a validated action (`ask` / `ask_many` / `synthesize` / `done`). Single questions render as chat bubbles; batches render as a dynamic multi-field intake form.
- **Comprehensive synthesis** — `AgentHub.synthesizeComprehensiveSpec` assembles the v2 spec (businessRequirements, dataFlows, transformations, dependencies, acceptanceCriteria, implementationConsiderations, sourceCatalog) with per-field provenance, persisted by `SpecManager`.

This same engine also drives **revising an already-approved specification** — see §8.6.1.

### 8.8 Context Sync, Implementation Type & Plan Governance (v0.10.0)

Follow-up to a review of the Generate Plan workflow, which surfaced three gaps: the Context Layer was never updated from the approved spec before planning, there was no Greenfield/Brownfield classification, and generated plans had no durable, governed record. All three build on existing patterns rather than introducing new ones.

- **Context sync before planning.** Approving a spec (`approveSpec`) now automatically runs `SynthesisPipeline.synthesizeFromSpec(spec)` — objectives/business requirements/dependencies become `business_term` nodes, constraints/assumptions become `business_rule` nodes, all stamped with `Origin.specId`/`specVersion`. Re-synthesizing on a later revision replaces the prior version's nodes rather than accumulating them. A durable, committed markdown record lands at `.ai-context/context/snapshots/<specId>.v<version>.md`. `generatePlan`'s own prompt now also merges in the Context Layer (`contextFileManager.buildContextPrompt()`), which it previously did not.
- **Greenfield/Brownfield classification** (`src/core/implementationType.ts`): deterministic keyword evidence (mirroring phase inference), computed at every spec draft/revision, always user-overridable (`setImplementationType`, preserved across later revisions). Displayed in the chat spec card and the Workflow Palette. Feeds phase inference: a Brownfield classification forces `discover` required by default unless `scope.out` explicitly excludes it.
- **Plan governance.** `PlanManager` (`src/context/PlanManager.ts`) persists the generated plan — steps, status, inferred phases, implementation type — to `.ai-context/plan/plan.yaml`, archiving every prior version to `plan/history/` on each re-plan, mirroring `SpecManager` exactly. Previously `PlanState` had no on-disk representation at all; it now survives a VS Code reload. `ArtifactWriter` additionally archives a file's previous revision to a `history/` subfolder before a rerun overwrites it within the same spec version.
- **Plan validation hardening.** `validatePlanResponse` now runs a topological-sort cycle check (previously only direct self-dependency was rejected; multi-node cycles surfaced later as a "blocked DAG" at execution time) and rejects any returned step whose agent maps to a phase outside the inferred required-phase set (previously a prompt-only instruction with no enforcement).
- **(v0.11.0)** Source and Target Context are now first-class, reviewed, gating objects, required before Generate Plan — see §8.10.

### 8.9 Plan-Completion UX, Stage Review, and Resilient Artifact Generation (v0.10.0)

Follow-up to hands-on testing of the workflow, which surfaced a real bug and three product gaps:

- **Fixed: the "still generating" bug.** `generatePlanFromSpec` left `state.status` at whatever a *previous* plan had left it (often a stale `'ready'`); `inferPhasesFromSpec`'s own internal state broadcast then carried that stale status out to the UI, which read it as "done" and cleared the pending indicator seconds before the actual plan LLM call had even started — then gave no further signal when the real completion happened later. `generatePlanFromSpec` now sets `state.status = 'planning'` before phase inference runs, so the premature broadcast can't happen.
- **Explicit plan-ready confirmation.** Once a plan actually finishes, the chat now shows a clear "✅ Plan generated — N steps across M phases" message with **View Plan** (scrolls to and highlights the plan card) and **Review Stages** (opens the Workflow Palette) actions — mirroring the spec-approval confirmation pattern.
- **Stage review as an explicit checkpoint.** New `PhaseStatus` value `pending-review`: once a plan exists but hasn't been executed yet (`PlanState.status === 'ready'`), required phases read "📝 Pending Review" instead of a bare "Pending" — signaling the palette is a deliberate review step, not just a status board. Each phase row now has **Applicable**/**Non-Applicable** override buttons (`AgentHub.setPhaseOverride`, webview message `setPhaseRequired`) — a manual override survives a subsequent re-plan (re-applied after every `inferPhases()` call) and is cleared by `resetPlan()`. Per product decision (2026-09-15): an override does **not** auto-regenerate an already-generated plan — the palette shows a "may not reflect your latest stage changes" banner with a one-click Re-plan instead, so overriding never triggers a surprise LLM call.
- **"🏗 Generate Artifacts"** is now the label everywhere the plan-execution action appears (palette, chat contextual actions, panel dashboard) — previously "▶ Execute Plan"/"▶ Continue Workflow" in different places, inconsistent with how the workflow was actually being described, and — on the Workflow Palette specifically — not labeled as an execution action at all (it existed, just read as "▶ Continue Workflow").
- **Artifact generation no longer stops at the first failure.** `executePlan`'s DAG loop used to `return` immediately on any step failure, silently abandoning every other independent, unrelated step — so a Snowflake connectivity failure (`snowflakeExecutor`) blocked artifacts that had nothing to do with Snowflake. The loop now marks the failing step `failed` and continues running everything else that's still ready; only steps that are genuinely blocked by a failed dependency are marked failed in turn. The plan's overall status still ends `'failed'` if anything failed, but only after everything that *could* run has run — directly addressing "artifact generation should not be blocked solely because a target platform connection is unavailable."
- **Fixed:** the Panel dashboard's "🏗 Generate Artifacts" quick action (and the `autoDE.executePlan` command generally) had no error handling — a failure (e.g. no plan generated yet) surfaced as an unhandled rejection instead of a clear message. Now wrapped in try/catch like `autoDE.generatePlan` already was.
- **Artifact storage moved under `.ai-context/`** (was a sibling `auto-de/` folder): `autoDataEngineeringHub.artifactDirectory` now defaults to `.ai-context/artifacts`, keeping spec, context, plan, and generated artifacts in one logical location per product direction (2026-09-15) — folder naming may be revisited later (git/repo-management considerations), but the "one root" principle is the durable part of this decision.

### 8.10 Source & Target Context: Mandatory, Reviewed, Gating (v0.11.0)

Follow-up to a hands-on finding: even after §8.8's spec→graph sync, neither source nor target platform context was actually being *established* — the graph sync only re-expressed spec text already visible on the spec card, and `TargetConfigManager`'s generic defaults (Snowflake/dimensional/dbt/Airflow) silently seeded every workspace regardless of the business problem, with no review step. This section closes that gap: Target Context is now always required, Source Context is required for Brownfield (auto-marked Non-Applicable for Greenfield), and **Generate Plan is blocked until both are built and approved.**

- **New types** (`src/core/types.ts`): `ContextStatus` (`not_applicable | pending | built | approved`), `ContextQuestion` (one deterministic Q&A field), `TargetContext`, `SourceContext` — both spec-tied (`specId`/`specVersion`) and distinct from the existing generic `TargetEnvironment`/`TargetConfigFile` (a user-editable tool-preference profile, now no longer auto-seeded into the hub — see below) and from the Context Layer graph (which only ever re-derives what the spec says).
- **New managers** (`src/context/TargetContextManager.ts`, `SourceContextManager.ts`): mirror `SpecManager`'s atomic-write pattern, single current record per spec version (no version history — recomputed fresh per spec version), persisted to `.ai-context/context/target-context.yaml` / `source-context.yaml` (committed, alongside `business-context.yaml`).
- **Structured Q&A, not adaptive.** Per product decision (2026-09-15), Target/Source Context are built through a **fixed, deterministic question sequence** (`src/core/targetContextQuestions.ts`, `sourceContextQuestions.ts`) — not an LLM-adaptive conversation like SpecOps. Each question carries a keyword-evidence `suggestedDefault` (same technique as `phaseInference`/`classifyImplementationType`) so the form isn't blank, but every field is explicitly confirmed or changed by the user, never silently assumed.
- **Target Context flow:** `startTargetContext` → 8 fixed questions (platform, modeling approach, transformation/orchestration tool, naming convention, environment profile, database, schema) → `submitTargetContextAnswers` (status `built`) → `approveTargetContext` (status `approved`, pushes the result into `AgentHub.setTargetEnvironment()` — now the **sole** source of the plan's target environment).
- **Source Context flow, Brownfield only:** user picks one of two methods (`chooseSourceContextMethod`), per product decision (2026-09-15):
  - **Connect** — a live connection check (`webviewProvider.runSourceConnectionCheck`, reusing `ConnectionManager`) that extracts lightweight metadata and records a `connectionSummary` (table/view counts).
  - **Describe** — 3 fixed questions (source type, free-text description, optional data-contract notes) for data-push/no-connectivity cases, composing into `SourceContext.description`.
  - Either way: `submitSourceContextAnswers`/the connection check → status `built` → `approveSourceContext` → status `approved`.
- **Greenfield:** `initializeContextForApprovedSpec` auto-calls `SourceContextManager.markNotApplicable()` — no user action, immediately gate-ready.
- **The gate.** `webviewProvider.computeContextGateStatus(spec)` is the single source of truth: `canGeneratePlan = targetContext.approved && (sourceNotApplicable || sourceContext.ready)`. Enforced server-side in the `generatePlanFromSpec` handler (a blocked attempt returns a clear `error` naming exactly what's missing) — not just a UI affordance. The Workflow Palette's new "Source & Target Context" section (above the phase rows) shows both as status-badged cards with Build/Approve/Revise actions; "Generate Plan"/"Generate Artifacts" buttons across the palette and chat contextual actions read "🧰 Build Context First" (disabled) until the gate passes.
- **Context reaches generation.** `buildContextSummaryForPlan(spec)` merges the Context Layer, the approved Source Context's description/connection summary, and the approved Target Context's platform/tooling summary into the `schemaContext` passed to `generatePlanFromSpec` — closing the last mile from "context exists" to "context is actually in the prompt."
- **Fixed a self-inflicted regression from v0.10.0.** Wiring `TargetConfigManager` into `extension.ts` had made every workspace silently start with generic target defaults and permanently short-circuited the `extractTargetFromMessage` fallback. `TargetConfigManager` stays instantiated (for future dev/staging/prod profile switching) but its default profile is **no longer auto-seeded** into the hub — Target Context is now the sole, spec-aware source of `state.targetEnvironment`.
- **Agents now actually consume context — the other half of the fix.** Per product decision (2026-09-15), the 5 previously-pure-template codegen agents (`ingestionAgent`, `dataModelerAgent`, `sttmAgent`, `architectureAgent`, `transformScaffoldAgent`) now try an LLM call first (`src/agents/llmCodegen.ts#generateWithLlm`, using the new `AgentExecutionContext.callLlm`), grounded in `step.taskDescription` + `context.objective` + `context.schemaContext` (which now includes source/target context) + the target environment — falling back to the original fixed-schema templates when no LLM is available or the call fails. `TransformationScaffolderAgent` LLM-generates only its two most-visible models (staging, marts); project config/intermediate model/tests/macros stay templated as genuinely domain-independent boilerplate. **Correctness note:** `generateWithLlm` only accepts a response wrapped in the requested fenced code block — an unfenced response (prose, a stray error message, anything the model didn't format as asked) is treated as a failed generation and falls back to the template, never shipped as artifact content. This was caught by a test during development: the shared LLM mock in the connectivity-degradation test returns raw plan JSON for every call, and an earlier, looser version of `generateWithLlm` was shipping that JSON as "generated SQL" before the fence requirement was tightened.
- **Not yet done:** `SchemaSnapshot.lineage` still isn't converted into graph `derives_from` edges (§8.9's carryover note). No profile-switcher UI for `TargetConfigManager`. Source/Target Context have no version history (single current record, unlike the spec) — a deliberate scope cut given they're recomputed fresh per spec version rather than incrementally revised.

### 8.11 Multi-Business-Problem Workspace (v0.12.0)

Follow-up to a hands-on finding: clearing chat history and deleting `.ai-context/` by hand did not produce a clean slate — the previously approved spec was still visible in the Workflow Palette, and a new business problem typed into chat jumped straight toward artifact generation instead of the full spec → approve → context → plan → artifacts lifecycle. Root cause: nothing in the extension ever re-derived its in-memory state from disk — `hub`, `SpecManager`, `TargetContextManager`, and `SourceContextManager` all held state that only a VS Code reload (not a UI action) would discard. Confirmed product principle (2026-09-15): **the extension should always start from a clean in-memory state and reconstruct whatever context it needs explicitly from what's persisted, never rely on residual session memory.** The fix generalizes further: a single workspace can now hold **more than one business problem**, each with its own fully isolated spec/plan/context/artifacts, with an explicit "active" one at a time.

- **Folder layout.** Each business problem lives at `.ai-context/problems/<id>/{spec,plan,context,artifacts}/`, mirroring the single-problem layout used before this change (per problem, not shared). `.ai-context/active-problem.json` is a pointer (`ActiveProblemPointer`: `problemId`, `activatedAt`) naming which one is currently active; absent = no active problem (a genuinely clean slate, distinct from "the first problem"). Global/shared state that doesn't belong to any one problem — the source registry (`sources.yaml`), the compiled Context Layer graph (`context/business-context.yaml`, `derived/graph.json`), and chat sessions (`chats/`) — stays at the workspace-level `.ai-context/` root, unchanged.
- **Identity.** A problem's folder name is an auto-generated slug (`src/core/problemSlug.ts#generateProblemSlug`) — first 5 non-stop-words of the problem statement, kebab-cased, truncated to 48 chars, plus a 4-char random suffix for uniqueness (collision-checked against existing slugs, never surfaced to or chosen by the user). Deliberately **lazy**: the folder can't be named before a problem statement exists, so it's created on the first spec draft, not when the user clicks "New."
- **`ActiveProblemManager`** (`src/context/ActiveProblemManager.ts`): owns the pointer file (atomic temp→rename write, same pattern as every other manager) and `listProblems()` — a lightweight scan of every `problems/<id>/spec/business-problem.yaml` (id, problemStatement, status, specVersion, updatedAt, isActive) for the picker, sorted newest-first, skipping unreadable folders rather than failing.
- **Context-root re-scoping.** `SpecManager`, `PlanManager`, `TargetContextManager`, `SourceContextManager`, and `ArtifactWriter` no longer hardcode `.ai-context/<thing>` off the workspace root; their constructors now take an already-resolved `contextRoot: vscode.Uri`, and the caller decides what that root is — a business problem's folder for these five, or the workspace root for the shared managers above. `artifactDirectory` (setting, default `artifacts`) is now resolved relative to that `contextRoot` rather than always under `.ai-context/`.
- **Activation sequence** (`webviewProvider.activateProblem`, called at startup with whatever `active-problem.json` names, and whenever the user starts or switches problems): runs `hub.resetForNewProblem()` first — a fuller reset than the existing `resetPlan()` (used for same-spec re-plans), additionally clearing spec identity, inferred phases, and implementation type, none of which should carry over across *different* business problems. Then swaps the *shared* Context Layer graph's spec-derived layer: removes the previous problem's spec-derived nodes (`GraphManager.removeNodesBySourceRef`) before re-synthesizing the newly active problem's (`SynthesisPipeline.synthesizeFromSpec`) — without this, one problem's objectives/constraints would keep leaking into another's prompts after a switch, the exact class of bug this feature exists to close. Only then are `SpecManager`/`TargetContextManager`/`SourceContextManager` (re)constructed against the new `contextRoot` and initialized; `extension.ts`'s `PlanManager`/`ArtifactWriter` are kept in sync via an `applyProblemRoot` callback the webview provider invokes on every activation, since those two are also needed by command-palette actions that don't go through the webview.
- **New webview actions:** `startNewBusinessProblem` (clears the active pointer, fully resets, archives the current chat, starts a new one — the "genuinely clean slate" workflow) and `switchBusinessProblem` (activates a different existing problem, same reset sequence, also starts a fresh chat since a chat session's content belongs to whichever problem was active when it was written). `listBusinessProblems` → `businessProblemsList` feeds the Workflow Palette's new "Business Problem" section (current active problem, "＋ New", and a "⇄ Switch" list of every saved problem with status/updated-at, current one disabled).
- **Not yet done:** no explicit "delete a business problem" action (folders can still be removed by hand); no renaming of a problem's auto-generated slug; switching problems does not warn about unsaved in-progress spec-interview state (carried over the same way "New Chat" already handles it — folded into context rather than lost, not a special case for this feature).

### 8.12 Lifecycle Orchestration: Closing the Ungated Path (v0.13.0)

Follow-up to fresh testing: "the solution is not consistently following a grounded execution workflow." Traced to a concrete, structural cause (audit Revision 6, §11): the gated lifecycle (spec → approve → context → approve → plan) was real, but coexisted with a second, older, fully ungated path — `AgentHub.generatePlan()`/`executePlan()`, predating the spec-driven architecture — that at least seven live UI entry points could still reach. Product decision (2026-09-16): the **orchestrator** (`AgentHub`) enforces the lifecycle's stage transitions and approval gates; the LLM retains full reasoning latitude *within* each stage. Three specific decisions from that interview:

- **Stage Inference ordering: kept as-is, plus a formal gate.** Phase inference still runs at spec-approval time (before Context Building) and continues to scope the plan-generation prompt to only the inferred phases — re-sequencing it to run after Plan Generation (as one literal reading of the request would have it) was explicitly declined, since scoping the prompt up front is valuable and phases stay reviewable/overridable throughout regardless of when they were first computed. What was missing — a *discrete, one-time* confirmation before Artifact Generation, rather than only continuous editability — is what this section adds (Stage Confirmation, below).
- **Plan Approval: an explicit action**, mirroring `approveSpec`/`approveTargetContext` exactly rather than upgrading the existing "plan ready" toast into a hard block.
- **Business Problem checkpoint: lightweight.** A boolean field (`problemStatementApproved`) on the spec itself, not a separate governed artifact/manager — proportionate to what's usually one or two sentences, promotable to a full artifact later if it ever needs its own version history.

**The orchestrator guard, concretely** (`src/core/agentHub.ts`):
- `AgentHub.generatePlan(objective, schemaContext)` — the method every ungated caller reaches — now requires `state.specId` and `state.contextGateReady` before doing anything else, throwing a clear error otherwise. Its previous body moved to a private `generatePlanInternal()`, which `generatePlanFromSpec()` calls directly (it validates its own, stricter preconditions — spec approved, business problem confirmed, context gate ready — and doesn't need the raw-objective guard on top of that). This one check is what actually closes the "seven ungated entry points" finding from the audit: the Command Palette's "Generate Plan"/"Execute Plan" commands, the AutoDE Dashboard panel's Quick Actions (which route through those same commands), the `/plan` slash command with no approved spec, and the sidebar's re-plan buttons all now hit the same rule, without any of those call sites needing to know the rule exists.
- `AgentHub.executePlan()` now requires `state.planApproved` **and** `state.stagesConfirmed`, both freshly reset to `false` whenever a new plan is generated (`generatePlanInternal`), whenever the inferred phase set changes (`inferPhasesFromSpec`), or whenever a phase is manually overridden (`setPhaseOverride`) — any of those invalidate a prior approval/confirmation.
- New `AgentHub.approvePlan()` / `AgentHub.confirmStages()` — explicit, distinct actions (mirroring `SpecManager.approve()`), each persisted via a new `PlanManager.patchGates()` (in-place, like `patchInferredPhases` — a status change on the existing plan version, not a new generation).
- **The AutoDE Dashboard panel is explicitly parked**, per product decision (2026-09-16) — its Quick Actions route through the now-gated Command Palette commands, so they're automatically covered by the guard above, but the panel's own broken multi-project UI (`projectList`/`getProjects`, which nothing in `panelProvider.ts` ever populates — see audit §11.1) was left untouched. Revisiting it is future work.

**The Business Problem checkpoint** (`BusinessProblemSpec.problemStatementApproved`, new field): every draft/revision synthesis (`applyImplementationType`, called from `draftSpec`/`reviseSpec`/`synthesizeFromSession`) resets it to `false` — a new or changed business problem always needs re-confirmation. A new `approveBusinessProblem` webview action sets it `true`; `approveSpec` now rejects with a clear error if it's still `false`. UI: the spec card (`specActionsHtml`) shows "✓ Confirm Business Problem" in place of "✓ Approve" until confirmed, and a small "Needs confirmation" / "✓ Confirmed" badge next to the Problem Statement field — refining it is just the existing draft-revision chat flow (`reviseSpec`), no new mechanism needed.

**UI for the two new plan gates**: the Workflow Palette's bottom action button and the chat's contextual actions both now walk through "✓ Approve Plan" → "✓ Confirm Applicable Stages" → "🏗 Generate Artifacts" as `PlanState.planApproved`/`stagesConfirmed` change, instead of jumping straight from "plan exists" to "Generate Artifacts."

**A bug found and fixed along the way:** `SpecManager` never actually persisted `implementationType`/`implementationTypeReason`/`implementationTypeOverridden` to YAML (present on the in-memory spec object, silently dropped by `serialize()`) — a user's Greenfield/Brownfield classification, including any manual override, was reclassified from scratch on every reload. Fixed in the same pass as adding `problemStatementApproved` persistence, since it's the same code path.

**Not yet done:** no "delete a business problem" UI (carried over from §8.11); the AutoDE Dashboard panel remains unaddressed (parked, above); no UI warning when re-planning discards a still-valid prior approval/confirmation (the gates simply reset silently — acceptable per the "no confirmation dialogs, everything is reversible" precedent from §10.4, since nothing is destroyed, just re-required).

### 8.13 Discovery Progress Surfacing (v0.13.0, same day)

Follow-up to dev-host testing: "the chat interaction with the LLM seems totally ungrounded — AutoDE is asking valid questions, but I'm not seeing the cohesive, grounded, controlled orchestrator I expected." Root cause, confirmed against the code rather than assumed: the discovery interview's real structure was never a UX problem so much as a **UI-opacity** problem. `SpecOpsEngine`/`IntakeSession` already track per-field coverage, turn budget, and (once resolved) which of the 7 skills owns a given question — but the webview payload for a question was always just `{question}`, and the Workflow Palette showed nothing at all ("No Business Problem Specification yet") for the entire discovery phase, only populating once the draft spec was synthesized at the end. So a genuinely deterministic, coverage-tracked, bounded process read as unstructured chat, because none of that structure ever reached the screen.

- **New pure module** (`src/core/discoveryProgress.ts`): `buildDiscoveryProgress(session, skills)` → `{turnCount, turnBudget, coveredFields, totalFields, skills: [{id, name, status}]}`; `skillNameForField(field, skills)` resolves a question's owning skill deterministically from `SkillDefinition.specFields`, rather than trusting the LLM's own optional `question.skill` string. Coverage only ever reaches `'complete'` at synthesis time (`SpecOpsEngine.completeFields`), so "addressed" here means "not missing" — matching `coverageComplete()`'s own stop-condition definition, not waiting for a status that never occurs mid-interview.
- **Wired into both question-posting paths** (`webviewProvider.postSpecQuestion`, and the `ask_many` branch in `runDiscoveryTurn`): every `specQuestion`/`specQuestions` message now also carries a `progress` snapshot and a `skillLabel` per question.
- **UI (`media/sidebar.html`):** each question bubble now shows its topic (e.g. "🔎 Clarifying requirements · Data Flow") and a compact progress readout (bar + "N/M areas addressed · turn X of up to Y"), via a shared `discoveryProgressLineHtml()` helper. The Workflow Palette's Business Specification section — previously blank during discovery — now shows a live "🔎 Requirements discovery in progress" card with the same progress bar and a per-skill checklist (✓ addressed / ~ partial / ○ not started) whenever a spec hasn't been drafted yet but discovery is active.
- **Not a change to grounding itself** — this surfaces existing orchestration state, it doesn't add new context to the LLM prompts. A secondary, expected-behavior factor noted during the investigation: for a genuinely fresh business problem with nothing registered yet, `ContextFileManager.buildContextPrompt()` legitimately returns empty, so early in a brand-new test the interview has only the user's own answers to reason from — correct, not a bug, but it compounds the "ungrounded" feel on top of the UI-opacity issue this section fixes.

---

## 8a. Chat Sessions & Lifecycle Management (Phase F, v0.9.0)

Prompted by usability feedback: chat had no persisted identity — reloading the sidebar lost history, there was no way to deliberately start over, and an abandoned mid-interview conversation had no defined fate. Chat session identity is **independent of BPS identity** (confirmed via clarifying question — a session may touch several specs over its life, and a spec may be discussed across several sessions), independent of Phase F's related "processing feedback" work (Phase E) and orthogonal to Context Memory curation (deferred — see §16).

### 8a.1 Session model

- `ChatSessionMeta`: `id`, `createdAt`, `updatedAt`, `status` (`active | archived | discarded`), optional `specId`/`specVersion` (recorded at creation time, not kept in sync afterward — a lightweight breadcrumb, not a live link), `llmProvider`, `title` (back-filled from the first user message).
- `ChatMessage`: `role` (`user | ai | log`), `content`, `at` (ISO timestamp).
- Exactly one session is `active` at a time. Every assistant-facing response the webview posts (`chatResponse`, `specDrafted`, `specApproved`, `specQuestion(s)`) and every user message is appended to the active session's transcript as it happens — chat is durable by default, not opt-in.

### 8a.2 Persistence

- `.ai-context/chats/<id>.meta.json` (atomic temp→rename write, mirroring `SpecManager`/`SourceRegistry`) + `.ai-context/chats/<id>.jsonl` (one JSON object per line; read-modify-write, not a true append, since `vscode.workspace.fs` has no append primitive — an accepted cost at realistic chat lengths, not engineered around).
- **Gitignored** (`.ai-context/chats/`), per explicit decision: transcripts are local/exploratory, unlike the curated, committed BPS. Confirmed via clarifying question ("Gitignored (Recommended)").
- Core module: `ChatSessionManager` (`src/context/ChatSessionManager.ts`) — `initialize`, `listSessions`, `getActiveSession`, `createSession`, `appendMessage`, `loadTranscript`, `archiveSession`, `discardSession`, `updateMeta`.

### 8a.3 New Chat

- "🗨 New Chat" (sidebar topbar icon) or Command Palette `AutoDE: New Chat` **archives** the current session (never a silent discard) and starts a fresh `active` one.
- If an agentic discovery/revision interview (§8.6) is in flight, its partial answers and insights are **never resumed as live Q&A** and **never silently discarded** — they are folded into the Enterprise Context Layer first: written as a `business_context` source file under `.ai-context/chats/carryover/<sessionId>.md`, registered via `SourceRegistry.addSource`, and run through `SynthesisPipeline.synthesize` so the partial answers become graph nodes before the interview state is torn down. This is the exact behavior specified by the user in response to a clarifying question that rejected three alternative designs (resumable / blocked / silently abandoned).
- The webview's client-side session state (pending bubble, `discoveryActive`, `discoveryProgress`, `revisionArmed`) resets on every `chatSessionLoaded` message, whether that message arrives from a fresh New Chat, a resumed history session, or the sidebar resolving/reloading.
- **Changed (v0.13.0):** activation itself no longer just "picks up the existing active session" silently — see §8a.4.

### 8a.4 Chat History, Resume & Discard

- **Startup no longer auto-resumes a conversation into view (v0.13.0).** Prompted by dev-host testing feedback ("restarting shows the previous chat loaded — the window should be empty as if it's a new session"). On `resolveWebviewView()`, if the resolved active session already has transcript content, it is **folded** — archived via the same `startNewChat()` path New Chat already uses (never discarded), with a fresh empty session taking its place — before anything is posted to the client. An already-empty active session (nothing to fold) is left as-is, so a genuinely fresh workspace or an already-folded state doesn't churn out an empty archived session on every reload.
- **`openChatSession` now resumes a session live, not a read-only preview (v0.13.0).** Archives whatever's currently active (folding it in turn — nothing is ever lost), reactivates the chosen session (`ChatSessionManager.updateMeta(chatId, {status:'active'})`), and responds with `chatSessionLoaded` (the same message type New Chat and the startup fold use) so the resumed transcript renders exactly like any other active session — new messages append to it normally. The old read-only `chatSessionViewed` response is retired.
- **New sidebar UI: "🕓" Chat History icon** (topbar, next to "🗨 New Chat") — the "on need basis" counterpart to the startup fold. Opens a dropdown (`listChatSessions` → `chatSessionsList`) listing every session (title, active/updated-at), clicking a row resumes it. This is the in-sidebar browser that §8a.4 previously described as scoped-out future work — the server-side plumbing (`listChatSessions`/`openChatSession`) already existed with no client-side consumer; this closes that gap, deliberately scoped to "list + resume" rather than the fuller search/tag/export browser still not built.
- `AutoDE: Chat History` (Command Palette) is unchanged and remains a **read-only** peek (`QuickPick` + `vscode.workspace.openTextDocument`) — distinct from the sidebar's resume-capable picker above; kept for quickly eyeballing a transcript without switching the active session.
- `AutoDE: Discard Chat` (Command Palette) lists sessions, requires the user to pick one, then a **modal confirmation** (`vscode.window.showWarningMessage`) before permanently deleting its meta + transcript files — irreversible, and only ever reachable through this explicit, two-step confirmation flow. Never triggered automatically.

### 8a.5 Explicitly deferred

- **Context Memory curation** (a "Distill this chat" action that runs an LLM extraction pass over a transcript into graph nodes with `origin.source: 'chat'` provenance) is a distinct concern from session persistence/lifecycle and has not been built — see the Pending Tasks Backlog (§16).

---

## 9. Local Language Model Integration Requirements (Copilot & Claude Code)

Objective: Provide a safe, user-consented way for AutoDE to use a language model a user already has installed locally — **GitHub Copilot** (via the VS Code Language Model API, `vscode.lm`) or **Claude Code** (the `claude` CLI) — with no API key.

> Dispatch note (Phase C, v0.9.0): both providers below, plus the 5 API-key providers, are now registered in one place — `src/core/llmProviders.ts` (`LLM_ADAPTERS`) — behind a shared `LlmAdapter` interface. See requirements around Topic 1 of the architecture review (LLM provider extensibility) and `technical-design.md` §6.0. This section describes provider *behavior*; the dispatch mechanism moved out of `agentHub.ts`.

Two adapters, selected by `activeLlmProvider`:
- `copilot` → `LanguageModelAdapter` (`src/core/languageModelAdapter.ts`) → `vscode.lm.selectChatModels({ vendor: 'copilot' })`. `src/core/copilotAdapter.ts` is a re-export shim; `CopilotAdapter` is a back-compat alias.
- `claude` → `ClaudeCodeAdapter` (`src/core/claudeCodeAdapter.ts`) → spawns the **Claude Code CLI** headless (`claude -p --output-format json`). This deliberately does **not** use `vscode.lm` — the Claude Code extension registers no LM provider, and `vscode.lm`'s "Claude" models are GitHub Copilot's, which is what we want to avoid routing through.

CLI discovery for `claude` (`ClaudeCodeAdapter.resolve()`), in order:
1. the `autoDataEngineeringHub.claudeCodePath` setting;
2. `claude` / `claude.exe` on `PATH`;
3. the binary bundled with the installed `Anthropic.claude-code` extension (`resources/native-binary/claude(.exe)`).
Not found → a clear, actionable error (no silent fallback to Copilot).

Functional modes:
1. Detect & Surface:
   - `copilot`: detect the Copilot Chat extension by known IDs; list models via `vscode.lm`.
   - `claude`: resolve the CLI and probe `--version`.
   - Post `languageModelInfo` (and, for back-compat, `copilotInfo`) into the webview settings payload. For `claude` it carries `provider`, `found`, `hasAccess`, `cliSource`, `cliPath`, `version`, `error`.
   - Show a per-provider status indicator and an opt-in checkbox in LLM Settings ("Allow programmatic use"). The checkbox writes `languageModelProgrammaticConsent` and applies to both providers. The Claude card also has an optional CLI-path field.
   - Selecting an LLM card auto-saves `activeLlmProvider` and re-detects, so the header provider pill always reflects the current choice (contextualised: "Copilot" / "Claude Code" / …).
   - `testLanguageModel` accepts an optional provider argument so each card's **Test** button tests *its own* provider (not just whichever is active); `listLanguageModels` enumerates every `vscode.lm` model **and** reports where the Claude Code CLI resolves from.

2. Programmatic Adapters:
   - `LanguageModelAdapter`: `detect()`, `complete()`, `testCall()`; timeboxed via `Promise.race`; system prompt as a leading Assistant message.
   - `ClaudeCodeAdapter`: `resolve()` / `detect()` / `complete(prompt, { systemPrompt, model, allowTools, timeoutMs, cwd })` / `testCall()`. Prompt piped on **stdin**; system prompt via `--append-system-prompt`; `--model` only when the configured model looks like a Claude model. Timeboxed (90s no-tools / 180s with tools) with the subprocess killed on timeout or cancellation.
   - Tool policy: orchestrator/JSON calls run with **no tools** (`--tools "" --max-turns 1`). Grounded chat passes `allowTools` → `--tools Read Grep Glob --permission-mode default`, run in the workspace root so Claude Code can inspect the repo. No write/exec tools are ever enabled.
   - Both providers are gated on `languageModelProgrammaticConsent` (legacy `copilotProgrammaticConsent` honored as a fallback).

3. UI Handoff Fallback (Copilot only):
   - If the user declines consent, seed an untitled editor with a prompt and trigger inline suggestions. (Not applicable to `claude`.)

Security & Privacy:
- Programmatic use of either local model must be opt-in.
- Document what workspace content may be sent. The Claude Code subprocess runs with read-only tools at most, and never write/exec tools.
- Do not store provider tokens or secrets in logs or the repository. Claude Code auth is the user's own (managed by the Claude Code CLI/extension); AutoDE never handles it.
- Telemetry for language model usage must be opt-in and scrub PII.

Limitations & Risks:
- `claude` depends on a working Claude Code CLI + an authenticated session; detection must degrade gracefully with install/sign-in/`claudeCodePath` guidance.
- Shelling out to a subprocess: guard against hangs (timeouts + kill), large prompts (piped on stdin, not argv), and partial/garbled stdout (tolerant JSON parsing).
- The bundled-binary path is version-stamped in the extension folder name; resolution must not hard-code a version.

---

## 9a. Tool-Executing Skills (Phase D, v0.9.0)

Objective: let a user import a **Claude Agent Skill** (a `SKILL.md` manifest + optional bundled resources — the tool-oriented format used by Claude Code, structurally different from AutoDE's own interview-only `skills/*.json`) and run it with real tool access (read/write files, run commands), scoped to the current workspace.

**Status: implemented as a narrower, more conservative slice than originally scoped in the architecture discussion — read this section before assuming parity with that discussion.**

### 9a.1 Import

- `AutoDE: Import Tool Skill` command → folder picker → validates a `SKILL.md` is present → copies the folder into `.ai-context/skills/tool-skills/<id>/` (a subfolder of the existing interview-skill override directory, kept separate since these are a different concept) → parses it (`src/core/toolSkills.ts`, pure/filesystem-only, mirrors `skillRegistry.ts`'s loading pattern) and reports what was found.
- `SKILL.md` parsing is deliberately lenient (optional YAML frontmatter for `name`/`description`/`allowed-tools`, the Markdown body becomes the skill's instructions) — there is no official machine-checkable schema for this format, so the parser degrades gracefully rather than rejecting anything unexpected.
- `declaredTools` (from frontmatter) is **informational only** — it does not by itself grant tool access; the actual tool surface is capped by the execution mode below regardless of what a skill's own manifest claims to need.

### 9a.2 Execution — two paths, deliberately different in capability

Only `copilot` and `claude` support running a tool skill at all (the five API-key `fetch()` providers have no execution sandbox and this doesn't attempt to build one for them — attempting to run a skill on another provider fails with a clear error). Gated by the same consent flag as ordinary LLM calls (`languageModelProgrammaticConsent`), plus the approval dialog(s) below.

**`claude`** — routes to the Claude Code CLI's own tool loop (`ClaudeCodeAdapter`, `toolMode: 'full'`). AutoDE does not intercept individual tool calls; Claude Code runs its own multi-turn loop opaquely and returns a final result.
- The skill's instructions are injected via `--append-system-prompt` (a proven, tested flag) — **this is not native Claude Code plugin/skill loading via `--plugin-dir`**, which would require a plugin manifest format that isn't documented anywhere AutoDE could verify; guessing at it risked silently not working, so it was not attempted.
- Tool surface: `Read Grep Glob Edit Write Bash`, with `--permission-mode acceptEdits`. **Verified against the real CLI:** the default permission mode silently blocks Edit/Write in headless (`-p`) runs (no interactive session exists to answer the prompt) — `acceptEdits` was required and confirmed, end-to-end, to actually write a file. **Not verified:** Bash/command execution under `acceptEdits` — in local testing the model described a requested command as text rather than invoking the tool; treat command execution via this path as best-effort until observed working, not a guarantee.
- Approval: **one confirmation dialog for the whole run** ("Run skill X with file write and command execution access, scoped to this workspace?"), not per individual tool call. Claude Code does have its own permission-prompt callback mechanism (`--permission-prompts host` + an external tool, per its `--help`) but the callback's expected schema isn't documented anywhere accessible, so it isn't wired up — this is a **known, deliberate scope reduction** from true per-call approval on this path.
- Sandbox: Claude Code's tools operate relative to the `cwd` passed to the subprocess (the workspace root) — not independently hardened by AutoDE beyond that.

**`copilot`** — AutoDE owns a real multi-turn tool-calling loop, built on the documented `vscode.lm` tool-calling API (`LanguageModelChatRequestOptions.tools`, `LanguageModelToolCallPart` / `LanguageModelToolResultPart`, verified against the installed `@types/vscode` definitions before writing any code — not guessed). Four private tools (not registered via `vscode.lm.registerTool`, so not visible to other extensions): `autode_read_file`, `autode_list_dir`, `autode_write_file`, `autode_run_command`.
- Approval: **every** `autode_write_file` / `autode_run_command` call shows its own `vscode.window.showWarningMessage` confirmation before executing — true per-call approval, the thing the Claude path can't do.
- Sandbox: every path argument is resolved against the workspace root and rejected if it would escape it (`resolveSandboxedPath` in `ToolSkillAgent.ts`); `autode_run_command` runs via `child_process.exec` with `cwd` set to the workspace root (no independent process sandboxing beyond that — a sufficiently adversarial command run from an approved call could still, e.g., read files elsewhere on disk; approval is the operative control, not a hard OS-level jail).
- Audit: every tool call (name, input, outcome: `ok`/`approved`/`denied`/`error`) is logged and returned in the result's `details.audit`.
- **Not verified against a live Copilot session** — this environment has no way to run an actual VS Code host with Copilot attached; the loop's logic is correct against the documented API and compiles, but has not been observed running end-to-end the way the Claude path was.

### 9a.3 Invocation

- Chat: `/skill <skillId> <instruction>` (mirrors the existing `/spec`, `/plan` slash-command convention).
- Command: `AutoDE: Run Tool Skill` → quick-pick over imported skills → input box for the instruction.
- **Not** reachable from the auto-generated plan DAG: `toolSkillAgent` is a full `AGENT_EXECUTORS` entry (so an explicit run can execute it) but is deliberately **excluded** from `VALID_AGENT_TYPES` / the planner's prompt allow-list — the planning LLM has no visibility into which skills are imported and could otherwise hallucinate a `skillId`. A future "reference an imported skill inside a generated plan" feature would need a different mechanism (e.g., listing imported skills in the plan prompt) — not built.

### 9a.4 Deliberately not built (from the original architecture-review scope)

- Native Claude Code plugin/skill loading (`--plugin-dir`) — see 9a.2.
- Per-call approval on the Claude path — see 9a.2.
- A hard OS-level sandbox (container, restricted user, etc.) for either path — the sandbox is a path-prefix check plus, for Copilot, per-call approval; for Claude, whatever Claude Code's own tool implementations do.
- Any tool surface beyond read/write/exec (no network-restricted fetch tool, no code-execution-specific tool distinct from `autode_run_command`).
- Making an imported skill's own deterministic capability (if any) callable as a "tool" by the other 6 template agents, or vice versa — the two systems (deterministic `AGENT_EXECUTORS` vs. agentic tool-skill runs) remain separate, nested (one new agent slot runs a tool loop internally; the outer DAG loop is unchanged), not merged.

---

## 10. Acceptance Criteria & Tests

1. Zero UI Blocking Validation (Performance):
   - Index build of 1,000 tables / 10,000 columns / 50 business terms in the background via worker threads while user types — the editor must remain responsive (no stutters). Observe performance with a synthetic dataset and worker-based indexing command.

2. Atomic Write & Crash Resilience Test:
   - Simulate a crash mid-write during context-graph persistence and artifact writing; verify `.ai-context/derived/graph.json` and `.ai-context/artifacts/` files remain uncorrupted (atomic rename) and the engine boots from the previous snapshot.

3. Token Precision Test:
   - Request context with `maxTokens: 1500`. The returned prompt must be strictly within the token budget using js-tiktoken; tests must ensure that pruning doesn't cut code blocks or break JSON/Markdown syntax.

4. Local LLM Consent & Safety Test:
   - With `languageModelProgrammaticConsent` enabled and the active provider available (a Copilot `vscode.lm` model, or a resolvable Claude Code CLI), `testLanguageModel` returns a result and agentHub routes LLM calls through the matching adapter.
   - If the user declines consent, or the provider is unavailable (no Copilot model / no `claude` CLI found), programmatic calls are not made and the error names the fix; the Copilot handoff fallback still works for `copilot`.

5. Clean Extension Deactivation:
   - Deactivation must stop file watchers, terminate worker threads, dispose graphs, and release file handles within 200ms in normal conditions.

6. Unit & Integration Tests:
   - Envelope/schema validation (ajv) for each `kind` and layer.
   - Graph traversal correctness, serialization round-trip, and diagnostics.
   - SynthesisPipeline provenance tests (sourceRef/confidence/extractor present).
   - ArtifactWriter atomic-write tests.
   - ContextRetriever token-pruning tests (business rules survive pruning).

7. Generate Plan Validity & Governance Test (v0.10.0):
   - A malformed, non-array, or otherwise structurally invalid LLM plan response is rejected by `validatePlanResponse` with a specific, user-facing error — including a step assigned to an invalid agent, a duplicate step ID, a dangling or self-referential dependency, and (test added this pass) a multi-step circular dependency, which must be rejected at generation time rather than surfacing later as a "blocked DAG" during execution.
   - A plan step whose agent maps to a phase outside the specification's inferred required-phase set is rejected, not silently accepted.
   - Approving a specification must synchronize the Context Layer (`SynthesisPipeline.synthesizeFromSpec`) before `generatePlanFromSpec` becomes reachable; re-approving a later revision must replace, not duplicate, the prior version's derived context nodes.
   - A generated plan (steps, status, inferred phases, implementation type) must be recoverable after a simulated reload via `PlanManager`, with every prior version preserved in `plan/history/`.
   - Every approved specification must carry an `implementationType` of `greenfield` or `brownfield`, deterministically classified and independently user-overridable; the override must survive a subsequent spec revision.

---

## 11. Implementation Plan & Phasing

Phase 0 — Single-workspace model & artifacts
- ✅ Remove `ProjectManager`/`ProjectRegistry`; fold state into `.ai-context/state.json`.
- ✅ Add `autoDE.artifactDirectory` setting (default `.ai-context/artifacts`).
- ✅ Implement `ArtifactWriter` (artifacts → `.ai-context/artifacts/<phase>/`, atomic writes).

Phase 1 — Context envelope & schema
- ✅ Extend `src/context/types.ts` with the unified envelope (identity + provenance + version + ownership).
- ✅ Add per-kind JSON Schemas (`docs/schemas/context-envelope.schema.json`; `content` union deferred, `ajv` runtime wired in Phase 3 part 1 via `src/context/ContextValidator.ts`).

Phase 2 — Source registry & synthesis
- ✅ Implement `SourceRegistry` (`sources.yaml`) + the source-registration UI form.
- ✅ Implement `SynthesisPipeline` (rule-based extraction → derived nodes/edges with provenance; LLM-assisted extraction deferred).

Phase 2.5 — Business Problem Specification (spec-driven)
- ✅ BPS types + `SpecManager` (persistence, versioning, history archive, atomic writes).
- ✅ `AgentHub.generateSpec` (LLM drafting/revising with version semantics) + `parseSpecResponse`.
- ✅ Spec-aware chat routing (no-spec → draft, draft → revise, approved → grounded chat); `/spec` command.
- ✅ Review/approve UI: chat spec card + palette spec section.
- ✅ `AgentHub.generatePlanFromSpec` — spec-driven plan generation.
- ✅ Traceability: `specId`/`specVersion` on `PlanState`, `GeneratedArtifact`, `Origin`.
- ✅ Spec-driven **phase inference** + orchestration: deterministic `inferPhases()` (keyword evidence + `scope.out` exclusions + dependency chaining) in `src/core/phaseInference.ts`; `AgentHub.inferPhasesFromSpec`; plan prompt constrained to required phases; palette-as-live-status-view (completed / in-progress / blocked / pending / unrequired).

Phase 2.6 — Agentic Specification Generation (SpecOps)
- ✅ Skills registry: `skills/*.json` + `src/core/skillRegistry.ts` (bundled + `.ai-context/skills/` overrides).
- ✅ `SpecOpsEngine` state machine + prompt-schema action validation (`src/core/specOps.ts`).
- ✅ Adaptive questioning: `AgentHub.discoverNextAction` + chat-bubble questions + dynamic batch intake forms (`specQuestions` / `submitSpecAnswers`).
- ✅ Comprehensive v2 synthesis (`src/core/specSynthesis.ts` + `AgentHub.synthesizeComprehensiveSpec`) with provenance, persisted by `SpecManager` and rendered in the review card.

Phase 3 — Layered context loading
- ✅ Part 1 (v0.8.0): real YAML parser (`src/context/Yaml.ts` over the `yaml` library), AJV envelope validator (`src/context/ContextValidator.ts`), atomic compiled-graph persistence (`src/context/GraphPersistence.ts` → `derived/graph.json`).
- ✅ Part 2 (v0.8.0): `ContextFileManager` loads authoritative `context/**` (+ legacy-root fallback) and compiled `derived/graph.json` via `GraphPersistence` (legacy `schema-graph.json` fallback), with AJV envelope validation wired through `ContextValidator`; persists the compiled graph atomically; real `yaml` library replaces hand-rolled parsers in `SpecManager`, `SourceRegistry`, `TargetConfigManager` (legacy flat-format files still parse).

Phase 4 — Real data adapters
- Wire `snowflake-sdk` into `SnowflakeAdapter` (real connect/query); same for Databricks.
- Persist system metadata to `derived/system/`.

Phase 5 — Retrieval & embeddings
- Implement `ContextRetriever` (graph + token pruning; vector later).
- Implement `Vector Engine Worker` (embedded, no server).

Phase 6 — Local LLMs (Copilot & Claude Code), testing, telemetry, docs
- `vscode.lm` adapter for Copilot + Claude Code CLI adapter for `claude` (done) + consent modal in webview.
- Unit/integration tests for context layer and adapters.
- Opt-in telemetry + privacy docs.

Phase 7 — Architecture review follow-through (v0.9.0)
- ✅ **Phase A — Spec revision.** Approved specs are never edited in place; "↻ Revise" (and `/spec <change>` on an approved spec) starts a full agentic revision interview seeded with the approved spec, ending in a new draft `version+1`. Field-preservation safety net + provenance carry-forward in `parseComprehensiveSpec`. Supplementary information (registered sources + ad-hoc file attachment) wired into the interview. §8.6.1.
- ✅ **Phase B — Versioning & governance.** Git is the version/audit log (a "🕓 History" action, not a parallel version store); `ArtifactWriter` stamps every artifact's folder with `<specId>.v<version>`; the palette flags artifact sets superseded by a newer approved spec. §8.7, §7.
- ✅ **Phase C — LLM adapter registry.** `callConfiguredLlm`'s if/else chain + the stale, disconnected `LLM_PROVIDER_REGISTRY` replaced by one `LlmAdapter` registry (`src/core/llmProviders.ts`) — adding a provider is one class + one line, not an edited branch. UI/settings-schema deliberately left hand-authored (backend-only scope). `technical-design.md` §6.0.
- ✅ **Phase D — Tool-executing Skills**, scoped down from the original discussion (see §9a for exactly what and why): import via `SKILL.md`; Claude runs via its own CLI tool loop (one confirmation, not per-call; `--permission-mode acceptEdits` required and verified against the real CLI; Bash execution unverified); Copilot runs via a real, AutoDE-owned `vscode.lm` tool-calling loop (true per-call approval + audit log; logic verified, not exercised against a live Copilot session). Not native Claude Code plugin loading; not per-call approval on the Claude path; not a hard OS sandbox on either path.

Phase 8 — Usability follow-through (v0.9.0)
- ✅ **Phase E — Processing feedback.** A single evolving "pending" chat bubble (spinner + context-derived opening line) replaces static append-only log lines for every chat-initiated request; send is disabled while a request is in flight. §2.
- ✅ **Phase F — Chat sessions & lifecycle.** `ChatSessionManager` persists chat as first-class, BPS-identity-independent sessions (`.ai-context/chats/`, gitignored); "🗨 New Chat" archives (never silently discards) the current session, folding any in-flight interview's partial answers into the Context Layer first; `AutoDE: Chat History` / `AutoDE: Discard Chat` (Command Palette, user-initiated) round out the lifecycle. §8a.
- ⏳ **Phase G — Context Memory curation** ("distill this chat" into graph nodes with `origin.source: 'chat'`) — deferred, not started. See §16.

---

## 12. Security, Privacy & Licensing

- Any content sent to third-party LLMs (Copilot or cloud) must be user-consented.
- No secrets should be logged or stored in source control.
- Make privacy and data-flow explicit in README and in the one-time consent dialog for Copilot.
- Review licensing on heavy native dependencies (e.g., hnswlib-node, ONNX runtimes) before shipping in VSIX. Provide clear optional-install or remote-hosted service options.

---

## 13. Dependencies & Packaging Considerations

- Embedding runtimes (Xenova/ONNX) and native vector indexes (hnswlib-node) add VSIX packaging complexity. Prefer a pure-JS fallback + optional native install; or a lightweight hosted embedding service for heavy workloads.
- Use `ajv` for JSON Schema validation (per-kind `content` schemas).
- Use `js-tiktoken` for token counting.
- Graph: use the in-memory `GraphManager` (dependency-free). If scale demands it, adopt **Kùzu** (embedded single-file graph DB) — no server.
- Avoid server dependencies (Postgres, Neo4j) and hosted vector DBs; keep the extension self-contained.

---

## 14. Files & Artifacts

- UI webviews: `media/sidebar.html`, `media/panel.html`, `media/editors/*.html`
- Context layer: `src/context/` — `types.ts`, `Yaml.ts` (real YAML parser), `ContextValidator.ts` (AJV envelope validation), `GraphPersistence.ts` (atomic graph snapshot I/O), `GraphManager.ts`, `ContextFileManager.ts`, `SourceRegistry.ts`, `SynthesisPipeline.ts`, `ArtifactWriter.ts`, `SpecManager.ts`
- Language model adapters: `src/core/languageModelAdapter.ts` (Copilot; `copilotAdapter.ts` = re-export shim) and `src/core/claudeCodeAdapter.ts` (Claude Code CLI)
- Webview providers: `src/core/webviewProvider.ts`, `src/core/panelProvider.ts`
- Agent hub: `src/core/agentHub.ts`
- Phase inference: `src/core/phaseInference.ts` (spec-driven inference + live phase status, pure module)
- Data adapters: `src/dqm/` — `BaseAdapter.ts`, `ConnectionManager.ts`, `adapters/*`
- Docs: `docs/requirements.md` (this file), `docs/technical-design.md`
- Runtime folder: `.ai-context/` — spec, context, plan, and generated artifacts (`.ai-context/artifacts/`) all live under one root (v0.10.0 — previously artifacts were a sibling `auto-de/` folder). Since v0.12.0, per-business-problem state (spec/plan/context/artifacts) nests under `.ai-context/problems/<id>/`, with `active-problem.json` and the shared source registry/Context Layer graph/chat sessions staying at the `.ai-context/` root — see §8.11.

---

## 15. Acceptance & Review Checklist

- [ ] UI: context section surfaces Enterprise Context Layer (layers, terms, rules, queries, relationships); source-file registration form present.
- [x] Webview: LLM settings show provider status (Copilot models / Claude Code CLI path+version) and consent checkbox; Test + Detect buttons present.
- [x] Envelope: unified metadata envelope (identity + provenance + version + ownership) implemented in `src/context/types.ts` (per-kind `content` union deferred).
- [x] GraphManager: in-memory graph with indexes, BFS traversal, serialization.
- [~] ContextFileManager: watcher + loading present; AJV envelope validation + real YAML parser + atomic graph persistence + layered (`context/**` + `derived/graph.json`) loading wired with `ContextValidator` (Phase 3 parts 1 & 2 ✅); per-kind AJV content schemas deferred.
- [x] SourceRegistry: `sources.yaml` read/write + UI form.
- [x] SynthesisPipeline: rule-based source ingestion → derived nodes/edges with provenance (LLM-assisted extraction deferred).
- [x] ArtifactWriter: artifacts persisted to `.ai-context/artifacts/<phase>/` (atomic writes).
- [x] Single-workspace model: `ProjectManager`/`ProjectRegistry` removed.
- [ ] ContextRetriever: token-aware prompt assembler.
- [ ] Vector/embedding engine (embedded, no server).
- [x] LanguageModelAdapter (`vscode.lm`, `copilot`) + ClaudeCodeAdapter (`claude -p`, `claude`); agentHub respects consent for both.
- [~] Documentation: this revision (BPS §8 fully documented).
- [x] BPS types + `SpecManager`: persistence/versioning/history + atomic writes.
- [x] `AgentHub.generateSpec` + `generatePlanFromSpec`: spec drafting/refining + spec-driven plan.
- [x] Spec-aware chat routing + `/spec` command + review/approve UI (chat card + palette).
- [x] Spec-driven phase inference (palette as live status view): `inferPhases()` + `AgentHub.inferPhasesFromSpec` + phase-constrained plan prompt + live phase rows.
- [x] Agentic spec generation: `skills/` registry + `SpecOpsEngine` state machine + adaptive questioning (chat bubbles + dynamic intake forms) + comprehensive v2 synthesis (`specSynthesis.ts`) with provenance, persisted and rendered in the review card.

---

## 16. Pending Tasks Backlog

> **Last updated:** 2026-09-13 (v0.9.0). Phases 0–3 of the implementation plan (§11) are complete, plus the Phase 7 architecture-review follow-through (A–D) and Phase 8 usability follow-through (E–F, §8a/§2).
> This section captures **all remaining work** with enough context (file pointers, current state,
> acceptance criteria) to be picked up independently without re-reading the whole codebase.
> Items are grouped by phase; within each group, order reflects suggested sequencing.

### 16.1 Phase 4 — Real Data Adapters

- **Wire `snowflake-sdk` into `SnowflakeAdapter`.**
  - *Files:* `src/dqm/adapters/SnowflakeAdapter.ts` (`connect()`, `executeQuery()`), `src/dqm/BaseAdapter.ts`.
  - *Current state:* `connect()` builds connection params but never opens a real connection; `executeQuery()` returns empty results. The `snowflake-sdk` package is already a declared dependency (`package.json`) but not imported.
  - *What to do:* Import `snowflake-sdk`, implement real `connect()` (account/username/warehouse/database/schema/role + auth-mode handling — key-pair path, OAuth, password) and real `executeQuery()` (with timeout + cancellation). `extractMetadata()` should then return live tables/views.
  - *Acceptance:* `ConnectionManager.connect('snowflake', creds)` returns live `ConnectionInfo`; `extractMetadata({ includeProfiling })` returns real tables/views; `persistSchemaContext()` writes a valid `derived/system/snowflake.schema.yaml`.

- **Wire Databricks SDK into `DatabricksAdapter`.**
  - *Files:* `src/dqm/adapters/DatabricksAdapter.ts`.
  - *Current state:* `connect()` sets `this.conn` to a plain object but performs no real connection; query execution is stubbed.
  - *What to do:* Wire the Databricks SQL connector (workspace URL + token + catalog/schema) for real connect/query.
  - *Acceptance:* Real connect + query; live metadata extraction.

- **Persist system metadata to `derived/system/`.**
  - *Files:* `src/dqm/BaseAdapter.ts` (`persistSchemaContext()`).
  - *Current state:* Writes only to `.ai-context/schema-graph.json`.
  - *What to do:* Additionally persist platform metadata snapshots under `.ai-context/derived/system/<platform>.schema.yaml` (authoritative layering per requirements §3).

### 16.2 Phase 5 — Retrieval & Embeddings

- **Implement `ContextRetriever`.**
  - *Files:* new `src/context/ContextRetriever.ts`; consumed by `ContextFileManager.buildContextPrompt()` and `AgentHub`.
  - *Current state:* No `ContextRetriever` class exists. `buildContextPrompt()` in `ContextFileManager.ts` does a naive string concat with a rough `tokens = nodes * 50` estimate.
  - *What to do:* Build a token-aware prompt assembler that loads the compiled graph + business context and assembles a prompt within a `maxTokens` budget. Implement token pruning with the rule that **business rules (STRICT) survive pruning** (req §10.6). Use `js-tiktoken` for accurate counting.
  - *Acceptance:* `buildContextPrompt(maxTokens)` returns a prompt strictly within budget; pruning never drops a STRICT rule; token count is accurate.

- **Implement Vector Engine Worker.**
  - *Files:* new `src/context/VectorEngine.ts` (or worker).
  - *Current state:* No implementation. `GraphManager.isWorkerReady` is hardcoded `true`.
  - *What to do:* Embedded vector/embedding engine with **no server**. Pure-JS fallback (cosine similarity over JSON-stored embeddings keyed by node ID, written to `derived/embeddings/`); optional native accelerator. Keep the extension self-contained (requirements §13).
  - *Acceptance:* Nodes can be embedded and similarity-searched without an external service.

### 16.3 Phase 3b / 3c / 3d — Agents & Orchestrator Intelligence

- **Phase 3b — Enhanced Sub-Agents** (tech-design §10):
  - Data Lineage Mapper agent (`src/agents/legacy` → migrate to `src/agents/discover/`).
  - Data Quality Profiler agent.
  - *(DataModeler + TransformationScaffolder already done.)*

- **Phase 3c — New Sub-Agents:**
  - DDL Generator agent.
  - Orchestration Generator agent (Airflow/Dagster/Prefect).
  - SQL Validator agent.
  - Test Generator agent.
  - Business Glossary Builder agent.

- **Phase 3d — Orchestrator Intelligence:**
  - Context-aware action suggestions in chat.
  - Auto-invocation of sub-agents based on intent.
  - Plan diff & iteration.
  - First-run onboarding flow.
  - Results preview for executed SQL.
  - Export functionality (Markdown/YAML).

### 16.3a Source & Target Environment Context (v0.10.0)

Follow-up to R11 (`TargetConfigManager` orphaned) — clarified 2026-09-14 that the original intent was broader than target-only configuration, then implemented the same day:

- **Target side** (platform/tool/modeling *choices*): `TargetConfigManager` (`.ai-context/target-environment.yaml`, profile inheritance) is now wired — instantiated in `extension.ts`, its active profile seeds `hub`'s target environment at activation; the ad-hoc `extractTargetFromMessage` LLM extraction is now only a fallback for a workspace with no persisted profile.
- **Source side** (*facts about what exists*, not choices): implemented as a tagged extension of the existing Context Layer rather than a parallel store, per the decision below. `Origin.environment?: 'source' | 'target'` (`src/context/types.ts`) marks a node as environment-specific; nodes with no tag (e.g. spec-derived objectives/constraints) apply regardless. Tagged `'source'` automatically: live schema introspection (`BaseAdapter.snapshotToGraph` — tables/columns/views from `sourceAssessmentAgent`/`ConnectionManager`) and registered-source-derived nodes (`SynthesisPipeline`'s business-context/verified-queries/data-definitions extractors — the last of these is already the "data contract" ingestion path for push-style integrations with no direct connectivity). `ContextFileManager.getContextStats().sourceEnvironmentNodes` exposes the count; the sidebar's Context Drawer shows a "Source Environment Context" note, marked Non-Applicable for Greenfield (reusing the phase-applicability pattern, not a second one).
- **Decisions made (2026-09-14):** tag the existing Context Layer rather than build a separate manager (reuse over parallel infrastructure); wire `TargetConfigManager` in the same pass rather than defer it; registering source context for Brownfield is an **optional enrichment**, not a blocking gate before Generate Plan (consistent with the earlier decision against a plan-approval gate).
- **Still open / not yet built:** no UI to switch or edit target profiles (dev/staging/prod) — `target-environment.yaml` is currently file-edit-only. `SchemaSnapshot.lineage` (extracted by `sourceAssessmentAgent`, logged) is not yet converted into graph `derives_from` edges — lineage data is discarded after logging rather than persisted. Data-pull vs. data-push is implicit (whichever `SourceRegistry` kind or live connection the user actually uses) rather than an explicit, modeled distinction.

### 16.4 Phase 6 — Local LLMs (Copilot & Claude Code), Testing, Telemetry, Docs

- **Language model consent modal.**
  - *Files:* `media/sidebar.html`, `src/core/webviewProvider.ts`.
  - *Current state:* Only an opt-in toggle (`languageModelProgrammaticConsent`, legacy `copilotProgrammaticConsent`) in LLM Settings; no modal/dialog.
  - *What to do:* Add a one-time consent modal when the user first enables programmatic use of a local LLM (Copilot or Claude Code) — requirements §9.

- **Opt-in telemetry implementation + privacy docs.**
  - *Files:* config flag `autoDataEngineeringHub.telemetryEnabled` exists (`package.json`, default `false`); no telemetry code.
  - *Current state:* Flag is read but nothing reports.
  - *What to do:* Implement opt-in telemetry (respect the flag) + a privacy/data-flow note in README.

- **`deactivate()` cleanup.**
  - *Files:* `src/extension.ts:181`.
  - *Current state:* `deactivate()` is `// Intentionally empty`.
  - *What to do:* Stop file watchers, dispose `GraphManager`/`ContextFileManager`/`SourceRegistry`/`SynthesisPipeline`/`SpecManager`/`TargetConfigManager`, terminate workers, release handles within 200ms (req §10.6 #5).

- **Unit & integration tests** (req §10.6). 52 functional tests exist today (`test/functional.test.cjs`). Missing coverage:
  - GraphManager traversal correctness + serialization round-trip + diagnostics.
  - SynthesisPipeline provenance (`sourceRef`/`confidence`/`extractor` present).
  - ArtifactWriter atomic-write tests.
  - SpecManager versioning/history.
  - ContextRetriever token-pruning (business rules survive).
  - Adapter connect/query (Snowflake/Databricks).
  - AJV per-kind/per-layer validation (see 16.6).

### 16.5 Deferred SpecOps Polish

- **Intake-session persistence.**
  - *Files:* `src/core/specOps.ts` (`SpecOpsEngine`), new `.ai-context/spec/intake.yaml`.
  - *Current state:* Intake session state (questions, answers, coverage, and — since the revision fix (§8.6.1) — `previousSpec`/`changeRequest`/`attachments`) is in-memory only; lost on reload. This now affects revision interviews too, not just the original discovery flow.
  - *What to do:* Persist to `.ai-context/spec/intake.yaml` so a conversation survives reload/resume.

- **Revision emergency-fallback loses v2 fields.**
  - *Files:* `src/core/webviewProvider.ts` (`synthesizeFromSession` catch block), `src/core/agentHub.ts` (`generateSpec`/`parseSpecResponse`).
  - *Current state:* If the comprehensive-synthesis LLM call throws, the fallback re-drafts via the older v1-only `generateSpec`, which doesn't know about `dataFlows`/`businessRequirements`/etc. — those are dropped in this (rare, error-path-only) case even though the primary revision path preserves them.
  - *What to do:* Either give `parseSpecResponse` the same previous-value fallback treatment as `parseComprehensiveSpec`, or retry the comprehensive path before falling back to v1.

- **Skills authoring guidance.**
  - *Files:* `skills/*.json` (bundled), `.ai-context/skills/` (user overrides).
  - *Current state:* No docs on how to author/override skills.
  - *What to do:* Document the skill JSON schema + override mechanism.

### 16.7 Phase G — Context Memory Curation (not started)

- **"Distill this chat" → Context Memory.**
  - *Files:* new work in `src/context/SynthesisPipeline.ts` (new `chat_history` source kind), `src/context/ChatSessionManager.ts` (read-only consumer), `media/sidebar.html`/`webviewProvider.ts` (new user-initiated action).
  - *Current state:* Phase F persists full conversation transcripts (§8a) but has no curation layer on top — a transcript is either kept whole or discarded whole. The interview-carryover path (`carryOverPartialInterview`) is a narrow, automatic special case (partial spec-intake answers only), not a general mechanism.
  - *What to do:* A user-initiated "Distill this chat" action that runs an LLM extraction pass over a chosen transcript and writes graph nodes/edges tagged `origin.source: 'chat'` (plus `sourceRef` back to the chat id) into the derived context graph, following the existing `SynthesisPipeline` provenance conventions.
  - *Acceptance:* Distilling a transcript with clear factual statements produces graph nodes with correct provenance; distilling an empty/trivial transcript produces nothing (no hallucinated nodes).

- **Fuller in-sidebar chat browser** (optional follow-up, explicitly scoped out of Phase F).
  - *Files:* `media/sidebar.html` (client-side rendering only — `webviewProvider.ts` already posts `chatSessionsList`/`chatSessionViewed` and handles `listChatSessions`/`openChatSession`, unused by any UI yet).
  - *Current state:* Chat History/Discard are Command-Palette-only (§8a.4); per clarifying-question answer, this was accepted as sufficient for this pass ("User-initiated (Recommended)" did not require it to live in the sidebar).
  - *What to do, if picked up:* Render a session list/search/tag UI directly in the sidebar, wire it to the existing message types, and add reopen-into-active-chat + export/import.

### 16.6 Cross-cutting / Infrastructure

- **Per-kind AJV content schemas** (req §16 #6).
  - *Files:* `docs/schemas/context-envelope.schema.json` (has `definitions` for per-kind content), `src/context/ContextValidator.ts`.
  - *Current state:* Envelope-level validation is wired; the per-kind `content` union is deferred.
  - *What to do:* Add AJV schemas for each `kind` (table, column, business_term, business_rule, metric, verified_query, semantic_artifact) and validate `content` on load.

- **UI context section surfaces Enterprise Context Layer.**
  - *Files:* `media/sidebar.html`.
  - *Current state:* Context section exists but does not fully surface layers/terms/rules/queries/relationships read-only (checklist §15, first item, still `[ ]`).
  - *What to do:* Render the context layer read-only in the webview context section.

---

## 17. Contact & Notes

If any requirement appears to conflict with project packaging constraints (e.g., native binaries in VSIX), request a tradeoff decision between shipping a pure-JS fallback vs bundling native libs.

For clarifications or to request changes to this specification, please reply with comments or request a revision; the implementation plan will follow this spec and this document will be used as the acceptance source of truth.


---

(End of requirements document)
