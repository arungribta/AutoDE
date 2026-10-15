# AutoDE — MCP Engine & Portable Skill Registry: Requirements Specification

**Status:** In progress — order and status of every phase: [roadmap.md](roadmap.md) · **Baseline:** v0.24.0 (`6f09e62`) · **Companion:** [context-layer-requirements.md](context-layer-requirements.md) · **Document map:** [README.md](README.md)
**Kind:** phase specification — WHAT and WHY for planned work, plus the implementation contract the coding agent builds against. When a phase ships, its WHAT/WHY moves into [requirements.md](requirements.md), its HOW into [technical-design.md](technical-design.md), and its section here shrinks to a pointer.
**Audience:** the coding agent (Claude Code, Gemini, Copilot) implementing this, and the reviewers approving each phase.

---

## 0. How to use this document (instructions for the implementing agent)

1. Implement **one phase at a time** (§9), in order. Each phase is one minor version bump and ends with the acceptance criteria for that phase passing.
2. Before changing a file, read it. Every file and symbol named here exists at the baseline commit; if one does not, stop and report it rather than guessing.
3. Keep `npm test` and `npm run lint` green at the end of every phase. Add tests for every new behavior.
4. Follow existing repo conventions: changelog entries at the top of `docs/technical-design.md` (one `(vX.Y.Z)` bullet per phase), matching sections in `docs/requirements.md`, comment density and naming as in the surrounding code.
5. Anything listed in §10 (Rejected approaches) is out of scope. Do not implement it even if it seems helpful.
6. Where this document says **MUST**, it is a requirement; **SHOULD** is a strong default you may deviate from only with a written reason in the phase's changelog entry.

---

## 1. Product intent — what must not be lost

AutoDE is an **automated data engineering VS Code extension**. The extension is the product: a guided, spec-driven workflow inside the IDE. This work makes its deterministic core *portable and reusable by any coding agent*; it does not turn AutoDE into a headless server with a thin UI.

The end-to-end flow stays exactly as it is today:

```
Business problem (interview, skills/*.json)
  → Business Problem Specification (.ai-context/spec/business-problem.yaml, approval gate)
  → Source / Target / Mapping context (approval gates)
  → Pipeline Spec (validated, compiled)
  → Plan (DAG of agent steps) → Plan approval + stage confirmation (enforced in agentHub.executePlan)
  → Deterministic generation (primitives, compiler, templates) → artifacts/
  → Validation & documentation
```

Non-negotiable principles (every phase MUST preserve them):

| # | Principle | Where it lives today |
|---|-----------|----------------------|
| P1 | The LLM selects and parameterizes; it does not freehand code where a primitive exists. Output is Ajv-validated JSON. | `src/agents/llmParamSelector.ts`, `src/core/transforms/registry.ts` |
| P2 | The skill/primitive registry is **static and governed at design time** (publish / deprecate / version). Nothing is created at runtime by an LLM. | `src/core/transforms/declarative/lifecycle.ts` |
| P3 | Human approval gates are enforced by the orchestrator, not only by the UI. | `agentHub.ts` `executePlan()` |
| P4 | LLM-agnostic: `vscode.lm` (Copilot and others), Claude Code CLI, and API providers all keep working. | `src/core/llmProviders.ts`, `languageModelAdapter.ts`, `claudeCodeAdapter.ts` |
| P5 | Credentials are pointers (`CredentialReference`), never secrets in LLM context, logs, or tool output. | `src/dqm/credentials/` |
| P6 | Small footprint, works offline / on locked-down client networks: no **automatic** downloads, and no native modules or heavy SDKs in the VSIX. The one sanctioned download is the user-initiated, integrity-checked native-driver acquisition (Phase DRV), with CLI/REST as the offline fallback. | `package.json` (deps: `ajv`, `yaml` only) |
| P7 | Platform CLIs (`snow`, `databricks`) are optional accelerators, never prerequisites — REST backends work without them. | `src/dqm/executionBackends/` |

---

