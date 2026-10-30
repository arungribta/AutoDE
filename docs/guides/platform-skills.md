# Platform skills

AutoDE has its own Snowflake, Databricks and Redshift skills, plus dbt and reconciliation. They work with no vendor skill installed. This page covers:
- what the skills do and when a stage gets them;
- how they are tested;
- how they work with the vendors' skills;
- how AutoDE keeps agents from changing a platform directly.

The full list, with versions and the roles that use each skill, is in [skills.md](skills.md). That file is generated from the skills' own files.

## The skills

| Skill | Stages | What it covers |
|---|---|---|
| `autode-snowflake-ingestion` | build, platform-setup | File formats; stages on a storage integration; raw landing tables that mirror the estate; `COPY INTO`; Snowpipe |
| `autode-snowflake-pipelines` | build | Dynamic tables (`TARGET_LAG`, incremental refresh); streams and tasks running the compiled MERGE |
| `autode-snowflake-governance` | platform-setup | Database roles and future grants; masking policies (tag-based too); row access policies; tags |
| `autode-snowflake-performance` | build, platform-setup | Warehouses per workload (auto-suspend, timeouts); clustering keys only on evidence |
| `autode-snowflake-deployment` | deploy | Idempotent DDL in order; a zero-copy clone before data-losing changes; `snow dbt deploy`; dev, then production |
| `autode-databricks-ingestion` | build, platform-setup | Unity Catalog volumes and external locations; Delta landing tables; idempotent `COPY INTO`; Auto Loader (`read_files`) |
| `autode-databricks-pipelines` | build | Lakeflow Declarative Pipelines: streaming tables, `AUTO CDC`, expectations from the quality rules, all in a bundle with its schedule |
| `autode-databricks-governance` | platform-setup | Grants to groups (inherited from catalog and schema); column masks; row filters; tags |
| `autode-databricks-performance` | build, platform-setup | Liquid clustering; predictive optimization or scheduled `OPTIMIZE`; `VACUUM` with a retention that keeps time travel |
| `autode-databricks-deployment` | deploy | Bundles: dev and prod targets, `run_as` a service principal in production, validate as the dry run |
| `autode-redshift-deployment` | platform-setup, source-assessment, target-context | Reaching Redshift (preview): the AWS CLI, the three sign-ins (Secrets Manager secret, IAM temporary credentials, AWS identity), the reads' privileges, troubleshooting. Deploying comes in 0.55.2 |
| `autode-redshift-ingestion` | source-assessment, build | Redshift as a source (preview): the estate through its operations and what its gaps mean; moving data out with `UNLOAD` to S3 as Parquet |
| `autode-redshift-performance` | source-assessment, modelling | Reading distribution and sort keys, skew, unsorted share and stale statistics (`performance.table_design`) into the assessment and the new design (preview) |
| `autode-redshift-governance` | source-assessment, platform-setup | Reading privileges and masking policies (`governance.relation_privileges`, `governance.masking_policies`) into personas and personal-data rules (preview) |
| `autode-redshift-pipelines` | source-assessment, code-conversion | Finding stored procedures, materialized views and logic-bearing views (`pipelines.*`) and what schedules them, for code conversion (preview) |
| `autode-dbt-project` | build | Sources with freshness; staging models compiled by AutoDE; incremental marts; data tests from the quality rules (Snowflake or Databricks) |
| `autode-de-reconciliation` | reconcile | Source against target, read-only: counts, distinct keys, sums, ranges, null counts; key hashes on one platform; missing keys on one connection |

AutoDE wrote these from the vendors' public documentation. They contain no vendor skill text. The Redshift skills name platform operations rather than carry SQL (CLAUDE.md), and are *preview* until checked on a live account: building for Redshift comes with Redshift as a target (0.55.2).

## When a stage gets them

A stage's assignment includes the skills that match two things:
- the stage's **kind**;
- the problem's **target platform**, taken from its target context.

The dbt skill also needs the target context's **transformation tool** to be dbt.

| Stage kind | Role | Skills on Snowflake (Databricks is the same pattern) |
|---|---|---|
| platform-setup | target architect | governance, performance, ingestion (storage access) |
| build | pipeline engineer | pipeline build, ingestion, pipelines, performance; dbt when chosen |
| deploy | pipeline engineer | deployment |
| reconcile | source assessor | reconciliation |

A problem with no target context gets no platform skills. A platform-setup stage on a platform AutoDE has no skills for is left to a person (the Workflow view says so).

## How they change a platform

