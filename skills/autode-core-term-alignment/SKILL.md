---
name: autode-core-term-alignment
description: Align the business vocabulary to the ontology - each glossary term means a concept (exact, broader, narrower or related) with its scope, and tables or logical tables represent concepts - proposed as facts a person confirms in the Context Inbox. Use it after a pack is approved, when a maintenance item says terms mean no concept, or before estate merge needs the same entity across systems.
allowed-tools: [Read, mcp__autode__autode_ontology, mcp__autode__autode_ontology_align, mcp__autode__autode_propose_concept_links, mcp__autode__autode_get_concept_context, mcp__autode__autode_search_assets, mcp__autode__autode_get_asset_context, mcp__autode__autode_list_assertions, mcp__autode__autode_propose_assertion, mcp__autode__autode_maintenance_next]
metadata:
  scope: core
  stageKinds: [ontology-alignment]
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Aligning terms to concepts

One place for meaning: a **term means a concept**. Columns and semantic elements reach concepts through the terms bound to them, so meaning is never stated twice. A table (or logical table) may **represent** a concept directly: that is how estate merge finds the same entity in two systems.

Example chain: `fibo:CreditFacility` ← enterprise term "Facility" ← system term "Deal" (scope: the LOANSYS system) ← logical table `facilities` ← physical table `DEAL_MSTR`.

## 1. Candidates

`autode_ontology_align` lists what AutoDE finds from names, synonyms and the customer's vocabulary:

| match | Means | Example |
|---|---|---|
| `exact` | the term is a name of the concept | "Facility" → Credit Facility (a synonym) |
| `broader` | the concept is broader than the term (skos:broadMatch) | "Commercial Mortgage" → Mortgage |
| `narrower` | the concept is narrower than the term | "Credit" → Credit Facility, when the business uses "credit" for facilities only |
| `related` | the term is about the concept, not a kind of it | "Loan Amount" → Loan |

Candidates are a starting point. Judge each with the term's definition (`autode_get_asset_context`) and the concept's (`autode_get_concept_context`). Name matches mislead: "Account" in a CRM can mean a customer organisation, not a financial account.

## 2. Scope

A term's scope is where it is used: the enterprise, a line of business, a named system, or one business problem. A system's own word ("Deal" in LOANSYS) is a term with scope `system` that means the same concept as the enterprise term. If the term's fact has no scope, propose the correction (`autode_propose_assertion`, kind business_term, same subject and predicate, with `scope: { level, name }`).

Legacy physical names (`cust_no`) are vocabulary aliases, not terms.

## 3. Represents

Propose *represents* for a table that holds one row per instance of a concept (its grain). AutoDE checks a represents link against the terms of the table's key columns: a key that means a concept under another upper concept is a conflict on the concept page.

## 4. Propose

`autode_propose_concept_links` with each link's subject, concept, match and reason (your evidence). Each becomes a proposed fact; a person confirms it in the Context Inbox, and only then does it count. Tell the user.

## Rules

- Propose; never confirm.
- A term that fits no concept is a gap: say so, and suggest an extension concept (`ext:`) if the business needs it.
- One exact meaning per term. Two exact links for one term show as a conflict.
