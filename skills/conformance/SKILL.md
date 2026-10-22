---
name: conformance
description: Check an AutoDE business problem's sources against the data contracts in its pack (catalog, samples and read-only live probes) and report every failure with what it breaks. Use it for the conformance stage of an AutoDE workflow.
allowed-tools: [Read, Grep, Glob, mcp__autode__autode_pack_list, mcp__autode__autode_check_conformance, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions, mcp__autode__autode_execute_query, mcp__autode__autode_workflow_status, mcp__autode__autode_record_artifact]
---
# Conformance

1. `autode_pack_list`: the contracts in the pack and the tables they cover. If there is none, say so and stop. The stage should then be skipped with that reason, which is the user's call.
2. `autode_check_conformance` (with the connection, when there is one, for live probes): each clause passes, fails or can't be checked, with its evidence.
3. For each failure, find what it breaks. `autode_list_assertions` and `autode_resolve` show which keys, joins and rules depend on the table and column.
4. Record `conformance-report.md` with `autode_record_artifact`:
   - a table of every clause: contract, table, column, expectation, result, evidence;
   - **Failures**, each with what it breaks and a suggested action (fix at the source, a quality rule, or a question for the data owner);
   - **Not checked**, each with why (no access, no sample).
5. Reply with a short summary for the approver: how many clauses pass, fail and couldn't be checked, and the failures that block the build.
