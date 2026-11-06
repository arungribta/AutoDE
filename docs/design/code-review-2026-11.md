# Critical code review, November 2026

> **Reviewed:** v0.61.2 (2026-11-06), the point where POP5 finished the platform model and before IMP1 builds on it. **Fixes from it:** v0.61.3 (CR1) and v0.61.4 (CR1b). The rest is proposed below, for the owner to decide.

## 1. The verdict

The architecture is sound where it matters most, and the next phases can build on it. On maintainability that verdict was too generous at first: see section 8. The engine really is independent of its hosts: nothing under `src/engine` imports a surface or `vscode`, measured over every file. The platform model holds up: Redshift, and now a catalog system, are added by files alone. Transports, binding and the review lifecycle are well built.

The review found two kinds of problem:

- **Promises the code didn't keep.** AutoDE's strongest claims are "read-only means read-only" and "a person approves". Each had a real hole. These are fixed in v0.61.3.
- **Structure that will get expensive.** Business logic in the surfaces, and one file every new decision kind must change. Nothing is broken today, but IMP1, C5c and PAT would each make it worse. These are the owner's to schedule.

## 2. How it was done

Three independent reviewers read the platform layer, the engine core, and the surfaces with the test setup. Each had to give `file:line` evidence, the concrete failure, the smallest fix, and what would make the finding wrong. The findings marked *reproduced* below were then run against the code rather than accepted from reading.

The question asked was not "is this code tidy" but: where does the design make the next phases harder, and where does the code break its own stated rules?

## 3. Fixed in v0.61.3 (CR1)

Every one of these was a safety defect, or a gate that could falsely pass.

| # | Defect | Why it mattered | Status of the evidence |
|---|---|---|---|
| 1 | The SQL guard didn't know `//` and `#` comments | A second statement could hide behind one, so `autode_execute_query` wasn't reliably read-only | Reproduced against the guard. Not run on a live Snowflake |
| 2 | An agent could approve its own high-stakes decision by editing the decision file | Breaks "agents propose, a person approves" | Confirmed in the code; the guard hook covered shell tools only |
| 3 | An approval wasn't tied to the content reviewed | A proposal could change after a person approved it | Confirmed in the code |
| 4 | `escapeHtml` in the chat panel escaped nothing, since v0.4.0 | Model output and file text reached `innerHTML` unescaped, and the page allowed remote images, a route for data to leave. Its test used its own working copy | Reproduced: the page's function returned its input |
| 5 | A wrong Snowflake password moved the password onto the command line | A typo exposed the real secret to any process listing | Confirmed in the code |
| 6 | `cli` read operations had no read-only check | An approved "read" could run any sub-command. The gap opened in v0.61.0, when `cli` operations became runnable | Confirmed in the code |
| 7 | Two hosts could apply one decision at once | A duplicate fact, then an escaping error | Derived from the code |
| 8 | `platform-approvals.json` wasn't written atomically, and a corrupt file read as empty | One bad write could silently return every approval to draft | Confirmed in the code |
| 9 | An agent's `language` argument could turn off the semantic grounding check | A governed problem could record SQL the semantic layer doesn't allow | Confirmed in the code |
| 10 | Snowflake REST read only the first result partition | A large read returned a prefix and reported nothing | Confirmed in the code; no live large result was tried |
| 11 | Dialect fragments ignored team definitions and approvals | A team platform silently got ANSI SQL; a team's fix wasn't used | Reproduced |
| 12 | A failed version read turned range checks off for the session | An operation outside its version range ran anyway | Confirmed in the code |
| 13 | A system on trial could still take raw SQL from an agent | The trial promise covered operations only | Confirmed in the code |
| 14 | A definition could name a path as its CLI, or set `PATH` or `NODE_OPTIONS` | Reviewing a definition didn't show which program really ran | Confirmed in the code |
| 15 | The test run could stop silently with exit 0, a filter could pass as green, and CI skipped the architecture test | "All green" could be false. CI ran only on `main`. One run this week stopped at 278 tests with exit 0, cause still unknown | Confirmed in the code; the original stop was never reproduced |
| 16 | A corrupt decision vanished from every inbox, and an unreadable spec meant no blockers | A failure became a silent pass | Confirmed in the code |

