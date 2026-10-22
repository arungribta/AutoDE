---
name: autode-de-modelling
description: Design the target data model of an AutoDE business problem - entities, grain, keys, foreign keys and history - from AutoDE's deterministic draft, check it, and record the model, its DDL (rendered by AutoDE) and its rationale. Use it for the modelling stage of an AutoDE workflow.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_draft_model, mcp__autode__autode_check_model, mcp__autode__autode_propose_assertion, mcp__autode__autode_check_grounding, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: de
  stageKinds: [modelling]
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Data modelling

## 1. What the model must serve

`autode_get_context_pack` with purpose `plan` and a query naming the problem gives the specification's objectives, success criteria and metrics, the target context (approach, naming, platform) and the approved mapping. `autode_list_assertions` (kinds `grain`, `key`, `relationship`, `metric`, `business_term`) gives what is confirmed or proposed. Note the measures and the questions the model must answer.

## 2. Start from the draft

Call `autode_draft_model`. It returns:
- **model:** one entity per mapped target, with columns (types from the source), grain, keys and foreign keys where facts support them, each with its provenance;
- **gaps:** what isn't known.

## 3. Refine

- **Kind.** Set each entity's kind: `fact`, `dimension`, `bridge` (dimensional); `hub`, `link`, `satellite` (data vault); `table` (3NF, one big table).
- **Grain and keys.** Close every gap:
  - when a fact or the data establishes the grain or key, set it;
  - when it's a choice (a fact at order level or order-line level), propose it with `autode_propose_assertion` (kind `grain` or `key`, your reasoning and the spec criterion as evidence), set it in the model, and list it as a decision for the reviewer.
- **Dimensional models:**
  - facts reference dimensions through surrogate keys (`foreignKeys` with `references`);
  - add the conformed dimensions the measures need (a date dimension for every reporting date);
  - set `scd` on each dimension: 2 where the specification asks for history, else 1;
  - give every measure in the specification a column on a fact, with its definition in `description`.
- **Data vault:** hubs on business keys, links between hubs, satellites with history.
- **Names:** follow the naming convention; don't rename mapped columns without updating the mapping.

## 4. Check and render

Call `autode_check_model` with the refined model. Fix every error and call it again. Keep the warnings for the reviewer. Its `ddl` is the DDL. If you quote SQL elsewhere, check it with `autode_check_grounding`.

## 5. Record

With `autode_record_artifact`:
- `model.yaml`: the model as checked;
- `model.sql`: the DDL from `autode_check_model`, unchanged;
- `model.md`: one section per entity (kind, grain, keys, history, sources), a relationship list, the decisions you made and why, the facts you proposed, and the remaining warnings.

## 6. Finish

Reply with a short summary for the approver: the entities, the decisions they should check (grain and history choices especially), and the facts waiting for confirmation in the Context Inbox.
