# AutoDE roadmap

**The single place for order and status.** Specifications say *what* each phase delivers and *why*; this document says *when*, and whether it's done. If another document's plan disagrees with this one, this one wins. Document map: [README.md](README.md).

Last updated: 2026-10-16 · Current version: **0.38.0** · Branch: `feature/engine-boundary`

---

## 1. Phases

Each row is one minor version, implemented in this order. ✅ = shipped (see [CHANGELOG.md](../CHANGELOG.md) for what changed and any deviations).

| Version | Phase | Specified in | Why here |
|---|---|---|---|
| v0.25.0 | ✅ **1** Spec state synchronization | [mcp-engine §8](mcp-engine-requirements.md) | Live bug; prerequisite for any second writer of `.autode/`. |
| v0.26.0 | ✅ **2** Engine boundary and context store | [mcp-engine §4](mcp-engine-requirements.md) | Everything after this builds in `src/engine/`. |
| v0.27.0 | ✅ **C1** Reference problem, eval harness, baseline | [context-layer §10, §11](context-layer-requirements.md) | Measures the baseline *before* the context layer changes. |
| v0.28.0 | ✅ **S1** Tool skills on every provider + `allowed-tools` | [mcp-engine §9.1](mcp-engine-requirements.md) | Security prerequisite for exposing skills. |
| v0.29.0 | ✅ **C2** Assertion ledger and projection | [context-layer §4, §11](context-layer-requirements.md) | System of record for context. |
| v0.30.0 | ✅ **C3** Context packs, manifests, causality | [context-layer §7, §8.3, §11](context-layer-requirements.md) | Grounded delivery. |
| v0.31.0 | ✅ **K1** Estate identity and catalogs: system/environment-qualified, namespaced ids with alias-map migration; `estate.yaml`; several schemas per connection; schema-scoped merges; catalog revisions in manifests; legacy dictionary import; planned objects in grounding | [context-layer §11 Phase K](context-layer-requirements.md) (items 1–3, 6, 7, 9, 10) | Every later phase attaches facts to these ids. |
| v0.32.0 | ✅ **K2** Working-set cache and scale: tiered cache with query-through, refresh on use, visibility, the 100 ms responsiveness budget, vocabulary-robust retrieval; large-estate fixture; embedded-store and RET decisions | [context-layer §11 Phase K](context-layer-requirements.md) (items 4, 5, 8, 11, 12) | Estates beyond the working-set size. |
| v0.33.0 | ✅ **C4a** Business-problem pack, interpretation profiles, discover → validate → ask, probes, conformance report, vocabulary capture | [context-layer §11 Phase C4a](context-layer-requirements.md) | Builds the spec from the customer's own documents; probes no longer wait for the MCP track. |
| v0.34.0 | ✅ **S2** Tool-skill lifecycle, provenance, review, trust tiers | [mcp-engine §9.1](mcp-engine-requirements.md) | Must exist before any skill is exposed to external agents over MCP. |
| v0.35.0 | ✅ **3** MCP server: registry, spec, prompts, resources | [mcp-engine §5, §9](mcp-engine-requirements.md) | Also exposes `autode_resolve`, `autode_get_context_pack`, `autode_list_assertions`, `autode_check_grounding`. |
| v0.36.0 | ✅ **LAY** Workspace layout: `.ai-context/` → `.autode/` grouped by lifecycle (problems, knowledge, config, git-ignored local), deliverables in a visible `autode-output/`, migration of existing workspaces | [technical-design §2.1–2.2](technical-design.md) | Decided 2026-10-16 before the MCP data-platform work: the name confused users, per-engineer state leaked into commits, and deliverables were hidden. |
| v0.37.0 | ✅ **4** MCP server: data platform, sample-data consent and redaction | [mcp-engine §5.3, §6, §9](mcp-engine-requirements.md) | Moves C4a's probes behind `autode_execute_query`; prerequisite for driver acquisition. |
| v0.38.0 | ✅ **DRV1** Platform prerequisites, moderated driver installation, Oracle as a source (Thin mode, 12.1+, tnsnames) | [mcp-engine §9.1](mcp-engine-requirements.md) | How legacy sources get a live connection without breaking P6: AutoDE moderates the install, the user's own npm does it. |
| v0.39.0 | ✅ **DRV2** Platform onboarding in the settings cards: prerequisites, backend, existing CLI connections and aliases, named connections checked before they are saved, Saved connections with per-consumer readiness, Oracle source card | [mcp-engine §9.1](mcp-engine-requirements.md) | Renders DRV1's prerequisite model; writes `connections.yaml` and its personal counterpart. |
| v0.40.0 | **C4b** Chat extraction, Context Inbox, tool-action memory | [context-layer §11 Phase C4b](context-layer-requirements.md) | Remaining context MCP tools; context gaps start pausing steps. |
| v0.41.0 | **GOV** Governance-as-code: `mask` primitive, sensitivity in specs, governance interview | [mcp-engine §9.1](mcp-engine-requirements.md) | Required by C5/C6 grounding checks and PII expectations. |
| v0.42.0 | **C5** Semantic model | [context-layer §6, §11](context-layer-requirements.md) | Built on confirmed/verified assertions; also carries the merge semantics (correspondence, survivorship, conformed dimensions). |
| v0.43.0 | **5** Extension as MCP client; exposure to other agents | [mcp-engine §7, §9](mcp-engine-requirements.md) | Done once the surface is complete. Also moves heavy work out of the extension host process. |
| v0.44.0 | **6** + **S3** Skill and primitive governance hardening; Git-URL skill import; docs and starter library | [mcp-engine §9](mcp-engine-requirements.md) | Third-party skills open last, once every safety rail exists. |
| v0.45.0 | **C6** Freshness, context health, release evaluation | [context-layer §8, §11](context-layer-requirements.md) | Final metric targets; eval report becomes a release gate. |
| tbd | **M1–M3** Migration track: assessment; bulk mapping and generation (importing external code-converter output); reconciliation and cutover | not yet written | Agreed in outline 2026-10-15; specified and positioned after K and C4a. |
| tbd | **RET** Embeddings as an optional, opt-in ranking signal | not yet written | Not scheduled (K2 measured 17/21 and 8/8; the misses are free paraphrases — decision log 2026-10-15). Reconsidered if real engagements show paraphrase misses that C4a's vocabulary capture does not fix. |

