'use strict';
/**
 * System-under-test adapter for AutoDE as it is today (the v0.26.0 baseline).
 *
 * The harness only talks to AutoDE through this interface, so later phases (C2 ledger, C3
 * context packs, C4 enrichment …) add an adapter exposing their new capabilities and are
 * measured on identical inputs:
 *
 *   setup({ workspaceDir, referenceDir, sourceOrder })   ingest sources + documents
 *   contextFor({ purpose, question, step })             the context the system would deliver
 *   chat(text)                                          one engineer turn → { reply } | { error }
 *   runPlan(plan, target)                               execute a plan → GeneratedArtifact[]
 *   schemaGraph()                                       { nodes, edges } — for grounding checks
 *   capabilities                                        optional; a missing entry = not supported
 *     conflicts()     → [{ subject, ids }]   contradictions the system has detected
 *     superseded()    → [{ id, by }]         facts the system knows were replaced
 *     verify(claim)   → { result }           check a claim against data
 *     contextGaps()   → [{ needed, subject }] facts a step needed but did not have
 *
 * Everything here calls AutoDE's real code; nothing is re-implemented.
 */
const fs = require('node:fs');
const path = require('node:path');

function dist(rel) {
  return require(path.join(__dirname, '..', '..', '..', 'dist', rel));
}

function buildSettings(provider) {
  return {
    activeLlmProvider: provider || 'openai',
    activeLlmModel: process.env.AUTODE_EVAL_MODEL || undefined,
    languageModelProgrammaticConsent: true,
    dataPlatformCliConsent: false,
    readOnlyMode: true
  };
}

function fakeConfigManager(settings) {
  return {
    getSettings: () => settings,
    getExtensionContext: () => undefined,
    getLlmApiKey: async () => process.env.AUTODE_EVAL_API_KEY,
    getSecret: async () => undefined
  };
}

function toTargetEnvironment(t) {
  return {
    platform: t.platform,
    environmentProfile: t.environment || 'development',
    modelingApproach: t.modelingApproach,
    namingConvention: t.namingConvention,
    transformationTool: t.transformationTool,
    orchestrationTool: t.orchestrationTool || 'none',
    outputFormats: ['sql', 'yaml', 'markdown'],
    platformConfig: t.platformConfig || {}
  };
}

/** Mirrors webviewProvider.buildContextSummaryForPlan's "## Target Context" block. */
function targetContextBlock(t) {
  const pc = t.platformConfig || {};
  return [
    '## Target Context',
    `Platform: ${t.platform}. Environment: ${t.environment || 'development'}.`,
    `Modeling approach: ${t.modelingApproach}. Naming convention: ${t.namingConvention}.`,
    `Transformation tool: ${t.transformationTool}. Orchestration tool: ${t.orchestrationTool || 'none'}.`,
    pc.database || pc.schema ? `Target location: ${pc.database || ''}${pc.schema ? '.' + pc.schema : ''}` : ''
  ].filter((l) => l.trim()).join('\n');
}

/**
 * Hooks for adapters that build on this one: `chatContext(text)` replaces the context a chat
 * turn is sent with; `configureHub(hub, target)` runs before plan execution.
 */
function createBaselineSut({ provider, chatContext, configureHub, viaCatalog }) {
  const { GraphManager } = dist('context/GraphManager.js');
  const { ContextFileManager } = dist('context/ContextFileManager.js');
  const { parseFile } = dist('engine/context/fileIngestion.js');
  const { DataAgentHubHub } = dist('core/agentHub.js');

  const settings = buildSettings(provider);
  const graph = new GraphManager();
  let cfm;
  const logs = [];
  const ingestion = [];

  return {
    name: 'baseline (v0.26.0)',
    logs,
    ingestion,

    async setup({ workspaceDir, referenceDir, sourceOrder, identities }) {
      // Documents go where AutoDE reads them: .ai-context/context/business-context.yaml
      const ctxDir = path.join(workspaceDir, '.ai-context', 'context');
      fs.mkdirSync(ctxDir, { recursive: true });
      fs.copyFileSync(path.join(referenceDir, 'documents', 'business-context.yaml'), path.join(ctxDir, 'business-context.yaml'));
      cfm = new ContextFileManager({ fsPath: workspaceDir }, graph, (m) => logs.push(m));
      await cfm.initialize();
      // Sources go in the way "Import File…" puts them: parseFile → the shared graph.
      for (const file of sourceOrder) {
        const full = path.join(referenceDir, 'sources', file);
        // Phase K1: a file's estate system/environment (default: a system named after the file).
        const parsed = parseFile(fs.readFileSync(full, 'utf8'), full, identities && identities[file]);
        // v0.32.0: "Import File…" goes through ContextFileManager.ingestParsed() (catalog, working set,
        // glossary links); the baseline keeps the v0.26.0 path of adding straight to the graph.
        if (viaCatalog) await cfm.ingestParsed(parsed.nodes, parsed.edges);
        else {
          for (const n of parsed.nodes) await graph.addNode(n);
          for (const e of parsed.edges) await graph.addEdge(e);
        }
        ingestion.push({ file, tables: parsed.nodes.filter((n) => n.type === 'table').length, warnings: parsed.warnings || [] });
      }
    },

    // Baseline has one context for everything: the same global dump regardless of purpose.
    async contextFor() {
      return cfm.buildContextPrompt();
    },

    async chat(text) {
      const hub = new DataAgentHubHub(fakeConfigManager(settings));
      hub.setLogListener((m) => logs.push(m));
      try {
        const res = await hub.chat(text, chatContext ? chatContext(text) : cfm.buildContextPrompt());
        return { reply: res.message };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },

    async runPlan(plan, target) {
      const hub = new DataAgentHubHub(fakeConfigManager(settings));
      hub.setLogListener((m) => logs.push(m));
      const schemaContext = [cfm.buildContextPrompt(), targetContextBlock(target)].filter((p) => p && p.trim()).join('\n\n');
      hub.loadPersistedPlan({
        id: 'eval-plan', version: 1, objective: plan.objective, schemaContext,
        steps: plan.steps.map((s) => ({ ...s, status: 'pending', dependsOn: s.dependsOn || [] })),
        status: 'ready', targetEnvironment: toTargetEnvironment(target),
        planApproved: true, stagesConfirmed: true
      });
      if (configureHub) await configureHub(hub, target);
      await hub.executePlan();
      const state = hub.getPlan();
      return { artifacts: state.artifacts || [], steps: state.steps, schemaContext, manifests: hub.getLastRunManifests ? [...hub.getLastRunManifests()] : [], hub };
    },

    schemaGraph() {
      return graph.serializeSnapshot();
    },

    /** For adapters that build on this one (sut/ledger.cjs). */
    internals() {
      return { graph, cfm, logs };
    },

    // The baseline has none of these mechanisms — the harness records each as "not supported".
    capabilities: {}
  };
}

module.exports = { createBaselineSut, targetContextBlock };
