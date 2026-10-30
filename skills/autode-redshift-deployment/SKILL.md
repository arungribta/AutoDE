---
name: autode-redshift-deployment
description: Reach Amazon Redshift from AutoDE - install the AWS CLI, choose a sign-in (a Secrets Manager secret, IAM temporary credentials or your AWS identity on Serverless), save and check the connection, grant AutoDE's reads, and troubleshoot - and deploy a problem's approved deliverables to it through runbooks (idempotent DDL in order, what a dry run can and can't check, a snapshot before data-losing changes, dev then production). Use it when a business problem connects a Redshift source or target, and in deploy stages on Redshift.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_list_connections, mcp__autode__autode_test_connection, mcp__autode__autode_propose_connection, mcp__autode__autode_platform_operations, mcp__autode__autode_platform_run, mcp__autode__autode_list_databases, mcp__autode__autode_list_schemas, mcp__autode__autode_workflow_status, mcp__autode__autode_compile_pipeline_spec, mcp__autode__autode_check_grounding, mcp__autode__autode_explain_sql, mcp__autode__autode_propose_runbook, mcp__autode__autode_runbook_status, mcp__autode__autode_record_artifact]
metadata:
  scope: redshift
  stageKinds: [platform-setup, source-assessment, target-context, deploy]
  platforms: [redshift]
  version: 2
  owner: AutoDE
  maturity: preview
---
# Reaching Redshift

Written by AutoDE from AWS's public documentation of the Redshift Data API and the AWS CLI. Preview: checked on recorded results, not yet on a live account.

AutoDE has no Redshift driver and no Redshift code. It runs each statement through the AWS CLI's Redshift Data API commands (`aws redshift-data`): it submits the statement, waits for it to finish, and fetches the result page by page. All of this is described in `platforms/redshift.yaml`. `autode_platform_operations` with `platform: redshift` lists what it can read.

## 1. The AWS CLI

- AutoDE needs the **AWS CLI version 2** (`aws --version` says `aws-cli/2…`). Version 1 isn't supported.
- If it's missing, the settings card's *Check prerequisites* shows the install options for this machine (WinGet, Homebrew) and the vendor's page. Never install it yourself: the person clicks Install.
- AutoDE runs the CLI only with the person's consent: the `autoDataEngineeringHub.dataPlatformCliConsent` setting in VS Code, or `--allow-cli` for the MCP server and the `autode` CLI.

## 2. Choose a sign-in

The Data API takes no plain database password. Ask the person which of these their team uses, in this order of preference:

| Sign-in | Fields | When |
|---|---|---|
| **Secrets Manager secret** (recommended) | Secrets Manager secret ARN, plus a workgroup or a cluster | The database user's password lives in AWS Secrets Manager. AutoDE passes only the ARN, so it holds no Redshift secret. |
| **IAM temporary credentials** | Provisioned cluster, database user | Redshift issues a short-lived password for the user. The AWS identity needs `redshift:GetClusterCredentials`. |
| **Your AWS identity** | Serverless workgroup | Redshift Serverless signs the person in as the database user mapped to their IAM identity. |

The AWS identity itself comes from:
- **an AWS CLI profile** (`aws configure sso`, or `aws configure`). This is preferred: AutoDE names the profile and stores nothing;
- or, where there is no profile (CI), access keys that AutoDE passes to the CLI in its environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`), never as arguments. In VS Code they go to its secret storage; elsewhere set `AUTODE_REDSHIFT[_<REF>]_ACCESS_KEY_ID` and the like.

Always give exactly one of a **Serverless workgroup** or a **provisioned cluster**, and the **database**. The region defaults to the profile's.

## 3. Save and check the connection

- **In VS Code:** the Redshift card under *Source* or *Target* in Settings → *Save and connect*. It checks the connection (it reads Redshift's version) and saves it only if it connects.
- **In a terminal:** `autode connections add --platform redshift --allow-cli`. It lists the AWS profiles to pick from and tests before it saves.
- **From an agent:** `autode_propose_connection` with the fields above and `credentials: { resolver: cli, ref: <profile> }`. A person approves it.

The connection is named after the workgroup or cluster (`redshift:<name>`). Its non-secret fields go to `.autode/config/connections.yaml`, and the database user and profile to the person's `.autode/local/connections.yaml`.

## 4. What AutoDE's reads need

AutoDE only reads, through the operations in the platform definition's capability map:
- **Estate** (`estate.list_tables`, `estate.list_columns`, `estate.list_views`, keys): `USAGE` on the schemas and `SELECT` on their tables. `SVV_ALL_TABLES` and `SVV_ALL_COLUMNS` list only what the user can access, so missing tables usually mean missing grants.
- **Row counts** (`estate.table_stats`) come from `SVV_TABLE_INFO`, which shows a regular user only some tables. Without them the tables still come in, and the ingest says what wasn't read.
- **View definitions and keys** are read for the connected database only. Connect once per database you need them for.

## 5. Troubleshooting

| What you see | What it means |
|---|---|
| *needs exactly one of Serverless workgroup or Provisioned cluster* | Give one, not both. |
| *The statement failed: … permission denied* | The database user lacks the grant named. The other reads still ran: say which grant is missing. |
| *ExpiredToken*, *The SSO session … has expired* | Ask the person to run `aws sso login --profile <profile>`, then check again. |
| *AccessDeniedException … redshift-data* | The AWS identity may not call the Data API (`redshift-data:ExecuteStatement` and the describe and get calls), or `secretsmanager:GetSecretValue` on the secret. |
| *The CLI couldn't start*, *not found* | The AWS CLI version 2 isn't installed or isn't on PATH: *Check prerequisites*. |
| *didn't finish within …s; it was cancelled* | A slow statement. Data API statements can queue behind the workload's queries: try again, or read fewer schemas at a time. |

## Deploying to Redshift

AutoDE deploys to Redshift the way it deploys anywhere: the approved deliverables become a runbook, the engine classifies every step, a person approves it, and AutoDE's runner runs it on the Redshift connection (each statement through the Data API, its error read back if it fails).

1. **What to deploy:** `autode_compile_pipeline_spec` with dialect `redshift` gives each entity's SQL; the target context names the schemas per layer. Check it with `autode_check_grounding`.
2. **Idempotent statements only:**
   - `CREATE SCHEMA IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE VIEW`.
   - Redshift has no `CREATE OR REPLACE TABLE`: the compiled SQL drops and recreates a table it rebuilds (`DROP TABLE IF EXISTS`, then `CREATE TABLE … AS`), which AutoDE classifies as destructive. It needs a rollback or a reason.
   - Views over tables that get rebuilt: add `WITH NO SCHEMA BINDING` (a late-binding view), so dropping the table doesn't break or drop the view.
3. **Order:** schemas, then tables, then views and materialized views, then grants (the `autode-redshift-governance` skill), then loads.
4. **What the dry run checks:** Redshift's EXPLAIN compiles `SELECT`, `INSERT`, `UPDATE` and `DELETE` only. A DDL or `MERGE` step gets no dry run, and the runbook check says so: tell the approver those steps are reviewed from their statement, and keep them small.
5. **Before a data-losing change:** a manual snapshot of the cluster or the Serverless namespace is the rollback. Taking it is an AWS console or CLI action outside the database: put it in the step's rollback as a procedure (`rollback.procedure`: "restore table X from snapshot Y"), and ask the person to take the snapshot before approving.
6. **Environments:** a dev and a prod connection (two workgroups or two databases); the runbook for dev first, then the same runbook for prod once dev ran clean.
7. `autode_propose_runbook` on the target connection, one `sql` step per statement, each with `expect`; `autode_runbook_status` to follow it. Never run the AWS CLI yourself.
