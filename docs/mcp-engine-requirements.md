# AutoDE — MCP Engine & Portable Skill Registry: Requirements Specification

**Status:** In progress — order and status of every phase: [roadmap.md](roadmap.md) · **Baseline:** v0.24.0 (`6f09e62`) · **Companion:** [context-layer-requirements.md](context-layer-requirements.md) · **Document map:** [README.md](README.md)
**Kind:** phase specification — WHAT and WHY for planned work, plus the implementation contract the coding agent builds against. When a phase ships, its WHAT/WHY moves into [requirements.md](requirements.md), its HOW into [technical-design.md](technical-design.md), and its section here shrinks to a pointer.
**Audience:** the coding agent (Claude Code, Gemini, Copilot) implementing this, and the reviewers approving each phase.

---

## 0. How to use this document (instructions for the implementing agent)

1. Implement **one phase at a time** (§9), in order. Each phase is one minor version bump and ends with the acceptance criteria for that phase passing.
2. Before changing a file, read it. Every file and symbol named here exists at the baseline commit; if one does not, stop and report it rather than guessing.
3. Keep `npm test` and `npm run lint` green at the end of every phase. Add tests for every new behavior.
4. Follow existing repo conventions (see [README.md](README.md) and the per-phase workflow in [roadmap.md](roadmap.md)): a `CHANGELOG.md` entry per phase, the affected requirements updated in `docs/requirements.md` (WHAT/WHY, by ID), comment density and naming as in the surrounding code.
5. Anything listed in §10 (Rejected approaches) is out of scope. Do not implement it even if it seems helpful.
6. Where this document says **MUST**, it is a requirement; **SHOULD** is a strong default you may deviate from only with a written reason in the phase's changelog entry.

---

## 1. Product intent — what must not be lost

AutoDE is an **automated data engineering VS Code extension**. The extension is the product: a guided, spec-driven workflow inside the IDE. This work makes its deterministic core *portable and reusable by any coding agent*; it does not turn AutoDE into a headless server with a thin UI.

The end-to-end flow stays exactly as it is today:

```
Business problem (interview, skills/*.json)
  → Business Problem Specification (.autode/problems/<id>/spec/business-problem.yaml, approval gate)
  → Source / Target / Mapping context (approval gates)
  → Pipeline Spec (validated, compiled)
  → Workflow (stages, each with its gate; since v0.45.9 the plan of steps is gone)
  → Deterministic generation (primitives, compiler, templates) → artifacts/
  → Validation & documentation
```

Non-negotiable principles (every phase MUST preserve them):

Defined in [requirements.md §2.1](requirements.md) (P1–P9), which is canonical: P1 the LLM selects and parameterises, never freehands where a primitive exists; P2 the catalog is governed at design time; P3 approval gates enforced by the orchestrator; P4 LLM-agnostic; P5 credentials are pointers; P6 small footprint, offline, no automatic downloads (AutoDE moderates installs the user starts; DRV1), new dependencies need a recorded decision; P7 platform CLIs are optional accelerators; P8 portable by standards (skills over deterministic tools via MCP; the host supplies the model); P9 people decide, machines are deterministic (§3.1).

---

## 2. Problem statement

1. **The skill registry is locked inside the extension.** The real registry — transform primitives (Tier 1 code + Tier 2 YAML `PrimitiveDefinition`s), the Pipeline Spec compiler, interview skills (`skills/*.json`) and imported tool skills (`SKILL.md`) — is reachable only from AutoDE's own panel. Claude Code, Copilot agent mode, Cursor, etc. cannot discover or call it, so when a developer uses those agents directly they fall back to freehand SQL, bypassing P1.
2. **In-memory spec caches go stale.** `SpecManager`, `PipelineSpecManager`, `SourceContextManager`, `TargetContextManager` (and the other context managers) load YAML once in `initialize()` and serve from memory. The only `.autode` watcher (`ContextFileManager.ts:110`) uses the non-recursive glob `.autode/*.{yaml,yml,json}`, so `spec/` and `context/` subfolders are unwatched. If any other process (Claude Code, Copilot, `git pull`, an MCP tool) edits a spec, the extension keeps the old copy and can overwrite the newer file on its next save.
3. **Platform access is coupled to VS Code.** `src/dqm/ConnectionManager.ts`, `dqm/types.ts`, `BaseAdapter.ts`, `adapters/SnowflakeAdapter.ts`, `credentials/index.ts`, `credentials/VsCodeSecretStorageResolver.ts` import `vscode`, so the adapters cannot run outside the extension host.
4. **Packaging (verify):** the build is plain `tsc` and `.vscodeignore` excludes `node_modules/**`, so a packaged VSIX likely ships without `ajv` and `yaml`. Confirm with `npx vsce ls`. Phase 3's bundling fixes this regardless.
5. **Version drift:** `package.json` says `0.13.0` while `docs/technical-design.md` is at v0.24.0. Phase 1 MUST align `package.json` to the documented version before bumping.

---

## 3. Target architecture

```
┌──────────────────────────── AutoDE VS Code extension (the product) ────────────────────────────┐
│  UI: webview panel, custom editors, QuickPick commands, approval dialogs                        │
│  Orchestration: agentHub (interview → spec → plan → approval → execute), agents/, spokes/       │
│  LLM adapters: vscode.lm · Claude Code CLI · API providers  (unchanged)                         │
│  Host-only: SecretStorage, settings, file watchers, ArtifactWriter                               │
│                                                                                                  │
│  EngineClient ──(MCP JSON-RPC over stdio)──┐                                                     │
└────────────────────────────────────────────┼─────────────────────────────────────────────────────┘
                                             ▼
┌──────────────── autode-engine (dist/mcp-server.js, bundled INSIDE the VSIX) ────────────────────┐
│  src/engine/**  — pure TypeScript, ZERO `vscode` imports (lint-enforced)                         │
│   • Registry: transform primitives (Tier 1 + Tier 2), interview skills, tool skills              │
│   • Pipeline Spec: validator, compiler, design-doc generator                                     │
│   • Platform: adapters, REST/CLI execution backends, credential resolvers (env, CLI config)      │
│   • Context store: .autode YAML read/write with revision checks                              │
│  src/mcp/server.ts — exposes the engine as MCP tools, prompts and resources                      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲                                   ▲                                   ▲
        │ same server, launched by:         │                                   │
   Copilot agent mode               Claude Code (.mcp.json)            Any MCP client (Cursor, etc.)
   (registered by the extension)    (written by an AutoDE command)
```

Key decisions (each was weighed; change only with reviewer sign-off):

- **D1 — One repository, one package, two entry points.** `src/engine/` + `src/mcp/server.ts` live in this repo and build into `dist/mcp-server.js` alongside `dist/extension.js`. The boundary is enforced by lint, not by package structure. A separate npm package can be published from the same source later without moving code.
- **D2 — Ship the server inside the VSIX; run it on VS Code's own Node.** Spawn with `process.execPath` and `ELECTRON_RUN_AS_NODE=1`. No per-OS binaries, no download, no code-signing burden. External clients run the same file with `node`.
- **D3 — The extension uses the engine through MCP too.** One code path means what Claude Code sees is exactly what the panel uses, and contract tests cover both. stdio IPC cost (milliseconds) is negligible next to LLM calls.
- **D4 — Registry tools are generic, not one tool per primitive.** The registry is meant to grow large; one MCP tool per primitive would flood every client's context. Clients use search → describe → compile (§5.1). (Optional later setting: expose per-primitive tools when the catalog is small.)
- **D5 — Reasoning stays with the client.** The MCP server performs no LLM calls. Spec synthesis, planning and interviewing remain in the extension (via its LLM adapters) or in whichever coding agent is connected. The server is deterministic.


### 3.1 Target architecture from v0.40.0: standard skills, deterministic tools, human decisions

*Decided 2026-10-18 (roadmap decision log, "portable architecture"). It keeps D1, D4 and D5, amends D2 and D3, and replaces the part of §3 that keeps orchestration and LLM calls inside the extension for good. Phases PA1–PA4 (§9.2) and phase 5 implement it.*

AutoDE stays a first-class VS Code product, and becomes usable from any coding agent that speaks MCP and, where the host supports it, Agent Skills: Claude Code, Codex, Cursor, Cline, JetBrains hosts. It works through files, MCP and a CLI until a native UI for another host is built on the same engine. Principles (requirements P8, P9):

