'use strict';
/**
 * System-under-test adapter for context-layer Phase C3 (v0.30.0): context packs, grounding
 * manifests and context gaps — on top of the C2 ledger adapter (same inputs, same stand-in for
 * C4's chat extraction; see sut/ledger.cjs).
 *
 *  - contextFor() returns the task-scoped pack AutoDE builds for that purpose: per plan step
 *    (query = the step's task) or per question.
 *  - Chat turns are sent with a chat pack built from the turn, as the panel now does.
 *  - Plan execution runs with the hub's context provider set, as the extension wires it, and an
 *    ArtifactWriter into the scratch workspace, so every artifact gets a `.grounding.json`.
 *  - capabilities.contextGaps() reports the gaps raised by chat and step packs.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createLedgerSut } = require('./ledger.cjs');
const { targetContextBlock } = require('./baseline.cjs');

function dist(rel) {
  return require(path.join(__dirname, '..', '..', '..', 'dist', rel));
}

function createPacksSut({ provider }) {
  const gaps = [];
  let sut;
  const cfm = () => sut.internals().cfm;
  let workspace;
  const run = { manifestFiles: 0 };

  sut = createLedgerSut({
    provider,
    chatContext: (text) => {
      const pack = cfm().buildContextPack({ purpose: 'chat', query: text }, `Chat: ${text.slice(0, 40)}`);
      gaps.push(...pack.manifest.gaps);
      return pack.text;
    },
    configureHub: async (hub, target) => {
      const { ArtifactWriter } = dist('context/ArtifactWriter.js');
      hub.setArtifactWriter(new ArtifactWriter({ fsPath: workspace }, () => {}));
      hub.setContextProvider({
        buildPack: (request) => {
          const pack = cfm().buildContextPack(request);
          gaps.push(...pack.manifest.gaps);
          return pack;
        },
        sources: () => cfm().getPackSources(),
        supplementary: () => targetContextBlock(target)
      });
    }
  });

  const setup = sut.setup;
  const runPlan = sut.runPlan;
  return {
    ...sut,
    name: 'context packs (v0.30.0, C3)',
    notes: [
      ...sut.notes,
      'Plan steps and questions each get their own context pack. The fixed reference plan is executed with the hub\'s context provider and an ArtifactWriter, exactly as the extension wires them.'
    ],

    async setup(opts) {
      workspace = opts.workspaceDir;
      await setup(opts);
    },

    async contextFor({ purpose, step, question }) {
      const query = step ? step.taskDescription : question;
      return cfm().buildContextPack({ purpose: purpose || 'qa', query, stepId: step && step.id }).text;
    },

    async runPlan(plan, target) {
      const result = await runPlan(plan, target);
      // Manifests on disk, and decisions resting on facts that are not active (stale-fact use).
      const walk = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'history' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]) : [];
      run.manifestFiles = walk(path.join(workspace, 'artifacts')).filter((f) => f.endsWith('.grounding.json')).length;
      const ledger = cfm().getLedger();
      const staleUse = result.manifests.reduce((n, m) => n + m.decisions.filter((d) => d.backedBy && (ledger.get(d.backedBy.id) || {}).status !== 'active').length, 0);
      return { ...result, manifestFiles: run.manifestFiles, staleUse };
    },

    capabilities: {
      ...sut.capabilities,
      async contextGaps() {
        const seen = new Set();
        return gaps.filter((g) => {
          const k = `${g.needed}|${g.subject.slice().sort().join('|')}|${g.stepId || ''}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
    }
  };
}

module.exports = { createPacksSut };
