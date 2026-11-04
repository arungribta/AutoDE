---
name: autode-core-ontology-onboarding
description: Onboard an industry standard (FIBO first, or the team's own OWL or SKOS copy) as an AutoDE ontology pack - the concepts a business problem touches, one hop out, each placed under the upper layer - and propose it as a workspace-level decision a person approves. Use it when a problem needs shared meaning (an ontology, FIBO, canonical definitions) or a maintenance item says a concept is missing.
allowed-tools: [Read, mcp__autode__autode_ontology_standards, mcp__autode__autode_ontology_browse, mcp__autode__autode_ontology, mcp__autode__autode_ontology_analyze, mcp__autode__autode_propose_ontology_pack, mcp__autode__autode_get_concept_context, mcp__autode__autode_search_assets, mcp__autode__autode_get_asset_context, mcp__autode__autode_list_assertions]
metadata:
  scope: core
  stageKinds: [ontology-alignment]
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Onboarding a standard

AutoDE's meaning has three layers: the **upper layer** (Party, Agreement, Product, Account, Transaction, Location, Event, Document; always in effect), **industry packs** (a curated subset of a standard, each concept with its source IRI) and **extensions** (`ext:`, the team's own). A pack is light: concepts, one parent each, relations with cardinality hints, attributes and synonyms. No axioms.

## 1. Source

`autode_ontology_standards` lists the standards catalog: FIBO (a pack ships), CIM as CGMES and BIAN (read from their repositories), and the team's. Use `source: { standard: "<id>" }`. A standard without a shipped pack is fetched only when a person browses it (Ontology view, Standards; or `autode ontology browse <id>`); until then AutoDE refuses it to you: ask the user. Browse it first (`autode_ontology_browse`: the tree, a search, a concept in full) to choose concepts. A standard the catalog lacks: autode-core-standard-research. A team's own copy can also be a file or folder in the workspace (`source: { file }`).

## 2. Analyse

`autode_ontology_analyze` with `source: { shipped: "fibo-lending" }` or `{ file: "standards/fibo" }`. Read what comes back:

| Field | What to check |
|---|---|
| `licence`, `distribution` | `workspace` means its licence doesn't allow redistribution: the pack stays in this workspace. Say so to the user. |
| `scope.seeds` | Concepts the glossary, tables and columns name, with what matched. A seed matched only by a column is weak: check it. |
| `scope.neighbours` | One hop out: parents and relation targets. Keep those the problem needs. |
| `placement` | Each concept the source leaves without a parent, with AutoDE's suggestion. A wrong suggestion is worse than none: place it yourself (`place`). |
| `warnings` | Several parents, axioms not kept, files skipped. |

Adjust with `add`, `remove` (or `only`) and `place`, and analyse again with `preview: true` to read the pack itself.

## 3. Keep it small

About 20 to 40 concepts for a first pack: what the problem touches, one hop out. A pack grows on demand: onboarding the same standard again adds concepts to the team's pack and keeps what it has. Never delete a concept from a pack: deprecate it.

## 4. Propose

`autode_propose_ontology_pack` with the same source and choices and a `reason` (the problem it serves). It is a workspace-level decision: every business problem shares the ontology. Tell the user a person approves it in the AutoDE panel; then align the vocabulary (autode-core-term-alignment).

## Rules

- Propose; never approve.
- Keep the standard's IRIs and definitions; don't rewrite them. A concept the standard lacks is an extension (`ext:`) in a pack of the team's own, with `broader` naming the standard concept it narrows.
- Concepts the problem needs and the standard doesn't have are a question for the user, not an invention.
