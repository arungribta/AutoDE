---
name: autode-de-source-assessment
description: Assess the source systems of an AutoDE business problem - bring their metadata into the estate, profile keys, grain, volumes and freshness with read-only aggregate queries, propose keys, grain and relationships as facts, and draft the source context. Use it for the source-assessment stage of an AutoDE workflow.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_list_connections, mcp__autode__autode_test_connection, mcp__autode__autode_list_databases, mcp__autode__autode_list_schemas, mcp__autode__autode_extract_metadata, mcp__autode__autode_ingest_metadata, mcp__autode__autode_ingest_file, mcp__autode__autode_execute_query, mcp__autode__autode_resolve, mcp__autode__autode_get_context_pack, mcp__autode__autode_list_assertions, mcp__autode__autode_propose_assertion, mcp__autode__autode_pack_list, mcp__autode__autode_mine_vocabulary, mcp__autode__autode_workflow_status, mcp__autode__autode_record_source_context, mcp__autode__autode_record_artifact]
metadata:
  scope: de
  stageKinds: [source-assessment]
  platforms: [any]
  version: 2
  owner: AutoDE
  maturity: tested
---
# Source assessment

## 1. What is in scope

`autode_get_context_pack` with purpose `plan` and a query naming the problem gives the specification's scope and objectives and what the estate already holds. List the source systems and the tables the outcome needs. When the stage has tasks per source system, do one system at a time.

## 2. Bring each system into the estate

- **Connected:** `autode_list_connections`; `autode_test_connection` if its readiness is unknown; `autode_list_databases` and `autode_list_schemas` to find the schemas; then `autode_ingest_metadata` with the schemas in scope (and `profile` when the connection allows it).
- **Files** in the workspace (DDL, CSV, JSON): `autode_ingest_file`.
- **No access:** don't guess. Record the system as *described* (step 5) with what it is, who owns it and what access is needed.

Then check with `autode_resolve` that the tables the outcome needs are there.

## 3. Profile what matters

For the tables the outcome depends on, aggregate queries only with `autode_execute_query`:
- row count;
- distinct count of each candidate key, and whether it equals the row count;
- null counts of keys, foreign keys and dates;
- min and max of the date that drives incremental loads (freshness);
- orphan counts for each relationship (child keys with no parent).

Never select row values.

## 4. Propose what you established

For each key, grain and relationship the profile supports, call `autode_propose_assertion` with kind `key`, `grain` or `relationship`, the subject (table, and column where it applies), the statement in one sentence, and the query and its result as evidence. If names are cryptic (CUST_NO, ORD_DT), `autode_mine_vocabulary` suggests abbreviations; mention them to the user.

## 5. Draft the source context

The source context lists which of the estate's systems this problem draws on; their tables, environments and bindings stay in the estate, so don't repeat them. Call `autode_record_source_context` with one entry per system:
- `system`: the estate system (for a connected or file-based source; bring it into the estate first);
- `connectionId`: the connection id or file that feeds it;
- `method`: `connected` or `file`;
- for a source with no connection yet, `method: described` with its `description` and `sourceType` instead (no `system`).

## 6. Report

Record `source-assessment.md` with `autode_record_artifact`:
- per system: what was brought in, the profile table (rows, keys, nulls, freshness), the facts proposed;
- **Risks:** duplicate keys, orphans, stale data, missing access;
- **Open questions** for the stakeholder.

Reply with a short summary for the approver: the systems, what is ready, what is missing, and which facts wait for confirmation in the Context Inbox.
