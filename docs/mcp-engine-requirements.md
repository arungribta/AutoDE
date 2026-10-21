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
  → Plan (DAG of agent steps) → Plan approval + stage confirmation (enforced in agentHub.executePlan)
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

#### Phase PA3 (revised 2026-10-21; DRAFT for the owner's review): workflows, agents and skills — the same AutoDE in every host

*This replaces the PA3 of 2026-10-18. It implements the roadmap decision log of 2026-10-20 (Surface parity; Workflows and agents as definitions). Nothing here is built until the owner approves it. Proposed versions are in "Releases"; the roadmap changes only after approval.*

**Goal.** A data engineer in any host that brings a model gets the same AutoDE process as in VS Code: VS Code itself, Claude Code, Cortex Code, the GitHub Copilot CLI, and, through MCP prompts, any other MCP client. That means the same workflow, stages, reasoning steps, context, checks, gates and deliverables. Texts differ by model; steps, checks and formats don't. The engine holds no model credentials (§3.1).

##### 1. Four layers, each a definition file

| Layer | What it decides | Format and location | Who runs it |
|---|---|---|---|
| **Workflow** | Which stages, in what order, which agent does each, where a person must approve | YAML: bundled `workflows/*.yaml`, overridden per workspace in `.autode/config/workflows/` | The engine's workflow runtime (deterministic) |
| **Agent** | Who does a stage: role, instructions, allowed tools, which skills | Markdown with frontmatter: bundled `agents/*.md`, overridden in `.autode/config/agents/` | The host's agent loop, or AutoDE's in-process executor in VS Code |
| **Skill** | How to do one task, step by step | Agent Skills `SKILL.md` folders: bundled `skills/<id>/`, imported skills as today | The same |
| **Tool** | Deterministic work: read, compute, check, compile, propose | AutoDE MCP tools | The engine |

Rules:
- **The workflow owns the sequence.** An agent does its stage; it doesn't call other agents or skip stages.
- **Agents and skills hold no deterministic logic.** Anything a program can decide is a tool.
- **Every change to AutoDE's state is a proposal or a gate decision**, as today (PA1), with the same stakes model.

##### 2. Workflows

**Bundled workflows:** `greenfield`, `modernization` (previously brownfield; legacy migration) and `estate-merge`. A workspace can copy one into `.autode/config/workflows/`, change it, or add its own. Workflows are versioned: a problem keeps the version it started with until a person moves it to a new one.

```yaml
id: estate-merge
version: 1
title: Merge several source systems into one target
description: Several sources, often with a shared contract, into one model.
suggestWhen: [merge, consolidat, combine, unify, "single view"]   # keywords for the suggestion only
stages:
  - id: problem
    title: Business problem and specification
    agent: business-analyst
    produces: [spec/business-problem.yaml]
    gate: approve-spec                # a person approves before later stages start
  - id: target
    title: Target context
    agent: target-architect
    after: [problem]
    produces: [context/target-context.yaml]
    gate: approve
  - id: sources
    title: Source assessment
    agent: source-assessor
    after: [problem]
    repeat: per-source-system          # one instance per estate system with role source
    produces: [context/source-context.yaml]
  - id: contract
    title: Contract conformance
    agent: source-assessor
    skill: contract-conformance
    after: [sources]
    optional: true
  - id: mapping
    title: Source-to-target mapping
    agent: sttm-mapper
    after: [sources, target]
    produces: [context/mapping-context.yaml]
    gate: approve
  - id: model
    title: Data model
    agent: data-modeler
    after: [mapping]
    gate: approve
  - id: build
    title: Pipeline Spec and build artifacts
    agent: pipeline-engineer
    after: [model]
    produces: [spec/pipeline.yaml]
    gate: approve
  - id: document
    title: Documentation and grounding report
    agent: documenter
    after: [build]
```

