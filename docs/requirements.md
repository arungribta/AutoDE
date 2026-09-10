# AutoDE — Requirements Specification

This document is the authoritative reference for AutoDE's design, implementation, QA, and acceptance criteria. It covers: UI/UX, the Enterprise Context Layer (information architecture), the single-workspace artifact model, and GitHub Copilot integration.

Last updated: 2026-09-09
Author: AutoDE Engineering

---

## 1. Overview & Goals

AutoDE is an AI-augmented VS Code extension for Data Engineering. Key functions:
- Provide a focused DE Agent Workspace webview (single-column, tabbed) as the primary UX for planning, executing, and refining data engineering pipelines.
- Transform a natural-language business problem into a structured, reviewable, versioned **Business Problem Specification (BPS)** — the system of record that governs all subsequent activity.
- Provide an **Enterprise Context Layer** — a persistent, evolving semantic understanding of the user's data environment stored in `.ai-context/` (used to ground prompts and LLM guidance).
- Generate data-engineering artifacts (DDL, dbt models, mappings, docs) into a visible, configurable folder (`auto-de/`) in the user's current repository.
- Offer optional integration with GitHub Copilot such that a user who already has Copilot can opt-in to programmatically route some LLM tasks to the installed Copilot extension.

Primary non-functional requirements:
- Zero UI blocking (offload heavy compute to worker threads / web workers).
- Strict type-safety, lifecycle / disposal, and atomic file operations for `.ai-context/` and `auto-de/` artifacts.
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
- Provide UI elements to configure/choose LLM provider and model, and show Copilot status and consent options in the LLM tab (see Copilot integration section).
- Provide a "Context" section that surfaces the Enterprise Context Layer (layers, business terms, rules, verified queries, relationships) read-only from `.ai-context/`.
- Provide a "register source files" form so users can identify which repository files contain business context, verified queries, and data definitions.

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
- **Generated artifacts** (DDL, dbt models, mappings, docs) are written to a **visible, configurable folder** `auto-de/` (setting `autoDE.artifactDirectory`), organized by phase:

  ```text
  auto-de/01-discover/
  auto-de/02-model/
  auto-de/03-build/
  auto-de/04-validate/
  ```

- **Artifacts are committed to git** — they are deliverables, not transient state.
- **Artifact writes are atomic** (temp staging → rename).
- **Separating efforts** = git branches, not a project registry.

Core module: ArtifactWriter (`src/context/ArtifactWriter.ts`) — persists a `GeneratedArtifact` → `auto-de/<phase>/<filename>`.

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

- **No spec exists** → the user's first message IS the business problem → AutoDE drafts a BPS.
- **Spec is a draft** → the user's next message refines it → the BPS is revised in place (same id/version).
- **Spec is approved** → the user's messages are answered conversationally, grounded in the BPS + repository context; a change request drafts a new revision (same id, version + 1).

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
- `AgentHub.generatePlanFromSpec(spec)` — spec-driven plan generation.
- Traceability: `specId`/`specVersion` on `PlanState`, `GeneratedArtifact`, `Origin`.

### 8.6 Agentic Specification Generation (SpecOps)

The draft BPS is produced by an **agentic, DE-tailored requirements flow** (Superpowers-inspired) rather than a single-shot prompt:

- **Skills** — `skills/*.json` define composable DE skills (Requirements Discovery, Source Catalog, Data Flow, Transformations, Quality & Acceptance, Constraints & Assumptions, Synthesis); `SkillRegistry` loads bundled skills plus optional `.ai-context/skills/` overrides.
- **Adaptive questioning** — `SpecOpsEngine` drives a `discovery → synthesizing → draft → refining → approved` state machine with per-field coverage and a turn budget; each turn the LLM returns a validated action (`ask` / `ask_many` / `synthesize` / `done`). Single questions render as chat bubbles; batches render as a dynamic multi-field intake form.
- **Comprehensive synthesis** — `AgentHub.synthesizeComprehensiveSpec` assembles the v2 spec (businessRequirements, dataFlows, transformations, dependencies, acceptanceCriteria, implementationConsiderations, sourceCatalog) with per-field provenance, persisted by `SpecManager`.

---

## 9. Copilot Integration Requirements

Objective: Provide a safe, user-consented way for AutoDE to use the GitHub Copilot extension a user may already have installed.