1. **Skills are standard.** Every AI capability, built-in or imported, is an Agent Skill: a `SKILL.md` with instructions and optional scripts and resources. There is no AutoDE-specific skill format, and a ported skill is never split by hand into deterministic and AI parts.
2. **Tools are deterministic** (D5). The engine's MCP tools read, compute, check and compile; no model runs inside them.
3. **A change to AutoDE's state is a proposal.** A tool that would change a specification, mapping, model, plan, artifact, the ledger or a data platform validates its input deterministically and creates a **pending decision**. Engine code applies it only after the decision is approved.
4. **The host supplies the model.** The engine holds no model credentials. A skill's reasoning runs in an *executor*:
   - **VS Code in-process:** the extension's LLM adapters, with the skill's `allowed-tools` enforced by AutoDE.
   - **Host agent:** any MCP client whose agent loads the skill and calls AutoDE's tools; works in every host.
   - **MCP sampling:** used only when the client declares it, and only for the engine's own judgement steps (e.g. analysing a skill to port, PA4).
5. **The workspace is the source of truth.** Specifications, ledger, connections and decisions are files under `.autode/`. The extension, any MCP client, the CLI and git all see the same state.

```
 Hosts (each brings its own model and agent loop)
   VS Code (rich panel, own chat, in-process executor) · Claude Code / Codex (skills + MCP)
   Cursor / Cline / JetBrains … (MCP; skills where supported) · CI and terminals (autode CLI)
          │ MCP (the extension too, from phase 5)                     │ CLI
          ▼                                                           ▼
 AutoDE engine (one package, host-neutral, no model credentials)
   AutoDE skills pack (built-in SKILL.md) · imported skills (reviewed, trusted)
   deterministic tools · proposal tools → decision store → apply on approval
   context layer · primitives and compile · platform adapters, guard, consent
          │
   .autode/ files (specs, ledger, connections, decisions)
```

Further decisions:

- **D6 — Decisions have stakes, and stakes decide who may resolve them.** A *low-stakes* decision (accept a vocabulary synonym, a documented fact) may be resolved through an MCP tool; the tool is annotated destructive, so the host asks its user. A *high-stakes* decision may be resolved only through a channel that needs a person:
  - the VS Code panel;
  - the CLI with an interactive terminal;
  - a committed decision file, reviewable in a pull request.

  High-stakes decisions are a specification or Pipeline Spec, a mapping set, a data model, a plan, generated artifacts, and anything that would write to a data platform. A non-interactive run (CI, no terminal) never resolves a decision; it is strictly deterministic.
- **D7 — The engine ships on its own as well** (amends D2). An `autode` package holds the engine, the MCP server (`autode mcp`, at a path that doesn't change with extension updates), the CLI and the skills pack. The VSIX bundles the same build. Publishing it to a registry is the owner's decision when PA2 ships.
- **D8 — AutoDE's own capabilities are AutoDE skills over deterministic tools** (amends D3 and §7.3). The built-in agents (`src/agents/**`) are re-expressed once, by us: their prompts become skill instructions and their deterministic code becomes tools. The extension runs these skills in-process. A host agent runs the same skills against the same tools, so behaviour can't drift between hosts.
- **D9 — No per-host plugins.** MCP and Agent Skills are the portability layer. A host needs, at most, configuration and a copy of the skills pack in its skills folder. A native UI for another host is built fresh on the engine when one is needed.

**Known limit.** A skill's `allowed-tools` is enforced only where AutoDE runs the loop (VS Code, the CLI). In another host, the host's own tools run, and only AutoDE's decision gate protects AutoDE's state. PA4's capability report says so for every skill that writes or executes.

---

## 4. Engine boundary (`src/engine/`)

### 4.1 What moves into `src/engine/` (already `vscode`-free at baseline — move, fix imports, no logic changes)

- `src/core/transforms/**` (registry, primitives, declarative/, platformDialect)
- `src/core/pipelineSpec/**`
- `src/core/skillRegistry.ts`, `src/core/toolSkills.ts`
- `src/context/Yaml.ts`, `src/context/fileIngestion.ts`, `src/context/ContextValidator.ts`
- `src/dqm/executionBackends/**`, `src/dqm/adapters/DatabricksAdapter.ts`, `src/dqm/adapters/snowflakeJwt.ts`
- `src/dqm/credentials/**` except `VsCodeSecretStorageResolver.ts` and the `vscode`-dependent part of `index.ts`
- The engine-relevant parts of `src/core/types.ts` (split into `src/engine/types.ts`; `core/types.ts` re-exports so existing imports keep compiling)

Move via `git mv` so history is preserved. Leave a one-line re-export at each old path for one phase only if needed to keep the diff reviewable; remove the shims at the end of Phase 2.

### 4.2 What must be split

| File | `vscode` dependency | Required change |
|------|---------------------|-----------------|
| `dqm/types.ts` | `vscode.CancellationToken`, `vscode.Disposable`, `vscode.Uri` | Replace with `AbortSignal`, a local `Disposable { dispose(): void }`, and string paths. |
| `dqm/BaseAdapter.ts` | `persistSchemaContext(..., vscode.Uri)` | Move persistence out of the adapter into the context store (§4.3); the adapter returns `SchemaSnapshot` only. |
| `dqm/ConnectionManager.ts` | implements `vscode.Disposable`; `persistSchemaContext` | Engine `ConnectionManager` is host-agnostic; settings come in as a plain `ConnectionConfig` object. |
| `dqm/adapters/SnowflakeAdapter.ts:87` | reads `dataPlatformCliConsent` from VS Code settings | Receive `cliConsent: boolean` via constructor/config. |
| `dqm/credentials/index.ts` | `registerDefaultCredentialResolvers(secrets: vscode.SecretStorage)` | Engine registers env + CLI-config resolvers only. SecretStorage stays in the extension (§6). |

### 4.3 Context store

Add `src/engine/context/ContextStore.ts`: node-`fs` based read/write for `.autode/**` with:
- `read(relPath) → { data, revision }`, where `revision` is a SHA-256 of the file bytes.
- `write(relPath, data, expectedRevision)` — writes atomically (temp file + rename, as `ArtifactWriter` already does) **only if** the on-disk revision still equals `expectedRevision`; otherwise throws `RevisionConflictError` with both revisions.
- The existing extension managers (`SpecManager`, `PipelineSpecManager`, `SourceContextManager`, `TargetContextManager`, `MappingContextManager`, `SemanticLayerManager`) keep their public APIs and UI behavior, but their parsing/versioning/archive logic SHOULD move behind this store so the server and the extension write `.autode` the same way.

### 4.4 Enforcement

- `.eslintrc.cjs`: `no-restricted-imports` banning `vscode` in `src/engine/**` and `src/mcp/**`.
- A test that `require`s `dist/mcp-server.js` in plain Node (no VS Code) and completes an MCP `initialize` handshake.

---

## 5. MCP surface

Server name `autode`, version = extension version. Transport: **stdio** only (§10). All tool names are `snake_case` with an `autode_` prefix, matching the existing `autode_read_file` convention in `agenticTools.ts`. Every tool declares MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).

### 5.1 Tools — skill / primitive registry

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `autode_search_primitives` | `query?: string`, `platform?: SqlDialect`, `includeDeprecated?: boolean` | `[{ kind, version, description, status, platforms }]` | Filters `listPrimitives()`; excludes non-selectable (`isSelectable`) by default. |
| `autode_describe_primitive` | `kind`, `version?` | `{ kind, version, description, paramSchema, platforms, previewParams }` | `paramSchema` is the Ajv schema verbatim — clients use it to build params. |
| `autode_validate_transform` | `{ kind, params, primitiveVersion? }` | `{ valid, errors[] }` | Wraps `validateTransformSpec`. Read-only. |
| `autode_compile_transform` | `{ kind, params, primitiveVersion? }`, `target: TargetEnvironmentSummary`, `dialect: SqlDialect` | `CompiledArtifact` | Wraps `compileTransformSpec`. Validates first; never writes files. |

### 5.2 Tools — Pipeline Spec

| Tool | Input | Output |
|------|-------|--------|
| `autode_validate_pipeline_spec` | `path?` (default active spec) or inline `spec` | `PipelineSpecValidationResult` |
| `autode_compile_pipeline_spec` | `path?`, `dialect` | `CompiledEntity[]` (content + suggested relative paths in the output folder, `autode-output/<problem>/03-build/…`) |
| `autode_generate_design_doc` | `path?` | Markdown |

