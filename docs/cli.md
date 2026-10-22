# The `autode` command line

`autode` is AutoDE's engine without VS Code: the checks and compilers the AutoDE panel uses, the AutoDE MCP server (`autode mcp`), and the commands a person uses to resolve decisions. It works on the same `.autode/` files as the extension, so the panel, any MCP client, the CLI and git all see the same state.

The CLI holds no model credentials and never calls an LLM. Every command except `decisions approve` and `decisions reject` only reads AutoDE's state. Those two need a person at an interactive terminal.

## Install

`autode` needs Node.js 18 or later.

- **From the package tarball:** `npm install -g autode-<version>.tgz`. This puts `autode` on your `PATH`. To build the tarball from a source checkout, run `npm install` and then `npm run package:cli`; the tarball lands in `dist/`.
- **From the registry:** not published yet. Publishing is a separate decision.
- **Without installing:** the VS Code extension ships the same build. Run `node <extension folder>/dist/autode.js <command>`. The folder name changes with every extension update, so prefer the installed command for anything you configure.

`autode --version` prints the version, and `autode --help` lists the commands.

## Common options

| Option | Meaning |
|---|---|
| `--workspace <folder>` | The project that holds `.autode/`. Defaults to the current folder. |
| `--problem <id>` | One business problem (a folder under `.autode/problems/`). Defaults to the active problem. When no problem is active, which is normal in CI because `.autode/local/` isn't committed, commands that check run over every problem, and commands that need one problem ask for `--problem`. |
| `--json` | Machine-readable output: one JSON object on stdout. |
| `--resources <folder>` | Where the bundled interview prompts and primitives live. Found automatically next to `autode.js`. |

## Deterministic commands

These commands never change AutoDE's state, so they are safe in CI.

| Command | What it does | Fails (exit 1) when |
|---|---|---|
| `autode validate [path]` | Checks each problem's business-problem specification, Pipeline Spec (schema, plus the parameters of every primitive step) and mapping context. It also checks the workspace's primitive definitions and `connections.yaml`. With a `path`, it validates that one Pipeline Spec. | Any document is unreadable or invalid. |
| `autode compile --dialect <d> [path]` | Compiles the problem's Pipeline Spec, or the one at `path`, to SQL for `snowflake`, `spark_sql`, `google_sql`, `postgres`, `tsql` or `ansi`. Prints to stdout, or writes `<entity>/<nn>_<kind>.sql` files under `--out <folder>`. | The spec is invalid. |
| `autode grounding <file.sql>…` | Checks SQL against the estate AutoDE knows: unresolved tables and columns, ambiguous names, incompatible join and cast types. | A table or column is unresolved, or a type issue is found. |
| `autode conformance [--connection <id>]` | Checks each pack contract with a confirmed profile against the catalog and the pack's samples. With `--connection`, it also checks against live data, using read-only probes that return aggregates only. | A contract clause fails. |
| `autode probe [--connection <id>]` | Probes the keys, grains, relationships and data expectations that aren't verified yet, against samples or the connection, and reports pass or fail. Nothing is recorded in the ledger. To record a verification, use the panel's *Verify Claims with Probes* or the MCP tool `autode_verify_assertion`. | A probe fails. |
| `autode doctor` | Shows the version, Node, the workspace, the drivers folder, the prerequisites of the platforms your connections use (CLIs, drivers), and each connection with its readiness for AutoDE and for MCP clients. | `connections.yaml` has refused entries, or a required driver of a platform you use isn't ready. |
| `autode check` | **The CI gate.** Runs everything `validate` runs. It then fails if a pending high-stakes decision belongs to the problems checked (or to no problem). A decision a person has resolved in its committed file counts as resolved. | Validation fails (exit 1), or a high-stakes decision is still pending (exit 3). |

`conformance` and `probe` with `--connection` connect read-only, exactly as the MCP server does. Pass `--allow-cli` for connections that need the platform CLI, and `--drivers <folder>` if your drivers aren't in `~/.autode/drivers`.

### Using `check` in CI

```yaml
# GitHub Actions
- run: npm install -g ./tools/autode-0.42.0.tgz   # or from your registry
- run: autode check --json
```

