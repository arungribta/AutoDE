# Reference problem: retail-orders

A business problem of realistic size that AutoDE is measured against. It exists to show, with numbers, how grounded AutoDE's output is, and to show each roadmap phase improving those numbers. Specified in `docs/specs/context-layer.md` §10.

## Run it

```
npm run eval                                       # offline: no LLM, deterministic, no credentials
npm run eval -- --mode record --provider openai    # real provider; needs AUTODE_EVAL_API_KEY (AUTODE_EVAL_MODEL optional)
npm run eval -- --mode replay --provider openai    # re-run against the recorded cassette, offline
npm run eval -- --sut ledger                        # ablation: same ledger, the global context dump instead of packs
npm run eval -- --sut baseline                      # measure the v0.26.0 behaviour instead of the current system
```

The report is written to `eval-report.md` (with raw numbers in `eval-results.json`). Both are rolling and git-ignored. Frozen reports per release live in `baselines/`. `baselines/v0.26.0-offline.md` is the starting point, recorded before any context-layer work. `baselines/v0.29.0-offline.md` adds the assertion ledger (C2). `baselines/v0.30.0-offline.md` adds context packs and grounding manifests (C3). `baselines/v0.31.0-offline.md` adds estate identity (K1) and is the first on the 20-table fixture. `baselines/v0.32.0-offline.md` adds the working-set cache (K2): the large-estate scenario and the vocabulary-mismatch question set. `baselines/v0.33.0-offline.md` adds the business-problem pack (C4a): contract conformance, revision supersession, the interview filter, trap 3 caught by a probe, and the vocabulary-mismatch questions re-measured with vocabulary captured from the customer's glossary. `baselines/v0.41.0-offline.md` adds chat extraction and the Context Inbox (C4b). `baselines/v0.45.4-offline.md` changes what produces the artifacts: AutoDE's deterministic build (primitive candidates from the facts → Pipeline Spec → compiler, `test/eval/lib/deterministicBuild.cjs`) in place of the deleted TypeScript agents' template fallbacks. Its artifact numbers are not comparable with earlier baselines; the agents' own choices are measured with host-agent runs (PA3c). `plan.yaml`'s steps are now context probes only, and its `buildSources` list what the build builds from.

Record mode works with the `fetch()`-based providers (`openai`, `azure-openai`, `anthropic`, `gemini`, `ollama`) and with `claude` if the Claude Code CLI is installed. `copilot` needs VS Code itself and can't be recorded from the command line.

## Contents

| Path | What it is |
|---|---|
| `problem.md` | The business problem statement |
| `sources/shop.ddl`, `sources/crm.ddl` | The two source systems: 20 tables, 129 columns. Both have a `customers` table, as real estates often do, and both have a `ref.currency_codes` table — the same fully qualified name with different columns (v0.31.0). |
| `sources/shop_dev.ddl` | Two tables of the shop system's dev environment: same names as production, one column ahead. Must stay distinct from production (v0.31.0). |
| `sources/legacy/edw_dbc_columns.csv` | A Teradata `DBC.ColumnsV` export of a legacy EDW (3 tables, cryptic names): a source with no live connector (v0.31.0). |
| `sources/hr_legacy.ddl` | 40 irrelevant tables, there to test context dilution |
| `vocabulary-questions.yaml` | 21 questions that name a table in other words — synonyms, legacy abbreviations, the acquired team's terms, glossary-only links and free paraphrases — scored per retrieval signal (v0.32.0) |
| `documents/pack/customer-contract.v1.yaml`, `.v2.yaml` | A Customer 360 data contract in the client data office's own YAML format; shop conforms, crm violates it in four planted places; revision 2 changes three clauses (v0.33.0) |
| `documents/pack/profile.house-contract.yaml` | The confirmed interpretation profile that reads that format |
| `documents/pack/brd.md` | A draft free-text BRD (facts extracted in replay/record runs) |
| `documents/pack/glossary.md`, `vocabulary-proposal.offline.json` | The customer's glossary, and the vocabulary an LLM proposes from it (the offline stand-in; replay/record runs ask the LLM). Accepted, it re-measures the vocabulary-mismatch questions (v0.33.0) |
| `documents/pack/expected.yaml` | What the pack scenario must find |
| `sources/samples/shop_customers.csv`, `crm_customers.csv` | Customer samples for probes; crm's has a duplicate `cust_no` |
| `documents/vocabulary.yaml` | The acquired CRM team's vocabulary (cross-organisation synonyms), as an engineer records it in `.autode/knowledge/vocabulary.yaml` |
| `../../eval/lib/largeEstate.cjs` | Generator for the large estate (4 systems, ~2 000 tables, ~50 000 columns, planted questions) used to measure scale and responsiveness (v0.32.0) |
| `sources/samples/loyalty_members.csv` | Sample rows; contains a duplicate `member_id` |
| `documents/business-context.yaml` | The client's finance glossary and rules (defines revenue as gross) |
| `chat-script.yaml` | The engineer's side of the conversation, including the traps |
| `target.yaml`, `plan.yaml` | Target environment and a fixed reference plan |
| `questions.yaml` | 30 questions: 26 answerable from what was said, 4 that must be answered "not known" |
| `expected-artifacts.yaml` | Properties generated code must have, checked structurally |
| `golden/assertions.yaml`, `golden/semantic-model.yaml` | The context and semantic model AutoDE should end up with (scored from C4 and C5) |
| `cassettes/` | Recorded LLM responses per provider (created by record mode) |

## The five traps

1. **Revenue is defined two ways.** The glossary says gross; the engineer says net. The conflict must be raised, not silently merged.
2. **A key is corrected mid-conversation.** "customer_id" becomes "cust_no". Anything built on the first statement is stale.
3. **A "unique" key isn't.** `member_id` has a duplicate in the sample. A probe must catch it.
4. **A join with no relationship behind it.** Support tickets relate to customers, not orders. The system must ask, not invent a join.
5. **An irrelevant schema is ingested.** None of its tables should appear in the context for a plan step.

## How the harness talks to AutoDE

`test/eval/run-eval.cjs` drives AutoDE's real code in plain Node, through a headless `vscode` stand-in (`test/eval/lib/vscodeHost.cjs`). It reaches AutoDE only through a system-under-test adapter (`test/eval/sut/baseline.cjs`). Each later phase adds an adapter exposing its new capabilities (conflicts, supersession, probes, context gaps, context packs), and is scored on identical inputs.
