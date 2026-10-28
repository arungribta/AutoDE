---
name: autode-core-semantic-modeling
description: Draft, refine and repair AutoDE's shared semantic models (Snowflake semantic model YAML) from confirmed facts - tables and keys, relationships, dimensions, facts, metrics, synonyms, verified queries, kpi tags - resolve ambiguous base tables, bind models to their system, and propose each change for a person to approve. Use it when a semantic model is to be created, when a maintenance item names the semantic modeler, or when a metric, join or term has no counterpart in the layer.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_search_assets, mcp__autode__autode_get_asset_context, mcp__autode__autode_explore_graph, mcp__autode__autode_semantic_list, mcp__autode__autode_semantic_check, mcp__autode__autode_semantic_draft, mcp__autode__autode_semantic_resolve, mcp__autode__autode_propose_semantic_model, mcp__autode__autode_propose_assertion]
metadata:
  scope: core
  stageKinds: []
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: preview
---
# Semantic modeling

The semantic layer is the governed translation from data to agreed numbers. It is derived from the context layer: confirmed facts are its authority, and a person approves every change.

## 1. Know what is there

- `autode_semantic_list`: the shared models with their approval status, and the active problem's composites.
- `autode_semantic_check` with a model's `name`: its errors and warnings against the estate and the facts.
- `autode_list_assertions` (kinds `key`, `grain`, `relationship`, `metric`, `business_term`): what is confirmed and what is only proposed. Only confirmed facts back an element.

## 2. Draft, then refine

1. `autode_semantic_draft` with the model's `name` and its `tables` (defaults to the active problem's). AutoDE writes what the facts say: tables and primary keys, relationships, dimensions and facts by column type, metrics from metric facts, synonyms from bound glossary terms, and the facts behind each element (`backing`).
2. Refine it: descriptions in the business's words, synonyms the users say, `kpi` tags on the metrics the business steers by, verified queries for the questions the problem must answer.
3. Never add a metric, key or join that no fact supports. Propose the fact instead (`autode_propose_assertion`, with your reasoning as evidence) and leave the element out until it is confirmed.

## 3. Check and propose

1. `autode_semantic_check` with `content` (the whole file). Fix every error. A base table that is **ambiguous** fits several tables of the same name in other databases, systems or environments: set its `database`, or bind the model to a system, so it names exactly one.
2. `autode_propose_semantic_model` with scope `shared` (or `composite` for one problem's additions) and the whole file.
3. In your summary: what changed, the facts behind it, the check's warnings, and the problems and composites the change affects. A person approves it.

## 4. Repair (maintenance items)

| Item | What to do |
|---|---|
| `semantic-contradiction` | A confirmed fact and the model disagree. Decide which is right and why. Propose the model's change, or a correction of the fact with the same kind, subject and predicate. |
| `semantic-broken` | A column or table the model uses is gone, renamed or retyped. Find its replacement (`autode_resolve`, `autode_get_asset_context`) and propose the change. If nothing replaces it, propose removing the element and say what that breaks. |
| `semantic-ambiguous` | Set the base table's database, or bind the model, as in §3. |
| `semantic-gap` | A confirmed metric, join or term has no counterpart. Add it where it belongs: the metric to the table it measures, the relationship between the tables it joins, the term as a synonym. |

## Rules

- Snowflake semantic model YAML only. AutoDE's own metadata (backing, binding, approvals) stays in its sidecar.
- A composite may add metrics, filters and verified queries and change descriptions and synonyms. It never redefines a shared expression, key or join: that is a change to the shared model.
- Never approve, resolve or apply anything.
