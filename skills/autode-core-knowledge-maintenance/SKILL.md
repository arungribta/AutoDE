---
name: autode-core-knowledge-maintenance
description: Work AutoDE's knowledge-maintenance queue - the items its deterministic rules raise when a confirmed fact contradicts a semantic model, a cited fact changes an article, a document hasn't been read for knowledge, chat turns that read like facts haven't been reviewed, or a stage's deliverable went stale - one item at a time, as proposals a person approves. Use it when asked to keep AutoDE's knowledge current, at the start or end of a stage, or when an item names your role.
allowed-tools: [Read, mcp__autode__autode_maintenance_list, mcp__autode__autode_maintenance_next, mcp__autode__autode_review_session, mcp__autode__autode_dismiss_turns, mcp__autode__autode_propose_assertion]
metadata:
  scope: core
  stageKinds: []
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: preview
---
# Knowledge maintenance

New knowledge arrives in chat and in documents brought for other purposes, and a change to one fact can affect semantic models, articles and deliverables. AutoDE's rules notice it without a model and raise **items**. Each item names the agent suited to it. You interpret the item and propose; a person decides.

## 1. Take an item

- `autode_maintenance_list` shows the open items (`role` filters them to yours).
- `autode_maintenance_next` with your `role` gives the next one, with its work order: what happened, what to do, the assets involved, and your skills for it.

## 2. Do what it asks

| Rule | Role | Do |
|---|---|---|
| `semantic-contradiction`, `semantic-broken`, `semantic-ambiguous`, `semantic-gap` | semantic-modeler | Propose the model's change, or a correction of the fact (the semantic-modeling skill) |
| `article-stale`, `glossary-structure` | knowledge-engineer | Update the article; place the terms (the knowledge-articles and glossary-structure skills) |
| `document-reading` | context-curator | Read the document for knowledge: add it to the pack if it isn't there, then apply and read it (the document-reading skill) |
| `unreviewed-turns` | context-curator | `autode_review_session` with no `turns` lists the recorded messages. Propose a fact for each that states one, citing the message's `ref` as `chat_message` evidence. Dismiss the rest with `autode_dismiss_turns` |
| `stage-stale` | the stage's role | A person re-opens the stage; then it is redone as a stage |

## 3. Close it

You never close an item. It closes itself when its cause is gone: the proposal is approved, the document is read, the turn is cited or dismissed. If an item needs nothing (the document holds no knowledge, the contradiction is intended), say why in your summary, and a person dismisses it (`autode maintenance dismiss`).

## Rules

- One item at a time. Say which item you worked on and what you proposed.
- Never approve, apply or dismiss an item. Turns are the exception: dismissing a message that states no fact is part of reviewing it.
- No model call is needed to find items. Under the workspace's `suggest` policy (the default), nothing runs until a person or a host agent picks an item up.
