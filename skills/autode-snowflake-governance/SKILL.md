---
name: autode-snowflake-governance
description: Govern an AutoDE business problem's Snowflake objects - access roles and grants (including future grants), masking policies for personal data, row access policies and tags - from the specification's constraints and the estate's personal-data columns, as a runbook a person approves. Use it in the platform-setup stage when the target platform is Snowflake.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_propose_assertion, mcp__autode__autode_list_connections, mcp__autode__autode_check_grounding, mcp__autode__autode_propose_runbook, mcp__autode__autode_runbook_status, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
metadata:
  scope: snowflake
  stageKinds: [platform-setup]
  platforms: [snowflake]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Snowflake governance

Written by AutoDE from Snowflake's public documentation (access control, masking policies, row access policies, object tagging). Governance changes who can see what: every change is a runbook, and production needs a named approver.

## 1. What has to be protected, and for whom

- **The specification's constraints** (`autode_get_context_pack`, purpose `plan`): regulations, who the consumers are, data that must not leave a region.
- **Personal data:** columns the estate marks as personal (email, phone, names, addresses) and facts about them (`autode_list_assertions`). A personal-data column with no masking decision is a gap. Propose it as a fact for the stakeholder; never decide it yourself.
- **Consumers:** the roles that read the marts (analysts, BI service users), from the target context or the stakeholder. Unknown consumers are a question, not a guess.

## 2. The patterns

- **Access roles (database roles) hold privileges; functional roles hold access roles.** Create a database role per access level (`marts_read`, `marts_write`). Grant it `USAGE` on the schema and `SELECT` on all and **future** tables, then grant the database role to the account role that people use. Never grant to users directly, and never to `PUBLIC`.
- **Ownership** stays with the deployment role, not a person.
- **Masking policies** are written once in a `governance` schema and attached to columns, or to a tag (tag-based masking, so a newly tagged column is masked without a new runbook). Use `IS_ROLE_IN_SESSION('<role>')` for who may see clear values.
- **Row access policies** restrict rows by a column (country, business unit) through a mapping table of role to allowed values. Attach one with `ADD ROW ACCESS POLICY … ON (column)`.
- **Tags** classify columns (`pii = 'email'`) so audits and policies can find them.
- **AutoDE's own tags** (`key=value`, from its metadata model): read them with `autode_get_asset_context` (or `autode_search_assets`, facet tag), and apply them as they are recorded: create each tag once in the `governance` schema (`CREATE TAG IF NOT EXISTS`), then `ALTER TABLE … SET TAG` or `ALTER TABLE … MODIFY COLUMN … SET TAG`; a tag without a value is set to `''`. Don't invent tags that AutoDE doesn't record; propose them as facts instead.

Classification: `GRANT` and the policy statements are changes. `REVOKE`, `DROP` and `CREATE OR REPLACE` are destructive and need a rollback (the grant that restores access). Policies are created with `IF NOT EXISTS`. Changing a policy body later is `ALTER MASKING POLICY … SET BODY`, which takes effect at once.

## 3. Propose the runbook and record the design

- `autode_propose_runbook` on the target connection, stage `platform-setup`. Order: schema and mapping table, then roles, grants, policies, tags, and the attachments last.
- `autode_record_artifact`: the SQL file (`governance/grants_and_policies.sql`) and a short access matrix (role, objects, what is masked or filtered), which the documenter reuses.

## Worked example (the reference problem: retail orders)

Analysts read the marts. Customer email is masked except for the `pii_reader` role. Each analyst role sees only its countries.

```sql
CREATE SCHEMA IF NOT EXISTS governance;

CREATE TABLE IF NOT EXISTS governance.country_access (
  role_name VARCHAR(100),
  country_code VARCHAR(2)
);

CREATE DATABASE ROLE IF NOT EXISTS marts_read;

GRANT USAGE ON SCHEMA marts TO DATABASE ROLE marts_read;

GRANT SELECT ON ALL TABLES IN SCHEMA marts TO DATABASE ROLE marts_read;

GRANT SELECT ON FUTURE TABLES IN SCHEMA marts TO DATABASE ROLE marts_read;

GRANT DATABASE ROLE marts_read TO ROLE analyst;

CREATE MASKING POLICY IF NOT EXISTS governance.mask_email AS (val VARCHAR) RETURNS VARCHAR ->
  CASE WHEN IS_ROLE_IN_SESSION('PII_READER') THEN val ELSE REGEXP_REPLACE(val, '.+@', '*****@') END;

CREATE TAG IF NOT EXISTS governance.pii ALLOWED_VALUES 'email', 'phone', 'name';

ALTER TABLE marts.dim_customer MODIFY COLUMN email SET TAG governance.pii = 'email';

ALTER TABLE marts.dim_customer MODIFY COLUMN email SET MASKING POLICY governance.mask_email;

CREATE ROW ACCESS POLICY IF NOT EXISTS governance.by_country AS (country_code VARCHAR) RETURNS BOOLEAN ->
  IS_ROLE_IN_SESSION('GLOBAL_ANALYST')
  OR EXISTS (SELECT 1 FROM governance.country_access a WHERE IS_ROLE_IN_SESSION(a.role_name) AND a.country_code = country_code);

ALTER TABLE marts.dim_customer ADD ROW ACCESS POLICY governance.by_country ON (country_code);
```

