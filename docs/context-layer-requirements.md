# AutoDE — Context Layer, Semantic Model & Grounding: Requirements Specification

**Status:** In progress — order and status: [roadmap.md](roadmap.md) · **Baseline:** v0.24.0 (`6f09e62`) · **Companion to:** [mcp-engine-requirements.md](mcp-engine-requirements.md) · **Document map:** [README.md](README.md) (read §0 and §1 there first; its implementation rules and principles P1–P7 apply here unchanged)
**Audience:** the coding agent implementing this, and the reviewers approving each phase.

---

## 1. Intent

AutoDE's output is only as accurate as what it knows about the business problem and the data. This specification turns the context layer from a **static dump of discovered metadata** into a **governed, continuously enriched, provenance-tracked knowledge layer**. Every chat turn, interview answer, attachment and discovery run can add to it. Every generated artifact can show exactly which facts it was built on. And AutoDE can **measure** its own grounding on a reasonably sized business problem.

Industry direction this follows (adopt the principles, not the products):
- **Snowflake Horizon Context**: metadata is *collected* from sources, *enriched* with business definitions, and *delivered* to agents. AutoDE maps this to discover → enrich → deliver (§4–§7).
- **AtScale-style universal semantic layer**: agents consume a governed model of metrics, relationships and policies through MCP, and **do not infer joins or KPI definitions themselves**. AutoDE adopts this as principle C3.

"Reasonably sized" (the design target for this spec): up to ~5 source connections, ~200 tables, ~5 000 columns, ~1 000 assertions per business problem. At this size everything stays in memory, with no vector database and no embeddings dependency (P6).

*Revised 2026-10-15:* estates larger than this are common (estate merge, legacy migration). The target above now describes a business problem's **working set**; the estate around it is handled by Phase K's per-system catalogs and tiered working-set cache, and an embedded store is adopted only if K's scale measurements require it.

---

## 2. Gaps at baseline (verified against the code)

| # | Gap | Evidence |
|---|-----|----------|
| G1 | **No task-scoped retrieval.** Every caller receives the same global dump. | `ContextFileManager.buildContextPrompt(maxTokens)` ignores `maxTokens`; it emits the first 20 tables (no columns), all terms and 5 query labels regardless of task. Its ~15 call sites (`webviewProvider.ts`, `agentHub.ts`) all get the same text. |
| G2 | **Graph retrieval exists but is unused.** | `GraphManager.traverseNeighborhood()` (relevance with distance decay) has no callers. |
| G3 | **Chat does not enrich context.** Facts stated by the engineer survive only in transcripts and lossy summaries. | `agentHub.chat()` → `summarizeDroppedTurns()`; nothing writes to `GraphManager` from chat. |
| G4 | **"Semantic layer" is a graph snapshot, not a semantic model.** No entities, measures, dimensions, grain, or join paths with cardinality. | `SemanticLayerManager.build()` copies `GraphManager.serializeSnapshot()`. NodeType `metric` is declared in `src/context/types.ts` but never created. |
| G5 | **No causality between facts and outputs.** Artifacts record spec id/version only. | `GeneratedArtifact.specId/specVersion`; `ArtifactStalenessScanner` compares spec version folders only. |
| G6 | **No truth maintenance.** Updates replace wholesale; no supersession, conflict detection or validity period. | `GraphManager.removeNodesBySourceRef()` + re-add; `Origin` has `extractedAt` / `lastVerifiedAt` but no `supersedes` / `validTo` / status. |
| G7 | **Facts are never verified against data.** Claims such as "order_id is unique" or "orders join customers on customer_id" are taken on trust. | No probe mechanism; `reliability: 'live-verified'` covers schema introspection only. |
| G8 | **No way to prove grounding.** Nothing measures whether output identifiers, keys, grains and metrics trace to known facts. | No evaluation harness; `test/functional.test.cjs` covers mechanics only. |

---

## 3. Context principles (in addition to P1–P7)

Defined in [requirements.md §2.2](requirements.md) (C1–C9), which is canonical: C1 assertions, not blobs; C2 nothing silently overwritten; C3 agents don't infer what the context layer defines; C4 explicit, ordered trust; C5 deliver less but the right context; C6 every artifact explainable; C7 grounding measured; C8 deterministic core, LLM at the edges; C9 sources referenced, never copied.

---

## 4. Data model

### 4.1 Assertion

New file `src/engine/context/assertions.ts` (engine layer; no `vscode`).

