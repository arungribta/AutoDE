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
 * Since v0.41.0 (C4b) the stand-in plays only the model's part: it returns each turn's facts as
 * the extractor's JSON (`{ facts: [...] }`, outcomes withheld — including `supersedes`), and the
 * engine does the rest exactly as after a real chat turn: `parseChatExtraction()` validates and
 * resolves, `recordChatProposals()` dedups and links corrections. The engineer then confirms the
 * turn's proposals in the Context Inbox (the golden end state is confirmed facts), which is when
 * a correction retires the fact it replaces.
 *
 * Capabilities: conflicts(), superseded().
 */
const fs = require('node:fs');
const path = require('node:path');
const { createBaselineSut } = require('./baseline.cjs');

function dist(rel) {
  return require(path.join(__dirname, '..', '..', '..', 'dist', rel));
}

const WITHHELD = ['status', 'trust', 'supersedes', 'conflictsWith', 'verification', 'id', 'evidence'];

function createLedgerSut(opts) {
  // Sources are imported the way "Import File…" imports them since v0.32.0 (catalog + working set).
  const base = createBaselineSut({ ...opts, viaCatalog: true });
  const { parseYaml } = dist('engine/context/Yaml.js');
  const { createSubjectResolver, resolveSubjects } = dist('engine/context/projection.js');
  const { detectConflicts } = dist('engine/context/conflicts.js');
  const { parseChatExtraction, recordChatProposals } = dist('engine/context/chatExtraction.js');
  let turnsByText = new Map();
  let golden = new Map();
  const proposals = [];

  const ledger = () => base.internals().cfm.getLedger();

  return {
    ...base,
    name: 'assertion ledger (v0.29.0, C2)',
    notes: [
      'Chat extraction (C4b) needs the LLM. Offline, a stand-in returns each turn\'s scripted facts as the extractor\'s JSON (outcomes such as status, trust, supersession and conflicts withheld); validation, subject resolution, dedup and correction linking are the engine\'s own work, and the engineer\'s Inbox confirmation is simulated per turn. Extraction quality itself is measured by hand (manual-verification Part 18).'
    ],
    proposals,
    corrections: [],
    trapNotes: { 2: 'supersession: the engine linked the correction and retired the earlier fact when it was confirmed' },

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
        // What the model would return for this turn: the scripted facts, outcomes withheld.
        const raw = { facts: turn.facts.map((id) => golden.get(id)).filter(Boolean).map((g) => ({ kind: g.kind, subject: g.subject, predicate: g.predicate, value: g.value, statement: text })) };
        const outcome = parseChatExtraction(raw, { ref: `chat-script#${turn.id}`, text, source: 'chat' }, resolve);
        const { recorded, corrections } = await recordChatProposals(ledger(), outcome);
        this.corrections.push(...corrections);
        recorded.forEach((a, i) => proposals.push({ fact: turn.facts[i], id: a.id, subject: a.subject, unresolved: (a.flags || []).includes('unresolved_subject') ? a.subject : [] }));
        // The engineer confirms the turn's proposals in the Context Inbox.
        for (const a of recorded) await ledger().confirm(a.id, 'user:engineer');
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
      },
      /** C4b: facts a confirmed correction replaced. */
      async superseded() {
        return ledger().assertions().filter((a) => a.status === 'superseded' && a.supersededBy && !String(a.createdBy).startsWith('system') && a.predicate !== 'node' && a.predicate !== 'edge').map((a) => ({ id: a.id, by: a.supersededBy, statement: a.statement }));
      }
    }
  };
}

module.exports = { createLedgerSut };
