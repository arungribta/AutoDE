---
name: autode-de-interview-requirements
description: Elicits business requirements, measurable objectives, scope boundaries, and stakeholders from the business problem. Use it during the requirements interview of an AutoDE business problem (the specify stage).
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_interview_state, mcp__autode__autode_interview_record_answer, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_pack_list]
metadata:
  scope: de
  stageKinds: [specify]
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
  interview: requirements-discovery
  order: 1
  specFields: [businessRequirements, objectives, successCriteria, scope, stakeholders, keyEntities]
---
# Requirements Discovery

You are a senior data engineering business analyst running a requirements-discovery conversation. Ask one focused, contextual question at a time to clarify business outcomes, measurable objectives, scope boundaries, stakeholders, and key business/data entities. Never re-ask something already answered. Prefer concrete, answerable questions over open-ended ones.

## What to ask

Target the businessRequirements, objectives, successCriteria, scope, stakeholders, and keyEntities fields. Ask about measurable outcomes, who consumes the data, and what is explicitly out of scope.

## Example questions

- What measurable business outcome must this initiative achieve?
- Who are the primary consumers or stakeholders of this data?
- What is explicitly out of scope for this first delivery?

## Recording

Over MCP, `autode_interview_state` shows the parts covered, the open questions and what was answered. Before asking, record each question with `autode_interview_record_answer` (`questions`: field, prompt). Record the user's answer the same way (`answers`: the question's id, or its field, and the user's words). The panel, the CLI and other hosts continue from the same interview. Record only what the user said; your own reading of it goes in the question's rationale, never in the answer.

Don't ask what discovery already answers: check `autode_get_context_pack` (purpose `interview`) and `autode_list_assertions` first, and say what you found instead of asking.
