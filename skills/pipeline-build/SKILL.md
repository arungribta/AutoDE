---
name: pipeline-build
description: Build an AutoDE business problem's pipelines - a Pipeline Spec of transform primitives (staging, deduplication, incremental loads) drafted from the approved mapping, model and facts, compiled by AutoDE into code with grounding manifests. Use it for the build stage of an AutoDE workflow.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_primitive_candidates, mcp__autode__autode_search_primitives, mcp__autode__autode_describe_primitive, mcp__autode__autode_validate_transform, mcp__autode__autode_compile_transform, mcp__autode__autode_validate_pipeline_spec, mcp__autode__autode_compile_pipeline_spec, mcp__autode__autode_record_pipeline_spec, mcp__autode__autode_check_grounding, mcp__autode__autode_explain_sql, mcp__autode__autode_list_connections, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
---
# Pipeline build

## 1. Inputs

`autode_get_context_pack` with purpose `plan` and a query naming the problem gives:
- the approved mapping: which sources feed which targets, column by column;
- the target context: platform, transformation tool, orchestration, naming;
- the model, if the modelling stage recorded one;
- the quality rules, if the quality stage recorded them.

`autode_list_assertions` (kinds `key`, `grain`, `data_fact`) gives the keys and profiles the steps rely on.

## 2. Steps per source

For each mapped source table, call `autode_primitive_candidates` with the source and its target. It returns:
- `rename_cast`: staging that projects, renames and casts the mapped columns;
- `dedup`: one row per key, the latest by the change column;
- `incremental_load`: a MERGE on the key;
- **notes:** expressions no primitive covers, a missing key or change column.

Each step has its reasons and is validated. Decide:
- **Accept** a step when its reasons hold for this problem. For example, deduplicate when the key fact is confirmed or a profile shows duplicates.
- **Full refresh** when there is no change column: leave out `incremental_load` and say so.
- **Other primitives:** `available` lists the workspace's own; check their parameters with `autode_describe_primitive` and `autode_validate_transform`.

## 3. Draft the Pipeline Spec

Call `autode_record_pipeline_spec` with:
- one entity per target: `name`, `source` (object, type), `transforms` (the accepted steps, as `kind` and `params`), `target` (object, `table` or `view`);
- `quality.rules`: descriptions of the quality rules that apply to the entity;
- `governance.columns`: the classification of personal data columns;
- `targetPlatform` from the target context.

Validation errors come back step by step: fix them and record again.

## 4. Compile and record

1. `autode_compile_pipeline_spec` with the dialect of the target platform (`snowflake`, `spark_sql`, …).
2. Record each compiled file with `autode_record_artifact`, as `sql/<entity>/<n>_<kind>.sql`, with `primitives`: the step it came from (`kind`, `params`) and its `lineage` (the entity's source table). Its grounding manifest then records which facts back each key and order decision.
3. For what no primitive covers (column expressions from the mapping; joins of several sources into a mart): write the SQL, check it with `autode_check_grounding`, dry-run it with `autode_explain_sql` when a connection is available, and record it as `sql/<entity>/custom_<name>.sql`.
4. Never quote a table or column that doesn't resolve.

## 5. Notes and finish

Record `build-notes.md` with `autode_record_artifact`:
- per entity: the steps and why, full refresh or incremental, and its custom SQL with the reason no primitive fits;
- the run order;
- what is missing (keys, change columns, expressions).

Reply with a short summary for the approver: entities, steps, custom SQL, and what to check before approving the Pipeline Spec.