Compile tools return content; they do not write. Writing stays with the caller (`ArtifactWriter` in the extension; the coding agent's own file tools elsewhere), so the server never touches `artifacts/` behind the user's back.

### 5.3 Tools — data platform

| Tool | Notes |
|------|-------|
| `autode_list_connections` | Configured connection ids (e.g. `snowflake:prod`, from `getConnectionId()`), platform, auth mode, role (`source`/`target`). Never secrets. |
| `autode_test_connection` | `connectionId` |
| `autode_list_databases` / `autode_list_schemas` | Wrap `listDatabases()` / `listSchemas()`. |
| `autode_extract_metadata` | `connectionId`, `database`, `schema`, `tables?`, `profile?: boolean` → `SchemaSnapshot`. Row samples off by default. |
| `autode_explain_sql` | Dry run (`EXPLAIN` on Snowflake/Databricks). Read-only. |
| `autode_execute_query` | `connectionId`, `sql`, `maxRows` (default 100, hard cap 10 000). **Read-only by default**: rejects anything except `SELECT` / `WITH` / `SHOW` / `DESCRIBE` / `EXPLAIN`, using a tokenizer that strips comments and rejects multiple statements. Write statements require the server to be started with `--allow-write` (the extension passes it only when the existing `autoDataEngineeringHub.readOnlyMode` setting is `false`; default is `true`) **and** `destructiveHint: true` so the client prompts. Document that lexical classification is a guard, not a security boundary — recommend a read-only platform role. |

There is deliberately no vendor-named tool (`execute_snowflake_query` etc.); the platform comes from the connection.

### 5.4 Prompts

- One prompt per interview skill in `skills/*.json`: `autode_interview_<id>` (e.g. `autode_interview_data-flow`). Body = `systemPrompt` + `questionGuidance` + `exampleQuestions`, with an optional `answers_so_far` argument. This lets any client run the same requirements interview.
- One prompt per imported tool skill (`SKILL.md`): `autode_skill_<id>`, body = the skill instructions. **Only skills that are `published` and at trust tier `reviewed` or `trusted` (Phase S2) are exposed**; `unreviewed`, `draft`, `deprecated` and `retired` skills never appear in `prompts/list`. The prompt text states the skill's declared `allowed-tools` so the client can honour them; enforcement inside AutoDE is Phase S1's allow-list.

### 5.5 Resources (read-only)

`autode://spec/business-problem`, `autode://spec/pipeline`, `autode://context/source`, `autode://context/target`, `autode://context/mapping`, `autode://context/semantic-layer`, `autode://primitives/{kind}`. Each resource includes its `revision`, so a client that later edits the file can detect conflicts. The server SHOULD emit `notifications/resources/updated` when a watched file changes. Context-layer tools, prompts and resources (ledger, context packs, semantic model, grounding checks) are specified in context-layer-requirements.md §9 and follow the same contract (§5.6).

### 5.6 Result and error contract

- Success: structured JSON content (`structuredContent` plus a text rendering).
- Failure: `isError: true` with
  ```json
  { "code": "VALIDATION_FAILED | UNKNOWN_PRIMITIVE | CONNECTION_FAILED | AUTH_FAILED | PERMISSION_DENIED | WRITE_NOT_ALLOWED | REVISION_CONFLICT | TIMEOUT | PLATFORM_ERROR",
    "message": "short, human-readable",
    "retryable": false,
    "details": { } }
  ```
- Raw platform output (stack traces, HTTP bodies) is truncated to ≤ 2 000 chars inside `details`, never as the message. Secrets, tokens, private-key material and connection strings MUST be redacted from every response and log line (add a single `redact()` helper and a test that feeds it known secret shapes).

---

## 6. Credentials across the process boundary

- The engine resolves credentials only through its own resolvers: `EnvVarCredentialResolver` (existing `AUTODE_<PLATFORM>_<FIELD>` convention) and `CliConfigResolver` (`connections.toml`, `.databrickscfg`).
- When the **extension** launches the server and a connection uses VS Code SecretStorage, the extension resolves the secret and passes it to the child **only via environment variables** using that same naming convention. Never on the command line, never written to disk.
- When an **external client** (Claude Code etc.) launches the server, it gets env-var and CLI-config credentials only. Document this in the setup guide; do not try to read VS Code's secret store from outside VS Code.
- `autode_list_connections` and all errors expose `CredentialReference` pointers only.

---

## 7. Extension integration

*Superseded in part by phase 5's restructuring (roadmap decision log 2026-10-20): §7.1's child process, §7.3 and the import ban were not built; §7.2's client is in-process; §7.4 and §7.5 shipped. See §9 Phase 5.*

### 7.1 Engine host — `src/core/mcp/engineHost.ts`

- Spawns `dist/mcp-server.js` via `process.execPath`, env `ELECTRON_RUN_AS_NODE=1` plus credential env (§6), cwd = workspace root, args `--workspace <root>` (+ `--allow-write` when permitted).
- **Lazy start** on the first engine call, never during `activate()`.
- Uses `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`.
- On `initialize`, checks that `serverInfo.version` equals the extension version; on mismatch, logs and restarts.
- Restarts on crash with backoff (1 s, 2 s, 4 s, max 3 tries) then surfaces an error in the panel. Disposed on deactivate.
- Server stderr is piped to the existing AutoDE output channel.

### 7.2 Typed client — `src/core/mcp/EngineClient.ts`

A thin typed wrapper (`searchPrimitives()`, `compileTransform()`, `compilePipelineSpec()`, `extractMetadata()`, …) over `client.callTool`, converting the §5.6 error envelope into a typed `EngineError`. Add `engine: EngineClient` to `AgentExecutionContext` (`src/core/types.ts`).

### 7.3 Route existing callers through the client

- `llmParamSelector.ts`, `TransformationScaffolderAgent.ts`, `IngestionPipelineAgent.ts`, `pipelineSpecSynthesis.ts`: registry/compile calls go through `context.engine`.
- `webviewProvider.ts` primitive preview/publish/deprecate, `ensurePrimitivesLoaded`: through the client (publish/deprecate remain host-side governance actions that write via the context store).
- `extension.ts` connection commands, `spokes/snowflakeExecutor.ts`, `SourceAssessmentAgent.ts`: through the client. Remove the direct `ConnectionManager` imports from these files.

### 7.4 Remaining host coupling in agents

- `ToolSkillAgent.ts`: replace the direct `vscode.window.showWarningMessage` and the `extensionContext` cast with a `host` interface on `AgentExecutionContext`: `host.confirm(message, detail) → Promise<boolean>` and `host.workspaceRoot`. Remove `extensionContext` from `AgentExecutionContext` once nothing reads it.
- `SourceAssessmentAgent.ts:82`: use `host.workspaceRoot` instead of `vscode.workspace.workspaceFolders`.
- `ToolSkillAgent` MUST also offer the engine's MCP tools (§5.1–5.3) to the model alongside the existing `READ_ONLY_TOOL_SPECS` / `WRITE_TOOL_SPECS`, so an imported skill can call primitives rather than write SQL. Write-capable engine tools follow the existing `ToolExecutionMode` gates and audit log (`ToolCallAuditEntry`), **and** the skill's `allowed-tools` allow-list and trust-tier mode ceiling (Phases S1/S2): an engine tool the skill did not declare is filtered out, and a `reviewed` (not `trusted`) skill never receives write-capable engine tools.

### 7.5 Exposing the server to other agents

- **Copilot / VS Code agent mode:** register the server with `vscode.lm.registerMcpServerDefinitionProvider` and the matching `contributes.mcpServerDefinitionProviders` entry. Raise `engines.vscode` to the minimum version that provides this API, and feature-detect at runtime so older hosts degrade gracefully.
- **Claude Code / other clients:** new command `AutoDE: Configure MCP for Claude Code` that merges an `autode` entry into the workspace `.mcp.json` (create if missing; never drop other entries; show the diff and ask before writing). Because the extension install path changes on every update, on activation copy `dist/mcp-server.js` to a stable location under `context.globalStorageUri` (only when the version changed) and point the config there. Use `node` if it is on `PATH`, else the VS Code executable with `ELECTRON_RUN_AS_NODE=1` in the entry's `env`.
- Add `docs/mcp-setup.md` with copy-paste configs for Claude Code, VS Code (`.vscode/mcp.json`) and Cursor.

---

## 8. Spec state synchronization (Phase 1 — a live bug today)

1. Replace the watcher in `ContextFileManager.ts:110` with a recursive one: `new RelativePattern(workspaceRoot, '.autode/**/*.{yaml,yml,json}')`. Keep the existing debounce.
2. Route change events by path to a new `reload()` on each affected manager: `SpecManager`, `PipelineSpecManager`, `SourceContextManager`, `TargetContextManager`, `MappingContextManager`, `SemanticLayerManager`. `TargetConfigManager` already has its own watcher — leave it. `ActiveProblemManager` reads from disk on every call and needs no cache invalidation, but a change to its pointer file MUST trigger the existing active-problem switch flow.
3. Each manager records the revision (§4.3) of what it loaded. Every save goes through compare-and-swap. On `RevisionConflictError`, show: *"<file> changed on disk since AutoDE loaded it."* with **Reload** (discard in-memory edits) and **Overwrite** (explicit, logged) actions. Never overwrite silently.
4. Ignore watcher events caused by AutoDE's own writes (compare the event file's revision with the last revision written by this process).
5. After a reload, push refreshed state to the webview (the same path `refreshSettingsInWebview()` uses for settings).
6. `executePlan()` records the spec revisions at start. If an approved spec changes mid-run, finish the running step, pause, and tell the user that later steps would run against a changed spec. Reuse `ArtifactStalenessScanner` to flag artifacts generated from the older revision.

