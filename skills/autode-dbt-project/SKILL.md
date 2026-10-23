---
name: autode-dbt-project
description: Build an AutoDE business problem's dbt project when the target context chooses dbt - sources from the estate with freshness, staging models compiled by AutoDE, incremental marts from the approved mapping and model, and data tests from the quality rules - for Snowflake or Databricks. Use it in the build stage when the transformation tool is dbt.
allowed-tools: [Read, Grep, Glob, Write, Edit, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_primitive_candidates, mcp__autode__autode_compile_transform, mcp__autode__autode_compile_pipeline_spec, mcp__autode__autode_check_grounding, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: dbt
  stageKinds: [build]
  platforms: [snowflake, databricks]
  version: 1
  owner: AutoDE
  maturity: tested
---
# dbt project

Written by AutoDE from dbt's public documentation (sources, models, incremental materializations, data tests). AutoDE selects this skill only when the target context's transformation tool is dbt. It works the same on Snowflake (dbt-snowflake, or dbt Projects on Snowflake) and Databricks (dbt-databricks).

## 1. Layout

```
dbt/<project>/
  dbt_project.yml
  models/staging/_<source>__sources.yml      sources, freshness, source tests
  models/staging/stg_<source>__<table>.sql   one per source table
  models/marts/fct_*.sql, dim_*.sql          from the model
  models/marts/_marts.yml                    model tests
```

`profiles.yml` is never in the project with credentials. Each engineer has their own, or the platform supplies the connection (`snow dbt`, a Databricks job's dbt task).

## 2. Sources

One `sources:` entry per source schema, with the estate's names (`autode_resolve` each table). Add `loaded_at_field` and `freshness` from the freshness rules: `warn_after` and `error_after` as the rules say, not a guess.

## 3. Staging models: compiled, not written

For each mapped source table, `autode_primitive_candidates`, then `autode_compile_transform` with the `rename_cast` primitive and `objectKind: dbt_model`. It renames and casts, reading `{{ source('<source>', '<table>') }}`. Keep the compiled model as it is. Name it `stg_<source>__<table>`.

## 4. Marts from the model

- One model per entity of the approved model, with its grain and key. Read only staging models (`{{ ref('stg_…') }}`), never sources.
- **Facts that grow:** `materialized='incremental'`, `unique_key` = the entity's key, `incremental_strategy='merge'`, and an `is_incremental()` filter on the change column.
- **Small dimensions:** `table`. SCD type 2 dimensions: dbt snapshots, when the model asks for history.
- Hand-written SQL beyond the compiled steps gets `autode_check_grounding`, and a note on why no primitive fits.

## 5. Tests from the quality rules

Every approved quality rule becomes a data test on the column it names:

| Quality rule | dbt test |
|---|---|
| not-null | `not_null` |
| uniqueness | `unique` |
| accepted values | `accepted_values` with the rule's values |
| referential integrity | `relationships` (to: `ref('<dim>')`, field) |
| range | a singular test in `tests/`, or a package the team already uses |
| freshness | the source's `freshness` |

Use only packages the team already has (`packages.yml`); adding one is a decision. Name every test's rule in its `description` (or `config.meta.rule`), so the quality report traces to it.

## 6. Record

`autode_record_artifact` with every file of the project. Deploying it is the deploy stage's: a runbook from `autode-snowflake-deployment` (`snow dbt deploy`) or `autode-databricks-deployment` (a bundle job with a dbt task).

## Worked example (the reference problem: retail orders)

```yaml models/staging/_shop__sources.yml
version: 2

sources:
  - name: shop
    schema: shop
    loaded_at_field: updated_at
    freshness:
      warn_after: {count: 12, period: hour}
      error_after: {count: 24, period: hour}
    tables:
      - name: orders
        columns:
          - name: order_id
            data_tests: [not_null, unique]
          - name: status
            data_tests:
              - accepted_values:
                  values: ['PLACED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED']
      - name: customers
        columns:
          - name: customer_id
            data_tests: [not_null, unique]
```

```sql models/staging/stg_shop__orders.sql
with source as (
    select * from {{ source('shop', 'orders') }}
),

renamed as (
    select
        order_id,
        customer_id,
        order_ts,
        upper(status) as order_status,
        currency as currency_code,
        shipping_amount,
        tax_amount,
        updated_at
    from source
)

select * from renamed
```

```sql models/marts/fct_orders.sql
{{ config(materialized='incremental', unique_key='order_id', incremental_strategy='merge') }}

select
    o.order_id,
    o.customer_id,
    o.order_ts,
    cast(o.order_ts as date) as order_date,
    o.order_status,
    o.shipping_amount,
    o.tax_amount,
    o.updated_at
from {{ ref('stg_shop__orders') }} o
{% if is_incremental() %}
where o.updated_at > (select max(t.updated_at) from {{ this }} t)
{% endif %}
```
