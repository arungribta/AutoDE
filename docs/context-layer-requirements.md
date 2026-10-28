# AutoDE — Context Layer, Semantic Model & Grounding: Requirements Specification

**Status:** In progress — order and status: [roadmap.md](roadmap.md) · **Baseline:** v0.24.0 (`6f09e62`) · **Companion to:** [mcp-engine-requirements.md](mcp-engine-requirements.md) · **Document map:** [README.md](README.md) (read §0 and §1 there first; its implementation rules and principles P1–P9 apply here unchanged)
**Audience:** the coding agent implementing this, and the reviewers approving each phase.

---

## 1. Intent

AutoDE's output is only as accurate as what it knows about the business problem and the data. This specification turns the context layer from a **static dump of discovered metadata** into a **governed, continuously enriched, provenance-tracked knowledge layer**. Every chat turn, interview answer, attachment and discovery run can add to it. Every generated artifact can show exactly which facts it was built on. And AutoDE can **measure** its own grounding on a reasonably sized business problem.

Industry direction this follows (adopt the principles, not the products):
- **Snowflake Horizon Context**: metadata is *collected* from sources, *enriched* with business definitions, and *delivered* to agents. AutoDE maps this to discover → enrich → deliver (§4–§7).
- **AtScale-style universal semantic layer**: agents consume a governed model of metrics, relationships and policies through MCP, and **do not infer joins or KPI definitions themselves**. AutoDE adopts this as principle C3.

"Reasonably sized" (the design target for this spec): up to ~5 source connections, ~200 tables, ~5 000 columns, ~1 000 assertions per business problem. At this size everything stays in memory, with no vector database and no embeddings dependency (P6).

*Revised 2026-10-15:* estates larger than this are common (estate merge, legacy migration). The target above now describes a business problem's **working set**; the estate around it is handled by Phase K's per-system catalogs and tiered working-set cache, and an embedded store is adopted only if K's scale measurements require it.

### 1.1 Enterprise context (owner, 2026-10-28)

The owner reviewed a proposal for an "enterprise context and semantic intelligence platform" of eleven layers, consulted by every agent before it decides. AutoDE adopts the intent: agents decide from enterprise knowledge with evidence, not from prompts alone, and every capability (mapping, SQL, models, pipelines, quality, governance, impact, documentation) uses it. AutoDE does not adopt the proposal's architecture of separate repositories:
- Most of the layers already exist here under other names.
- The customer's enterprise tools are sources and export targets. AutoDE doesn't rebuild them (§6.9, §12).
- A vector store stays out (§12).
- The semantic layer stays Snowflake semantic model YAML.

| Proposed layer | In AutoDE | Added by |
|---|---|---|
| Metadata repository | Estate, catalogs, profiles (K1, K2) | Owner and domain on objects; non-table assets where lineage names them (§8.5, LIN) |
| Business semantics: glossary, metrics, rules | Vocabulary and `business_term` facts; the semantic layer (§6); `business_rule` facts | Terms gain a scope and a meaning (§6.8, ONT1) |
| Ontology | — | Canonical ontology: upper layer, industry packs, extensions (§6.8, ONT1) |
| Knowledge graph | Graph projection (§4.3) | Concept, domain, owner, pipeline and policy nodes; traversal tools (C5b, LIN, ONT1) |
| Lineage | The adapters extract lineage edges; nothing stores them | Observed, designed, generated and logical lineage; impact analysis (§8.5, LIN) |
| Entity resolution | `resolveText`, vocabulary, column matching with mapping precedents | Resolution through concepts, returning the evidence chain (§6.8, ONT2) |
| Pattern library | Primitives, declarative primitives, platform skills | SCD2, CDC merge, snapshot; pipeline-type recommendation (§7.6, PAT) |
| Governance repository | Classifications and masking (GOV) | Policies as data; applicable policies per asset (ONT2) |
| Agent memory | `decision` facts, team-wide predicates, mapping precedents, Team Knowledge | Scoped preferences that rank candidates (§7.6, PAT) |
| Vector retrieval | Not adopted (§12) | — |
| Context APIs | Context packs, `autode_resolve`, assertion queries | Asset context (§7.5, C5b) |

The proposal's workflow enhancements map to phases:

| Enhancement | Delivered by |
|---|---|
| Source-to-target mapping through meaning; quality rules inferred from semantics | ONT2 |
| SQL generation aware of semantics, governance and patterns | C5b grounding, ONT2, PAT |
| Pipeline design recommendation | PAT |
| Cross-domain lineage and impact analysis | LIN |
| Data contracts and design recommendations | PAT |

Its explainability shape (decision, reason, evidence, confidence) is adopted with one change: confidence is derived from the trust of the backing facts, not a number a model states (§7.5).

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

## 3. Context principles (in addition to P1–P9)

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

- Append-only JSON Lines under `.autode/knowledge/ledger/` with one file per writer session: `<yyyy-mm-dd>.<sessionUlid>.jsonl`. Appending to separate files keeps git merges conflict-free when a team shares a workspace.
- Event types: `asserted`, `confirmed`, `rejected`, `superseded`, `verified`, `verification_failed`, `flagged_needs_review`. Every event carries `id`, `assertionId`, `at`, `actor`, and `causedBy` (the event or evidence id that triggered it). `causedBy` is what makes causality traceable (§8).
- Folding all events gives the current assertion set. Compaction: an `AutoDE: Compact Context Ledger` command writes `.autode/knowledge/ledger/snapshot.json` plus the events after it. It never deletes history unless the user explicitly runs it with `--prune`.
- All writes go through `ContextStore` (mcp-engine-requirements §4.3).

