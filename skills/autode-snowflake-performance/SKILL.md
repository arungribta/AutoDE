---
name: autode-snowflake-performance
description: Size and tune an AutoDE business problem's Snowflake workload from evidence - warehouses per workload with auto-suspend and timeouts, clustering keys only where query history and clustering depth justify them - as a runbook a person approves. Use it in build and platform-setup stages when the target platform is Snowflake.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_list_connections, mcp__autode__autode_execute_query, mcp__autode__autode_explain_sql, mcp__autode__autode_check_grounding, mcp__autode__autode_propose_runbook, mcp__autode__autode_runbook_status, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: snowflake
  stageKinds: [build, platform-setup]
  platforms: [snowflake]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Snowflake performance

Written by AutoDE from Snowflake's public documentation (warehouse considerations, clustering keys, query history). Tune from evidence, not habit. Every setting here costs credits, so each one states the reason for it.

## 1. Evidence first

- **Volumes and freshness:** the source profiles and facts (`autode_list_assertions`, kind `data_fact`) give row counts and how often data changes. The specification gives the freshness and query patterns the business needs.
- **Where a connection allows it (read-only):**
  - `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` for elapsed time, partitions scanned against total, and bytes spilled. Account usage lags by up to 45 minutes and needs a role with access to the `SNOWFLAKE` database.
  - `SYSTEM$CLUSTERING_INFORMATION('<table>', '(<columns>)')` for clustering depth.

  Run them with `autode_execute_query`. They return aggregates and metadata, not customer data.
- With no evidence (greenfield), start small and say so: the first production weeks are the evidence.

## 2. Warehouses

- **One warehouse per workload:** loading, transformation, BI. Each can be sized and suspended on its own, and costs are attributable.
- **Start at `XSMALL` or `SMALL`.** Scale **up** (a bigger size) when single queries spill to local or remote storage. Scale **out** (multi-cluster, Enterprise edition) when queries queue because of concurrency, not because they are slow.
- `AUTO_SUSPEND = 60` and `AUTO_RESUME = TRUE` for transformation and loading. BI may keep a longer suspend to keep its cache warm, when the evidence shows repeated queries.
- `STATEMENT_TIMEOUT_IN_SECONDS` caps a runaway query. Resource monitors need `ACCOUNTADMIN`: propose them as a separate runbook for an administrator.
- `INITIALLY_SUSPENDED = TRUE`, so creating a warehouse doesn't start billing.

## 3. Clustering

- Snowflake's natural clustering (insertion order) is enough for most tables. Define a clustering key only when **all** hold:
  - the table is large (multi-terabyte, or many thousands of micro-partitions);
  - queries filter or join on a few columns;
  - query history shows most partitions scanned.
- Cluster on low-to-medium cardinality expressions used in filters (`order_date`, not `order_ts` or `order_id`). Automatic clustering then runs in the background and costs credits: say so in the runbook.
- **Point lookups** on high-cardinality columns call for search optimization, not clustering. That is an Enterprise feature: name it, with the evidence, as a decision.

## 4. Propose the runbook

`autode_propose_runbook`, stage `platform-setup` for warehouses and `build` for clustering keys. Give each step its rollback (`ALTER WAREHOUSE … SET WAREHOUSE_SIZE = <previous>`; `ALTER TABLE … DROP CLUSTERING KEY`). Record the evidence and the reasoning with `autode_record_artifact` (`performance/notes.md`).

## Worked example (the reference problem: retail orders)

The evidence queries (read-only), then the changes:

```sql
SELECT SYSTEM$CLUSTERING_INFORMATION('shop.orders', '(TO_DATE(order_ts))');

SELECT q.query_id, q.warehouse_size, q.total_elapsed_time, q.partitions_scanned, q.partitions_total, q.bytes_spilled_to_local_storage
FROM snowflake.account_usage.query_history q
WHERE q.start_time > DATEADD(day, -7, CURRENT_TIMESTAMP())
  AND q.query_text ILIKE '%fct_orders%'
ORDER BY q.total_elapsed_time DESC
LIMIT 20;

CREATE WAREHOUSE IF NOT EXISTS transform_wh
  WAREHOUSE_SIZE = 'SMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  STATEMENT_TIMEOUT_IN_SECONDS = 3600;

ALTER TABLE marts.fct_orders CLUSTER BY (order_date);
```

```yaml runbook
id: transform-warehouse
title: Transformation warehouse and the fct_orders clustering key
reason: The pipelines need their own warehouse; query history shows dashboards filtering fct_orders by order_date while scanning nearly all its partitions.
connectionId: snowflake:analytics_dev
stage: platform-setup
explanation: Creates a small transformation warehouse that suspends after a minute idle and stops any statement after an hour. Clusters fct_orders by order_date, which the dashboards filter on; automatic clustering then runs in the background and costs credits.
steps:
  - id: transform-wh
    title: Warehouse transform_wh
    kind: sql
    sql: CREATE WAREHOUSE IF NOT EXISTS transform_wh WAREHOUSE_SIZE = 'SMALL' AUTO_SUSPEND = 60 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE STATEMENT_TIMEOUT_IN_SECONDS = 3600
    expect: transform_wh exists, suspended, size SMALL.
    rollback:
      procedure: DROP WAREHOUSE IF EXISTS transform_wh, once no task or dynamic table names it.
  - id: cluster-fct-orders
    title: Cluster fct_orders by order_date
    kind: sql
    sql: ALTER TABLE marts.fct_orders CLUSTER BY (order_date)
    expect: SHOW TABLES shows the clustering key; clustering depth falls over the following days.
    rollback:
      steps:
        - id: drop-clustering-key
          title: Drop the clustering key
          kind: sql
          sql: ALTER TABLE marts.fct_orders DROP CLUSTERING KEY
          expect: Automatic clustering stops for the table.
```
