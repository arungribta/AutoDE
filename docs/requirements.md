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
| **P6** | Small footprint, works offline and on locked-down client networks: no automatic downloads, no native modules or heavy SDKs in the package. The one sanctioned download is the user-initiated, integrity-checked driver acquisition (phase DRV). Any new dependency needs a recorded decision covering licence and size. | Client networks and security reviews. |
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

- **WS-1 — Works inside the engineer's repository.** AutoDE operates on the open folder; its state, specifications and artifacts live in the repository, visible and committable, except local-only transcripts and caches. *Why:* the repository is the deliverable and git is the history. *Status:* Shipped v0.9.0.
- **WS-2 — Several business problems per workspace, one active.** Starting or switching a problem gives a genuinely clean slate: nothing from another problem leaks into its specification, context, plan or prompts. *Why:* one repository often hosts several workstreams. *Status:* Shipped v0.12.0.
- **WS-3 — Problems can be renamed and deleted from the UI.** *Status:* Not met.
- **WS-4 — Edits from outside AutoDE are respected.** When another process (an editor, a coding agent, git) changes a file AutoDE holds, AutoDE reloads it; it never saves a stale copy over a newer one, and asks the user when both changed. *Why:* AutoDE shares the repository with other tools and agents. *Status:* Shipped v0.25.0.

### 3.2 Business problem and specification (BPS)

- **BPS-1 — A business problem can be a sentence, a document, or a set of documents.** AutoDE builds the specification from whatever the customer has: text, attached files, and (planned) a registered pack of documents with roles and authority — a BRD, KPI definitions, a data contract (often in a house format), a mapping workbook, a data dictionary. *Why:* real engagements start from pre-work, not from a blank prompt. *Status:* Partial — text and single attachments shipped (v0.9.0, structured extraction v0.14.0); document packs Planned (C4a).
- **BPS-2 — The specification is produced by a guided discovery interview.** The interview covers requirements, sources, data flows, transformations, quality and constraints; asks only about what is missing; and shows its progress (which areas are covered, how many turns remain). *Why:* a structured, reviewable specification instead of a one-shot draft. *Status:* Shipped v0.7.0 (progress shown v0.13.0).
- **BPS-3 — Gaps are closed by machines before people.** Facts discoverable from connected systems or checkable against data are discovered or validated before the interview asks; the interview asks about intent, decisions and unresolved conflicts. *Why:* shorter, sharper interviews; nobody is asked what the data can answer. *Status:* Planned (C4a).
- **BPS-4 — The specification captures** the problem statement, objectives, success criteria, scope in and out, constraints, assumptions to confirm, domain, stakeholders, key entities, business requirements, data flows, transformations, dependencies, acceptance criteria and a source catalog — each field with where it came from (a question, an attachment, an assumption). *Status:* Shipped v0.7.0.
- **BPS-5 — Approval is explicit and staged.** The business problem is confirmed, then the specification approved; an approved specification is never edited in place — a change starts a revision interview that produces the next version for review. *Why:* the specification is the system of record (P3). *Status:* Shipped v0.9.0 (business-problem confirmation v0.13.0).
- **BPS-6 — A revision never loses approved content.** Fields the change didn't touch carry forward, with their original provenance. *Status:* Partial — holds on the normal path; the error-path fallback can drop the comprehensive fields (roadmap, "Not yet scheduled").
- **BPS-7 — An interview survives a reload.** *Status:* Not met.
- **BPS-8 — Specification history is the git history,** viewable from the UI. *Status:* Shipped v0.9.0.
- **BPS-9 — Greenfield or brownfield is classified automatically and can be overridden;** the override survives revisions. It decides whether source context is required and whether discovery is in scope. *Status:* Shipped v0.10.0.
- **BPS-10 — The specification states intent and scope; detailed clauses stay with their source documents** and are referenced, not copied. *Why:* a specification that copies a contract drifts from it. *Status:* Planned (C4a).

### 3.3 Source and target context (STC)

