# AutoDE — Engineering Onboarding Guide

> **For:** an engineer joining the team that supports AutoDE's codebase, who needs to find their way around, run it, change it safely and ship a phase. Data engineers who *use* AutoDE: read the [user guide](user-guide.md).
> **Describes:** v0.49.0 (2026-10-28). This guide orients; it does not duplicate. Details live in [technical-design.md](technical-design.md) (HOW), [requirements.md](requirements.md) (WHAT and WHY) and [roadmap.md](roadmap.md) (WHEN), and every section here links to them. The guide is updated when a phase ships, together with those documents. The previous long-form guide (v0.13.0) is in git history.

---

## Contents

1. [AutoDE in five minutes](#1-autode-in-five-minutes)
2. [The documents and how they fit](#2-the-documents-and-how-they-fit)
3. [Architecture at a glance](#3-architecture-at-a-glance)
4. [Concepts you need](#4-concepts-you-need)
5. [The main flows](#5-the-main-flows)
6. [A tour of the code](#6-a-tour-of-the-code)
7. [Working on AutoDE day to day](#7-working-on-autode-day-to-day)
8. [Rules that keep AutoDE correct](#8-rules-that-keep-autode-correct)
9. [How to extend AutoDE](#9-how-to-extend-autode)
10. [Known risks and technical debt](#10-known-risks-and-technical-debt)
11. [Your first week](#11-your-first-week)
12. [FAQ](#12-faq)

---

## 1. AutoDE in five minutes

AutoDE is a **VS Code extension** that takes a data-engineering business problem from description to delivered artifacts — specification, context, plan, models, pipelines, documentation — inside the engineer's own repository. It is used on customer engagements: greenfield builds, estate merges and legacy migrations.

**The problem it solves.** General coding agents write plausible data-engineering code that is not grounded in the customer's real schemas, business definitions or approvals. AutoDE makes every artifact trace back to an **approved specification** and to **facts about the data** that are recorded, trusted to a known degree and checkable — and keeps the engineer in control at every gate.

**The mental model in one sentence.** *A governed, spec-driven workflow (interview → specification → planned workflow of stages → generated artifacts), grounded in a ledger of facts about the customer's estate and business, with a deterministic engine underneath that other coding agents can use too.*

Things that surprise newcomers:

- **There is no backend.** Everything runs on the engineer's machine: the VS Code extension host, a webview, and (since v0.35.0) an optional MCP server process. Everything AutoDE knows is a file under `.autode/` in the open repository, and everything it generates for the customer goes to `autode-output/` (§4.11).
- **The LLM proposes; deterministic code decides.** Transform SQL comes from reviewed *primitives* the LLM only selects and parameterises; facts the LLM extracts land as *proposed* and need a person or a probe to become trusted; grounding checks are pure code.
- **The chat box is a router.** What a message does depends on the state of the active business problem (§5.2).
- **Most product decisions are recorded.** Before changing direction, read the roadmap's decision log and the "Rejected approaches" in the specs — the question has often been answered.

## 2. The documents and how they fit

| You want to know… | Read | Notes |
|---|---|---|
| What AutoDE must do, and why | [requirements.md](requirements.md) | Requirement IDs (`GRD-4`, `SKL-5` …) with status. Principles P1–P9 and C1–C9 are binding. §1.1 maps each capability area to where its planned work is specified. |
| What planned phases will build | [mcp-engine-requirements.md](mcp-engine-requirements.md), [context-layer-requirements.md](context-layer-requirements.md) | Phase specifications with acceptance criteria. A shipped phase shrinks to a pointer. |
| What is next, and what was decided | [roadmap.md](roadmap.md) | Phase order and status, backlog, decision log. Wins over any plan text elsewhere. |
| How it is built | [technical-design.md](technical-design.md) | Modules, formats, algorithms. §10.5 (settings) and §12 (source tree) are generated from the code. |
| What changed in each version | [CHANGELOG.md](../CHANGELOG.md) | Includes every deliberate deviation from a spec. |
| How to check a release by hand | [manual-verification.md](manual-verification.md) | F5 checklists per version. |
| How other agents use AutoDE | [mcp-setup.md](mcp-setup.md) | Claude Code, Codex, VS Code, Cursor, Cline. |
| The `autode` command line | [cli.md](cli.md) | CI gate, decisions from a terminal, exit codes. |
| How AutoDE is measured | [test/reference/retail-orders/README.md](../test/reference/retail-orders/README.md) | The reference problem and `npm run eval`. |

The doc map with precedence rules is [README.md](README.md). **Rule of thumb:** requirements say *what*, the design says *how*, the roadmap says *when*, the changelog says *what changed*. Don't put a file path in requirements.md, and don't restate a requirement in the design.

## 3. Architecture at a glance

```
┌──────────────────────── VS Code extension host ─────────────────────────┐
│  extension.ts — activate, ~45 commands                                   │
│  webviewProvider.ts — the panel's bridge: chat router, gates, commands   │
│  agentHub.ts — the orchestrator: spec, plan, execute, every LLM call     │
│                                                                          │
│  host layer (may import vscode)                                          │
│    src/core      LLM adapters (7 providers), tool loops, spec engine,    │
│                  settings, SecretStorage credentials                     │
│    src/context   managers for specs, plans, context documents, the       │
│                  business-problem pack, artifacts, chats; ContextFile-   │
│                  Manager (ledger, catalog, working set, packs)           │
│    src/agents    discover / model / build / validate agents, skills      │
│                                                                          │
│  engine (never imports vscode — lint-enforced)                           │
│    src/engine/context    assertions, ledger, projection, conflicts,      │
│                          estate ids, catalog, vocabulary, retrieval,     │
│                          packs, gaps, pack/profiles/contracts,           │
│                          conformance, probes, ingestion                  │
│    src/engine/grounding  SQL grounding checks, manifests                 │
│    src/engine/transforms primitives (Tier 1 code, Tier 2 YAML)           │
│    src/engine/pipelineSpec, platform, skills                             │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ postMessage
                     media/sidebar.html (one-file webview: chat, context
                     drawer, workflow palette, settings) + custom editors

dist/autode.js — src/cli + src/mcp over src/engine: the autode CLI and, as
`autode mcp`, a separate, LLM-free MCP server (stdio) for Claude Code, Codex,
VS Code agent mode, Cursor, Cline. Also packed on its own as the `autode`
package (dist/mcp-server.js is a shim for `autode mcp`).
```

Three ideas carry most of the design:

1. **The engine boundary.** `src/engine/**`, `src/mcp/**` and `src/cli/**` never touch the VS Code API, so the same code runs in the extension, the MCP server, the CLI and plain-Node tests. Host concerns come in as parameters (`FileIo`, `AgentHost`, `CompleteJson`). See technical-design §10.2.
2. **The ledger is the system of record for context.** Facts are append-only *assertions* with status and trust; the graph the agents read is a projection of them, rebuilt, never edited in place. See §4.4 and technical-design §5.3.
3. **Packs, not dumps.** Each LLM call gets a task-scoped *context pack* within a token budget, and every generated artifact gets a *manifest* of what it rested on. See technical-design §5.5–5.7.

**Workflows (since v0.44.0).** Each business problem has a planned workflow, kept in `.autode/problems/<id>/workflow.yaml`. It's drafted from a template in `workflows/*.yaml` (greenfield, modernization, estate merge; see [workflow-templates.md](workflow-templates.md)) and approved by a person. The engine's runtime (`src/engine/workflows/`) is the hub: it says which stage is ready, which waits and why, and which is stale. Document-backed stages read their approval from their documents, so the panel, CLI and MCP agree. See technical-design §7.8. In VS Code the **Workflow view** shows it: a tree in AutoDE's activity bar, a Workflow editor tab with the stage board, detail, decisions and history, and a status-bar item. Everything is recorded with who did it in `workflow-events.jsonl`.

**Where the architecture is going (from v0.40.0).** AutoDE is moving to a portable architecture ([mcp-engine-requirements.md §3.1](mcp-engine-requirements.md), phases PA1–PA4 and phase 5 in the [roadmap](roadmap.md)):
- every AI capability becomes a standard agent skill (`SKILL.md`);
- the engine offers deterministic tools;
- a change to AutoDE's state becomes a validated **proposal** that a person approves as a **decision**;
- the host (VS Code, Claude Code, Cursor, Codex …) supplies the model.

VS Code stays the first-class host; other hosts use the same engine through MCP, the skills pack (PA3) and the `autode` CLI (since v0.42.0). Today's agents and `AgentHub` flows are migrated phase by phase, and a migrated path is deleted in the same release.

Bundling: `tsc` compiles every module to `dist/**` (used by tests); esbuild then bundles `dist/extension.js` and `dist/mcp-server.js`, which are all the package ships (technical-design §10.7).

## 4. Concepts you need

The ideas a data engineer works with in AutoDE, how they fit together, and the guarantee each one carries. The rest of this section (4.1–4.12) goes one level deeper, into how each is built. Everything else in AutoDE is internal: it supports these concepts.


| Concept | What it is | Where it lives | Guarantee it carries |
|---|---|---|---|
| **Business problem** | One piece of work: its specification, its pack of documents, its workflow and everything it produces. | `.autode/problems/<id>/` | Work is scoped and traceable to a problem. |
| **Specification** | What the business needs, in its own words: problem statement, objectives, scope, success criteria. Approved by a person. | `spec/business-problem.yaml` | Nothing is built against an unapproved intent. |
| **Pack** | The documents behind a problem: contracts, BRDs, KPI definitions, data dictionaries, samples. | `pack/` | Requirements come from documents a person supplied, with their authority (signed or draft). |
| **Estate and facts** | What exists (the source and target systems and their tables and columns, from connections or files) and what is known about it (keys, grain, relationships, terms, rules), each fact with its evidence, trust and status. | `.autode/knowledge/` | Everything AutoDE produces is checked against what really exists, and every important fact is confirmed by a person. |
| **Workflow** | The problem's stages, from a template (greenfield, modernization, estate merge), proposed by the engine and approved by a person: what each stage needs and produces, and what is ready, waiting, done or stale. | `workflow.yaml`, `workflow-events.jsonl` | The process is planned, gated and recorded; no stage is skipped silently. |
| **Approvals** | Everything that waits for a person, in one list: *Waiting for you*. Workflow and stage gates, facts to review, stage documents, runbooks, connections. | The Workflow view, `autode approvals`, `autode_approvals_list` | Only a person decides; consequential decisions can't be made by an agent. |
| **Mapping** | How each source table and column becomes each target column, with transformations. | `context/mapping-context.yaml` | The build follows an approved, grounded mapping. |
| **Model** | The target data model: entities, grain, keys, relationships, history, rendered as DDL by AutoDE. | the modelling stage's artifacts | The model is checked (grain, keys, references) before it is built. |
| **Pipeline Spec** | The pipelines as data: per entity, its source, its transform steps (AutoDE's primitives with parameters) and its target. Compiled to code by AutoDE. | `spec/pipeline.yaml` | Code is generated deterministically from an approved spec, not written freehand. |
| **Artifacts** | What stages produce: SQL, YAML, documents. Each has a grounding manifest: what it references and which facts back its decisions. | `autode-output/<problem>/` | Every deliverable is traceable to the estate and the facts. |
| **Runbook** | A platform change (create objects, grant, load, deploy): steps an agent proposes, AutoDE classifies (read, change, destructive) and checks, a person approves under the team's policy, and AutoDE's runner runs one step at a time with a tamper-evident log. | `runbooks/`, `runs/` | Nothing changes a data platform without a person, and every change is logged. |
| **Agents and skills** | An agent is a role (what it may do: its tools and permission tier). A skill is a method (how to do one kind of stage). AutoDE's workflow hands each stage to its agent; agents never call each other or approve anything. | `agents/`, `skills/` (and `.autode/config/agents/` for a team's own) | AI works inside bounded roles, from reviewed instructions, on the stages the workflow assigns. |

#### How they fit together

1. A **business problem** starts from a statement; the interview turns it, and the **pack**, into a **specification** that a person approves.
2. The engine proposes a **workflow** from a template and what it knows; a person approves it.
3. Stage by stage, **agents** with their **skills** bring the **estate** in, propose **facts**, and draft the stage's output: the source and target contexts, the **mapping**, the **model**, the **Pipeline Spec**, the **artifacts**, the documentation.
4. Every draft waits in **approvals** until a person accepts it. A changed input makes the stages that used it stale, and they need approving again.
5. Platform changes go through **runbooks**; AutoDE's runner runs them once a person approves.

The same process holds in VS Code, in a terminal (`autode`), and in any agent host over MCP (Claude Code, Cortex Code, the Copilot CLI): the host brings the model, AutoDE brings the process, the checks and the approvals.

#### Definitions AutoDE ships, and a team adapts

| Definition | What it decides | A team's own |
|---|---|---|
| Workflow templates | The stages of an engagement | `.autode/config/workflows/` |
| Role templates (agents) | What each agent may do | `.autode/config/agents/` |
| Skills | How a stage is done | ported through the Skills view or `autode skills import` (reviewed, then published); see [skills-authoring.md](skills-authoring.md) |
| Primitives | The vetted transforms the compiler uses | `.autode/config/primitives/` |
| Policy | Who approves runbooks per environment | `.autode/config/approvals.yaml` |
| Connections | Which platforms, and how to reach them (never secrets) | `.autode/config/connections.yaml` |

#### Internal (you don't need these to use AutoDE)

The catalog's per-system files, the working set and graph caches, context packs, the decision files' event history, readiness records, chat sessions, the derived semantic-layer snapshot, and the interview's prompt packs. They support the concepts above.

#### Being simplified

AutoDE grew some overlapping objects. They are being reduced, one release at a time (roadmap, decision log 2026-10-22):
- **one way to change a platform:** runbooks only (the older single-statement platform change goes);
- **one way to record a mapping:** the mapping document only;
- **the old plan of steps:** removed in v0.45.9, with the dashboard panel (the workflow replaced it; context gaps are now listed in each stage's assignment);
- **contexts reference the workspace** (v0.45.10): a problem's target context names a target connection and keeps its own decisions; its source context lists estate systems. Both stay as the problem's approved choices; the unused `target-environment.yaml` is gone;
- **later:** chat attachments into the pack; the interview packs become skills; the older knowledge files (business context, verified queries, semantic-layer snapshots) fold into the facts; one lifecycle for AutoDE's and imported skills.

### 4.1 Business problem and its specification
A workspace holds several **business problems** under `.autode/problems/<id>/`; `.autode/local/active-problem.json` says which is current for this engineer. Each has a **Business Problem Specification** (`spec/business-problem.yaml`), versioned and approved by the engineer. Everything downstream keys off the spec's id and version. The **requirements interview** that produces it is kept with the problem (`interview/state.yaml`, `src/engine/interview/`): the panel, an agent host (`autode_interview_state`, `autode_interview_record_answer`) and a terminal (`autode interview`) all continue the same one. Its parts are the `autode-de-interview-*` skills, and files attached during it go into the problem's pack. The pack's documents are read by AutoDE's LLM in the panel or by an agent host's model, through the same steps (`readingFor`, `recordFacts`, `recordProfile`; MCP `autode_pack_reading`, `autode_pack_record_reading`); the **context curator** role and its skills do this in hosts. *Requirements BPS-1, BPS-7; design §3, §7.9.*

### 4.2 Workflow, stages and approvals
Each problem's **workflow** (`workflow.yaml`) is drafted by the engine from a template (`workflows/*.yaml`: greenfield, modernization, estate merge), refined by the planner, checked against the template's rules and approved by a person. Its stages run by dependency; each produces an artifact, a document with its own approval (spec, contexts, mapping, Pipeline Spec) or a gate decision. A changed input makes everything downstream stale. The runtime (`src/engine/workflows/`) keeps the gates, for every surface; `workflow-events.jsonl` records who did what. **Waiting for you** (`src/engine/approvals/waiting.ts`) gathers every pending approval, whatever mechanism holds it. *Requirements ORC-9; design §7.8.*

### 4.3 Agents, skills and assignments
An **agent** is a role template (`agents/<role>.md`: its AutoDE tools, permission tier and skills); a **skill** (`skills/autode-<scope>-<capability>/SKILL.md`, standard Agent Skills) is the method for a kind of stage, chosen by the stage kind and the problem's target platform. For each stage the hub builds an **assignment** (`src/engine/agents/assignment.ts`) with exactly the tools the tier and role allow; it runs in VS Code (Run agent, `src/core/agentExecutor.ts`) or in a host through `autode_workflow_next` and the plugin. Agents record drafts (`autode_record_artifact` and the stage's own document tools) and never approve, start stages or call each other. A stage no skill does is manual. The old plan of steps was removed in v0.45.9. **Personal data** (v0.47.0, `src/engine/governance/`) is classified by facts a person confirms; the build masks it after staging with the `mask` primitive, and a build that leaves sensitive data unmasked can't be approved (requirement SEC-4). A team's **imported skills** (v0.46.0, `src/engine/skills/port.ts`) join the same assignments when they declare stage kinds and are published and reviewed; imported knowledge skills join context packs instead. See [skills-authoring.md](skills-authoring.md). **Platform skills** (v0.45.11: Snowflake, Databricks, dbt, reconciliation) are skills like the others. Each ends with a worked example on the reference problem, which `test/platformSkillCheck.cjs` checks in `npm test`: a skill edit that breaks its example fails the build. See [platform-skills.md](platform-skills.md). *Requirements SKL-6, SKL-8, SKL-9; design §7.9.*

### 4.4 Assertions, ledger, trust
An **assertion** is one fact (`schema_fact`, `key`, `grain`, `relationship`, `business_term`, `metric`, `quality_expectation`, `decision`, …) about subjects (object ids), with a **status** (`proposed`, `active`, `needs_review`, `superseded`, `rejected`), a **trust** tier (`verified` > `confirmed` > `documented` > `assumed` > `inferred`) and evidence. Facts a model extracted record the model. The **ledger** (`.autode/knowledge/ledger/*.jsonl`) appends events; folding them gives the current assertions. Graph nodes are **mirrors** of schema assertions. Nothing an LLM proposes becomes trusted without a person (or, for `verified`, a probe). **Capture coverage** (v0.48.0, `src/engine/context/coverage.ts`, `dataCandidates.ts`, `capture.ts`) lists per table and metric what is known and missing, and finds keys, joins and personal data from the data before any model. **Exploration mode** (`src/engine/documents/problemMode.ts`) is per problem: model proposals and assumptions go live at `assumed` trust, which no governed check accepts; approval checks split into hard and soft (`documentApprovalCheck`); runbooks can't target production. *Requirements CTX-*, ORC-11; design §5.3–5.4, §5.15.* The **semantic layer** (v0.49.0, `src/engine/semantic/`) is separate: business definitions as Snowflake semantic model YAML in the deliverables folder (shared models, and each problem's composites resolved into deployable models), approved by a person, with AutoDE's notes in `.autode/semantic/`; the Semantic Model editor is a custom text editor over the engine's `editorState.ts`. *Requirement CTX-11; design §5.16.*

### 4.5 Estate, catalog, working set
Objects have estate-qualified ids: `obj:<system>/<environment>/<fqn>` (e.g. `obj:shop/prod/shop.orders`); `.autode/knowledge/estate.yaml` records systems, environments and which connection or file feeds them. Each system has a **catalog** (`.autode/local/catalog/…`, git-ignored, rebuildable) holding the whole estate in tiers (names → structure → profile). Only the **working set** — what problems use, 200 tables by default — is mirrored into the ledger and graph; a task that needs a catalogued table promotes it. *Design §5.11–5.12.*

### 4.6 Context packs, gaps, grounding
`buildContextPack({ purpose, query | seeds, maxTokens })` resolves seeds (deterministic retrieval with abbreviations, synonyms, the customer's vocabulary, comments, glossary), expands the graph neighbourhood, renders within a budget and reports **gaps** (missing keys, grains, joins). After generation, **grounding checks** resolve every identifier in the SQL against the estate and write a manifest next to the artifact. "What the Agent Saw" and "Explain This Artifact" show both. *Design §5.5–5.7.*

### 4.7 Business-problem pack
The customer's documents — contract, BRD, KPI definitions, mapping, data dictionary, sample rows — registered with a role, an authority (`signed` → confirmed, `draft` → documented) and a version. House-format structured documents are read through an **interpretation profile** (LLM-proposed once, engineer-confirmed, then deterministic); contract clauses become expectations, never observed facts; **conformance** checks each source against the contract; **probes** verify claims with fixed, aggregate-only SQL or over samples. *Design §5.13.*

### 4.8 Primitives and the Pipeline Spec
**Primitives** are reviewed generators: Tier 1 in TypeScript (`dedup`, `incremental_load`, `rename_cast`), Tier 2 as YAML definitions with a deliberately limited template language. The LLM picks a primitive and its parameters (validated by Ajv); the primitive writes the code. The **Pipeline Spec** describes entities and transform steps and compiles deterministically. *Design §9.*

### 4.9 Tool skills
Imported Claude Agent Skills (`SKILL.md` folders) that run with real tools on any of the seven LLM providers. What a skill can use is capped by its declared `allowed-tools` and by its **trust tier**: `unreviewed` (doesn't run), `reviewed` (read-only, not via Claude Code), `trusted` (full). Trust belongs to the reviewed content's checksum — change a file and it's unreviewed again. *Design §7.6.*

### 4.10 The MCP server and the CLI
`autode mcp` (in `dist/autode.js`; `dist/mcp-server.js` is a shim for it) exposes the engine to other agents: primitives, Pipeline Spec, context tools (`autode_resolve`, `autode_get_context_pack`, `autode_list_assertions`, `autode_check_grounding`), data-platform tools (`autode_list_connections` … `autode_execute_query`, since v0.37.0), interview and reviewed-skill prompts, and resources. No workspace writes, no LLM calls, secrets redacted. Platform connections come from `.autode/config/connections.yaml` plus the personal `.autode/local/connections.yaml` (no secrets; credentials from `AUTODE_*` env vars, the CLI's configuration, or — for `resolver: vscode` entries saved from a settings card — env variables standing in for VS Code's secret storage); queries are read-only; changes (facts, spec and Pipeline Spec revisions, mappings, platform writes) are proposed and become decisions a person approves (since v0.40.0, design §7.7); row values are withheld unless the connection sets `allowSampleDataInPrompts`. *Design §6.12, §10.6; setup: [mcp-setup.md](mcp-setup.md).*

Inside VS Code (since v0.43.0) the extension reaches the same server in-process through `src/core/engineClient.ts` (MCP over an in-memory transport, started on first use): imported tool skills get its tools within their `allowed-tools` and trust tier, and PA3's executor will use it. VS Code's agent mode gets the server from a provider (`registerMcpProvider` in `src/core/mcpConfig.ts`) with no configuration. The extension still imports `src/engine` directly for in-process work; the boundary that matters is that changes go through decisions. *Design §10.9.*

The **`autode` CLI** (since v0.42.0) runs the same checks without VS Code: `validate`, `compile`, `grounding`, `conformance`, `probe`, `doctor`, and `check`, the CI gate that also fails while a high-stakes decision is pending. `validate`, `compile` and `grounding` call the MCP tools' own handlers. `problems new | use` and `estate ingest | extract` start problems and load the estate (since v0.43.2; the same over MCP); `facts`, `pack`, `vocabulary`, `design-doc`, `query` and `explain` cover the Context Inbox, the pack and SQL (since v0.43.3); `decisions approve | reject` and `connections add | remove` change state, and they need a person at an interactive terminal; `connections list | test` manage connections without VS Code (since v0.43.1). The exit codes are stable. The `autode` package (`npm run package:cli`) contains the same `dist/autode.js` the VSIX ships. *Design §10.8; reference: [cli.md](cli.md).*

### 4.11 Where AutoDE keeps things
`.autode/` holds AutoDE's working state, grouped by lifecycle: `problems/<id>/` (spec, plan, context documents, pack — committed), `knowledge/` (ledger, estate, sources, profiles, business context, vocabulary — committed), `config/` (skills, primitives, target environment, connections — committed) and `local/` (active problem, chats, derived graph, catalog — never committed; AutoDE writes `.autode/.gitignore` for it). Generated deliverables go to the visible `autode-output/<problem-id>/` (setting `artifactDirectory`). Every path comes from `src/engine/workspaceLayout.ts`; never build one by hand. A workspace from before v0.36.0 (`.ai-context/`) is moved over on activation (`workspaceMigration.ts`). *Design §2.1–2.2.*

### 4.12 Runbooks and the runner
Everything that changes a data platform is a **runbook** (`src/engine/runner/`): steps an agent proposes, the engine classifies (read, change, destructive) and checks (CLI allowlist, arguments, rollback), a person approves under `.autode/config/approvals.yaml`, and deterministic code runs in order with dry runs and a hash-chained log, from VS Code's Runbook tab. In agent hosts, the plugin's guard hook (`autode hook guard`, `src/engine/runner/hostGuard.ts`) blocks the host's agent from running platform-changing `snow`/`databricks` commands itself. *Requirements ORC-10; design §7.9.*

## 5. The main flows

Each flow names its entry point; follow it in the code with the design section beside you.

### 5.1 Activation
`extension.ts#activate` builds `ConfigurationManager`, `AgentHub`, `ConnectionManager`, the sidebar `DataAgentHubWebviewProvider` and the managers, registers the commands and custom editors, and returns. Nothing heavy runs at activation (no MCP server, no LLM call); the context layer loads when the panel opens. *Design §10.1.*

### 5.2 A chat message
`webviewProvider.handleMessage('chat')` routes by state: no active business problem → the **interview**; a draft spec → **revision** of the draft; an approved spec → **grounded chat** with a `chat` pack. Slash commands (`/spec`, `/plan`, `/skill <id>[@<version>]`, `/settings` …) bypass the router. *Design §4.3, §4.8.*

### 5.3 Interview → specification
`AgentHub.discoverNextAction()` runs the SpecOps interview over the bundled skills (`skills/*.json`, overridable in `.autode/config/skills/`), with an `interview` pack and what discovery already established (questions discovery answers are dropped). Synthesis drafts the spec (`specSynthesis.ts`); `SpecManager` persists and versions it. *Design §3.8–3.9.*

### 5.4 Spec → workflow → stages
Approve the spec → the engine drafts the workflow (`draftWorkflow()`), a person approves it → stage by stage, `nextAssignment()` and `assignmentFor()` give the agent its assignment; the agent records drafts (artifacts with grounding manifests, or the stage's document), the stage is handed in, and a person approves its gate or document → platform changes run as runbooks. *Design §7.8–7.9.*

### 5.5 Getting the estate in
Two routes, same destination: a live connection (`ConnectionManager` → adapter → REST or CLI backend → `extractMetadata`) or a file (`Ingest File as Source Context`: DDL, CSV/JSON, legacy column dictionaries). Both go through `ContextFileManager`: into the catalog whole, into the working set as far as it fits, mirrored into the ledger, projected into the graph. *Design §5.9, §5.11–5.12, §6.*

### 5.6 Business-problem pack → conformance
`Add Document to Business-Problem Pack` → `Apply Business-Problem Pack` (profile proposal or deterministic read; free text extraction; samples registered) → `Run Conformance Check` (report artifact) → `Verify Claims with Probes`. Host side: `src/context/BusinessPackManager.ts`; logic in `src/engine/context/{pack,profiles,contracts,conformance,probes,documentExtraction}.ts`. *Design §5.13.*

### 5.7 Running a tool skill
`/skill <id> <instruction>` or `Run Tool Skill` → `AgentHub.runToolSkill()` → `ToolSkillAgent`: resolve the version, check the run gate (status, trust for the current content, Claude Code eligibility), cap the tool mode, then one call through the provider's own tool loop with per-call approval and audit. *Design §7.6, §8.7.*

### 5.8 An MCP tool call
Client → stdio → `src/mcp/server.ts` validates arguments against the tool's JSON Schema → handler in `tools.ts` reads the workspace through `EngineWorkspace` (cached by file fingerprints) → structured result, or the error envelope; everything redacted. *Design §10.6.*

## 6. A tour of the code

The full, generated tree is technical-design §12. The files that matter most, in reading order:

| # | File | Why |
|---|---|---|
| 1 | `src/engine/types.ts` | The vocabulary: specs, plans, steps, artifacts, settings, skills. |
| 2 | `src/extension.ts` | What is registered, and how the pieces are wired. |
| 3 | `src/core/webviewProvider.ts` | The chat router, gates, and most command implementations (~2 500 lines; read by feature). |
| 4 | `src/core/agentHub.ts` | The orchestrator and every LLM call (~1 700 lines). |
| 5 | `src/engine/context/contextFileManager.ts` | Loading, ledger sync, catalog and working set, packs (moved into the engine in v0.43.2; the extension injects its file watcher). |
| 6 | `src/engine/context/assertions.ts`, `ledger.ts`, `projection.ts` | The context layer's core. |
| 7 | `src/engine/context/contextPack.ts`, `retrieval.ts`, `catalog.ts` | How context reaches an LLM. |
| 8 | `src/engine/grounding/sqlGrounding.ts`, `manifest.ts` | How output is checked. |
| 9 | `src/engine/transforms/registry.ts` + one primitive | Deterministic generation. |
| 10 | `src/engine/agents/` (`assignment.ts`, `primitiveCandidates.ts`, `modelDraft.ts`) and `agents/`, `skills/` | AutoDE's agents as role templates and skills, and the deterministic tools they build on (v0.45). |
| 11 | `src/core/llmProviders.ts`, `agenticTools.ts` | Providers and tool loops. |
| 12 | `src/mcp/server.ts`, `tools.ts`; `src/cli/main.ts` | The MCP surface, and the CLI that reuses its handlers. |
| 13 | `test/functional.test.cjs` (search for the feature) | Executable documentation for nearly everything above. |

Folders at a glance: `src/core` (orchestration, LLMs, settings, spec engine), `src/context` (host-side managers), `src/agents` (the tool-skill runner), `src/editors` (custom editors for data model, STTM, graph, profile, docs), `src/engine/*` (host-agnostic logic), `src/mcp` (MCP server), `src/cli` (the `autode` command line), `src/spokes` (only `snowflakeExecutor.ts` is live), `media/` (webviews, icons), `skills/` (interview prompt packs as JSON, and since v0.45.0 the agents' skills as `skills/<id>/SKILL.md`), `agents/` (role templates, `<role>.md`, v0.45.0), `workflows/` (workflow templates), `test/` (tests, eval, reference problem, golden snapshots), `scripts/` (bundler, `autode` package, docs generator).

**Safe to ignore at first:** CSS in `sidebar.html`, `mock_activate.js`.

## 7. Working on AutoDE day to day

### 7.1 Setup and running
```bash
npm install
npm run compile        # tsc to dist/** + esbuild bundles (dist/extension.js, dist/autode.js) + the mcp-server.js shim
node dist/autode.js --help   # the CLI; npm run package:cli builds the autode tarball in dist/
```
Press **F5** ("Run Extension (Development Host)"); it compiles first. In the new window, open a scratch workspace — the reference problem's files in `test/reference/retail-orders/` make a good one ([manual-verification.md](manual-verification.md) Part 0). Commands run from the Command Palette *of the Development Host window*. Log lines appear in the panel's chat stream; tool-skill transitions also go to the `AutoDE: Tool Skills` output channel.

### 7.2 Checks
| Command | What it does | When |
|---|---|---|
| `npm test` | Compile, bundle, run `test/functional.test.cjs` (288 tests) | Before every commit |
| `npm run lint` | ESLint; **0 errors** required (≈31 known warnings) | Before every commit |
| `npm run eval` | The reference problem, offline; writes `test/reference/retail-orders/eval-report.md` | When you touch the context layer, retrieval, packs, grounding or generation |
| `npm run docs:generate` | Regenerates technical-design §10.5 and §12 | After adding a setting or a source file (`npm test` fails otherwise) |
| `AUTODE_UPDATE_GOLDEN=1 npm test` | Rewrites `test/golden/mcp-compile/` | Only when a primitive's output is meant to change — review the diff |
| `npx vsce package --no-dependencies` | Builds the VSIX (minified bundles) | Release |

CI (`.github/workflows/ci.yml`) runs compile, tests and lint on Node 20.

### 7.3 How tests work
One runner, plain Node. Modules load from `dist/` with a fake `vscode` (`createMock()`, `withMock()`), and are re-required with `fresh()` because they capture the mock when loaded. Engine modules need no mock. MCP tests spawn the real bundle and talk to it with the SDK client. Add tests next to the feature's existing ones, named `vX.Y.Z: <behaviour>`; an acceptance criterion in a spec should map to a test.

### 7.4 Shipping a phase
The checklist the project follows for every phase:
1. Read the phase spec; verify every named file and symbol against the code; state the plan, including where you'd deviate and why.
2. Implement with tests for each acceptance criterion.
3. `rm -rf dist`, `npm test`, `npm run lint`, `npm run eval` (freeze a baseline under `test/reference/retail-orders/baselines/` when the phase moves a metric).
4. Documents: CHANGELOG entry (with deviations); requirements by ID (status, WHAT/WHY only); technical design (HOW; `npm run docs:generate`); the phase's spec section shrunk to a pointer; roadmap ✅ and decision-log entries; this guide and [manual-verification.md](manual-verification.md) for anything a newcomer or a tester needs to know.
5. Bump the version in `package.json` (once) and `package-lock.json` (twice) by hand — `npm version` reformats `package.json`.
6. Commit and push.

### 7.5 Gotchas
- **Windows line endings.** Most files are CRLF on disk; regexes over them need `\r?\n`. Golden snapshots are LF and marked `-text` in `.gitattributes`.
- **`tsc` leaves stale files** when a module moves — `rm -rf dist` before trusting a test run.
- **`npm install` reformats `package.json`** arrays; check the diff.
- **GitHub push protection** rejects token-shaped strings, even fake ones in tests — build them from fragments at run time.
- **A new spec field needs persistence code.** `SpecManager.serialize()/parse()` are explicit; adding a field to the type alone does not save it.

## 8. Rules that keep AutoDE correct

- **No `vscode` in `src/engine/**` or `src/mcp/**`.** Take what you need as a parameter. (Lint error.)
- **No LLM calls in the engine's decisions or in the MCP server.** The LLM proposes; deterministic code validates, compiles and checks (P1, D5).
- **Never build an `.autode/` path by hand.** Use `LAYOUT` / `layoutPath()` from `src/engine/workspaceLayout.ts`, so the extension, the engine and the MCP server agree.
- **Never edit the graph or the ledger in place.** Append events (assert, supersede, retract, verify); the graph is rebuilt from them.
- **Nothing an LLM produces becomes trusted on its own.** Proposed facts need a person (the Context Inbox; a correction retires the old fact only on confirmation); `verified` needs a probe; tool skills need a review. Exploration mode admits model proposals only at `assumed` trust: never compare trust to `inferred` to mean "model-made", and never let a governed check accept `assumed`.
- **Probes and MCP responses never return row values** without explicit consent, and every outward string goes through `redact()`.
- **Writes are atomic and revision-checked** (`writeFileAtomic`, `RevisionedFile`); an external edit wins a conflict unless the user overwrites explicitly.
- **New dependencies need a recorded decision** (licence, size) in the roadmap's decision log (P6); pin exact versions.
- **Gates live in `AgentHub`,** not only in the UI, and since v0.40.0 in the engine's decision store (`src/engine/decisions/`): a change proposed through MCP is a decision, high-stakes decisions are resolved only through a human channel, and only engine code applies them. Never write a specification, Pipeline Spec, mapping or ledger fact from an MCP tool directly; propose it.
- **Facts use the ledger's gate, changes use decisions.** A fact is recorded `proposed` (`recordChatProposals()` dedups and links corrections) and confirmed by a person; documents, mappings and platform changes are decisions (§7.7). Never confirm a fact from code on a model's behalf.
- **Chat extraction runs after the turn and never fails it** (`extractFromTurn()` never throws); keep it that way.
- **Spec, Pipeline Spec and Mapping Context formats live in `src/engine/documents/problemDocuments.ts`.** The managers and the decision appliers both use it; change serialisation there only.
- **New AI capability is written the new way** (PA1 has shipped): a skill plus deterministic tools ending in a proposal tool. Don't add new flow logic or LLM calls to `src/core` or `src/agents` (PA3 adds a lint rule).

## 9. How to extend AutoDE

Each recipe lists the touch points; the design section has the detail.

**A Tier-2 primitive (no TypeScript).** Add `.autode/config/primitives/<kind>.yaml` (or `primitive-definitions/<kind>.yaml` to ship it) with `kind`, `version`, `status: draft`, `description`, `paramSchema`, `platformTemplates`, `previewParams` (template syntax: `src/engine/transforms/declarative/templateEngine.ts`). Preview it in the panel's Primitives section; publish it with `primitiveManagementEnabled` on. To have an agent offer it, add the kind to that agent's `candidateKinds`. It appears in the MCP server automatically. *Design §9.2, §9.5.*

**An agent.** Since v0.45 an agent is a role template (`agents/<role>.md`: name, description, the AutoDE tools it may use, its skills, its instructions) and its method is a skill (`skills/<id>/SKILL.md`, named after the stage kind it does). Add the role to its stage kind's roles (`src/engine/workflows/stageKinds.ts`); put deterministic help in an MCP tool (`src/mcp/agentTools.ts`) rather than in the prompt; have it record deliverables with `autode_record_artifact` or its stage's document tool; add a test through MCP. *Design §7.9.*

**An LLM provider.** One `LlmAdapter` class plus an entry in `LLM_ADAPTERS` (`src/core/llmProviders.ts`); add the enum value to `activeLlmProvider` in `package.json` and to the guard in `webviewProvider.updateSettings`; a provider card in `sidebar.html`. Tool loops: see the existing adapters and `agenticTools.ts`. *Design §8.*

**A data platform.** An adapter extending `BaseDataSourceAdapter` in `src/engine/platform/adapters/`, a factory and credentials case in `ConnectionManager`, settings in `package.json`, a probe dialect in `probes.ts` if the SQL differs, fields in `connectionsConfig.ts` and `EnvVarCredentialResolver`. If it needs a driver, never add it to `package.json`: describe it in `DRIVERS` (`driverStore.ts`; package, version range, check) and as a prerequisite, and have the adapter take a `loadDriver` function, as `OracleAdapter` does. Users install it with AutoDE's guidance. Check that the guard (`sqlGuard.ts`) understands the dialect's quoting. For onboarding, add the platform to `backendFor()` and `PlatformOnboarding.existing()` (`src/core/platformOnboarding.ts`), its secret fields to `secretFieldsFor()` and `VsCodeSecretStorageResolver`, its per-engineer fields to `PERSONAL_FIELDS`, and a card in `media/sidebar.html` (the onboarding block is injected into every card). *Design §6, §6.13, §6.14.*

**A proposal kind (a change agents may propose).** Add the kind to `DecisionKind` and `stakesFor()` (`decisionStore.ts`), a validator, a describer and an applier in `proposals.ts` (document kinds also in `DOCUMENT_OF`, so supersession works), a tool in `decisionTools()` (`src/mcp/decisions.ts`), a refresh case in `webviewProvider.afterDecisionApplied()`, and a label in the webview's `KIND_LABEL`. *Design §7.7.*

**An MCP tool.** Add an `EngineTool` to `TOOLS` in `src/mcp/tools.ts` (JSON Schema input, annotations, a handler that throws `EngineToolError` for expected failures), or to `platformTools()` in `src/mcp/platform.ts` if it talks to a platform (run SQL only through the `sqlGuard.ts` checks and return rows only through `gateQueryResult()`). Keep it read-only unless the spec says otherwise; add good/bad payloads to the contract test and update [mcp-setup.md](mcp-setup.md). *Design §10.6.*

**A setting.** Declare it in `package.json`, read it in `ConfigurationManager`, add it to `DataAgentHubSettings`, then `npm run docs:generate`. *Design §10.4–10.5.*

**An interview skill.** A `skills/<id>.json` (`id`, `name`, `order`, `description`, `systemPrompt`, `questionGuidance`, `specFields`, `exampleQuestions`); new spec fields also need `specSynthesis` and `SpecManager` changes. It becomes an MCP prompt automatically.

**A webview message.** `vscode.postMessage({ type })` in `sidebar.html` → a `case` in `webviewProvider.handleMessage` → reply with `this.postMessage()`. Reference: technical-design Appendix A.

**A new assertion kind or predicate.** `assertions.ts` (kind), `assertionSchemas.ts` (value schema), projection if it should appear in the graph, conflicts if two values can disagree, packs if agents should see it. Discuss first — kinds are part of the ledger's long-term format.

## 10. Known risks and technical debt

Open items worth knowing before you change things. The roadmap's backlog is the authoritative list.

| # | Risk | Where | Status / direction |
|---|---|---|---|
| R1 | `agentHub.ts` and `webviewProvider.ts` are large (~1 700 and ~2 600 lines) and mix UI, flow logic and LLM calls. | `src/core/` | Resolved by the portable architecture: PA1 moves gates to the engine's decisions, PA3 moves flows into skills over deterministic tools and deletes the old paths. Risk during migration: two implementations of one flow; the rule is one release at most. |
| R2 | Several declared settings do nothing: `readOnlyMode`, `metadataCachingDurationMinutes`, `queryTimeoutSeconds`, `enableSessionReuse`, `autoDocumentationEnabled`, `telemetryEnabled`. `readOnlyMode` implies a guarantee that only phase 4's query guard will provide. | `package.json`, settings UI | Implement or remove; `readOnlyMode` gets real meaning in phase 4. |
| R3 | The interview session is in memory only; a window reload loses it. | `IntakeSession` | BPS-7, planned with C4b. |
| R4 | Tier-1 primitives emit Snowflake-flavoured SQL (`SELECT * EXCEPT`, `CREATE OR REPLACE VIEW`) for every dialect. | `src/engine/transforms/primitives/` | Pinned by golden snapshots; fixed in phase 6 with per-dialect coverage. |
| R5 | Few primitives exist, so most generation still falls back to the LLM. | transforms | Grow Tier-2 definitions; phase 6 adds a conformance suite. |
| R6 | Tool skills have no OS-level sandbox; an approved command can act outside the workspace. Claude Code runs are approved once per run, not per call. | `ToolSkillAgent`, `agenticTools.ts` | Trust tiers (v0.34.0) narrow exposure; treat approval as "I trust this skill". |
| R7 | Chat transcripts grow without limit. | `ChatSessionManager` | Acceptable at current scale; revisit with retention. |
| R10 | The extension still calls the engine in-process; only external agents use the MCP server. | `src/core`, `src/mcp` | Phase 5. |

## 11. Your first week

| Day | Do | You'll understand |
|---|---|---|
| 1 | Read §1–§4 of this guide and requirements.md §1–§2. Build, run `npm test`, F5 into a scratch workspace. | What AutoDE is and the rules it lives by. |
| 2 | Run [manual-verification.md](manual-verification.md) Parts 1, 5 and 6 with Copilot or an API provider; watch `.autode/` fill. | The interview, the ledger, packs. |
| 3 | Read `src/engine/workflows/runtime.ts`, `src/engine/agents/assignment.ts`, then `src/core/agentExecutor.ts`. Run Parts 24–26. | The workflow, assignments and gates. |
| 4 | Read the context-layer core (§6 items 5–8) beside technical-design §5. Run `npm run eval` and read the report. | Grounding, and how AutoDE is measured. |
| 5 | Read the roadmap and the next phase's spec. Pick a small backlog item or a test gap and ship it through §7.4. | The way the project works. |

## 12. FAQ

**Why didn't my chat message get an answer?** A draft spec is waiting: the router sends messages to revision until the spec is approved (§5.2).

**Why didn't the agent use the table I imported?** It may be catalogued but not in the working set, or the pack didn't seed it. Run "What the Agent Saw" — it lists seeds, what was promoted and the gaps.

**Why is a fact still "proposed"?** Nothing an LLM extracts becomes trusted automatically. Confirmation is a person's action (Inbox, C4b); `verified` comes from a probe.

**Why won't my imported skill run?** It hasn't been reviewed, it changed since it was reviewed, it's a draft/deprecated/retired, or it's reviewed (not trusted) and you're on the `claude` provider. The error says which.

**Where do artifacts go?** `autode-output/<problem-id>/<phase>/<specId>.v<n>/`, each with a `.grounding.json` manifest. AutoDE's own state is in `.autode/` (§4.11).

**I opened an old workspace and `.ai-context/` disappeared.** v0.36.0 moved it to `.autode/` (and its artifacts to `autode-output/`) on activation and said so in a notification; commit the move. Anything it didn't recognise stays in `.ai-context/`.

**Can I add a dependency?** Only with a recorded decision (licence, size, why no alternative) — P6. Everything ships bundled.

**The engine needs something from VS Code. What do I do?** Define a small interface in the engine and pass the implementation in from the host (see `FileIo`, `AgentHost`, `CompleteJson`).

**Where do I ask "why is it like this"?** The roadmap's decision log, the specs' "Rejected approaches", and the CHANGELOG's deviation notes — in that order.
