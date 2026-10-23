---
name: autode-databricks-ingestion
description: Land an AutoDE business problem's source data in Databricks - Unity Catalog volumes or external locations, raw Delta landing tables that mirror the estate, idempotent COPY INTO for batch files and Auto Loader (read_files in a streaming table) for files that keep arriving - as a runbook a person approves. Use it in build and platform-setup stages when the target platform is Databricks.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_list_connections, mcp__autode__autode_check_grounding, mcp__autode__autode_explain_sql, mcp__autode__autode_propose_runbook, mcp__autode__autode_runbook_status, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: databricks
  stageKinds: [build, platform-setup]
  platforms: [databricks]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Databricks ingestion

Written by AutoDE from Databricks' public documentation (Unity Catalog volumes and external locations, COPY INTO, Auto Loader, `read_files`). It works with no Databricks agent skill installed. When `databricks-lakeflow-connect` is installed and the source is a SaaS application or a database, that managed connector may suit better: say so as a choice for the stakeholder.

## 1. What to land, and how it arrives

- `autode_get_context_pack` (purpose `plan`) gives the source context. `autode_resolve` each source table: a landing table mirrors the estate's columns. Never guess a column.
- Pick the pattern:
  - **Files dropped in batches** (a daily export): `COPY INTO` a Delta table. It is idempotent: files already loaded are skipped.
  - **Files that keep arriving, or millions of them:** Auto Loader. In SQL, that is a streaming table over `STREAM read_files(…)`, which tracks files incrementally and handles schema evolution.
  - **A database or SaaS source:** Lakeflow Connect or the team's replication tool, not this skill. Record it as a gap or a choice.

## 2. The objects, in order

1. **Storage access:** a Unity Catalog **volume** (`/Volumes/<catalog>/<schema>/<volume>/…`) or an **external location** on a storage credential. Creating a storage credential or an external location needs metastore-level privileges: that is the platform-setup stage, for an administrator. Never put keys in a path, an option or a runbook.
2. **Schemas:** `<catalog>.raw` for landing, created with `IF NOT EXISTS`.
3. **Landing table:** Delta (the default), the source columns with Databricks types (`BIGINT`, `STRING`, `DECIMAL(10,2)`, `TIMESTAMP` …), plus `_source_file` and `_loaded_at`. Write `-- lands <source table>` right above it, so the check can compare its columns with the estate.
4. **Load:** `COPY INTO … FROM (SELECT … FROM '<path>')` with explicit casts, `_metadata.file_path` into `_source_file`, `FILEFORMAT`, `FORMAT_OPTIONS` and `PATTERN`. Keep `COPY_OPTIONS ('mergeSchema' = 'false')` unless the stakeholder accepts new columns arriving on their own.

Rules:
- Three-part names (`catalog.schema.table`) everywhere. The catalog differs per environment, so name it in the runbook.
- `CREATE TABLE IF NOT EXISTS`, never `CREATE OR REPLACE TABLE` (destructive: it replaces the data).
- Re-running `COPY INTO` doesn't load the same files twice. `'force' = 'true'` does: never use it.

## 3. Check, then propose the runbook

- `autode_check_grounding` on the SQL; `autode_explain_sql` on the `SELECT` inside the load when a connection is available.
- `autode_propose_runbook` on the target connection: one `sql` step per statement, with `expect`, and rollbacks (`DROP TABLE IF EXISTS` for a table this run created). The engine classifies each step; a person approves; AutoDE's runner runs it. Never run `databricks` yourself.
- `autode_record_artifact`: the SQL (`ingestion/shop_orders.sql`) and notes (pattern, storage access needed, gaps).

## Worked example (the reference problem: retail orders)

The shop's daily CSV export of orders lands in the volume `/Volumes/retail_dev/landing/shop/orders/`.

