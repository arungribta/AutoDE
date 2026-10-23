---
name: autode-databricks-deployment
description: Deploy an AutoDE business problem's approved deliverables to Databricks as bundles through runbooks - validate as the dry run, deploy to the dev target first and production under a named approver, run as a service principal in production, never destroy without a separate runbook - and bring the deployed objects back into the estate. Use it in the deploy stage when the target platform is Databricks.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_connections, mcp__autode__autode_check_grounding, mcp__autode__autode_explain_sql, mcp__autode__autode_propose_runbook, mcp__autode__autode_runbook_status, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: databricks
  stageKinds: [deploy]
  platforms: [databricks]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Databricks deployment

Written by AutoDE from Databricks' public documentation (Declarative Automation Bundles, formerly Databricks Asset Bundles: targets, modes, `run_as`). When `databricks-dabs` is installed in the host, use it for bundle details. The deploy stage is done when its runbook has run successfully. You write the runbook; a person approves it; AutoDE's runner runs it. You never run `databricks` commands that change the workspace yourself. In hosts with AutoDE's plugin, a hook blocks them.

## 1. What to deploy

- The build stage's recorded bundle (`databricks.yml`, pipeline SQL, jobs, a dbt project), from `autode_get_context_pack` (purpose `plan`).
- Only **approved** deliverables. If the Pipeline Spec or the model isn't approved, say so and stop.
- The target connection per environment. The team's policy (`.autode/config/approvals.yaml`) says which is production.

## 2. The bundle, checked before the runbook

- **Targets:**
  - `dev`: `mode: development`. Resources are prefixed with the deployer's name, schedules and triggers are paused, and each engineer gets their own copy.
  - `prod`: `mode: production`, with `run_as` a service principal (by application id), so jobs don't run as the person who deployed them.
- **Variables** carry what differs per environment (catalog, schema, warehouse id). Nothing environment-specific is hard-coded in resources.
- **Permissions** in the bundle give the team's group `CAN_VIEW` or `CAN_MANAGE_RUN`. Ownership follows `run_as`.
- **No secrets:** no tokens, passwords or hosts with credentials. The runner deploys with the connection's CLI profile, and secrets that jobs need come from secret scopes.

## 3. Writing the runbook

- A `bundle` step: the bundle's folder and target. The engine dry-runs `databricks bundle validate --target <t>`, and the runner then runs `databricks bundle deploy --target <t>` with the profile.
- Table DDL the model needs before the bundle's jobs run goes into `sql` steps **before** the bundle step, with idempotent forms (`CREATE SCHEMA IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`).
- A first run right after deploying is a `cli` step `databricks jobs run-now <job-id>`, in a follow-up runbook once the deploy has given the job its id. `databricks bundle destroy` is destructive: never part of a deploy runbook.
- Production: the same bundle and steps against the production connection with `target: prod`. It needs a named approver, and never runs unattended.

## 4. After the run

- `autode_runbook_status` shows each step. When it has run, ask the person to bring the target's metadata into the estate (Ingest, or `autode estate extract` on the target connection), so reconciliation sees what was deployed.
- `autode_record_artifact` with a deployment note: bundle, target, workspace, runbook.

## Worked example (the reference problem: retail orders)

The marts schema and the fact table first, then the bundle.

```sql
CREATE SCHEMA IF NOT EXISTS retail_dev.marts;

CREATE TABLE IF NOT EXISTS retail_dev.marts.fct_orders (
  order_id BIGINT NOT NULL,
  customer_id INT,
  order_ts TIMESTAMP,
  order_date DATE,
  order_status STRING,
  shipping_amount DECIMAL(10,2),
  tax_amount DECIMAL(10,2),
  updated_at TIMESTAMP
)
CLUSTER BY (order_date);
```

```yaml bundles/retail_marts/databricks.yml
bundle:
  name: retail_marts

variables:
  catalog:
    default: retail_dev
  warehouse_id:
    description: The SQL warehouse the marts build on (per target).
  service_principal:
    description: The production service principal's application id.

resources:
  jobs:
    retail_marts_daily:
      name: retail_marts_daily
      schedule:
        quartz_cron_expression: "0 30 5 * * ?"
        timezone_id: UTC
      tasks:
        - task_key: build_marts
          sql_task:
            warehouse_id: ${var.warehouse_id}
            file:
              path: ../../marts/fct_orders.sql
      permissions:
        - group_name: data-engineers
          level: CAN_MANAGE_RUN

targets:
  dev:
    mode: development
    default: true
  prod:
    mode: production
    variables:
      catalog: retail
    run_as:
      service_principal_name: ${var.service_principal}
```

```yaml runbook
id: marts-deploy-dev
title: Deploy the retail marts to dev
reason: The model and the Pipeline Spec are approved; the deploy stage puts the marts on the dev workspace before production.
connectionId: databricks:lakehouse_dev
stage: deploy
explanation: Creates the marts schema and fct_orders as the model defines them, then deploys the retail_marts bundle to the dev target. That creates the daily job, paused in development mode.
steps:
  - id: marts-schema
    title: Schema retail_dev.marts
    kind: sql
    sql: CREATE SCHEMA IF NOT EXISTS retail_dev.marts
    expect: The schema exists.
  - id: fct-orders
    title: Table retail_dev.marts.fct_orders
    kind: sql
    sql: CREATE TABLE IF NOT EXISTS retail_dev.marts.fct_orders (order_id BIGINT NOT NULL, customer_id INT, order_ts TIMESTAMP, order_date DATE, order_status STRING, shipping_amount DECIMAL(10,2), tax_amount DECIMAL(10,2), updated_at TIMESTAMP) CLUSTER BY (order_date)
    expect: fct_orders exists with the model's columns, clustered by order_date (an existing table is left as it is).
    rollback:
      procedure: Only if this run created it, DROP TABLE retail_dev.marts.fct_orders.
  - id: deploy-bundle
    title: Deploy bundles/retail_marts to dev
    kind: bundle
    folder: bundles/retail_marts
    target: dev
    expect: bundle validate passes; deploy creates the retail_marts_daily job in the dev workspace, paused.
    timeoutSec: 900
    rollback:
      procedure: Deploy the previous commit of bundles/retail_marts the same way.
```
