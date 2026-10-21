# Workflow templates (reviewed 2026-10-21)

*Prework for the revised PA3 (docs/mcp-engine-requirements.md §9.2): the stage kinds and the three bundled templates, grounded in published practice. The owner reviewed it on 2026-10-21 (§5 records the answers). In PA3a these become `workflows/*.yaml` and the stage-kind catalogue in the engine.*

## How to read it

- A **template** is a stage catalogue for a category of engagement. The **planning stage** proposes the workflow for one problem from it. The engine checks the plan against the rules below, and a person approves it.
- **Inclusion:**
  - **mandatory**: always in the workflow, never skipped;
  - **default**: included unless the planner drops it with a reason;
  - **conditional**: included when its condition on the spec or estate holds, and skipped automatically otherwise (the condition is recorded);
  - **optional**: in the catalogue, but included only if the planner adds it with a reason.
- **Origin:** `template`, or `added` (a stage the planner introduced). An added stage must use a known stage kind and is flagged to the approver.
- **Dependencies:**
  - `after: X` waits for X to be completed; `after: X (approved)` waits for X to pass its approval gate.
  - `consumes` / `produces` name artifacts; the engine refuses a plan in which something consumed has no producer.
  - `repeat: per-source-system` fans out; `join: all | any` fans back in.
  - A changed approved output makes everything that consumed it **stale**. There are no loops: a stage is **re-opened** instead.
- **Gates:** `check` (automatic: validation, grounding, conformance) and `approve` (a person). The check runs before the approval.

## 1. Stage kinds

The kind decides who can do the stage, the most an agent may do there (permission ceiling: `read` < `propose` < `platform-read` < `workspace-write`; resolving or applying decisions is never included), what it consumes and produces, and its default gates. Templates and planners name stages freely but must use one of these kinds.

