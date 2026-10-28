---
name: autode-core-orchestrator
description: Run an AutoDE business problem's workflow in this host - find the next stage, have the right agent do it, hand it in, and tell the user what needs their approval. Use it when the user asks to work on, continue, or check progress of an AutoDE problem.
allowed-tools: [mcp__autode__autode_list_problems, mcp__autode__autode_select_problem, mcp__autode__autode_workflow_status, mcp__autode__autode_workflow_next, mcp__autode__autode_refresh_working_set, mcp__autode__autode_workflow_history, mcp__autode__autode_workflow_complete_stage, mcp__autode__autode_propose_workflow, mcp__autode__autode_list_decisions, mcp__autode__autode_maintenance_list]
metadata:
  scope: core
  stageKinds: []
  platforms: [any]
  version: 3
  owner: AutoDE
  maturity: tested
---
# AutoDE orchestrator

AutoDE's workflow is the hub: it decides what comes next. You dispatch the work and report; you never decide the order, approve anything, or skip a mandatory step.

## Loop

1. `autode_workflow_status`. If there is no approved workflow, propose one with `autode_propose_workflow` and tell the user how to approve it (the AutoDE panel, `autode workflow approve` in a terminal, or the decision file). Stop until it is approved.
2. `autode_workflow_next`. Its `maintenance` field counts the open knowledge-maintenance items and the unreviewed chat turns, and lists those that touch this stage's assets: tell the user about them (in a governed problem they hold the stage's gate until resolved or dismissed). It returns the next stage and, when AutoDE has a definition for its role, an **assignment**: role, brief, skills, permission tier, the AutoDE tools allowed, and the full instructions in `assignment.text`.
3. If the stage is **waiting for approval**, tell the user what to approve and how. Stop. If the reply has **`notReady`**, the stage lacks what its work needs (for example, no tables in the estate to map): tell the user each item and what to do, and don't start the agent. Stop.
4. If there is an assignment, first call `autode_refresh_working_set`, so the tables the agent works with are current (it reports a source it can't reach; go ahead anyway). Then run it:
   - with sub-agents: start the AutoDE agent named by `assignment.role` and give it `assignment.text` as its task;
   - without sub-agents: follow `assignment.text` yourself, using only the tools it allows.

   The agent records each deliverable with `autode_record_artifact`.
5. Hand the stage in: `autode_workflow_complete_stage` with the recorded files as `outputs` and a short `summary` for the approver. Tell the user it waits for their approval.
6. After handing in, `autode_maintenance_list`: if the stage raised items (a fact it confirmed contradicts a semantic model, a document it brought in is unread), tell the user which agent each names. Start that agent only if the user asks (with sub-agents: the role named by the item, given `autode_maintenance_next`'s `assignment.text`).
7. If there is no assignment yet (the stage's role still runs in AutoDE's VS Code panel), tell the user which stage it is and that it is done from the AutoDE panel for now.

## Rules

- Never call one AutoDE agent from inside another; every assignment comes from `autode_workflow_next`.
- Never approve, resolve or apply a decision, and never skip a stage unless the user asks; when they do, use the workflow's own skip with their reason.
- Report progress from `autode_workflow_status` and `autode_workflow_history`: who did what is recorded there.
