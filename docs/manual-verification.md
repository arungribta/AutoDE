# Manual verification — v0.25.0 to v0.31.0

Hands-on checks for the features shipped in v0.25.0–v0.31.0, run in the VS Code Extension Development Host. Each check gives **Do** and **Expect**; tick the box when it holds, and note anything that doesn't in the results table at the end.

Automated coverage already exists (`npm test`, `npm run eval`); these checks cover what only a real VS Code session shows: the panel, prompts, commands, file watching and real LLM providers.

Time: about 90 minutes, of which Part 7 (a full plan run) takes the longest. Parts 1–6 can be done in any order after Part 0.

---

## Part 0 — Setup (once)

1. **Build.** In the AutoDE repo: `rm -rf dist && npm run compile`.
2. **Make a scratch workspace** outside the repo, e.g. `D:\autode-manual-test\`, and copy into it:
   - `test/reference/retail-orders/sources/shop.ddl`, `crm.ddl`, `hr_legacy.ddl` → `D:\autode-manual-test\sources\`
   - `test/reference/retail-orders/documents/business-context.yaml` → `D:\autode-manual-test\.ai-context\context\business-context.yaml`
3. **Launch.** Press F5 in the repo ("Run Extension (Development Host)"). In the new window, **File → Open Folder…** the scratch workspace.
4. **Open the AutoDE panel** (AutoDE icon in the activity bar). Log lines appear as small grey messages in the chat stream; most "Expect" items below refer to those.
5. **Choose an LLM provider** with `/settings` in the chat box. Parts 4 and 7 need a working provider; use Copilot if it is available, plus one API provider (OpenAI, Anthropic, Gemini or Ollama) for Part 4.
6. Keep the Explorer open on `.ai-context/`; several checks look at files there.
7. **Where commands are:** every step written as "`AutoDE: …`" is a VS Code command, run from the **Command Palette** (Ctrl+Shift+P, type part of the name) **in the Development Host window**. Most have no button in the AutoDE panel. Steps written as `/something` are typed into the AutoDE chat box.

> **Known gap found while writing this:** edits to `.ai-context/context/business-context.yaml` are not picked up live (that folder isn't watched for business context, and `AutoDE: Re-index Context` only shows a message). Where a step edits that file, it says to run **Developer: Reload Window** afterwards.

---

## Part 1 — v0.25.0 Spec state synchronization

Needs a business problem with a spec. Create one quickly: in chat, `/spec Daily net revenue reporting in Snowflake from the shop orders system`, then wait for the draft.

- [ ] **1.1 External edit is picked up.**
  Do: open `.ai-context/problems/<problem>/spec/business-problem.yaml` in the editor, change the `problemStatement` text, save.
  Expect: within a second the panel's specification view shows the new text. No AutoDE save overwrites it.
- [ ] **1.2 A stale save asks instead of overwriting.**
  Do: in the same file, break the YAML on purpose (e.g. delete a closing quote) and save. Then make AutoDE save the spec (e.g. `/spec add a requirement for hourly freshness`, or click Approve).
  Expect: a warning "…changed on disk since AutoDE loaded it — your change was not saved." with **Reload from Disk** and **Overwrite**. Fix the YAML, choose **Reload from Disk**, and confirm the panel shows the disk version.
- [ ] **1.3 Execution pauses on a spec change.** (Do this during Part 7 if you prefer: it needs a running plan.)
  Do: while a plan is executing, edit and save `business-problem.yaml`.
  Expect: log "The Business Problem Specification changed on disk during execution — execution will pause after the current step…"; the running step finishes and the next does not start.

## Part 2 — v0.26.0 Engine boundary (regression only)

No behaviour should have changed. Skip 2.2 if you have no data-platform credentials.

- [ ] **2.1 Panel and commands load.**
  Do: run `AutoDE: Show Active Language Model Status` and `AutoDE: Test Language Model (Copilot / Claude)`.
  Expect: both work as before; no errors in **Help → Toggle Developer Tools → Console** mentioning `dist/engine`.
- [ ] **2.2 Live connection still works.**
  Do: `/connect`, connect to Snowflake or Databricks, then `AutoDE: Run Source Assessment`.
  Expect: "Source assessment complete: N tables, M views." With Snowflake CLI auth, the CLI-execution consent prompt still appears before the first CLI call.

## Part 3 — v0.27.0 Evaluation harness

Run from the AutoDE repo, not the Development Host.

- [ ] **3.1 Offline eval runs.**
  Do: `npm run eval`.
  Expect: a summary ending with "Plan-step context size …"; `test/reference/retail-orders/eval-report.md` is written. Trap detection **3/5**, answerability **13/26**, tables kept distinct **18/18** (the frozen `baselines/v0.30.0-offline.md`).
- [ ] **3.2 Ablation reproduces the older numbers.**
  Do: `npm run eval -- --sut ledger --out ledger.md` and `npm run eval -- --sut baseline --out baseline.md`.
  Expect: ledger: traps 1/5, answerability 5/26. Baseline: traps 0/5, answerability 5/26. Delete the two `.md` files afterwards.
- [ ] *(Optional, paid)* **3.3 Record a cassette.**
  Do: `AUTODE_EVAL_API_KEY=… npm run eval -- --mode record --provider openai`.
  Expect: QA accuracy and identifier grounding of LLM-generated artifacts get real numbers. Decide afterwards whether to commit `cassettes/`.

## Part 4 — v0.28.0 Tool skills on every provider + allowed-tools

Create a test skill folder anywhere, e.g. `D:\skills\table-lister\SKILL.md`:

```markdown
---
name: table-lister
description: Lists the DDL files in the workspace and the tables they define.
allowed-tools: Read, Grep, Glob
---
Find every .ddl file under the workspace, read each one, and reply with a list of the
CREATE TABLE names per file. Do not create or modify any file.
```

- [ ] **4.1 Import.** Do: Command Palette → `AutoDE: Import Tool Skill`; in the folder picker select the `table-lister` **folder** (not `SKILL.md` itself) and click "Import as a tool skill".
  Expect: it lands under `.ai-context/skills/tool-skills/table-lister/`.
- [ ] **4.2 Runs on Copilot.** Do: with Copilot active, chat `/skill table-lister list the tables`.
  Expect: a reply listing the `shop`, `crm` and `hr_legacy` tables. No write tool was offered (nothing created in the workspace).
- [ ] **4.3 Runs on an API provider.** Do: switch provider (`/settings`) to OpenAI/Anthropic/Gemini/Ollama, repeat 4.2.
  Expect: same result. (Before v0.28.0 this failed on every provider except Copilot and Claude.)
- [ ] **4.4 allowed-tools is enforced.** Do: edit the imported `SKILL.md`: change the instruction to "…then write the list to tables.txt", keep `allowed-tools: Read, Grep, Glob`, and run it again.
  Expect: no `tables.txt` is created. The model either says it cannot write, or its write attempt is refused.
- [ ] **4.5 Claude Code approval text.** (Only if the Claude Code CLI is installed.) Do: switch to `claude`, run the skill.
  Expect: one approval prompt that says the whole run is approved once and that AutoDE cannot audit or block individual tool calls.

## Part 5 — v0.29.0 Assertion ledger

- [ ] **5.1 First load migrates into the ledger.**
  Do: open `.ai-context/ledger/`.
  Expect: a file named `<date>.<26-char id>.jsonl`; each line is an event (`"type":"asserted"`). The four glossary terms and two rules from `business-context.yaml` are there.
- [ ] **5.2 DDL import keeps schemas apart.**
  Do: `AutoDE: Ingest File as Source Context (CSV/JSON/DDL)` three times: `sources/shop.ddl`, `crm.ddl`, `hr_legacy.ddl`.
  Expect: "Ingested shop.ddl: 10 table(s), 72 column(s)", "crm.ddl: 8 table(s), 50 column(s)". Open `.ai-context/derived/graph.json` and search `"fqn": "shop.customers"` and `"fqn": "crm.customers"`: both exist as separate nodes. `shop.orders` has a `channel` column (it was lost before v0.30.0).
- [ ] **5.3 Nodes carry their support.**
  Do: in `derived/graph.json`, look at any table node.
  Expect: `"supportedBy": ["01…"]` and `"origin": { …, "confidence": 0.8 }` (file-derived = documented). The id matches an `asserted` event in the ledger.
- [ ] **5.4 An edit supersedes, history is kept.**
  Do: in `.ai-context/context/business-context.yaml`, change the Revenue `formula` (e.g. add `- SUM(refunds.amount)`), save, run **Developer: Reload Window**.
  Expect: log "Context ledger: … 1 superseded …" (some "asserted" too on the first reload after 5.2 — the glossary links to the now-ingested tables are new). A new ledger file has an `asserted` event with `"supersedes"` and a `superseded` event; the original `asserted` line is still in the older file.
- [ ] **5.5 A contradiction is detected.**
  Do: add a second entry to `business-terms` in the same file — `term: Revenue`, `formula: SUM(order_items.unit_price)` — save, reload the window.
  Expect: log "…2 flagged for review; 1 conflict(s)." (both definitions are active, so both go to review). The ledger has `flagged_needs_review` events with reason "conflicts with … (definition)". Remove the duplicate entry afterwards and reload.
- [ ] **5.6 A removed entry is retracted, not deleted.**
  Do: delete the "Loyalty Tier" term, save, reload.
  Expect: a `rejected` event with reason "no longer present in context/business-context.yaml"; the term disappears from the panel's context drawer (`/context`).
- [ ] **5.7 Compaction.**
  Do: `AutoDE: Compact Context Ledger` → **Compact**.
  Expect: "Context ledger compacted: N assertion(s) in snapshot.json"; `snapshot.json` appears and the `.jsonl` files remain. Reload the window: the graph is unchanged. (Optionally repeat with **Compact and prune history**: only `snapshot.json` remains, and the graph is still unchanged after a reload.)
- [ ] **5.8 Live extraction keeps file-ingested tables.** (Needs a connection; skip otherwise.)
  Do: with the DDL files ingested, run `AutoDE: Run Source Assessment`.
  Expect: the live tables are added and the `shop`/`crm` tables from the DDL files are still in the context drawer (before v0.29.0 a live extraction replaced the whole graph). Their ledger events are `asserted` with `"trust":"verified"` and `"type":"introspection"` evidence.

## Part 6 — v0.30.0 Context packs, gaps, "What the Agent Saw"

Needs a working LLM provider and the DDL files from 5.2.

- [ ] **6.1 A chat reply gets a task-scoped pack.**
  Do: chat "What columns does shop.order_items have?". Then run `AutoDE: What the Agent Saw` and pick the newest "Chat: …" entry.
  Expect: a document showing a `seeded` pack. Seeds include `table-shop_order_items`; the context lists its columns with types; no `hr_legacy` tables. The reply itself names the real columns.
- [ ] **6.2 Unrelated chat still gets the overview.**
  Do: chat "Hello, what can you do?", then open What the Agent Saw for it.
  Expect: mode `overview` — the same "Database Tables" list as before v0.30.0 (first 20 tables).
- [ ] **6.3 Context gap instead of an invented join.**
  Do: chat "Show the number of support tickets per order."
  Expect: in What the Agent Saw, under Warnings: "Context gap: No known relationship joins support tickets ↔ order…". The reply should ask how they relate rather than inventing a join key. The reply is the model's choice; the gap in the pack is AutoDE's.
- [ ] **6.4 Conflicts reach the prompt.** (Use the duplicate Revenue entry from 5.5, then remove it again.)
  Do: chat "How is revenue calculated?" and open What the Agent Saw.
  Expect: a "Conflict (definition) — do not pick a side without asking" warning listing both formulas.

## Part 7 — v0.30.0 Plan run: packs per step, manifests, Explain, staleness

Uses real LLM calls (one per step plus spec and plan). Continue with the problem from Part 1, or start a new one.

1. Get to an executable plan the normal way: approve the specification, complete the Source/Target Context gates, `/plan`, approve the plan, confirm the stages.
2. Click Execute (or `/execute`).

- [ ] **7.1 Each step had its own context.**
  Do: `AutoDE: What the Agent Saw`; open two different "Plan step sN (…)" entries.
  Expect: different seeds and tables per step, matching each step's task text; no `hr_legacy` tables in any step.
- [ ] **7.2 Every artifact has a manifest.**
  Do: open `.ai-context/problems/<problem>/artifacts/`.
  Expect: beside each generated file a `<file>.grounding.json` with `planStepId`, `packId`, `agent`, `model`, `specRevision`, `assertions` and `grounding`. Each artifact appears only once in the panel's artifact list.
- [ ] **7.3 Grounding Report.**
  Do: open `artifacts/04-validate/…/grounding-report.md`.
  Expect: the metrics table (identifier grounding, decision backing, unbacked decisions, STRICT rule violations, context gaps), one row per artifact, and the STRICT rules needing manual review.
- [ ] **7.4 Explain This Artifact.**
  Do: open a generated `.sql` file, run `AutoDE: Explain This Artifact`.
  Expect: a document beside it: generated by / method / spec / pack, then Decisions (each backed by a fact with its evidence, or **unbacked**), Grounding checks, and Context facts. On a file without a manifest you get "…has no grounding manifest".
- [ ] **7.5 Fact-level staleness.**
  Do: change the Revenue formula in `business-context.yaml` again, reload the window, open the panel's 🧰 Workflow Palette (this triggers the staleness check).
  Expect: log lines "<artifact> is stale: context fact changed: "Business term "Revenue" …" was superseded …" for artifacts whose pack included Revenue. Running Explain on one of them shows a **Stale:** banner.
- [ ] **7.6 PII rule is checked.**
  Do: in the Grounding Report, find the PII masking rule.
  Expect: for SQL that selects `email`/`phone` without a hash function, a `RULE_VIOLATION` warning; otherwise pass or not applicable.

---

## Part 8 — v0.31.0 Estate identity

- [ ] **8.1 Bind files to systems and environments first.**
  Do: in a fresh scratch workspace run `AutoDE: Open Estate (Systems & Environments)` and replace the file's content with:
  ```yaml
  systems:
    - { id: shop, name: Shop OMS, role: source }
    - { id: crm, name: CRM, role: source }
  bindings:
    - { file: shop.ddl, system: shop, environment: prod }
    - { file: shop_dev.ddl, system: shop, environment: dev }
    - { file: crm.ddl, system: crm, environment: prod }
  ```
  Save, then import `sources/shop.ddl`, `sources/crm.ddl` and `sources/shop_dev.ddl` (Command Palette → `AutoDE: Ingest File as Source Context`), accepting the suggested system each time.
  Expect: the suggestion for each file shows its bound system and environment.
- [ ] **8.2 Same names stay apart.**
  Do: open `.ai-context/derived/graph.json`.
  Expect: `obj:shop/prod/ref.currency_codes` and `obj:crm/prod/ref.currency_codes` with different columns; `obj:shop/prod/shop.orders` and `obj:shop/dev/shop.orders`, the dev one with `gift_wrap`.
- [ ] **8.3 Legacy dictionary.**
  Do: import `sources/legacy/edw_dbc_columns.csv` as a new system `edw-dbc-columns` (suggested).
  Expect: "Ingested …: 3 table(s), 12 column(s)" and a note that it was read as a Teradata DBC.ColumnsV dictionary; `CUST_NO` is `VARCHAR(20)` and not null.
- [ ] **8.4 Old workspaces migrate in place.** (Only if you kept a workspace from Parts 5–7.)
  Do: open it with this build.
  Expect: log "Re-keyed N legacy id(s)…" and "Context ledger: N re-keyed…"; nothing reported as retracted; "Explain This Artifact" on an earlier artifact still shows its facts.
- [ ] **8.5 Several schemas per connection.** (Needs a connection.)
  Do: Browse… on the source card, pick two schemas, then Source Assessment.
  Expect: tables from both schemas; `estate.yaml` lists both under the connection's binding; running Source Assessment again doesn't retract either schema.

## Results

| Check | Pass / Fail | Notes |
|---|---|---|
| 1.1 |  |  |
| 1.2 |  |  |
| 1.3 |  |  |
| 2.1 |  |  |
| 2.2 |  |  |
| 3.1 |  |  |
| 3.2 |  |  |
| 4.1 |  |  |
| 4.2 |  |  |
| 4.3 |  |  |
| 4.4 |  |  |
| 4.5 |  |  |
| 5.1 |  |  |
| 5.2 |  |  |
| 5.3 |  |  |
| 5.4 |  |  |
| 5.5 |  |  |
| 5.6 |  |  |
| 5.7 |  |  |
| 5.8 |  |  |
| 6.1 |  |  |
| 6.2 |  |  |
| 6.3 |  |  |
| 6.4 |  |  |
| 7.1 |  |  |
| 7.2 |  |  |
| 7.3 |  |  |
| 7.4 |  |  |
| 7.5 |  |  |
| 7.6 |  |  |
| 8.1 |  |  |
| 8.2 |  |  |
| 8.3 |  |  |
| 8.4 |  |  |
| 8.5 |  |  |

For a failure, the most useful notes are: the log lines around it, the relevant `.ai-context` file, and for packs the What the Agent Saw document.