```ts
type AssertionKind =
  | 'schema_fact'          // table/column/type/nullability exists (discovery, file ingestion)
  | 'data_fact'            // profiled property: null %, distinct count, min/max, freshness
  | 'key'                  // primary / natural / candidate key of an entity
  | 'grain'                // "one row per <...>" for a table or entity
  | 'relationship'         // join path between entities, with cardinality
  | 'business_term'        // glossary definition, bound to physical columns where possible
  | 'metric'               // measure/metric definition: expression, aggregation, grain, filters
  | 'business_rule'        // STRICT | RECOMMENDED rule
  | 'mapping'              // source column(s) → target column, with transform
  | 'quality_expectation'  // expected data property (not-null, accepted values, freshness SLA)
  | 'decision'             // a design choice made in chat ("SCD2 for customer")
  | 'assumption'           // something taken as true without evidence; must be visible
  | 'constraint'           // non-functional: latency, volume, cost, compliance
  | 'naming_convention';

type AssertionStatus = 'proposed' | 'active' | 'rejected' | 'superseded' | 'needs_review';
type TrustTier = 'verified' | 'confirmed' | 'documented' | 'inferred';

interface Assertion {
  id: string;                 // ULID (sortable, merge-friendly)
  kind: AssertionKind;
  subject: string[];          // graph node ids (fqn-based) this is about; ≥1
  predicate: string;          // kind-specific, e.g. 'unique', 'grain', 'joins_to', 'defined_as'
  value: unknown;             // kind-specific payload, schema-validated per kind (Ajv)
  statement: string;          // one-sentence human-readable form, shown in UI and prompts
  status: AssertionStatus;
  trust: TrustTier;
  evidence: Evidence[];       // ≥1; why we believe it
  supersedes?: string;        // id of the assertion this replaces
  validFrom: string;          // ISO timestamp it became active
  validTo?: string;           // set when superseded / rejected
  verification?: { method: 'introspection' | 'probe' | 'test'; at: string; result: 'pass' | 'fail'; detail?: string; probeId?: string };
  specId?: string;            // business problem it belongs to (undefined = project-wide)
  createdBy: string;          // 'user:<name>' | 'agent:<agentType>' | 'mcp:<clientName>' | 'system'
  createdAt: string;
}

interface Evidence {
  type: 'chat_message' | 'interview_answer' | 'attachment' | 'file' | 'introspection' | 'probe' | 'spec_field' | 'user_edit';
  ref: string;                // chat id + message index, file path + line range, probe id, spec path, ...
  excerpt?: string;           // ≤ 300 chars quote of the evidence
}
```

Each `kind` has an Ajv schema for `value` in `src/engine/context/assertionSchemas.ts`. For example, `relationship.value = { from: {entity, columns[]}, to: {entity, columns[]}, cardinality: '1:1'|'1:N'|'N:1'|'N:M', optional: boolean }`; `metric.value = { expression, aggregation, grain[], filters[], unit? }`.

### 4.2 Ledger (system of record)

- Append-only JSON Lines under `.ai-context/ledger/` with one file per writer session: `<yyyy-mm-dd>.<sessionUlid>.jsonl`. Appending to separate files keeps git merges conflict-free when a team shares a workspace.
- Event types: `asserted`, `confirmed`, `rejected`, `superseded`, `verified`, `verification_failed`, `flagged_needs_review`. Every event carries `id`, `assertionId`, `at`, `actor`, and `causedBy` (the event or evidence id that triggered it). `causedBy` is what makes causality traceable (§8).
- Folding all events gives the current assertion set. Compaction: an `AutoDE: Compact Context Ledger` command writes `.ai-context/ledger/snapshot.json` plus the events after it. It never deletes history unless the user explicitly runs it with `--prune`.
- All writes go through `ContextStore` (mcp-engine-requirements §4.3).

### 4.3 Projections (derived, rebuildable, never hand-edited)

1. **Context graph.** `GraphManager` is rebuilt from active assertions. Existing node and edge types stay. Nodes gain `supportedBy: string[]` (assertion ids), and edges gain the same. The existing `Origin` remains for compatibility and is filled from the strongest supporting assertion.
2. **Semantic model** (§6), `.ai-context/semantic/model.yaml`.
3. **Governed containers.** The Business Problem Spec, Source/Target/Mapping context and Pipeline Spec stay the human-approval units and keep their files and versioning. Approving a container sets every `proposed` assertion it contains to `active` with trust ≥ `confirmed`. Editing an approved container emits `superseded` events rather than rewriting.

Migration: on first load, existing graph content (`GraphPersistence` snapshot, `business-context.yaml`, verified queries, data definitions, file ingestion, live discovery) is converted into assertions. Trust is `verified` for `reliability: 'live-verified'` origins, `documented` for file-derived ones, `inferred` for `OriginSource 'llm'`, and `confirmed` for content inside already-approved containers. The migration MUST be idempotent and MUST produce the same graph as before (test: node and edge sets equal pre/post).

---

## 5. Enrichment — how discovery and chat feed the context layer

### 5.1 Sources of assertions

| Source | Module today | Produces | Initial trust / status |
|--------|--------------|----------|------------------------|
| Live discovery (schema) | `SourceAssessmentAgent`, `BaseAdapter.extractMetadata()` | `schema_fact`, declared keys / FKs | `verified` / `active` |
| Profiling | `BaseAdapter.profileColumns()` | `data_fact`, candidate `key` (distinct = rows, no nulls) | `verified` / `active` for facts; `inferred` / `proposed` for candidate keys |
| File ingestion | `fileIngestion.ts` | `schema_fact` | `documented` / `active` |
| Business context files | `SynthesisPipeline` (business-context.yaml, verified queries, data definitions) | `business_term`, `business_rule`, `metric` | `documented` / `active` |
| Interview | `agentHub.discoverNextAction()` + `skills/*.json` | any kind, from answers | `inferred` / `proposed` (`confirmed` once the spec is approved) |
| Chat | `agentHub.chat()` | any kind | `inferred` / `proposed` |
| Attachments | `extractAttachmentFacts()` | `schema_fact`, `business_term`, `business_rule` | `documented` / `proposed` |
| LLM relationship/grain inference | new | `relationship`, `grain`, `key` | `inferred` / `proposed` → probe (§5.3) |
| External MCP clients | `autode_propose_assertion` (§9) | any kind | `inferred` / `proposed`, `createdBy: mcp:<client>` |

### 5.2 Assertion extraction from chat and interview (the only LLM step)

