---
name: autode-snowflake-deployment
description: Deploy an AutoDE business problem's approved deliverables to Snowflake through runbooks - idempotent DDL in dependency order, a zero-copy clone before any change that loses data, dbt projects with the Snowflake CLI, dev first and then production under a named approver - and bring the deployed objects back into the estate. Use it in the deploy stage when the target platform is Snowflake.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_connections, mcp__autode__autode_check_grounding, mcp__autode__autode_explain_sql, mcp__autode__autode_propose_runbook, mcp__autode__autode_runbook_status, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: snowflake
  stageKinds: [deploy]
  platforms: [snowflake]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Snowflake deployment

Written by AutoDE from Snowflake's public documentation (DDL, cloning, Snowflake CLI). The deploy stage is done when its runbook has run successfully. You write the runbook; a person approves it; AutoDE's runner runs it. You never run `snow` or SQL that changes the platform yourself. In hosts with AutoDE's plugin, a hook blocks it.

## 1. What to deploy

- The build stage's recorded artifacts (`autode_get_context_pack`, purpose `plan`): the DDL AutoDE rendered from the model, the pipeline SQL, a dbt project.
- Only **approved** deliverables. If the Pipeline Spec or the model isn't approved, say so and stop.
- The target connection from the target context. One connection per environment; the team's policy (`.autode/config/approvals.yaml`) says which is production.

## 2. Writing the runbook

- **Order:** schemas, then tables, views and dynamic tables, then streams and tasks, then grants. Resume tasks last.
- **Idempotent statements:**
  - `CREATE SCHEMA IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`;
  - `CREATE OR ALTER TABLE` / `VIEW` to change an existing object's definition without dropping it;
  - `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for an additive change.
- **A change that can lose data** (`CREATE OR REPLACE TABLE`, dropping or narrowing a column) is destructive. First add a step `CREATE TABLE <t>_bak_<yyyymmdd> CLONE <t>` (a zero-copy clone, instant and cheap). Give the destructive step a rollback that restores from the clone, or that uses `UNDROP` within the time-travel retention.
- **dbt projects:** `cli` steps with the Snowflake CLI's dbt commands: `snow dbt deploy <name> --source <folder>`, then `snow dbt execute <name> run`. The runner adds the connection; never put `--connection`, a password or a key in a runbook. Check the commands against the team's CLI version (`snow dbt --help`).
- **Snowpark, Streamlit or other `snow` commands** aren't on AutoDE's allowlist. The team adds them to `runbooks.allowCommands` in its policy after reviewing them; until then, say they are missing.

## 3. Environments

- Propose the runbook against **dev** first. After it has run, propose the same steps against the production connection. Production needs a named approver, and never runs unattended (the runbook wizard runs it step by step).
- Never edit an approved runbook: an edit voids its approval. Propose a new revision.

## 4. After the run

- `autode_runbook_status` shows each step's state. When it has run, ask the person to bring the target's metadata into the estate (Ingest, or `autode estate extract` on the target connection), so reconciliation and grounding see what was deployed.
- `autode_record_artifact` with a deployment note: what was deployed, where, by which runbook.

## Worked example (the reference problem: retail orders)

The first deployment of the marts to dev, then the dbt project.

```sql
CREATE SCHEMA IF NOT EXISTS marts;

CREATE TABLE IF NOT EXISTS marts.fct_orders (
  order_id NUMBER(38,0) NOT NULL,
  customer_id NUMBER(38,0),
  order_ts TIMESTAMP_NTZ,
  order_date DATE,
  order_status VARCHAR(20),
  shipping_amount NUMBER(10,2),
  tax_amount NUMBER(10,2),
  updated_at TIMESTAMP_NTZ,
  CONSTRAINT pk_fct_orders PRIMARY KEY (order_id)
);

CREATE TABLE IF NOT EXISTS marts.fct_orders_bak_20261023 CLONE marts.fct_orders;
```

```yaml runbook
id: marts-deploy-dev
title: Deploy the retail marts to dev
reason: The model, Pipeline Spec and dbt project are approved; the deploy stage puts them on the dev connection before production.
connectionId: snowflake:analytics_dev
stage: deploy
explanation: Creates the marts schema and fct_orders as the model's DDL defines it, keeps a clone of fct_orders as it was before the dbt run, then deploys and runs the dbt project.
steps:
  - id: marts-schema
    title: Schema marts
    kind: sql
    sql: CREATE SCHEMA IF NOT EXISTS marts
    expect: The schema exists.
  - id: fct-orders
    title: Table marts.fct_orders
    kind: sql
    sql: CREATE TABLE IF NOT EXISTS marts.fct_orders (order_id NUMBER(38,0) NOT NULL, customer_id NUMBER(38,0), order_ts TIMESTAMP_NTZ, order_date DATE, order_status VARCHAR(20), shipping_amount NUMBER(10,2), tax_amount NUMBER(10,2), updated_at TIMESTAMP_NTZ, CONSTRAINT pk_fct_orders PRIMARY KEY (order_id))
    expect: fct_orders exists with the model's columns (an existing table is left as it is).
    rollback:
      procedure: Only if this run created it, DROP TABLE marts.fct_orders.
  - id: backup-fct-orders
    title: Clone fct_orders before the dbt run
    kind: sql
    sql: CREATE TABLE IF NOT EXISTS marts.fct_orders_bak_20261023 CLONE marts.fct_orders
    expect: A zero-copy clone holds fct_orders as it was.
    rollback:
      steps:
        - id: drop-backup
          title: Drop the clone
          kind: sql
          sql: DROP TABLE IF EXISTS marts.fct_orders_bak_20261023
          expect: The clone is gone.
  - id: dbt-deploy
    title: Deploy the dbt project
    kind: cli
    argv: [snow, dbt, deploy, retail_orders, --source, dbt/retail_orders]
    expect: The dbt project object retail_orders exists in Snowflake with this version of the project.
    timeoutSec: 600
    rollback:
      procedure: Deploy the previous version of dbt/retail_orders from source control the same way.
  - id: dbt-run
    title: Run the dbt project
    kind: cli
    argv: [snow, dbt, execute, retail_orders, run]
    expect: Every model builds; the run's log shows no errors.
    timeoutSec: 3600
    rollback:
      procedure: Restore marts.fct_orders from marts.fct_orders_bak_20261023 (CREATE OR REPLACE TABLE marts.fct_orders CLONE marts.fct_orders_bak_20261023), as a separate runbook.
```