## 2. Problem statement

1. **The skill registry is locked inside the extension.** The real registry — transform primitives (Tier 1 code + Tier 2 YAML `PrimitiveDefinition`s), the Pipeline Spec compiler, interview skills (`skills/*.json`) and imported tool skills (`SKILL.md`) — is reachable only from AutoDE's own panel. Claude Code, Copilot agent mode, Cursor, etc. cannot discover or call it, so when a developer uses those agents directly they fall back to freehand SQL, bypassing P1.
2. **In-memory spec caches go stale.** `SpecManager`, `PipelineSpecManager`, `SourceContextManager`, `TargetContextManager` (and the other context managers) load YAML once in `initialize()` and serve from memory. The only `.ai-context` watcher (`ContextFileManager.ts:110`) uses the non-recursive glob `.ai-context/*.{yaml,yml,json}`, so `spec/` and `context/` subfolders are unwatched. If any other process (Claude Code, Copilot, `git pull`, an MCP tool) edits a spec, the extension keeps the old copy and can overwrite the newer file on its next save.
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
│   • Context store: .ai-context YAML read/write with revision checks                              │
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

Add `src/engine/context/ContextStore.ts`: node-`fs` based read/write for `.ai-context/**` with:
- `read(relPath) → { data, revision }`, where `revision` is a SHA-256 of the file bytes.
- `write(relPath, data, expectedRevision)` — writes atomically (temp file + rename, as `ArtifactWriter` already does) **only if** the on-disk revision still equals `expectedRevision`; otherwise throws `RevisionConflictError` with both revisions.
- The existing extension managers (`SpecManager`, `PipelineSpecManager`, `SourceContextManager`, `TargetContextManager`, `MappingContextManager`, `SemanticLayerManager`) keep their public APIs and UI behavior, but their parsing/versioning/archive logic SHOULD move behind this store so the server and the extension write `.ai-context` the same way.

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
| `autode_compile_pipeline_spec` | `path?`, `dialect` | `CompiledEntity[]` (content + suggested relative paths under `artifacts/`) |
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

1. Replace the watcher in `ContextFileManager.ts:110` with a recursive one: `new RelativePattern(workspaceRoot, '.ai-context/**/*.{yaml,yml,json}')`. Keep the existing debounce.
2. Route change events by path to a new `reload()` on each affected manager: `SpecManager`, `PipelineSpecManager`, `SourceContextManager`, `TargetContextManager`, `MappingContextManager`, `SemanticLayerManager`. `TargetConfigManager` already has its own watcher — leave it. `ActiveProblemManager` reads from disk on every call and needs no cache invalidation, but a change to its pointer file MUST trigger the existing active-problem switch flow.
3. Each manager records the revision (§4.3) of what it loaded. Every save goes through compare-and-swap. On `RevisionConflictError`, show: *"<file> changed on disk since AutoDE loaded it."* with **Reload** (discard in-memory edits) and **Overwrite** (explicit, logged) actions. Never overwrite silently.
4. Ignore watcher events caused by AutoDE's own writes (compare the event file's revision with the last revision written by this process).
5. After a reload, push refreshed state to the webview (the same path `refreshSettingsInWebview()` uses for settings).
6. `executePlan()` records the spec revisions at start. If an approved spec changes mid-run, finish the running step, pause, and tell the user that later steps would run against a changed spec. Reuse `ArtifactStalenessScanner` to flag artifacts generated from the older revision.

Until this phase ships, the MCP server MUST NOT be given write access to `.ai-context/`.

---

## 9. Phases and acceptance criteria

### 9.0 Combined roadmap

The order, version and status of every phase — this spec's, the context-layer spec's, and the carried-forward ones — live in one place: [roadmap.md](roadmap.md). Implement in that order; each phase is one minor version. Phase identifiers: `1`–`6` (this spec), `C1`–`C6`, `C4a`/`C4b` and `K` (context-layer spec §11), `S1`–`S3`, `DRV` and `GOV` (§9.1 below). `DRV` and `GOV` were called D and G until 2026-10-15; they were renamed because those letters also name older, unrelated work (the v0.9.0 tool-skills "Phase D", and an unbuilt "Phase G" context-memory item).