- After each user turn in chat or the interview, run an **extractor** asynchronously so it never blocks the reply. It calls the configured LLM adapter with the turn, the previous assistant turn, and a compact list of existing assertions on the referenced subjects. It returns `{ assertions: ProposedAssertion[] }`, validated against the per-kind Ajv schemas. Invalid output is dropped and logged; it never fails the chat turn.
- The extractor prompt lives in `skills/` as a governed prompt pack and is exposed as the MCP prompt `autode_extract_assertions`, so external clients can run the same extraction with their own model (D5).
- **Entity resolution (deterministic):** each proposed `subject` is resolved against graph nodes by fqn, label, alias and business-term binding, using the same deterministic resolver as the `autode_resolve` tool. Unresolvable subjects stay `proposed`, flagged `unresolved_subject` in the inbox. They are never dropped silently.
- **Dedup:** a proposal equal in `kind + subject + predicate + value` to an active assertion only adds evidence to it.
- Explicit capture is also available: chat commands `/define <term> = <definition>`, `/rule <text>`, `/decide <text>`, `/assume <text>`. These skip the LLM extraction and go straight to `proposed`.
- Chat replies that use context MUST cite assertion ids inline (rendered as hover chips in the panel), so the engineer sees what an answer rests on.

### 5.3 Verification probes (turning claims into evidence)

Read-only SQL checks run through the engine (`autode_execute_query`, read-only mode), generated from **fixed templates per kind and dialect**, never LLM-written:

| Kind / predicate | Probe |
|------------------|-------|
| `key` unique | `COUNT(*)` vs `COUNT(DISTINCT cols)` plus a null count on the key columns |
| `grain` | same as unique, on the grain columns |
| `relationship` | orphan rate: share of `from` rows with no match in `to`; observed cardinality from max matches per key |
| `data_fact` / `quality_expectation` not-null / accepted values / freshness | `COUNT_IF(col IS NULL)`, `COUNT(DISTINCT)` outside the accepted set, `MAX(ts)` vs now |
| `metric` | evaluate the expression on a bounded sample; check it compiles (`EXPLAIN`) |

- Probes are templates in the primitive registry (Tier-2 `PrimitiveDefinition`s with a `probe` category), so they get the same governance, versioning and conformance tests (mcp-engine Phase 6).
- Probes respect `maxRows`, the query timeout and sampling (`TABLESAMPLE` where the dialect supports it). Results record the sample size, and a sampled pass is labelled as such.
- Probes return **aggregates only** (counts, rates, min/max), never row values, so they are unaffected by the sample-data consent setting (mcp-engine Phase 4).
- On pass: emit a `verified` event and raise trust to `verified`. On fail: emit `verification_failed`, set status `needs_review`, and show the observed numbers in the inbox (e.g. *"order_id is not unique: 1.2% duplicates in 50 000 sampled rows"*).
- Probes run automatically for `proposed` key/grain/relationship assertions when a connection is live and the `readOnlyMode` setting is on, and on demand from the inbox. Without a live connection, assertions stay at their tier and show *"not verified — no connection"*.

### 5.4 Context Inbox (human gate)

A new panel section listing `proposed`, `needs_review` and conflicting assertions, grouped by subject. Each item shows the statement, kind, trust, evidence excerpts with links (chat message, file line, probe result), and conflicts. Actions: **Confirm**, **Edit & confirm** (supersedes), **Reject**, **Verify now**. Bulk-confirm is allowed only for `documented` items from one source. Live-verified schema facts never appear in the inbox; they're `active` already.

---

## 6. Semantic model

`SemanticLayerManager` changes from a graph snapshot to a **semantic model** projected from active assertions and stored at `.ai-context/semantic/model.yaml`. It keeps the existing approve / version / archive pattern (`context/history/...`) and spec pinning.

```yaml
version: 3
specId: retail-orders
status: approved            # draft | approved (approval gate, same pattern as other containers)
entities:
  - name: order
    table: SALES.PUBLIC.ORDERS
    grain: [order_id]               # from a 'grain' assertion
    keys: { primary: [order_id] }
    dimensions:
      - { name: order_date, column: ORDER_TS, type: time, granularity: day }
      - { name: channel, column: CHANNEL, type: categorical }
    measures:
      - { name: gross_amount, expression: AMOUNT, aggregation: sum }
relationships:
  - { from: order, to: customer, on: [[customer_id, customer_id]], cardinality: N:1 }
metrics:
  - name: net_revenue
    expression: gross_amount - refund_amount
    filters: ["status <> 'CANCELLED'"]
    grain: [order]
    owner: finance
glossary:
  - { term: Active customer, definition: "...", binds_to: [customer.last_order_date] }
rules:
  - { id: R1, level: STRICT, text: "PII columns are masked in all target layers" }
assertionRefs: { net_revenue: [01J...], order.grain: [01J...] }   # traceability back to the ledger
```

Requirements:
- Concepts align with dbt MetricFlow semantic models (entities, dimensions, measures, metrics), so an export maps one-to-one.
- **Exports are primitives:** dbt `semantic_models` / `metrics` YAML, Snowflake semantic view DDL, and Databricks metric views where the platform supports them. Each is a Tier-2 `PrimitiveDefinition`, so exports are deterministic and versioned. Track the emerging cross-vendor semantic interchange formats as future export targets; do not adopt them as the internal format.
- **Consumption (principle C3):** `SttmMapperAgent`, `DataModelerAgent`, `TransformationScaffolderAgent` and `llmParamSelector` read grain, keys, join paths and metric definitions from the semantic model. When a step needs one that doesn't exist (e.g. a join between two entities with no `relationship` assertion), the step pauses with a **context gap** (§7.3). It must not invent one.
- A model element backed only by `inferred` assertions is shown as such and cannot be part of an `approved` model unless the user explicitly confirms it.

---

## 7. Delivery — task-scoped context packs

### 7.1 ContextPackBuilder

New file `src/engine/context/contextPack.ts`. It replaces the body of `buildContextPrompt()`, which stays as a thin wrapper (no seeds = project overview) so existing call sites keep compiling during migration.

