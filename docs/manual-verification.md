# Manual verification — v0.25.0 to v0.36.0

Hands-on checks for the features shipped in v0.25.0–v0.36.0, run in the VS Code Extension Development Host. Each check gives **Do** and **Expect**; tick the box when it holds, and note anything that doesn't in the results table at the end.

Automated coverage already exists (`npm test`, `npm run eval`); these checks cover what only a real VS Code session shows: the panel, prompts, commands, file watching and real LLM providers.

Time: about 90 minutes for Parts 1–8, of which Part 7 (a full plan run) takes the longest, plus about 60 minutes for Parts 9–12 and 20 minutes for Part 13. Parts can be done in any order after Part 0; Part 12.2–12.4 reuse the workspace of Part 10.

---

## Part 0 — Setup (once)

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
  Do: with the server started with `--allow-write`, ask Claude Code to insert a row into a scratch table.
  Expect: `autode_execute_query` refuses and the agent proposes the change instead; after you approve it in the panel, the agent's `autode_apply_decision` runs it once. Without `--allow-write`, apply is refused.
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

For a failure, the most useful notes are: the log lines around it, the relevant `.autode` file, and for packs the What the Agent Saw document.