### 9.1 Carried-forward phases (S1, S2, DRV, GOV, S3)

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
Scope:
- **Sidecar file.** AutoDE owns `.ai-context/skills/tool-skills/<id>/.autode-skill.json` and never modifies the foreign `SKILL.md`. Fields:
  - `status`: `draft | published | deprecated | retired`
  - `version`
  - `provenance { source: local|git, repoUrl?, ref?, resolvedCommit?, subpath?, contentChecksum, importedAt }`
  - `trustTier`: `unreviewed | reviewed | trusted`

  A skill with no sidecar defaults to `{ status: published, version: 1, trustTier: trusted }` if it was imported before this phase (back-compat), and `unreviewed` if imported after.
- **Lifecycle.** `src/core/toolSkillLifecycle.ts` mirrors `transforms/declarative/lifecycle.ts`: publish, deprecate, archive to `history/v<N>/`. It is gated by a new `toolSkillManagementEnabled` setting (default false, hidden when off).
- **Review screen.** Shows the full `SKILL.md`, declared tools and resource files, with an explicit "Trust and enable". Tier semantics:
  - `unreviewed`: not runnable, not exposed over MCP.
  - `reviewed`: runnable with a `read-only` mode ceiling; not eligible for the Claude CLI path.
  - `trusted`: an explicit elevation to `full` and Claude CLI eligibility.

  Every transition is logged.
- **Run gate.** `isSkillRunnable()` gates the run picker the way `isSelectable()` gates primitives. A pinned `skillVersion` still resolves after deprecation.

Acceptance:
- A freshly imported skill is neither runnable nor listed in MCP `prompts/list` until reviewed.
- Review unlocks read-only only; elevation unlocks full.
- Publish/deprecate/archive round-trip tests mirror the primitive lifecycle tests.

#### Phase DRV: Opt-in native driver acquisition + platform-onboarding UI
Scope (the earlier Phase 3b-iv design, moved into the engine):
- **Backend cascade per connection.** Native-protocol CLI (Snowflake `snow sql`) → **opt-in native driver** (`snowflake-sdk` / `@databricks/sql`) → REST. All three return the existing `QueryResult` shape.
- **Driver acquisition** in `src/engine/platform/driverAcquisition.ts`:
  - Resolves the package from a **configurable registry URL**. The default is `https://registry.npmjs.org`; it can point at Artifactory or Nexus on client networks.
  - Reads the version, tarball URL and `integrity` hash from the registry's metadata. Never hardcoded, never chosen by an LLM.
  - Verifies the hash, then extracts to the extension's global storage under `drivers/<pkg>/<version>/`.
  - Loads the driver in the **engine server process** only, and caches it by version.
- **Only ever started by the user**, from the onboarding UI, with the trade-offs stated: download size, disk space, and why it helps. Never at activation, never automatic. A failed fetch (offline, proxy, air-gapped) is reported plainly and the connection falls back to CLI or REST.
- **Platform-onboarding UI** ("Data Platforms"):
  1. Pick platforms.
  2. Per platform, Configure: the existing detect / pick-connection flow.
  3. Choose a backend tier, with honest caveats for each.
  4. Guided authentication.
  5. End-to-end connectivity check before the platform is marked ready.

Acceptance (using a mocked registry and a local tarball fixture):
- A tampered payload is rejected by the integrity check.
- A configured internal registry URL is used.
- With the registry unreachable, the connection falls back to REST with a clear message.
- The VSIX contains neither driver.
- Nothing downloads unless the user clicks the install action; a test asserts there is no fetch on activation or on connection.

#### Phase GOV: Governance-as-code
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

