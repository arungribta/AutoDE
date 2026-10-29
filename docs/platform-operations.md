# Platform operations: one catalog for every interaction with a platform

**Status:** specified 2026-10-28 (owner). Built in four phases (roadmap): **POP1** the catalog and executor, with LIN's platform lineage reads (v0.54.0); **POP2** the adapters' metadata extraction (v0.55.0); **POP4** the operations and skills catalog in the UI (v0.56.0); **POP3** agent-proposed operations and drift detection (v0.57.0). Requirement: PLT-9 in [requirements.md](requirements.md). **Rule for contributors:** [CLAUDE.md](../CLAUDE.md). **Related:** [platform-skills.md](platform-skills.md), the runner (technical-design §5, runbooks), transform primitives (`primitive-definitions/`, the same pattern for deliverables).

## 1. Need and intent

### 1.1 The need

AutoDE works on platforms it doesn't control. Snowflake, Databricks and Oracle change every few weeks:
- new object kinds (Snowflake Horizon objects, Databricks metric views);
- renamed or replaced system views (account usage, information schema, `system.access` tables);
- new editions and privileges;
- CLI commands that gain flags or change their output.

AutoDE is also used across many client accounts, each on its own edition, version and set of privileges.

Today, how AutoDE talks to a platform is TypeScript spread through the engine: SQL strings in adapters, probes, reconciliation and dry runs, and `if (platform === 'snowflake')` branches. That has already cost us:

| What happened | What it shows |
|---|---|
| The Snowflake adapter's lineage read used `QUERY_HISTORY`, which returns no source or target, so every lineage edge came back empty for months, unnoticed (removed in v0.53.0). | A wrong platform query fails silently, and only a code release fixes it. |
| MM1's tag handling was written as Snowflake-specific code; the owner pushed back. | Each new feature adds more platform code unless there is a place for it that isn't code. |
| A client on an older edition, or without a privilege, gets a failure from a read that works elsewhere. | One fixed query per platform can't serve every account. |

So:
- **A platform change breaks AutoDE.** Nobody can fix it without a developer and a new AutoDE release.
- **New platform capabilities stay invisible** until someone writes code for them.
- **The team that knows the platform** (the data engineers and platform owners using AutoDE on client work) **can't correct or extend what AutoDE does** on it, even when they know exactly which view to read.

Handing every platform interaction to an agent with a skill doesn't solve this. Agents are slow, cost money per call and don't give the same answer twice. Approvals are bound to exact content, the grounding checks must be repeatable, and the CLI must work without a model. All of that needs the same result on every run.

### 1.2 The intent

**Every interaction with a platform is a platform operation: a small declarative file that says what to run on each platform, with typed parameters and a typed result. One platform-neutral executor runs it, the same way for AutoDE's own code, the CLI, the MCP tools and agents.**

- **Operations are the *what*:** the exact statement or command for each platform and version, with its parameters, its result and a recorded example. They are deterministic, testable without an account, and checked by the same safety rules every time.
- **Skills are the *when, why and how to judge*:** which operations to use for a task, what a platform feature is for, how to read a result, what to do when a privilege is missing. Skills name operations by id; they don't carry their own SQL.
- **A platform change is handled by updating files, not code:** an edited or new operation file, an updated skill. Teams can do it in their own workspace (it overrides the shipped one by id), reviewed like any other change. AutoDE ships improvements the same way.
- **Agents discover, the catalog keeps** (POP3). When an agent finds a way to do something no operation covers, it proposes an operation. A person approves it, and from then on the interaction is deterministic.
- **People can see and shape it** (POP4). The operations, the skills that rely on them and the code that calls them are visible in one place, and the skills can be edited there, by technical and non-technical users alike.

### 1.3 Goals and non-goals

