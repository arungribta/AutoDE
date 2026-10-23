---
name: autode-core-vocabulary
description: Propose the customer's retrieval vocabulary to AutoDE - abbreviations (CUST = customer) and synonyms (client ~ customer) mined from the estate's names and comments and read from the pack's documents - so AutoDE finds the right tables for the words people use. Use it when names are cryptic, when a search for a business word misses a table, or after new sources or documents arrive.
allowed-tools: [Read, mcp__autode__autode_mine_vocabulary, mcp__autode__autode_pack_list, mcp__autode__autode_resolve, mcp__autode__autode_propose_vocabulary]
metadata:
  scope: core
  stageKinds: []
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Vocabulary

AutoDE matches a person's words to tables and columns through its vocabulary (`.autode/knowledge/vocabulary.yaml`). A missing entry means a question about "clients" misses `CUST_MSTR`. Entries come from evidence, never from guesses.

## 1. Gather candidates

- `autode_mine_vocabulary` returns abbreviations and synonyms mined from the estate's table and column names and comments, each with the names it came from.
- The pack's documents (`autode_pack_list`, then Read): a glossary or data dictionary often says "CUST_NO is the customer number" outright.
- What the user says: "we call them clients".

## 2. Check each one

- `autode_resolve` the business word: if it already finds the table, the entry isn't needed.
- Keep an entry only when the evidence is a name, a comment, a document or the user. Drop expansions that are merely plausible (`DT` could be date or detail: ask).
- **Abbreviation:** a short form used in names (`from: cust`, `to: customer`).
- **Synonym:** two words for one thing (`from: client`, `to: customer`).

## 3. Propose

`autode_propose_vocabulary` with the entries. The stakes are low: after the user agrees, the decision can be approved straight away, or left for the panel. Then check that `autode_resolve` finds the tables for the user's words.

## Worked example

The CRM's columns are `CUST_NO`, `CUST_NM` and `ADDR_LN1`, and its data dictionary says "CUST = customer". Propose:
- `abbreviation cust → customer`, with evidence from the column names and the dictionary;
- `abbreviation addr → address`, with evidence from the column name.

Don't propose `abbreviation nm → name` unless a comment or the user says so.
