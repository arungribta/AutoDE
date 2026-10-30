# Platform operations: one catalog for every interaction with a platform

**Status:** specified 2026-10-28 (owner). Built in four phases (roadmap): **POP1** the catalog and executor, with LIN's platform lineage reads (v0.54.0); **POP2** the estate read through operations, Redshift first (v0.55.0), then Snowflake's and Databricks' extraction (v0.55.1); Oracle's platform work is deferred to the backlog (§6.2a, owner 2026-10-30); **POP4** the operations and skills catalog in the UI (v0.57.0, after the UI2 simplification); **POP3** agent-proposed operations and drift detection (v0.58.0); **POP5** onboarding new systems and sharing them (v0.61.0, before the AtScale import). Requirement: PLT-9 in [requirements.md](../requirements.md). **Rule for contributors:** [CLAUDE.md](../../CLAUDE.md). **Related:** [platform-skills.md](../guides/platform-skills.md), the runner (technical-design §5, runbooks), transform primitives (`primitive-definitions/`, the same pattern for deliverables).

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

### 2.1 Transports

AutoDE talks to very different systems, so an implementation names its **transport**. All four are in the format from POP1, so that later phases (AtScale, Collibra) add files, not engine code:

| Transport | For | Example |
|---|---|---|
| `sql` | warehouses and lakehouses | Snowflake `ACCESS_HISTORY`, Redshift `SVV_TABLE_INFO` |
| `cli` | a vendor's command-line tool, as an argument list (never a shell line), `parse: json` or `table` | `databricks tables list` |
| `http` | REST APIs: method, path, query, JSON body template, authenticated from the connection, `parse: json` with a JSON path per result field, paging declared | Collibra's REST API, AtScale's API, the Redshift Data API |
| `file` | files in a bound Git repository or folder: a glob and a parser (`yaml`, `json`, `csv`) | AtScale SML models |

Binding, the guard (`read` must not change anything: for `http`, only `GET` or a declared read-only `POST` such as a search), mapping and partial failures work the same for all four.

**How a statement reaches the platform: CLI or API, never a bundled driver** (owner, 2026-10-29; consistent with PLT-2):
- **Access paths.** `sql` says *what* to run. The connection's **access path** says *how*: the platform's **CLI** (`snow sql`, the Databricks CLI, the AWS CLI's `redshift-data`, Oracle's SQLcl) or its **API** (the Snowflake SQL API, the Databricks Statement Execution API).
- **The CLI is the user's.** It is installed on the user's machine and is never bundled in AutoDE's package or the VSIX. When it is missing, AutoDE says so and suggests how to install it: the platform's skill holds the install and setup steps, and a command runs only on request (as for drivers today, PLT-7).
- **A CLI-free path where the vendor offers one.** A platform definition declares the CLI path and, where the vendor has one, an API path. AutoDE prefers the CLI and falls back to the API, for locked-down machines where nothing may be installed and for CI. A platform with neither available is *not connected*, with the reason.
- **Credentials: AutoDE holds them, never in its files, and hands them to the CLI at the call.** The connection's resolver, as today (PLT-3), says where a credential lives:
  - `vscode`: VS Code's secret storage, which is what a person types in Settings → Connections;
  - `env`: environment variables, for CI, the MCP server and the CLI;
  - `cli`: the CLI's own profile (`snow` connection, Databricks profile, AWS profile, SQLcl connection), where AutoDE only names the profile.

  With `vscode` and `env`, AutoDE reads the credential when the call is made and passes it to the CLI to sign in. `connections.yaml` refuses secret fields, and no credential is written to a file, a log or an error message.
  - **How each CLI takes a credential** is declared in the platform definition: preferably the child process's environment (or a temporary config file removed after the call), and a command-line argument only as a last resort. Today the Snowflake password goes to `snow` as `--password`, briefly visible to anything that lists processes; POP1 moves it to the environment where the CLI supports that.
  - For API paths, authentication is a **small fixed set of generic methods**, coded once: a bearer token, OAuth client credentials, Snowflake key-pair, user and password where the API accepts it. AWS request signing is not among them: Redshift goes through the AWS CLI.
