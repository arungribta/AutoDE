---
name: autode-snowflake-ingestion
description: Land an AutoDE business problem's source data in Snowflake - file formats, stages on a storage integration, raw landing tables that mirror the estate, COPY INTO for batch loads and Snowpipe for files that keep arriving - as a runbook a person approves. Use it in build and platform-setup stages when the target platform is Snowflake.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_list_connections, mcp__autode__autode_check_grounding, mcp__autode__autode_explain_sql, mcp__autode__autode_propose_runbook, mcp__autode__autode_runbook_status, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: snowflake
  stageKinds: [build, platform-setup]
  platforms: [snowflake]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Snowflake ingestion

Written by AutoDE from Snowflake's public documentation (COPY INTO, stages, file formats, Snowpipe). It does not need any Snowflake or Cortex Code skill.

## 1. What to land, and how it arrives

- `autode_get_context_pack` (purpose `plan`) gives the source context: each source system, and whether it is a connection, files or described only.
- `autode_resolve` each source table the mapping uses. A landing table mirrors the estate's columns and types; never guess a column.
- Pick the pattern by how the data arrives:
  - **Files in cloud storage, on a schedule:** an external stage and `COPY INTO`, run by a task or the orchestrator.
  - **Files that arrive continuously:** a pipe with `AUTO_INGEST = TRUE` (Snowpipe), fed by the bucket's event notifications.
  - **A database source (no files):** this skill doesn't apply. A replication tool or connector lands it, and that is a decision for the stakeholder. Record it as a gap in your notes.

## 2. The objects, in order

1. **Storage integration:** created once by an account administrator (`CREATE STORAGE INTEGRATION` needs `ACCOUNTADMIN` or the `CREATE INTEGRATION` privilege). It belongs to the platform-setup stage. A stage never carries keys or credentials: it names the integration.
2. **File format:** type, header, quoting, `NULL_IF`. One per file shape, reused.
3. **Stage:** the bucket path, the integration and the file format.
4. **Landing table** in a `raw` schema: the source table's columns with Snowflake types (`NUMBER`, `VARCHAR`, `TIMESTAMP_NTZ` …), plus `_source_file` and `_loaded_at`. Write a `-- lands <source table>` comment right above it, so the check can compare its columns with the estate.
5. **Load:** `COPY INTO` with a column list from `SELECT $1, $2 …` (CSV) or `MATCH_BY_COLUMN_NAME = CASE_INSENSITIVE` (Parquet), `METADATA$FILENAME` into `_source_file`, and `ON_ERROR = ABORT_STATEMENT` unless the quality rules allow skipping rows.
6. **Continuous files:** `CREATE PIPE … AUTO_INGEST = TRUE AS COPY INTO …`, with the same statement as step 5.

Rules:
- **Idempotent forms only.** Use `CREATE … IF NOT EXISTS`. `CREATE OR REPLACE` drops the object, and AutoDE classifies it as destructive.
- **Reloads:** `COPY INTO` remembers loaded files for 64 days and skips them, so a re-run doesn't duplicate rows. Never add `FORCE = TRUE`: it loads the same files again.
- **Dry run:** EXPLAIN doesn't cover DDL or COPY. For a CSV load without a transformation, say in the runbook that `VALIDATION_MODE = RETURN_ERRORS` can check the files first.

## 3. Check, then propose the runbook

- `autode_check_grounding` on the SQL: every table it reads is in the estate or created by the runbook.
- `autode_propose_runbook` on the target connection with the stage's id: one `sql` step per statement, in the order above. Give each `expect`, and a rollback for each created object (`DROP … IF EXISTS`). The engine classifies every step; a person approves the runbook; AutoDE's runner runs it. Never run `snow` yourself.
- `autode_record_artifact` with the SQL as files (for example `ingestion/shop_orders.sql`) and your notes: patterns chosen, gaps (no storage integration yet, a database source).

## Worked example (the reference problem: retail orders)

`shop.orders` is exported daily as CSV files to `s3://retail-landing/shop/orders/`.