**The language stays small:** `after`, `optional`, `repeat: per-source-system`, `gate: approve | approve-spec`, `agent`, `skill` (to override the agent's default skill), `produces`. There are no conditions or loops. A JSON Schema (`docs/schemas/workflow.schema.json`) validates definitions; the runtime refuses an invalid one and names the error.

**The runtime** (`src/engine/workflows/`, deterministic) keeps each problem's state in `.autode/problems/<id>/workflow.yaml`: the workflow id and version, and each stage instance's state (`pending`, `ready`, `in-progress`, `awaiting-approval`, `done`, `skipped` with a reason and who skipped it). It answers:
- **status:** where the problem is, what is ready, what is blocked and why;
- **start / complete a stage:** complete checks the `produces` files exist and validate. A gated stage moves to `awaiting-approval` and creates a **gate decision**;
- **skip:** an optional stage can be skipped with a reason. A gated stage can be skipped only by a person;
- **change workflow:** moving to another workflow or version keeps the stages they share. This is a person's decision.

**Flexibility is kept on purpose:**
- **Gates block only promotion to approved, never work.** An engineer can draft a mapping before the model stage, explore in chat, or ask any agent anything. The runtime records it and warns if an approval is missing; it doesn't refuse.
- **Choosing the workflow:** AutoDE suggests one from `suggestWhen` and the spec, and the engineer picks. An agent may propose one (a low-stakes decision).
- **A stage that turns out to be wrong for this engagement** is skipped with a reason, or the workflow is changed; no code changes are needed.

**What happens to today's model:**
- The four phases become stage groups.
- `ImplementationType` and the keyword phase inference become the workflow suggestion.
- The gates `AgentHub` enforces today (ORC-3) move into the runtime. The panel reads them from there, like every other surface.
- Existing problems are migrated once: greenfield to `greenfield`, brownfield to `modernization`, with stage states derived from the documents and approvals they already have.

**The plan.** Today an LLM writes a plan of steps per phase. With workflows, the stage list is the plan's backbone. Within the build stage, the pipeline engineer proposes the task list (entities, primitives, artifacts) as a `plan` proposal, which a person approves. This keeps "plan approved" and "stages confirmed" as gates, now attached to a stage.

##### 3. Agents

Agent definitions are Markdown with a small, host-neutral frontmatter:

```markdown
---
name: sttm-mapper
description: Maps source tables to the target, column by column, grounded in the estate and the contract.
tools: [autode_get_context_pack, autode_resolve, autode_match_columns, autode_check_grounding, autode_propose_mapping]
skills: [sttm-mapping]
---
You are a senior data engineer mapping sources to a target …
```

Bundled agents replace today's TypeScript agents (`src/agents/**`) and the orchestration prompts in `src/core`:

| Agent | Replaces | Default skills |
|---|---|---|
| `business-analyst` | interview, spec synthesis and revision (`specOps`, `specSynthesis`) | `business-problem-interview`, `specification-authoring` |
| `target-architect` | target context questions | `target-context` |
| `source-assessor` | `SourceAssessmentAgent`, source context questions | `source-assessment`, `contract-conformance` |
| `sttm-mapper` | `SttmMapperAgent` | `sttm-mapping` |
| `data-modeler` | `DataModelerAgent` (`architectureAgent`) | `data-modelling` |
| `pipeline-engineer` | `TransformationScaffolderAgent`, `IngestionPipelineAgent`, Pipeline Spec synthesis, plan generation | `pipeline-planning`, `pipeline-scaffolding` |
| `documenter` | `DocumentationAgent` | `documentation` |
| `context-curator` | chat fact extraction, pack free-text extraction, profile and vocabulary proposals | `fact-extraction`, `document-reading`, `vocabulary` |

Imported tool skills (S1, S2) keep working. They can be used by any agent that lists them, and PA4's port-a-skill flow adds to the same library.

##### 4. Skills and new tools

The **skills pack** is one `SKILL.md` folder per skill in the table above. Each one names the AutoDE tools it uses, ends in proposal tools, and carries its prompt material as resources. The interview prompt packs (`skills/*.json`) become resources of `business-problem-interview`. Skills pass an Agent Skills format check.

**New deterministic tools** for what today's agents do in code:
- `autode_match_columns`: candidate column matches by name, type, vocabulary and past approved mappings.
- `autode_draft_model`: a draft model from grain and keys.
- `autode_primitive_candidates`: primitives and parameter checks for a transformation.
- `autode_propose_plan`, `autode_propose_model`, `autode_propose_artifacts`: the missing proposal kinds. With these, artifacts written by any host get grounding manifests, so *Explain This Artifact* works for them.
- **Workflow tools:** `autode_workflow_list`, `autode_workflow_status`, `autode_workflow_start_stage`, `autode_workflow_complete_stage`, `autode_workflow_skip_stage` (optional stages only), `autode_propose_workflow` (choose or change the workflow).
- **Interview state:** `autode_interview_state`, and answers recorded through a proposal-free tool. See §6.

##### 5. Approvals inside the host (the person channel)

Gate decisions are high stakes, so an agent never resolves them. The channels:
- **VS Code:** the panel, as today.
- **CLI:** `autode decisions approve`, and the new `autode workflow status | approve <stage>` in a terminal.
- **Committed decision file**, as today.
- **New: MCP elicitation.** When the client declares the elicitation capability, `autode_request_approval {decisionId}` asks the *user* directly in the client's UI. The model cannot answer that prompt; the server receives the user's answer. It shows what is being approved (title, a summary, validation, where to read the full proposal). The answer is recorded on channel `elicitation`, with the client's name.

**Policy** (`.autode/config/approvals.yaml`, committed): which decision kinds may be approved by elicitation.
- **Proposed default:** specification, context, mapping, model, plan and artifact gates *yes*; platform changes and connections *no*, so those keep panel, CLI or file.
- A team that doesn't trust a client's elicitation prompt sets it to *no* for everything.
- Where the client has no elicitation, the agent tells the user the exact `autode decisions approve <id>` command or the file to edit.

This is the one real change to PA1's channel model. It rests on the MCP spec's guarantee that elicitation answers come from the user. A client that auto-answers would break it, which is why it's a per-team policy and not hard-wired.

##### 6. Interview and session state on disk

Today the interview's progress lives in the panel's memory, and BPS-7 (survive a reload) is in the backlog. In PA3 the interview state lives in `.autode/problems/<id>/interview/state.yaml`:
- the skill packs covered;
- each question asked and its answer (with who answered, and where);
- what is still open;
- the draft it feeds.

Any surface can resume it, so you can start in Claude Code and finish in VS Code. Answers are the user's statements, not AI inferences, so recording them needs no decision; the specification they produce is still a proposal and a gate. Chat transcripts stay the host's own.

##### 7. Executors — who runs the agents

- **VS Code (in-process executor):** reads the same agent and skill files and runs them with the configured provider (the S1 single dispatch), calling tools through the phase 5 `EngineClient`. `allowed-tools` is enforced and every call audited. `AgentHub` keeps only running agents, progress and the panel's view of the workflow runtime.
- **Host agents** (Claude Code, Cortex Code, Copilot CLI): load the plugin (§8) and call AutoDE's tools. AutoDE can't enforce `allowed-tools` there (§3.1 known limit); the decision gates protect AutoDE's state.
- **Other MCP clients:** the agents are also offered as MCP prompts (`autode_agent_<name>`) and the workflow as tools, so a client without skills or plugins can still be walked through a stage.
- **Background fact extraction:** in VS Code it runs after every turn, as today. In hosts it depends on the agent following the `fact-extraction` skill. This is weaker, and the docs say so.

##### 8. The plugin folder

The build writes `dist/plugin/autode/` and packs it into the `autode` package and the VSIX. It is generated from the single source in `agents/`, `skills/` and `workflows/`:

```
autode/
  .claude-plugin/plugin.json      # Claude Code; Cortex Code reads this layout too
  plugin.json                     # GitHub Copilot CLI
  .mcp.json                       # wires `autode mcp --workspace .`
  agents/<name>.md                # Claude Code / Cortex Code
  agents/<name>.agent.md          # Copilot CLI (same content)
  skills/<id>/SKILL.md            # all three; VS Code Copilot agent mode reads .github/skills etc.
  commands/                       # slash commands: /autode-status, /autode-next, /autode-approve
```

`autode plugin install --host claude|cortex|copilot [--scope project|user]` installs the folder where the host looks for it, and `autode plugin path` prints it. A test checks the manifests against each host's documented fields; the format details for Cortex Code agents are verified when this is built.

##### 9. What each surface gets (target state)

| Task | VS Code | Claude Code / Cortex / Copilot CLI (plugin + MCP) | Other MCP clients | CLI |
|---|---|---|---|---|
| Choose the workflow, see status, next step | panel | `/autode-status`, tools | tools | `autode workflow status` |
| Interview → spec | panel (in-process agent) | `business-analyst` agent | prompt `autode_agent_business-analyst` | 🤖 needs a host |
| Each stage's work | panel | the stage's agent | agent prompt | 🤖 |
| Approve a gate | panel | elicitation prompt (per policy) or terminal | elicitation or terminal | `autode decisions approve` |
| Skip an optional stage, change workflow | panel | propose, person approves | propose | `autode workflow skip` |

The CLI holds no model by design (§3.1); it covers status, gates and every deterministic step.

##### 10. Releases (proposed)

| Version | Part | Contents |
|---|---|---|
| v0.44.0 | **PA3a: workflow runtime** | The workflow language, schema, the three bundled workflows; the runtime and state file; the gates moved out of `AgentHub` into the runtime (the panel reads them from there); migration of existing problems; workflow tools on MCP; `autode workflow` on the CLI; new decision kinds `gate`, `workflow`, `plan`, `model`, `artifacts`. No AI change: today's agents still run the stages in VS Code. |
| v0.45.0 | **PA3b: agents and skills** | The agent and skill definitions; the new deterministic tools; the in-process executor; every TypeScript agent replaced and **deleted in the same release**; interview state on disk (BPS-7); agent prompts over MCP; the plugin folder and `autode plugin install`. |
| v0.46.0 | **PA3c: same outcome, measured** | Elicitation approvals with the policy file; an eval mode that runs the reference problem through an MCP host agent (a scripted host, plus cassettes recorded with a real host's model; this closes the backlog item "record cassettes with the host's model"); parity tests (§9) in `npm test`. |

After PA3, PA4 (port a skill) adds imported skills to the same library, and the later phases (GOV, C5, 6, C6) shift by two versions.

##### 11. Acceptance

**PA3a**
- The three workflows validate. An invalid workflow file is refused with its errors.
- On the reference problem, the stage sequence and gates match today's lifecycle for brownfield (`modernization`) and greenfield.
- A gated stage can't be marked approved by an agent. It can be by the panel, the CLI in a terminal, or the decision file.
- An optional stage is skipped with a recorded reason. An exploratory draft before its stage is allowed and recorded.
- Existing problems migrate with their approvals intact.
- The panel, the CLI and MCP report the same status for the same problem.

**PA3b**
- The reference problem in VS Code produces the same artifacts and grounding manifests as before the migration, and `npm run eval` doesn't regress.
- A scripted host agent that only follows the agent and skill files and calls MCP tools reaches every gate of every bundled workflow with valid proposals.
- No `src/agents/**` code remains. A lint rule keeps LLM calls out of `src/core`, except in the executor.
- The plugin folder installs into Claude Code's, Cortex Code's and the Copilot CLI's documented locations, and passes each manifest check.
- An interview started over MCP resumes in the panel, with the same questions answered.

**PA3c**
- An elicitation answer resolves an allowed gate; a disallowed kind is refused with the right channel named; a client without elicitation gets the terminal command.
- The host-agent eval meets the same thresholds as VS Code on the reference problem: traps, contract violations, answerability, grounding.

##### 12. Open questions for the owner

1. **Elicitation as a person channel**, with the per-team policy and the proposed default (§5). Is that acceptable, or should gates in hosts always go through a terminal or file?
2. **The plan:** it becomes the build stage's task list, proposed and approved (§2). Or keep a separate plan stage before build?
3. **Workflow changes mid-engagement:** keep the shared stages' states (proposed), or restart?
4. **The bundled stage lists** above: what would you change for modernization and estate merge in your engagements? For example, a reconciliation stage in modernization, or survivorship rules in estate merge.
5. **Size:** three releases of real work. Shall PA4 (port a skill) wait until after PA3c, as proposed?

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