- **No browser in the loop.** The MCP server, CI and agent hosts run the CLI non-interactively. Every call has a timeout. A profile that needs a browser sign-in (SSO) is reported as such, and the skill recommends a non-interactive profile (key-pair, token, service principal).
- **Asynchronous statements.** Most statement APIs submit, then poll, then fetch pages. The `cli` and `http` transports have this pattern built in, coded once: operations declare it (`async: submit_poll_fetch` with the fields to follow) rather than loop.
- **CLI versions drift too.** Operations always ask for machine-readable output (`--output json`, SQLcl's JSON format). The CLI's version is detected like the platform's, and an operation can declare a CLI version range. A changed output shape is drift (POP3), never an empty result.
- **Skills guide, the executor runs.** A platform skill holds the knowledge: installing the CLI, setting up its profile, testing it, troubleshooting. The call itself always goes through the executor, so reads stay repeatable and the CLI works without a model.
- **Read-mostly.** AutoDE mostly reads. A CLI read must be on the command allowlist; an API read must be a `GET`, or a statement that passes the read-only guard (also applied to SQL inside an API request body). Row values follow the sample-data consent. Writes are rare and run only as approved runbooks, through the same CLIs (`snow`, `databricks bundle`).

### 2.2 Platform definitions

**One platform definition per system** (`platforms/<id>.yaml` shipped, `.autode/config/platforms/` the team's, overriding by id) describes what the system is and what AutoDE can do with it. It is form-friendly like operations, and validated by `docs/schemas/platform.schema.json`.

- **category:** `warehouse`, `lakehouse`, `semantic`, `catalog` (later `orchestration`, `bi`);
- **transports** it supports, its **access paths** (the CLI with its minimum version and how to detect it; the API where the vendor has one), its **connection fields**, and **how its CLI takes a credential** (an environment variable, a temporary config file, or an argument as a last resort). The credential itself comes from the connection's resolver (VS Code's secret storage, the environment, or the CLI's own profile), never from a definition;
- the **version detection** operation;
- the **capability map:** for each AutoDE capability (`estate`, `profiling`, `lineage`, `governance.tags`, `governance.policies`, `semantic.import`, `semantic.export`, `semantic.deploy`, `knowledge.import`, `knowledge.export`, `compile.target` …):
  - the operations that implement it;
  - the **privileges** it needs, in plain language and as a grant template;
  - whether it is supported, partly supported (with what is missing) or not applicable;
- the **object kinds** it has, so an unread kind is noticed (POP3);
- its **dialect** for compiled deliverables, linking to `primitive-definitions/` (warehouses and lakehouses only);
- its **skills and tools:** bundled and team skills, vendor skills (PA4), CLIs and MCP servers with their allowlisted commands.

A **sub-platform** is a capability set within a platform, not a system of its own. **Snowflake Horizon**, for example, is Snowflake's governance capabilities (tags, policies, classification, data metric functions, lineage), read with `sql` operations on the Snowflake connection.

How the systems AutoDE plans for differ:

| System | Category | Transports | What AutoDE uses it for | Writes back (always runbooks) |
|---|---|---|---|---|
| Snowflake (with Horizon) | warehouse | `sql` through `snow` or the SQL API; `cli` | estate, profiling, lineage, governance import (IMP2), compile target, deployment | DDL, grants, tags, policies |
| Databricks | lakehouse | `sql` through the Databricks CLI or the Statement Execution API; `http`; `cli` | estate, lineage, Unity Catalog import (IMP4), compile target, deployment (bundles) | grants, tags, bundles |
| Redshift | warehouse | `sql` through the AWS CLI (`redshift-data`) | estate, profiling; no native column lineage, so lineage is designed only; compile target once its dialect exists | DDL, grants |
| AtScale | semantic | `file` (SML in Git), `http` | semantic import and export (IMP1) | the exported model as a reviewed file change or API call |
| Collibra | catalog | `http` | glossary, domains, owners and lineage import (IMP3) | certified knowledge pushed back |
| Oracle | warehouse (source) | the Node driver today; `sql` through SQLcl (JSON output) when its deferred work resumes (§6.2a) | estate, profiling; view dependencies as lineage | none (a source) |

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

**Status:** part 1 shipped in v0.54.0 (CHANGELOG.md 0.54.0; HOW: technical-design.md §6.15): the format and its schemas, the loader with item-by-item checks, the executor, platform definitions for Snowflake, Databricks and Oracle, the CLI and MCP tools, team review as decisions, and LIN's lineage operations. Part 2 shipped in v0.54.1 (CHANGELOG.md 0.54.1): the five baseline items as **dialect fragments** in the platform definitions (sampling, the regex match, booleans, distinct tuples, the key hash, and the dry run's `EXPLAIN` with Oracle's plan read-back), read by `fragmentsFor()` in `src/engine/platform/dialects.ts`, so the architecture baseline has no TO MOVE entries left; the lineage operations reorganised **one file per kind of lineage** (`lineage.columns`, `lineage.objects`) with every platform's SQL, and Oracle's view dependencies (`ALL_DEPENDENCIES`, per schema: `scopeLevel: schema`); credentials passed to CLIs through the environment (`access.cli.credentialEnv`); interim VS Code commands until POP4. **Deviation:** the dry run's `EXPLAIN` is a fragment, not an operation: an operation's `statement` parameter must be read-only, and the dry run compiles DDL and DML without running them. Composition and the asynchronous pattern move to POP2. POP1 is complete.

Scope:
- the format with its four transports (§2.1; `sql` and `cli` implemented first, `http` and `file` specified and tested on fixtures), its JSON Schema and loader (shipped plus team overrides, validation, each example checked in `npm test`);
- **platform definitions** (§2.2) for Snowflake, Databricks and Oracle, with the capability map; the engine reads a capability's operations from them;
- the executor (binding, guard, mapping, partial failures, version ranges);
- the tools: CLI `autode platform …` and MCP `autode_platform_operations` / `autode_platform_run`; change operations as runbook steps;
- migration of the five **TO MOVE** entries in `test/architecture/platform-boundary.json` (probes, reconciliation aggregates, the platform-to-dialect mapping, the dry-run `EXPLAIN`). Their baseline entries are lowered as they move;
- the platform skills refer to operations by id.

**Observed lineage** (agreed with the LIN session, 2026-10-28). LIN v0.53.0 ships with no platform lineage reads: the old `QUERY_HISTORY` read was removed from the Snowflake adapter, and the lineage path from the base adapter. LIN ships a platform-neutral recorder that POP1's lineage operations feed:
- **The recorder:** `recordObservedLineage(ledger, batch, identity)` in `src/engine/lineage/observed.ts`, also exposed as `autode_record_observed_lineage` and `autode lineage record`. It writes `lineage` facts: subject `[downstream, upstream]`; value `{upstream, downstream, level, source: 'observed', method, connection, scope, entity?}`.
  - It is idempotent.
  - It retires edges only when a batch is complete, scoped by connection, method and databases. A partial result from a failed operation must therefore be recorded as incomplete, so nothing is retired.
- **The operations:**
  - `lineage.columns`: Snowflake `ACCESS_HISTORY` and Databricks `system.access.column_lineage`;
  - `lineage.objects`: Snowflake `OBJECT_DEPENDENCIES`, Databricks `system.access.table_lineage` and Oracle `ALL_DEPENDENCIES` (v0.54.1).
- **Their result mapping:** rows to `{ upstream: {object, column?}, downstream: {object, column?} }`, or `{ upstream, entity: {type, id, name?} }` for a job or query entity.


Acceptance:
- **Deterministic:** the same operation, parameters and connection give the same SQL; a parameter can't inject SQL (tested with hostile identifiers and literals).
- **Safe:** a `read` operation the guard classifies as changing is refused when loaded; a `change` operation can't run except as an approved runbook step.
- **One path:** probes, reconciliation and dry runs produce the same SQL as before, through operations (golden tests).
- **Every surface:** CLI, MCP and the VS Code executor run the same operation with the same result.
- **Resilient:** an operation failing against a fixture platform version reports a gap and the rest of the read continues.
- **Boundary:** the architecture test's baseline loses the TO MOVE entries.
- **Lineage:** on a recorded fixture of each platform, the lineage operations' facts match a golden set; a failed read retires nothing. LIN's live Snowflake check passes.

### 6.2 POP2 — the estate through operations, Redshift first (v0.55.0–v0.55.1)

The adapters (`SnowflakeAdapter`, `DatabricksAdapter`, `OracleAdapter`) still carry the estate reads as code: tables, columns, keys, views, profiling and last-altered times. POP2 moves them to operations, so the estate itself stays current with the platforms.

**Two parts** (owner, 2026-10-30: Redshift's priority raised, Oracle deferred):
- **Part 1 (v0.55.0), Redshift first.** The generic pieces Redshift needs, then Redshift itself:
  - the `estate.*` operations' result shape, taken from today's snapshot model (so it isn't Redshift's shape), checked against recorded Snowflake and Databricks results as well;
  - `extractMetadata` reads a platform's estate through the operations its definition names for `estate`, and through the adapter's code where it names none (Snowflake, Databricks and Oracle until they move);
  - the executor's asynchronous pattern (submit, poll, fetch pages) and a **generic statement runner** for a platform reached only by its CLI, so a platform needs no adapter class: queries, probes and dry runs reach Redshift through its definition;
  - Redshift onboarded (below).
- **Part 2 (v0.55.1).** Snowflake's and Databricks' estate extraction moved onto the same operations (the same snapshot, node for node), their adapters keeping only connection, authentication and execution; new object kinds from an operation file.

**Why Redshift can lead:** it depends on nothing Oracle-related, only on the generic pieces of part 1, which POP2 needed anyway. Splitting the work this way is a risk only if the estate operations are shaped around Redshift alone, so part 1 checks the shape against recorded Snowflake and Databricks results too.

Scope:
- operations `estate.list_tables`, `estate.list_columns`, `estate.list_primary_keys`, `estate.list_foreign_keys`, `estate.list_views`, `estate.last_altered`, `estate.profile_table` for Redshift (part 1), Snowflake and Databricks (part 2), with version ranges and recorded examples;
- `BaseDataSourceAdapter.extractMetadata` calls them by id. The adapters keep only connection, authentication and execution (the allowed machinery);
- **access through CLI or API only** (§2.1): Snowflake and Databricks keep their CLI and API paths; Redshift is reached through the AWS CLI. The async pattern and the generic sign-in methods live in the executor. **Oracle is deferred (§6.2a):** it keeps the Node driver and its adapter's code extraction, the one recorded exception to CLI or API only;
- a read the account can't do (an edition, a privilege) is reported per operation, and the rest of the extraction continues;
- **Redshift onboarded** (owner, 2026-10-29), as the proof that a platform is added by files:
  - a platform definition (category `warehouse`, access through the AWS CLI's `redshift-data`, asynchronous: `execute-statement`, `describe-statement`, `get-statement-result`, paged);
  - its estate and profiling operations (`SVV_TABLE_INFO`, `SVV_COLUMNS`, `SVV_ALL_TABLES` and the like, with version ranges and recorded examples);
  - an `autode-redshift-*` skill: installing the AWS CLI, an AWS profile with a non-interactive sign-in, choosing a cluster or Serverless workgroup and database, the privileges needed, troubleshooting;
  - Redshift as a **source** only: no compile dialect yet, so it isn't offered as a build target; lineage is designed only, since Redshift has no native column lineage. Its capability map says so;
- **new object kinds:** an operation can read objects the snapshot didn't know (for example Snowflake dynamic tables, Databricks metric views). They come into the estate as their declared kind, not dropped.

Acceptance:
- **Same estate:** on the recorded fixtures, extraction through operations gives the same snapshot as before, node for node (golden test).
- **Extensible:** a team operation file adding an object kind brings those objects into the estate with no code change (test with a fixture kind).
- **Resilient:** a failing operation (fixture: a missing privilege) leaves the other reads' results and reports the gap in the ingest result and the Estate view.
- **Boundary:** the architecture baseline lists no platform SQL in the adapters.
- **Redshift without code:** on recorded `redshift-data` output (including a paged result and a failed statement), Redshift's estate comes in through its platform definition, operations and skill only; the architecture test passes with no new exception. With the AWS CLI missing, the skill's install steps are shown.
- **Oracle unchanged:** Oracle connections, probes, dry runs and object lineage work as in v0.54.1 (the existing tests pass).

### 6.2a Deferred: Oracle's platform work (owner, 2026-10-30)

Oracle is deprioritised and its remaining platform work is in the product backlog (roadmap §2). This section is the record of what is pending, so it can be resumed as one phase without rediscovery.

**What Oracle has today (v0.54.1):**
- a **source** only, through the Node `oracledb` driver in Thin mode (Oracle Database 12.1 or later), which the user installs with AutoDE's guidance (DRV1, PLT-7);
- the estate read as code in `OracleAdapter` (tables, columns, keys, views, comments);
- `platforms/oracle.yaml`: its dialect (booleans `1`/`0` before 23ai, distinct tuples emulated, `FETCH FIRST` sampling, `REGEXP_LIKE`, `EXPLAIN PLAN FOR` with the plan read from `DBMS_XPLAN`), `scopeLevel: schema`, lineage `partly`;
- operations `platform.version` (`product_component_version`) and `lineage.objects` (`all_dependencies`: views on tables and views, per bound schema).

**Pending, in the order it would be done:**
1. **Oracle through SQLcl** (was in POP2):
   - `oracle.yaml`'s access becomes SQLcl (`sql`), with JSON output (`SET SQLFORMAT JSON`) and its version detected (`sql -V`);
   - the statement reaches SQLcl through standard input, not as an argument;
   - **credentials need a design:** SQLcl reads no password from an environment variable, so `credentialEnv` stays empty. Options are `/nolog` with `CONNECT` sent through standard input, or a saved SQLcl connection or wallet that AutoDE only names (the `cli` resolver). It must keep the rule that a password is never on a command line or in a file of AutoDE's;
   - an `autode-oracle-*` skill: installing SQLcl (it needs Java), the saved connection or wallet, the privileges, troubleshooting.
2. **Oracle's estate as operations:** `estate.*` for Oracle over `ALL_TABLES`, `ALL_TAB_COLUMNS`, `ALL_CONSTRAINTS` and `ALL_CONS_COLUMNS`, `ALL_VIEWS`, `ALL_TAB_COMMENTS` and `ALL_COL_COMMENTS`, `ALL_OBJECTS.LAST_DDL_TIME`, and profiling. A golden test compares them with what the driver gives, node for node, and then `OracleAdapter` keeps only the connection.
3. **The driver path removed** once SQLcl works: the drivers folder, `driverStore.ts`, the *Install Oracle Driver*, *Verify Oracle Driver* and *Set Oracle Password* commands, `autode doctor`'s driver check and PLT-7's guided install (PLT-7 is then superseded). Until then PLT-7 stays live.
4. **Live checks not yet run:** manual-verification Part 54.1 (Oracle's plan from `DBMS_XPLAN`) and 54.2 (Oracle object lineage). Both are covered only by recorded-result tests.
5. **Later, if needed:** lineage beyond views (procedures and packages from `ALL_DEPENDENCIES`, reads from Unified Auditing; Oracle has no native column lineage); booleans as a version range once 23ai's `BOOLEAN` matters; **Oracle as a target** (its own backlog item).

**What doesn't change while it waits:** Oracle connections keep working as they do today, and its tests stay in `npm test`. `OracleAdapter` is in the allowed folder, so there is no architecture exception. POP4's catalog shows Oracle as it is: driver access, lineage `partly`. POP5's template doesn't need Oracle.

**Resume when:** an engagement needs Oracle sources, or the driver path becomes a support burden. Then specify these items as one phase, starting from this list.

### 6.3 POP4 — the operations and skills catalog (v0.57.0)

A place where anyone can see what AutoDE does on each platform and what it relies on, and adjust the skills behind it, with the same answers on the CLI and over MCP. It is the first step of the platform UI the owner plans, for technical and non-technical users alike.

**Its own view** (owner, 2026-10-29): *Platform catalog*, a tab of the unified AutoDE window that UI2 introduces, beside the Knowledge Explorer and the Workflow view. Each keeps its own view, reachable from one place. It is also opened from the Explorer's Estate view.

**Front page: the capability matrix.** Capabilities are rows; the workspace's systems are columns, grouped by category. Each cell is *supported*, *partly* (what is missing, for example a privilege) or *not applicable*, with the status on each bound connection. It answers the question people ask first: "can AutoDE read lineage from our Redshift, and what is missing?". Operations are one click deeper.

**A platform's page:** the same tabs for every system, with different contents. A tab that doesn't apply to its category is hidden, not shown empty (Collibra has no primitives).

| Tab | Shows |
|---|---|
| Overview | category, version range, connections bound and their readiness, the platform definition's origin (shipped or team) |
| Capabilities | each capability: supported, partly or not; its operations; its status per connection; the privilege missing |
| Operations | its operations by area and transport (the operation pages below) |
| Skills | bundled, team and vendor skills for it, with *Customise* (below) |
| Tools | CLIs, MCP servers and drivers: detected, installed, version, allowlisted commands |
| Primitives and dialect | which primitives compile for it and their golden-test status (warehouses and lakehouses) |
| Privileges | what AutoDE's role needs, per capability; *Request access* drafts a grant runbook for a person |
| Health | last runs, gaps and drift items |

**What a person can do here:**

| Area | Possibilities |
|---|---|
| See | the capability matrix; each system's configuration, versions, object kinds and privileges; what uses each operation and skill; health and drift |
| Update | edit operations, skills (*Customise* for AutoDE's), version ranges and capability mappings, all as reviewed drafts |
| Link | a skill to the operations and stages it uses; a vendor tool or MCP server to a platform, with its allowlisted commands; a capability to the AutoDE features that use it; primitives to a platform's dialect (shown with what compiles and is tested) |
| Test | try an operation; a **conformance run** per connection ("this account supports 9 of 11 capabilities; lineage needs a privilege"); run every recorded example |
| Govern | the review queue for team and agent proposals, with diffs and who approved; privilege requests |
| Onboard and share | POP5 (§6.5) |


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

**Skills in every host** (owner, 2026-10-29):
- **One rule:** a published team copy of a skill wins over AutoDE's bundled one. Every place AutoDE picks a skill uses it: stage assignments, the VS Code agent runs, MCP, the catalog.
- **Claude Code** reads skills as files from its plugin folder, so `autode plugin install` writes the skills in effect (team copies in place of bundled ones).
- `autode plugin status`, and a maintenance item, say when the installed plugin is behind: a team copy was published, or AutoDE's own version changed. Serving skills only over MCP was ruled out, because Claude Code picks a skill by reading its file.

**Surfaces:**
- the CLI: `autode platform operations [--platform p] [--uses <skill>]`, `autode platform operation <id>` (its page, with what relies on it), `autode skills show <id>` (with its operations), `autode skills customise <id>`, `autode skills reset <id>`, `autode skills lint <id>`, `autode plugin status`;
- MCP: `autode_platform_operations` with the same fields, and `autode_skills_list` with each skill's operations.

Acceptance:
- **Per platform:** the capability matrix and each platform's page come from its platform definition, with no platform-specific screen code. A fixture team platform appears with its own tabs; a catalog-category fixture hides the primitives tab. A conformance run on a fixture connection with a missing privilege shows *partly* and the privilege.
- **Traceable:** for every shipped operation, the view lists the skills and engine features that use it, and for every skill its operations. An operation nothing uses is flagged. Checked against a fixture where the answers are known.
- **Editable safely:** customising an AutoDE skill makes a team copy, the stage uses it only after it is published, and reset restores the bundled one. A later bundled change is flagged on the copy.
- **Checked:** a skill naming an unknown operation, or carrying SQL, is flagged in the editor and by `autode skills lint <id>` (new; `skills check` already probes external installs). A change operation can't run from the view.
- **For everyone:** every field has a label and a description. The view works by keyboard and screen reader (UI-4) and in VS Code's themes. Empty states say what to do next.
- **Parity:** the CLI and MCP give the same lists and pages as the view.
- **Every host:** after a team copy is published, `autode plugin status` reports the plugin behind; `autode plugin install` brings it up to date and Claude Code then loads the team copy.

### 6.4 POP3 — agent-proposed operations and drift detection (v0.58.0)

Scope:
- **Proposals:**
  - an agent that did something with a platform's CLI or a query no operation covers can propose an operation file (`autode_propose_platform_operation`; decision kind `platform_operation`);
  - the proposal must include a recorded example. AutoDE validates it (schema, guard, binding of the example) before a person sees it;
  - the person reviews it in the POP4 catalog, which shows the proposal beside the operations it resembles, and approves or rejects it;
  - approved, it becomes a team operation, and the skill that needed it can name it.
- **Drift:**
  - an operation failing on a platform version outside its range, or an error that says a view or column is missing, raises a maintenance item;
  - so does a platform reporting object kinds no operation reads (from POP2's estate reads);
  - the item names the operation, the platform version and the skill's owner, and is for the *platform maintainer*.
- **The platform maintainer** (a new role, owner 2026-10-29), apart from the knowledge engineer: the knowledge engineer curates business knowledge for data stewards, while this is platform knowledge that platform owners review.
  - It works at the propose tier: it reads the catalog, tries read operations, and proposes operation files and skill edits. It never publishes.
  - Its skills are a core skill on the operation format (recorded examples, version ranges, result mapping), plus the platform's own skills.
  - A platform owner reviews its proposals in the catalog.
- Proposals and drift items appear in the POP4 catalog, on the operation's page.

Acceptance:
- **Codified:** a proposal without a passing example is refused with the reason. An approved one runs deterministically through the executor, from the CLI with no model.
- **Noticed:** on a fixture platform version where a view is renamed, the failing operation raises one item; fixing the file closes it. An unread object kind raises one item.
- **Never silent:** drift never turns into an empty result; the gap stays visible until it is fixed or dismissed with a reason.

### 6.5 POP5 — onboarding new systems, and sharing them (v0.61.0)

Scope:
- **A new system from a template:** the steps are category, transports, access paths (CLI, API), connection fields, version detection, starter operations for the category's capabilities, then skills. It counts only once its recorded examples pass and a conformance run on a real connection is reviewed.
- **Redshift is already onboarded in POP2,** by hand; the template reproduces it as its first check. AtScale (`file`, `http`) and Collibra (`http`) then arrive through IMP1 and IMP3 on the same model, as platform definitions and operations, not special cases.
- **The `http` and `file` transports** run against live systems (fixtures from POP1).
- **Packs:** export a team's platform definitions, operations and skills as a pack for other workspaces; import one with the same review as a ported skill (PA4).

**What still needs code, said plainly in the wizard** (rare, and never per platform):
- a new generic sign-in method for API paths, beyond the fixed set (§2.1);
- a new compile dialect (pipeline SQL for Redshift), which is transform machinery driven by primitive definitions. The catalog shows and links dialect coverage; it doesn't create it.

Everything above that (what to read, how to map it, what to write) is files.

**Boundaries that stay:**
- writes to Collibra, Horizon or AtScale are runbooks a person approves, never a button that pushes;
- credentials are only references, never in a definition, an operation or the UI;
- no per-vendor screens: if a system needs its own layout, the model is missing a field.

Acceptance:
- **The template reproduces Redshift:** running it with Redshift's answers gives POP2's platform definition and operations.
- **Guided:** with the CLI missing, AutoDE says so and shows the skill's install and profile steps; with a browser-only profile, it says so instead of hanging.
- **Honest:** a template whose transport isn't available says which code is needed and stops; nothing half-onboarded runs.
- **Shareable:** a pack exported from one workspace and imported into another gives the same catalog after review.

## 7. Open questions for POP1

1. Where team-supplied operations are reviewed before they run: the skills' review lifecycle (PA4), or decisions.
2. Whether `autode_platform_run` needs a row limit and the sample-data consent (`allowSampleDataInPrompts`) for operations that return rows, not just metadata. Proposed: yes, the same rules as `autode_execute_query`.
3. Version detection: read the platform version once per connection and cache it, or per run.

## 8. Decided for the later phases (owner, 2026-10-29)

4. **The catalog is its own view,** a tab of the unified AutoDE window (UI2) beside the Knowledge Explorer and the Workflow view (§6.3).
5. **A published team copy of a skill wins everywhere;** `autode plugin install` writes the skills in effect for Claude Code, and `autode plugin status` says when it is behind (§6.3).
6. **A new platform maintainer role** at the propose tier, apart from the knowledge engineer (§6.4).
