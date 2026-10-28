---
name: autode-databricks-governance
description: Govern an AutoDE business problem's Databricks objects in Unity Catalog - grants to groups on catalogs and schemas (inherited by tables), column masks for personal data, row filters and tags - from the specification's constraints and the estate's personal-data columns, as a runbook a person approves. Use it in the platform-setup stage when the target platform is Databricks.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_propose_assertion, mcp__autode__autode_list_connections, mcp__autode__autode_check_grounding, mcp__autode__autode_propose_runbook, mcp__autode__autode_runbook_status, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: databricks
  stageKinds: [platform-setup]
  platforms: [databricks]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Databricks governance

Written by AutoDE from Databricks' public documentation (Unity Catalog privileges, row filters and column masks, tags). Governance changes who can see what: every change is a runbook, and production needs a named approver.

## 1. What has to be protected, and for whom

- **The specification's constraints** (`autode_get_context_pack`, purpose `plan`): regulations, consumers, data residency.
- **Personal data:** columns the estate marks as personal, and facts about them (`autode_list_assertions`). A personal-data column with no masking decision is a gap. Propose it as a fact for the stakeholder; never decide it yourself.
- **Consumers:** the account groups that read the marts, from the target context or the stakeholder.

## 2. The patterns

- **Grant to groups, never to users.** Privileges are inherited downwards in Unity Catalog:
  - `USE CATALOG` on the catalog and `USE SCHEMA` on the schema are needed to reach anything;
  - `SELECT` on a **schema** covers its tables and views, today's and future ones.
  Grant at the lowest level that covers the need.
- **Ownership:** a group or a service principal owns production objects (`ALTER … OWNER TO`), not a person.
- **Column masks** are SQL UDFs in a `governance` schema, attached with `ALTER TABLE … ALTER COLUMN … SET MASK`. Use `is_account_group_member('<group>')` to decide who sees clear values.
- **Row filters** are boolean UDFs attached with `ALTER TABLE … SET ROW FILTER <function> ON (<column>)`.
- **Tags** classify columns (`SET TAGS ('pii' = 'email')`). Where the workspace has governed tags and attribute-based policies, a policy on the tag can replace per-column masks. Name that as an option for the stakeholder.
- **AutoDE's own tags** (`key=value`, from its metadata model): read them with `autode_get_asset_context` (or `autode_search_assets`, facet tag), and apply them as they are recorded: `ALTER TABLE … SET TAGS ('key' = 'value')` or `ALTER TABLE … ALTER COLUMN … SET TAGS (…)`. Don't invent tags that AutoDE doesn't record; propose them as facts instead.

Classification: `GRANT`, `SET MASK` and `SET ROW FILTER` are changes. `REVOKE`, `DROP` and `CREATE OR REPLACE` are destructive and need a rollback. Create functions with `IF NOT EXISTS`. Masks and filters need compute that supports them (a SQL warehouse, or serverless). Say so if the consumers use something else.

## 3. Propose the runbook and record the design

- `autode_propose_runbook` on the target connection, stage `platform-setup`. Order: schema, functions, grants, tags, then masks and filters last.
- `autode_record_artifact`: `governance/grants_and_policies.sql` and an access matrix (group, objects, masked or filtered), which the documenter reuses.

## Worked example (the reference problem: retail orders)

Analysts read the marts. Email is masked except for `pii_readers`. UK analysts see only British customers.

```sql
CREATE SCHEMA IF NOT EXISTS retail_dev.governance;

CREATE FUNCTION IF NOT EXISTS retail_dev.governance.mask_email(email STRING)
RETURNS STRING
RETURN CASE WHEN is_account_group_member('pii_readers') THEN email ELSE regexp_replace(email, '^.*@', '***@') END;

CREATE FUNCTION IF NOT EXISTS retail_dev.governance.customer_country_filter(country_code STRING)
RETURNS BOOLEAN
RETURN is_account_group_member('global_analysts') OR (is_account_group_member('uk_analysts') AND country_code = 'GB');

GRANT USE CATALOG ON CATALOG retail_dev TO `analysts`;

GRANT USE SCHEMA, SELECT ON SCHEMA retail_dev.marts TO `analysts`;

ALTER TABLE retail_dev.marts.dim_customer ALTER COLUMN email SET TAGS ('pii' = 'email');

ALTER TABLE retail_dev.marts.dim_customer ALTER COLUMN email SET MASK retail_dev.governance.mask_email;

ALTER TABLE retail_dev.marts.dim_customer SET ROW FILTER retail_dev.governance.customer_country_filter ON (country_code);
```

