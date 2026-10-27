---
name: team-sql-conventions
description: The team's SQL and naming conventions for warehouse models - layer prefixes, key and timestamp column names, casing, and how incremental loads are written. Read it before writing or reviewing SQL models.
license: MIT
---

# Team SQL conventions

An example **knowledge skill**: it tells an agent how this team writes SQL and does
not act on anything. Once it is published and reviewed, AutoDE adds it to the context
packs whose question it matches, so every agent writing SQL sees it. Replace the
rules below with your team's own.

## Layers and names

- Staging models are `stg_<source>__<entity>` (two underscores between source and
  entity), one per source table, with no joins.
- Intermediate models are `int_<entity>_<verb>`, for example `int_orders_joined`.
- Marts are `fct_<process>` for facts and `dim_<entity>` for dimensions.
- Names are lower snake case. Never quote identifiers to keep mixed case.

## Columns

- A surrogate key is `<entity>_sk`; the source's own key keeps its name and is
  suffixed `_id`.
- Timestamps end in `_at` and are UTC (`loaded_at`, `updated_at`); dates end in
  `_date`.
- Booleans start with `is_` or `has_`.
- Money is `NUMBER(18,2)` (Snowflake) or `DECIMAL(18,2)` (Databricks), never a float.

## Incremental loads

- Deduplicate on the business key by the change column before merging:
  keep the latest row per key (`QUALIFY ROW_NUMBER() OVER (PARTITION BY <key> ORDER BY <changed_at> DESC) = 1`).
- Merge on the business key; never `INSERT OVERWRITE` a fact table.
- Every incremental model filters on its watermark with a look-back of one day, to
  catch late rows.

## Reviews

- A model without a primary-key uniqueness test is not merged.
- Comments explain *why*, not *what*.
