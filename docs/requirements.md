# AutoDE — Requirements Specification

This document collects the detailed, production-grade requirements for the AutoDE VS Code extension as discussed: UI design and UX polish, the Enterprise Context Layer (production-grade), and GitHub Copilot integration. Use this file as the authoritative reference for design, implementation, QA, and acceptance criteria.

Last updated: 2026-08-17T23:47:55-05:00
Author: AutoDE Engineering (captured by Copilot CLI runtime in VS Code)

---

## 1. Overview & Goals

AutoDE is an AI-augmented VS Code extension for Data Engineering. Key functions:
- Provide a focused DE Agent Workspace webview (single-column, tabbed) as the primary UX for planning, executing, and refining data engineering pipelines.
- Provide a production-grade, high-throughput Context Layer for local knowledge graph, vector search, and token-aware retrieval (used to ground prompts and LLM guidance).
- Offer optional integration with GitHub Copilot such that a user who already has Copilot can opt-in to programmatically route some LLM tasks to the installed Copilot extension.

Primary non-functional requirements:
- Zero UI blocking (offload heavy compute to worker threads / web workers).
- Strict type-safety, lifecycle / disposal, and atomic file operations for `.ai-context/` artifacts.
- Strong privacy and opt-in consent for any third-party LLM usage (Copilot or cloud providers).

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

Accessibility & polish:
- All controls accessible by keyboard and screen-reader friendly where practical.
- Use meaningful aria roles for tabs and tab panels.

Deliverables (UI):
- Updated webview HTML/CSS/JS with the polished layout (already present in `media/sidebar.html`).
- A short style guide describing color tokens and component rules.

---

## 3. Context Layer: Production Requirements (High-level)

Purpose: Provide robust, token-efficient, local context for the AutoDE agents. Must be suitable for enterprise usage (non-PoC).

Non-negotiable operational constraints:
1. Thread isolation: All heavy operations (embedding, graph traversal for large graphs, YAML/JSON parsing of large files) must run off the Extension Host main thread. Use Node `worker_threads` (or dedicated web workers for webview-hosted logic) with async IPC (MessageChannel / parentPort).
2. Atomic file IO: Writes to `.ai-context/` must use temporary staging and atomic renames (e.g., write to `schema-graph.tmp.<hash>` then rename to `schema-graph.json`). Use `vscode.workspace.fs` methods where possible.
3. Memory & lifecycle management: Graph and Vector Index must implement `vscode.Disposable`. Extension deactivation must dispose and free memory. Large indices may be evicted or persisted to disk when inactive.
4. Graceful degradation: If `.ai-context` files are corrupted, locked by Git, or partial, the engine should:
   - Log structured diagnostics
   - Fall back to partial context and continue with degraded functionality
   - Attempt automatic repair or recreate schema templates when safe
5. Token budgets & context hygiene: Use tokenizers (e.g., `js-tiktoken`) to compute token counts and strictly enforce budgets when assembling prompts. Prioritize content by relevance score and graph centrality.

Local workspace layout (`.ai-context/`):
- System state (generated):
  - `schema-graph.json` (primary serialized graph snapshot)
  - `schema-graph.schema.json` (JSON Schema)
- Human/team-curated (source-controlled):
  - `business-context.yaml`
  - `verified-queries.yaml`

A filesystem watcher + debounce handles updates and triggers re-indexing.

---

## 4. Context Layer: Type Definitions (production-grade)

(Implement in `src/context/types.ts`) — include strict readonly contracts and discriminated unions. Example core types (summary):
- NodeType: 'table' | 'column' | 'semantic_view' | 'business_term' | 'business_rule' | 'verified_query'
- EdgeType: 'contains' | 'foreign_key' | 'maps_to' | 'uses_table' | 'constrained_by'
- BaseNode (id, type, label, description?, metadata, version)
- TableNode extends BaseNode (database, schema, fqn, isView)
- ColumnNode, BusinessTermNode, BusinessRuleNode, VerifiedQueryNode (with dialect, tablesUsed, etc.)
- GraphEdge (id, source, target, type, weight?)
- RetrievalOptions (topKSeeds, maxHops, maxTokens, minScoreThreshold, includeVerifiedQueries)
- SubgraphResult (nodes, edges, formattedContext, tokenCount, latencyMs)
- ContextEngineDiagnostics (totalNodes, totalEdges, memoryUsageMB, isWorkerReady, lastIndexedAt)