#### Phase S3 (ships with Phase 6): Git-URL skill import, docs and starter library
Scope:
- **Import sources.** `SkillImportSource` covers a local folder and a Git URL. For Git:
  - Shallow clone only.
  - File-count and byte caps are checked **before** anything is copied.
  - Path-traversal check, like `resolveSandboxedPath`.
  - `resolvedCommit` is recorded.
- **Format importers.** `SkillFormatImporter`, with today's `SKILL.md` parser as the default implementation.
- **"Update Skill" command.** Re-fetches, shows a diff, and resets `trustTier` to `unreviewed`. Never silent.
- **Docs and starter library.** Skills authoring docs for both skill systems, and an optional bundled `skills-library/` of first-party `trusted` starter skills.

Acceptance:
- A Git import from a local bare-repo fixture lands in the same shape, with provenance recorded and `unreviewed`.
- An oversized or path-escaping repo is rejected before anything is copied.
- Update Skill against a changed ref shows a diff and requires re-approval.

### Phase 1: Spec state synchronization
Scope: §8, plus the `package.json` version alignment (§2.5).
Acceptance:
- Test: edit `.ai-context/spec/business-problem.yaml` externally → `SpecManager.getSpec()` returns the new content within the debounce window.
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
Scope: `src/mcp/server.ts`; §5.1, §5.2, §5.4, §5.5, §5.6; esbuild bundling of both entry points; packaging fix.
Packaging requirements:
- Add `esbuild` (dev dependency) and `@modelcontextprotocol/sdk` (runtime, bundled). Build scripts produce `dist/extension.js` (external: `vscode`) and `dist/mcp-server.js` (no externals), both minified with source maps excluded from the VSIX.
- `npx vsce ls` shows no `node_modules/` content and both bundles present.
- Record the bundle and VSIX sizes in the changelog entry. Budget: `mcp-server.js` ≤ 1.5 MB; VSIX growth vs. the previous release ≤ 2 MB. If the budget is exceeded, report what is responsible before proceeding.
Acceptance:
- Contract tests (plain Node, spawning the bundle over stdio): `tools/list`, `prompts/list` and `resources/list` return the expected names; each tool's `inputSchema` validates a known-good and rejects a known-bad payload.
- Golden tests: `autode_compile_transform` for every Tier 1 primitive and every bundled Tier 2 definition, per supported dialect, matches committed snapshots byte-for-byte (determinism).
- Manual: Claude Code configured with the server (by hand, per `docs/mcp-setup.md`) can search, describe and compile a primitive.

### Phase 4: MCP server — data platform
Scope: §5.3, §6. (`ContextStore` already exists from Phase 2.) Plus **sample-data consent and redaction**: row samples from profiling, `autode_execute_query` results and CSV ingestion never enter an LLM prompt unless the per-connection setting `allowSampleDataInPrompts` is on (default off). When it is off, only schema, counts and aggregate statistics are used. Values in columns classified as PII (by Phase GOV, or by column-name heuristics until then) are masked in any sample that is allowed through.
Acceptance:
- Read-only guard tests: `INSERT`, `MERGE`, `DROP`, `CREATE`, `GRANT`, `CALL`, multi-statement input, and comment-smuggled writes are rejected without `--allow-write`; `SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN` pass.
- Redaction test: no tool response or log line contains any test secret value.
- Manual, live: Snowflake via CLI connection and via key-pair REST; Databricks via PAT REST — list schemas, extract metadata, explain, select.
- A machine without `snow`/`databricks` CLIs installed can still use the REST paths (P7).
- Test: with `allowSampleDataInPrompts` off, no sampled row value appears in any assembled prompt; with it on, PII-named columns are masked.

### Phase 5: Extension as an MCP client; exposure to other agents
Scope: §7.1–7.3, §7.5.
Acceptance:
- The extension no longer imports `src/engine/**` directly except for types (lint rule: value imports from `src/engine` banned outside `src/mcp`).
- Activation does not spawn the server; first engine use does. Killing the server process mid-session recovers on the next call.
- End-to-end manual run of the full flow (§1) produces the same artifacts (and grounding manifests) as the previous release for the same inputs (diff the `artifacts/` tree); `npm run eval` metrics do not regress.
- Copilot agent mode lists AutoDE tools without manual config (on VS Code versions that support the provider API).
- `AutoDE: Configure MCP for Claude Code` writes a working `.mcp.json` entry that survives an extension update.

