---
name: autode-core-workflow-planning
description: Plan an AutoDE business problem's workflow - refine the deterministic draft (stages included, left out or added, each with a reason) and write each stage's brief from the approved specification and the estate, then propose it for a person's approval. Use it for the plan stage of an AutoDE workflow.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_workflow_templates, mcp__autode__autode_workflow_draft, mcp__autode__autode_workflow_status, mcp__autode__autode_get_context_pack, mcp__autode__autode_list_assertions, mcp__autode__autode_resolve, mcp__autode__autode_skills_list, mcp__autode__autode_propose_workflow]
metadata:
  scope: core
  stageKinds: [plan]
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Workflow planning

## 1. Inputs

- `autode_workflow_draft` gives:
  - AutoDE's draft for the suggested template (or the one you name);
  - the problem's current workflow, if one exists;
  - for each stage kind: the roles allowed, the permission-tier ceiling, and the skills that do it on this problem's platform.
- `autode_workflow_templates` lists the templates (greenfield, modernization, estate merge, and the workspace's own) with each stage's inclusion: mandatory, default, conditional or optional.
- `autode_get_context_pack` (purpose `plan`) gives the approved specification, the source and target contexts and what the estate holds. `autode_list_assertions` gives the confirmed keys, grains and decisions.

## 2. Refine the draft

- **Template:** keep the suggested one unless the specification says otherwise (a migration of a legacy system is modernization; several sources of the same entities are an estate merge). Changing template after a workflow was approved restarts it after the specification: say so.
- **Stages:**
  - mandatory stages and their gates stay;
  - a default stage left out needs a reason from the specification or the estate (for example: no BI tool in scope, so no BI migration);
  - an added stage needs a reason too, and a new id.
- **Per stage, `agent`:**
  - `role`: one the stage kind allows;
  - `tier`: at or below the kind's ceiling (lower when the stage only reads);
  - `skills`: only when the default choice is wrong; they must exist and be for the stage's kind;
  - `brief`: see below.

## 3. Write the briefs

A brief is the context the stage's agent can't work out alone, in at most 1,500 characters:
- **scope:** which entities, systems or tables this stage covers (for a per-source stage, the system);
- **constraints** from the specification that bind this stage (personal data, freshness, a regulator's rule);
- **open questions** it must settle with the stakeholder, or record as gaps;
- **what to produce**, when it's more specific than the stage kind says.

A brief never names tools or skills, and never says how to do the work: the role and the stage's skills carry the method. The engine refuses a brief that names a tool or a skill, or that is too long.

## 4. Propose

`autode_propose_workflow` with `workflow`: the refined draft, complete. The engine checks it against the template's rules and returns any errors item by item; fix them and propose again. The result is a decision a person approves (the panel, `autode workflow approve`, or the decision file). Tell the user what you changed from the draft, and why.

## Worked example (the reference problem: retail orders)

The modernization draft for the retail orders problem includes BI migration as an optional stage, left out. The specification names no BI tool, so it stays out: "no BI tool in the specification's scope". The mapping stage's brief:

> Map shop.orders, shop.order_items and shop.customers to the dimensional model's fct_orders and dim_customer. Customer email and phone are personal data: the specification requires them masked outside the PII readers. Open question for the stakeholder: are cancelled orders kept in fct_orders with their status, or excluded? Produce the mapping document; mark the cancelled-orders rule as an open question until answered.
