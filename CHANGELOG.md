# Changelog

Release history of AutoDE, newest first. Each entry records what changed in that version, including deliberate deviations from the specification it implemented.

Where things are documented: requirements (WHAT and WHY) in [docs/requirements.md](docs/requirements.md) and the forward specifications, design (HOW) in [docs/technical-design.md](docs/technical-design.md), order and status in [docs/roadmap.md](docs/roadmap.md). See [docs/README.md](docs/README.md).

> Section references in older entries (e.g. "§4.9", "§2.12") point into `docs/technical-design.md` or `docs/requirements.md` as they were at that version; use git history for the exact text.

## 0.51.0

- **MM1: the metadata model** (context-layer §6.11; CTX-17, CTX-18), using the names of the standards and catalogs. Before building, a challenge list was reviewed with the owner.
  - **Facts:**
    - the new kind `metadata`: tags `{key, value}`, owners `{role, person}` (business owner, technical owner, data steward), domain, certification by a person (verified, draft, deprecated) and custom properties;
    - **classification** as its own kind;
    - business terms gain SKOS links (category, broader, narrower, related), a steward, a status, an abbreviation and examples;
    - rules gain a **type** (definition, validation, policy, standard, guidance; OMG SBVR) and a **modality** (mandatory, advisory);
    - quality expectations gain checks (`pattern`, `referential`) and a **DAMA dimension**.

    Tags are low stakes (an agent may confirm one after asking); the rest is a person's. A person's change supersedes the fact it replaces, so history is kept.
  - **Migration**, recorded and idempotent: GOV's classifications (stored as rules) move to the classification kind, and earlier rules gain a type and modality (STRICT → mandatory; the type comes from the wording). The panel runs it on load; the CLI runs `autode metadata migrate`. Governance and STRICT enforcement are unchanged.
  - **Team structure** in `.autode/config/`:
    - `tags.yaml`: tag groups, with controlled values;
    - `properties.yaml`: typed custom properties;
    - `domains.yaml`: domains with owners, asset patterns, semantic models and data products.

    An asset's owners default to its domain's for roles it doesn't name.
  - **Knowledge articles** (`.autode/knowledge/articles/*.md`): Markdown with front matter.
    - They cite facts and never copy them: a `[fact:…]` used but not cited, or a citation that doesn't exist, is an error.
    - They are approved by a person at a revision; an edit makes them *changed*.
    - When a cited fact is superseded, rejected or sent to review, the article is *stale*, with the reason.
    - Decision kind `article`: agents propose with `autode_propose_article`, and a person approves.
  - **Packs:**
    - **Guidance** rules over the task's assets, plus team-wide ones (at most 8);
    - approved **knowledge articles** about the task's assets, marked STALE when needed, recorded as `knowledgeArticles`; their cited facts join the manifest.
  - **The Knowledge Explorer:**
    - the **Domain**, **Owner** and **Tag** facets are live;
    - **domains**, **data products** and **knowledge articles** are context-layer assets with pages and members;
    - the Overview shows domain, data products, owners (marking inherited ones), tags, certification and properties, each with an empty state that says how to fill it;
    - *Set metadata…* (VS Code's pickers, recorded as the person's);
    - new *Quality* (by dimension) and *Knowledge* (articles) tabs;
    - rules with type and modality, glossary terms with their SKOS details, and a *KPIs* button (metrics tagged `kpi`).
  - **CLI:** `autode metadata show|set|remove|migrate` and `autode articles list|show|new|check|approve` (setting and approving are a person's, at an interactive terminal); `explore search --domain/--owner/--tag`. **MCP:** `autode_search_articles`, `autode_propose_article`, metadata facts through `autode_propose_assertion`, and the resources `autode://article/{slug}` and `autode://metadata/config`. **VS Code:** *New Knowledge Article…*, *Approve Knowledge Article*.
- **Changed direction mid-phase (owner):** the Snowflake and Unity tag renderers I wrote were removed. One-off platform changes are runbooks written by agents with the platform skills, and the two governance skills now say how to apply AutoDE's tags. Reading platform metadata, pipeline code and deliverable translations stay deterministic (decision log).
- **Deviations:**
  - The acceptance criterion "tags round-trip with Snowflake tag syntax (golden)" is dropped, by the decision above.
  - A rule's type, for rules written before v0.51.0, is inferred from its wording. It's recorded, and a person can correct it.
  - Glossary categories are fields of terms, not assets of their own.
  - The agents that draft articles and keep metadata current are MM2.
- **What I checked:** migration on GOV-era facts (idempotent, governance unchanged); supersession and removal; domain patterns and inheritance; article citations, staleness, re-approval and packs; guidance in packs; facets, KPIs and domain members; every surface end to end. **What I didn't:** the Explorer's *Set metadata…* pickers in VS Code itself (manual-verification Part 48), and large `domains.yaml` files against the large estate.
- **Measured:** 400 tests (5 new: the model and its vocabularies; recording and migration; knowledge articles and their proposals; guidance and the Explorer; every surface; the tool-list tests include the article tools). Lint: 0 errors, 21 warnings. Eval unchanged.

## 0.50.3

- **Identity across databases, schemas, systems and environments** (context-layer §6.4a; CTX-19), after the owner asked how same-named tables are told apart. The question exposed a real bug: semantic base tables were matched on schema and table only, so a model over `RETAIL.SALES.ORDERS` also matched `ARCHIVE.SALES.ORDERS`, the dev copy, and the same name in another account.
  - **Matching** (`layer.ts`: `physicalRef`, `physicalMatches`, `matchBase`) compares database, schema and table where both sides know them, within the model's **binding**. One fit links; several fits are **ambiguous**, so nothing is linked and no definitions reach packs. An unknown database (DDL without one, `SET_DATABASE`) never picks one.
    - Used by: the graph overlay (`metadata.ambiguous` lists the candidates), the landscape's semantic joins, packs (a table receives only the definitions that resolve to it), the semantic checks (an error naming every candidate and the fix) and the grounding check (a database named in SQL must match).
  - **Binding:** drafts record the system and environment of their tables in the sidecar (`writeDraft(…, binding)`), never in the YAML. A draft across systems stays unbound, with a note. Models written before are unbound and keep working, with ambiguity reported.
  - **Logical names** stay unique: the table name, else schema_name, else database_schema_name. Before, two databases with the same schema and table produced a duplicate name, which Snowflake refuses.
  - **Databases and schemas are physical assets** (catalog containers):
    - computed from qualified names per system and environment;
    - pages with *Contents*, and breadcrumbs (a table's parent is its schema);
    - **Database** and **Schema** facets;
    - a lazy **Browse** tree in the Explorer, `autode explore browse`, and `autode_browse_assets`.

    Tables without a database are under `(unknown)`. Ingestion's format labels (`ddl`, `csv`, `json`) used for a missing schema count as no schema.
- **A realistic-estate fixture** (`test/reference/realistic-estate/`): `ORDERS` in two databases and two schemas, the same full name in dev and in another system, legacy DDL with no database or schema, no foreign keys, cryptic names. Three tests use it.
- **Specified:** one model serves every environment, with database names mapped at deployment (C5c). The "semantic architect" becomes two agents: a **semantic modeler** and a **knowledge engineer**, both in MM, with the knowledge engineer's ontology skills in ONT1.
- **Deviations:**
  - Composites aren't bound yet: their tables match unbound, so ambiguity is reported.
  - An agent's proposed shared model (`autode_propose_semantic_model`) carries no binding; drafts written by AutoDE do.
  - Unqualified names in SQL aren't resolved through the connection's default database and schema yet; they match leniently.
- **What I checked:** the matching rules on the realistic estate (bound, unbound, placeholder, other environment, other system, missing database or schema); packs and grounding per table; logical names; the browse tree and facets. **What I didn't:** the Explorer in VS Code itself (manual-verification Part 47), and live Snowflake or Databricks names (quoted, case-sensitive identifiers are compared case-insensitively).
- **Measured:** 395 tests (3 new on the realistic estate; the tool-list tests include `autode_browse_assets`). Lint: 0 errors, 21 warnings. Eval unchanged.

## 0.50.2

- **Three layers** (context-layer §6.1, CTX-18), after the owner's review. I checked how the industry uses the terms now, and the owner's view held:
  - **physical:** what exists (tables, views, columns);
  - **context:** what it means to the business and what is known (glossary terms, and later ontology concepts; rules, knowledge facts, and later knowledge articles);
  - **semantic:** how it is measured and queried (semantic models and everything in them).

  Every asset carries `layer`, and Layer is the first facet (`layers` over MCP, `--layer` on the CLI). In the Knowledge Explorer:
  - a layer switch in the header;
  - layer badges, and layer-coloured fills on graph nodes;
  - a three-layer row on the overview page.
- **The semantic layer's home page** (the Semantic switch): each model, approved or draft, with its logical tables, metrics and their expressions, relationships, verified queries with their questions, and custom instructions. It is also available as `autode explore semantic` and the resource `autode://explore/semantic`.
- **Relationships, verified queries and custom instructions are assets:** they can be searched, have pages (the join with its columns and type; the question, SQL and who verified it; the instructions) and appear in the graph. A physical table's *Used by* now lists the verified queries over its logical tables.
- **Specified:**
  - the ontology and glossary are moved into the context layer (§6.1, §6.8);
  - tables may **represent** a concept directly, while columns reach concepts through terms;
  - a computed **concept page** (ONT1);
  - **knowledge articles** (MM): they cite facts rather than copy them, link many-to-many to concepts and assets, go stale when a cited fact changes, and are delivered in packs;
  - KPI is a metric tagged `kpi`.
- **Deviation:** I earlier proposed the glossary and ontology for the semantic layer. That is withdrawn (decision log, 2026-10-28).
- **Measured:** 392 tests (1 new: three layers and the semantic layer's assets; the surfaces test checks `explore semantic`, `--layer` and the resource). Lint: 0 errors, 21 warnings. Eval unchanged.

## 0.50.1

- **Standard vocabulary** (context-layer §6.11; CTX-17), after the owner tried the Explorer: every term a data engineer or architect sees comes from a standard or a catalog convention.
  - **Asset types** (`assetType`, replacing `kind`) follow catalog names and, for the semantic layer, Snowflake's: logical table, dimension, time dimension, fact, metric, filter. AutoDE's own facts are *knowledge facts*.
  - **Platform** is a new facet.
  - **Certification** (verified, documented, unverified, draft) on assets replaces *trust* as a facet. The five tiers stay on knowledge facts, labelled *Evidence*.
  - **Status** (an asset's lifecycle) is now apart from **review state** (a knowledge fact's).
  - **Glossary term** is a facet and appears on assets.
  - Domain, owner and tags are shown, disabled, until MM.
  - The same names apply in `autode explore` (`--type`, with `--kind` still accepted; `--platform`) and in MCP (`assetTypes`, `certifications`, `platforms`, `reviewStates`, `glossaryTerms`, and `pendingFacets` in results).
- **The Graph view** shows the landscape (`exploreLandscape`): the working set's tables, or one system, schema or semantic model's. It shows every relationship AutoDE knows, lifted to the tables and labelled with their columns: declared foreign keys, confirmed relationship facts, proposed ones (dashed), and semantic-layer joins (dotted; dashed for a draft model). Columns can be drawn inside their tables. Up to 250 tables are shown; beyond that, a scope is offered.
  - In every graph: a click opens a summary card (*Open*, *Expand*, *Focus*), and a double-click expands a node's neighbours in place.
  - *Find* highlights matches and dims the rest; there's a legend, and an explanation when a graph has no relationships yet.
  - Grid layout added.
  - An asset's Graph tab shows its columns inside it by default.
  - Also as `autode explore graph` without an asset, and `autode_explore_graph` without `asset`.
- An empty search now lists knowledge facts too, after the assets.
- **The metadata model** is specified (context-layer §6.11): the standards anchors for each concept, rule types under OMG SBVR with modality, and where names come from. **MM** is a new phase, v0.51.0. Owners and domains move there from LIN, and the later phases each move one version.
- **Deviations:** the JSON of a knowledge fact keeps the ledger's names (`trust`, `status`), shown as *Evidence* and *Review state*. Renaming them would break `autode_list_assertions` and the ledger files.
- **Measured:** 391 tests (2 new: standard vocabulary; the landscape; the v0.50.0 tests updated to the new names, and the surfaces test checks the landscape on the CLI and MCP). Lint: 0 errors, 21 warnings. Eval unchanged.

## 0.50.0

- **C5b: the Knowledge Explorer; packs and grounding use the semantic layer** (context-layer §6.5, §6.10, §7.5; CTX-8, CTX-11, GRD-10, UI-7).
  - **The approved semantic layer as an index** (`src/engine/semantic/layer.ts`, loaded by `loadSemanticLayer` in `store.ts`): shared models approved at their current revision, plus the active problem's composites approved at their current resolution. Drafts are kept out of the authority; the Explorer can list them, flagged. `definitionsFor` gives the metrics, filters and relationships of a task's physical tables (matched on schema and table). `layerGraph.ts` turns the layer into graph nodes (new node types `semantic_model`, `semantic_table`, `semantic_element`; metrics are `metric`): logical tables `maps_to` their physical tables, elements `derives_from` the columns their expressions use, relationships are `related_to`, and each node carries the facts behind it from the sidecar.
  - **Packs** carry a mandatory *Semantic definitions (approved: use these, never your own)* block for their tables: metrics with their expressions and synonyms, filters, and joins with columns and type. The manifest records the models used as `semanticModels` (`name@revision`). *What the agent saw* shows them.
  - **The semantic grounding check** (`src/engine/grounding/semanticGrounding.ts`, deterministic): a join between two tables the approved layer covers must be one of its relationships, on its columns (either direction). An aggregate named after an approved metric or synonym must compute it as defined (compared unqualified, with the table's facts expanded). An aggregate named after a metric the facts know but no approved model defines is flagged. Joins between tables the layer doesn't cover, a table joined to itself (a merge) and unknown aggregate names aren't judged. With no approved layer nothing is checked.
    - `autode_record_artifact` **refuses** such SQL in a governed problem, naming each issue and its fix, and writes nothing. In exploration mode it records the file with a `GROUNDING_SEMANTIC` warning.
    - `autode_check_grounding` returns the result as `semantic`, so external agents can check before recording.
    - Manifests carry `grounding.semantic`.
  - **Explainability and traceability:**
    - Each decision in a grounding manifest has a `confidence`: the weakest trust tier among its backing, or `unbacked` (`confidenceOf`). A model's stated confidence is never recorded.
    - Manifests list their sources by category (`sources`: semantic, metadata, pattern, governance, ontology, lineage).
  - **Exploring** (`src/engine/explore/`): one implementation behind every surface.
    - `searchAssets`: objects, columns, terms, rules, queries, semantic elements, facts, and catalog tables outside the working set. Every word must match a name, alias, synonym or description. When nothing does, results come from the vocabulary and are flagged `approximate`. Facets: kind, system, environment, trust, status and classification, counted before filtering.
    - `getAssetContext`: overview and provenance; schema with keys, grain, profile and classifications; meaning (glossary terms; for a table, the semantic tables over it and metrics built on it; for a column, the elements derived from it); relationships and derivations; governance (classifications, rules linked to or naming it); facts with evidence, trust and history; decisions and assumptions in scope, including team-wide ones; what uses it (artifacts, by their grounding manifests; semantic models; verified queries); conflicts; sources by category. An asset can be found by id, by fact id, by catalog id, or by a unique name or fqn.
    - `exploreGraph`: one to three hops, by edge type, columns on request, capped, with what's left out counted per node.
    - Also `listFacts`, `exploreOverview` and `estateView` (systems, environments, catalog tiers, the working set, connections and their readiness). `handleExploreRequest` answers all of them.
    - `render.ts` renders the asset page as Markdown.
  - **The Knowledge Explorer** (`src/core/knowledgeExplorer.ts`, `media/explorer.html`, command *AutoDE: Open Knowledge Explorer*, also on the Workflow view's title bar):
    - **Search** with facet filters, a result list and keyboard navigation (`/` to search, arrows, Enter, Alt+←/→ for history).
    - **Asset pages** with tabs (Overview, Schema, Meaning, Lineage, Facts, Governance, Used by, Graph), breadcrumbs, *Copy as Markdown*, *Open in Semantic Model editor* and *Review in the Context Inbox*.
    - **Graph** (Cytoscape.js): force, layered and concentric layouts; hops; edge-type filters; columns on request; trust shown as border colour, dashed for inferred or draft; export as PNG or SVG.
    - **Facts** view (filterable, newest first) and **Estate** view.
    - An overview when no asset is open. VS Code theme colours, ARIA roles, and state kept when hidden.
    - It reads through the engine's workspace, the one the CLI and the MCP server read. Its messages are handled by `knowledgeExplorerModel.ts` without VS Code, and it opens only files inside the workspace.
  - **The sidebar's context drawer is now a status line** (counts and a *Knowledge Explorer* link). `/context` and `/explore` open the Explorer, and its *Review in the Context Inbox* opens the palette. The drawer's controls for the older knowledge files (register a source, synthesize, re-index, open `.autode`) are gone from the sidebar; re-index stays on the top bar.
  - **CLI:** `autode explore` (overview), `explore search <words> [--kind] [--system] [--environment] [--all]`, `explore asset <id|name>` and `explore graph <id|name> [--hops]`, with `--json` for the same JSON as MCP. **MCP:** `autode_search_assets`, `autode_get_asset_context` and `autode_explore_graph` (read-only), plus the resources `autode://asset/{id}` (a template), `autode://explore/overview` and `autode://explore/estate`. Resource reads are asynchronous.
  - **Cytoscape.js 3.34.3** (MIT) is pinned as a development dependency. The build copies its published `cytoscape.min.js` to `dist/` (about 435 KB), the VSIX ships it, and `dist/THIRD-PARTY-NOTICES.md` carries its licence. The decision record is in the roadmap's decision log.
  - **Tests:** `AUTODE_TEST_GREP=<regex>` runs only matching tests during development; the full suite remains the gate.
- **Deviations:**
  - Lists are paged ("Show more", 50 at a time) rather than virtualised; on the large-estate fixture every request answers within NFR-1, so paging is enough.
  - SVG export is AutoDE's own, drawn from node positions: Cytoscape's SVG exporter is a separate package under another licence. PNG uses Cytoscape's own export.
  - Owner, domain, observed lineage and impact are LIN; ontology concepts are ONT1. The Explorer shows where they will appear.
  - Explainability is carried by grounding-manifest decisions. Other recommendations (mappings, pipeline types) gain the shape as their phases add them (ONT2, PAT).
  - The sidebar's old message handlers for registering knowledge files remain in the provider, unreachable from the UI; the older knowledge files move into the ledger later (C5 cleanup).
  - The Explorer's search falls back to vocabulary-aware matching only when plain matching finds nothing, and says so (`approximate`). Mixing the two would let one unmatched word slip through.
- **Measured:** 389 tests (6 new: the approved layer, packs and graph; the semantic grounding check; refusal and manifests; exploring; NFR-1 on the large estate; every surface the same; 2 existing tests list the new tools). Large-estate fixture (2 000 tables, about 50 000 columns; 200 in the working set): every Explorer request (search, asset, graph, overview) under 100 ms; with the whole estate in the graph, the index build takes about 90 ms and a search about 35 ms. Lint: 0 errors, 21 warnings. Eval: unchanged (the reference run has no approved semantic layer).

## 0.49.0

- **C5a: the semantic layer — shared models, composites, checks and the editor** (context-layer §6.1–6.5, §6.7; CTX-11 in part).
  - **Shared semantic models** (`src/engine/semantic/model.ts`) in `<artifactDirectory>/semantic/<subject>.yaml`, in Snowflake's semantic model YAML: a schema of the format with unknown keys refused (Snowflake refuses them too), unique table and element names, relationships between the model's tables; a fixed key order, so equal models serialize to equal bytes; a content revision (SHA-256, 12 hex).
  - **Composites** (`composite.ts`) in `<artifactDirectory>/<problem>/semantic/<name>.yaml` (`autode: semantic-composite/1`): `uses` (shared models, optionally some tables and metrics), `add` (metrics, filters, verified queries), `describe` (descriptions and synonyms). Resolution is deterministic and writes `<name>.resolved.yaml` with a header naming every shared model's revision. Refused, with every reason: a missing model, table or metric; an addition with the name of a shared element (a redefinition: "a different calculation is a new metric with its own name"); `add.tables|relationships|dimensions|facts` and a `describe` with an expression (the composite format has no place for them, and the message says why); a table two shared models define differently (the collision names the difference: base table, key or a column's expression); a metric, filter or relationship defined differently by two models.
  - **Staleness:** a composite resolved from a shared model's earlier revision, or edited since, is *stale*, with the reason, until resolved again; resolving returns the diff.
  - **Drafting from knowledge** (`draft.ts`), deterministic, from facts a person confirmed or a probe verified: tables and primary keys from declared keys and key facts; relationships from declared foreign keys and relationship facts (`N:1` and `1:N` become many_to_one in the right direction, `1:1` one_to_one, `N:M` is left out with a note); time dimensions, dimensions (keys, join columns, text) and facts (numbers) from column types; metrics from metric facts with an expression (their filters become a `<metric>_scope` filter); synonyms from glossary terms bound to columns; a personal-data note on classified columns. A base table with no database gets `SET_DATABASE`, which the checks flag. The facts behind each element are recorded in `.autode/semantic/`. On the reference problem the draft matches a golden file (`test/golden/semantic/retail-orders.sales.yaml`), and invents no join (trap 4).
  - **Checks** (`checks.ts`): against the estate, base tables and columns exist, expressions use known columns and elements (`exprIdentifiers` leaves out functions, keywords and literals), time dimensions and facts have fitting types; against the knowledge, a join whose "one" side isn't its table's known key is an error (it would fan out), a one-to-one's other side not being its key is a warning, a primary key a fact contradicts is an error and one no fact supports a warning, a metric its fact defines otherwise is an error.
  - **Approval:** a shared model is approved by a person at its revision (refused while a check fails), recorded in `.autode/semantic/`; an edit makes it *changed since approved*. A composite is approved within its problem at its resolved revision, once resolved and not stale; in exploration mode failed checks only warn. *Waiting for you* lists shared models not approved at their revision and stale or unresolved composites.
  - **Agents propose:** `autode_propose_semantic_model` (decision kind `semantic_model`, high stakes) for a shared model or a composite, validated (format; for a composite, that it resolves); approving it writes the file, and for a shared model approves that revision. A proposal against a file that changed since is superseded.
  - **The Semantic Model editor** (`src/editors/SemanticModelEditorProvider.ts`, `media/editors/semanticModelEditor.html`): a custom text editor, the default for `**/semantic/*.yaml`. Form (tables, elements, relationships, verified queries; edit expressions, descriptions and synonyms; add and remove metrics and filters), Diagram, YAML; checks inline; *Draft from knowledge* (add-only merge: nothing written changes), *Resolve*, *Approve…*. Every change is an ordinary document edit. The editor's state and edits are engine code (`editorState.ts`), tested without VS Code. Commands *New Shared Semantic Model (Draft from Knowledge)…* and *New Semantic Composite…*.
  - **CLI:** `autode semantic show | draft <name> [--tables] [--database] | compose <name> --models | resolve <composite> | check <name> | approve <name>` (approving: a person at a terminal). **MCP:** `autode_semantic_list`, `autode_semantic_check`, `autode_semantic_draft` (read), `autode_semantic_resolve`, resources `autode://semantic/shared/<name>`, `…/composite/<name>`, `…/resolved/<name>`.
  - **Retired:** the semantic-layer snapshot (`SemanticLayerManager`, *Build Unified Semantic Layer Snapshot*, `semantic-layer.yaml`, the `autode://context/semantic-layer` resource): a spec-pinned copy of the graph, now replaced by the semantic layer itself.
- **Deviations:**
  - A problem doesn't record the models it uses in a file of its own: its composites (in its folder) name them, and `autode semantic show` lists them.
  - Staleness is the semantic layer's own state (editor, CLI, MCP, *Waiting for you*), not a workflow stage's: no stage kind produces a composite yet.
  - Deployment and exports are C5c; packs, grounding and the graph using the semantic layer are C5b. Model-proposed descriptions and synonyms are not offered in the editor yet: an agent proposes them through `autode_propose_semantic_model`.
  - Editing in the form re-serializes the model in the fixed order, so comments in a shared model are not kept (the raw YAML view keeps them).
  - The development build of the `autode` package is over 2 MB unpacked; its test budget is now 2.5 MB (the published, minified build is well under half).
- **Measured:** 383 tests (5 new: the format; composites, redefinition, collision and staleness; the golden draft and the checks; approval, proposals and the editor's logic; CLI and MCP end to end; 1 removed with the snapshot). Lint: 0 errors, 21 warnings. Eval unchanged.

## 0.48.0

- **C4c: capture coverage and verification** (context-layer §5.5; CTX-13). Capture no longer depends on the model to find facts, to decide what should be known, or to be believed unchecked.
  - **The completeness checklist** (`src/engine/context/coverage.ts`). From the specification (and the mapping, when there is one) and the estate, AutoDE lists every table in scope with its key, grain, change column, load pattern, personal-data classification, relationships to the other tables in scope and business description, and every metric the specification names with its definition, grain and filters. Each item is *known*, *proposed*, *assumed*, a *candidate* or *missing*, and every item not known carries its action: a probe, a confirmation, a question or a classification. Tables in scope are resolved from the specification's text the way context packs resolve it; metric names come from fixed business nouns (revenue, retention, churn, margin …). Surfaces: *AutoDE: Capture Coverage*, `autode coverage`, `autode_capture_coverage`.
  - **The data before any model** (`dataCandidates.ts`). Candidate keys (columns named like a key, at most three per table, the first that is unique and never null in the data wins), grain from that key, foreign keys (a column with another table's key name, `<table>_<key>`, or `<schema>_<key>`, with compatible types; checked by the orphan probe), change columns (by name and type) and personal data by value shape (a new fixed `shape` probe for e-mail addresses and phone numbers, counts only). Declared keys are probed too, and a declared key the data breaks is reported. Those that pass are recorded as proposed facts that arrive `verified`; a person confirms what they mean. Personal data stays a person's classification. Surfaces: *AutoDE: Find Candidates from Data*, `autode capture candidates [--connection] [--record]`, `autode_find_candidates`.
  - **Documents.**
    - **Quote check:** every fact the model reads quotes its section word for word (case, spacing and emphasis aside); a fact whose quote isn't there is dropped as unsupported.
    - **Section accounting:** the model reports on every section; a section it neither reported on nor took a fact from is read again, on its own, once (in the panel automatically; over MCP the answer says which sections to read again).
    - **Deterministic first:** Markdown tables with a column-name header (a data dictionary: description, key, unique, required or nullable) and fixed phrases ("must be unique", "is never null", "is required", "has one row per") are read without a model, as documented proposals. Free text with no model available (`autode pack apply`) still yields these.
    - **Agreement:** the same fact from a second document adds its evidence to the first (a new `corroborated` ledger event) instead of being skipped.
    - **Double reading** (setting `capture.doubleExtraction`, off by default): keys, grain and relationships are kept only where two readings agree.
  - **Model provenance:** facts extracted from chat, documents and MCP proposals record the model (`Assertion.model`).
  - **The conversation, reviewed:** `/review` in chat lists the messages that read like facts (fixed cues: keys, grain, definitions, joins, rules, decisions, thresholds) and have no fact citing them; `/review record <n>` has the model read one again, `/review dismiss <n>|all` drops them. Closing a chat says how many it left. Over MCP, `autode_review_session` does the same for a host's conversation.
- **Exploration mode** (context-layer §7.4; ORC-11), per business problem.
  - **Switching** is a person's act, with the disclaimer acknowledged and recorded (`<problem>/mode.yaml`, kept apart from the specification so switching never makes stages stale): the panel's Business Problem card (*Explore…*; before the first message it applies to the new problem), or `autode problems new --exploration` and `autode problems mode exploration|governed` in a terminal (type `explore` or `governed`).
  - **Assume and continue:** an agent's assignment says the problem is exploratory; at a context gap it records its best guess with `autode_record_assumption` (the fact, at a new `assumed` trust tier, flagged `assumption`, with the model, the stage and the reason) and continues. An assumed fact closes the gap in exploration only. Refused in a governed problem, where the assignment says to stop and ask.
  - **Model proposals count at once:** facts from chat, documents, MCP proposals, capture commands and data candidates are recorded live at `assumed` trust (a verified one stays verified), flagged `exploration`. A correction still waits for a person.
  - **Checks warn:** approving a stage's document no longer refuses for another specification version, a source context with no source, or an unmasked sensitive column; the approval says what warned and records it.
  - **Gates take one click:** no confirmation dialog in the panel or the Workflow view; `y` instead of a typed word in a terminal. Still a person, still recorded.
  - **Labels:** a banner in the panel and the Workflow view; a first line in every deliverable an agent records; `exploration: true` in its grounding manifest; a section in every agent assignment.
  - **Never relaxed:** an exploration problem's runbooks may target only non-production environments (a connection no environment lists counts as production), refused at approval and at run time; runbook policy, sample-data consent, secrets and rollbacks are unchanged (tested in both modes).
  - **Hardening:** switching back to governed lists the assumptions, the model-only facts and the checks that only warned (`autode problems hardening` at any time). Governed checks don't accept `assumed` trust, so they block until each is confirmed or replaced.
- **Deviations:**
  - An assumption is recorded as a fact of the kind the gap needs (a relationship, a key, a grain) flagged `assumption`, not as a fact of kind `assumption`, so the gap closes and later stages use it.
  - Completeness doesn't block a governed approval yet: it is a to-do list in both modes, and the hardening list. Blocking on it waits for the semantic layer's checks (C5).
  - Grounding checks already only warned on recorded deliverables, so exploration mode changes nothing there.
  - Metric names in the specification are found by fixed nouns, so a metric named otherwise ("bookings") isn't listed until a metric fact names it.
  - The panel's mode control is on the Business Problem card; there is no separate creation dialog.
  - In a workspace shared by several problems, an assumed fact is live for all of them (it carries the problem's specification id); governed checks never accept it.
  - The per-model benchmark and corrections counted as misses are C6, as specified.
- **Measured:** 379 tests (7 new: the checklist on the reference problem; candidates from the reference samples; quotes, re-reads, parsing, agreement and double reading; the conversation review; exploration mode end to end; never relaxed, in both modes; CLI and MCP). Lint: 0 errors, 21 warnings. Eval unchanged.

## 0.47.0

- **GOV: governance as code** (mcp-engine §9.1; SEC-4, SEC-5).
  - **Classifications are facts.** A column is `pii`, `sensitive-pii`, `confidential` or `none`: a `business_rule` fact with predicate `classification` on the column, whose value also names how personal data is masked (`hash` or `redact`). A person records it confirmed (*AutoDE: Classify Personal Data…* in VS Code, `autode governance classify` in a terminal), or an agent proposes it for a person to confirm. A new classification of the same column replaces the old one. As ledger facts they reach context packs, manifests and grounding like any other.
  - **Candidates, never automatic.** The personal-data name heuristic (the one that already masks sample rows) suggests columns and a classification: identity numbers, card and bank data, health, salary and credentials suggest `sensitive-pii`, the rest `pii`. Secrets are redacted, everything else hashed. Nothing is classified until a person says so. Surfaces: `autode governance show`, `autode_governance_candidates` over MCP, and the panel command's pick list.
  - **The `mask` primitive** (Tier 1). It masks columns in a view or table over the source; the others pass through.
    - `hash` is SHA-256 as lowercase hex, the same on Snowflake, Databricks (Spark SQL), BigQuery, PostgreSQL and SQL Server. Equal values stay equal, so keys still join and deduplicate. An optional `saltExpression` names a platform secret or variable (an identifier, a variable or one function call with quoted arguments, never a literal).
    - `redact` writes a constant.
    - NULL stays NULL. Masking is non-reversible; tokenisation is out of scope.
    - ANSI SQL has no hash function, so a hashing mask is refused for `ansi` rather than guessed.
    - Golden snapshots cover every dialect.
  - **Masking follows from the facts.** `autode_primitive_candidates` adds a `mask` step right after staging for columns classified as personal data. Masked columns keep their staged names, and nothing downstream reads unmasked data. It also fills the entity's `governance` block, and notes classifications that aren't confirmed yet.
  - **Checks.**
    - **Structural:** a Pipeline Spec is invalid while a `sensitive-pii` column in an entity's governance block isn't masked by one of its `mask` steps. This is enforced everywhere the spec is validated.
    - **Against the ledger:** recording a Pipeline Spec over MCP, and approving the build stage's document, are refused while a confirmed `sensitive-pii` fact about a column the entity reads is missing from its governance block. An unmasked `pii` column is a warning: the platform's own masking policy may cover it. A spec without governance still validates.
  - **The governance interview** is a new part, `autode-de-interview-governance` (order 7; synthesis moves to 8). It covers personal data, regulations and policies, then column by column classification and masking, starting from the candidates. It is asked only when personal data is in play: the problem's words (customers, patients, e-mail, GDPR …) or columns already known. This is decided deterministically when the interview starts (`metadata.askWhen: personal-data`), and an interview without it doesn't list it. The business analyst has the part and the tools to propose classifications.
  - **The specification** gains `governance` (personal data none, present or sensitive; regulations; notes), and sources and data flows gain a `sensitivity` hint. All are optional, filled by synthesis only from what the user said, and kept through save, parse and revision.
  - **Sample rows (SEC-5):** with sample data allowed, columns classified as personal data are masked as well as those the name heuristic catches.
  - **The pipeline-build skill** (v2) keeps `mask` steps, explains hash and redact, and suggests a salt for guessable values. The pipeline engineer has `autode_governance_candidates`.
  - **Deviations:**
    - `mask` is Tier 1 (code), not a Tier-2 definition: the template engine has no conditionals by design, and a per-column strategy and an optional salt need them.
    - Governance discovery questions are a skill, not `skills/*.json` (interview parts became skills in v0.45.12).
    - No `governanceContent` in `context-envelope.schema.json`: governance facts live in the ledger, and the envelope's knowledge files fold into the ledger in C5.
    - Masking a classified column in sample rows adds to the name heuristic rather than replacing it, because a query result carries no table.
  - **Measured:** 372 tests (2 new: the primitive, facts, candidates, masking after staging and both checks; the interview, CLI, MCP and the approval check end to end). Golden snapshots: 23 (5 new for `mask`, `ansi` refused). Lint: 0 errors, 21 warnings.

## 0.46.0

- **PA4: port a skill** (mcp-engine §9.2; SKL-5, SKL-7). A data engineer brings a skill written for any agent into AutoDE without code, from a Git repository, a folder or a dbt package. Guide: [docs/skills-authoring.md](docs/skills-authoring.md).
  - **Staging.** A Git repository is cloned shallow without checkout into a temporary folder. Its file list is checked before anything is checked out: at most 2,000 files and 30 MB (5 MB per file), no path that leaves the repository, no symbolic links, no submodules. The commit is recorded. A folder is walked with the same checks. Nothing reaches the workspace before import.
  - **Analysis** (deterministic): frontmatter; declared tools and the AutoDE tools they map to, and those with no counterpart; AutoDE engine tools and other MCP servers it names; the CLIs its instructions run, with AutoDE's install guide where there is one (Snowflake and Databricks CLIs); scripts and resources; the licence (a non-redistributable one, such as the Databricks License, refuses the import; an unrecognised one is a warning); overlaps with imported and AutoDE skills; and its kind, *knowledge* or *procedure*.
  - **The model's proposal.** Where a model is configured, the panel can ask it for the kind, a tool mapping and prerequisites. It stays a proposal until the person accepts it (as proposed or with the other kind) or rejects it.
  - **Capability report:** what it is, where it came from and under which licence; what it reads; which of its changes become approval-gated decisions; whether it writes files or runs scripts and commands; the limit of §3.1 for skills that write or execute; what it needs; overlaps; problems and warnings.
  - **Import** copies the skill into `.autode/config/skills/tool-skills/<id>/`, unreviewed, with its provenance (source, location or repository and commit, licence) and the analysis beside it (`.autode-port.json`, not part of the content checksum).
  - **Publishing needs review when a skill acts on its own:** a skill with scripts, or tools that write or run commands, is not published while its content is unreviewed (`lifecycle.publishToolSkill`). With *Tool Skill Management* off there are no drafts, as before: an import becomes usable once reviewed.
  - **Update Skill** re-fetches from the recorded source, shows the diff file by file, and applies only when the person confirms. The new content is unreviewed (a new `update` transition), so it stops running and leaves assignments and context packs until reviewed again.
  - **Knowledge skills in context packs.** Published, reviewed knowledge skills whose name or description match a pack's question join it under *Team Knowledge* (at most two, a quarter of the budget, cut to fit), and the manifest names them. Both the panel's packs and the MCP server's include them.
  - **One lifecycle.** Imported skills that declare `metadata.stageKinds` join the assignments of those stages once published and reviewed, next to AutoDE's skills (AutoDE's win a name clash). They add instructions, never tools. The plan check and `autode_workflow_draft` know them too. The catalog gives imported skills the same fields as AutoDE's: stage kinds, platforms, scope `team`, kind, licence and source.
  - **Surfaces:**
    - **VS Code:** *AutoDE: Port a Skill…* (the **+** on the Skills view) opens a wizard: source, choose, what it does, import, then review and publish. It replaces the folder-only *Import Tool Skill*, keeping its command id. *Update Skill from Its Source…* is the sync button on an imported skill. *Open Skill Source* reveals a local source folder.
    - **CLI:** `autode skills analyze | import <source> [--ref] [--skill] [--replace]`, and `update | review [--tier] | publish <id>`. Update, review and publish are a person's acts in a terminal. Imports follow the workspace's *Tool Skill Management* setting (`.vscode/settings.json`).
    - **MCP:** `autode_skills_analyze` (read only: an https Git URL or a workspace folder; SSH and paths outside the workspace are refused).
  - **Starter examples** in `examples/skills/` (shipped in the extension; *Try AutoDE's examples* in the wizard): `team-sql-conventions` (knowledge) and `table-freshness-check` (procedure, with a script). The tests use them as fixtures.
  - **Deviations:**
    - No optional dry run on a sample workspace yet.
    - The *Agent Skills* format is the only importer; there is no `SkillFormatImporter` interface until a second format is needed.
    - Over MCP the host's own model reads the skill; MCP sampling isn't used.
    - AutoDE doesn't yet suggest turning a skill's repeated procedure into a primitive.
  - **Measured:** 370 tests (3 new: the port engine with a fake hostile Git tree, knowledge skills and Update Skill, and the CLI, MCP and wizard end to end; the assignment test also covers imported skills). Lint: 0 errors, 21 warnings (was 22; an unused folder-copy helper went with the old import).
- **The manual-verification kit** (`npm run manual:kit`, `scripts/manual-kit.cjs`). It builds a ready workspace from the reference problem, next to the repo:
  - the sources and the pack's documents (a BRD, a glossary, and a house-format contract with no profile yet);
  - a connection template;
  - the AutoDE plugin installed for Claude Code, with its guard hook.

  In a throwaway copy it then runs every step of Parts 36 on that needs no person, no VS Code and no live platform:
  - platform skills per stage;
  - the runbook checks;
  - the guard hook;
  - the catalog;
  - the interview from a terminal;
  - pack reading;
  - the build stage's single path;
  - the MCP server's tools.

  It writes `MANUAL-KIT.md`, which lists what passed and, per check, what is left for you and whether this machine can run it. It detects VS Code, Claude Code (CLI or VS Code extension), and the Snowflake, Databricks and Cortex Code CLIs. It replaces only a folder it made, and only with `--force`.
- **Found by the kit:** *Environment and security* (platform-setup) is optional in every template, so a drafted workflow leaves it out and its stage gets no assignment. That is correct behaviour, but check 36.1 assumed the stage was there. 36.1 now says to include it.
- **Measured:** 367 tests (1 new: the kit end to end, including refusing a folder it didn't make).

## 0.45.14

- **Code audit follow-ups** (owner, 2026-10-26: all five recommendations accepted; the sixth item, the interview decision note, stands). Details: [docs/code-audit-2026-10.md](docs/code-audit-2026-10.md).
  - **One way to make the build stage's Pipeline Spec.** In VS Code the build stage offers Run agent (the pipeline engineer, AutoDE's compiler, grounding manifests), the same as agent hosts, and no separate Produce.
    - **Removed:** the one-shot LLM synthesis behind Produce (`AgentHub.synthesizePipelineSpec`, `src/agents/pipelineSpecSynthesis.ts`), its command *AutoDE: Generate Pipeline Spec*, and its two tests.
    - **Attachments:** they reach the build through the business-problem pack (v0.45.12), so nothing is lost.
    - **Mapping:** the mapping stage keeps Produce, which is a person's own mapping.
  - **One way to bring a source's metadata in.** *Run Source Assessment* on a platform card now picks a named connection, a database and its schemas. It brings them into the estate with profiling, through the same engine tools agents and the CLI use (`autode_list_databases`, `autode_list_schemas`, `autode_ingest_metadata`), instead of the single connection in the settings. *Re-verify source schema* uses it too, and sees the new tables.
  - **Refresh on use is back.** Tables past their refresh age are refreshed before a stage's agent runs:
    - **In VS Code:** by Run agent.
    - **In hosts:** by the new `autode_refresh_working_set`, which the orchestrator skill (v2) calls before an assignment. It uses the named connections already bound to an estate system, connects only when a table needs fetching, reports a source it can't reach, and never creates estate systems.
  - **Palette:** the commands `testCopilot`, `listCopilotInfo` (aliases) and `debugListExtensions` are gone.
  - **Catalog:** it checks roles naming unknown skills with `checkDefinitions`, one implementation instead of two.
  - **Deliberate deviation:** the audit suggested refreshing inside `autode_workflow_next`. That tool is read-only, and MCP's context is read-only by design, so the refresh is a separate records tool the orchestrator calls first.
  - **Third pass:** two more methods orphaned by the removal (`PipelineSpecManager.hasApprovedSpec`, `getSpecDir`) and four unused imports went too.
  - **Measured:** 366 tests: 2 new (one path for the build stage, with the mapping stage's Produce kept; the refresh tool, the orchestrator step and the catalog check); 2 removed with the synthesis; 1 trimmed. Lint 0 errors, 22 warnings. Eval unchanged.
- **Code audit: dead code removed, stranded code listed for decision** ([docs/code-audit-2026-10.md](docs/code-audit-2026-10.md)). Every module was checked for reachability from the extension, the CLI and the MCP server, and every export for references, with the TypeScript language service; panel messages, commands, settings and layout entries were checked against their uses.
  - **Removed:**
    - three dead modules: the `copilotAdapter` and `GraphPersistence` re-export shims, and `platformDialect`;
    - 18 unused exports, among them the types SIMP-4 left behind and the `ContextPackProvider` interface of the removed plan run;
    - six panel handlers no page sends, and five messages no page listens for;
    - the `carryover` layout entry;
    - 12 unused imports. Lint warnings fell from 33 to 22.
  - **No behaviour changed:** 366 tests, eval unchanged.
  - **For the owner's decision:**
    - two AI paths make the build stage's Pipeline Spec;
    - two ways bring a source's metadata in;
    - K2's refresh before a run lost its caller;
    - back-compat palette commands;
    - engine helpers only tests use;
    - a note that v0.45.12 reversed an earlier interview decision under the later PA3 §7.

## 0.45.13

- **PA3b step 6: the context curator** (mcp-engine §9.2 PA3 §4). The last of PA3b's role templates.
- **A host's model reads pack documents the way the panel's LLM does.** Before, `autode_pack_apply` in an agent host stopped at free text ("needs the LLM") and at structured documents in a new format ("needs a profile"), with no way for the host's model to do that work. Now:
  - `autode_pack_reading` returns what reading a document needs: for free text, its sections (by id), the extraction prompt and the document's sha; for a new structured format, the profile prompt; otherwise why nothing is needed.
  - `autode_pack_record_reading` records the answer with the panel's checks:
    - every fact must cite a section the document has, be of an extractable kind and be valid;
    - subjects are resolved against the estate;
    - facts are recorded as proposed, citing their section, and duplicates are skipped;
    - what is dropped is reported with the reason;
    - a document changed since it was read is refused;
    - a proposed profile is always *proposed*, and a confirmed one is never overwritten.
  - The pack manager's `applyDocument()` now runs the panel's LLM through the same three steps (`readingFor`, `recordFacts`, `recordProfile`), so the two paths can't drift.
- **The context curator** (`agents/context-curator.md`) and three skills of AutoDE's own:
  - `autode-core-fact-extraction`: facts the user states in conversation, proposed with the message as evidence. It is the panel's after-every-turn extraction, for hosts where the agent must follow it.
  - `autode-core-document-reading`: the pack's documents, through the two new tools.
  - `autode-core-vocabulary`: abbreviations and synonyms from names, comments, documents and the user, with evidence, then `autode_propose_vocabulary`.

  They have no stage kinds: like the orchestrator, they serve the whole problem.
- **Deliberate deviations:**
  - In VS Code nothing changes: extraction after each chat turn and pack reading stay with the panel's LLM. The curator role is for agent hosts.
  - In hosts, extraction still depends on the agent following the skill, as the spec says; there is no hook for it.
- **Measured:** 366 tests (2 new: the reading steps with their checks, shared by the panel's LLM and a host's model; the curator, its skills and the reading tools over MCP). 3 tests were updated for the new tools and skills. Lint 0 errors. Eval unchanged.

## 0.45.12

- **PA3b step 5: the interview survives, the business analyst, the planner's briefs** (mcp-engine §9.2 PA3 §4 and §7).
- **The interview is kept with the problem (BPS-7).** `.autode/problems/<id>/interview/state.yaml` holds:
  - every question;
  - every answer, with who gave it and through which surface (panel, MCP, CLI);
  - the coverage of the specification's fields;
  - the attachments;
  - the specification it produced.

  Answers are the user's own statements and need no approval; the specification is still approved by a person. An interview that produced a specification is kept as the record and not resumed; the next revision starts a new one.
- **The panel resumes it.**
  - The problem now starts with the interview (it used to start only when the specification was drafted).
  - The interview is saved after every question, answer and attachment.
  - After a reload, a New Chat or a switch of problem, the open interview resumes and its open questions are asked again.
  - New Chat no longer ends the interview. Before, it folded the partial answers into context as a note, and a reload always started a new chat, so an interview never survived a reload. The carry-over is gone.
  - If synthesis produces no specification, the interview stays open.
- **Every surface continues the same interview:**
  - MCP: `autode_interview_state` (parts covered, open questions, answers with who and where) and `autode_interview_record_answer` (questions and the user's answers, by question id or field; refused item by item). `autode_start_problem` starts the interview, and proposing a specification with `autode_propose_spec_change` closes it.
  - CLI: `autode interview show | answer <question-id> "<answer>"`; `autode problems new` starts the interview.
- **The interview's parts are skills.** The seven `skills/*.json` packs became `autode-de-interview-{requirements,sources,data-flow,transformations,quality,constraints}` and `autode-de-specification-authoring`, converted word for word. Their metadata keeps each part's id, order and specification fields.
  - The panel, the MCP prompts `autode_interview_<id>` and the CLI all read them.
  - A team's `.autode/config/skills/*.json` still replaces a part by id.
  - The catalog lists them as AutoDE skills. Its *interview* group now holds only a workspace's own parts.
- **The business analyst** (`agents/business-analyst.md`) has these skills. In an agent host it runs the interview over MCP, recording before asking and continuing whatever another surface started. Its assignment is the specify stage's.
- **Attachments go into the business-problem pack.**
  - A file attached during the interview is registered as a pack document (role *other*, authority *draft*; change them in the Pack view). A file from outside the workspace is copied to `<problem>/pack/files/`.
  - Its extract is kept in the interview, and its text stays in its file.
  - `AttachmentStore` is removed. Pipeline Spec synthesis reads the extracts from the interview, and those of attachments saved before this version.
- **The planner's briefs.**
  - The role template `agents/planner.md` and the skill `autode-core-workflow-planning` refine the drafted workflow and write each stage's brief: scope, constraints, open questions, what to produce.
  - `autode_workflow_draft` (read) gives the deterministic draft without proposing it, with what each stage kind allows (roles, tier ceiling, the skills that fit the platform).
  - Only the plan stage's agent may call `autode_propose_workflow`.
  - The plan check refuses a brief that names AutoDE tools or skills (that is method, which the role and skills carry), one longer than 1,500 characters, and a stage's skills that don't exist or aren't for its kind.
  - The Workflow view shows each stage's brief.
- **Deliberate deviations:**
  - In VS Code, the interview still runs on the panel's own loop (the same skills and state), not as a role-template agent; the business analyst runs as a role template in agent hosts. Moving the panel to the executor would change the interview's UI, and it isn't needed for the same outcome.
  - Briefs can't name tools at all. The spec says a brief asking for a tool above its tier is refused; refusing any tool or skill name is simpler and stricter, and keeps briefs to context.
  - The panel's resume is covered by manual verification (Part 37); the engine, MCP and CLI paths it uses are covered by tests.
- **Measured:** 364 tests: 4 new (the interview on disk; MCP → CLI → MCP continuation and closing; the analyst and the planner as assignments, and the draft that writes nothing; the brief checks). 2 replaced: the bundled-packs test by one for the interview parts as skills (with a team override), and the attachment-store test by one for attachments in the interview. 5 tests were updated for the new tools, skills and catalog group. Lint 0 errors. Eval unchanged.

## 0.45.11

- **Platform skills** (owner, 2026-10-22: platform depth out of the box for the Tiger technical review; mcp-engine §9.2 PA3 §8b). Twelve new skills of AutoDE's own, written from the vendors' public documentation, with no vendor skill text:
  - Snowflake and Databricks: `ingestion`, `pipelines`, `governance`, `performance`, `deployment`;
  - `autode-dbt-project`;
  - `autode-de-reconciliation`.

  They work with no vendor skill installed. See [docs/platform-skills.md](docs/platform-skills.md) (new).
- **Every skill is tested by its worked example.** Each `SKILL.md` ends with an example on the reference problem (retail orders). `test/platformSkillCheck.cjs` checks it:
  - its SQL resolves against the reference estate;
  - it carries no other platform's dialect;
  - a landing table has exactly the estate table's columns;
  - its runbooks pass the engine's checks;
  - its bundles declare their variables;
  - its dbt sources exist;
  - the reconciliation example is exactly what the generator produces.

  `npm test` also feeds it broken copies, which it must reject. The example is inside `SKILL.md` because that is all an agent receives in VS Code (files beside a skill aren't passed on).
- **Who gets them.** A stage gets the skills for its kind and the problem's target platform (as since v0.45.5). Also:
  - a `dbt`-scoped skill needs dbt as the target context's transformation tool;
  - a role gets the platform's skills for a kind even when its own list doesn't name them.

  New role template `target-architect` for platform-setup stages (governance, performance, storage access). The target context stays a form: no skill does target-context stages. The pipeline engineer lists the build and deploy platform skills, and the source assessor lists reconciliation.
- **`autode_reconcile_plan`** (MCP, read-only; mcp-engine §9 named it). For a source table and its target it generates:
  - one aggregate query per side: row count, distinct keys, key nulls, and per mapped column a sum, min/max, distinct count and null count by type;
  - a key hash only when both sides are on one platform (`HASH_AGG` on Snowflake, `xxhash64` on Databricks; hash functions differ between platforms);
  - missing-key anti-joins only when both tables are on one connection;
  - the comparisons to make, with tolerances only for sums.

  Columns come from the problem's mapping. Nothing runs: the agent runs each query read-only.
- **Vendor skills not installed are named, with how a person installs them.** An assignment now also lists the installable vendor skills that would help its stage, and says the user installs them (`autode skills install`, or the Skills view). The agent never installs anything. Installed ones are named as before.
- **The guard hook.** `autode hook guard` reads a host's `PreToolUse` event on stdin. It finds every `snow` and `databricks` invocation in a shell command, however it is chained, wrapped or quoted, and blocks platform changes with exit 2 and a reason that points to runbooks. What passes:
  - reads (list, get, validate, read-only `snow sql`);
  - local setup (`snow connection`, `databricks auth`, `bundle init`);
  - help.

  Anything it can't check (a `snow sql` file it can't open, statements from the terminal) is blocked. Where it is installed:
  - **The plugin folder** has `hooks/hooks.json`.
  - **`autode plugin install --host claude`** merges the hook into `.claude/settings.json`. It keeps the team's hooks, adds it once, and leaves unreadable settings alone with the entry to add by hand.
  - **Cortex Code** reads the plugin layout. Copied skills alone don't bring the hook.
  - **The Copilot CLI** gets a note that the rule is a convention there.
- **Runbook checks know the platforms:**
  - a SQL step carrying the other platform's markers gets a warning (`src/engine/platform/dialectMarkers.ts`: a short list of unambiguous constructs, not a parser);
  - `VACUUM` is destructive;
  - the allowlist adds `snow dbt list | deploy | execute`, `databricks pipelines list-pipelines | get | start-update` and `databricks bundle summary`.
- **Grounding reads platform SQL correctly:**
  - `FROM STREAM(t) alias` resolves `t` and the alias;
  - table functions (`read_files(…)`, `STREAM read_files(…)`) are not tables;
  - dynamic, streaming and Iceberg tables, streams and `CREATE OR REFRESH` count as created objects;
  - the platforms' catalog views (`snowflake.account_usage.*`, `system.*`, `information_schema`) are known;
  - `REVOKE … FROM <grantee>` no longer reads the grantee as a table.
- **Deliberate deviations:**
  - **`platforms:` selection** (roadmap) is the skills' `metadata.platforms`, chosen by the target platform. It shipped in v0.45.5, and is extended here by the transformation tool for dbt. The primitives' `platforms:` field stays in Phase 6.
  - **The skills are tested against the reference estate, not a live platform.** The live walk-through is manual-verification.md Part 36.
  - **The CLI forms are as the vendors document them; the AutoDE CLI didn't run them:** `snow dbt deploy|execute`, `databricks pipelines start-update`, Lakeflow's `CREATE FLOW … AUTO CDC INTO`.
  - **Cortex Code's hook support is unverified:** it reads the plugin layout. Part 36 checks it.
- **Measured:** 360 tests (6 new: the skills' examples and broken copies; the reconciliation plan; platform skill selection; the guard and `autode hook guard`; the plugin's hook and settings merge; platform-aware runbook and grounding checks). 4 tests were updated for the new tool, skills and assignment text. Lint 0 errors. Eval unchanged.

**Also in this release** (fixes from the owner's test of the sample, made between v0.45.10 and v0.45.11):

- **From the owner's test of the sample** (mapping said *not ready* and *in progress* at once; re-opening Source assessment approved it again with no tables found):
  - **Re-opening a document stage keeps it open.** The stage's old document was still marked approved, and the workflow read that as a fresh approval, so the stage closed again within the second (by "unknown", via the document). A re-opened stage now records when it was re-opened (`reopenedAt`); a document approved before then is the version being redone. The stage stays in progress until a new draft, then waits for approval as usual.
  - **A workflow that maps sources needs a source.** A source context that is *not applicable* or lists no source is no longer approved (by the sync or by Approve) when an included stage consumes the source context (mapping, conformance …). The stage shows what to do instead: bring the source into the estate, then pick it.
  - **Per-source tasks follow the estate.** A per-source-system stage's systems and tasks were fixed when the workflow was planned (the sample's was the business-context file). Until the stage is done, they now follow the estate's source systems. Several sources work the same way; one is the usual case.
  - **"Started, but blocked"** replaces *Not ready yet* on a stage that is already in progress. When Source assessment was approved without any tables, the message says to re-open it rather than to run its agent.
- **The target is needed only when the workflow has a target stage**, the same rule the source already followed. The panel no longer asks for a target context in a workflow without one, and shows *Not in this workflow*.
- **The specification card's leftover *Generate Plan* button** (it opened the Workflow view) is now labelled *Open Workflow*.
- **Sources shared as files are found and brought in** (owner's test: the source assessor found "no connected systems" although the sample has DDL files; in real projects, DDLs, extracts and load scripts are often all that is handed over). `findSourceFiles()` (`src/engine/context/sourceFiles.ts`) walks the workspace deterministically and classifies each file:
  - **DDL**: how many tables it creates and in which schemas; it suggests its one schema as the system, else its file name;
  - **data**: CSV or JSON extracts;
  - **load scripts**: SQL with COPY INTO, INSERT or MERGE, and Python or shell that reads or loads data. These are evidence to read, not structure to ingest.

  It skips `.autode/`, `autode-output/`, `node_modules/`, hidden folders and config JSON, and says which files are in the estate already. The source assessor's role and skill now start with it: ingest each DDL and data file as its suggested system, and read the load scripts for what is loaded and from where. In the panel, *Pick from the Estate* first offers to bring in the source files not yet in the estate (ticked by default), then the systems to pick. Over MCP it is `autode_find_source_files`; in a terminal, `autode estate files`. The Workflow view's hint for the source stage no longer mentions the retired *connect* option.
- **Measured:** 354 tests (2 new: replaying the sample; the source files, over the engine, MCP and the CLI). Lint 0 errors.

## 0.45.10

- **SIMP-4: the contexts reference the workspace** (owner, 2026-10-22, after asking for a review first; roadmap decision log). The review found:
  - `target-environment.yaml` was read by nothing;
  - the estate, catalog and ledger already hold far more about sources than a source context did;
  - but each problem's contexts carry what the workspace can't: which systems this problem uses, its own target decisions, and someone's approval.

  So both contexts stay, and they now point at the workspace instead of describing it again. Folding them into the ledger was rejected: typed fields keep their readers deterministic, and a fact about the estate is a different thing from one problem's choice.
- **The target context picks a target connection.** The panel's form starts with the workspace's target connections (or *none yet*). The connection decides the platform and the default database; the context keeps the problem's decisions: modelling approach, transformation and orchestration tools, naming, target database and schema. A named connection that doesn't exist, or a platform that contradicts it, is refused. The environment-profile question is gone: the runbook approval policy uses the connection's estate environment.
- **Defaults come from the team.** The form suggests the specification's own words first, then the team's facts in the ledger (a project-wide naming convention; decisions on modelling approach, transformation or orchestration tool, target platform), then the last approved target context of another problem, then a built-in default. Each suggestion says where it came from.
- **The source context lists estate systems.** *Pick from the Estate* lists the estate's source systems to tick; *Describe Source* stays for a source with no connection. A connected or file entry must name an estate system (or the connection or file bound to one); table counts are no longer copied in (the catalog has them live). The old settings-based *Connect to Source* check is gone: sources come into the estate through ingestion or extraction.
- **Every surface can record both** (parity): `autode_record_target_context` is new (with no arguments it returns the choices: target connections, allowed values, estate systems); `autode_record_source_context` takes `system`; `autode context show|target|sources` in a terminal. All three use the panel's code (`src/engine/context/problemContexts.ts`).
- **Removed:** `TargetConfigManager`, the profile types, `environmentProfile` and `outputFormats`. An existing `target-environment.yaml` is left alone.
- **Fixed (from v0.45.9):** Run agent asked for the stage's context gaps through a tool name that doesn't exist (`autode_context_pack`; it is `autode_get_context_pack`), so its assignments had no gaps; the error was swallowed. A test now calls the real tool.
- **Measured:** 352 tests (1 new, covering both contexts across the engine, MCP and the CLI, and the gap tool; the `TargetConfigManager` test was removed with it). Lint 0 errors. Eval unchanged.

## 0.45.9

- **SIMP-3: the plan of steps is removed** (owner, 2026-10-22; roadmap decision log). The workflow has been the only path since v0.45.1; the code behind the old path is now gone too.
- **Removed:**
  - `PlanManager` and the problem's `plan/` folder (no longer written; an existing one is left alone and ignored);
  - `AgentHub`'s plan generation, validation, execution, pause and re-plan; phase inference (`phaseInference.ts`); the Snowflake check executor (`snowflakeExecutor`), the plan's only remaining agent;
  - the plan's types (`PlanState`, `PlanStep`, `PersistedPlan`, `InferredPhase` …) and the panel's plan messages;
  - the commands *Generate Plan*, *Execute Plan* and *Reset Session*;
  - **the AutoDE Dashboard panel** (owner's choice). Everything it showed came from the plan's phases and steps; the Workflow view shows progress and each stage's outputs.

  `AgentHub` went from 1,751 lines to 746: it now holds the specification, chat and the model with tools.
- **The sidebar's next step after the specification is Open Workflow.** `/plan`, `/execute` and `/workflow` open the Workflow view; the stop button (it paused plan runs) is gone.
- **Context gaps are in the stage's assignment.** They used to pause a plan step. A mapping, modelling, build, quality-rules, conformance or validation stage now gets the joins, keys, grain and object structure its context can't back, each with its question, in a *Context gaps* section of its assignment (`Assignment.contextGaps`). The agent is told not to infer them: ask the person, propose the fact, or record the gap as open in its deliverable, which the person approving the stage sees. Nothing pauses. It is the same on every surface: `autode_workflow_next` builds the gaps from the server's context, and Run agent gets them through `autode_get_context_pack` (`src/engine/agents/stageGaps.ts`).
- **Run agent checks that a stage can be done before calling the model** (owner's UI test of the sample: Run agent on Mapping "failed"). The mapper had run on an estate with no tables, and could only write notes saying so. Three fixes:
  - **Readiness.** Mapping, quality rules and conformance need tables in the estate. Modelling and the build need mappings in the mapping document. The check is deterministic: it reads the compiled estate graph and the problem's documents, and calls no model. It applies everywhere:
    - **Run agent** refuses with what to do (for mapping: Run agent on Source assessment, Ingest File, or `autode estate ingest` / `autode estate extract`);
    - **the Workflow view** shows the same before anyone clicks: no Run agent, and *Not ready yet: …*;
    - **`autode_workflow_next`** returns `notReady`, and the orchestrator skill tells the user instead of starting the agent.
  - **A document stage is drafted only when its document is.** A run that recorded only notes used to say "drafted, approve it". It now reports that the document (for example `context/source-context.yaml`) was not drafted, with the agent's reply.
  - **The business-context file is no longer a source system.** Re-keying the terms of `business-context.yaml` registered that file in the estate as a source system. As a result, the workflow planned a source stage for it, and the estate counted it as a source. Knowledge-file origins now never create a system, and a system bound only to `business-context.yaml` or `verified-queries.yaml` (in estates written before this fix) is not counted as a source.
- **Measured:** 352 tests. 31 tests of the plan, phase inference and `PlanManager` were removed with them; 2 are new (the readiness check; the plan's removal and the gaps in assignments), and the hub's reset test was rewritten. Tests that read old agents' names out of `agentHub.ts` now check that they are gone. Lint 0 errors. Eval unchanged (its plan-step context figure measures the pack, which stays).

## 0.45.8

- **SIMP-2: one way for each change** (owner, 2026-10-22; roadmap decision log). Two duplicate paths are gone.
- **Platform changes are runbooks, only.** Retired:
  - the single-statement `platform_change` decision;
  - `autode_propose_platform_change` and `autode_apply_decision`;
  - the MCP server's `--allow-write` flag.

  The server's platform session now never writes. Only AutoDE's runner creates one that may, for an approved runbook's change steps. `autode_execute_query` and the server's instructions point to `autode_propose_runbook`. A platform-change decision approved before this release is not run: applying it fails, saying "propose it as a runbook".
- **Mappings live in the mapping document, only.** Retired:
  - `autode_propose_mapping` (drafting goes through `autode_record_mapping`, which validates the same way and writes the draft that the mapping stage approves);
  - the `mapping` fact kind. Nothing produced it, and proposing one now says to record the mapping instead.

  A mapping decision approved before this release still lands, as a draft in the mapping document. Old decision files and ledgers keep reading.
- **Why it's safe now:** the `autode` package is unpublished, so no outside client depends on the retired tools or the flag.
- **Measured:** 381 tests. The two v0.40.0 tests of the retired paths were rewritten as retirement tests: a direct write is refused and points to runbooks; an old approved platform change fails with where to go; the flag is gone; there is no proposal tool or fact kind for mappings; an old approved mapping decision still lands. The decision mechanics they also covered (stakes recomputed, never read from the file; a file resolution needs a name) now use a connection proposal. The engine-client tests use the vocabulary proposal as their sample. Lint 0 errors. Eval unchanged.

## 0.45.7

- **SIMP-1: one approvals list, and the concept map** (owner, 2026-10-22: simplify before adding capability; roadmap decision log). The first of four simplification releases.
- **Waiting for you.** Everything that waits for a person is now in one list, whatever mechanism records it:
  - pending decisions of every kind (workflow, stage gates, runbooks, connections, proposals);
  - the Context Inbox's facts, grouped, with how many are high stakes;
  - stage documents drafted and waiting for approval;
  - runbooks that need their second approver.

  It is sorted high stakes first, then oldest. It appears at the top of the Workflow tree (opening each item where it is approved: the Workflow tab, the Runbook tab, the Context Inbox or the decision file), with a count in the status bar, and as `autode approvals` in a terminal and `autode_approvals_list` over MCP. Approving still goes through each mechanism's own code: the list adds no second rulebook, and each item shows the terminal command that approves it.
- **The concept map** is now the start of the engineering onboarding guide's §4 (owner: no separate document). It covers the twelve concepts a data engineer works with, the guarantee each carries, how they fit, the definitions a team adapts, what is internal, and what is being simplified. The stale parts of the guide were rewritten:
  - "Lifecycle gates" (in `AgentHub`) is now the workflow, stages and approvals;
  - "Phases, plan and agents" is now agents, skills and assignments;
  - the spec → plan → execution flow is now spec → workflow → stages;
  - runbooks are new (§4.12).
- **A stage no AutoDE skill does is manual.** It is labelled so on the board and in the tree, and gets no agent. **Fixed:** such a stage used to get an agent with the wrong method. For example, a BI migration stage got the documenter with its documentation skill, because the documenter is allowed on BI migration stages. An assignment now needs a skill for the stage's kind (or one the plan named). **As a result, deploy stages are manual until the platform skills (v0.45.11)**; agents in hosts can still propose runbooks for them.
- **Measured:** 381 tests (2 new: the gathered list across mechanisms, the CLI and MCP; manual stages and the concept map). Lint 0 errors. Eval unchanged.

## 0.45.6

- **The runner: runbooks approved by a person, run by deterministic code** (owner, 2026-10-22; requirements ORC-10; `docs/mcp-engine-requirements.md` §9.2 PA3 §8a; technical-design §7.9). Everything that changes a data platform now goes through one controlled path. No agent runs a platform command.
- **Runbooks.** An agent proposes one with **`autode_propose_runbook`**: the steps in order, each one of
  - one SQL statement on the connection;
  - a Snowflake or Databricks CLI command as an argument list, never a shell string;
  - a Databricks bundle folder,

  with what it is expected to do, and a rollback for anything destructive.
- **The engine checks the runbook before anyone sees it:**
  - **classification:** every step is read, change or destructive, by the engine (`DROP`, `TRUNCATE`, `DELETE`, `REVOKE`, `CREATE OR REPLACE`, `ALTER … DROP`, `OVERWRITE` and `bundle destroy` are destructive), never by the agent;
  - **CLI commands** must be on AutoDE's allowlist or the team's own;
  - **arguments:** no profile or credential flags (the runner adds the connection's profile itself), nothing that looks like a secret, paths inside the workspace;
  - **CLI steps** need a connection whose credentials come from the CLI's own configuration;
  - **destructive steps** need a rollback or a stated reason;
  - **the environment's policy** must allow the step classes.

  It refuses item by item.
- **Approval is a person's, under the team's policy.** A runbook is a high-stakes decision, approved in the panel, `autode runbook approve` in a terminal, or the decision file. `.autode/config/approvals.yaml` sets, per environment:
  - which connections belong to it;
  - who may approve;
  - whether a second, different approver is needed;
  - whether the remaining steps may run on one click;
  - which step classes are allowed.

  **A connection no environment lists counts as production**, and production needs a named approver and never runs unattended, whatever the file says. Approvals are bound to the runbook's content: editing an approved runbook voids them.
- **Running it.** The runner (`src/engine/runner/`) is deterministic code:
  - steps run strictly in order, one per click (or all remaining, where the environment allows), with a dry run first where the step has one (`EXPLAIN` for SQL changes, `bundle validate` for bundles);
  - SQL goes through the same connectors as everything else; commands go through the user's own CLI, with no shell. Read steps report row counts, never values;
  - it stops at the first failure and offers the step's rollback;
  - every action goes to `.autode/problems/<id>/runs/<runbook>.jsonl`, **hash-chained**, with the command and output redacted and truncated. `verifyRunLog()` shows when a line was changed or removed;
  - a runbook that belongs to a stage hands the stage in when its last step succeeds, with the runbook and its log as the outputs.
- **The Runbook tab in VS Code** (*AutoDE: Open Runbook…*, or from the stage in the Workflow view) is the wizard. It shows:
  - the environment's policy;
  - every step with the engine's classification, exactly what runs, its dry run, its rollback and its state;
  - the agent's explanation, labelled "not checked by AutoDE";
  - the approvals and the log;
  - buttons: Approve, Reject, Dry run, Run step, Run remaining, Roll back. Each change is confirmed in a modal that names the connection, the environment and the command.
- **Other surfaces:** `autode runbook list | show | approve` and `autode_runbook_status` (MCP). The pipeline engineer proposes deploy runbooks. The interactive terminal runner stays in the backlog, by the owner's decision.
- **Install guidance is data, probed before it is offered** (owner, 2026-10-22: the same concern as the external skills' install commands). The new shipped `prerequisites.yaml` holds, for the Snowflake and Databricks CLIs:
  - the vendor's page and the date it was last verified (2026-10-22, against the vendors' pages);
  - package-manager options per OS: Homebrew (with the `brew trust` step Homebrew 6 needs), pipx, uv and WinGet (`Databricks.DatabricksCLI`). Snowflake has no WinGet package;
  - a note when a method is linked rather than run: the Databricks curl script, because it pipes a download into a shell.

  Each option is probed (its package manager answers `--version`) before it is offered, and runs only on a click in the AutoDE terminal. `autode doctor` lists the available options. A team overrides the file in `.autode/config/prerequisites.yaml`, for example for an internal software centre. **The Oracle driver's package and range stay in code**: they are a compatibility contract with AutoDE's adapter.
- **Deviations / notes:**
  - **The second approval** is recorded on the runbook (the Runbook tab, or `autode runbook approve`), not as a second decision. The first approval resolves the decision.
  - **Snowflake CLI steps** cover connection test, object list and describe, and stage list and copy. SQL goes in `sql` steps, one statement each; `snow sql -q/-f` is not allowed, because a file's statements couldn't be classified one by one. Teams add commands in `runbooks.allowCommands`.
  - **Bundles** are Databricks only. Snowflake projects are deployed through their SQL and stage steps until the platform skills (v0.45.7).
  - **The deploy stage's gate still goes to a person** after the run, to accept the result.
- **Measured:** 379 tests (5 new: classification and checks; the policy; a runbook end to end, including dry runs, failure, rollback, log tampering, edits and the stage hand-in; production with two approvers across MCP and the CLI; install guidance as data). Lint 0 errors. Eval unchanged.

## 0.45.5

- **The skill catalog and the naming convention** (owner, 2026-10-22; requirements SKL-9; technical-design §7.9; `docs/skills.md`). Every skill AutoDE has or works with now has one view, kept current by construction.
- **AutoDE's skills are named `autode-<scope>-<capability>`** with hyphens. Scopes: `core` (how AutoDE works), `de` (platform-neutral data engineering), `snowflake`, `databricks`, `oracle`, `dbt`. The 8 skills are renamed:

  | Was | Now |
  |---|---|
  | `autode-orchestrator` | `autode-core-orchestrator` |
  | `documentation` | `autode-de-documentation` |
  | `quality-rules` | `autode-de-quality-rules` |
  | `source-assessment` | `autode-de-source-assessment` |
  | `conformance` | `autode-de-conformance` |
  | `mapping` | `autode-de-mapping` |
  | `modelling` | `autode-de-modelling` |
  | `pipeline-build` | `autode-de-pipeline-build` |

  The prefix also keeps AutoDE's skills from colliding with other skills in a host's shared skills folder.
- **Skills declare what they are for** in the Agent Skills `metadata` map: `scope`, `stageKinds`, `platforms`, `version`, `owner` and `maturity` (`tested`, or `preview` without a fixture test). The files stay standard, and the loader refuses a skill that breaks the convention, item by item.
- **Stages pick skills by metadata, not by name.** A stage gets the skills whose `stageKinds` include its kind and whose `platforms` fit the problem's target platform (from the target context). A Snowflake skill joins a build on Snowflake, not one on Databricks. The role chosen is the one that has such a skill (the planned role first). This replaces the v0.45.2 rule that a skill's name equals its stage kind.
- **The catalog** has four groups:
  - AutoDE's skills, from their frontmatter, with the roles that use them;
  - this workspace's imported skills, with their review state;
  - the interview packs;
  - **external skills**, which are references only.

  It is shown in the new **Skills view** in VS Code, by `autode skills list | show` and `autode_skills_list` (MCP), and on the generated page `docs/skills.md` (`npm run docs:generate`, checked by `npm test`).
- **External skills without breaking their licences.** `skills/external.yaml` lists 14 vendor and community skills with their source, licence, availability (installable, host-only or importable), the stage kinds and platforms they help with, and a summary in AutoDE's own words. No vendor text is copied:
  - the 11 Databricks agent skills AutoDE's stages use are under the Databricks License, so they are marked "referenced, not redistributed";
  - Cortex Code's built-in skills are host-only, available inside Cortex Code;
  - two Snowflake-Labs community skills are importable after their per-skill licence is checked.

  Installed vendor skills are detected in the hosts' skills folders. An assignment names the installed ones for its stage, with "AutoDE's rules still apply"; uninstalled ones appear only in its data, so a UI can offer them.
- **Install commands are data that is checked, not trusted:**
  - each installer records its command, minimum CLI version and the date it was last verified;
  - `autode skills check <name>` and the view's Install button **probe** it first (CLI version, then a harmless `--help`). If the vendor has changed it, AutoDE shows the docs link instead of a stale command;
  - a team corrects or adds entries in `.autode/config/external-skills.yaml` without waiting for an AutoDE release;
  - **installing is a person's act**: `autode skills install` needs an interactive terminal and a typed confirmation, and the view runs the command in the visible AutoDE terminal only on a click;
  - "installed" means the skill was found in a host's skills folder afterwards, not that the command exited 0.
- **Re-installing the plugin cleans up after itself.** `autode plugin install` now records what it installed (`.autode-installed.json` in each skills folder). On the next install it removes what it installed before and no longer ships, and AutoDE's pre-v0.45.5 skill folders. It never touches a folder it didn't install: an old name is removed only when its `SKILL.md` is AutoDE's (it names AutoDE's tools).
- **Deviations / notes:**
  - **Hyphens, not the requested underscores** (`autode_*`). The Agent Skills standard that Claude Code, Copilot and Cortex Code follow allows only lowercase letters, digits and hyphens, so hosts would reject an underscore name. MCP names keep underscores (`autode_skills_list`), as their convention is.
  - **The registry release went first.** It became v0.45.5, so the runner moves to v0.45.6, the platform skills to v0.45.7, and the business analyst with the planner and the context curator to v0.45.8 and v0.45.9. Renaming before the platform skills arrive means they don't need renaming later.
  - **Probing the install commands in CI** (catching a vendor change before users do) goes to the backlog.
- **Measured:** 374 tests (5 new: naming and metadata; platform-aware selection and vendor skills in assignments; the catalog, team overrides and probes; the CLI and MCP; plugin clean-up, packaging and the view). Lint 0 errors. Eval unchanged.

## 0.45.4

- **Phase PA3b, step 4: the pipeline engineer** (`docs/mcp-engine-requirements.md` §9.2 PA3b; requirements SKL-6, GEN-1, GEN-2; technical-design §7.9). The build stage is done by the `pipeline-engineer` role with the `pipeline-build` skill, the same in VS Code (Run agent) and in any host. It drafts the Pipeline Spec from AutoDE's primitive candidates, compiles it with AutoDE's compiler, and records the code with grounding manifests. Deleted:
  - the TypeScript `ingestionAgent` and `transformScaffoldAgent`;
  - their LLM codegen helpers (`src/agents/llmCodegen.ts`, `src/agents/llmParamSelector.ts`);
  - the v0.45.1 per-stage bridge to the old agents (`AgentHub.runStageSteps`, `LEGACY_AGENTS`), since every stage with an agent now has a role template.

  The plan of steps keeps only `snowflakeExecutor` until it goes (v0.45.6).
- **`autode_primitive_candidates`** (read-only, deterministic) gives the steps a mapped source needs, with parameters filled in from what AutoDE knows:
  - `rename_cast`: a staging view that projects, renames and casts the mapped columns;
  - `dedup`: one row per key (from the key fact), the latest by the change column (`updated_at`, `modified` …);
  - `incremental_load`: a MERGE on the key.

  Each step has its reasons, including the fact and its trust, and whether it is still unconfirmed. Each is validated against its primitive. What no primitive covers comes back as notes: column expressions such as `SHA2(email)`, a missing key or change column, a key that isn't fully mapped. Columns default to the problem's mapping for that source.
- **`autode_record_pipeline_spec`** drafts the problem's Pipeline Spec:
  - AutoDE fills in its id, version (bumped after an approved revision, which is archived) and lineage (the specification it derives from);
  - the spec and every step are validated against its primitive, with errors step by step.

  A person approves it as the build stage's document. `autode_compile_pipeline_spec` then gives the code.
- **Decision backing for host agents.** `autode_record_artifact` takes `primitives`: the steps a compiled file came from, with `lineage`, the estate table their columns trace to. The file's grounding manifest then records which facts back each key and order decision, the same as AutoDE's own build. The `lineage` field is new on grounding manifests' primitive uses.
- **Fixed in grounding manifests:** a key or grain fact written with a table's name (`shop.orders`, as agents propose them over MCP) now backs a decision about that table. The manifest used to compare only resolved node ids, so such facts never counted.
- **The eval measures the deterministic build.** Its offline artifacts used to come from the deleted agents' template fallbacks. They now come from AutoDE's own path: `autode_primitive_candidates` for each source in `plan.yaml`'s new `buildSources`, every valid step accepted, compiled by the engine, with a grounding manifest per file. The plan steps remain only as context probes. New baseline `baselines/v0.45.4-offline.*`:
  - expected artifact properties **4/8**, was 1/8 (E1 deduplicates orders on `order_id`, E6, E7, E8);
  - identifier grounding **100% (5/5)**, was 0% from the template tier;
  - decision backing **83% (5/6)**, was n/a.

  The agent's own choices and its custom SQL (masking, net-revenue filters, SCD2, the refunds join: E3–E6) are measured with host-agent runs in PA3c. This compares a different producer, not an improved one.
- **Findings from the eval:**
  - **The `incremental_load` primitive has no watermark.** It compiles a plain MERGE of the whole source, so property E2 ("orders load incrementally on updated_at") fails. It goes to the backlog for the primitive.
  - **Fixed in `autode_primitive_candidates`:** a key fact on `crm.customers` was matched to `shop.customers` by the bare table name across systems. Two systems' `customers` tables also produced two entities with the same name. Only an unqualified subject now matches by name, and default names keep the schema (`shop_customers`, `stg_shop_customers`).
- **Deviations / notes:**
  - The skill is `pipeline-build`, not the spec's `pipeline-scaffolding`. Code-conversion import and deployment are not part of this step: their stages keep hand-in.
  - **GEN-2 changes shape.** The LLM no longer picks a primitive inside a plan step. The engine proposes the primitives and their parameters from facts; the agent accepts them into the Pipeline Spec; the compiler generates the code.
- **Measured:** 369 tests (2 new: the candidates; the pipeline engineer over MCP, through the compile, decision backing and approval). Removed 7 unit tests of the deleted codegen helpers. Tests that used the build agents as generic plan agents now use `snowflakeExecutor`. Lint 0 errors (30 warnings, 3 fewer).

## 0.45.3

- **Phase PA3b, step 3: the data modeler** (`docs/mcp-engine-requirements.md` §9.2 PA3b; requirements SKL-6; technical-design §7.9). The modelling stage is done by the `data-modeler` role with the `modelling` skill, the same in VS Code (Run agent) and in any host. The TypeScript `dataModelerAgent` is **deleted**. Whenever its model call failed, it fell back to a fixed customer/product/sales template.
- **`autode_draft_model`** (read-only, deterministic) drafts the model from what AutoDE knows:
  - one entity per mapped target, with the mapped columns (types from the source columns, or from the target table when it exists) and their transforms;
  - the kind from the name (`fct_`, `dim_`, `bridge_`, `hub_`, `link_`, `sat_`);
  - grain and keys from key and grain facts (confirmed or proposed, never rejected), about the target or about its single source through the mapping, each with where it came from;
  - in a dimensional model, a surrogate key for each dimension, with the business key as its natural key;
  - foreign keys from relationship facts between sources mapped to different targets;
  - the target context's approach, naming, database and schema.

  What isn't known comes back as gaps: no grain, no key, SCD type not decided, an unknown type, a fact with no foreign keys, a relationship or grain that isn't fully mapped.
- **`autode_check_model`** (read-only) checks the refined model:
  - errors: every entity has a grain and a primary key made of its own columns; foreign keys reference entities and columns in the model with matching arity; no duplicates; every mapped target column is in the model;
  - warnings: naming convention, SCD type, missing types, facts without foreign keys.

  It returns the **DDL that AutoDE renders from the model**: referenced entities first, primary and foreign keys, the grain as a comment. The agent records that DDL and never writes it by hand.
- **The data modeler**:
  - starts from the draft;
  - closes the gaps: a grain or key that is a choice is proposed as a fact for the Context Inbox, not assumed;
  - applies the approach (surrogate keys, SCD types, conformed date dimension, a home for every measure in a dimensional model; hubs, links and satellites in a data vault);
  - checks the model, and records `model.yaml`, `model.sql` (the rendered DDL) and `model.md` (entities, decisions, proposed facts, warnings).

  The stage is handed in, and a person approves the model at its gate.
- **Deviations / notes:**
  - **No `autode_propose_model`.** The spec listed a model proposal. Like the other deliverables since v0.45.0, the model is recorded as the stage's artifacts and approved once, at the stage's gate.
  - **Only the build stage still uses AutoDE's old agents** (ingestion and transformation, v0.45.4).
  - **The development build's size budget moved from 1.5 to 2 MB.** The unminified `dist/autode.js` grew to 1.55 MB. The shipped build is minified (about 830 KB), and the package test still budgets the tarball.
  - **Eval:** the reference plan loses its model step. Identifier grounding stays at 0% offline, as before (the template tier, until a cassette is recorded), but the count moves from 0/2 to 0/5: the ingestion step now runs without the model step's output, so its fallback SQL names more identifiers. Every other metric is unchanged.
- **Measured:** 374 tests (3 new: the draft from mapping and facts; the check and the DDL; the data modeler over MCP). Tests that used `dataModelerAgent` as a generic plan agent now use the ingestion or transformation agent; the v0.45.1 per-stage legacy test now runs the build stage. Lint 0 errors.

## 0.45.2

- **Phase PA3b, step 2: the source assessor and the mapper** (`docs/mcp-engine-requirements.md` §9.2 PA3b; requirements SKL-6; technical-design §7.9). Source assessment, conformance and source-to-target mapping are now role templates with skills. They work the same in VS Code (Run agent) and in any host (`autode_workflow_next`, the plugin). The TypeScript `sourceAssessmentAgent` and `sttmAgent` are **deleted**, with the unused `src/spokes/{sttmAgent,ingestionAgent}.ts`.
- **`source-assessor`**, with the `source-assessment` and `conformance` skills:
  - brings each source system into the estate (`autode_ingest_metadata` for a connection, `autode_ingest_file` for DDL, CSV or JSON);
  - profiles keys, nulls, orphans and freshness with read-only aggregate queries;
  - proposes keys, grain and relationships as facts for the Context Inbox;
  - drafts the source context with the new **`autode_record_source_context`**: each system as connected, file or described; a system it can't reach is described, never invented;
  - records `source-assessment.md`;
  - on a conformance stage, checks the sources against the pack's contracts and records `conformance-report.md`.
- **`sttm-mapper`**, with the `mapping` skill:
  - takes evidence from the new **`autode_match_columns`**;
  - writes each entity mapping, column by column with transform expressions, with the new **`autode_record_mapping`**, so the mapping stage now gets structured mappings (the old agent wrote a SQL view);
  - records `mapping-notes.md`: target columns with no source, overruled suggestions, open questions.
- **`autode_match_columns`** (read-only, deterministic): candidate matches from a source table to a target table in the estate, or to a planned table's columns. Each candidate has a score and its reasons:
  - the same name, or the same name without the table's prefix (`ord_status` → `status`);
  - the same meaning through the customer's vocabulary (`CUST_NO` → `customer_number`);
  - words in common;
  - how the same column was mapped in any approved mapping of the workspace.

  Types that can't convert (timestamp to number) halve the score. The matches are one-to-one, with runners-up for the agent to weigh.
- **Drafts, approved as the stage's document.** `autode_record_mapping` validates against the estate (errors item by item) and `autode_record_source_context` validates each entry. Both write the document as `built`, pinned to the current specification, and note it in the stage's history. A person approves it from the Workflow view or with `autode workflow approve <stage>`. **Run agent** on a document stage drafts it and leaves it for approval, and it can be run again while the draft waits.
- **Fixed:** a mapping recorded when the problem had no mapping document yet (through `autode_propose_mapping` and its decision) was written with an empty specification id, so it could never be approved. Mappings are now pinned to the current specification, as the panel pins them.
- **Assignments pick the right role and skill.** A stage goes to the role, among those its kind allows, whose skills include the stage kind's skill (the planned role first). That role then gets only that skill: the source assessor gets `conformance` on a conformance stage and `source-assessment` on a source-assessment stage. Before this, a quality stage planned for `source-assessor` would have gone to the source assessor once it had a definition; it now goes to the quality engineer.
- **Deviations / notes:**
  - The skills are named `conformance` and `mapping`, not the spec's `contract-conformance` and `sttm-mapping`, because skill names now match their stage kind. Quality rules belong to the quality engineer (v0.45.1), not the source assessor. The spec's role table is updated.
  - **Reconciliation and entity resolution** (the spec lists them under these roles) are not part of this step. Their stages still offer hand-in and skip.
  - **`autode_record_mapping` drafts without a decision.** `autode_propose_mapping` still exists for a single mapping outside a stage. Inside a stage, the person approves the whole mapping once, the same rule as v0.45.0's artifacts.
  - **Eval:** the reference plan loses its source-assessment and mapping steps, which are now stages done by host or in-process agents (measured in PA3c). With fewer agent steps, the counts shrink: SQL identifiers 3 → 2, manifests 11 → 9, median step context 529 → 272 tokens. Every other metric is unchanged.
- **Measured:** 371 tests (3 new: the matcher; the source assessor and mapper over MCP, through to approved documents; Run agent on a document stage and the retired agents). Tests that used the retired agents as generic plan agents now use the data modeler. Lint 0 errors.

## 0.45.1

- **The workflow is the only path** (owner's UI testing, 2026-10-21). Four findings, one cause: two systems were running side by side, the old plan of steps and the workflow.
  - The plan steps couldn't be seen, and the proposed workflow wasn't shown before approval.
  - Quality rules had nothing to produce them.
  - The mapping couldn't be approved from the UI.
  - Artifacts were generated outside the stages, so progress didn't move.
- **Every stage now has a way forward,** shown as a **Next:** line on its card, in the tree and in the detail:
  - **Run agent:** the stage's role template (the documenter, and now the quality engineer); otherwise AutoDE's not-yet-migrated agents for that stage kind only, on any model:
    - source assessment: the source assessment agent;
    - modelling: the data modeler;
    - build: the ingestion and transformation agents.

    What they write is recorded to the stage, with grounding manifests as before, and handed in. A failed run is reported to the stage and never re-plans the problem.
  - **Produce:** for stages whose output is a document, the panel's own flow (specification, target and source context in the panel; *Add a mapping…*; *Generate the Pipeline Spec*). **Open document** shows it.
  - **Approve…:** for a stage's document. It is checked first, with the panel's own checks: a mapping needs at least one entity mapping, and a context must match the current specification version. Then it is approved as you (the panel channel) and the stage is done. While it can't be approved, the card says why.
  - **Hand in** and **Skip** as before. A stage that no AutoDE agent does yet says so.
- **The same approval in a terminal:** `autode workflow approve <stage>` now also approves a stage's document (specification, target or source context, mapping, Pipeline Spec). It asks for an interactive terminal and a typed confirmation, and records you on the CLI channel. No MCP tool approves a document: that is a person's act.
- **The proposed workflow is shown in full** in the Workflow tab before you approve it: every stage with its kind and inclusion, which are in, and the reason each left-out stage is out (optional stages left out: "optional, not included"), plus the engine's objections if it refuses the draft.
- **Quality rules have an agent:**
  - the `quality-engineer` role with the `quality-rules` skill: rules on critical attributes (not-null, unique, accepted values, ranges, relationships, freshness, reconciliation), each traced to a spec criterion, contract clause or fact;
  - each rule is proposed as a `quality_expectation` fact for the Context Inbox and recorded as `quality-rules.yaml` and `quality-rules.md`;
  - `quality-rules` stages now list `quality-engineer` first;
  - an assignment falls back to the first role its kind allows that has a definition, so workflows approved earlier (which named `source-assessor`) get it too.
- **Nothing runs outside the workflow.** The panel's Generate Plan, Approve Plan, Confirm Stages and Execute buttons, and `/plan` and `/execute`, now open the Workflow view and explain that AutoDE works stage by stage. The Workflow tab's *AutoDE agents* box is gone.
- **Deviations / notes:**
  - **The increments move up by one.** This release is the "one path" fix, so the PA3b migrations shift to v0.45.2 to v0.45.6. In the new order, source assessment and mapping come next: the mapping agent is what gives the mapping stage structured mappings. Today's mapping agent writes a SQL view, not the mapping document, so mappings are added with *Add a mapping…* until then.
  - **The quality engineer is a new role**, not one of the eight agents being migrated. It was added because the quality stage had nothing that could produce its output.
  - **The plan-of-steps code stays inside `AgentHub` for now,** because the not-yet-migrated agents run through it one stage at a time. It goes with the last migration.
- **Measured:** 368 tests (4 new: the proposal view; document approval from the view model and the CLI, refusals included; ways forward, role fallback and legacy per-stage runs; no path outside the workflow). Lint 0 errors. Eval unchanged.

## 0.45.0

- **Phase PA3b, step 1: agents as definitions, and the first agent moved** (`docs/mcp-engine-requirements.md` §9.2 PA3b; requirements SKL-6, ORC-9; technical-design §7.9). Agents are now **role templates** (`agents/<role>.md`), and their method is **standard skills** (`skills/<id>/SKILL.md`). Both are files that every host reads the same way. The engine turns them into **assignments**.
- **Assignments.** For a stage, the workflow (the hub) combines:
  - the role template;
  - the planner's brief, if any;
  - the role's skills;
  - the stage's permission tier.

  From these it derives exactly the AutoDE tools the agent may call: tools above its tier are excluded, destructive tools (resolving or applying decisions) are never granted, and workflow control (start, hand in, skip, re-open, re-plan) stays with the hub. Recording the stage's own deliverable is allowed at any tier. A role can narrow its tool list, never widen it.
- **The same assignment on every surface:**
  - **MCP:** `autode_workflow_next` returns it in full, including `assignment.text`, the instructions to follow;
  - **hosts without sub-agents:** `autode_agent_<role>` prompts carry it (with a `stage` argument, the full assignment);
  - **VS Code:** the Workflow view's **Run agent** action runs it with the model configured in AutoDE.
- **`autode_record_artifact`.** The agent doing a stage records each deliverable with this tool:
  - the file goes to `autode-output/<problem>/<phase>/<stage>/`, and the previous revision is archived to `history/`;
  - it gets the same grounding manifest the panel writes (unresolved tables and columns are reported);
  - it is noted in the workflow's history ("recorded by agent …").

  It is a draft: the stage's gate is where a person accepts it.
- **The VS Code executor** (`src/core/agentExecutor.ts`):
  - starts the stage as the agent;
  - runs the assignment with an engine client named after the role, so the history says "documenter (VS Code)";
  - hands the stage in with the recorded files and the agent's summary.

  It refuses cleanly when nothing was recorded, and when the model is Claude Code, which runs its own tool loop: the plugin is the way there.
- **The first migration: the documenter.** The documentation stage is done by the `documenter` role with the `documentation` skill:
  - `design.md`, `data-dictionary.md`, `runbook.md` and `decisions.md`, from the approved spec, the workflow history, the context pack and the Pipeline Spec;
  - every named table and column is checked with `autode_resolve`, and quoted SQL with `autode_check_grounding`.

  The TypeScript `architectureAgent` (`DocumentationAgent.ts`, and the unused `src/spokes/architectureAgent.ts`) is **deleted**. Plans can no longer name it. A step in a saved plan that does fails with a message saying where documentation went.
- **The orchestrator skill** (`skills/autode-orchestrator/SKILL.md`) is the hub's loop for agent hosts:
  1. status;
  2. next assignment;
  3. run it as the named sub-agent, or follow it directly;
  4. hand it in;
  5. stop at every approval, and tell the user how to give it.
- **`autode plugin`:**
  - **`autode plugin path [--out]`** builds the plugin folder: `.claude-plugin/plugin.json`, `.mcp.json` wiring `autode mcp`, `agents/`, `skills/` and `commands/` (`/autode-status`, `/autode-next`, `/autode-approve`, which never approves). Claude Code loads it with `--plugin-dir`, and Cortex Code reads the same layout.
  - **`autode plugin install --host claude|cortex|copilot [--scope project|user]`** copies the same files into each host's own folders:
    - Claude Code: `.claude/`; the project's `.mcp.json` is merged, keeping other servers;
    - Cortex Code: `.cortex/skills` or `~/.snowflake/cortex/skills`;
    - Copilot CLI: `.github/agents/*.agent.md` and `.github/skills`, or `~/.copilot/…`.

    Where a host has no documented MCP file (Cortex Code projects, Copilot CLI, Claude Code at user scope), the installer prints the exact step instead of guessing a file.
- **Packaging:** `agents/` and the skill folders ship in the VSIX, the `autode` package and the stable server copy.
- **Deviations / notes:**
  - **PA3b is split into increments**, one agent migration per release, because "the old agent is deleted in the same release" can't hold for eight agents at once:
    - v0.45.1: source assessor and mapping (`autode_match_columns`);
    - v0.45.2: data modeler (`autode_draft_model`, model proposal);
    - v0.45.3: pipeline engineer (`autode_primitive_candidates`);
    - v0.45.4: business analyst (interview state on disk) and the planner's briefs;
    - v0.45.5: context curator; the plan-of-steps path and the AutoDE agents box are removed.
  - **Artifacts are drafts approved at the stage gate,** not one decision per artifact: one approval per stage.
  - **The plugin folder has no Copilot agents.** Claude Code would read `*.agent.md` files as agents too, so each agent would load twice. Copilot's agents come from `autode plugin install --host copilot`.
  - **Cortex Code** has no documented project MCP file or agents folder (checked 2026-10-21). The installer copies skills and prints the `~/.snowflake/cortex/mcp.json` entry; sub-agents come from the plugin folder.
  - **Run agent, not Hand in,** is the action for a stage whose role has a definition. Hand in stays for work done by hand.
- **Measured:** 364 tests (6 new: definitions and format checks; tools by tier; the MCP assignment, recording and prompts; the executor; the plugin and installs; the retired agent and packaging). Updated tests that used `architectureAgent` as a generic agent. Lint 0 errors. Eval: the reference plan no longer has the documentation step (s6). Every other metric is unchanged from the v0.41.0 baseline.

## 0.44.1

- **The Workflow view, history and provenance** (owner's request, 2026-10-21: progress must be traceable and clearly visible; requirements ORC-9; technical-design §7.8).
- **Who did what, always recorded.** Every workflow event is written by the engine to `.autode/problems/<id>/workflow-events.jsonl`, append-only:
  - the template suggestion, labelled as **the engine's rule** with the words it matched (no model is involved);
  - drafts, proposals and approvals, with **who** (person, engine or agent) and **through which channel** (panel, CLI, decision file, document, tool);
  - hand-ins, skips with their reason, re-openings, and staleness with its cause.

  The workflow also carries its provenance: suggested by, chosen by, drafted by, proposed by and approved by. You can read it on every surface: `autode workflow history [<stage>]`, MCP `autode_workflow_history`, and the new view.
- **A dedicated Workflow view in VS Code:**
  - **Tree** in AutoDE's activity bar: every stage with its state and reason, plus context actions (approve, hand in, approve again, skip, re-open).
  - **Editor tab** (*AutoDE: Open Workflow*): the problem, its provenance and progress, a board of stages in dependency columns, and the selected stage's kind, role and tier, dependencies, inputs and outputs, gates, "done when", approval, decision trail and history. Approvals are confirmed in a modal and recorded as you (the panel channel).
  - **Status-bar item** with the problem, progress and what needs attention.

  All three follow changes made in the panel, a terminal or by an agent.
- **The palette is slimmed.** The old Phases, Agents and Continue Workflow sections, which competed with the stages, are replaced by a link to the view. Today's agents (generate plan steps, approve, confirm, generate artifacts) now run from the view's **AutoDE agents** box, until PA3b moves agents onto the workflow.
- **Deviations / notes:**
  - Stage actions in the engine now take an actor (person, engine or agent) and a channel instead of a name.
  - The history syncs the runtime first, so approvals made in documents or decision files appear in it straight away.
  - The board's columns are dependency depth, not time.
- **Measured:** 358 tests (3 new: history and provenance across the CLI and MCP; the view model; the view's contributions, CSP and the slimmed palette). The VS Code test mock gained the tree and status-bar APIs. Lint 0 errors. Eval unchanged.

## 0.44.0

- **Phase PA3a: workflow templates and runtime** (`docs/mcp-engine-requirements.md` §9.2 PA3, approved 2026-10-21; `docs/workflow-templates.md`; requirements ORC-9, with ORC-1, ORC-3, ORC-6 and BPS-9 updated; technical-design §7.8). Each business problem now gets a **planned workflow**: drafted from a template, checked by the engine, approved by a person, and the same on every surface.
- **17 stage kinds and three templates**, built from published practice:
  - **greenfield** (the Kimball Lifecycle);
  - **modernization**, which replaces brownfield (Snowflake's and Databricks' migration guides, Practical Data Migration);
  - **estate merge** (master-data consolidation).

  Each stage is mandatory, default, conditional (`when:` on facts, for example a contract in the pack) or optional, with dependencies (`after`, optionally `(approved)`), the artifacts it consumes and produces, gates (check, approve), and `repeat: per-source-system`. A workspace adapts them in `.autode/config/workflows/`, and editors validate the files against `docs/schemas/workflow-template.schema.json`.
- **The planning stage produces the workflow.** After the specification is approved, AutoDE suggests a template and drafts the problem's workflow deterministically. The engine refuses a workflow that:
  - drops a mandatory stage or one of its gates;
  - leaves out a default or conditional stage without a reason;
  - gives a stage a role or permission tier its kind doesn't allow;
  - has unknown or circular dependencies;
  - leaves a stage without its inputs.

  The approver sees it as a diff against the template, and approves it as a `workflow` decision (high stakes).
- **The runtime is the hub.** It says which stage is ready, which waits and for what, and which is stale. Stages whose output is a document with its own approval (spec, target and source context, mapping, Pipeline Spec) read that approval, so the panel, CLI and MCP always agree. Other stages are handed in with their outputs and approved through a `gate` decision. **Staleness:** a stage whose approved inputs change becomes stale and needs approval again. Optional and default stages can be skipped with a reason; a re-opened stage makes everything downstream stale. Changing the template restarts the workflow.
- **On every surface:**
  - **Panel:** a Workflow section in the Workflow Palette (draft, hand in, skip, re-open; approvals in the Context Inbox).
  - **CLI:** `autode workflow templates | status | plan | next | start | complete | approve | skip | reopen`.
  - **MCP:** `autode_workflow_templates`, `_status`, `_next`, `_start_stage`, `_complete_stage`, `_skip_stage`, `_reopen_stage` and `autode_propose_workflow`. No tool approves.
- **Changed — the plan gate:** Generate Plan and Pipeline Spec generation now also need the approved workflow. Whether source context applies is now decided by the workflow's source-assessment stage, not the greenfield/brownfield flag.
- **Migration:** a problem from before 0.44.0 gets a draft workflow on first use (greenfield → greenfield, brownfield → modernization). Its approved documents still count; the workflow needs one approval.
- **Deviations / notes:**
  - **The planner agent and agents working from briefs are PA3b.** Here the deterministic draft stands in for the planner, today's agents still do the stage work in VS Code, and every stage's agent is the kind's first role at its ceiling.
  - **Repeated stages are one stage with a task per source system** (owner's decision: tasks inside stages), approved once rather than per system.
  - **Re-approving a stale stage** goes through a gate decision even for document-backed stages, because their documents stay `approved` when an input changes.
  - Named outputs of a handed-in stage must exist whatever its gates.
  - `estate.has_legacy_code` is not detected yet; it stays false until the planner (PA3b) or a person sets it, so code conversion is added deliberately.
- **Measured:** 355 tests (6 new: templates and their errors, the draft and plan checks, the runtime from the CLI and MCP, migration and template restart, schema validation, packaging). The MCP tool-list and schema tests include the eight new tools. Lint 0 errors. Eval unchanged.

## 0.43.3

- **Parity step 1b: facts, the pack, vocabulary and SQL without VS Code** (roadmap 2026-10-20, *Surface parity*; requirements CTX-10, GRD-8; technical-design §10.8; reference: `docs/cli.md` *Knowledge*, *SQL and documents*). With this, someone without VS Code can confirm a key or grain fact. Before, a fact an agent proposed could only be confirmed in the panel.
- **The Context Inbox in a terminal:** `autode facts` (`list`, `show`, `confirm`, `reject`, `edit`, `conflicts`), plus `confirm --from <source>` for documented facts from one source. `confirm`, `reject` and `edit` need a person (an interactive terminal, refused with `CI` set) and a typed confirmation. The panel and the CLI now run the same engine code (`src/engine/context/factReview.ts`).
- **The pack:**
  - CLI: `autode pack list | add | apply`.
  - MCP: `autode_pack_list`, `autode_pack_add` and `autode_pack_apply`.
  - Structured documents are read through their **confirmed** profile, with no model. A document without one is reported, never guessed. An agent can add only **draft** documents; marking one signed is a person's call.
- **Conformance over MCP:** `autode_check_conformance` (catalog, samples, and read-only probes with a connection). The CLI has had `autode conformance` since v0.42.0.
- **Vocabulary:**
  - CLI: `autode vocabulary mine | accept`.
  - MCP: `autode_mine_vocabulary`, and `autode_propose_vocabulary`, a new **low-stakes** decision kind `vocabulary`. The agent may approve it after asking you, and it is applied to `vocabulary.yaml`.
- **SQL and documents from the terminal:** `autode design-doc`, `autode query` and `autode explain`. These call the MCP tools' own handlers, so the read-only guard and the sample-data gate are identical.
- **Refactored:** `BusinessPackManager` moved into the engine (re-export at the old path), and the panel's fact review now delegates to `factReview.ts`.
- **Deviations / notes:**
  - The pack's document version is `--doc-version`, because `--version` prints AutoDE's version.
  - Free-text pack documents and interpretation-profile proposals still need a model, so they stay with the panel or with an MCP host's model through the extraction prompt (PA3 makes this a skill).
  - Profiles are confirmed by editing `status: confirmed` in `.autode/knowledge/profiles/`, as in the panel.
- **Measured:** 349 tests (4 new: facts in a terminal; the pack via CLI and MCP with conformance; vocabulary mining, acceptance and a low-stakes proposal; design-doc, query and explain; the MCP tool-list and schema tests include the new tools). Lint 0 errors. Eval unchanged.

## 0.43.2

- **Parity step 1a: business problems and the estate without VS Code** (roadmap 2026-10-20, *Surface parity*; requirements WS-2, STC-10; technical-design §10.6, §10.8; reference: `docs/cli.md` *Business problems*, *Estate*). These were the two biggest gaps of the parity audit: outside VS Code, a problem couldn't be started, and the estate couldn't be filled.
- **Business problems**, using the same folders, first draft and active-problem pointer as the panel:
  - CLI: `autode problems list | new "<statement>" | use <id>`.
  - MCP: `autode_list_problems`, `autode_start_problem` and `autode_select_problem`.

  A started problem holds only its statement, as an unapproved v1 draft. A problem started in a terminal or by an agent opens in the panel, and the reverse.
- **The estate:**
  - CLI: `autode estate show`, `autode estate ingest <file>...` (DDL, CSV or JSON) and `autode estate extract --connection <id> --schema <DB.SCHEMA>`, with options to bind to an estate system and to read sampled profiles.
  - MCP: `autode_ingest_file` (files inside the workspace) and `autode_ingest_metadata` (a connection's schemas).

  Both go into the catalog, the working set and the ledger through the panel's own code, so grounding, `autode_resolve`, context packs and conformance know the tables afterwards. A connection's binding remembers its schemas for the next extract.
- **Refactored:**
  - `ContextFileManager` and `GraphManager` moved from `src/context/` into the engine (`src/engine/context/contextFileManager.ts`, `graphManager.ts`, `graphPersistence.ts`). They have no VS Code dependency: the extension injects its watcher of `.autode/knowledge/`, and re-exports remain at the old paths.
  - `generateProblemSlug` moved to `src/engine/documents/problemSlug.ts`.
  - New engine modules `src/engine/documents/problems.ts` and `src/engine/context/estateIngest.ts`, and `ConnectionManager.snapshotGraph()`.
- **Deviations / notes:**
  - **The MCP server now writes more than proposals** (decision log 2026-10-20). It writes a new problem's draft, the local active-problem pointer, and observed metadata. These tools are marked as writing but not destructive. Inferred knowledge still goes through proposals.
  - **A running panel doesn't see ledger changes made by the CLI or an agent until *Re-index Context* or a reload.** Its watcher covers the knowledge files, not the ledger folder. Nothing is lost, because the ledger is append-only per session.
  - `--system` on `estate ingest` applies to every file in that command.
- **Measured:** 345 tests (3 new: problems across the CLI, MCP and the panel's reader; files into the estate with grounding and resolve; a connection's schemas through the CLI and MCP; the MCP tool-list and schema tests include the five new tools). The knowledge-watcher test now injects its watcher. Lint 0 errors. Eval unchanged.

## 0.43.1

- **Connections on every surface** (first step of surface parity, roadmap 2026-10-20; requirements PLT-8, MCP-2; technical-design §10.8, §7.7; reference: `docs/cli.md` *Connections*). A data engineer without the VS Code extension can now set up the connections the MCP server and the CLI use.
- **`autode connections add`** sets one up in a terminal:
  - It offers the connections the platform tools already know: Snowflake CLI connections from `connections.toml`, and Databricks profiles from `.databrickscfg`. These files are read directly; the CLIs aren't run.
  - It asks only for what is missing, for example the SQL warehouse HTTP path.
  - It tests the connection read-only before saving. If the test fails, nothing is written, and the platform's own error is shown.
  - It writes the same files as the settings cards: shared settings to `.autode/config/connections.yaml`, and the username and key path to the personal `.autode/local/connections.yaml`.

  Flags answer any question up front (`--platform`, `--role`, `--resolver cli|env`, `--ref`, `--set key=value`, `--scope`, `--allow-sample-data`, `--no-test`). Secrets are refused; they come from the CLI's configuration or from `AUTODE_*` environment variables.
- **The other subcommands:**
  - `autode connections list` shows each connection's readiness on this machine and what it still needs, naming the environment variables not set.
  - `autode connections test <id>` re-checks a connection and records the result.
  - `autode connections remove <id>` removes it.
- **MCP:** new tool `autode_propose_connection`. An agent proposes a connection: settings only, with credentials from the CLI's configuration or the environment. It becomes a high-stakes decision, so the agent can't approve it. A person approves it in the panel, with `autode decisions approve`, or in the decision file, and AutoDE then saves it. The server's instructions point agents to it when a connection is missing.
- **Refactored:** the draft checks in `saveConnection()` moved into `validateConnectionDraft()`, which the cards, the CLI and the proposal all use. New engine module `src/engine/platform/connectionSetup.ts` (discovery, questions, credential needs, the entry to test).
- **Deviations / notes:**
  - **`add` and `remove` need a person** (an interactive terminal; refused when `CI` is set), like `decisions approve`. A connection decides which platforms AutoDE's agents can reach. Pipelines commit the file instead, and agents propose.
  - **`--resolver vscode` is refused outside the extension.** VS Code's secret storage is reachable only from there. Such entries still work in the CLI and MCP through the `AUTODE_*` variables `connections list` names.
  - An approved connection proposal is saved untested; the result message says to test it.
- **Measured:** 342 tests (3 new: add from a Databricks profile including a failing test, add with environment variables plus test, list and remove, and an MCP proposal approved through the CLI; the MCP tool-list and schema tests include the new tool). Lint 0 errors. Eval unchanged.

## 0.43.0

- **Phase 5: the extension as an MCP client, and AutoDE in VS Code's agent mode**, restructured at the user's direction (roadmap decision log 2026-10-20; `docs/mcp-engine-requirements.md` §9 Phase 5; requirements MCP-1, SKL-2; technical-design §10.9; usage: `docs/mcp-setup.md`).
- **Agent mode lists AutoDE's tools with nothing to configure.** On VS Code 1.101 and later, the extension registers the AutoDE server with VS Code's MCP server definition provider API. VS Code runs it with its own runtime, so Node.js isn't needed and no `.vscode/mcp.json` is required. The API is feature-detected, so older VS Code versions are unaffected and `engines.vscode` stays at ^1.90.
- **Connections whose secrets VS Code keeps work there too.** For each `resolver: vscode` connection, AutoDE passes the secrets as the matching `AUTODE_*` variables, and only when VS Code starts the server. The listed server definition never contains a secret.
- **`.mcp.json` survives extension updates without the `autode` package.** *Configure MCP for Claude Code* copies the server into VS Code's global storage and points `.mcp.json` there. AutoDE refreshes an existing copy after an update; it never creates one at activation. The installed `autode` is still preferred when it is on `PATH`.
- **The extension reaches its own engine through MCP.** `EngineClient` connects to the same server other hosts get from `autode mcp`, over an in-memory transport: the same tools, validation and error envelope, without a child process. It starts on first use, never at activation, and a closed client starts again on the next call.
- **Imported tool skills can use AutoDE's tools:** primitives, the Pipeline Spec, context, grounding, read-only platform access and proposals. A skill declares them like any other tool (`autode_compile_transform`, `mcp__autode__autode_compile_transform`, or `mcp__autode__*`). The existing caps apply:
  - only declared tools are offered;
  - read-only tools in read-only mode, and proposals only in full mode;
  - a *reviewed* skill gets read-only tools only;
  - no skill may resolve or apply a decision.

  A declared proposal tool lets a trusted skill run in full mode even if it declares no file write. Every engine call is audited with the run. Gemini receives the tools' schemas in the subset it accepts.
- **Deviations / notes (the restructuring):**
  - **Not built: the lint ban on value imports from `src/engine` outside `src/mcp`.** There are 221 such imports across 55 files. Since PA2 the extension and `autode mcp` are one build, so the ban would have guarded against drift that can't happen, at the cost of a process hop for pure helpers. The boundary that matters is that every change is a decision (PA1).
  - **Not built: panel approvals through the MCP decision tools.** The panel is the person channel. For the server to accept a "panel" claim, any agent could make that claim, which would undo PA1's stakes model. The panel already uses the engine's own `DecisionStore`.
  - **Not built: routing the built-in agents' registry, compile and connection calls through the client.** PA3 replaces those agents with skills and deletes their old paths.
  - **Not built: a supervised child process** (lazy spawn, version check, restart with backoff). In-process gives the same contract, and VS Code starts and supervises the agent-mode server itself.
  - The §7.4 host decoupling of the agents (`host.confirm`, `host.workspaceRoot`, no `extensionContext`) was already in place from v0.26.0.
  - **Claude Code is offered no engine tools.** It runs its own loop; passing AutoDE's server to it with `--mcp-config` is left for PA3.
  - Activation event `onMcpCollection:autode` added so VS Code can activate AutoDE when agent mode needs the server.
  - `extension.js` grows from 829 KB to 1050 KB (production) because it now carries the server for the in-process client.
- **Measured:** 339 tests (5 new: the in-process client and tool selection, engine tools in the tool loops, the skill runner's caps, agent-mode registration and secrets, the stable copy). Lint 0 errors. `npm run eval` unchanged (traps 5/5, answerability 18/26, contract violations 4/4 with none false, plan-step context 529 tokens median). The end-to-end artifact comparison with v0.42.0 is a manual check (manual-verification Part 20.7), not run.

## 0.42.0

- **Phase PA2: the engine on its own, as the `autode` package and CLI** (`docs/mcp-engine-requirements.md` §3.1 D7, §9.2; requirements MCP-3, P9; technical-design §10.8; reference: `docs/cli.md`; per-host set-up: `docs/mcp-setup.md`).
- **One build, two packages.** `dist/autode.js` is a single self-contained bundle (no `vscode`, no runtime dependency) holding the engine, the CLI and the MCP server. The VSIX ships it, and `npm run package:cli` packs it with the bundled interview prompts, icon and licences into `dist/autode-<version>.tgz` (205 KB, 660 KB unpacked, production build). Install it with `npm install -g autode-<version>.tgz`. **Nothing is published to a registry**; that remains the owner's step.
- **`autode mcp`** is the MCP server at a path that doesn't change with extension updates. `dist/mcp-server.js` still works: it is now a two-line shim for `autode mcp`, so existing client configurations keep working.
- **Deterministic commands** (they never change AutoDE's state):
  - `validate`: business problem, Pipeline Spec, mapping documents, workspace primitives and `connections.yaml`.
  - `compile --dialect <d>`: to stdout, or files under `--out`.
  - `grounding <file.sql>…`
  - `conformance` and `probe`: pack samples, and live read-only probes with `--connection`.
  - `doctor`: prerequisites, drivers, connections and their readiness.
  - **`check`, the CI gate:** everything `validate` checks, and it fails while a high-stakes decision is pending for the problem.

  `validate`, `compile` and `grounding` call the MCP tools' own handlers, so the CLI and the server can't disagree (a test compares them). With no active problem (normal in CI, because `.autode/local/` isn't committed), commands run over every problem, or take `--problem <id>`.
- **Human commands:** `decisions list | show | approve | reject`. Approve and reject work only in an interactive terminal, refuse whenever `CI` is set, and need the verb typed back to confirm. This is the *CLI* channel PA1 already allowed for high-stakes decisions. An approved document change is applied by the engine at once; an approved platform change still runs only on an `--allow-write` server.
- **Stable exit codes:** 0 ok, 1 failed, 2 usage, 3 pending high-stakes decision, 4 refused (a person is needed), 5 not found, 6 platform error, 70 internal. `--json` gives machine-readable output.
- **`AutoDE: Configure MCP for Claude Code`** (new command) writes the project's `.mcp.json`. It uses the installed `autode mcp` when that is on `PATH` (`cmd /c autode …` on Windows), else `node <extension>/dist/autode.js mcp`, else VS Code's own runtime. It keeps other servers, and shows the command line before writing. At activation AutoDE notices an entry left pointing at an older extension folder and offers to update it; it never writes on its own.
- **Docs:** new `docs/cli.md` (the CLI reference, also the package README). `docs/mcp-setup.md` now prefers `autode mcp`, adds Codex and Cline, documents the Windows `cmd /c` form, and lists the CLI as a decision channel.
- **Refactored:** conformance, sample probes and probe candidates moved from `BusinessPackManager` into the engine (`src/engine/context/packChecks.ts`), so the panel and the CLI run the same code; `verifyAssertions()` is now `probeAssertions()` (run) plus recording. `EngineWorkspace` takes an explicit `problemId`. The MCP server module no longer starts itself when it is the main module, because inside a bundle every module looks like the main one; the entry point is the CLI.
- **Deviations / notes:**
  - **`autode probe` reports and records nothing.** The spec didn't say. Recording a verification changes the ledger, so the CLI leaves that to the panel's *Verify Claims* and `autode_verify_assertion`, which keeps every CLI command except `decisions` CI-safe.
  - **"No pending high-stakes decision affects the artifacts"** is implemented as: no pending decision with recomputed high stakes for a checked problem, or for no problem. A decision a person resolved in its committed file counts as resolved; `check` doesn't sync or apply it. Decisions aren't yet linked to individual artifacts, so a pending platform change also blocks.
  - **`decisions list` and `show` don't apply file resolutions** (the MCP `autode_list_decisions` does), so they never write.
  - **The MCP contract test against `autode mcp`** compares the packed server with `dist/mcp-server.js`: identical tool, prompt and resource lists, identical results for five tool calls, and a passing refusal. It doesn't re-run every MCP test against both entry points; the existing suite still runs against `dist/mcp-server.js`, which is now the same code.
  - **The skills pack** named in D7 isn't in the package yet; it arrives with PA3.
  - **The spec assumed `AutoDE: Configure MCP for Claude Code` already existed;** it didn't, so it was added here.
  - **Codex and Cline set-up** is written from their documented configuration formats and hasn't been tried live (manual-verification Part 19).
  - **Whether the package name `autode` is free on npm** wasn't checked. It matters only when the owner publishes; a Tiger Analytics fork would need its own name anyway.
- **Measured:** 334 tests (7 new: `check` exit codes, decisions refusal and confirmation, CLI ↔ MCP parity, conformance and probe on samples, the packed package and its server, Configure MCP, VSIX contents). Lint 0 errors. `npm run eval` unchanged from v0.41.0 (traps 5/5, contract violations 4/4, none false). Bundles in production: `extension.js` 829 KB, `autode.js` 632 KB.

## 0.41.0

- **Phase C4b: facts from conversation, the Context Inbox, and tool-action memory** (`docs/context-layer-requirements.md` §5.2–5.4, §7.2, §11; requirements CHT-5, CTX-10, GRD-3, CTX-1; technical-design §5.14; usage: `docs/mcp-setup.md`).
- **Facts from what the engineer says.** After each chat and interview turn, the configured assistant proposes the facts the turn states: keys, grain, relationships, terms, metrics, rules, decisions, assumptions and platform constraints.
  - This runs **in the background and never slows down or fails the turn**. A model error, a garbled answer, a timeout or a ledger problem is logged and nothing else happens; a test injects each fault.
  - Proposals are validated, their subjects resolved against the estate (unresolved ones flagged, never dropped), and duplicates skipped.
  - **A correction is linked deterministically:** a later, different value for the same key, grain, metric, term definition or platform supersedes the earlier fact. The earlier fact is retired only when the correction is confirmed, and a pending correction is not reported as a conflict.
  - **Explicit capture without the model:** `/define <term> = <definition>`, `/rule`, `/decide`, `/assume`.
- **Context Inbox** (the Workflow Palette section that PA1 called Decisions):
  - facts to review, grouped by subject, with stakes, evidence, the fact a correction replaces, and verification results;
  - conflicts;
  - a plan step paused for missing context;
  - PA1's changes to approve.

  Actions: **Confirm**, **Edit & confirm** (statement and value; supersedes), **Reject**, **Verify now** (probes on the live source connection), and **Confirm all** for documented facts from one source. With a live connection and read-only mode on, proposed keys, grain and relationships are probed automatically.
- **Plan steps pause on missing context.** A step whose context lacks a confirmed join, key or grain pauses until the engineer states it (and confirms it) or chooses "Continue without it". The choice is logged.
- **Answers cite their facts.** Chat context lists the facts it holds with ids, the assistant is asked to cite them as `[fact:<id>]`, and the panel shows them as chips whose hover text is the fact.
- **Tool-action memory.** What the assistant did in a turn (files written, commands run) is shown under the reply, kept in the transcript, and part of later turns' history (folded into the assistant turn). It is also recorded as evidence on facts extracted from that turn.
- **MCP:**
  - `autode_propose_assertion` now records a *proposed* fact in the ledger instead of a decision file, attributed to the client (and skill and model when given). It dedups, links corrections and returns the stakes.
  - New `autode_review_assertion` lets an agent confirm or reject a low-stakes fact only (glossary terms, naming conventions, assumptions); other facts are refused and go to the Inbox.
  - New `autode_verify_assertion` runs the probe for a fact on a named connection.
  - New prompt `autode_extract_assertions` gives other hosts the same extraction with their own model.
- **Eval:** offline, the stand-in now plays only the model's part (each turn's scripted facts as the extractor's JSON, outcomes withheld). Validation, resolution, dedup and correction linking are the engine's own work, and the engineer's Inbox confirmation is simulated per turn. **Trap 2 (customer key corrected mid-chat) is now detected: traps 5/5** (4/5 before). Answerability from the context layer rose to 18/26 (16/26), partly because simulated confirmation makes chat facts confirmed. New baseline `baselines/v0.41.0-offline.md`.
- **Deviations / notes:**
  - **Facts use the ledger's gate, not PA1's decision files** (decision log 2026-10-20). This changes what PA1 shipped two days earlier for `autode_propose_assertion`. Decisions remain the gate for documents, mappings and platform changes.
  - **The ≥ 90% extraction criterion was not measured automatically.** The eval runs outside VS Code and can't use Copilot, and recording with a billed API key was declined. It is checked by hand with the user's own assistant (manual-verification Part 18.1). A recorder that uses the host's model is in the roadmap backlog.
  - **The extractor prompt is engine code, not a `skills/` prompt pack:** governed by review now, and it becomes part of an AutoDE skill in PA3. Over MCP it's the `autode_extract_assertions` prompt.
  - **Duplicates add nothing**, because the ledger has no "evidence added" event; the spec said they add evidence to the existing fact.
  - **Not done here:** an interview that survives a window reload (BPS-7) stays in the backlog.
  - Steps pause only on join, key and grain gaps (principle C3), not on structure or decision gaps.
- **Measured:** `npm run eval`: traps 5/5, contract violations 4/4 with none false, answerability 18/26, vocabulary 17/21 and 19/21 with captured vocabulary, large estate 8/8, longest synchronous task 48 ms, plan-step context 529 tokens median (unchanged; only chat packs gained the fact list). 327 tests (6 new; the PA1 fact test was rewritten for the ledger gate; MCP tool-list and input-schema tests updated).

## 0.40.0

- **Phase PA1: decisions and proposal tools**, the first phase of the portable architecture (`docs/mcp-engine-requirements.md` §3.1, §9.2; requirements ORC-8, MCP-2, P9; technical-design §7.7; usage: `docs/mcp-setup.md`, *Proposing changes*).
- **Agents propose; people decide; AutoDE applies.** Five new MCP proposal tools: `autode_propose_assertion`, `autode_propose_spec_change`, `autode_propose_pipeline_spec`, `autode_propose_mapping` and `autode_propose_platform_change`.
  - A proposal is validated first. Mapping source columns are checked against the estate AutoDE knows, platform changes must be exactly one write, and specifications must keep their id. Errors come back item by item.
  - A valid proposal becomes a **decision** in `.autode/decisions/<id>.yaml` (committed), with the proposal, its validation report, evidence, and who proposed it (client, skill, and model when given).
  - Nothing else is written until a person approves it. Then AutoDE's own code applies it:
    - a fact enters the ledger as confirmed, attributed to the decision;
    - a specification or Pipeline Spec revision becomes the next draft (archived as before);
    - a mapping goes into the Mapping Context.
  - A decision whose document changed after it was proposed is **superseded**, not applied.
- **Stakes decide who may resolve a decision.** They are defined in the engine and recomputed at every resolution, so editing `stakes:` in the file changes nothing.
  - **Low** (glossary terms, naming conventions, assumptions): the proposing agent may resolve it with `autode_resolve_decision`, which is marked destructive so the host asks its user.
  - **High** (everything else): only a person, in the panel or by setting `resolution.decision` and `resolution.by` in the decision file and committing it.
  - `autode_list_decisions` and `autode_get_decision` show what's waiting.
- **Decisions in the panel:** a *Decisions* section in the Workflow Palette with kind, stakes, proposer, warnings and evidence, Approve / Reject with a note, and recent outcomes. Approving a specification or Pipeline Spec revision there also runs its usual approval, in one click. The panel's own specification and Pipeline Spec approvals are now recorded as decisions too. Decision files edited by hand are picked up when saved.
- **Changed — platform writes:** `autode_execute_query` no longer runs writes, **even on a server started with `--allow-write`**. The agent proposes the change, a person approves it, and `autode_apply_decision` runs it on an `--allow-write` server. Clients that relied on 0.37–0.39's direct writes must switch to proposals.
- **Refactored:** the serialisation, history names and revision rules of the specification, Pipeline Spec and Mapping Context moved from the three VS Code managers into `src/engine/documents/problemDocuments.ts`, moved verbatim and used by both the managers and the decision appliers, so the two can't drift.
- **Deviations / notes:**
  - **Lifecycle approval of a specification or Pipeline Spec stays in the panel.** Approval there syncs context, infers phases and opens the next gates, which needs the extension. A revision approved through the decision file becomes the draft, and you approve it in the panel as usual. Approved in the panel, it's one click.
  - **The panel can approve a platform change but not run it.** Only an MCP server started with `--allow-write` applies it (`autode_apply_decision`), because running it needs that server's connection and permission.
  - **The terminal channel comes with the CLI** (PA2). Today's human channels are the panel and the decision file.
  - **The decision file's `by` is self-declared**; the commit is its audit. If agents in a setup can edit files, review decision files in pull requests.
  - Each decision's history is a growing `events` list inside its YAML (one file per decision, so teams merge without conflicts) rather than a separate event log.
  - The model behind a proposal is recorded only when the agent passes it (roadmap backlog: model identity in the host-agent path).
- **Measured:** `npm run eval` unchanged from v0.39.0 (traps 4/5, contract violations 4/4 with none false, vocabulary 17/21, large estate 8/8, longest synchronous task 45 ms). 321 tests (5 new; the MCP tool-list, input-schema and `--allow-write` tests were updated for the new tools and the write path).

## 0.39.0

- **Phase DRV2: platform onboarding in the settings cards, and named connections** (`docs/mcp-engine-requirements.md` §9.1; requirements PLT-7, PLT-8 (new); technical-design §6.14; setup: `docs/mcp-setup.md`, *Data platforms*).
- **Each platform card** (Source: Snowflake, Databricks, Oracle; Target: Snowflake, Databricks) now shows:
  - **Prerequisites**, checked when you click *Check prerequisites* (DRV1's model): state, version, why, and *Install…* / *Verify* for the Oracle driver or *Install guide* for a CLI. The install command is shown before it runs, and runs only on the click.
  - **The backend it will use**, with that backend's limits: Snowflake SQL API or Snowflake CLI (by auth mode), Databricks Statement Execution API (the only backend), Oracle Thin mode (12.1+, a source only).
  - **Existing connections** under *Find existing*: Snowflake `connections.toml` names, `.databrickscfg` profiles (those without a token are listed but not selectable, with the reason), tnsnames aliases (picking one fills the connect string). They are read from the files; no CLI is run.
  - **Save as named connection.** AutoDE connects first and writes nothing if that fails. On success the shared fields go to `.autode/config/connections.yaml` (comments in the file are kept), and your `username`, key, wallet and CLI paths go to the new gitignored `.autode/local/connections.yaml`. A password or token you typed moves to VS Code's secret storage under the connection's reference, and the connection becomes the one Connect uses for that role. *Share with the team* off keeps the whole entry personal.
- **Saved connections** at the top of the Source and Target tabs: every connection from both files and the environment, with **AutoDE: ready / failed / not checked / re-check** and **MCP: ready / not ready** plus what an MCP client still needs (env variables, `--allow-cli`, the drivers folder). Buttons: *Use* (connect with it), *Use card fields*, *Re-check*, *Remove* (confirmed; removes it from both files and deletes its stored secrets).
- **Readiness is per machine** (`.autode/local/connection-readiness.json`) and tied to the entry: editing it turns the status to *re-check*.
- **Connect through a named connection** (settings `activeSourceConnection`, `activeTargetConnection`). When one is in use, Test Connection resolves its credentials through the same resolvers the MCP server uses, which closes the backlog item "the old testConnection path assembles credentials from settings". With none in use, the card's fields work exactly as before.
- **`connections.yaml`**:
  - The new **`resolver: vscode`** means VS Code's secret storage. Outside VS Code the secret comes from `AUTODE_<PLATFORM>_<REF>_<FIELD>`; `autode_list_connections` names those variables in `secretFromEnv`, and a missing one is an error naming it.
  - The **personal file** `.autode/local/connections.yaml` adds fields, or the engineer's own credentials, to a team entry by `id`, or holds connections of its own. It can't change sample-data consent.
- **Oracle source card**, with connect string, username, tnsnames folder, password, and an optional wallet folder and wallet password (stored in secret storage). There is no Oracle target card.
- **Fixed:**
  - In `connections.yaml`, `role` is source/target, so a Snowflake role given as `role` made the entry invalid. Snowflake's role is now **`snowflakeRole`** (mapped to the adapter's `role`).
  - **Databricks `.databrickscfg` profiles** could not connect at all (v0.37.0 notes). `DatabricksAdapter` now reads the profile's host and personal access token at connect time; `httpPath` still comes from the entry. A profile without a token (OAuth, Azure CLI) is explained.
  - The settings panel's save dropped the Oracle settings and `oracle` as the source provider.
- **Deviations / notes:**
  - No "Data Platforms" tab or wizard. On review with the owner the steps moved into the existing platform cards, and a Saved connections list was added because a card holds one connection while an estate merge needs several (decision log 2026-10-18). The spec's step 1, picking platforms, is the card choice. Step 3, the backend tier, is shown as information, because only Snowflake has a real choice and it follows the auth mode.
  - Secrets are stored in VS Code's secret storage as the spec says. Because MCP clients can't read it, readiness is reported per consumer, and a `vscode` connection that needs a secret is *MCP: not ready* until its env variables are set in the client (or phase 5 starts the server).
  - Writing the connections files keeps comments and order (yaml Document API), but a hand-edited entry is matched by its id. Editing a team entry from a card replaces its shared fields and leaves its consent alone.
  - The card path still stores its secrets under the old fixed keys; a named connection copies them to its own reference. Two places for the same password until the card-only path is retired (roadmap backlog).
  - Oracle as a target goes to the backlog: it means Oracle SQL generation, not a card.
- **Measured:** `npm run eval` unchanged from v0.38.0 (traps 4/5, contract violations 4/4 with none false, vocabulary 17/21 and 19/21 with captured vocabulary, large estate 8/8, longest synchronous task 47 ms). 316 tests (8 new, one rewritten for the Databricks profile change).

## 0.38.0

- **Phase DRV1: AutoDE moderates driver installs, and reads Oracle as a source** (`docs/mcp-engine-requirements.md` §9.1, rewritten before implementation, commit 77d02c3; requirements PLT-1, PLT-7; technical-design §6.13; setup: `docs/mcp-setup.md`, *Oracle*).
- **Platform prerequisites** (`src/engine/platform/prerequisites.ts`). For each platform, what it needs (CLI, driver, client library), whether it's there, why it matters, and the exact install step. **AutoDE: Check Platform Prerequisites** lists them; picking one installs it, verifies it or opens the vendor's guide.
- **Moderated driver installation** (`src/engine/platform/driverStore.ts`, `src/core/platformPrerequisites.ts`). AutoDE never downloads or bundles a driver.
  - **AutoDE: Install Oracle Driver** explains the install (package, folder, size, licence, the 12.1+ limit) and shows the command: `npm install --prefix "<drivers>/oracle" --ignore-scripts --no-audit --no-fund "oracledb@^6.0.0"`.
  - **Run in AutoDE terminal** runs it in a visible terminal named "AutoDE", with the user's own npm and `.npmrc`, so an internal registry, proxy and lockfile integrity work as they do elsewhere. **Copy command** copies it instead.
  - **AutoDE: Verify Oracle Driver** loads the package, checks its version and that it's in Thin mode, and records the lockfile's SHA-256. A driver loads only while that record matches; a folder that changes afterwards is `changed` and must be verified again.
  - Drivers live in `~/.autode/drivers` (setting `driversDirectory`, or `AUTODE_DRIVERS_DIR`), which is also where the MCP server looks (`--drivers`).
  - Without npm, AutoDE says so and offers Node.js or the setting.
  - Tested: no process and no network request at activation or on connect; the command reaches a terminal only through the Run button; neither the package manifest nor either bundle contains `oracledb`.
- **Oracle Database 12.1+ as a source** (`src/engine/platform/adapters/OracleAdapter.ts`, Thin mode).
  - Connections go through a **tnsnames alias** (found as Oracle's tools find it: `oracleConfigDir`, `TNS_ADMIN`, `$ORACLE_HOME/network/admin`) or Easy Connect. A TLS wallet is optional. An unknown alias is reported with the file searched and the aliases found.
  - Metadata comes from the `ALL_*` views: tables and views with comments and last DDL time, columns with formatted types, primary and foreign keys, view text, and sampled profiling with `FETCH FIRST`.
  - Oracle works in `connections.yaml` (`AUTODE_ORACLE_*`), in every MCP data-platform tool (`autode_explain_sql` via `EXPLAIN PLAN` + `DBMS_XPLAN`), in probes (new `oracle` dialect) and in the extension's connection flow: settings `defaultOracleConnectString`, `defaultOracleUsername`, `oracleConfigDir`, `oracleWalletLocation`; **AutoDE: Set Oracle Password**; Test Connection; Source Assessment.
  - An older server gets a plain "needs Thick mode" message.
  - The read-only guard now also reads Oracle's `q'[…]'` quoting, so a write hidden behind one is refused.
- **Fixed for every platform:** extracted columns were never flagged as primary or foreign keys (`isPrimaryKey` and `isForeignKey` were always false). Foreign-key columns are now flagged from the foreign keys already read, and primary keys on platforms that list them (Oracle so far; Snowflake's and Databricks' `information_schema` queries don't read key constraints yet).
- **Deviations / notes:**
  - The phase was respecified before it was built (decision log 2026-10-16). Fetching `snowflake-sdk` / `@databricks/sql` tarballs ourselves can't produce a working driver (~120 MB dependency trees with native binaries), so AutoDE moderates installs that the user's npm performs. Those two SDKs are not planned. The old phase was split: DRV1 here, DRV2 (onboarding UI) next.
  - The drivers folder is user-level (`~/.autode/drivers`), not VS Code's global storage as the old text said, so an MCP server started by another client finds the same drivers.
  - "The install starts only from the onboarding UI" became "only from a command's button", since the UI is DRV2.
  - Oracle is a source only. Generating Oracle SQL (primitives, Pipeline Spec dialects) is out of scope, and an Oracle *target* connection is refused.
  - Thin mode only: Oracle 11g and older, and the wallet-based password store, need Thick mode.
  - The settings panel has no Oracle card yet (DRV2). Oracle is configured in VS Code settings and with the password command.
  - A q-quoted string that contains an apostrophe is refused by the guard, because the readings disagree. Use `''`.
- **Measured:** `npm run eval` unchanged from v0.37.0 (traps 4/5, contract violations 4/4 with none false, vocabulary 17/21 and 19/21 with captured vocabulary, large estate 8/8, longest synchronous task 57 ms). 308 tests (8 new). Minified bundles: extension 776 KB, MCP server 554 KB.

## 0.37.0

- **MCP server — phase 4: data platforms** (`docs/mcp-engine-requirements.md` §5.3, §6; requirements MCP-1, SEC-5; technical-design §6.12, §10.6; setup: `docs/mcp-setup.md`, *Data platforms*). Seven new tools: `autode_list_connections`, `autode_test_connection`, `autode_list_databases`, `autode_list_schemas`, `autode_extract_metadata`, `autode_explain_sql`, `autode_execute_query`. No vendor-named tools; the platform comes from the connection.
- **Connections without secrets.** The server reads `.autode/config/connections.yaml` (new; committed): platform, role, non-secret settings, a credential pointer (`env`: `AUTODE_<PLATFORM>[_<REF>]_<FIELD>`; `cli`: a Snowflake `connections.toml` entry) and the per-connection `allowSampleDataInPrompts`. An entry holding a password, token or key is refused. With no file, `AUTODE_SNOWFLAKE_ACCOUNT` / `AUTODE_DATABRICKS_WORKSPACE_URL` define a source connection (for CI). Connection ids match what the adapters report (`snowflake:prod`), so estate bindings line up. The server never touches VS Code's secret store; `--allow-cli` gives it consent to run `snow`.
- **Read-only guard** (`src/engine/platform/sqlGuard.ts`). `autode_execute_query` runs exactly one statement and, unless the server is started with `--allow-write`, only `SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN`. Comments, strings and quoted identifiers are stripped before the check, under two quoting conventions at once (ANSI, and Snowflake/Spark's backslash escapes, backticks and `$$`), and the text is accepted only when both agree. Tested: `INSERT`, `MERGE`, `DROP`, `CREATE`, `GRANT`, `CALL`, `USE`, multi-statement input, comment-smuggled and quote-smuggled writes, `SELECT … INTO`, `WITH … INSERT`, `EXPLAIN ANALYZE` are refused before anything reaches the platform. With `--allow-write` the tool is annotated `destructiveHint: true`, so clients ask first. C4a's probes now pass the same guard. `autode_explain_sql` compiles any single statement with `EXPLAIN` without running it, writes included, which is what phase 6's dry-run before execute needs.
- **Sample-data consent** (`src/engine/platform/sampleData.ts`). Off by default, per connection. Off: `autode_execute_query` returns columns and the row count, not rows (`SHOW`/`DESCRIBE`/`EXPLAIN` output passes, since it is metadata); metadata extraction keeps structure, row counts, and distinct and null counts, and drops profile minimum/maximum values and query-history text (which carries literals from real queries). This happens in `ConnectionManager.extractMetadata()`, so the extension's own extractions (Source Assessment, Sync Metadata, the source connection check) obey it too, reading consent from the same file. On: values in columns whose names suggest personal data, and e-mail addresses and card numbers in any column, are `[masked]`. Tested end to end: with consent off, planted sample values reach neither the persisted `schema-graph.json` nor an assembled context pack; with it on, the personal-data column is masked and the ordinary one kept; CSV ingestion keeps no values.
- **Errors and redaction.** Platform failures map to `AUTH_FAILED`, `PERMISSION_DENIED`, `TIMEOUT`, `CONNECTION_FAILED` or `PLATFORM_ERROR`, with the raw text redacted and truncated in `details`. A stdio test starts the bundle with a Databricks token and a Snowflake password in its environment, makes connections fail, and finds neither in any response or stderr line.
- **Fixed:** the plan's Source Assessment step passed a Snowflake private-key passphrase as `passphrase`, which the adapter never reads, so an encrypted key failed there while Test Connection worked. It now passes `privateKeyPassphrase`.
- **Deviations / notes:**
  - The spec doesn't say where a server started by another client finds its connections. The extension's settings and SecretStorage are invisible to it, so the server uses the new committed file, and consent lives there too: it is a decision about the customer's data, and the file makes it visible and reviewable (decision log 2026-10-16).
  - "Never enter an LLM prompt" is applied to MCP responses, because a tool result is the client's prompt. So without consent `autode_execute_query` returns no row values at all. That includes `SELECT COUNT(*)`: the guard can't tell an aggregate from a single value by lexing.
  - `--allow-write` comes from the command line, not from the `readOnlyMode` setting. Phase 5, where the extension starts the server, passes the flag when `readOnlyMode` is false.
  - The guard refuses some legitimate SQL whose quoting the two conventions read differently (`'it\'s'`, `$$a;b$$`). Use `''` escapes. Functions with side effects are invisible to any lexical guard; `docs/mcp-setup.md` recommends a read-only platform role.
  - Databricks connections from `.databrickscfg` profiles still aren't connectable (no change since v0.17.0: the CLI resolver returns a pointer, not the token). Use an `env` reference.
  - Personal data is recognised by column name and value shape until GOV classifies columns. An alias (`SELECT email AS e`) gets past the name check.
- **Measured:** `npm run eval` unchanged from v0.36.0 (traps 4/5, contract violations 4/4 with none false, vocabulary 17/21 and 19/21 with captured vocabulary, large estate 8/8, longest synchronous task 55 ms against 49 ms, within run-to-run noise). 300 tests (8 new). `dist/mcp-server.js` is 538 KB minified (470 KB at v0.35.0; budget 1.5 MB).

## 0.36.0

- **Workspace layout: `.ai-context/` becomes `.autode/`, grouped by lifecycle, and deliverables move to a visible `autode-output/`** (roadmap phase LAY, decision log 2026-10-16; requirements WS-1, CTX-5; technical-design §2.1–2.2). The folder had grown from a deliverables folder into four kinds of content with different lifecycles, under a name users found confusing. Now:
  - `.autode/problems/<id>/` — spec, Pipeline Spec, plan, context documents, pack, attachments (committed);
  - `.autode/knowledge/` — ledger, `estate.yaml`, `sources.yaml`, profiles, business context, verified queries, vocabulary, snapshots (committed);
  - `.autode/config/` — interview-skill overrides and tool skills, primitives, target environment (committed);
  - `.autode/local/` — active problem, chats, derived graph, catalog, last extraction (never committed);
  - `autode-output/<problem-id>/<phase>/<specId>.v<n>/` — generated deliverables with their grounding manifests (setting `artifactDirectory`, now workspace-relative, default `autode-output`; absolute paths and `..` are refused).
  Every path is defined once in the new `src/engine/workspaceLayout.ts` (it was hard-coded in 33 places across 12 files); extension, engine and MCP server use it.
- **Fixed: per-engineer state was committed in customer repositories.** The documentation called chats, caches and `active-problem.json` "git-ignored", but only this repository's own `.gitignore` said so — AutoDE never wrote ignore rules into a workspace. AutoDE now writes `.autode/.gitignore` (`local/`) itself, so transcripts and caches stay out of any repository, and teammates no longer overwrite each other's active problem.
- **Migration.** On activation, a workspace with `.ai-context/` is moved to the new layout before any manager reads a path (`src/engine/workspaceMigration.ts`): moves only (ledger events, manifests and history stay byte-identical; git records renames), never overwrites (a file already at its new place wins and the old one is reported), never guesses (unrecognised entries stay in `.ai-context/` and are listed), idempotent (a teammate who pulls a migrated repository gets their remaining local files moved on next start). A notification summarises the move and asks for a commit. Tested: every kind of legacy file lands where it belongs byte for byte; a migrated workspace's ledger reloads with every fact live and none retracted or sent to review.
- **Fixed along the way:** edits to the business-context file take effect without a window reload (the old watcher only covered top-level `.ai-context/` files, and business context lived one level down). "Open artifacts folder" and the artifact staleness check were given the workspace root and looked in `<workspace>/artifacts`, where nothing was ever written; they now use the active problem's output folder. The MCP tool `autode_compile_pipeline_spec` suggested `artifacts/build/…` paths that matched neither layout; it now suggests `autode-output/<problem>/03-build/<specId>.v<n>/…`, where the extension writes build artifacts.
- **Deviations / notes:** migration is automatic with a notification rather than behind a confirmation dialog — activation would otherwise have to wait on a modal, and running half-migrated would need both layouts supported everywhere; every step is a reversible move inside the repository. A custom `artifactDirectory` value set before v0.36.0 was relative to the problem folder and is now read relative to the workspace. The MCP server assumes the default output folder for suggested paths (it can't see VS Code settings). Phase 4 and every later phase move one version later (phase 4 is now v0.37.0).
- **Measured:** `npm run eval` unchanged from v0.35.0 (traps 4/5, contract violations 4/4 with none false, vocabulary 17/21 and 19/21 with captured vocabulary, large estate 8/8, longest synchronous task 49 ms). 292 tests.
- **Licence and identity.** AutoDE stays **MIT** — free for any use, including commercial — with the copyright now held by Arun Gribta (it named "Auto Data Engineering Hub", which is not a legal person); `package.json` gains `author`; the README states the terms. Publisher id `arun-gribta` (was the display name "Arun Gribta", which `vsce` rejects): the extension id becomes `arun-gribta.auto-data-engineering-hub`, so a development host asks for platform credentials once more.
- **Icons.** New marketplace icon `media/autode-icon-256.png`, a single-colour activity-bar and panel glyph `media/autode-activitybar.svg` (VS Code tints it; the old full-colour `media/logo.svg` is removed), and `media/autode-icon-64.png`, which the MCP server now reports as its icon (embedded as a data URI) together with `title: "AutoDE"`.
- **Documentation brought up to date.** The engineering onboarding guide (last revised for v0.13.0, with paths that moved in v0.26.0) is rewritten for v0.35.0 as an orientation — concepts, flows, code tour, daily loop, rules, how to extend, current risks, a first-week plan — linking into the other documents for detail. requirements.md gains §1.1, a map from each capability area to the spec sections and phases that extend it, and a *Planned work* line under each capability. technical-design.md: the architecture diagram shows the MCP server; §10.5 (settings — it listed 23 of 56) and §12 (source tree — missing 11 modules) are now generated by `npm run docs:generate` from `package.json` and `src/`, and a test fails when they are stale; the test section describes the current suite. manual-verification.md gains Parts 9–12 for v0.32.0–v0.35.0. The doc map records the rule that each phase updates the guide and the checklist.
- **Packaging works.** `npx vsce package --no-dependencies` now builds a VSIX (480 KB, 28 files) — impossible at every earlier version. `.vscodeignore` is now an allowlist, because the blocklist would have shipped local `.claude/` settings and a `.venv/` Python environment. **Third-party notices:** the bundles strip comments, so the licences of the 9 bundled libraries (6 MIT, 2 ISC, 1 BSD-3-Clause) are generated into `dist/THIRD-PARTY-NOTICES.md` from what esbuild actually bundled, and ship in the package.

## 0.35.0

- MCP server — phase **3** (`docs/mcp-engine-requirements.md` §5.1, §5.2, §5.4–§5.6; context-layer-requirements.md §9, read-only part; requirements MCP-1, NFR-5). New `src/mcp/` (no `vscode`, lint-enforced), bundled to **`dist/mcp-server.js`** and run as `node dist/mcp-server.js --workspace <root>`. **Tools** (all read-only, deterministic, Ajv-validated arguments): `autode_search_primitives`, `autode_describe_primitive`, `autode_validate_transform`, `autode_compile_transform`; `autode_validate_pipeline_spec`, `autode_compile_pipeline_spec` (with suggested paths under `artifacts/`), `autode_generate_design_doc`; `autode_resolve`, `autode_get_context_pack`, `autode_list_assertions`, `autode_check_grounding` — the same pack builder, ledger projection and grounding checks the extension uses. **Prompts:** `autode_interview_<id>` per interview skill; `autode_skill_<id>` only for published, reviewed or trusted tool skills (S2's `isSkillExposable`). **Resources:** the active problem's specifications and context documents and `autode://primitives/{kind}`, each with its revision. **Errors:** the §5.6 envelope; `redact()` scrubs every response and log line. **Setup:** new `docs/mcp-setup.md` (Claude Code, VS Code, Cursor).
- **Build and packaging:** esbuild bundles both entry points (`scripts/bundle.cjs`; `npm run compile` runs `tsc` then the bundler, `vscode:prepublish` minifies). **Packaging fix:** the package excluded `node_modules/` while `ajv` and `yaml` were runtime dependencies, so a packaged AutoDE could not load; now everything is bundled and `.vscodeignore` ships only the two bundles from `dist/`. **Sizes** (production): `dist/extension.js` 740 KB, `dist/mcp-server.js` 470 KB (budget 1.5 MB); VSIX 453 KB / 25 files, down from 871 KB / 220 files at v0.34.0 (measured the same way). New dependencies: `@modelcontextprotocol/sdk` 1.31.0 (runtime, bundled), `esbuild` 0.28.2 and `@vscode/vsce` 4.0.0 (dev) — all MIT, pinned exactly (roadmap decision log, P6). `npm audit fix` updated `fast-uri` (via `ajv`; moderate advisory) — runtime dependencies report no vulnerabilities.
- **Tests:** the bundle is spawned in plain Node over stdio — tools, prompts, resources and templates listed; every tool's `inputSchema` accepts a good payload and rejects a bad one, and the server answers the bad one with `VALIDATION_FAILED`; golden snapshots of `autode_compile_transform` for all three Tier-1 primitives × six dialects (`test/golden/mcp-compile/`, refreshed with `AUTODE_UPDATE_GOLDEN=1`); Pipeline Spec tools, prompts and resources over an active problem; context tools over a ledger the extension's code wrote, with a check that the server changed no file; `redact()` against known secret shapes. The `activate()` test now loads the bundled extension.
- **Deviations from the spec:** (1) The server is **strictly read-only** beyond what §8 requires: it never runs the S2 skill migration (an unmigrated pre-S2 skill stays hidden until the extension has migrated it) and packs built over MCP do not promote objects into the working set. (2) Context is re-read when its files' size or mtime change; **`notifications/resources/updated` is not sent yet** (a SHOULD) — phase 5 adds it with the extension as a client. (3) Two error codes beyond §5.6: `NOT_FOUND` (no such spec, prompt or resource) and `INTERNAL_ERROR` (unexpected failures, raw text only in `details`). Prompt and resource failures are JSON-RPC errors carrying the envelope as `data`, since those results have no `isError`. (4) `platforms` is reported as `null` (unrestricted) and the `platform` filter matches every primitive until phase 6 adds per-primitive platforms. (5) `autode_check_grounding` accepts `dialect` but the identifier extraction is dialect-independent today. (6) Not in this phase, as specified: data-platform tools and `autode_propose_assertion` / `autode_verify_assertion` (phase 4, C4b), `autode_get_semantic_model` and the semantic resources (C5), the extension as an MCP client and agent registration (phase 5). (7) The "manual: Claude Code configured by hand can search, describe and compile" acceptance check is yours: the same calls are covered over stdio by the contract tests.
- **Found, not fixed (roadmap backlog):** `vsce` cannot package AutoDE — the `publisher` is a display name rather than a publisher id, and the icon is an SVG — at this or any earlier version; changing the publisher changes the extension id and with it stored secrets, so it needs the owner's decision. The golden snapshots show Tier-1 `dedup` emitting `SELECT * EXCEPT` and `CREATE OR REPLACE VIEW` for every dialect (invalid in T-SQL, and `EXCEPT` in Postgres/ANSI); phase 6 fixes dialect coverage.

## 0.34.0

- Tool-skill lifecycle, provenance, review and trust tiers — Phase **S2** (`docs/mcp-engine-requirements.md` §9.1; requirement SKL-5). Must exist before any skill is exposed to other agents over MCP (phase 3). New `src/engine/skills/lifecycle.ts` (no `vscode`). **Sidecar** `.ai-context/skills/tool-skills/<id>/.autode-skill.json` — status (`draft | published | deprecated | retired`), version, provenance (`source`, `contentChecksum`, `importedAt`; git fields reserved for S3), trust tier, and a log of every transition (who, when, which content); `SKILL.md` is never modified. **Trust tiers:** `unreviewed` does not run and is not exposable; `reviewed` runs with read-only tools at most and never through Claude Code; `trusted` allows writes and commands (each still approved) and Claude Code. `resolveToolExecutionMode()` takes the lower of the declared-tools ceiling (S1) and the tier's. **Review screen:** `AutoDE: Review Tool Skill` opens a page with `SKILL.md` verbatim, declared and granted tools, resource files, provenance, checksum and history, then asks for a tier. **Run gate:** `isSkillRunnable()` gates the run picker, `/skill` and `ToolSkillAgent` itself (checked before any LLM call); `isSkillExposable()` is what phase 3's `prompts/list` will use. **Lifecycle** (opt-in `autoDataEngineeringHub.toolSkillManagementEnabled`, commands hidden when off): imports start as drafts; Publish keeps the version on first publish and bumps it when the content changed, snapshotting each version to `.autode-history/v<N>/`; Deprecate; Retire. `PlanStep.skillVersion` and `/skill <id>@<N>` pin a version, which still resolves after deprecation. Import now asks before replacing an existing skill, and offers to review the new one.
- **Deviations from the spec:** (1) **Trust is bound to content.** The spec records a checksum but never checks it; here a review applies to the checksum that was read, so a skill whose files change (a pull, an edit, a swapped script) is unreviewed until reviewed again. Line-ending-only changes don't count. (2) **Back-compat is a one-time migration**, not "no sidecar = trusted" forever: skills present at upgrade get a trusted sidecar once (marker `.autode-skills-migrated`); a folder without a sidecar after that is unreviewed, so hand-copied skills cannot bypass review. (3) Import strips any `.autode-skill.json` or `.autode-history/` the source folder carries — a skill cannot ship its own trust. (4) Snapshots are in `.autode-history/v<N>/`, not `history/v<N>/`, because a foreign skill may have its own `history/` folder (which is now covered by the checksum). (5) The lifecycle lives in `src/engine/skills/lifecycle.ts`, not `src/core/toolSkillLifecycle.ts` (engine boundary; the MCP server needs it). (6) Review and trust are **not** behind the management setting — otherwise, with it off, no newly imported skill could ever run; only publish/deprecate/retire and versioning are. (7) The review screen is a generated read-only Markdown page plus a modal choice, not a custom webview. (8) MCP `prompts/list` doesn't exist yet: `isSkillExposable()` ships with tests and phase 3 must use it. (9) No "archive" action separate from publish: each publish snapshots its version.

## 0.33.0

- Business-problem pack, discovery-first gap closing and conformance — Phase **C4a** (`docs/context-layer-requirements.md` §11 Phase C4a, items 1–11; requirements BPS-1, BPS-3, BPS-10, CTX-3, CTX-9, GRD-8, SEC-5). A business problem is whatever the customer has: a paragraph, a document or a set of them. **Pack:** new `src/engine/context/pack.ts` and host `src/context/BusinessPackManager.ts` — documents are registered by path (never copied) with a role (`contract`, `brd`, `kpi_definitions`, `mapping`, `data_dictionary`, `sample`, `other`), an authority (`signed` → confirmed, `draft` → documented) and a version, in `<problem>/pack/pack.yaml`. Evidence refs are clause-level: `<file>#<path | section:Lx-Ly>@<sha12>`. **Interpretation profiles** (`profiles.ts`, `.ai-context/profiles/`): for a house-format YAML/JSON contract the LLM proposes a path mapping from the document's skeleton only (Ajv-validated, always `proposed`); once the engineer confirms it, it is applied deterministically. **Contracts** (`contracts.ts`): clauses are `quality_expectation` assertions on `contract:` subjects (`contract_schema`, `unique`, rules), never schema facts; a new revision supersedes exactly the changed clauses and retracts removed ones. **Conformance** (`conformance.ts`): each source system against each contract, clause by clause — presence, type family and nullability from the catalog, uniqueness and rules from probes; unverifiable data clauses are "not verified", never passed; written as the discover-phase `conformance-report.md`. **Probes** (`probes.ts`): fixed, read-only templates per dialect (Snowflake, Spark SQL, ANSI) returning one row of aggregates; non-identifiers are refused; sampled; run through `ConnectionManager.probeExecutor()` (own system only) or over customer-supplied sample CSVs with the same aggregates. A pass records `verified` (trust → verified, status unchanged); a failure records `verification_failed` (→ needs_review, counts as the reason). **Free text** (`documentExtraction.ts`): per-section extraction into `proposed`/`inferred` facts with section provenance; unresolved subjects flagged; re-extraction adds nothing. **Discover → validate → ask** (`discoveryGaps.ts`): the interviewer is told what discovery established, and a proposed question discovery already answers is dropped with the reason logged. **Spec from the pack:** a spec drafted with a pack records the contract clause ids it rests on (`packRefs`) and sees them during synthesis. **Vocabulary capture:** abbreviations mined from names and the comments that spell them out (no LLM), plus LLM proposals from the pack's documents; the engineer accepts each in a multi-select; accepted entries are merged into `vocabulary.yaml` and re-indexed. New `AgentHub.completeJson()`. Commands: Add Document to Business-Problem Pack, Apply Business-Problem Pack, Run Conformance Check, Verify Claims with Probes, Propose Vocabulary.
- **Measured** (`test/reference/retail-orders/baselines/v0.33.0-offline.md`): all 4 planted violations in source B found, 0 false in source A; contract v2 supersedes exactly 3 clauses; interview filter 4/4; **trap 3 (duplicate `member_id`) now caught by a probe** over a sample file — traps 4/5. Vocabulary captured from the customer's glossary (offline stand-in for the LLM's proposal) lifts paraphrase recall from 0/4 to 2/4 and the whole question set from 17/21 to 19/21, without regressions.
- **Fixed:** an inline `PRIMARY KEY` column was recorded as nullable. Multi-word synonym proposals ("money back") are now dropped — retrieval matches word by word, so an accepted phrase never applied.
- **Deviations from the spec:** (1) a `sample` document role and probes over customer-supplied sample files, because merge and migration sources often have no live connection yet (roadmap decision log). (2) Probes run **on demand** (a command), not automatically on each new claim. (3) Item 7's conflict questions ("the contract says X, source B shows Y; which applies?") are **not** generated from conformance failures yet; they belong in the Context Inbox (C4b). (4) BPS-10 is partial: clause ids are referenced, but the spec's own fields are not restructured around references. (5) BRD extraction with section provenance is covered by a unit test with a stubbed LLM; the offline eval reports it as "not measured" until a cassette is recorded. (6) Binary formats (docx, pdf) are not read, as specified. (7) The two remaining paraphrase misses: v18 shares no word with `refunds`, and v19 resolves "points" to loyalty but ranks `loyalty_members` over `loyalty_transactions`. RET stays unscheduled (decision log). (8) The interview session still does not survive a reload (BPS-7); moved to C4b.

## 0.32.0

- Working-set cache and scale — Phase **K2** (`docs/context-layer-requirements.md` §11 Phase K, items 4, 5, 8, 11, 12; requirements GRD-8, NFR-1, NFR-6, NFR-8). Estate merges and legacy migrations bring estates far beyond the ~200-table working set. **Measured first:** on a generated estate of 2 008 tables and 49 393 columns, the v0.31.0 path (every table and column mirrored into the graph and the assertion ledger) took 713 MB of extension-host heap (the graph itself 49 MB; the rest is ledger), a 2.1 s ledger sync and ~100–130 ms of synchronous work per context pack, and found 0 of 8 tables asked for in other words. **Catalog:** new `src/engine/context/catalog.ts` — per-system, per-environment catalogs under `.ai-context/catalog/<system>/<environment>/catalog.json` (git-ignored by a `.gitignore` the folder writes for itself; rebuildable), in tiers: 0 = name and comment, 1 = structure, 2 = with a column profile. **Working set:** the graph and the ledger now hold only the working set. Imports and extractions go into the catalog whole and into the working set as far as it fits (`autoDataEngineeringHub.context.workingSetMaxTables`, default 200 — so estates of today's size behave exactly as before); beyond that, only tables already in it or referenced by a business assertion. A table enters the working set when a pack uses it: the pack renders it from the catalog and reports it in `PackManifest.promoted`, and `ContextFileManager` promotes it into the graph and ledger. `ContextFileManager.ingestParsed()` is the import path ("Import File…" uses it), `admitObjects()` the shared admission rule (also for live extractions, whose scope replacement now applies to the catalog too). "Create Mapping" and @-mentions list catalog tables outside the working set as well; picking one for a mapping promotes it. **Eviction:** while the working set is over its size, tables unused for `context.evictAfterDays` (default 30) and referenced by no live business assertion leave it, oldest first; their mirrors are retracted with the reason "left the working set" (new `evicted` option and count in `syncGraphToLedger`) and nothing is flagged for review; a live-sourced entry drops back to tier 0, a file-sourced one keeps its structure. **Query-through and refresh on use:** `ContextPackProvider` gains `prepare(request)` and `beforeRun()`; the hub awaits `beforeRun()` before a plan runs and `prepare()` before each step's pack, and chat calls `prepareContext()` before its pack. A request's catalog matches are loaded from the connected source when only their name is known or their structure is older than `context.schemaTtlDays` (default 7, §8.2): an unchanged last-altered timestamp only marks the entry checked, a change re-reads it and the ledger records a supersession (dependents flagged). `ConnectionManager.catalogFetcher()` implements this over the active adapter (`extractMetadata({ schemaFilter, tableFilter })`, lineage skipped; new `readLastAltered()`); `getMetadataQueries(scope, tables)` pushes a table filter into Snowflake's and Unity Catalog's information_schema queries, which now also return `last_altered`. Offline, a name-only match becomes a context gap of the new class `structure` ("the structure of X is not loaded…"); packs with no other seeds now show their gaps too. **Visibility:** a table the source does not return when asked for is marked not visible, and packs say "N object(s) in scope are not visible with your current grants" instead of omitting it. **Profiling (tier 2):** `BaseAdapter.profileTables()` replaces per-column sequential full scans with one sampled query per table (`profileTable`, Snowflake `SAMPLE (n ROWS)`, Databricks `TABLESAMPLE`), at most `discovery.profileConcurrency` (default 4) in flight and never more than `discovery.profileQueryBudget` (default 50) queries per run; `SchemaSnapshot.profiling` reports what was left out. **Vocabulary-robust retrieval:** new `src/engine/context/vocabulary.ts` reduces names and requests to concepts (separators and camel case split, singularised, a default data-engineering abbreviation dictionary — `CUST` → customer, `HDR` → header, `GL` → general ledger … — and generic synonym groups — client/buyer/shopper → customer …), extended per customer by `.ai-context/context/vocabulary.yaml` (`abbreviations`, `synonyms`). The catalog keeps a ranked full-text index over names, schema, table and column comments, column names and glossary aliases (a term's name and definition index the tables its `mapped_tables` name, resolved against the catalog, so they reach tables outside the working set); it is built in chunks that yield to the event loop. Packs add the best few catalog matches (within 75 % of the best score; a column-name match alone never seeds) to the exact matches. DDL `COMMENT ON TABLE|COLUMN … IS '…'` and inline `COMMENT '…'` (quote-aware, so commas and parentheses inside comments no longer split columns), and dictionary comment columns (`CommentString`, `COMMENTS`, `COMMENT`) are now read. **Fixed on the way:** tables imported after the glossary was loaded never got its `maps_to` links until the next re-index; they are linked whenever tables enter the working set. **Eval:** new generated large estate (`test/eval/lib/largeEstate.cjs`: 4 systems, 20 schemas, 2 008 tables, 49 393 columns, cross-schema name collisions, a legacy EDW with abbreviated names, an acquired CRM with its own words, 8 planted questions) and a 21-question vocabulary-mismatch set over the estate fixture (`vocabulary-questions.yaml`, with the acquired team's `documents/vocabulary.yaml`), reported per signal; the ledger and packs SUTs now import sources the way "Import File…" does. Results (offline, `baselines/v0.32.0-offline`): large estate — ingest 302 ms, heap growth 24 MB, packs ≤ 2.2 ms touching 1–3 of 20 schemas, longest synchronous task 46 ms (target ≤ 100 ms), 8/8 planted questions seeded, catalog 11 MB on disk; vocabulary questions 17/21 seeded (names only 3/21, + comments 3/21, + abbreviations 7/21, + synonyms, vocabulary file and glossary 17/21; paraphrases 0/4); answerability 16/26 (was 13/26: q02, q07, q18 now answerable); traps 3/5 and noise 0/40 unchanged; step packs 517 tokens median (was 421 — glossary terms now reach the tables they name). **Decisions (recorded in the roadmap):** no embedded database — the catalog at 2 000 tables costs 24 MB of heap and 11 MB of JSON, and every budget holds with margin; revisit above roughly ten times that size. RET (embeddings) not scheduled: every miss is a paraphrase no dictionary covers, which an LLM-proposed, engineer-reviewed vocabulary entry (C4a) can address without making retrieval provider-dependent; RET is reconsidered if real engagements' questions show paraphrase misses that C4a's vocabulary capture does not fix. **Deliberate deviations from the spec text:** (1) tier 0 is not populated by a separate name-only listing — imports and extractions deliver structure, so their tables arrive at tier 1; tier 0 arises from eviction of live-sourced entries and from name-only sources (`Catalog.upsertNames()`); (2) the working set takes an import whole when it fits (`workingSetMaxTables`) rather than only "objects in scope", so small estates behave as before; (3) eviction applies only while the working set is over its size; (4) tier-2 profiling is not yet triggered per plan step — it stays in Source Assessment, now sampled and budgeted (C4a's probes are the per-step data checks); (5) "visible with your grants" is detected when a source does not return a table it was asked for, not by a separate privilege query; (6) query-through runs where an async hook exists (plan steps, chat); other packs (spec drafting, interview turns) render catalog structure they already have and report name-only matches as gaps; (7) the 100 ms budget is measured, not enforced at run time: the eval reports event-loop delay per stage plus the directly timed synchronous calls. 263/263 tests (12 new: vocabulary, comments, ranked search and seed selection, working-set admission and promotion, glossary linking, structure gaps and visibility, query-through, refresh on use, eviction, budgeted profiling, query-through SQL and the catalog fetcher, the hub's prepare/beforeRun), lint 0 errors.

## 0.31.0

- Estate identity and catalogs — Phase **K1** (`docs/context-layer-requirements.md` §11 Phase K, items 1–3, 6, 7, 9, 10; requirements STC-6, STC-7, STC-10, PLT-6, NFR-7). Estate merge and legacy migration need several systems side by side; before this, identically named tables from two systems (or dev and prod) became one node. **Ids:** new `src/engine/context/estate.ts` — physical objects are `obj:<system>/<environment>/<fqn>[.<column>]`, glossary terms `term:<slug>`, rules `rule:<slug of first six words>`, verified queries `query:<slug>`, spec-derived `term:spec.<specId>.<suffix>`/`rule:spec.…`, edges `edge:<type>:<source>-><target>`. File and live-extraction producers emit them directly (a collision must be prevented before two nodes share an id, not repaired after); `Origin` gains `system` and `systemEnvironment`, and `Origin.environment` (source/target) now follows the system's role. **Estate:** `.ai-context/estate.yaml` — systems (id, name, role `source | target | both`, optional per-schema role overrides for in-place modernisation) and bindings (connection or imported file → system, environment, schemas); `resolveIdentity()` gives an unbound connection or file a system named after it and records it. `ContextFileManager` owns the estate (`getEstate`, `bindToSystem`, `resolveConnection`, `resolveFile`). New command `AutoDE: Open Estate (Systems & Environments)`; `Ingest File as Source Context` asks which system a file describes; Browse… allows several schemas and records them on the connection's binding. **Migration:** pure, idempotent `rekeyLegacyGraph()` re-keys every pre-0.31.0 id from its provenance; `ContextFileManager` applies it on load and before every persist; the ledger gets a new `aliased` event (`from`, `to`), `foldAliases()` resolves chains, `assertions()` reports non-mirror subjects under the current id, and compaction keeps the map; `syncGraphToLedger(…, { aliases })` carries a re-keyed mirror to its new id as a `superseded` (reason `re-keyed`) pair — not a change, not a retraction, dependents not flagged; `GraphManager.getNodeById()` falls back through the alias map, so mapping contexts holding old ids still resolve. **Catalogs:** `getMetadataQueries(scope?)` (Snowflake, Databricks) and `extractMetadata({ schemaFilter })` extract several schemas per connection (lineage read once); `ConnectionManager.setEstateResolver()` supplies a connection's identity and binding schemas; the `schema-graph.json` merge is keyed by `(system, environment, database.schema)` (or connection + database.schema), so extracting a second schema no longer retracts the first — a re-extraction replaces only its own schema. **Manifests** pin `catalogRevisions` (latest extraction per `system/environment`, `catalogWatermarks()`); **grounding** treats objects the approved Pipeline Spec plans to create as known (`checkSqlGrounding(…, plannedObjects)`). **Legacy dictionaries:** a CSV with a Teradata `DBC.ColumnsV`, Oracle `ALL_TAB_COLUMNS` or `INFORMATION_SCHEMA.COLUMNS` header is read as a column dictionary (types with length/precision, Teradata type codes mapped, nullability). **Eval:** the reference sources gain `ref.currency_codes` in both shop and crm (same fully qualified name, different columns — now 20 tables, 129 columns), a shop dev environment (`shop_dev.ddl`) and a Teradata EDW export (`legacy/edw_dbc_columns.csv`); a new estate scenario checks every declared table stays distinct. Results (offline, `baselines/v0.31.0-offline`): source tables kept distinct 20/20, tables distinct across shop/prod, shop/dev, crm and the EDW export 25/25, no legacy ids, all 13 manifests pin catalog revisions; traps 3/5 and answerability 13/26 unchanged (expected — K1 doesn't change delivery). Earlier baselines were measured on the 18-table fixture. **Deliberate deviations from the spec text:** (1) Phase K split into K1 (this) and K2 (working-set cache, refresh on use, visibility, the 100 ms budget, vocabulary-robust retrieval, large-estate fixture), and later phases move down one version; (2) the unnamed environment is `default`, and ids are lower-cased; (3) the spec's "environment" is `Origin.systemEnvironment`, because `Origin.environment` already meant source/target; (4) rules have no natural key, so their id is the slug of the first six words — an edit there reads as a removal plus an addition rather than a supersession; (5) grounding "per side" is simplified: identifiers resolve against every system's catalog plus the planned objects, since SQL patterns can't reliably tell a source reference from a target one; ambiguity across systems is reported as before; (6) `estate.yaml` is written by `ContextFileManager` with an atomic write but without the revision check other documents use; (7) dictionary exports carry no key information, so their columns have no primary keys. 251/251 tests (10 new: estate.yaml edits apply without a reload, id scheme and estate parsing, same-name tables across systems and environments, dictionary CSVs, pure re-keying, re-keyed supersession with the alias map and compaction, an in-place migration of a pre-K1 workspace, scope-keyed merging, multi-schema extraction with the estate resolver, manifest catalog revisions and planned objects), lint 0 errors.

## 0.30.0

- Context packs, grounding manifests and causality — context-layer Phase C3 (`docs/context-layer-requirements.md` §7.1, §7.3, §8.3, §10.1, §11). Every LLM call now gets context for *its* task instead of the one global dump, and every generated artifact can show what it was built on. **Engine (no `vscode`):** `src/engine/context/retrieval.ts` — `resolveText()` (deterministic free-text → graph nodes: qualified names, `<table>.<column>`, schema mentions such as "the shop and crm source schemas" → every table in them, table labels in prose with singular/plural and multi-word matching — "support tickets", "order" — ambiguous labels match every candidate, term/metric names) and `expandNeighborhood()` (BFS with distance decay, both edge directions; `GraphManager.traverseNeighborhood()`, unused since its introduction, now delegates to it). `contextPack.ts` — `buildContextPack({ purpose, seeds?, query?, maxTokens?, stepId? }, { graph, assertions, conflicts, runtimeFacts })`: seeds from `seeds` + `resolveText(query)`; hops per purpose (step 2, others 1); score = relevance × trust weight (verified 1.0, confirmed 0.95, documented 0.7, inferred 0.4); mandatory sections first — warnings (conflicts and `needs_review` items touching the scope, context gaps), STRICT rules linked to the scope or naming a seed table or one of its columns, keys/grain on seed tables — then seed tables *with columns* (name, type, PK, NOT NULL), neighbours collapsed, relationships among tables in the pack, terms, verified queries; a per-purpose token budget (step 3000, plan 2500, qa 2500, chat/spec 2000, interview 1500) with anything left out summarised by count. Returns text + `PackManifest { packId, purpose, mode, seeds, nodeIds, assertions[{id, revision, trust, status}], truncated, tokenCount, gaps, warnings }`; deterministic (`packId` is a content hash; `assertionRevision()` a hash of the assertion's content and status). **No seeds = project overview, byte-for-byte the pre-C3 `buildContextPrompt()` output** — which is now a thin wrapper, so a call with nothing to scope by sees no change. `ContextPackProvider` interface (`buildPack`, `sources`, `supplementary`, `specRevision`). `contextGaps.ts` — §7.3 relationship gaps: a request that combines two entities ("<A> per/by/for each <B>", "join <A> to/with <B>", "<A> joined to <B>") with no join path between them at the required trust (default ≥ confirmed; paths ≤ 3 hops over foreign-key and projected relationship edges, plus proposed relationship assertions at `inferred`) → `ContextGap { needed, subject, reason: absent | below_trust, minTrust, foundTrust }`, phrased as a question by `describeGap()`. `src/engine/grounding/manifest.ts` — `backDecisions()` maps each decision-bearing primitive parameter (`*key*`, `partition*`, `grain`, `orderBy*`, `incremental`, …) to the assertion that justifies it (a live key/grain assertion with the same columns, else the schema's declared PK; ordering/incremental columns ← a live `decision` naming the column) or records it `unbacked` / `belowTrust`; `checkRules()` machine-checks STRICT masking rules (every reference to a column the rule names must sit inside a hash/mask function) and lists other STRICT rules for manual review; `buildGroundingManifest()` (§8.3 shape: artifact, spec id/version/revision, plan step, agent, generation method, primitives, packId, assertions with `usedFor`, decisions, overrides, gaps, and the §10.1 results — identifier resolution and type compatibility via C1's `checkSqlGrounding`, decision backing, rule compliance, `GROUNDING_UNRESOLVED`/`GROUNDING_UNBACKED`/`RULE_VIOLATION` warnings); `manifestStaleReasons()` (fact-level impact analysis: a relied-on assertion superseded / rejected / under review → *"dedup.partitionByColumns changed: "…" was superseded by … (chat message t3)"*); `explainManifest()`; `renderGroundingReport()`. **Hub:** `AgentHub.setContextProvider(provider, onPack)`. `executePlan()` builds a pack per step (`purpose: 'step'`, query = the step's task) and passes it plus the provider's supplementary Source/Target Context as `context.schemaContext`, instead of the plan-time context string; gaps are logged. New `AgentExecutionContext.recordGeneration` — called by the shared `generateViaPrimitiveOrFallback()` (primitive with params and version, or the freehand/template fallback), so no agent changed. After each step every returned artifact gets a manifest, written beside it as `<file>.grounding.json` (`ArtifactWriter.writeManifest()`, archived like the artifact), and at the end of the run a **Grounding Report** artifact (validation phase). `getStepPack()`, `getLastRunManifests()`. **Also fixed (C1 finding 4):** an artifact an agent both passes to `context.addArtifact()` and returns no longer appears twice. **Extension:** `ContextFileManager.buildContextPack()` / `getPackSources()` / a ring buffer of the last 50 packs; `webviewProvider` sends every LLM call a purpose-specific pack — chat (query = the message), plan generation (problem statement + objectives), spec drafting/refinement/synthesis and phase inference, interview turns, Pipeline Spec synthesis, tool skills — and registers itself as the hub's provider. New commands **`AutoDE: What the Agent Saw`** (pick any recent LLM call → the pack as sent, with seeds, assertion counts by trust, what was left out, gaps) and **`AutoDE: Explain This Artifact`** (active editor or explorer file → artifact → decisions → assertions → evidence, with current status and stale reasons). Checking artifact staleness now also reports fact-level staleness from the manifests (`reportFactStaleness()`, logged per artifact and posted as `artifactFactStaleness`). **DDL ingestion:** SQL comments are stripped before parsing — a trailing `-- PLACED, SHIPPED, …, RETURNED` comment's commas used to split into bogus columns and swallow the next real one (`shop.orders.channel` was lost); the reference sources now ingest all 122 columns. **Eval:** new system-under-test `test/eval/sut/packs.cjs` (default; builds on the C2 ledger adapter): per-step and per-question packs, chat turns sent with chat packs, plan executed with the hub's provider and an `ArtifactWriter`. The harness now measures step context per plan step (a table counts if any step's pack names it; tokens are the per-step median) and answerability per question, requires trap 4's gap to name tickets and orders, and reports decision backing and stale-fact use from the manifests; `--sut ledger` / `--sut baseline` are the ablation. **Results (offline, frozen as `baselines/v0.30.0-offline.{md,json}`):** traps 3/5 (was 1/5 — trap 4 by a context gap, trap 5 with 0/40 noise tables in every step's pack, whichever order the schemas were imported in); answerability 13/26 (was 5/26; the ablation with the global dump on the same ledger stays at 5/26); step context 421 tokens median (max 1175) with column details, vs the same 477-token table-name list for every step before; 13 manifests written, stale-fact use 0; artifact duplicates 0 (was 13). Identifier grounding is unchanged at 0/3: offline, artifacts come from the template tier, which packs don't reach — measuring the LLM paths needs a recorded cassette (open item). **Deliberate deviations from the spec text:** (1) a step with a context gap is *not paused* yet — gaps are recorded in the pack, the manifest and the log and shown as warnings in the prompt; pausing ships with the Context Inbox (C4), where the engineer can answer them, since a pause with nothing to answer would only block runs; (2) C3 detects relationship gaps from text and decision gaps from manifests; key/grain/metric gaps for steps need the semantic model (C5); (3) freshness weighting (§8.2) is 1.0 until C6; (4) step seeds come from the step's task text, not yet from spec data flows / mappings (C5 consumption); (5) proposed assertions are not rendered into packs (only their conflicts and gaps) — principle C3: they're not facts until confirmed (C4's inbox); (6) when one step writes several artifacts, each manifest lists all of that step's primitive uses; (7) "What the agent saw" is a command opening the pack as a document rather than a panel button; (8) the per-run Grounding Report is produced by the hub rather than `DocumentationAgent`, so it covers every artifact including documentation steps'. 241/241 tests (10 new: text resolution, traversal, overview byte-equality, seeded packs incl. budget and determinism, relationship gaps incl. below-trust and confirmed, decision backing, masking checks, manifest + staleness + Explain + report, executePlan wiring end-to-end, DDL comments), lint 0 errors.

## 0.29.0

- Assertion ledger and projection — context-layer Phase C2 (`docs/context-layer-requirements.md` §4, §8.1, §11). The context layer gets a system of record: every fact is an *assertion* in an append-only ledger, and the context graph is rebuilt from it. **Engine modules** (no `vscode`): `src/engine/context/assertions.ts` — `Assertion`/`Evidence`/`TrustTier` per §4.1, trust ordering, `trustToConfidence()` (verified 1.0, confirmed 0.9, documented 0.8, inferred 0.5), a monotonic ULID factory, canonical JSON; `assertionSchemas.ts` — one Ajv schema per kind for `value` (`relationship` = from/to entity+columns, cardinality; `key`/`grain` = column lists; `metric` needs an expression or definition; …) and `validateAssertion()`; `ledger.ts` — `AssertionLedger` over `.ai-context/ledger/<yyyy-mm-dd>.<sessionUlid>.jsonl` (one file per writer session, so a shared workspace merges cleanly), the seven event types with `causedBy`, `foldEvents()` (pure: events sorted by id, so file read order never matters), convenience mutators (`assert`, `confirm`, `reject`, `supersede`, `recordVerification`, `flag`) and `compact({ prune })` → `snapshot.json` plus the events after it; `projection.ts` — graph ⇄ ledger; `conflicts.ts` — the detector. `FileIo` gains optional `listDir`/`deleteFile` (Node and `vscode.workspace.fs` implementations). **Migration and sync:** every node and edge the existing producers put in the graph becomes a *mirror* assertion (predicate `node`/`edge`, the node or edge as its value), with trust from provenance per §4.3 (`live-verified` → verified, `llm` → inferred, from an approved spec → confirmed, otherwise documented) and evidence from the origin (introspection / spec field / file). `syncGraphToLedger()` asserts new facts, supersedes changed ones (timestamps and confidence alone are not a change), rejects vanished ones with a reason (`no longer present in <source>`), records a newer `lastVerifiedAt` from a live extraction as a `verified` event, and sends live business assertions about a changed or removed node to `needs_review` (the §8.1 dependency walk). Re-syncing an unchanged graph appends nothing, so migration is idempotent. **Projection:** `projectGraph()` rebuilds nodes/edges from `active` + `needs_review` assertions — mirrors give back exactly what they recorded, plus `supportedBy` (new optional field on `BaseNode`/`GraphEdge`) and `origin.confidence` from the strongest supporter's trust; live non-mirror terms, metrics (the first producer of the `metric` node type), rules and relationships add nodes/`related_to` edges. Output is in assertion-id (creation) order, deterministic and byte-identical for the same ledger. **Wiring:** `ContextFileManager.persistCompiledGraph()` is the one choke point — sync → detect + flag conflicts → re-project → `derived/graph.json` — so live discovery and the settings-panel Connect / Source Assessment flow (via the reindex after `schema-graph.json`), file ingestion, spec sync and the business-context files all write assertions; this closes the v0.19.0 gap where Source Assessment wrote no `SourceContext` record: it now writes project-wide (`specId` unset) `schema_fact` assertions. `loadAllFiles()` now starts from the ledger's projection (falling back to `derived/graph.json` for the one-time migration), merges a newer `schema-graph.json` by replacing only nodes from the same source (it used to replace the whole graph, dropping file-ingested tables), and re-reads `business-context.yaml`/`verified-queries.yaml` on top. This also fixes a latent bug: once `derived/graph.json` existed, its snapshot overwrote the freshly loaded business context, so later edits to the YAML never took effect. Business-term and verified-query node ids are keyed by name (`biz-term-revenue`, was `biz-term-1`), so reordering the file changes nothing and redefining a term supersedes it; those nodes now carry an `origin`. **Spec scoping:** an assertion with a `specId` is in scope only while that problem is active — `ContextFileManager.setActiveSpecId()` (called by `webviewProvider` on problem switch and spec approval; carried across the Source Assessment re-init). Switching problems leaves the other problem's facts live in the ledger, neither retracted nor projected. `webviewProvider` now persists after `synthesizeFromSpec()`, so spec facts reach the ledger. **Conflicts** (`detectConflicts()`, over active/proposed/needs_review): *definition* — two definitions of the same business name across glossary terms and metrics, whatever subject they were recorded under, with different formula text; *value* — same kind+subject+predicate, different value (key/grain column lists compared case-insensitively); *declared_key* — a claimed primary key that differs from the one the schema declares. `flagConflicts()` sends active sides to `needs_review` once (idempotent); proposals are already awaiting review. **Also:** `ContextValidator` dispatches the envelope schema's per-kind `definitions` (declared since v0.19.0, never referenced) on `kind` and validates `content`; failures are `warnings`, never `valid: false`, so old persisted data keeps loading. DDL ingestion keeps the declared schema/database (`shop.customers` and `crm.customers` were both `ddl.customers` — C1 finding 1, fixed) and honours table-level `[CONSTRAINT x] PRIMARY KEY (a, b)`. New command `AutoDE: Compact Context Ledger` (QuickPick: compact, or compact and prune — the only path that deletes history). `GraphManager.removeNodesWhere()`. **Eval:** new system-under-test `test/eval/sut/ledger.cjs` (default; `--sut baseline` keeps the v0.26.0 adapter). Until C4's extractor exists, it proposes each scripted turn's facts from `golden/assertions.yaml` as an extractor would — kind/subject/predicate/value, the turn as evidence, `inferred`/`proposed`, subjects resolved deterministically — withholding every outcome field (status, trust, `supersedes`, `conflictsWith`, verification), so what the ledger concludes is its own work; the report says so. Trap 1 now requires a conflict about revenue (C1 accepted any conflict). Fixture clarification: the golden net-revenue metric gains `name: Revenue` (the name turn t2 defines) and the gross glossary fact `term: Revenue`. **Results (offline, frozen as `baselines/v0.29.0-offline.{md,json}`):** traps 1/5 (was 0/5 — trap 1 caught by the definition rule); source tables kept distinct 18/18 (was 17/18); the ledger also surfaces trap 2's turns as a key conflict (t5 vs the DDL's declared key and vs t6) — reported, not counted, since recognising a *correction* is C4 work; everything else unchanged (answerability 5/26, grounding 0/3, artifact properties 1/8). **Deliberate deviations from the spec text:** (1) the graph's producers still write nodes, and the ledger mirrors them, instead of each producer emitting typed assertions (`schema_fact` per column etc.); mirrors make the migration exactly graph-equivalent, and typed assertions arrive with the producers that need them (C4 extraction, C5 semantic model); (2) a new kind `verified_query`, since §4.1 has no kind for the graph's verified queries; (3) a vanished fact is a `rejected` event by `system` with a reason — §4.2 has no retraction event; (4) conflicts are flagged with `flagged_needs_review` events and recomputed on each persist rather than stored; (5) `needs_review` assertions are still projected (they were active and are now contested — dropping them would silently remove context; the inbox/pack warning is C3/C4); (6) key, grain, decision and other non-definitional kinds are recorded and conflict-checked but not projected into the graph yet (the semantic model, C5); (7) "approving a container activates its proposed assertions" has nothing to act on until C4 creates proposals inside containers; (8) the ledger uses Node `fs`, like the rest of `ContextFileManager`, not `vscode.workspace.fs`. 231/231 tests (16 new: ULIDs, per-kind schemas, migration equivalence + idempotence across sessions, deterministic folding, supersession/retraction/dependency walk, lifecycle folding, the three conflict rules, spec scoping, subject resolution, non-mirror projection, compaction/prune, per-kind validation, DDL schemas, and ContextFileManager end-to-end), lint 0 errors.

## 0.28.0

- Tool skills on every provider + `allowed-tools` enforcement — Phase S1 of the roadmap (`docs/mcp-engine-requirements.md` §9.1; carried forward from the earlier Phase 4a/4b plan). **One execution path:** `ToolSkillAgent` no longer special-cases `claude`/`copilot` (`runOnClaude`/`runOnCopilot` removed) — it calls a new `AgentExecutionContext.runWithTools`, which `AgentHub.runConfiguredLlmWithTools()` implements as one `getLlmAdapter(provider).complete(...)` with a tool mode, so a skill runs on all seven providers with no skill changes. `ToolSkillAgent` now imports neither `vscode` nor any adapter, and `extensionContext` is gone from `AgentExecutionContext` (its only reader was the removed Copilot path). Done differently from the plan text: instead of extracting `buildLlmContext()` for the agent to build adapters itself, the hub hands agents the capability — agents stay host-agnostic. **Audit out of every loop:** new `LlmCompleteOptions.auditSink` — the OpenAI-style loop (openai/azure-openai/ollama), Anthropic, Gemini and Copilot loops append each `ToolCallAuditEntry` to it instead of discarding their audit; the result's `details.audit` carries it. Claude Code's CLI runs its own loop and appends nothing. **Allow-list:** new `src/engine/skills/toolAllowList.ts` — `resolveAllowedToolNames()` maps declared `allowed-tools` (Claude/OSS names such as `Read`, `Bash(git:*)`, `Grep`) onto AutoDE tools; nothing declared = no extra restriction (back-compat); declared-but-unrecognized = no tools, not every tool. `toolModeCeiling()` never grants `'full'` to a skill whose allow-list has no write/exec tool (`ToolSkillAgent.resolveToolExecutionMode`, which S2 extends with trust tiers). `toolSpecsForMode(mode, allowed)` moved into `agenticTools.ts` and is used by every loop; `LlmCompleteOptions.allowedToolNames` threads it through all adapters. Defence in depth: `executeAgenticTool` refuses (and audits as `denied`) any call to a tool the run wasn't offered. **Claude Code:** better than the old plan assumed — the CLI's `--tools` list is narrowed to the allow-list (`autode_read_file`→`Read`, `autode_search_files`→`Grep`, `autode_list_dir`→`Glob`, `autode_write_file`→`Edit`+`Write`, `autode_run_command`→`Bash`), and `acceptEdits` mode is used only when a write tool remains. Its whole-run approval now uses caller-supplied text (`LlmCompleteOptions.approvalPrompt`); for skills it states that the run is approved once and AutoDE can't audit or block individual calls. **Interview skills:** `SkillDefinition.systemPrompt` — required by the parser since the format shipped but never sent anywhere — is now rendered as each question skill's `approach:` line in the discovery prompt, so the in-app interview and the MCP prompts (§5.4) use the same text. The bundled `synthesis` skill's `systemPrompt` stays descriptive: synthesis uses its own built-in system prompt and never receives skills. Eval baseline unchanged (expected — S1 doesn't touch context or codegen). 215/215 tests, lint 0 errors.

## 0.27.0

- Reference problem, evaluation harness and baseline — context-layer Phase C1 (`docs/context-layer-requirements.md` §10, §11). No product behaviour change. **Reference problem** `test/reference/retail-orders/`: two source systems (`shop`, `crm`; 18 tables, 122 columns, both with a `customers` table), a 40-table irrelevant `hr_legacy` schema, a sample CSV with a duplicate key, the client's glossary (revenue = gross), an 11-turn engineer script carrying the five traps, a fixed reference plan, 30 questions (4 that must be answered "not known"), 8 structural artifact checks, and the golden assertions/semantic model C4/C5 will be scored against. **Harness** `npm run eval` (`test/eval/run-eval.cjs`): runs AutoDE's real code in plain Node behind a headless `vscode` stand-in backed by the real file system (`test/eval/lib/vscodeHost.cjs`); reaches AutoDE only through a system-under-test adapter (`test/eval/sut/baseline.cjs`) so later phases plug in new capabilities and are scored on identical inputs; routes every LLM call through `LlmRouter` (`offline` — calls refused, deterministic fallbacks; `record` — real provider, saves a cassette; `replay` — answers from the cassette, misses counted) by wrapping `LLM_ADAPTERS`. Measures ingestion fidelity, context delivery (with the noise schema imported last and first), answerability of each question from the context layer, QA accuracy (replay/record), trap detection, artifact grounding and artifact properties; writes `eval-report.md` + `eval-results.json` (git-ignored, rolling) — the frozen baseline is `baselines/v0.26.0-offline.{md,json}`. **Grounding checker** `src/engine/grounding/sqlGrounding.ts` (§10.1 items 1 and 3, reused by C3): resolves `FROM`/`JOIN` targets, aliases and qualified `alias.column` references against the ingested schema, treats CTEs / created objects / dbt models as internal, resolves dbt `source()`/`ref()`, and flags joins and casts across incompatible type classes — a pattern scanner, not a parser, with that limit stated in every report. **Baseline (offline, v0.26.0):** identifier grounding 0% (0/3 — template artifacts read invented tables such as `RAW_DB.PUBLIC.landing`, `raw_sales`); answerability 19.2% (5/26); traps 0/5; artifact properties 1/8 (only the negative "no invented ticket→order join" holds); source tables kept distinct 17/18; plan-step context 526 tokens. **Findings recorded, not fixed here** (C1 measures): (1) DDL ingestion labels every table `ddl.<name>`, dropping the source schema, so `shop.customers` and `crm.customers` collapse into one node; (2) with the noise schema imported first, the step context names 2/17 relevant tables and 20/40 noise tables — the global dump is order-dependent; (3) no column detail ever reaches a prompt; (4) every artifact appears twice in plan state (agents both call `context.addArtifact()` and return it; `executePlan()` keeps both). 206/206 tests, lint 0 errors.

## 0.26.0

- Engine boundary and context store — Phase 2 of the MCP roadmap (`docs/mcp-engine-requirements.md` §4, §7.4). No behaviour change. **Move** (`git mv`, history kept, 47 files): `core/types.ts`→`engine/types.ts`; `core/transforms/`→`engine/transforms/`; `core/pipelineSpec/`→`engine/pipelineSpec/`; `core/skillRegistry.ts`, `core/toolSkills.ts`→`engine/skills/`; `dqm/**` and `core/providerRegistry.ts`→`engine/platform/`; `context/types.ts`, `Yaml.ts`, `fileIngestion.ts`, `ContextValidator.ts`→`engine/context/`. Every importer was rewritten directly — no re-export shims remain. `.eslintrc.cjs` now rejects any `vscode` import (type-only included) under `src/engine/**`, and a functional test loads every `dist/engine/**` module in plain Node with no VS Code available. **Splits:** platform `QueryOptions`/`ExtractOptions` take an `AbortSignal` (`signal`) instead of a `vscode.CancellationToken` (no caller passed one); `IDataSourceAdapter` extends a local `Disposable`; schema-graph persistence moved out of `BaseAdapter` into `ConnectionManager.persistSchemaContext(snapshot, workspaceRoot: string, io: FileIo)` with `snapshotToGraph()` now public; `SnowflakeAdapter` gets CLI-execution consent as a constructor option and `ConnectionManager` as a `cliConsent` getter (read at connect time, like before) instead of reading VS Code settings; the engine's credentials index registers `env`+`cli` (`registerBuiltInCredentialResolvers()`) while the `vscode-secret-storage` resolver and `registerDefaultCredentialResolvers(secrets)` moved to `src/core/credentials/`. `providerRegistry.ts`'s deprecated, caller-less LLM helpers (`getSupportedLlmProviders`, `getLlmProviderDefinition`) were deleted — they were the only engine→extension import. `context/types.ts` lost its unused `IDisposable`. **Context store:** new `src/engine/context/contextStore.ts` replaces v0.25.0's `src/context/RevisionedFile.ts` — `ContextStore` (stateless revision-checked read/write), `RevisionedFile`, `RevisionConflictError` (now `filePath: string`), `writeFileAtomic`, all over a `FileIo` interface with a Node implementation (`nodeFileIo`, default — for the MCP server) and `src/context/vscodeFileIo.ts` for the extension, so managers keep reaching files through `vscode.workspace.fs` and remote/virtual workspaces keep working. **Host interface (§7.4):** `AgentHost { workspaceRoot, confirm(message, actionLabel), fileIo }` on `AgentExecutionContext.host`, built by `AgentHub.buildAgentHost()`; `ToolSkillAgent`'s Claude-run approval and `SourceAssessmentAgent`'s workspace/persistence now go through it, and `SourceAssessmentAgent` no longer imports `vscode`. Deliberate deviations from the spec text: `ContextStore` is built over `FileIo` rather than being Node-fs-only (keeps virtual-workspace support; the engine still defaults to Node); it takes absolute paths rather than workspace-relative ones; the managers' parse/version/archive logic stays in the managers for now (folds into the C2 assertion ledger instead of being moved twice); `extensionContext` stays on `AgentExecutionContext` until S1 removes `runOnCopilot`; the §4.4 MCP-handshake test arrives with the server in Phase 3 — the plain-Node load test covers the boundary until then. 202/202 tests, lint 0 errors.

## 0.25.0

- Spec state synchronization — Phase 1 of the MCP Engine & Portable Skill Registry roadmap (`docs/mcp-engine-requirements.md` §8/§9.0; companion `docs/context-layer-requirements.md`). Fixes a live bug: `SpecManager`, `PipelineSpecManager`, `SourceContextManager`, `TargetContextManager`, `MappingContextManager` and `SemanticLayerManager` loaded their YAML once and served it from memory, and the only `.ai-context` watcher (`ContextFileManager`) was non-recursive, so an edit made by any other process (Claude Code, Copilot, `git pull`, a second window) went unnoticed and the next AutoDE save overwrote it with the stale copy. New `src/context/RevisionedFile.ts`: compare-and-swap persistence keyed on a SHA-256 revision of the file bytes — every manager now reads and writes its file through one, a write is refused with `RevisionConflictError` when the file changed on disk since it was last read or written, and the refused change is no longer adopted in memory (each manager now writes *before* updating its cached copy). An unparseable external edit keeps the loaded copy and leaves the expected revision stale, so the next save asks rather than clobbering an in-progress hand edit. Takes the VS Code API from its owner rather than importing it, keeping the module free of a runtime `vscode` dependency until Phase 2's node-fs `ContextStore` replaces it. New `src/context/ContextFileWatcher.ts`: one recursive watcher over `.ai-context/**/*.{yaml,yml,json}`, debounced per path, ignoring `.<name>.tmp.*` temp files and `history/` archives. Deliberate deviation from the spec text: added alongside `ContextFileManager`'s top-level watcher rather than replacing it, so that watcher's existing business-context re-index scope is unchanged. `webviewProvider.ts` routes each changed path to its owning manager's new `reload()` (own writes are filtered out because the revision still matches what the manager last wrote), then refreshes dependants: a spec reload re-syncs `hub.setSpec()`, re-posts the spec and context gate, and pushes a fresh artifact-staleness report; a change to `active-problem.json` switches the active problem. A refused save raises a Reload from Disk / Overwrite prompt via a module-level conflict handler, so the prompt appears even where a caller catches and only logs the error. New `AgentHub.pauseForExternalChange()`: a Business Problem Spec or Pipeline Spec change during execution lets the running step finish and pauses before the next (simplification vs. spec §8.6: pauses on any external change while running instead of comparing revisions recorded at start — equivalent, since AutoDE's own writes never reach this path). Also: `package.json` version aligned from a stale `0.13.0` to `0.25.0`; a pre-existing `no-useless-escape` lint error in `fileIngestion.ts`'s DDL regex fixed so lint is error-free. 7 new tests (200/200).

## 0.24.0

- Source & Target Context Architecture — Step 7 (governance layer), completing the plan's 7-step sequencing. Modeled on the same 3-layer governance already specified (not yet built) for tool skills in Part 2 of the plan file: provenance capture, review before low-confidence content drives generation, and an explicit never-silent re-verify action. `Origin` (`src/context/types.ts`) gained `reliability?: 'live-verified' | 'best-effort-inferred'` and `lastVerifiedAt?: string` — closing a confirmed gap from the architecture review (Challenge 3: `confidence` existed on `Origin` but was never actually set by a live connection anywhere). `BaseAdapter.snapshotToGraph()` now sets `confidence: 1.0, reliability: 'live-verified', lastVerifiedAt` on every node from a live extraction; `fileIngestion.ts`'s `baseOrigin()` sets `reliability: 'best-effort-inferred'` (a structural parse is a real fact about the *file*, but has never been checked against the *live* source — a real distinction). `ContextFileManager.buildContextPrompt()`'s table listing now flags `best-effort-inferred` tables inline (`_(file-derived, not live-verified)_`) so the LLM and the user both see the difference instead of every table looking equally solid. New `AutoDE: Re-verify Source Schema` command (`reVerifySourceSchema`) — re-runs the existing `sourceAssessment` extraction, diffs the source-tagged table set before/after via a new `listSourceTableFqns()` bridge method, and reports the drift in plain terms (new/still-present/no-longer-found), never silently dropping a missing table from context on its own initiative (a permissions change or network blip shouldn't make a table silently vanish — it's flagged for the user to investigate instead). This closes out all 7 steps of the plan in `after-phase-3b-are-graceful-lagoon.md` Part 3.

## 0.23.0

- Source & Target Context Architecture — Step 6 (Mapping Context). New `MappingContext`/`EntityMapping`/`ColumnMapping` types (`src/core/types.ts`) and `src/context/MappingContextManager.ts` — a separate, independent object from `SourceContext`/`TargetContext` (per the architecture review's Q2: mappings are inherently relational and don't belong inside either side), persisted to `context/mapping-context.yaml` with the exact same content-revision versioning/archive pattern as `SourceContextManager`/`TargetContextManager` (`version` bumps only when revising an already-approved predecessor; archived to `context/history/mapping-context.spec<N>.v<M>.yaml`). `EntityMapping.sourceEntityId` references a real `GraphManager` node id — both sides of a mapping are picked from the same shared, already-unified graph (source and target connections both write into one `GraphManager`, tagged via `Origin.environment`), not two separate models; `targetEntityId` is optional so Greenfield work (a target table that doesn't exist as a discovered node yet) can still record a mapping against a free-text `targetName`. Editing any mapping in an already-`approved` container drops its status back to `built` — an edited-then-unreviewed mapping set is never silently treated as still-approved. Wired into `webviewProvider.ts`'s `activateProblem()` lifecycle alongside `SourceContextManager`/`TargetContextManager`; new bridge methods `listMappableTables()`/`listTableColumns()`/`upsertEntityMapping()`/`getMappingContext()` let `extension.ts` reach the shared graph and the new manager (both private fields on the webview provider). New QuickPick-driven `AutoDE: Create Mapping (Source → Target)` command (`createMapping`) — consistent with this codebase's QuickPick-only UX convention (no bespoke visual mapping editor): picks a source table, then either an existing target table or a typed name for Greenfield, auto-matches columns by case-insensitive name, and saves via `upsertEntityMapping()`. The Unified Semantic Layer half of Step 6 is also done: new `SemanticLayerSnapshot` type + `src/context/SemanticLayerManager.ts`, capturing the live shared `GraphManager` graph's current content/counts as an explicit, spec-pinned, versioned snapshot on a new `AutoDE: Build Unified Semantic Layer Snapshot` command (`buildSemanticLayer` — never runs automatically). Metadata persists to `context/semantic-layer.yaml`; the captured graph content itself to `context/semantic-layer.snapshot.json`; both archived together (mirroring the same version-bump-on-revising-approved pattern) to `context/history/semantic-layer.spec<N>.v<M>.{yaml,json}` — a later live-graph change can't silently invalidate what an approved artifact was actually generated against. Not yet started: Step 7's governance/trust-tier layer.

## 0.22.0

- Source & Target Context Architecture — Step 5 (real, structural file-based ingestion). New `src/context/fileIngestion.ts` — dependency-free structural parsers for CSV (real header + sampled-value type inference: INTEGER/FLOAT/BOOLEAN/TIMESTAMP/STRING), JSON (array-of-objects or single-object; column set is the *union* of keys across a sample, so a key missing from one record means nullable, not absent), and DDL (`CREATE TABLE` — a deliberately narrow parser, not a general SQL grammar: handles `NOT NULL`/`PRIMARY KEY`, a type's own internal comma like `DECIMAL(10,2)`, multiple statements per file, and skips constraint-only lines like `FOREIGN KEY (...)` rather than miscounting them as columns). Every node gets `Origin.confidence: 1.0` — a structural parse is a fact, not an LLM guess, unlike the existing `AttachmentStore` LLM-extraction path this deliberately doesn't touch or duplicate. New `ContextFileManager.persistCompiledGraph()` (made public) and `DataAgentHubWebviewProvider.ingestFileIntoGraph(nodes, edges)` let a command add directly to the same shared `GraphManager` a live connection's Source Assessment already writes to — so an ingested file's tables render everywhere `buildContextPrompt()` already does, with zero new rendering path. New `ingestFileAsSourceContext` command + "Import File..." button in the Source panel (deliberately source-only, matching the reviewed proposal's own panel-responsibility split; Parquet/Avro/data-dictionaries/docs are explicitly out of scope — the first two need a real binary-parsing dependency, the rest are inherently free-text and already better served by `AttachmentStore`). Same known, accepted gap as `testConnection`/`sourceAssessment`: doesn't also write a `SourceContext` record (spec-scoped; this command doesn't assume an active business problem either).

## 0.21.0

- Source & Target Context Architecture — Step 4 (database/schema/catalog discovery + picker). `IDataSourceAdapter` gained `listDatabases()`/`listSchemas(database)`, implemented concretely on both `SnowflakeAdapter` (`SHOW DATABASES` / `SHOW SCHEMAS IN DATABASE <db>`) and `DatabricksAdapter` (`SHOW CATALOGS` / `SHOW SCHEMAS IN <catalog>` — confirmed live this session that a *bare* SHOW command works even against `hive_metastore`, unlike one wrapped in SELECT/WITH), passed through `ConnectionManager` with the same "no active connection" guard `extractMetadata()` already uses. New `browseSourceDatabase`/`browseTargetDatabase` commands (one role-parameterized `browseDatabaseAndSchema(role)` implementation) connect if needed, then walk the user through two native QuickPicks (database/catalog, then schema) instead of requiring a name typed blindly — directly closing the reviewed proposal's "don't assume the whole account is relevant" gap. Selections write straight to the role- and platform-correct settings and push a `refreshSettingsInWebview()` so the panel's fields don't go stale after a command-driven change bypasses the webview's own save path. A "Browse..." button was added next to Connect on all four cards (Source/Target × Snowflake/Databricks), reusing the same save-before-act (`connectAfterSave`) mechanism Connect already needed.

## 0.20.0

- Source & Target Context Architecture — Steps 2 & 3 (versioning + the Source/Target Panel UI split). **Versioning:** `SourceContextManager`/`TargetContextManager` gained real content-revision history, mirroring `PipelineSpecManager`'s exact pattern — a `version` field bumped only when revising an already-*approved* predecessor of the same spec lineage (never on a plain approve), with the predecessor archived to `context/history/{source,target}-context.spec<N>.v<M>.yaml` first, idempotently. **UI:** the single "Data Platform" panel split into two real, independent tabs — Source and Target — each listing the same platform cards (Snowflake, Databricks), confirmed live-connectable *simultaneously* per an explicit decision (both roles can hold an active connection at once). Settings storage is deliberately **additive doubled flat settings**, not a rename: every pre-existing `defaultSnowflake*`/`defaultDatabricks*` setting keeps meaning "source" exactly as before (so already-configured `settings.json` values, including this session's own live-tested Snowflake config, were never orphaned); a parallel `defaultTarget*` set was added alongside. `extension.ts`'s `testConnection`/`disconnectDataPlatform` were refactored into role-parameterized `runConnectionTest(role)`/`runDisconnect(role)` helpers shared by new `testTargetConnection`/`disconnectTargetDataPlatform` commands, backed by a second, fully independent `targetConnectionManager` instance alongside the existing `connectionManager` (confirms `ConnectionManager`'s single-connection-per-instance design was never a constraint — two instances just coexist). `ConnectionManager.getCredentialsFromSettings()` gained a `role` parameter (`'source'` default, for compatibility). **Databricks wired for the first time in either panel** — previously a visual placeholder only (fields present in the HTML but never connected to save/load, no Connect button at all) despite the backend (`DatabricksAdapter`, REST execution, settings, secrets) having existed since Phase 3b; now has real Workspace URL/HTTP Path/Catalog/Schema/Catalog Type/CLI Path/Token fields and Connect/Disconnect(+Source Assessment on the source side) buttons in both panels, closing a real gap between what the user believed was already wired and what the UI actually did.

## 0.19.0

- Source & Target Context Architecture — data-model foundation (Step 1 of the plan in `after-phase-3b-are-graceful-lagoon.md` Part 3; a full architecture review preceded this, challenging the original proposal before any code was written). `SourceContext` changed from a single flat record (`method`/`sourceType`/`description`/`connectionSummary` directly on the document) to one object holding a `sources: SourceContextEntry[]` list — still one lifecycle/version/approval per container, but internally scalable to more than one source connection without another reshape. Each entry, and every `Origin`-tagged graph node, now carries a `connectionId` (`BaseDataSourceAdapter.getConnectionId()`, e.g. `snowflake:prod`) distinct from the bare platform name — closing a confirmed gap where two connections of the same platform type (or two same-named tables from different sources) were indistinguishable. `SourceContextManager.parse()` migrates a pre-v0.19.0 flat-shape file into the new list on read, so existing workspaces keep working. UI (`sourceContext.sources[0]`) and `pipelineSpecSynthesis.ts`'s rendering updated to match. A known, explicitly deferred issue: the settings-panel "Connect"/"Source Assessment" flow (`extension.ts`) still doesn't write a `SourceContext` record at all — only the Palette's "Describe source"/"Connect to Data Platform" flow does; fixing that is tied to a larger, not-yet-decided question about whether `SourceContext` should stay spec-version-scoped or move to project-level, and is intentionally out of scope for this pass.

## 0.18.0

- Runtime Context Unification — see §4.10. Live UI testing of the v0.17.0 connectivity work found chat had zero awareness of a real, live connection, and the top status pill never updated after connecting — traced to "LLM context" being assembled independently in ~7 places, two of which (`generateSpec`/`refineSpec`, and a client-supplied `schemaContext` param hardcoded to `''`) carried no real context at all. Fixed by extending `ContextFileManager.buildContextPrompt()` — already the closest thing to a shared context object — with a generic, in-memory `RuntimeFact` slot (`setRuntimeFact()`), and making connection status role-keyed (`source`/`target`) via `webviewProvider.notifyConnectionStatus(role, status)`, closing a second gap where `connectToDataPlatform()` (the target-connection flow) never reported status anywhere. `generateSpec`/`refineSpec` and `ToolSkillAgent` now receive live context for the first time.

## 0.17.0

- Real Snowflake/Databricks execution — core (Phase 3b-i/ii/iii) — see §4.9. Revised twice in-session on concrete evidence (measured ~120MB combined dependency-tree cost, then real-world feedback that a REST-only default underperforms for large-catalog extraction and is separately network-restrictable in some enterprises): neither `snowflake-sdk` nor `@databricks/sql` is a dependency any more. A priority cascade instead — Snowflake prefers shelling out to `snow sql` (native protocol) for a CLI-derived connection, both platforms fall back to their public REST SQL-execution API (`fetch()`, PAT/OAuth/key-pair-JWT via `node:crypto` alone) for a direct credential. `ConnectionManager.getSupportedPlatforms()` now reads `providerRegistry.ts`; a real Databricks settings surface replaces a previously-nonexistent settings key. Not yet built: on-demand native-driver acquisition and the platform-onboarding checklist UI.

## 0.16.0

- Platform Onboarding & Credential Architecture — Interactive Onboarding UX implemented (Phase 3a-ii) — see §4.8. `PlatformCliDescriptor` (`src/dqm/credentials/PlatformCliDescriptor.ts`, `cliDetection.ts`, `cliRegistry.ts`) for both `snow` and `databricks`, mirroring `ClaudeCodeAdapter.resolve()`'s cascade; `SnowflakeCli` shells out to `snow connection list` (gated behind the new `dataPlatformCliConsent` setting); `DatabricksCli` reads `.databrickscfg` directly instead of an unverified CLI subcommand (`databricksCfg.ts`). New command "AutoDE: Connect to Data Platform" (`webviewProvider.ts#connectToDataPlatform()`) resolves a chosen CLI connection through Phase 3a-i's `cli` resolver and populates a new `TargetContext.credentialRef` pointer. `CliConfigResolver` extended to Databricks (pointer-only, consistent with Snowflake). Service-account path: `serviceAccountCredentialRef` setting + "AutoDE: Test Service Account Credential". `SnowflakeAdapter`/`DatabricksAdapter` stubs widened to accept a CLI-derived pointer credential so the onboarding flow demonstrably completes today, ahead of Phase 3b's real execution.

## 0.15.0

- Platform Onboarding & Credential Architecture — Credential Resolution Foundation implemented (Phase 3a-i) — see §4.8. `src/dqm/credentials/`: a pluggable `CredentialResolver` interface (`CredentialReference` is a pointer — platform, principal type, resolver id, ref — never the secret itself) plus a module-level registry (`registerCredentialResolver()`/`resolveCredential()`) as the extension point for enterprise secrets managers. Three built-in resolvers: `EnvVarCredentialResolver` (documented `AUTODE_<PLATFORM>_<FIELD>` env vars — the simplest service-account/CI path, zero VS Code dependency), `CliConfigResolver` (Snowflake only — confirms a named connection exists in `connections.toml` via a `[name]`-header scan, then hands back a `{connectionName}` pointer for `snowflake-sdk`'s own native loading), and `VsCodeSecretStorageResolver` (generalizes `ConfigurationManager`'s 3 hardcoded secret methods into one key scheme, `autoDataEngineeringHub.secret.<platform>.<principalType>.<profileOrRef>.<field>`, additive alongside them). `providerRegistry.ts`'s `authModes` gained a `principalTypes` dimension (`AuthModeDescriptor[]`) and is consumed for the first time via `getAuthModesForPrincipal()`. Not yet wired: `ConnectionManager`/`testConnection`/the adapters still source credentials from the flat settings-only assembly — that migration is Phase 3b's job, downstream of Phase 3a-ii giving a user a way to pick a `CredentialReference` in the first place.

## 0.14.0

- Deterministic Execution Core & Declarative Specification Framework — see §12. Stabilization (CI/lint/real `deactivate()`/dead-code removal); a closed, Ajv-validated transform-primitive registry (`src/core/transforms/`) the LLM only selects/parameterizes, never freehands, wired ahead of the existing freehand-LLM/template fallback in 3 of 5 codegen agents; a declarative (Tier 2, YAML-authored, no-code-execution-template-engine) primitive extensibility layer mirroring the skills-loader's bundled+override pattern; a strictly-validated Pipeline Spec (`src/core/pipelineSpec/`) deterministically compiled from — and rendering a Markdown design doc alongside — an approved BPS plus its full surrounding context, including a new attachment structured-extraction pass (`AttachmentStore`, `SpecProvenance`'s new `'attachment'` source); primitive lifecycle management (sidebar UI, publish/deprecate, an opt-in permission gate, and version pinning so an approved Pipeline Spec survives a primitive being republished later). Also produced (not yet implemented at the time): a Platform Onboarding & Credential Architecture design — §4.8.

## 0.13.0

- Lifecycle orchestration — see §8.12 of `requirements.md`. `AgentHub` is now the single enforcement point for the lifecycle's approval gates, closing a finding from the Generate Plan audit's Revision 6 (§11): at least seven UI entry points (Command Palette commands, the AutoDE Dashboard panel's Quick Actions, the `/plan` slash command, re-plan buttons) could reach plan generation/execution without ever touching a spec or context approval. `AgentHub.generatePlan()` now requires an active, context-ready business problem (`state.specId` + new `state.contextGateReady`, pushed by `webviewProvider.postContextGateStatus()`) before doing anything else; its old body moved to a private `generatePlanInternal()` that `generatePlanFromSpec()` calls after its own, stricter checks. Two new explicit approval gates before `executePlan()` will run: Plan Approval (`AgentHub.approvePlan()`) and Stage Confirmation (`AgentHub.confirmStages()`), both persisted via a new `PlanManager.patchGates()` and both reset whenever the plan or its inferred phases change. New lightweight Business Problem checkpoint (`BusinessProblemSpec.problemStatementApproved`) gates `approveSpec`. Also fixed in the same pass: `SpecManager` was silently dropping `implementationType`/`implementationTypeReason`/`implementationTypeOverridden` on every save, never actually persisting a user's Greenfield/Brownfield classification. The AutoDE Dashboard panel itself is explicitly parked (product decision, 2026-09-16) — future work.

- Discovery progress surfacing — see §8.13 of `requirements.md`. Fresh dev-host testing found that even a fully orchestrated discovery interview *read* as ungrounded, unstructured chat, because `SpecOpsEngine`'s real per-field coverage/turn-budget/skill-ownership tracking never reached the webview — `specQuestion`/`specQuestions` payloads were just the bare question, and the Workflow Palette showed nothing during discovery at all. New pure module `src/core/discoveryProgress.ts` (`buildDiscoveryProgress`, `skillNameForField`) now feeds a `progress` snapshot + per-question `skillLabel` into both message types; the chat bubbles show a topic + progress readout, and the palette shows a live "discovery in progress" card (progress bar + per-skill checklist) instead of staying blank until synthesis.

- Chat no longer auto-resumes on reload — see §8a.4 of `requirements.md`. A reload/restart previously reloaded whatever chat session was last active, transcript and all — confusing testers who expected a clean slate. Any session with real content is now folded on activation (archived via the existing `startNewChat()` path, never discarded) and a fresh empty one takes its place; a new "🕓" Chat History icon in the sidebar topbar lists past sessions and resumes one on click. `openChatSession`'s semantics changed from a read-only preview (`chatSessionViewed`, now retired) to a real resume (`chatSessionLoaded`, reactivating the session via `ChatSessionManager.updateMeta(id, {status:'active'})`) — this closed out the last piece of Phase F's chat-session plumbing that had no UI consumer.

## 0.12.0

- Multi-business-problem workspace — see §8.11 of `requirements.md`. A single workspace can now hold more than one business problem, each fully isolated under `.ai-context/problems/<id>/{spec,plan,context,artifacts}/`, with `.ai-context/active-problem.json` naming the current one; `SpecManager`/`PlanManager`/`TargetContextManager`/`SourceContextManager`/`ArtifactWriter` were re-scoped to take a caller-resolved `contextRoot` instead of hardcoding `.ai-context/<thing>` off the workspace root. New `AgentHub.resetForNewProblem()` and `webviewProvider.activateProblem()` guarantee a genuinely clean in-memory state on every activation/switch — including swapping the shared Context Layer graph's spec-derived layer via `removeNodesBySourceRef`/`synthesizeFromSpec` — closing the stale-state bug where clearing chat and deleting `.ai-context` by hand still left the previous spec visible. New Workflow Palette "Business Problem" section (＋ New / ⇄ Switch) drives `startNewBusinessProblem`/`listBusinessProblems`/`switchBusinessProblem`.

## 0.11.0

- Source & Target Context are now mandatory, reviewed, gating objects — see §8.10 of `requirements.md`. `TargetContextManager`/`SourceContextManager` persist spec-tied records built through a fixed Q&A (`targetContextQuestions.ts`/`sourceContextQuestions.ts`); `generatePlanFromSpec` is blocked server-side until both are approved (Source auto-marked Non-Applicable for Greenfield); the Workflow Palette gained a "Source & Target Context" section. The 5 template codegen agents now try an LLM call first (`AgentExecutionContext.callLlm`, `src/agents/llmCodegen.ts`), grounded in the task/objective/context/target environment, falling back to their original templates — closing the "agents ignore schemaContext" finding (R5 / requirements.md §8's Revision 3 analysis). `TargetConfigManager`'s generic default is no longer auto-seeded into the hub (a regression from wiring it in during v0.10.0).

## 0.10.0

- Generate Plan audit follow-through — see §2.12. Context Layer synced from the approved spec automatically before planning (`SynthesisPipeline.synthesizeFromSpec`, durable snapshot per spec version); deterministic Greenfield/Brownfield classification (`src/core/implementationType.ts`) with user override, feeding phase inference; plan persistence (`src/context/PlanManager.ts`, mirrors `SpecManager`); artifact-level version history (`ArtifactWriter`); `validatePlanResponse` cycle detection + required-phase enforcement + tolerant JSON parsing (closes R10). Source/target environment context implemented — `Origin.environment` tags on the existing Context Layer, `TargetConfigManager` wired into `extension.ts` — see `requirements.md` §16.3a.

- Workflow UX follow-through from hands-on testing — see §8.9 of `requirements.md`. Fixed a stale-status race that made plan generation look stuck after `generatePlanFromSpec`; added an explicit plan-ready confirmation with View Plan/Review Stages actions; new `pending-review` phase status + per-phase Applicable/Non-Applicable overrides on the palette; `executePlan`'s DAG loop no longer halts on the first step failure — independent steps keep running so a missing target connection doesn't block every other artifact; "Generate Artifacts" is now the consistent label everywhere plan execution is triggered; artifact storage moved from a sibling `auto-de/` folder to `.ai-context/artifacts/`.

## Before 0.10.0

Implemented up to v0.9.0 (recorded at the time without per-version entries):

- Single-workspace model (`ArtifactWriter`, `autoDE.artifactDirectory`; `ProjectManager` removed)
- Context Layer IA: unified envelope (`src/context/types.ts`, `docs/schemas/context-envelope.schema.json`), `SourceRegistry` (`sources.yaml`), `SynthesisPipeline`
- Webview CSP nonce fix, workflow palette rework, Cline dev-host workaround in `.vscode/launch.json`
- **Business Problem Specification (spec-driven orchestration)** — see §2. Implemented: BPS types + `SpecManager` persistence/versioning/history, `AgentHub.generateSpec` (LLM-based spec drafting/refining with version semantics), spec-aware chat routing (no-spec → draft, draft → revise, approved → grounded chat), palette + chat spec card review/approve/revise/open UI, `/spec` command, and `generatePlanFromSpec` (spec-driven plan generation).
- **Spec-driven phase inference + orchestration** — see §2.5/§2.7. Deterministic `inferPhases()` (keyword evidence + `scope.out` exclusions + dependency chaining) turns an approved BPS into a required-phase set; plan generation is constrained to those phases; the palette renders the live phase status view (completed / in-progress / blocked / pending / unrequired).
- **Agentic Specification Generation (SpecOps)** — see §2.8. A Superpowers-inspired, DE-tailored requirements flow: a `SpecOpsEngine` state machine + `skills/` registry drive an adaptive questioning conversation (chat bubbles + dynamic intake forms), then synthesize the comprehensive v2 spec (business requirements, data flows, transformations, dependencies, acceptance criteria, implementation considerations, source catalog, provenance).
- **Phase 3 (parts 1 & 2) — layered context loading** — see §10. Real YAML parser (`yaml` dep + `src/context/Yaml.ts`), AJV envelope validator (`src/context/ContextValidator.ts`), atomic compiled-graph persistence (`src/context/GraphPersistence.ts` → `derived/graph.json`); `ContextFileManager` layered loading (`context/**` + `derived/graph.json` via `GraphPersistence`, legacy fallbacks) with AJV envelope validation wired through `ContextValidator`; `SpecManager`/`SourceRegistry`/`TargetConfigManager` migrated to the real `yaml` library.