| Kind | Agent roles | Ceiling | Consumes | Produces | Default gates | Done when (check) |
|---|---|---|---|---|---|---|
| `specify` | business-analyst | propose | problem statement, chat, pack | spec | check, approve | spec validates; problem statement confirmed |
| `plan` | planner | propose | spec, template, estate summary | workflow instance (stages, tasks, agents) | check, approve | the plan passes the template rules (mandatory stages and gates present, producers exist, acyclic) |
| `target-context` | target-architect | propose | spec | target context | check, approve | the context is complete (all fixed questions answered) |
| `source-assessment` | source-assessor | platform-read | spec, connections or files | estate entries, source context, profiles | check, approve | the sources' schemas are in the estate; the context is complete |
| `conformance` | source-assessor | platform-read | pack contracts, estate, samples | conformance report, `needs_review` facts | check | the report exists; failures are raised as facts or decisions |
| `quality-rules` | source-assessor, data-modeler | propose | spec, contracts, profiles | quality expectations (facts) | approve | every critical attribute has a rule or a recorded reason |
| `mapping` | sttm-mapper | propose | source context, target context, vocabulary | mapping context | check, approve | the mappings ground against the estate; every target column is mapped or justified |
| `entity-resolution` | sttm-mapper, data-modeler | propose | source contexts (several), mapping | match keys, survivorship rules, conformed dimensions | check, approve | every merged entity has match and survivorship rules |
| `modelling` | data-modeler | propose | spec, mapping, keys and grain facts | data model | check, approve | the model validates; grain and keys are stated |
| `code-conversion` | pipeline-engineer | workspace-write | legacy code, converter output (SnowConvert, Lakebridge …) | converted code, gaps list | check, approve | the converted code is grounded; gaps are listed |
| `build` | pipeline-engineer | workspace-write | model, mapping, Pipeline Spec | Pipeline Spec, artifacts with grounding manifests | check, approve | it compiles; there are no unresolved references |
| `reconcile` | source-assessor, pipeline-engineer | platform-read | source and target connections, mapping | reconciliation report (counts, sums, checksums by key) | check, approve | agreed tolerances are met, or the differences are explained |
| `validate` | documenter, pipeline-engineer | platform-read | artifacts, quality rules | test results, grounding report | check, approve | the tests pass and the acceptance criteria are traced |
| `deploy` | pipeline-engineer | propose | approved artifacts | platform-change decisions (run, cut over, roll back) | approve (platform change) | the changes are applied by an `--allow-write` server after approval |
| `document` | documenter | workspace-write | everything above | design and operations docs | check | the docs are generated and linked to their artifacts |
| `platform-setup` | target-architect | propose | target context, spec | environment and security plan (accounts, networking, roles and grants, mapped from the source's security model); platform-change proposals | approve | the plan covers every environment in the estate; changes run only as approved decisions |
| `bi-migration` | documenter, data-modeler | read | estate, model, mapping | inventory of reports and semantic objects, the mapping of their fields to the new model, a migration plan | approve | every report in scope is mapped or listed as a gap |

*Five kinds beyond the twelve first discussed:*
- `quality-rules` (a distinct step in published migration methods);
- `entity-resolution` (matching and survivorship in consolidation);
- `code-conversion` (modernisation imports a converter's output; AutoDE doesn't convert code itself, per the 2026-10-15 decision);
- `platform-setup` and `bi-migration`, two phases in the Snowflake and Databricks guides. In AutoDE they produce plans, documents and proposals only; the platform work itself runs as approved platform changes, and report tools are outside AutoDE.

## 2. Greenfield

*Basis:* the Kimball Lifecycle (requirements, dimensional modelling, physical design, ETL design, deployment, growth), which is the most widely used delivery method for a new warehouse.

| Stage | Kind | Inclusion | After | Notes |
|---|---|---|---|---|
| Business problem and spec | specify | mandatory | — | Fixed first stage. |
| Plan | plan | mandatory | spec (approved) | Fixed second stage; its output is the rest of this workflow. |
| Target context | target-context | mandatory | plan (approved) | |
| Source assessment | source-assessment | default, per source system | plan (approved) | Greenfield still has sources, often new feeds or files. |
| Quality rules | quality-rules | default | sources | |
| Mapping | mapping | mandatory | sources (approved), target (approved) | |
| Data model | modelling | mandatory | mapping (approved) | Kimball puts modelling before ETL design; here mapping and model can be drafted together, but the model's approval follows mapping. |
| Build | build | mandatory | model (approved) | |
| Validate | validate | default | build | |
| Environment and security | platform-setup | optional | target (approved) | Plan and proposals only. |
| BI and reports | bi-migration | optional | model (approved) | Plan and field mapping only. |
| Deploy | deploy | optional | validate (approved) | |
| Document | document | default | build | |

## 3. Modernization (previously brownfield; legacy migration)

*Basis:*
- Snowflake's migration guides: nine phases, from planning and design and environment and security through code conversion, data migration and ingestion, reporting, validation and deployment.
- Databricks' EDW migration guide: discovery and assessment, architecture and planning, warehouse migration, stored procedures and ETL, BI integration, validation.
- Practical Data Migration (PDMv2, BCS): landscape analysis, gap analysis and mapping, migration design and execution, data quality rules, legacy decommissioning.

All three put *assess, then design and map, then convert or build, then reconcile and validate, then cut over* in that order. All three treat reconciliation against the legacy system as a requirement, not an extra.

| Stage | Kind | Inclusion | After | Notes |
|---|---|---|---|---|
| Business problem and spec | specify | mandatory | — | |
| Plan | plan | mandatory | spec (approved) | Migration waves are tasks within the later stages. |
| Landscape assessment | source-assessment | mandatory, per source system | plan (approved) | PDM's landscape analysis; Snowflake and Databricks discovery. |
| Target context | target-context | mandatory | plan (approved) | |
| Contract conformance | conformance | conditional `when: pack.has_contract` | sources | |
| Quality rules | quality-rules | default | sources | PDM's data quality rules. |
| Mapping (gap analysis) | mapping | mandatory | sources (approved), target (approved) | PDM's gap analysis and mapping. |
| Code conversion | code-conversion | conditional `when: estate.has_legacy_code` | sources | Imports converter output. |
| Data model | modelling | default | mapping (approved) | Lift-and-shift may drop it (with a reason); re-architecture keeps it. |
| Build | build | mandatory | mapping (approved); model (approved) when present | |
| Reconcile | reconcile | mandatory | build | Legacy against new, by key: counts, sums, checksums. |
| Validate | validate | mandatory | reconcile | Includes acceptance checks. |
| Environment and security | platform-setup | optional | target (approved) | Snowflake's environment and security phase; maps the source's security model. |
| BI and reports | bi-migration | optional | mapping (approved); model (approved) when present | Snowflake's reporting phase; Databricks' BI integration. |
| Deploy / cutover | deploy | default | validate (approved) | Final incremental load, switch-over, rollback plan. |
| Decommission plan | document | optional | deploy | PDM's legacy decommissioning, as a plan; switching off a system is outside AutoDE. |
| Document | document | default | build | |

## 4. Estate merge (consolidation)

*Basis:* master data consolidation practice as described by MDM vendors (SAP MDG consolidation, Reltio, Profisee, Software AG): profiling, standardisation, matching, survivorship (best record), then distribution. Conformed dimensions (Kimball) serve the analytical side.

| Stage | Kind | Inclusion | After | Notes |
|---|---|---|---|---|
| Business problem and spec | specify | mandatory | — | |
| Plan | plan | mandatory | spec (approved) | |
| Source assessment | source-assessment | mandatory, per source system, `join: all` | plan (approved) | Profiling of each source. |
| Target context | target-context | mandatory | plan (approved) | |
| Contract conformance | conformance | conditional `when: pack.has_contract` | sources | Shared contracts are common in mergers. |
| Quality and standardisation rules | quality-rules | mandatory | sources | Standardisation before matching. |
| Mapping | mapping | mandatory, per source system | sources (approved), target (approved) | |
| Entity resolution | entity-resolution | mandatory | mapping (approved, all sources) | Matching, survivorship, conformed dimensions. |
| Data model | modelling | mandatory | entity-resolution (approved) | |
| Build | build | mandatory | model (approved) | |
| Reconcile | reconcile | mandatory | build | Each source against the merged result: no record lost or duplicated beyond the survivorship rules. |
| Validate | validate | default | reconcile | |
| Environment and security | platform-setup | optional | target (approved) | |
| BI and reports | bi-migration | optional | model (approved) | Reports from several sources onto the merged model. |
| Deploy | deploy | optional | validate (approved) | |
| Document | document | default | build | |

## 5. Review decisions (owner, 2026-10-21)

1. Keep `quality-rules`, `entity-resolution` and `code-conversion` as kinds.
2. Reconciliation is mandatory in modernization and estate merge.
3. The data model is default, not mandatory, in modernization: a lift-and-shift can drop it, with a reason.
4. Environment and security setup, and BI and report migration, are optional stages (`platform-setup`, `bi-migration`) that produce plans, documents and proposals only.
5. Migration waves are tasks inside stages, not stages.

## Sources

- Snowflake migration guides: [Oracle](https://docs.snowflake.com/migrations/guides/oracle), [Amazon Redshift](https://docs.snowflake.com/migrations/guides/redshift), [Azure Synapse](https://docs.snowflake.com/migrations/guides/azuresynapse), [SQL Server](https://docs.snowflake.com/migrations/guides/sqlserver), [Databricks](https://docs.snowflake.com/migrations/guides/databricks)
- Databricks: [Netezza to Databricks migration guide](https://www.databricks.com/sites/default/files/2025-05/databricks-migration-guide-netezza-fa.pdf), [How Databricks simplifies data warehouse migrations](https://databricks.com/blog/how-databricks-simplifies-data-warehouse-migrations-proven-strategies-and-tools), [Migrating to a lakehouse without breaking AI models](https://answers.databricks.com/migrate-data-lake-warehouse-to-lakehouse-without-breaking-ai-models)
- Kimball: [The Data Warehouse Lifecycle Toolkit (O'Reilly)](https://www.oreilly.com/library/view/the-data-warehouse/9780470149775/chapter-13.html), [Kimball Group](https://www.kimballgroup.com/?p=16145)
- Practical Data Migration: [BCS](https://www.bcs.org/books/datamigration), [Data migration and SAP methodology (BCS)](https://www.bcs.org/articles-opinion-and-research/data-migration-sap-methodology/)
- Consolidation and MDM: [SAP MDG consolidation (ASUG)](https://www.asug.com/events/eim-sap-master-data-governance-consolidation-overview), [Reltio match, merge and survivorship](https://docs.reltio.com/objectives/resolve-potential-matches/potential-matching-at-a-glance/potential-matching-navigation/reltio-match-merge-and-survivorship), [Profisee golden record management](https://profisee.com/platform/golden-record-management?menu=hide), [Software AG MDM consolidation](https://documentation.softwareag.com/webmethods/compendiums/v10-5/C_Master_Data_Management/mdm_compendium/to-overview_3.html)
