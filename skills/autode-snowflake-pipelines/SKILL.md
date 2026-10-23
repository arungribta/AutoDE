---
name: autode-snowflake-pipelines
description: Run an AutoDE business problem's compiled pipelines on Snowflake - dynamic tables for declarative staging and deduplication, streams and tasks for incremental MERGE loads - created through a runbook a person approves. Use it in the build stage when the target platform is Snowflake.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_compile_pipeline_spec, mcp__autode__autode_check_grounding, mcp__autode__autode_explain_sql, mcp__autode__autode_list_connections, mcp__autode__autode_propose_runbook, mcp__autode__autode_runbook_status, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: snowflake
  stageKinds: [build]
  platforms: [snowflake]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Snowflake pipelines

Written by AutoDE from Snowflake's public documentation (dynamic tables, streams, tasks). The pipeline logic comes from the approved Pipeline Spec; this skill decides how Snowflake runs it.

## 1. Start from the compiled spec

`autode_compile_pipeline_spec` with dialect `snowflake` gives each step's SQL: staging (`rename_cast`), deduplication (`dedup`), incremental loads (`incremental_load`, a MERGE). Don't rewrite that logic. Wrap it in the Snowflake objects below. Where you must write SQL yourself, check it with `autode_check_grounding`.

## 2. Choose how each step runs

| Step | Default | When to use the other |
|---|---|---|
| Staging, deduplication, joins, aggregates | **Dynamic table** (`TARGET_LAG`, `REFRESH_MODE = INCREMENTAL`) | A view, when it is small and read rarely |
| MERGE into a table that keeps history or needs custom logic | **Stream + task** running the compiled MERGE | A dynamic table, when the result is a pure function of its inputs |

**Dynamic tables:**
- `TARGET_LAG` is the freshness the specification asks for (for example `'1 hour'`). Use `DOWNSTREAM` for intermediate tables, so they refresh only when a table above them needs it.
- Set `REFRESH_MODE = INCREMENTAL` explicitly. Creation then fails visibly when the query can't be refreshed incrementally, instead of falling back to full refreshes.
- `WAREHOUSE` names the transformation warehouse (the performance skill sizes it).

**Streams and tasks:**
- A stream on the source table, and a task with `WHEN SYSTEM$STREAM_HAS_DATA('<stream>')` that runs one MERGE. A task that finds no data doesn't start the warehouse.
- Tasks are created **suspended**. `ALTER TASK … RESUME` is the runbook's last step, after everything it depends on exists. Child tasks use `AFTER <parent>`: resume children before the root.
- The MERGE reads only `METADATA$ACTION = 'INSERT'` rows of the stream (an update appears as a delete and an insert), and updates only when the incoming change column is newer.

**Always:** `CREATE … IF NOT EXISTS`. `CREATE OR REPLACE` drops the object, and a dynamic table rebuilt from scratch can be expensive. AutoDE classifies it as destructive.

## 3. Propose the runbook and record the files

- `autode_propose_runbook` on the target connection, stage `build`. Steps in dependency order: streams, dynamic tables, tasks, then the resumes. Give each a rollback (`DROP … IF EXISTS`; for a resume, `ALTER TASK … SUSPEND`).
- `autode_record_artifact` with the SQL files (for example `pipelines/orders.sql`) and notes: the lag chosen and why, steps left as views, anything the spec couldn't express.

## Worked example (the reference problem: retail orders)

Staging and deduplication as a dynamic table, and an incremental load into the model's fact table with a stream and a task. The MERGE is the compiled `incremental_load` step.

```sql
CREATE DYNAMIC TABLE IF NOT EXISTS staging.stg_orders
  TARGET_LAG = '1 hour'
  WAREHOUSE = transform_wh
  REFRESH_MODE = INCREMENTAL
  INITIALIZE = ON_CREATE
AS
SELECT
  o.order_id,
  o.customer_id,
  o.order_ts,
  UPPER(o.status) AS order_status,
  o.currency AS currency_code,
  o.shipping_amount,
  o.tax_amount,
  o.updated_at
FROM shop.orders o
QUALIFY ROW_NUMBER() OVER (PARTITION BY o.order_id ORDER BY o.updated_at DESC) = 1;

CREATE STREAM IF NOT EXISTS staging.orders_changes ON TABLE shop.orders;

CREATE TASK IF NOT EXISTS staging.load_fct_orders
  WAREHOUSE = transform_wh
  SCHEDULE = '15 MINUTE'
  WHEN SYSTEM$STREAM_HAS_DATA('staging.orders_changes')
AS
MERGE INTO marts.fct_orders t
USING (
  SELECT c.order_id, c.customer_id, c.order_ts, c.status, c.shipping_amount, c.tax_amount, c.updated_at
  FROM staging.orders_changes c
  WHERE c.METADATA$ACTION = 'INSERT'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY c.order_id ORDER BY c.updated_at DESC) = 1
) s
ON t.order_id = s.order_id
WHEN MATCHED AND s.updated_at > t.updated_at THEN UPDATE SET
  customer_id = s.customer_id, order_ts = s.order_ts, order_status = s.status,
  shipping_amount = s.shipping_amount, tax_amount = s.tax_amount, updated_at = s.updated_at
WHEN NOT MATCHED THEN INSERT (order_id, customer_id, order_ts, order_status, shipping_amount, tax_amount, updated_at)
  VALUES (s.order_id, s.customer_id, s.order_ts, s.status, s.shipping_amount, s.tax_amount, s.updated_at);

ALTER TASK staging.load_fct_orders RESUME;
```

