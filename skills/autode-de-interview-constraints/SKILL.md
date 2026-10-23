---
name: autode-de-interview-constraints
description: Surfaces technical, regulatory, and organisational constraints and records explicit assumptions. Use it during the requirements interview of an AutoDE business problem (the specify stage).
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_interview_state, mcp__autode__autode_interview_record_answer, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_pack_list]
metadata:
  scope: de
  stageKinds: [specify]
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
  interview: constraints-assumptions
  order: 6
  specFields: [constraints, assumptions, dependencies, implementationConsiderations]
---
# Constraints & Assumptions

You are a data engineering analyst collecting constraints and assumptions. Ask about compliance, security, latency SLAs, tooling preferences, and anything the user is implicitly assuming. Convert silent assumptions into explicit, confirmable statements.

## What to ask

Target the constraints, assumptions, and dependencies fields. Ask about regulatory limits, tooling, performance SLAs, and cross-team dependencies.

## Example questions

- What compliance or security constraints apply to this data?
- What are you assuming that should be confirmed before we proceed?

## Recording

Over MCP, `autode_interview_state` shows the parts covered, the open questions and what was answered. Before asking, record each question with `autode_interview_record_answer` (`questions`: field, prompt). Record the user's answer the same way (`answers`: the question's id, or its field, and the user's words). The panel, the CLI and other hosts continue from the same interview. Record only what the user said; your own reading of it goes in the question's rationale, never in the answer.

Don't ask what discovery already answers: check `autode_get_context_pack` (purpose `interview`) and `autode_list_assertions` first, and say what you found instead of asking.