`check` reads committed files only. A decision approved in the panel or in its file passes. A proposal nobody has looked at blocks the merge until a person resolves it.

## Business problems

Work in AutoDE happens in a business problem, a folder under `.autode/problems/`.

| Command | |
|---|---|
| `autode problems list` | Every problem with its status and specification version; `*` marks the active one. |
| `autode problems new "<problem statement>"` | Starts a problem. It creates the folder (named from the statement, as the panel names it) and a first draft specification holding the statement, and makes the problem active. Nothing is approved: the interview, the specification and its approval follow, in the AutoDE panel or with an AutoDE skill in your agent. |
| `autode problems use <id>` | Makes another problem active. The panel follows, and so does the MCP server. |

The active problem is per engineer (`.autode/local/`), so in CI pass `--problem <id>` or let the checking commands cover every problem.

## Estate

The estate is what AutoDE knows about your systems: their tables and columns, organised by system and environment (`.autode/knowledge/estate.yaml`). Grounding, context packs, conformance and mappings all rely on it. These commands load it with the same code as the panel's *Ingest File* and Source Assessment. What they record is what the file or platform says. That's an observation, not a judgement, so it needs no approval.

| Command | |
|---|---|
| `autode estate show` | Systems, bindings (which connection or file feeds which system, and which schemas), how many tables the catalog holds per system, and the working set agents get as context. |
| `autode estate ingest <file>... [--system <s>] [--environment <e>]` | Imports DDL (`.sql`, `.ddl`), CSV or JSON. With `--system`, the files are bound to that system first; otherwise an existing binding applies, or a system named after the file is created. |
| `autode estate extract --connection <id> --schema <DATABASE.SCHEMA>... [--system <s>] [--profile]` | Reads the structure of a connection's schemas: tables, columns, keys and views. With `--profile` it also reads sampled counts, and row values only where the connection allows sample data. `--system` binds the connection and its schemas, so the next `extract` needs only `--connection`. |

Large estates go into the catalog in full. The working set, the part agents get as context, takes what fits and grows as tasks use more.

## Workflow