Strict TypeScript and readonly where possible.

---

## 5. Core Modules & Responsibilities (src/context/)

Create modular components with clear runtime responsibilities and well-documented interfaces.

Module A — ContextFileManager (src/context/ContextFileManager.ts)
- FileSystemWatcher using `vscode.workspace.createFileSystemWatcher` with 300ms debounce.
- Atomic JSON validation against `schema-graph.schema.json` using `ajv` before loading.
- Atomic persistence via temp staging files and `vscode.workspace.fs.rename`.
- Structured diagnostic events and repair functions.

Module B — GraphManager (src/context/GraphManager.ts)
- Use `graphology` with a directed MultiGraph.
- Fast lookup indexes for FQN, label, and node type.
- Neighborhood traversal (personalized PageRank or seeded BFS) with decay factor:
  Relevance(seed → node) = SeedScore × (DecayFactor)^(HopDistance)
- Thread-safe serialization/deserialization for worker message passing.
- Explicit `dispose()` to free memory and close resources.

Module C — Vector Engine Worker (src/context/workers/vector.worker.ts)
- Run embedding runtime inside a `worker_threads` worker (Xenova or external embedding service).
- Use batched embeddings and streaming to prevent memory spikes.
- Load quantized vectors into an HNSW or other index (prefer `hnswlib-node` or a pure JS fallback for VSIX packaging).
- Provide IPC methods for `indexBatch`, `search`, `serializeIndex`, `loadIndex`.

Module D — ContextRetriever (src/context/ContextRetriever.ts)
- Combine vector search + subgraph traversal + token-budget pruning.
- Pruning policy hierarchy:
  1. Business Rules (STRICT bypass token limit when relevant)
  2. Direct Table/Column nodes
  3. BusinessTerm nodes
  4. VerifiedQuery nodes (pruned first under ceiling)
- Use `js-tiktoken` to compute token budgets and assemble the final formatted context.
- Return SubgraphResult with formatted Markdown and tokenCount.

Module E — Base DQM Adapter (src/dqm/BaseAdapter.ts)
- Abstract class for database metadata extraction and persistence.
- Provide `extractMetadata()` (with cancellation token) returning nodes and edges.
- Provide `persistSchemaContext()` implementing atomic write to `.ai-context/schema-graph.json` using staging and rename.

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

## 7. Copilot Integration Requirements

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

## 8. Acceptance Criteria & Tests

1. Zero UI Blocking Validation (Performance):
   - Index build of 1,000 tables / 10,000 columns / 50 business terms in the background via worker threads while user types — the editor must remain responsive (no stutters). Observe performance with a synthetic dataset and worker-based indexing command.

2. Atomic Write & Crash Resilience Test:
   - Simulate a crash or terminate VS Code mid write during `persistSchemaContext` and verify `.ai-context/schema-graph.json` remains uncorrupted (atomic rename semantics) and engine boots using previous snapshot.

3. Token Precision Test:
   - Request context with `maxTokens: 1500`. The returned prompt must be strictly within the token budget using js-tiktoken; tests must ensure that pruning doesn't cut code blocks or break JSON/Markdown syntax.

4. Copilot Consent & Safety Test:
   - When user enables programmatic Copilot usage and Copilot exports are available, calling `testCopilot` returns a result and agentHub will route LLM calls to the adapter.
   - If user declines consent or adapter is not available, programmatic calls are not made; fallback handoff works.

5. Clean Extension Deactivation:
   - Deactivation must stop file watchers, terminate worker threads, dispose graphs, and release file handles within 200ms in normal conditions.

6. Unit & Integration Tests:
   - Graph traversal correctness, serialization round-trip, and diagnostics.
   - ContextRetriever token-pruning test cases (edge cases where business rules must survive pruning).
   - Atomic write tests for persistSchemaContext.

---

## 9. Implementation Plan & Phasing

Phase 0 — UI polish and LLM settings
- Finalize sidebar webview CSS and components. Drop excess frames and modernize top strip.
- Add Copilot status & consent UI in LLM tab.
- Add `autoDE.testCopilot` command to test adapter.

Phase 1 — Context Layer core
- Add `src/context/types.ts` (strict types).
- Implement `GraphManager.ts` (graphology MultiGraph, indexes, BFS/pagerank relevance).
- Implement `ContextFileManager.ts` (watcher, AJV validation, atomic persistence helpers).

