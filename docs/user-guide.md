# AutoDE user guide

> **Describes:** v0.50.1. For data engineers who use AutoDE on client work: how to set it up, how a piece of work flows through it, and every feature in detail. If you maintain AutoDE's code, read the [engineering onboarding guide](engineering-onboarding-guide.md) instead.

**Contents**

1. [What AutoDE is](#1-what-autode-is)
2. [Install and set up](#2-install-and-set-up)
3. [Your first business problem, end to end](#3-your-first-business-problem-end-to-end)
4. [The ideas you work with](#4-the-ideas-you-work-with)
5. [Business problems and the specification](#5-business-problems-and-the-specification)
6. [The pack: the client's documents](#6-the-pack-the-clients-documents)
7. [The estate: bringing source and target systems in](#7-the-estate-bringing-source-and-target-systems-in)
8. [Facts, trust and the Context Inbox](#8-facts-trust-and-the-context-inbox)
9. [The workflow](#9-the-workflow)
10. [Agents and how they run a stage](#10-agents-and-how-they-run-a-stage)
11. [The stages in detail](#11-the-stages-in-detail)
12. [Personal data](#12-personal-data)
13. [Platform changes: runbooks](#13-platform-changes-runbooks)
14. [Grounding and traceability](#14-grounding-and-traceability)
15. [The semantic layer](#15-the-semantic-layer)
16. [Chat](#16-chat)
17. [Skills](#17-skills)
18. [Primitives](#18-primitives)
19. [Working outside VS Code](#19-working-outside-vs-code)
20. [What goes where on disk](#20-what-goes-where-on-disk)
21. [Settings](#21-settings)
22. [Coming next](#22-coming-next)
23. [Troubleshooting](#23-troubleshooting)

---

## 1. What AutoDE is

AutoDE is a data engineering workspace. It takes a business problem ("daily net revenue by channel from the shop and the CRM") from the first conversation to deployed, documented pipelines, with AI agents doing the drafting and you deciding.

What sets it apart from a coding assistant:

- **You decide.** Every specification, workflow, mapping, model, Pipeline Spec and platform change waits for a person. An agent proposes; it never approves.
- **It is grounded.** AutoDE knows your estate (the real tables and columns) and the facts about it (keys, grain, relationships, rules), each with its evidence and how far it is confirmed. Generated SQL is checked against the estate, and every deliverable says what it relied on.
- **Code is generated, not written freehand.** Pipelines are described as data (the Pipeline Spec) and compiled by AutoDE's reviewed primitives into SQL for Snowflake, Databricks, BigQuery, PostgreSQL or SQL Server.
- **Nothing changes a platform without you.** Platform changes run only as runbooks you approve, step by step, with dry runs and a tamper-evident log.
- **It works where you work.** The VS Code panel is the main surface. The same engine runs in a terminal (`autode`) and inside agent hosts such as Claude Code, Cortex Code and the GitHub Copilot CLI, over MCP. All of them share the same files.

---

## 2. Install and set up

### 2.1 Install the extension

AutoDE isn't on the Marketplace yet. Install the `.vsix` file you were given: in VS Code, open the Extensions view, then **… → Install from VSIX…**, and pick the file. The AutoDE icon appears in the activity bar.

The extension contains everything it needs: no `npm install`, no Python.

### 2.2 Open a workspace

AutoDE works on the folder you open in VS Code (the first folder of a multi-root workspace). Use one folder per client engagement, ideally a git repository: AutoDE's state is plain files meant to be committed and reviewed (see [§20](#20-what-goes-where-on-disk)).

Click the AutoDE icon. You'll see three views:
- **Workspace:** the panel, with chat, the business problem, the specification, the Context Inbox and the settings.
- **Workflow:** the stages of the current problem, and *Waiting for you* at the top.
- **Skills:** every skill AutoDE has or works with.

### 2.3 Choose a model

Open the settings in the panel (`/settings` in chat, or the gear) and pick a provider:

| Provider | What you need | Notes |
|---|---|---|
| GitHub Copilot | Copilot in VS Code | No key. Allow AutoDE to use it with the setting `languageModelProgrammaticConsent`. |
| Claude Code | The Claude Code CLI (found on `PATH` or in the Claude Code extension) | No key in AutoDE. Model: `sonnet`, `opus` or `auto`. Same consent setting. |
| OpenAI | An API key | Key stored in VS Code's secret storage. |
| Azure OpenAI | Endpoint and key | |
| Anthropic | An API key | |
| Gemini | An API key | |
| Ollama | A local Ollama endpoint | Runs fully local. |

**Test** checks the connection. Keys are never written to files. Most client networks allow only the IDE's own models: Copilot or Claude Code are usually the ones that work.

### 2.4 Connect your data platforms

Open **Source** or **Target** in the panel's settings. Each platform has a card:

- **Snowflake:** account, user, warehouse, database, schema, role; key-pair, password (through the Snowflake CLI) or an existing `snow` connection.
- **Databricks:** workspace host, SQL warehouse HTTP path, catalog and schema; a token or a Databricks CLI profile.
- **Oracle** (source only): a `tnsnames.ora` alias or Easy Connect string, user, and the password (*AutoDE: Set Oracle Password*). It needs the Oracle driver: *AutoDE: Install Oracle Driver* guides you through it.

Each card shows the platform's **prerequisites** (CLIs, drivers) with *Install* and *Verify*. AutoDE never downloads anything by itself: it shows you the vendor's command and runs it in a visible terminal only when you click.

Click **Save as named connection**. AutoDE tests it first and saves it only if the test passes:
- shared settings go to `.autode/config/connections.yaml` (committed, so your team gets them);
- your user name and file paths go to `.autode/local/connections.yaml` (not committed);
- passwords and tokens go to VS Code's secret storage. Secrets never go in files.

The **Saved connections** list at the top of the tab shows each connection's readiness, in AutoDE and for agent hosts.

**Read-only by default.** AutoDE's queries only read. **Sample data**: by default no row values reach a model, only columns and counts. To allow sample rows for a connection, set `allowSampleDataInPrompts: true` on it in `connections.yaml`. Even then, columns that look like personal data (or that you classified as personal, [§12](#12-personal-data)) are masked.

### 2.5 Optional: the terminal and agent hosts

- **The `autode` CLI:** `npm install -g autode-<version>.tgz` (Node.js 18 or later). See [§19](#19-working-outside-vs-code).
- **Claude Code, Cortex Code or the Copilot CLI:** `autode plugin install --host claude` (or `cortex`, `copilot`). See [§19.2](#192-agent-hosts).

---

## 3. Your first business problem, end to end

A quick tour, which the rest of the guide explains in detail.

1. **Start a problem.** In the panel, **＋ New**, and describe the work in a sentence or two: *"Daily net revenue by sales channel, from the shop's orders and the CRM's customers, on Snowflake."*
2. **The interview.** AutoDE asks what discovery can't answer: objectives, sources, data flows, transformations, quality, constraints (and personal data, when it is involved). Answer in chat. Attach documents with the paperclip; they go into the problem's pack.
3. **Approve the specification.** AutoDE writes the Business Problem Specification from your answers. Read it, ask for changes in chat, and click **✓ Approve Specification**.
4. **Plan the workflow.** In the Workflow view, the planning stage drafts the problem's stages from a template (greenfield here). Review it and approve.
5. **Bring the sources in.** *Run Source Assessment* on a platform card (or *Ingest File* for DDL, CSV or JSON). The tables appear in the estate, with profiles.
6. **Work stage by stage.** For each stage, **Run agent**. The agent drafts the stage's output (the target context, the source context, the mapping, the model, the Pipeline Spec …) and you approve it in *Waiting for you*. Confirm the facts it proposes in the Context Inbox.
7. **Build.** The pipeline engineer drafts the Pipeline Spec from AutoDE's primitives and compiles it to SQL. Deliverables land in `autode-output/<problem>/`, each with a grounding manifest.
8. **Deploy.** The deploy stage proposes a runbook. Open it in the Runbook tab, review each step, approve, then run it step by step.

---

## 4. The ideas you work with

| Idea | What it is | Guarantee |
|---|---|---|
| **Business problem** | One piece of work, with its specification, pack, workflow and deliverables. A workspace can hold several. | Work is scoped and traceable. |
| **Specification** | What the business needs, in its words. Approved by you. | Nothing is built against an unapproved intent. |
| **Pack** | The client's documents behind a problem: contracts, BRDs, KPI definitions, dictionaries, samples. | Requirements come from documents a person supplied, with their authority. |
| **Estate** | The source and target systems and their tables and columns. | Everything is checked against what really exists. |
| **Facts** | What is known about the estate (keys, grain, relationships, terms, metrics, rules), each with evidence, trust and status. | Important facts are confirmed by a person or verified against data. |
| **Workflow** | The problem's stages, planned from a template, each gated. | No stage is skipped silently; changes make later stages stale. |
| **Waiting for you** | Everything that needs a person, in one list. | Only a person decides. |
| **Agents and skills** | An agent is a role with bounded tools; a skill is a method for a kind of stage. | AI works inside bounded roles. |
| **Mapping, model, Pipeline Spec** | How sources become targets; the target model; the pipelines as data. | Each is checked and approved before the next step uses it. |
| **Deliverables** | What stages produce, with a grounding manifest each. | Every deliverable is traceable. |
| **Runbook** | A platform change as approved, logged steps. | Nothing changes a platform without you. |

---

## 5. Business problems and the specification

### 5.1 Starting and switching

- **New:** **＋ New** in the panel, `autode problems new "<statement>"`, or `autode_start_problem` from an agent host. A folder is created under `.autode/problems/<id>/`, named from the statement.
- **Switch:** **⇄ Switch** in the panel, or `autode problems use <id>`. The active problem is per person (`.autode/local/active-problem.json`), so teammates can work on different problems in the same repository.

### 5.2 The requirements interview

The interview turns your statement and the pack into a specification. It has parts, each an AutoDE skill:

1. Requirements and objectives
2. Source catalog
3. Data flow
4. Transformations
5. Quality and acceptance
6. Constraints and assumptions
7. Governance and personal data — asked only when the problem involves people or personal data
8. Synthesis: writing the specification

AutoDE **discovers before it asks**: it checks the pack and the facts first, and doesn't ask what they already answer (it tells you what it found instead). You can answer several questions at once, skip one, or say "I don't know": unanswered points become explicit assumptions in the specification.

The interview is saved with the problem. You can continue it in the panel, in a terminal (`autode interview show`, `autode interview answer`), or in an agent host; each answer records who gave it and where.

**Attachments.** Files you attach in the interview become documents of the problem's pack ([§6](#6-the-pack-the-clients-documents)); a file from outside the workspace is copied in.

### 5.3 The specification

The Business Problem Specification (`spec/business-problem.yaml`) holds:
- problem statement, objectives, success criteria, scope (in and out), constraints, assumptions;
- business requirements, data flows, transformations, dependencies, acceptance criteria, implementation considerations;
- the source catalog;
- governance: whether personal data is involved and which regulations apply;
- provenance: which question, answer or document each field came from.

Review it in the panel, change it by asking in chat ("move refunds out of scope"), and click **✓ Approve Specification**. An approved specification is versioned: revising it later makes a new version, and the stages built on the old one become stale.

### 5.4 Exploration mode

Most work with AutoDE is exploration, a proof of concept or a proof of value, not production. A business problem can run in **exploration mode**: AutoDE then proceeds on the model's recommendations instead of stopping to ask, and labels everything it produces so nobody mistakes it for grounded work.

**Switching it on.** On the panel's Business Problem card, choose **Explore…** and acknowledge the disclaimer ("results may be completely wrong: assumptions are not verified"). Before the problem's first message it applies to the new problem. In a terminal: `autode problems new "<statement>" --exploration`, or `autode problems mode exploration`, typing `explore` to acknowledge. Who switched it, and when, is recorded in `.autode/problems/<id>/mode.yaml`.

**What changes:**

| Governed (the default) | Exploration |
|---|---|
| At a context gap (an unknown join, key or grain) the agent stops and asks you. | The agent records its best guess as an **assumption** (with the model, the stage and why) and continues. |
| Facts a model proposes wait in the Context Inbox. | They count at once, at **assumed** trust. |
| A failed check refuses an approval (another specification version, a source context with no source, an unmasked sensitive column). | It warns; the approval says what warned, and AutoDE keeps the list. |
| Approving asks you to confirm (a typed word in a terminal). | One click (`y` in a terminal). Still you, still recorded. |

**What never changes:** platform changes go only through approved runbooks; an exploration problem may target **non-production environments only** (a connection your approvals file doesn't list under dev, sandbox or test counts as production, and its runbooks are refused); row values reach a model only where the connection allows sample data; no secrets in files; destructive steps need a rollback.

**Labels.** A banner in the panel and the Workflow view; a first line in every deliverable an agent records ("built on unverified assumptions; results may be completely wrong"); `"exploration": true` in its grounding manifest; and a section in every agent's assignment, so agents in Claude Code or other hosts behave the same.

**Back to governed.** Choose **Switch to governed** on the card, or `autode problems mode governed`. AutoDE lists what to harden: every assumption, every fact only a model vouched for, and every check that only warned (`autode problems hardening` shows the list at any time). Governed checks don't accept assumed facts, so the problem blocks where it normally would until you confirm or replace them.

---

## 6. The pack: the client's documents

### 6.1 Adding documents

*AutoDE: Add Document to Business-Problem Pack* (or attach in the interview, or `autode pack add <file> --role <role> --authority signed|draft --doc-version <v>`). For each document you set:
- its **role**: contract, BRD, KPI definitions, mapping workbook, data dictionary, sample;
- its **authority**: `signed` (its facts enter as confirmed) or `draft` (they enter as documented, waiting for you);
- its **version**: a new version replaces exactly the clauses that changed.

### 6.2 How documents are read

- **Structured documents in a house format** (a client's own YAML data contract, say) are read through an **interpretation profile**. The model proposes the profile once; you confirm it (it lives in `.autode/knowledge/profiles/`). From then on AutoDE reads every version of that document deterministically, with no model.
- **Free text** (a BRD) is read into proposed facts. Each fact cites the section it came from and **quotes it word for word**: a fact whose quote isn't in that section is dropped as unsupported, and so are facts that don't validate, with the reason shown. The model reports on every section; a section it skipped is read again on its own. Facts carry the model that read them.
- **Tables and fixed phrases need no model.** A Markdown data dictionary (a table with a *Column* header and *Description*, *PK*, *Unique*, *Required* or *Nullable* columns) and sentences such as "`email` must be unique", "`status` is never null" or "`order_items` has one row per `order_item_id`" are read deterministically, as documented proposals, whenever the document is applied (even with no model, as in `autode pack apply`).
- **Two documents that agree** strengthen each other: the same fact from a second document adds its evidence instead of a duplicate.
- **Double reading** (setting `capture.doubleExtraction`) reads each document twice and keeps keys, grain and relationships only where both readings agree. It doubles the model calls.
- **Binary formats** (Word, PDF) are not read yet: export them to Markdown or text.

**Apply** (*AutoDE: Apply Business-Problem Pack*) reads the documents and records their facts. In a terminal, `autode pack apply` reads structured documents through their confirmed profiles; free text needs a model (the panel, or an agent host).

### 6.3 Conformance and probes

- **Conformance** (*AutoDE: Run Conformance Check*, `autode conformance`) checks each source system against the contract, clause by clause: column present, type, nullability, accepted values, uniqueness. Without a live connection, data clauses are reported as *not verified*, never as passed.
- **Probes** (*AutoDE: Verify Claims with Probes*) check claims against data with fixed SQL that returns only aggregates (counts, rates), on a live connection or on sample files you supplied. A claim that passes becomes **verified**.

---

## 7. The estate: bringing source and target systems in

### 7.1 Systems and environments

The estate (`.autode/knowledge/estate.yaml`, *AutoDE: Open Estate*) lists the systems (shop, CRM, the warehouse) and their environments (dev, prod), and which connection or file feeds each. Objects get ids such as `obj:shop/prod/shop.public.orders`, so two systems' `customers` tables never get mixed up.

### 7.2 Bringing metadata in

- **Run Source Assessment** on a platform card: choose a named connection, a database and its schemas. AutoDE brings the tables and columns into the estate, with profiles (null rates, distinct counts, min and max where sample data is allowed). Profiling is budgeted: `discovery.profileQueryBudget` queries at most, `discovery.profileConcurrency` at a time.
- **Ingest File** (*AutoDE: Ingest File as Source Context*): DDL, CSV (types only, never values) or JSON.
- **Column-dictionary exports** (Teradata, Oracle or `information_schema` column listings as CSV) are recognised by *Ingest File* and loaded as tables and columns.
- From a terminal: `autode estate ingest <file>… [--system <id>]` and `autode estate extract --connection <id> --schema <DATABASE.SCHEMA>… [--profile]`; `autode estate show` lists systems and the working set.
- **Re-verify Source Schema** compares the estate with the live source and reports drift.

### 7.3 Large estates: the catalog and the working set

AutoDE keeps the whole estate in a per-system **catalog** but mirrors only the **working set**, the tables your problems use, into its knowledge (200 tables by default, `context.workingSetMaxTables`). When a task needs a catalogued table, AutoDE brings it in. Tables nobody has used for `context.evictAfterDays` leave the working set when it is full. Schema facts older than `context.schemaTtlDays` are re-checked against the source before a stage's agent uses them.

Search understands abbreviations, synonyms, the client's own **vocabulary** (*AutoDE: Propose Vocabulary* mines abbreviations from names and comments; you accept entries), column comments and glossary terms.

---

## 8. Facts, trust and the Context Inbox

### 8.1 Facts

Everything AutoDE knows about the data is a **fact**:

| Kind | Example |
|---|---|
| schema fact | `orders.amount` is `NUMBER(12,2)`, nullable |
| data fact | `orders.channel` has 4 distinct values, 0% null |
| key | `orders` is unique on `order_id` |
| grain | one row per order line |
| relationship | `orders.customer_id` → `customers.customer_id`, many to one |
| business term | *Active customer*: ordered in the last 90 days |
| metric | *net revenue* = gross − refunds, daily, excluding cancelled |
| business rule | personal data is masked in every target layer |
| quality expectation | `order_id` is never null |
| decision | SCD type 2 for customers |
| assumption, constraint, naming convention, verified query | |

Each fact has:
- **evidence:** where it came from (a column's introspection, a document section, your chat message, a probe);
- **trust:** `verified` (checked against data) > `confirmed` (by a person) > `documented` (from a signed or draft document) > `assumed` (a model's reading or guess, taken as true in exploration mode, [§5.4](#55-exploration-mode)) > `inferred` (a model's reading, waiting for you);
- **status:** `proposed`, `active`, `needs review`, `superseded`, `rejected`.

Facts are kept in an append-only ledger (`.autode/knowledge/ledger/`): history is never lost, and every change records who made it.

### 8.2 Where facts come from

- **Your sources:** introspection and profiles.
- **The pack:** contracts and documents ([§6](#6-the-pack-the-clients-documents)).
- **Conversation:** after each chat or interview turn, the model proposes the facts you stated, in the background. A later, different value for the same fact (you corrected yourself) supersedes the earlier one once you confirm it.
- **Without a model:** type `/define`, `/rule`, `/decide` or `/assume` in chat to record a fact directly.
- **Agents:** they propose facts; you confirm them.
- **The data itself** ([§8.6](#87-facts-from-the-data)): keys, joins and personal data found and checked without a model.

### 8.3 The Context Inbox

The Context Inbox, in the panel, lists what waits for you: facts to review (grouped by subject), conflicts, and changes agents proposed. For each fact: **Confirm**, **Edit & confirm**, **Reject**, or **Verify now** (run a probe). Documented facts from one source can be confirmed in bulk.

From a terminal: `autode facts`, `autode facts show <id>`, `autode facts confirm <id>…` (or `--from <source>`), `autode facts reject <id>`, `autode facts edit <id>`, `autode facts conflicts`.

**Conflicts** — two facts that contradict each other — are shown side by side, never merged silently.

### 8.4 Context gaps

When a stage needs something nobody knows (how two tables join, the key of a table, the grain of a fact table), its agent gets the **context gap** in its assignment: it asks you instead of guessing, or leaves the gap open in its deliverable for the approver. Once you record the fact, the gap closes. In exploration mode the agent records its best guess as an assumption instead, and continues ([§5.4](#55-exploration-mode)).

### 8.5 Capture coverage: what is still missing

*AutoDE: Capture Coverage* (`autode coverage`) is a checklist of what a complete picture of the problem needs, built without a model from the specification and the estate:

- **per table in scope** (those the specification or the mapping names): key, grain, change column, load pattern, personal-data classification, relationships to the other tables in scope, business description;
- **per metric the specification names** (revenue, retention, churn, margin …): definition, grain, filters.

Each item is ✓ known, ? proposed (waiting for you), ~ assumed (exploration), ◦ a candidate AutoDE found, or ✗ missing, and every item not known says what closes it: a probe, a confirmation in the Context Inbox, a question for you or the curator, or a classification. Use it before approving the specification's downstream stages, and as the to-do list when hardening an exploration.

### 8.6 Facts from the data

*AutoDE: Find Candidates from Data* (`autode capture candidates --record`) looks at the tables in scope before any model does:

- **keys:** columns named like a key, tested for uniqueness and nulls (a declared key is tested too, and a key the data breaks is reported);
- **grain** from the key it found;
- **joins:** a column named after another table's key (`cust_no`, `customer_id` for `customers.id`, `shop_customer_id` for `shop.customers.customer_id`), tested for orphans;
- **change columns** (`updated_at`, `last_modified` …);
- **personal data by value:** columns whose values look like e-mail addresses or phone numbers.

Every test is a fixed probe that returns counts only, on the live connection or on the pack's samples. What passes is recorded as a proposed fact that is already **verified**; you confirm what it means. Personal data stays yours to classify ([§12](#12-personal-data)).


### 8.7 The Knowledge Explorer

*AutoDE: Open Knowledge Explorer* (also from the Workflow view's title bar, the 📊 status line under the chat, `/explore` or `/context`) opens a tab for exploring everything AutoDE knows. It only reads: changes still go through the Context Inbox, decisions and the Semantic Model editor.

- **Search** (press `/`): tables, views, columns, glossary terms, rules, verified queries, semantic models and their logical tables, dimensions, facts, metrics and filters, and knowledge facts, by name, alias, synonym or description. Every word must match. If nothing does, AutoDE shows related results from your vocabulary and says so. Tables from the estate catalog that aren't loaded yet appear too, marked *catalog only*.
- **Filters** on the left use the names catalogs use:
  - asset type, system, platform, environment;
  - certification: *verified*, *documented*, *unverified*, or *draft* for unapproved semantic models;
  - status, review state (knowledge facts), classification, glossary term.

  Domain, owner and tags appear greyed until the metadata model gives them data (MM, v0.51.0). Counts are for your search before filtering, so you can see the alternatives.
- **Asset pages** have these tabs:
  - **Overview:** where the asset came from, when it was captured and verified, keys and grain, decisions and assumptions in scope (including team-wide ones), conflicts.
  - **Schema:** columns with type, key, nullability, classification and certification.
  - **Meaning:** glossary terms, and the logical tables, metrics and other semantic elements built on it.
  - **Lineage:** relationships, mappings and derivations known so far.
  - **Facts:** each knowledge fact with its evidence tier, review state, sources and history.
  - **Governance:** classifications and masking, and the rules that name it.
  - **Used by:** artifacts whose manifests rest on it, semantic models, verified queries.
  - **Graph.**

  *Copy as Markdown* puts the page on the clipboard. *Review in the Context Inbox* appears when something waits for you.
- **Graph view** (top bar) shows the **landscape**: every table in the working set, or one system, schema or semantic model, with every relationship AutoDE knows between them:
  - foreign keys and confirmed relationships, as solid lines;
  - proposed relationships and joins of draft models, dashed;
  - semantic-layer joins, dotted;

  each labelled with its columns. Tick *Columns* to see them inside their tables.
- **An asset's Graph tab** shows its neighbours one to three hops out, with columns inside their table. You can filter by edge type and choose a layout (force, layered, concentric).
- **In every graph:**
  - **click** a node for a summary card (*Open*, *Expand*, *Focus*);
  - **double-click** to add its neighbours to the canvas without losing what's there;
  - **Find** highlights matches and dims the rest.

  The border colour is certification; dashed means unverified or draft. Export as PNG or SVG. If a table has no relationships yet, the graph says so and points you to the ways to add them.
- **Facts** view: every knowledge fact, filterable by type, review state, evidence and text.
- **Estate** view: systems and environments with their catalog tables, working set and objects you can't see; connections and whether they're ready; what feeds each system.
- **Keyboard:** `/` to search, ↑ ↓ and Enter in the results, ← → between tabs, Alt+← and Alt+→ for back and forward.

**From a terminal:** `autode explore` (overview), `autode explore search <words> [--type table,column,glossary_term] [--system s] [--platform p]`, `autode explore asset <id or name>` (the asset page as Markdown), `autode explore graph <id or name> [--hops 2]`, and `autode explore graph [--system s] [--model m] [--columns]` for the landscape. Add `--json` for the same data the panel uses. **For agents:** `autode_search_assets`, `autode_get_asset_context`, `autode_explore_graph` and the `autode://asset/{id}` resource.

The vocabulary follows the industry's standards and catalogs (context-layer specification §6.11). Tags, a full glossary, typed rules, owners, domains and certification come with the metadata model (MM, v0.51.0); lineage from the platform and impact analysis with LIN (v0.52.0); ontology concepts with ONT1 (v0.53.0).
---

## 9. The workflow

### 9.1 Templates

Each problem gets a workflow from a template:

- **Greenfield:** a new pipeline or platform from requirements.
- **Modernization:** moving a legacy system to a new platform (it can import a code converter's output, such as SnowConvert or Lakebridge; AutoDE doesn't convert code itself).
- **Estate merge:** consolidating several systems into one (matching, survivorship, conformed dimensions).

A team can add its own in `.autode/config/workflows/`. Details: [workflow-templates.md](workflow-templates.md).

### 9.2 Planning

The planning stage drafts the workflow deterministically from the template and what AutoDE knows (a contract in the pack switches conformance on, for example), and the planner agent refines it: stages in or out, with reasons; per stage, the agent, its permission tier and a brief. AutoDE checks it against the template's rules (mandatory stages kept, every input has a producer, no cycles), and you approve it. Choosing another template later restarts the workflow after the specification.

### 9.3 Stage kinds

| Kind | What it produces |
|---|---|
| specify | the specification |
| plan | the workflow |
| target-context | the target platform, connection and the problem's choices (modelling approach, transformation and orchestration tools, naming) |
| source-assessment | the sources in the estate, and the source context |
| conformance | the conformance report |
| quality-rules | quality expectations |
| mapping | the source-to-target mapping |
| entity-resolution | match keys, survivorship, conformed dimensions |
| modelling | the target data model and its DDL |
| code-conversion | converted code from a converter's output, with gaps |
| build | the Pipeline Spec and the compiled code |
| reconcile | the reconciliation report |
| validate | test results and the grounding report |
| deploy | runbooks |
| document | design and operations documentation |
| platform-setup | the environment and security plan |
| bi-migration | the inventory and migration plan of reports |

### 9.4 The Workflow view

The Workflow view shows each stage's state: **done**, **ready**, **in progress**, **awaiting approval**, **pending** (with what it waits for), **stale** (with why) or **skipped** (with the reason). A *Next* line says what to do now. *AutoDE: Open Workflow* opens a larger editor tab; the status bar shows the current stage.

Actions on a stage:
- **Run agent:** the stage's agent drafts its output ([§10](#10-agents-and-how-they-run-a-stage)).
- **Produce:** for stages a person does (the mapping can also be yours), open the document to write it.
- **Open stage document**, **Approve stage document**, **Review and approve** (gates).
- **Hand in:** mark a stage you did yourself as done, with its output files.
- **Skip** (with a reason; never a mandatory stage, nor one whose output a later stage needs), **Re-open** (everything after it becomes stale), **Approve again** (a stale stage).

**Waiting for you** at the top gathers everything that needs a person: the workflow and stage gates, stage documents, facts to review, runbooks and their second approvals, connections and other proposals. High stakes come first, and each item says where and how to approve it. The same list is `autode approvals` in a terminal.

**History:** `autode workflow history [<stage>]` shows who did what, when, through which surface, and why.

---

## 10. Agents and how they run a stage

### 10.1 Roles

| Agent | Stages |
|---|---|
| business-analyst | specify (the interview) |
| planner | plan |
| target-architect | target context, platform setup |
| source-assessor | source assessment, conformance, reconcile |
| quality-engineer | quality rules |
| sttm-mapper | mapping |
| data-modeler | modelling |
| pipeline-engineer | build, deploy |
| documenter | document, validate |
| context-curator | reading documents, facts from conversation, vocabulary (in agent hosts) |

Each agent works under a **permission tier** that the stage kind caps: `read` < `propose` < `platform-read` < `workspace-write`. No agent can approve, resolve a decision, start a stage or call another agent.

### 10.2 What an agent gets

**Run agent** builds an **assignment**: the stage, its brief, the role's instructions, the skills for this kind of stage and this target platform, exactly the tools the tier allows, and the **context gaps** already known. The agent works in VS Code with your configured model. A stage no skill covers is yours to do by hand (*Produce*, then *Hand in*).

Before a stage runs, tables past their refresh age are re-checked against the source.

### 10.3 What an agent leaves

Drafts, never decisions: the stage's document, artifacts with grounding manifests, proposed facts. You review them in *Waiting for you* and the Context Inbox. **What the Agent Saw** shows exactly what context it was given ([§14](#14-grounding-and-traceability)).

---

## 11. The stages in detail

### 11.1 Target context

The target platform (from a named target connection), the database and schema, and the problem's choices: modelling approach (dimensional, data vault, one big table, 3NF), transformation tool (dbt, custom SQL …), orchestration, naming convention. Defaults come from the specification, then from team-wide facts, then from the last approved target. Approve it in the panel (**✓ Approve**) or `autode workflow approve <stage>`. From a terminal: `autode context target --connection <id> --set modelingApproach=dimensional …`.

### 11.2 Source context

Which estate systems the problem reads (*Pick from the Estate*, or `autode context sources --system shop,crm`). A source without a connection can be described in words.

### 11.3 Mapping

The source-to-target mapping (`context/mapping-context.yaml`): for each target table, its source, and for each target column, its source column and transformation. The mapper agent drafts it using a deterministic column matcher (names, types, vocabulary, earlier mappings) as evidence; you can also write it yourself (*Create Mapping*, or *Produce* on the stage). AutoDE checks it against the estate; approve it as the stage's document.

### 11.4 Model

The data modeler refines AutoDE's deterministic draft: one entity per target, its kind from the name (`fct_`, `dim_`, `hub_` …), grain and keys from facts, surrogate keys for dimensions in a dimensional model, foreign keys from relationship facts. AutoDE checks it (every entity has a grain and a key of its own columns, foreign keys resolve, the mapping's columns are all there, naming) and renders the DDL itself. What isn't known comes back as gaps.

### 11.5 Quality rules

Quality expectations as facts (not null, unique, accepted values, freshness, ranges), drafted from the contracts and profiles, one per critical attribute or a recorded reason why not.

### 11.6 Build: the Pipeline Spec

The pipeline engineer asks AutoDE for **primitive candidates** for each mapped source:
- `rename_cast`: the staging projection that renames and casts the mapped columns;
- `mask`: right after staging, for columns classified as personal data ([§12](#12-personal-data));
- `dedup`: one row per key, the latest by the change column;
- `incremental_load`: a MERGE on the key.

Each candidate has its reasons ("key from fact …, confirmed") and is validated. What no primitive covers (a column expression, a missing key or change column) is listed, not hidden. The agent records the **Pipeline Spec** (`spec/pipeline.yaml`), AutoDE compiles it to SQL for the target dialect, and the files are recorded as deliverables with grounding manifests. You approve the Pipeline Spec as the build stage's document.

From a terminal: `autode validate`, `autode compile --dialect snowflake [--out <folder>]`.

### 11.7 Reconcile

Reconciliation compares source and target with queries AutoDE generates deterministically: row counts, sums of the measures, key hashes, missing keys on either side, with tolerances for sums. It only reads.

### 11.8 Deploy

The deploy stage proposes **runbooks** ([§13](#13-platform-changes-runbooks)).

### 11.9 Document

Design and operations documentation, generated from the approved specification, model, mapping and Pipeline Spec, linked to its artifacts. *Design doc* is also `autode design-doc`.

---

## 12. Personal data

AutoDE treats personal data as something you decide and it enforces.

**Classify.** *AutoDE: Classify Personal Data…* lists the columns whose names suggest personal data, with a suggestion:
- `pii`: personal data (names, e-mail, phone, address, birth date …);
- `sensitive-pii`: must be masked (identity numbers, card and bank data, health, salary, credentials);
- `confidential`: business-confidential, not personal;
- `none`: not personal after all.

For personal data you choose how it is masked:
- **hash**: SHA-256, so equal values stay equal and keys still join and deduplicate. For values someone could guess by trying them all (phone numbers, birth dates), add a salt from a platform secret, such as `secret('pii', 'salt')` on Databricks or a Snowflake session variable;
- **redact**: a constant instead of the value (passwords, card security codes).

Your classification is recorded as a confirmed fact. From a terminal: `autode governance show [--table <t>]` and `autode governance classify <table.column> --as sensitive-pii [--strategy hash]`. An agent can only propose a classification for you to confirm.

**What follows from it:**
- the build masks classified personal data right after staging, so nothing downstream sees raw values;
- a Pipeline Spec in which a `sensitive-pii` column isn't masked is invalid, and the build can't be approved while a confirmed sensitive column it reads is left undeclared. An unmasked `pii` column is a warning: your platform's own masking policy may cover it;
- with sample data allowed, classified columns are masked in query results too.

Masking is non-reversible. Tokenisation (reversible, with a vault) isn't offered.

---

## 13. Platform changes: runbooks

Creating objects, grants, loading data, deploying a dbt project or a Databricks bundle: every change to a platform runs as a **runbook**.

**What a runbook is.** Steps, each one SQL statement, one allowlisted CLI command or one bundle, with what it should do and how to roll it back. An agent proposes it; AutoDE checks it:
- it classifies every step itself: **read**, **change** or **destructive**;
- CLI commands must be on the allowlist (a team adds its own in `.autode/config/approvals.yaml`, `runbooks.allowCommands`); profile and credential flags are refused (AutoDE adds the connection);
- destructive steps need a rollback or a stated reason;
- SQL with the other platform's constructs gets a warning.

**Who approves.** `.autode/config/approvals.yaml` sets, per environment, its connections, its approvers, whether a second approver is needed, whether it may run unattended, and which classes of step are allowed. A connection no environment lists counts as **production**: production needs a named approver and never runs unattended.

**Running it.** *AutoDE: Open Runbook…* opens the Runbook tab. It shows every step as AutoDE classified it, and lets you:
1. approve (and a second person approves where the policy says so);
2. **dry-run** a step (`EXPLAIN`, `bundle validate`);
3. **run** one step at a time, in order, or the rest at once where the environment is unattended;
4. **roll back**.

Each action is confirmed, and every action goes to a hash-chained log (`runs/<id>.jsonl`) that shows tampering. Editing an approved runbook voids its approval. When the last step is done, the stage is handed in.

From a terminal: `autode runbook list | show <id> | approve <id>`.

**In agent hosts,** AutoDE's plugin for Claude Code adds a guard hook that blocks `snow` and `databricks` commands that change a platform, and tells the agent to propose a runbook instead. It catches mistakes; it isn't a sandbox. Give agents' credentials read-only roles.

---

## 14. Grounding and traceability

- **Context packs.** Every model call gets a pack of context scoped to its task: the relevant tables and columns, facts, terms, and the team's knowledge skills, within a budget, and with the gaps stated.
- **What the Agent Saw** (*AutoDE: What the Agent Saw*) shows a recent pack: what was sent, which facts it rested on, what was left out.
- **Grounding manifests.** Every generated file has a manifest next to it: the tables and columns it references (resolved against the estate), the primitives that wrote it, and the facts behind its decisions. *AutoDE: Explain This Artifact* shows it.
- **Grounding checks** flag unresolved or ambiguous names and incompatible join or cast types: `autode grounding <file.sql>`.
- **Citations.** Chat answers cite the facts they use (`[fact:<id>]`).
- **The semantic layer governs joins and metrics.** Once a shared model or composite is approved (§15), every pack over its tables carries its metrics, filters and joins, and the agent is told to use them. SQL that joins two of its tables in a way it doesn't define, computes one of its metrics differently, or computes a metric your facts know but no approved model defines, is **refused** when an agent records it in a governed problem; the message says what to change. In exploration mode it is recorded with a warning. `autode grounding <file.sql>` and the MCP tool `autode_check_grounding` show the same result.
- **Confidence** on a decision in a manifest is the weakest trust of the facts behind it, or *unbacked*. AutoDE never records a model's own idea of how sure it is.

---

## 15. The semantic layer

The semantic layer holds the business definitions a BI tool or Cortex Analyst uses: what a metric means, which dimensions slice it, how tables join for analysis, the questions it answers. It is a deliverable, kept as YAML in your repository, approved by a person. It is separate from AutoDE's knowledge (§8): facts say what is true of the data; the semantic layer says how the business wants to read it.

### 15.1 Shared models and composites

- **Shared semantic models** live in `autode-output/semantic/<subject>.yaml`, one per subject area (sales, customer, finance). Their format is **Snowflake's semantic model YAML** (tables with `base_table`, `primary_key`, `dimensions`, `time_dimensions`, `facts`, `metrics`, `filters`; `relationships`; `verified_queries`), deployable as it is. AutoDE refuses keys Snowflake doesn't know; its own notes (which facts each element rests on, who approved it) live in `.autode/semantic/`, never in the model.
- **Composites** are a use case's view, in the problem's own folder: `autode-output/<problem>/semantic/<name>.yaml`. A composite names the shared models it **uses** (all their tables, or some; all their metrics, or some), **adds** its own metrics, filters and verified queries, and **describes** (descriptions and synonyms only):

```yaml
autode: semantic-composite/1
name: revenue_by_channel
uses:
  - model: sales
    metrics: [net_revenue]
  - model: customer
    tables: [customers]
add:
  metrics:
    - { table: orders, name: revenue_per_order, expr: "net_revenue / COUNT(order_id)" }
describe:
  orders.channel: { synonyms: [sales channel] }
```

- **No redefinition.** A composite never changes a shared expression, key or join: a different calculation is a new metric with its own name. AutoDE refuses it and says so.
- **No collisions.** Two shared models used together that define the same table must define it the same way; otherwise AutoDE names the difference.
- **Resolving** writes `<name>.resolved.yaml`: one self-contained Snowflake model, what gets deployed. The same inputs always give the same bytes, and the file's header records the version of every shared model it came from.
- **Stale.** When a shared model changes, composites resolved from its earlier version are stale until resolved again; resolving shows the changes.

### 15.2 The Semantic Model editor

Files in a `semantic` folder open in the **Semantic Model editor** (*Reopen Editor With… → Text Editor* for the plain YAML). The file stays the source of truth: every change is an ordinary edit you can undo, diff and commit.

- **Form:** each table with its key and elements; edit expressions, descriptions and synonyms, add or remove metrics and filters. For a composite: what it uses, adds and describes, and the model as it would resolve now.
- **Diagram:** the tables and their joins.
- **YAML:** the raw file.
- **Checks**, shown inline (✗ an error, ! a warning):
  - against the estate: base tables and columns exist, expressions use known columns and elements, types fit;
  - against the knowledge: a join whose "one" side isn't its table's key (it would fan out), a primary key no fact supports or a fact contradicts, a metric its fact defines otherwise.
- **Actions:** *Draft from knowledge* (shared models: adds the tables, elements and joins AutoDE knows and the model lacks; nothing you wrote changes), *Resolve* (composites), *Approve…*, *Check again*.

New files: *AutoDE: New Shared Semantic Model (Draft from Knowledge)…* drafts one from the tables the active problem names; *AutoDE: New Semantic Composite…* starts a composite over the shared models you pick.

### 15.3 Drafting from knowledge

A draft is deterministic and uses only facts a person confirmed or a probe verified: tables and primary keys from declared keys and key facts; joins from foreign keys and relationship facts (direction and type from their cardinality); time dimensions, dimensions and facts from column types; metrics from metric facts that have an expression (one defined in words only is listed as left out); synonyms from glossary terms bound to columns; a personal-data note on classified columns. A base table whose name has no database gets `SET_DATABASE`, and the checks remind you to set it. A model may later suggest better descriptions; you edit and approve.

### 15.4 Approval

- **A shared model** is approved by a person, workspace-wide, at its exact version: in the editor (*Approve…*) or `autode semantic approve <name>`. A failing check refuses it. Editing it afterwards makes it *changed since approved*, and it waits in *Waiting for you* until approved again. An agent proposes a shared model as a decision (`autode_propose_semantic_model`); approving that decision approves the version it writes.
- **A composite** is approved within its problem, at its resolved version, once resolved and not stale. In exploration mode ([§5.4](#54-exploration-mode)) failed checks only warn.

### 15.5 How agents use it

Only approved versions count. A draft, or a shared model changed since its approval, is shown in the Knowledge Explorer (marked *draft*) but is not handed to agents and doesn't govern their SQL. See §14 for what an agent receives and what it is refused.

Deployment (Snowflake semantic views, Databricks metric views, dbt MetricFlow) comes next; see [Coming next](#22-coming-next).

---

## 16. Chat

The chat in the panel is for questions and changes about the active problem: "which tables hold refunds?", "why is the grain of orders the line?", "move refunds out of scope".

- **Read-only by default.** The assistant can read and search the workspace. The toggle next to the input allows edits and commands for that chat; each write is still confirmed.
- **Slash commands:**

| Command | |
|---|---|
| `/spec <text>` | Draft or revise the specification |
| `/workflow` | Open the Workflow view |
| `/define`, `/rule`, `/decide`, `/assume` | Record a fact without the model |
| `/review` | The messages in this chat that read like facts (a key, a rule, a definition, a threshold) and that no fact cites. `/review record <n>` has the model read one again; `/review dismiss <n>` or `/review dismiss all` drops them. Starting a New Chat tells you how many the old one left. |
| `/skill <id> <instruction>` | Run an imported skill |
| `/context` | Show the context status |
| `/connect`, `/target`, `/settings` | Open settings |
| `/sync` | Sync metadata |
| `/clear` | Clear the conversation |

- **History:** *AutoDE: New Chat*, *Chat History*, *Discard Chat*. Chats are personal (not committed).

---

## 17. Skills

### 17.1 The Skills view

Every skill in one place:
- **AutoDE skills** (`autode-<scope>-<capability>`), each with the stage kinds and platforms it serves, its version and maturity, and the roles that use it;
- **Imported in this workspace:** your team's, with their review state and kind;
- **External skills:** vendor and community skills AutoDE works with, by reference only, with their licence and whether they are installed. *Install Skill…* checks the vendor's command first and runs it in a visible terminal only after you confirm.

Catalog: [skills.md](skills.md). From a terminal: `autode skills list | show | check | install`.

### 17.2 Platform skills

AutoDE's own Snowflake and Databricks skills (ingestion, pipelines, governance, performance, deployment), plus dbt and reconciliation. A stage gets them by its kind and the target platform; dbt skills only when dbt is the transformation tool. They change platforms only through runbooks. Details: [platform-skills.md](platform-skills.md).

### 17.3 Your team's skills

*AutoDE: Port a Skill…* (the **+** on the Skills view) brings in a skill from a Git repository, a folder or a dbt package, written for any agent: AutoDE reports what it does, what it needs and what it may change, and imports it unreviewed. You review it, then publish it. A **knowledge** skill (your conventions) then joins the context packs whose question it matches; a skill that declares stage kinds joins those stages' assignments. *Update Skill from Its Source…* fetches a new version and shows the diff. How to write and port skills: [skills-authoring.md](skills-authoring.md).

### 17.4 Running a skill yourself

*AutoDE: Run Tool Skill* (or `/skill`) runs a published, reviewed skill with an instruction. A **reviewed** skill gets read-only tools; a **trusted** one may write files and run commands, each confirmed. Changing a skill's files makes it unreviewed again.

---

## 18. Primitives

Primitives are the reviewed generators the compiler uses: `rename_cast`, `dedup`, `incremental_load` and `mask` are built in, for every dialect. A team adds its own as YAML definitions (Tier 2) in `.autode/config/primitives/`: a parameter schema, a template per dialect with a deliberately small template language (no logic), preview parameters and output checks. The **Transform Primitives** palette in the panel lists them with a live preview. With `primitiveManagementEnabled` on, definitions are drafted, published, deprecated and retired, and an approved Pipeline Spec stays pinned to the version it used.

---

## 19. Working outside VS Code

### 19.1 The `autode` command line

The same engine in a terminal, on the same files. It never calls a model and holds no credentials. The commands, in groups:

- **Checks (safe in CI):** `validate`, `compile`, `grounding`, `conformance`, `probe`, `doctor`, and `check`, the CI gate, which also fails while a high-stakes decision is pending.
- **Problems and estate:** `problems list | new [--exploration] | use | mode | hardening`, `estate ingest | extract`, `context show | target | sources`.
- **Interview and workflow:** `interview show | answer`, `workflow templates | status | plan | approve | next | start | complete | skip | reopen | history`.
- **Knowledge:** `facts …`, `coverage`, `capture candidates`, `semantic show | draft | compose | resolve | check | approve`, `pack …`, `vocabulary …`, `governance show | classify`, `design-doc`, `query`, `explain`.
- **Decisions and approvals:** `approvals`, `decisions list | show | approve | reject`.
- **Connections:** `connections add | list | test | remove`.
- **Runbooks:** `runbook list | show | approve`.
- **Skills and agent hosts:** `skills …`, `plugin path | install`.

Commands that decide something (approve, reject, classify, review, publish) need a person at an interactive terminal and a typed confirmation, and refuse to run when `CI` is set. Full reference, options and exit codes: [cli.md](cli.md).

### 19.2 Agent hosts

`autode plugin install --host claude` (or `cortex`, `copilot`) installs AutoDE's agents, skills and commands (`/autode-status`, `/autode-next`, `/autode-approve`) into the host's folders and registers the MCP server. Then ask the agent to continue your AutoDE problem: the orchestrator skill takes each stage's assignment, has the named agent do it, hands the stage in, and stops at every approval. Your host supplies the model; AutoDE supplies the process, the checks and the approvals. Approvals stay with you: in the panel, in a terminal, or in a committed decision file.

### 19.3 MCP

`autode mcp` exposes the engine to any MCP client (Claude Code, Codex, Cursor, Cline, VS Code's agent mode, where it is available with no configuration). Reads are read-only; changes come back as proposals for a person. Setup per host: [mcp-setup.md](mcp-setup.md).

---

## 20. What goes where on disk

```
<your repository>/
  .autode/                      AutoDE's working state
    problems/<id>/              spec, interview, pack, workflow, contexts, Pipeline Spec, runbooks   (commit)
    knowledge/                  facts (ledger), estate, profiles, vocabulary                         (commit)
    semantic/                   the semantic layer's notes: backing facts, approvals, resolutions   (commit)
    config/                     connections, approval policy, workflows, agents, skills, primitives  (commit)
    local/                      your active problem, chats, caches, catalog                         (not committed)
  autode-output/semantic/       shared semantic models (Snowflake semantic model YAML)               (commit)
  autode-output/<problem>/      the deliverables: SQL, YAML, documents, manifests, semantic/ composites (commit)
```

- **Commit** everything except `.autode/local/` (AutoDE writes a `.gitignore` for it). Reviewing AutoDE's state in pull requests is part of the design.
- **Never** put secrets in these files: AutoDE refuses connections with a password or token in them.
- The deliverables folder is configurable (`artifactDirectory`).

---

## 21. Settings

All settings start with `autoDataEngineeringHub.`.

| Area | Settings |
|---|---|
| Model | `activeLlmProvider`, `activeLlmModel`, `llmEndpoint`, `claudeCodePath`, `languageModelProgrammaticConsent` (allow AutoDE to use Copilot or Claude Code) |
| Connections | `activeSourceConnection`, `activeTargetConnection`; per-platform defaults for the cards (`defaultSnowflake*`, `defaultDatabricks*`, `defaultTarget*`, `defaultOracle*`); `snowflakeCliPath`, `databricksCliPath`, `dataPlatformCliConsent` (allow AutoDE to list your CLI connections) |
| Oracle and drivers | `oracleConfigDir`, `oracleWalletLocation`, `driversDirectory` |
| Discovery | `discovery.profileQueryBudget`, `discovery.profileConcurrency`, `queryTimeoutSeconds` |
| Knowledge | `context.workingSetMaxTables`, `context.evictAfterDays`, `context.schemaTtlDays`, `capture.doubleExtraction` (read documents twice; keep keys, grain and joins only where both readings agree) |
| Output | `artifactDirectory` |
| Lifecycles | `toolSkillManagementEnabled` (drafts and versions for imported skills), `primitiveManagementEnabled` |

---

## 22. Coming next

Specified and scheduled ([roadmap](roadmap.md)):

- **The metadata model** (v0.51.0): tags, a glossary with categories and related terms, classifications, typed rules (validation, policy, standard, guidance), owners and stewards, domains and data products, certification and custom properties.
- **Lineage and impact** (v0.52.0): table and column lineage from the platform, your mappings and AutoDE's artifacts; what a change would break.
- **Ontology and terminology** (v0.53.0–v0.54.0): industry standards such as FIBO as a canonical layer, with your organisation's terms mapped onto it; a guided step to onboard a standard; matching, quality rules and policies that use the meaning.
- **AtScale import** (v0.55.0); Horizon, Collibra and Unity Catalog later.
- **Deploying the semantic layer** (v0.56.0): Snowflake semantic views through a runbook, Databricks metric views, dbt MetricFlow.
- **Merge semantics** (v0.57.0): conformed dimensions and survivorship across systems, in shared models and composites.
- **Patterns and recommendations** (v0.58.0): SCD2, CDC merge and snapshot primitives; a recommended pipeline type with its reasons; team preferences; data contracts for the tables you build.

---

## 23. Troubleshooting

| Symptom | What to do |
|---|---|
| "No language model available" | Check the provider in settings and **Test**. For Copilot or Claude Code, turn on `languageModelProgrammaticConsent`. *AutoDE: Show Active Language Model Status* says what AutoDE sees. |
| A connection won't save | AutoDE saves only after a successful test: read the card's message. Check the platform's prerequisites on the card (*Check Platform Prerequisites*). `autode doctor` shows readiness from a terminal. |
| An agent paused | It hit a context gap: the message says which fact is missing. Record it (Context Inbox, `/define`), then run the agent again. Or, for a proof of concept, switch the problem to exploration mode. |
| A runbook is refused in an exploration problem | Exploration targets non-production only: list the connection under dev, sandbox or test in `.autode/config/approvals.yaml`, or switch the problem to governed. |
| A stage is stale | An input changed after it was approved (a new spec version, a re-opened stage). Review the stage's output and approve it again. |
| Approval is refused | The checks failed: the message lists why (for a build, for example, an unmasked sensitive column). |
| A runbook step is refused | Its command isn't allowlisted, it carries a credential flag, or a destructive step lacks a rollback. `autode runbook show <id>` explains each step. |
| An agent host doesn't see AutoDE | Run `/mcp` (Claude Code) and check `autode` is connected; see [mcp-setup.md](mcp-setup.md#troubleshooting). |
| Something else | `autode doctor`; the panel's log in chat; VS Code's Output view (*AutoDE: Tool Skills*, *autoDE:language-models*); [manual-verification.md](manual-verification.md) shows what each feature should do. |