Each business problem has a **workflow**: its stages, planned from a template (greenfield, modernization, estate merge, or your workspace's own in `.autode/config/workflows/`). See [workflow-templates.md](workflow-templates.md).

| Command | |
|---|---|
| `autode workflow templates` | The templates, each stage with its kind and inclusion (mandatory, default, conditional, optional). |
| `autode workflow status` | Each stage: done, ready, in progress, waiting for approval, pending (and what it waits for), stale (and why), skipped (and the reason). The `next` line says what to do now. |
| `autode workflow plan [--template <id>]` | The planning stage. Drafts the workflow from the template (default: AutoDE's suggestion, from the spec and the estate) and proposes it. Conditional stages are decided from facts, for example a contract in the pack switches conformance on. Re-run it to re-plan. A different template restarts the workflow. |
| `autode workflow approve [<stage>]` | Approves the pending workflow, or a stage's gate. Needs an interactive terminal, like `decisions approve`. |
| `autode workflow next` | The next assignment: stage, role, permission tier, what it consumes and produces. |
| `autode workflow start <stage>` | Marks a stage in progress. Working ahead of its dependencies is allowed; it just can't be approved before them. |
| `autode workflow complete <stage> --output <file>... --summary <text>` | Hands in a stage. The files must exist; the approval goes to a person. Stages whose output is a document with its own approval (spec, contexts, mapping, Pipeline Spec) complete when that document is approved. |
| `autode workflow skip <stage> --reason <text>` | Skips a default, conditional or optional stage. Never a mandatory one, nor one whose output a later stage needs. |
| `autode workflow reopen <stage> --reason <text>` | Re-opens a done stage. Everything downstream becomes stale and needs approval again. |
| `autode workflow history [<stage>]` | Who did what, when, through which channel, and why: the engine's suggestion (with its rule), drafts, proposals, approvals (by whom, in the panel, CLI, decision file or document), hand-ins, skips, staleness and re-openings. Agents are labelled as agents. |

## Knowledge: facts, pack, vocabulary

AutoDE's knowledge is the facts in its ledger: keys, grain, relationships, terms, metrics, rules and decisions. Agents and documents *propose* facts; a person confirms them. These commands are the panel's Context Inbox in a terminal.

| Command | |
|---|---|
| `autode facts` (or `facts list`) | What waits for review (proposed, or flagged for review after a failed check or a conflict). For each fact it shows its stakes, trust, what it corrects, any probe result, and where it came from. `--kind <k>` narrows the list; `--all` shows every fact. |
| `autode facts show <id>` | One fact with its value, subject and evidence. |
| `autode facts confirm <id>...` | Confirms the facts. A correction replaces the fact it corrects. |
| `autode facts confirm --from <source>` | Confirms every **documented** fact from one source, for example a pack document. This is the only bulk confirmation. |
| `autode facts reject <id> [--note <text>]` | Rejects a fact. |
| `autode facts edit <id> [--statement <text>] [--value <json>]` | Replaces a fact with your corrected version, confirmed. |
| `autode facts conflicts` | Facts that contradict each other. |

`confirm`, `reject` and `edit` show the facts and ask you to type the verb. They need an interactive terminal and refuse when `CI` is set. `--by` names you; the default is your OS user. Agents can confirm low-stakes facts (terms, naming conventions, assumptions) themselves, after asking you. Every other fact waits for you, here or in the panel.

| Command | |
|---|---|
| `autode pack list` | The active problem's documents: contracts, BRDs, KPI definitions, mappings, data dictionaries and samples. |
| `autode pack add <file> --role <role> --authority signed\|draft --doc-version <v> [--table <object id>]` | Adds a document. `signed` makes its clauses confirmed facts; `draft` makes them documented facts, to review. A sample needs `--table`. Needs a terminal. An agent can add only drafts. |
| `autode pack apply [<doc id>...]` | Reads structured documents (YAML, JSON) through their **confirmed** interpretation profile, deterministically. A document with no confirmed profile is reported: profiles are in `.autode/knowledge/profiles/`, and a person sets `status: confirmed`. Free-text documents need a model: use the panel, or the extraction prompt in an MCP host. |
| `autode vocabulary mine` | Abbreviations mined from table and column names and comments (for example `PTRN = patron`) that aren't in the vocabulary yet. |
| `autode vocabulary accept` | Shows the mined entries and lets you pick which are right for this customer. They go to `.autode/knowledge/vocabulary.yaml`. Needs a terminal. |

## SQL and documents

| Command | |
|---|---|
| `autode design-doc [path] [--out <file>]` | The Pipeline Spec's design document, as Markdown. |
| `autode query --connection <id> "<sql>" [--max-rows <n>]` | Runs one read-only statement. It uses the same guard as the MCP server, so writes are refused. Row values are shown only when the connection allows sample data; otherwise you get the columns and the row count. |
| `autode explain --connection <id> "<sql>"` | The platform's plan for a statement, which may be DDL or DML. Nothing runs. |

## Connections

Connections to Snowflake, Databricks and Oracle (Oracle as a source) are kept in `.autode/config/connections.yaml`, which is committed and shared by the team, and in your personal `.autode/local/connections.yaml`. Neither file ever holds a secret. These commands manage those files without VS Code. They write exactly what the extension's settings cards write.

| Command | |
|---|---|
| `autode connections list` | Each connection: its role and credential source, whether it is ready on this machine, and what it still needs, such as the environment variables not set in this terminal. |
| `autode connections test <id>` | Connects read-only and records the result on this machine. |
| `autode connections add` | Sets one up, interactively. |
| `autode connections remove <id>` | Removes the entry from both files, after you type `remove` to confirm. |

**`add`, step by step:**
1. It asks for the platform and the role (source or target).
2. **It offers the connections your platform tools already know**: the named connections in the Snowflake CLI's `connections.toml`, or the profiles in `.databrickscfg`. Pick one, and AutoDE stores only its name. Or answer `env` to give the settings yourself and supply the secret through an environment variable.
3. It asks only for what is still missing, for example the SQL warehouse's HTTP path for a Databricks profile. Fields that differ per engineer (username, key path) go to your personal file.
4. **It tests the connection before saving it.** If the test fails, nothing is written, and you see the platform's own error.
5. It shows what will be written and asks you to type `save`.

You can answer any question up front with flags: `--platform`, `--role`, `--resolver cli|env`, `--ref <connection or profile name>`, `--set key=value` (repeatable), `--scope team|personal`, `--allow-sample-data`, and `--no-test` to save without testing.

```
autode connections add --platform databricks --resolver cli --ref prod --set httpPath=/sql/1.0/warehouses/abc123
```

`add` and `remove` need an interactive terminal and refuse when `CI` is set, like `decisions approve`. A connection decides which platforms AutoDE and its agents can reach, so a person sets it up. An agent in Claude Code or another MCP client can propose one with `autode_propose_connection`, and a person approves it with `autode decisions approve`. In a pipeline, commit the file instead.

Secrets never go in these files. A field such as `password` or `token` is refused. They come from the platform CLI's configuration (`--resolver cli`) or from environment variables (`--resolver env`). `connections list` names the variables. VS Code's secret storage (`resolver: vscode`, used by the extension's settings cards) is reachable only from the extension. Outside it, the same connection takes its secret from the variables `connections list` shows.

## Decisions

| Command | |
|---|---|
| `autode decisions list [--status <s>] [--kind <k>] [--problem <id>]` | Lists decisions with their status, stakes and kind. `--status` is one of pending, approved, rejected, applied, superseded, withdrawn or failed. |
| `autode decisions show <id>` | Shows one decision: summary, validation, evidence, history and the full proposal. |
| `autode decisions approve <id> [--note <text>] [--by <name>]` | Approves a decision and applies it. Specification and Pipeline Spec revisions, mappings and facts are applied at once. An approved platform change runs when an MCP server started with `--allow-write` applies it. |
| `autode decisions reject <id> [--note <text>] [--by <name>]` | Rejects a decision. |

`approve` and `reject` work only in an interactive terminal (stdin and stdout), and they refuse whenever `CI` is set (to anything other than empty, `0` or `false`). They show the decision and ask you to type `approve` or `reject` to confirm. `--by` defaults to your OS user name. This is the *CLI* channel of a decision: it may resolve high-stakes decisions, because it needs a person at the keyboard. A non-interactive run never resolves a decision (requirements P9).

## Agent hosts

AutoDE's agents (role templates) and skills, for Claude Code, Cortex Code and the GitHub Copilot CLI. Your host supplies the model; the AutoDE MCP server supplies the engine, the workflow and the approvals.

| Command | What it does |
|---|---|
| `autode plugin path [--out <folder>]` | Builds the plugin folder (agents, skills, `/autode-status`, `/autode-next`, `/autode-approve`, `.mcp.json`) and prints its path. Load it with `claude --plugin-dir <path>`; Cortex Code reads the same layout. |
| `autode plugin install --host claude\|cortex\|copilot [--scope project\|user]` | Copies the agents and skills into the host's folders: `.claude/` (and the project's `.mcp.json`, other servers kept), `.cortex/skills` or `~/.snowflake/cortex/skills`, `.github/agents` and `.github/skills` or `~/.copilot/…`. Where the host has no file for MCP servers, it prints the step to add `autode`. |

Then ask the agent to continue your AutoDE problem: the `autode-orchestrator` skill takes each assignment from the workflow, has the named agent do it, hands the stage in, and stops at every approval.

## The MCP server

`autode mcp` is the AutoDE MCP server over stdio. Its flags are `--workspace`, `--resources`, `--allow-cli`, `--drivers` and `--allow-write`. It is the same server as `dist/mcp-server.js` in the extension, at a path that doesn't change with extension updates. Per-host set-up: [mcp-setup.md](mcp-setup.md).

## Exit codes

These codes are stable. Scripts may rely on them.

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | A check or validation failed; the findings are printed. When `check` finds both a validation failure and a pending decision, it returns 1. |
| 2 | Usage: an unknown command, a bad option, or a missing argument (for example `compile` without `--dialect`, or several problems and no `--problem`). |
| 3 | `check` only: validation passed, but a pending high-stakes decision affects the problem. |
| 4 | Refused: a person is needed. Either there is no interactive terminal, `CI` is set, the confirmation wasn't typed, or the decision's stakes don't allow this channel. |
| 5 | Not found: a file, business problem, decision or connection. |
| 6 | A data platform couldn't be reached or refused the request (connection, authentication, timeout, platform error). |
| 70 | Internal error. Please report it. |