### Phase 6: Skill governance hardening
Scope:
- Add optional `platforms: SqlDialect[]` to `PrimitiveDefinition` (+ `docs/schemas/primitive-definition.schema.json`); `autode_search_primitives` filters by it. Make it visible when a compile falls back to the `default` template for a platform.
- **Conformance suite:** a test that loads every bundled and workspace primitive and, for each declared platform, validates `previewParams` against `paramSchema`, compiles, runs `outputChecks`, and compares with a golden snapshot. Publishing a primitive (`publishPrimitiveDefinition`) MUST run the same checks and refuse to publish on failure.
- **Dry-run before execute:** any plan step that executes SQL against a platform calls `autode_explain_sql` first and fails the step on an explain error.
- **Idempotency:** generated DDL/DML from primitives uses idempotent forms (`CREATE OR REPLACE` / `CREATE ... IF NOT EXISTS` / `MERGE`) where the dialect supports them; add a conformance check (`mustNotContain` on bare `CREATE TABLE` where applicable).
Acceptance: the conformance suite runs in `npm test`; a deliberately broken primitive fixture is rejected by both the suite and the publish path.

---

## 10. Rejected approaches (out of scope — do not implement)

| Approach | Why rejected |
|----------|--------------|
| Moving the engine to a separate repository | Shared types (e.g. `SqlDialect` duplicated between `dqm/types.ts` and `transforms/types.ts`) would drift; one repo with a lint-enforced boundary gives the same isolation (D1). |
| Native per-OS binaries (`pkg`, PyInstaller, Go) | `pkg` is archived; binaries are 40–80 MB each, need code signing, and are often blocked on client networks. A bundled JS file on VS Code's Node is a few hundred KB (D2). |
| Downloading the server or CLIs at activation (JIT installer) | Breaks offline / air-gapped clients, slows activation, and introduces an unsigned download-and-execute path. The only sanctioned download is Phase DRV's user-initiated, integrity-checked driver acquisition, which has an offline fallback. |
| Blocking activation or the panel on `snow` / `databricks` being installed | REST backends need no CLI (P7); detection already exists in `cliDetection.ts` and runs lazily at connection time. |
| Rewriting `skillRegistry.ts` as an MCP client or deleting it | It loads the interview prompt packs; they are exposed as MCP **prompts** (§5.4), and the client lives in `src/core/mcp/`. |
| Making the extension a proxy between Claude Code / Copilot and the server | Both connect to MCP servers directly; the extension is one client among several (§7.5). |
| Vendor-named raw execution tools (`execute_snowflake_query`) | Breaks tool-agnosticism; the connection determines the platform (§5.3). |
| SSE / HTTP transport, Docker image | stdio covers all local clients. A Docker image is a later option and can reuse the same bundle with `docker run -i` over stdio; Streamable HTTP only if a remote/shared deployment is required. |
| Adopting an external agent harness (CUGA, AutoGen, LangGraph, …) | AutoDE's orchestration, approval gates and deterministic core already cover the harness role; adding a Python runtime contradicts P6. With the engine behind MCP, a harness can be adopted later without a rewrite. |
| LLM calls inside the MCP server | Keeps the server deterministic and provider-free (D5). |

---

## 11. Documentation deliverables

Per phase: a `(vX.Y.Z)` changelog bullet in `docs/technical-design.md`, the matching requirements section in `docs/requirements.md` (new §19 "MCP Engine & Portable Skill Registry", referencing this document), and onboarding-guide updates for the new `src/engine/` / `src/mcp/` layout. Phase 3 adds `docs/mcp-setup.md`. Phase 6 adds a "How to onboard a new primitive" section covering the conformance requirements.