Until this phase ships, the MCP server MUST NOT be given write access to `.autode/`.

---

## 9. Phases and acceptance criteria

### 9.0 Combined roadmap

The order, version and status of every phase — this spec's, the context-layer spec's, and the carried-forward ones — live in one place: [roadmap.md](roadmap.md). Implement in that order; each phase is one minor version. Phase identifiers: `1`–`6` (this spec), `C1`–`C6`, `C4a`/`C4b` and `K1`/`K2` (context-layer spec §11), `S1`–`S3`, `DRV1`/`DRV2` and `GOV` (§9.1 below). `DRV` and `GOV` were called D and G until 2026-10-15; they were renamed because those letters also name older, unrelated work (the v0.9.0 tool-skills "Phase D", and an unbuilt "Phase G" context-memory item).

### 9.1 Carried-forward phases (S1, S2, DRV1/DRV2, GOV, S3)

These come from the earlier AutoDE plans:
- Phase 4, "Skill Onboarding, Versioning & Governance" (becomes S1–S3).
- Phase 3b-iv, opt-in driver acquisition and platform onboarding (becomes D).
- Phase 6, "Governance/DQ-as-Code" (becomes G).

Their detailed designs still apply, except where this document overrides them: the engine boundary, MCP exposure, and no automatic downloads.

#### Phase S1: Tool-skill execution on every provider + `allowed-tools` enforcement
Scope:
- **One dispatch for all providers.** Replace `runOnClaude` / `runOnCopilot` in `src/agents/build/ToolSkillAgent.ts` with a single call through `getLlmAdapter(provider).complete(...)`. Extract `AgentHub.buildLlmContext()` so `ToolSkillAgent` can construct it. The Claude Code CLI path keeps its whole-run confirmation, because no per-call audit is possible there, and the confirmation text says so.
- **Allow-list filter.** Add `filterToolSpecsByAllowList(specs, declaredTools)` to `src/core/agenticTools.ts`.
  - An alias table maps `Read`, `Write`, `Bash`, `Grep` and `Glob` to the `autode_*` tools.
  - Unknown names are dropped.
  - Absent or empty `declaredTools` means no extra restriction.
  - Thread `allowedToolNames?: string[]` through `LlmCompleteOptions` and every adapter's `toolSpecsForMode(...)` call site in `llmProviders.ts`.
- **Mode ceiling.** Add `resolveToolExecutionMode(skill)` in `ToolSkillAgent`; S2's trust tiers extend it.
- **Dead `systemPrompt` field.** `SkillDefinition.systemPrompt` is parsed by `skillRegistry.ts` but never used. Wire it into the interview prompt in `specOpsPrompts.ts`. §5.4 exposes it over MCP, so the in-app and MCP paths must behave the same.

Acceptance:
- A tool skill runs with a full `ToolCallAuditEntry[]` on copilot and on at least one of openai/anthropic/gemini/ollama, with no `SKILL.md` changes.
- A skill declaring `allowed-tools: [Read]` cannot reach `autode_write_file` or `autode_run_command` on any of the six non-CLI providers. A test asserts on the filtered tool list.
- A skill with no declared tools behaves exactly as before.
- An interview turn's prompt contains the skill's `systemPrompt`.

#### Phase S2: Tool-skill lifecycle, provenance, review and trust tiers
**Status:** ✅ shipped in v0.34.0. What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md SKL-5; HOW: technical-design.md §7.6. The full specification text is in git (this file at v0.33.0).

In short: AutoDE keeps a sidecar per imported skill (status, version, provenance with a content checksum, trust tier) and never touches `SKILL.md`. A skill runs only after an engineer has reviewed it — *reviewed* caps it at read-only tools and keeps it off the Claude Code path, *trusted* allows writes, commands and Claude Code — and trust is tied to the content that was reviewed. With lifecycle management on, skills are published as numbered versions, deprecated or retired; a pinned version still runs after deprecation. Only published, reviewed or trusted skills are eligible for MCP `prompts/list` (§5.4).

#### Phases DRV1 and DRV2: moderated driver installation, Oracle, platform onboarding

*Rewritten 2026-10-16 (roadmap decision log). The earlier text had AutoDE fetch `snowflake-sdk` / `@databricks/sql` tarballs from a registry and verify their hashes itself. That doesn't hold: each is a dependency tree, not a tarball (together ~120 MB, including the full AWS/Azure/Google SDKs and native per-OS binaries; technical-design §6.9). Making it work would mean writing an npm installer and shipping native code. Those two platforms also gain little over CLI + REST. The roadmap's reason for the phase is legacy sources, which the old text didn't cover.*

**Principle: AutoDE moderates, it does not distribute.** AutoDE bundles, hosts and downloads no driver. For each platform it knows the **prerequisites** (a platform CLI, a driver package, a client library). For each one it can detect it, say why it is needed, give the exact install step, and verify the result. The install runs only when the user clicks, as a visible command in an AutoDE terminal, using the user's own tools. For npm packages this is `npm` with the user's own `.npmrc`, so internal registries (Artifactory, Nexus), proxies, registry authentication and lockfile integrity work exactly as they do for the user's other projects. P6 holds by construction: nothing heavy or native enters AutoDE's package, and nothing downloads unless the user starts it.

##### Phase DRV1 (v0.38.0): prerequisites, moderated install, Oracle as a source
**Status:** ✅ shipped in v0.38.0. What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md PLT-1, PLT-7; HOW: technical-design.md §6.13; setup: [mcp-setup.md](mcp-setup.md) (Oracle). The full specification text is in git (this file at commit 77d02c3).

In short: a prerequisite model per platform (CLI, driver, client library: detect, why, install step, verify), the driver store (`~/.autode/drivers` or the `driversDirectory` setting, shared with the MCP server), an `npm install --ignore-scripts` command run in a visible AutoDE terminal only on the user's click, a verification record bound to the lockfile, and Oracle 12.1+ in Thin mode as a source: tnsnames aliases or Easy Connect, ALL_* metadata with primary and foreign keys, Oracle probes and q-quote-aware read-only guard, in `connections.yaml`, the MCP tools and the extension's connection flow.

##### Phase DRV2 (v0.39.0): platform onboarding in the settings cards
**Status:** ✅ shipped in v0.39.0. What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md PLT-7, PLT-8; HOW: technical-design.md §6.14; setup: [mcp-setup.md](mcp-setup.md) (Data platforms). The full specification text is in git (this file at v0.38.0).

In short: no separate "Data Platforms" tab (decided with the owner, 2026-10-18). Each platform card in the Source and Target tabs shows its prerequisites with Install / Verify, the backend it will use with that backend's caveat, and the existing CLI connections, Databricks profiles or tnsnames aliases. **Save as named connection** connects first and writes only if the check passes: shared fields to `.autode/config/connections.yaml`, personal ones to the gitignored `.autode/local/connections.yaml`, and secrets to VS Code's secret storage under the new `resolver: vscode`, which an MCP server reads from same-named env variables. A **Saved connections** list per tab shows readiness for AutoDE and for MCP clients separately (per machine, bound to the entry), with Use, Re-check and Remove. Connect resolves a named connection through the credential resolvers, as the MCP server does. There is an Oracle source card; Oracle as a target is not offered. The existing Snowflake and Databricks flows are unchanged.

**Not planned:** `snowflake-sdk` and `@databricks/sql` as a backend tier. Reconsider them as moderated installs if an engagement is blocked because the Snowflake SQL API is restricted and no CLI is allowed.

#### Phase GOV: Governance-as-code
Built in the §3.1 style (scheduled after PA4): the governance interview is an AutoDE skill, and sensitivity flags reach specs and Pipeline Specs through proposal tools and decisions.

