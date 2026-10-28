# Manual verification — v0.25.0 to v0.36.0

Hands-on checks for the features shipped in v0.25.0–v0.36.0, run in the VS Code Extension Development Host. Each check gives **Do** and **Expect**; tick the box when it holds, and note anything that doesn't in the results table at the end.

Automated coverage already exists (`npm test`, `npm run eval`); these checks cover what only a real VS Code session shows: the panel, prompts, commands, file watching and real LLM providers.

Time: about 90 minutes for Parts 1–8, of which Part 7 (a full plan run) takes the longest, plus about 60 minutes for Parts 9–12 and 20 minutes for Part 13. Parts can be done in any order after Part 0; Part 12.2–12.4 reuse the workspace of Part 10.

---

## Part 0 — Setup (once)



> **The kit (since v0.45.14).** `npm run compile && npm run manual:kit` does this setup for Parts 36 on and more. It builds a workspace next to the repo (`../autode-manual-test`; `--out <folder>` to choose, `--force` to make it again) from the reference problem: the sources, the pack's documents, a connection template, and the AutoDE plugin installed for Claude Code with its guard hook. It then runs, in a throwaway copy, every step that needs no person, no VS Code and no live platform, and writes `MANUAL-KIT.md` in the workspace. That file lists what passed or failed, and for each check what is left for you and whether this machine can run it (VS Code, Claude Code, the Snowflake and Databricks CLIs). Start from that file; the steps below are the manual equivalent.

