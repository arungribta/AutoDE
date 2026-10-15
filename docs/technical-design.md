# AutoDE — Technical Design Document

**Last Updated:** 2026-09-20
**Version:** 0.24.0
**Status:** v0.8.0 code committed. Implemented:
- Single-workspace model (`ArtifactWriter`, `autoDE.artifactDirectory`; `ProjectManager` removed)
- Context Layer IA: unified envelope (`src/context/types.ts`, `docs/schemas/context-envelope.schema.json`), `SourceRegistry` (`sources.yaml`), `SynthesisPipeline`
- Webview CSP nonce fix, workflow palette rework, Cline dev-host workaround in `.vscode/launch.json`
- **Business Problem Specification (spec-driven orchestration)** — see §2. Implemented: BPS types + `SpecManager` persistence/versioning/history, `AgentHub.generateSpec` (LLM-based spec drafting/refining with version semantics), spec-aware chat routing (no-spec → draft, draft → revise, approved → grounded chat), palette + chat spec card review/approve/revise/open UI, `/spec` command, and `generatePlanFromSpec` (spec-driven plan generation).
- **Spec-driven phase inference + orchestration** — see §2.5/§2.7. Deterministic `inferPhases()` (keyword evidence + `scope.out` exclusions + dependency chaining) turns an approved BPS into a required-phase set; plan generation is constrained to those phases; the palette renders the live phase status view (completed / in-progress / blocked / pending / unrequired).
- **Agentic Specification Generation (SpecOps)** — see §2.8. A Superpowers-inspired, DE-tailored requirements flow: a `SpecOpsEngine` state machine + `skills/` registry drive an adaptive questioning conversation (chat bubbles + dynamic intake forms), then synthesize the comprehensive v2 spec (business requirements, data flows, transformations, dependencies, acceptance criteria, implementation considerations, source catalog, provenance).
- **Phase 3 (parts 1 & 2) — layered context loading** — see §10. Real YAML parser (`yaml` dep + `src/context/Yaml.ts`), AJV envelope validator (`src/context/ContextValidator.ts`), atomic compiled-graph persistence (`src/context/GraphPersistence.ts` → `derived/graph.json`); `ContextFileManager` layered loading (`context/**` + `derived/graph.json` via `GraphPersistence`, legacy fallbacks) with AJV envelope validation wired through `ContextValidator`; `SpecManager`/`SourceRegistry`/`TargetConfigManager` migrated to the real `yaml` library.
- **(v0.10.0)** Generate Plan audit follow-through — see §2.12. Context Layer synced from the approved spec automatically before planning (`SynthesisPipeline.synthesizeFromSpec`, durable snapshot per spec version); deterministic Greenfield/Brownfield classification (`src/core/implementationType.ts`) with user override, feeding phase inference; plan persistence (`src/context/PlanManager.ts`, mirrors `SpecManager`); artifact-level version history (`ArtifactWriter`); `validatePlanResponse` cycle detection + required-phase enforcement + tolerant JSON parsing (closes R10). Source/target environment context implemented — `Origin.environment` tags on the existing Context Layer, `TargetConfigManager` wired into `extension.ts` — see `requirements.md` §16.3a.
- **(v0.10.0, same day)** Workflow UX follow-through from hands-on testing — see §8.9 of `requirements.md`. Fixed a stale-status race that made plan generation look stuck after `generatePlanFromSpec`; added an explicit plan-ready confirmation with View Plan/Review Stages actions; new `pending-review` phase status + per-phase Applicable/Non-Applicable overrides on the palette; `executePlan`'s DAG loop no longer halts on the first step failure — independent steps keep running so a missing target connection doesn't block every other artifact; "Generate Artifacts" is now the consistent label everywhere plan execution is triggered; artifact storage moved from a sibling `auto-de/` folder to `.ai-context/artifacts/`.
- **(v0.11.0)** Source & Target Context are now mandatory, reviewed, gating objects — see §8.10 of `requirements.md`. `TargetContextManager`/`SourceContextManager` persist spec-tied records built through a fixed Q&A (`targetContextQuestions.ts`/`sourceContextQuestions.ts`); `generatePlanFromSpec` is blocked server-side until both are approved (Source auto-marked Non-Applicable for Greenfield); the Workflow Palette gained a "Source & Target Context" section. The 5 template codegen agents now try an LLM call first (`AgentExecutionContext.callLlm`, `src/agents/llmCodegen.ts`), grounded in the task/objective/context/target environment, falling back to their original templates — closing the "agents ignore schemaContext" finding (R5 / requirements.md §8's Revision 3 analysis). `TargetConfigManager`'s generic default is no longer auto-seeded into the hub (a regression from wiring it in during v0.10.0).
- **(v0.12.0)** Multi-business-problem workspace — see §8.11 of `requirements.md`. A single workspace can now hold more than one business problem, each fully isolated under `.ai-context/problems/<id>/{spec,plan,context,artifacts}/`, with `.ai-context/active-problem.json` naming the current one; `SpecManager`/`PlanManager`/`TargetContextManager`/`SourceContextManager`/`ArtifactWriter` were re-scoped to take a caller-resolved `contextRoot` instead of hardcoding `.ai-context/<thing>` off the workspace root. New `AgentHub.resetForNewProblem()` and `webviewProvider.activateProblem()` guarantee a genuinely clean in-memory state on every activation/switch — including swapping the shared Context Layer graph's spec-derived layer via `removeNodesBySourceRef`/`synthesizeFromSpec` — closing the stale-state bug where clearing chat and deleting `.ai-context` by hand still left the previous spec visible. New Workflow Palette "Business Problem" section (＋ New / ⇄ Switch) drives `startNewBusinessProblem`/`listBusinessProblems`/`switchBusinessProblem`.
- **(v0.13.0)** Lifecycle orchestration — see §8.12 of `requirements.md`. `AgentHub` is now the single enforcement point for the lifecycle's approval gates, closing a finding from the Generate Plan audit's Revision 6 (§11): at least seven UI entry points (Command Palette commands, the AutoDE Dashboard panel's Quick Actions, the `/plan` slash command, re-plan buttons) could reach plan generation/execution without ever touching a spec or context approval. `AgentHub.generatePlan()` now requires an active, context-ready business problem (`state.specId` + new `state.contextGateReady`, pushed by `webviewProvider.postContextGateStatus()`) before doing anything else; its old body moved to a private `generatePlanInternal()` that `generatePlanFromSpec()` calls after its own, stricter checks. Two new explicit approval gates before `executePlan()` will run: Plan Approval (`AgentHub.approvePlan()`) and Stage Confirmation (`AgentHub.confirmStages()`), both persisted via a new `PlanManager.patchGates()` and both reset whenever the plan or its inferred phases change. New lightweight Business Problem checkpoint (`BusinessProblemSpec.problemStatementApproved`) gates `approveSpec`. Also fixed in the same pass: `SpecManager` was silently dropping `implementationType`/`implementationTypeReason`/`implementationTypeOverridden` on every save, never actually persisting a user's Greenfield/Brownfield classification. The AutoDE Dashboard panel itself is explicitly parked (product decision, 2026-09-16) — future work.
- **(v0.13.0, same day)** Discovery progress surfacing — see §8.13 of `requirements.md`. Fresh dev-host testing found that even a fully orchestrated discovery interview *read* as ungrounded, unstructured chat, because `SpecOpsEngine`'s real per-field coverage/turn-budget/skill-ownership tracking never reached the webview — `specQuestion`/`specQuestions` payloads were just the bare question, and the Workflow Palette showed nothing during discovery at all. New pure module `src/core/discoveryProgress.ts` (`buildDiscoveryProgress`, `skillNameForField`) now feeds a `progress` snapshot + per-question `skillLabel` into both message types; the chat bubbles show a topic + progress readout, and the palette shows a live "discovery in progress" card (progress bar + per-skill checklist) instead of staying blank until synthesis.
- **(v0.13.0, same day)** Chat no longer auto-resumes on reload — see §8a.4 of `requirements.md`. A reload/restart previously reloaded whatever chat session was last active, transcript and all — confusing testers who expected a clean slate. Any session with real content is now folded on activation (archived via the existing `startNewChat()` path, never discarded) and a fresh empty one takes its place; a new "🕓" Chat History icon in the sidebar topbar lists past sessions and resumes one on click. `openChatSession`'s semantics changed from a read-only preview (`chatSessionViewed`, now retired) to a real resume (`chatSessionLoaded`, reactivating the session via `ChatSessionManager.updateMeta(id, {status:'active'})`) — this closed out the last piece of Phase F's chat-session plumbing that had no UI consumer.

- **(v0.14.0)** Deterministic Execution Core & Declarative Specification Framework — see §12. Stabilization (CI/lint/real `deactivate()`/dead-code removal); a closed, Ajv-validated transform-primitive registry (`src/core/transforms/`) the LLM only selects/parameterizes, never freehands, wired ahead of the existing freehand-LLM/template fallback in 3 of 5 codegen agents; a declarative (Tier 2, YAML-authored, no-code-execution-template-engine) primitive extensibility layer mirroring the skills-loader's bundled+override pattern; a strictly-validated Pipeline Spec (`src/core/pipelineSpec/`) deterministically compiled from — and rendering a Markdown design doc alongside — an approved BPS plus its full surrounding context, including a new attachment structured-extraction pass (`AttachmentStore`, `SpecProvenance`'s new `'attachment'` source); primitive lifecycle management (sidebar UI, publish/deprecate, an opt-in permission gate, and version pinning so an approved Pipeline Spec survives a primitive being republished later). Also produced (not yet implemented at the time): a Platform Onboarding & Credential Architecture design — §4.8.
- **(v0.15.0)** Platform Onboarding & Credential Architecture — Credential Resolution Foundation implemented (Phase 3a-i) — see §4.8. `src/dqm/credentials/`: a pluggable `CredentialResolver` interface (`CredentialReference` is a pointer — platform, principal type, resolver id, ref — never the secret itself) plus a module-level registry (`registerCredentialResolver()`/`resolveCredential()`) as the extension point for enterprise secrets managers. Three built-in resolvers: `EnvVarCredentialResolver` (documented `AUTODE_<PLATFORM>_<FIELD>` env vars — the simplest service-account/CI path, zero VS Code dependency), `CliConfigResolver` (Snowflake only — confirms a named connection exists in `connections.toml` via a `[name]`-header scan, then hands back a `{connectionName}` pointer for `snowflake-sdk`'s own native loading), and `VsCodeSecretStorageResolver` (generalizes `ConfigurationManager`'s 3 hardcoded secret methods into one key scheme, `autoDataEngineeringHub.secret.<platform>.<principalType>.<profileOrRef>.<field>`, additive alongside them). `providerRegistry.ts`'s `authModes` gained a `principalTypes` dimension (`AuthModeDescriptor[]`) and is consumed for the first time via `getAuthModesForPrincipal()`. Not yet wired: `ConnectionManager`/`testConnection`/the adapters still source credentials from the flat settings-only assembly — that migration is Phase 3b's job, downstream of Phase 3a-ii giving a user a way to pick a `CredentialReference` in the first place.

- **(v0.16.0)** Platform Onboarding & Credential Architecture — Interactive Onboarding UX implemented (Phase 3a-ii) — see §4.8. `PlatformCliDescriptor` (`src/dqm/credentials/PlatformCliDescriptor.ts`, `cliDetection.ts`, `cliRegistry.ts`) for both `snow` and `databricks`, mirroring `ClaudeCodeAdapter.resolve()`'s cascade; `SnowflakeCli` shells out to `snow connection list` (gated behind the new `dataPlatformCliConsent` setting); `DatabricksCli` reads `.databrickscfg` directly instead of an unverified CLI subcommand (`databricksCfg.ts`). New command "AutoDE: Connect to Data Platform" (`webviewProvider.ts#connectToDataPlatform()`) resolves a chosen CLI connection through Phase 3a-i's `cli` resolver and populates a new `TargetContext.credentialRef` pointer. `CliConfigResolver` extended to Databricks (pointer-only, consistent with Snowflake). Service-account path: `serviceAccountCredentialRef` setting + "AutoDE: Test Service Account Credential". `SnowflakeAdapter`/`DatabricksAdapter` stubs widened to accept a CLI-derived pointer credential so the onboarding flow demonstrably completes today, ahead of Phase 3b's real execution.

- **(v0.17.0)** Real Snowflake/Databricks execution — core (Phase 3b-i/ii/iii) — see §4.9. Revised twice in-session on concrete evidence (measured ~120MB combined dependency-tree cost, then real-world feedback that a REST-only default underperforms for large-catalog extraction and is separately network-restrictable in some enterprises): neither `snowflake-sdk` nor `@databricks/sql` is a dependency any more. A priority cascade instead — Snowflake prefers shelling out to `snow sql` (native protocol) for a CLI-derived connection, both platforms fall back to their public REST SQL-execution API (`fetch()`, PAT/OAuth/key-pair-JWT via `node:crypto` alone) for a direct credential. `ConnectionManager.getSupportedPlatforms()` now reads `providerRegistry.ts`; a real Databricks settings surface replaces a previously-nonexistent settings key. Not yet built: on-demand native-driver acquisition and the platform-onboarding checklist UI.

- **(v0.18.0)** Runtime Context Unification — see §4.10. Live UI testing of the v0.17.0 connectivity work found chat had zero awareness of a real, live connection, and the top status pill never updated after connecting — traced to "LLM context" being assembled independently in ~7 places, two of which (`generateSpec`/`refineSpec`, and a client-supplied `schemaContext` param hardcoded to `''`) carried no real context at all. Fixed by extending `ContextFileManager.buildContextPrompt()` — already the closest thing to a shared context object — with a generic, in-memory `RuntimeFact` slot (`setRuntimeFact()`), and making connection status role-keyed (`source`/`target`) via `webviewProvider.notifyConnectionStatus(role, status)`, closing a second gap where `connectToDataPlatform()` (the target-connection flow) never reported status anywhere. `generateSpec`/`refineSpec` and `ToolSkillAgent` now receive live context for the first time.

- **(v0.19.0)** Source & Target Context Architecture — data-model foundation (Step 1 of the plan in `after-phase-3b-are-graceful-lagoon.md` Part 3; a full architecture review preceded this, challenging the original proposal before any code was written). `SourceContext` changed from a single flat record (`method`/`sourceType`/`description`/`connectionSummary` directly on the document) to one object holding a `sources: SourceContextEntry[]` list — still one lifecycle/version/approval per container, but internally scalable to more than one source connection without another reshape. Each entry, and every `Origin`-tagged graph node, now carries a `connectionId` (`BaseDataSourceAdapter.getConnectionId()`, e.g. `snowflake:prod`) distinct from the bare platform name — closing a confirmed gap where two connections of the same platform type (or two same-named tables from different sources) were indistinguishable. `SourceContextManager.parse()` migrates a pre-v0.19.0 flat-shape file into the new list on read, so existing workspaces keep working. UI (`sourceContext.sources[0]`) and `pipelineSpecSynthesis.ts`'s rendering updated to match. A known, explicitly deferred issue: the settings-panel "Connect"/"Source Assessment" flow (`extension.ts`) still doesn't write a `SourceContext` record at all — only the Palette's "Describe source"/"Connect to Data Platform" flow does; fixing that is tied to a larger, not-yet-decided question about whether `SourceContext` should stay spec-version-scoped or move to project-level, and is intentionally out of scope for this pass.

- **(v0.20.0)** Source & Target Context Architecture — Steps 2 & 3 (versioning + the Source/Target Panel UI split). **Versioning:** `SourceContextManager`/`TargetContextManager` gained real content-revision history, mirroring `PipelineSpecManager`'s exact pattern — a `version` field bumped only when revising an already-*approved* predecessor of the same spec lineage (never on a plain approve), with the predecessor archived to `context/history/{source,target}-context.spec<N>.v<M>.yaml` first, idempotently. **UI:** the single "Data Platform" panel split into two real, independent tabs — Source and Target — each listing the same platform cards (Snowflake, Databricks), confirmed live-connectable *simultaneously* per an explicit decision (both roles can hold an active connection at once). Settings storage is deliberately **additive doubled flat settings**, not a rename: every pre-existing `defaultSnowflake*`/`defaultDatabricks*` setting keeps meaning "source" exactly as before (so already-configured `settings.json` values, including this session's own live-tested Snowflake config, were never orphaned); a parallel `defaultTarget*` set was added alongside. `extension.ts`'s `testConnection`/`disconnectDataPlatform` were refactored into role-parameterized `runConnectionTest(role)`/`runDisconnect(role)` helpers shared by new `testTargetConnection`/`disconnectTargetDataPlatform` commands, backed by a second, fully independent `targetConnectionManager` instance alongside the existing `connectionManager` (confirms `ConnectionManager`'s single-connection-per-instance design was never a constraint — two instances just coexist). `ConnectionManager.getCredentialsFromSettings()` gained a `role` parameter (`'source'` default, for compatibility). **Databricks wired for the first time in either panel** — previously a visual placeholder only (fields present in the HTML but never connected to save/load, no Connect button at all) despite the backend (`DatabricksAdapter`, REST execution, settings, secrets) having existed since Phase 3b; now has real Workspace URL/HTTP Path/Catalog/Schema/Catalog Type/CLI Path/Token fields and Connect/Disconnect(+Source Assessment on the source side) buttons in both panels, closing a real gap between what the user believed was already wired and what the UI actually did.

- **(v0.21.0)** Source & Target Context Architecture — Step 4 (database/schema/catalog discovery + picker). `IDataSourceAdapter` gained `listDatabases()`/`listSchemas(database)`, implemented concretely on both `SnowflakeAdapter` (`SHOW DATABASES` / `SHOW SCHEMAS IN DATABASE <db>`) and `DatabricksAdapter` (`SHOW CATALOGS` / `SHOW SCHEMAS IN <catalog>` — confirmed live this session that a *bare* SHOW command works even against `hive_metastore`, unlike one wrapped in SELECT/WITH), passed through `ConnectionManager` with the same "no active connection" guard `extractMetadata()` already uses. New `browseSourceDatabase`/`browseTargetDatabase` commands (one role-parameterized `browseDatabaseAndSchema(role)` implementation) connect if needed, then walk the user through two native QuickPicks (database/catalog, then schema) instead of requiring a name typed blindly — directly closing the reviewed proposal's "don't assume the whole account is relevant" gap. Selections write straight to the role- and platform-correct settings and push a `refreshSettingsInWebview()` so the panel's fields don't go stale after a command-driven change bypasses the webview's own save path. A "Browse..." button was added next to Connect on all four cards (Source/Target × Snowflake/Databricks), reusing the same save-before-act (`connectAfterSave`) mechanism Connect already needed.

