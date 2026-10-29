# Platform operations: one catalog for every interaction with a platform

**Status:** specified 2026-10-28 (owner); to be built as phase **POP1** before LIN's platform lineage reads, by the owner's choice (option a). **Rule for contributors:** [CLAUDE.md](../CLAUDE.md). **Related:** [platform-skills.md](platform-skills.md), the runner (technical-design §5, runbooks), transform primitives (`primitive-definitions/`, the same pattern for deliverables).

## 1. Why

The owner wants AutoDE to keep working when a platform changes, and changes to be handled by updating skills and data, never by releasing new code. Examples: Snowflake adds Horizon objects, Databricks renames a system table, a CLI command gains a flag. Platform-specific TypeScript scattered through the engine fails this in two ways:
- **Breaking:** an adapter query fails on a newer platform version.
- **Incompleteness:** new object kinds go unseen, silently.

Moving every interaction to agents with skills would make each one slow, costly and non-reproducible. Approvals, the grounding checks and the model-free CLI need the same result on every run.

**The answer is a catalog of platform operations:** declarative files describing each interaction, run by one platform-neutral executor, called the same way by deterministic code and by agents.

## 2. What an operation is

One YAML file per interaction, in `platform-operations/<area>/<id>.yaml` (shipped) or `.autode/config/platform-operations/` (the team's own, which override by id).

```yaml
id: estate.list_columns
title: List the columns of a schema
description: Every column of the tables and views in one schema, with type, nullability and comment.
kind: read                          # read | change
params:
  - { name: database, type: identifier, label: Database }
  - { name: schema, type: identifier, label: Schema }
returns:
  - { name: table, from: TABLE_NAME }
  - { name: column, from: COLUMN_NAME }
  - { name: data_type, from: DATA_TYPE }
  - { name: nullable, from: IS_NULLABLE, as: yes_no }
  - { name: comment, from: COMMENT }
platforms:
  snowflake:
    sql: >
      SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COMMENT
      FROM {database}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = {schema:literal}
    since: "8.0"
  databricks:
    sql: >
      SELECT table_name AS TABLE_NAME, column_name AS COLUMN_NAME, data_type AS DATA_TYPE,
             is_nullable AS IS_NULLABLE, comment AS COMMENT
      FROM system.information_schema.columns WHERE table_catalog = {database:literal} AND table_schema = {schema:literal}
example:                             # a recorded result, so npm test checks binding and mapping without an account
  params: { database: RETAIL, schema: SHOP }
  rows: [ { TABLE_NAME: ORDERS, COLUMN_NAME: ORDER_ID, DATA_TYPE: NUMBER, IS_NULLABLE: NO, COMMENT: null } ]
```

An implementation can also be a platform CLI command, which follows the vendor's tooling as it evolves: `cli: [databricks, tables, list, "{catalog}", "{schema}", --output, json]`, with `parse: json`. A command is an argument list, never a shell line.

**Form-friendly by design** (the owner's plan: a platform UI later, the same for technical and non-technical users, to set up operations and onboard platform skills):
- the structure is flat;
- a published JSON Schema (`docs/schemas/platform-operation.schema.json`) validates every file;
- every field has a label and a plain-language description;
- parameters and results are typed lists, not free text.

The future UI edits the same files and runs the same checks; it adds no second format.

## 3. How operations run

**The executor** is the only platform-aware engine code here (`src/engine/platform/operations/`). It:
- picks the connection's platform implementation, with its version range;
- binds parameters by type: `identifier` is quoted by the platform's rules, `literal` is escaped as a value, `number` and `boolean` are checked. A template never contains pasted-in text;
- checks a `read` operation with the read-only guard, refusing it if the guard disagrees, both when the file is loaded and at run time;
- runs it with a timeout, maps the results to the declared names and types, and reports a failure as a partial result with its reason. It never stops a larger read.

**Change operations** (`kind: change`: tags, grants, warehouses, schedules) never run directly. Calling one produces a runbook step, which a person approves and AutoDE's runner executes, with its rollback.

**Composition stays small:** `steps` (a sequence), `for_each` (per item of an earlier result), and `when` (a platform version condition). There are no loops, variables or expressions. An interaction that needs more stays as code in `src/engine/platform/`, with the reason recorded.

## 4. Who calls them

| Caller | How |
|---|---|
| The engine, deterministically | By id: estate refresh, probes, reconciliation, dry runs, LIN's observed lineage |
| The CLI | `autode platform operations [--platform p]`, `autode platform run <id> --connection <c> [--param k=v]` (reads only) |
| Agents (MCP) | `autode_platform_operations` (list and describe), `autode_platform_run` (reads). Change operations go through `autode_propose_runbook` steps that name them. A stage's assignment lists the operation ids it may use. |
| Skills | Refer to operations by id ("tag a column: `governance.set_tag`") instead of carrying SQL |

## 5. How it keeps up with platforms

1. **New feature, new file.** Supporting a new object kind or API means a new or edited operation file, shipped or team-supplied, with no code release.
2. **Agents codify what they discover.** When an agent uses the platform's CLI to do something no operation covers, it can propose an operation file (decision kind `platform_operation`). A person approves it after its example passes. From then on the interaction is deterministic and testable.
3. **Drift is noticed.** An operation that fails on a platform version outside its range, or a platform that reports object kinds no operation reads, raises a maintenance item ("estate.list_columns failed on Snowflake 9.2: update its file"), naming the platform skill's owner.
4. **Partial, never stopped.** A failed operation reports a gap; the reads around it continue.

## 6. Phase POP1 (before LIN's platform lineage)

Scope:
- the format, its JSON Schema and loader (shipped plus team overrides, validation, each example checked in `npm test`);
- the executor (binding, guard, mapping, partial failures, version ranges);
- the tools: CLI `autode platform …` and MCP `autode_platform_operations` / `autode_platform_run`; change operations as runbook steps;
- migration of the five **TO MOVE** entries in `test/architecture/platform-boundary.json` (probes, reconciliation aggregates, the platform-to-dialect mapping, the dry-run `EXPLAIN`). Their baseline entries are lowered as they move;
- the platform skills refer to operations by id.

Later steps:
- **POP2:** migrate the adapters' metadata extraction;
- **POP3:** agent-proposed operations, drift detection;
- **later still:** the platform UI.

Acceptance:
- **Deterministic:** the same operation, parameters and connection give the same SQL; a parameter can't inject SQL (tested with hostile identifiers and literals).
- **Safe:** a `read` operation the guard classifies as changing is refused when loaded; a `change` operation can't run except as an approved runbook step.
- **One path:** probes, reconciliation and dry runs produce the same SQL as before, through operations (golden tests).
- **Every surface:** CLI, MCP and the VS Code executor run the same operation with the same result.
- **Resilient:** an operation failing against a fixture platform version reports a gap and the rest of the read continues.
- **Boundary:** the architecture test's baseline loses the TO MOVE entries.

## 7. Open questions for POP1

1. Where team-supplied operations are reviewed before they run: the skills' review lifecycle (PA4), or decisions.
2. Whether `autode_platform_run` needs a row limit and the sample-data consent (`allowSampleDataInPrompts`) for operations that return rows, not just metadata. Proposed: yes, the same rules as `autode_execute_query`.
3. Version detection: read the platform version once per connection and cache it, or per run.
