---
name: autode-redshift-ingestion
description: Bring an Amazon Redshift source into AutoDE's estate (tables, columns, views, keys, row counts, through the platform's estate operations) and plan how its data leaves Redshift for a new platform (UNLOAD to S3 as Parquet); and, with Redshift as a target, land source data from S3 with COPY into raw tables that mirror the estate. Use it in source assessment when a source system is Redshift, when a modernization moves data out of it, and in build stages when the target is Redshift.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_list_connections, mcp__autode__autode_list_databases, mcp__autode__autode_list_schemas, mcp__autode__autode_extract_metadata, mcp__autode__autode_ingest_metadata, mcp__autode__autode_platform_operations, mcp__autode__autode_platform_run, mcp__autode__autode_resolve, mcp__autode__autode_record_source_context, mcp__autode__autode_record_artifact, mcp__autode__autode_check_grounding, mcp__autode__autode_explain_sql, mcp__autode__autode_propose_runbook]
metadata:
  scope: redshift
  stageKinds: [source-assessment, build]
  platforms: [redshift]
  version: 2
  owner: AutoDE
  maturity: preview
---
# Redshift as a source

Written by AutoDE from AWS's public Redshift documentation (system views, the Data API, UNLOAD). Preview: checked on recorded results, not yet on a live account. The connection itself: the `autode-redshift-deployment` skill.

## 1. Bring the estate in

- `autode_list_databases`, then `autode_list_schemas` for each database the problem uses. Ask the person which schemas matter. Don't bring in a whole cluster.
- `autode_ingest_metadata` with `DATABASE.SCHEMA` for each. It runs the platform's estate operations: `estate.list_tables` (`SVV_ALL_TABLES`: local, Spectrum external and datashare tables), `estate.list_columns` (types with their length or precision), `estate.list_views` (definitions, late-binding views included), `estate.list_primary_keys` and `estate.list_foreign_keys`, and `estate.table_stats` (row counts and sizes).
- Read the ingest's **warnings**. Each read that failed is listed with why (`Not read: estate.table_stats: … permission denied`). The others still came in. Say what is missing and which grant would fix it. Don't call the estate complete.

What the estate means on Redshift:
- **Keys are declared, not enforced.** Redshift never checks primary, unique or foreign keys. Treat them as claims: the probes (`autode_verify_assertion`, the data before any model) check them against the data.
- **External tables** (`EXTERNAL`) live in S3 through Spectrum. Their data is outside Redshift: record the S3 location as part of the source context when the person knows it.
- **Datashare tables** belong to another cluster or account. Record the producer as the source of truth, not this cluster.
- **View definitions and keys** come from the connected database only. Connect once per database for them.

## 2. Record the source context

`autode_record_source_context` for the Redshift system: the connection, the schemas in scope, what wasn't read, and the facts the person adds (load schedule, owners, what each schema holds).

## 3. Moving data out (a modernization)

When the target is another platform (Snowflake, Databricks), Redshift's data leaves through **UNLOAD** to S3, and the target loads the files (its own ingestion skill):
- `UNLOAD ('SELECT …') TO 's3://bucket/prefix/table_' IAM_ROLE '<role arn>' FORMAT AS PARQUET` writes in parallel, one or more files per slice. Parquet keeps types and needs no quoting rules.
- Add `PARTITION BY (column)` for a large table loaded by date, `MAXFILESIZE` to bound the files, and `MANIFEST` so the loader knows the full set of files.
- The IAM role is attached to the cluster or workgroup and needs write access to the bucket. Never put access keys in the statement.
- Write the plan as an artifact (`autode_record_artifact`, for example `ingestion/redshift_unload.sql` with notes): table by table, the select (columns from the estate, never `*` for a table whose columns the mapping drops), the S3 prefix and the partitioning.
- **Running it** is a change on Redshift: propose it as a runbook (one `sql` step per table, `autode_propose_runbook`); a person approves it and AutoDE's runner runs it. UNLOAD has no dry run on Redshift (its EXPLAIN doesn't compile it): the check says so.

## 4. Landing data in Redshift (a target)

- **Raw tables mirror the estate:** the source table's columns with Redshift types (`BIGINT`, `NUMERIC(p,s)`, `VARCHAR(n)` with the source's length, `TIMESTAMP`), plus `_source_file VARCHAR(1024)` and `_loaded_at TIMESTAMP DEFAULT GETDATE()`. Write a `-- lands <source table>` comment above each, so the check can compare its columns with the estate. `CREATE TABLE IF NOT EXISTS`.
- **Load with COPY** from S3: `COPY raw.orders FROM 's3://…/orders/' IAM_ROLE '<role arn>' FORMAT AS PARQUET` (or `CSV IGNOREHEADER 1`), a `MANIFEST` for an exact file set. The role is attached to the cluster or workgroup; never put keys in the statement.
- **Reloads duplicate:** unlike Snowflake, COPY doesn't remember which files it loaded. Load into a staging table, then `MERGE` into the raw table on the key (the `incremental_load` primitive), or load each batch's files by manifest exactly once and say so in the runbook.
- **Errors:** `MAXERROR 0` unless the quality rules allow skipping rows; `STL_LOAD_ERRORS` (or `SYS_LOAD_ERROR_DETAIL`) says which rows failed.
- Propose the landing tables and loads as a runbook (the `autode-redshift-deployment` skill: order and what the dry run checks).

## Worked example (orders and customers)

The estate came in for `dev.sales`: `orders` (1.2 million rows, `KEY(customer_id)`), `customers`, and the view `v_open_orders`. `estate.table_stats` was not read (the user has no access to `SVV_TABLE_INFO`), so the row counts are missing; the ingest's warning says so.

The modernization plan unloads `orders` by month:

```sql
UNLOAD ('SELECT order_id, customer_id, order_date, status, amount FROM sales.orders')
TO 's3://retail-migration/redshift/sales/orders/'
IAM_ROLE 'arn:aws:iam::123456789012:role/redshift-unload'
FORMAT AS PARQUET
PARTITION BY (order_date)
MAXFILESIZE 256 MB
MANIFEST;
```
