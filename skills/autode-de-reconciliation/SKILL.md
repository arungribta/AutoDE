---
name: autode-de-reconciliation
description: Reconcile an AutoDE business problem's targets with their sources, read-only - row counts, distinct keys, per-column sums, ranges, distinct and null counts, key hashes on one platform and missing keys on one connection - from queries AutoDE generates, judged against the quality rules' tolerances, into a reconciliation report. Use it for the reconcile stage of an AutoDE workflow.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_list_connections, mcp__autode__autode_reconcile_plan, mcp__autode__autode_execute_query, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: de
  stageKinds: [reconcile]
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Reconciliation

Reconciliation proves the target holds what the source says it should, and nothing more. It only reads: aggregates, never rows. It never fixes data. Differences go into the report with their likely causes, and a person decides.

## 1. What to reconcile

- `autode_get_context_pack` (purpose `plan`) gives the approved mapping: each source table and its target.
- **Keys** come from confirmed key facts (`autode_list_assertions`, kind `key`). Without a confirmed key, only row counts can be compared. Say so; don't pick a key yourself.
- **Tolerances** come from the quality rules (reconciliation tolerances). With none, the rule is *equal*. Never invent one.
- **The target must be in the estate:** after deployment, a person brings the target's metadata in. `autode_reconcile_plan` says when it isn't.

## 2. The queries: generated, not written

For each mapped pair, call `autode_reconcile_plan` with:
- `source`, `target` and `keys`;
- `sourcePlatform`, which decides the SQL functions;
- `sourceWhere` and `targetWhere` when the load covers a window (for example the last day's changes);
- `sameConnection: true` when both tables are reachable through one connection.

It returns:
- one aggregate query per side: row count, distinct keys, key nulls, and per mapped column a sum (numbers), min and max (dates), a distinct count (text) and a null count;
- a key hash when both sides are Snowflake, or both Databricks;
- missing-key counts on one connection;
- the comparisons to make, each `equal`, `zero` or `within-tolerance`.

Run each query **as given** with `autode_execute_query` on its side's connection. Don't edit the generated SQL. If it doesn't fit, say why in the report.

## 3. Judge and report

- Compare every metric by its rule. A sum `within-tolerance` uses the quality rules' tolerance. A type change between source and target (a cast or a trim) can move sums and distinct counts slightly: the plan's notes say when.
- For each difference, give the likely causes, in this order:
  1. a filter or load window that differs;
  2. late-arriving data;
  3. deduplication (the target keeps one row per key: compare the source's distinct keys, not its rows);
  4. history (an SCD type 2 target has several rows per key: compare current rows);
  5. a mapping error.
  Name the evidence that would tell them apart.
- `autode_record_artifact` with `reconciliation/report.md`. One table per pair: metric, source value, target value, rule, verdict (✓ / ✗). Then the causes, and the queries' ids. Values are aggregates only.
- Never call the stage done because the numbers "look close". A person approves the report.

## Worked example (the reference problem: retail orders)

Reconciling `shop.orders` (the source, Postgres) with its landing table on Snowflake, key `order_id`. `autode_reconcile_plan` generates, for the source:

```sql
SELECT
  COUNT(*) AS row_count,
  COUNT(DISTINCT order_id) AS key_distinct,
  COUNT(*) - COUNT(order_id) AS key_nulls_order_id,
  COUNT(DISTINCT status) AS distinct_status,
  COUNT(*) - COUNT(status) AS nulls_status,
  SUM(shipping_amount) AS sum_shipping_amount,
  COUNT(*) - COUNT(shipping_amount) AS nulls_shipping_amount,
  MIN(updated_at) AS min_updated_at,
  MAX(updated_at) AS max_updated_at,
  COUNT(*) - COUNT(updated_at) AS nulls_updated_at
FROM shop.orders
```

and the same aggregates over `raw.shop_orders_raw` for the target. Different connections and platforms, so no key hash and no missing-key join. The report:

| Metric | shop.orders | raw.shop_orders_raw | Rule | Verdict |
|---|---|---|---|---|
| row_count | 1,204,311 | 1,204,311 | equal | ✓ |
| key_distinct | 1,204,311 | 1,204,311 | equal | ✓ |
| sum_shipping_amount | 6,021,554.10 | 6,021,554.10 | within 0.01 | ✓ |
| max_updated_at | 2026-10-22 23:59:41 | 2026-10-22 23:59:41 | equal | ✓ |