1. **Build.** In the AutoDE repo: `rm -rf dist && npm run compile`.
2. **Make a scratch workspace** outside the repo, e.g. `D:\autode-manual-test\`, and copy into it:
   - `test/reference/retail-orders/sources/shop.ddl`, `crm.ddl`, `hr_legacy.ddl` → `D:\autode-manual-test\sources\`
   - `test/reference/retail-orders/documents/business-context.yaml` → `D:\autode-manual-test\.autode\knowledge\business-context.yaml`
3. **Launch.** Press F5 in the repo ("Run Extension (Development Host)"). In the new window, **File → Open Folder…** the scratch workspace.
4. **Open the AutoDE panel** (AutoDE icon in the activity bar). Log lines appear as small grey messages in the chat stream; most "Expect" items below refer to those.
5. **Choose an LLM provider** with `/settings` in the chat box. Parts 4 and 7 need a working provider; use Copilot if it is available, plus one API provider (OpenAI, Anthropic, Gemini or Ollama) for Part 4.
6. Keep the Explorer open on `.autode/`; several checks look at files there.
7. **Where commands are:** every step written as "`AutoDE: …`" is a VS Code command, run from the **Command Palette** (Ctrl+Shift+P, type part of the name) **in the Development Host window**. Most have no button in the AutoDE panel. Steps written as `/something` are typed into the AutoDE chat box.

> **Fixed in v0.36.0:** edits to `.autode/knowledge/business-context.yaml` now take effect without a reload (before, that file wasn't watched). Steps below that say to reload after editing it still work; the reload is no longer needed.

---

## Part 1 — v0.25.0 Spec state synchronization

Needs a business problem with a spec. Create one quickly: in chat, `/spec Daily net revenue reporting in Snowflake from the shop orders system`, then wait for the draft.

- [ ] **1.1 External edit is picked up.**
  Do: open `.autode/problems/<problem>/spec/business-problem.yaml` in the editor, change the `problemStatement` text, save.
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
  Expect: it lands under `.autode/config/skills/tool-skills/table-lister/`.
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
  Do: open `.autode/knowledge/ledger/`.
  Expect: a file named `<date>.<26-char id>.jsonl`; each line is an event (`"type":"asserted"`). The four glossary terms and two rules from `business-context.yaml` are there.
- [ ] **5.2 DDL import keeps schemas apart.**
  Do: `AutoDE: Ingest File as Source Context (CSV/JSON/DDL)` three times: `sources/shop.ddl`, `crm.ddl`, `hr_legacy.ddl`.
  Expect: "Ingested shop.ddl: 10 table(s), 72 column(s)", "crm.ddl: 8 table(s), 50 column(s)". Open `.autode/local/derived/graph.json` and search `"fqn": "shop.customers"` and `"fqn": "crm.customers"`: both exist as separate nodes. `shop.orders` has a `channel` column (it was lost before v0.30.0).
- [ ] **5.3 Nodes carry their support.**
  Do: in `derived/graph.json`, look at any table node.
  Expect: `"supportedBy": ["01…"]` and `"origin": { …, "confidence": 0.8 }` (file-derived = documented). The id matches an `asserted` event in the ledger.
- [ ] **5.4 An edit supersedes, history is kept.**
  Do: in `.autode/knowledge/business-context.yaml`, change the Revenue `formula` (e.g. add `- SUM(refunds.amount)`), save, run **Developer: Reload Window**.
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
  Do: open `autode-output/<problem>/`.
  Expect: beside each generated file a `<file>.grounding.json` with `planStepId`, `packId`, `agent`, `model`, `specRevision`, `assertions` and `grounding`. Each artifact appears only once in the panel's artifact list.
- [ ] **7.3 Grounding Report.**
  Do: open `autode-output/<problem>/04-validate/…/grounding-report.md`.
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
  Do: open `.autode/local/derived/graph.json`.
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

## Part 9 — v0.32.0 Working set and catalog

Use a fresh scratch workspace with `sources/shop.ddl` and `sources/crm.ddl` copied in as in Part 0.

- [ ] **9.1 Imports beyond the working set are catalogued, not mirrored.**
  Do: in the Development Host's settings set `autoDataEngineeringHub.context.workingSetMaxTables` to `5`. Import `sources/shop.ddl` (`AutoDE: Ingest File as Source Context`).
  Expect: log "Catalogued 11 table(s); 5 in the working set (limit 5)…". `.autode/local/catalog/shop/<environment>/catalog.json` exists, and `.autode/local/catalog/` holds its own `.gitignore`.
- [ ] **9.2 A task pulls a catalogued table in.**
  Do: ask in chat "Which table records refunds?", then run `AutoDE: What the Agent Saw`.
  Expect: the answer names `shop.refunds`. The pack lists it, and the log shows "Working set: … table(s) promoted from the catalog."
- [ ] **9.3 The customer's vocabulary.**
  Do: copy `test/reference/retail-orders/documents/vocabulary.yaml` to `.autode/knowledge/vocabulary.yaml`, import `sources/crm.ddl`, run **Developer: Reload Window**, then ask "Which patrons are in which engagement?"
  Expect: What the Agent Saw shows the CRM customer and campaign tables among the seeds.
- [ ] **9.4 Reset.** Set `workingSetMaxTables` back to its default (200).

## Part 10 — v0.33.0 Business-problem pack, conformance, probes, vocabulary capture

Needs an active business problem: in chat, `/spec Customer 360 merge of the shop and CRM customer tables`, and wait for the draft. Import `sources/shop.ddl` and `sources/crm.ddl`, accepting systems `shop` and `crm`. Copy these files from `test/reference/retail-orders/` into the scratch workspace's `docs/` folder: `documents/pack/customer-contract.v1.yaml`, `documents/pack/brd.md`, `documents/pack/glossary.md`, `sources/samples/shop_customers.csv`, `sources/samples/crm_customers.csv`.

- [ ] **10.1 Add documents with role and authority.**
  Do: `AutoDE: Add Document to Business-Problem Pack` → `docs/customer-contract.v1.yaml`, role `contract`, authority `signed`, version `1`. Repeat for `docs/brd.md` (`brd`, `draft`), and for each CSV (role `sample`, choosing `customers` in the matching system).
  Expect: one "Added … to the business-problem pack (…)" line per document; the problem folder has `pack/pack.yaml` listing all four.
- [ ] **10.2 A house-format contract gets a reading profile proposed, not applied.**
  Do: `AutoDE: Apply Business-Problem Pack`.
  Expect: for the contract, "AutoDE proposed a reading profile. Check it, set "status: confirmed"…"; a new file under `.autode/knowledge/profiles/`. The BRD reports "N fact(s) proposed for review" with a working LLM, or says it needs one. The samples report "registered as a sample — probes will use it."
- [ ] **10.3 Confirm the profile; clauses become expectations.**
  Do: compare the proposed profile with `test/reference/retail-orders/documents/pack/profile.house-contract.yaml`, correct it if needed, set `status: confirmed`, save, and apply the pack again.
  Expect: "read with profile … — 7 new clause(s), 0 changed, 0 removed".
- [ ] **10.4 Conformance report.**
  Do: `AutoDE: Run Conformance Check`.
  Expect: "Conformance report written: 4 failing clause(s) …"; the report artifact shows four failures for `crm.customers` (`customer_ref` unique, `email` nullability, `country` missing, `created` type) and none for `shop.customers`.
- [ ] **10.5 A new contract version supersedes only what changed.**
  Do: overwrite `docs/customer-contract.v1.yaml` with the content of `documents/pack/customer-contract.v2.yaml`, add it again with version `2`, and apply the pack.
  Expect: "0 new clause(s), 3 changed, 0 removed, 4 unchanged".
- [ ] **10.6 Probes verify claims, with counts only.**
  Do: after the BRD was read in 10.2 (needs a working LLM), run `AutoDE: Verify Claims with Probes`.
  Expect: one ✓/✗ line per claim AutoDE could check, ending "Probes: N verified, M failed (now under review), K not verified". Claims about tables with neither a live connection nor a sample in the pack stay "not verified". Every detail is a count or rate, never a row value. (Chat statements such as "member_id is the key" become claims only with C4b.)
- [ ] **10.7 Vocabulary capture.**
  Do: add `docs/glossary.md` to the pack (role `data_dictionary`, `draft`), then run `AutoDE: Propose Vocabulary`.
  Expect: with a working LLM, single-word entries such as "complaint means ticket" and "parcel means shipment"; never a multi-word phrase. Accepting them writes `.autode/knowledge/vocabulary.yaml` and logs "retrieval re-indexed".
- [ ] **10.8 The interview skips what discovery knows.**
  Do: `/spec` a new problem about `shop.customers` and answer the interview until it asks about keys.
  Expect: no question about the key of a table whose DDL declares one; the log says which question was dropped and why.

## Part 11 — v0.34.0 Tool-skill review and trust

Make a skill folder outside the workspace, e.g. `D:\skills\reader\SKILL.md`:
```markdown
---
name: reader
allowed-tools: [Read]
---
Read README.md and summarise it in three bullet points.
```

- [ ] **11.1 Imported skills are not runnable until reviewed.**
  Do: `AutoDE: Import Tool Skill` → `D:\skills\reader`. Close the message without choosing **Review Now**. Then run `AutoDE: Run Tool Skill`.
  Expect: the import message says it is unreviewed. The run picker says none can run yet. `/skill reader summarise` in chat fails with "has not been reviewed".
- [ ] **11.2 The review page.**
  Do: `AutoDE: Review Tool Skill` → reader.
  Expect: a read-only page with `SKILL.md` verbatim, declared tools `Read`, granted tool `autode_read_file`, provenance and checksum; then a modal with Reviewed / Trusted / Unreviewed.
- [ ] **11.3 Reviewed means read-only, and not through Claude Code.**
  Do: choose **Reviewed (read-only)**, then run the skill on an API provider or Copilot, and again with provider `claude`.
  Expect: the first run works without any write prompt. The `claude` run is refused: "…is reviewed, not trusted: it cannot run through Claude Code…".
- [ ] **11.4 Changed content loses its trust.**
  Do: edit the imported `.autode/config/skills/tool-skills/reader/SKILL.md` (add a line) and run it.
  Expect: "changed since it was reviewed". Reviewing it again restores it. `.autode-skill.json` lists every transition.
- [ ] **11.5 Lifecycle (optional).**
  Do: set `autoDataEngineeringHub.toolSkillManagementEnabled` to true. Import a second skill, review it, `AutoDE: Publish Tool Skill`, edit it, publish again, `AutoDE: Deprecate Tool Skill`. Then `/skill <id>@1 do something`.
  Expect: the Publish/Deprecate/Retire commands appear only with the setting on. Versions go v1 → v2. `.autode-history/v1/` exists. After deprecation, an unpinned run is refused but `@1` runs version 1's instructions.

## Part 12 — v0.35.0 MCP server and packaging

- [ ] **12.1 The server runs on its own.**
  Do: in the repo, `node dist/mcp-server.js --workspace <scratch workspace>`.
  Expect: stderr "autode MCP server 0.35.0 — workspace …", then it waits. Ctrl+C stops it.
- [ ] **12.2 Claude Code can use it.**
  Do: configure it as in [mcp-setup.md](mcp-setup.md) for the scratch workspace from Part 10, start Claude Code there, and run `/mcp`.
  Expect: `autode` connected, 11 tools. Asking "Use AutoDE to find a deduplication primitive and compile it for Snowflake for RAW.ORDERS by ORDER_ID, latest UPDATED_AT" calls search → describe → compile and returns the SQL.
- [ ] **12.3 Context and grounding over MCP.**
  Do: ask Claude Code "Use autode_check_grounding on: SELECT discount FROM shop.orders".
  Expect: `discount` reported as unresolved. `autode_resolve` for "refunds" returns `obj:shop/prod/shop.refunds`. The workspace's files are unchanged afterwards (`git status`, if it is a repository).
- [ ] **12.4 Only reviewed skills are prompts.**
  Do: list prompts in the client (Claude Code: type `/` and look for `autode` entries).
  Expect: the interview prompts, plus `autode_skill_reader` only while reader is reviewed or trusted for its current content.
- [ ] **12.5 The package builds and installs.**
  Do: in the repo, `npx vsce package --no-dependencies`. In a normal VS Code window (not the Development Host), run **Extensions: Install from VSIX…** with the result, and reload.
  Expect: a VSIX of about 480 KB. The extension shows the new icon in the Extensions view and the single-colour glyph in the activity bar; the panel opens; `AutoDE: Run Tool Skill` works (it needs `ajv` and `yaml`, which earlier packages lacked). Uninstall it afterwards if you keep using the Development Host.

## Part 13 — v0.36.0 `.autode/` layout, visible deliverables, migration

- [ ] **13.1 An old workspace is moved over.**
  Do: take a workspace used with v0.35.0 or earlier (it has `.ai-context/`; Part 10's is ideal) and commit it if it is a repository. Open it with this build.
  Expect: a notification "AutoDE now keeps its working state in .autode/ … Moved N file(s) …". `.ai-context/` is gone (or holds only what was listed as not recognised). `.autode/` has `problems/`, `knowledge/` (ledger, estate.yaml, profiles, business-context.yaml …), `config/` (skills, target-environment.yaml), `local/` and a `.gitignore` containing `local/`. Generated artifacts are under `autode-output/<problem-id>/`.
- [ ] **13.2 Nothing is lost.**
  Do: run `git status` and `git diff -M --stat`; then ask a chat question about a table and run `AutoDE: What the Agent Saw`; open an artifact and run `AutoDE: Explain This Artifact`.
  Expect: git shows renames, no content changes (`local/` contents are no longer listed — they are ignored now). The pack and the explanation show the same facts as before; nothing new is "needs review".
- [ ] **13.3 A fresh workspace starts in the new layout.**
  Do: open an empty folder, `/spec` a problem, run a plan step that writes an artifact.
  Expect: only `.autode/` and `autode-output/` appear; the artifact is under `autode-output/<problem-id>/<phase>/<specId>.v1/`; `📂 Open .autode` in the context drawer opens `.autode/`; "open artifacts folder" opens the problem's output folder.
- [ ] **13.4 Business context edits apply live.**
  Do: edit `.autode/knowledge/business-context.yaml` (add a term), save, wait a second, ask about the term.
  Expect: the term is known without reloading the window.
- [ ] **13.5 The output folder setting.**
  Do: set `autoDataEngineeringHub.artifactDirectory` to `deliverables`, run a step; then set it to `../outside`.
  Expect: the first run writes to `deliverables/<problem-id>/…`; the second falls back to `autode-output/` (paths that leave the workspace are refused).

## Part 14 — v0.37.0 MCP data-platform tools, read-only guard, sample-data consent

Needs real accounts. Use a role that can only read. Configure the server as in [mcp-setup.md](mcp-setup.md) (Data platforms) for a scratch workspace, and keep the client's MCP log open.

- [ ] **14.1 Snowflake through a CLI connection.**
  Do: add `{ platform: snowflake, credentials: { resolver: cli, ref: <your connection> } }` to `.autode/config/connections.yaml`; start the server with `--allow-cli`. In Claude Code: "list AutoDE connections", then list databases and schemas, "extract metadata for <DB>.<SCHEMA>", "explain SELECT * FROM <table>", "run SELECT COUNT(*) FROM <table>".
  Expect: the connection id is `snowflake:<connection>`; each call answers; the SELECT returns columns and `rowCount` but no rows, with a `withheld` note; the explain returns a plan. Without `--allow-cli` the first call fails with `PERMISSION_DENIED` naming `--allow-cli`.
- [ ] **14.2 Snowflake key-pair over the SQL API.**
  Do: an entry with `account`, `username`, `authMode: key-pair`, `credentials: { resolver: env, ref: kp }`; set `AUTODE_SNOWFLAKE_KP_PRIVATE_KEY_PATH` (and `…_PRIVATE_KEY_PASSPHRASE` if the key is encrypted) in the client's `env`. Repeat 14.1's calls without `--allow-cli`.
  Expect: the same results. `autode_list_connections` shows `authMode: key-pair`, `resolver: env`, and no key path or passphrase.
- [ ] **14.3 Databricks with a token.**
  Do: an entry with `workspaceUrl`, `httpPath`, `credentials: { resolver: env }`; `AUTODE_DATABRICKS_TOKEN` in `env`. List catalogs and schemas, extract metadata, explain, select.
  Expect: all answer; a wrong token gives `AUTH_FAILED`, and the token appears in neither the response nor the server's stderr.
- [ ] **14.4 No CLIs installed.**
  Do: on a machine (or a shell with `PATH` trimmed) where neither `snow` nor `databricks` resolves, run 14.2 and 14.3.
  Expect: both work.
- [ ] **14.5 Writes are refused, then allowed only on request.**
  Do: ask the agent to run `CREATE TABLE autode_probe (id INT)`, then `SELECT 1; DROP TABLE x`, then `SELECT 1 /* ; */ ; DELETE FROM x`. Restart the server with `--allow-write` and ask again for the CREATE (in a schema where that's harmless; drop it afterwards).
  Expect: `WRITE_NOT_ALLOWED`, then `VALIDATION_FAILED` twice, and nothing reaches the platform (its query history shows none of them). With `--allow-write` the client asks for confirmation before the CREATE runs.
- [ ] **14.6 Sample data with consent.**
  Do: set `allowSampleDataInPrompts: true` on one connection (no restart) and run a SELECT that includes an e-mail or name column and an ordinary one.
  Expect: rows come back; the personal-data column shows `[masked]`, the ordinary column its values; `maskedColumns` lists the masked one. Set it back to `false`: rows are withheld again on the next call.
- [ ] **14.7 The extension honours the same consent.**
  Do: in the AutoDE panel, connect the source and run Source Assessment with profiling; open `.autode/local/schema-graph.json`.
  Expect: column profiles have distinct and null counts but no `minValue`/`maxValue` unless the connection's entry allows sample data.

## Part 15 — v0.38.0 Platform prerequisites, Oracle driver install, Oracle as a source

Needs an Oracle Database 19c (or any 12.1+) you can reach, a read-only user, and a tnsnames.ora with an alias for it.

- [ ] **15.1 Nothing happens until you ask.**
  Do: reload the window and connect an existing Snowflake source as usual.
  Expect: no "AutoDE" terminal, and nothing new under `~/.autode/drivers`.
- [ ] **15.2 Prerequisites are listed.**
  Do: **AutoDE: Check Platform Prerequisites**.
  Expect: Snowflake CLI and Databricks CLI (optional; ready or missing with their install guides) and the Oracle driver (`missing`), each with a reason.
- [ ] **15.3 The install is explained and runs only on click.**
  Do: pick the Oracle driver (or run **AutoDE: Install Oracle Driver**). Read the dialog, then press **Copy command** once, and run the command again with **Run in AutoDE terminal**.
  Expect: the dialog shows the `npm install --prefix "…/oracle" --ignore-scripts … "oracledb@^6.0.0"` command, the folder, size, licence and the 12.1+ note. Copy puts exactly that on the clipboard and runs nothing. Run opens a terminal named "AutoDE" and npm installs from your usual registry (check `npm config get registry` if you have an internal one). Afterwards **Verify** reports "ready" with the version, and `.autode-driver.json` exists in the folder.
- [ ] **15.4 A changed folder must be verified again.**
  Do: run `npm install --prefix ~/.autode/drivers/oracle "oracledb@^6.0.0"` once more yourself (or edit `package-lock.json`), then connect Oracle (15.5).
  Expect: if the lockfile changed, the connection fails with "changed after it was verified … Verify Oracle Driver"; after verifying, it connects.
- [ ] **15.5 Connect through a tnsnames alias.**
  Do: set `defaultProvider` = `oracle`, `defaultOracleConnectString` = your alias, `defaultOracleUsername`, and (if tnsnames.ora isn't under TNS_ADMIN) `oracleConfigDir`; **AutoDE: Set Oracle Password**; Test Connection.
  Expect: "Connected to source oracle: <PDB>.<USER> (v19…)". A wrong alias names the tnsnames.ora that was searched and the aliases found.
- [ ] **15.6 Easy Connect and Source Assessment.**
  Do: switch the connect string to `host:1521/service`, test again, then run Source Assessment with profiling on a schema with keys.
  Expect: it connects; `.autode/local/schema-graph.json` has the schema's tables and views with comments; primary-key and foreign-key columns are flagged; LOB columns have no profile.
- [ ] **15.7 Oracle over MCP.**
  Do: add an Oracle entry to `.autode/config/connections.yaml` (as in mcp-setup.md, password in `AUTODE_ORACLE_PASSWORD`), restart the server, and in Claude Code list connections, extract metadata for the schema, explain a SELECT, and run one.
  Expect: all answer; the explain shows a DBMS_XPLAN plan; the SELECT returns no rows (consent off); `SELECT q'[a']' ; DROP …` is refused.
- [ ] **15.8 No npm.**
  Do: on a machine (or a shell with `PATH` trimmed) without npm, run **AutoDE: Install Oracle Driver**.
  Expect: a dialog saying npm is missing, offering Node.js and the `driversDirectory` setting; nothing runs.

## Part 16 — v0.39.0 Platform onboarding in the cards, named connections

Use a scratch workspace with a git repository (to see what would be committed). Keep the AutoDE chat log visible.

- [ ] **16.1 Existing flows unchanged.**
  Do: with no saved connections, fill in the Snowflake source card as before and click **Connect**; repeat for a Databricks target.
  Expect: both connect as in v0.38.0; the Saved connections lists say "None yet"; no `.autode/config/connections.yaml` is created.
- [ ] **16.2 Prerequisites and backend in a card.**
  Do: open the Oracle source card, click **Check prerequisites**; switch the Snowflake card's auth mode between Key-Pair and Username + Password.
  Expect: the Oracle driver with its state and the exact `npm install …` command (nothing runs); **Install…** opens DRV1's install dialog. The Snowflake backend line changes between "SQL API (REST)" and "Snowflake CLI (native protocol)" with its caveat.