Input: `{ purpose: 'interview' | 'spec' | 'plan' | 'step' | 'chat' | 'qa', seeds?: nodeId[], query?: string, maxTokens: number }`.

Algorithm (deterministic):
1. **Seeds**: explicit `seeds`; otherwise resolve them from the plan step (its spec data flows, source/target entities and mappings) or, for chat, from `autode_resolve(query)`.
2. **Expand** with `GraphManager.traverseNeighborhood()` (finally wired up), with `maxHops` per purpose (step: 2, chat: 1, plan: 1).
3. **Score** = relevance (distance decay) × trust weight (verified 1.0, confirmed 0.95, documented 0.7, inferred 0.4) × freshness weight (§8.2).
4. **Mandatory inclusions** whatever the score: STRICT rules touching any seed, active conflicts and `needs_review` items on seeds (as warnings), grain/keys for seed entities, and relationships among seeds.
5. **Budget**: render by score until `maxTokens` (using the existing `tokenBudget.ts`). Columns are included for seed tables, collapsed for neighbours. Anything truncated is summarised by count (*"+14 more columns on ORDERS"*).
6. **Output**: rendered markdown plus a `PackManifest { packId, purpose, seeds, includedAssertionIds@revision, truncatedCounts, tokenCount }`.

Every LLM call made by the hub or the agents uses a pack, and the `PackManifest` is attached to the step result. The panel offers **"What the agent saw"** for any step or chat reply.

### 7.2 Q&A grounding

For chat questions about the data (*"what's the grain of fact_orders?"*), the hub first tries a deterministic answer from the semantic model and ledger. It uses the LLM only to phrase the answer and must cite assertion ids. If no assertion covers the question, the answer says so and offers to capture one. It does not answer from general knowledge.

### 7.3 Context gaps

When a step or the param selector needs a fact class that is absent or below the required trust (key, grain, join, metric, a mapping for a target column), it emits a `ContextGap { stepId, needed: kind+subject, minTrust }`. The step pauses, and the gap appears in the inbox as a targeted question to the engineer (or as a probe, if one can settle it). Answering it creates the assertion and resumes the step. Minimum trust per fact class is configurable. Defaults: keys / grain / joins / STRICT rules need ≥ `confirmed`; others ≥ `documented`. An explicit "proceed on inferred" override is recorded in the manifest.

---

## 8. Context rot, freshness and causality

### 8.1 Context rot: failure modes and countermeasures

| Failure mode | Countermeasure |
|--------------|----------------|
| **Stale facts:** the source schema or data drifted | Freshness policy (§8.2); `reVerifySourceSchema` emits supersession / `needs_review` events instead of a silent replace; dependent assertions on a removed column go to `needs_review` automatically (subject dependency walk). |
| **Superseded decisions lingering** | Supersession sets `validTo`; projections include only active assertions; packs never include superseded ones. |
| **Contradictions** | Conflict detector: two active assertions with the same `subject + predicate` and incompatible `value` → both flagged, shown in the inbox, and included in any pack touching the subject as a warning. Generation of a step whose required fact is in conflict is blocked (§7.3). |
| **Dilution:** irrelevant context in the prompt degrades output | Task-scoped, token-budgeted packs (§7) instead of the global dump. |
| **Summary drift:** lossy rolling chat summaries | Facts live in the ledger, not in summaries. `summarizeDroppedTurns()` output is never used as a source of facts, and its prompt is told to reference assertion ids rather than restate facts. |
| **Orphans:** assertions about nodes that no longer exist | Health check (§8.4) flags them; never auto-deleted. |

### 8.2 Freshness policy

Settings (defaults in brackets): `schema_fact` re-verify after [7 days] and always before plan execution when a connection is live; `data_fact` / probe results expire after [30 days]; `confirmed` business assertions don't expire but go to `needs_review` when any subject's schema fact changes. Freshness weight in scoring decays linearly to 0.5 at expiry. Expired facts are still used but labelled *stale* in packs and manifests.

### 8.3 Causality and impact

- **Causal chain:** every ledger event's `causedBy` links it to the evidence or event that triggered it. So any assertion can be traced back to the chat message, file line or probe it came from (*"why do we believe X"*), and forward to what it affected.
- **Grounding manifest per artifact** (`<artifact>.grounding.json` next to each file written by `ArtifactWriter`):
  ```json
  { "artifact": "03-build/retail-orders.v3/stg_orders.sql",
    "specRevision": "sha256:…", "planStepId": "s4", "agent": "transformScaffoldAgent",
    "primitives": [{ "kind": "dedup", "version": 2 }],
    "packId": "01J…", "assertions": [{ "id": "01J…", "revision": "sha256:…", "trust": "verified", "usedFor": "dedup.keys" }],
    "overrides": [], "model": "provider/model-id", "generatedAt": "…" }
  ```
  For primitive-based generation, `usedFor` maps each decision-bearing parameter (keys, grain, incremental column, join keys, filters) to the assertion that justified it. `llmParamSelector` MUST supply this mapping, and a parameter that came from no assertion is recorded as `unbacked`.
- **Impact analysis:** when an assertion is superseded, rejected or fails verification, every artifact whose manifest references it is marked stale with the reason. This extends `ArtifactStalenessScanner` from spec-version granularity to fact granularity. The panel shows *"stg_orders.sql is stale: order.grain changed (chat, 14 Oct, message 12)"*.
- **"Why?" command:** `AutoDE: Explain This Artifact` (also on selection) shows the manifest as a readable chain: artifact → decisions → assertions → evidence.

### 8.4 Context health report

`AutoDE: Context Health` (and the MCP resource `autode://context/health`): counts by status and trust; conflicts; `needs_review`; stale; orphaned; unresolved subjects; share of seed entities with confirmed grain/keys; open context gaps. Shown as a compact panel widget. It is part of the validation-phase artifacts.