### 4.3 Projections (derived, rebuildable, never hand-edited)

1. **Context graph.** `GraphManager` is rebuilt from active assertions. Existing node and edge types stay. Nodes gain `supportedBy: string[]` (assertion ids), and edges gain the same. The existing `Origin` remains for compatibility and is filled from the strongest supporting assertion.
2. **The semantic layer is not a projection** (decided 2026-10-27): it is an authored, versioned artifact (§6) that the knowledge layer drafts from and checks against.
3. **Governed containers.** The Business Problem Spec, Source/Target/Mapping context and Pipeline Spec stay the human-approval units and keep their files and versioning. Approving a container sets every `proposed` assertion it contains to `active` with trust ≥ `confirmed`. Editing an approved container emits `superseded` events rather than rewriting.

Migration: on first load, existing graph content (`GraphPersistence` snapshot, `business-context.yaml`, verified queries, data definitions, file ingestion, live discovery) is converted into assertions. Trust is `verified` for `reliability: 'live-verified'` origins, `documented` for file-derived ones, `inferred` for `OriginSource 'llm'`, and `confirmed` for content inside already-approved containers. The migration MUST be idempotent and MUST produce the same graph as before (test: node and edge sets equal pre/post).

---

## 5. Enrichment — how discovery and chat feed the context layer

### 5.1 Sources of assertions

| Source | Module today | Produces | Initial trust / status |
|--------|--------------|----------|------------------------|
| Live discovery (schema) | the `source-assessor` role through `autode_ingest_metadata` (until v0.45.2 `SourceAssessmentAgent`), `BaseAdapter.extractMetadata()` | `schema_fact`, declared keys / FKs | `verified` / `active` |
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

### 5.5 Capture coverage and verification (C4c; owner, 2026-10-27)

**Status:** ✅ shipped in v0.48.0. What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md CTX-13; HOW: technical-design.md §5.15; usage: [user-guide.md](user-guide.md) §8.5–8.6. The full specification text is in git (this file at v0.47.0).

In short: capture doesn't depend on the model to find facts, decide what should be known, or be believed unchecked. A deterministic completeness checklist per table and metric, each missing item with its action; keys, grain, foreign keys, change columns and personal data found from the data and checked by probes; document facts checked against verbatim quotes, every section accounted for, tables and fixed phrases parsed without a model, agreement across sources; the model recorded on each fact, with optional double reading; an end-of-session review of chat. The model benchmark (recall and precision per source type, on the reference problem) and corrections counted as misses are part of C6.

## 6. Semantic layer

*Decided with the owner, 2026-10-27; replaces the earlier "semantic model projected from assertions". Built in phases C5a–C5d (§11); C5a (§6.1–6.5, the editor) shipped in v0.49.0. Ontology and terminology (§6.8), imports (§6.9) and the Knowledge Explorer (§6.10) were added on 2026-10-28 (§1.1).*

### 6.1 Two layers

