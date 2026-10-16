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

Defined in [requirements.md §2.1](requirements.md) (P1–P7), which is canonical: P1 the LLM selects and parameterises, never freehands where a primitive exists; P2 the catalog is governed at design time; P3 approval gates enforced by the orchestrator; P4 LLM-agnostic; P5 credentials are pointers; P6 small footprint, offline, no automatic downloads (AutoDE moderates installs the user starts; DRV1), new dependencies need a recorded decision; P7 platform CLIs are optional accelerators.

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

Scope:
1. **Prerequisite model** (`src/engine/platform/prerequisites.ts`). Per platform: id, kind (`cli` | `driver` | `client-library`), what it is, why it's needed, `detect()` (status `ready` | `missing` | `unverified` | `changed`, with version and detail), the install step (command, working folder, notes, size and licence where known), and `verify()`. The existing Snowflake/Databricks CLI detection appears in the model unchanged.
2. **Driver store.** Drivers live in one folder per driver under a drivers root. The root is the setting `driversDirectory`, else `AUTODE_DRIVERS_DIR`, else `~/.autode/drivers`. It is a user-level folder rather than VS Code's global storage, so that an MCP server started by another client finds the same drivers. Install command: `npm install --prefix "<root>/<driver>" --ignore-scripts --no-audit --no-fund "<package>@<range>"`; the version range is fixed in code and reviewed like code (never chosen by an LLM). `--ignore-scripts` because no supported driver needs an install script.
3. **Verification and trust.** `verify()` loads the package from the driver folder, checks its version against the supported range and that it works without native code (Oracle: Thin mode). It then records `{ package, version, lockfileSha256, verifiedAt }` in `<driver folder>/.autode-driver.json`. A driver is loaded only while that record matches the folder's `package-lock.json`. If the folder changes, the status becomes `changed` and the driver must be verified again (the same "trust belongs to content" rule as S2 skills). A driver is never loaded at activation and is loaded on first connect only.
4. **Moderated install in the extension.** Commands **AutoDE: Check Platform Prerequisites** (status of every prerequisite, with actions) and **AutoDE: Install Oracle Driver**. The install command shows what will run, where, roughly how large it is and why. On **Run in terminal** it opens a visible terminal named "AutoDE" in the driver folder and runs the command. Then **Verify** checks and records the result. Without `npm` on `PATH`, AutoDE says so and offers the alternatives: install Node.js, or point `driversDirectory` at a folder where the package is already installed.
5. **Oracle as a source** (`oracledb` ≥ 6, Thin mode only — **Oracle Database 12.1 or later**; older databases need Thick mode and Oracle Instant Client, which is out of scope and documented as such):
   - Connection: `connectString` is either a **tnsnames alias** or an Easy Connect string. `configDir` is optional. The location of `tnsnames.ora` follows Oracle's own order: `configDir`, then `TNS_ADMIN`, then `$ORACLE_HOME/network/admin`. AutoDE reads alias names from it only (to list and validate them); the driver resolves the alias. `walletLocation` covers TLS wallets (e.g. Autonomous Database). The username is a setting or a `connections.yaml` field. The password and wallet password come from `AUTODE_ORACLE[_<REF>]_PASSWORD` / `_WALLET_PASSWORD` or VS Code SecretStorage. tnsnames carries no credentials, and Oracle's wallet-based password store needs Thick mode.
   - Adapter (`src/engine/platform/adapters/OracleAdapter.ts`): metadata from `ALL_TABLES`, `ALL_VIEWS`, `ALL_TAB_COLUMNS`, `ALL_TAB_COMMENTS` / `ALL_COL_COMMENTS`, `ALL_CONSTRAINTS` / `ALL_CONS_COLUMNS` (foreign **and primary** keys), `ALL_OBJECTS` (last DDL time); a schema is an owner; listing "databases" returns the connected database; sampled profiling with `FETCH FIRST n ROWS ONLY`.
   - Probes gain an `oracle` dialect. The read-only guard gains a third reading convention for Oracle's `q'[…]'` quoting, so Oracle SQL can't hide a write past it.
   - `connections.yaml`, the MCP data-platform tools (§5.3) and the extension's connection flow (settings and a SecretStorage password) all accept `oracle`. `autode_explain_sql` uses `EXPLAIN PLAN FOR` + `DBMS_XPLAN.DISPLAY`.
   - Oracle is a **source**: generating Oracle SQL (primitives, Pipeline Spec dialects) is out of scope.