**Phase identifiers.** `1`–`6` and `S1`–`S3`, `DRV1`/`DRV2`, `GOV` are specified in mcp-engine-requirements.md; `LAY` (v0.36.0, workspace layout) was decided in the decision log and is documented in technical-design.md §2.1–2.2 without a separate spec; `C1`–`C6`, `C4a`/`C4b`, `K1`/`K2` in context-layer-requirements.md. Shipped work is referred to by version (e.g. "the v0.9.0 tool-skills work"), not by older phase letters: the letters D, F, G and the numbers 0–9 were reused across earlier plans and mean different things in the plan sections of earlier versions of requirements.md (§11) and technical-design.md (§10), both at `fc16b0d`.

**Workflow per phase:** spec section verified against the code → implementation with tests → `npm test`, `npm run lint`, `npm run eval` → CHANGELOG entry (with deviations) → requirements.md: the affected requirements' status and wording (WHAT/WHY only) → technical-design.md for the HOW → spec section shrinks to a pointer → ✅ here → version bump → commit and push.

---

## 2. Not yet scheduled

Every item from the retired backlog and checklist of the previous requirements.md (§16 and §15 at `fc16b0d`), triaged on 2026-10-15 against the code. Requirement IDs for the open items are in [requirements.md](requirements.md).

**Still open**

