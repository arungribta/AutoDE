---
name: autode-de-quality-rules
description: Define the data quality rules for an AutoDE business problem - not-null, uniqueness, accepted values, ranges, referential integrity, freshness and reconciliation tolerances - each traced to the specification, a contract or the data. Use it for the quality-rules stage of an AutoDE workflow.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_check_conformance, mcp__autode__autode_pack_list, mcp__autode__autode_propose_assertion, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: de
  stageKinds: [quality-rules]
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Quality rules

## 1. Find the critical attributes

1. `autode_get_context_pack` with purpose `plan` and a query naming the problem: the specification's objectives, success criteria and constraints; the source and target objects; keys, grain and relationships.
2. `autode_list_assertions` for kinds `key`, `grain`, `relationship`, `quality_expectation` and `data_fact`: what is already known or confirmed, including profiles (null %, distinct counts, freshness).
3. `autode_pack_list`: contracts and data dictionaries. If the pack has contracts, `autode_check_conformance` shows where the data breaks them today.

A critical attribute is one the outcome depends on: keys and the columns joined on, the measures in the success criteria, the dates that drive incremental loads and reporting periods, and the columns a contract names.

## 2. Write the rules

For each critical attribute, one or more rules:

| Rule type | Use it for |
|---|---|
| `not_null` | keys, foreign keys, measures, reporting dates |
| `unique` | primary and natural keys, at the stated grain |
| `accepted_values` | status and type codes (list the values and where they come from) |
| `range` | amounts, quantities, dates (bounds from the contract or the profile) |
| `relationship` | every foreign key: the parent exists |
| `freshness` | each source the outcome needs: the maximum age, from the SLA |
| `reconciliation` | totals that must match between source and target, with the tolerance |

Each rule has: an id (`qr-<table>-<column>-<type>`), the table and column (resolved), the type and its parameters, the **severity** (`error` stops the load, `warn` reports), and the **reason** (the success criterion, contract clause or fact id it comes from).

## 3. Propose and record

- Propose each rule with `autode_propose_assertion`: kind `quality_expectation`, subject `[<table>, <column>]`, predicate the rule type, value its parameters and severity, the statement in one sentence, and the evidence (the spec criterion, contract or fact it traces to).
- Record two files with `autode_record_artifact` (stage: the quality-rules stage):
  - `quality-rules.yaml`: the rules as a list (`id`, `table`, `column`, `type`, `params`, `severity`, `reason`);
  - `quality-rules.md`: the same as a table for the reviewer, followed by **Critical attributes without a rule**, each with its reason, and **Not in the estate**: names you couldn't resolve.

## 4. Finish

Reply with a short summary for the approver: how many rules, of which `error` severity, which critical attributes have no rule and why, and what needs a person's confirmation in the Context Inbox.
