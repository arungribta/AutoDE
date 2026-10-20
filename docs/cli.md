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

## Decisions

| Command | |
|---|---|
| `autode decisions list [--status <s>] [--kind <k>] [--problem <id>]` | Lists decisions with their status, stakes and kind. `--status` is one of pending, approved, rejected, applied, superseded, withdrawn or failed. |
| `autode decisions show <id>` | Shows one decision: summary, validation, evidence, history and the full proposal. |
| `autode decisions approve <id> [--note <text>] [--by <name>]` | Approves a decision and applies it. Specification and Pipeline Spec revisions, mappings and facts are applied at once. An approved platform change runs when an MCP server started with `--allow-write` applies it. |
| `autode decisions reject <id> [--note <text>] [--by <name>]` | Rejects a decision. |

`approve` and `reject` work only in an interactive terminal (stdin and stdout), and they refuse whenever `CI` is set (to anything other than empty, `0` or `false`). They show the decision and ask you to type `approve` or `reject` to confirm. `--by` defaults to your OS user name. This is the *CLI* channel of a decision: it may resolve high-stakes decisions, because it needs a person at the keyboard. A non-interactive run never resolves a decision (requirements P9).

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