## 4. Open, for the owner to decide

Ranked by what they cost the next phases. None is a safety defect.

| # | Finding | Cost if left | Proposed |
|---|---|---|---|
| A | **Approving a spec has two implementations.** The panel records a decision and resets contexts; the CLI and MCP do neither | The same approval leaves different state by surface | **CR2**, before IMP1 |
| B | **Decision approval is orchestrated three times,** and the copies have drifted | Every fix is made three times | **CR2** |
| C | **Running a runbook exists only in the panel** | A headless user can approve a platform change but not apply it: a breach of the parity rule | **CR2**, or confirm it is a deliberate safety choice |
| D | **`http` and `file` can't be runbook steps** | IMP1's export and IMP3's write-back are blocked. Needs a step kind, a dry run and a redaction rule | **Before IMP1's export** |
| E | **The ledger folds only events newer than its snapshot,** and pruning can delete events it never saw | A teammate's offline facts, merged later, are silently ignored. C5d relies on this fold | **Before C5d.** Derived from the code, not reproduced |
| F | **`decisions/proposals.ts`: a new decision kind touches about nine places** | IMP1 to PAT add perhaps 25 more edits, each a chance to skip a staleness check | **CR3:** one handler per kind, forced complete by the compiler; can go one kind at a time |
| G | **`usePlatformWorkspace` and other module-level state** | Fine at one workspace per process, which every host is today. It caused real test failures this week | **CR3:** pass the scope explicitly |
| H | **The platform layer imports the decision layer, and the reverse** | Load-order fragility; running an operation pulls in the whole decisions hub | **CR3:** small leaf modules first |
| I | **Two persistence layers for the same documents** (`src/context/*Manager.ts` and the engine) | The panel and the CLI already disagree on which problems exist | **CR3:** thin wrappers over the engine |
| J | **The plan gate lives only in the panel** | An agent can propose what the panel would block | With A |
| K | **Hand-written Snowflake and Databricks REST backends** | No timeout, size cap or redirect rule, unlike `httpTransport`; `spawnSync` blocks the host | When next touched: one submit, poll and fetch engine for CLI and HTTP |
| L | **The test suite:** one 16,000-line file and 464 `fresh()` reloads. Speed turned out not to be the problem: 520 tests in 129 seconds alone on this machine, the slowest 5.2 seconds. Runs took about 9 minutes during this review while other work shared the machine; the share due to that wasn't measured | `fresh()` on modules holding state caused real failures this week | Stop reloading modules that hold state. No sharding needed |
| M | **Built-in platforms beside definition-driven ones** (`CONNECTION_FIELDS`, Oracle branches) | Two ways of doing one thing | Accept for now. Incremental: add `connection:` blocks to `snowflake.yaml` and `databricks.yaml` first |
| N | **The webview protocol is untyped, and the big inline scripts are barely tested** | v0.61.3 at least parses them | When next touched |

**Accepted, and worth saying plainly:**
- `by`, the approver's name, is text and not an identity. The two-approver rule is an honesty control among cooperating people, not separation of duties against a malicious one. Any later claim otherwise would be false.
- `.autode/config` is treated as reviewed repository content. A pull request adding a definition and its approval entry together is stopped only by code review.
- The host guard stops an agent's mistakes. It isn't a sandbox, and a determined script gets past it.

## 5. What was found to be sound

- **Host independence:** no engine file imports a surface, and no `vscode` under `src/engine`.
- **`httpTransport`:** confinement after URL normalisation, redirects refused, secrets scrubbed, sizes capped.
- **SQL binding:** typed identifiers and escaped literals. A statement parameter is guarded again.
- **Checks at apply time, not only at proposal:** runbooks, bundles, documents and articles are validated again, and stakes are recomputed rather than read from the file.
- **The architecture test** for the platform boundary is well built, with a baseline and a recorded reason per exception.
- **The Explorer's ontology view** calls the CLI, so it can't drift from it: the model to copy.

## 6. What this review did not cover