- **STC-1 — Target context is required and approved before planning:** platform, modelling approach, transformation and orchestration tools, naming, environment, location. Each answer is confirmed by the user; defaults are suggestions. It is the only source of the plan's target environment. *Status:* Shipped v0.11.0.
- **STC-2 — Source context is required for brownfield work and marked not applicable for greenfield.** Sources can be connected live or described (for data that is pushed, or when no connectivity exists); a problem can have several sources. *Status:* Shipped v0.11.0 (several sources v0.19.0).
- **STC-3 — Planning is blocked until context is ready,** with a clear statement of what is missing (P3). *Status:* Shipped v0.11.0.
- **STC-4 — Source, target and mapping context are versioned;** revising an approved one creates a new version and keeps the old. *Status:* Shipped v0.20.0.
- **STC-5 — Source and target can be connected at the same time,** with independent settings. *Status:* Shipped v0.20.0.
- **STC-6 — The user chooses which databases and schemas matter;** AutoDE does not assume the whole account is relevant. *Status:* Shipped v0.21.0 (one database and schema per connection; several schemas per connection Planned (K)).
- **STC-7 — Context can be built from files when there is no connectivity:** CSV, JSON and DDL, parsed structurally (a fact about the file, not a guess), keeping each table's own schema. *Status:* Shipped v0.22.0 (schemas kept v0.29.0, comments ignored v0.30.0). Legacy catalog exports Planned (K).
- **STC-8 — Source-to-target mappings are a reviewed, versioned object;** editing an approved mapping set requires re-review. *Status:* Shipped v0.23.0. Rule-based bulk mapping Planned (M2).
- **STC-9 — Live-verified and file-derived facts are never blended silently;** the difference is shown to the user and to the model. An explicit re-verify reports what appeared and disappeared without deleting anything on its own. *Status:* Shipped v0.24.0.
- **STC-10 — An estate is modelled as systems, environments and locations.** Several source systems and a target coexist; identically named tables in different systems stay distinct; roles (source, target, both) belong to a system or schema, so in-place modernisation and dev/test/prod are expressible. *Why:* estate merge and migration. *Status:* Planned (K).

### 3.4 Data platforms and credentials (PLT)

- **PLT-1 — Snowflake and Databricks can be connected, queried and introspected** (tables, columns, keys, views; optional profiling). Other platforms are listed but not yet connectable. *Status:* Shipped v0.17.0.
- **PLT-2 — Connectivity works on restricted networks without heavy SDKs** (P6, P7): a native-protocol path through the platform CLI where present and consented, and a CLI-free path always. *Status:* Shipped v0.17.0.
- **PLT-3 — Both interactive users and service accounts can authenticate,** through credential references resolved at use (environment, CLI configuration, the OS secret store, or a pluggable enterprise secrets manager). Secrets are never written to settings or the repository (P5). *Status:* Shipped v0.15.0 / v0.16.0.
- **PLT-4 — Every auth mode offered in the UI works end to end,** and a missing consent is fixed in place rather than by editing settings by hand. *Status:* Shipped v0.17.0.
- **PLT-5 — The assistant knows what is connected,** and the UI shows it. *Status:* Shipped v0.18.0.
- **PLT-6 — Legacy sources without a live connector can still be described:** dictionary exports and DDL. *Status:* Partial — DDL shipped; dictionary exports Planned (K).
- **PLT-7 — A user can opt in to a native driver** for platforms or performance the CLI-free path doesn't cover, fetched only on request and integrity-checked. *Status:* Planned (DRV).

### 3.5 Context layer (CTX)