Functional modes:
1. Detect & Surface (Phase 0):
   - Detect Copilot by searching known extension IDs (`github.copilot`, `GitHub.copilot`, `github.copilot-nightly`, `github.copilot-enterprise`).
   - Post `copilotInfo` into the webview settings payload (found, isActive, hasExports, exportsKeys).
   - Show a Copilot status indicator and an opt-in checkbox in LLM Settings: "Allow programmatic use of local Copilot (opt-in)".
   - Provide a "Test Copilot" button that invokes a safe, best-effort test call via the adapter.

2. Programmatic Adapter (Phase 1):
   - If the Copilot extension exports a callable API (detected at runtime), expose a thin adapter `CopilotAdapter` that normalizes `complete(prompt, opts)` and `testCall()`.
   - Adapter calls must be:
     - Best-effort only (never assume stability of internals)
     - Timeboxed (configurable default timeout, e.g., 15s)
     - Respect cancellation tokens
   - Only enable programmatic Copilot usage when the user has explicitly given consent via the LLM settings toggle (`copilotProgrammaticConsent`).

3. UI Handoff Fallback (Phase 2):
   - If no programmatic API exists or user declines consent, provide a non-programmatic handoff flow: seed an untitled editor with a prompt and trigger inline suggestions such that the user can accept suggestions interactively.

Security & Privacy:
- Programmatic Copilot usage must be opt-in.
- Document exactly what workspace content may be sent to Copilot in the consent modal. Obtain explicit one-time consent before sending content.
- Do not store Copilot tokens or secrets in logs or repository.
- Telemetry for Copilot usage must be opt-in and scrub PII.

Limitations & Risks:
- Copilot extension exports are not a documented stable API — this is a brittle integration and needs defensive coding and fallbacks.
- Rely on best-effort detection and never attempt to use internal or private extension internals.

---

## 10. Acceptance Criteria & Tests

1. Zero UI Blocking Validation (Performance):
   - Index build of 1,000 tables / 10,000 columns / 50 business terms in the background via worker threads while user types — the editor must remain responsive (no stutters). Observe performance with a synthetic dataset and worker-based indexing command.

2. Atomic Write & Crash Resilience Test:
   - Simulate a crash mid-write during context-graph persistence and artifact writing; verify `.ai-context/derived/graph.json` and `auto-de/` files remain uncorrupted (atomic rename) and the engine boots from the previous snapshot.

3. Token Precision Test:
   - Request context with `maxTokens: 1500`. The returned prompt must be strictly within the token budget using js-tiktoken; tests must ensure that pruning doesn't cut code blocks or break JSON/Markdown syntax.

4. Copilot Consent & Safety Test:
   - When user enables programmatic Copilot usage and Copilot exports are available, calling `testCopilot` returns a result and agentHub will route LLM calls to the adapter.
   - If user declines consent or adapter is not available, programmatic calls are not made; fallback handoff works.

5. Clean Extension Deactivation:
   - Deactivation must stop file watchers, terminate worker threads, dispose graphs, and release file handles within 200ms in normal conditions.

6. Unit & Integration Tests:
   - Envelope/schema validation (ajv) for each `kind` and layer.
   - Graph traversal correctness, serialization round-trip, and diagnostics.
   - SynthesisPipeline provenance tests (sourceRef/confidence/extractor present).
   - ArtifactWriter atomic-write tests.
   - ContextRetriever token-pruning tests (business rules survive pruning).

---

## 11. Implementation Plan & Phasing

Phase 0 — Single-workspace model & artifacts
- ✅ Remove `ProjectManager`/`ProjectRegistry`; fold state into `.ai-context/state.json`.
- ✅ Add `autoDE.artifactDirectory` setting (default `auto-de`).
- ✅ Implement `ArtifactWriter` (artifacts → `auto-de/<phase>/`, atomic writes).

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

Phase 6 — Copilot, testing, telemetry, docs
- Copilot `vscode.lm` adapter (done) + consent modal in webview.
- Unit/integration tests for context layer and adapters.
- Opt-in telemetry + privacy docs.

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
- Copilot adapter: `src/core/copilotAdapter.ts`
- Webview providers: `src/core/webviewProvider.ts`, `src/core/panelProvider.ts`
- Agent hub: `src/core/agentHub.ts`
- Phase inference: `src/core/phaseInference.ts` (spec-driven inference + live phase status, pure module)
- Data adapters: `src/dqm/` — `BaseAdapter.ts`, `ConnectionManager.ts`, `adapters/*`
- Docs: `docs/requirements.md` (this file), `docs/technical-design.md`
- Runtime folders: `.ai-context/` (context layer), `auto-de/` (generated artifacts)