- Nothing was tried on a live Snowflake, Databricks, Redshift or Oracle account, so items 1, 5 and 10 are proven against the code only.
- Webviews weren't opened. Layout, focus order and screen readers are unverified, including for the corrected escaping.
- Not read in depth: `explore/`, `transforms/`, `quality/`, `ontology/`, `maintenance/`, the Oracle adapter, and each MCP tool one by one.
- Items 7, E and the concurrency findings come from reading the code. No race was reproduced.

## 7. Against OWASP ASVS 4.0.3

Added at the owner's request: sections 1 to 6 were a review against AutoDE's own rules, not a named standard. This one followed ASVS at about Level 2, using the chapters that apply to a local tool with an agent interface. It is a structured review, not a certification or a penetration test.

| Chapter | Result | Note |
|---|---|---|
| V1 Architecture | Partial | Trust boundaries are drawn well; workspace settings and SQL literals leaked through them (fixed) |
| V5 Validation and encoding | Partial | Almost every `innerHTML` escapes its data. The custom editors, SQL backslashes and regular expressions from names did not (fixed) |
| V6 Cryptography | Partial | Nonces fixed. Key handling wasn't reviewed in depth |
| V7 Errors and logging | Partial | Redaction is a good pattern. The run log's chain can't detect a removed last entry, and it is unkeyed |
| V8 Data protection | Partial | Sample-data gate sound by design. Name-based masking can be evaded by aliasing a column |
| V10 Malicious code | Partial | Git ingestion is careful. The Oracle driver range has no integrity pin |
| V12 Files | Partial | Links now followed everywhere; `ingestFile` has no size cap |
| V13 API | Pass, with gaps | Every tool has a schema and annotations; handlers weren't each checked against their annotation |
| V14 Configuration | Partial | Settings scope fixed. `style-src 'unsafe-inline'` remains on every webview |

**Fixed in v0.61.4:** SQL literal backslashes, workspace-settable executables and consents, custom editor breakouts, regular expressions from model input, links escaping the workspace, the run log's false pass, weak nonces and temporary files, and the drivers folder.

**Remaining, accepted for now:** name-based masking is best effort, the run log can't detect tail loss, `style-src 'unsafe-inline'`, the Oracle driver's range, no size cap on ingestion.

**Not checked:** `mode: 'full'` Claude Code as a prompt-injection path, per-tool tier enforcement across all MCP handlers, licences of fetched content, and anything on a live platform or in a real webview.

## 8. Maintainability, measured

The figures are for v0.61.3: 282 files, 58,869 lines, 5,191 `if` statements, 4,230 ternaries. Complexity counts branches per function; a common guideline is about 10.

| Complexity | Functions, of 6,931 |
|---|---|
| Median | 1 |
| 90th percentile | 8 |
| Over 10 | 461 |
| Over 20 | 180 |
| Over 50 | 28 |

The worst are dispatchers: `handleMessage` 456, `journeyFor` 165, `cmdPlatform` 142, `cmdWorkflow` 107, `applyClaimed` 105, `onMessage` 99. The last three grew during POP5, and `planOnboarding`, written in POP5, is 68.

**Is this the best approach? Not for everything.** Adding a platform scales well, since it is files. Adding a decision kind, a panel message or a command doesn't: each lengthens a central `switch`. Those need tables of handlers (CR3). Validators and guards are conditional by nature and should stay so. There are 70 checks of a platform's name left, some of them deliberate safety code.

| SOLID principle | Assessment |
|---|---|
| Single responsibility | Broken in the dispatchers and `catalogView.ts` |
| Open/closed | Met for platforms, broken for decision kinds |
| Dependency inversion | Weak: the platform and decision layers import each other |
| Liskov, interface segregation | Not evaluated |

| Quality | How it was evaluated | Assessment |
|---|---|---|
| Maintainability | Reviewers' judgement, then measured | Weak in the dispatchers. Now held by a ratchet |
| Extensibility | Against the next phases | Strong for platforms, weak elsewhere |
| Readability | Not evaluated: style was excluded from the review | Unknown. Very long single-line statements are a concern |
| Testability | Reviewed | Good in the engine. `handleMessage` has no tests |
| Operational support | Barely: logging, diagnostics and upgrades weren't reviewed | Unknown, and the biggest gap |