Goals:
- AutoDE keeps working through platform changes. A failure is reported as a gap, never a silent empty result, and never stops the reads around it.
- No platform-specific SQL or CLI text in engine code outside a few named folders (enforced by `test/architecture.test.cjs`).
- One path for every caller: the same operation, parameters and connection give the same statement, and the same result shape.
- Safety does not depend on who wrote the file. A read is checked by the read-only guard when it is loaded and when it is run. A change runs only as an approved runbook step.
- The format is simple enough for a form: flat, validated by a published JSON Schema, every field labelled and described.

Non-goals:
- A general programming language. Composition stays to `steps`, `for_each` and version conditions (§3). Anything more stays as code, with the reason recorded.
- Replacing compiled deliverables. Pipeline code still comes from vetted primitives (`primitive-definitions/`), the same pattern for what AutoDE *builds*. Operations cover how AutoDE *talks to* a platform.
- Letting agents run arbitrary statements. `autode_execute_query` stays read-only and guarded. Operations add reviewed, repeatable reads; they don't widen what an agent may do.

### 1.4 Who it serves

| Who | What they get |
|---|---|
| Data engineers using AutoDE | Reads that work on their client's edition and privileges, and a clear gap when they don't; a fix in the workspace the same day, not a wait for a release |
| Platform owners and team leads | One place to see and review every interaction AutoDE has with their platform, and what it relies on |
| Data stewards and non-technical users (POP4) | A readable catalog of what AutoDE reads and changes, and skills they can adjust in plain language |
| Agents | Named, described operations to call instead of writing SQL; the same results the engine gets |
| AutoDE's maintainers | Platform support as data with recorded examples, tested in `npm test` without accounts |

### 1.5 What success looks like

- Supporting a new Snowflake or Databricks object kind is a new operation file and a skill update, with no TypeScript change.
- A system view renamed by a platform shows up as a maintenance item naming the failing operation. A team fixes it in the workspace, and the fix is reviewed like any change.
- The architecture test's baseline of platform code outside the allowed folders falls to zero (POP1 and POP2).
- Someone can open the catalog and answer "what does AutoDE run against our Snowflake account, and which skills use it?" without reading code (POP4).

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

## 6. Phases

### 6.1 POP1 — the catalog and the executor (v0.54.0)

Scope:
- the format, its JSON Schema and loader (shipped plus team overrides, validation, each example checked in `npm test`);
- the executor (binding, guard, mapping, partial failures, version ranges);
- the tools: CLI `autode platform …` and MCP `autode_platform_operations` / `autode_platform_run`; change operations as runbook steps;
- migration of the five **TO MOVE** entries in `test/architecture/platform-boundary.json` (probes, reconciliation aggregates, the platform-to-dialect mapping, the dry-run `EXPLAIN`). Their baseline entries are lowered as they move;
- the platform skills refer to operations by id.

**Observed lineage** (agreed with the LIN session, 2026-10-28). LIN v0.53.0 ships with no platform lineage reads: the old `QUERY_HISTORY` read was removed from the Snowflake adapter, and the lineage path from the base adapter. LIN ships a platform-neutral recorder that POP1's lineage operations feed:
- **The recorder:** `recordObservedLineage(ledger, batch, identity)` in `src/engine/lineage/observed.ts`, also exposed as `autode_record_observed_lineage` and `autode lineage record`. It writes `lineage` facts: subject `[downstream, upstream]`; value `{upstream, downstream, level, source: 'observed', method, connection, scope, entity?}`.
  - It is idempotent.
  - It retires edges only when a batch is complete, scoped by connection, method and databases. A partial result from a failed operation must therefore be recorded as incomplete, so nothing is retired.
- **The operations:**
  - Snowflake `ACCESS_HISTORY` and `OBJECT_DEPENDENCIES`;
  - Databricks `system.access.table_lineage` and `system.access.column_lineage`.
- **Their result mapping:** rows to `{ upstream: {object, column?}, downstream: {object, column?} }`, or `{ upstream, entity: {type, id, name?} }` for a job or query entity.