Scope (from the earlier Phase 6 plan):
- `src/engine/governance/types.ts` (`PiiClassification`, `ColumnGovernance`). Fill in the `governance` block already reserved on each Pipeline Spec entity.
- A `mask` primitive as a Tier-2 `PrimitiveDefinition`, with **non-reversible strategies only** (`hash`, `redact`). `tokenize` is out of scope because it needs an external vault.
- Optional `sensitivityHint` / `governance` fields on `BusinessProblemSpec`, `SourceEntry` and `DataFlow`.
- Governance discovery questions in `skills/*.json`, and a `governanceContent` definition in `context-envelope.schema.json`.
- Governance facts are stored as `business_rule` / `quality_expectation` assertions in the ledger (context spec §4), so they flow into context packs, manifests and grounding checks.

Acceptance:
- A `sensitive-pii` / `hash` entry compiles to deterministic masking SQL for each dialect, covered by the conformance suite.
- Generated artifacts for a flagged entity contain the masking expression.
- A spec without governance still validates.
- The interview raises a governance question when governance guidance is active.

#### Phase S3: Git-URL skill import, docs and starter library
**Absorbed into Phase PA4** (2026-10-18): Git and vendor import, format importers, Update Skill with diffs, the starter library and authoring docs are part of the Port-a-skill step (§9.2). The previous text is in git (this file at v0.39.0).

### Phase 1: Spec state synchronization
Scope: §8, plus the `package.json` version alignment (§2.5).
Acceptance:
- Test: edit `.autode/problems/<id>/spec/business-problem.yaml` externally → `SpecManager.getSpec()` returns the new content within the debounce window.
- Test: external edit, then an AutoDE save of a stale copy → `RevisionConflictError`; the file on disk is unchanged.
- Test: AutoDE's own save does not trigger a reload loop.
- Manual: the panel reflects an external spec edit without a reload of the window.

### Phase 2: Engine boundary and context store
Scope: §4.1, §4.2, §4.3 `ContextStore` (the existing managers delegate their file I/O to it), §4.4 lint rule, §7.4 host interface. No behavior change.
Acceptance:
- `src/engine/**` has zero `vscode` imports; lint rule in place and passing.
- Existing functional tests pass unchanged (beyond import-path updates).
- Plan execution, connection test, source assessment and primitive preview work manually exactly as at v0.25.0.

### Phase 3: MCP server — registry, spec, prompts, resources
**Status:** ✅ shipped in v0.35.0. What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md MCP-1, NFR-5; HOW: technical-design.md §10.6, §10.7; setup: [mcp-setup.md](mcp-setup.md). The full specification text is in git (this file at v0.34.0).

In short: `dist/mcp-server.js`, bundled with esbuild and runnable in plain Node, exposes §5.1 and §5.2 as tools, §5.4 prompts and §5.5 resources, plus the read-only context tools of context-layer §9 (`autode_resolve`, `autode_get_context_pack`, `autode_list_assertions`, `autode_check_grounding`), under the §5.6 error contract with redaction. The extension is bundled the same way and the package ships no `node_modules/`. Contract tests run the bundle over stdio; golden snapshots pin every Tier-1 primitive's output per dialect.

### Phase 4: MCP server — data platform
**Status:** ✅ shipped in v0.37.0. What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md MCP-1, SEC-5; HOW: technical-design.md §6.12, §10.6; setup: [mcp-setup.md](mcp-setup.md) (Data platforms). The full specification text is in git (this file at v0.36.0).

In short: the §5.3 tools over connections defined in `.autode/config/connections.yaml` (pointers and non-secret settings; secrets from env vars or the platform CLI's configuration, §6). `autode_execute_query` runs one statement, read-only unless the server is started with `--allow-write`, behind a lexical guard that reads the SQL under two quoting conventions. Row values — query results, profile minimums and maximums, query-history text — reach a prompt only when the connection's `allowSampleDataInPrompts` is on; personal-data columns are masked when it is. The live acceptance checks (Snowflake CLI and key-pair, Databricks PAT, a machine without CLIs) are in manual-verification.md Part 14.

### Phase 5: Extension as an MCP client; exposure to other agents
**Status:** ✅ shipped in v0.43.0, **restructured** (roadmap decision log 2026-10-20). What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md MCP-1, SKL-2; HOW: technical-design.md §10.9; usage: [mcp-setup.md](mcp-setup.md). The full specification text is in git (this file at commit bc10a2c).

In short: VS Code's agent mode lists AutoDE's tools with no configuration (MCP server definition provider, feature-detected; `resolver: vscode` secrets added only when VS Code starts the server). `.mcp.json` survives extension updates through the installed `autode` or a stable copy in global storage. The extension reaches the engine through an in-process `EngineClient` (MCP over an in-memory transport); imported tool skills get the engine's tools within their `allowed-tools`, mode and trust tier, and PA3's in-process executor uses the same client. Not done, by decision: the lint ban on engine value imports, panel approvals through the MCP tools, rerouting the built-in agents, and a supervised child process. §7 below describes the original plan.

### Phase 6: Skill governance hardening
Scope (S3's import work moved to PA4; publishing a primitive or skill goes through PA1's decisions):
- Add optional `platforms: SqlDialect[]` to `PrimitiveDefinition` (+ `docs/schemas/primitive-definition.schema.json`); `autode_search_primitives` filters by it. Make it visible when a compile falls back to the `default` template for a platform.
- **Conformance suite:** a test that loads every bundled and workspace primitive and, for each declared platform, validates `previewParams` against `paramSchema`, compiles, runs `outputChecks`, and compares with a golden snapshot. Publishing a primitive (`publishPrimitiveDefinition`) MUST run the same checks and refuse to publish on failure.
- **Dry-run before execute:** any plan step that executes SQL against a platform calls `autode_explain_sql` first and fails the step on an explain error.
- **Idempotency:** generated DDL/DML from primitives uses idempotent forms (`CREATE OR REPLACE` / `CREATE ... IF NOT EXISTS` / `MERGE`) where the dialect supports them; add a conformance check (`mustNotContain` on bare `CREATE TABLE` where applicable).
Acceptance: the conformance suite runs in `npm test`; a deliberately broken primitive fixture is rejected by both the suite and the publish path.

### 9.2 Portable architecture (PA1–PA4)

*Added 2026-10-18 for §3.1. Order and versions: roadmap.md. Phase 5 (below) belongs to the same direction.*

#### Phase PA1: Decision store and proposal tools
**Status:** ✅ shipped in v0.40.0. What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md ORC-8, MCP-2, P9; HOW: technical-design.md §7.7; usage: [mcp-setup.md](mcp-setup.md) (Proposing changes). The full specification text is in git (this file at commit 437e7e6).

In short: proposals are validated and become decisions in `.autode/decisions/`. Stakes are defined in the engine and recomputed on every resolution. High-stakes decisions are resolved only in the panel or through a committed decision file; low-stakes ones also through the proposing agent. Approved decisions are applied by engine code, and a decision whose document changed meanwhile is superseded. `autode_execute_query` no longer runs writes: a platform change is proposed, approved and then applied by an `--allow-write` server. The panel's approvals are recorded as decisions. *Changed in v0.41.0 (C4b):* facts go through the ledger's own gate (proposed, then confirmed in the Context Inbox) rather than decision files; decisions remain the gate for documents, mappings and platform changes.

#### Phase PA2: The engine on its own — `autode` package and CLI
**Status:** ✅ shipped in v0.42.0. What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md MCP-3, P9; HOW: technical-design.md §10.8; usage: [cli.md](cli.md) (commands, exit codes) and [mcp-setup.md](mcp-setup.md) (per-host set-up). The full specification text is in git (this file at commit fd73fff).

In short: one `autode` package (engine, `autode mcp`, CLI, bundled resources; no runtime dependency) that the VSIX ships as the same `dist/autode.js`. The deterministic commands are `validate`, `compile`, `grounding`, `conformance`, `probe` (report only), `doctor` and `check` (the CI gate). The `decisions` commands are human only (interactive terminal, refused with `CI` set). Exit codes are stable. `AutoDE: Configure MCP for Claude Code` prefers the installed `autode mcp`. The skills pack joins the package in PA3. Publishing to a registry remains the owner's step.

#### Phase PA3 (revised and approved 2026-10-21): planned workflows, agents and skills — the same AutoDE in every host

**Status:** PA3a ✅ shipped in v0.44.0 (CHANGELOG.md; requirements ORC-9; technical-design §7.8). PA3b and PA3c are next.

*Approved by the owner on 2026-10-21; it replaces the PA3 of 2026-10-18. It implements the roadmap decision log of 2026-10-20 and 2026-10-21. The templates and stage kinds are in [workflow-templates.md](workflow-templates.md).*

**Goal.** A data engineer in any host that brings a model gets the same AutoDE process as in VS Code:
- **hosts:** VS Code; Claude Code, Cortex Code and the GitHub Copilot CLI through the plugin; any other MCP client through prompts and tools;
- **what is the same:** the planned workflow, its stages, the agents' reasoning steps, context, checks, gates and deliverables.

Texts differ by model; steps, checks and formats don't. The engine holds no model credentials (§3.1).

##### 1. Layers

| Layer | What it is | Defined in | Run by |
|---|---|---|---|
| **Template** | A stage catalogue for a category (greenfield, modernization, estate merge), with inclusion levels, stage kinds and dependencies | `workflows/*.yaml`, overridden or added per workspace in `.autode/config/workflows/` | — |
| **Workflow instance** | The workflow for one problem: the planning stage's approved output | `.autode/problems/<id>/workflow.yaml` | The engine's workflow runtime (deterministic): **the hub** |
| **Agent** | An assignment: a role template, plus a brief for this stage, approved skills and tools, and a permission tier | Role templates `agents/<role>.md`; the generated brief is stored in the instance | The host's agent loop, or AutoDE's in-process executor in VS Code: **the spokes** |
| **Skill** | A method: how to do a task well | Agent Skills `SKILL.md` folders (bundled pack, reviewed imports) | The same |
| **Tool** | Deterministic work and proposals | AutoDE MCP tools | The engine |

Principles:
- **The runtime decides what comes next.** An LLM decides only how to do a task.
- **Agents never call agents.** No tool returns another agent to run. The runtime dispatches, hub-and-spoke.
- **Methods live in skills, never in generated text.**
- **Every change to AutoDE's state is a proposal or a gate decision** (PA1's stakes model).