```yaml runbook
id: marts-governance
title: Read access, email masking and country filtering for the marts
reason: The specification restricts customer email to PII readers and British customers' rows to the UK analysts; analysts need read access to the marts.
connectionId: databricks:lakehouse_dev
stage: platform-setup
explanation: Grants the analysts group read access to the marts schema, inherited by its tables. Masks dim_customer.email except for pii_readers and tags it as personal data. Filters dim_customer rows so UK analysts see only GB customers and global analysts see all.
steps:
  - id: governance-schema
    title: Schema retail_dev.governance
    kind: sql
    sql: CREATE SCHEMA IF NOT EXISTS retail_dev.governance
    expect: The schema exists.
  - id: mask-function
    title: Email mask function
    kind: sql
    sql: "CREATE FUNCTION IF NOT EXISTS retail_dev.governance.mask_email(email STRING) RETURNS STRING RETURN CASE WHEN is_account_group_member('pii_readers') THEN email ELSE regexp_replace(email, '^.*@', '***@') END"
    expect: The function exists, used by no table yet.
  - id: filter-function
    title: Country row filter function
    kind: sql
    sql: "CREATE FUNCTION IF NOT EXISTS retail_dev.governance.customer_country_filter(country_code STRING) RETURNS BOOLEAN RETURN is_account_group_member('global_analysts') OR (is_account_group_member('uk_analysts') AND country_code = 'GB')"
    expect: The function exists, used by no table yet.
  - id: grant-catalog
    title: Analysts may use the catalog
    kind: sql
    sql: GRANT USE CATALOG ON CATALOG retail_dev TO `analysts`
    expect: analysts can reach the catalog.
    rollback:
      steps:
        - id: revoke-catalog
          title: Revoke catalog use
          kind: sql
          sql: REVOKE USE CATALOG ON CATALOG retail_dev FROM `analysts`
          expect: analysts can no longer reach the catalog.
  - id: grant-marts
    title: Analysts read the marts schema
    kind: sql
    sql: GRANT USE SCHEMA, SELECT ON SCHEMA retail_dev.marts TO `analysts`
    expect: analysts read every table in marts, including later ones.
    rollback:
      steps:
        - id: revoke-marts
          title: Revoke read on the marts
          kind: sql
          sql: REVOKE USE SCHEMA, SELECT ON SCHEMA retail_dev.marts FROM `analysts`
          expect: analysts no longer read the marts.
  - id: tag-email
    title: Tag dim_customer.email as personal data
    kind: sql
    sql: ALTER TABLE retail_dev.marts.dim_customer ALTER COLUMN email SET TAGS ('pii' = 'email')
    expect: The column carries the pii tag.
  - id: mask-email
    title: Mask dim_customer.email
    kind: sql
    sql: ALTER TABLE retail_dev.marts.dim_customer ALTER COLUMN email SET MASK retail_dev.governance.mask_email
    expect: Analysts see ***@domain; pii_readers see the address.
    rollback:
      steps:
        - id: unmask-email
          title: Remove the mask
          kind: sql
          sql: ALTER TABLE retail_dev.marts.dim_customer ALTER COLUMN email DROP MASK
          expect: The column is no longer masked.
  - id: filter-customers
    title: Filter dim_customer by country
    kind: sql
    sql: ALTER TABLE retail_dev.marts.dim_customer SET ROW FILTER retail_dev.governance.customer_country_filter ON (country_code)
    expect: uk_analysts see only GB customers; global_analysts see all.
    rollback:
      procedure: ALTER TABLE retail_dev.marts.dim_customer DROP ROW FILTER (a person runs it; every reader then sees every row).
```
