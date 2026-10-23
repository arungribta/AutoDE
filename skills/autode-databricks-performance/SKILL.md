---
name: autode-databricks-performance
description: Tune an AutoDE business problem's Databricks tables and compute from evidence - liquid clustering instead of partitions and Z-order, predictive optimization or scheduled OPTIMIZE, VACUUM with a retention that keeps time travel, statistics - as a runbook a person approves. Use it in build and platform-setup stages when the target platform is Databricks.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_list_connections, mcp__autode__autode_execute_query, mcp__autode__autode_explain_sql, mcp__autode__autode_check_grounding, mcp__autode__autode_propose_runbook, mcp__autode__autode_runbook_status, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: databricks
  stageKinds: [build, platform-setup]
  platforms: [databricks]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Databricks performance

Written by AutoDE from Databricks' public documentation (liquid clustering, predictive optimization, OPTIMIZE, VACUUM, ANALYZE). Tune from evidence. Each setting states its reason, and anything that deletes files states what it costs.

## 1. Evidence first

- **Volumes and freshness:** source profiles and facts (`autode_list_assertions`, kind `data_fact`), and the specification's query patterns.
- **Where a connection allows it (read-only):**
  - `DESCRIBE DETAIL <table>`: number of files, size, clustering columns;
  - `system.query.history`: duration and bytes read per statement, where the workspace has system tables enabled.

  Run them with `autode_execute_query`. They return metadata and aggregates, not customer data.
- With no evidence (greenfield), set the defaults below and say that the first weeks in production are the evidence.

## 2. Layout

- **Liquid clustering** is the default for new tables: `CLUSTER BY (<columns>)` on create, or `ALTER TABLE … CLUSTER BY (…)` later. Choose up to four columns used in filters and joins (`order_date`, `customer_id`). Its keys can change later without rewriting the table.
- Don't partition tables under about a terabyte, and never on high-cardinality columns. Liquid clustering replaces both partitioning and `ZORDER`, and doesn't combine with them.
- `CLUSTER BY AUTO` lets Databricks choose the keys from the query workload, where predictive optimization is on.

## 3. Maintenance

- **Predictive optimization** (on Unity Catalog managed tables) runs OPTIMIZE and VACUUM itself. Where an administrator has enabled it for the catalog or schema, don't schedule them as well. Enabling it is an administrator's decision: propose it as such.
- **Without it:**
  - schedule `OPTIMIZE <table>` (it also clusters) after large loads;
  - schedule `VACUUM <table>` with the default retention of 7 days (`RETAIN 168 HOURS`). A shorter retention breaks time travel and can break long-running readers: never lower it without the stakeholder's decision.
- `ANALYZE TABLE … COMPUTE STATISTICS FOR ALL COLUMNS` after large changes helps the optimizer choose join strategies.

Classification: `ALTER TABLE … CLUSTER BY` and `OPTIMIZE` are changes. `VACUUM` deletes files that time travel and a restore would need: AutoDE classifies it as destructive. It has no rollback, so its step gives `noRollbackReason`.

## 4. Propose the runbook

`autode_propose_runbook` on the target connection: stage `build` for table layout, `platform-setup` for schedules or predictive optimization. Record the evidence and the reasoning with `autode_record_artifact` (`performance/notes.md`).

## Worked example (the reference problem: retail orders)

```sql
DESCRIBE DETAIL retail_dev.marts.fct_orders;

SELECT h.statement_id, h.total_duration_ms, h.read_bytes
FROM system.query.history h
WHERE h.start_time > current_timestamp() - INTERVAL 7 DAYS
  AND h.statement_text ILIKE '%fct_orders%'
ORDER BY h.total_duration_ms DESC
LIMIT 20;

ALTER TABLE retail_dev.marts.fct_orders CLUSTER BY (order_date, customer_id);

OPTIMIZE retail_dev.marts.fct_orders;

ANALYZE TABLE retail_dev.marts.fct_orders COMPUTE STATISTICS FOR ALL COLUMNS;

VACUUM retail_dev.marts.fct_orders RETAIN 168 HOURS;
```

```yaml runbook
id: fct-orders-layout
title: Cluster fct_orders and run its first maintenance
reason: The dashboards filter fct_orders by order date and customer, and DESCRIBE DETAIL shows thousands of small files after the first loads; predictive optimization is not enabled on retail_dev.
connectionId: databricks:lakehouse_dev
stage: build
explanation: Clusters fct_orders on order_date and customer_id, compacts and clusters its files, refreshes statistics, and removes files older than the default 7-day retention.
steps:
  - id: cluster-keys
    title: Liquid clustering on order_date, customer_id
    kind: sql
    sql: ALTER TABLE retail_dev.marts.fct_orders CLUSTER BY (order_date, customer_id)
    expect: DESCRIBE DETAIL shows clusteringColumns [order_date, customer_id].
    rollback:
      steps:
        - id: cluster-none
          title: Remove the clustering keys
          kind: sql
          sql: ALTER TABLE retail_dev.marts.fct_orders CLUSTER BY NONE
          expect: The table is no longer clustered on write.
  - id: optimize
    title: Compact and cluster the files
    kind: sql
    sql: OPTIMIZE retail_dev.marts.fct_orders
    expect: numFilesRemoved is larger than numFilesAdded; the data is unchanged.
    timeoutSec: 3600
    rollback:
      procedure: Nothing to undo (OPTIMIZE doesn't change the data; the earlier files stay until VACUUM).
  - id: statistics
    title: Refresh statistics
    kind: sql
    sql: ANALYZE TABLE retail_dev.marts.fct_orders COMPUTE STATISTICS FOR ALL COLUMNS
    expect: Statistics are current.
  - id: vacuum
    title: Remove files past the 7-day retention
    kind: sql
    sql: VACUUM retail_dev.marts.fct_orders RETAIN 168 HOURS
    expect: Files no longer referenced for 7 days or more are deleted; time travel within 7 days still works.
    noRollbackReason: VACUUM deletes files permanently. With the default 7-day retention, the table can still be restored to any version from the last 7 days.
```