- **CTX-1 — AutoDE keeps a persistent knowledge layer per repository** built from discovery, files, business-context documents, specifications and (planned) conversations. *Why:* grounding needs memory beyond a chat. *Status:* Partial — conversations Planned (C4b).
- **CTX-2 — Every fact is an assertion with provenance, trust, status and validity, in an append-only record** (C1, C2, C4). Changes supersede, removals are recorded with a reason, and facts depending on a changed or removed object go to review. *Status:* Shipped v0.29.0.
- **CTX-3 — Contradictions are detected and surfaced, not merged:** two definitions of one business term, two values for one fact, a claimed key that differs from the declared one. *Status:* Shipped v0.29.0. Data-contract conformance Planned (C4a).
- **CTX-4 — Facts from one business problem's specification apply only while that problem is active;** facts about systems are shared. *Status:* Shipped v0.29.0.
- **CTX-5 — Business context is registered from repository files** — glossary terms, rules (STRICT or recommended), verified queries — and edits to them take effect. *Status:* Shipped v0.8.0. Partial: edits under `.ai-context/context/` need a window reload to take effect (known gap).
- **CTX-6 — Context documents are schema-validated;** old data that fails a newer check still loads, with a warning. *Status:* Shipped v0.29.0.
- **CTX-7 — The record can be compacted;** history is deleted only on an explicit request. *Status:* Shipped v0.29.0.
- **CTX-8 — The context layer is visible in the UI,** read-only: layers, terms, rules, queries, relationships, conflicts. *Status:* Partial — tables, business terms, verified queries and registered sources are shown; rules, relationships, conflicts and trust are not.
- **CTX-9 — Claims are verified against data where possible** (uniqueness, nullability, accepted values, join orphan rates), returning aggregates only. *Status:* Planned (C4a).
- **CTX-10 — The engineer confirms, edits or rejects proposed facts in one place** (Context Inbox). *Status:* Planned (C4b).
- **CTX-11 — A semantic model** (entities, keys, grain, relationships, measures, metrics) is derived from confirmed facts and exportable to the target's semantic formats. *Status:* Planned (C5).
- **CTX-12 — Freshness and health are tracked;** stale facts are labelled, and a health view summarises the layer. *Status:* Planned (C6).

### 3.6 Context delivery and grounding (GRD)

- **GRD-1 — Each LLM call receives context selected for its task** (C5): what the task names, related objects, STRICT rules, conflicts and items under review that touch them; unrelated schemas are left out. With nothing to scope by, it receives the project overview. *Status:* Shipped v0.30.0.
- **GRD-2 — A context budget is never exceeded,** whichever provider is used: a conservative estimate everywhere, an exact count where the provider offers one. Pruning never cuts a block in half and never drops a STRICT rule. *Status:* Partial — the estimate and pruning rules are met; exact provider counts are not used.
- **GRD-3 — Missing facts become questions, not guesses** (C3): a request to combine entities with no confirmed relationship raises a context gap. *Status:* Partial — detected and reported since v0.30.0; steps pause on a gap from C4b.
- **GRD-4 — Every generated artifact records what it was built from** (C6): specification revision, plan step, agent, model, primitive, the context it received, and which fact justified each design decision — or that none did. *Status:* Shipped v0.30.0.
- **GRD-5 — Generated code is checked:** identifiers resolve to known objects, joins and casts use compatible types, STRICT rules are checked where they have a machine-checkable form (PII masking) and listed for review otherwise; each run produces a grounding report. *Status:* Shipped v0.30.0.
- **GRD-6 — An artifact is reported stale when its specification version changed or a fact it relied on changed,** with the reason. *Status:* Shipped v0.9.0 (specification version), v0.30.0 (facts).
- **GRD-7 — The engineer can see exactly what any recent LLM call received, and why any artifact looks the way it does.** *Status:* Shipped v0.30.0.
- **GRD-8 — Retrieval finds the right objects when the request's vocabulary differs from physical names** — synonyms, abbreviations, another organisation's terms. Deterministic signals first; embeddings only as an optional signal if measurement shows they're needed. *Why:* merges and legacy estates. *Status:* Planned (K; RET conditional).
- **GRD-9 — Grounding and accuracy are measured on a reference problem for every release** (C7), with frozen baselines so every change shows its effect; the results become a release gate. *Status:* Shipped v0.27.0 (release gate Planned C6).

### 3.7 Planning and orchestration (ORC)