---

## 9. MCP surface additions (extends mcp-engine-requirements §5)

| Tool / resource | Purpose |
|-----------------|---------|
| `autode_resolve` `{ text }` | Deterministic entity resolution: candidate nodes with scores. |
| `autode_get_context_pack` `{ purpose, seeds?, query?, maxTokens }` | Same `ContextPackBuilder` the extension uses; returns text + `PackManifest`. |
| `autode_get_semantic_model` | The approved (or draft) semantic model. |
| `autode_list_assertions` `{ subject?, kind?, status?, trust? }` | Ledger query. |
| `autode_propose_assertion` `{ kind, subject, predicate, value, statement, evidence }` | External agents can enrich context. Always lands as `proposed` / `inferred`; never `active`. |
| `autode_verify_assertion` `{ id }` | Runs the matching probe (read-only). |
| `autode_check_grounding` `{ content, dialect }` | Grounding check of any SQL/YAML (§10.1); lets external coding agents self-check. |
| Prompt `autode_extract_assertions` | The extraction prompt (§5.2). |
| Resources `autode://context/health`, `autode://semantic/model`, `autode://ledger/assertion/{id}` | Read-only views with revisions. |

There is deliberately no `confirm` or `reject` tool over MCP: confirmation is a human action in the extension UI (principle P3).

---

## 10. Proving grounding and accuracy

### 10.1 Deterministic grounding checks (run on every generated artifact)

1. **Identifier resolution:** every table and column identifier in generated SQL/DDL/YAML resolves to an active node (lightweight identifier extraction per dialect: qualified names, `FROM`/`JOIN` targets, select-list columns, primitive params). Unresolved identifiers → `GROUNDING_UNRESOLVED` warning on the artifact, listed in the report.
2. **Decision backing:** every decision-bearing primitive parameter is backed by an assertion of the required trust (§7.3), or the artifact carries an explicit override.
3. **Type compatibility:** casts and joins use compatible types per `schema_fact`s.
4. **Rule compliance:** STRICT rules with a machine-checkable form (e.g. PII masking via governance classification in the Pipeline Spec) are checked; the others are listed as "manual review required".

Results go into the manifest and into a per-run **Grounding Report** artifact (validation phase, rendered by `DocumentationAgent`).

### 10.2 Metrics (reported per run and per release)

| Metric | Definition | Target on the reference problem |
|--------|------------|---------------------------------|
| Identifier grounding rate | resolved identifiers / all identifiers in generated artifacts | 100% |
| Decision backing rate | decision parameters backed by ≥ `confirmed` assertions / all decision parameters | ≥ 95% (rest explicitly overridden) |
| Unbacked / unresolved count | absolute counts | 0 unresolved; unbacked only with overrides |
| QA accuracy | correct answers / questions in the reference question set (§10.3) | ≥ 90%; 0 confident wrong answers (wrong answers must say "not known") |
| Trap detection | reference traps caught (§10.3) | 100% |
| Stale-use count | artifacts generated using expired / `needs_review` facts without an override | 0 |
| Context pack efficiency | median pack tokens per step; share of pack assertions actually cited in manifests | reported (no target in v1) |

### 10.3 Reference business problem and evaluation harness

Add `test/reference/retail-orders/`. It must be small enough to run offline in CI and realistic enough to be convincing:
- `problem.md`: business problem statement (daily net revenue and customer retention reporting on Snowflake from 2 sources).
- `sources/`: DDL for 2 source systems (18 tables, 122 columns, deliberately sharing one table name across the two systems) plus small CSV samples, and a 40-table irrelevant schema for the dilution trap, ingested through `fileIngestion.ts` offline; an optional live mode loads them into a sandbox schema.
- `chat-script.yaml`: scripted engineer turns, including the traps below.
- `golden/assertions.yaml`, `golden/semantic-model.yaml`: expected confirmed context after the script.
- `questions.yaml`: ~30 questions with expected answers (grain, keys, join paths, metric definitions, rule applicability, and "unknown" cases).
- `expected-artifacts.yaml`: properties the generated artifacts must have (dedup keys, incremental column, SCD2 on customer, PII masking, metric expression), checked structurally rather than by exact text.
- **Traps** (each must be caught, by the inbox/conflict detector or by a probe):
  1. "Revenue" is defined two ways (gross in a document, net in chat) → conflict raised, not silently merged.
  2. A column is renamed mid-chat ("actually it's `cust_no`, not `customer_id`") → supersession, and any artifact using the old fact is marked stale.
  3. A claimed-unique `id` has duplicates in the sample CSV → the probe fails and the assertion goes to `needs_review`.
  4. A join is requested between two entities with no relationship in context → a context gap, not an invented join.
  5. An irrelevant 40-table schema is also ingested → it must not appear in step packs (dilution check).

Harness (`npm run eval`):
- **Replay mode (CI, deterministic):** LLM responses are recorded once per provider into cassettes (`test/reference/cassettes/<provider>/`) and replayed. Asserts every metric target in §10.2.
- **Live mode (manual, pre-release):** runs the same script against real providers (Copilot via `vscode.lm`, Claude Code, an API provider) to demonstrate LLM-agnostic behaviour, and writes `eval-report.md` with the metric table per provider.
- **Ablation:** the same run with the context pack replaced by the baseline `buildContextPrompt()` dump, to show the measured contribution of the context layer. The first eval phase records the **v0.26.0 baseline** before any context-layer change, so later phases can show the improvement.

---

## 11. Phases and acceptance criteria

These phases interleave with the MCP phases; the combined order and status are in [roadmap.md](roadmap.md). Each is one minor version.