Acceptance:
- **Deterministic:** the same operation, parameters and connection give the same SQL; a parameter can't inject SQL (tested with hostile identifiers and literals).
- **Safe:** a `read` operation the guard classifies as changing is refused when loaded; a `change` operation can't run except as an approved runbook step.
- **One path:** probes, reconciliation and dry runs produce the same SQL as before, through operations (golden tests).
- **Every surface:** CLI, MCP and the VS Code executor run the same operation with the same result.
- **Resilient:** an operation failing against a fixture platform version reports a gap and the rest of the read continues.
- **Boundary:** the architecture test's baseline loses the TO MOVE entries.
- **Lineage:** on a recorded fixture of each platform, the lineage operations' facts match a golden set; a failed read retires nothing. LIN's live Snowflake check passes.

### 6.2 POP2 — the adapters' metadata extraction (v0.55.0)

The adapters (`SnowflakeAdapter`, `DatabricksAdapter`, `OracleAdapter`) still carry the estate reads as code: tables, columns, keys, views, profiling and last-altered times. POP2 moves them to operations, so the estate itself stays current with the platforms.

Scope:
- operations `estate.list_tables`, `estate.list_columns`, `estate.list_primary_keys`, `estate.list_foreign_keys`, `estate.list_views`, `estate.last_altered`, `estate.profile_table` for each platform, with version ranges and recorded examples;
- `BaseDataSourceAdapter.extractMetadata` calls them by id. The adapters keep only connection, authentication and execution (the allowed machinery);
- a read the account can't do (an edition, a privilege) is reported per operation, and the rest of the extraction continues;
- **new object kinds:** an operation can read objects the snapshot didn't know (for example Snowflake dynamic tables, Databricks metric views). They come into the estate as their declared kind, not dropped.

Acceptance:
- **Same estate:** on the recorded fixtures, extraction through operations gives the same snapshot as before, node for node (golden test).
- **Extensible:** a team operation file adding an object kind brings those objects into the estate with no code change (test with a fixture kind).
- **Resilient:** a failing operation (fixture: a missing privilege) leaves the other reads' results and reports the gap in the ingest result and the Estate view.
- **Boundary:** the architecture baseline lists no platform SQL in the adapters.

### 6.3 POP4 — the operations and skills catalog (v0.56.0)

A place where anyone can see what AutoDE does on each platform and what it relies on, and adjust the skills behind it. It is a view in VS Code, with the same answers on the CLI and over MCP. It is the first step of the platform UI the owner plans, for technical and non-technical users alike.