| Item | From | Notes |
|---|---|---|
| **Tier-1 primitives emit Snowflake syntax for every dialect** | — | Found by v0.35.0's golden snapshots: `dedup` uses `SELECT * EXCEPT (…)` (Snowflake, BigQuery and Databricks only) and `CREATE OR REPLACE VIEW` (not T-SQL) for every dialect. The snapshots pin today's output; phase 6 (per-dialect `platforms` and the conformance suite) is where it gets fixed and the snapshots updated. |
| One-time consent dialog for programmatic LLM use | §16.4 | Today only an opt-in setting exists. |
| Opt-in telemetry + privacy/data-flow note | §16.4 | `telemetryEnabled` is read; nothing reports. |
| Interview (intake) session survives a reload | §16.5 | Still in memory only (BPS-7). Not done in C4a; fits C4b, which persists chat-derived facts. |
| Spec revision fallback keeps the comprehensive fields | §16.5 | The emergency path re-drafts with the older single-shot generator. |
| Search, tags and export in the chat history browser | §16.7 | The sidebar history dropdown with resume exists (v0.13.0). |
| Context drawer surfaces layers, rules, relationships read-only | §16.6, §15 | Partly done. |
| Agents not built: DDL generator, orchestration generator (Airflow/Dagster/Prefect), test generator | §16.3 | DDL generation is likely covered by M2's bulk generation; decide when M is specified. |
| Orchestrator ideas: action suggestions, intent-based agent invocation, plan diff, first-run onboarding, SQL result preview, Markdown/YAML export | §16.3 | Product backlog; unprioritised. |
| **Oracle as a target** | DRV2 discussion, 2026-10-18 | A target card promises generation in that dialect: Oracle in `SqlDialect`, Tier-1 primitive templates, golden snapshots and conformance, plus the target-context interview. Today Oracle is a source only (DRV1). Specify as its own phase when an engagement needs it; in the agreed engagements (legacy migration, estate merge) Oracle is the source. |
| **AWS Redshift card** | owner, 2026-10-18 | A platform card like Snowflake's and Databricks', on DRV1/DRV2's model: listed in `providerRegistry.ts` but no adapter. Decide the backend first — Redshift Data API (REST, IAM/Secrets Manager auth, no driver) fits P6/P7 better than a moderated `pg` driver install — then the adapter, `connections.yaml` fields, probe dialect and guard quoting. Source and target: a Redshift target also needs dialect generation (primitives, snapshots, conformance), so scope that with it or ship source-only first, as with Oracle. |
| Settings-based connections keep their secrets under the old fixed keys | DRV2 | The card fields (one connection per platform and role) still use `SECRET_KEYS`; named connections use `secretStorageKey()`. Retire the card-only path once named connections are the norm, or migrate it into a named connection on first save (today the user saves explicitly). |
| Rename and delete business problems from the UI (WS-3) | §8.11 | Folders can only be removed by hand. |
| Edits to `.autode/knowledge/business-context.yaml` take effect without a window reload (CTX-5) | found 2026-10-14 | That folder isn't watched for business context, and `AutoDE: Re-index Context` only shows a message. |
| Style guide; keyboard and screen-reader verification (UI-4, UI-5) | §2 | |
| Make command-only features discoverable from the panel: a Skills section in the Workflow Palette (import, run, list) and chat slash commands for import, "What the Agent Saw" and "Explain This Artifact" (UI-1) | manual testing 2026-10-15 | Today they exist only in the Command Palette. |
| Remove unused `src/spokes/{architectureAgent,ingestionAgent,sttmAgent}.ts` | found 2026-10-15 | Not imported anywhere; superseded by `src/agents/`. |
| AutoDE beyond VS Code | discussed 2026-10-16, parked | Option 1: a headless, deterministic `autode` CLI (`validate`, `compile`, `grounding`, `extract`, `conformance`, `probe`, `doctor`, `mcp`; exit codes for CI), mostly reuse of `src/engine` and the MCP tool handlers. Option 2: the conversational assistant outside VS Code through existing harnesses (a Claude Code plugin, plus MCP write and approval tools with gates held by the engine), after phase 5 makes orchestration host-agnostic. Building AutoDE's own harness is not recommended. Orchestration's VS Code coupling is shallow (file I/O, settings, watchers, dialogs). |

