---
name: autode-de-mapping
description: Write the source-to-target mapping of an AutoDE business problem - entity by entity and column by column, with transformations, using AutoDE's deterministic column matcher as evidence - into the problem's mapping document. Use it for the mapping stage of an AutoDE workflow.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_match_columns, mcp__autode__autode_mine_vocabulary, mcp__autode__autode_search_primitives, mcp__autode__autode_describe_primitive, mcp__autode__autode_propose_assertion, mcp__autode__autode_workflow_status, mcp__autode__autode_record_mapping, mcp__autode__autode_record_artifact]
metadata:
  scope: de
  stageKinds: [mapping]
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Source-to-target mapping

## 1. Sources, targets and grain

`autode_get_context_pack` with purpose `plan` and a query naming the problem gives the approved source and target contexts, the target entities, and the known keys, grain and relationships. `autode_list_assertions` (kinds `key`, `grain`, `relationship`, `business_term`) gives what is confirmed. List each target entity, its grain, and the source tables that feed it.

If a target entity's grain or key isn't known, don't guess: say so in your notes, and propose it as a fact if the sources establish it.

## 2. Match columns

For each source table → target entity, call `autode_match_columns`:
- with `target` when the target table is in the estate;
- with `targetColumns` (from the target context or model) when it is planned.

Read every candidate's reasons:
- **accept** a match when the meaning and type agree;
- **reject** one that only shares a word (for example `status` vs `status_date`);
- **use the alternatives** for the unmatched columns;
- **cryptic names**: `autode_mine_vocabulary` may explain them.

## 3. Transformations

For each column, write `transformExpression` when the value isn't copied as is:
- casts and trims;
- code-to-description lookups;
- defaults for nulls;
- derivations (net = gross - refunds);
- masking or hashing of personal data the specification protects.

Where a transform primitive fits (`autode_search_primitives`, `autode_describe_primitive`), name it in the notes. The build stage compiles it.

## 4. Draft each mapping

Call `autode_record_mapping` once per source table → target entity:
- `id`: `map-<source>-<target>`;
- `sourceEntityId` and `sourceFqn`: the resolved source table;
- `targetName`;
- `columns` with `sourceColumn`, `targetColumn` and `transformExpression`;
- `notes`.

Validation errors come back item by item: fix them and record again. Never map a column that doesn't resolve.

## 5. Notes and finish

Record `mapping-notes.md` with `autode_record_artifact`:
- per target entity: its grain, its sources, the target columns with no source and why;
- the matcher's suggestions you overruled, and why;
- open questions.

Reply with a short summary for the approver: entities mapped, columns mapped and unmapped, and the decisions they should check before approving the mapping.
