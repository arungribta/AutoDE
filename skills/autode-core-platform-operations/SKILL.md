---
name: autode-core-platform-operations
description: Keep AutoDE's platform operations right - propose an operation file when you did something on a platform that no operation covers, and fix an operation that drifted (a view renamed, a column gone, a new platform version, an object kind AutoDE doesn't know) - each with a recorded example, as a proposal a platform owner approves. Use it when a maintenance item names the platform maintainer, or when you ran a read on a platform that should become repeatable.
allowed-tools: [Read, mcp__autode__autode_platform_operations, mcp__autode__autode_platform_catalog, mcp__autode__autode_platform_drift, mcp__autode__autode_platform_run, mcp__autode__autode_execute_query, mcp__autode__autode_list_connections, mcp__autode__autode_propose_platform_operation, mcp__autode__autode_skill_check, mcp__autode__autode_skill_customise, mcp__autode__autode_maintenance_list, mcp__autode__autode_maintenance_next]
metadata:
  scope: core
  stageKinds: []
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Platform operations

Every interaction AutoDE has with a platform is an **operation**: a reviewed file with typed parameters, a statement or command per platform, a typed result and a recorded example. AutoDE's executor runs them with no model. Your job is to keep that catalog right when the platforms change, and to grow it when an agent had to do something by hand.

## 1. Know the format

Read an operation in full before you write one: `autode_platform_operations` with `id` (for example `estate.list_views`).

| Field | What it holds |
|---|---|
| `id` | `area.name`: `estate`, `lineage`, `governance`, `quality`, `performance`, `pipelines`, `deployment`, `platform` |
| `kind` | `read` runs; `change` only becomes a runbook step a person approves |
| `content` | `metadata` (names only) or `data` (row values, gated by the connection's sample-data setting) |
| `params` | each with `name`, `type` (`identifier`, `identifier_list`, `literal`, `literal_list`, `number`, `boolean`) and `label`. Values are bound, never pasted: `{database}` binds an identifier, `{schema:literal}` a quoted value, `[[ … ]]` is kept only when its parameters have values |
| `returns` | one entry per column: `name`, `from` (the platform's column, any case), `as` (`string`, `number`, `yes_no`, `boolean`, `json`) |
| `platforms.<id>` | `sql` (one read-only statement for a read) or `cli` (an argument list, never a shell line); `since` / `until` bound the platform versions it works for |
| `example` | `platform`, `params` and `rows`: what the platform returned when you ran it |

## 2. Record the example first

A proposal without a recorded example is refused. Run the statement read-only on a connection (`autode_execute_query`, or `autode_platform_run` for an existing operation) and copy a few rows into `example.rows`, with the parameters you used and the platform. AutoDE checks that the example binds and that every `returns` column is in it.

## 3. Propose

`autode_propose_platform_operation` with the operation, a `reason` (what you did that nothing covered, or what drifted), and `fixes` (the maintenance item's key) when it fixes one. Problems come back one by one: fix them and propose again. The answer lists the operations it resembles. If one already does the job, use that one and don't add a duplicate.

## 4. Fix drift

`autode_platform_drift` and the items with rule `operation-drift` or `object-kind-unread` (`autode_maintenance_next` with role `platform-maintainer`) say what broke:

| What it says | Do |
|---|---|
| a view or column is missing | Find what replaced it (the platform's documentation; `autode_execute_query` on its system views). Change the statement, record a new example, and propose the operation under the **same id** with `fixes` |
| the platform's version is outside the range | Add an implementation for the new version with `since` (and `until` on the old one) |
| an object kind the definition doesn't name | Say what the kind is and what AutoDE should read about it. A person customises the platform definition (`autode platform customise <platform>`) to name it. Propose an operation for what it needs to read |

The item closes when a person approves the fixed operation. A later run that works confirms it.

## Worked example

`estate.list_external_stages` came up because a pipeline engineer listed Snowflake's external stages by hand:

```yaml
formatVersion: 1
id: estate.list_external_stages
title: External stages in a schema
description: Each external stage of one schema, with its URL and type (structure, not data).
kind: read
content: metadata
area: estate
params:
  - { name: database, type: identifier, label: Database }
  - { name: schema, type: literal, label: Schema }
returns:
  - { name: stage_name, label: Stage }
  - { name: stage_url, label: URL }
  - { name: stage_type, label: Type }
platforms:
  snowflake:
    sql: SELECT stage_name, stage_url, stage_type FROM {database}.INFORMATION_SCHEMA.STAGES WHERE stage_schema = {schema:literal} AND stage_type = 'External Named'
example:
  platform: snowflake
  params: { database: RETAIL, schema: RAW }
  rows:
    - { STAGE_NAME: ORDERS_LANDING, STAGE_URL: 's3://acme-landing/orders/', STAGE_TYPE: External Named }
```

## Rules

- Propose; never approve. A platform owner reviews in the Platform catalog.
- Reads stay reads: one statement, no writes. A change on the platform is a runbook (`autode_propose_runbook`), never an operation that runs.
- Name the operation in the skill that needed it once it is approved. Check the skill with `autode_skill_check`. To change one of AutoDE's skills, customise it (`autode_skill_customise`): a person reviews and publishes the copy.
- Don't put credentials, account names or data you weren't asked for in an example. Use the names the platform returned, and only a few rows.
