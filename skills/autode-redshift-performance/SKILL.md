---
name: autode-redshift-performance
description: Read an Amazon Redshift source's physical design from evidence - distribution style and key, sort keys, row skew, unsorted share, stale statistics and compression (the performance.table_design operation) - and carry what it says into the assessment and into the new platform's design. Tuning Redshift as a target comes in v0.55.2. Use it in source assessment and modelling when a source is Redshift.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_connections, mcp__autode__autode_platform_operations, mcp__autode__autode_platform_run, mcp__autode__autode_propose_assertion, mcp__autode__autode_record_artifact]
metadata:
  scope: redshift
  stageKinds: [source-assessment, modelling]
  platforms: [redshift]
  version: 1
  owner: AutoDE
  maturity: preview
---
# Redshift physical design

Written by AutoDE from AWS's public Redshift documentation (`SVV_TABLE_INFO`, distribution styles, sort keys). Preview: checked on recorded results, not yet on a live account.

## 1. Read the evidence

`autode_platform_run` with `performance.table_design` and the schema, on the Redshift connection. One row per table:

| Column | Read it as |
|---|---|
| `distribution` | `KEY(column)`: rows placed by that column's hash, so joins on it stay on one node. `EVEN`: spread round-robin. `ALL`: a full copy on every node (small dimensions). `AUTO(…)`: Redshift chose, and may change it. |
| `sort_key` | The first sort key column. Range filters on it skip blocks. |
| `skew_rows` | Largest slice ÷ smallest. Above about 4, a poor distribution key: one node does most of the work. |
| `unsorted_pct` | Share of rows outside sort order. High means VACUUM SORT is overdue. |
| `stats_off_pct` | How stale the planner's statistics are. Above about 10, ANALYZE is overdue. |
| `encoded` | `N`: no column compression, so the table is larger and slower to scan. |

The operation reads `SVV_TABLE_INFO`, which shows a regular user only some tables. If tables are missing, say so; don't infer.

## 2. What it tells the assessment

Record what the evidence shows as facts on the tables (`autode_propose_assertion`, kind `data` or `constraint`, with the operation as evidence). Never guess a value the read didn't give.
- **The join paths:** a `KEY(customer_id)` distribution says the workload joins on `customer_id`. That's a strong hint for the target model's relationships and clustering.
- **The access paths:** a date sort key says queries filter by date. On Snowflake that becomes a clustering key only if the table is large and history shows the filters (the `autode-snowflake-performance` skill); on Databricks, liquid clustering or partitioning on that column.
- **Problems not to carry over:** high skew, a stale-statistics backlog or uncompressed tables are Redshift maintenance debt, not requirements. Note them as findings, not design inputs.
- **Small `ALL` tables** are dimensions. Expect them to be conformed dimensions in the target model.

## 3. Write it up

`autode_record_artifact` with a short table-by-table note (for example `assessment/redshift_physical_design.md`): the distribution and sort keys, what they imply for the target, and the debt found.

## Tuning Redshift as a target

Choosing distribution and sort keys for new tables, workload management and maintenance runbooks come with Redshift as a target (v0.55.2, platform-operations §6.2b).