```sql
CREATE SCHEMA IF NOT EXISTS retail_dev.raw;

-- lands shop.orders
CREATE TABLE IF NOT EXISTS retail_dev.raw.shop_orders_raw (
  order_id BIGINT,
  customer_id INT,
  order_ts TIMESTAMP,
  status STRING,
  channel STRING,
  currency STRING,
  promotion_id INT,
  shipping_amount DECIMAL(10,2),
  tax_amount DECIMAL(10,2),
  updated_at TIMESTAMP,
  _source_file STRING,
  _loaded_at TIMESTAMP
);

COPY INTO retail_dev.raw.shop_orders_raw
FROM (
  SELECT
    CAST(order_id AS BIGINT) AS order_id,
    CAST(customer_id AS INT) AS customer_id,
    CAST(order_ts AS TIMESTAMP) AS order_ts,
    status,
    channel,
    currency,
    CAST(promotion_id AS INT) AS promotion_id,
    CAST(shipping_amount AS DECIMAL(10,2)) AS shipping_amount,
    CAST(tax_amount AS DECIMAL(10,2)) AS tax_amount,
    CAST(updated_at AS TIMESTAMP) AS updated_at,
    _metadata.file_path AS _source_file,
    current_timestamp() AS _loaded_at
  FROM '/Volumes/retail_dev/landing/shop/orders/'
)
FILEFORMAT = CSV
PATTERN = 'orders_*.csv'
FORMAT_OPTIONS ('header' = 'true')
COPY_OPTIONS ('mergeSchema' = 'false');
```

When files arrive all day, a streaming table with Auto Loader replaces the `COPY INTO`, in a Lakeflow pipeline (see `autode-databricks-pipelines`):

```sql
CREATE OR REFRESH STREAMING TABLE shop_orders_stream
AS SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _loaded_at
FROM STREAM read_files('/Volumes/retail_dev/landing/shop/orders/', format => 'csv', header => true);
```

```yaml runbook
id: shop-orders-landing
title: Land shop orders from the landing volume in raw
reason: The build stage needs shop.orders in Databricks; the shop exports it daily as CSV to /Volumes/retail_dev/landing/shop/orders/.
connectionId: databricks:lakehouse_dev
stage: build
explanation: Creates the raw schema and a Delta landing table with the columns of shop.orders, then loads the files already in the volume. Re-running it loads only new files.
steps:
  - id: raw-schema
    title: Schema retail_dev.raw
    kind: sql
    sql: CREATE SCHEMA IF NOT EXISTS retail_dev.raw
    expect: The schema exists.
  - id: landing-table
    title: Landing table for shop orders
    kind: sql
    sql: CREATE TABLE IF NOT EXISTS retail_dev.raw.shop_orders_raw (order_id BIGINT, customer_id INT, order_ts TIMESTAMP, status STRING, channel STRING, currency STRING, promotion_id INT, shipping_amount DECIMAL(10,2), tax_amount DECIMAL(10,2), updated_at TIMESTAMP, _source_file STRING, _loaded_at TIMESTAMP)
    expect: An empty Delta table with the columns of shop.orders plus the two load columns.
    rollback:
      procedure: DROP TABLE IF EXISTS retail_dev.raw.shop_orders_raw, only while it holds no loaded data.
  - id: first-load
    title: Load the files already in the volume
    kind: sql
    sql: "COPY INTO retail_dev.raw.shop_orders_raw FROM (SELECT CAST(order_id AS BIGINT) AS order_id, CAST(customer_id AS INT) AS customer_id, CAST(order_ts AS TIMESTAMP) AS order_ts, status, channel, currency, CAST(promotion_id AS INT) AS promotion_id, CAST(shipping_amount AS DECIMAL(10,2)) AS shipping_amount, CAST(tax_amount AS DECIMAL(10,2)) AS tax_amount, CAST(updated_at AS TIMESTAMP) AS updated_at, _metadata.file_path AS _source_file, current_timestamp() AS _loaded_at FROM '/Volumes/retail_dev/landing/shop/orders/') FILEFORMAT = CSV PATTERN = 'orders_*.csv' FORMAT_OPTIONS ('header' = 'true') COPY_OPTIONS ('mergeSchema' = 'false')"
    expect: num_affected_rows equals the rows in the new files.
    timeoutSec: 1800
    rollback:
      procedure: A person deletes the loaded rows by _source_file (DELETE FROM retail_dev.raw.shop_orders_raw WHERE _source_file IN (…)); COPY INTO then needs force for those files.
```
