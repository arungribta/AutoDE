'use strict';
/**
 * The offline build (v0.45.4): what AutoDE's deterministic path produces for
 * the reference problem — `autode_primitive_candidates` for each source in
 * `plan.buildSources`, every valid step accepted, the Pipeline Spec compiled
 * by the engine — with a grounding manifest per file. It replaces the offline
 * plan run, whose TypeScript agents (and their template fallbacks) are gone;
 * the pipeline engineer's own judgement is measured with host-agent runs
 * (PA3c).
 */
const path = require('node:path');

function deterministicBuild({ dist, cfm, plan, specId = 'retail' }) {
  const { primitiveCandidates } = dist('engine/agents/primitiveCandidates.js');
  const { compilePipelineSpec } = dist('engine/pipelineSpec/compiler.js');
  const { buildSchemaIndex } = dist('engine/grounding/sqlGrounding.js');
  const { buildGroundingManifest } = dist('engine/grounding/manifest.js');
  const sources = cfm.getPackSources();
  const index = buildSchemaIndex(sources.graph.nodes, sources.graph.edges);
  const notes = [];
  const entities = [];
  for (const source of plan.buildSources || []) {
    try {
      const r = primitiveCandidates({ source, schemaIndex: index, assertions: sources.assertions, nodes: sources.graph.nodes });
      const transforms = r.entity.transforms.filter((t) => t.valid).map((t) => ({ kind: t.kind, params: t.params }));
      if (transforms.length) entities.push({ ...r.entity, transforms });
      for (const n of r.notes) notes.push(n);
    } catch (err) { notes.push(`${source}: ${err.message}`); }
  }
  const spec = { specVersion: 1, id: `ps-${specId}`, version: 1, status: 'draft', derivedFromBpsId: specId, derivedFromBpsVersion: 1, targetPlatform: 'snowflake', entities, createdAt: '', updatedAt: '' };
  const artifacts = [];
  const manifests = [];
  for (const [ei, e] of compilePipelineSpec(spec, 'snowflake').entries()) {
    e.artifacts.forEach((a, i) => {
      const step = spec.entities[ei].transforms[i];
      const filePath = path.posix.join('03-build', e.name, `${i + 1}_${a.kind}.sql`);
      artifacts.push({ id: filePath, title: `${e.name}: ${a.kind}`, filePath, type: 'transformation', language: 'sql', content: a.content, generatedBy: 'pipeline-spec', phase: 'build' });
      manifests.push(buildGroundingManifest({
        artifact: { path: filePath, content: a.content, language: 'sql', agent: 'pipeline-spec', specId, specVersion: 1 },
        catalogRevisions: sources.catalogRevisions,
        stepId: e.name,
        primitiveUses: [{ kind: step.kind, params: step.params, source: 'primitive', lineage: spec.entities[ei].source.object }],
        graph: sources.graph,
        schemaIndex: index,
        assertions: sources.assertions
      }));
    });
  }
  const ledger = cfm.getLedger ? cfm.getLedger() : undefined;
  const staleUse = ledger ? manifests.reduce((n, m) => n + m.decisions.filter((d) => d.backedBy && (ledger.get(d.backedBy.id) || {}).status !== 'active').length, 0) : null;
  return { artifacts, steps: [], schemaContext: '', manifests, staleUse, manifestFiles: null, spec, notes };
}

module.exports = { deterministicBuild };
