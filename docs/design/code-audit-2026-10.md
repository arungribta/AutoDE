# Code audit, October 2026: dead and stranded code

**For:** the owner, deciding what to remove after the direction changes and simplifications (SIMP-1 to SIMP-4, PA3).
**Date:** 2026-10-26, at v0.45.13. **Decisions:** all taken on 2026-10-26 (the owner accepted every recommendation); items 1 to 5 shipped in v0.45.14.

AutoDE changed direction several times: the plan of steps became the workflow; TypeScript agents became role templates and skills; settings-based connections became named connections and the estate. This audit sorts what those changes left behind into three groups:
- **dead:** nothing reaches it, and no roadmap phase names it. **Removed.**
- **stranded:** it works, but what used to call it is gone, or a newer path does the same job. **Kept, with a recommendation for your decision.**
- **parked:** waiting for a phase on the roadmap. **Kept.**

## How it was checked

1. **Reachability.** Every module was followed from the three entry points: the extension (`src/extension.ts`), the CLI (`src/cli/main.ts`) and the MCP server (`src/mcp/server.ts`). Static imports, re-exports, `import()` and `require()` were all counted.
2. **References.** For every exported declaration, the TypeScript language service listed its references in `src/`. Exports used only by tests or scripts were listed separately.
3. **Wiring.** Panel message handlers were checked against what the webview pages send, messages the extension posts against what the pages listen for, commands declared against those registered, settings declared against those read, and layout entries against their uses.
4. **Lint.** Unused imports and variables.

Removals were done one wave at a time. After each wave the analysis was run again, because removing a caller can orphan what it called. Tests, lint and the eval were run after each wave.

## Removed (dead)

| What | Where | Why it was dead |
|---|---|---|
| `copilotAdapter.ts` (re-export shim), and the aliases `CopilotAdapter`, `CopilotInfo`, `CopilotModelInfo` | `src/core/` | Back-compat names from before the adapter was generalised; nothing in `src/` used them, only a test of the shim itself. |
| `GraphPersistence.ts` (re-export shim) | `src/context/` | Kept "so existing imports keep working" when the module moved into the engine in v0.43.2; only one test still imported it (now imports the engine module). |
| `platformDialect.ts` (`platformToDialect`) | `src/engine/transforms/` | Unreachable from any entry point. |
| `runnableReason` | `agentExecutor.ts` | No callers. |
| `getExtensionDisplayName`, `getExtensionDescription`, `EXTENSION_PANEL_ID`, `EXTENSION_NAME`, `EXTENSION_DESCRIPTION` | `extensionIdentity.ts` | No callers. The two settings they read are still read by `configManager`, so the settings stay. |
| `EnvironmentProfile`, `OutputFormat`, `WebviewSettingsMessage` | `engine/types.ts` | Left over from SIMP-4, which removed the environment profile and output formats. |
| `problemRootPath`, `graphToMirrorAssertions`, `listCredentialResolvers`, `getPrimitive`, `STAGE_KIND_NAMES` | engine | No callers. |
| `ContextPackProvider` interface | `engine/context/contextPack.ts` | Described the hub's context provider, which went with the plan of steps (SIMP-3). Nothing is typed against it. |
| Panel handlers no page sends: `updateTargetConfig`, `listSources`, `listInbox` (an alias of `listDecisions`), `openArtifactFolder`, `approvePipelineSpec`, the `generatePipelineSpec` message | `webviewProvider.ts` | No webview sends them. `updateTargetConfig` belonged to the target form that became the target context in v0.45.10. The methods behind the last two stay, because the build stage's Produce and a decision still call them. |
| Posted messages no page listens for: `pipelineSpecGenerated`, `pipelineSpecApproved`, `sourceAssessmentComplete`, `targetConfigUpdated`, `artifactFactStaleness` | `webviewProvider.ts` | The page ignores them. The same information already goes to the log. |
| Layout entry `carryover` | `workspaceLayout.ts` | The interview carry-over went in v0.45.12. The `approvals` entry is now used by the runbook policy instead of a hand-built path. |
| 12 unused imports | across `src/` | Lint warnings fell from 33 to 22. |

**Behaviour:** nothing a person or an agent can do changed. 366 tests pass, and the eval is unchanged.

## Stranded or overlapping: your decisions

### 1. Two AI paths make the build stage's Pipeline Spec in VS Code