None of these skills runs a platform command. Each writes a **runbook**: one SQL statement, allowlisted CLI command or Databricks bundle per step. Each step has what it is expected to do and a rollback. Then:
- the engine classifies every step itself (read, change, destructive);
- a person approves the runbook under the team's policy (production needs a named approver);
- AutoDE's runner runs it step by step, with dry runs and a hash-chained log.

See the runner in [mcp-engine.md](../specs/mcp-engine.md) §9.2 PA3 §8a. The skills add to the engine's checks:
- **Dialect:** a runbook step whose SQL carries another platform's constructs (`OPTIMIZE` on Snowflake, `TARGET_LAG` on Databricks …) gets a warning before anyone approves it.
- **`VACUUM` is destructive:** it deletes the files that time travel and a restore need, so its step needs a rollback or a stated reason.
- **The allowlist** adds `snow dbt list | deploy | execute`, `databricks pipelines list-pipelines | get | start-update` and `databricks bundle summary`. A team adds its own commands under `runbooks.allowCommands` in `.autode/config/approvals.yaml`.

Reconciliation only reads. Its queries come from `autode_reconcile_plan`, which generates them deterministically; the skill tells the agent not to edit them.

## The guard hook

In Claude Code, AutoDE's plugin carries a `PreToolUse` hook (`hooks/hooks.json`, which runs `autode hook guard`). Before the host runs a shell command for its agent, the hook looks for every `snow` and `databricks` invocation in it, however it is chained, wrapped (`bash -c`, `sudo`, `npx`) or quoted, and blocks those that change a platform. The agent is told to propose a runbook instead.

What passes:
- reads: list, get, describe, validate, `snow sql` whose statements only read;
- local setup: `snow connection`, `databricks auth`, `bundle init`;
- help.

What is blocked:
- anything else;
- anything the guard can't check: `snow sql` from a file it can't open, or from the terminal.

Where you get it:
- **Claude Code:** `autode plugin path` builds the plugin folder with the hook. `autode plugin install --host claude` adds it to `.claude/settings.json` (or `~/.claude/settings.json` with `--scope user`) and keeps the team's own hooks. Claude Code shows new hooks for review under `/hooks`.
- **Cortex Code:** it reads the same plugin layout. Copying skills into `.cortex/skills` alone doesn't bring the hook.
- **GitHub Copilot CLI and hosts without hooks:** the rule is stated in the skills and role templates, and is a convention, not a guarantee.

The guard checks the agent's mistakes; it isn't a sandbox. A Python script that calls a connector directly doesn't name the CLI, so the guard doesn't see it. The real boundary is the platform's own permissions: give agents' credentials read-only roles.

## Vendor skills

AutoDE references the vendors' skills and never copies them:
- the Databricks agent skills are under the Databricks License, which doesn't allow redistribution;
- Cortex Code's built-in skills run only inside Cortex Code.

The [catalog](skills.md) lists them, with each one's licence and the stages it helps with.

- **Installed in the host:** the assignment names them ("Vendor skills installed in this host"), and AutoDE's rules still apply.
- **Not installed:** the assignment lists the ones that would help, and says the person installs them (`autode skills install <name>` in a terminal, or the Skills view). The agent never installs anything. Install commands are probed before they are offered, and run only after the person confirms.

## How each skill is tested

Each skill's `SKILL.md` ends with a worked example on the reference problem (retail orders, `test/reference/retail-orders/`). `test/platformSkillCheck.cjs` checks every example:
- **grounding:** its SQL reads only tables and columns in the reference estate, objects the examples create, the model's planned tables, or the platforms' own catalog views;
- **dialect:** no other platform's markers, and one statement at a time where a runbook runs it;
- **landing tables:** a table marked `-- lands <table>` has exactly the estate table's columns, plus `_`-prefixed load columns;
- **runbooks:** they pass the engine's checks with no dialect warning, on a connection of the skill's platform;
- **bundles:** `bundle.name`, targets, and every `${var.…}` declared;
- **dbt sources:** every source table and column is in the estate;
- **reconciliation:** the example's SQL is exactly what `autode_reconcile_plan` generates.

`npm test` runs the check, together with broken copies of the examples it must reject. Run it on its own after `npm run compile` with `node test/platformSkillCheck.cjs`.

The check proves the examples are consistent with the estate and with AutoDE's engine. It doesn't run them on a live platform: that is [manual-verification.md](../testing/manual-verification.md) Part 36.

## Changing a skill

1. Edit its `SKILL.md`, and bump `metadata.version`.
2. Keep the worked example passing `node test/platformSkillCheck.cjs`.
3. Run `npm run docs:generate` to update [skills.md](skills.md).

A team overrides a skill by importing its own version (PA4). AutoDE's copy stays as shipped.