### Phase C1: Reference problem, harness and baseline
Scope: §10.3 (fixtures, replay harness, metrics computation), with grounding checks §10.1 items 1 and 3 run *post hoc* on baseline output.
Acceptance: `npm run eval` runs offline; `eval-report.md` records baseline numbers for the current pipeline (expected to be poor; that's the point); traps 1–5 are recorded as detected or not.

### Phase C2: Assertion ledger and projection
Scope: §4 (Assertion, schemas, ledger, folding, compaction, projections, migration); conflict detector and supersession (§8.1). Also absorbs leftovers from the earlier "Phase 5 — grounding/retrieval" plan, and closes a deferred v0.19.0 gap:
- `ContextValidator` dispatches to the per-kind definitions already in `context-envelope.schema.json` but never referenced. Validation stays lenient for old persisted data: warn, don't fail.
- Every node's `origin.confidence` is filled from its supporting assertion's trust tier. Today the field is optional and almost never set.
- The settings-panel Connect / Source Assessment flow (`extension.ts`) still writes no `SourceContext` record (the gap deferred in v0.19.0). It now writes `schema_fact` assertions to the ledger. They are project-wide (`specId` unset) when no business problem is active, which answers the open "spec-scoped vs project-level" question without reshaping `SourceContext`.
Acceptance: migration is idempotent and graph-equivalent (test); folding is deterministic (same ledger → byte-identical projection); conflict and supersession unit tests; trap 1 detected in replay.

### Phase C3: Context packs, manifests and causality
Scope: §7.1, §7.3, §8.3, §10.1 (all checks), Grounding Report; `buildContextPrompt()` becomes a wrapper; every hub/agent LLM call uses a pack.
Acceptance: every artifact written has a manifest; "What the agent saw" and "Explain This Artifact" work; trap 4 (context gap) and trap 5 (dilution) pass in replay; identifier grounding rate is reported per run.

### Phase K: Estate identity, per-system catalogs and the working-set cache
**Status:** split into **K1** — items 1–3, 6, 7, 9, 10 — ✅ shipped in v0.31.0 (see CHANGELOG.md; WHAT/WHY in requirements.md STC-6, STC-10, PLT-6, NFR-7; HOW in technical-design.md §5.11), and **K2** — items 4, 5, 8, 11, 12 and the large-estate and vocabulary fixtures — planned for v0.32.0. The text below stays as K2's specification and K1's record.

Added 2026-10-15 (after C3). Estate merge and legacy migration/modernisation are the common engagements; both need several source systems and a target side by side, and estates larger than the §1 design target.

**Gaps verified against the code (v0.30.0):**
- Live table node ids are `table-<fqn>` with no system or connection in them (`BaseAdapter.snapshotToGraph`): two platforms that both hold `SALES.PUBLIC.CUSTOMERS` become one node.
- Live extraction hard-codes `origin.environment: 'source'`, and the `schema-graph.json` merge (v0.29.0) replaces nodes by `origin.sourceRef`, which is only the platform name, so extracting a second schema of the same platform retracts the first one's tables.
- Each extraction covers exactly one database and schema (`WHERE table_schema = '<schema>'`). `ExtractOptions.schemaFilter` exists but nothing reads it.
- Column profiling runs one full-scan query per column, sequentially, with a 30-second timeout each (`BaseAdapter.profileColumns`).

**Scope:**
1. **Identity model.** `ObjectRef { system, environment, location: { platform, account?, database, schema, object, column? } }`. The canonical node id is `obj:<system>/<environment>/<database>.<schema>.<object>[.<column>]`. A *system* is a logical source or target (e.g. "Shop OMS", "CRM", "EDW target"). Roles (`source` | `target` | both) attach to a system, or to a schema within it, never to a connection, so in-place modernisation (RAW → CURATED in one account) and dev/test/prod are expressible. Recorded in a new `.ai-context/estate.yaml` (systems, environments, which connection and schemas feed which system, roles). Connections and file imports are assigned to a system when created; an unassigned one gets a system named after it.
2. **Migration of existing ids.** Existing nodes are re-keyed to `obj:` ids. The ledger records an alias map (old id → new id), so assertion subjects, packs and grounding manifests written before K still resolve. Re-keying is idempotent, and the re-keyed graph is equivalent to the old one apart from ids (test).
3. **Per-system catalogs.** Extraction is tagged with system and environment; one connection can feed several schemas (wire `schemaFilter`, accept a list). The `schema-graph.json` merge is keyed by `(system, environment, database.schema)`.
4. **Tiered working-set cache, populated incrementally** (not a mirror of the estate):
   - *Tier 0, name index*: database, schema and object names plus table comments, only for the databases/schemas the engineer selects.
   - *Tier 1, structure*: columns, types, keys and tags, loaded when an object enters scope (named in a spec or document, a pack seed, browsed or mapped).
   - *Tier 2, profile*: null rates, distinct counts, freshness, only for objects a step uses; sampled, in parallel with a bounded concurrency, within a per-run query budget. This replaces per-column sequential profiling.
   - *Query-through on a miss*: a name in tier 0 whose structure isn't loaded is fetched live when a connection exists; offline, the pack raises a context gap (`structure of <object> not loaded`).
   - *Eviction*: tier 1 and 2 entries referenced by no spec, assertion or pack for N days (setting, default 30) drop back to tier 0.
   - Storage: in memory plus JSON under `.ai-context/catalog/<system>/<environment>/` (git-ignored, rebuildable). Whether an embedded database is needed is decided from the scale fixture's measurements (acceptance below), not up front (P6).
5. **Refresh on use**, no background sync: an in-scope object older than its TTL (§8.2: schema facts 7 days) is re-checked by its last-altered timestamp when it is seeded and before plan execution; a change becomes supersession through the existing sync and dependency walk.
6. **Catalog revision pinned in manifests**: `catalogRevisions: { "<system>/<environment>": <watermark> }` on every grounding manifest, so an artifact's context is reproducible after the catalog moves on.
7. **Legacy catalog import** for sources with no live connector: column-dictionary exports as CSV (Teradata `DBC.ColumnsV`, Oracle `ALL_TAB_COLUMNS`, SQL Server `INFORMATION_SCHEMA.COLUMNS`, recognised by their header names), alongside the existing DDL import, each assigned to a system.
8. **Visibility**: when tier 0 knows objects whose structure the engineer's grants don't reveal, packs say so (`N objects in scope are not visible with your current grants`) instead of omitting them silently.
9. **Grounding per side**: identifier checks resolve source references against source systems, and target references against the target system plus the planned objects of the approved Pipeline Spec. Planned objects stay owned by the Pipeline Spec; the catalog holds only what exists.
10. **Namespaced ids for every kind**, not only physical objects: `term:`, `rule:`, `metric:`, `query:` alongside `obj:` — the intent of the original ID-scheme requirement (stable, readable, collision-free; requirements.md STC-10), which was never implemented. Same alias-map migration as item 2.
11. **The extension host is never blocked for long** (requirements.md NFR-1): no single synchronous task during ingestion, catalog sync, ledger sync, projection or pack building runs longer than 100 ms on the large-estate fixture; long work yields, reports progress and can be cancelled. VS Code runs extensions in their own process, so the editor itself stays responsive regardless — what a blocked extension host freezes is AutoDE's panel and every other extension, Copilot included. How (chunking, a worker thread, or the engine process once the extension talks to it over MCP in Phase 5) is a design choice recorded in technical-design.md.
12. **Retrieval that survives vocabulary mismatch** (requirements.md GRD-8 — the need behind the original embeddings requirement, kept and restated): finding the right tables when the request's words differ from physical names — synonyms ("client" vs `customers`), abbreviations (`CUST_NO`, `TXN_AMT`), or the other organisation's terms in a merge. Deterministic signals first: glossary bindings and aliases, an abbreviation-expansion dictionary (governed, extensible per customer), column and table comments, and ranked full-text scoring over names and comments. Embeddings are not adopted in K; they become an optional, opt-in ranking signal (phase RET in the roadmap) only if the vocabulary-mismatch questions below still miss after this.

**Fixtures:** retail-orders extended into a merge where both sources contain an identically named fully qualified table; a dev/prod pair of one system; a legacy dictionary export; a generated large estate (~2 000 tables, ~50 000 columns, with name collisions across schemas); and a **vocabulary-mismatch question set** (synonyms, abbreviations, cross-organisation terms) over the merge and legacy fixtures.

**Acceptance:** identically named tables from two systems stay distinct end-to-end (graph, ledger subjects, packs, manifests); extracting a second schema does not retract the first; re-keying an existing workspace is idempotent and loses no assertion; profiling never exceeds its query budget; an offline miss raises a gap; manifests carry catalog revisions; the eval report records ingest time, memory, sync time, pack build time and the longest synchronous task on the large estate (≤ 100 ms), packs still exclude unrelated schemas there, and the embedded-database decision is recorded with those numbers; the vocabulary-mismatch questions' seed recall is reported, and the RET decision is made from it.

### Phase C4a: Business-problem pack, discovery-first gap closing, conformance
Added 2026-10-15; the document, discovery and validation half of the original C4, pulled ahead of the MCP track. A business problem is whatever the customer has: a paragraph, one document, or a set of documents (a BRD, KPI definitions, a data contract, a mapping workbook, a data dictionary). These are rarely in a standard format: the merger demo's data contract was YAML in a house format. AutoDE builds the specification from them, closes gaps by discovery and validation, and interviews only for what remains.

**Scope:**
1. **Business-problem pack.** Register documents with a *role* (`contract`, `brd`, `kpi_definitions`, `mapping`, `data_dictionary`, `other`), an *authority* (`signed` → assertions enter at `confirmed`; `draft` → `documented`) and a version. Text-based formats (txt, md, yaml, json, csv), as attachments are stored today; binary formats (docx, pdf) need a text-extraction step and are out of scope for C4a.
2. **Interpretation profiles** for structured documents with a non-standard shape (YAML, JSON, CSV). The LLM reads the document's structure once and proposes a mapping from its paths to AutoDE's model (e.g. `entities[].fields[].name` → column, `.mandatory: yes` → not null, `rules[]` → quality expectations), returned as Ajv-validated JSON. The engineer confirms or corrects it once. It is then applied **deterministically** to every entry, and re-applied to later versions of the document, so a new version is a precise diff: only the changed clauses are superseded. Profiles are stored under `.ai-context/profiles/` and can be reused for documents of the same shape.
3. **Free-text extraction** (BRDs, notes, unstructured documents) per fact, through the governed extractor prompt (§5.2), landing as `proposed` / `inferred`.
4. **Provenance at clause level**: `Evidence.ref = <file>#<yaml-path | section | line-range>@<content-sha>`. "Explain This Artifact" and the inbox show the exact clause.
5. **Normative vs descriptive.** Contract clauses are expectations (`quality_expectation`, and a new `contract_schema` predicate for expected column / type / nullability), never `schema_fact`. A contract never overwrites what a catalog observed; a difference is a conformance violation.
6. **Computed gaps**: SpecOps' per-field coverage plus the required fact classes per in-scope entity (keys, grain, joins, metric definitions; §7.3 minimum trust).
7. **Discover → validate → ask.** Gaps are closed by machines first:
   - discovery fills structural facts (tables, columns, declared keys) through K's tiered cache;
   - validation runs probes (§5.3) on claims the documents make;
   - the interview then asks only about what is left: business intent, decisions, unresolved conflicts ("the contract says X, source B shows Y; which applies?"), and facts below the required trust.
8. **Probes without the MCP dependency.** The §5.3 probes (fixed templates per kind and dialect, read-only, aggregates only — never row values) run through the engine's `ConnectionManager`. They need no sample-data consent because they return no row values; they move behind `autode_execute_query` when Phase 4 lands. Results are `verified` / `verification_failed` events.
9. **Conformance report** (discover-phase artifact): each source system against the contract, clause by clause. Schema conformance comes from the catalog; data conformance (nulls, uniqueness, accepted values, join orphan rates) comes from probes.
10. **Spec from the pack.** The generated Business Problem Specification records intent and scope (objectives, entities in scope, decisions, constraints) and *references* the assertion ids of detailed clauses instead of copying them, so the spec and the contract can't drift apart.

**Fixtures:** a house-format contract YAML for the merge reference problem (source A conforms; source B violates it in known places: a type, a nullability, a missing column, a duplicate key), a second version of that contract with three changed clauses, and a free-text BRD.

**Acceptance:** every planted violation in source B appears in the conformance report and no false one appears for source A; re-applying the profile to contract v2 supersedes exactly the three changed clauses; BRD facts land as proposed with section-level provenance; the interview asks no question that discovery or a probe answered (test: no question about a key the DDL declares); trap 3 (duplicate `member_id`) passes through a probe; a test asserts probes never return row values.

### Phase C4b: Chat extraction, Context Inbox, tool-action memory
The remainder of the original C4.
Scope: what C4a doesn't cover of §5 (chat and interview extraction §5.2, Context Inbox §5.4); §7.2 cited Q&A; MCP additions in §9 (`autode_propose_assertion`, `autode_verify_assertion` — probes move behind `autode_execute_query` here). Context gaps (C3) pause the step from this phase on, since the inbox lets the engineer answer them. Also absorbs the open phase 5 of the earlier chat-memory plan, **tool-action memory**:
- `AgentHub.chat()` returns the tool audit it already collects (`ToolCallAuditEntry[]`).
- The chat handler appends one compact `log` message per meaningful action (file written, command run) to the transcript.
- Structured history includes those entries. For Anthropic and Gemini they are folded into the adjacent assistant turn, because those APIs require strict user/assistant alternation.
- Actions that change context (e.g. a written spec file) are also recorded as ledger evidence.
Acceptance: the scripted chat produces the golden assertions (≥ 90% match, the rest surfaced in the inbox); trap 2 passes; extraction never blocks or fails a chat turn (fault-injection test); chat answers cite assertion ids.

### Phase C5: Semantic model
Scope: §6, including dbt and Snowflake semantic-view export primitives (Databricks metric views where supported) and C3 consumption by the modeling/STTM/transform agents. Depends on mcp-engine Phase GOV (governance-as-code): the model's `rules` and PII classifications come from GOV's governance assertions, and the reference problem's masking expectations need GOV's `mask` primitive.
Acceptance: projected model equals `golden/semantic-model.yaml` after the scripted run; exports pass primitive conformance tests; no agent emits a join or metric absent from the model (a grounding check enforces this).

### Phase C6: Freshness, health and release evaluation
Scope: §8.2, §8.4; eval report becomes part of the release checklist.
Acceptance: every metric target in §10.2 is met in replay mode; the live-mode report has been produced for at least two LLM providers; the ablation shows the context layer's contribution.

---

## 12. Out of scope

- Vector databases and embedding models (they'd add a dependency and runtime; lexical + alias + graph retrieval is sufficient at the target size, §1). This supersedes the earlier "Phase 5" plan's provider-sourced embeddings design. Revisit only if a C1/C6 evaluation shows retrieval misses that alias and graph expansion can't fix. *(2026-10-15)* That evaluation is now part of Phase K (vocabulary-mismatch question set); if it shows such misses, embeddings come in through phase RET as an optional, opt-in ranking signal — never a requirement, and never the only way to find context.
- Replacing an enterprise catalog (Horizon, Unity Catalog, Atlan, etc.). Importing from catalogs is a future *source* of `documented` assertions via the same ledger, not a reason to build one.
- Auto-confirming LLM-proposed assertions, and confirmation over MCP.
- LLM-written verification probes.
- *(2026-10-15)* A full local mirror of a customer's catalog with periodic background sync. A per-laptop copy goes stale, differs between engineers (different sync times and grants) and so breaks reproducibility, loads the customer's warehouse once per engineer, and exports estate-wide metadata to laptops that security reviews often reject. Phase K's working-set cache with query-through and refresh-on-use replaces it. A shared, team-wide catalog cache would need a remote MCP deployment (mcp-engine §10) and is revisited only if a customer needs it.
- *(2026-10-15)* Converting legacy code (stored procedures, BTEQ, PL/SQL, ETL-tool mappings). Mature converters exist (e.g. Snowflake SnowConvert, Databricks Lakebridge); the migration track imports their output and grounds, maps and reconciles it instead.
- *(2026-10-15, parked)* ERP sources with cryptic physical names (SAP-style), which need the ERP's own text dictionary as aliases. Not rejected; deferred until a customer needs it.

## 13. Documentation deliverables

Same conventions as mcp-engine-requirements §11. Update the affected requirements in `docs/requirements.md` (WHAT/WHY, by ID) and add a "Context layer" chapter in the onboarding guide covering the assertion lifecycle (proposed → active → superseded), trust tiers, and how to read a grounding manifest.