- **The semantic layer** holds the governed business definitions as YAML files: what a metric means, which dimensions can slice it, how tables join for analysis, the questions it answers. They are authored (by people and agents), versioned in git, approved by a person, and deployed to the platform. It is a deliverable: what a BI tool or Cortex Analyst uses.
- **The context layer** holds what AutoDE knows about the data, with evidence and trust: the knowledge (the facts in the ledger, the estate and its catalogs, the vocabulary, the pack's documents) and the **graph**, which links physical objects, facts and the semantic layer's elements. The context layer **uses** the semantic layer: packs and grounding read its approved definitions, so an agent can't invent a join or metric the semantic layer lacks.

**Authority.** Facts about the data — keys, grain, observed relationships, classifications — belong to the knowledge layer. Business definitions — metrics, dimensions, filters, synonyms, verified queries — belong to the semantic layer once approved. A metric stated in chat is recorded as a fact (a proposal with evidence); approving it into a semantic model makes the model the authority. Verified queries move from the knowledge files into the semantic layer's `verified_queries`. The glossary stays in the knowledge layer as vocabulary; a term bound to a column appears as a synonym in the semantic layer.

### 6.2 Files

```
<artifactDirectory>/                    deliverables (setting artifactDirectory, default autode-output)
  semantic/<subject>.yaml               shared semantic models, one per subject area (sales, customer, finance)
  <problem-id>/semantic/<name>.yaml     the use case's composite (AutoDE format, §6.4)
  <problem-id>/semantic/<name>.resolved.yaml   generated: self-contained Snowflake YAML, what is deployed
.autode/semantic/                       AutoDE's metadata only: backing facts per element, review state,
                                        approvals, the shared revisions a composite was resolved from
```

A problem records which shared models and composites it uses or produces.

### 6.3 Shared semantic models

The native format is **Snowflake's semantic model YAML** (the format of `SYSTEM$CREATE_SEMANTIC_VIEW_FROM_YAML` and Cortex Analyst): `name`, `description`, `tables` (each with `base_table`, `primary_key`, `dimensions`, `time_dimensions`, `facts`, `metrics`, `filters`, synonyms and descriptions), `relationships` (`left_table`, `right_table`, `relationship_columns`, `join_type`, `relationship_type`), `verified_queries` and `custom_instructions`. A shared model stays deployable as is: AutoDE's metadata never goes into it (Snowflake's validator may reject unknown keys), only into `.autode/semantic/`. Shared models carry the conformed dimensions (customer, date, product) once.

### 6.4 Composites (AtScale-style) and resolution

A use case composes shared models in a small AutoDE file:

```yaml
autode: semantic-composite/1
name: revenue_by_channel
description: Daily net revenue by sales channel for the retail-orders problem.
uses:
  - model: sales                       # autode-output/semantic/sales.yaml
    tables: [orders, channels]         # optional subset; default all
    metrics: [net_revenue]
  - model: customer
    tables: [customers]
add:                                   # the use case's own definitions
  metrics:
    - { table: orders, name: revenue_per_order, expr: "net_revenue / COUNT(order_id)" }
  filters:
    - { table: orders, name: web_only, expr: "channel = 'WEB'" }
  verified_queries: [ ... ]
describe:                              # descriptions and synonyms only
  orders.net_revenue: { synonyms: [net sales] }
```

Rules (checked deterministically; a violation refuses the composite):
- **No redefinition.** A composite may add metrics, filters and verified queries, narrow what it includes, and change descriptions and synonyms. It never changes a shared element's expression, key or join. A different calculation is a new metric with its own name.
- **No collisions.** Two shared models used together that both define a table must define it identically (base table, key, columns); otherwise the check names the difference.
- **Resolution** produces `<name>.resolved.yaml`: one self-contained Snowflake semantic model, deterministic (same inputs, byte-identical output). It records the revision (checksum) of every shared model it used.
- **Staleness.** When a shared model changes, composites resolved from its earlier revision are stale (the workflow's stale state) until resolved again, which shows the diff.

### 6.5 Between the layers

- **Draft from knowledge.** AutoDE drafts semantic elements deterministically from confirmed facts: tables and primary keys from key facts, relationships from relationship facts (direction and type from cardinality), time dimensions and dimensions from column types, facts and metrics from metric facts, synonyms from bound glossary terms, personal-data notes from GOV classifications. A model may propose descriptions and synonyms; the person edits and approves.
- **Checks.** Against the estate: every base table and column exists, expressions use known columns, types fit. Against the knowledge: a relationship that contradicts a known key or grain, a primary key no fact supports, a metric whose fact says otherwise. Results are shown in the editor; nothing is synchronised silently.
- **Graph and packs.** Approved semantic elements become graph nodes linked to their physical columns and backing facts. Context packs include the definitions relevant to the task; the grounding check refuses a join or metric absent from the semantic layer.
- **Approval and stakes.** A change to a shared model is a workspace-level decision for a person (it affects every problem that uses it; it appears in *Waiting for you*). A composite is approved within its problem's workflow. Exploration mode (§7.4) relaxes the checks, not the authority.

### 6.6 Deployment and exports (C5c)

- **Snowflake:** a resolved model becomes a semantic view through `SYSTEM$CREATE_SEMANTIC_VIEW_FROM_YAML`, as a runbook step under the team's approval policy.
- **Databricks:** a metric view (YAML) through a runbook.
- **dbt:** MetricFlow `semantic_models` and `metrics` YAML, written as deliverables.

Translations are deterministic and tested like primitives. Emerging cross-vendor interchange formats are tracked as further export targets, not adopted internally.

### 6.7 Interfaces

- **Semantic Model editor:** a custom text editor on the YAML files (the file is the source of truth; undo, diffs and git come with it). It has a form view (tables, dimensions, metrics, relationships), a relationship diagram and the raw YAML. Check results are shown inline. Actions: draft from knowledge, resolve (composites), approve, deploy.
- **Knowledge Explorer** (renamed from "Knowledge Graph window" on 2026-10-28, when its scope grew): §6.10. A semantic element opens in the Semantic Model editor.
- **The sidebar's context drawer** becomes one status line linking both; its controls for the older knowledge files go.
- **CLI:** `autode semantic show | check | draft | resolve | approve`. **MCP:** read tools and a file resource; changes from agents are proposals.

### 6.8 Ontology and business terminology (owner, 2026-10-28; ONT1, ONT2)

Meaning has three layers:

```
canonical ontology      upper layer (always present, shipped with AutoDE)
  ├ industry packs      derived from a standard (FIBO first), grown per business problem
  └ extensions          the team's own concepts (ext:), including a house ontology
        ▲  means: exact | broader | narrower | related
business vocabulary     the organisation's terms, scoped: enterprise | line of business | system | problem
        ▲  bound to
semantic layer (§6.3) and the physical estate
```

Example: `fibo:LoanContract` ← enterprise term "Facility" ← system term "Deal" (scope: the legacy LOANSYS system) ← semantic table `loans` ← physical table `LOAN_APPL`. Every link carries evidence and trust, so the chain is the explanation an agent gives for what it matched.

**Canonical ontology.**
- **Upper layer.** It has eight concepts: Party, Agreement, Product, Account, Transaction, Location, Event and Document. Every industry pack places each of its concepts under one of them. This gives estates that span industries a common meeting point (C5d).
- **Industry packs.** A pack is a curated, problem-relevant subset of a standard, never the whole standard. FIBO, for banking, is first.
  - Each concept keeps its source IRI, its standard and the standard's pinned version, and its licence.
  - A pack holds concepts (each under a parent concept), relations (verb, target concept, cardinality hint), identifying and notable attributes, and synonyms.
  - It also holds hints: typical classifications and typical quality rules.
- **Extensions.** Concepts a standard lacks go under `ext:`, optionally marked `broader` than a standard concept. Most analytical concepts are extensions. A team's house ontology is an extension pack.
- **Light by design.** Classes, subclasses, relations with cardinality hints, and attributes. No OWL axioms and no reasoner. Packs are plain YAML (`autode: ontology-pack/1`): deterministic and diffable.
- **Grows on demand.** When a business problem touches a concept the workspace lacks, AutoDE offers it, with its one-hop neighbourhood, from the pack's source. A pack starts small (about 20–40 core concepts per industry) and grows with use.
- **Shared by every problem.** Importing, changing or deprecating a concept is a workspace-level decision for a person, the same as a shared semantic model change (§6.5). Concepts are deprecated, never deleted.

**Business vocabulary.** These are the existing vocabulary and `business_term` facts.
- A term gains a **scope**: the enterprise, a line of business, a named system, or one business problem.
- A term gains **`means`** links to concepts, each with a match type.
- Links are facts, with evidence and trust, reviewed in the Context Inbox.
- Resolution prefers the most specific scope and keeps the others.
- Legacy physical names (`cust_no`) stay vocabulary aliases. They are not terms.

**One place for meaning.** A term means a concept. Columns and semantic elements reach concepts through the terms bound to them, so meaning is never stated twice and can't drift. A semantic logical table with no term may align to a concept directly; the semantic check lists such tables.

**What it is used for:**
- Resolution returns the chain (column → alias → term → concept) as its evidence (ONT2).
- Column matching for mappings considers concepts (ONT2).
- Two systems' entities that mean the same concept become correspondence candidates; a person confirms (C5d).
- Pack hints become candidate classifications and quality rules at `documented` trust. They are never applied silently (ONT2).
- Concepts are graph nodes, so impact and cross-domain traversal pass through meaning.

The ontology never blocks a gate: a problem without a pack works as before.

**Onboarding a standard (ONT1).** A guided step in the Knowledge Explorer. The same steps exist on the CLI (`autode ontology …`) and over MCP, where analysis is read-only and the import is a proposal.
1. **Source:** a pack shipped with AutoDE, or a file or Git repository the user supplies (OWL in Turtle or RDF/XML, SKOS, or a pack). Nothing is downloaded automatically (P6). A Git source is staged with the same limits and checks as porting a skill (PA4).
2. **Analysis:** concepts, relations, modules, version and licence. If the licence forbids redistribution, the result stays in the team's workspace only.
3. **Scope:** the semantic architect proposes seed concepts from the problem's documents, vocabulary and estate, expanded one hop. The person adjusts them.
4. **Placement and terms:** each concept is placed under the upper layer, and `means` links are proposed for the workspace's vocabulary.
5. **Approval:** a person approves, as a workspace-level decision. The pack is written to `.autode/knowledge/ontology/`.

Packs shipped with AutoDE live in `ontologies/`. FIBO comes first; others follow when an engagement needs them and their licence allows redistribution, which is checked when each pack is planned. Other standards are imported from the team's own copy. Parsing OWL needs an RDF parser, which requires a P6 decision record (licence, size) at ONT1. Shipped packs are converted when AutoDE is built, so at runtime the parser is needed only for files a user supplies.

**The semantic architect (ONT1).**
- A new role template, `agents/semantic-architect.md`.
- Its skills cover:
  - semantic modelling: drafting and refining shared models and composites, synonyms and verified queries;
  - onboarding a standard: proposing seed concepts and their placement;
  - term alignment: proposing `means` links with evidence.
- The context curator keeps capturing facts, documents and vocabulary.
- A workflow template, `semantic-foundation`, runs the role: onboard a standard → align the vocabulary → draft shared models → approve.

### 6.9 Importing from semantic and catalog tools (IMP1–IMP4; owner, 2026-10-28)

The customer's tools are sources and export targets; AutoDE doesn't replace them (§12). The owner's order is AtScale, Snowflake Horizon, Collibra, then Unity Catalog, starting with AtScale.

- **AtScale (IMP1).** SML (Semantic Modeling Language, YAML) imports into shared models and composites:

  | SML | AutoDE |
  |---|---|
  | Datasets | Tables |
  | Dimensions and hierarchies | Dimensions (hierarchy levels go into descriptions; the Snowflake format has no hierarchies) |
  | Metrics and calculated metrics | Metrics |
  | Relationships | Relationships |
  | Models | Composites |

  Anything that doesn't translate is listed, never dropped silently. Export back to SML supports round trips. Both directions are deterministic and tested on golden files.
- **Horizon (IMP2):**
  - tags and classifications → governance facts;
  - comments → documented descriptions;
  - existing semantic views → shared models.

  Lineage comes from LIN's observed lineage.
- **Collibra (IMP3):** business assets (terms, definitions, domains, stewards) → scoped terms with owner and domain; Collibra's relations → `means` links and relationship facts.
- **Unity Catalog (IMP4):** tags, comments, owners and metric views, imported as above.

Imported items become `documented` facts or proposed semantic models, through the usual gates. An import can be run again: it supersedes only what changed, as interpretation profiles do (C4a). IMP2–IMP4 are specified when they are planned.

### 6.10 Knowledge Explorer (C5b; grown by LIN and ONT1; owner, 2026-10-28)

A webview panel, like the Workflow tab, where data engineers and architects explore what AutoDE knows. It should feel as professional and easy to use as a modern data catalog, inside the editor. It is read-only by default: every change goes through the existing channels (proposals, the Context Inbox, decisions, the Semantic Model editor).

- **Search everywhere.** One search box across objects, columns, terms, concepts, semantic elements, facts and artifacts. It matches names, aliases, synonyms and comments (K2's retrieval). Facets: type, system, environment, domain, owner, trust, status, classification and staleness.
- **Asset page** for every object, column, term, concept and semantic element. Its tabs:

  | Tab | Shows |
  |---|---|
  | Overview | Description, owner, domain, system and environment, freshness |
  | Schema | Columns, types, keys, classification, profile |
  | Meaning | Terms, the concept chain, semantic elements |
  | Lineage | Upstream and downstream (LIN) |
  | Facts | Facts with evidence, trust and history |
  | Governance | Classifications, masks, applicable policies |
  | Used by | Business problems, artifacts, semantic models, pipelines |

  Navigation: breadcrumbs, back and forward, and deep links into the Semantic Model editor, the file, or the Inbox.
- **Graph.**
  - Explore one hop at a time from any asset; filter by node and edge type; focus on or hide nodes.
  - A layered layout for lineage and a force layout for the ontology.
  - Trust is shown on every element, and gaps are shown, not hidden.
  - A cap on visible nodes, with "+N more".
  - Export as SVG or PNG.
- **Lineage and impact (LIN).**
  - Table and column level, upstream and downstream, with depth control.
  - Each edge is labelled observed, designed or generated.
  - Impact mode lists what a change would affect, grouped by schema, pipeline, semantic model, report, artifact and domain. The list exports as Markdown or CSV.
- **Ontology and glossary (ONT1).** The concept tree (upper layer → industry pack → extensions), terms by scope, the term-to-concept mapping view, unmapped terms and coverage. Onboarding a standard starts here.
- **Facts and estate.**
  - A filterable fact table; review hands off to the Context Inbox, which stays the to-do list.
  - Systems, environments, catalogs and connection readiness.
- **Quality bar.**
  - VS Code theme colours and fonts; keyboard navigation and screen-reader labels (UI-4).
  - Virtualised lists. The engine answers queries, so the webview never holds the whole estate, and it stays within NFR-1 on the large-estate fixture.
  - State is kept when the panel is hidden.
  - Empty states say what to do next.
  - A graph-rendering library, if one is used, is bundled (no CDN) and needs a P6 decision record.

**Every view has a CLI and an MCP equivalent**, so external AI agents, and data engineers without VS Code, can use the layers: search, asset context (§7.5), lineage, impact, concepts and terms, through `autode explore …` and the MCP read tools and resources (§9).

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

### 7.4 Exploration mode (per business problem; owner, 2026-10-27)

**Status:** ✅ shipped in v0.48.0. What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md ORC-11; HOW: technical-design.md §5.15; usage: [user-guide.md](user-guide.md) §5.4. The full specification text is in git (this file at v0.47.0).

In short: a business problem can run in exploration mode, switched by a person who acknowledges the disclaimer. At a context gap an agent records its best guess as an assumption (`assumed` trust) and continues; model proposals count at once at `assumed` trust; approval checks warn; gates take one click; everything produced is labelled. Never relaxed: runbooks, production policy (exploration targets non-production only), sample-data consent, secrets, rollbacks. Switching to governed lists the assumptions, model-only facts and warned checks; governed checks don't accept `assumed`. The semantic layer's checks (§6.5) will warn in exploration mode too.

### 7.5 Asset context and explainability (C5b; owner, 2026-10-28)

- **Asset context.** One deterministic function returns everything AutoDE knows about an asset, each item with its source and trust:
  - metadata;
  - meaning: terms, concepts and semantic elements;
  - lineage and governance;
  - applicable patterns;
  - memory: the decisions and preferences in scope.

  It backs the Knowledge Explorer's asset page, `autode explore asset` and the MCP tool `autode_get_asset_context`. A context pack (§7.1) is budgeted and task-centred; asset context is unbudgeted and asset-centred. What an agent's prompt receives is still a pack.
- **Explainability.** Every recommendation an agent records (a mapping, a primitive choice, a model decision, a pipeline type) carries:
  - the decision;
  - the reason;
  - the evidence: ids of facts, semantic elements, concepts, patterns, policies and lineage;
  - a confidence: the **weakest trust tier among the backing facts**, or `unbacked` when nothing backs it.

  Numbers appear only where AutoDE computes them deterministically, such as column-match scores. A model's self-reported confidence is not recorded as confidence.
- **Traceability.** The grounding manifest (§8.3) names each source with its category: semantic, metadata, pattern (primitive or skill), governance, ontology or lineage.

### 7.6 Patterns, preferences and recommendations (PAT; owner, 2026-10-28)

- **Patterns are primitives and skills, not code templates.** A pattern that generates code is a primitive: deterministic, versioned, with validated parameters, and grounded. Guidance is a skill.
  - New primitives: SCD2 (hash-diff), CDC merge (with deletes), snapshot, and the `incremental_load` watermark (from the backlog).
  - Orchestration patterns for other tools (Airflow, ADF, Fabric) wait until those become targets.
- **Pipeline-type recommendation.** A deterministic table chooses batch, micro-batch, CDC or streaming, explained as in §7.5. Its inputs are facts:
  - volume and change rate, from profiles;
  - latency and freshness, from `constraint` facts;
  - change columns and CDC availability, from the source;
  - platform standards and governance.

  A missing input is a context gap.
- **Preferences (memory).** `decision` facts gain a scope (team, domain or problem) and a polarity (prefer or avoid), for example "prefer hash-diff SCD2" or "avoid full reloads". Primitive candidates and recommendations are ranked by them and cite them. Human feedback is already recorded as corrections and rejections in the ledger.
- **Outgoing data contracts.** A contract for each produced table, generated from the semantic layer, governance, lineage and owners. The format is an open one (for example the Open Data Contract Standard), chosen when PAT is planned.

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

### 8.5 Lineage and impact (LIN; owner, 2026-10-28)

Today the platform adapters extract lineage edges, but nothing stores them. Lineage comes from four sources, and every edge is labelled with its source:

- **Observed** on the platform:
  - Snowflake: `ACCOUNT_USAGE.ACCESS_HISTORY` (column level; needs Enterprise edition and a granted role) and `OBJECT_DEPENDENCIES`.
  - Databricks: `system.access.table_lineage` and `system.access.column_lineage`.

  These are the adapters' fixed, read-only queries in the engine, not skills: deterministic, guarded by `sqlGuard`, and testable offline on recorded results. The platform skills say when to refresh lineage and how to read it. Observed lineage is optional: without the privilege, the other sources still work, and the Knowledge Explorer says which source is missing.
- **Designed:** approved mapping documents (column level) and Pipeline Specs (entity level). It works offline and is the guaranteed baseline.
- **Generated:** the grounding manifests of artifacts (the primitives' lineage).
- **Logical:** a semantic metric → its facts and dimensions → columns; a term → its concept.

Lineage edges are `derives_from` assertions in the working set. Observed edges are `verified`; edges from approved designs are `confirmed`. Observed lineage for the estate beyond the working set stays in the catalog and is read on demand, as in K2.

**Owner and domain.** Objects gain an owner (from the platform, an import, or a person) and a domain. A shared semantic model's subject area is a domain; objects in it inherit it unless stated otherwise. Cross-domain lineage is lineage whose ends lie in different domains.

**Traversals.**
- Upstream and downstream, depth-limited, at table or column level.
- Impact of a proposed change: a column renamed, dropped or retyped; a table removed; a fact superseded. The result lists what is affected, each item with the path that links it:
  - pipelines and artifacts (§8.3);
  - semantic models, composites and verified queries;
  - reports, where a lineage source names them;
  - domains, and the business problems that use them.

Impact uses graph traversal, never similarity. It is available on all three surfaces. A runbook proposal for a schema change includes the impact summary.

---

## 9. MCP surface additions (extends mcp-engine-requirements §5)

| Tool / resource | Purpose |
|-----------------|---------|
| `autode_resolve` `{ text }` | Deterministic entity resolution: candidate nodes with scores. |
| `autode_get_context_pack` `{ purpose, seeds?, query?, maxTokens }` | Same `ContextPackBuilder` the extension uses; returns text + `PackManifest`. |
| `autode_get_semantic_model` | The approved (or draft) semantic model. |
| `autode_list_assertions` `{ subject?, kind?, status?, trust? }` | Ledger query. |
| `autode_propose_assertion` `{ kind, subject, predicate, value, statement, evidence }` | External agents can enrich context. Always lands as `proposed` / `inferred`; never `active`. Since v0.41.0 (C4b) it records a `proposed` assertion in the ledger (attributed `mcp:<client>`); a person confirms it in the Context Inbox, or the agent confirms a low-stakes one with `autode_review_assertion`. |
| `autode_verify_assertion` `{ id }` | Runs the matching probe (read-only). |
| `autode_check_grounding` `{ content, dialect }` | Grounding check of any SQL/YAML (§10.1); lets external coding agents self-check. |
| Prompt `autode_extract_assertions` | The extraction prompt (§5.2). |
| Resources `autode://context/health`, `autode://semantic/model`, `autode://ledger/assertion/{id}` | Read-only views with revisions. |
| `autode_search_assets` `{ query, facets? }` (C5b) | The Knowledge Explorer's search. |
| `autode_get_asset_context` `{ asset }` (C5b) | Asset context (§7.5). |
| `autode_lineage` `{ asset, direction, depth, level }`, `autode_impact` `{ change }` (LIN) | Traversals (§8.5). |
| `autode_ontology_list`, `autode_ontology_concept`, `autode_ontology_analyze` (ONT1) | Read the canonical ontology; analyse a standard for onboarding (read-only). |
| `autode_propose_ontology_import` (ONT1) | Proposes an onboarding, a workspace-level decision for a person. `means` links go through `autode_propose_assertion`. |
| Resources `autode://asset/{id}`, `autode://ontology/{pack}` | Read-only views with revisions. |

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
**Status:** ✅ shipped in two parts — **K1** (identity and catalogs, items 1–3, 6, 7, 9, 10) in v0.31.0 and **K2** (working-set cache and scale, items 4, 5, 8, 11, 12, with the large-estate and vocabulary-mismatch fixtures) in v0.32.0. What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md STC-6, STC-7, STC-10, PLT-6, GRD-8, NFR-1, NFR-6, NFR-7, NFR-8; HOW: technical-design.md §5.11, §5.12, §6.3; measurements: `test/reference/retail-orders/baselines/v0.32.0-offline.md`. The embedded-store and RET decisions are in the roadmap's decision log. The full specification text is in git (this file at v0.31.0).

Added 2026-10-15 (after C3), because estate merge and legacy migration/modernisation need several systems side by side and estates larger than the §1 design target. In short: physical objects have estate-qualified ids (`obj:<system>/<environment>/<fqn>`); `.autode/knowledge/estate.yaml` records systems, environments, roles and which connections and files feed them; each system has a catalog in tiers (names, structure, profile) of which only the working set — what a problem uses — is mirrored into the graph and ledger; objects are loaded from the live source when a task needs them and re-checked when stale; packs report what is not loaded or not visible; retrieval matches abbreviations, synonyms, the customer's vocabulary, comments and glossary terms; and no synchronous task exceeds 100 ms at about 2 000 tables and 50 000 columns.

### Phase C4a: Business-problem pack, discovery-first gap closing, conformance
**Status:** ✅ shipped in v0.33.0 (items 1–11). What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md BPS-1, BPS-3, BPS-10, CTX-3, CTX-9, GRD-8, SEC-5; HOW: technical-design.md §5.13; measurements: `test/reference/retail-orders/baselines/v0.33.0-offline.md` (pack scenario and trap 3). The full specification text is in git (this file at v0.32.0).

In short: a business problem is whatever the customer has — a paragraph, a document or a set of them. AutoDE registers them in a pack with a role, an authority and a version; reads house-format structured documents through an interpretation profile the LLM proposes once and the engineer confirms (then applied deterministically, so a new version supersedes exactly the changed clauses); reads free text into proposed facts with section-level provenance; records contract clauses as expectations, never as observed facts; checks each source system against a contract clause by clause; verifies claims with fixed, aggregate-only probes on a live connection or on customer-supplied samples; asks the interviewer only what discovery and probes did not settle; and captures the customer's vocabulary for retrieval.

### Phase C4b: Chat extraction, Context Inbox, tool-action memory
**Status:** ✅ shipped in v0.41.0. What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md CHT-5, CTX-10, GRD-3, CTX-1; HOW: technical-design.md §5.14; usage: [mcp-setup.md](mcp-setup.md). The full specification text is in git (this file at v0.40.0).

In short:
- After each chat and interview turn, the configured model proposes the facts the turn states, in the background. Validation, subject resolution, dedup and **correction linking** are deterministic: a later, different value for the same single-valued fact supersedes the earlier one once confirmed.
- `/define`, `/rule`, `/decide` and `/assume` capture facts without the model.
- The **Context Inbox** shows facts to review (grouped by subject), conflicts, a plan step paused on a context gap, and PA1's changes to approve, with Confirm / Edit & confirm / Reject / Verify now and bulk confirmation of documented facts.
- Facts proposed over MCP use the ledger's gate, not decision files (`autode_review_assertion` for low-stakes facts only); `autode_verify_assertion` runs probes; the `autode_extract_assertions` prompt gives other hosts the same extraction.
- Chat answers cite `[fact:<id>]`.
- A step needing a missing join, key or grain pauses.
- Tool actions are kept in the transcript.

### Phase C4c: Capture coverage, verification and exploration mode
**Status:** ✅ shipped in v0.48.0 (§5.5, §7.4). Acceptance met by the tests named in CHANGELOG.md 0.48.0: the checklist on the reference problem lists every table and metric in scope with an action for each missing item; candidate keys and foreign keys come from the reference samples without a model and are verified by probes; an unsupported quote is dropped and a skipped section read again; an exploration problem continues past a gap with a recorded assumption, a governed one stops and asks, and switching lists the assumption; platform runbooks, production policy, sample-data consent and secrets behave the same in both modes.

### Phase C5a: Semantic layer files, composites and the editor
**Status:** ✅ shipped in v0.49.0. What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md CTX-11; HOW: technical-design.md §5.16; usage: [user-guide.md](user-guide.md) §15. §6 stays the specification for C5b–C5d. Acceptance met by the tests named in CHANGELOG.md 0.49.0: shared models validate as Snowflake semantic model YAML; a composite resolves byte-identically twice; redefining a shared expression, key or join is refused; a collision is named; a changed shared model makes its composites stale; the reference draft matches its golden file; the checks find a missing column and a join that contradicts a key. The older semantic-layer snapshot is retired.

### Phase C5b: The Knowledge Explorer, asset context; packs and grounding use the semantic layer
Scope:
- §6.5: graph, packs and grounding.
- §6.10: the Knowledge Explorer's search, asset page (Overview, Schema, Meaning as far as the semantic layer goes, Facts, Governance, Used by), graph, facts and estate; the drawer becomes a status line.
- §7.5: asset context, the explainability shape, and source categories in the manifest.
- The Explorer's CLI (`autode explore search | asset`) and MCP equivalents.

Acceptance:
- No agent emits a join or metric absent from the semantic layer (grounding check).
- Packs include the task's definitions.
- The Explorer's messages are driven by a test.
- Search and the asset page answer within NFR-1 on the large-estate fixture.
- The asset page, `autode explore asset` and `autode_get_asset_context` return the same content.

### Phase LIN: Lineage, ownership and impact
Scope: §8.5, and the Explorer's Lineage tab and impact view.

Acceptance:
- On the reference problem, designed and generated lineage links every target column to its source columns.
- Recorded Snowflake and Databricks lineage results load as observed edges.
- The impact of renaming a source column lists the dependent mapping, artifacts, semantic elements and business problem, each with its path.
- Owners and domains are shown and filterable.
- A manual check against a live Snowflake account.

### Phase ONT1: Canonical ontology, terminology and onboarding standards
Scope:
- §6.8: the upper layer; the pack format; a FIBO pack (about 20–40 core concepts, starting with lending); onboarding a standard in the Explorer, on the CLI (`autode ontology`) and over MCP; term scope and `means` links.
- The semantic architect role, its skills, and the `semantic-foundation` workflow template.
- The Explorer's ontology and glossary view.
- The RDF parser's P6 decision record.
- A small lending fixture beside the retail reference problem.

Acceptance:
- Onboarding the same source twice produces the same pack.
- A licence that forbids redistribution keeps the pack in the workspace.
- A `means` link goes through the Inbox.
- Concepts appear in the graph and on asset pages.
- The lending fixture's terms align with the expected concepts.

### Phase ONT2: Reasoning through meaning
Scope:
- Resolution through concepts, with the evidence chain (§6.8).
- Column matching for mappings considers concepts and classifications.
- Quality-rule candidates from keys, grain, relationships, classifications and pack hints: not null, unique, referential integrity, accepted values, patterns.
- Policies as data: `.autode/config/policies.yaml` maps regulation → classifications → required controls (masking, retention, access). Each asset lists its applicable policies, and a governance check runs on them.

Acceptance:
- On the reference and lending fixtures, the mapping finds pairs that names alone miss, measured against golden mappings, with recall reported before and after.
- Quality candidates exist for every confirmed key and relationship.
- Applicable policies are listed for every classified column.

### Phase IMP1: AtScale import and export
Scope: §6.9 (AtScale).
Acceptance: a reference SML repository imports into shared models and composites that match golden files; constructs that don't translate are listed; exporting the imported result reproduces the SML's translatable content.

### Phase C5c: Deployment and exports
Scope: §6.6.
Acceptance: a resolved model deploys to Snowflake as a semantic view through a runbook (manual check); Databricks metric view and dbt MetricFlow translations match golden files.

### Phase C5d: Merge semantics
Scope: correspondence between systems' entities (candidates from shared concepts, §6.8), survivorship rules and conformed dimensions for estate merge, expressed in shared models and composites.
Acceptance: specified when the phase is planned.

### Phase PAT: Patterns, preferences and recommendations
Scope: §7.6.

Acceptance:
- The SCD2, CDC merge and snapshot primitives have golden snapshots per dialect.
- The pipeline-type recommendation decides the reference cases with explanations.
- A recorded preference changes the ranking and is cited.
- A contract is generated for each target table of the reference problem.

### Phases IMP2–IMP4: Horizon, Collibra and Unity Catalog imports
Scope: §6.9. Specified when planned.

### Phase C6: Freshness, health and release evaluation
Scope: §8.2, §8.4; eval report becomes part of the release checklist; the model benchmark of §5.5 (recall and precision per source type for the configured model, on demand) and corrections counted as misses.
Acceptance: every metric target in §10.2 is met in replay mode; the live-mode report has been produced for at least two LLM providers; the ablation shows the context layer's contribution.

---

## 12. Out of scope

- Vector databases and embedding models (they'd add a dependency and runtime; lexical + alias + graph retrieval is sufficient at the target size, §1). This supersedes the earlier "Phase 5" plan's provider-sourced embeddings design. Revisit only if a C1/C6 evaluation shows retrieval misses that alias and graph expansion can't fix. *(2026-10-15)* That evaluation is now part of Phase K (vocabulary-mismatch question set); if it shows such misses, embeddings come in through phase RET as an optional, opt-in ranking signal — never a requirement, and never the only way to find context. *(v0.32.0)* Measured: deterministic signals find 17 of 21 vocabulary-mismatch questions and 8 of 8 on the large estate; the 4 misses are free paraphrases. RET is not scheduled (roadmap decision log).
- Replacing an enterprise catalog (Horizon, Unity Catalog, Atlan, etc.). Importing from catalogs is a future *source* of `documented` assertions via the same ledger, not a reason to build one.
- Auto-confirming LLM-proposed assertions, and confirmation over MCP.
- LLM-written verification probes.
- *(2026-10-15)* A full local mirror of a customer's catalog with periodic background sync. A per-laptop copy goes stale, differs between engineers (different sync times and grants) and so breaks reproducibility, loads the customer's warehouse once per engineer, and exports estate-wide metadata to laptops that security reviews often reject. Phase K's working-set cache with query-through and refresh-on-use replaces it. A shared, team-wide catalog cache would need a remote MCP deployment (mcp-engine §10) and is revisited only if a customer needs it.
- *(2026-10-15)* Converting legacy code (stored procedures, BTEQ, PL/SQL, ETL-tool mappings). Mature converters exist (e.g. Snowflake SnowConvert, Databricks Lakebridge); the migration track imports their output and grounds, maps and reconciles it instead.
- *(2026-10-15, parked)* ERP sources with cryptic physical names (SAP-style), which need the ERP's own text dictionary as aliases. Not rejected; deferred until a customer needs it.
- *(2026-10-28)* A separate enterprise context platform with its own repositories for metadata, glossary, governance and memory (§1.1). AutoDE's ledger, estate, semantic layer and ontology are the system of record for a workspace; enterprise tools are imported (§6.9) and exported to.
- *(2026-10-28)* Loading an industry standard in full, OWL axioms and reasoning, and numeric "relationship strength" between concepts. Cardinality and trust say what such scores would only invent.
- *(2026-10-28)* Confidence numbers stated by a model (§7.5).

## 13. Documentation deliverables

Same conventions as mcp-engine-requirements §11. Update the affected requirements in `docs/requirements.md` (WHAT/WHY, by ID) and add a "Context layer" chapter in the onboarding guide covering the assertion lifecycle (proposed → active → superseded), trust tiers, and how to read a grounding manifest.
