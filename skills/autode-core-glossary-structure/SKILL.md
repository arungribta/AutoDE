---
name: autode-core-glossary-structure
description: Structure AutoDE's business glossary as SKOS concepts - place each term in a category, link broader, narrower and related terms, name its steward and status, and bind it to the columns it describes - as corrections a person confirms in the Context Inbox. Use it when terms fit no category, when the glossary has grown unorganised, or when a maintenance item names the knowledge engineer for the glossary.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_search_assets, mcp__autode__autode_get_asset_context, mcp__autode__autode_propose_assertion]
metadata:
  scope: core
  stageKinds: []
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: preview
---
# Glossary structure

A glossary term is a `business_term` fact. Its value is shaped like a SKOS concept: `term`, `definition`, `category`, `broader`, `narrower`, `related`, `steward`, `status` (draft, approved, deprecated), `abbreviation`, `examples`, and `boundTo` (the columns it describes).

## 1. See the glossary

`autode_list_assertions` with kind `business_term`. Note the terms with no category, terms that say the same thing twice, and terms bound to no column.

## 2. Find the categories

- Use the categories the team already uses before inventing one. Look in other terms' `category` values and in the domains (`autode://metadata/config`).
- Typical categories follow the business's subject areas: Customer, Product, Order, Finance, Risk. Keep them few and broad. A category is not a table.
- `broader` and `narrower` express "is a kind of" (Net revenue is narrower than Revenue). `related` expresses "see also". Never put a term in both its own broader and narrower lists.

## 3. Propose each term's place

For each term, call `autode_propose_assertion` with the **same kind, subject and predicate** as the existing term fact, so AutoDE links your proposal as a correction. Keep the definition, add the structure, and give your reasoning as evidence.

- Bind the term to its columns (`boundTo`) where the estate shows them (`autode_resolve`).
- Two terms that mean the same thing are one concept: propose one as the other's synonym (its `abbreviation`, or a `related` link and a note), and let the user decide which name stays.
- Name a steward only when the user or a document names one.

## Rules

- Organise; don't redefine. A definition changes only when the user or a document says so.
- A person confirms every correction in the Context Inbox (or with `autode facts confirm`).
