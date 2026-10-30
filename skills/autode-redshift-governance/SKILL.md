---
name: autode-redshift-governance
description: Read how an Amazon Redshift source protects its data - privileges per table and view, roles and groups, and dynamic data masking policies (the governance.relation_privileges and governance.masking_policies operations) - and carry it into the target's access design and personal-data rules; and, with Redshift as a target, grant access and mask personal data through the governance change operations, as runbook steps. Use it in source assessment when a source is Redshift, and in platform setup when the target is Redshift.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_propose_assertion, mcp__autode__autode_list_connections, mcp__autode__autode_platform_operations, mcp__autode__autode_platform_run, mcp__autode__autode_governance_candidates, mcp__autode__autode_record_artifact]
metadata:
  scope: redshift
  stageKinds: [source-assessment, platform-setup]
  platforms: [redshift]
  version: 2
  owner: AutoDE
  maturity: preview
---
# Redshift access and masking

Written by AutoDE from AWS's public Redshift documentation (privileges, role-based access control, dynamic data masking). Preview: checked on recorded results, not yet on a live account.

## 1. Read who can see what

On the Redshift connection, for each schema in scope:
- `autode_platform_run` with `governance.relation_privileges`: each privilege on each table or view, and to whom (`user`, `role` or `group`).
- `autode_platform_run` with `governance.masking_policies`: each masking policy, the columns it masks, for whom, and its priority (the highest applies when several match).

A regular user sees only some privileges and policies. A superuser or a role with `sys:secadmin` sees all. If the lists look thin, say so; don't conclude there is no protection.

## 2. What it tells the assessment

- **Access groups:** read the grants as personas, for example the `analyst` role can SELECT on `sales.*`, and `etl_user` writes `stage.*`. Propose them as facts (`autode_propose_assertion`, kind `constraint`) and as input to the target's roles (the target platform's governance skill).
- **Personal data:** a masking policy on a column is strong evidence it holds personal data. Compare with `autode_governance_candidates`: a candidate with a policy is confirmed by the source's own protection; a policy on a column AutoDE didn't flag means the shape check missed it. Record both.
- **Groups versus roles:** Redshift's older user groups and its newer roles may both be in use. Map each to one target role; don't carry both models over.
- **Row-level security** isn't read by an operation yet. Ask the person whether row-level policies are in use, and record their answer as an assumption until it is read.

## 3. Write it up

`autode_record_artifact` with `governance/redshift_access.md`: the personas and their grants, the masked columns and who sees them unmasked, and the gaps (what the user couldn't see, row-level security).

## Governance on Redshift as a target

Changes run only as runbook steps a person approves. `autode_platform_run` with a change operation returns the step to propose; never write the grant yourself.

1. **Roles from personas:** one role per persona from the specification's constraints (and, in a modernization, the source's grants above). `CREATE ROLE` steps first.
2. **Access:** `governance.grant_usage` then `governance.grant_select` for each role and schema it reads. `GRANT SELECT ON ALL TABLES` covers the tables that exist now: tables created later need the grant again, so put the grants after the tables in the deployment runbook, and re-run them after a rebuild.
3. **Personal data:** for each column the governance candidates flag (or the source masked):
   - a `CREATE MASKING POLICY` step (a hash or a redaction, matching the `mask` primitive's choice);
   - `governance.attach_masking_policy` for `PUBLIC` (masked for everyone), then again with a higher priority for the role that may see the value.
4. **Who runs them:** masking needs `sys:secadmin` (or a role granted `ATTACH MASKING POLICY`). Say which role the runbook needs; don't assume the deploying role has it.
5. `autode_propose_runbook` on the target connection; record the design (`governance/redshift_access.md`): roles, grants, policies, who sees what unmasked.