Phase 2 — Worker offload & Vector engine
- Implement `src/context/workers/vector.worker.ts` using `worker_threads`.
- Choose embedding runtime: hosted vs local Xenova/ONNX; evaluate packaging constraints for VSIX.
- Implement similarity index (HNSW or fallback). Implement batched indexing.

Phase 3 — ContextRetriever & prompt assembler
- Implement hybrid retriever combining vector search + graph traversal + token pruning.
- Implement prompt formatting to compact Markdown with token-safety.

Phase 4 — DQM Base Adapter & Snowflake adapter
- Implement `src/dqm/BaseAdapter.ts` with atomic persistSchemaContext.
- Wire Snowflake metadata extraction to the BaseAdapter and persist to `.ai-context`.

Phase 5 — Copilot programmatic adapter & wiring
- Implement `src/core/copilotAdapter.ts` (detect, adapt exported functions, timeouts).
- Wire `agentHub.callConfiguredLlm()` to prefer local Copilot when selected and consented.
- Add fallback handoff flow.

Phase 6 — Testing, telemetry opt-in, and docs
- Implement tests for acceptance criteria.
- Add opt-in telemetry and documentation about privacy.

---

## 10. Security, Privacy & Licensing

- Any content sent to third-party LLMs (Copilot or cloud) must be user-consented.
- No secrets should be logged or stored in source control.
- Make privacy and data-flow explicit in README and in the one-time consent dialog for Copilot.
- Review licensing on heavy native dependencies (e.g., hnswlib-node, ONNX runtimes) before shipping in VSIX. Provide clear optional-install or remote-hosted service options.

---

## 11. Dependencies & Packaging Considerations

- Worker-thread embedding runtimes (Xenova/ONNX) and native indexes (hnswlib-node) add packaging complexity for VSIX. Options:
  - Bundle a pure-JS fallback (lower perf) + optional native install for power users.
  - Use a lightweight remote embedding service (self-hosted or cloud) for heavy workloads.
- Use ajv for JSON Schema validation.
- Use graphology for graph engine.
- Use js-tiktoken for token counting.

---

## 12. Files & Artifacts (current state & where to add)

- UI webview: `media/sidebar.html` (updated for modernized UI and Copilot consent controls)
- Context types: `src/context/types.ts`
- Graph manager: `src/context/GraphManager.ts`
- Copilot adapter: `src/core/copilotAdapter.ts` (detect & adapter)
- Webview provider: `src/core/webviewProvider.ts` (posts copilotInfo)
- Agent hub: `src/core/agentHub.ts` (attempts to route to local Copilot when consented)
- New docs: `docs/requirements.md` (this file)

---

## 13. Acceptance & Review Checklist

- [ ] UI: Top strip cleaned; "Panel" removed from table names; modern aesthetics applied.
- [ ] Webview: LLM settings show Copilot status and consent checkbox; test button present.
- [ ] Context Layer types implemented and exported.
- [ ] GraphManager: concurrent-safe, serializable snapshot methods, traversal with decay scoring implemented.
- [ ] ContextFileManager: atomic writes and AJV validation implemented.
- [ ] Vector worker scaffolding in place (batched embedding interface).
- [ ] ContextRetriever: token-aware prompt assembler implemented and tested.
- [ ] CopilotAdapter: detection and safe programmatic adapter present; agentHub respects user consent.
- [ ] Documentation: README and this requirements doc updated.

---

## 14. Next Steps (recommended immediate actions)

1. Finalize Context types and GraphManager unit tests (priority).
2. Implement ContextFileManager atomic write tests (simulate abrupt termination).
3. Add worker scaffolding and a debug command to populate a synthetic large graph to validate non-blocking behavior and memory usage.
4. Surface Copilot consent modal in the webview (one-time consent text) and record choice in configuration.
5. Choose embedding runtime strategy (local Xenova vs hosted) and document packaging implications.

---

## 15. Contact & Notes

If any requirement appears to conflict with project packaging constraints (e.g., native binaries in VSIX), request a tradeoff decision between shipping a pure-JS fallback vs bundling native libs.

For clarifications or to request changes to this specification, please reply with comments or request a revision; the implementation plan will follow this spec and this document will be used as the acceptance source of truth.


---

(End of requirements document)
