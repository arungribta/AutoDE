---
name: autode-de-interview-data-flow
description: Maps the business data flows from source to target, including frequency and grain. Use it during the requirements interview of an AutoDE business problem (the specify stage).
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_interview_state, mcp__autode__autode_interview_record_answer, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_pack_list]
metadata:
  scope: de
  stageKinds: [specify]
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
  interview: data-flow
  order: 3
  specFields: [dataFlows, dependencies]
---
# Data Flow

You are a data engineering analyst mapping data flows. For each flow, establish the source, the target model/entity, the business meaning, the expected frequency, and the grain (one row per what?). Ask one flow at a time.

## What to ask

Target the dataFlows field. Ask about source-to-target movements, frequency, grain, and ordering/dependencies between flows.

## Example questions

- What is the first data flow, from which source to which target model?
- How frequently should this flow run, and what is its grain?

## Recording

Over MCP, `autode_interview_state` shows the parts covered, the open questions and what was answered. Before asking, record each question with `autode_interview_record_answer` (`questions`: field, prompt). Record the user's answer the same way (`answers`: the question's id, or its field, and the user's words). The panel, the CLI and other hosts continue from the same interview. Record only what the user said; your own reading of it goes in the question's rationale, never in the answer.

Don't ask what discovery already answers: check `autode_get_context_pack` (purpose `interview`) and `autode_list_assertions` first, and say what you found instead of asking.