- **ORC-1 — The required workflow phases (discover, model, build, validate) are inferred from the approved specification,** explained, shown live, and can be overridden; an override survives re-planning. *Status:* Shipped v0.6.0 (overrides v0.10.0).
- **ORC-2 — The plan is generated from the approved specification, within the inferred phases,** and rejected if structurally invalid (unknown agents, duplicates, missing or circular dependencies, steps outside the required phases). *Status:* Shipped v0.10.0.
- **ORC-3 — The lifecycle's gates are enforced by the orchestrator** (P3): business problem confirmed → specification approved → context ready → plan approved → stages confirmed → artifacts. Anything that invalidates an approval resets it. *Status:* Shipped v0.13.0.
- **ORC-4 — Plans are persisted and versioned,** and survive a reload. *Status:* Shipped v0.10.0.
- **ORC-5 — A failed step doesn't stop independent steps;** only steps that depend on it are blocked. *Status:* Shipped v0.10.0.
- **ORC-6 — A specification change during execution pauses the run after the current step.** *Status:* Shipped v0.25.0.
- **ORC-7 — Long-running actions show progress, and completion is confirmed** with the next actions offered. *Status:* Shipped v0.9.0 / v0.10.0.

### 3.8 Generation (GEN)

- **GEN-1 — Agents produce artifacts for each phase** — source assessment, data model, source-to-target mapping, ingestion, transformation project, architecture and data dictionary — grounded in the specification, context and target environment, with deterministic templates as the last resort when no LLM is available. *Status:* Shipped v0.11.0.
- **GEN-2 — Where a vetted primitive fits, the LLM only selects and parameterises it** (P1). *Status:* Shipped v0.14.0.
- **GEN-3 — The primitive catalog can grow without code changes,** through declarative definitions that cannot execute code; primitives have a lifecycle (draft, published, deprecated, retired), management is opt-in, and an approved specification pins the primitive versions it used (P2). *Status:* Shipped v0.14.0.
- **GEN-4 — A Pipeline Specification can be generated:** a strictly validated, deterministically compiled, per-entity contract, with a design document derived from it so the two can't drift. *Status:* Shipped v0.14.0.
- **GEN-5 — Artifacts are written to a visible folder per business problem, phase and specification version;** earlier revisions are kept; artifacts are committed as deliverables. *Status:* Shipped v0.9.0 / v0.12.0.
- **GEN-6 — Migration programmes are supported at scale:** assessment and wave planning, rule-based mapping and generation across many objects, importing external code-converter output, and reconciliation proving the target matches the source. *Status:* Planned (M1–M3).
- **GEN-7 — Further generators:** DDL, orchestration (Airflow, Dagster, Prefect) and tests as dedicated agents. *Status:* Not met (DDL likely covered by M2).

### 3.9 Conversation (CHT)

- **CHT-1 — Chat follows the specification's state:** with no specification, the first message starts the discovery interview; with a draft, messages refine it; with an approved specification, questions are answered grounded in it and the context; a requested change starts a revision interview. *Status:* Shipped v0.9.0.
- **CHT-2 — Conversations are persisted locally,** not committed. A new chat archives the previous one (never discards it); history can be reopened and resumed; deleting a conversation is explicit and confirmed; a restart opens an empty chat. *Status:* Shipped v0.9.0 / v0.13.0.
- **CHT-3 — An abandoned interview is never lost:** its partial answers are folded into the context layer. *Status:* Shipped v0.9.0.
- **CHT-4 — The assistant is read-only by default;** write and command access is granted per chat, explicitly. *Status:* Shipped.
- **CHT-5 — Facts stated in chat are captured as proposed facts, and answers cite the facts they rest on.** *Status:* Planned (C4b).
- **CHT-6 — Chat history can be searched, tagged and exported.** *Status:* Not met.

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
- **SKL-5 — Skills are reviewed and trusted before they gain capabilities,** with provenance; imports from Git with updates shown as diffs; a starter library and authoring guidance. *Status:* Planned (S2, S3).

### 3.12 Interoperability with other agents (MCP)

- **MCP-1 — AutoDE's deterministic core — primitives, specifications, context, grounding checks, platform access — is usable by other coding agents** (Claude Code, Copilot agent mode, Cursor) through the Model Context Protocol, and the extension uses the same interface. *Why:* engineers also work in those agents; they should get AutoDE's grounding instead of freehand SQL. *Status:* Partial — engine boundary shipped v0.26.0; server Planned (3–5).