---

## 15. Acceptance & Review Checklist

- [ ] UI: context section surfaces Enterprise Context Layer (layers, terms, rules, queries, relationships); source-file registration form present.
- [x] Webview: LLM settings show Copilot status and consent checkbox; test button present.
- [x] Envelope: unified metadata envelope (identity + provenance + version + ownership) implemented in `src/context/types.ts` (per-kind `content` union deferred).
- [x] GraphManager: in-memory graph with indexes, BFS traversal, serialization.
- [~] ContextFileManager: watcher + loading present; AJV envelope validation + real YAML parser + atomic graph persistence + layered (`context/**` + `derived/graph.json`) loading wired with `ContextValidator` (Phase 3 parts 1 & 2 ✅); per-kind AJV content schemas deferred.
- [x] SourceRegistry: `sources.yaml` read/write + UI form.
- [x] SynthesisPipeline: rule-based source ingestion → derived nodes/edges with provenance (LLM-assisted extraction deferred).
- [x] ArtifactWriter: artifacts persisted to `auto-de/<phase>/` (atomic writes).
- [x] Single-workspace model: `ProjectManager`/`ProjectRegistry` removed.
- [ ] ContextRetriever: token-aware prompt assembler.
- [ ] Vector/embedding engine (embedded, no server).
- [x] CopilotAdapter: `vscode.lm` detection + adapter; agentHub respects consent.
- [~] Documentation: this revision (BPS §8 fully documented).
- [x] BPS types + `SpecManager`: persistence/versioning/history + atomic writes.
- [x] `AgentHub.generateSpec` + `generatePlanFromSpec`: spec drafting/refining + spec-driven plan.
- [x] Spec-aware chat routing + `/spec` command + review/approve UI (chat card + palette).
- [x] Spec-driven phase inference (palette as live status view): `inferPhases()` + `AgentHub.inferPhasesFromSpec` + phase-constrained plan prompt + live phase rows.
- [x] Agentic spec generation: `skills/` registry + `SpecOpsEngine` state machine + adaptive questioning (chat bubbles + dynamic intake forms) + comprehensive v2 synthesis (`specSynthesis.ts`) with provenance, persisted and rendered in the review card.

---

## 16. Pending Tasks Backlog

> **Last updated:** 2026-09-09 (v0.8.0). Phases 0–3 of the implementation plan (§11) are complete.
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

### 16.4 Phase 6 — Copilot, Testing, Telemetry, Docs

- **Copilot consent modal.**
  - *Files:* `media/sidebar.html`, `src/core/webviewProvider.ts`.
  - *Current state:* Only an opt-in toggle (`copilotProgrammaticConsent`) in LLM Settings; no modal/dialog.
  - *What to do:* Add a one-time consent modal when the user first enables programmatic Copilot (requirements §9).

- **Opt-in telemetry implementation + privacy docs.**
  - *Files:* config flag `autoDataEngineeringHub.telemetryEnabled` exists (`package.json`, default `false`); no telemetry code.
  - *Current state:* Flag is read but nothing reports.
  - *What to do:* Implement opt-in telemetry (respect the flag) + a privacy/data-flow note in README.

- **`deactivate()` cleanup.**
  - *Files:* `src/extension.ts:181`.
  - *Current state:* `deactivate()` is `// Intentionally empty`.
  - *What to do:* Stop file watchers, dispose `GraphManager`/`ContextFileManager`/`SourceRegistry`/`SynthesisPipeline`/`SpecManager`/`TargetConfigManager`, terminate workers, release handles within 200ms (req §10.6 #5).

- **Unit & integration tests** (req §10.6). Only 34 functional tests exist today. Missing coverage:
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
  - *Current state:* Intake session state (questions, answers, coverage) is in-memory only; lost on reload.
  - *What to do:* Persist to `.ai-context/spec/intake.yaml` so a conversation survives reload/resume.

- **Skills authoring guidance.**
  - *Files:* `skills/*.json` (bundled), `.ai-context/skills/` (user overrides).
  - *Current state:* No docs on how to author/override skills.
  - *What to do:* Document the skill JSON schema + override mechanism.

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
