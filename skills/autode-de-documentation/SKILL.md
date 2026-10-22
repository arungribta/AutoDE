---
name: autode-de-documentation
description: Document a business problem's data deliverables (design, data dictionary, operations runbook, decision log) from AutoDE's approved specification, workflow history, context and Pipeline Spec. Use it for the documentation stage of an AutoDE workflow.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_generate_design_doc, mcp__autode__autode_validate_pipeline_spec, mcp__autode__autode_check_grounding, mcp__autode__autode_workflow_status, mcp__autode__autode_workflow_history, mcp__autode__autode_list_decisions, mcp__autode__autode_record_artifact]
metadata:
  scope: de
  stageKinds: [document]
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Documentation

Produce the documents below for the active business problem. Each is Markdown, recorded with `autode_record_artifact` (its `stage` is the documentation stage, its `path` the file name shown here).

## 1. Gather what is known

1. `autode_workflow_status` and `autode_workflow_history`: which stages are done, who approved them and how, which were skipped and why.
2. `autode_get_context_pack` with purpose `plan` and a query naming the problem: the estate objects, confirmed facts, conflicts and gaps.
3. `autode_validate_pipeline_spec`; when it is valid, `autode_generate_design_doc` for the design document's skeleton.
4. `autode_list_decisions` (status `applied`) for the decisions behind the deliverables.

If a stage the document depends on isn't done, say so at the top of that document instead of guessing.

## 2. Write

- **`design.md`** — purpose (from the specification), scope in and out, sources and target, the model (entities, grain, keys), how sources map to the target, the transformations (which primitives), and the open gaps. Start from the generated design document when there is one, and add the narrative it lacks.
- **`data-dictionary.md`** — every target entity and column you can find in the context: name, type, meaning, source, rule. One table per entity.
- **`runbook.md`** — how the pipelines run: order, schedule and orchestration (from the target context), incremental logic, what to check after a run, how to re-run a failed load, who to ask.
- **`decisions.md`** — the decision log: each approved decision (what, why, who approved it, through which channel, when), and each skipped stage with its reason. This is what an auditor reads.

## 3. Check

- Run `autode_check_grounding` on any SQL you quote; don't quote SQL with unresolved tables or columns.
- Every table and column you name must resolve with `autode_resolve`. Mark anything that doesn't as *not in the estate*.

## 4. Finish

Reply with a short summary for the person approving the stage: which documents you recorded, and what is missing or uncertain.