### 3.13 Governance and security (SEC)

- **SEC-1 — Nothing is sent to a third-party model without consent;** no secret is logged or committed (P5). *Status:* Shipped.
- **SEC-2 — Privacy and data flow are explained** in the README and the consent dialog. *Status:* Not met.
- **SEC-3 — Telemetry, if any, is opt-in and free of personal data.** *Status:* Not met (the setting exists; nothing reports).
- **SEC-4 — Data sensitivity and masking are governed as code:** classifications in specifications, a masking primitive, a governance interview. *Status:* Planned (GOV).
- **SEC-5 — Probes and samples never expose row values without consent;** verification uses aggregates. *Status:* Planned (C4a, phase 4).

### 3.14 User experience (UI)

- **UI-1 — One chat-first sidebar** carries the workflow, with a Workflow Palette for the specification, context, phases, artifacts and primitives, and a settings panel with LLM, Source, Target and Preferences tabs. *Status:* Shipped.
- **UI-2 — The look follows VS Code:** theme colours and fonts, minimal frames, pill-style status indicators, empty states for anything not configured. *Status:* Shipped.
- **UI-3 — Every request shows one evolving progress indicator,** and sending is disabled while one is running. *Status:* Shipped v0.9.0.
- **UI-4 — Controls are usable by keyboard and screen readers.** *Status:* Partial (not verified).
- **UI-5 — A short style guide documents colour tokens and component rules.** *Status:* Not met.
- **UI-6 — Dashboard panel.** *Status:* Parked (v0.13.0); its quick actions go through the gated commands.

---

## 4. Non-functional requirements (NFR)

- **NFR-1 — AutoDE never blocks the extension host for long:** no single synchronous task longer than 100 ms at large-estate size; long work yields, reports progress and can be cancelled. *Why:* a blocked extension host freezes AutoDE's panel and every other extension, Copilot included (the editor itself runs in another process). *Status:* Not met / unmeasured; measured and enforced from K.
- **NFR-2 — Writes are atomic;** a crash never leaves a corrupt specification, context file or artifact. *Status:* Shipped.
- **NFR-3 — Corrupt or partial files are tolerated:** logged, skipped or repaired when safe, never fatal. *Status:* Shipped.
- **NFR-4 — Deactivation releases watchers, processes and handles promptly** (target: 200 ms). *Status:* Shipped v0.14.0 (timing not measured).
- **NFR-5 — Footprint and dependencies** follow P6. *Status:* Shipped (runtime dependencies: `ajv`, `yaml`).
- **NFR-6 — Works without a live connection** from cached and imported metadata, and says what it cannot see. *Status:* Partial — file ingestion shipped; cache and visibility Planned (K).
- **NFR-7 — Reproducible:** the same inputs give the same context, projections and checks; artifacts pin the revisions they used. *Status:* Shipped v0.29.0 / v0.30.0 (catalog revisions Planned K).
- **NFR-8 — Scale:** a business problem's working set (about 200 tables, 5 000 columns, 1 000 facts) stays responsive in memory; larger estates are handled by K's catalogs and cache, with any storage change decided from measurements. *Status:* Shipped for the working set; estates Planned (K).
- **NFR-9 — Every behaviour change is covered by automated tests,** and every release is evaluated on the reference problem. *Status:* Shipped (241 tests and eval at v0.30.0).

---

## Appendix A — Where the previous sections went (2026-10-15)

The previous document (commit `fc16b0d`) mixed requirements with implementation detail and per-version narratives. Every section is accounted for below. "→ design" means the HOW content moves into [technical-design.md](technical-design.md) in the next documentation step (until then it remains in git at `fc16b0d`); "→ history" means it is release history, already in [CHANGELOG.md](../CHANGELOG.md).

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
| §17.6 – §17.7 Credentials, real execution | PLT-1 – PLT-4, PLT-7, P5 – P7; detail → design; live-test narratives → history |
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
