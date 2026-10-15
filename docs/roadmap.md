# AutoDE roadmap

**The single place for order and status.** Specifications say *what* each phase delivers and *why*; this document says *when*, and whether it's done. If another document's plan disagrees with this one, this one wins. Document map: [README.md](README.md).

Last updated: 2026-10-15 · Current version: **0.30.0** · Branch: `feature/engine-boundary`

---

## 1. Phases

Each row is one minor version, implemented in this order. ✅ = shipped (see [CHANGELOG.md](../CHANGELOG.md) for what changed and any deviations).

| Version | Phase | Specified in | Why here |
|---|---|---|---|
| v0.25.0 | ✅ **1** Spec state synchronization | [mcp-engine §8](mcp-engine-requirements.md) | Live bug; prerequisite for any second writer of `.ai-context/`. |
| v0.26.0 | ✅ **2** Engine boundary and context store | [mcp-engine §4](mcp-engine-requirements.md) | Everything after this builds in `src/engine/`. |
| v0.27.0 | ✅ **C1** Reference problem, eval harness, baseline | [context-layer §10, §11](context-layer-requirements.md) | Measures the baseline *before* the context layer changes. |
| v0.28.0 | ✅ **S1** Tool skills on every provider + `allowed-tools` | [mcp-engine §9.1](mcp-engine-requirements.md) | Security prerequisite for exposing skills. |
| v0.29.0 | ✅ **C2** Assertion ledger and projection | [context-layer §4, §11](context-layer-requirements.md) | System of record for context. |
| v0.30.0 | ✅ **C3** Context packs, manifests, causality | [context-layer §7, §8.3, §11](context-layer-requirements.md) | Grounded delivery. |
| v0.31.0 | **K** Estate identity, per-system catalogs, working-set cache | [context-layer §11 Phase K](context-layer-requirements.md) | Estate merge and migration need several systems side by side and estates beyond the original size target; every later phase attaches facts to these ids. |
| v0.32.0 | **C4a** Business-problem pack, interpretation profiles, discover → validate → ask, probes, conformance report | [context-layer §11 Phase C4a](context-layer-requirements.md) | Builds the spec from the customer's own documents; probes no longer wait for the MCP track. |
| v0.33.0 | **S2** Tool-skill lifecycle, provenance, review, trust tiers | [mcp-engine §9.1](mcp-engine-requirements.md) | Must exist before any skill is exposed to external agents over MCP. |
| v0.34.0 | **3** MCP server: registry, spec, prompts, resources | [mcp-engine §5, §9](mcp-engine-requirements.md) | Also exposes `autode_resolve`, `autode_get_context_pack`, `autode_list_assertions`, `autode_check_grounding`. |
| v0.35.0 | **4** MCP server: data platform, sample-data consent and redaction | [mcp-engine §5.3, §6, §9](mcp-engine-requirements.md) | Moves C4a's probes behind `autode_execute_query`; prerequisite for driver acquisition. |
| v0.36.0 | **DRV** Opt-in native driver acquisition + platform-onboarding UI | [mcp-engine §9.1](mcp-engine-requirements.md) | How legacy sources (Oracle, SQL Server …) get a live connection without breaking P6. |
| v0.37.0 | **C4b** Chat extraction, Context Inbox, tool-action memory | [context-layer §11 Phase C4b](context-layer-requirements.md) | Remaining context MCP tools; context gaps start pausing steps. |
| v0.38.0 | **GOV** Governance-as-code: `mask` primitive, sensitivity in specs, governance interview | [mcp-engine §9.1](mcp-engine-requirements.md) | Required by C5/C6 grounding checks and PII expectations. |
| v0.39.0 | **C5** Semantic model | [context-layer §6, §11](context-layer-requirements.md) | Built on confirmed/verified assertions; also carries the merge semantics (correspondence, survivorship, conformed dimensions). |
| v0.40.0 | **5** Extension as MCP client; exposure to other agents | [mcp-engine §7, §9](mcp-engine-requirements.md) | Done once the surface is complete. Also moves heavy work out of the extension host process. |
| v0.41.0 | **6** + **S3** Skill and primitive governance hardening; Git-URL skill import; docs and starter library | [mcp-engine §9](mcp-engine-requirements.md) | Third-party skills open last, once every safety rail exists. |
| v0.42.0 | **C6** Freshness, context health, release evaluation | [context-layer §8, §11](context-layer-requirements.md) | Final metric targets; eval report becomes a release gate. |
| tbd | **M1–M3** Migration track: assessment; bulk mapping and generation (importing external code-converter output); reconciliation and cutover | not yet written | Agreed in outline 2026-10-15; specified and positioned after K and C4a. |
| tbd | **RET** Embeddings as an optional, opt-in ranking signal | not yet written | Only if K's vocabulary-mismatch eval shows misses that the deterministic signals can't fix (see §3). |

