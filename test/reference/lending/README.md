# Fixture: lending (ONT1)

A small lending estate beside the retail reference problem, for the ontology (docs/specs/context-layer.md §6.8). It checks that a standard onboards deterministically and that a bank's vocabulary aligns with the expected FIBO concepts.

| Path | What it is |
|---|---|
| `sources/loansys.ddl` | LOANSYS, a legacy loan system: 7 tables with cryptic names (`deal_mstr`, `brwr`, `loan_appl`, `collat`, `pmt`, `guar`, `cust_acct`). Its own word for a credit facility is *deal*. |
| `glossary.yaml` | The vocabulary: enterprise terms (Facility, Borrower, …), LOANSYS's own word (Deal, scope: system), a line of business's (Obligor, scope: credit risk), and columns two of them are bound to. |
| `vocabulary.yaml` | LOANSYS's abbreviations (`BRWR`, `APPL`, `COLLAT`, …) and its synonym *deal* for *facility*. |
| `expected-alignment.yaml` | What aligning the vocabulary to the shipped FIBO lending pack must propose: each term's concept and match, the term that fits none, and the tables that represent a concept. |
| `standards/lending-sample.ttl`, `.rdf` | The same small FIBO-style ontology in Turtle and in RDF/XML (with DOCTYPE entities, as FIBO's files are written). Onboarding either gives the same pack. |
| `standards/house-restricted.ttl` | A house ontology whose licence forbids redistribution: its pack stays in the workspace, and export is refused. |

Used by the v0.59.0 ONT1 test in `test/functional.test.cjs`.
