---
name: autode-redshift-pipelines
description: Find the pipelines living inside an Amazon Redshift source - stored procedures, materialized views and their refresh, views that encode business logic (the pipelines.list_procedures, pipelines.materialized_views and estate.list_views operations) - and hand them to code conversion and mapping. Building pipelines on Redshift comes in v0.55.2. Use it in source assessment and code conversion when a source is Redshift.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_connections, mcp__autode__autode_platform_operations, mcp__autode__autode_platform_run, mcp__autode__autode_record_artifact, mcp__autode__autode_record_source_context, mcp__autode__autode_record_assumption]
metadata:
  scope: redshift
  stageKinds: [source-assessment, code-conversion]
  platforms: [redshift]
  version: 1
  owner: AutoDE
  maturity: preview
---
# Pipelines inside Redshift

Written by AutoDE from AWS's public Redshift documentation (stored procedures, materialized views). Preview: checked on recorded results, not yet on a live account.

A Redshift estate often holds its transformations inside the database. A modernization has to find them all, or the new platform quietly loses logic.

## 1. Find them

On the Redshift connection, for each schema in scope (`etl`, `stage` and the like matter most):
- `autode_platform_run` with `pipelines.list_procedures`: each stored procedure's arguments and body (PL/pgSQL). Procedures that INSERT, DELETE or MERGE into tables are loads.
- `autode_platform_run` with `pipelines.materialized_views`: each materialized view, whether it refreshes automatically, whether it is stale. Their SQL is in the estate's views (`estate.list_views`).
- The views themselves (`estate.list_views`, already in the estate after ingestion): views with joins, aggregations or CASE logic are business rules.

What runs them is usually **outside** Redshift: scheduled queries (Amazon EventBridge), AWS Glue or Step Functions, Airflow, cron. Ask the person what schedules each procedure and record the answer (`autode_record_assumption` until it is confirmed). Without the schedule, a converted pipeline doesn't know when to run.

## 2. Hand them on

- **Code conversion:** record each procedure and each logic-bearing view as an artifact (`autode_record_artifact`, for example `legacy/redshift/etl.load_orders.sql`) with what it reads and writes. Code conversion takes them from there. Redshift-specific SQL to flag as you go: `DISTKEY`/`SORTKEY` in DDL (physical design, not logic), `IDENTITY` columns, `SUPER` and PartiQL navigation, `LISTAGG`, `GETDATE()`, and `DELETE … USING` joins.
- **Mapping:** a procedure's INSERT … SELECT is a source-to-target mapping in code form. Use it as evidence for the mapping stage; never as the mapping itself until a person confirms it.
- **Materialized views** that refresh automatically become, on the target, a dynamic table (Snowflake) or a materialized view or streaming table (Databricks). Note the refresh need.

## 3. Record the source context

`autode_record_source_context`: the procedures and materialized views found, what schedules them, and the gaps (schemas not read, schedules unknown).

## Building on Redshift

Pipelines compiled to Redshift's SQL dialect and created on Redshift through runbooks come with Redshift as a target (v0.55.2, platform-operations §6.2b).