- **Run agent:** the pipeline engineer, through primitive candidates, the Pipeline Spec and AutoDE's deterministic compiler, with grounding manifests (PA3b, v0.45.4).
- **Produce:** a one-shot LLM synthesis of the whole Pipeline Spec (`AgentHub.synthesizePipelineSpec`, `src/agents/pipelineSpecSynthesis.ts`, the command *AutoDE: Generate Pipeline Spec*).

The two can disagree, and only the first is what agent hosts do. That goes against "one way per change" (SIMP-2) and "every surface, same outcome".

**Recommendation:** make Produce on a build stage run the stage's agent. Then remove the one-shot synthesis, `src/agents/pipelineSpecSynthesis.ts` and the palette command. About 300 lines.

**Done (v0.45.14):** a build stage offers Run agent only, and the one-shot synthesis and its command are gone.

The mapping stage's Produce is different and should stay. It lets a person author a mapping by hand (pick the source and target, then edit), which is the manual path next to the agent.

### 2. Two ways to bring a source's metadata in

- **The platform card's "Run Source Assessment" button** (`autoDataEngineeringHub.sourceAssessment`) extracts through the single connection in the settings (`connectionManager`), with profiling.
- **Named connections** (`.autode/config/connections.yaml`), with `autode estate extract`, `autode_ingest_metadata` and the source assessor's Run agent, bring metadata into the estate per system.

v0.45.10 removed the settings-based *Connect to Source* check from the source context, but this button still uses the settings connection.

**Recommendation:** have the button run the estate extraction on a named connection, so there is one way in.

**Done (v0.45.14):** the button picks a named connection, a database and its schemas, and ingests through `autode_ingest_metadata`.

### 3. Refresh on use has lost its caller

`ContextFileManager.refreshWorkingSet()` (K2) refreshes stale working-set objects "before a plan runs". The plan run went in SIMP-3, so today only tests call it, and stale tables are no longer refreshed before an agent works on them.

**Recommendation:** call it before a stage's agent runs (Run agent, and `autode_workflow_next`). This restores what K2 intended.

**Done (v0.45.14):** the panel's Run agent calls it. In hosts, `autode_refresh_working_set` calls it, and the orchestrator skill calls that before an assignment. `autode_workflow_next` stays read-only.

### 4. Back-compat and debug commands in the palette

- `testCopilot` and `listCopilotInfo` are aliases of `testLanguageModel` and `listLanguageModelInfo`.
- `debugListExtensions` is a debug aid.

All three show in the command palette. `copilotHandoff` is used by a prompt, so it stays.

**Recommendation:** drop the two aliases and the debug command from `package.json` at the next UI release. A keybinding someone made to them would stop working, which is why this is your call.

**Done (v0.45.14):** the three commands are gone.

### 5. Engine helpers only tests use

`approveWorkflow`, `roleFor`, `resolveSubjects`, `renderGroundingReport`, `getAuthModesForPrincipal`, `unregisterCredentialResolver`, `problemFromRoot` and `checkDefinitions` are exercised by tests, but no product path calls them.

**Recommendation:** keep them; they are small, tested operations. One exception is worth a look: `checkDefinitions` (a role naming a skill that doesn't exist). The catalog already reports this its own way, so either use `checkDefinitions` there or drop it.

**Done (v0.45.14):** the helpers are kept, and the catalog now uses `checkDefinitions`.

### 6. A decision that changed: the interview after New Chat

Until v0.45.12, New Chat ended an interview and folded its answers into context as a note. The design notes record that you chose this over resuming the interview, blocking New Chat, or discarding it. v0.45.12 changed it to resuming, following PA3 §7, which you approved later (2026-10-21). That newer decision governs. It is recorded here so the change isn't silent.

## Parked (kept, named on the roadmap)

- **The knowledge files** (business context, verified queries, semantic-layer snapshots) and the source registry: they fold into the ledger in **C5**.
- **The semantic layer builder:** superseded by the semantic model in **C5**.
- **`ToolSkillAgent`** (`src/agents/build/`): runs imported tool skills (SKL-2). It is live, and its lifecycle is unified with AutoDE's skills in **PA4**.

## Not a problem

382 exports are used only inside their own file. They could be made private, but that changes nothing at run time.

## Doing it again

The checks are two scripts. `deadcode.cjs` covers reachability and references through the TypeScript language service. `wiring.cjs` covers messages, commands, settings and layout. Both were run from the session's scratch folder. If this audit becomes routine, they can move into `scripts/` and run as part of `npm test`, with a short allow-list for the parked items.
