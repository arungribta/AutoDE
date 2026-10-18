# AutoDE — Engineering Onboarding Guide

> **For:** an engineer joining AutoDE who needs to find their way around, run it, change it safely and ship a phase.
> **Describes:** v0.39.0 (2026-10-18). This guide orients; it does not duplicate. Details live in [technical-design.md](technical-design.md) (HOW), [requirements.md](requirements.md) (WHAT and WHY) and [roadmap.md](roadmap.md) (WHEN), and every section here links to them. The guide is updated when a phase ships, together with those documents. The previous long-form guide (v0.13.0) is in git history.

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

**The mental model in one sentence.** *A governed, spec-driven workflow (interview → specification → plan → generated artifacts), grounded in a ledger of facts about the customer's estate and business, with a deterministic engine underneath that other coding agents can use too.*

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
| How other agents use AutoDE | [mcp-setup.md](mcp-setup.md) | Claude Code, VS Code, Cursor. |
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

dist/mcp-server.js — src/mcp over src/engine: a separate, read-only, LLM-free
process (stdio) for Claude Code, VS Code agent mode, Cursor.
```

Three ideas carry most of the design:

1. **The engine boundary.** `src/engine/**` and `src/mcp/**` never touch the VS Code API, so the same code runs in the extension, the MCP server and plain-Node tests. Host concerns come in as parameters (`FileIo`, `AgentHost`, `CompleteJson`). See technical-design §10.2.
2. **The ledger is the system of record for context.** Facts are append-only *assertions* with status and trust; the graph the agents read is a projection of them, rebuilt, never edited in place. See §4.4 and technical-design §5.3.
3. **Packs, not dumps.** Each LLM call gets a task-scoped *context pack* within a token budget, and every generated artifact gets a *manifest* of what it rested on. See technical-design §5.5–5.7.

**Where the architecture is going (from v0.40.0).** AutoDE is moving to a portable architecture ([mcp-engine-requirements.md §3.1](mcp-engine-requirements.md), phases PA1–PA4 and phase 5 in the [roadmap](roadmap.md)):
- every AI capability becomes a standard agent skill (`SKILL.md`);
- the engine offers deterministic tools;
- a change to AutoDE's state becomes a validated **proposal** that a person approves as a **decision**;
- the host (VS Code, Claude Code, Cursor, Codex …) supplies the model.

VS Code stays the first-class host; other hosts use the same engine through MCP, the skills pack and a CLI. Today's agents and `AgentHub` flows are migrated phase by phase, and a migrated path is deleted in the same release.

Bundling: `tsc` compiles every module to `dist/**` (used by tests); esbuild then bundles `dist/extension.js` and `dist/mcp-server.js`, which are all the package ships (technical-design §10.7).

## 4. Concepts you need

### 4.1 Business problem and its specification
A workspace holds several **business problems** under `.autode/problems/<id>/`; `.autode/local/active-problem.json` says which is current for this engineer. Each has a **Business Problem Specification** (`spec/business-problem.yaml`), versioned and approved by the engineer. Everything downstream keys off the spec's id and version. *Design: technical-design §3.*

### 4.2 Lifecycle gates
Business problem confirmed → spec approved → source/target context approved → plan approved → stage confirmed → execute. The gates are enforced in `AgentHub` itself, not only in the UI — a command that skips a gate throws. *Requirements: ORC-3; design §3.14.*

### 4.3 Phases, plan and agents
Phases (discover, model, build, validate) are inferred **deterministically** from the spec (`src/core/phaseInference.ts`, no LLM). The plan is a DAG of steps, each assigned to an agent (`AGENT_EXECUTORS` in `agentHub.ts`). The planner may only assign known agents; tool skills are never auto-planned. *Design §7.*

### 4.4 Assertions, ledger, trust
An **assertion** is one fact (`schema_fact`, `key`, `grain`, `relationship`, `business_term`, `metric`, `quality_expectation`, `decision`, …) about subjects (object ids), with a **status** (`proposed`, `active`, `needs_review`, `superseded`, `rejected`), a **trust** tier (`verified` > `confirmed` > `documented` > `inferred`) and evidence. The **ledger** (`.autode/knowledge/ledger/*.jsonl`) appends events; folding them gives the current assertions. Graph nodes are **mirrors** of schema assertions. Nothing an LLM proposes becomes trusted without a person (or, for `verified`, a probe). *Requirements CTX-*; design §5.3–5.4.*

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

### 4.10 The MCP server
`dist/mcp-server.js` exposes the engine to other agents: primitives, Pipeline Spec, context tools (`autode_resolve`, `autode_get_context_pack`, `autode_list_assertions`, `autode_check_grounding`), data-platform tools (`autode_list_connections` … `autode_execute_query`, since v0.37.0), interview and reviewed-skill prompts, and resources. No workspace writes, no LLM calls, secrets redacted. Platform connections come from `.autode/config/connections.yaml` plus the personal `.autode/local/connections.yaml` (no secrets; credentials from `AUTODE_*` env vars, the CLI's configuration, or — for `resolver: vscode` entries saved from a settings card — env variables standing in for VS Code's secret storage); queries are read-only unless started with `--allow-write`; row values are withheld unless the connection sets `allowSampleDataInPrompts`. *Design §6.12, §10.6; setup: [mcp-setup.md](mcp-setup.md).*

### 4.11 Where AutoDE keeps things
`.autode/` holds AutoDE's working state, grouped by lifecycle: `problems/<id>/` (spec, plan, context documents, pack — committed), `knowledge/` (ledger, estate, sources, profiles, business context, vocabulary — committed), `config/` (skills, primitives, target environment, connections — committed) and `local/` (active problem, chats, derived graph, catalog — never committed; AutoDE writes `.autode/.gitignore` for it). Generated deliverables go to the visible `autode-output/<problem-id>/` (setting `artifactDirectory`). Every path comes from `src/engine/workspaceLayout.ts`; never build one by hand. A workspace from before v0.36.0 (`.ai-context/`) is moved over on activation (`workspaceMigration.ts`). *Design §2.1–2.2.*

## 5. The main flows

Each flow names its entry point; follow it in the code with the design section beside you.

### 5.1 Activation
`extension.ts#activate` builds `ConfigurationManager`, `AgentHub`, `ConnectionManager`, the sidebar `DataAgentHubWebviewProvider` and the managers, registers the commands and custom editors, and returns. Nothing heavy runs at activation (no MCP server, no LLM call); the context layer loads when the panel opens. *Design §10.1.*

### 5.2 A chat message
`webviewProvider.handleMessage('chat')` routes by state: no active business problem → the **interview**; a draft spec → **revision** of the draft; an approved spec → **grounded chat** with a `chat` pack. Slash commands (`/spec`, `/plan`, `/skill <id>[@<version>]`, `/settings` …) bypass the router. *Design §4.3, §4.8.*

### 5.3 Interview → specification
`AgentHub.discoverNextAction()` runs the SpecOps interview over the bundled skills (`skills/*.json`, overridable in `.autode/config/skills/`), with an `interview` pack and what discovery already established (questions discovery answers are dropped). Synthesis drafts the spec (`specSynthesis.ts`); `SpecManager` persists and versions it. *Design §3.8–3.9.*

### 5.4 Spec → plan → execution
Approve the spec and contexts → `generatePlanFromSpec()` (phase inference, planner LLM call, validation of the plan) → approve the plan → `executePlan()`: per step, refresh the working set, build a `step` pack, run the agent, write artifacts through `ArtifactWriter` under `autode-output/<problem-id>/<phase>/<specId>.v<n>/`, run grounding checks, write the manifest. A changed approved spec mid-run pauses the plan. *Design §7.4, §5.7.*

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
| 5 | `src/context/ContextFileManager.ts` | Loading, ledger sync, catalog and working set, packs. |
| 6 | `src/engine/context/assertions.ts`, `ledger.ts`, `projection.ts` | The context layer's core. |
| 7 | `src/engine/context/contextPack.ts`, `retrieval.ts`, `catalog.ts` | How context reaches an LLM. |
| 8 | `src/engine/grounding/sqlGrounding.ts`, `manifest.ts` | How output is checked. |
| 9 | `src/engine/transforms/registry.ts` + one primitive | Deterministic generation. |
| 10 | `src/agents/build/TransformationScaffolderAgent.ts`, `src/agents/llmParamSelector.ts` | Primitive-first codegen with LLM fallback. |
| 11 | `src/core/llmProviders.ts`, `agenticTools.ts` | Providers and tool loops. |
| 12 | `src/mcp/server.ts`, `tools.ts` | The MCP surface. |
| 13 | `test/functional.test.cjs` (search for the feature) | Executable documentation for nearly everything above. |

Folders at a glance: `src/core` (orchestration, LLMs, settings, spec engine), `src/context` (host-side managers), `src/agents` (step executors), `src/editors` (custom editors for data model, STTM, graph, profile, docs), `src/engine/*` (host-agnostic logic), `src/mcp` (MCP server), `src/spokes` (only `snowflakeExecutor.ts` is live), `media/` (webviews, icons), `skills/` (interview skills), `test/` (tests, eval, reference problem, golden snapshots), `scripts/` (bundler, docs generator).

**Safe to ignore at first:** the AutoDE Dashboard panel (`panel.html`, `panelProvider.ts` — parked), `src/spokes/` other than `snowflakeExecutor.ts`, CSS in `sidebar.html`, `mock_activate.js`.

## 7. Working on AutoDE day to day

### 7.1 Setup and running
```bash
npm install
npm run compile        # tsc to dist/** + esbuild bundles (dist/extension.js, dist/mcp-server.js)
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
- **Nothing an LLM produces becomes trusted on its own.** Proposed facts need a person; `verified` needs a probe; tool skills need a review.
- **Probes and MCP responses never return row values** without explicit consent, and every outward string goes through `redact()`.
- **Writes are atomic and revision-checked** (`writeFileAtomic`, `RevisionedFile`); an external edit wins a conflict unless the user overwrites explicitly.
- **New dependencies need a recorded decision** (licence, size) in the roadmap's decision log (P6); pin exact versions.
- **Gates live in `AgentHub`,** not only in the UI. From PA1 on they live in the engine's decision store: a change proposed by an AI path is a decision, and high-stakes decisions are resolved only through a human channel.
- **New AI capability is written the new way** once PA1 ships: a skill plus deterministic tools ending in a proposal tool. Don't add new flow logic or LLM calls to `src/core` or `src/agents` (PA3 adds a lint rule).

## 9. How to extend AutoDE

Each recipe lists the touch points; the design section has the detail.

**A Tier-2 primitive (no TypeScript).** Add `.autode/config/primitives/<kind>.yaml` (or `primitive-definitions/<kind>.yaml` to ship it) with `kind`, `version`, `status: draft`, `description`, `paramSchema`, `platformTemplates`, `previewParams` (template syntax: `src/engine/transforms/declarative/templateEngine.ts`). Preview it in the panel's Primitives section; publish it with `primitiveManagementEnabled` on. To have an agent offer it, add the kind to that agent's `candidateKinds`. It appears in the MCP server automatically. *Design §9.2, §9.5.*

**An agent.** *Being replaced:* from PA3, a capability is an AutoDE skill (`SKILL.md`) plus deterministic tools, not an agent class. Until then: add the type to `AgentType` (`src/engine/types.ts`); write `execute<Name>(step, context)` under `src/agents/<phase>/`; register it in `AGENT_EXECUTORS`, `VALID_AGENT_TYPES` and `AGENT_PHASE` (`agentHub.ts`) and the planner's allowed list; return artifacts in `result.artifacts`; add a test. Prefer a primitive path with LLM fallback (`llmParamSelector.ts`). *Design §7.2.*

**An LLM provider.** One `LlmAdapter` class plus an entry in `LLM_ADAPTERS` (`src/core/llmProviders.ts`); add the enum value to `activeLlmProvider` in `package.json` and to the guard in `webviewProvider.updateSettings`; a provider card in `sidebar.html`. Tool loops: see the existing adapters and `agenticTools.ts`. *Design §8.*

**A data platform.** An adapter extending `BaseDataSourceAdapter` in `src/engine/platform/adapters/`, a factory and credentials case in `ConnectionManager`, settings in `package.json`, a probe dialect in `probes.ts` if the SQL differs, fields in `connectionsConfig.ts` and `EnvVarCredentialResolver`. If it needs a driver, never add it to `package.json`: describe it in `DRIVERS` (`driverStore.ts`; package, version range, check) and as a prerequisite, and have the adapter take a `loadDriver` function, as `OracleAdapter` does. Users install it with AutoDE's guidance. Check that the guard (`sqlGuard.ts`) understands the dialect's quoting. For onboarding, add the platform to `backendFor()` and `PlatformOnboarding.existing()` (`src/core/platformOnboarding.ts`), its secret fields to `secretFieldsFor()` and `VsCodeSecretStorageResolver`, its per-engineer fields to `PERSONAL_FIELDS`, and a card in `media/sidebar.html` (the onboarding block is injected into every card). *Design §6, §6.13, §6.14.*

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
| R8 | The AutoDE Dashboard panel is stale and parked. | `panel.html`, `panelProvider.ts` | Retire or rewire later (product decision). |
| R9 | Context gaps don't pause steps yet; extracted chat facts don't reach the ledger. | context layer | C4b (Context Inbox). |
| R10 | The extension still calls the engine in-process; only external agents use the MCP server. | `src/core`, `src/mcp` | Phase 5. |

## 11. Your first week

| Day | Do | You'll understand |
|---|---|---|
| 1 | Read §1–§4 of this guide and requirements.md §1–§2. Build, run `npm test`, F5 into a scratch workspace. | What AutoDE is and the rules it lives by. |
| 2 | Run [manual-verification.md](manual-verification.md) Parts 1, 5 and 6 with Copilot or an API provider; watch `.autode/` fill. | The interview, the ledger, packs. |
| 3 | Read `types.ts`, `extension.ts`, then `agentHub.ts` (`generatePlanFromSpec`, `executePlan`). Run Part 7. | Orchestration and gates. |
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
