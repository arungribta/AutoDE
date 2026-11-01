---
name: autode-core-workflow-planning
description: Plan an AutoDE business problem's workflow from the coverage of its approved specification - refine the deterministic draft, combine templates or compose from stage kinds where none fits, add manual stages for work done outside AutoDE, write each stage's brief, then propose the workflow and the coverage for a person's approval. Use it for the plan stage of an AutoDE workflow.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_workflow_templates, mcp__autode__autode_workflow_draft, mcp__autode__autode_workflow_status, mcp__autode__autode_coverage, mcp__autode__autode_get_context_pack, mcp__autode__autode_list_assertions, mcp__autode__autode_resolve, mcp__autode__autode_skills_list, mcp__autode__autode_propose_workflow, mcp__autode__autode_propose_coverage]
metadata:
  scope: core
  stageKinds: [plan]
  platforms: [any]
  version: 2
  owner: AutoDE
  maturity: tested
---
# Workflow planning

The plan answers two questions, approved by a person in this order: **what will be delivered** (the coverage of the specification) and **how** (the workflow). Nothing in the specification drops silently.

## 1. Inputs

- `autode_coverage` lists the items to cover: every in-scope item and objective of the approved specification, its constraints and acceptance criteria, and personal-data handling when the specification involves personal data. Each has the engine's starting placement, and the items it couldn't place are `question`.
- `autode_workflow_draft` gives:
  - AutoDE's draft for the suggested template (or the one you name);
  - the problem's current workflow, if one exists;
  - for **every** stage kind: the roles allowed, the permission-tier ceiling, and the skills that do it on this problem's platform. A kind with no skill is a person's to do.
- `autode_workflow_templates` lists the templates (greenfield, modernization, estate merge, and the workspace's own) with each stage's inclusion: mandatory, default, conditional or optional.
- `autode_get_context_pack` (purpose `plan`) gives the approved specification, the source and target contexts and what the estate holds. `autode_list_assertions` gives the confirmed keys, grains and decisions.

## 2. Place every item

For each coverage item, decide one status:
- **covered:** AutoDE stages deliver it. Name them.
- **manual:** a person does it outside AutoDE (an ML feature pipeline, a streaming service, a sign-off in another tool). It goes on a `manual` stage (below).
- **out-of-scope:** this problem doesn't deliver it. Give the reason: a later problem, it already exists, the stakeholder dropped it. A constraint no stage acts on (a deadline, a budget) is out of scope with that reason.
- **gap:** it's needed and no AutoDE stage kind or skill can deliver it. Say what's missing (a stage kind, a platform skill, a capability).

Never invent a skill or a stage kind. What AutoDE can't do is a gap or manual work, and both go on the team's list for new skills.

## 3. Shape the workflow

- **Template:** keep the suggested one unless the specification says otherwise (a migration of a legacy system is modernization; several sources of the same entities are an estate merge). Changing the template after a workflow was approved restarts it after the specification: say so.
- **Stages from another template:** when the engagement needs them (a modernization with the estate merge's entity resolution, or with BI migration), add the stage with `origin: combined` and `fromTemplate`, keeping its id, kind, gates and its dependencies on stages already in the workflow. Give a reason.
- **No template fits:** set the workflow's `template.id` to `composed` and build it from stage kinds, every stage `origin: added` with a reason. It still starts with specify and plan. If it moves data between systems, it must reconcile and validate it.
- **Manual stages:** `kind: manual`, `origin: added`, a reason, an `owner` (a person or a team), no `agent`, and a dependency on the stage it follows. AutoDE runs nothing there; its owner marks it done with a note.
- **Rules for every workflow:**
  - mandatory stages and their gates stay;
  - a default stage left out needs a reason from the specification or the estate (for example: no BI tool in scope, so no BI migration);
  - a model is approved after the mapping, and deployment follows validation;
  - every stage covers an item or is a supporting stage (contexts, assessment, reconciliation, validation, documentation, deployment).
- **Per stage, `agent`** (not on manual stages):
  - `role`: one the stage kind allows;
  - `tier`: at or below the kind's ceiling (lower when the stage only reads);
  - `skills`: only when the default choice is wrong; they must exist and be for the stage's kind;
  - `brief`: see below.

## 4. Write the briefs

A brief is the context the stage's agent can't work out alone, in at most 1,500 characters:
- **scope:** which entities, systems or tables this stage covers (for a per-source stage, the system), and the coverage items it delivers;
- **constraints** from the specification that bind this stage (personal data, freshness, a regulator's rule);
- **open questions** it must settle with the stakeholder, or record as gaps;
- **what to produce**, when it's more specific than the stage kind says.

A brief never names tools or skills, and never says how to do the work: the role and the stage's skills carry the method. The engine refuses a brief that names a tool or a skill, or that is too long.

## 5. Propose, in order

1. `autode_propose_workflow` with `workflow`: the refined or composed workflow, complete. The engine checks it against the template's rules and the composition rules, and returns any errors item by item; fix them and propose again.
2. `autode_propose_coverage` with a placement for each item whose status or stages you set. It is checked against that workflow: every stage you name must be in it, manual items on manual stages, a reason for every gap and out-of-scope item, no question left.

A person approves the coverage first, then the workflow (the panel's plan step, `autode workflow coverage approve` and `autode workflow approve`, or the decision files). Tell the user what you changed from the draft and why, and list the gaps and the manual work.

If an item can't be placed without an answer only the stakeholder has, don't guess: tell the user the question and leave the item for them to place.

## Worked example (the reference problem: retail orders)

The modernization draft for the retail orders problem includes BI migration as an optional stage, left out. The specification names no BI tool, so it stays out: "no BI tool in the specification's scope". Its scope also asks for "churn-risk scores for the CRM team": no AutoDE stage kind builds an ML model, so the planner adds a manual stage `churn-model` (owner: the data science team, after `build`) and places the item as manual there. The constraint "go live before the Q3 close" is out of scope: "a deadline, not a deliverable".

The mapping stage's brief:

> Map shop.orders, shop.order_items and shop.customers to the dimensional model's fct_orders and dim_customer. Customer email and phone are personal data: the specification requires them masked outside the PII readers. Open question for the stakeholder: are cancelled orders kept in fct_orders with their status, or excluded? Produce the mapping document; mark the cancelled-orders rule as an open question until answered.