##### 2. Templates, stage kinds and the rules a workflow must follow

The **stage kinds**, 17 of them, are fixed in the engine: `specify`, `plan`, `target-context`, `source-assessment`, `conformance`, `quality-rules`, `mapping`, `entity-resolution`, `modelling`, `code-conversion`, `build`, `reconcile`, `validate`, `deploy`, `document`, `platform-setup`, `bi-migration`. Each kind defines:
- the agent roles allowed;
- the permission ceiling;
- what it consumes and produces;
- its default gates;
- its *done when* check.

A template is a catalogue of stages using these kinds. Each stage has:
- **inclusion:** `mandatory`, `default`, `conditional` (`when:` on facts about the spec or estate) or `optional`;
- **dependencies:** `after`, with `(approved)` to wait for the gate rather than completion; `consumes` and `produces`; `repeat: per-source-system` with `join: all | any`.

The language has no conditions beyond `when:`, and no loops. A JSON Schema validates templates (`docs/schemas/workflow-template.schema.json`).

**Rules the engine enforces on every workflow instance:**
- The first two stages are fixed: `specify`, then `plan`.
- Mandatory stages and their gates are present.
- A default or conditional stage that is left out carries a reason. A conditional stage whose condition is false is skipped, with the condition as the reason.
- An **added** stage (one not in the template) uses a known kind and a role that kind allows, and is flagged for the approver.
- Dependencies are acyclic and name known stages, and everything consumed has a producer.
- Each agent's permission tier is at or below its stage kind's ceiling.

##### 3. Planning produces the workflow

1. **Deterministic draft.** When the spec is approved, the engine builds a draft instance from the chosen template:
   - it evaluates `when:` conditions (number of source systems, a contract in the pack, legacy code in the estate, target platform);
   - it expands `repeat` stages per source system;
   - it applies the dependencies.
2. **Planner refinement.** The planner (role `planner`, skill `workflow-planning`) refines the draft from the spec, the context and chat facts:
   - include or drop default and optional stages, with reasons, and add stages;
   - order stages within the dependency rules;
   - write each stage's **task list** (entities to map, tables to build, migration waves; tasks live inside stages);
   - **assign agents**: a role template, a generated brief and the skills and tier for each stage or task.

   It proposes the result with `autode_propose_workflow`.
3. **Checks, then a person.** The engine checks the proposal against §2's rules and refuses it, item by item, if it breaks them. The approver sees it as a **diff against the template and the draft**: added, dropped (with reasons), reordered, and each agent's brief and tier. Approval is the plan gate, with the same channels as other gates (§6).
4. **Re-planning.** A changed spec or new facts lead to a revised workflow, proposed and approved the same way. Completed stages stay done if they remain in the plan; stages that consumed changed outputs become stale (§5).
5. **Changing the template** (for example modernization to estate merge) restarts the workflow after the spec stage, by the owner's decision of 2026-10-21, so that no state is carried over by mistake.

**Choosing the template:** AutoDE suggests one from the spec (each template's `suggestWhen` keywords, the estate's systems and roles). The engineer picks it, or an agent proposes it as a low-stakes decision.

##### 4. Agents: role templates, generated briefs, tiers

- **Role templates** are reviewed and bundled: `business-analyst`, `planner`, `target-architect`, `source-assessor`, `sttm-mapper`, `data-modeler`, `pipeline-engineer`, `documenter`, `context-curator`. Each is a Markdown file stating the role, standing instructions and default skills. A workspace can add or override roles in `.autode/config/agents/`, and review applies (S2) as for skills.
- **An agent for a stage is generated:** the planner writes a **brief** on top of a role template. The brief carries context only: which entities, which constraints, the open questions, what to produce. It never carries the method; that stays in the skills. The brief is stored in the instance and approved with the plan.
- **Grounded tasks only.** A task is valid when:
  - its kind is one its stage kind allows;
  - it uses approved skills and tools only;
  - its output is a known proposal or artifact kind.

  The engine refuses anything else at plan check. No new tool or skill is created at run time; new methods arrive through PA4's reviewed import.
- **Permission tiers** are a predefined range:
  - `read`: context, resolve, grounding, compile, catalog;
  - `propose`: adds proposal tools;
  - `platform-read`: adds query, explain and extraction;
  - `workspace-write`: adds file writes, each approved.

  No tier includes resolving or applying decisions. The planner picks a tier at or below the stage kind's ceiling.
- **Enforcement:** AutoDE enforces tiers and tool lists where it runs the loop (VS Code). In other hosts, the host's own tools are outside AutoDE's control (§3.1 known limit). The decision gates still protect AutoDE's state there, and the docs say so.

Today's TypeScript agents (`src/agents/**`) and orchestration prompts in `src/core` are replaced by these roles and skills:

| Role | Replaces | Default skills |
|---|---|---|
| `business-analyst` | interview, spec synthesis and revision | the six `autode-de-interview-*` parts and `autode-de-specification-authoring` (shipped v0.45.12) |
| `planner` | plan generation, phase inference | `autode-core-workflow-planning` (shipped v0.45.12) |
| `target-architect` | target context questions | `target-context`, `platform-setup` |
| `source-assessor` | `SourceAssessmentAgent`, source context questions | `source-assessment`, `conformance` (shipped v0.45.2); `reconciliation` later |
| `quality-engineer` | (new in v0.45.1: nothing produced quality rules) | `quality-rules` (shipped) |
| `sttm-mapper` | `SttmMapperAgent` | `mapping` (shipped v0.45.2); `entity-resolution` later |
| `data-modeler` | `DataModelerAgent` | `modelling` (shipped v0.45.3) |
| `pipeline-engineer` | `TransformationScaffolderAgent`, `IngestionPipelineAgent`, Pipeline Spec synthesis | `pipeline-build` (shipped v0.45.4; replaces `pipeline-scaffolding`); later `code-conversion-import`, `deployment` |
| `documenter` | `DocumentationAgent` | `documentation` (shipped v0.45.0); `bi-migration` later |
| `context-curator` | chat fact extraction, pack free-text reading, profile and vocabulary proposals | `autode-core-fact-extraction`, `autode-core-document-reading`, `autode-core-vocabulary` (shipped v0.45.13; documents through `autode_pack_reading` and `autode_pack_record_reading`) |

##### 5. The runtime: stages, gates, staleness

- **Stage states:** `pending`, `ready`, `in-progress`, `awaiting-check`, `awaiting-approval`, `done`, `skipped` (with a reason and who skipped it), `stale`.
- **Gates.** `check` runs the stage kind's *done when* automatically. `approve` creates a **gate decision** (high stakes) after the check passes.
- **Gates block promotion, not work.** Drafting ahead of a gate is allowed and recorded, with a warning.
- **Staleness.** When an approved output changes, every stage that consumed it becomes `stale` and needs its check and approval again. This one rule replaces ORC-6's pause-on-change and the artifact staleness scan.
- **No loops.** Re-opening a stage makes everything downstream stale.
- **Panel parity.** The gates `AgentHub` enforces today (ORC-3) move into the runtime, and the panel reads them from there like every other surface.
- **Migration of existing problems:** greenfield problems move to the `greenfield` template, brownfield ones to `modernization`. A one-time draft instance is derived from the documents and approvals they already have, and approved once.

