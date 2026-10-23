---
name: autode-databricks-pipelines
description: Run an AutoDE business problem's compiled pipelines on Databricks as Lakeflow Declarative Pipelines - streaming tables and materialized views from the Pipeline Spec, AUTO CDC for keyed upserts and history, expectations from the quality rules - packaged in a bundle with its schedule and deployed through a runbook. Use it in the build stage when the target platform is Databricks.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_compile_pipeline_spec, mcp__autode__autode_check_grounding, mcp__autode__autode_explain_sql, mcp__autode__autode_list_connections, mcp__autode__autode_propose_runbook, mcp__autode__autode_runbook_status, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: databricks
  stageKinds: [build]
  platforms: [databricks]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Databricks pipelines

Written by AutoDE from Databricks' public documentation (Lakeflow Declarative Pipelines, formerly Delta Live Tables; Declarative Automation Bundles, formerly Databricks Asset Bundles). The pipeline logic comes from the approved Pipeline Spec; this skill decides how Databricks runs it. When `databricks-pipelines` is installed in the host, use it for details. AutoDE's rules still apply.

## 1. Start from the compiled spec

`autode_compile_pipeline_spec` with dialect `spark_sql` gives each step's SQL. Keep its logic; express it as pipeline datasets:

| Pipeline Spec step | Lakeflow dataset |
|---|---|
| Staging (`rename_cast`) over an append-only source | **Streaming table** reading `STREAM(<source>)` |
| Deduplication + incremental load on a key (`dedup` + `incremental_load`) | **`AUTO CDC INTO`** a streaming table: `KEYS` (the key fact), `SEQUENCE BY` (the change column), `STORED AS SCD TYPE 1`, or `TYPE 2` when the model keeps history |
| Joins and aggregates for marts | **Materialized view** |

`AUTO CDC` (formerly `APPLY CHANGES`) handles out-of-order changes by the sequence column. It replaces a hand-written MERGE.

## 2. Quality rules as expectations

Each approved quality rule on a pipeline dataset becomes a `CONSTRAINT <name> EXPECT (<condition>)`:
- **no action:** record the violation, keep the row (the default, for monitoring);
- **`ON VIOLATION DROP ROW`:** drop bad rows, only where the rule says so;
- **`ON VIOLATION FAIL UPDATE`:** stop the update, for rules whose breach makes the output wrong.

Name each constraint after the rule, so the quality report traces to it.

## 3. The bundle

- Pipeline SQL files go in `transformations/`, one file per entity.
- `databricks.yml` declares:
  - the pipeline (catalog and schema from the target context, `serverless: true` unless the team says otherwise, the SQL files as libraries);
  - a job with a `pipeline_task` and its schedule (the specification's freshness);
  - targets `dev` (`mode: development`: resources are prefixed per user and schedules paused) and `prod` (`mode: production`).
- **No secrets and no hosts with tokens in the bundle:** the runner deploys with the connection's CLI profile.
- Grounding: `autode_check_grounding` on each SQL file.

## 4. Propose the runbook and record the files

- `autode_record_artifact`: `databricks.yml` and each `transformations/*.sql`.
- `autode_propose_runbook` with a `bundle` step: folder and target `dev`. The engine dry-runs `databricks bundle validate`; a person approves; the runner runs `databricks bundle deploy`. Production is a second runbook against the production connection, `target: prod`, approved by a named approver. See `autode-databricks-deployment`.

## Worked example (the reference problem: retail orders)

`transformations/orders_pipeline.sql`:

```sql transformations/orders_pipeline.sql
CREATE OR REFRESH STREAMING TABLE stg_orders (
  CONSTRAINT order_id_present EXPECT (order_id IS NOT NULL) ON VIOLATION DROP ROW,
  CONSTRAINT known_status EXPECT (order_status IN ('PLACED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED'))
)
AS SELECT
  o.order_id,
  o.customer_id,
  o.order_ts,
  upper(o.status) AS order_status,
  o.currency AS currency_code,
  o.shipping_amount,
  o.tax_amount,
  o.updated_at
FROM STREAM(shop.orders) o;

CREATE OR REFRESH STREAMING TABLE orders_current;

CREATE FLOW orders_current_cdc AS AUTO CDC INTO orders_current
FROM STREAM(stg_orders)
KEYS (order_id)
SEQUENCE BY updated_at
STORED AS SCD TYPE 1;
```

`bundles/retail_orders/databricks.yml`:

```yaml bundles/retail_orders/databricks.yml
bundle:
  name: retail_orders

variables:
  catalog:
    default: retail_dev

resources:
  pipelines:
    retail_orders_pipeline:
      name: retail_orders_pipeline
      catalog: ${var.catalog}
      schema: staging
      serverless: true
      libraries:
        - file:
            path: ../../transformations/orders_pipeline.sql
  jobs:
    retail_orders_hourly:
      name: retail_orders_hourly
      schedule:
        quartz_cron_expression: "0 0 * * * ?"
        timezone_id: UTC
      tasks:
        - task_key: refresh_orders
          pipeline_task:
            pipeline_id: ${resources.pipelines.retail_orders_pipeline.id}

targets:
  dev:
    mode: development
    default: true
  prod:
    mode: production
    variables:
      catalog: retail
```

```yaml runbook
id: orders-pipeline
title: Deploy the orders pipeline to dev
reason: The approved Pipeline Spec stages shop.orders and keeps a current row per order; this bundle runs it on Databricks every hour.
connectionId: databricks:lakehouse_dev
stage: build
explanation: Deploys the bundle to the dev target. That creates the Lakeflow pipeline (stg_orders with two expectations, orders_current by AUTO CDC on order_id) and an hourly job, paused in development mode.
steps:
  - id: deploy-bundle
    title: Deploy bundles/retail_orders to dev
    kind: bundle
    folder: bundles/retail_orders
    target: dev
    expect: bundle validate passes; deploy creates retail_orders_pipeline and the retail_orders_hourly job in the dev workspace.
    timeoutSec: 900
    rollback:
      procedure: Deploy the previous commit of bundles/retail_orders the same way. To remove it from dev entirely, a person runs databricks bundle destroy --target dev (destructive; a separate runbook).
```