**Phase identifiers.** `1`–`6` and `S1`–`S3`, `DRV`, `GOV` are specified in mcp-engine-requirements.md; `C1`–`C6`, `C4a`/`C4b`, `K` in context-layer-requirements.md. Shipped work is referred to by version (e.g. "the v0.9.0 tool-skills work"), not by older phase letters: the letters D, F, G and the numbers 0–9 were reused across earlier plans and mean different things in the plan sections of earlier versions of requirements.md (§11) and technical-design.md (§10), both at `fc16b0d`.

**Workflow per phase:** spec section verified against the code → implementation with tests → `npm test`, `npm run lint`, `npm run eval` → CHANGELOG entry (with deviations) → requirements.md: the affected requirements' status and wording (WHAT/WHY only) → technical-design.md for the HOW → spec section shrinks to a pointer → ✅ here → version bump → commit and push.

---

## 2. Not yet scheduled

Every item from the retired backlog and checklist of the previous requirements.md (§16 and §15 at `fc16b0d`), triaged on 2026-10-15 against the code. Requirement IDs for the open items are in [requirements.md](requirements.md).

**Still open**

| Item | From | Notes |
|---|---|---|
| One-time consent dialog for programmatic LLM use | §16.4 | Today only an opt-in setting exists. |
| Opt-in telemetry + privacy/data-flow note | §16.4 | `telemetryEnabled` is read; nothing reports. |
| Interview (intake) session survives a reload | §16.5 | Still in memory only. Natural fit for C4a. |
| Spec revision fallback keeps the comprehensive fields | §16.5 | The emergency path re-drafts with the older single-shot generator. |
| Search, tags and export in the chat history browser | §16.7 | The sidebar history dropdown with resume exists (v0.13.0). |
| Context drawer surfaces layers, rules, relationships read-only | §16.6, §15 | Partly done. |
| Agents not built: DDL generator, orchestration generator (Airflow/Dagster/Prefect), test generator | §16.3 | DDL generation is likely covered by M2's bulk generation; decide when M is specified. |
| Orchestrator ideas: action suggestions, intent-based agent invocation, plan diff, first-run onboarding, SQL result preview, Markdown/YAML export | §16.3 | Product backlog; unprioritised. |
| Old `testConnection` path still assembles credentials from settings rather than the credential resolvers | §16.8 | Verify, then fold into K or DRV. |
| Rename and delete business problems from the UI (WS-3) | §8.11 | Folders can only be removed by hand. |
| Edits to `.ai-context/context/business-context.yaml` take effect without a window reload (CTX-5) | found 2026-10-14 | That folder isn't watched for business context, and `AutoDE: Re-index Context` only shows a message. |
| Style guide; keyboard and screen-reader verification (UI-4, UI-5) | §2 | |
| Make command-only features discoverable from the panel: a Skills section in the Workflow Palette (import, run, list) and chat slash commands for import, "What the Agent Saw" and "Explain This Artifact" (UI-1) | manual testing 2026-10-15 | Today they exist only in the Command Palette. |
| Remove unused `src/spokes/{architectureAgent,ingestionAgent,sttmAgent}.ts` | found 2026-10-15 | Not imported anywhere; superseded by `src/agents/`. |
| Refresh the engineering onboarding guide (describes v0.13.0) | — | Both specs list onboarding chapters as documentation deliverables. |

**Covered by a planned phase**

| Item | From | Covered by |
|---|---|---|
| Persist platform metadata under `derived/system/` | §16.1 | K (per-system catalogs) |
| Target profiles for dev/staging/prod | §16.3a | K (environments) |
| Lineage persisted as graph edges | §16.3a | M1 (dependency graph) |
| Data Lineage Mapper and Data Quality Profiler agents | §16.3 | M1, and K tier-2 profiles + C4a probes |
| SQL validator agent | §16.3 | C3 grounding checks (done for identifiers/types) + M3 |
| Business glossary builder agent | §16.3 | C4a/C4b extraction |
| "Distill this chat" into context | §16.7 | C4b chat extraction |
| Skills authoring guidance | §16.5 | S3 docs |
| Git-URL / vendor skill import | §16.8 | S3 |

**Done**

| Item | From | Done in |
|---|---|---|
| Real Snowflake/Databricks execution | §16.1 | v0.17.0 |
| `deactivate()` cleanup | §16.4 | v0.14.0 |
| Token-aware prompt assembly, STRICT rules survive pruning | §16.2 | v0.30.0 (context packs) |
| Per-kind content validation | §16.6 | v0.29.0 |
| Tool-skill `allowed-tools` enforcement; skills on every provider | §16.8 | v0.28.0 |
| Credential resolvers; interactive onboarding | §16.8 | v0.15.0, v0.16.0 |
| Test coverage listed in §16.4 | §16.4 | Largely covered (241 functional tests at v0.30.0) |

---

## 3. Requirements revisited (2026-10-15)

Requirements in the previous requirements.md that were unmet or contradicted by later decisions, reviewed on their merits rather than dropped. The rewritten [requirements.md](requirements.md) carries these verdicts (IDs in the last column).

