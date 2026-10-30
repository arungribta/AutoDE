---
name: autode-redshift-deployment
description: Reach Amazon Redshift from AutoDE - install the AWS CLI, choose a sign-in (a Secrets Manager secret, IAM temporary credentials or your AWS identity on Serverless), save and check the connection, grant AutoDE's reads, and troubleshoot. Deploying deliverables to Redshift comes with Redshift as a target (v0.55.2). Use it when a business problem connects a Redshift source or target.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_list_connections, mcp__autode__autode_test_connection, mcp__autode__autode_propose_connection, mcp__autode__autode_platform_operations, mcp__autode__autode_platform_run, mcp__autode__autode_list_databases, mcp__autode__autode_list_schemas, mcp__autode__autode_workflow_status]
metadata:
  scope: redshift
  stageKinds: [platform-setup, source-assessment, target-context]
  platforms: [redshift]
  version: 1
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

Building for Redshift (its SQL dialect, deploying deliverables through runbooks, governance changes) comes with Redshift as a target in v0.55.2 (platform-operations §6.2b). Until then, a Redshift **target** can be connected and read (its estate and existing objects for the target context), but don't propose runbooks that create objects on it: say that it is planned.
