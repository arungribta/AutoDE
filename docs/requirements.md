# AutoDE — Requirements

**What AutoDE must do, and why.** This document is authoritative for shipped behaviour and for the product-wide principles. It does not say how anything is built: that is [technical-design.md](technical-design.md). Planned work is specified in [mcp-engine-requirements.md](mcp-engine-requirements.md) and [context-layer-requirements.md](context-layer-requirements.md); order and status are in [roadmap.md](roadmap.md); release history is in [CHANGELOG.md](../CHANGELOG.md). Document map: [README.md](README.md).

Last updated: 2026-10-15 (rewritten as WHAT/WHY only; the previous version, with its implementation detail and per-version narratives, is at commit `fc16b0d` — Appendix A maps every old section to its new home).

**Reading a requirement.** Each has an ID (`AREA-n`), a statement, the reason for it, and a status:

| Status | Meaning |
|---|---|
| **Shipped vX** | Met since version X. |
| **Partial** | Met in part; the gap is named. |
| **Not met** | Valid, not yet delivered, not scheduled — see the roadmap's "Not yet scheduled". |
| **Planned (phase)** | Specified and scheduled; the phase spec has the detail. |
| **Superseded** | Replaced by another requirement or decision, named. Kept so references stay resolvable. |

Changes to requirements follow the rules in [README.md](README.md): a requirement changes here when the behaviour ships, or when a decision in the roadmap's decision log changes it.

---

## 1. Purpose and scope

AutoDE is a VS Code extension that takes a data-engineering business problem from description to delivered artifacts — specification, context, plan, models, pipelines, documentation — through a guided, governed workflow inside the engineer's own repository.

**Why it exists.** General-purpose coding agents write plausible data-engineering code that is not grounded in the customer's actual data, business definitions or approvals. AutoDE's value is the opposite: every artifact traces to an approved specification and to facts about the data that are recorded, trusted to a known degree, and checkable — and the engineer stays in control at every gate.

**Who uses it.** Data engineers and delivery teams on customer engagements. The common engagements are:
- **Greenfield builds** — new pipelines and models from a business problem.
- **Estate merge / consolidation** — several source systems (often from different organisations) merged into one target, usually against a shared data contract.
- **Legacy migration and modernisation** — moving an existing estate (e.g. Teradata, Oracle, SQL Server, Hadoop) to a modern platform (e.g. Snowflake, Databricks), with proof that the result matches.

