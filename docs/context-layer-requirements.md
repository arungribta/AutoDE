# AutoDE — Context Layer, Semantic Model & Grounding: Requirements Specification

**Status:** Proposed · **Baseline:** v0.24.0 (`6f09e62`) · **Companion to:** [mcp-engine-requirements.md](mcp-engine-requirements.md) (read §0 and §1 there first; its implementation rules and principles P1–P7 apply here unchanged)
**Audience:** the coding agent implementing this, and the reviewers approving each phase.

---

## 1. Intent

AutoDE's output is only as accurate as what it knows about the business problem and the data. This specification turns the context layer from a **static dump of discovered metadata** into a **governed, continuously enriched, provenance-tracked knowledge layer**. Every chat turn, interview answer, attachment and discovery run can add to it. Every generated artifact can show exactly which facts it was built on. And AutoDE can **measure** its own grounding on a reasonably sized business problem.

Industry direction this follows (adopt the principles, not the products):
- **Snowflake Horizon Context**: metadata is *collected* from sources, *enriched* with business definitions, and *delivered* to agents. AutoDE maps this to discover → enrich → deliver (§4–§7).
- **AtScale-style universal semantic layer**: agents consume a governed model of metrics, relationships and policies through MCP, and **do not infer joins or KPI definitions themselves**. AutoDE adopts this as principle C3.

"Reasonably sized" (the design target for this spec): up to ~5 source connections, ~200 tables, ~5 000 columns, ~1 000 assertions per business problem. At this size everything stays in memory, with no vector database and no embeddings dependency (P6).

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

| # | Principle |
|---|-----------|
| C1 | **Assertions, not blobs.** The unit of context is an *assertion*: one claim about one subject, with provenance, trust, status and validity. The graph and the semantic model are *projections* of the assertion ledger. |
| C2 | **Nothing is silently overwritten.** Changes supersede; contradictions are surfaced; history is retained. |
| C3 | **Agents do not infer what the context layer defines.** Joins, grain, keys, metric formulas and business rules used in generation come from confirmed or verified assertions. If one is missing, the agent asks; it does not guess silently. |
| C4 | **Trust is explicit and ordered:** `verified` (checked against live data/metadata) > `confirmed` (a human approved it) > `documented` (from a file or document) > `inferred` (proposed by an LLM). Generation records which tier it relied on. |
| C5 | **Deliver less, but the right context.** Each LLM call receives a task-scoped, token-budgeted *context pack*, and the pack's contents are recorded. |
| C6 | **Every artifact is explainable.** It carries a grounding manifest linking it to the exact assertion revisions, spec revision, primitive versions and context pack used. |
| C7 | **Grounding is measured, not claimed.** A reference problem and harness report grounding and accuracy numbers for every release. |
| C8 | **Deterministic core, LLM at the edges.** Ledger, projection, retrieval, conflict detection, verification probes and grounding checks are deterministic engine code (D5). Only *proposing* assertions from natural language uses an LLM. |

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
- `sources/`: DDL for 2 source systems (~18 tables, ~180 columns) plus small CSV samples, ingested through `fileIngestion.ts` offline; an optional live mode loads them into a sandbox schema.
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

These phases interleave with the MCP phases; the combined order is in mcp-engine-requirements §9. Each is one minor version.

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

### Phase C4: Enrichment from chat, interview and discovery; Context Inbox; probes
Scope: §5 in full; §7.2 cited Q&A; MCP additions in §9. Depends on the MCP platform phase, since probes run through `autode_execute_query`. Also absorbs the open phase 5 of the earlier chat-memory plan, **tool-action memory**:
- `AgentHub.chat()` returns the tool audit it already collects (`ToolCallAuditEntry[]`).
- The chat handler appends one compact `log` message per meaningful action (file written, command run) to the transcript.
- Structured history includes those entries. For Anthropic and Gemini they are folded into the adjacent assistant turn, because those APIs require strict user/assistant alternation.
- Actions that change context (e.g. a written spec file) are also recorded as ledger evidence.
Acceptance: the scripted chat produces the golden assertions (≥ 90% match, the rest surfaced in the inbox); traps 2 and 3 pass; extraction never blocks or fails a chat turn (fault-injection test); chat answers cite assertion ids.

### Phase C5: Semantic model
Scope: §6, including dbt and Snowflake semantic-view export primitives (Databricks metric views where supported) and C3 consumption by the modeling/STTM/transform agents. Depends on mcp-engine Phase G (governance-as-code): the model's `rules` and PII classifications come from G's governance assertions, and the reference problem's masking expectations need G's `mask` primitive.
Acceptance: projected model equals `golden/semantic-model.yaml` after the scripted run; exports pass primitive conformance tests; no agent emits a join or metric absent from the model (a grounding check enforces this).

### Phase C6: Freshness, health and release evaluation
Scope: §8.2, §8.4; eval report becomes part of the release checklist.
Acceptance: every metric target in §10.2 is met in replay mode; the live-mode report has been produced for at least two LLM providers; the ablation shows the context layer's contribution.

---

## 12. Out of scope

- Vector databases and embedding models (they'd add a dependency and runtime; lexical + alias + graph retrieval is sufficient at the target size, §1). This supersedes the earlier "Phase 5" plan's provider-sourced embeddings design. Revisit only if a C1/C6 evaluation shows retrieval misses that alias and graph expansion can't fix.
- Replacing an enterprise catalog (Horizon, Unity Catalog, Atlan, etc.). Importing from catalogs is a future *source* of `documented` assertions via the same ledger, not a reason to build one.
- Auto-confirming LLM-proposed assertions, and confirmation over MCP.
- LLM-written verification probes.

## 13. Documentation deliverables

Same conventions as mcp-engine-requirements §11. Add `docs/requirements.md` §20 "Context Layer, Semantic Model & Grounding" and a "Context layer" chapter in the onboarding guide covering the assertion lifecycle (proposed → active → superseded), trust tiers, and how to read a grounding manifest.
