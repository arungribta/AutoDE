---
name: autode-core-fact-extraction
description: Turn what the user states about their data and business while working with you (keys, grain, relationships, terms, metrics, rules, decisions, assumptions, constraints) into facts proposed to AutoDE, with the message as evidence, for a person to confirm. Use it after any message in which the user says something true about their data, systems or rules, in an AutoDE workspace.
allowed-tools: [mcp__autode__autode_list_assertions, mcp__autode__autode_resolve, mcp__autode__autode_propose_assertion]
metadata:
  scope: core
  stageKinds: []
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Fact extraction from the conversation

In the AutoDE panel this runs after every chat turn. In your host it runs because you follow this skill: when the user tells you something true about their data, don't let it stay in the chat.

## 1. What counts

Only what the **user** states, not your suggestions, not questions, and not what you inferred. One fact per clause:

| Kind | Predicate | Value |
|---|---|---|
| key | `primary` | the key columns, `["order_id"]` |
| grain | `grain` | the columns one row is per |
| relationship | `joins_to` | `{ "from": { "entity", "columns" }, "to": { "entity", "columns" } }` |
| business_term | `defined_as` | `{ "term", "definition" }` |
| metric | `defined_as` | `{ "name", "expression", "filters" }` or `{ "name", "definition" }` |
| business_rule | a short verb | `{ "text", "level": "STRICT" or "RECOMMENDED" }` |
| quality_expectation | a short verb | `{ "check": "not_null", "unique", "accepted_values" or "freshness", "values" }` |
| decision, assumption | a short verb | `{ "text" }` |
| constraint | `platform` | `{ "platform", ... }` |

In hosts with MCP prompts, the `autode_extract_assertions` prompt gives the same instructions for one message.

## 2. Check, then propose

1. `autode_resolve` the tables and columns named, and use the names it returns. Never invent a table or column; an unresolved name is kept as said and flagged.
2. `autode_list_assertions` for those subjects. If the user is correcting a recorded fact, propose the corrected fact with the same kind, subject and predicate: AutoDE links the correction to the old one.
3. `autode_propose_assertion` for each fact, with the user's words as the statement and the message as evidence.

A person confirms each fact in the Context Inbox (or with `autode facts`). Tell the user what you proposed, in one line, and carry on with what they asked.

## Worked example

> User: "Orders are unique on order_id, and a cancelled order never counts towards revenue."

Two facts:
- **key:** subject `shop.orders`, predicate `primary`, value `["order_id"]`, statement "Orders are unique on order_id".
- **business_rule:** subject `revenue`, predicate `excludes`, value `{ "text": "Cancelled orders never count towards revenue", "level": "STRICT" }`.