##### 6. Approvals: channels and policy

- **Channels:** the panel; the CLI in a terminal (`autode decisions approve`, `autode workflow approve <stage>`); a committed decision file; and **MCP elicitation**. With elicitation, `autode_request_approval {decisionId}` asks the *user* in the client's UI, which the model can't answer. The answer is recorded on channel `elicitation`, with the client's name. (Approved by the owner, 2026-10-21.)
- **Policy** (`.autode/config/approvals.yaml`, committed): which decision kinds may be approved by elicitation. **Default:**
  - spec, plan or workflow, context, mapping, entity resolution, model, build and artifact gates: *yes*;
  - platform changes, connections and deploy: *no* (panel, CLI or file).

  A client without elicitation gets the exact CLI command or file to use.

##### 7. Interview and session state on disk (shipped v0.45.12)

**Status:** ✅ shipped in v0.45.12, with the business analyst, the interview parts as skills, attachments in the pack and the planner's briefs (§4). What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md BPS-7, BPS-1, SKL-6, ORC-9; HOW: technical-design.md §7.9. The full text is in git (this file at commit 355574c).

In short: `.autode/problems/<id>/interview/state.yaml` holds the questions, the answers with who and where, the coverage, the attachments and the specification it fed. The panel, MCP (`autode_interview_state`, `autode_interview_record_answer`) and the CLI (`autode interview`) continue the same interview; answers need no decision, and the specification stays a proposal and a gate.

##### 8. Executors