```yaml runbook
id: orders-pipeline
title: Orders staging and the fct_orders load
reason: The approved Pipeline Spec stages and deduplicates shop.orders and loads marts.fct_orders incrementally; these objects run it on Snowflake.
connectionId: snowflake:analytics_dev
stage: build
explanation: A dynamic table keeps staging.stg_orders within an hour of shop.orders. A stream records changes to shop.orders, and a task merges them into marts.fct_orders every 15 minutes when there are any. The task starts suspended and is resumed last.
steps:
  - id: stg-orders
    title: Dynamic table staging.stg_orders
    kind: sql
    sql: CREATE DYNAMIC TABLE IF NOT EXISTS staging.stg_orders TARGET_LAG = '1 hour' WAREHOUSE = transform_wh REFRESH_MODE = INCREMENTAL INITIALIZE = ON_CREATE AS SELECT o.order_id, o.customer_id, o.order_ts, UPPER(o.status) AS order_status, o.currency AS currency_code, o.shipping_amount, o.tax_amount, o.updated_at FROM shop.orders o QUALIFY ROW_NUMBER() OVER (PARTITION BY o.order_id ORDER BY o.updated_at DESC) = 1
    expect: staging.stg_orders exists with one row per order_id, refreshed incrementally.
    timeoutSec: 1800
    rollback:
      steps:
        - id: drop-stg-orders
          title: Drop the dynamic table
          kind: sql
          sql: DROP DYNAMIC TABLE IF EXISTS staging.stg_orders
          expect: staging.stg_orders is gone.
  - id: orders-stream
    title: Stream on shop.orders
    kind: sql
    sql: CREATE STREAM IF NOT EXISTS staging.orders_changes ON TABLE shop.orders
    expect: The stream exists and starts recording changes from now.
    rollback:
      procedure: DROP STREAM IF EXISTS staging.orders_changes (changes since its creation are no longer tracked).
  - id: load-task
    title: Task merging changes into marts.fct_orders
    kind: sql
    sql: CREATE TASK IF NOT EXISTS staging.load_fct_orders WAREHOUSE = transform_wh SCHEDULE = '15 MINUTE' WHEN SYSTEM$STREAM_HAS_DATA('staging.orders_changes') AS MERGE INTO marts.fct_orders t USING (SELECT c.order_id, c.customer_id, c.order_ts, c.status, c.shipping_amount, c.tax_amount, c.updated_at FROM staging.orders_changes c WHERE c.METADATA$ACTION = 'INSERT' QUALIFY ROW_NUMBER() OVER (PARTITION BY c.order_id ORDER BY c.updated_at DESC) = 1) s ON t.order_id = s.order_id WHEN MATCHED AND s.updated_at > t.updated_at THEN UPDATE SET customer_id = s.customer_id, order_ts = s.order_ts, order_status = s.status, shipping_amount = s.shipping_amount, tax_amount = s.tax_amount, updated_at = s.updated_at WHEN NOT MATCHED THEN INSERT (order_id, customer_id, order_ts, order_status, shipping_amount, tax_amount, updated_at) VALUES (s.order_id, s.customer_id, s.order_ts, s.status, s.shipping_amount, s.tax_amount, s.updated_at)
    expect: The task exists, suspended.
    rollback:
      procedure: DROP TASK IF EXISTS staging.load_fct_orders
  - id: resume-task
    title: Resume the load task
    kind: sql
    sql: ALTER TASK staging.load_fct_orders RESUME
    expect: SHOW TASKS shows the task started; its first run merges the changes recorded so far.
    rollback:
      steps:
        - id: suspend-task
          title: Suspend the load task
          kind: sql
          sql: ALTER TASK staging.load_fct_orders SUSPEND
          expect: The task no longer runs.
```