Acceptance:
- Nothing runs or downloads unless the user clicks: a test asserts no process is spawned and no network request is made at activation or on connection, and that the install command is only sent to a terminal from the install action.
- The install command uses the configured drivers folder, the fixed version range and `--ignore-scripts`. It quotes paths and the version range so that it works in PowerShell, cmd and bash.
- A driver folder whose lockfile changed after verification is reported `changed` and is not loaded. An unverified driver is not loaded. Connecting without the driver says what is missing and how to install it.
- Against a fake `oracledb` package (fixture): connect via a tnsnames alias with `configDir`; extract metadata (tables, views, columns, comments, primary and foreign keys); probes; the MCP tools.
- tnsnames: aliases are listed (including multi-alias entries and `IFILE` reported but not followed); an unknown alias is reported with the file that was searched.
- The guard rejects `q'[…]'`-smuggled statements.
- The VSIX contains no driver.
- Manual, live: an Oracle 19c (or later) database via a tnsnames alias and via Easy Connect; a machine without npm gets the guidance.

##### Phase DRV2 (v0.39.0): platform-onboarding UI ("Data Platforms")

Scope: a panel section that renders the prerequisite model for each platform:
1. Pick platforms.
2. Per platform, the prerequisites with their status and actions (install, verify), and the existing detect / pick-connection flow (CLI connections, tnsnames aliases).
3. Choose a backend tier, with honest caveats for each.
4. Guided authentication, storing secrets in SecretStorage.
5. An end-to-end connectivity check before the platform is marked ready.

It also writes the chosen connection to `.autode/config/connections.yaml` (pointers only), so the MCP server sees it. It also folds in the backlog item "the old `testConnection` path assembles credentials from settings rather than the credential resolvers".

Acceptance: a platform is marked ready only after a passing connectivity check; every action that installs or runs something is a click with the command shown; the settings panel's existing Snowflake/Databricks flows keep working.

**Not planned:** `snowflake-sdk` and `@databricks/sql` as a backend tier. Reconsider them as moderated installs if an engagement is blocked because the Snowflake SQL API is restricted and no CLI is allowed.

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
| Downloading the server or CLIs at activation (JIT installer) | Breaks offline / air-gapped clients, slows activation, and introduces an unsigned download-and-execute path. Drivers are installed only by the user, through a command AutoDE shows and runs on request (Phase DRV1), with the user's own package manager and registry. |
| Blocking activation or the panel on `snow` / `databricks` being installed | REST backends need no CLI (P7); detection already exists in `cliDetection.ts` and runs lazily at connection time. |
| Rewriting `skillRegistry.ts` as an MCP client or deleting it | It loads the interview prompt packs; they are exposed as MCP **prompts** (§5.4), and the client lives in `src/core/mcp/`. |
| Making the extension a proxy between Claude Code / Copilot and the server | Both connect to MCP servers directly; the extension is one client among several (§7.5). |
| Vendor-named raw execution tools (`execute_snowflake_query`) | Breaks tool-agnosticism; the connection determines the platform (§5.3). |
| SSE / HTTP transport, Docker image | stdio covers all local clients. A Docker image is a later option and can reuse the same bundle with `docker run -i` over stdio; Streamable HTTP only if a remote/shared deployment is required. |
| Adopting an external agent harness (CUGA, AutoGen, LangGraph, …) | AutoDE's orchestration, approval gates and deterministic core already cover the harness role; adding a Python runtime contradicts P6. With the engine behind MCP, a harness can be adopted later without a rewrite. |
| LLM calls inside the MCP server | Keeps the server deterministic and provider-free (D5). |

---

## 11. Documentation deliverables

Per phase: a `CHANGELOG.md` entry, the affected requirements in `docs/requirements.md` updated by ID (WHAT/WHY only), the HOW in `docs/technical-design.md`, and onboarding-guide updates for the new `src/engine/` / `src/mcp/` layout. Phase 3 adds `docs/mcp-setup.md`. Phase 6 adds a "How to onboard a new primitive" section covering the conformance requirements.