- **VS Code (in-process):** runs role templates, briefs and skills with the configured provider (S1's single dispatch). It calls tools through the phase 5 `EngineClient`, enforces tiers and tool lists, and audits every call. `AgentHub` keeps only dispatching from the runtime, progress and the panel's view.
- **Plugin hosts** (Claude Code, Cortex Code, Copilot CLI): the plugin ships the role templates, the skills and an **orchestrator skill**. That skill loops:
  1. `autode_workflow_next` returns the next assignment: stage, role, brief, skills, tier;
  2. the host runs it as a sub-agent with that brief;
  3. `autode_workflow_complete_stage` hands back the result, which the runtime checks.

  Generated briefs always come through the tool, never from plugin files.
- **Other MCP clients:** the same assignments as MCP prompts (`autode_agent_<role>`, filled with the brief), and the workflow as tools.
- **Background fact extraction:** in VS Code it runs after every turn. In hosts it depends on the agent following the `fact-extraction` skill. This is weaker, and documented.

##### 8a. The runner: runbooks, approved by a person, run by the engine (shipped v0.45.6; owner, 2026-10-22)

Everything that changes a data platform runs through one deterministic runner. Agents only write **runbooks**; a person approves them; the engine runs them. No agent runs a platform command, in AutoDE or (with the plugin's hooks, §8b) in a host. The aim is execution that is as easy as clicking through a wizard, including for people who aren't data engineers, without weakening P9.

- **A runbook** (`.autode/problems/<id>/runbooks/<runbook-id>.yaml`, written by `autode_propose_runbook`) holds:
  - title, stage, the reason, and the environment and connection it targets;
  - ordered **steps**, each one of:
    - `sql`: one statement on the connection;
    - `cli`: an argv for `snow` or `databricks`, never a shell string;
    - `bundle`: a Databricks bundle or Snowflake project folder, with its validate and deploy commands;
  - per step: what it is expected to do, its dry run (`EXPLAIN`, `bundle validate`, `--dry-run`), its rollback (a step or a written procedure), and a timeout;
  - a plain-language explanation from the agent, labelled as such.
- **The engine checks it before anyone sees it,** and refuses it item by item:
  - every `sql` step is classified read, change or destructive by the same guard `autode_execute_query` uses;
  - every `cli` step must match the platform's command allowlist, with argument rules (no credentials, profiles by name, paths inside the workspace);
  - the connection and environment must exist;
  - destructive steps need a rollback or a written reason.

  The classification is the engine's, never the agent's.
- **Approval is a decision** (kind `runbook`, high stakes), by a person through the panel or the decision file. The rules come from the team's policy in `.autode/config/approvals.yaml` (the file PA3c extends to gates):
  - who may approve per environment;
  - whether production needs a second approver;
  - which step kinds are allowed per environment;
  - whether unattended runs are allowed: never for production; by default only in dev and sandbox.

  Defaults when the file has none: any person approves in dev, test and sandbox; production needs a person named under `approvers.prod`, and can't run unattended.
- **The runner** (`src/engine/runner/`) is deterministic code. It runs one step at a time, dry run first where a step has one, through the connector for `sql` and through the user's own CLI profile for `cli` and `bundle` (P5: no secret is ever in a runbook). It stops at the first failure, shows the error, and offers the step's rollback. Every action (dry run, run, skip, rollback, stop) is appended to `.autode/problems/<id>/runs/<run-id>.jsonl` with who, when, the redacted command, the exit status, the duration and a truncated, redacted output. The entries are hash-chained so a change is evident, and noted in the workflow history.
- **The wizard (VS Code):** a Runbook tab opened from the stage or the decision. It shows:
  - the environment and approval state;
  - each step with the engine's classification (read, change or destructive), its expected effect, its dry-run result and its rollback;
  - the explanation;
  - buttons: Approve (when you may), Dry run, Run step, Run remaining (when the policy allows), Roll back, and the log.

  A run needs an approved runbook; it is the only place a platform-changing command executes in AutoDE.
- **Other surfaces:**
  - MCP: agents propose runbooks and read their status (`autode_runbook_status`), never run them;
  - CLI: `autode runbook list | show`, and approval with `autode decisions approve`.

  The interactive terminal runner (`autode run <runbook>`) is in the backlog, by the owner's decision of 2026-10-22. Until it exists, runs happen in VS Code. This is a deliberate exception to surface parity.
- **Stages:** the deploy and platform-setup stages produce runbooks, and are done when their run succeeds. `autode_apply_decision` keeps working for single platform-change decisions.

##### 8b. Platform skills and vendor skills (shipped v0.45.11; owner, 2026-10-22; naming and the catalog shipped in v0.45.5)

**Status:** ✅ shipped in v0.45.11. What changed and the deliberate deviations: CHANGELOG.md; WHAT/WHY: requirements.md SKL-8, ORC-10; HOW: technical-design.md §7.9 (Platform skills); usage: [platform-skills.md](platform-skills.md). The full specification text is in git (this file at commit 74fee3c).

In short: twelve AutoDE skills (Snowflake and Databricks ingestion, pipelines, governance, performance, deployment; dbt; reconciliation), each with a worked example on the reference problem that `npm test` checks against the estate, the platform's dialect and the runbook checks. They are chosen by stage kind and target platform (dbt also by the transformation tool). Vendor skills are referenced, never copied: named when installed, listed with a person's install step when not. The plugin's guard hook blocks platform-changing `snow`/`databricks` commands in hosts with hooks; elsewhere it is a convention.

##### 9. Tools added

- **Workflow:** `autode_workflow_templates`, `autode_workflow_status`, `autode_workflow_next`, `autode_workflow_start_stage`, `autode_workflow_complete_stage`, `autode_workflow_skip_stage` (default and optional stages only), `autode_workflow_reopen_stage`, `autode_propose_workflow`, `autode_request_approval`.
- **Deterministic helpers for the roles:**
  - `autode_match_columns`: candidate column matches by name, type, vocabulary and past approved mappings;
  - `autode_draft_model`: a draft model from grain and keys (shipped v0.45.3, with `autode_check_model`, which checks it and renders the DDL);
  - `autode_primitive_candidates` (shipped v0.45.4, with `autode_record_pipeline_spec`);
  - `autode_reconcile_plan`: reconciliation queries by key, read-only (shipped v0.45.11).
- **Proposals:** `autode_propose_model` (not built: since v0.45.0 a stage's deliverables are drafts approved at its gate, v0.45.3), `autode_propose_artifacts` (built as `autode_record_artifact`, v0.45.0) (gives artifacts written in any host grounding manifests), `autode_propose_entity_resolution`, `autode_propose_quality_rules`.
- **Interview:** `autode_interview_state`, `autode_interview_record_answer` (shipped v0.45.12); also `autode_workflow_draft` for the planner.
- **CLI:** `autode workflow templates | status | next | approve <stage> | skip <stage> --reason | reopen <stage>`, and `autode plugin install --host claude|cortex|copilot [--scope project|user]`, `autode plugin path`.

##### 10. The plugin folder

`dist/plugin/autode/` is generated from the single source in `agents/`, `skills/` and `workflows/`, and ships in the `autode` package and the VSIX:
- `.claude-plugin/plugin.json` (Claude Code; Cortex Code reads this layout too) and `plugin.json` (Copilot CLI);
- `.mcp.json`, wiring `autode mcp --workspace .`;
- `agents/<role>.md` and `agents/<role>.agent.md`, the role templates;
- `skills/<id>/SKILL.md`, including the orchestrator skill;
- `commands/`: `/autode-status`, `/autode-next`, `/autode-approve`.

Manifest checks per host run in `npm test`. Cortex Code's agent file details are verified when this is built.

##### 11. Releases

| Version | Part | Contents |
|---|---|---|
| v0.44.0 | **PA3a: templates and runtime** | Stage kinds; the three templates (workflow-templates.md) and their schema; the runtime and instance file; §2 rule checks; the deterministic draft; staleness; gate decisions; gates moved out of `AgentHub` (the panel reads the runtime); migration of existing problems; workflow tools on MCP; `autode workflow` on the CLI; new decision kinds (`gate`, `workflow`, `model`, `artifacts`, `entity_resolution`, `quality_rules`). Today's agents still do the stage work in VS Code, and the deterministic draft stands in for the planner. |
| v0.45.0 | **PA3b: roles, briefs, skills** | Role templates and the skills pack; the planner and generated briefs with tier checks; the deterministic helper tools; the in-process executor; every TypeScript agent replaced and **deleted in the same release**; interview state on disk; agent prompts over MCP; the plugin folder and `autode plugin install`. |
| backlog (was v0.46.0; parked 2026-10-27) | **PA3c: approvals in the host, same outcome measured** | Elicitation approvals and the policy file; host-agent eval (a scripted host, plus cassettes recorded with a real host's model; this closes the backlog item "record cassettes with the host's model"); parity tests in `npm test`. |

PA4 (port a skill) follows PA3c, by the owner's decision of 2026-10-21. GOV, C5, 6 and C6 move back by two versions.

##### 12. Acceptance

**PA3a**
- The templates validate; an invalid template is refused with its errors.
- For the reference problem, the deterministic draft for `modernization` and for `greenfield` matches today's lifecycle stages and gates.
- A proposed workflow that drops a mandatory stage or gate, leaves a consumed artifact without a producer, or contains a cycle is refused with each error.
- A gate can't be approved by an agent. It can be by the panel, the CLI in a terminal, or the decision file.
- Changing an approved mapping marks the model and build stages stale.
- Existing problems migrate with their approvals intact.
- The panel, the CLI and MCP report the same status.

**PA3b**
- The reference problem in VS Code produces the same artifacts and grounding manifests as before, and `npm run eval` doesn't regress.
- A scripted host following only the orchestrator skill and `autode_workflow_next` completes every stage of each template's reference plan with valid proposals.
- A brief that asks for a tool above its tier, or a task of an unknown kind, is refused at plan check.
- No `src/agents/**` remains. A lint rule keeps LLM calls out of `src/core`, except in the executor.
- The plugin installs into each host's documented location and passes its manifest check.
- An interview started over MCP resumes in the panel.

**PA3c**
- An elicitation answer resolves an allowed gate. A kind the policy disallows is refused, naming the channels that are allowed. A client without elicitation gets the CLI command.
- The host-agent eval meets VS Code's thresholds on the reference problem: traps, contract violations, answerability, grounding, plan quality against the expected stages.

#### Phase PA4: Port a skill — a guided step in the panel, no code
Scope (absorbs S3):
- **Sources:**
  - a local folder;
  - a Git URL (shallow clone; file-count and byte caps checked before anything is copied; path-traversal check; `resolvedCommit` recorded);
  - skills shipped in dbt packages.

  `SkillFormatImporter`, with the Agent Skills parser as the default.
- **Analysis.** Deterministic: frontmatter, declared tools, scripts, resources, size, overlaps with installed skills. Model-assisted, presented as a proposal for review, never applied:
  - classification (*knowledge*, usable as context in AutoDE's packs; *procedure*, run by an agent);
  - mapping of the tools the skill mentions to AutoDE tools;
  - external prerequisites (CLIs, MCP servers), reusing DRV1's prerequisite model.
- **Capability report:** what the skill does, which of its actions become approval-gated decisions, what it reads, whether it runs scripts, and the limit of §3.1 for skills that write or execute.
- **Review and trust** (S2, bound to the content checksum), an optional dry run on a sample workspace, then publish. A skill that runs scripts or commands is never published without review.
- **Update Skill** re-fetches, shows a diff and resets trust to unreviewed. Never silent.
- **Optional hardening:** AutoDE may suggest turning a repeated deterministic procedure in a skill into a primitive or tool. The skill works without it.
- **Starter library and authoring guide:** the PA3 pack plus curated examples; authoring docs covering skills, tools and proposals.
- **CLI:** `autode skills import` runs the deterministic analysis and writes the report. Publishing needs a human channel.

Acceptance:
- Importing a fixture skill from a local bare repository produces a report listing mapped tools and prerequisites; the skill stays unpublished until reviewed.
- An oversized or path-escaping repository is rejected before anything is copied.
- A knowledge skill appears as context in a relevant context pack. A procedure skill's state changes reach AutoDE only as proposals.
- Update shows a diff and requires re-approval.
- The whole flow runs from the panel with no code or file editing (a test drives the webview messages).

---

## 10. Rejected approaches (out of scope — do not implement)

| Approach | Why rejected |
|----------|--------------|
| Moving the engine to a separate repository | Shared types (e.g. `SqlDialect` duplicated between `dqm/types.ts` and `transforms/types.ts`) would drift; one repo with a lint-enforced boundary gives the same isolation (D1). |
| Native per-OS binaries (`pkg`, PyInstaller, Go) | `pkg` is archived; binaries are 40–80 MB each, need code signing, and are often blocked on client networks. A bundled JS file on VS Code's Node is a few hundred KB (D2). |
| Downloading the server or CLIs at activation (JIT installer) | Breaks offline / air-gapped clients, slows activation, and introduces an unsigned download-and-execute path. Drivers are installed only by the user, through a command AutoDE shows and runs on request (Phase DRV1), with the user's own package manager and registry. |
| Blocking activation or the panel on `snow` / `databricks` being installed | REST backends need no CLI (P7); detection already exists in `cliDetection.ts` and runs lazily at connection time. |
| Rewriting `skillRegistry.ts` as an MCP client or deleting it | It loads the interview prompt packs; they are exposed as MCP **prompts** (§5.4), and the client lives in `src/core/mcp/`. |
| Making the extension a proxy between Claude Code / Copilot and the server | Both connect to MCP servers directly; the extension is one client among several (§7.5). |
| Vendor-named raw execution tools (`execute_snowflake_query`) | Breaks tool-agnosticism; the connection determines the platform (§5.3). |
| SSE / HTTP transport, Docker image | stdio covers all local clients. A Docker image is a later option and can reuse the same bundle with `docker run -i` over stdio; Streamable HTTP only if a remote/shared deployment is required. |
| Adopting an external agent harness (CUGA, AutoGen, LangGraph, …) | AutoDE's orchestration, approval gates and deterministic core already cover the harness role; adding a Python runtime contradicts P6. With the engine behind MCP, a harness can be adopted later without a rewrite. |
| LLM calls inside the MCP server | Keeps the server deterministic and provider-free (D5). |
| An engine-owned task protocol, with agents redefined as AutoDE workflows of deterministic steps and LLM "tasks" (considered 2026-10-18) | Non-standard: a ported skill would have to be split by hand into tasks, and the result would no longer run in other hosts. Standard skills over deterministic, gated tools give the same guarantee where it matters, at the change of state (§3.1). |
| Plugins or adapters per host (Cursor, Codex, Cline, …) | MCP and Agent Skills are the portability layer (D9); per-host work is configuration, plus a native UI only when one is needed. |
| A CLI or server that calls LLM providers with its own keys | Client networks allow the models their IDE provides; the host supplies the model (§3.1, D5). |
| MCP tools that write AutoDE state or run platform writes directly, even behind a flag | Every change is a proposal a person approves (D6); `--allow-write` turns platform writes into proposals (PA1). |

---

## 11. Documentation deliverables

PA2 adds a CLI reference and per-host set-up; PA3 and PA4 add a skills authoring guide (skills, tools, proposals). Per phase: a `CHANGELOG.md` entry, the affected requirements in `docs/requirements.md` updated by ID (WHAT/WHY only), the HOW in `docs/technical-design.md`, and onboarding-guide updates for the new `src/engine/` / `src/mcp/` layout. Phase 3 adds `docs/mcp-setup.md`. Phase 6 adds a "How to onboard a new primitive" section covering the conformance requirements.