**Not in scope** (decided; see the roadmap's decision log): replacing the customer's data catalog; converting legacy code (AutoDE uses converters' output); running as a headless service with a thin UI — the extension is the product, and its deterministic core is shared with other agents, not replaced by them.

---

### 1.1 Where planned work is specified

This document states what AutoDE does and why; requirements marked *Planned* or *Partial* are completed by phases specified in two companion documents. They hold the detail — design contracts, acceptance criteria, rejected alternatives — and are not repeated here. Each capability section below ends with a *Planned work* line pointing to them. When a phase ships, its WHAT/WHY moves into this document and its specification shrinks to a pointer ([README.md](README.md)).

| Capability area (this document) | Specified in | Phases (order: [roadmap.md](roadmap.md)) |
|---|---|---|
| Business problem and specification (BPS), Conversation (CHT) | [context-layer-requirements.md](context-layer-requirements.md) §5.2 extraction, §5.4 Context Inbox, §7.2 cited Q&A | C4b |
| Source and target context (STC), Context layer (CTX) | [context-layer-requirements.md](context-layer-requirements.md) §5 enrichment, §6 semantic model, §8 freshness and health | C4b, C5, C6; migration track M1–M3 (not yet written) |
| Context delivery and grounding (GRD) | [context-layer-requirements.md](context-layer-requirements.md) §7 packs, §10 grounding checks and metrics | C4b, C5, C6 |
| Data platforms and credentials (PLT) | [mcp-engine-requirements.md](mcp-engine-requirements.md) §7 extension as MCP client (secrets passed to the server it starts) | 5 |
| Planning and orchestration (ORC), Generation (GEN) | [mcp-engine-requirements.md](mcp-engine-requirements.md) §7 extension as MCP client, §9 Phase 6, §9.1 Phase GOV; [context-layer-requirements.md](context-layer-requirements.md) §6 semantic model | 5, 6, GOV, C5 |
| Tool skills (SKL) | [mcp-engine-requirements.md](mcp-engine-requirements.md) §9.1 Phase S3, §9 Phase 6 | S3, 6 |
| Interoperability with other agents (MCP) | [mcp-engine-requirements.md](mcp-engine-requirements.md) §7 extension as client; [context-layer-requirements.md](context-layer-requirements.md) §9 context-layer tools | 5, C4b, C5 |
| Governance and security (SEC) | [mcp-engine-requirements.md](mcp-engine-requirements.md) §9.1 Phase GOV | GOV |
| Non-functional (NFR) | [context-layer-requirements.md](context-layer-requirements.md) §10.2 metrics, §11 Phase C6 release evaluation | C6 |

Workspace (WS), LLM providers (LLM) and user experience (UI) have no open specification; their open items are in the roadmap's backlog.

## 2. Principles

Product-wide; every capability and phase preserves them. The forward specs refer to these by ID.

### 2.1 Workflow and execution

| ID | Principle | Why |
|---|---|---|
| **P1** | The LLM selects and parameterises; it does not freehand code where a vetted primitive exists. Its output is schema-validated. | Deterministic, reviewable output; the LLM's creative surface is bounded. |
| **P2** | The primitive and skill catalog is governed at design time (publish, deprecate, version). Nothing is created at runtime by an LLM. | What runs in production was reviewed by a person. |
| **P3** | Human approval gates are enforced by the orchestrator, not only by the UI. | No entry point can skip a gate. |
| **P4** | LLM-agnostic: Copilot, Claude Code and the API providers all keep working; no capability depends on one provider. | Customers choose (or are restricted to) their provider. |
| **P5** | Credentials are pointers, never secrets in LLM context, logs or tool output. | Customer credentials never leave their control. |
| **P6** | Small footprint, works offline and on locked-down client networks: no automatic downloads, no native modules or heavy SDKs in the package. Drivers and client tools are installed by the user, with the user's own package manager, through a step AutoDE shows and runs only on request (phase DRV1); AutoDE itself never downloads or bundles them. Any new dependency needs a recorded decision covering licence and size. | Client networks and security reviews. |
| **P7** | Platform CLIs are optional accelerators, never prerequisites; a CLI-free path always exists. | Not every machine has, or may install, a CLI. |

### 2.2 Context and grounding

| ID | Principle | Why |
|---|---|---|
| **C1** | **Assertions, not blobs.** The unit of context is an assertion: one claim about one subject, with provenance, trust, status and validity. The graph and the semantic model are projections of them. | Every fact can be traced, trusted to a known degree and replaced. |
| **C2** | **Nothing is silently overwritten.** Changes supersede; contradictions are surfaced; history is kept. | Auditability; no lost decisions. |
| **C3** | **Agents do not infer what the context layer defines.** Joins, grain, keys, metric formulas and business rules come from confirmed or verified facts; when one is missing the agent asks. | Invented joins and keys are the costliest errors in data engineering. |
| **C4** | **Trust is explicit and ordered:** verified (checked against live data or metadata) > confirmed (a person approved it) > documented (from a file or document) > inferred (proposed by an LLM). Generation records the tier it relied on. | Reviewers know what to double-check. |
| **C5** | **Deliver less, but the right context.** Each LLM call receives task-scoped, budgeted context, and what it received is recorded. | Irrelevant context degrades output; recorded context makes it explainable. |
| **C6** | **Every artifact is explainable,** linked to the exact facts, specification revision, primitives and context it was built from. | Review, audit and impact analysis. |
| **C7** | **Grounding is measured, not claimed,** on a reference problem, for every release. | Improvement must be shown, not asserted. |
| **C8** | **Deterministic core, LLM at the edges.** Storage, retrieval, conflict detection, verification and grounding checks are deterministic; only proposing facts from natural language uses an LLM. | Reproducibility; the LLM is never the source of truth. |
| **C9** | **Sources are referenced, never copied.** AutoDE keeps derived understanding and pointers; customer documents and data stay where they are. Human-owned knowledge is kept apart from machine-derived knowledge. | Customer data governance; derived knowledge can always be rebuilt. |

---

## 3. Capabilities

### 3.1 Workspace and business problems (WS)

- **WS-1 — Works inside the engineer's repository.** AutoDE operates on the open folder; its state, specifications and artifacts live in the repository, visible and committable, except local-only transcripts and caches. *Why:* the repository is the deliverable and git is the history. *Status:* Shipped v0.9.0. Since v0.36.0 AutoDE's working state sits in one folder grouped by lifecycle — per-problem work, shared knowledge, team customisations — with per-engineer state and caches in a part AutoDE keeps out of git in any repository (before, transcripts and caches were committed in customer repositories unless someone added ignore rules); generated deliverables go to a visible folder of their own; existing workspaces are moved over automatically, nothing rewritten.
- **WS-2 — Several business problems per workspace, one active.** Starting or switching a problem gives a genuinely clean slate: nothing from another problem leaks into its specification, context, plan or prompts. *Why:* one repository often hosts several workstreams. *Status:* Shipped v0.12.0.
- **WS-3 — Problems can be renamed and deleted from the UI.** *Status:* Not met.
- **WS-4 — Edits from outside AutoDE are respected.** When another process (an editor, a coding agent, git) changes a file AutoDE holds, AutoDE reloads it; it never saves a stale copy over a newer one, and asks the user when both changed. *Why:* AutoDE shares the repository with other tools and agents. *Status:* Shipped v0.25.0.

### 3.2 Business problem and specification (BPS)

- **BPS-1 — A business problem can be a sentence, a document, or a set of documents.** AutoDE builds the specification from whatever the customer has: text, attached files, and (planned) a registered pack of documents with roles and authority — a BRD, KPI definitions, a data contract (often in a house format), a mapping workbook, a data dictionary. *Why:* real engagements start from pre-work, not from a blank prompt. *Status:* Shipped v0.33.0 — text and single attachments (v0.9.0, structured extraction v0.14.0); a pack of documents per problem, each with a role, an authority (signed facts enter as confirmed, drafts as documented) and a version. Structured documents in a house format are read through an interpretation profile the LLM proposes once and the engineer confirms; it then reads every later version the same way, so a new version changes exactly the clauses that changed. Free text is read into proposed facts that cite the section they came from. Binary formats (Word, PDF) are not read yet.
- **BPS-2 — The specification is produced by a guided discovery interview.** The interview covers requirements, sources, data flows, transformations, quality and constraints; asks only about what is missing; and shows its progress (which areas are covered, how many turns remain). *Why:* a structured, reviewable specification instead of a one-shot draft. *Status:* Shipped v0.7.0 (progress shown v0.13.0).
- **BPS-3 — Gaps are closed by machines before people.** Facts discoverable from connected systems or checkable against data are discovered or validated before the interview asks; the interview asks about intent, decisions and unresolved conflicts. *Why:* shorter, sharper interviews; nobody is asked what the data can answer. *Status:* Shipped v0.33.0 — the interview is told what discovery established (declared and confirmed keys, grains, loaded structure), and a proposed question that discovery already answers is not asked (the reason is logged). Claims are checked by probes on demand (CTX-9).
- **BPS-4 — The specification captures** the problem statement, objectives, success criteria, scope in and out, constraints, assumptions to confirm, domain, stakeholders, key entities, business requirements, data flows, transformations, dependencies, acceptance criteria and a source catalog — each field with where it came from (a question, an attachment, an assumption). *Status:* Shipped v0.7.0.
- **BPS-5 — Approval is explicit and staged.** The business problem is confirmed, then the specification approved; an approved specification is never edited in place — a change starts a revision interview that produces the next version for review. *Why:* the specification is the system of record (P3). *Status:* Shipped v0.9.0 (business-problem confirmation v0.13.0).
- **BPS-6 — A revision never loses approved content.** Fields the change didn't touch carry forward, with their original provenance. *Status:* Partial — holds on the normal path; the error-path fallback can drop the comprehensive fields (roadmap, "Not yet scheduled").
- **BPS-7 — An interview survives a reload.** *Status:* Not met.
- **BPS-8 — Specification history is the git history,** viewable from the UI. *Status:* Shipped v0.9.0.
- **BPS-9 — Greenfield or brownfield is classified automatically and can be overridden;** the override survives revisions. It decides whether source context is required and whether discovery is in scope. *Status:* Shipped v0.10.0.
- **BPS-10 — The specification states intent and scope; detailed clauses stay with their source documents** and are referenced, not copied. *Why:* a specification that copies a contract drifts from it. *Status:* Partial v0.33.0 — a specification drafted while the problem has a pack records the ids of the contract clauses it rests on and is drafted with them in view; the specification's own fields are not yet restructured around references.

*Planned work:* interview and chat answers extracted into the ledger, the Context Inbox, an interview that survives a reload — [context-layer-requirements.md](context-layer-requirements.md) §5.2, §5.4 (C4b).

### 3.3 Source and target context (STC)

- **STC-1 — Target context is required and approved before planning:** platform, modelling approach, transformation and orchestration tools, naming, environment, location. Each answer is confirmed by the user; defaults are suggestions. It is the only source of the plan's target environment. *Status:* Shipped v0.11.0.
- **STC-2 — Source context is required for brownfield work and marked not applicable for greenfield.** Sources can be connected live or described (for data that is pushed, or when no connectivity exists); a problem can have several sources. *Status:* Shipped v0.11.0 (several sources v0.19.0).
- **STC-3 — Planning is blocked until context is ready,** with a clear statement of what is missing (P3). *Status:* Shipped v0.11.0.
- **STC-4 — Source, target and mapping context are versioned;** revising an approved one creates a new version and keeps the old. *Status:* Shipped v0.20.0.
- **STC-5 — Source and target can be connected at the same time,** with independent settings. *Status:* Shipped v0.20.0.
- **STC-6 — The user chooses which databases and schemas matter;** AutoDE does not assume the whole account is relevant. *Status:* Shipped v0.21.0; several schemas per connection v0.31.0.
- **STC-7 — Context can be built from files when there is no connectivity:** CSV, JSON and DDL, parsed structurally (a fact about the file, not a guess), keeping each table's own schema. *Status:* Shipped v0.22.0 (schemas kept v0.29.0, comments ignored v0.30.0, legacy column-dictionary exports v0.31.0, table and column comments read as descriptions v0.32.0).
- **STC-8 — Source-to-target mappings are a reviewed, versioned object;** editing an approved mapping set requires re-review. *Status:* Shipped v0.23.0. Rule-based bulk mapping Planned (M2).
- **STC-9 — Live-verified and file-derived facts are never blended silently;** the difference is shown to the user and to the model. An explicit re-verify reports what appeared and disappeared without deleting anything on its own. *Status:* Shipped v0.24.0.
- **STC-10 — An estate is modelled as systems, environments and locations.** Several source systems and a target coexist; identically named tables in different systems stay distinct; roles (source, target, both) belong to a system or schema, so in-place modernisation and dev/test/prod are expressible. The estate is recorded in the repository and editable; a connection or imported file not yet assigned gets a system named after it. *Why:* estate merge and migration. *Status:* Shipped v0.31.0.

*Planned work:* semantic model — [context-layer-requirements.md](context-layer-requirements.md) §6 (C5); legacy migration assessment and mapping — migration track M1–M3 (to be specified).

### 3.4 Data platforms and credentials (PLT)

- **PLT-1 — Snowflake and Databricks can be connected, queried and introspected** (tables, columns, keys, views; optional profiling — sampled and within a per-run query budget since v0.32.0, so profiling a large schema cannot run unbounded against the customer's warehouse). Since v0.38.0 also **Oracle Database 12.1+ as a source** (through a tnsnames alias or Easy Connect; tables, views, columns, comments, primary and foreign keys, sampled profiling), once its driver is installed (PLT-7). Other platforms are listed but not yet connectable. *Status:* Shipped v0.17.0; Oracle v0.38.0.
- **PLT-2 — Connectivity works on restricted networks without heavy SDKs** (P6, P7): a native-protocol path through the platform CLI where present and consented, and a CLI-free path always. *Status:* Shipped v0.17.0.
- **PLT-3 — Both interactive users and service accounts can authenticate,** through credential references resolved at use (environment, CLI configuration, the OS secret store, or a pluggable enterprise secrets manager). Secrets are never written to settings or the repository (P5). *Status:* Shipped v0.15.0 / v0.16.0.
- **PLT-4 — Every auth mode offered in the UI works end to end,** and a missing consent is fixed in place rather than by editing settings by hand. *Status:* Shipped v0.17.0.
- **PLT-5 — The assistant knows what is connected,** and the UI shows it. *Status:* Shipped v0.18.0.
- **PLT-6 — Legacy sources without a live connector can still be described:** dictionary exports (Teradata, Oracle, INFORMATION_SCHEMA) and DDL. *Status:* Shipped v0.31.0.
- **PLT-7 — A user can add a driver for a platform the CLI-free path doesn't cover,** guided by AutoDE: what is missing, why, the exact install step (run only on request), and a verification before first use. *Why:* legacy sources need drivers AutoDE must not ship (P6), and engineers on client machines need to know exactly what to install and why. *Status:* Shipped v0.38.0 / v0.39.0. AutoDE lists each platform's prerequisites with their state. For the Oracle driver it explains the install (what, where, size, licence, why) and runs it with the user's own npm and registry settings, but only on request, in a visible terminal. It then verifies the result and refuses to load a driver that is unverified or has changed since. Nothing is installed or loaded at activation or by connecting. Since v0.39.0 each platform card in the settings panel shows this per platform, with the backend it will use and that backend's limits.
- **PLT-8 — A connection is set up once, checked before it counts, and shared without leaking what is personal or secret.** From a platform card, a user saves a named connection (Snowflake, Databricks, or Oracle as a source), starting from fields or from what the platform's own tools already know (a Snowflake CLI connection, a Databricks profile, a tnsnames alias). It is saved only after a connectivity check passes. What the team shares goes to the committed connections file; what differs per engineer (username, key and wallet paths) stays in a personal, uncommitted file; secrets go to the OS-backed secret store. A workspace can hold several connections per platform and role, and the user chooses which one Connect uses. Each connection shows whether it is ready in AutoDE and, separately, what other agents' clients still need to use it. Readiness is per machine and lapses when the connection's definition changes. *Why:* estate merges and migrations need several sources at once; a connection that worked once on someone else's laptop says nothing about this one; and a committed file must not carry one engineer's username or anyone's password (P5). *Status:* Shipped v0.39.0. Oracle as a target is not offered (it would mean generating Oracle SQL; roadmap backlog).

*Planned work:* secrets kept in VS Code's secret store reach an MCP server only when the extension starts it — [mcp-engine-requirements.md](mcp-engine-requirements.md) §7 (phase 5); Oracle as a target — roadmap backlog.

### 3.5 Context layer (CTX)

- **CTX-1 — AutoDE keeps a persistent knowledge layer per repository** built from discovery, files, business-context documents, specifications and (planned) conversations. *Why:* grounding needs memory beyond a chat. *Status:* Partial — conversations Planned (C4b).
- **CTX-2 — Every fact is an assertion with provenance, trust, status and validity, in an append-only record** (C1, C2, C4). Changes supersede, removals are recorded with a reason, and facts depending on a changed or removed object go to review. *Status:* Shipped v0.29.0.
- **CTX-3 — Contradictions are detected and surfaced, not merged:** two definitions of one business term, two values for one fact, a claimed key that differs from the declared one. *Status:* Shipped v0.29.0. Data-contract conformance shipped v0.33.0: each source system is checked against a contract clause by clause (columns present, type family, nullability from the catalog; blanks, uniqueness and accepted values from probes) in a conformance report. A contract never overwrites what was observed.
- **CTX-4 — Facts from one business problem's specification apply only while that problem is active;** facts about systems are shared. *Status:* Shipped v0.29.0.
- **CTX-5 — Business context is registered from repository files** — glossary terms, rules (STRICT or recommended), verified queries — and edits to them take effect. *Status:* Shipped v0.8.0; since v0.36.0 edits take effect without a reload.
- **CTX-6 — Context documents are schema-validated;** old data that fails a newer check still loads, with a warning. *Status:* Shipped v0.29.0.
- **CTX-7 — The record can be compacted;** history is deleted only on an explicit request. *Status:* Shipped v0.29.0.
- **CTX-8 — The context layer is visible in the UI,** read-only: layers, terms, rules, queries, relationships, conflicts. *Status:* Partial — tables, business terms, verified queries and registered sources are shown; rules, relationships, conflicts and trust are not.
- **CTX-9 — Claims are verified against data where possible** (uniqueness, nullability, accepted values, join orphan rates, freshness), returning aggregates only. *Status:* Shipped v0.33.0 — fixed read-only templates per platform, sampled; run on a live connection, or over sample files the customer supplied when there is none. A pass raises the claim to verified; a failure sends it to review with the observed counts. On demand (a command); automatic probing of new claims is not yet on.
- **CTX-10 — The engineer confirms, edits or rejects proposed facts in one place** (Context Inbox). *Status:* Planned (C4b).
- **CTX-11 — A semantic model** (entities, keys, grain, relationships, measures, metrics) is derived from confirmed facts and exportable to the target's semantic formats. *Status:* Planned (C5).
- **CTX-12 — Freshness and health are tracked;** stale facts are labelled, and a health view summarises the layer. *Status:* Planned (C6).

*Planned work:* chat and interview extraction, Context Inbox — [context-layer-requirements.md](context-layer-requirements.md) §5.2, §5.4 (C4b); semantic model — §6 (C5); freshness policy and context health — §8.2, §8.4 (C6).

### 3.6 Context delivery and grounding (GRD)

- **GRD-1 — Each LLM call receives context selected for its task** (C5): what the task names, related objects, STRICT rules, conflicts and items under review that touch them; unrelated schemas are left out. With nothing to scope by, it receives the project overview. *Status:* Shipped v0.30.0.
- **GRD-2 — A context budget is never exceeded,** whichever provider is used: a conservative estimate everywhere, an exact count where the provider offers one. Pruning never cuts a block in half and never drops a STRICT rule. *Status:* Partial — the estimate and pruning rules are met; exact provider counts are not used.
- **GRD-3 — Missing facts become questions, not guesses** (C3): a request to combine entities with no confirmed relationship raises a context gap. *Status:* Partial — detected and reported since v0.30.0; steps pause on a gap from C4b.
- **GRD-4 — Every generated artifact records what it was built from** (C6): specification revision, plan step, agent, model, primitive, the context it received, and which fact justified each design decision — or that none did. *Status:* Shipped v0.30.0.
- **GRD-5 — Generated code is checked:** identifiers resolve to known objects, joins and casts use compatible types, STRICT rules are checked where they have a machine-checkable form (PII masking) and listed for review otherwise; each run produces a grounding report. *Status:* Shipped v0.30.0.
- **GRD-6 — An artifact is reported stale when its specification version changed or a fact it relied on changed,** with the reason. *Status:* Shipped v0.9.0 (specification version), v0.30.0 (facts).
- **GRD-7 — The engineer can see exactly what any recent LLM call received, and why any artifact looks the way it does.** *Status:* Shipped v0.30.0.
- **GRD-8 — Retrieval finds the right objects when the request's vocabulary differs from physical names** — synonyms, abbreviations, another organisation's terms. Deterministic signals first; embeddings only as an optional signal if measurement shows they're needed. *Why:* merges and legacy estates. *Status:* Shipped v0.32.0 — abbreviations, synonyms, the customer's own vocabulary, table and column comments and glossary terms; on the reference question set 17 of 21 found, against 3 of 21 from names alone. Free paraphrases ("money customers got back") are not covered; embeddings (RET) are not scheduled, see the roadmap's decision log. Since v0.33.0 the customer's vocabulary can be captured from their documents: abbreviations are mined from names and the comments that spell them out, the LLM proposes further entries from the pack, and the engineer accepts each one. With vocabulary captured from the reference customer's glossary, 19 of 21 are found and 2 of the 4 paraphrases; the two still missed share no word with the table they mean, or rank a sibling table first.
- **GRD-9 — Grounding and accuracy are measured on a reference problem for every release** (C7), with frozen baselines so every change shows its effect; the results become a release gate. *Status:* Shipped v0.27.0 (release gate Planned C6).

*Planned work:* cited Q&A — [context-layer-requirements.md](context-layer-requirements.md) §7.2 (C4b); decision backing against the semantic model — §10.1 (C5); release metrics and ablation — §10.2, §11 Phase C6.

### 3.7 Planning and orchestration (ORC)

- **ORC-1 — The required workflow phases (discover, model, build, validate) are inferred from the approved specification,** explained, shown live, and can be overridden; an override survives re-planning. *Status:* Shipped v0.6.0 (overrides v0.10.0).
- **ORC-2 — The plan is generated from the approved specification, within the inferred phases,** and rejected if structurally invalid (unknown agents, duplicates, missing or circular dependencies, steps outside the required phases). *Status:* Shipped v0.10.0.
- **ORC-3 — The lifecycle's gates are enforced by the orchestrator** (P3): business problem confirmed → specification approved → context ready → plan approved → stages confirmed → artifacts. Anything that invalidates an approval resets it. *Status:* Shipped v0.13.0.
- **ORC-4 — Plans are persisted and versioned,** and survive a reload. *Status:* Shipped v0.10.0.
- **ORC-5 — A failed step doesn't stop independent steps;** only steps that depend on it are blocked. *Status:* Shipped v0.10.0.
- **ORC-6 — A specification change during execution pauses the run after the current step.** *Status:* Shipped v0.25.0.
- **ORC-7 — Long-running actions show progress, and completion is confirmed** with the next actions offered. *Status:* Shipped v0.9.0 / v0.10.0.

*Planned work:* context gaps pause a step once the Context Inbox exists — [context-layer-requirements.md](context-layer-requirements.md) §11 Phase C4b; the extension reaches the engine through MCP — [mcp-engine-requirements.md](mcp-engine-requirements.md) §7 (phase 5).

### 3.8 Generation (GEN)

- **GEN-1 — Agents produce artifacts for each phase** — source assessment, data model, source-to-target mapping, ingestion, transformation project, architecture and data dictionary — grounded in the specification, context and target environment, with deterministic templates as the last resort when no LLM is available. *Status:* Shipped v0.11.0.
- **GEN-2 — Where a vetted primitive fits, the LLM only selects and parameterises it** (P1). *Status:* Shipped v0.14.0.
- **GEN-3 — The primitive catalog can grow without code changes,** through declarative definitions that cannot execute code; primitives have a lifecycle (draft, published, deprecated, retired), management is opt-in, and an approved specification pins the primitive versions it used (P2). *Status:* Shipped v0.14.0.
- **GEN-4 — A Pipeline Specification can be generated:** a strictly validated, deterministically compiled, per-entity contract, with a design document derived from it so the two can't drift. *Status:* Shipped v0.14.0.
- **GEN-5 — Artifacts are written to a visible folder per business problem, phase and specification version;** earlier revisions are kept; artifacts are committed as deliverables. *Status:* Shipped v0.9.0 / v0.12.0.
- **GEN-6 — Migration programmes are supported at scale:** assessment and wave planning, rule-based mapping and generation across many objects, importing external code-converter output, and reconciliation proving the target matches the source. *Status:* Planned (M1–M3).
- **GEN-7 — Further generators:** DDL, orchestration (Airflow, Dagster, Prefect) and tests as dedicated agents. *Status:* Not met (DDL likely covered by M2).

*Planned work:* per-dialect primitives, conformance suite, dry-run before execute, idempotent DDL — [mcp-engine-requirements.md](mcp-engine-requirements.md) §9 Phase 6; governance-as-code (masking, classifications) — §9.1 Phase GOV; semantic-model exports — [context-layer-requirements.md](context-layer-requirements.md) §6 (C5).

### 3.9 Conversation (CHT)

- **CHT-1 — Chat follows the specification's state:** with no specification, the first message starts the discovery interview; with a draft, messages refine it; with an approved specification, questions are answered grounded in it and the context; a requested change starts a revision interview. *Status:* Shipped v0.9.0.
- **CHT-2 — Conversations are persisted locally,** not committed. A new chat archives the previous one (never discards it); history can be reopened and resumed; deleting a conversation is explicit and confirmed; a restart opens an empty chat. *Status:* Shipped v0.9.0 / v0.13.0.
- **CHT-3 — An abandoned interview is never lost:** its partial answers are folded into the context layer. *Status:* Shipped v0.9.0.
- **CHT-4 — The assistant is read-only by default;** write and command access is granted per chat, explicitly. *Status:* Shipped.
- **CHT-5 — Facts stated in chat are captured as proposed facts, and answers cite the facts they rest on.** *Status:* Planned (C4b).
- **CHT-6 — Chat history can be searched, tagged and exported.** *Status:* Not met.

*Planned work:* chat extraction into the ledger and tool-action memory — [context-layer-requirements.md](context-layer-requirements.md) §11 Phase C4b.

### 3.10 LLM providers (LLM)

- **LLM-1 — The user chooses among Copilot, Claude Code, OpenAI, Azure OpenAI, Anthropic, Gemini and Ollama** (P4); Copilot and Claude Code need no API key. *Status:* Shipped v0.9.0.
- **LLM-2 — Programmatic use of a model is opt-in,** with a one-time consent dialog explaining what is sent. *Status:* Partial — opt-in setting shipped; the dialog is not built.
- **LLM-3 — Claude Code is used with the least tool access the task needs:** none for structured calls, read-only for grounded chat, and only what a tool skill declared for skills. A missing CLI produces actionable guidance, never a silent fallback. *Status:* Shipped v0.9.0 (skill allow-list v0.28.0).
- **LLM-4 — Without consent, Copilot users can hand the prompt to Copilot themselves.** *Status:* Shipped v0.9.0.

### 3.11 Tool skills (SKL)

- **SKL-1 — Engineers can import agent skills** in the `SKILL.md` folder format. *Status:* Shipped v0.9.0.
- **SKL-2 — A skill runs on any provider, gets only the tools it declared, and every tool call is audited** where AutoDE runs the tool loop; where it can't (Claude Code), the run is approved as a whole and says so. *Status:* Shipped v0.28.0.
- **SKL-3 — Skills run only when explicitly invoked;** the planner never schedules them. *Status:* Shipped v0.9.0.
- **SKL-4 — Skills are confined to the workspace,** and writes or commands are approved per call where AutoDE runs the loop. *Status:* Shipped v0.9.0.
- **SKL-5 — Skills are reviewed and trusted before they gain capabilities,** with provenance; imports from Git with updates shown as diffs; a starter library and authoring guidance. *Why:* a skill's instructions and scripts act in the customer's workspace; what runs must have been read by a person (P2). *Status:* Partial v0.34.0 — every imported skill records where it came from and a checksum of its content, and does not run until an engineer has read it on a review page and chosen a tier: *reviewed* (read-only tools at most, never through Claude Code) or *trusted* (writes and commands, each approved, and Claude Code). Trust belongs to the content that was read: a skill whose files change afterwards (a pull, an edit) is unreviewed again. Skills present before v0.34.0 stay trusted. With lifecycle management switched on, skills are published as numbered versions, deprecated or retired, and a plan step can pin a version that keeps running after deprecation. Every transition is recorded with who and when. Git imports with diffs, the starter library and authoring guidance are S3.

*Planned work:* Git-URL import with update diffs, starter library, authoring guidance — [mcp-engine-requirements.md](mcp-engine-requirements.md) §9.1 Phase S3.

### 3.12 Interoperability with other agents (MCP)

- **MCP-1 — AutoDE's deterministic core — primitives, specifications, context, grounding checks, platform access — is usable by other coding agents** (Claude Code, Copilot agent mode, Cursor) through the Model Context Protocol, and the extension uses the same interface. *Why:* engineers also work in those agents; they should get AutoDE's grounding instead of freehand SQL. *Status:* Partial v0.35.0 — the server ships inside the extension and runs on plain Node: transform primitives (search, describe, validate, compile), Pipeline Spec validation, compilation and design document, AutoDE's interview prompts and reviewed tool skills as prompts, the active problem's specifications and context documents as resources, and the read-only context tools (resolve text to estate objects, context packs, the assertion ledger, SQL grounding checks). Since v0.37.0 it also reaches the data platforms: list connections, test one, browse databases and schemas, extract a schema's metadata, dry-run SQL with EXPLAIN and run queries. Connections are configured in the workspace without secrets, which come from the environment or the platform CLI's own configuration, so a server started by another agent never needs VS Code's secret store. Queries are read-only unless the server is explicitly started to allow writes, and then the client is told the tool is destructive. Nothing the server offers writes to the workspace or calls an LLM, and every response is scrubbed of secrets. Setup for Claude Code, VS Code and Cursor is documented. Still planned: the extension using the server itself and registering it with other agents (5).

*Planned work:* the extension as a client and registration with other agents — §7 (phase 5); proposing and verifying assertions, semantic-model resources — [context-layer-requirements.md](context-layer-requirements.md) §9 (C4b, C5).

### 3.13 Governance and security (SEC)

- **SEC-1 — Nothing is sent to a third-party model without consent;** no secret is logged or committed (P5). *Status:* Shipped.
- **SEC-2 — Privacy and data flow are explained** in the README and the consent dialog. *Status:* Not met.
- **SEC-3 — Telemetry, if any, is opt-in and free of personal data.** *Status:* Not met (the setting exists; nothing reports).
- **SEC-4 — Data sensitivity and masking are governed as code:** classifications in specifications, a masking primitive, a governance interview. *Status:* Planned (GOV).
- **SEC-5 — Probes and samples never expose row values without consent;** verification uses aggregates. *Why:* customer data must not reach a model provider because an agent asked a question; schema and counts are enough for most engineering work. *Status:* Shipped v0.37.0 — probes return counts and rates only, also over sample files (v0.33.0). Consent is per connection and off by default; it is recorded in the workspace's committed configuration, so it is a visible, reviewable decision of the engagement rather than one engineer's setting. Without it, query results reach an agent as columns and a row count only, and extracted metadata keeps structure and counts but no minimum or maximum values and no query text from the platform's history; CSV ingestion keeps types, never values. With it, values in columns whose names suggest personal data, and e-mail addresses and card numbers anywhere, are masked. Names are a heuristic: classification as code comes with GOV (SEC-4).

*Planned work:* governance-as-code, including column classification that replaces the name heuristic — [mcp-engine-requirements.md](mcp-engine-requirements.md) §9.1 Phase GOV.

### 3.14 User experience (UI)

- **UI-1 — One chat-first sidebar** carries the workflow, with a Workflow Palette for the specification, context, phases, artifacts and primitives, and a settings panel with LLM, Source, Target and Preferences tabs. *Status:* Shipped.
- **UI-2 — The look follows VS Code:** theme colours and fonts, minimal frames, pill-style status indicators, empty states for anything not configured. *Status:* Shipped.
- **UI-3 — Every request shows one evolving progress indicator,** and sending is disabled while one is running. *Status:* Shipped v0.9.0.
- **UI-4 — Controls are usable by keyboard and screen readers.** *Status:* Partial (not verified).
- **UI-5 — A short style guide documents colour tokens and component rules.** *Status:* Not met.
- **UI-6 — Dashboard panel.** *Status:* Parked (v0.13.0); its quick actions go through the gated commands.

---

## 4. Non-functional requirements (NFR)

- **NFR-1 — AutoDE never blocks the extension host for long:** no single synchronous task longer than 100 ms at large-estate size; long work yields, reports progress and can be cancelled. *Why:* a blocked extension host freezes AutoDE's panel and every other extension, Copilot included (the editor itself runs in another process). *Status:* Measured v0.32.0 on the large-estate fixture (about 2 000 tables, 50 000 columns): the longest synchronous task during import, ledger sync, projection, reload and pack building is under 50 ms; catalog indexing yields as it goes. Partial: imports do not yet report progress or offer cancellation.
- **NFR-2 — Writes are atomic;** a crash never leaves a corrupt specification, context file or artifact. *Status:* Shipped.
- **NFR-3 — Corrupt or partial files are tolerated:** logged, skipped or repaired when safe, never fatal. *Status:* Shipped.
- **NFR-4 — Deactivation releases watchers, processes and handles promptly** (target: 200 ms). *Status:* Shipped v0.14.0 (timing not measured).
- **NFR-5 — Footprint and dependencies** follow P6. *Status:* Shipped (runtime dependencies: `ajv`, `yaml`, and since v0.35.0 the MCP SDK; all bundled, so the package ships no third-party folders). The packaged extension is 480 KB, including the MCP server, and ships the licences of every bundled library. AutoDE itself is MIT-licensed: free for any use, including commercial.
- **NFR-6 — Works without a live connection** from cached and imported metadata, and says what it cannot see. *Status:* Shipped v0.32.0 — file ingestion and dictionary exports (v0.22.0, v0.31.0); a local catalog of what was imported or extracted; objects whose structure isn't loaded are reported as context gaps, and objects hidden by the user's grants are reported as not visible. With a connection, missing or outdated structure is loaded when a task needs it.
- **NFR-7 — Reproducible:** the same inputs give the same context, projections and checks; artifacts pin the revisions they used. *Status:* Shipped v0.29.0 / v0.30.0 (catalog revisions pinned in manifests v0.31.0).
- **NFR-8 — Scale:** a business problem's working set (about 200 tables, 5 000 columns, 1 000 facts) stays responsive in memory; larger estates are handled by K's catalogs and cache, with any storage change decided from measurements. *Status:* Shipped v0.32.0 — the working set is held in memory; the estate around it lives in per-system catalogs, and objects enter the working set when a task uses them and leave it when unused. Measured at about 2 000 tables and 50 000 columns; no database is needed at that size (decision in the roadmap).
- **NFR-9 — Every behaviour change is covered by automated tests,** and every release is evaluated on the reference problem. *Status:* Shipped (241 tests and eval at v0.30.0).

*Planned work:* release evaluation across providers — [context-layer-requirements.md](context-layer-requirements.md) §10.2, §11 Phase C6.

---

## Appendix A — Where the previous sections went (2026-10-15)

The previous document (commit `fc16b0d`) mixed requirements with implementation detail and per-version narratives. Every section is accounted for below. "→ design" means the HOW content now lives in [technical-design.md](technical-design.md) (moved and brought up to date on 2026-10-15); "→ history" means it is release history, already in [CHANGELOG.md](../CHANGELOG.md).

| Previous section | Now |
|---|---|
| §1 Overview & goals | §1; WS-1; LLM-1; NFR-1 (restated), NFR-2 |
| §2 UI & UX | UI-1 – UI-5 (tab names updated); UI-3 (processing feedback); CHT-2 |
| §3.1 Design principles | C9; CTX-6; envelope/file detail → design |
| §3.2 Storage decision, §3.11 Scalability | NFR-8; GRD-8; Kùzu and vector store superseded (roadmap §3) |
| §3.3 – §3.5, §4 Layer taxonomy, envelope, relationship model, types | → design (data model); intent in C1, C4, CTX-2 |
| §3.6 ID scheme | Superseded by STC-10 / Phase K (namespaced ids for every kind) |
| §3.7 – §3.8 File hierarchy, ownership | WS-1, C9; layout → design |
| §3.9 Traceability | C1, C6, GRD-4 |
| §3.10 Operational constraints | NFR-1 (restated), NFR-2, NFR-3, NFR-4; GRD-2 (token counting restated) |
| §5 Core modules | → design; ContextRetriever met by GRD-1; vector engine superseded (roadmap §3) |
| §6 Prompt assembly formatter | GRD-1, GRD-2; format → design |
| §7 Workspace artifact model | WS-1, WS-2, GEN-5, GRD-6; "one workspace = one effort" superseded by WS-2 |
| §8 – §8.5, §8.7 Business Problem Specification | BPS-4, BPS-5, BPS-8, CHT-1, ORC-2; persistence → design |
| §8.6, §8.6.1 SpecOps, revision | BPS-2, BPS-5, BPS-6, BPS-7, BPS-1 (attachments) |
| §8.8 Context sync, implementation type, plan governance | BPS-9, CTX-4, ORC-2, ORC-4, GEN-5 |
| §8.9 Plan completion, stage review, resilient generation | ORC-1, ORC-5, ORC-7; bug narratives → history |
| §8.10 Source & target context | STC-1 – STC-3, GEN-1 |
| §8.11 Multi-problem workspace | WS-2, WS-3 |
| §8.12 Lifecycle orchestration | ORC-3, BPS-5, UI-6 |
| §8.13 Discovery progress | BPS-2 |
| §8a Chat sessions | CHT-2, CHT-3, CHT-6; session store → design |
| §9 Local language models | LLM-1 – LLM-4, SEC-1; adapter and CLI detail → design |
| §9a Tool-executing skills | SKL-1 – SKL-4 (updated for v0.28.0); execution detail → design |
| §10 Acceptance criteria & tests | Folded into the requirements they verify (NFR-1, NFR-2, NFR-4, GRD-2, LLM-2, ORC-2, ORC-4, BPS-9); test inventory → design |
| §11 Implementation plan & phasing | → history; current plan in roadmap |
| §12 Security, privacy & licensing | SEC-1 – SEC-3; P6 (licence rule) |
| §13 Dependencies & packaging | P6, NFR-5; js-tiktoken, Kùzu, embedding runtimes superseded (roadmap §3) |
| §14 Files & artifacts | → design |
| §15 Acceptance & review checklist | Triaged into roadmap §2; met items covered by the requirements above |
| §16 Pending tasks backlog | Triaged into roadmap §2 |
| §17.1 – §17.5 Deterministic core, Pipeline Spec, attachments, primitive lifecycle | GEN-2 – GEN-4, BPS-1, P1, P2; detail → design |
| §17.6 – §17.7 Credentials, real execution | PLT-1 – PLT-4, PLT-7, PLT-8, P5 – P7; detail → design; live-test narratives → history |
| §17.8 Runtime context unification | PLT-5 |
| §17.9 – §17.14 Source & target context architecture | STC-2, STC-4 – STC-9, PLT-6; detail → design |
| §18 Contact & notes | README.md (how to change documents); P6 (packaging trade-offs) |
| §19 MCP engine (shipped summaries) | WS-4, ORC-6, MCP-1, SKL-2 |
| §20 Context layer (shipped summaries) | CTX-2 – CTX-7, GRD-1 – GRD-7, GRD-9, STC-7 |

## Appendix B — Glossary

| Term | Meaning |
|---|---|
| Business problem | What the customer wants solved: a sentence, a document or a set of documents. |
| Business Problem Specification (BPS) | The structured, reviewed, versioned statement of the business problem; the system of record. |
| Pipeline Specification | A strictly validated, compilable per-entity contract derived from an approved BPS. |
| Source / Target / Mapping context | Reviewed records of where data comes from, where it goes, and how one maps to the other. |
| Assertion | One claim about one subject, with provenance, trust, status and validity. |
| Trust tier | verified > confirmed > documented > inferred (C4). |
| Context pack | The task-scoped context one LLM call receives, with a record of what it contained. |
| Context gap | A fact a task needs that the context layer lacks at the required trust; raised as a question. |
| Grounding manifest | The record of what an artifact was built from (`<file>.grounding.json`). |
| Primitive | A vetted, parameterised, deterministic transformation the LLM selects instead of writing code. |
| Tool skill | An imported `SKILL.md` skill that runs with a declared, enforced set of tools. |
| System / environment / location | Estate identity (Phase K): a logical source or target, its dev/test/prod variants, and where its objects physically live. |
