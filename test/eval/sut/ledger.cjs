'use strict';
/**
 * System-under-test adapter for context-layer Phase C2 (v0.29.0): the assertion ledger.
 *
 * Same inputs and the same AutoDE code paths as the baseline adapter, plus:
 *  - ingested sources are recorded the way the extension records them —
 *    `ContextFileManager.persistCompiledGraph()` (what "Import File…" calls), which syncs the
 *    graph into the ledger and rebuilds the graph from it;
 *  - each scripted engineer turn's facts are proposed to the ledger.
 *
 * Chat extraction is Phase C4. Until it exists, this adapter stands in for it: the facts a turn
 * states (chat-script.yaml `facts` → golden/assertions.yaml) are proposed as an extractor would
 * propose them — kind, subject, predicate, value and the turn as evidence, at `inferred` /
 * `proposed`, subjects resolved deterministically against the graph. Everything the golden file
 * records as an *outcome* (status, trust, `supersedes`, `conflictsWith`, verification) is
 * withheld, so whatever the ledger concludes — conflicts in particular — is its own work.
 *
 * Capabilities: conflicts() only. Supersession from chat (trap 2) needs the extractor to
 * recognise a correction, so it stays unsupported until C4.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createBaselineSut } = require('./baseline.cjs');

function dist(rel) {
  return require(path.join(__dirname, '..', '..', '..', 'dist', rel));
}

const WITHHELD = ['status', 'trust', 'supersedes', 'conflictsWith', 'verification', 'id', 'evidence'];

function createLedgerSut({ provider }) {
  const base = createBaselineSut({ provider });
  const { parseYaml } = dist('engine/context/Yaml.js');
  const { createSubjectResolver, resolveSubjects } = dist('engine/context/projection.js');
  const { detectConflicts } = dist('engine/context/conflicts.js');
  let turnsByText = new Map();
  let golden = new Map();
  const proposals = [];

  const ledger = () => base.internals().cfm.getLedger();

  return {
    ...base,
    name: 'assertion ledger (v0.29.0, C2)',
    notes: [
      'Chat extraction arrives in C4. This run proposes each turn\'s scripted facts to the ledger as an extractor would (outcomes such as status, trust, supersession and conflicts withheld), so trap 1 measures the conflict detector, not extraction.'
    ],
    proposals,
    trapNotes: { 2: 'not yet: the ledger supersedes, but telling that a chat turn corrects an earlier one is extraction (C4) — here t5 and t6 surface as a key conflict instead' },

    async setup(opts) {
      await base.setup(opts);
      // What the extension's ingestFileIntoGraph() does after adding the parsed nodes.
      await base.internals().cfm.persistCompiledGraph();
      const load = (f) => parseYaml(fs.readFileSync(path.join(opts.referenceDir, f), 'utf8'));
      turnsByText = new Map(load('chat-script.yaml').turns.map((t) => [t.text, t]));
      golden = new Map(load('golden/assertions.yaml').assertions.map((a) => [a.id, a]));
    },

    async chat(text) {
      const res = await base.chat(text);
      const turn = turnsByText.get(text);
      if (turn && turn.facts) {
        const resolve = createSubjectResolver(base.internals().graph.serializeSnapshot());
        for (const factId of turn.facts) {
          const g = golden.get(factId);
          if (!g) continue;
          const fact = Object.fromEntries(Object.entries(g).filter(([k]) => !WITHHELD.includes(k)));
          const { subject, unresolved } = resolveSubjects(fact.subject, resolve);
          const a = await ledger().assert({
            kind: fact.kind,
            subject,
            predicate: fact.predicate,
            value: fact.value,
            statement: text,
            evidence: [{ type: 'chat_message', ref: `chat-script#${turn.id}`, excerpt: text }],
            trust: 'inferred',
            status: 'proposed',
            createdBy: 'agent:extraction-standin',
            flags: unresolved.length ? ['unresolved_subject'] : undefined
          });
          proposals.push({ fact: factId, id: a.id, subject, unresolved });
        }
        await base.internals().cfm.persistCompiledGraph();
      }
      return res;
    },

    ledgerSummary() {
      const all = ledger().assertions();
      const count = (pred) => all.filter(pred).length;
      return {
        assertions: all.length,
        events: ledger().allEvents().length,
        active: count((a) => a.status === 'active'),
        proposed: count((a) => a.status === 'proposed'),
        needsReview: count((a) => a.status === 'needs_review'),
        byTrust: ['verified', 'confirmed', 'documented', 'inferred'].map((t) => [t, count((a) => a.trust === t)]),
        unresolvedProposals: proposals.filter((p) => p.unresolved.length).map((p) => ({ fact: p.fact, unresolved: p.unresolved }))
      };
    },

    capabilities: {
      async conflicts() {
        return detectConflicts(ledger().assertions()).map((c) => ({ rule: c.rule, key: c.key, subject: c.subject, ids: c.ids, sides: c.sides }));
      }
    }
  };
}

module.exports = { createLedgerSut };