| Requirement (section numbers of the previous requirements.md, `fc16b0d`) | Verdict | Where it lives now |
|---|---|---|
| Heavy work never blocks the UI; worker threads (§1, §3.10, §10.1, §10.5) | **Keep, restated and measurable.** The real risk is blocking the *extension host*, which freezes AutoDE's panel and every other extension (Copilot included); the editor itself runs in another process. Requirement: no synchronous task over 100 ms at large-estate size; long work yields, reports progress, can be cancelled. Worker threads are one possible HOW, not the requirement. | NFR-1; Phase K item 11 (acceptance on the large fixture); Phase 5 moves heavy work into the engine process. |
| Embeddings and a vector store for retrieval at scale (§3.11, §5 module F, §13) | **Keep the need, change the means.** The need is retrieval that survives vocabulary mismatch (synonyms, abbreviations, another organisation's terms), which is real for merges and legacy estates. Embeddings are a poor *default*: embedding APIs exist for some of the 7 providers but not all (P4), a local model is a heavy dependency (P6), and they make retrieval provider-dependent and harder to reproduce. Deterministic signals first; embeddings as an optional signal only if measured misses remain. | GRD-8; Phase K item 12 + vocabulary-mismatch eval; phase RET (conditional). context-layer §12 updated to match. |
| "Availability" of context | **Keep, as offline operation:** AutoDE works without a live connection from cached and imported metadata, and says what it can't see. | NFR-6; Phase K (cache, legacy imports, visibility). |
| Kùzu embedded graph DB beyond ~50k nodes (§3.2, §3.11, §13) | **Drop Kùzu; keep "storage scales".** The graph queries AutoDE needs (neighbourhood, join paths ≤ 3 hops) run on the working set in memory; the at-scale problem is catalog storage and text search, which a relational store with full-text search suits better than a graph database. Any store must also respect P6 (no native modules). | NFR-8; Phase K: embedded-store decision from measurements. |
| Exact token counting with `js-tiktoken` (§3.10, §6, §10.3, §13) | **Drop the library; keep "never exceed the budget".** Each provider tokenises differently and only OpenAI's tokenizer ships as a library, so "precise" can't hold across 7 providers. Requirement: a conservative estimate with headroom, exact counts where a provider offers them; pruning never cuts mid-block and never drops STRICT rules (met by context packs). | GRD-2; C6 (context health). |
| Namespaced, readable IDs (§3.6) | **Keep the intent; the scheme was never implemented.** | STC-10; Phase K items 1 and 10. |
| Authoritative vs derived separation; sources referenced, never copied (§3.1) | **Keep.** It also underpins the rejection of a local catalog mirror. | Principle C9. |
| File layout (§3.7), module list (§5), file list (§14) | **Move to technical design (HOW);** update to the actual layout (ledger, problems, catalog). | technical-design.md (documentation stage 3). |
| Deactivation releases everything within 200 ms (§10.5) | **Keep** (drop "terminate worker threads"). | NFR-4. |
| One workspace = one effort (§7) | **Superseded** by multi-problem workspaces (v0.12.0). | WS-2. |
| Licensing review for hnswlib/ONNX (§12, §13) | **Fold into a general rule:** any new dependency needs a P6 decision record with licence and size. | Principle P6. |
| UI tab names (§2) | **Update** to the current panel (LLM / Source / Target / Prefs); keep the design principles. | UI-1, UI-2. |

---

## 4. Decision log

| Date | Decision |
|---|---|
| 2026-10-14 | P6 is "no *automatic* downloads": opt-in, integrity-checked driver acquisition (now DRV) is allowed. |
| 2026-10-15 | Reorder: K and C4a before S2 and the MCP track; C4 split into C4a and C4b — estate merge and legacy migration/modernisation are the common customer engagements. |
| 2026-10-15 | A business problem is text, a document or a document set (often non-standard, e.g. a house-format contract YAML); AutoDE builds the spec from it, closes gaps by discovery and validation first, and interviews last. |
| 2026-10-15 | Rejected: a full local mirror of a customer's catalog with periodic background sync (context-layer §12). Replaced by K's working-set cache with query-through and refresh on use. |
| 2026-10-15 | Rejected: building legacy code converters; import their output instead (context-layer §12). |
| 2026-10-15 | Parked: SAP-style sources with cryptic physical names. |
| 2026-10-15 | Embedded database only if K's scale measurements require it; embeddings only via RET, if K's vocabulary-mismatch eval requires it. |
| 2026-10-15 | Documents reorganised: requirements answer WHAT/WHY, technical design answers HOW, this roadmap answers WHEN, CHANGELOG.md records what changed. Phases D and G renamed DRV and GOV. |

**Superseded planning documents.** The plan files under `~/.claude/plans/` used before v0.25.0 were folded into this roadmap and are no longer maintained. The plan and backlog sections of the previous requirements.md (§11, §15, §16) and technical-design.md (§10), both at `fc16b0d`, are historical; the technical-design phase list was removed on 2026-10-15 and lives on in git and CHANGELOG.md.