```yaml runbook
id: marts-governance
title: Read access, email masking and country filtering for the marts
reason: The specification restricts customer email to the PII reader role and customer rows to each analyst's countries; analysts need read access to the marts.
connectionId: snowflake:analytics_dev
stage: platform-setup
explanation: Creates a read database role for the marts and grants it to analysts, masks dim_customer.email except for PII_READER, tags it as personal data, and filters dim_customer rows by country through governance.country_access.
steps:
  - id: governance-schema
    title: Governance schema
    kind: sql
    sql: CREATE SCHEMA IF NOT EXISTS governance
    expect: The schema exists.
  - id: country-access
    title: Role-to-country mapping table
    kind: sql
    sql: CREATE TABLE IF NOT EXISTS governance.country_access (role_name VARCHAR(100), country_code VARCHAR(2))
    expect: An empty mapping table; the data owner fills it.
  - id: read-role
    title: Database role marts_read
    kind: sql
    sql: CREATE DATABASE ROLE IF NOT EXISTS marts_read
    expect: The database role exists.
  - id: grant-usage
    title: Usage on the marts schema
    kind: sql
    sql: GRANT USAGE ON SCHEMA marts TO DATABASE ROLE marts_read
    expect: marts_read can see the schema.
    rollback:
      steps:
        - id: revoke-usage
          title: Revoke usage
          kind: sql
          sql: REVOKE USAGE ON SCHEMA marts FROM DATABASE ROLE marts_read
          expect: marts_read no longer sees the schema.
  - id: grant-select
    title: Select on today's tables
    kind: sql
    sql: GRANT SELECT ON ALL TABLES IN SCHEMA marts TO DATABASE ROLE marts_read
    expect: marts_read can read every table in marts.
  - id: grant-future
    title: Select on future tables
    kind: sql
    sql: GRANT SELECT ON FUTURE TABLES IN SCHEMA marts TO DATABASE ROLE marts_read
    expect: Tables created in marts later are readable too.
  - id: grant-to-analyst
    title: Give analysts the read role
    kind: sql
    sql: GRANT DATABASE ROLE marts_read TO ROLE analyst
    expect: The analyst role reads the marts.
    rollback:
      steps:
        - id: revoke-from-analyst
          title: Take the read role back
          kind: sql
          sql: REVOKE DATABASE ROLE marts_read FROM ROLE analyst
          expect: Analysts lose read access to the marts.
  - id: mask-email-policy
    title: Email masking policy
    kind: sql
    sql: "CREATE MASKING POLICY IF NOT EXISTS governance.mask_email AS (val VARCHAR) RETURNS VARCHAR -> CASE WHEN IS_ROLE_IN_SESSION('PII_READER') THEN val ELSE REGEXP_REPLACE(val, '.+@', '*****@') END"
    expect: The policy exists, attached to nothing yet.
  - id: pii-tag
    title: Personal-data tag
    kind: sql
    sql: CREATE TAG IF NOT EXISTS governance.pii ALLOWED_VALUES 'email', 'phone', 'name'
    expect: The tag exists.
  - id: tag-email
    title: Tag dim_customer.email
    kind: sql
    sql: ALTER TABLE marts.dim_customer MODIFY COLUMN email SET TAG governance.pii = 'email'
    expect: The column carries pii = email.
  - id: mask-email
    title: Mask dim_customer.email
    kind: sql
    sql: ALTER TABLE marts.dim_customer MODIFY COLUMN email SET MASKING POLICY governance.mask_email
    expect: Analysts see *****@domain; PII_READER sees the address.
    rollback:
      steps:
        - id: unmask-email
          title: Remove the masking policy
          kind: sql
          sql: ALTER TABLE marts.dim_customer MODIFY COLUMN email UNSET MASKING POLICY
          expect: The column is no longer masked.
  - id: country-policy
    title: Country row access policy
    kind: sql
    sql: "CREATE ROW ACCESS POLICY IF NOT EXISTS governance.by_country AS (country_code VARCHAR) RETURNS BOOLEAN -> IS_ROLE_IN_SESSION('GLOBAL_ANALYST') OR EXISTS (SELECT 1 FROM governance.country_access a WHERE IS_ROLE_IN_SESSION(a.role_name) AND a.country_code = country_code)"
    expect: The policy exists, attached to nothing yet.
  - id: filter-customers
    title: Filter dim_customer by country
    kind: sql
    sql: ALTER TABLE marts.dim_customer ADD ROW ACCESS POLICY governance.by_country ON (country_code)
    expect: Each analyst role sees only the countries mapped to it; GLOBAL_ANALYST sees all.
    rollback:
      procedure: ALTER TABLE marts.dim_customer DROP ROW ACCESS POLICY governance.by_country (a person runs it; rows are then visible to every reader of the table).
```