**Covered by a planned phase**

| Item | From | Covered by |
|---|---|---|
| Target profiles for dev/staging/prod | §16.3a | K (environments) |
| Lineage persisted as graph edges | §16.3a | M1 (dependency graph) |
| Data Lineage Mapper and Data Quality Profiler agents | §16.3 | M1, and K tier-2 profiles + C4a probes |
| SQL validator agent | §16.3 | C3 grounding checks (done for identifiers/types) + M3 |
| Business glossary builder agent | §16.3 | C4b extraction (C4a reads glossaries in documents) |
| "Distill this chat" into context | §16.7 | C4b chat extraction |
| Skills authoring guidance | §16.5 | S3 docs |
| Git-URL / vendor skill import | §16.8 | S3 |

**Done**

| Item | From | Done in |
|---|---|---|
| Real Snowflake/Databricks execution | §16.1 | v0.17.0 |
| Persist platform metadata under `derived/system/` | §16.1 | v0.32.0 (per-system catalogs under `.autode/local/catalog/`) |
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
| 2026-10-15 | Phase K split into K1 (identity and catalogs, v0.31.0) and K2 (working-set cache and scale, v0.32.0) — twelve scope items are two reviewable phases; later phases move down one version. |
| 2026-10-15 | K2: the ledger and graph hold only the **working set**; the estate lives in per-system catalogs. Measured on 2 008 tables / 49 393 columns: mirroring everything cost 713 MB of extension-host heap and a 2.1 s sync; the catalog costs 24 MB and the longest synchronous task is 46 ms. Imports enter the working set whole while it stays within 200 tables, so estates of the original target size behave as before. |
| 2026-10-15 | K2: **no embedded database.** The catalog at 2 000 tables is 11 MB of JSON and 24 MB of heap, packs build in ≤ 2.2 ms and every budget holds with margin. Revisit at roughly ten times that size (about 20 000 tables), where JSON load and heap would approach the limits. |
| 2026-10-15 | K2: **RET not scheduled.** Deterministic signals found 17 of 21 vocabulary-mismatch questions (3 of 21 from names alone) and 8 of 8 on the large estate; all 4 misses are free paraphrases. Counter-measure first: C4a's vocabulary capture (LLM-proposed, engineer-reviewed `vocabulary.yaml` entries) keeps run-time retrieval deterministic and provider-independent. RET is reconsidered if real engagements' questions show paraphrase misses that this does not fix. |
| 2026-10-15 | C4a: probes also run over **sample files the customer supplies** (same templates, same aggregates), because merge and migration sources often have no live connector yet; only counts leave the probe either way. |
| 2026-10-15 | C4a: probes stay **fixed templates in code** (`probes.ts`), reviewed like code, until phase 6 brings Tier-2 governance for them; a passed probe raises trust to verified but does **not** confirm the claim — confirming stays the engineer's (Inbox, C4b). |
| 2026-10-16 | **`.ai-context/` becomes `.autode/`, grouped by lifecycle; deliverables move to a visible `autode-output/`.** The folder had grown from a deliverables folder into four things with different lifecycles (per-problem work, shared knowledge, team customisations, per-engineer caches). AutoDE never wrote ignore rules into customer repositories, so chat transcripts, caches and `active-problem.json` were committed there. Rejected: nesting `.ai-context/` inside `.autode/` (keeps the confusing name, adds a level, fixes nothing). Existing workspaces migrate on open by moves only. Inserted as v0.36.0; phase 4 and everything after shift by one version. |
| 2026-10-16 | **Documentation kept current by construction where possible.** The onboarding guide was rewritten as an orientation that links into the other documents instead of duplicating them (the duplicated v0.13.0 guide had drifted for twenty versions). technical-design.md's settings table and source tree are generated from `package.json` and `src/` and checked by `npm test`. requirements.md maps each capability area to the spec sections that extend it. Every phase updates the guide and the manual-verification checklist. |
| 2026-10-16 | **Licence and identity.** AutoDE is the owner's personal open-source work, free for any use including commercial: it stays **MIT** (copyright Arun Gribta), which already permits that and is accepted by enterprise intake reviews; publisher id `arun-gribta`. A Tiger Analytics fork will need its own publisher and, to install alongside, its own extension name and command/setting prefix. Bundled libraries' licences ship as `dist/THIRD-PARTY-NOTICES.md`, generated from what the bundler included. |
| 2026-10-16 | Phase 3: new runtime dependency **`@modelcontextprotocol/sdk` 1.31.0** (MIT; with zod, ajv and its other dependencies, all MIT) — bundled into `dist/mcp-server.js`, 470 KB minified against a 1.5 MB budget; dev-only `esbuild` 0.28.2 and `@vscode/vsce` 4.0.0 (MIT). Versions pinned exactly and chosen at least two weeks old. The package shrank from 871 KB / 220 files (and broken: no `ajv`/`yaml`) to 453 KB / 25 files. |
| 2026-10-16 | **DRV rewritten: AutoDE moderates driver installs instead of distributing drivers.** The earlier design (fetch `snowflake-sdk` / `@databricks/sql` tarballs and verify their hashes) can't produce a working driver: each is a ~120 MB dependency tree with native per-OS binaries, so it would mean an npm installer of our own plus native code (P6). The two platforms also gain little over CLI + REST. AutoDE now knows each platform's prerequisites (detect, why, install step, verify). It runs the install step in a visible terminal only on the user's click, using the user's own npm and `.npmrc`, so internal registries and integrity come for free. A driver loads only while its verification record matches its lockfile. Rejected: pre-bundling drivers into packages AutoDE publishes (owner's decision: AutoDE doesn't distribute packages); companion VSIX extensions. Split into DRV1 (model, install, Oracle) and DRV2 (onboarding UI); later phases move down one version. |
| 2026-10-18 | DRV2: **no separate "Data Platforms" tab** (owner's call, after review): onboarding lives in each platform card, where it already belongs, so there is no fourth place to configure a connection. Added instead: a **Saved connections** list per tab, because a card holds one connection per platform while an estate merge has several. **Oracle stays a source**: a target card would promise Oracle SQL generation, which is its own phase (backlog). |
| 2026-10-18 | DRV2: **secrets typed in a card go to VS Code's secret storage under `resolver: vscode`**, and an MCP server, which can't read that store, takes the same secret from `AUTODE_<PLATFORM>_<REF>_<FIELD>`. Readiness is shown per consumer ("AutoDE" / "MCP"), so a connection that works in the panel isn't presented as working for Claude Code. Rejected: refusing secrets for named connections (password and PAT users couldn't onboard in the UI); keeping secret-based connections out of the file (MCP would never see them). Phase 5 passes the secrets as env variables to the server the extension starts. |
| 2026-10-18 | DRV2: **per-engineer fields don't go in the committed file.** `username`, key, wallet and CLI paths go to `.autode/local/connections.yaml`, merged by id; consent stays the team's decision. **Readiness is per machine** (`.autode/local/`) and bound to a hash of the entry. Found on the way: Snowflake's `role` collided with the entry's source/target `role` since phase 4 and is now `snowflakeRole`; Databricks `.databrickscfg` profiles couldn't connect at all and now supply host and token. |
| 2026-10-16 | DRV1: **Oracle first, Thin mode only (Oracle Database 12.1+)** — pure JS, no Instant Client; 11g and older need Thick mode, whose native library must not load in the extension host (phase 5 isolates the engine). Connections use a **tnsnames alias or Easy Connect** with Oracle's own lookup order (`configDir`, `TNS_ADMIN`, `$ORACLE_HOME/network/admin`); AutoDE reads alias names only. Passwords still come from env or SecretStorage: tnsnames holds no credentials, and Oracle's wallet password store needs Thick mode. Oracle is a source; generating Oracle SQL is out of scope. |
| 2026-10-16 | Phase 4: **connections for the MCP server live in `.autode/config/connections.yaml`**, committed, with pointers and non-secret settings only (a secret in it invalidates the entry). A server started by Claude Code or Cursor can't see VS Code settings or SecretStorage, so the settings panel can't be the source; a per-engineer file would split the consent decision across laptops. The extension's own connections still come from settings until phase 5; it reads consent from the same file by connection id. |
| 2026-10-16 | Phase 4: **an MCP tool result is a prompt.** Whatever the server returns goes into the calling agent's model context, so sample-data consent gates the server's responses, not only AutoDE's own prompts: without consent `autode_execute_query` returns columns and a row count, and `SHOW`/`DESCRIBE`/`EXPLAIN` output (metadata) passes. Rejected: letting single-row numeric results through as "aggregates" — `SELECT salary FROM emp WHERE id = 5` is one numeric row. Verification by aggregates stays the probes' job (C4b exposes them as `autode_verify_assertion`). Consent is per connection and committed, so it is a visible decision of the engagement. |
| 2026-10-16 | Phase 4: the **read-only guard tokenises the SQL under two quoting conventions** (ANSI; Snowflake/Spark with backslash escapes, backticks and `$$`) and accepts only what both read as one read-only statement. A single convention is bypassable on the other dialect (`'x\'' ; DROP …`). The cost is refusing some legitimate but unusual quoting (`'it\'s'`, `$$…;…$$`). The guard is documented as a guard; the platform role is the boundary. |
| 2026-10-16 | Phase 3: the MCP server is **strictly read-only**, including for skills (no S2 migration from the server) and packs (no working-set promotion); context is re-read when its files change rather than watched. `notifications/resources/updated` (a SHOULD in §5.5) moves to phase 5, where the extension becomes a client and needs it. |
| 2026-10-15 | S2: **trust belongs to content**, not to a skill id: a review records the checksum of what was read, and changed files are unreviewed again. "No sidecar = trusted" (the spec's back-compat rule) applies only once, at upgrade, so a skill folder copied in by hand later cannot bypass review. Snapshots live in `.autode-history/` rather than `history/`, which a foreign skill may use itself. |
| 2026-10-15 | C4a: vocabulary captured from the reference glossary lifts paraphrase recall from 0/4 to 2/4 (19/21 overall, no regressions). Of the two misses, one shares no word with its table ("money customers got back" → refunds) and one ranks a sibling table first (loyalty members over loyalty transactions). **RET stays unscheduled**: two misses on a four-question set don't justify a ranking dependency; revisit with real engagements' questions. Multi-word synonym proposals are dropped (retrieval is word by word) rather than adding phrase matching, which would not have caught the miss either. |
| 2026-10-15 | C4a: the interviewer is told what discovery established and a question discovery answers is dropped deterministically (logged), rather than trusting the LLM to skip it. |
| 2026-10-15 | Documents reorganised: requirements answer WHAT/WHY, technical design answers HOW, this roadmap answers WHEN, CHANGELOG.md records what changed. Phases D and G renamed DRV and GOV. |

**Superseded planning documents.** The plan files under `~/.claude/plans/` used before v0.25.0 were folded into this roadmap and are no longer maintained. The plan and backlog sections of the previous requirements.md (§11, §15, §16) and technical-design.md (§10), both at `fc16b0d`, are historical; the technical-design phase list was removed on 2026-10-15 and lives on in git and CHANGELOG.md.