- **(v0.22.0)** Source & Target Context Architecture — Step 5 (real, structural file-based ingestion). New `src/context/fileIngestion.ts` — dependency-free structural parsers for CSV (real header + sampled-value type inference: INTEGER/FLOAT/BOOLEAN/TIMESTAMP/STRING), JSON (array-of-objects or single-object; column set is the *union* of keys across a sample, so a key missing from one record means nullable, not absent), and DDL (`CREATE TABLE` — a deliberately narrow parser, not a general SQL grammar: handles `NOT NULL`/`PRIMARY KEY`, a type's own internal comma like `DECIMAL(10,2)`, multiple statements per file, and skips constraint-only lines like `FOREIGN KEY (...)` rather than miscounting them as columns). Every node gets `Origin.confidence: 1.0` — a structural parse is a fact, not an LLM guess, unlike the existing `AttachmentStore` LLM-extraction path this deliberately doesn't touch or duplicate. New `ContextFileManager.persistCompiledGraph()` (made public) and `DataAgentHubWebviewProvider.ingestFileIntoGraph(nodes, edges)` let a command add directly to the same shared `GraphManager` a live connection's Source Assessment already writes to — so an ingested file's tables render everywhere `buildContextPrompt()` already does, with zero new rendering path. New `ingestFileAsSourceContext` command + "Import File..." button in the Source panel (deliberately source-only, matching the reviewed proposal's own panel-responsibility split; Parquet/Avro/data-dictionaries/docs are explicitly out of scope — the first two need a real binary-parsing dependency, the rest are inherently free-text and already better served by `AttachmentStore`). Same known, accepted gap as `testConnection`/`sourceAssessment`: doesn't also write a `SourceContext` record (spec-scoped; this command doesn't assume an active business problem either).

- **(v0.23.0)** Source & Target Context Architecture — Step 6 (Mapping Context). New `MappingContext`/`EntityMapping`/`ColumnMapping` types (`src/core/types.ts`) and `src/context/MappingContextManager.ts` — a separate, independent object from `SourceContext`/`TargetContext` (per the architecture review's Q2: mappings are inherently relational and don't belong inside either side), persisted to `context/mapping-context.yaml` with the exact same content-revision versioning/archive pattern as `SourceContextManager`/`TargetContextManager` (`version` bumps only when revising an already-approved predecessor; archived to `context/history/mapping-context.spec<N>.v<M>.yaml`). `EntityMapping.sourceEntityId` references a real `GraphManager` node id — both sides of a mapping are picked from the same shared, already-unified graph (source and target connections both write into one `GraphManager`, tagged via `Origin.environment`), not two separate models; `targetEntityId` is optional so Greenfield work (a target table that doesn't exist as a discovered node yet) can still record a mapping against a free-text `targetName`. Editing any mapping in an already-`approved` container drops its status back to `built` — an edited-then-unreviewed mapping set is never silently treated as still-approved. Wired into `webviewProvider.ts`'s `activateProblem()` lifecycle alongside `SourceContextManager`/`TargetContextManager`; new bridge methods `listMappableTables()`/`listTableColumns()`/`upsertEntityMapping()`/`getMappingContext()` let `extension.ts` reach the shared graph and the new manager (both private fields on the webview provider). New QuickPick-driven `AutoDE: Create Mapping (Source → Target)` command (`createMapping`) — consistent with this codebase's QuickPick-only UX convention (no bespoke visual mapping editor): picks a source table, then either an existing target table or a typed name for Greenfield, auto-matches columns by case-insensitive name, and saves via `upsertEntityMapping()`. The Unified Semantic Layer half of Step 6 is also done: new `SemanticLayerSnapshot` type + `src/context/SemanticLayerManager.ts`, capturing the live shared `GraphManager` graph's current content/counts as an explicit, spec-pinned, versioned snapshot on a new `AutoDE: Build Unified Semantic Layer Snapshot` command (`buildSemanticLayer` — never runs automatically). Metadata persists to `context/semantic-layer.yaml`; the captured graph content itself to `context/semantic-layer.snapshot.json`; both archived together (mirroring the same version-bump-on-revising-approved pattern) to `context/history/semantic-layer.spec<N>.v<M>.{yaml,json}` — a later live-graph change can't silently invalidate what an approved artifact was actually generated against. Not yet started: Step 7's governance/trust-tier layer.

- **(v0.24.0)** Source & Target Context Architecture — Step 7 (governance layer), completing the plan's 7-step sequencing. Modeled on the same 3-layer governance already specified (not yet built) for tool skills in Part 2 of the plan file: provenance capture, review before low-confidence content drives generation, and an explicit never-silent re-verify action. `Origin` (`src/context/types.ts`) gained `reliability?: 'live-verified' | 'best-effort-inferred'` and `lastVerifiedAt?: string` — closing a confirmed gap from the architecture review (Challenge 3: `confidence` existed on `Origin` but was never actually set by a live connection anywhere). `BaseAdapter.snapshotToGraph()` now sets `confidence: 1.0, reliability: 'live-verified', lastVerifiedAt` on every node from a live extraction; `fileIngestion.ts`'s `baseOrigin()` sets `reliability: 'best-effort-inferred'` (a structural parse is a real fact about the *file*, but has never been checked against the *live* source — a real distinction). `ContextFileManager.buildContextPrompt()`'s table listing now flags `best-effort-inferred` tables inline (`_(file-derived, not live-verified)_`) so the LLM and the user both see the difference instead of every table looking equally solid. New `AutoDE: Re-verify Source Schema` command (`reVerifySourceSchema`) — re-runs the existing `sourceAssessment` extraction, diffs the source-tagged table set before/after via a new `listSourceTableFqns()` bridge method, and reports the drift in plain terms (new/still-present/no-longer-found), never silently dropping a missing table from context on its own initiative (a permissions change or network blip shouldn't make a table silently vanish — it's flagged for the user to investigate instead). This closes out all 7 steps of the plan in `after-phase-3b-are-graceful-lagoon.md` Part 3.

- **(v0.25.0)** Spec state synchronization — Phase 1 of the MCP Engine & Portable Skill Registry roadmap (`docs/mcp-engine-requirements.md` §8/§9.0; companion `docs/context-layer-requirements.md`). Fixes a live bug: `SpecManager`, `PipelineSpecManager`, `SourceContextManager`, `TargetContextManager`, `MappingContextManager` and `SemanticLayerManager` loaded their YAML once and served it from memory, and the only `.ai-context` watcher (`ContextFileManager`) was non-recursive, so an edit made by any other process (Claude Code, Copilot, `git pull`, a second window) went unnoticed and the next AutoDE save overwrote it with the stale copy. New `src/context/RevisionedFile.ts`: compare-and-swap persistence keyed on a SHA-256 revision of the file bytes — every manager now reads and writes its file through one, a write is refused with `RevisionConflictError` when the file changed on disk since it was last read or written, and the refused change is no longer adopted in memory (each manager now writes *before* updating its cached copy). An unparseable external edit keeps the loaded copy and leaves the expected revision stale, so the next save asks rather than clobbering an in-progress hand edit. Takes the VS Code API from its owner rather than importing it, keeping the module free of a runtime `vscode` dependency until Phase 2's node-fs `ContextStore` replaces it. New `src/context/ContextFileWatcher.ts`: one recursive watcher over `.ai-context/**/*.{yaml,yml,json}`, debounced per path, ignoring `.<name>.tmp.*` temp files and `history/` archives. Deliberate deviation from the spec text: added alongside `ContextFileManager`'s top-level watcher rather than replacing it, so that watcher's existing business-context re-index scope is unchanged. `webviewProvider.ts` routes each changed path to its owning manager's new `reload()` (own writes are filtered out because the revision still matches what the manager last wrote), then refreshes dependants: a spec reload re-syncs `hub.setSpec()`, re-posts the spec and context gate, and pushes a fresh artifact-staleness report; a change to `active-problem.json` switches the active problem. A refused save raises a Reload from Disk / Overwrite prompt via a module-level conflict handler, so the prompt appears even where a caller catches and only logs the error. New `AgentHub.pauseForExternalChange()`: a Business Problem Spec or Pipeline Spec change during execution lets the running step finish and pauses before the next (simplification vs. spec §8.6: pauses on any external change while running instead of comparing revisions recorded at start — equivalent, since AutoDE's own writes never reach this path). Also: `package.json` version aligned from a stale `0.13.0` to `0.25.0`; a pre-existing `no-useless-escape` lint error in `fileIngestion.ts`'s DDL regex fixed so lint is error-free. 7 new tests (200/200).

- **(v0.26.0)** Engine boundary and context store — Phase 2 of the MCP roadmap (`docs/mcp-engine-requirements.md` §4, §7.4). No behaviour change. **Move** (`git mv`, history kept, 47 files): `core/types.ts`→`engine/types.ts`; `core/transforms/`→`engine/transforms/`; `core/pipelineSpec/`→`engine/pipelineSpec/`; `core/skillRegistry.ts`, `core/toolSkills.ts`→`engine/skills/`; `dqm/**` and `core/providerRegistry.ts`→`engine/platform/`; `context/types.ts`, `Yaml.ts`, `fileIngestion.ts`, `ContextValidator.ts`→`engine/context/`. Every importer was rewritten directly — no re-export shims remain. `.eslintrc.cjs` now rejects any `vscode` import (type-only included) under `src/engine/**`, and a functional test loads every `dist/engine/**` module in plain Node with no VS Code available. **Splits:** platform `QueryOptions`/`ExtractOptions` take an `AbortSignal` (`signal`) instead of a `vscode.CancellationToken` (no caller passed one); `IDataSourceAdapter` extends a local `Disposable`; schema-graph persistence moved out of `BaseAdapter` into `ConnectionManager.persistSchemaContext(snapshot, workspaceRoot: string, io: FileIo)` with `snapshotToGraph()` now public; `SnowflakeAdapter` gets CLI-execution consent as a constructor option and `ConnectionManager` as a `cliConsent` getter (read at connect time, like before) instead of reading VS Code settings; the engine's credentials index registers `env`+`cli` (`registerBuiltInCredentialResolvers()`) while the `vscode-secret-storage` resolver and `registerDefaultCredentialResolvers(secrets)` moved to `src/core/credentials/`. `providerRegistry.ts`'s deprecated, caller-less LLM helpers (`getSupportedLlmProviders`, `getLlmProviderDefinition`) were deleted — they were the only engine→extension import. `context/types.ts` lost its unused `IDisposable`. **Context store:** new `src/engine/context/contextStore.ts` replaces v0.25.0's `src/context/RevisionedFile.ts` — `ContextStore` (stateless revision-checked read/write), `RevisionedFile`, `RevisionConflictError` (now `filePath: string`), `writeFileAtomic`, all over a `FileIo` interface with a Node implementation (`nodeFileIo`, default — for the MCP server) and `src/context/vscodeFileIo.ts` for the extension, so managers keep reaching files through `vscode.workspace.fs` and remote/virtual workspaces keep working. **Host interface (§7.4):** `AgentHost { workspaceRoot, confirm(message, actionLabel), fileIo }` on `AgentExecutionContext.host`, built by `AgentHub.buildAgentHost()`; `ToolSkillAgent`'s Claude-run approval and `SourceAssessmentAgent`'s workspace/persistence now go through it, and `SourceAssessmentAgent` no longer imports `vscode`. Deliberate deviations from the spec text: `ContextStore` is built over `FileIo` rather than being Node-fs-only (keeps virtual-workspace support; the engine still defaults to Node); it takes absolute paths rather than workspace-relative ones; the managers' parse/version/archive logic stays in the managers for now (folds into the C2 assertion ledger instead of being moved twice); `extensionContext` stays on `AgentExecutionContext` until S1 removes `runOnCopilot`; the §4.4 MCP-handshake test arrives with the server in Phase 3 — the plain-Node load test covers the boundary until then. 202/202 tests, lint 0 errors.

- **(v0.27.0)** Reference problem, evaluation harness and baseline — context-layer Phase C1 (`docs/context-layer-requirements.md` §10, §11). No product behaviour change. **Reference problem** `test/reference/retail-orders/`: two source systems (`shop`, `crm`; 18 tables, 122 columns, both with a `customers` table), a 40-table irrelevant `hr_legacy` schema, a sample CSV with a duplicate key, the client's glossary (revenue = gross), an 11-turn engineer script carrying the five traps, a fixed reference plan, 30 questions (4 that must be answered "not known"), 8 structural artifact checks, and the golden assertions/semantic model C4/C5 will be scored against. **Harness** `npm run eval` (`test/eval/run-eval.cjs`): runs AutoDE's real code in plain Node behind a headless `vscode` stand-in backed by the real file system (`test/eval/lib/vscodeHost.cjs`); reaches AutoDE only through a system-under-test adapter (`test/eval/sut/baseline.cjs`) so later phases plug in new capabilities and are scored on identical inputs; routes every LLM call through `LlmRouter` (`offline` — calls refused, deterministic fallbacks; `record` — real provider, saves a cassette; `replay` — answers from the cassette, misses counted) by wrapping `LLM_ADAPTERS`. Measures ingestion fidelity, context delivery (with the noise schema imported last and first), answerability of each question from the context layer, QA accuracy (replay/record), trap detection, artifact grounding and artifact properties; writes `eval-report.md` + `eval-results.json` (git-ignored, rolling) — the frozen baseline is `baselines/v0.26.0-offline.{md,json}`. **Grounding checker** `src/engine/grounding/sqlGrounding.ts` (§10.1 items 1 and 3, reused by C3): resolves `FROM`/`JOIN` targets, aliases and qualified `alias.column` references against the ingested schema, treats CTEs / created objects / dbt models as internal, resolves dbt `source()`/`ref()`, and flags joins and casts across incompatible type classes — a pattern scanner, not a parser, with that limit stated in every report. **Baseline (offline, v0.26.0):** identifier grounding 0% (0/3 — template artifacts read invented tables such as `RAW_DB.PUBLIC.landing`, `raw_sales`); answerability 19.2% (5/26); traps 0/5; artifact properties 1/8 (only the negative "no invented ticket→order join" holds); source tables kept distinct 17/18; plan-step context 526 tokens. **Findings recorded, not fixed here** (C1 measures): (1) DDL ingestion labels every table `ddl.<name>`, dropping the source schema, so `shop.customers` and `crm.customers` collapse into one node; (2) with the noise schema imported first, the step context names 2/17 relevant tables and 20/40 noise tables — the global dump is order-dependent; (3) no column detail ever reaches a prompt; (4) every artifact appears twice in plan state (agents both call `context.addArtifact()` and return it; `executePlan()` keeps both). 206/206 tests, lint 0 errors.

- **(v0.28.0)** Tool skills on every provider + `allowed-tools` enforcement — Phase S1 of the roadmap (`docs/mcp-engine-requirements.md` §9.1; carried forward from the earlier Phase 4a/4b plan). **One execution path:** `ToolSkillAgent` no longer special-cases `claude`/`copilot` (`runOnClaude`/`runOnCopilot` removed) — it calls a new `AgentExecutionContext.runWithTools`, which `AgentHub.runConfiguredLlmWithTools()` implements as one `getLlmAdapter(provider).complete(...)` with a tool mode, so a skill runs on all seven providers with no skill changes. `ToolSkillAgent` now imports neither `vscode` nor any adapter, and `extensionContext` is gone from `AgentExecutionContext` (its only reader was the removed Copilot path). Done differently from the plan text: instead of extracting `buildLlmContext()` for the agent to build adapters itself, the hub hands agents the capability — agents stay host-agnostic. **Audit out of every loop:** new `LlmCompleteOptions.auditSink` — the OpenAI-style loop (openai/azure-openai/ollama), Anthropic, Gemini and Copilot loops append each `ToolCallAuditEntry` to it instead of discarding their audit; the result's `details.audit` carries it. Claude Code's CLI runs its own loop and appends nothing. **Allow-list:** new `src/engine/skills/toolAllowList.ts` — `resolveAllowedToolNames()` maps declared `allowed-tools` (Claude/OSS names such as `Read`, `Bash(git:*)`, `Grep`) onto AutoDE tools; nothing declared = no extra restriction (back-compat); declared-but-unrecognized = no tools, not every tool. `toolModeCeiling()` never grants `'full'` to a skill whose allow-list has no write/exec tool (`ToolSkillAgent.resolveToolExecutionMode`, which S2 extends with trust tiers). `toolSpecsForMode(mode, allowed)` moved into `agenticTools.ts` and is used by every loop; `LlmCompleteOptions.allowedToolNames` threads it through all adapters. Defence in depth: `executeAgenticTool` refuses (and audits as `denied`) any call to a tool the run wasn't offered. **Claude Code:** better than the old plan assumed — the CLI's `--tools` list is narrowed to the allow-list (`autode_read_file`→`Read`, `autode_search_files`→`Grep`, `autode_list_dir`→`Glob`, `autode_write_file`→`Edit`+`Write`, `autode_run_command`→`Bash`), and `acceptEdits` mode is used only when a write tool remains. Its whole-run approval now uses caller-supplied text (`LlmCompleteOptions.approvalPrompt`); for skills it states that the run is approved once and AutoDE can't audit or block individual calls. **Interview skills:** `SkillDefinition.systemPrompt` — required by the parser since the format shipped but never sent anywhere — is now rendered as each question skill's `approach:` line in the discovery prompt, so the in-app interview and the MCP prompts (§5.4) use the same text. The bundled `synthesis` skill's `systemPrompt` stays descriptive: synthesis uses its own built-in system prompt and never receives skills. Eval baseline unchanged (expected — S1 doesn't touch context or codegen). 215/215 tests, lint 0 errors.

- **(v0.29.0)** Assertion ledger and projection — context-layer Phase C2 (`docs/context-layer-requirements.md` §4, §8.1, §11). The context layer gets a system of record: every fact is an *assertion* in an append-only ledger, and the context graph is rebuilt from it. **Engine modules** (no `vscode`): `src/engine/context/assertions.ts` — `Assertion`/`Evidence`/`TrustTier` per §4.1, trust ordering, `trustToConfidence()` (verified 1.0, confirmed 0.9, documented 0.8, inferred 0.5), a monotonic ULID factory, canonical JSON; `assertionSchemas.ts` — one Ajv schema per kind for `value` (`relationship` = from/to entity+columns, cardinality; `key`/`grain` = column lists; `metric` needs an expression or definition; …) and `validateAssertion()`; `ledger.ts` — `AssertionLedger` over `.ai-context/ledger/<yyyy-mm-dd>.<sessionUlid>.jsonl` (one file per writer session, so a shared workspace merges cleanly), the seven event types with `causedBy`, `foldEvents()` (pure: events sorted by id, so file read order never matters), convenience mutators (`assert`, `confirm`, `reject`, `supersede`, `recordVerification`, `flag`) and `compact({ prune })` → `snapshot.json` plus the events after it; `projection.ts` — graph ⇄ ledger; `conflicts.ts` — the detector. `FileIo` gains optional `listDir`/`deleteFile` (Node and `vscode.workspace.fs` implementations). **Migration and sync:** every node and edge the existing producers put in the graph becomes a *mirror* assertion (predicate `node`/`edge`, the node or edge as its value), with trust from provenance per §4.3 (`live-verified` → verified, `llm` → inferred, from an approved spec → confirmed, otherwise documented) and evidence from the origin (introspection / spec field / file). `syncGraphToLedger()` asserts new facts, supersedes changed ones (timestamps and confidence alone are not a change), rejects vanished ones with a reason (`no longer present in <source>`), records a newer `lastVerifiedAt` from a live extraction as a `verified` event, and sends live business assertions about a changed or removed node to `needs_review` (the §8.1 dependency walk). Re-syncing an unchanged graph appends nothing, so migration is idempotent. **Projection:** `projectGraph()` rebuilds nodes/edges from `active` + `needs_review` assertions — mirrors give back exactly what they recorded, plus `supportedBy` (new optional field on `BaseNode`/`GraphEdge`) and `origin.confidence` from the strongest supporter's trust; live non-mirror terms, metrics (the first producer of the `metric` node type), rules and relationships add nodes/`related_to` edges. Output is in assertion-id (creation) order, deterministic and byte-identical for the same ledger. **Wiring:** `ContextFileManager.persistCompiledGraph()` is the one choke point — sync → detect + flag conflicts → re-project → `derived/graph.json` — so live discovery and the settings-panel Connect / Source Assessment flow (via the reindex after `schema-graph.json`), file ingestion, spec sync and the business-context files all write assertions; this closes the v0.19.0 gap where Source Assessment wrote no `SourceContext` record: it now writes project-wide (`specId` unset) `schema_fact` assertions. `loadAllFiles()` now starts from the ledger's projection (falling back to `derived/graph.json` for the one-time migration), merges a newer `schema-graph.json` by replacing only nodes from the same source (it used to replace the whole graph, dropping file-ingested tables), and re-reads `business-context.yaml`/`verified-queries.yaml` on top. This also fixes a latent bug: once `derived/graph.json` existed, its snapshot overwrote the freshly loaded business context, so later edits to the YAML never took effect. Business-term and verified-query node ids are keyed by name (`biz-term-revenue`, was `biz-term-1`), so reordering the file changes nothing and redefining a term supersedes it; those nodes now carry an `origin`. **Spec scoping:** an assertion with a `specId` is in scope only while that problem is active — `ContextFileManager.setActiveSpecId()` (called by `webviewProvider` on problem switch and spec approval; carried across the Source Assessment re-init). Switching problems leaves the other problem's facts live in the ledger, neither retracted nor projected. `webviewProvider` now persists after `synthesizeFromSpec()`, so spec facts reach the ledger. **Conflicts** (`detectConflicts()`, over active/proposed/needs_review): *definition* — two definitions of the same business name across glossary terms and metrics, whatever subject they were recorded under, with different formula text; *value* — same kind+subject+predicate, different value (key/grain column lists compared case-insensitively); *declared_key* — a claimed primary key that differs from the one the schema declares. `flagConflicts()` sends active sides to `needs_review` once (idempotent); proposals are already awaiting review. **Also:** `ContextValidator` dispatches the envelope schema's per-kind `definitions` (declared since v0.19.0, never referenced) on `kind` and validates `content`; failures are `warnings`, never `valid: false`, so old persisted data keeps loading. DDL ingestion keeps the declared schema/database (`shop.customers` and `crm.customers` were both `ddl.customers` — C1 finding 1, fixed) and honours table-level `[CONSTRAINT x] PRIMARY KEY (a, b)`. New command `AutoDE: Compact Context Ledger` (QuickPick: compact, or compact and prune — the only path that deletes history). `GraphManager.removeNodesWhere()`. **Eval:** new system-under-test `test/eval/sut/ledger.cjs` (default; `--sut baseline` keeps the v0.26.0 adapter). Until C4's extractor exists, it proposes each scripted turn's facts from `golden/assertions.yaml` as an extractor would — kind/subject/predicate/value, the turn as evidence, `inferred`/`proposed`, subjects resolved deterministically — withholding every outcome field (status, trust, `supersedes`, `conflictsWith`, verification), so what the ledger concludes is its own work; the report says so. Trap 1 now requires a conflict about revenue (C1 accepted any conflict). Fixture clarification: the golden net-revenue metric gains `name: Revenue` (the name turn t2 defines) and the gross glossary fact `term: Revenue`. **Results (offline, frozen as `baselines/v0.29.0-offline.{md,json}`):** traps 1/5 (was 0/5 — trap 1 caught by the definition rule); source tables kept distinct 18/18 (was 17/18); the ledger also surfaces trap 2's turns as a key conflict (t5 vs the DDL's declared key and vs t6) — reported, not counted, since recognising a *correction* is C4 work; everything else unchanged (answerability 5/26, grounding 0/3, artifact properties 1/8). **Deliberate deviations from the spec text:** (1) the graph's producers still write nodes, and the ledger mirrors them, instead of each producer emitting typed assertions (`schema_fact` per column etc.); mirrors make the migration exactly graph-equivalent, and typed assertions arrive with the producers that need them (C4 extraction, C5 semantic model); (2) a new kind `verified_query`, since §4.1 has no kind for the graph's verified queries; (3) a vanished fact is a `rejected` event by `system` with a reason — §4.2 has no retraction event; (4) conflicts are flagged with `flagged_needs_review` events and recomputed on each persist rather than stored; (5) `needs_review` assertions are still projected (they were active and are now contested — dropping them would silently remove context; the inbox/pack warning is C3/C4); (6) key, grain, decision and other non-definitional kinds are recorded and conflict-checked but not projected into the graph yet (the semantic model, C5); (7) "approving a container activates its proposed assertions" has nothing to act on until C4 creates proposals inside containers; (8) the ledger uses Node `fs`, like the rest of `ContextFileManager`, not `vscode.workspace.fs`. 231/231 tests (16 new: ULIDs, per-kind schemas, migration equivalence + idempotence across sessions, deterministic folding, supersession/retraction/dependency walk, lifecycle folding, the three conflict rules, spec scoping, subject resolution, non-mirror projection, compaction/prune, per-kind validation, DDL schemas, and ContextFileManager end-to-end), lint 0 errors.

- **(v0.30.0)** Context packs, grounding manifests and causality — context-layer Phase C3 (`docs/context-layer-requirements.md` §7.1, §7.3, §8.3, §10.1, §11). Every LLM call now gets context for *its* task instead of the one global dump, and every generated artifact can show what it was built on. **Engine (no `vscode`):** `src/engine/context/retrieval.ts` — `resolveText()` (deterministic free-text → graph nodes: qualified names, `<table>.<column>`, schema mentions such as "the shop and crm source schemas" → every table in them, table labels in prose with singular/plural and multi-word matching — "support tickets", "order" — ambiguous labels match every candidate, term/metric names) and `expandNeighborhood()` (BFS with distance decay, both edge directions; `GraphManager.traverseNeighborhood()`, unused since its introduction, now delegates to it). `contextPack.ts` — `buildContextPack({ purpose, seeds?, query?, maxTokens?, stepId? }, { graph, assertions, conflicts, runtimeFacts })`: seeds from `seeds` + `resolveText(query)`; hops per purpose (step 2, others 1); score = relevance × trust weight (verified 1.0, confirmed 0.95, documented 0.7, inferred 0.4); mandatory sections first — warnings (conflicts and `needs_review` items touching the scope, context gaps), STRICT rules linked to the scope or naming a seed table or one of its columns, keys/grain on seed tables — then seed tables *with columns* (name, type, PK, NOT NULL), neighbours collapsed, relationships among tables in the pack, terms, verified queries; a per-purpose token budget (step 3000, plan 2500, qa 2500, chat/spec 2000, interview 1500) with anything left out summarised by count. Returns text + `PackManifest { packId, purpose, mode, seeds, nodeIds, assertions[{id, revision, trust, status}], truncated, tokenCount, gaps, warnings }`; deterministic (`packId` is a content hash; `assertionRevision()` a hash of the assertion's content and status). **No seeds = project overview, byte-for-byte the pre-C3 `buildContextPrompt()` output** — which is now a thin wrapper, so a call with nothing to scope by sees no change. `ContextPackProvider` interface (`buildPack`, `sources`, `supplementary`, `specRevision`). `contextGaps.ts` — §7.3 relationship gaps: a request that combines two entities ("<A> per/by/for each <B>", "join <A> to/with <B>", "<A> joined to <B>") with no join path between them at the required trust (default ≥ confirmed; paths ≤ 3 hops over foreign-key and projected relationship edges, plus proposed relationship assertions at `inferred`) → `ContextGap { needed, subject, reason: absent | below_trust, minTrust, foundTrust }`, phrased as a question by `describeGap()`. `src/engine/grounding/manifest.ts` — `backDecisions()` maps each decision-bearing primitive parameter (`*key*`, `partition*`, `grain`, `orderBy*`, `incremental`, …) to the assertion that justifies it (a live key/grain assertion with the same columns, else the schema's declared PK; ordering/incremental columns ← a live `decision` naming the column) or records it `unbacked` / `belowTrust`; `checkRules()` machine-checks STRICT masking rules (every reference to a column the rule names must sit inside a hash/mask function) and lists other STRICT rules for manual review; `buildGroundingManifest()` (§8.3 shape: artifact, spec id/version/revision, plan step, agent, generation method, primitives, packId, assertions with `usedFor`, decisions, overrides, gaps, and the §10.1 results — identifier resolution and type compatibility via C1's `checkSqlGrounding`, decision backing, rule compliance, `GROUNDING_UNRESOLVED`/`GROUNDING_UNBACKED`/`RULE_VIOLATION` warnings); `manifestStaleReasons()` (fact-level impact analysis: a relied-on assertion superseded / rejected / under review → *"dedup.partitionByColumns changed: "…" was superseded by … (chat message t3)"*); `explainManifest()`; `renderGroundingReport()`. **Hub:** `AgentHub.setContextProvider(provider, onPack)`. `executePlan()` builds a pack per step (`purpose: 'step'`, query = the step's task) and passes it plus the provider's supplementary Source/Target Context as `context.schemaContext`, instead of the plan-time context string; gaps are logged. New `AgentExecutionContext.recordGeneration` — called by the shared `generateViaPrimitiveOrFallback()` (primitive with params and version, or the freehand/template fallback), so no agent changed. After each step every returned artifact gets a manifest, written beside it as `<file>.grounding.json` (`ArtifactWriter.writeManifest()`, archived like the artifact), and at the end of the run a **Grounding Report** artifact (validation phase). `getStepPack()`, `getLastRunManifests()`. **Also fixed (C1 finding 4):** an artifact an agent both passes to `context.addArtifact()` and returns no longer appears twice. **Extension:** `ContextFileManager.buildContextPack()` / `getPackSources()` / a ring buffer of the last 50 packs; `webviewProvider` sends every LLM call a purpose-specific pack — chat (query = the message), plan generation (problem statement + objectives), spec drafting/refinement/synthesis and phase inference, interview turns, Pipeline Spec synthesis, tool skills — and registers itself as the hub's provider. New commands **`AutoDE: What the Agent Saw`** (pick any recent LLM call → the pack as sent, with seeds, assertion counts by trust, what was left out, gaps) and **`AutoDE: Explain This Artifact`** (active editor or explorer file → artifact → decisions → assertions → evidence, with current status and stale reasons). Checking artifact staleness now also reports fact-level staleness from the manifests (`reportFactStaleness()`, logged per artifact and posted as `artifactFactStaleness`). **DDL ingestion:** SQL comments are stripped before parsing — a trailing `-- PLACED, SHIPPED, …, RETURNED` comment's commas used to split into bogus columns and swallow the next real one (`shop.orders.channel` was lost); the reference sources now ingest all 122 columns. **Eval:** new system-under-test `test/eval/sut/packs.cjs` (default; builds on the C2 ledger adapter): per-step and per-question packs, chat turns sent with chat packs, plan executed with the hub's provider and an `ArtifactWriter`. The harness now measures step context per plan step (a table counts if any step's pack names it; tokens are the per-step median) and answerability per question, requires trap 4's gap to name tickets and orders, and reports decision backing and stale-fact use from the manifests; `--sut ledger` / `--sut baseline` are the ablation. **Results (offline, frozen as `baselines/v0.30.0-offline.{md,json}`):** traps 3/5 (was 1/5 — trap 4 by a context gap, trap 5 with 0/40 noise tables in every step's pack, whichever order the schemas were imported in); answerability 13/26 (was 5/26; the ablation with the global dump on the same ledger stays at 5/26); step context 421 tokens median (max 1175) with column details, vs the same 477-token table-name list for every step before; 13 manifests written, stale-fact use 0; artifact duplicates 0 (was 13). Identifier grounding is unchanged at 0/3: offline, artifacts come from the template tier, which packs don't reach — measuring the LLM paths needs a recorded cassette (open item). **Deliberate deviations from the spec text:** (1) a step with a context gap is *not paused* yet — gaps are recorded in the pack, the manifest and the log and shown as warnings in the prompt; pausing ships with the Context Inbox (C4), where the engineer can answer them, since a pause with nothing to answer would only block runs; (2) C3 detects relationship gaps from text and decision gaps from manifests; key/grain/metric gaps for steps need the semantic model (C5); (3) freshness weighting (§8.2) is 1.0 until C6; (4) step seeds come from the step's task text, not yet from spec data flows / mappings (C5 consumption); (5) proposed assertions are not rendered into packs (only their conflicts and gaps) — principle C3: they're not facts until confirmed (C4's inbox); (6) when one step writes several artifacts, each manifest lists all of that step's primitive uses; (7) "What the agent saw" is a command opening the pack as a document rather than a panel button; (8) the per-run Grounding Report is produced by the hub rather than `DocumentationAgent`, so it covers every artifact including documentation steps'. 241/241 tests (10 new: text resolution, traversal, overview byte-equality, seeded packs incl. budget and determinism, relationship gaps incl. below-trust and confirmed, decision backing, masking checks, manifest + staleness + Explain + report, executePlan wiring end-to-end, DDL comments), lint 0 errors.

Next: **Phase 3b-iv — on-demand native driver acquisition + platform-onboarding UI** (§4.9) — the opt-in tier that fetches the real vendor driver from the npm registry only for a user who explicitly wants it, plus the "which platforms do you use" first-run wizard this and §4.8's onboarding flow both attach to. Pulling forward, in parallel: generalizing tool-skill execution beyond 2 of 7 LLM providers (§5.6), a hard prerequisite for the also-planned Superpowers/Git-sourced skill import. The remaining SpecOps polish (skills authoring guidance, intake-session persistence) is tracked in §10. The AutoDE Dashboard panel (parked in v0.13.0) is the next lifecycle-adjacent item.

---

## Table of Contents

1. [Overview & Architecture Philosophy](#1-overview--architecture-philosophy)
2. [Business Problem Specification & Spec-Driven Architecture](#2-business-problem-specification--spec-driven-architecture)
3. [UI Architecture](#3-ui-architecture)
4. [Context Layer](#4-context-layer)
5. [Multi-Platform Adapter Architecture](#5-multi-platform-adapter-architecture)
6. [Agent Orchestration](#6-agent-orchestration)
7. [LLM Integration](#7-llm-integration)
8. [Extension Architecture](#8-extension-architecture)
9. [File Structure](#9-file-structure)
10. [Implementation Phases](#10-implementation-phases)
11. [Design Decisions & Tradeoffs](#11-design-decisions--tradeoffs)
12. [Deterministic Execution Core & Declarative Specification Framework](#12-deterministic-execution-core--declarative-specification-framework)

---

## 1. Overview & Architecture Philosophy

### 1.1 What is AutoDE?

AutoDE is an AI-augmented VS Code extension for Data Engineering. It provides:

- A **conversation-first workspace** for planning, executing, and refining data engineering pipelines
- A **production-grade context layer** (knowledge graph + vector search + token-aware retrieval) that grounds LLM prompts in actual database schemas and business context
- **Multi-platform adapter architecture** that abstracts away platform-specific metadata extraction, SQL dialects, and capabilities
- **Agent orchestration** with an orchestrating/planning agent that decomposes objectives into DAG-based execution plans and routes to specialized sub-agents

### 1.2 Core Design Principles

| Principle | Rationale |
|-----------|-----------|
| **Conversation-first** | The chat is the central nervous system. Everything else (context, settings, connection status) is surfaced within or adjacent to the conversation, not siloed in separate tabs. |
| **Platform-agnostic agents** | Sub-agents ask "what" (extract metadata, run query, generate DDL). Adapters know "how" (which system tables to query, which SQL dialect to use). |
| **Progressive disclosure** | Show essential status at a glance (top bar), reveal detail on demand (expandable panels, slide-outs). |
| **Context visibility** | The semantic layer (database schemas, business terms, verified queries) must be visible and interactive — users should see what context is being fed into each prompt. |
| **Atomic operations** | All writes to `.ai-context/` use temporary staging + atomic rename to prevent corruption. |
| **Zero UI blocking** | Heavy compute (embedding, graph traversal, large file parsing) runs off the Extension Host main thread. |

### 1.3 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     VS Code Extension Host                    │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ extension.ts │  │ agentHub.ts  │  │ webviewProvider.ts │  │
│  │ (activate)   │  │ (orchestrator│  │ (message bridge)   │  │
│  └──────┬───────┘  │ + LLM calls) │  └────────┬───────────┘  │
│         │          └──────┬───────┘           │              │
│         │                 │                   │              │
│  ┌──────┴─────────────────┴───────────────────┴──────────┐  │
│  │                  Core Services                         │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐  │  │
│  │  │ ConfigManager│ │ LM Adapter   │ │ProviderRegistry│  │  │
│  │  └──────────────┘ └──────────────┘ └───────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  Context Layer                         │  │
│  │  ┌──────────────┐ ┌──────────────────┐                │  │
│  │  │ GraphManager │ │ContextFileManager│                │  │
│  │  └──────────────┘ └──────────────────┘                │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │            Multi-Platform Adapter Layer                │  │
│  │  ┌────────────────┐ ┌───────────────────────────────┐ │  │
│  │  │ConnectionManager│ │BaseDataSourceAdapter (abstract)│ │  │
│  │  └────────────────┘ └───────────┬───────────────────┘ │  │
│  │                     ┌───────────┼───────────┐         │  │
│  │                     ▼           ▼           ▼         │  │
│  │              ┌──────────┐ ┌──────────┐ ┌──────────┐  │  │
│  │              │Snowflake │ │Databricks│ │ BigQuery │  │  │
│  │              │ Adapter  │ │ Adapter  │ │ Adapter  │  │  │
│  │              └──────────┘ └──────────┘ └──────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  Sub-Agents                            │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │  │
│  │  │ Discover │ │  Model   │ │  Build   │ │ Validate │ │  │
│  │  │  Agents  │ │  Agents  │ │  Agents  │ │  Agents  │ │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                     Webview (sidebar.html)                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Top Status Bar [Provider] [Connection] [Context] [Plan]│  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Chat Stream (messages, plan cards, context previews)   │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Context Drawer (collapsible)                           │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Chat Input + Action Bar                                │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Slide-Out Panels: Settings / Workflow Palette          │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Business Problem Specification & Spec-Driven Architecture

> **North star.** This section defines AutoDE's governing flow. It supersedes the earlier "objective → plan" model. `docs/requirements.md` remains the authoritative requirements source.

### 2.1 Principle

AutoDE is **conversation-driven and specification-driven**. The user describes a business problem in natural language; AutoDE transforms it into a structured, reviewable, versioned **Business Problem Specification (BPS)**. The BPS — not the raw prompt — is the **system of record** for the repository and governs all subsequent activity.

### 2.2 The Business Problem Specification artifact

| Field | Purpose |
|-------|---------|
| `id`, `version` | stable identity; version increments on each approval |
| `status` | `draft` → `approved` → `superseded` |
| `problemStatement` | refined statement (from the user's prompt) |
| `objectives` | measurable business outcomes |
| `successCriteria` | how we know it is solved |
| `scope.in` / `scope.out` | boundaries |
| `constraints`, `assumptions` | guardrails |
| `domain`, `stakeholders`, `keyEntities` | context hints for context-building |
| `targetEnvironment` | platform + modeling + transformation tooling |
| `createdAt/updatedAt/approvedAt/approvedBy` | audit |

Persisted and versioned in `.ai-context/spec/business-problem.yaml` (git is the version history).

### 2.3 Spec-driven flow

```
prompt ──(LLM analysis)──► BPS (draft)
                            │ user reviews → approves (or regenerates)
                            ▼
                       BPS (approved, vN)
                            │ (LLM assessment)
                            ▼
                    Phase plan (which phases + dependencies)
                            │
              ┌─────────────┴──────────────┐
              ▼                            ▼
   Continuous context creation      Orchestrated execution
   (repo assets + sources +         (agents in dependency order)
    platform metadata)                      │
              └─────────────┬──────────────┘
                            ▼
               Palette = live status view
```

### 2.4 Traceability

Every `GeneratedArtifact`, context node (`Origin`), and workflow phase carries `specId` + `specVersion`.

### 2.5 Phase inference (no manual step selection)

From the approved BPS, AutoDE determines which phases (discover / model / build / validate) are required and their dependencies. The user does **not** select workflow steps; the workflow is inferred and continuously adapted.

**Implemented (v0.6.0).** `src/core/phaseInference.ts` is a pure, deterministic module:
- `inferPhases(spec)` — keyword evidence across the problem statement / objectives / success criteria / scope / constraints / assumptions / domain / key entities marks a phase required; `scope.out` exclusions veto a phase; an underspecified-but-approved spec defaults to the full workflow; a build (transformation) phase implies discovery when source evidence exists.
- `buildPhaseDependencies(required)` — the natural predecessor chain (discover → model → build → validate) is pruned to the required set, so a phase depends only on required predecessors.
- `computePhaseStatuses(phases, steps, currentPhase)` — derives live status per phase from the plan: `completed`, `in-progress` (running or partially done), `blocked` (a dependency is unsatisfied or a step failed), `pending`, or `unrequired`.
- Orchestration integration in `AgentHub`: `inferPhasesFromSpec()` is invoked on spec approval, on work-space load with an approved spec, and on reset; `buildPlanPrompt` receives the required phases so the LLM only plans steps for those phases; every step is tagged with its phase at plan time; every state emit recomputes phase statuses.

### 2.6 Continuous context creation

Context layers (industry / enterprise / domain / system / definitions / queries / artifacts) are built **automatically** from the BPS + repository assets + registered sources + platform metadata — not a manual step. `SourceRegistry` + `SynthesisPipeline` (Phase 2) are the foundation; the spec drives *what* to build.

### 2.7 Workflow Palette as status view

The palette shows (top → bottom): BPS summary (read-only + status + approve/regenerate) → phase status (completed / in-progress / blocked / pending) → next action. It is a **transparent view**, not a manual launcher.

**Implemented (v0.6.0).** The palette's four phase rows are driven by `PlanState.inferredPhases` on every `stateUpdate`: each row shows a status badge, the deterministic inference reason, and the dependency chain; unrequired phases are dimmed and show no run buttons; completed phases disable their run buttons; the surfaced agents are read from the selected phase only.

### 2.8 Agentic Specification Generation (SpecOps)

The BPS draft is produced by an **agentic, DE-tailored requirements flow** inspired by the Superpowers SDLC (skills + explicit phases + review gates), rather than a single-shot prompt.

**Skills.** `skills/*.json` define composable DE skills — Requirements Discovery, Source Catalog, Data Flow, Transformations, Quality & Acceptance, Constraints & Assumptions, and Synthesis. Each carries a system prompt, question guidance, and the spec fields it owns. `SkillRegistry` (`src/core/skillRegistry.ts`) loads bundled skills plus optional user overrides in `.ai-context/skills/` (later entries win).

**Engine.** `SpecOpsEngine` (`src/core/specOps.ts`) is a deterministic state machine (`discovery → synthesizing → draft → refining → approved`) that tracks per-field coverage and a turn budget, and validates the prompt-schema **actions** the LLM returns each turn (`ask` / `ask_many` / `synthesize` / `done`). No native tool-calling is used — actions are JSON, validated deterministically, so the loop works on Copilot's `vscode.lm` and the Claude Code CLI as well as OpenAI/Anthropic/Ollama.

**Loop.** `AgentHub.discoverNextAction` renders the discovery prompt (`specOpsPrompts.ts`) and returns a validated action. The webview renders a single question as a chat bubble or a batch (`ask_many` with 2+) as a dynamic multi-field intake form (`specQuestions` / `submitSpecAnswers`). When coverage is complete or the turn budget is exhausted, `AgentHub.synthesizeComprehensiveSpec` assembles the comprehensive v2 spec (business requirements, data flows, transformations, dependencies, acceptance criteria, implementation considerations, source catalog) with per-field provenance, which is persisted by `SpecManager` and shown in the review card.

### 2.9 Revising an approved specification

**Implemented (v0.9.0, Phase A).** An approved spec is never mutated in place — every revision runs through the *same* SpecOps engine used for a brand-new spec, seeded with the approved content, and always produces a new draft `version + 1` that must be reviewed and re-approved.

**Entry points.**
- Spec card "↻ Revise" → webview posts `startRevision` → `DataAgentHubWebviewProvider` sets a one-shot `pendingRevision` flag (only when the current spec's `status === 'approved'`; a draft spec doesn't need it — its next message already revises in place, unchanged).
- The next `chat` message, while `pendingRevision` is set, calls `handleSpecDiscovery(message, previousSpec)` instead of `hub.chat()` — same function the fresh-discovery path uses, now revision-aware via an optional second argument.
- `/spec <change>` while the spec is `approved` routes through the same path (`case 'refineSpec'` in `webviewProvider.ts`) rather than the older single-shot `reviseSpec()`/`generateSpec()`, closing a second entry point into the same bug (see below).

**Session seeding (`createIntakeSession`, `src/core/specOps.ts`).** When `previousSpec` is supplied: the `problemStatement` argument is reinterpreted as `changeRequest`; the session's own `problemStatement` falls back to the previous spec's; `specId` is set from the previous spec. Coverage still starts all-`'missing'` (deliberately — see rationale below), so the LLM, not a coverage shortcut, decides how much to ask.

**Prompt visibility (`specOpsPrompts.ts`).** `renderSpecSnapshot(spec)` renders a compact textual snapshot of every populated field. `buildDiscoveryTurnPrompt`/`buildSynthesisPrompt` prepend it (plus the change request) when `session.previousSpec` is set, and append extra system-prompt rules (`REVISION_DISCOVERY_RULES` / `REVISION_SYNTHESIS_RULES`): only ask about what the change affects or what's still empty; the synthesis output must be the **full** spec, carrying forward everything untouched. Both prompt builders also accept an optional `extraContext` string — `AgentHub.discoverNextAction`/`synthesizeComprehensiveSpec` thread through `ContextFileManager.buildContextPrompt()` (registered sources) and `session.attachments` (ad-hoc files, see below) automatically.

*Why coverage isn't pre-seeded from the previous spec:* `SpecOpsEngine.shouldSynthesize()` treats "no field is `'missing'`" as license to skip straight to synthesis without ever asking the LLM. Seeding every populated field as `'partial'`/`'complete'` at session creation would trip that circuit-breaker on the very first turn, skipping discovery entirely. The turn-budget/coverage map stays a deterministic safety net; the *actual* "don't re-ask what's unchanged" behavior is a prompt instruction the LLM (already trusted to decide ask-vs-synthesize each turn) follows.

**Field-preservation safety net (`parseComprehensiveSpec`, `src/core/specSynthesis.ts`).** Independent of whether the prompt instruction is followed: every optional array/string field falls back to the previous spec's value when the new synthesis output leaves it empty (`orFallback`); the three required fields (`problemStatement`, `objectives`, `scope.in`) fall back the same way *before* their empty-value validation throws, so an under-specified revision turn can't spuriously fail. `buildProvenance` carries forward a field's *original* provenance entry (question id / skill) when the current session didn't address it, rather than relabeling it `'synthesis'`.

**Supplementary information.** A 📎 button next to the chat input posts `attachSpecFile`; the extension host shows `vscode.window.showOpenDialog`, reads the picked file via `vscode.workspace.fs` (capped at 200,000 bytes), and calls `SpecOpsEngine.addAttachment({path, content, attachedAt})` — rendered by both prompt builders as "Attached reference material." Works for any active `SpecOpsEngine` session (fresh discovery or revision), not revision-only.

**Known gaps (tracked in `requirements.md` §16.5):** `IntakeSession` (including the new `previousSpec`/`changeRequest`/`attachments` fields) is still in-memory only — lost on reload. The emergency fallback on a comprehensive-synthesis failure still re-drafts via the older v1-only `generateSpec`, which doesn't carry v2 fields.

### 2.10 Versioning & governance (Phase B, v0.9.0)

**Design choice:** lean on git as the version/audit log rather than build a parallel in-app version store — `.ai-context/spec/` is already meant to be committed, so a second source of version truth would only drift from it.

- **`src/context/ArtifactWriter.ts`** now writes every spec-stamped artifact under a `<specId>.v<version>` folder (`ArtifactWriter.specTag(artifact)`), inserted **above** the artifact's own relative path — so a multi-file artifact (e.g. the dbt scaffold) keeps every filename a tool like dbt expects (`dbt_project.yml` stays `dbt_project.yml`); only a folder is added, never a filename prefix. Artifacts with no `specId` (legacy pre-Phase-B writes, or generated with no spec set) land directly under the phase directory as before.
- **`src/context/ArtifactStalenessScanner.ts`** (`scanArtifactStaleness(workspaceRoot, currentSpec?)`) walks `.ai-context/artifacts/<phase>/*`, recognizes `<specId>.v<version>` folder names via regex, and classifies each as `current` (matches the approved spec's id+version), `stale` (same id, older version), or `unknown-spec` (different id, or no spec currently approved). Files sitting directly under a phase dir (no version folder) are counted separately as `untaggedFileCount` — this is *why* the folder scheme exists: `PlanState.artifacts` (which also carries `specId`/`specVersion`) is in-memory only and gone after a reload, so the filesystem path is the only durable record.
- **UI:** opening the Workflow Palette posts `checkArtifactStaleness`; the response renders a small "Generated Artifacts" section above the phase rows — a warning banner + list for `stale` groups, a quiet green line per `current` group, and a note for untagged/unknown files. Nothing is deleted or regenerated automatically.
- **"🕓 History"** on the spec card posts `viewSpecHistory` → `git log --follow -p -- <spec path>` (via `child_process.execFile`, `cwd` = workspace root) rendered as a chat message. Not a git repo, or no history yet → a clear message, not a crash.

### 2.11 Chat Sessions & Lifecycle (Phase F, v0.9.0)

**Design choice:** chat session identity is deliberately independent of BPS identity (confirmed via clarifying question) — a session can span several specs, and a spec can be discussed across several sessions, so `ChatSessionMeta.specId`/`specVersion` are a breadcrumb recorded at creation time, not a live foreign key kept in sync.

**`ChatSessionManager` (`src/context/ChatSessionManager.ts`).** One class, mirrors the rest of `src/context/`'s pattern (atomic metadata writes, one class per concern):
- `.ai-context/chats/<id>.meta.json` — `{ id, createdAt, updatedAt, status: 'active'|'archived'|'discarded', specId?, specVersion?, llmProvider?, title? }`, written via the same temp-file→`rename` pattern as `SpecManager`/`SourceRegistry`.
- `.ai-context/chats/<id>.jsonl` — one `ChatMessage` (`{ role: 'user'|'ai'|'log', content, at }`) per line. `vscode.workspace.fs` has no append primitive, so `appendMessage` is read-modify-write (whole file re-read, message appended, whole file rewritten) — an accepted cost at realistic chat lengths rather than an engineered-around one.
- Exactly one session is `status: 'active'` at a time; `getActiveSession()` is `listSessions().find(s => s.status === 'active')`.
- Gitignored (`.ai-context/chats/`) — unlike the committed BPS, transcripts are local/exploratory by explicit decision.

**`webviewProvider.ts` wiring.**
- On `resolveWebviewView()`, after the spec manager initializes: construct `ChatSessionManager`, `initialize()`, `getActiveSession()` or `createSession()` if none exists, load its transcript. **Changed in v0.13.0:** if that transcript is non-empty, the session is folded (`startNewChat()` — archived, never discarded, and a fresh empty one takes its place) rather than posted as-is; only an empty session is posted directly via `chatSessionLoaded` (`{ meta, transcript }`). A reload/restart therefore never silently resumes a prior conversation into view — see §8a.4 of `requirements.md`.
- `postMessage()` now also calls `recordAssistantMessage(type, payload)`, which maps the handful of assistant-facing message types (`chatResponse`, `specDrafted`, `specApproved`, `specQuestion`, `specQuestions`) to a `ChatMessage` and appends it to the active session — chat persistence is a side effect of the existing post path, not a parallel code path callers have to remember to invoke. User messages are appended directly at the `case 'chat'` / `case 'submitSpecAnswers'` handlers.
- New message cases: `newChat` → `startNewChat()`; `listChatSessions` → posts `chatSessionsList`; `openChatSession` → **(v0.13.0, changed from a read-only viewer)** archives whatever's currently active, reactivates the chosen session (`ChatSessionManager.updateMeta(chatId, {status:'active'})`), and posts `chatSessionLoaded` with its transcript — a real resume, not a preview; `discardChat` → `ChatSessionManager.discardSession` after the caller's own confirmation.
- `startNewChat()`: if a `SpecOpsEngine` interview is in flight, calls `carryOverPartialInterview()` first, then tears down the engine; archives the current session (`archiveSession`, never a delete); creates a new one seeded with the current spec's id/version and the active LLM provider; posts `chatSessionLoaded` with an empty transcript. Now also called from the startup-fold path above, not just the "🗨 New Chat" action.
- `carryOverPartialInterview(session, workspaceRoot)`: implements the exact behavior specified by the user in response to a clarifying question that rejected three alternative designs (resume as live Q&A / block New Chat / silently discard). Renders the session's collected `answers`/`insights` as Markdown, writes it to `.ai-context/chats/carryover/<sessionId>.md`, registers it via `SourceRegistry.addSource(..., 'business_context', 'autode')`, and runs `SynthesisPipeline.synthesize()` so the partial answers become graph nodes *before* the interview state is discarded. A no-op if the session collected nothing.

**Sidebar (`media/sidebar.html`).**
- "🗨 New Chat" topbar icon → `post('newChat')` (after `endPending()`, so an in-flight pending bubble doesn't leak into the new session's rendering).
- **New in v0.13.0:** "🕓" Chat History topbar icon, next to New Chat — opens a dropdown (`#chatHistoryDropdown`, styled like the `@mention` dropdown) populated by `listChatSessions`/`chatSessionsList`; clicking a row `post('openChatSession', {chatId})` to resume it. This is the "on need basis" counterpart to the startup fold.
- `case 'chatSessionLoaded': loadChatSession(msg.meta, msg.transcript)` — clears `chatStream`, resets client-side session flags (`discoveryActive`, `discoveryProgress`, `revisionArmed`, any pending bubble), shows the welcome block for an empty transcript, otherwise replays each `ChatMessage` through the existing `addMessage()`/`addLogEntry()` renderers keyed on `role`. Also now re-renders the Workflow Palette's spec section, so a stale "discovery in progress" view from a just-folded session doesn't linger.
- `case 'chatSessionsList': renderChatHistoryDropdown(msg.sessions, msg.activeChatId)` — new in v0.13.0. `chatSessionViewed` (the old read-only-preview response) is retired along with `openChatSession`'s old semantics; nothing posts or handles it anymore.

**Command Palette (`src/extension.ts`).** `AutoDE: New Chat` (`triggerNewChat()`), `AutoDE: Chat History` (`QuickPick` over `listSessions()`, opens the selected transcript read-only via `vscode.workspace.openTextDocument` — unchanged; this remains a read-only peek, distinct from the sidebar's new resume-capable picker above), `AutoDE: Discard Chat` (`QuickPick` + a modal `vscode.window.showWarningMessage` confirmation before `discardSession()` — irreversible, only ever behind this two-step flow).

**Explicitly deferred (see `requirements.md` §16.7):** a "distill this chat" Context Memory curation pass (LLM extraction of a transcript into graph nodes with `origin.source: 'chat'` provenance) is a separate concern from session persistence and has not been built; a fuller in-sidebar chat browser (search/tag/export/reopen) was scoped out of this pass, with the message-handling plumbing already in place for it.

### 2.12 Context Sync, Implementation Type & Plan Persistence (v0.10.0)

**Design choice:** reuse existing machinery rather than build parallel systems — spec→context sync reuses `SynthesisPipeline`/`GraphManager` (already built for registered-source ingestion), implementation-type classification reuses the deterministic keyword-evidence pattern `phaseInference.ts` already established, and plan persistence reuses `SpecManager`'s exact atomic-write-plus-history shape.

- **Context sync (closes the gap where nothing fed the approved spec's own content into the Context Layer).** `SynthesisPipeline.synthesizeFromSpec(spec)` maps `objectives`/`businessRequirements`/`dependencies` to `business_term` nodes and `constraints`/`assumptions` to `business_rule` nodes (STRICT / RECOMMENDED respectively), each stamped with `Origin.specId`/`specVersion`. It first calls `GraphManager.removeNodesBySourceRef('spec:' + spec.id)` so re-synthesizing on a later revision **replaces** the prior version's derived nodes rather than accumulating stale ones alongside them. Runs automatically inside the `approveSpec` handler — before `generatePlanFromSpec` is ever reachable — so the Context Layer is always current for the spec version a plan is about to be generated from. A durable, human-readable record is also written to `.ai-context/context/snapshots/<specId>.v<version>.md` (committed, unlike the transient `.ai-context/derived/graph.json`), capturing exactly what fed plan generation for that spec version.
- **`generatePlan`'s prompt now actually reads the Context Layer.** Previously only `chat`, `discoverNextAction`, and `synthesizeComprehensiveSpec` merged in `contextFileManager.buildContextPrompt()`; the `generatePlan` webview case passed the caller's raw (usually empty) `schemaContext` straight through. It now merges `buildContextPrompt()` the same way `chat` does, and `generatePlanFromSpec` does the same before delegating to `generatePlan`.
- **Implementation type (`src/core/implementationType.ts`).** `classifyImplementationType(spec)` scans the same spec-text corpus `phaseInference.ts` uses for keyword evidence of existing-system language (`existing`, `legacy`, `migrate`, `as-is`, …) vs. new-build language (`greenfield`, `from scratch`, `net new`, …); mixed evidence defaults to `brownfield` (the higher-risk assumption), no evidence defaults to `greenfield`. Computed at every spec draft/revision/synthesis point (`webviewProvider.applyImplementationType`), unless the user has explicitly overridden it (`setImplementationType` message → `implementationTypeOverridden: true`, preserved across later revisions rather than silently reclassified). Surfaced as a badge with a one-click flip in both the chat spec card and the Workflow Palette.
- **Phase applicability now considers implementation type and context.** `inferPhases(spec, implementationType?, contextSummary?)` — both new parameters are optional so existing callers are unaffected. A `brownfield` classification forces `discover` required by default (existing systems need assessment even absent explicit spec language) unless `scope.out` explicitly excludes it, which still wins. Note the **`unrequired` `PhaseStatus`** (§2.5) already *is* the Non-Applicable state the palette renders (dimmed, "⊘ Non-Applicable", with its `reason` string) — this section only widens what feeds the classification, it does not introduce a new status.
- **Plan persistence (`src/context/PlanManager.ts`).** Mirrors `SpecManager` exactly: atomic writes to `.ai-context/plan/plan.yaml`, every version-on-change archived to `plan/history/plan.v<n>.<status>.yaml`, restored into `AgentHub`'s in-memory `PlanState` on extension activation (`hub.loadPersistedPlan`) so the generated steps, inferred phases, status, and implementation type survive a VS Code reload — previously `PlanState` had no on-disk representation at all. `PlanState.artifacts` (execution-produced `GeneratedArtifact[]`) is **not** part of the persisted shape and remains in-memory-only, per §2.10's existing rationale for the artifact-folder spec-tagging scheme.
- **Artifact-level version history.** `ArtifactWriter.write()` now archives whatever previously sat at a given path to a `history/` subfolder before overwriting it, so re-running a step within the *same* `<specId>.v<version>` folder no longer silently discards the prior output — only cross-version staleness was tracked before (§2.10).

---

## 3. UI Architecture

### 2.1 Layout: Single-Column, Section-Based

The UI uses a single scrollable workspace with distinct sections. A thin, icon-based top bar provides quick navigation and status at a glance.

```
┌─────────────────────────────────┐
│ TOP STATUS BAR                  │  ← Provider, model, token usage, context stats
├─────────────────────────────────┤
│                                 │
│  CHAT / CONVERSATION STREAM     │  ← Primary interaction area
│  (scrollable)                   │
│    - User messages              │
│    - AI responses               │
│    - Embedded plan artifacts    │
│    - Execution progress cards   │
│    - Context assembly previews  │
│                                 │
├─────────────────────────────────┤
│  CONTEXT ASSEMBLY DRAWER        │  ← Collapsible: shows what context
│  (expandable)                   │     will be sent with next prompt
├─────────────────────────────────┤
│  CHAT INPUT + ACTION BAR        │  ← Message input, Send, Plan, Execute
└─────────────────────────────────┘
```

### 2.2 Top Status Bar

| Element | ID | Description |
|---------|-----|-------------|
| **Provider pill** | `providerPill` | Shows active LLM (e.g., "Copilot" or "Claude" with green dot). Clicking opens LLM settings. |
| **Connection pill** | `connPill` | Shows data platform connection status. Clicking opens connection settings. |
| **Context meter** | `ctxMetric` | Token/entity counter with mini progress bar. Clicking expands context drawer. |
| **Plan status** | `planMetric` | Shows plan step count and execution status. |
| **Refresh button** | `refreshBtn` | Triggers context re-index. |
| **Stop button** | `stopBtn` | Stops plan execution. |
| **Settings button** | `settingsBtn` | Opens slide-out settings panel. |
| **Workflow palette** | `paletteBtn` | (Phase 3a) Opens workflow palette. |

### 2.3 Chat Stream

The chat stream is the primary interaction surface. Every interaction — planning, execution, context queries — flows through this stream.

#### Message Types

| Type | CSS Class | Alignment | Description |
|------|-----------|-----------|-------------|
| User message | `.message.user` | Right | User's objective or follow-up. Accent-tinted background. |
| AI text response | `.message.ai` | Left | Markdown-rendered response with syntax-highlighted code blocks. |
| Plan artifact | `.plan-card` | Full-width | Interactive card with collapsible steps, timeline, and action buttons. |
| Context preview | `.ctx-preview` | Full-width | Collapsible block showing what context was used for a response. |
| Log entry | `.message.ai` (dimmed) | Left | System log messages at reduced opacity. Suppressed while a pending bubble is active — see below — routed into it instead. |
| Pending bubble | `.message.ai.pending` | Left | **Phase E, v0.9.0.** One per in-flight chat-initiated request (`beginPending()`/`updatePending()`/`endPending()` in `sidebar.html`). Animated `.typing-dots` + a `.pending-text` span updated in place by `logEntry` messages that arrive while it's active, removed by the terminal response (`chatResponse`, `specDrafted`, `specQuestion(s)`, `planUpdated`, `error`). Opening text is picked by `pendingLabelForChat()` from client-side state (`currentSpec`, `discoveryActive`, `revisionArmed`) — not a fixed string. `sendBtn` is disabled for the duration. |

#### Plan Card Structure

```
┌──────────────────────────────────────────────┐
│ 📋 EXECUTION PLAN                    [▼] [×] │
│                                              │
│ ○────●────◐────○  (execution timeline)       │
│                                              │
│ Step 1  ✅  Extract raw events from S3       │
│   Agent: ingestionAgent    Duration: 2.3s    │
│   └─ (expandable detail)                     │
│                                              │
│ Step 2  ⏳  Validate schema & null checks     │
│   Agent: sttmAgent         Depends on: Step 1│
│                                              │
│ [▶ Execute All]  [⏸ Pause]  [↻ Re-plan]     │
└──────────────────────────────────────────────┘
```

### 2.4 Context Drawer

A persistent, collapsible panel between the chat stream and input area:

- **Collapsed state**: 32px header showing summary stats
- **Expanded state**: Up to 260px showing entity chips organized by category
- **Categories**: Database Metadata, Business Context, Verified Queries
- **Chips**: Clickable pill-shaped elements that insert `@entityname` into the chat input
- **Actions**: Re-index button, Open .ai-context folder button

### 2.5 Slide-Out Settings Panel

Accessible via the ⚙ icon. Slides in from the right with a semi-transparent overlay.

**Inner tabs:**
- 🤖 **LLM Provider**: Card-based selection (Copilot, Claude Code, OpenAI, Anthropic, Azure OpenAI, Gemini, Ollama). Selecting a card auto-saves `activeLlmProvider` and updates the header pill immediately. The Copilot (`vscode.lm`) and Claude Code (CLI) cards are both no-API-key and share a consent toggle (auto-saves `languageModelProgrammaticConsent`); each card's **Test** button tests *that* provider regardless of which is active. Copilot adds Handoff; Claude Code adds a Detect button and an optional CLI-path field.
- 🔌 **Connections**: Platform cards (Snowflake, Databricks, BigQuery, Redshift, Synapse) with credential fields, Connect button, and Source Assessment button.
- ⚙ **Preferences**: Read-only mode, auto-documentation, telemetry, cache duration, query timeout.

### 2.6 Workflow Palette (Phase 3a)

Accessible via a 🧰 icon. Phase-organized action cards:

| Phase | Agents |
|-------|--------|
| 🔍 **Discover** | Source Assessment, Data Lineage, Quality Profiler, Current-State Architecture |
| 🎨 **Model** | STTM Mapper, Data Modeler, Business Glossary |
| 🔨 **Build** | Ingestion Pipeline, Transform Scaffold, DDL Generator, Orchestration |
| ✅ **Validate & Document** | SQL Validator, Test Generator, Documentation, Future-State Architecture |

Each card shows: icon, name, description, `[▶ Run]` button. Cards are disabled if prerequisites aren't met.

### 2.7 @-Mention System

Typing `@` in the chat input triggers an autocomplete dropdown populated from the context layer:

- `@orders` → resolves to `RAW_DB.PUBLIC.ORDERS`
- `@MRR` → resolves to the business term definition
- `@daily_active_users` → inserts the reference SQL

### 2.8 Slash Commands

| Command | Action |
|---------|--------|
| `/plan` | Generate execution plan |
| `/execute` | Execute current plan |
| `/context` | Expand context drawer |
| `/connect` | Open connection settings |
| `/settings` | Open settings panel |
| `/sync` | Sync database metadata |
| `/reindex` | Rebuild context index |
| `/clear` | Reset session |
| `/export` | Export plan (future) |

### 2.9 CSS Design System

All colors use VS Code theme CSS variables for native look and feel:

| Token | Usage |
|-------|-------|
| `--vscode-editor-background` | Main background |
| `--vscode-sideBar-background` | Cards, input areas, panels |
| `--vscode-panel-border` | Subtle separators |
| `--vscode-button-background` | Primary actions, accent elements |
| `--vscode-foreground` | Primary text |
| `--vscode-descriptionForeground` | Secondary text, labels |

**Semantic colors:**
- Success: `#2ea043` (green) — connected, completed, passed
- Warning: `#d29922` (amber) — pending, degraded, needs attention
- Error: `#f85149` (red) — failed, disconnected, error
- Info: `#58a6ff` (blue) — informational, links

**Spacing scale:** 4px base unit → 4, 8, 12, 16, 20px
**Border radius:** 4px (small), 6px (standard), 8px (cards), 999px (pills/chips)
**Font sizes:** 11px (captions), 12px (body), 13px (headings), 14px (icons)
**Transitions:** 120ms (fast), 200ms (normal), 300ms (slow)

---

## 4. Context Layer

### 3.1 Knowledge Graph (GraphManager)

**File:** `src/context/GraphManager.ts`

Thread-safe in-memory graph using maps and indexes:

| Feature | Implementation |
|---------|---------------|
| Node storage | `Map<string, BaseNode>` |
| Edge storage | `Map<string, GraphEdge>` |
| FQN index | `Map<string, string>` (fqn → nodeId) |
| Label index | `Map<string, Set<string>>` (label → nodeIds) |
| Type index | `Map<string, Set<string>>` (type → nodeIds) |
| Concurrency | Simple mutex (`Promise` chain) |
| Serialization | `serializeSnapshot()` / `loadSnapshot()` for worker transfer |
| Traversal | BFS with decay factor: `Relevance = SeedScore × (DecayFactor)^(HopDistance)` |
| Lifecycle | Implements `vscode.Disposable` |

#### Node Types

| Type | Interface | Description |
|------|-----------|-------------|
| `table` | `TableNode` | Database table with FQN, database, schema |
| `column` | `ColumnNode` | Table column with data type, nullability, PK/FK flags |
| `semantic_view` | `TableNode` (isView=true) | Database view |
| `business_term` | `BusinessTermNode` | Business glossary term with optional formula |
| `business_rule` | `BusinessRuleNode` | Rule with STRICT/RECOMMENDED enforcement |
| `verified_query` | `VerifiedQueryNode` | Reference SQL with dialect and table references |

#### Edge Types

| Type | Description |
|------|-------------|
| `contains` | Table → Column |
| `foreign_key` | Table → Table |
| `maps_to` | Business Term → Table |
| `uses_table` | Verified Query → Table |
| `constrained_by` | Business Rule → Table |

### 3.2 ContextFileManager

**File:** `src/context/ContextFileManager.ts`

Manages the `.ai-context/` directory:

| Feature | Implementation |
|---------|---------------|
| File watching | `vscode.workspace.createFileSystemWatcher` with 300ms debounce |
| YAML parsing | Custom lightweight parser (no external dependency) |
| Business context | Parses `business-context.yaml` → BusinessTermNode + BusinessRuleNode |
| Verified queries | Parses `verified-queries.yaml` → VerifiedQueryNode |
| Schema graph | Loads `schema-graph.json` snapshots |
| Mentionable entities | `getMentionableEntities()` returns all tables, terms, queries for @-mention |
| Context stats | `getContextStats()` returns counts + token estimates |
| Prompt assembly | `buildContextPrompt()` formats Markdown context block for LLM prompts |
| Lifecycle | Implements `vscode.Disposable` |

#### .ai-context/ Directory Layout

```
.ai-context/
├── schema-graph.json          # Generated: serialized knowledge graph
├── schema-graph.schema.json   # JSON Schema for validation
├── business-context.yaml      # Human-curated: business terms + rules
├── verified-queries.yaml      # Human-curated: reference SQL queries
├── sttm-mapping.yaml          # Generated: source-to-target mappings
└── architecture.md            # Generated: architecture documentation
```

### 3.3 Context Retrieval & Prompt Assembly

The `buildContextPrompt()` method formats context as compact Markdown:

```
## Enterprise Context Layer

### Business Rules (STRICT)
- **Rule name**: Rule text

### Database Tables
- `DB.SCHEMA.TABLE` — Description

### Business Terms
- **Term Name** (formula: ...): Description

### Verified SQL Queries
- **Query Name** (dialect)
```

Token budget enforcement and pruning will be implemented in a future `ContextRetriever` module.

---

## 5. Multi-Platform Adapter Architecture

### 4.1 Design Rationale

Different data platforms have fundamentally different:
- **Metadata tables**: Snowflake's `INFORMATION_SCHEMA` vs Databricks' `system.information_schema` vs BigQuery's region-qualified `INFORMATION_SCHEMA`
- **SQL dialects**: Snowflake SQL vs Spark SQL vs GoogleSQL vs T-SQL
- **Authentication**: Key-pair, OAuth, tokens, service accounts, external browser
- **Capabilities**: Column profiling, lineage extraction, CDC, streaming

The adapter pattern isolates these differences behind a common interface, so sub-agents never need platform-specific code.

### 4.2 IDataSourceAdapter Interface

```typescript
interface IDataSourceAdapter {
  connect(credentials: Record<string, string>): Promise<ConnectionInfo>;
  disconnect(): Promise<void>;
  extractMetadata(options?: ExtractOptions): Promise<SchemaSnapshot>;
  executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult>;
  getCapabilities(): PlatformCapabilities;
  translateDialect(sql: string, target: SqlDialect): string;
  getMetadataQueries(): PlatformMetadataQueries;
  persistSchemaContext(snapshot: SchemaSnapshot, uri: vscode.Uri): Promise<void>;
}
```

### 4.3 BaseDataSourceAdapter (Abstract Class)

**File:** `src/dqm/BaseAdapter.ts`

Provides:
- Common `extractMetadata()` orchestration (tables → columns → FKs → profiling)
- `snapshotToGraph()` conversion (SchemaSnapshot → knowledge graph nodes/edges)
- Atomic `persistSchemaContext()` (temp file → rename)
- Abstract methods that each platform adapter must implement

### 4.4 Platform-Specific Adapters

#### SnowflakeAdapter (`src/dqm/adapters/SnowflakeAdapter.ts`)

| Aspect | Detail |
|--------|--------|
| Metadata | `INFORMATION_SCHEMA.TABLES`, `.COLUMNS`, `.REFERENTIAL_CONSTRAINTS`, `.VIEWS` |
| Lineage | `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` (optional) |
| Profiling | Per-column `COUNT(DISTINCT)`, null count, `MIN`, `MAX` |
| Auth | Key-pair, OAuth, username/password, external browser, MCP |
| Capabilities | metadata ✓, profiling ✓, lineage ✓, CDC ✓, streaming ✓, DDL ✓ |
| Dialect | Snowflake SQL (native) |

#### DatabricksAdapter (`src/dqm/adapters/DatabricksAdapter.ts`)

| Aspect | Detail |
|--------|--------|
| Metadata | `system.information_schema.tables`, `.columns`, `.key_column_usage` |
| Profiling | `COUNT(DISTINCT)`, null count, `MIN`, `MAX` via Spark SQL |
| Auth | OAuth, personal access token |
| Capabilities | metadata ✓, profiling ✓, lineage ✗, CDC ✓ (Delta CDF), streaming ✓ |
| Dialect | Spark SQL — translates `UUID_STRING()` → `uuid()`, `ILIKE` → `lower() LIKE lower()` |

#### Future Adapters

| Adapter | Metadata Source | Key Differences |
|---------|----------------|-----------------|
| BigQuery | `region-us.INFORMATION_SCHEMA` | Region-qualified, different column types |
| Redshift | `PG_CATALOG` + `SVV_*` tables | PostgreSQL-based, different system tables |
| Synapse | `sys.tables`, `sys.columns` | T-SQL dialect, dedicated SQL pool vs serverless |

### 4.5 ConnectionManager

**File:** `src/dqm/ConnectionManager.ts`

| Method | Description |
|--------|-------------|
| `connect(platform, credentials)` | Disconnect existing, instantiate correct adapter, connect |
| `getActiveAdapter()` | Return current adapter or null |
| `extractMetadata(options?)` | Delegate to active adapter |
| `executeQuery(sql)` | Delegate to active adapter |
| `getCapabilities()` | Return active adapter's capabilities |
| `dispose()` | Disconnect and clean up |

Uses a `Map<DataPlatformProvider, AdapterFactory>` for adapter registration.

### 4.6 Type Definitions

**File:** `src/dqm/types.ts`

| Type | Purpose |
|------|---------|
| `PlatformCapabilities` | Boolean flags for metadata, profiling, lineage, CDC, streaming, DDL |
| `SqlDialect` | `'snowflake' \| 'spark_sql' \| 'google_sql' \| 'postgres' \| 'tsql' \| 'ansi'` |
| `ConnectionInfo` | Status, platform, database, schema, version, capabilities |
| `SchemaSnapshot` | Tables, views, columns, foreign keys, lineage edges |
| `TableMetadata` | FQN, type, row count, size, columns, comment |
| `ColumnMetadata` | Name, data type, nullability, PK/FK, ordinal, profile |
| `ColumnProfile` | Distinct count, null count, min/max, avg length |
| `ForeignKeyMetadata` | Source table/column → target table/column |
| `LineageEdge` | Column-level lineage with transform description |
| `PlatformMetadataQueries` | SQL query templates for metadata extraction |
| `QueryResult` | Columns, rows, row count, execution time |

---

## 4.7 Target Environment Configuration (Phase 3b)

### 4.7.1 Design Rationale

Data engineering workflows are inherently source→target. The source is discovered via the adapter layer (Phase 3a), but the target stack — platform, modeling approach, transformation tool, orchestration tool — must be defined by the user and maintained as a stable internal structure that all sub-agents can reference.

### 4.7.2 TargetEnvironment Type

```typescript
interface TargetEnvironment {
  platform: DataPlatformProvider;
  environmentProfile: 'development' | 'staging' | 'production';
  modelingApproach: 'dimensional' | 'data-vault' | 'obt' | '3nf' | 'raw-pass-through';
  namingConvention: 'snake_case' | 'camelCase' | 'PascalCase';
  transformationTool: 'dbt' | 'sqlmesh' | 'custom-sql' | 'stored-procedures' | 'none';
  orchestrationTool: 'airflow' | 'dagster' | 'prefect' | 'dbt-cloud' | 'manual' | 'none';
  outputFormats: ('ddl' | 'yaml' | 'markdown' | 'python' | 'sql')[];
  platformConfig: SnowflakeTargetConfig | DatabricksTargetConfig | BigQueryTargetConfig;
}
```

### 4.7.3 Profile-Based Configuration

Target environments support multiple profiles (dev/staging/prod) with inheritance:

```yaml
# .ai-context/target-environment.yaml
profiles:
  base:
    platform: snowflake
    modelingApproach: dimensional
    transformationTool: dbt
    orchestrationTool: airflow
  development:
    inherits: base
    platformConfig:
      database: DEV_DB
      schema: DEV_ANALYTICS
  production:
    inherits: base
    platformConfig:
      database: PROD_DB
      schema: ANALYTICS
      warehouse: WH_L
```

### 4.7.4 Target Extraction

The orchestrator uses a dedicated LLM call to extract target stack details from user messages. If critical fields are missing, it prompts the user for clarification. Once extracted, the target config is persisted to `.ai-context/target-environment.yaml` and injected into all sub-agent execution contexts.

### 4.7.5 Target-Aware Prompt Assembly

Plan prompts now separate source and target context:

```
## Source Environment
Platform: Snowflake (RAW_DB.PUBLIC)
Tables: orders, customers, products (15 total)

## Target Environment
Platform: Snowflake (CURATED_DB.ANALYTICS)
Transformation: dbt (dimensional modeling)
Orchestration: Airflow
Naming: snake_case
Output: DDL, YAML, Markdown
```

### 4.7.6 Files

| File | Purpose |
|------|---------|
| `src/core/types.ts` | `TargetEnvironment`, `TargetProfile`, `TargetConfigFile`, `GeneratedArtifact` types |
| `src/context/TargetConfigManager.ts` | Read/write/validate `target-environment.yaml` with profile inheritance |
| `src/core/agentHub.ts` | `extractTargetFromMessage()`, `buildTargetFromPartial()`, target-aware prompt assembly |
| `src/agents/build/IngestionPipelineAgent.ts` | Uses `targetEnvironment` for target-side DDL |
| `src/agents/model/SttmMapperAgent.ts` | Uses `targetEnvironment` for mapping output |
| `src/agents/validate/DocumentationAgent.ts` | Uses `targetEnvironment` for architecture docs |

### 4.8 Platform Onboarding & Credential Architecture (Phase 3a-i and 3a-ii implemented v0.16.0)

An architecture review (2026-09-17), deliberately done before Phase 3's real-adapter work (§10), designed how AutoDE discovers/reuses a locally-installed platform CLI (`snow`, `databricks`) and falls back gracefully otherwise — for both an interactive developer and a headless service account — without coupling the mechanism to Snowflake/Databricks specifically. Grounded directly in two existing facts: `src/core/claudeCodeAdapter.ts#resolve()` already implements the exact detection shape needed (3-tier cascade: explicit setting → PATH → bundled-extension; structured result, never throws), and `snowflake-sdk` (already a dependency) already reads the Snowflake CLI's own `connections.toml` natively via `createConnection()` called with no options. Both the credential-resolution foundation (Phase 3a-i) and the interactive onboarding UX (Phase 3a-ii) are now implemented, in `src/dqm/credentials/` and `webviewProvider.ts#connectToDataPlatform()` respectively. Phase 3b (real `snowflake-sdk`/Databricks-driver execution) is still not started.

**Two principals, one abstraction — implemented.** An interactive user at a workstation and a headless service account (CI, a scheduled job, a future server deployment) need different default paths, designed in together rather than one bolted onto the other later:

```typescript
// src/core/types.ts
type PrincipalType = 'interactive-user' | 'service-account';
interface AuthModeDescriptor { mode: string; principalTypes: PrincipalType[]; }

// src/dqm/credentials/types.ts
interface CredentialReference {           // stored in settings/Target Context — never the secret itself
  platform: DataPlatformProvider;
  principalType: PrincipalType;
  ref: string;                            // a CLI connection/profile name, an env-var prefix, a secrets-manager path
  resolverId: string;                     // 'cli' | 'env' | 'vscode-secret-storage' | 'keyvault' | ...
}

interface CredentialResolver {
  readonly id: string;
  readonly supportedPrincipalTypes: PrincipalType[];
  resolve(reference: CredentialReference): Promise<Record<string, string> | undefined>;
}
```

`ConnectionManager.connect()`'s existing `Record<string,string>` credentials contract (§4.5) is **unchanged** — a resolver becomes the thing that *produces* it, upstream of where `ConnectionManager.getCredentialsFromSettings()` does today (that migration itself is Phase 3b's job, not this sub-phase's — see below). `src/dqm/credentials/registry.ts` implements the module-level `registerCredentialResolver()`/`unregisterCredentialResolver()`/`resolveCredential()` extension point; `src/dqm/credentials/index.ts#registerDefaultCredentialResolvers()` wires the three built-ins up once, from `extension.ts activate()`:

- **`EnvVarCredentialResolver`** — documented `AUTODE_<PLATFORM>_<FIELD>` env vars (optionally `AUTODE_<PLATFORM>_<PROFILE>_<FIELD>` for a named profile), the simplest service-account path — no AutoDE-specific CI infrastructure, zero VS Code dependency. Full variable table in `engineering-onboarding-guide.md`'s Secrets section.
- **`CliConfigResolver`** — both platforms. For Snowflake, reuses `snowflake-sdk`'s native `connections.toml` loading rather than re-implementing a TOML parser: it only confirms the named connection exists (scanning for its `[name]` table header) and returns a `{connectionName, authMode: 'connections-toml'}` pointer, never the underlying field values. For Databricks (Phase 3a-ii), no vendor Node SDK with native `.databrickscfg` loading is chosen yet (that's Phase 3b's "new dependency"), so — for consistency with Snowflake's pointer-only contract — it likewise only confirms the named profile exists in `.databrickscfg` and returns `{profile, authMode: 'databrickscfg'}`, never the file's `host`/`token` values.
- **`VsCodeSecretStorageResolver`** — generalizes `ConfigurationManager`'s 3 hardcoded secrets (all Snowflake/LLM-specific) into one key scheme, `autoDataEngineeringHub.secret.<platform>.<principalType>.<profileOrRef>.<field>` (`secretStorageKey()`), covering whichever fields of a platform's credential set are actual secrets (e.g. Snowflake: `password`/`privateKey`/`privateKeyPassphrase`; Databricks: `token`/`clientSecret`). Additive alongside — not a replacement for — the 3 existing bespoke methods, which still serve today's settings-driven flow untouched.

Enterprise secrets managers (Key Vault, AWS Secrets Manager, Vault) are the documented `registerCredentialResolver()` extension point, not a shipped implementation — ship the interface, not every vendor; a unit test registers a fake resolver and drives it through `resolveCredential()` with no changes to `ConnectionManager`/either adapter.

**CLI detection (Phase 3a-ii — implemented)**, one `PlatformCliDescriptor` per platform (`src/dqm/credentials/PlatformCliDescriptor.ts`), same shape as `ClaudeCodeAdapter.resolve()` minus its "bundled with a VS Code extension" tier (there's no equivalent for a data-platform CLI):

```typescript
interface PlatformCliDescriptor {
  readonly platform: DataPlatformProvider;
  readonly binaryNames: { win32: string; default: string };
  detect(explicitPathSetting?: string): Promise<{ found: boolean; cliPath?: string; version?: string; source: 'setting'|'path'|'well-known-location'|'none'; error?: string }>;
  listConnections(cliPath: string): Promise<{ name: string }[]>;   // enumeration only — never opens a real connection
}
```

`cliDetection.ts#detectCliBinary()` implements the shared setting→PATH→well-known-directory cascade both descriptors use (the third tier added in §4.9 alongside live CLI testing); `cliRegistry.ts#getCliDescriptor(platform)` looks one up. **`SnowflakeCli`** shells out to `snow connection list --format json` purely to populate a picker — gated behind the new `dataPlatformCliConsent` setting, since (unlike detection's harmless version check) this actually invokes the vendor CLI; the *real* connection still goes through `snowflake-sdk`'s native `connections.toml` loading, never re-implemented by AutoDE. **`DatabricksCli`** deliberately sidesteps the unverified Databricks CLI subcommand surface entirely: `listConnections()` reads `.databrickscfg` directly (`databricksCfg.ts#readDatabricksCfgProfiles()`, a small ~40-line INI parser respecting `DATABRICKS_CONFIG_FILE`) instead of shelling out at all — no consent gate applies, since it's a local file read, not external-process execution. `detect()` (CLI presence/version) is still implemented independently for guided-install messaging.

**New command "AutoDE: Connect to Data Platform"** (`webviewProvider.ts#connectToDataPlatform()`, exposed via `triggerConnectToDataPlatform()`) — for the `interactive-user` principal type, requires an active business problem (`TargetContext` is spec-scoped): platform QuickPick → `detect()` → (Snowflake only) a one-time CLI-consent prompt → `listConnections()` → a QuickPick of found connections (or "enter credentials manually", falling back to the pre-existing Settings-panel/`testConnection` path) → resolves the chosen connection through the Phase 3a-i `cli` resolver → `ConnectionManager.connect()` for an immediate, staged-feedback test (`postLog` messages at every step, never a bare "Connection failed") → on success, saves platform + a new `TargetContext.credentialRef: {resolverId, ref}` pointer (merged onto any existing Target Context answers, `status` reset to `'built'`) via the pre-existing `TargetContextManager` — proving onboarding is a front door onto that model, not a parallel one. Choices use native VS Code QuickPicks, not a new bespoke webview wizard; staged feedback reuses the same `postLog`/`postMessage` channel every other chat-visible flow in `webviewProvider.ts` already uses.

**Service-account configuration (Phase 3a-ii — implemented)** is deliberately un-fancy: the `autoDataEngineeringHub.serviceAccountCredentialRef` setting (a JSON `{platform, resolverId, ref}` string) plus "AutoDE: Test Service Account Credential" to verify it resolves — no chat, no QuickPicker, no CLI-detection dialog, matching "a platform team scripts this once."

**Consent gating (decided):** `autoDataEngineeringHub.dataPlatformCliConsent` — a parallel, dedicated setting (not a broadened `languageModelProgrammaticConsent`), gating only an actual CLI shell-out (`SnowflakeCli.listConnections()`). CLI *detection* (a version-check shell-out) is exempt, mirroring `ClaudeCodeAdapter`'s own unguarded `--version` probe; `DatabricksCli.listConnections()` needs no gate at all since it reads a local file, never invoking an external process.

**`providerRegistry.ts` (§4.6-adjacent) is now consumed — implemented (Phase 3a-i).** Confirmed unconsumed anywhere outside its own module before this phase; `authModes` is now `AuthModeDescriptor[]`, and `getAuthModesForPrincipal(provider, principalType)` partitions by principal type (e.g. Snowflake `key-pair` → both, `oauth` → service-account, `external-browser`/`username-password`/`mcp` → interactive-user; Databricks `oauth-m2m`/`service-principal-token` → service-account, `oauth-u2m`/`personal-access-token` → interactive-user).

**A small, deliberate touch to two Phase-3b-owned stub files:** `SnowflakeAdapter.connect()`/`DatabricksAdapter.connect()` (`src/dqm/adapters/`) now also accept a CLI-derived, pointer-only credential (`connectionName` / `profile`) without requiring account/username/database or workspaceUrl/token — otherwise the CLI-derived onboarding path above could never demonstrate a working "connected" state today, since `CliConfigResolver` deliberately withholds those field values until Phase 3b's real execution reads them from the vendor's own config. `executeQuery()` on both adapters is untouched and still a stub.

**Known verification gap:** neither `snow` nor `databricks` was installed in the environment this phase was implemented in, so the "CLI found, real detection" path (`detect()` returning `found: true` against a genuine installed CLI) is implemented per each vendor's documented behavior but not verified against a live install. The "CLI not found" cascade, `.databrickscfg` parsing, and the Snowflake `connections.toml` presence-check are all verified against real files/mocked process output. The Databricks CLI-subcommand risk flagged in the original design is sidestepped by design (reading the stable config file instead of shelling out), not resolved by verification.

See `requirements.md` §17.6/§16.8 for the backlog entry and full rationale.

### 4.9 Real Snowflake/Databricks Execution (Phase 3b, core implemented v0.17.0; on-demand driver + onboarding UI not yet implemented)

The original Phase 3b plan was to wire the pre-existing `snowflake-sdk` dependency and a new `@databricks/sql` driver into the stub adapters. That plan was revised twice, in-session, on concrete evidence: measuring `@databricks/sql`'s real transitive footprint (Thrift, Apache Arrow, Winston, OpenID Connect client, 8 platform-specific native "kernel" binaries) alongside `snowflake-sdk`'s (the full AWS SDK, Azure Identity/Storage, Google auth — for bulk-load staging AutoDE never uses) put the combined dependency-tree cost at **~120MB**, not the few MB first assumed. Direct REST access was then evaluated as the replacement — until real-world feedback surfaced two problems with making REST the *default*: Snowflake's SQL API v2 measurably underperforms for large-scale catalog metadata extraction (AutoDE's core workflow), and it's a distinct REST surface a real slice of enterprises disable or network-restrict separately from Snowflake's native protocol (the wire path Snowsight, JDBC/ODBC, and the `snow` CLI all use instead).

**Net design: neither SDK is a dependency. A priority cascade, not a single default:**

1. **CLI-derived connection, native protocol (Snowflake only)** — a `connectionName`-bearing credential (`CliConfigResolver`, §4.8) shells out to `snow sql -c <connection> --format JSON_EXT -q "<sql>"` (`src/dqm/executionBackends/SnowflakeCliBackend.ts`), gated behind `dataPlatformCliConsent` (the same setting §4.8 already gates connection *listing* with — now also gates connection *execution*). This rides Snowflake's native protocol, not the separate SQL API, so it isn't subject to the network restriction above, and carries zero bundle weight. **Databricks has no equivalent** — its CLI is a thin wrapper over the exact same Statement Execution REST endpoint used below, confirmed by research — so a `profile`-derived Databricks credential is rejected with an explanation (`DatabricksAdapter.connect()`) rather than silently failing on a missing workspace URL.
2. **On-demand native driver, opt-in — not yet implemented.** The planned second tier: fetch `snowflake-sdk`/`@databricks/sql` from the npm registry's own metadata API (authoritative latest version + integrity hash, never a hardcoded version or an LLM-guessed one) into extension global storage, only for a user who explicitly opts in via a platform-onboarding UI. This is what gives a Databricks user without CLI access — or a Snowflake user on a locked-down machine — a native-protocol option beyond REST. See the plan file for the full design; not built in this pass.
3. **Direct REST call (the always-available fallback)** — `src/dqm/executionBackends/SnowflakeRestBackend.ts` (SQL API v2 — PAT/OAuth bearer token, or a key-pair JWT built with `crypto.sign('RSA-SHA256', ...)` alone, `src/dqm/adapters/snowflakeJwt.ts`, no signing dependency) and `src/dqm/executionBackends/DatabricksRestBackend.ts` (Statement Execution API — PAT/OAuth bearer, `warehouse_id` derived from the configured HTTP Path's last path segment). Both poll a non-terminal (`202` / `PENDING`/`RUNNING`) response to a genuinely terminal state rather than checking once and assuming success — a real bug pattern found in a public Airflow-provider issue during research, deliberately avoided here.

Each adapter's `connect()` picks the backend once (CLI-derived credential → tier 1; direct credential → tier 3 today) and stores it behind a small shared `ExecutionBackend` interface (`src/dqm/executionBackends/types.ts`) that `executeQuery()` delegates to — nothing downstream (`BaseDataSourceAdapter.extractMetadata()`, `ConnectionManager`) knows which backend is active. `connect()` also now runs a real validation query (`SELECT CURRENT_DATABASE()...` / `SELECT current_catalog()...`) and fails fast with a clear error on a bad credential, rather than the previous stub's unconditional "connected" response.

**New Databricks settings surface** (previously nonexistent — `ConnectionManager.getCredentialsFromSettings()`'s databricks case referenced a settings key, `workspaceUrl`, that was never declared in `DataAgentHubSettings`): `defaultDatabricksWorkspaceUrl`, `defaultDatabricksHttpPath` (the SQL warehouse's HTTP Path — also the source `warehouse_id` is parsed from), `defaultDatabricksCatalog`, `defaultDatabricksSchema`, plus a proper `databricksToken` secret (`SECRET_KEYS`, `ConfigurationManager.getDatabricksToken()`/`setDatabricksToken()`) replacing an ad hoc raw-string secret key used in a few places. `extension.ts`'s `testConnection` and `webviewProvider.ts`'s `runSourceConnectionCheck()` both overlay it now (previously only `runSourceConnectionCheck()` did — a real, pre-existing asymmetry, fixed alongside this).

`ConnectionManager.getSupportedPlatforms()` (new) reads `providerRegistry.ts` intersected with which platforms have a registered adapter factory — `providerRegistry.ts`'s second real consumer after §4.8's `getAuthModesForPrincipal()`.

`src/spokes/snowflakeExecutor.ts` no longer hardcodes `username: 'DATA_AGENT_USER'` or duplicates connection logic against `snowflake-sdk` directly — it builds credentials the same way `testConnection` does and delegates to `SnowflakeAdapter`, so it automatically gets the same tier cascade.

**Known verification gap, same discipline as §4.8:** no live Snowflake/Databricks account is available in this environment — the REST/CLI backends are implemented against the confirmed, current API/CLI contracts (see the plan file's research citations) and covered by tests using mocked `fetch`/`child_process`, not a real warehouse. A real large-schema extraction to confirm the tier-1-vs-tier-3 performance difference reported during design is flagged as a follow-up, not done here.

**Live-verified against a real production Azure Databricks workspace** (the user's own, via `.databrickscfg` — credentials never left that process, never logged). This surfaced and fixed three real bugs no amount of documentation-reading would have caught: (1) Unity Catalog's `information_schema` lives at `<catalog>.information_schema.*`, not `<catalog>.system.information_schema.*` as originally written; (2) `information_schema.views` has no `comment` column, unlike `.tables`/`.columns`; (3) the Statement Execution API's `manifest.schema.columns[].type_name` is Spark's internal type name, not SQL type text — a `BIGINT` column reports `type_name: "LONG"`, which `DatabricksRestBackend`'s value-casting now accounts for. Full `connect()` → `extractMetadata()` (with profiling) verified end-to-end against a real Unity Catalog catalog.

**Catalog-type handling is explicit-first, not silently inferred.** The same live workspace has both a legacy `hive_metastore` catalog (no `information_schema` support at all — confirmed live; only `SHOW TABLES` works, and Spark SQL can't reshape a `SHOW` command's output via `SELECT`/`WITH`, so bulk column/FK/view introspection isn't expressible as a single static query there) *and* dozens of real Unity Catalog catalogs, side by side. Rather than always inferring which shape applies from the catalog name, `defaultDatabricksCatalogType` (`'auto' | 'unity' | 'hive_metastore'`) lets a user state it explicitly per connection — `'auto'` (default) still infers from the reserved `hive_metastore` name for zero-config use, but an explicit setting always wins, and doubles as a manual escape hatch for any other catalog (a Lakehouse Federation catalog, an attached external Iceberg REST catalog, etc.) that turns out to share the legacy catalog's limitations, without AutoDE needing to special-case it by name. `BaseDataSourceAdapter.assembleTables()` also now recognizes Databricks' native `SHOW TABLES` column names (`database`/`tableName`) as a fallback, and `extractMetadata()`'s table/column listing steps are non-fatal (matching the FK/view/lineage steps' existing resilience) rather than aborting the whole extraction.

**On Polaris/Iceberg-federated catalogs specifically:** not independently live-verified (no such catalog was available to test against), but by design, any catalog that Unity Catalog or Snowflake itself manages — including an external Iceberg REST catalog (Apache Polaris, Snowflake Open Catalog) attached via Lakehouse Federation or a Snowflake Catalog Integration — is unified into that platform's own normal catalog/database model from a SQL client's perspective, so the existing Unity Catalog / Snowflake `INFORMATION_SCHEMA` queries should apply unchanged. `defaultDatabricksCatalogType`'s `'hive_metastore'` setting is available as an override if a specific federated catalog turns out not to behave that way in practice.

**Chat had zero awareness of a live connection, and the top status pill never updated after a successful connect — both real, both fixed.** Two separate "Connect" actions exist: the settings-panel "Connect" (`testConnection`) only proves connectivity; a full schema extraction only happens via the separate "Source Assessment" button, or via the Palette's "Connect to Data Platform"/`runSourceConnectionCheck` flow (which does both in one step). A user who only clicks the first "Connect" — the natural first thing to try — gets a real connection but a chat that still has nothing to say, since (a) `sidebar.html`'s `sendMessage()`/`generatePlan` slash command both hardcoded `schemaContext: ''` unconditionally, always, regardless of anything the user did (dead parameter — real schema context, once extracted, actually reaches chat through `ContextFileManager.buildContextPrompt()`'s `repositoryContext` instead, fed by `.ai-context/schema-graph.json` via a `FileSystemWatcher`-triggered reindex), and (b) nothing at all told the LLM a live connection even existed short of a full extraction, so it answered as if AutoDE had no database capability whatsoever. Fixed with a new `DataAgentHubWebviewProvider.connectionStatus` field, set via a public `notifyConnectionStatus()` called from `extension.ts`'s `testConnection`/`sourceAssessment` commands and from `runSourceConnectionCheck()` — driving both the top-of-panel status pill (`connDot`/`connLabel`, previously grabbed via `$()` but never once updated after being declared — confirmed dead UI) and a new always-included one-line chat context fact ("Connected to X, no schema extracted yet — suggest Source Assessment" when `ContextFileManager.getContextStats().tables === 0`, or the real detail once it's non-zero). This doesn't merge the two "Connect" actions or replace `repositoryContext` as the real schema-carrying channel — it just makes the gap between "connected" and "schema known" visible and self-explanatory instead of silent.

**A pasted folder path was silently accepted as if it were the binary, then failed with a confusing `ENOENT`.** Once the field above existed, live testing immediately hit it: `fs.existsSync()` can't tell a directory from a file, so an explicit `snowflakeCliPath` pointing at the CLI's *folder* (a completely natural thing to paste — e.g. from Explorer's address bar) was accepted as "found," and `spawnSync` then tried to execute the directory itself. `detectCliBinary()`'s explicit-setting branch now uses `fs.statSync()` first: a file is used as-is (unchanged behavior); a directory is auto-completed to `<folder>/<binName>` and re-checked as a file before being accepted.

**A configured `snowflakeCliPath` never actually reached the settings-panel connection flow — two real, separate drops, both fixed, plus a UI field added.** The setting itself (used correctly by the "Connect to Data Platform" QuickPick flow) was silently absent from `ConnectionManager.getCredentialsFromSettings()`'s snowflake case, so `SnowflakeAdapter.createCliBackend()`'s `this.credentials['snowflakeCliPath']` was always empty via the settings-panel "Connect" button, regardless of what was configured. It was also missing from `webviewProvider.ts`'s `updateSettings` field whitelist, so even a value the webview *did* send would have been silently dropped rather than persisted. Both fixed, and `media/sidebar.html`'s Snowflake card gained a "Snowflake CLI path (only if not found automatically)" field — directly closing the gap surfaced by this session's own CLI-detection work (§4.9): a real install on a non-default drive (`D:\Program Files\Snowflake CLI\`) is exactly the case the well-known-directory tier can't reach, and until now the only way to supply the explicit path was hand-editing Settings JSON.

**Consent gate now offers to fix itself instead of sending the user to Settings JSON.** Username/password auth's CLI path (below) needs the same `dataPlatformCliConsent` a CLI-derived connection already required — live testing hit exactly that on a first attempt. `extension.ts`'s `testConnection` command now recognizes that specific error and offers a `showErrorMessage` action, "Enable CLI Consent & Retry", that flips the setting via `configManager.updateSettings()` and immediately re-invokes the command — no manual Settings-search round trip.

**Non-secret fields already prepopulate on load (confirmed, not a gap); a secret field's *presence* now does too, without ever exposing its value.** `settingsLoaded`'s payload (now built once via a shared `buildSettingsMessagePayload()`, previously duplicated across two call sites) adds `snowflakeHasPassword: boolean` — computed from whether `configManager.getSnowflakePassword()` returns a value, never the value itself. `sidebar.html`'s password field placeholder changes accordingly ("Password already saved — leave blank to keep it..." vs the generic prompt), so a returning user can tell a password is on file without it ever being rendered back into the page — the write-only design (§ above) is preserved, only its *presence* is now visible.

**Three real bugs found live-testing the settings-panel "Connect" button, all fixed.** (0) "Connect" (`testConnBtn`) fired the `testConnection` command directly, which only ever reads already-*saved* VS Code settings — so typing Account/Username/Password into the form and clicking Connect without a separate "Save Settings" click first always failed with a stale "Missing credentials" error, even with the fields visibly filled in. Fixed by having "Connect" save first and chain off the extension's existing `settingsSaved` acknowledgment (not a fixed delay, which would race the actual persistence) before firing `testConnection` — `media/sidebar.html`'s `pendingTestConnectionAfterSave` flag. (1) The webview's "Connecting to database…" chat message was never followed up: the `testConnection` VS Code command it invokes only ever reported outcomes via native `showErrorMessage`/`showInformationMessage` popups, which the webview has no way to see — so the chat bubble looked permanently stuck regardless of whether the connection actually succeeded or failed. Fixed by adding `DataAgentHubWebviewProvider.logToChat()` (a thin public wrapper around the existing private `postLog()`) and having `extension.ts`'s `testConnection` command call it alongside each native notification, and by threading it through as `ConnectionManager`'s own log callback so in-progress connection messages reach the chat too, not just the final result. (2) Both `extension.ts`'s `testConnection` and `webviewProvider.ts`'s `runSourceConnectionCheck()` hardcoded Warehouse *and* Database as always-required for Snowflake — stale duplicated validation that never matched `SnowflakeAdapter`'s actual requirements (Database matters only for the REST tier; Warehouse isn't required by any path, since Snowflake falls back to the account's default warehouse) and drifted further out of sync once the username/password CLI path below was added. Narrowed both to only Account + Username — the two fields every Snowflake path genuinely needs — and left everything else to `SnowflakeAdapter.connect()`'s own accurate, path-specific error.

**Username/password auth, wired end-to-end through the UI into SecretStorage into a real execution path.** A `sfPassword` field was added to the Snowflake card in `media/sidebar.html` (the "Username + Password" auth mode already existed in the dropdown, but had no password input at all — a real, pre-existing gap). It's write-only by design: never re-populated from `settingsLoaded` (which only ever carries `ConfigurationManager.getSettings()`'s plain settings, never a secret value), and only included in the `updateSettings` message when non-empty, so an untouched blank field on a later save can never overwrite an already-stored password with an empty string. `webviewProvider.ts`'s existing (previously dead — nothing in the UI called it) `message.snowflakePassword` handler stores it via `configManager.setSnowflakePassword()`, i.e. VS Code `SecretStorage` — the same mechanism `VsCodeSecretStorageResolver` (§4.8) already generalizes for other platforms/principal types. On the execution side: since Snowflake's SQL API (tier 3) categorically cannot authenticate with a plain username/password, `SnowflakeAdapter.connect()` now routes a `username-password`-mode credential with a stored password to a **new tier-1 variant** — `SnowflakeCliBackend` accepts either a named `connections.toml` connection or an ad-hoc `{account, username, password, warehouse?, database?, schema?, role?}` spec, shelling out to `snow sql --account ... --user ... --password ... -q "<sql>"` instead of `-c <connection>`. This still rides the native protocol and the same `dataPlatformCliConsent` gate as the named-connection path — it does not touch REST at all, since REST has no way to accept this auth mode. The one caveat, stated plainly rather than hidden: `--password` on a command line is briefly visible to anything on the same machine that can list process command lines (Task Manager/`ps`) for the life of that one short-lived `snow` process — an inherent property of the CLI's own supported flag, not something AutoDE introduces; the password is never logged, written to disk, or included in an error message by AutoDE itself, and still lives only in `SecretStorage` between runs. A credential with `authMode: 'username-password'` but no password yet stored falls through to REST and gets an explicit, actionable rejection naming exactly what's missing, rather than a silent or generic failure.

**Live-verified against a real installed Snowflake CLI, and a real CLI-detection gap fixed as a result.** `SnowflakeCli.listConnections()`'s `connection_name`-based parsing was confirmed byte-for-byte against real `snow connection list --format json` output. Executing a query via `SnowflakeCliBackend` against a real account then hit a genuine, legitimate Snowflake network policy — `"Incoming request with IP/Token ... is not allowed to access Snowflake"` — correctly surfaced as an actionable error rather than something to route around; it independently confirms this session's own rationale for preferring the CLI-native-protocol tier (a restricted network path is exactly the real-world condition tier 1 is designed around, whichever specific surface a given enterprise restricts). This same test exposed that `detectCliBinary()` (§4.8) only ever checked an explicit setting or `PATH` — a real install in a standard location (e.g. Snowflake's own Windows installer default, `Program Files\Snowflake CLI\`) went undetected with neither configured. Fixed by adding a third, bounded tier: `detectCliBinary()` now accepts a `wellKnownDirs?: string[]` list of specific, documented install directories to check (not a filesystem or drive scan) between the `PATH` and `none` outcomes, reported as `source: 'well-known-location'`. `SnowflakeCli` supplies `%ProgramFiles%`/`%ProgramFiles(x86)%`/`%LOCALAPPDATA%\Snowflake CLI` on Windows and `/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin` on macOS/Linux; `DatabricksCli` supplies only the Unix paths, since no Windows default install location has been independently confirmed for it (guessing one would be worse than leaving it to `PATH`/the explicit setting). This deliberately does **not** cover every case — the real install verified here happened to be on a non-default drive (`D:\Program Files\...`, where `%ProgramFiles%` itself resolves to `C:\Program Files`), which only the explicit `snowflakeCliPath`/`databricksCliPath` setting reaches; that's an intentional boundary, not a gap, since a genuine directory/drive scan would be slow, unpredictable, and needlessly invasive for a VS Code extension to perform. Also fixed alongside: `SnowflakeCliBackend`'s error-detail extraction previously took the *first* 2000 characters of the CLI's combined output; live testing showed the CLI can emit a long, noisy internal traceback before its actual error box, which was getting truncated away. It now takes the *last* 2000 characters instead, so the actionable message survives truncation.

The on-demand driver acquisition tier and platform-onboarding checklist UI (Phase 3b-iv) remain not yet built — see this section's own notes above for what's implemented vs. deferred.

### 4.10 Runtime Context Unification (v0.18.0)

Live UI testing of the Phase 3b connectivity work above surfaced a structural bug, not a one-off: a successful live connection produced a chat response denying any database access, and the top status pill never updated. Root cause: "what does the LLM currently know" was assembled independently in ~7 different places (chat, `/plan`, `generatePlanFromSpec`, `generateSpec`/`refineSpec`, SpecOps discovery, codegen agents, `ToolSkillAgent`), each with its own gaps — two of the worst being a client-supplied `schemaContext` parameter `media/sidebar.html` hardcoded to `''` on every single chat/plan message (so it could never carry anything), and `generateSpec`/`refineSpec` including *no* context of any kind, not even repository content.

**Design: extend the existing `ContextFileManager.buildContextPrompt()` — already the closest thing to a unifying context object, since 5 of the 7 call sites already call it — with a generic, in-memory "runtime facts" slot**, rather than building a second, parallel context system:

```typescript
export interface RuntimeFact { label: string; text: string; }
// ContextFileManager.setRuntimeFact(key, fact | null) — never persisted to .ai-context/,
// cleared on reload by construction; buildContextPrompt() renders these under a new
// "## Live Session Facts" heading, ahead of the existing Enterprise Context Layer section.
```

`ContextFileManager` stays domain-agnostic — it doesn't know what "Snowflake" or "a connection" is, just generic `{label, text}` facts keyed by a caller-chosen string. This is the decoupling point: a fact *producer* (a connection command) and a fact *consumer* (a prompt-building call site) only need to know about this one shared object, never about each other. Because most call sites already call `buildContextPrompt()`, they gained runtime-fact awareness with zero code changes of their own.

**Connection status is now role-keyed (`source`/`target`), closing a second real gap found in the same investigation:** `ConnectionManager` (`src/dqm/ConnectionManager.ts`) is a strict single-connection-at-a-time model, and connection status used to be a single unlabeled slot that `connectToDataPlatform()` (the actual *target*-connection-test flow, tied to `TargetContext`) never even updated. `webviewProvider.ts`'s `notifyConnectionStatus(role, status)` now writes to both a `Record<'source'|'target', {...}>` (driving two status pills in `media/sidebar.html`'s top bar — `connPill`/`targetConnPill`) and `contextFileManager.setRuntimeFact('connection:'+role, ...)` (the LLM-facing side), from all four places a connection outcome becomes known: `extension.ts`'s `testConnection`/`sourceAssessment` (source), `webviewProvider.ts`'s `runSourceConnectionCheck()` (source), and `connectToDataPlatform()` (target — previously silent). A source-role fact also states plainly when no schema has been extracted yet, pointing at "Source Assessment," so chat can no longer claim it has zero database access while a connection is genuinely live.

**Also extended to two call sites that had the biggest gaps**, since the mechanism made it cheap: `AgentHub.generateSpec()` (used by both `generateSpec`/`refineSpec`) gained an optional `context?: string` parameter, now populated from `contextFileManager.buildContextPrompt()` by both webview call sites — previously these built a prompt from user input alone. `ToolSkillAgent.buildSkillSystemPrompt()` now includes `context.schemaContext` (previously ignored entirely by tool-executing skills), fed via a new optional `liveContext` parameter on `AgentHub.runToolSkill()` rather than the stale, plan-generation-scoped `this.state.schemaContext` it silently fell back to before. `generateWithLlm`/codegen agents' use of `AgentExecutionContext.schemaContext` was deliberately left untouched — it's plan-approval-scoped by design (captures schema *as of* plan approval), a different, intentionally-non-live semantic.

No generic pub/sub `EventEmitter` bus was introduced — confirmed zero usages anywhere in `src/` before this change, and none were added. The concrete problem (N prompt-builders reinventing context assembly) is solved by "N producers write one shared object, already-existing consumers read it," which is real decoupling without a new framework; a formal event bus remains a valid future layer if a second, non-prompt-building subscriber ever needs one.

**Files:** `src/context/ContextFileManager.ts` (`RuntimeFact`, `setRuntimeFact()`, `buildContextPrompt()` rendering), `src/core/webviewProvider.ts` (`connectionStatus` now role-keyed, `notifyConnectionStatus(role, status)`, `chat`/`generatePlan` cases simplified to a single `buildContextPrompt()` call, `draftSpec()`/`reviseSpec()`/`runToolSkill` call sites), `src/extension.ts` (`testConnection`/`sourceAssessment` pass `'source'`), `src/core/agentHub.ts` (`generateSpec(userInput, previous?, context?)`, `runToolSkill(skillId, instruction, liveContext?)`), `src/agents/build/ToolSkillAgent.ts` (`buildSkillSystemPrompt(skill, context)`), `media/sidebar.html` (dual `connPill`/`targetConnPill`, dead `schemaContext: ''` removed from `chat`/`/plan` messages).

**Two further real bugs found live-testing this mechanism end-to-end, both structural, both fixed at the source rather than patched around:**

1. **`ContextFileManager.loadAllFiles()`'s derived-graph/legacy-schema precedence was existence-based, not freshness-based — meaning a live extraction could never be read again after the very first extension activation, ever.** `persistCompiledGraph()` unconditionally (re)writes `derived/graph.json` at the end of *every* reindex, including the first one on a completely fresh workspace with zero nodes. The old logic was `if (exists(derived/graph.json)) use it; else fall back to schema-graph.json` — since `derived/graph.json` exists after that very first reindex, `schema-graph.json` (what `BaseAdapter.persistSchemaContext()` — i.e. Source Assessment — actually writes) became permanently unreachable from that point on, for any workspace, regardless of how many times a real extraction ran afterward. Fixed by comparing mtimes instead: whichever file is newer wins, so a fresh Source Assessment's `schema-graph.json` correctly wins over a stale compiled cache and gets folded back into `derived/graph.json` on the same pass.
2. **The Snowflake card's "Source Assessment" button was wired to a second, parallel, fake implementation that never touched a live connection at all.** `webviewProvider.ts`'s `case 'sourceAssessment':` didn't call `ConnectionManager.extractMetadata()`/`persistSchemaContext()` — it just disposed and re-initialized `ContextFileManager` (re-reading whatever was already on disk) and unconditionally reported success. The *real* implementation lived only in `extension.ts`'s `sourceAssessment` command, reachable from the Command Palette but never from the button a user would actually click. This is the same class of bug `testConnection`'s webview case had already been fixed for earlier in this session (delegate to the one real command, don't duplicate it) — `sourceAssessment` had simply never received the same fix. Fixed by making the command itself return its real outcome (`{success, tableCount?, viewCount?, error?}` instead of `void`) and having the webview case delegate via `vscode.commands.executeCommand()`, then force an immediate `ContextFileManager` reindex on success (rather than waiting on the debounced file watcher) so the freshly-extracted schema is available to the very next chat message.

**New: "AutoDE: Disconnect Data Platform" command + a Disconnect button** next to Connect/Source Assessment in the Snowflake card. Calls `ConnectionManager.disconnect()` and then `notifyConnectionStatus('source', {connected: false})` unconditionally (even if the adapter's own `disconnect()` throws, since the local handle is gone either way) — which, via the same mechanism as everything above, both flips the status pill red and clears the `connection:source` runtime fact, so chat immediately stops claiming a connection that no longer exists.

See the architecture plan (`after-phase-3b-are-graceful-lagoon.md`, Part 1) for the full context inventory and design rationale this implementation followed.

---

## 6. Agent Orchestration

### 5.1 Orchestrating Agent (DataAgentHubHub)

**File:** `src/core/agentHub.ts`

The orchestrating agent is the central coordinator:

| Responsibility | Implementation |
|----------------|---------------|
| Intent understanding | LLM call with system prompt + context |
| Task decomposition | `buildPlanPrompt()` → LLM → `validatePlanResponse()` |
| Sub-agent routing | `AGENT_EXECUTORS` map: `AgentType → executor function` |
| Dependency resolution | DAG-based execution with `dependsOn` arrays |
| State management | `PlanState` with steps, status, runningStepId |
| Failure recovery | `handleFailure()` with re-plan option |
| Context injection | Passes schema context to LLM prompts |

### 5.2 Sub-Agent Catalog

#### Phase: Discover (Source-Side)

| Agent | Type Key | Description | Status |
|-------|----------|-------------|--------|
| Source Assessment | `sourceAssessmentAgent` | Extract schema metadata, profile columns, build knowledge graph | Phase 3a |
| Data Lineage Mapper | `lineageMapperAgent` | Trace column-level lineage across views/ETL | Future |
| Data Quality Profiler | `qualityProfilerAgent` | Run configurable quality checks | Future |
| Current-State Architect | `currentStateArchitectAgent` | Generate as-is architecture diagram | Future |

#### Phase: Model (Design)

| Agent | Type Key | Description | Status |
|-------|----------|-------------|--------|
| STTM Mapper | `sttmAgent` | Source-to-target mapping with column-level transformations | Enhanced in 3a |
| Data Modeler | `dataModelerAgent` | Dimensional/Data Vault/OBT model generation | Future |
| Business Glossary Builder | `glossaryBuilderAgent` | Extract/update business terms | Future |

#### Phase: Build (Target-Side)

| Agent | Type Key | Description | Status |
|-------|----------|-------------|--------|
| Ingestion Pipeline | `ingestionAgent` | Generate ingestion code (COPY, Python, Airbyte) | Enhanced in 3a |
| Transformation Scaffolder | `transformScaffoldAgent` | dbt project scaffolding | Future |
| DDL Generator | `ddlGeneratorAgent` | CREATE/ALTER statements | Future |
| Orchestration Generator | `orchestrationAgent` | Airflow/Dagster/Prefect DAGs | Future |

#### Phase: Validate & Document

| Agent | Type Key | Description | Status |
|-------|----------|-------------|--------|
| SQL Validator | `sqlValidatorAgent` | Validate SQL against schema graph | Future |
| Test Generator | `testGeneratorAgent` | dbt tests + custom quality tests | Future |
| Documentation Generator | `architectureAgent` | Data dictionary + architecture docs | Enhanced in 3a |
| Future-State Architect | `futureStateArchitectAgent` | To-be architecture diagram | Future |

### 5.3 Agent Execution Context

All sub-agents receive the same context:

```typescript
interface AgentExecutionContext {
  objective: string;
  schemaContext?: string;
  settings: DataAgentHubSettings;
  configManager: {
    getSecret: (key: string) => Promise<string | undefined>;
    getSettings: () => DataAgentHubSettings;
  };
  log: (message: string) => void;
  // toolSkillAgent-only (Phase D, v0.9.0) — every other executor ignores these:
  workspaceRoot?: string;
  extensionContext?: unknown;   // real vscode.ExtensionContext, cast where needed
  skillId?: string;
  skillInstruction?: string;
}
```

### 5.4 Agent Execution Result

All sub-agents return the same contract:

```typescript
interface AgentExecutionResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
  error?: string;
}
```

### 5.5 Plan Execution Flow

```
User describes objective
        │
        ▼
Orchestrator generates plan (LLM)
        │
        ▼
Plan displayed as interactive card
        │
        ▼
User clicks "Execute All" (or steps run automatically)
        │
        ▼
DAG execution: for each ready step:
  ├── Check dependencies satisfied
  ├── Set step status → 'running'
  ├── Invoke sub-agent via AGENT_EXECUTORS[step.assignedAgent]
  ├── On success: status → 'completed'
  └── On failure: status → 'failed', offer re-plan
        │
        ▼
All steps complete → status → 'completed'
```

### 5.6 Tool-Executing Skills (`toolSkillAgent`, Phase D, v0.9.0)

Two loops, nested, not parallel — the design settled on during the architecture review. The DAG/orchestrator loop above is **unchanged**; `toolSkillAgent` is one more entry in `AGENT_EXECUTORS` whose internals happen to run a multi-turn agentic conversation instead of a template render, exactly the way `snowflakeExecutor` already does something structurally different (real async DB I/O) without the outer loop needing to know or care:

```
ORCHESTRATOR LOOP (unchanged)
  for each ready step: AGENT_EXECUTORS[step.assignedAgent](step, context)
     ├─ 6 template agents + snowflakeExecutor → plain fn call (unchanged)
     └─ toolSkillAgent (NEW) → runs the loop below, returns ONE
                                AgentExecutionResult, same contract as any other agent
                                     │
                                     ▼ (only for a toolSkillAgent step)
TOOL-USE LOOP (src/agents/build/ToolSkillAgent.ts)
  claude  → Claude Code's own loop, opaque to AutoDE (ClaudeCodeAdapter, toolMode:'full')
  copilot → AutoDE-run: sendRequest(tools) → ToolCallPart → execute (sandboxed,
            approved, audited) → ToolResultPart → sendRequest again → ... (≤12 turns)
```

**Not reachable from the auto-planner.** `toolSkillAgent` is a full `AGENT_EXECUTORS` entry (so `hub.runToolSkill()` can invoke it) but is **excluded** from `VALID_AGENT_TYPES` and the planner's prompt allow-list — `generatePlan()`'s LLM has no visibility into which skills are imported and could hallucinate a `skillId`. The only entry points are `/skill <id> <instruction>` in chat and the `AutoDE: Run Tool Skill` command, both calling `AgentHub.runToolSkill(skillId, instruction)` directly — a one-off step built and executed outside the DAG, not queued into `PlanState.steps`.

**`AgentExecutionContext` gained four fields** for this one agent (every other executor ignores them):
```typescript
interface AgentExecutionContext {
  // ...unchanged fields...
  workspaceRoot?: string;        // sandbox boundary
  extensionContext?: unknown;    // real vscode.ExtensionContext, cast at the one call site that needs it
  skillId?: string;
  skillInstruction?: string;
}
```
`extensionContext` is typed `unknown` in the pure `core/types.ts` deliberately — importing `vscode` there would break the file's no-`vscode`-import rule; `ToolSkillAgent.ts` casts it back. That file is also the **one exception** to "sub-agents import only `core/types`" (§ Extension Guide) — it imports `vscode` and `node:child_process` directly, because it does real file I/O and process spawning, not deterministic templating.

**Import & storage:** `src/core/toolSkills.ts` (pure, mirrors `skillRegistry.ts`'s loading pattern) parses a `SKILL.md` (lenient YAML frontmatter + Markdown body) into a `ToolSkillDefinition`. `AutoDE: Import Tool Skill` copies a user-picked folder into `.ai-context/skills/tool-skills/<id>/`; `loadToolSkillsFromDirectory()` scans that directory at run time (no separate index file).

**Execution paths — see `requirements.md` §9a.2 for the full detail, verified findings, and what was deliberately not built** (native Claude Code plugin loading, per-call approval on the Claude path, and a hard OS-level sandbox on either path are all explicitly out of scope for this pass). In short: `claude` gets Claude Code's own tool loop (one whole-run confirmation, `--permission-mode acceptEdits` — verified against the real CLI to be required and sufficient for Read/Grep/Glob/Edit/Write; Bash unverified); `copilot` gets a real loop AutoDE owns against the documented `vscode.lm` tool-calling API (`LanguageModelChatRequestOptions.tools`, `LanguageModelToolCallPart`/`LanguageModelToolResultPart` — types confirmed against the installed `@types/vscode` before writing code), with true per-call approval + an audit log, but not exercised against a live Copilot session in this environment.

**Confirmed-still-open gap (v0.14.0 review):** `ToolSkillDefinition.declaredTools` (parsed from a skill's `allowed-tools` frontmatter) is informational only — never enforced at any call site (`grep -r "declaredTools" src/` shows zero enforcement outside `toolSkills.ts`/`types.ts` itself) — and only `claude`/`copilot` can run a tool skill at all, 2 of AutoDE's 7 LLM providers. The v0.14.0 platform-onboarding review (§4.8) flags generalizing this (a provider-agnostic loop for any adapter exposing `completeWithTools()`, plus real `allowed-tools` filtering via `src/core/agenticTools.ts`) as a **hard prerequisite**, not a nice-to-have, for the also-planned Superpowers/vendor-published skill integration (extending `AutoDE: Import Tool Skill` with a Git-URL source, reusing this exact execution path unchanged) — importing a skill that can only run on 2 of 7 providers doesn't meet AutoDE's own LLM-agnostic bar. See `requirements.md` §16.8.

---

## 7. LLM Integration

### 6.0 Adapter Registry (Phase C, v0.9.0)

**Problem this replaced:** adding or changing an LLM provider used to mean editing an if/else chain in `agentHub.callConfiguredLlm` (~90 lines mixing dispatch, consent-gating, and per-provider request shaping) *and* keeping a separate, already-drifted-stale metadata table (`providerRegistry.ts`'s `LLM_PROVIDER_REGISTRY` — still said `claude: 'Claude (VS Code)'` after that provider became the Claude Code CLI) in sync by hand.

**What's there now:**
- **`src/core/llmAdapter.ts`** — the `LlmAdapter` interface (`id`, `displayName`, `requiresApiKey`, `supportsCustomEndpoint`, optional `supportsToolExecution`, and `complete(prompt, opts, ctx)`), the `LlmAdapterContext` interface (the narrow slice of extension-host services an adapter needs — `getSettings`/`getLlmApiKey`/`getExtensionContext`/`getWorkspaceRoot`/`log` — decoupled from `DataAgentHubHub` so adapters are constructible/testable standalone), and the shared `extractJsonText()` helper (moved out of `agentHub.ts`, still used by both the adapters and by `agentHub`'s own JSON-parsing call sites for discovery/synthesis actions).
- **`src/core/llmProviders.ts`** — one small class per provider implementing `LlmAdapter`. `CopilotLlmAdapter`/`ClaudeLlmAdapter` delegate to `languageModelAdapter.ts`/`claudeCodeAdapter.ts` (unchanged internals — this refactor only touched the *dispatch*, not the transports); the five `fetch()`-based providers were moved verbatim out of `agentHub.ts`. `LLM_ADAPTERS: Record<LlmProvider, LlmAdapter>` + `getLlmAdapter(provider)` (falls back to `ollama` for an unrecognized provider — preserving the old chain's implicit default) are the **single source of truth** for "which LLM providers exist."
- **`agentHub.callConfiguredLlm`** is now: resolve settings → `getLlmAdapter(provider).complete(prompt, {model, systemPrompt, justification, allowTools}, this.buildLlmContext())` — a lookup, not a branch. `providerRegistry.ts`'s LLM-facing functions are now thin deprecated wrappers reading `LLM_ADAPTERS` (nothing in `src/` actually calls them — flagged, not removed, in case a future caller wants that shape).
- **Deliberately not done** (per the scoping decision): the UI (`media/sidebar.html`'s hand-authored provider cards), the `package.json` settings-schema enum, and `webviewProvider`'s settings-validation guard were **not** unified into this registry — adding a provider still touches those three by hand (§17.2). Also not attempted: a fully config-driven "describe a new REST provider in JSON, zero code" mechanism — `copilot`/`claude` fundamentally need code (in-process API / subprocess), so a generic template would only cover a subset of providers while adding its own abstraction cost.

### 6.1 Multi-Provider Model

**File:** `src/core/llmProviders.ts` (`LLM_ADAPTERS`), dispatched from `src/core/agentHub.ts` (`callConfiguredLlm`)

| Provider | Key | Implementation |
|----------|-----|---------------|
| GitHub Copilot | `copilot` | VS Code Language Model API via `LanguageModelAdapter` (vendor `copilot`) — no API key |
| Claude Code | `claude` | Spawns the Claude Code CLI headless via `ClaudeCodeAdapter` (`claude -p --output-format json`) — no API key, uses the user's Claude Code login. **Not** `vscode.lm`. |
| OpenAI | `openai` | `fetch()` to `api.openai.com/v1/chat/completions` |
| Anthropic | `anthropic` | `fetch()` to `api.anthropic.com/v1/messages` (direct API key) |
| Azure OpenAI | `azure-openai` | `fetch()` to custom endpoint |
| Google Gemini | `gemini` | `fetch()` to `generativelanguage.googleapis.com` |
| Ollama (Local) | `ollama` | `fetch()` to `localhost:11434/api/chat` |

### 6.2a LanguageModelAdapter (provider `copilot`)

**File:** `src/core/languageModelAdapter.ts` (`src/core/copilotAdapter.ts` = re-export shim; `CopilotAdapter` is a back-compat alias)

| Feature | Implementation |
|---------|---------------|
| Detection | Searches for the `github.copilot-chat` extension |
| Model selection | `vscode.lm.selectChatModels({ vendor: 'copilot' })`; preferred model matched loosely against `activeLlmModel` |
| Consent gate | `languageModelProgrammaticConsent` (legacy `copilotProgrammaticConsent` honored as fallback) |
| Request | `model.sendRequest(messages, { justification })`; system prompt sent as a leading Assistant message |
| Timeout | 30s default / 60s from `callConfiguredLlm` via `Promise.race` |
| Enumerate | `listAll()` → every `vscode.lm` model + vendor (used by `listLanguageModels`) |

### 6.2b ClaudeCodeAdapter (provider `claude`)

**File:** `src/core/claudeCodeAdapter.ts`

| Feature | Implementation |
|---------|---------------|
| CLI discovery | `resolve()`: `claudeCodePath` setting → `claude`/`claude.exe` on `PATH` → `resources/native-binary/claude(.exe)` in the `Anthropic.claude-code` extension. `--version` probe. No hard-coded version. |
| Consent gate | Same as Copilot: `languageModelProgrammaticConsent` (legacy fallback) |
| Request | `spawn(cli, ['-p','--output-format','json', ...])`; prompt piped on **stdin**; `--append-system-prompt <sys>`; `--model <m>` only when `m` matches `/^(claude|sonnet|opus|haiku)/i` |
| Tools | JSON/orchestrator calls: `--tools "" --max-turns 1`. Grounded chat (`allowTools`): `--tools Read Grep Glob --permission-mode default --max-turns 16`, run in the workspace root. Never write/exec tools. |
| Output | Parses the JSON envelope; returns `.result`; treats `is_error` / non-`success` `subtype` as failure |
| Timeout | 90s (no tools) / 180s (tools); subprocess killed on timeout or cancellation |
| Test | `testCall()` → `"Reply with exactly the word: PONG"` |

### 6.3 Chat vs. Plan Routing

| Path | Method | Prompt Style | Response Handling |
|------|--------|-------------|-------------------|
| **Chat** | `hub.chat()` | Conversational assistant | Raw text returned to UI |
| **Plan** | `hub.generatePlan()` | Strict JSON DAG format | Parsed + validated as `PlanStep[]` |

### 6.4 Prompt Engineering

**Chat prompt:**
```
You are AutoDE, an expert data engineering assistant running inside VS Code.
You help users with data engineering tasks including pipeline design, SQL authoring,
schema analysis, data modeling, ETL/ELT workflows, and data platform operations.

Respond conversationally and helpfully. If the user asks you to generate a plan,
suggest they click the "Generate Plan" button or use the /plan command.

{context block}

User message: {message}
```

**Plan prompt** (`AgentHub.buildPlanPrompt`, current as of v0.10.0 — every block below is conditional and omitted when its input is empty):
```
You are an expert data engineering planning assistant. Create a strict execution DAG
for the following objective for the {provider} provider:

## Source Environment
{schemaContext — now includes the Context Layer, merged in by the caller}

## Required workflow phases (inferred from the approved business specification)
{requiredPhases.join(', ')}

Create steps ONLY for the phases listed above. Do not create steps that belong to an unlisted phase.

## Implementation type
Brownfield — this builds on an existing system. Plan steps should account for integrating
with, migrating from, or coexisting with what already exists.
(or, for greenfield: "Greenfield — no existing system to integrate with. Plan steps can
assume a clean build.")

## Target Environment
- Platform: {platform} ({database}.{schema})
- Profile: {environmentProfile}
- Modeling: {modelingApproach}
- Transformation: {transformationTool}
- Orchestration: {orchestrationTool}
- Naming: {namingConvention}
- Outputs: {outputFormats}

Objective: {objective}

Return only a valid JSON array of objects. Each object must include:
{"id":"step-1","assignedAgent":"ingestionAgent","taskDescription":"...",
 "status":"pending","dependsOn":[],"validationRules":["..."]}.

Use only these assignedAgent values: ingestionAgent, sttmAgent, architectureAgent,
snowflakeExecutor, sourceAssessmentAgent, dataModelerAgent, transformScaffoldAgent.
Order the DAG so each step is sequentially dependent. Make sure step ids are unique and
use a dependency list when appropriate. If a step touches Snowflake, use snowflakeExecutor
as the terminal step. Do not include markdown fences, comments, or extra text. This JSON
must be parseable by a strict JSON parser.
```
The returned array is validated by `validatePlanResponse`, which (v0.10.0) also runs a
topological-sort cycle check and rejects any step whose agent maps to a phase outside
`requiredPhases` — both previously deferred to execution time or unenforced entirely (§16 R10 follow-up).

---

## 8. Extension Architecture

### 7.1 Activation & Lifecycle

**File:** `src/extension.ts`

```
activate(context)
  ├── Create ConfigurationManager
  ├── Create DataAgentHubHub (orchestrator)
  ├── Create ConnectionManager (Phase 3a)
  ├── Create DataAgentHubWebviewProvider
  ├── Register commands:
  │   ├── openSidebar
  │   ├── generatePlan
  │   ├── executePlan
  │   ├── resetSession
  │   ├── testLanguageModel  (alias: testCopilot)
  │   ├── listLanguageModelInfo  (alias: listCopilotInfo)
  │   ├── listLanguageModels
  │   ├── debugListExtensions
  │   ├── copilotHandoff
  │   ├── testConnection (Phase 3a)
  │   └── sourceAssessment (Phase 3a)
  └── Register webview view provider

deactivate()
  └── (cleanup handled by disposables)
```

### 7.2 WebviewProvider Message Protocol

**File:** `src/core/webviewProvider.ts`

| Message (Webview → Extension) | Handler | Description |
|------------------------------|---------|-------------|
| `chat` | `hub.chat()` | Conversational message |
| `generatePlan` | `hub.generatePlan()` | Generate execution plan — orchestrator-gated (§8.12, v0.13.0): requires an active, context-ready business problem, or throws |
| `executePlan` | `hub.executePlan()` | Execute current plan — orchestrator-gated (§8.12, v0.13.0): requires `planApproved` and `stagesConfirmed`, or throws |
| `pausePlan` | `hub.pauseExecution()` | Pause execution |
| `resetPlan` | `hub.resetPlan()` | Reset session |
| `updateSettings` | `configManager.updateSettings()` | Save settings |
| `testLanguageModel` / `testCopilot` | Command proxy | Test the active local LLM (Copilot model, or Claude Code CLI) |
| `listLanguageModels` | Command proxy | Enumerate all `vscode.lm` models + report where the Claude Code CLI resolves from |
| `openCopilotHandoff` | Command proxy | Open handoff editor |
| `reindex` | Command proxy | Rebuild context index |
| `openContextFolder` | File system | Open .ai-context in OS |
| `testConnection` | `ConnectionManager.connect()` | Connect to data platform |
| `sourceAssessment` | `ConnectionManager.extractMetadata()` | Extract + persist metadata |
| `runAgent` | Agent routing | Run a specific sub-agent |
| `settingsLoaded` | Re-send settings | Webview initial load |
| `newChat` | `startNewChat()` | Archive current session (folding in any partial interview), start a fresh one (Phase F) |
| `listChatSessions` | `ChatSessionManager.listSessions()` | Enumerate all chat sessions |
| `openChatSession` | Archive current + reactivate + `loadTranscript()` | Resume a past session live (v0.13.0 — was read-only) |
| `discardChat` | `ChatSessionManager.discardSession()` | Permanently delete a session (caller confirms first) |

| Message (Extension → Webview) | Purpose |
|------------------------------|---------|
| `stateUpdate` | Push plan state changes |
| `planUpdated` | Push new plan |
| `logEntry` | Push log message |
| `settingsLoaded` | Push settings + active language model info (`languageModelInfo`, plus `copilotInfo` alias) |
| `settingsSaved` | Confirm settings saved |
| `error` | Push error message |
| `contextUpdate` | Push context stats + entities |
| `stepUpdate` | Push step status change |
| `chatResponse` | Push chat response |
| `agentStatus` | Push agent execution status |
| `sourceAssessmentComplete` | Push source assessment result |
| `chatSessionLoaded` | Push `{ meta, transcript }` for the active/new session (Phase F) — fires on every sidebar resolve and on New Chat |
| `chatSessionsList` | Push all session metadata (Phase F; consumed by the sidebar's Chat History dropdown since v0.13.0) |

### 7.3 Configuration Management

**File:** `src/core/configManager.ts`

| Method | Description |
|--------|-------------|
| `getSettings()` | Read all settings from VS Code configuration |
| `updateSettings(partial)` | Write settings to VS Code configuration |
| `setSecret(key, value)` | Store secret in VS Code secret storage |
| `getSecret(key)` | Retrieve secret from VS Code secret storage |
| `deleteSecret(key)` | Remove secret |
| `setLlmApiKey(value)` | Store LLM API key |
| `getLlmApiKey()` | Retrieve LLM API key |
| `setSnowflakePassword(value)` | Store Snowflake password |
| `getSnowflakePassword()` | Retrieve Snowflake password |

### 7.4 Registered Configuration Properties

All properties are under the `autoDataEngineeringHub` section:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `defaultProvider` | enum | `snowflake` | Default data platform |
| `defaultSnowflakeAccount` | string | `""` | Snowflake account |
| `defaultSnowflakeUsername` | string | `""` | Snowflake username |
| `defaultSnowflakeWarehouse` | string | `""` | Snowflake warehouse |
| `defaultSnowflakeDatabase` | string | `""` | Snowflake database |
| `defaultSnowflakeSchema` | string | `PUBLIC` | Snowflake schema |
| `defaultSnowflakeRole` | string | `SYSADMIN` | Snowflake role |
| `defaultSnowflakeAuthMode` | enum | `key-pair` | Auth mode |
| `snowflakePrivateKeyPath` | string | `""` | Key path |
| `metadataCachingDurationMinutes` | number | `15` | Cache duration |
| `queryTimeoutSeconds` | number | `120` | Query timeout |
| `readOnlyMode` | boolean | `true` | Read-only mode |
| `enableSessionReuse` | boolean | `true` | Session reuse |
| `autoDocumentationEnabled` | boolean | `true` | Auto-documentation |
| `telemetryEnabled` | boolean | `false` | Telemetry opt-in |
| `activeLlmProvider` | enum | `copilot` | Active LLM provider (`copilot`, `claude`, `openai`, `anthropic`, `azure-openai`, `gemini`, `ollama`) |
| `activeLlmModel` | string | `gpt-4o-mini` | LLM model name |
| `llmEndpoint` | string | `""` | Custom LLM endpoint |
| `languageModelProgrammaticConsent` | boolean | `false` | Consent to use a local LLM (Copilot via `vscode.lm`, or the Claude Code CLI) programmatically |
| `claudeCodePath` | string | `""` | Explicit path to the `claude` CLI for provider `claude`; empty = auto-detect |
| `copilotProgrammaticConsent` | boolean | `false` | _Deprecated_ — legacy consent flag, still honored as a fallback |
| `extensionDisplayName` | string | `Auto Data Engineering Hub` | Display name |
| `extensionDescription` | string | `...` | Description |

---

## 9. File Structure

```
AutoDE/
├── .ai-context/                          # Context layer (hidden, per-repo)
│   ├── sources.yaml                      # Source registry (user-identified files)
│   ├── context/                          # AUTHORITATIVE — human-owned, committed
│   │   ├── industry/
│   │   ├── enterprise/
│   │   ├── domain/
│   │   └── queries/
│   ├── derived/                          # DERIVED — generated, gitignored
│   │   ├── system/
│   │   ├── artifacts/
│   │   ├── graph.json                    # Compiled index (in-memory working set)
│   │   └── embeddings/
│   ├── spec/                             # Business Problem Specification
│   │   └── business-problem.yaml
│   ├── chats/                             # Chat sessions (Phase F) — gitignored
│   │   ├── <id>.meta.json
│   │   ├── <id>.jsonl
│   │   └── carryover/<sessionId>.md      # Abandoned-interview partial answers, folded into context
│   ├── target-environment.yaml           # Target env config
│   ├── state.json                        # Workspace state (objective + phase progress)
│   ├── plan/                             # Generated plan (v0.10.0) — mirrors spec/
│   │   ├── plan.yaml
│   │   └── history/plan.v<n>.<status>.yaml
│   └── artifacts/                        # Generated artifacts (v0.10.0 — visible, committed;
│       ├── 01-discover/                  #   previously a sibling auto-de/ folder)
│       ├── 02-model/
│       ├── 03-build/
│       └── 04-validate/
│
├── docs/
│   ├── requirements.md                   # Authoritative requirements
│   ├── technical-design.md               # THIS DOCUMENT
│   └── schemas/
│       └── context-envelope.schema.json  # Context envelope JSON Schema
│
├── media/
│   ├── logo.svg
│   ├── architecture.drawio
│   ├── sidebar.html                      # Workspace webview
│   ├── panel.html                        # Bottom panel dashboard
│   └── editors/                          # Custom editor webviews
│
├── skills/                               # DE spec-generation skills (JSON, user-overridable)
│
├── src/
│   ├── extension.ts                      # Activation, command registration
│   ├── core/
│   │   ├── agentHub.ts                   # Orchestrator + LLM calls
│   │   ├── configManager.ts              # Settings + secrets
│   │   ├── languageModelAdapter.ts       # GitHub Copilot via vscode.lm
│   │   ├── claudeCodeAdapter.ts          # provider 'claude' → Claude Code CLI (claude -p)
│   │   ├── copilotAdapter.ts             # re-export shim (back-compat)
│   │   ├── extensionIdentity.ts          # Constants (IDs, keys)
│   │   ├── phaseInference.ts             # Spec-driven phase inference + live status (pure module)
│   │   ├── implementationType.ts         # Deterministic Greenfield/Brownfield classification (pure module)
│   │   ├── targetContextQuestions.ts     # Fixed Target Context Q&A + keyword-evidence defaults (pure module) — v0.11.0
│   │   ├── sourceContextQuestions.ts     # Fixed Source Context Q&A + keyword-evidence defaults (pure module) — v0.11.0
│   │   ├── problemSlug.ts                # generateProblemSlug() — business-problem folder slugs (pure module) — v0.12.0
│   │   ├── skillRegistry.ts              # Spec skills registry + directory loader
│   │   ├── toolSkills.ts                 # Imported Claude Agent Skill (SKILL.md) parser — Phase D
│   │   ├── llmAdapter.ts                 # LlmAdapter/LlmAdapterContext interfaces + extractJsonText — Phase C
│   │   ├── llmProviders.ts               # LLM_ADAPTERS registry (one class per provider) — Phase C
│   │   ├── specOps.ts                    # SpecOpsEngine state machine + action validation
│   │   ├── specOpsPrompts.ts             # Discovery + synthesis prompt assembly
│   │   ├── specSynthesis.ts              # Comprehensive v2 spec parsing/validation
│   │   ├── panelProvider.ts              # Bottom panel provider
│   │   ├── providerRegistry.ts           # Platform + LLM definitions
│   │   ├── types.ts                      # Core type definitions
│   │   ├── webviewProvider.ts            # Webview message bridge
│   │   └── webviewSecurity.ts            # CSP nonce helper
│   ├── context/
│   │   ├── ActiveProblemManager.ts       # active-problem.json pointer + listProblems() for the picker — v0.12.0
│   │   ├── ArtifactWriter.ts             # Artifacts → <contextRoot>/artifacts/<phase>/[<specId>.v<version>/] (contextRoot = the active business problem's folder, v0.12.0)
│   │   ├── ArtifactStalenessScanner.ts   # Scans <contextRoot>/artifacts/ for <specId>.v<version> folders vs. the current approved spec
│   │   ├── ContextFileManager.ts         # .ai-context/ file management (workspace-level, shared across business problems)
│   │   ├── ContextValidator.ts           # AJV envelope validation (Phase 3 pt 1)
│   │   ├── GraphManager.ts               # In-memory knowledge graph (workspace-level; spec-derived layer swapped per active business problem — v0.12.0)
│   │   ├── GraphPersistence.ts           # Atomic derived/graph.json I/O (Phase 3 pt 1)
│   │   ├── ChatSessionManager.ts         # Chat session CRUD (.ai-context/chats/, workspace-level) — Phase F
│   │   ├── SourceRegistry.ts             # sources.yaml read/write (workspace-level)
│   │   ├── SpecManager.ts                # BPS persistence/versioning/history — constructed per active business problem (v0.12.0)
│   │   ├── PlanManager.ts                # Plan persistence/versioning/history — mirrors SpecManager; per active business problem (v0.12.0)
│   │   ├── TargetContextManager.ts       # Target Context persistence/approval — per active business problem (v0.12.0)
│   │   ├── SourceContextManager.ts       # Source Context persistence/approval — per active business problem (v0.12.0)
│   │   ├── SynthesisPipeline.ts          # Rule-based source → graph
│   │   ├── TargetConfigManager.ts        # Target env profiles (workspace-level tool-preference profile, distinct from TargetContext)
│   │   ├── types.ts                      # Context types + envelope
│   │   └── Yaml.ts                       # Real YAML parse/stringify (Phase 3 pt 1)
│   ├── dqm/
│   │   ├── BaseAdapter.ts
│   │   ├── ConnectionManager.ts
│   │   ├── types.ts
│   │   └── adapters/
│   │       ├── SnowflakeAdapter.ts
│   │       └── DatabricksAdapter.ts
│   ├── agents/
│   │   ├── discover/SourceAssessmentAgent.ts
│   │   ├── model/SttmMapperAgent.ts
│   │   ├── model/DataModelerAgent.ts
│   │   ├── build/IngestionPipelineAgent.ts
│   │   ├── build/TransformationScaffolderAgent.ts
│   │   ├── build/ToolSkillAgent.ts        # toolSkillAgent — Phase D; the one agent that imports vscode directly
│   │   └── validate/DocumentationAgent.ts
│   ├── editors/                          # Custom text editors
│   │   ├── DataModelEditorProvider.ts
│   │   ├── DocEditorProvider.ts
│   │   ├── GraphEditorProvider.ts
│   │   ├── ProfileEditorProvider.ts
│   │   └── SttmEditorProvider.ts
│   └── spokes/                           # Legacy spoke agents (to be migrated)
│       ├── architectureAgent.ts
│       ├── ingestionAgent.ts
│       ├── snowflakeExecutor.ts
│       └── sttmAgent.ts
│
├── test/
│   └── functional.test.cjs
├── package.json
├── tsconfig.json
└── README.md
```

---

## 10. Implementation Phases

> **Forward plan (spec-driven):** mirroring `docs/requirements.md` §10:
> 1. **Business Problem Specification** — ✅ DONE. Spec types + `SpecManager` persistence/versioning/history, `AgentHub.generateSpec`, spec-aware chat routing, review/approve UI, `/spec`, `generatePlanFromSpec`.
> 2. **Spec-driven phase inference + orchestration** — ✅ DONE (v0.6.0). Deterministic `inferPhases()` in `src/core/phaseInference.ts` infers the required phases + dependencies from the approved BPS; plan generation is constrained to those phases (`buildPlanPrompt`); the palette renders the live status view (completed / in-progress / blocked / pending / unrequired), and phase statuses recompute on every state emit.
> 2b. **Agentic Specification Generation (SpecOps)** — ✅ DONE (v0.7.0). Superpowers-inspired, DE-tailored requirements flow: `skills/` registry + `SpecOpsEngine` state machine + adaptive questioning (chat bubbles + dynamic intake forms) + comprehensive v2 synthesis with provenance. See §2.8.
> 3. **Phase 3** — layered context loading. ✅ PART 1 (v0.8.0): real YAML parser (`src/context/Yaml.ts`), AJV envelope validation (`src/context/ContextValidator.ts`), atomic graph persistence (`src/context/GraphPersistence.ts`). ✅ PART 2 (v0.8.0): `ContextFileManager` layered loading (`context/**` + `derived/graph.json` via `GraphPersistence`, legacy fallbacks), AJV envelope validation wired through `ContextValidator`; `SpecManager`/`SourceRegistry`/`TargetConfigManager` migrated to the real `yaml` library (legacy flat-format files still parse). Per-kind AJV content schemas remain deferred.
> 4. **Phase 4** — real Snowflake/Databricks adapters (wire `snowflake-sdk`).
> 5. **Phase 5** — ContextRetriever + vector engine (embedded, no server).
> 6. **Phase 6** — Local LLM (Copilot + Claude Code) consent UI, telemetry, unit/integration tests.

### Historical phases (committed)

### Phase 0: UI Restructure ✅ COMPLETE

- [x] Replace four-tab layout with single-column, section-based layout
- [x] Redesign top status bar with provider pill, connection pill, context meter, plan status
- [x] Move Settings and Connect into slide-out panel
- [x] Implement context assembly drawer (collapsible)
- [x] Polish all CSS to match design specifications
- [x] Add welcome/onboarding block

### Phase 1: Chat Routing Fix + Codebase Cleanup ✅ COMPLETE

- [x] Add conversational `chat()` method to agentHub
- [x] Route regular messages to `chat` instead of `generatePlan`
- [x] Add `chatResponse` handler in webview
- [x] Auto-save language model consent toggle (Copilot + Claude Code cards)
- [x] Register `languageModelProgrammaticConsent` configuration property (legacy `copilotProgrammaticConsent` kept as fallback)
- [x] Remove stale duplicate re-export files (`src/agentHub.ts`, etc.)
- [x] Fix broken imports in spoke agents
- [x] Add slash command support (`/plan`, `/execute`, `/context`, etc.)

### Phase 2: Context Visibility & Interaction ✅ COMPLETE

- [x] Create `ContextFileManager` with YAML parsing, file watching, atomic writes
- [x] Wire `ContextFileManager` into `webviewProvider`
- [x] Post `contextUpdate` messages with real stats and entity lists
- [x] Update @-mention system to use real context entities
- [x] Populate context drawer chips from context layer
- [x] Add "Source Assessment" button to connection panel
- [x] Add `sourceAssessment` message handler

### Phase 3a: Multi-Platform Adapter Architecture + Workflow Palette ✅ COMPLETE

- [x] Create `docs/technical-design.md` (this document)
- [x] Create `src/dqm/types.ts` — adapter type definitions
- [x] Create `src/dqm/BaseAdapter.ts` — abstract base class
- [x] Create `src/dqm/adapters/SnowflakeAdapter.ts` — Snowflake implementation
- [x] Create `src/dqm/adapters/DatabricksAdapter.ts` — Databricks implementation
- [x] Create `src/dqm/ConnectionManager.ts` — connection lifecycle
- [x] Move spoke agents to `src/agents/` directory
- [x] Create `src/agents/discover/SourceAssessmentAgent.ts`
- [x] Enhance STTM, Ingestion, Documentation agents
- [x] Update `src/core/agentHub.ts` imports
- [x] Update `src/extension.ts` with ConnectionManager
- [x] Update `src/core/webviewProvider.ts` with new handlers
- [x] Build Workflow Palette UI in `media/sidebar.html`
- [x] Add palette CSS + JS
- [x] Compile + test

### Phase 3b: Enhanced Sub-Agents

- [x] Data Modeler agent (dimensional + Data Vault) — `src/agents/model/DataModelerAgent.ts`
- [x] Transformation Scaffolder agent (dbt project generation) — `src/agents/build/TransformationScaffolderAgent.ts`
- [ ] Data Lineage Mapper agent
- [ ] Data Quality Profiler agent

### Phase 3c: New Sub-Agents

- [ ] DDL Generator agent
- [ ] Orchestration Generator agent (Airflow/Dagster/Prefect)
- [ ] SQL Validator agent
- [ ] Test Generator agent
- [ ] Business Glossary Builder agent

### Phase 3d: Orchestrator Intelligence

- [ ] Context-aware action suggestions in chat
- [ ] Auto-invocation of sub-agents based on intent
- [ ] Plan diff & iteration
- [ ] Onboarding flow for first-time users
- [ ] Results preview for executed SQL
- [ ] Export functionality (Markdown/YAML)

### Phase 4: Project System → SUPERSEDED (see requirements §7)

> The multi-project registry (`ProjectManager`, `.auto-de/projects.json`) is **superseded** by the single-workspace model: AutoDE operates on the open repository, and generated artifacts go to a visible `.ai-context/artifacts/` folder. See `docs/requirements.md` §7.

- [x] `src/context/TargetConfigManager.ts` — target environment profiles with inheritance (kept)
- [x] Workflow phases (discover → model → build → validate) and phase progress tracking (kept, workspace-scoped)
- [~] `ProjectManager` / `ProjectRegistry` — to be removed (superseded)

### Phase 5a: Bottom Panel Dashboard ✅ COMPLETE (v0.5.0)

- [x] `src/core/panelProvider.ts` + `media/panel.html` — project progress, stats, artifacts

### Phase 5b: Custom Editors ✅ COMPLETE (v0.5.1)

- [x] `src/editors/` — DataModel, STTM, Graph, Profile, Doc custom text editors

### Phase 6: Testing, telemetry & docs — PARTIAL

- [~] Functional tests — `test/functional.test.cjs` covers the Copilot `vscode.lm` adapter, the Claude Code CLI adapter (mocked `child_process`), plus the pure modules
- [ ] Context Layer / adapter / agent unit tests
- [~] Opt-in telemetry — config flag exists; no telemetry implementation
- [~] Docs — synced to v0.5.0 (this revision)

### Security fix (post-v0.5.1)

- [x] Webview CSP nonce injection — `src/core/webviewSecurity.ts` (`applyCspNonce`) applied to the sidebar, panel, and all 5 custom editors so inline scripts run under VS Code's default CSP.

> **⚠️ Implementation-status caveats (as of v0.5.0):**
> - `SnowflakeAdapter`/`DatabricksAdapter` `connect()` and `executeQuery()` are **stubs** — they do not perform real connections or queries (empty results). Metadata extraction is therefore non-functional end-to-end.
> - `GraphManager` is in-memory only: `isWorkerReady` is hardcoded `true`, and `traverseNeighborhood()` returns empty `formattedContext`/`tokenCount` (the ContextRetriever does not exist yet).
> - No worker threads, no vector/embedding engine, no `js-tiktoken` token counting, no `ajv` validation, and `deactivate()` is empty.

### Phase 7: Architecture review follow-through ✅ COMPLETE (v0.9.0)

- [x] **Phase A — Spec revision.** §2.9. Approved specs are never edited in place; full agentic revision interview seeded from the approved spec.
- [x] **Phase B — Versioning & governance.** §2.10. Git as the version/audit log; `<specId>.v<version>` artifact folders; staleness scanning.
- [x] **Phase C — LLM adapter registry.** §6.0. `LlmAdapter` registry replaces the `callConfiguredLlm` if/else chain.
- [x] **Phase D — Tool-executing Skills.** §5.6. `SKILL.md` import; Claude CLI tool loop + Copilot `vscode.lm` tool-calling loop, workspace-sandboxed.

### Phase 8: Usability follow-through ✅ COMPLETE (E–F) / ⏳ NOT STARTED (G) (v0.9.0)

- [x] **Phase E — Processing feedback.** §2.3 (pending bubble row). Single evolving pending chat bubble replaces static append-only log lines; send disabled while in flight.
- [x] **Phase F — Chat sessions & lifecycle.** §2.11. `ChatSessionManager` persists chat as BPS-identity-independent sessions; New Chat archives (never silently discards, folding partial interviews into context first); Chat History/Discard via Command Palette.
- [ ] **Phase G — Context Memory curation.** Not started — see `requirements.md` §16.7.

### Phase 9: Deterministic Execution Core & Declarative Specification Framework ✅ COMPLETE (v0.14.0)

- [x] **Stabilization.** CI, first-pass ESLint, real `deactivate()` (`src/core/disposables.ts`), dead-code/stale-artifact removal.
- [x] **Transform primitives.** §12.2. Closed, Ajv-validated registry; Tier 1 (code) + Tier 2 (declarative YAML, constrained no-code-execution template engine); wired ahead of the existing freehand-LLM/template fallback in 3 of 5 codegen agents.
- [x] **Pipeline Spec.** §12.3. Strictly-validated (`additionalProperties:false` at every level), deterministically compiled, Markdown design doc generated alongside; new opt-in "Generate Pipeline Spec" command.
- [x] **Attachment structured extraction.** §12.4. Closes the raw-text-dump gap in `attachSpecFile`; `SpecProvenance` gains an `'attachment'` source.
- [x] **Primitive lifecycle & governance.** §12.5. Sidebar Primitives palette, `draft→published→deprecated→retired`, opt-in permission gate, version pinning.
- [x] **Platform Onboarding & Credential Architecture — Credential Resolution Foundation (Phase 3a-i, v0.15.0).** §4.8. `src/dqm/credentials/`: `CredentialResolver`/`CredentialReference`, `EnvVarCredentialResolver`, `CliConfigResolver` (Snowflake), `VsCodeSecretStorageResolver`, `registerCredentialResolver()` extension point; `providerRegistry.ts` consumed for the first time via `principalTypes`.
- [x] **Platform Onboarding — Interactive Onboarding UX (Phase 3a-ii, v0.16.0).** §4.8. CLI detection/picker for `snow`/`databricks`, "AutoDE: Connect to Data Platform" command, Databricks CLI resolver (pointer-only via `.databrickscfg`), `dataPlatformCliConsent` gate, service-account settings surface.
- [x] **Real Snowflake/Databricks execution — core (Phase 3b-i/ii/iii, v0.17.0).** §4.9. Neither `snowflake-sdk` nor `@databricks/sql` is a dependency any more — both were evaluated and dropped after live research + real-world feedback (SQL API v2 performs poorly for large-scale metadata extraction and is a separately-restrictable enterprise network surface). Real execution is a priority cascade: Snowflake prefers shelling out to `snow sql` (native protocol, zero bundle weight) for a CLI-derived connection, falling back to the public SQL API v2 over `fetch()` (PAT/OAuth/key-pair-JWT, JWT signed with only `node:crypto`) for a direct credential; Databricks — which has no CLI-native-protocol escape hatch — goes through the Statement Execution REST API. `ConnectionManager.getSupportedPlatforms()` now reads `providerRegistry.ts`. **Not yet built:** the on-demand native-driver acquisition tier and the platform-onboarding checklist UI (Phase 3b-iv) — see §4.9's own "not yet implemented" note.
- [x] **Runtime Context Unification (v0.18.0).** §4.10. `ContextFileManager.setRuntimeFact()`/`buildContextPrompt()` — a generic, in-memory, never-persisted fact slot that most LLM-prompt call sites already picked up for free by already calling `buildContextPrompt()`. Connection status made role-keyed (`source`/`target`) via `webviewProvider.notifyConnectionStatus()`, closing a gap where the target-connection flow (`connectToDataPlatform()`) never reported status at all. `generateSpec`/`refineSpec` and `ToolSkillAgent` now receive live context for the first time (previously zero).

---

## 11. Design Decisions & Tradeoffs

### 10.1 Why Conversation-First Over Tab-Based?

**Decision:** Single scrollable workspace with slide-out panels instead of multiple tabs.

**Rationale:**
- No tab switching during the core workflow (describe → plan → execute → refine)
- Context is always visible — users can expand the context drawer to see exactly what semantic metadata is being included
- Settings and connections move to a slide-out panel — not a tab competing for attention
- Cline's success validates this pattern: one unified conversation surface where configuration, context, and execution flow naturally from the chat

### 10.2 Why Adapter Pattern Over Code Generation?

**Decision:** Abstract `BaseDataSourceAdapter` with platform-specific implementations.

**Rationale:**
- Each platform has fundamentally different system tables, SQL dialects, and authentication
- Code generation would require maintaining templates for every platform × operation combination
- Adapter pattern allows adding new platforms by implementing one class
- Sub-agents stay clean and platform-agnostic
- The `PlatformCapabilities` model allows graceful degradation (e.g., Databricks doesn't support lineage extraction)

### 10.3 Why Phase-Organized Palette Over Source/Target Split?

**Decision:** Workflow palette organized by phase (Discover → Model → Build → Validate) rather than source vs. target sections.

**Rationale:**
- Real data engineering is iterative, not linear: Source Assessment → STTM → Modeling → back to Source for more profiling
- Rigid source/target separation forces context switching
- Phase organization matches how engineers think about their workflow
- The orchestrating agent understands which phase the user is in and suggests the next logical action

### 10.4 Why Atomic Writes for .ai-context/?

**Decision:** All writes use temporary staging + atomic rename.

**Rationale:**
- Prevents corruption if VS Code crashes mid-write
- The `schema-graph.json` file is always in a valid state
- On next boot, the engine loads the previous valid snapshot
- Implemented via `vscode.workspace.fs.writeFile(tempFile)` → `vscode.workspace.fs.rename(tempFile, targetFile, { overwrite: true })`

### 10.5 Why Single-File Webview (sidebar.html)?

**Decision:** All HTML, CSS, and JavaScript in one file.

**Rationale:**
- VS Code webviews have restrictions on loading external resources
- Single-file simplifies the build process (no bundler needed)
- The file is read via `fs.readFileSync` and injected directly
- For a sidebar-sized UI, the complexity doesn't yet warrant a framework
- Can be split later if the UI grows significantly

### 10.6 YAML Parsing Strategy

**Original decision:** Lightweight custom parser for `.ai-context/` YAML files.

**Original rationale:**
- Avoids adding a native dependency that complicates VSIX packaging
- The YAML structures needed (business-context.yaml, verified-queries.yaml) are simple and flat
- A full YAML parser would be overkill for these specific file formats

**Superseded (v0.8.0, Phase 3 part 1):** the hand-rolled parsers are being replaced with the **`yaml`** library (pure JS, no native bindings → still VSIX-safe) via `src/context/Yaml.ts` (`parseYaml`/`stringifyYaml`). Structure validation uses **`ajv`** (`src/context/ContextValidator.ts`) against `docs/schemas/context-envelope.schema.json`. Remaining migration: `SpecManager`, `SourceRegistry`, `TargetConfigManager`, `ContextFileManager` (tracked in §10 Phase 3 part 2; requirements §16 #6).

---

## 12. Deterministic Execution Core & Declarative Specification Framework

v0.14.0. Full product rationale in `requirements.md` §17; this section is the technical architecture.

### 12.1 The problem this closes

Before this phase, plan-step *dispatch* was deterministic (a fixed `AGENT_EXECUTORS` lookup table, §5.5) but step *content* was entirely LLM-freehand (`src/agents/llmCodegen.ts#generateWithLlm` — an LLM writes the actual SQL/dbt text, a generic non-schema-aware template only as a last-resort fallback), and AutoDE had no artifact playing the role of a compile-ready, per-entity spec — the BPS (§2) is a requirements document, not one.

### 12.2 Transform primitives (`src/core/transforms/`)

```typescript
interface TransformPrimitive<TParams = Record<string, unknown>> {
  kind: PrimitiveKind;                 // 'rename_cast' | 'dedup' | 'incremental_load' | (string & {})
  description: string;
  paramSchema: object;                 // Ajv JSON Schema
  status?: PrimitiveLifecycleStatus;   // Tier 2 only — see 12.5
  version?: number;                    // Tier 2 only — see 12.5
  compile(params: TParams, target: TargetEnvironmentSummary, dialect: SqlDialect): CompiledArtifact;  // pure, no LLM call
}
```

`PrimitiveKind` is an "open union" (`'rename_cast' | 'dedup' | 'incremental_load' | (string & {})`) — keeps autocomplete for the 3 Tier-1 kinds while accepting any runtime-loaded Tier-2 `kind`.

**Two tiers, one interface, one registry (`registry.ts`):**
- **Tier 1** (code, reviewed): `rename_cast` (staging casts/renames, plus a `dbt_model` output mode), `dedup` (`ROW_NUMBER()`, dialect-aware `EXCLUDE`/`EXCEPT`), `incremental_load` (keyed `MERGE`). Registered at module load into `TRANSFORM_PRIMITIVES: Record<string, TransformPrimitive<any>>`.
- **Tier 2** (declarative, `declarative/`): a `PrimitiveDefinition` YAML (`kind`/`version`/`status`/`paramSchema`/`platformTemplates`/`previewParams`/`outputChecks`) whose `compile()` is a rendered template, not code — `templateEngine.ts` is a hand-rolled, deliberately constrained engine (`{{param}}`, `{{join arr ", "}}`, `{{#each}}...{{/each}}`, no `eval`/`Function()`) so a definition author cannot smuggle code execution into the compile path. `loadPrimitiveDefinitionsFromDirectory()` + `mergePrimitiveDefinitions()` mirror `skillRegistry.ts#loadSkillsFromDirectory` exactly — bundled `primitive-definitions/` + `.ai-context/primitives/` override, later wins. `registerPrimitives()` merges Tier 2 into the same `TRANSFORM_PRIMITIVES` map; Tier 1 always wins a `kind` collision.

**Selection (`src/agents/llmParamSelector.ts`):** `selectTransformSpec(context, step, candidateKinds, fixedParams?)` asks the LLM for *only* `{kind, params}` JSON against the candidate primitives' schemas, Ajv-validates, and returns `undefined` (never throws) on any failure — `fixedParams` (object names the caller already computed deterministically) are merged in *after* the LLM's response so they can't be overridden. `generateViaPrimitiveOrFallback()` wraps this as tier 0 ahead of the *unmodified* existing tier 1 (freehand LLM) / tier 2 (hardcoded template) fallback chain in `IngestionPipelineAgent`, `SttmMapperAgent`, and `TransformationScaffolderAgent`'s staging model — the 3 of 5 codegen agents where a single-source primitive is a genuine fit (not `DataModelerAgent`'s multi-table schema design, nor the marts model's multi-source joins).

### 12.3 The Pipeline Spec (`src/core/pipelineSpec/`)

The compile-ready artifact the BPS was never meant to be. `additionalProperties: false` at **every** nesting level (top-level, each entity, `source`/`target`/`transforms`/`quality`/`governance` blocks) — the same recursive-strict Ajv pattern already used by `renameCast.ts`'s `paramSchema`, not the deliberately-open `context-envelope.schema.json` family (§4/context-envelope is for flexible knowledge-graph content; this is a machine-compile contract, a different lineage).

```yaml
specVersion: 1        # schema-of-the-schema version — separate from the document's own `version`
id: pipeline-<slug>
version: 1
status: draft | approved
derivedFromBpsId: bps-...
derivedFromBpsVersion: 2
targetPlatform: snowflake | databricks | ...
entities:
  - name: customers
    source: { object: RAW_DB.PUBLIC.raw_customers, type: table }
    transforms: [{ kind: rename_cast, params: {...}, primitiveVersion: 1 }]   # TransformSpec, §12.2, unchanged
    target: { object: CURATED_DB.STAGING.stg_customers, materialization: view }
    quality: { rules: [] }        # forward slot — Phase 6
    governance: { columns: [] }   # forward slot — Phase 6
```

- **`compiler.ts#compilePipelineSpec(spec, dialect)`** — the AutoDE analogue of the sibling framework's `interpreter.py`: runs each entity's `transforms[]` through the existing `compileTransformSpec()` (§12.2) in order, zero LLM calls. Deliberately **no freehand fallback** here (unlike §12.2's tiered chain) — a compile failure is a bug in an already-approved, already-Ajv-validated spec, not a coverage gap.
- **`designDocGenerator.ts#generateDesignDoc(spec)`** — a pure function producing Markdown (with a Mermaid `flowchart LR` lineage diagram) from a validated spec; same input always produces the same output, so the YAML and its Markdown projection cannot drift apart.
- **`context/PipelineSpecManager.ts`** — persistence modeled function-for-function on `SpecManager.ts` (§2): `.ai-context/problems/<id>/spec/pipeline.yaml` + `spec/history/pipeline.v<version>.<status>.yaml`, atomic temp-then-rename writes, `approve()` doesn't bump version (a draft v1 becomes approved v1), a new revision from an approved predecessor does. A document whose `specVersion` doesn't match `CURRENT_PIPELINE_SPEC_VERSION` loads leniently (a logged warning, not a thrown error) — schema evolution must never brick an already-approved pipeline.
- **Synthesis (`src/agents/pipelineSpecSynthesis.ts` + `AgentHub.synthesizePipelineSpec()`)** — grounded in the approved BPS, the approved Target Context (platform/naming/tooling feed `targetPlatform` directly — confirmed via test that swapping Target Context's platform changes the generated spec with no BPS change at all), the approved Source Context, the Context Layer graph, and attachment extracts (§12.4). Retries up to 3 times, feeding the previous attempt's Ajv errors back into the next prompt (`buildPipelineSpecSynthesisPrompt(inputs, validationErrors?)`) — the same discipline `selectTransformSpec` (§12.2) already uses for one primitive, now applied to the whole document. Also the first real consumer of `BusinessProblemSpec.provenance` (§2.2): a field tagged `source: 'assumption'` is called out in the prompt for conservative treatment.
- **New command, "AutoDE: Generate Pipeline Spec"** — additive, not a replacement for §2.3's existing plan flow; gated on the same `computeContextGateStatus()` (§2.12) Generate Plan already requires.

### 12.4 Attachment structured extraction

Closes a real gap in the pre-existing `attachSpecFile` flow (§2.9): raw attachment text was appended verbatim to a prompt, never persisted past the discovery session, never tagged with provenance.

- **`core/attachmentExtraction.ts`** — `buildAttachmentExtractionPrompt()`/`parseAttachmentExtract()`, pure (mirrors the `specOpsPrompts.ts`/`specSynthesis.ts` split for the BPS itself) — `AgentHub.extractAttachmentFacts()` owns the actual LLM call and never throws, falling back to `fallbackAttachmentExtract()` (a plain text summary, `confidence: 'low'`) on any failure. Deliberately not a rigid, format-specific parser — an attachment could be a schema dump, a memo, anything.
- **`context/AttachmentStore.ts`** — persists `{raw content, extract}` to `.ai-context/problems/<id>/attachments/<id>.yaml`, atomic write, surviving past the ephemeral `IntakeSession` that created it.
- **`SpecProvenance.source`** gains `'attachment'` (+ `attachmentId`) — `specSynthesis.ts#buildProvenance` tags `sourceCatalog`/`dataFlows` this way when an entity-extracting attachment exists and no direct question already covers the field (a narrow, honest heuristic — there's no per-field attribution signal from the LLM's synthesis output for anything broader).

### 12.5 Primitive lifecycle & governance

```typescript
type PrimitiveLifecycleStatus = 'draft' | 'published' | 'deprecated' | 'retired';
```

- **UI:** sidebar Workflow Palette gains a "Primitives" section (`palettePrimitives`/`renderPalettePrimitives`) — chosen over a new panel or a 6th custom editor because the Dashboard panel has zero manager wiring and none of the 5 existing custom editors support write-back, whereas the palette's `paletteProblems`/`paletteSpec`/`paletteArtifacts` pattern (§3.6) already does exactly this shape of work. **Preview** is a plain `compileTransformSpec()` call — confirmed to need neither an LLM call nor `agenticTools.ts`'s agentic loop (§5.6), since rendering a template against sample params isn't LLM-directed at all.
- **Selectability:** `isSelectable(primitive)` = `!primitive.status || primitive.status === 'published'` — `selectTransformSpec()` (§12.2) filters `candidateKinds` through this before building the LLM's catalog and again before accepting its response. `compileTransformSpec()` is **not** filtered — a deprecated/retired primitive still compiles for anything that already references it; selectability only gates the LLM's future choice.
- **Version pinning:** `TransformSpec.primitiveVersion?: number`; `registry.ts` keeps a second map, `VERSIONED_PRIMITIVES: Map<kind, Map<version, TransformPrimitive>>`, independent of the live `TRANSFORM_PRIMITIVES` catalog. `resolvePrimitive(spec)` prefers an exact-version match when pinned, falling back to the live entry otherwise. `webviewProvider.ts#ensurePrimitivesLoaded()` also loads `.ai-context/primitives/history/` into this map (never into the live catalog) so an approved Pipeline Spec's pinned reference keeps resolving after a newer version is published.
- **Publish/deprecate (`declarative/lifecycle.ts`):** `publishPrimitiveDefinition()` — a first publish keeps `version` as-is (mirrors `SpecManager.approve()`'s "draft v1 becomes approved v1"); republishing an already-published definition bumps `version` and archives the prior revision to `history/`, same convention as `SpecManager`/`PipelineSpecManager`. Gated by `autoDataEngineeringHub.primitiveManagementEnabled` (default `false`, same opt-in pattern as `languageModelProgrammaticConsent`, §6.0) — the sidebar hides Publish/Deprecate entirely, not just disables them, when off.

### 12.6 Files

| File | Purpose |
|------|---------|
| `src/core/transforms/{types,registry}.ts` | `TransformPrimitive` contract; the merged Tier 1 + Tier 2 catalog, version-pinned resolution |
| `src/core/transforms/primitives/*.ts` | Tier 1: `renameCast.ts`, `dedup.ts`, `incrementalLoad.ts` |
| `src/core/transforms/declarative/*.ts` | Tier 2: `types.ts`, `schema.ts`, `templateEngine.ts`, `loader.ts`, `adapter.ts`, `lifecycle.ts` |
| `src/agents/llmParamSelector.ts` | `selectTransformSpec()`, `generateViaPrimitiveOrFallback()` |
| `src/core/pipelineSpec/*.ts` | `types.ts`, `schema.ts`, `validator.ts`, `compiler.ts`, `designDocGenerator.ts` |
| `src/context/PipelineSpecManager.ts` | Pipeline Spec persistence/versioning |
| `src/agents/pipelineSpecSynthesis.ts` | Prompt-building + response-parsing for Pipeline Spec synthesis |
| `src/core/attachmentExtraction.ts`, `src/context/AttachmentStore.ts` | Attachment structured extraction + persistence |
| `src/core/disposables.ts` | `DisposableRegistry` — real `deactivate()` (§8) |
| `docs/schemas/primitive-definition.schema.json` | `yamlValidation` contribution target for live-editing Tier-2 definitions |

---

## Appendix A: Webview Message Reference

### Webview → Extension

| Message Type | Payload | Handler |
|-------------|---------|---------|
| `chat` | `{ message: string, schemaContext?: string }` | `hub.chat()` — merges `contextFileManager.buildContextPrompt()` with `schemaContext` before calling `hub.chat()` |
| `generatePlan` | `{ objective: string, schemaContext?: string }` | `hub.generatePlan()` — same Context Layer merge as `chat` (v0.10.0; previously passed `schemaContext` through unmerged) |
| `approveSpec` | `{}` | `specManager.approve()` → automatically runs `syncContextFromApprovedSpec()` (spec → Context Layer sync + durable snapshot, v0.10.0) → `hub.inferPhasesFromSpec(spec, contextSummary)` → responds `specApproved` |
| `generatePlanFromSpec` | `{}` | Requires an approved spec; `hub.generatePlanFromSpec(spec, contextFileManager.buildContextPrompt())` — the spec-driven counterpart to `generatePlan`, and the primary trigger from the "📋 Generate Plan" UI actions (§2.5) |
| `setImplementationType` | `{ value: 'greenfield' \| 'brownfield' }` | User override of the deterministic Greenfield/Brownfield classification (§2.12); persists `implementationTypeOverridden: true` on the spec so future revisions don't silently reclassify it |
| `setPhaseRequired` | `{ phase: WorkflowPhase, required: boolean }` | `hub.setPhaseOverride(phase, required)` (§8.9) — manual Applicable/Non-Applicable override on the palette, survives a subsequent re-plan, does not retroactively edit an already-generated plan's steps (the palette flags it as possibly stale instead) |
| `startTargetContext` / `reviseTargetContext` | `{}` | Posts `targetContextQuestions` — the fixed 8-question Target Context form (§8.10) |
| `submitTargetContextAnswers` | `{ answers: [{questionId, value}] }` | Saves as `TargetContext` (status `built`); posts `targetContextBuilt` |
| `approveTargetContext` | `{}` | Marks approved, pushes into `hub.setTargetEnvironment()`; posts `targetContextApproved` |
| `chooseSourceContextMethod` | `{ method: 'connected' \| 'described' }` | `'connected'` runs a live connection check (`runSourceConnectionCheck`); `'described'` posts `sourceContextQuestions` (3 fixed questions) — Brownfield only |
| `runSourceConnectionCheck` | `{}` | Re-runs the live connection check (retry) |
| `submitSourceContextAnswers` | `{ answers: [...] }` | Saves as `SourceContext` (status `built`, method `described`); posts `sourceContextBuilt` |
| `approveSourceContext` / `reviseSourceContext` | `{}` | Approve marks approved and posts `sourceContextApproved`; revise re-opens the form (or re-runs the connection check for `method: 'connected'`) |
| `executePlan` | `{}` | `hub.executePlan()` |
| `pausePlan` | `{}` | `hub.pauseExecution()` |
| `resetPlan` | `{}` | `hub.resetPlan()` |
| `updateSettings` | `{ settings: Partial<DataAgentHubSettings> }` | `configManager.updateSettings()` |
| `testCopilot` / `testLanguageModel` | `{}` | Command proxy |
| `listLanguageModels` | `{}` | Command proxy |
| `openCopilotHandoff` | `{ prompt?: string }` | Command proxy |
| `reindex` | `{}` | Command proxy |
| `openContextFolder` | `{}` | File system |
| `testConnection` | `{}` | `ConnectionManager.connect()` |
| `sourceAssessment` | `{}` | `ConnectionManager.extractMetadata()` |
| `runAgent` | `{ agent: string }` | Agent routing |
| `settingsLoaded` | `{}` | Re-send settings |
| `startRevision` | `{}` | Arms `pendingRevision` (only if the current spec is `approved`); the next `chat` message becomes the change request (§2.9) |
| `attachSpecFile` | `{}` | Opens a file picker; attaches the picked file to the active `SpecOpsEngine` session as reference material (§2.9) |
| `refineSpec` | `{ refinement: string }` | Approved spec → full revision interview (§2.9); draft spec → single-shot `reviseSpec()` |
| `checkArtifactStaleness` | `{}` | `scanArtifactStaleness()` → responds with `artifactStaleness` (§2.10) |
| `runToolSkill` | `{ skillId: string, instruction: string }` | `hub.runToolSkill(skillId, instruction)` → responds with `chatResponse` (§5.6, Phase D) |
| `viewSpecHistory` | `{}` | `git log --follow -p` on the spec file → responds with `specHistory` (§2.10) |
| `newChat` | `{}` | Archives the current session (folding in any partial interview), starts a new one → responds with `chatSessionLoaded` (§2.11, Phase F) |
| `listChatSessions` | `{}` | `ChatSessionManager.listSessions()` → responds with `chatSessionsList` (§2.11, Phase F) — drives the sidebar's Chat History dropdown (v0.13.0) |
| `openChatSession` | `{ chatId: string }` | **Resumes** the given session as the live active one (v0.13.0 — previously a read-only preview): archives whatever's currently active, reactivates the target, responds with `chatSessionLoaded` (not `chatSessionViewed`, which is retired) |
| `discardChat` | `{ chatId: string }` | Permanently deletes a session (caller confirms first) (§2.11, Phase F) |
| `startNewBusinessProblem` | `{}` | Clears the active-problem pointer, fully resets (`hub.resetForNewProblem()`), archives the current chat and starts a new one → responds with `activeProblemChanged` (§8.11, v0.12.0) |
| `listBusinessProblems` | `{}` | `ActiveProblemManager.listProblems()` → responds with `businessProblemsList` (§8.11, v0.12.0) |
| `switchBusinessProblem` | `{ problemId: string }` | Activates a different existing business problem (same reset sequence as above), archives the current chat and starts a new one → responds with `activeProblemChanged` (§8.11, v0.12.0) |
| `approveBusinessProblem` | `{}` | Sets `spec.problemStatementApproved = true` (§8.12, v0.13.0) — required before `approveSpec` will accept the spec |
| `approvePlan` | `{}` | `hub.approvePlan()` — explicit Plan Approval gate (§8.12, v0.13.0), required (alongside `confirmStages`) before `executePlan` will run |
| `confirmStages` | `{}` | `hub.confirmStages()` — explicit "confirm applicable stages" gate (§8.12, v0.13.0), required (alongside `approvePlan`) before `executePlan` will run |

### Extension → Webview

| Message Type | Payload | Purpose |
|-------------|---------|---------|
| `stateUpdate` | `{ state: PlanState }` | Plan state changes |
| `planUpdated` | `{ plan: PlanStep[] }` | New plan generated |
| `logEntry` | `{ message: string }` | Log message |
| `settingsLoaded` | `{ ...DataAgentHubSettings, languageModelInfo, copilotInfo }` | Initial settings |
| `settingsSaved` | `{ success: boolean }` | Settings confirmation |
| `error` | `{ message: string }` | Error notification |
| `contextUpdate` | `{ stats, dbEntities, bizTerms, queries }` | Context data |
| `stepUpdate` | `{ stepId, status, details }` | Step status change |
| `chatResponse` | `{ message: string, error?: boolean }` | Chat response |
| `agentStatus` | `{ agent, status, result? }` | Agent execution status |
| `sourceAssessmentComplete` | `{ success: boolean, error? }` | Assessment result |
| `chatSessionLoaded` | `{ meta: ChatSessionMeta, transcript: ChatMessage[] }` | Active/new session to render (§2.11, Phase F) |
| `chatSessionsList` | `{ sessions: ChatSessionMeta[], activeChatId?: string }` | All sessions (§2.11, Phase F) — populates the sidebar's Chat History dropdown (v0.13.0) |
| `specLoaded` | `{ spec: BusinessProblemSpec \| undefined }` | Current spec (including `implementationType`/`implementationTypeReason`, v0.10.0), sent on load and after every spec mutation |
| `specQuestion` | `{ question: SpecIntakeQuestion & { skillLabel?: string }, progress?: DiscoveryProgress }` | One discovery-turn question (`'ask'`) — chat bubble. `skillLabel`/`progress` added v0.13.0 (`discoveryProgress.ts`) so the interview reads as a bounded, structured process rather than opaque back-and-forth (§8.13) |
| `specQuestions` | `{ questions: Array<SpecIntakeQuestion & { skillLabel?: string }>, progress?: DiscoveryProgress }` | A batch of discovery-turn questions (`'ask_many'`, 2+) — dynamic intake form. Same v0.13.0 additions as `specQuestion` |
| `specDrafted` | `{ spec: BusinessProblemSpec, revised: boolean }` | A new draft (or revision) was synthesized |
| `specApproved` | `{ spec: BusinessProblemSpec }` | The spec was approved; Context Layer sync has already completed by the time this is posted (§2.12) |
| `contextGateStatus` | `{ targetStatus, sourceApplicable, sourceStatus, canGeneratePlan, blockingReasons, targetContext?, sourceContext? }` | The single source of truth for whether Generate Plan is unblocked (§8.10) — posted after every context-affecting action |
| `targetContextQuestions` / `sourceContextQuestions` | `{ questions: ContextQuestion[], answers: Record<string,string> }` | The fixed Q&A form to render, pre-filled with any prior answers |
| `targetContextBuilt` / `sourceContextBuilt` | `{ context: TargetContext \| SourceContext }` | Answers saved (status `built`) — awaiting `approve*Context` |
| `targetContextApproved` / `sourceContextApproved` | `{ context: TargetContext \| SourceContext }` | Approved — Target Context is now live in `hub.state.targetEnvironment` |
| `activeProblemChanged` | `{ problemId: string \| undefined, spec?: BusinessProblemSpec }` | Posted after `activateProblem()` completes (startup, switch, or new-problem reset); `problemId: undefined` is the genuinely clean "no active business problem" state (§8.11, v0.12.0) |
| `businessProblemsList` | `{ problems: BusinessProblemSummary[] }` | Every saved business problem in the workspace, newest-first, for the Workflow Palette's switcher (§8.11, v0.12.0) |

---

## Appendix B: CSS Variable Reference

| Variable | Fallback | Usage |
|----------|----------|-------|
| `--bg` | `#1f1f1f` | Main background |
| `--surface` | `#252526` | Cards, panels, input areas |
| `--surface-hover` | `rgba(255,255,255,0.03)` | Hover state |
| `--surface-active` | `rgba(255,255,255,0.06)` | Active/selected state |
| `--surface-elevated` | `rgba(255,255,255,0.04)` | Elevated surfaces |
| `--border` | `rgba(255,255,255,0.12)` | Standard borders |
| `--border-soft` | `rgba(255,255,255,0.08)` | Subtle borders |
| `--border-subtle` | `rgba(255,255,255,0.05)` | Very subtle borders |
| `--text` | `#cccccc` | Primary text |
| `--text-muted` | `#9d9d9d` | Secondary text |
| `--text-dim` | `rgba(255,255,255,0.45)` | Dimmed text |
| `--accent` | `#0e639c` | Primary accent |
| `--accent-hover` | `#1177bb` | Accent hover |
| `--accent-subtle` | `rgba(14,99,156,0.12)` | Subtle accent background |
| `--accent-border` | `rgba(14,99,156,0.25)` | Accent border |
| `--text-on-accent` | `#ffffff` | Text on accent |
| `--success` | `#2ea043` | Success green |
| `--warning` | `#d29922` | Warning amber |
| `--error` | `#f85149` | Error red |
| `--info` | `#58a6ff` | Info blue |
| `--radius` | `8px` | Card border radius |
| `--radius-sm` | `6px` | Small border radius |
| `--radius-xs` | `4px` | Extra small border radius |
| `--radius-pill` | `999px` | Pill border radius |
| `--spacing-xs` | `4px` | Extra small spacing |
| `--spacing-sm` | `8px` | Small spacing |
| `--spacing-md` | `12px` | Medium spacing |
| `--spacing-lg` | `16px` | Large spacing |
| `--spacing-xl` | `20px` | Extra large spacing |
| `--font-size` | `12px` | Base font size |
| `--font-size-sm` | `11px` | Small font size |
| `--font-size-lg` | `13px` | Large font size |
| `--font-size-xl` | `14px` | Extra large font size |
| `--transition-fast` | `0.12s ease` | Fast transitions |
| `--transition-normal` | `0.2s ease` | Normal transitions |
| `--transition-slow` | `0.3s ease` | Slow transitions |

---

*This document is version-controlled and should be updated whenever design decisions change during implementation.*