**Review the operations:**
- every operation, shipped or the team's, filterable by platform, area (estate, lineage, governance, quality, deployment), kind (read or change) and status (ok, failing, team override, proposed);
- for each one:
  - its title and plain-language description;
  - its parameters and results, with labels;
  - the statement or command per platform, with its version range;
  - the recorded example;
  - where it comes from (shipped, or the team's override and who approved it);
  - its last run on each connection: when, how many rows, ok or the gap and its reason;
- **what relies on it:**
  - the skills that name it, with the section that does;
  - the engine features that call it (estate refresh, probes, reconciliation, dry runs, lineage);
  - the stages whose assignments list it;
- **try it:** run a read operation with chosen parameters on a connection, read-only, with the row limits and sample-data consent of `autode_execute_query`. You see the bound statement before it runs. A change operation shows the runbook step it would produce; it can't run from here.

**Review the skills:**
- every skill, AutoDE's own and the team's, by platform and stage, with its version, maturity and review state;
- for each one, the operations it relies on (each linked to its page), and any operation it names that doesn't exist or is failing. A skill that still carries its own SQL is flagged.

**Edit the skills:**
- a team skill opens in an editor: its instructions (Markdown) and its metadata as a form (stages, platforms, the operations it uses);
- an AutoDE skill is edited through **Customise**:
  - this makes a team copy under the same id in the workspace, which takes precedence over the bundled one;
  - when a later AutoDE release changes the original, the copy is flagged "AutoDE's version changed", with the difference, so the team can merge it in or keep theirs;
  - *Reset to AutoDE's* removes the copy;
- every edit goes through the skills' review lifecycle (PA4): a draft until a person publishes it, the version recorded, and the change visible in its history. A stage never runs an unpublished draft;
- the editor checks as you type: the format rules, unknown operation ids, and SQL in the skill (suggesting the operation to use instead).

**Edit operations** (in the same view): a form generated from the JSON Schema, with the statement per platform. Saving checks the file (schema, read-only guard for reads, binding of the example). A team change to an operation is a draft until a person approves it, as for skills.

**Surfaces:**
- the CLI: `autode platform operations [--platform p] [--uses <skill>]`, `autode platform operation <id>` (its page, with what relies on it), `autode skills show <id>` (with its operations), `autode skills customise <id>`, `autode skills reset <id>`, `autode skills lint <id>`;
- MCP: `autode_platform_operations` with the same fields, and `autode_skills_list` with each skill's operations.

Acceptance:
- **Traceable:** for every shipped operation, the view lists the skills and engine features that use it, and for every skill its operations. An operation nothing uses is flagged. Checked against a fixture where the answers are known.
- **Editable safely:** customising an AutoDE skill makes a team copy, the stage uses it only after it is published, and reset restores the bundled one. A later bundled change is flagged on the copy.
- **Checked:** a skill naming an unknown operation, or carrying SQL, is flagged in the editor and by `autode skills lint <id>` (new; `skills check` already probes external installs). A change operation can't run from the view.
- **For everyone:** every field has a label and a description. The view works by keyboard and screen reader (UI-4) and in VS Code's themes. Empty states say what to do next.
- **Parity:** the CLI and MCP give the same lists and pages as the view.

### 6.4 POP3 — agent-proposed operations and drift detection (v0.57.0)

Scope:
- **Proposals:**
  - an agent that did something with a platform's CLI or a query no operation covers can propose an operation file (`autode_propose_platform_operation`; decision kind `platform_operation`);
  - the proposal must include a recorded example. AutoDE validates it (schema, guard, binding of the example) before a person sees it;
  - the person reviews it in the POP4 catalog, which shows the proposal beside the operations it resembles, and approves or rejects it;
  - approved, it becomes a team operation, and the skill that needed it can name it.
- **Drift:**
  - an operation failing on a platform version outside its range, or an error that says a view or column is missing, raises a maintenance item;
  - so does a platform reporting object kinds no operation reads (from POP2's estate reads);
  - the item names the operation, the platform version and the skill's owner. The *platform maintainer* role is suited to it, and drafts a fix to the operation file as a proposal.
- Proposals and drift items appear in the POP4 catalog, on the operation's page.

Acceptance:
- **Codified:** a proposal without a passing example is refused with the reason. An approved one runs deterministically through the executor, from the CLI with no model.
- **Noticed:** on a fixture platform version where a view is renamed, the failing operation raises one item; fixing the file closes it. An unread object kind raises one item.
- **Never silent:** drift never turns into an empty result; the gap stays visible until it is fixed or dismissed with a reason.

## 7. Open questions for POP1

1. Where team-supplied operations are reviewed before they run: the skills' review lifecycle (PA4), or decisions.
2. Whether `autode_platform_run` needs a row limit and the sample-data consent (`allowSampleDataInPrompts`) for operations that return rows, not just metadata. Proposed: yes, the same rules as `autode_execute_query`.
3. Version detection: read the platform version once per connection and cache it, or per run.

## 8. Open questions for the later phases

4. **POP4:** whether the catalog is its own view or a section of the Knowledge Explorer. Proposed: its own view, *Platform catalog*, opened from the Explorer's Estate view and the Workflow view's title bar, because its users include platform owners who don't explore the estate.
5. **POP4:** a customised AutoDE skill in other hosts. The Claude Code plugin ships AutoDE's skills; a team copy has to reach it too. Proposed: `autode plugin install` copies published team overrides over the bundled ones.
6. **POP3:** the *platform maintainer* role is new: an agent template for fixing operation files, at the propose tier. Or the knowledge engineer takes it. Proposed: a new role, since its skills (platform documentation, operation format) differ.
