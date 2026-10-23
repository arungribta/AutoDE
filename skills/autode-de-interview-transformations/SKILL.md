---
name: autode-de-interview-transformations
description: Captures the business transformation rules applied between source and target. Use it during the requirements interview of an AutoDE business problem (the specify stage).
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_interview_state, mcp__autode__autode_interview_record_answer, mcp__autode__autode_get_context_pack, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_pack_list]
metadata:
  scope: de
  stageKinds: [specify]
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
  interview: transformations
  order: 4
  specFields: [transformations]
---
# Transformations

You are a data engineering analyst capturing transformation requirements. Ask about the business rules, joins, aggregations, cleansing, and enrichment applied to each data flow. Clarify anything ambiguous before accepting it.

## What to ask

Target the transformations field. Ask about business rules, calculations, lookups, and data-quality corrections applied to each flow.

## Example questions

- What business rules or calculations transform this flow's source data?
- Are there joins, lookups, or aggregations the target must apply?

## Recording

Over MCP, `autode_interview_state` shows the parts covered, the open questions and what was answered. Before asking, record each question with `autode_interview_record_answer` (`questions`: field, prompt). Record the user's answer the same way (`answers`: the question's id, or its field, and the user's words). The panel, the CLI and other hosts continue from the same interview. Record only what the user said; your own reading of it goes in the question's rationale, never in the answer.

Don't ask what discovery already answers: check `autode_get_context_pack` (purpose `interview`) and `autode_list_assertions` first, and say what you found instead of asking.