- [ ] **16.3 A failed check saves nothing.**
  Do: in the Snowflake source card, enter a wrong password and click **Save as named connection**.
  Expect: "Not saved — the connectivity check failed: …"; no connections file changes (`git status` clean).
- [ ] **16.4 Saving splits team, personal and secret.**
  Do: fix the password, **Save as named connection** with *Share with the team* on.
  Expect: `.autode/config/connections.yaml` has the entry (`id`, account, warehouse, `snowflakeRole`, `credentials: { resolver: vscode, ref: … }`) and no username, key path or password; `.autode/local/connections.yaml` (ignored by git) has the username/key path; Saved connections shows **AutoDE: ready**, **MCP: not ready** with `AUTODE_SNOWFLAKE_<REF>_PASSWORD`, and "● " as in use.
- [ ] **16.5 Connect uses the named connection.**
  Do: change the card's account field to something wrong, save settings, click **Connect**.
  Expect: it still connects (to the named connection) and the card shows the "Connect uses the saved connection …" banner. **Use card fields** switches back, and Connect then fails with the wrong account.
- [ ] **16.6 Existing CLI connection and Databricks profile.**
  Do: **Find existing** in the Snowflake card, pick a `connections.toml` connection, **Save as named connection** (consent prompt if asked). In the Databricks card, enter the HTTP path, **Find existing**, pick a profile with a token, save.
  Expect: both saved with `resolver: cli` and shown **MCP: ready** (Snowflake noting `--allow-cli`). A profile without a token is greyed out with the reason.
- [ ] **16.7 Oracle alias.**
  Do: in the Oracle card set the tnsnames folder, **Find existing**, pick an alias, enter the username and password, save.
  Expect: the alias fills the connect string; the entry saves after a passing check; MCP shows the `AUTODE_ORACLE_<ALIAS>_PASSWORD` variable.
- [ ] **16.8 Readiness lapses on edit; Re-check; Remove.**
  Do: edit the saved Snowflake entry's warehouse in the committed file; reopen settings. Then **Re-check**. Then **Remove** and confirm.
  Expect: "AutoDE: re-check" after the edit; ready again after Re-check; Remove deletes it from both files, its secret is gone (Connect with it would fail), and Connect falls back to the card.
- [ ] **16.9 Over MCP.**
  Do: with the 16.4 entry, start the MCP server (mcp-setup.md) without and then with `AUTODE_SNOWFLAKE_<REF>_PASSWORD` in the client's `env`; call `autode_list_connections` and `autode_test_connection`.
  Expect: the listing shows `secretFromEnv`; without the variable the test fails naming it; with it, it connects.

## Part 17 — v0.40.0 Decisions and proposal tools

Use the scratch workspace from Part 16 with an active business problem and a source assessed (so AutoDE knows some tables). Register AutoDE's MCP server in Claude Code (mcp-setup.md) and keep the Workflow Palette open.

- [ ] **17.1 A bad proposal is refused item by item.**
  Do: in Claude Code ask "propose a mapping from <a known table> to FACT_X, mapping a column that doesn't exist".
  Expect: the tool answers `VALIDATION_FAILED` naming the column; nothing appears in `.autode/decisions/`.
- [ ] **17.2 A valid proposal waits for you.**
  Do: ask for a correct mapping. Then ask Claude Code to approve it.
  Expect: a decision appears under **Decisions** (high stakes, "from mcp · Claude Code"); the agent's approval is refused, naming the panel and the decision file; `mapping-context.yaml` is unchanged.
- [ ] **17.3 Approve in the panel.**
  Do: Approve it with a note.
  Expect: `mapping-context.yaml` has the mapping; the decision moves to Recent as applied with your user name; its YAML shows the approved and applied events.
- [ ] **17.4 Approve through the file.**
  Do: ask for a spec change (e.g. one more objective). In `.autode/decisions/<id>.yaml` set `resolution.decision: approved` and `resolution.by: <you>`; save.
  Expect: the specification becomes a new draft version with the objective; approve it in the panel as usual. Without `by`, the log says it is incomplete and nothing happens.
- [ ] **17.5 Superseded, not applied.**
  Do: propose another spec change; before approving it, edit the specification by hand; then approve the decision.
  Expect: the decision is superseded and your hand edit stays.
- [ ] **17.6 Low-stakes fact through the agent.**
  Do: ask Claude Code to add a glossary term and accept it.
  Expect: Claude Code asks you first (destructive tool); after you agree, the term is in the ledger as confirmed (`autode_list_assertions`).
- [ ] **17.7 Platform writes need approval.**
  Do: ask Claude Code to insert a row into a scratch table.
  Expect: `autode_execute_query` refuses and the agent proposes a runbook instead (since 0.45.8; Part 32 runs it).
- [ ] **17.8 Panel approvals are recorded.**
  Do: approve a specification in the panel the usual way.
  Expect: a `spec_approval` decision appears under Recent with your name.

## Part 18 — v0.41.0 Facts from conversation, Context Inbox, paused steps

Use a workspace with the retail reference sources imported (`test/reference/retail-orders/sources`) and an approved specification, with your usual assistant (e.g. Copilot) selected. Keep the Workflow Palette open on **Context Inbox**.