```sql
CREATE FILE FORMAT IF NOT EXISTS raw.csv_with_header
  TYPE = CSV
  SKIP_HEADER = 1
  FIELD_OPTIONALLY_ENCLOSED_BY = '"'
  NULL_IF = ('', 'NULL')
  EMPTY_FIELD_AS_NULL = TRUE;

CREATE STAGE IF NOT EXISTS raw.shop_landing
  URL = 's3://retail-landing/shop/'
  STORAGE_INTEGRATION = retail_landing_int
  FILE_FORMAT = raw.csv_with_header;

-- lands shop.orders
CREATE TABLE IF NOT EXISTS raw.shop_orders_raw (
  order_id NUMBER(38,0),
  customer_id NUMBER(38,0),
  order_ts TIMESTAMP_NTZ,
  status VARCHAR(20),
  channel VARCHAR(20),
  currency VARCHAR(3),
  promotion_id NUMBER(38,0),
  shipping_amount NUMBER(10,2),
  tax_amount NUMBER(10,2),
  updated_at TIMESTAMP_NTZ,
  _source_file VARCHAR,
  _loaded_at TIMESTAMP_LTZ
);

COPY INTO raw.shop_orders_raw
FROM (
  SELECT s.$1, s.$2, s.$3, s.$4, s.$5, s.$6, s.$7, s.$8, s.$9, s.$10, METADATA$FILENAME, CURRENT_TIMESTAMP()
  FROM @raw.shop_landing/orders/ s
)
PATTERN = '.*orders_.*[.]csv'
ON_ERROR = ABORT_STATEMENT;
```

The runbook (the storage integration already exists; it was the platform-setup stage's):

```yaml runbook
id: shop-orders-landing
title: Land shop orders from S3 in RAW
reason: The build stage needs shop.orders in Snowflake; the shop exports it daily as CSV to s3://retail-landing/shop/orders/.
connectionId: snowflake:analytics_dev
stage: build
explanation: Creates the CSV file format, the stage on the existing storage integration and the landing table, then loads the files already there. Re-running it loads only new files.
steps:
  - id: file-format
    title: CSV file format
    kind: sql
    sql: CREATE FILE FORMAT IF NOT EXISTS raw.csv_with_header TYPE = CSV SKIP_HEADER = 1 FIELD_OPTIONALLY_ENCLOSED_BY = '"' NULL_IF = ('', 'NULL') EMPTY_FIELD_AS_NULL = TRUE
    expect: The file format raw.csv_with_header exists.
    rollback:
      steps:
        - id: drop-file-format
          title: Drop the file format
          kind: sql
          sql: DROP FILE FORMAT IF EXISTS raw.csv_with_header
          expect: The file format is gone.
  - id: stage
    title: Stage on the landing bucket
    kind: sql
    sql: CREATE STAGE IF NOT EXISTS raw.shop_landing URL = 's3://retail-landing/shop/' STORAGE_INTEGRATION = retail_landing_int FILE_FORMAT = raw.csv_with_header
    expect: The stage raw.shop_landing lists the shop's files.
    rollback:
      procedure: DROP STAGE IF EXISTS raw.shop_landing (the files in the bucket are not touched).
  - id: landing-table
    title: Landing table for shop orders
    kind: sql
    sql: CREATE TABLE IF NOT EXISTS raw.shop_orders_raw (order_id NUMBER(38,0), customer_id NUMBER(38,0), order_ts TIMESTAMP_NTZ, status VARCHAR(20), channel VARCHAR(20), currency VARCHAR(3), promotion_id NUMBER(38,0), shipping_amount NUMBER(10,2), tax_amount NUMBER(10,2), updated_at TIMESTAMP_NTZ, _source_file VARCHAR, _loaded_at TIMESTAMP_LTZ)
    expect: An empty table with the columns of shop.orders plus the two load columns.
    rollback:
      procedure: DROP TABLE IF EXISTS raw.shop_orders_raw, only while it holds no loaded data.
  - id: first-load
    title: Load the files already in the bucket
    kind: sql
    sql: COPY INTO raw.shop_orders_raw FROM (SELECT s.$1, s.$2, s.$3, s.$4, s.$5, s.$6, s.$7, s.$8, s.$9, s.$10, METADATA$FILENAME, CURRENT_TIMESTAMP() FROM @raw.shop_landing/orders/ s) PATTERN = '.*orders_.*[.]csv' ON_ERROR = ABORT_STATEMENT
    expect: One result row per file, each LOADED; the row count matches the files' rows.
    timeoutSec: 1800
    rollback:
      procedure: Nothing is loaded when a file fails (ABORT_STATEMENT). To undo a load, a person truncates raw.shop_orders_raw, and COPY then needs FORCE for those files.
```
