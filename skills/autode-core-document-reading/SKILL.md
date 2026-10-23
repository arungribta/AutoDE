---
name: autode-core-document-reading
description: Read the documents in an AutoDE business problem's pack (BRDs, KPI definitions, data contracts, data dictionaries) into proposed facts that cite their section, and propose reading profiles for structured documents in a house format, for a person to confirm. Use it when the user adds a document to the pack or asks what a document says.
allowed-tools: [Read, mcp__autode__autode_pack_list, mcp__autode__autode_pack_add, mcp__autode__autode_pack_apply, mcp__autode__autode_pack_reading, mcp__autode__autode_pack_record_reading, mcp__autode__autode_resolve, mcp__autode__autode_list_assertions]
metadata:
  scope: core
  stageKinds: []
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Reading pack documents

AutoDE reads structured documents deterministically, through a confirmed reading profile. A model is needed for two things: free text, and the first profile for a new document format. In the panel, AutoDE's own LLM does them. In your host, you do, through the same prompts and the same checks.

## 1. Register and apply

1. `autode_pack_list` shows the problem's documents, each with its role (contract, BRD, KPI definitions, mapping, data dictionary, sample, other) and authority (signed or draft). Add a document with `autode_pack_add`, giving the role the user names. Ask if it's unclear.
2. `autode_pack_apply` reads everything it can without a model. It reports which documents need one.

## 2. Free text: facts with their section

1. `autode_pack_reading` with the document's id returns its sections (ids such as `2.1 Revenue`), the extraction prompt and the document's `sha`.
2. Follow the prompt exactly:
   - only facts the document states, one per clause;
   - every fact cites the id of the section it comes from;
   - the document's own terms;
   - no invented tables or columns.
3. `autode_pack_record_reading` with `facts` and the `sha`. AutoDE checks each fact and resolves its subjects against the estate. It records the facts as proposed (a signed document's facts still need a person), skips duplicates, and reports what it dropped and why.

## 3. Structured documents in a house format: a profile

When no confirmed profile reads a YAML or JSON document, `autode_pack_reading` returns the profile prompt instead. A profile maps the document's structure onto AutoDE's fixed reading model; it never extracts the data itself. Record your proposal with `autode_pack_record_reading` (`profile`). A person reviews it and sets `status: confirmed`. After that, `autode_pack_apply` reads this document and every later version of it the same way, so a new version changes exactly the clauses that changed.

## 4. Tell the user

Say what was read, how many facts were proposed (and dropped, with the reasons), and that a person confirms them in the Context Inbox or reviews the profile. Don't summarise the document as if its facts were confirmed.