- [ ] **18.1 Extraction quality (the C4b measurement, done by hand).**
  Do: send the eleven turns of `test/reference/retail-orders/chat-script.yaml` in order, one message each.
  Expect: after each turn the reply arrives at its normal speed, and within a few seconds facts appear in the Inbox. Compare with `golden/assertions.yaml` (the turns' `facts`): record how many golden facts appear (target ≥ 90%: at least 13 of 14) and anything extra or wrong. t10 asks for something without stating a fact.
- [ ] **18.2 The correction (trap 2).**
  Do: after t6, look at the CRM customer key.
  Expect: the cust_no fact says "corrects: … customer_id" and there is no key conflict. Confirm it: the customer_id fact disappears from the Inbox and is superseded in the ledger.
- [ ] **18.3 Confirm, edit, reject, bulk.**
  Do: confirm one fact, edit another (change its value JSON), reject a third. Apply a business document with several documented facts and use "Confirm all … documented facts".
  Expect: each action is logged; the edited fact is active with your text; the rejected one is gone; bulk confirmation only offers documented facts from one source.
- [ ] **18.4 Verify now.**
  Do: with the source connected, Verify the loyalty member_id key (from t7).
  Expect: "Failed verification: member_id is not unique …" and the fact shows ✖ with the numbers. Without a connection: "Not verified — no live source connection".
- [ ] **18.5 Capture commands.**
  Do: `/define Active customer = ordered in the last 90 days`, `/rule PII must never reach the marts`, `/decide Use SCD2 for customers`, `/assume Refunds arrive within 30 days`.
  Expect: each answers "Recorded as a proposed …" at once (no model call) and appears in the Inbox.
- [ ] **18.6 Citations.**
  Do: after confirming the orders key, ask "what is the key of shop.orders?".
  Expect: the answer has a "fact 1" chip; hovering shows "order_id is the key …".
- [ ] **18.7 A step pauses on a missing join.**
  Do: add a plan step about "support tickets per order" and run the plan.
  Expect: the run pauses at that step; the Inbox shows it with the missing relationship; "Continue without it" runs it, and so does stating the join in chat, confirming it, and running again.
- [ ] **18.8 Tool-action memory.**
  Do: in a chat with "Can edit" on, ask the assistant to write a small file; then ask "what did you just change?".
  Expect: an "Actions: wrote …" line under the reply; the follow-up answer knows the file it wrote.
- [ ] **18.9 Extraction never breaks chat.**
  Do: switch to a provider that is not configured (or withdraw consent) and chat.
  Expect: the chat reply (or its usual error) is unchanged; no extraction error appears in the chat.
- [ ] **18.10 Facts from another agent.**
  Do: in Claude Code, ask it to record a glossary term and a key for shop.orders through AutoDE.
  Expect: both appear in the Inbox as from "mcp · …"; Claude Code may confirm the term after asking you, but is refused for the key.

## Part 19 — v0.42.0 The `autode` package and CLI

Build the package first: `npm run package:cli` (the tarball is `dist/autode-0.42.0.tgz`). Install it into a scratch prefix, so your global npm stays clean: `npm install --prefix <scratch> dist/autode-0.42.0.tgz`. The command is then `<scratch>/node_modules/.bin/autode` (`autode.cmd` on Windows). Below, `autode` means that command. Use the reference workspace from Part 18, which has `.autode/`.

- [ ] **19.1 Install and identity.**
  Do: `autode --version`, then `autode doctor` in the workspace.
  Expect: the version is 0.42.0. `doctor` lists Node, the workspace with its problems and the active one, the drivers folder, the prerequisites of the platforms your connections use, and each saved connection with its readiness for AutoDE and for MCP clients (as shown in the settings card's Saved connections).
- [ ] **19.2 The CI gate.**
  Do: run `autode check; echo $?` (PowerShell: `autode check; $LASTEXITCODE`). Then ask Claude Code to propose a mapping through AutoDE, and run `check` again. Then break `spec/pipeline.yaml` (for example `entities: 5`) and run it once more.
  Expect: 0 and "check passed"; then 3, naming the pending mapping decision; then 1, naming the broken document (a validation failure outranks the decision). Restore the file.
- [ ] **19.3 Decisions need a person.**
  Do: `autode decisions list`, then `autode decisions approve <id> | cat` (piped, so there is no terminal), then `CI=1 autode decisions approve <id>` (PowerShell: `$env:CI=1`, and clear it afterwards). Finally run `autode decisions approve <id>` in a plain terminal, type something other than `approve`, and then run it again typing `approve`.
  Expect: the piped run and the CI run are refused with exit 4. The wrong word changes nothing. Typing `approve` applies the mapping: the Mapping Context has it, the panel's Context Inbox no longer lists it, and `decisions show <id>` shows *approved* on channel `cli` by your OS user name.
- [ ] **19.4 Compile and grounding.**
  Do: `autode compile --dialect snowflake`, then `autode compile --dialect spark_sql --out <scratch>/out`, then `autode grounding <scratch>/out/<entity>/01_*.sql`.
  Expect: the SQL matches what the panel's Pipeline Spec build produces. The files land under `<scratch>/out`, not in the workspace. Grounding is ✓ for tables AutoDE knows, and a misspelled table gives exit 1.
- [ ] **19.5 Conformance and probe.**
  Do: with the Part 10 pack (signed contract and a CRM sample) in place, run `autode conformance` and `autode probe`. If you have a source connection, add `--connection <id>`.
  Expect: the same failing clauses as *Run Conformance* in the panel. The probe shows ✗ for cust_no with "(sample data)" and ends with "Nothing was recorded". The Inbox shows no new verification.
- [ ] **19.6 `autode mcp` in Claude Code.**
  Do: put the scratch `node_modules/.bin` folder on your `PATH`, then in VS Code run **AutoDE: Configure MCP for Claude Code**. Read the modal, write the file, and start Claude Code in the workspace. Then remove the folder from `PATH` and run the command again.
  Expect: the first `.mcp.json` runs `autode mcp --workspace .` (`cmd /c autode …` on Windows), any other servers in the file are kept, and `/mcp` shows autode connected with the same tools as before. The second run offers the extension's own `dist/autode.js` and says its folder changes with updates.
- [ ] **19.7 A stale path is noticed.**
  Do: edit `.mcp.json` so the autode entry runs `…/auto-data-engineering-hub-0.41.0/dist/mcp-server.js`, then reload the window.
  Expect: an info message ".mcp.json runs the AutoDE MCP server from an older extension version" with *Update .mcp.json*. Nothing is written until you click it.
- [ ] **19.8 The VSIX still works offline.**
  Do: `npx vsce package --no-dependencies`, install the VSIX with the network off, and open the panel. Then point a client at `node <extension>/dist/mcp-server.js`.
  Expect: the extension activates as before, and the old server path still connects.

## Part 20 — v0.43.0 Extension as MCP client, agent mode, stable server copy

Use VS Code 1.101 or later with Copilot, and the reference workspace from Part 18. Remove any `.vscode/mcp.json` that defines an `autode` server first.

- [ ] **20.1 Agent mode without configuration.**
  Do: reload the window, open Copilot Chat in agent mode and its tools picker, then run **MCP: List Servers**.
  Expect: an **AutoDE** server with AutoDE's tools; starting it needs no Node.js on `PATH`. Ask "which transform primitives does AutoDE have?" and the agent calls `autode_search_primitives`.
- [ ] **20.2 VS Code-stored secrets reach it, and only at start.**
  Do: with a Databricks or Snowflake connection saved from a settings card (secret in VS Code's storage) and no `AUTODE_*` variables set, ask agent mode to list that connection's schemas. Then run **MCP: List Servers → AutoDE → Show Configuration**.
  Expect: the schemas come back. The configuration shows the command and `ELECTRON_RUN_AS_NODE`, but no secret.
- [ ] **20.3 Nothing starts at activation.**
  Do: reload the window and watch the process list (Task Manager or `ps`) without opening agent mode or running a skill.
  Expect: no extra AutoDE server process appears until agent mode starts one.
- [ ] **20.4 A skill uses the engine.**
  Do: import a skill whose `SKILL.md` declares `allowed-tools: [Read, mcp__autode__autode_search_primitives, mcp__autode__autode_compile_transform]` and says "compile a dedup of shop.orders on order_id with AutoDE's primitive". Review and trust it, then run it on Copilot or an API-key provider.
  Expect: the run's log reports "… engine tool(s)", the result holds SQL from the `dedup` primitive, and the audit lists the engine calls. Set the skill back to *reviewed* and run it again: it runs read-only, and a declared `autode_propose_mapping` is not offered.
- [ ] **20.5 Claude Code is offered none.**
  Do: run the trusted skill from 20.4 with Claude Code as the provider.
  Expect: it runs as before (whole-run approval); no engine tools are offered.
- [ ] **20.6 `.mcp.json` survives an update.**
  Do: make sure `autode` isn't on `PATH`, run **AutoDE: Configure MCP for Claude Code**, then install a VSIX with a higher version and reload.
  Expect: `.mcp.json` points into `globalStorage/…/autode-server/`. After the update, the log says the copy was updated, and Claude Code's `/mcp` still connects and reports the new version.
- [ ] **20.7 Same artifacts as v0.42.0.**
  Do: run the full flow (Part 7) on the reference problem with v0.42.0 and with v0.43.0, then diff the two `autode-output/<problem>/` trees.
  Expect: the same artifacts and grounding manifests. Only timestamps and generated ids differ.

## Part 21 — v0.43.1 Connections without VS Code

Use a terminal with the `autode` command (Part 19), a scratch folder, and at least one existing Snowflake CLI connection (`snow connection list`) or Databricks profile (`~/.databrickscfg`).

- [ ] **21.1 Add from an existing CLI connection.**
  Do: `autode connections add` in the scratch folder. Choose your platform, pick your connection or profile from the list, and answer the remaining questions (for Databricks, the SQL warehouse HTTP path).
  Expect: only the missing settings are asked for, the test connects, and after you type `save` the file `.autode/config/connections.yaml` names the connection or profile with no secret in it. `autode connections list` shows it as ready.
- [ ] **21.2 A failing test saves nothing.**
  Do: run `add` again with `--ref` set to a profile that has an expired token (or a wrong HTTP path).
  Expect: "✗ The connection failed: …" with the platform's own message, then "Nothing was saved".
- [ ] **21.3 Environment variables.**
  Do: `autode connections add --platform snowflake --resolver env --ref prod` with a key-pair user, without setting any `AUTODE_*` variable. Answer the questions, then save with `--no-test`. Next, set the variables `connections list` names and run `autode connections test snowflake:<account>`.
  Expect: the username and key path are in `.autode/local/connections.yaml`, not the team file. `list` names the missing variables. After the test passes, the connection is ready.
- [ ] **21.4 Only a person.**
  Do: run `autode connections add` from Claude Code's agent (or as `echo | autode connections add`), and again with `CI=1`.
  Expect: both are refused with exit code 4.
- [ ] **21.5 An agent proposes; you approve.**
  Do: in Claude Code with AutoDE's MCP server, ask "set up a connection to my Databricks profile prod with warehouse path …". Then run `autode decisions list` and `autode decisions approve <id>`.
  Expect: the agent proposes it, and it can't approve it itself. After your approval, `autode connections list` shows it. The agent can then test it with `autode_test_connection`.
- [ ] **21.6 The same files as the settings card.**
  Do: open the scratch folder in VS Code with the extension.
  Expect: the connection added in 21.1 is in the Saved connections list of its tab.

## Part 22 — v0.43.2 Business problems and the estate without VS Code

Use the `autode` command (Part 19) and an empty scratch folder with the reference DDL files from `test/reference/retail-orders/sources/`.

- [ ] **22.1 Start and switch problems in a terminal.**
  Do: `autode problems new "Merge the shop and CRM customer data into one analytics model"`, then a second problem, then `autode problems list` and `autode problems use <first id>`.
  Expect: each problem's folder holds a v1 draft with only the statement, and the active one is marked with `*`. Open the folder in VS Code: the panel shows the same problems and the same active one.
- [ ] **22.2 Load the estate from files.**
  Do: `autode estate ingest sources/shop.ddl --system shop`, then `autode estate ingest sources/crm.ddl --system crm`, then `autode estate show`.
  Expect: two systems and two bindings, with 11 and 9 tables catalogued. `autode grounding` on a query over `shop.orders` passes. In VS Code, *Open Estate* shows the same systems.
- [ ] **22.3 Load the estate from a connection.**
  Do: `autode estate extract --connection <id> --schema <DATABASE.SCHEMA> --system <name>`, then run it again with only `--connection`.
  Expect: the schema's tables arrive under that system; the second run reuses the bound schema. With `--profile` and sample data not allowed for the connection, no row values appear in the catalog.
- [ ] **22.4 An agent does the same.**
  Do: in Claude Code with the server, say "start a business problem for modernizing the HR payroll feeds, and bring in sources/hr_legacy.ddl as system hr".
  Expect: it calls `autode_start_problem` and `autode_ingest_file`. `autode problems list` and `autode estate show` show the results, and the agent's next proposals are about this problem.
- [ ] **22.5 The panel sees agent and terminal work.**
  Do: with the panel open, ingest a file from the terminal, then run *Re-index Context* in VS Code.
  Expect: the new tables are in the context drawer. Without a re-index, the panel picks them up at the next reload.

## Part 23 — v0.43.3 Facts, pack, vocabulary and SQL without VS Code

Use the workspace from Part 22 and Claude Code with the AutoDE server.

- [ ] **23.1 Review facts in a terminal.**
  Do: ask Claude Code to record "order_id is the key of shop.orders" and the term "Order = a customer purchase" through AutoDE. Then run `autode facts`, `autode facts confirm <key id>`, `autode facts edit <term id> --value '{"term":"Order","definition":"A paid purchase"}'`, and a reject with `--note`.
  Expect: the key shows as high stakes and the term as low stakes. Each change asks you to type the verb, and the panel's Context Inbox shows the same result. Piped or with `CI=1`, the commands are refused.
- [ ] **23.2 A pack without VS Code.**
  Do: `autode pack add docs/customer-contract.yaml --role contract --authority signed --doc-version 1`, then `autode pack apply`, then put the confirmed profile in `.autode/knowledge/profiles/` and apply again. Next, have the agent add the CRM sample (`autode_pack_add`) and run `autode_check_conformance`.
  Expect: the first apply reports that no confirmed profile fits; the second applies 7 clauses. The agent's document is a draft, and conformance reports the duplicate `cust_no` from the sample, matching `autode conformance`.
- [ ] **23.3 Vocabulary.**
  Do: `autode vocabulary mine` on an estate with cryptic names, then `autode vocabulary accept` and pick one. Next, ask the agent to propose a synonym; it asks you, then approves.
  Expect: entries in `.autode/knowledge/vocabulary.yaml`, and `autode_resolve` finds tables by the new words.
- [ ] **23.4 SQL from the terminal.**
  Do: `autode query --connection <id> "SELECT * FROM <table>"` on a connection without sample-data consent, then `autode query … "DELETE FROM <table>"`, then `autode explain --connection <id> "<a MERGE statement>"`.
  Expect: columns and the row count without values; the DELETE refused; a plan for the MERGE, with nothing run.

## Part 24 — v0.44.0 Workflow templates and runtime

Use the reference workspace in VS Code, the `autode` command, and Claude Code with the server.

- [ ] **24.1 Suggestion and draft.**
  Do: start a problem whose statement mentions migrating a legacy warehouse, then approve its specification in the panel. Open the Workflow Palette → **Workflow**.
  Expect: the suggestion is modernization, with the words it matched. **Draft the workflow** lists the stages. Conformance is included only if the pack has a contract; code conversion is left out "condition … is false". A workflow decision appears in the Context Inbox.
- [ ] **24.2 The plan gate.**
  Do: before approving the workflow, try Generate Plan; then approve the workflow in the Context Inbox.
  Expect: Generate Plan is blocked with "Plan the workflow and approve it". After approval, sources and target are ready, and the mapping waits for both to be approved.
- [ ] **24.3 The same state everywhere.**
  Do: run `autode workflow status`, and ask Claude Code "what's the next step in AutoDE's workflow?".
  Expect: the same stages and states; the agent names the next stage and role from `autode_workflow_next`.
- [ ] **24.4 A gate stage.**
  Do: ask the agent to hand in the quality-rules stage with a file it wrote, then approve it with `autode workflow approve quality` in a terminal.
  Expect: the agent can't approve it itself. After your approval the stage is done in the panel too.
- [ ] **24.5 Staleness.**
  Do: approve the mapping, then revise and re-approve the source context.
  Expect: the mapping turns stale "source-context changed since it was approved", and shows *Approve again…*.
- [ ] **24.6 Skip and re-open.**
  Do: skip *Deploy* with a reason, try to skip *Reconcile*, then re-open *Quality rules*.
  Expect: Deploy is skipped with the reason shown; Reconcile is refused as mandatory; re-opening turns the stages after it stale.
- [ ] **24.7 An existing problem.**
  Do: open a problem created before v0.44.0.
  Expect: a draft workflow from its old greenfield or brownfield setting. Its approved spec counts; the workflow needs one approval.
- [ ] **24.8 Your own template.**
  Do: copy `workflows/modernization.yaml` into `.autode/config/workflows/`, add an optional stage, and break one dependency on purpose.
  Expect: the editor flags schema problems while you type, and `autode workflow templates` names the broken dependency. Fix it: the new stage is offered in the next draft.

## Part 25 — v0.44.1 Workflow view, history and provenance

- [ ] **25.1 The view.**
  Do: open a problem whose spec is approved. Look at the **Workflow** tree in AutoDE's activity bar and the status bar, then open **AutoDE: Open Workflow**.
  Expect:
  - the tree lists the stages with icons and their state or reason;
  - the status bar reads "AutoDE: <problem> · n/m · …";
  - the editor tab shows the stage board in dependency columns and the provenance: "Suggested by the engine: … (rule: …)", then "Proposed by …" and "Approved by …".
- [ ] **25.2 Approve from the view.**
  Do: in the editor tab, approve the pending workflow, then hand in a gate stage and approve it.
  Expect: each approval asks for confirmation as you (the panel channel). The stage detail shows the decision trail and a history entry "approved by <you> (panel)".
- [ ] **25.3 Agents are labelled.**
  Do: have Claude Code skip *Deploy* with a reason.
  Expect: the history reads "skipped by agent <client> via MCP (tool) — <reason>", in the view and in `autode workflow history deploy`.
- [ ] **25.4 Stale, explained.**
  Do: approve the mapping, then re-approve the source context with a change.
  Expect: the Mapping card turns red, "source-context changed since it was approved", with *Approve again…*; the history shows "stale by the engine (rule: inputs changed)".
- [ ] **25.5 The agents box.**
  Do: in the editor tab, use **AutoDE agents** to generate plan steps, approve them, confirm the stages and generate artifacts.
  Expect: the same behaviour as the palette's old Continue button. The palette no longer shows Phases or Agents; it links to the view.

## Part 26 — v0.45.0 Agents as definitions: the documenter, assignments, the plugin

- [ ] **26.1 Run agent in VS Code.**
  Do: with a model other than Claude Code, open a problem whose workflow is approved and whose Documentation stage is ready. In the Workflow view, choose **Run agent** on it.
  Expect:
  - a progress notification;
  - files under `autode-output/<problem>/04-validate/document/`, each with a `.grounding.json` beside it;
  - the stage handed in;
  - history entries "recorded by agent documenter (VS Code) via MCP" and "handed in by agent documenter via VS Code".
- [ ] **26.2 Claude Code as the model.**
  Do: switch AutoDE's model to Claude Code and choose Run agent.
  Expect: a message pointing to `autode plugin install --host claude`; nothing changes.
- [ ] **26.3 Claude Code with the plugin.**
  Do: in a terminal in the project, run `autode plugin install --host claude`, start Claude Code, and ask it to "continue my AutoDE problem".
  Expect:
  - it reads the status, takes the assignment from `autode_workflow_next`, and runs the `documenter` sub-agent;
  - it records files with `autode_record_artifact` and hands the stage in;
  - it stops at the approval and tells you how to give it. It never approves.
- [ ] **26.4 Copilot CLI and Cortex Code.**
  Do: run `autode plugin install --host copilot` and `--host cortex --scope user`.
  Expect: agents in `.github/agents/documenter.agent.md`, skills in the host's folder, and the printed MCP step (the Copilot CLI's `/mcp add`, or the `~/.snowflake/cortex/mcp.json` entry). Follow the step, then ask the host to continue the problem.
- [ ] **26.5 No sub-agents.**
  Do: in another MCP client, get the prompt `autode_agent_documenter` with `stage: document`.
  Expect: the full assignment text: role, tier, tools and the documentation skill.
- [ ] **26.6 An old plan.**
  Do: run a plan saved before v0.45.0 that has an `architectureAgent` step.
  Expect: that step fails with "Documentation moved to the workflow: run the document stage from the Workflow view…"; the other steps run.

## Part 27 — v0.45.1 The workflow is the only path

- [ ] **27.1 The proposal.**
  Do: draft a workflow from the Workflow tab and don't approve it yet.
  Expect: a table of every stage with its kind, its inclusion and whether it is in; each left-out stage shows its reason.
- [ ] **27.2 Next, everywhere.**
  Do: after approving the workflow, look at the tree, the cards and the stage detail.
  Expect: every stage says what moves it forward: Run agent, Produce, Approve, Hand in, Skip, or what it waits for.
- [ ] **27.3 Approve the mapping.**
  Do: on Mapping, use *Add a mapping…*.
  Expect:
  - before any mapping exists, the card says the mapping can't be approved yet and why;
  - after one is added, **Approve…** appears, asks for confirmation as you, and the stage is done ("approved by <you> (panel)");
  - `autode workflow approve mapping` in a terminal does the same.
- [ ] **27.4 Quality rules.**
  Do: Run agent on Quality rules.
  Expect:
  - the quality engineer proposes `quality_expectation` facts (Context Inbox) and records `quality-rules.yaml` and `quality-rules.md` under the stage's folder;
  - the stage is handed in and waits for your approval.
- [ ] **27.5 Per-stage agents.**
  Do: Run agent on Modelling.
  Expect: only the data modeler runs. Its files are listed as the stage's outputs, and nothing else is generated.
- [ ] **27.6 No side door.**
  Do: in the panel, use Generate Plan, Execute, `/plan` and `/execute`.
  Expect: each opens the Workflow view with "AutoDE now works stage by stage…"; no artifacts are generated.

## Part 28 — v0.45.2 The source assessor and the mapper

- [ ] **28.1 Source assessment in VS Code.**
  Do: with a model other than Claude Code and a source connection configured, choose Run agent on Source assessment.
  Expect:
  - the sources' schemas are in the estate (`autode estate show`);
  - aggregate-only queries in the log; key, grain and relationship facts proposed in the Context Inbox;
  - a `source-context.yaml` draft and `source-assessment.md`;
  - the stage waits for Approve…, and approving it completes the stage.
- [ ] **28.2 No access.**
  Do: run it with a source system that can't be reached.
  Expect: the system is in the source context as *described*, with the access needed. No tables are invented.
- [ ] **28.3 Mapping.**
  Do: Run agent on Mapping.
  Expect:
  - structured entity mappings in `mapping-context.yaml`, column by column, with transform expressions where needed;
  - `mapping-notes.md` listing unmapped target columns and overruled suggestions;
  - after Approve…, the stage is done.
- [ ] **28.4 The matcher, in a host.**
  Do: in Claude Code with the plugin (`autode plugin install --host claude`), ask it to continue the problem through the mapping stage.
  Expect: it calls `autode_match_columns` and `autode_record_mapping`, and stops for your approval of the mapping.
- [ ] **28.5 An old plan.**
  Do: run a plan saved before v0.45.2 that has `sourceAssessmentAgent` or `sttmAgent` steps.
  Expect: those steps fail with "… moved to the workflow: run its stage from the Workflow view…".

## Part 29 — v0.45.3 The data modeler

- [ ] **29.1 The draft.**
  Do: with an approved mapping and some key and grain facts, call `autode_draft_model` from Claude Code (or read the start of Run agent's log on Modelling).
  Expect: the mapped entities with their source types, grain and keys labelled with the facts they came from, surrogate keys on dimensions, and gaps for whatever is unknown.
- [ ] **29.2 Run agent on Modelling.**
  Do: with a model other than Claude Code, choose Run agent on the Modelling stage.
  Expect:
  - `model.yaml`, `model.sql` and `model.md` under the stage's folder;
  - the DDL matches what `autode_check_model` renders: no hand-written DDL;
  - grain and key choices proposed as facts in the Context Inbox;
  - the stage waits for your approval at its gate.
- [ ] **29.3 Refusals.**
  Do: give `autode_check_model` a model with an entity without a grain, and a foreign key to an entity that isn't there.
  Expect: both are errors, each named.
- [ ] **29.4 An old plan.**
  Do: run a plan saved before v0.45.3 with a `dataModelerAgent` step.
  Expect: "Data modelling moved to the workflow: run its stage from the Workflow view…".

## Part 30 — v0.45.4 The pipeline engineer

- [ ] **30.1 Candidates.**
  Do: with an approved mapping and a confirmed key fact on a source that has an `updated_at` column, call `autode_primitive_candidates` for it from Claude Code.
  Expect: `rename_cast`, `dedup` (by the key, latest by `updated_at`) and `incremental_load`, each with its reasons (the key fact and its trust), and notes for any column expressions.
- [ ] **30.2 Run agent on Build.**
  Do: with a model other than Claude Code, choose Run agent on the build stage.
  Expect:
  - a draft `spec/pipeline.yaml`;
  - compiled files under the stage's folder, each with a `.grounding.json` whose decisions are backed by the key fact;
  - `build-notes.md`;
  - the stage waits for Approve… on the Pipeline Spec.
- [ ] **30.3 Not confirmed yet.**
  Do: repeat 30.1 with the key fact only proposed.
  Expect: the dedup reason says the fact is not confirmed yet, and the recorded file's manifest shows the decision unbacked.
- [ ] **30.4 An old plan.**
  Do: run a plan saved before v0.45.4 with `ingestionAgent` or `transformScaffoldAgent` steps.
  Expect: "The build moved to the workflow…".

## Part 31 — v0.45.5 Skill catalog and naming

- [ ] **31.1 The Skills view.**
  Do: open the Skills view in AutoDE's activity bar.
  Expect:
  - groups: AutoDE skills (all `autode-*`, each with its stage kinds), Interview packs, External skills, and, if the workspace imported any, Imported in this workspace;
  - external skills show the vendor, installed or not, and the licence in the tooltip.
- [ ] **31.2 Install a Databricks skill.**
  Do: with the Databricks CLI installed, choose Install on `databricks-dabs`.
  Expect:
  - a modal showing `databricks aitools install`, the Databricks License summary, and that it was probed just now;
  - Run in AutoDE terminal runs it visibly;
  - after Check, the item shows "installed".
- [ ] **31.3 A changed command.**
  Do: in `.autode/config/external-skills.yaml`, set the installer's probe to a command that fails, then choose Install.
  Expect: a warning that the vendor may have changed how the skills are installed, with the docs link; nothing runs.
- [ ] **31.4 The terminal.**
  Do: run `autode skills list`, `autode skills show databricks-dabs`, `autode skills check databricks-dabs`, then `autode skills install databricks-dabs` (type `install`).
  Expect: the same catalog; the install runs only after confirmation and reports where the skill was found.
- [ ] **31.5 Upgrading a host.**
  Do: run `autode plugin install --host claude` in a project installed with an earlier version.
  Expect:
  - the old folders (`documentation`, `mapping` …) are replaced by `autode-de-*`;
  - a skill of your own with one of those names, which doesn't name AutoDE's tools, is left alone.
- [ ] **31.6 Platform skills in an assignment.**
  Do: with `databricks-pipelines` installed and the target context on Databricks, run the build stage in Claude Code with the plugin.
  Expect: the assignment lists `databricks-pipelines` under "Vendor skills installed in this host".

## Part 32 — v0.45.6 The runner

- [ ] **32.1 Propose.**
  Do: in Claude Code with the plugin, ask the pipeline engineer to propose a runbook that creates a table and loads a file to a stage on your dev connection.
  Expect: `autode_propose_runbook` returns a high-stakes decision. A step like `snow sql -q …` or one with `--connection` is refused, naming the reason.
- [ ] **32.2 Policy.**
  Do: create `.autode/config/approvals.yaml` with dev (your dev connection, any approver) and prod (your prod connection, two named approvers, secondApprover).
  Expect: `autode runbook show <id>` names the environment and lists every step with its classification.
- [ ] **32.3 The Runbook tab.**
  Do: run *AutoDE: Open Runbook…* and pick it.
  Expect:
  - the policy, each step with read/change/destructive, what runs, its dry run and its rollback;
  - the agent's explanation, labelled as not checked;
  - Approve asks for confirmation as you.
- [ ] **32.4 Run.**
  Do: Dry run the create step, then Run step for each.
  Expect:
  - steps run only in order;
  - each change is confirmed in a modal naming the connection and environment;
  - a failure stops the run and offers Roll back;
  - the log table fills, and "Hash-chained; intact" shows.
- [ ] **32.5 Production.**
  Do: propose one for the prod connection; approve it as one approver, then try to run it.
  Expect:
  - "prod needs 2 approval(s)";
  - the same person can't approve twice;
  - a second named approver (`autode runbook approve <id>`) makes it runnable;
  - Run remaining is not offered.
- [ ] **32.6 Tampering.**
  Do: edit a step's SQL in `.autode/problems/<id>/runbooks/<rb>.yaml`.
  Expect: the tab says it was edited after approval and can't run.
- [ ] **32.7 Install guidance.**
  Do: on a machine without the Snowflake CLI, run *AutoDE: Check Platform Prerequisites* and pick it.
  Expect:
  - the options your machine has (Homebrew, pipx or uv), the unavailable ones marked, and the vendor's guide;
  - choosing one shows the exact commands and runs them in the AutoDE terminal only on your click;
  - `autode doctor` lists the same options.

## Part 33 — v0.45.7 Waiting for you; manual stages

- [ ] **33.1 One list.**
  Do: with a pending workflow or stage decision, a few proposed facts, a drafted mapping, and a prod runbook with one approval, open the Workflow view.
  Expect:
  - **Waiting for you** at the top: high stakes first, each item opening where it is approved (the Workflow tab, the Runbook tab, the Context Inbox, or the decision file);
  - a count in the status bar.
- [ ] **33.2 The same in a terminal and an agent.**
  Do: run `autode approvals`; ask Claude Code "what waits for me in AutoDE?".
  Expect: the same items. The terminal shows the command for each; the agent reports them and doesn't approve.
- [ ] **33.3 Manual stages.**
  Do: include a BI migration or deploy stage in a workflow.
  Expect: it is labelled *manual*, offers hand-in and skip, and has no Run agent.
- [ ] **33.4 The concept map.**
  Do: read §4 of the engineering onboarding guide.
  Expect: the concepts table, how they fit, what is internal, and what is being simplified.

## Part 34 — v0.45.9 Readiness before Run agent; the plan removed

- [ ] **34.1 Nothing to map.**
  Do: in a workspace with no tables in the estate (only business-context.yaml), open the Workflow view on a problem at its Mapping stage.
  Expect: Mapping says *Not ready yet: there are no tables in the estate…* with the ways to bring sources in, and has no Run agent.
- [ ] **34.2 Bring the sources in.**
  Do: ingest the DDL files (Ingest File, or `autode estate ingest sources/shop.ddl --system shop`), then re-open Source assessment and Run agent on it.
  Expect: the source context lists the systems. After you approve it, Mapping offers Run agent.
- [ ] **34.3 Notes are not a document.**
  Do: Run agent on a document stage where the agent can't produce the document.
  Expect: the run reports that the document wasn't drafted, with the agent's reply. It doesn't say "approve it".
- [ ] **34.4 Over MCP.**
  Do: ask Claude Code to continue the problem at its Mapping stage with no tables.
  Expect: it tells you what's missing and doesn't start the mapper.
- [ ] **34.5 No plan left.**
  Do: open AutoDE after updating; approve a specification; type `/plan`.
  Expect:
  - no AutoDE Dashboard panel, and no Generate Plan, Execute Plan or Reset Session in the Command Palette;
  - after approval the sidebar offers Open Workflow, and `/plan` opens the Workflow view.
- [ ] **34.6 Gaps in the assignment.**
  Do: with an estate where two tables have no known join, write a specification that combines them (for example "support tickets per order") and Run agent on its mapping stage, or ask Claude Code to continue the problem.
  Expect: the agent's instructions have a *Context gaps* section with the question about the join; the agent asks you or records it as open; nothing pauses.

## Part 35 — v0.45.10 Contexts reference the workspace

- [ ] **35.1 Target from a connection.**
  Do: with a target connection saved (a platform card, or `autode connections add`), build the Target Context of an approved problem.
  Expect: the first question picks the connection; the platform follows it; the database defaults to the connection's; there is no environment question.
- [ ] **35.2 Team defaults.**
  Do: confirm a project-wide fact "We name objects in PascalCase" (kind naming convention) or approve another problem's target context first, then build a new problem's Target Context.
  Expect: the naming question suggests it and says where the suggestion came from; the specification's own words still win.
- [ ] **35.3 Sources from the estate.**
  Do: ingest the sample's `sources/*.ddl` (one system each), then Source Context → Pick from the Estate.
  Expect: the estate's systems to tick (not business-context); the saved context lists them by system, with no table counts.
- [ ] **35.4 Over MCP and the CLI.**
  Do: run `autode context show`; ask Claude Code to draft the target context.
  Expect: the same choices; the agent calls `autode_record_target_context` and asks you to approve.
- [ ] **35.5 Re-open stays open.**
  Do: re-open an approved Source assessment.
  Expect: it stays *in progress* (not approved again); after a new draft it waits for your approval.
- [ ] **35.6 Mapping needs a source.**
  Do: in a greenfield workflow, try to approve a source context that is not applicable or empty.
  Expect: refused, with what to do; mapping says *Started, but blocked* or *Not ready yet* with the steps.
- [ ] **35.7 Per-source tasks.**
  Do: ingest a source after the workflow was planned.
  Expect: the source stage's tasks show that system (not business-context).
- [ ] **35.8 Sources as files.**
  Do: in the sample (DDL files in `sources/`, nothing ingested), Run agent on Source assessment; separately, Source Context → Pick from the Estate; and `autode estate files`.
  Expect: the agent finds and ingests the three DDL files (crm, hr_legacy, shop) and drafts the source context from them; the panel offers the same files to bring in, then the systems; the terminal lists them with their suggested systems.

## Part 36 — v0.45.11 Platform skills and the guard hook

- [ ] **36.1 The right skills per stage.**
  Do: in a problem whose target context is Snowflake with dbt, propose the workflow with the optional *Environment and security* stage included (it is left out by default in every template). Open the assignment of Environment and security, Build, Deploy and Reconcile (Run agent, or `autode workflow next` in a host). Switch the target to Databricks without dbt, and look again.
  Expect: Platform setup goes to the target architect with governance, performance and ingestion. Build has pipelines, ingestion, performance, and dbt only while dbt is chosen. Deploy has deployment. Reconcile goes to the source assessor with reconciliation. Every skill is for the current platform.
- [ ] **36.2 A Snowflake runbook end to end (dev).**
  Do: on a dev Snowflake connection, have the build agent land `shop.orders` (the ingestion skill's example). Open its runbook, dry-run, then run it.
  Expect: every step is classified, with its rollback. The run creates the file format, stage, table and load. Running it again loads nothing new.
- [ ] **36.3 A Databricks bundle (dev).**
  Do: on a dev Databricks connection, have the build agent produce the orders pipeline and its bundle. Approve and run the runbook.
  Expect: `bundle validate` is the dry run; the deploy creates the pipeline and a paused job prefixed with your name. Check that `CREATE FLOW … AUTO CDC INTO` is accepted by your workspace.
- [ ] **36.4 The other platform's SQL is flagged.**
  Do: propose a runbook with `OPTIMIZE` on a Snowflake connection.
  Expect: the Runbook tab warns that the step looks like Databricks SQL. A `VACUUM` step on Databricks without a rollback reason is refused.
- [ ] **36.5 Reconciliation reads only.**
  Do: after 36.2, bring the target into the estate, then run the reconcile stage's agent.
  Expect: it calls `autode_reconcile_plan`, runs the generated aggregate queries unchanged and read-only, and records a report with a verdict per metric. No row values appear.
- [ ] **36.6 The guard in Claude Code.**
  Do: `autode plugin install --host claude`, review the hook in `/hooks`. Ask Claude Code to "deploy the bundle with databricks bundle deploy", then to "list the catalogs".
  Expect: the deploy is blocked with a message pointing to runbooks; the listing runs. Your own hooks in `.claude/settings.json` are still there.
- [ ] **36.7 Cortex Code and the Copilot CLI.**
  Do: load the plugin folder (`autode plugin path`) in Cortex Code and try a `snow sql -q "CREATE TABLE …"`; in the Copilot CLI, run `autode plugin install --host copilot`.
  Expect: record whether Cortex Code runs the hook (unverified when this shipped). The Copilot install says the rule is a convention there.
- [ ] **36.8 Vendor skills.**
  Do: on a Databricks build stage without the Databricks agent skills installed, read the assignment; install them (`autode skills install databricks-pipelines`), and read it again.
  Expect: first listed under *not installed here*, with how you install them; then under *installed in this host*. Neither time does the agent install anything.

## Part 37 — v0.45.12 The interview survives; the analyst and the planner

- [ ] **37.1 Reload mid-interview.**
  Do: start a new problem in the panel, answer two questions, then reload VS Code (Developer: Reload Window).
  Expect: the panel says it resumed the interview (2 answers, n open) and asks the open question again. Nothing is asked twice.
- [ ] **37.2 New Chat and switching problems.**
  Do: mid-interview, click New Chat; then switch to another problem and back.
  Expect: the interview continues after New Chat; switching away shows nothing of it in the other problem, and switching back resumes it.
- [ ] **37.3 Continue in another surface.**
  Do: run `autode interview show` and answer an open question with `autode interview answer`; then, in Claude Code with the plugin, ask the business analyst to continue the interview.
  Expect: the panel (after a reload) and the agent see the terminal's answer with channel cli; the agent records its questions before asking and doesn't ask what was answered.
- [ ] **37.4 The specification closes it.**
  Do: let the panel synthesize the specification (or the agent propose it).
  Expect: `interview/state.yaml` records the version it fed; a reload doesn't resume it; a revision starts a new interview.
- [ ] **37.5 Attachments into the pack.**
  Do: mid-interview, attach a file from outside the workspace.
  Expect: it is copied to `<problem>/pack/files/` and listed in the Pack view (role other, draft); the interview's next question can use it; after a reload it is still attached.
- [ ] **37.6 The interview's parts.**
  Do: open the Skills view and `autode skills list`.
  Expect: the seven interview skills are AutoDE skills (stage specify, used by business-analyst); the interview group appears only with a workspace's own JSON parts.
- [ ] **37.7 The planner's briefs.**
  Do: after approving the specification, Run agent on the Plan stage (or ask the planner in Claude Code).
  Expect: it proposes the workflow with a brief per stage; the Workflow view shows each brief; a brief naming a tool is refused with the reason.
- [ ] **37.8 Questions fit the problem.**
  Do: start two problems with different statements (for example "daily revenue from shop orders" and "merge two CRMs into one customer master"), and answer the first three questions of each.
  Expect: the questions name the problem's own entities and systems, not generic wording; each shows its part (Sources, Data flow …) and the progress panel shows the parts addressed, partial or not started. Note any question that ignores an earlier answer.
- [ ] **37.9 Discovery before asking.**
  Do: ingest the sample's `sources/*.ddl` into the estate first, then start an interview about the shop orders.
  Expect: the log shows "Not asking … discovery already answers it" for questions the estate answers (which systems or tables exist), and the interview doesn't ask them.
- [ ] **37.10 Stopping.**
  Do: answer every question briefly until the interview ends.
  Expect: it stops when every field has an answer or after 12 questions, whichever comes first, then drafts the specification; unanswered points appear as assumptions or open questions, not invented facts.
- [ ] **37.11 Same interview, different model.**
  Do: in Claude Code, ask the business analyst to run the interview of a new problem.
  Expect: it asks about the same parts in the same order (requirements, sources, data flow, transformations, quality, constraints), records each question before asking it, and `autode interview show` lists them.


## Part 38 — v0.45.13 The context curator

- [ ] **38.1 A BRD read in an agent host.**
  Do: in Claude Code with the plugin, add the sample's `documents/pack/brd.md` to the pack and ask the context curator to read it.
  Expect: it calls `autode_pack_reading`, then `autode_pack_record_reading`; the facts appear in the Context Inbox as proposed, each citing its section; dropped ones are reported with the reason.
- [ ] **38.2 Same document, same checks in the panel.**
  Do: apply the same BRD from the panel's Pack view.
  Expect: no duplicate facts for what was already proposed; new ones cite their sections.
- [ ] **38.3 A new contract format.**
  Do: in a host, add a house-format YAML contract no profile reads and ask the curator to read it.
  Expect: a profile is proposed under `.autode/knowledge/profiles/` with status proposed; after you set it to confirmed, `autode_pack_apply` reads the contract with no model.
- [ ] **38.4 Facts from conversation in a host.**
  Do: tell Claude Code "orders are unique on order_id".
  Expect: it proposes a key fact for shop.orders and says it waits for your confirmation.
- [ ] **38.5 Vocabulary.**
  Do: ask the curator to propose vocabulary for the CRM source.
  Expect: entries with evidence (column names, comments, the dictionary); nothing merely plausible; a low-stakes decision you can approve.

## Part 39 — v0.45.14 Code audit follow-ups

- [ ] **39.1 The build stage has one way.**
  Do: open the Workflow view on a problem whose mapping is approved.
  Expect: the build stage offers Run agent, not "Generate the Pipeline Spec"; the palette has no *AutoDE: Generate Pipeline Spec*. The mapping stage still offers "Add a mapping…".
- [ ] **39.2 Source assessment through a named connection.**
  Do: with a named source connection saved, click *Run Source Assessment* on its platform card; pick the database and two schemas.
  Expect: the tables arrive in the estate (Estate view) as that connection's system, with profiles; the chat logs the count; *Re-verify source schema* then reports no drift.
- [ ] **39.3 No named connection.**
  Do: in a workspace without `.autode/config/connections.yaml`, click *Run Source Assessment*.
  Expect: a message to save a named connection first; nothing else happens.
- [ ] **39.4 Refresh before Run agent.**
  Do: set `autoDataEngineeringHub.context.schemaTtlDays` to 0 (every loaded table counts as stale), then Run agent on a mapping stage.
  Expect: the log says how many tables were refreshed before the run (or nothing, when none were stale); a failed refresh doesn't stop the run.
- [ ] **39.5 Refresh in a host.**
  Do: in Claude Code, ask for the next stage.
  Expect: the orchestrator calls `autode_refresh_working_set` before running the assignment; an unreachable source is reported and the stage still runs.

## Part 40 — v0.46.0 Port a skill

- [ ] **40.1 The examples, end to end in the panel.**
  Do: Skills view → **+** (*Port a Skill…*) → *Try AutoDE's examples* → choose *team-sql-conventions*.
  Expect: the report says **knowledge**, MIT, no scripts, nothing it writes; *Import* asks first; then *Review…* opens the review screen; after *reviewed*, *Publish* works. The Skills view lists it under *Imported in this workspace* with `team`, its kind and licence.
- [ ] **40.2 A procedure can't be published unreviewed.**
  Do: port *table-freshness-check* from the examples and import it.
  Expect: the report shows the script, `python` and `snow` (with AutoDE's Snowflake CLI guide) and the §3.1 limit; *Publish* is disabled with "Review it first: it carries scripts (scripts/check_freshness.py)".
- [ ] **40.3 From Git.**
  Do: port from an https repository you can read that holds a skill (several skills: you're asked to choose one).
  Expect: the report names the commit; nothing appears in the workspace until *Import*; the imported skill's sidecar records the repository and commit.
- [ ] **40.4 A licence that forbids copying.**
  Do: port a skill folder whose `LICENSE` is the Databricks License.
  Expect: "It can't be imported", with the reason; no *Import* button.
- [ ] **40.5 Team knowledge in a pack.**
  Do: with *team-sql-conventions* published and reviewed, ask in chat "how should I name the incremental staging model for orders?", then *What the Agent Saw*.
  Expect: the pack has a *Team Knowledge* section with the conventions, and the manifest lists `team-sql-conventions`.
- [ ] **40.6 Update Skill.**
  Do: edit the source of an imported skill (a line in its `SKILL.md`), then the sync button on it in the Skills view.
  Expect: a diff of exactly that line and the report; after *Update* the skill is unreviewed and leaves packs until reviewed again.
- [ ] **40.7 In a terminal and in a host.**
  Do: `autode skills analyze <repo URL> --skill <path>`; `autode skills import …`; `autode skills review <id>` and `publish <id>`; in Claude Code ask it to analyse a skill repository.
  Expect: the CLI prints the same report; review and publish ask you to type the word; the host calls `autode_skills_analyze` and says a person imports it.

## Part 41 — v0.47.0 Governance as code

- [ ] **41.1 The interview asks about personal data only when it matters.**
  Do: start a problem "Customer churn by e-mail domain, under GDPR"; then another "Daily revenue from the shop orders, by channel".
  Expect: the first interview has a *Governance & Personal Data* part and asks about regulations and personal data; the second has no such part. After synthesis, the first specification has a `governance` block with GDPR.
- [ ] **41.2 Classify a column in the panel.**
  Do: with a source table that has `email` and `ssn` in the estate, run *AutoDE: Classify Personal Data…*; choose `ssn`, *sensitive-pii*, *hash*; confirm.
  Expect: the pick list suggests `ssn` as sensitive-pii and `email` as pii; after *Record*, the chat says what was recorded; `autode facts list --all` shows the fact as confirmed (it never waits in the Context Inbox, because you recorded it).
- [ ] **41.3 The build masks it.**
  Do: Run agent on the build stage of a problem whose mapping reads that table.
  Expect: the Pipeline Spec has a `mask` step right after staging (ssn hashed), the dedup reads the masked view, and the entity's governance block lists ssn as sensitive-pii. The compiled SQL hashes ssn with `SHA2(…, 256)` on Snowflake or `sha2(…)` on Databricks.
- [ ] **41.4 An unmasked build can't be approved.**
  Do: remove the `mask` step and the governance block from the Pipeline Spec by hand, then try to approve the build stage.
  Expect: approval is refused, naming `ssn` and its fact.
- [ ] **41.5 In a terminal and in a host.**
  Do: `autode governance show --table <the table>`; `autode governance classify <table>.email --as pii --strategy hash`; in Claude Code ask which columns hold personal data.
  Expect: the CLI lists suggestions and what is classified, and asks you to type `classify`; the host calls `autode_governance_candidates` and proposes facts for you to confirm instead of recording them.
- [ ] **41.6 Sample rows.**
  Do: with `allowSampleDataInPrompts: true` on a connection, classify a column whose name says nothing (e.g. `cust_ref`) as pii, then ask an agent to query a few rows.
  Expect: `cust_ref` comes back masked.

## Part 42 — v0.48.0 Capture coverage and exploration mode

- [ ] **42.1 The checklist.**
  Do: in the kit's problem (after the specification), run *AutoDE: Capture Coverage*; then `autode coverage`.
  Expect: every table the specification names is listed with key, grain, change column, load pattern, classification, relationships and description; *net revenue* and the retention metric are listed as missing their definition; every item not known ends with what to do. The CLI prints the same.
- [ ] **42.2 Candidates from the data.**
  Do: with the pack's samples added, run *AutoDE: Find Candidates from Data* (or `autode capture candidates --record`).
  Expect: `crm.customers.shop_customer_id → shop.customers.customer_id` passes; `crm.loyalty_members.cust_no → crm.customers.cust_no` fails with orphans; the declared key of `crm.customers` is reported broken (C-20003 twice); e-mail and phone columns are found by their values; the passing facts wait in the Context Inbox already verified.
- [ ] **42.3 Documents.**
  Do: apply the BRD in the panel; then add a Markdown data dictionary with a `| Column | Description | PK |` table and apply it.
  Expect: every fact the BRD gave cites a quote that is in its section; the dictionary's rows become documented proposals without a model call for them; applying a copy of the dictionary under another file name adds no new facts, and `autode facts show <id>` on one of them lists both files as evidence.
- [ ] **42.4 The conversation, reviewed.**
  Do: in chat, say "order_id is unique across channels" and "a customer is retained if they order again within 90 days"; type `/review`; then `/review dismiss 1`; then start a New Chat.
  Expect: the messages no fact cites are listed with their cue (one the background extraction already recorded is not listed); the dismissed one is not listed again; New Chat says how many the closed chat left.
- [ ] **42.5 Exploration mode on.**
  Do: on the Business Problem card choose *Explore…* and acknowledge; run an agent on a mapping stage that has a context gap.
  Expect: a banner in the panel and the Workflow view; the agent records an assumption (`autode facts list --all` shows it active, trust assumed) and continues; the deliverable's first line says it was built on unverified assumptions; its `.grounding.json` has `"exploration": true`; approving the stage takes one click.
- [ ] **42.6 Checks warn; production is refused.**
  Do: approve a target context built for an older specification version; propose and try to approve a runbook on a connection not listed under dev, sandbox or test.
  Expect: the target context is approved with a warning that names the check; the runbook is refused because exploration targets non-production only.
- [ ] **42.7 Back to governed.**
  Do: *Switch to governed* on the card (or `autode problems mode governed`).
  Expect: a hardening list opens with the assumption, the model-only facts and the warned check; approving the same target context now refuses.

## Part 43 — v0.49.0 The semantic layer

- [ ] **43.1 Draft a shared model.**
  Do: in the kit's problem, run *AutoDE: New Shared Semantic Model (Draft from Knowledge)…*, name it `sales`.
  Expect: `autode-output/semantic/sales.yaml` opens in the Semantic Model editor with the tables the specification names, their keys, dimensions, time dimensions and facts; relationships only where a foreign key or a confirmed relationship fact backs them; a warning per base table that its database is a placeholder. The YAML has no AutoDE-only keys.
- [ ] **43.2 Edit and check.**
  Do: in the Form, add a metric `order_count` = `COUNT(order_id)` on orders; change a dimension's expression to a column that doesn't exist; use Undo.
  Expect: each change is an ordinary edit of the file (the YAML view shows it; Undo reverts it); the bad expression shows ✗ with "isn't a column".
- [ ] **43.3 Approve.**
  Do: *Approve…*; then edit a description and save.
  Expect: refused while a check fails; after fixing, approved (the pill says by whom). After the edit, it shows "changed since approved" and appears in *Waiting for you*.
- [ ] **43.4 A composite.**
  Do: *AutoDE: New Semantic Composite…*, pick `sales`; add a metric with the name of an existing shared metric; Resolve. Then rename it and Resolve again.
  Expect: the first resolve is refused ("a composite never redefines a shared element…"); the second writes `<name>.resolved.yaml` with a header naming `sales@<revision>`. Resolving again changes nothing.
- [ ] **43.5 Stale.**
  Do: change the shared model, save, approve it; open the composite.
  Expect: the composite shows *stale* (the shared model changed) and waits in *Waiting for you*; Resolve shows the changes.
- [ ] **43.6 In a terminal and a host.**
  Do: `autode semantic show`, `autode semantic check sales`, `autode semantic approve sales`; in Claude Code ask to add a metric to the shared model.
  Expect: the CLI lists both files with their status and asks you to type `approve`; the host calls `autode_propose_semantic_model` and tells you to approve the decision, which writes and approves the model.

## Part 44 — v0.50.0 The Knowledge Explorer; packs and grounding use the semantic layer

- [ ] **44.1 Open and search.**
  Do: in the kit, *AutoDE: Open Knowledge Explorer*. Press `/`, type `order`, then tick *Table* under Kind.
  Expect: an overview first (tables, catalog, facts by trust, systems, semantic models). Results appear as you type, best first; Kind still lists the other kinds with their counts; ↑ ↓ Enter open a result.
- [ ] **44.2 An asset page.**
  Do: open `shop.orders`; go through every tab; click a column, then Alt+←.
  Expect: Schema lists its columns with keys and classifications; Facts shows grain and key facts with evidence; Used by lists artifacts whose manifests rest on it; the column page names the table in its breadcrumb; Back returns to the table.
- [ ] **44.3 The graph.**
  Do: on `shop.orders`, *Show in graph*; set hops to 2, layout Layered, tick Columns; click a node; export PNG and SVG.
  Expect: the table at the centre with a highlighted border; trust as border colour; columns appear when ticked; clicking a node opens it; both files save and open.
- [ ] **44.4 The semantic layer in packs.**
  Do: draft and approve the `sales` model (Part 43), then run the build stage's agent and open *What the Agent Saw* for its step.
  Expect: the pack has *Semantic definitions (approved…)* with the model's metrics and joins, and the manifest names `sales@<revision>`.
- [ ] **44.5 An invented join is refused.**
  Do: in a governed problem, ask the agent (or call `autode_record_artifact` from Claude Code) to record SQL joining two tables of the approved model on columns the model doesn't relate. Switch the problem to exploration mode and repeat.
  Expect: governed — refused, naming the join and what the layer defines; nothing is written. Exploration — recorded, and the manifest carries `GROUNDING_SEMANTIC`.
- [ ] **44.6 Facts, estate and the status line.**
  Do: open the Facts view, filter by trust; open the Estate view; in the sidebar, click the 📊 status line and type `/explore`.
  Expect: facts newest first with counts per filter; systems, environments, catalog and connection readiness; the status line and `/explore` both open the Explorer; the old drawer and its *Add source* form are gone.
- [ ] **44.7 In a terminal and a host.**
  Do: `autode explore`, `autode explore search tax --kind metric`, `autode explore asset shop.orders`; in Claude Code ask "what do we know about shop.orders?".
  Expect: the CLI prints the overview, the metric and the asset page as Markdown; the host calls `autode_get_asset_context` (or reads `autode://asset/...`) and answers from it.

## Part 45 — v0.50.1 Standard vocabulary and the Graph view

- [ ] **45.1 Standard filters.**
  Do: open the Knowledge Explorer and search `order`.
  Expect: filters titled Asset type, System, Platform, Environment, Certification, Status, Review state, Classification, Glossary term; Domain, Owner and Tags greyed ("Arrives with the metadata model"). Asset types read Table, Column, Logical table, Dimension, Metric, Knowledge fact; no "Kind" or "Trust".
- [ ] **45.2 The landscape.**
  Do: open the Graph view; choose Scope → System → shop; tick Columns; then choose the `sales` semantic model.
  Expect: every shop table, with dotted semantic joins between orders and customers once `sales` is approved, dashed proposed relationships if any, and solid foreign keys; columns drawn inside their tables; the footer counts relationships by kind, or says how to add them when there are none.
- [ ] **45.3 Expand, card and find.**
  Do: click a table; *Expand*; double-click another node; type `cust` in Find.
  Expect: a card with type, certification and *Open*, *Expand*, *Focus*; neighbours added without losing the canvas; matches highlighted, the rest dimmed.
- [ ] **45.4 An asset's graph.**
  Do: open `shop.orders` → Graph.
  Expect: its columns inside it; if it has no relationships, a note saying so with a link to the landscape.
- [ ] **45.5 In a terminal and a host.**
  Do: `autode explore graph --system shop`; `autode explore search tax --type metric`; in Claude Code ask "show me how the shop tables relate".
  Expect: the CLI lists tables and relationships with their columns; the host calls `autode_explore_graph` without an asset.

## Part 46 — v0.50.2 Three layers and the semantic layer's own assets

- [ ] **46.1 The layer switch.**
  Do: in the Knowledge Explorer, click Physical, Context, Semantic, All.
  Expect: results narrow to that layer (badges: blue physical, purple context, green semantic); Layer is the first filter; graph nodes are filled with their layer's colour.
- [ ] **46.2 The semantic home page.**
  Do: add a verified query and `custom_instructions` to `sales` in the Semantic Model editor, approve it, then click Semantic.
  Expect: `sales` (approved) with its logical tables, metrics and expressions, relationships, the verified query's question and the instructions; *Open in Semantic Model editor* opens the file.
- [ ] **46.3 Semantic assets.**
  Do: open the relationship, the verified query, then `shop.orders` → Used by.
  Expect: the join with its columns and type; the question, SQL and who verified it; `shop.orders` lists the verified query.
- [ ] **46.4 In a terminal and a host.**
  Do: `autode explore semantic`; `autode explore search orders --layer semantic`; in Claude Code ask "which verified queries exist for sales?".
  Expect: the model listing; only semantic results; the host reads `autode://explore/semantic` or searches with `layers: ["semantic"]`.

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
| 9.1 |  |  |
| 9.2 |  |  |
| 9.3 |  |  |
| 9.4 |  |  |
| 10.1 |  |  |
| 10.2 |  |  |
| 10.3 |  |  |
| 10.4 |  |  |
| 10.5 |  |  |
| 10.6 |  |  |
| 10.7 |  |  |
| 10.8 |  |  |
| 11.1 |  |  |
| 11.2 |  |  |
| 11.3 |  |  |
| 11.4 |  |  |
| 11.5 |  |  |
| 12.1 |  |  |
| 12.2 |  |  |
| 12.3 |  |  |
| 12.4 |  |  |
| 12.5 |  |  |
| 13.1 |  |  |
| 13.2 |  |  |
| 13.3 |  |  |
| 13.4 |  |  |
| 13.5 |  |  |
| 14.1 |  |  |
| 14.2 |  |  |
| 14.3 |  |  |
| 14.4 |  |  |
| 14.5 |  |  |
| 14.6 |  |  |
| 14.7 |  |  |
| 15.1 |  |  |
| 15.2 |  |  |
| 15.3 |  |  |
| 15.4 |  |  |
| 15.5 |  |  |
| 15.6 |  |  |
| 15.7 |  |  |
| 15.8 |  |  |
| 16.1 |  |  |
| 16.2 |  |  |
| 16.3 |  |  |
| 16.4 |  |  |
| 16.5 |  |  |
| 16.6 |  |  |
| 16.7 |  |  |
| 16.8 |  |  |
| 16.9 |  |  |
| 17.1 |  |  |
| 17.2 |  |  |
| 17.3 |  |  |
| 17.4 |  |  |
| 17.5 |  |  |
| 17.6 |  |  |
| 17.7 |  |  |
| 17.8 |  |  |
| 18.1 |  |  |
| 18.2 |  |  |
| 18.3 |  |  |
| 18.4 |  |  |
| 18.5 |  |  |
| 18.6 |  |  |
| 18.7 |  |  |
| 18.8 |  |  |
| 18.9 |  |  |
| 18.10 |  |  |
| 19.1 |  |  |
| 19.2 |  |  |
| 19.3 |  |  |
| 19.4 |  |  |
| 19.5 |  |  |
| 19.6 |  |  |
| 19.7 |  |  |
| 19.8 |  |  |
| 20.1 |  |  |
| 20.2 |  |  |
| 20.3 |  |  |
| 20.4 |  |  |
| 20.5 |  |  |
| 20.6 |  |  |
| 20.7 |  |  |
| 21.1 |  |  |
| 21.2 |  |  |
| 21.3 |  |  |
| 21.4 |  |  |
| 21.5 |  |  |
| 21.6 |  |  |
| 22.1 |  |  |
| 22.2 |  |  |
| 22.3 |  |  |
| 22.4 |  |  |
| 22.5 |  |  |
| 23.1 |  |  |
| 23.2 |  |  |
| 23.3 |  |  |
| 23.4 |  |  |
| 24.1 |  |  |
| 24.2 |  |  |
| 24.3 |  |  |
| 24.4 |  |  |
| 24.5 |  |  |
| 24.6 |  |  |
| 24.7 |  |  |
| 24.8 |  |  |
| 25.1 |  |  |
| 25.2 |  |  |
| 25.3 |  |  |
| 25.4 |  |  |
| 25.5 |  |  |
| 26.1 |  |  |
| 26.2 |  |  |
| 26.3 |  |  |
| 26.4 |  |  |
| 26.5 |  |  |
| 26.6 |  |  |
| 27.1 |  |  |
| 27.2 |  |  |
| 27.3 |  |  |
| 27.4 |  |  |
| 27.5 |  |  |
| 27.6 |  |  |
| 28.1 |  |  |
| 28.2 |  |  |
| 28.3 |  |  |
| 28.4 |  |  |
| 28.5 |  |  |
| 29.1 |  |  |
| 29.2 |  |  |
| 29.3 |  |  |
| 29.4 |  |  |
| 30.1 |  |  |
| 30.2 |  |  |
| 30.3 |  |  |
| 30.4 |  |  |
| 31.1 |  |  |
| 31.2 |  |  |
| 31.3 |  |  |
| 31.4 |  |  |
| 31.5 |  |  |
| 31.6 |  |  |
| 32.1 |  |  |
| 32.2 |  |  |
| 32.3 |  |  |
| 32.4 |  |  |
| 32.5 |  |  |
| 32.6 |  |  |
| 32.7 |  |  |
| 33.1 |  |  |
| 33.2 |  |  |
| 33.3 |  |  |
| 33.4 |  |  |
| 34.1 |  |  |
| 34.2 |  |  |
| 34.3 |  |  |
| 34.4 |  |  |
| 34.5 |  |  |
| 34.6 |  |  |
| 35.1 |  |  |
| 35.2 |  |  |
| 35.3 |  |  |
| 35.4 |  |  |
| 35.5 |  |  |
| 35.6 |  |  |
| 35.7 |  |  |
| 35.8 |  |  |
| 36.1 |  |  |
| 36.2 |  |  |
| 36.3 |  |  |
| 36.4 |  |  |
| 36.5 |  |  |
| 36.6 |  |  |
| 36.7 |  |  |
| 36.8 |  |  |
| 37.1 |  |  |
| 37.2 |  |  |
| 37.3 |  |  |
| 37.4 |  |  |
| 37.5 |  |  |
| 37.6 |  |  |
| 37.7 |  |  |
| 37.8 |  |  |
| 37.9 |  |  |
| 37.10 |  |  |
| 37.11 |  |  |
| 38.1 |  |  |
| 38.2 |  |  |
| 38.3 |  |  |
| 38.4 |  |  |
| 38.5 |  |  |
| 39.1 |  |  |
| 39.2 |  |  |
| 39.3 |  |  |
| 39.4 |  |  |
| 39.5 |  |  |
| 40.1 |  |  |
| 40.2 |  |  |
| 40.3 |  |  |
| 40.4 |  |  |
| 40.5 |  |  |
| 40.6 |  |  |
| 40.7 |  |  |
| 41.1 |  |  |
| 41.2 |  |  |
| 41.3 |  |  |
| 41.4 |  |  |
| 41.5 |  |  |
| 41.6 |  |  |
| 42.1 |  |  |
| 42.2 |  |  |
| 42.3 |  |  |
| 42.4 |  |  |
| 42.5 |  |  |
| 42.6 |  |  |
| 42.7 |  |  |
| 43.1 |  |  |
| 43.2 |  |  |
| 43.3 |  |  |
| 43.4 |  |  |
| 43.5 |  |  |
| 43.6 |  |  |
| 44.1 |  |  |
| 44.2 |  |  |
| 44.3 |  |  |
| 44.4 |  |  |
| 44.5 |  |  |
| 44.6 |  |  |
| 44.7 |  |  |
| 45.1 |  |  |
| 45.2 |  |  |
| 45.3 |  |  |
| 45.4 |  |  |
| 45.5 |  |  |
| 46.1 |  |  |
| 46.2 |  |  |
| 46.3 |  |  |
| 46.4 |  |  |

For a failure, the most useful notes are: the log lines around it, the relevant `.autode` file, and for packs the What the Agent Saw document.
