# Using AutoDE from other coding agents (MCP)

AutoDE ships an MCP server that gives Claude Code, VS Code's agent mode, Cursor and any other MCP client the same deterministic engine the AutoDE panel uses: reviewed transform primitives that compile to SQL, Pipeline Spec validation and compilation, AutoDE's requirements-interview prompts, the context layer (what the estate and the business problem hold), a grounding check for SQL, and access to your Snowflake and Databricks connections.

The server never writes to your workspace and never calls an LLM. Your agent writes files with its own tools, after you approve them. Queries against your data platforms are **read-only** unless you start the server with `--allow-write`, and row values are returned only for connections where you allowed it ([Data platforms](#data-platforms)).

## What you need

- Node.js 18 or later on your `PATH`. Alternatively, use VS Code's own runtime, as described [below](#without-nodejs).
- The server file `dist/mcp-server.js`. It has no dependencies, and you can find it in either of two places:
  - **Installed extension:** `~/.vscode/extensions/<publisher>.auto-data-engineering-hub-<version>/dist/mcp-server.js` (Windows: `%USERPROFILE%\.vscode\extensions\…`). The folder name changes with every extension update, so update the path after updating. A command that writes a stable path for you comes in a later release.
  - **Source checkout:** run `npm install` and then `npm run compile`. The server is `<checkout>/dist/mcp-server.js`.
- A workspace that AutoDE has worked in, meaning it has an `.autode/` folder. Without one, the primitive and Pipeline Spec tools still work, but the context tools find nothing.

The server takes these arguments:

| Argument | Meaning |
|---|---|
| `--workspace <folder>` | The project whose `.autode/` the server reads. Defaults to the current directory. |
| `--resources <folder>` | The extension's root folder, which holds the bundled interview prompts and primitives. Found automatically next to the server file, so pass it only if you copied `mcp-server.js` somewhere else. |
| `--allow-cli` | Lets the server run the Snowflake CLI (`snow`). Needed for connections from `connections.toml` and for username/password sign-in; key-pair and Databricks connections don't need it. |
| `--drivers <folder>` | Where drivers you installed with AutoDE's guidance live (the Oracle driver). Defaults to `AUTODE_DRIVERS_DIR`, else `~/.autode/drivers`, which is the same folder the extension uses. |
| `--allow-write` | Lets `autode_execute_query` run statements that change data or objects. Leave it off unless you need it; see [Read-only by default](#read-only-by-default). |

## Claude Code

Add a `.mcp.json` file in the project root:

```json
{
  "mcpServers": {
    "autode": {
      "command": "node",
      "args": ["/path/to/dist/mcp-server.js", "--workspace", "."]
    }
  }
}
```

Or add the server from the command line:

```bash
claude mcp add autode -- node /path/to/dist/mcp-server.js --workspace .
```

Run `/mcp` in Claude Code to check that `autode` is connected.

## VS Code (agent mode)

Add `.vscode/mcp.json` to the workspace:

```json
{
  "servers": {
    "autode": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/dist/mcp-server.js", "--workspace", "${workspaceFolder}"]
    }
  }
}
```

A later release registers the server automatically, so this file won't be needed.

## Cursor

Add `.cursor/mcp.json` to the project, or `~/.cursor/mcp.json` to use it in every project:

```json
{
  "mcpServers": {
    "autode": {
      "command": "node",
      "args": ["/path/to/dist/mcp-server.js", "--workspace", "${workspaceFolder}"]
    }
  }
}
```

## Without Node.js

VS Code's own executable can run the server as plain Node. Set `ELECTRON_RUN_AS_NODE`:

```json
{
  "command": "/path/to/Code.exe",
  "args": ["/path/to/dist/mcp-server.js", "--workspace", "."],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
}
```

On macOS the executable is `/Applications/Visual Studio Code.app/Contents/MacOS/Electron`.

## Data platforms

The server reads connections from `.autode/config/connections.yaml` in the workspace. The file is committed with the rest of `.autode/config/`, so it holds **no secrets**: an entry with a `password`, `token` or private key in it is refused. Secrets come from environment variables or from the platform CLI's own configuration.

```yaml
connections:
  # A Snowflake CLI connection ([prod] in ~/.snowflake/connections.toml). Needs --allow-cli.
  - platform: snowflake
    role: source
    credentials: { resolver: cli, ref: prod }

  # Snowflake key-pair over the SQL API, no CLI needed. Settings that aren't secret can live here;
  # the key path and passphrase come from AUTODE_SNOWFLAKE_TARGET_PRIVATE_KEY_PATH and
  # AUTODE_SNOWFLAKE_TARGET_PRIVATE_KEY_PASSPHRASE.
  - platform: snowflake
    role: target
    account: ACME-XY12345
    username: AUTODE_SVC
    warehouse: ANALYTICS_WH
    database: ANALYTICS
    authMode: key-pair
    credentials: { resolver: env, ref: target }

  # Databricks with a personal access token in AUTODE_DATABRICKS_TOKEN.
  - platform: databricks
    workspaceUrl: adb-1234567890.12.azuredatabricks.net
    httpPath: /sql/1.0/warehouses/abc123
    credentials: { resolver: env }
    allowSampleDataInPrompts: false
```

| Key | Meaning |
|---|---|
| `platform` | `snowflake`, `databricks` or `oracle` (a source; see [Oracle](#oracle)). |
| `role` | `source` (default) or `target`. |
| `credentials.resolver` | `env`: environment variables `AUTODE_<PLATFORM>_<FIELD>`, or `AUTODE_<PLATFORM>_<REF>_<FIELD>` when `ref` is set. `cli`: a named connection in the Snowflake CLI's `connections.toml`. |
| `credentials.ref` | The CLI connection name, or the infix of the environment variables. |
| `id` | Optional. By default `<platform>:<CLI connection name, account or workspace URL>`, the id AutoDE uses for this connection everywhere else (estate bindings, extracted schema). |
| `allowSampleDataInPrompts` | Whether row values from this connection may reach a language model. Default `false`. See [Sample data](#sample-data). |
| other keys | Settings that aren't secret: Snowflake `account`, `username`, `warehouse`, `database`, `schema`, `role`, `authMode`, `keyPath`; Databricks `workspaceUrl`, `httpPath`, `catalog`, `schema`. |

Environment variable fields: Snowflake `ACCOUNT`, `USERNAME`, `WAREHOUSE`, `DATABASE`, `SCHEMA`, `ROLE`, `AUTH_MODE`, `PASSWORD`, `PRIVATE_KEY_PATH`, `PRIVATE_KEY`, `PRIVATE_KEY_PASSPHRASE`; Databricks `WORKSPACE_URL`, `HTTP_PATH`, `TOKEN`, `CATALOG`, `SCHEMA`; Oracle `CONNECT_STRING`, `USERNAME`, `PASSWORD`, `CONFIG_DIR`, `WALLET_LOCATION`, `WALLET_PASSWORD`. Pass them in the client's `env` block or set them in the shell that starts the client:

```json
{
  "mcpServers": {
    "autode": {
      "command": "node",
      "args": ["/path/to/dist/mcp-server.js", "--workspace", "."],
      "env": { "AUTODE_DATABRICKS_TOKEN": "${DATABRICKS_TOKEN}" }
    }
  }
}
```

**Without the file.** If `AUTODE_SNOWFLAKE_ACCOUNT` or `AUTODE_DATABRICKS_WORKSPACE_URL` is set, the server offers that connection as a source, with sample data off. This is the simplest set-up for CI.

**VS Code's secret store.** A server started by Claude Code or Cursor can't read the passwords and tokens you saved in AutoDE's settings panel. Use environment variables or the CLI's configuration. (When the AutoDE extension starts the server itself, in a later release, it passes those secrets as environment variables.)

**Without the platform CLIs.** Snowflake key-pair and Databricks token connections go over HTTPS and need no CLI.

### Oracle

AutoDE reads Oracle Database **12.1 and later** as a source, using the `oracledb` driver in Thin mode (pure JavaScript, no Oracle Instant Client). Oracle 11g and older need Thick mode, which AutoDE doesn't support. AutoDE doesn't ship the driver: in VS Code, run **AutoDE: Install Oracle Driver**. It shows the `npm` command, runs it in a terminal named "AutoDE" when you click, and then verifies the result. npm uses your own registry settings (`.npmrc`). Without VS Code, run the same command yourself:

```bash
npm install --prefix ~/.autode/drivers/oracle --ignore-scripts --no-audit --no-fund "oracledb@^6.0.0"
```

The server only uses a driver that AutoDE has verified. Run **AutoDE: Verify Oracle Driver** once. If the folder changes later, verify it again.

```yaml
connections:
  - platform: oracle
    connectString: PRODDB              # a tnsnames.ora alias, or Easy Connect: dbhost:1521/ORCLPDB1
    configDir: /opt/oracle/network/admin   # optional; otherwise TNS_ADMIN, then $ORACLE_HOME/network/admin
    username: AUTODE_RO
    credentials: { resolver: env }     # password in AUTODE_ORACLE_PASSWORD
```

- **tnsnames.ora** is found the way Oracle's own tools find it. AutoDE reads only the alias names, and lists them if the alias you gave isn't there; the driver resolves the alias. Aliases from files pulled in with `IFILE` are passed to the driver unchecked.
- **Credentials.** tnsnames.ora holds no credentials, and Oracle's wallet-based password store needs Thick mode, so the password comes from `AUTODE_ORACLE_PASSWORD` (or `AUTODE_ORACLE_<REF>_PASSWORD`). For a TLS wallet (e.g. Autonomous Database), set `walletLocation` and pass `AUTODE_ORACLE_WALLET_PASSWORD`.
- A schema is an owner; `autode_list_databases` returns the database (PDB) you are connected to. `autode_explain_sql` uses `EXPLAIN PLAN FOR`, which writes the plan to your session's `PLAN_TABLE`.
- Oracle's `q'[…]'` quoting is understood by the read-only guard. A q-quoted string that contains an apostrophe is refused; write it with doubled quotes (`'it''s'`) instead.

### Read-only by default

`autode_execute_query` runs exactly one statement per call and, unless the server was started with `--allow-write`, only `SELECT`, `WITH`, `SHOW`, `DESCRIBE` and `EXPLAIN`. Comments and quoted text are taken into account, so a write hidden behind a comment or inside a second statement is refused. With `--allow-write` the tool is marked destructive, so your client asks before each call.

This check reads the SQL text; it can't see what a function or a view does when it runs. **The real protection is the platform role:** give the connection a role that can only read.

`autode_explain_sql` compiles a statement with `EXPLAIN` without running it, including `CREATE`, `INSERT` and `MERGE` statements. Use it to check generated SQL before anyone runs it.

### Sample data

Whatever a tool returns goes into your agent's prompt, and so to its model provider. For that reason, a connection returns **no row values** unless its entry in `connections.yaml` has `allowSampleDataInPrompts: true`:

- `autode_execute_query` returns the columns and the row count, but no rows. `SHOW`, `DESCRIBE` and `EXPLAIN` return their output, because it describes objects, not data.
- `autode_extract_metadata` returns structure, row counts, and distinct and null counts, but not minimum or maximum values, or query text from the platform's history (which contains literal values from real queries).

When you allow sample data, values in columns that look like personal data (`email`, `phone`, `first_name`, `date_of_birth`, `iban` and similar names) are replaced by `[masked]`, as are e-mail addresses and card numbers in any column. The check works on names, so an alias such as `SELECT email AS e` gets past it. Phase GOV adds proper column classification. The AutoDE extension reads the same setting for its own connections. The server reads the file again on every call, so a change takes effect without a restart.

## What the server offers

**Tools**

| Tool | Use it to |
|---|---|
| `autode_search_primitives` | Find a transform primitive (deduplication, incremental load, rename and cast, and your team's own) instead of writing the SQL by hand. |
| `autode_describe_primitive` | Read a primitive's parameter schema. |
| `autode_validate_transform` | Check parameters against that schema. |
| `autode_compile_transform` | Generate the code for a target and SQL dialect. |
| `autode_validate_pipeline_spec` | Validate a Pipeline Spec (the active problem's, a file, or an inline spec). |
| `autode_compile_pipeline_spec` | Compile a Pipeline Spec, entity by entity, with a suggested path for each file. |
| `autode_generate_design_doc` | Generate the Pipeline Spec's design document. |
| `autode_resolve` | Find which tables, columns or business terms a phrase refers to, including the customer's own vocabulary. |
| `autode_get_context_pack` | Get the context AutoDE gives its own agents for a task: relevant objects, business facts, conflicts and gaps. |
| `autode_list_assertions` | List the facts AutoDE holds, with their status, trust and evidence. |
| `autode_check_grounding` | Check SQL against the known estate before proposing it: unknown tables and columns, ambiguous names, type mismatches. |
| `autode_list_connections` | See which data-platform connections the server can use, where their credentials come from, and whether sample data is allowed. Never shows secrets. |
| `autode_test_connection` | Connect and report the database, schema and platform version. |
| `autode_list_databases` / `autode_list_schemas` | Browse what the connection can see. |
| `autode_extract_metadata` | Read a schema's tables, columns, keys and views, and optionally sampled column profiles. |
| `autode_explain_sql` | Dry-run a statement: the platform compiles it and returns the plan without running it. |
| `autode_execute_query` | Run one statement, read-only unless the server allows writes, with at most 10 000 rows (100 by default). |

**Prompts**
- `autode_interview_<part>`: AutoDE's requirements interview, one prompt per part.
- `autode_skill_<id>`: an imported tool skill, listed only if it has been reviewed or trusted in AutoDE (**AutoDE: Review Tool Skill**).

**Resources**
- The active business problem's specification, Pipeline Spec and context documents, under `autode://spec/…` and `autode://context/…`.
- Each primitive, under `autode://primitives/{kind}`.
- Every resource carries a `revision`, so a client that edits the file later can tell whether it changed in the meantime.

**Errors.** A failed tool call returns `isError: true` with `{ code, message, retryable, details }`, for example `VALIDATION_FAILED`, `UNKNOWN_PRIMITIVE`, `NOT_FOUND`, `WRITE_NOT_ALLOWED`, `CONNECTION_FAILED`, `AUTH_FAILED`, `PERMISSION_DENIED`, `TIMEOUT` or `PLATFORM_ERROR`. The server removes secrets from every response and log line.

## Not yet available

The following arrive in later releases:
- Proposing facts to AutoDE's context.
- Automatic registration in VS Code.
- A stable server path that survives extension updates.

## Troubleshooting

- **No tools show up.** Run the configured command yourself. The server prints `autode MCP server <version> — workspace <folder>` to stderr and then waits for input; press Ctrl+C to stop it.
- **The context tools return nothing.** Check that `--workspace` points at the folder that contains `.autode/`.
- **`autode_list_connections` is empty.** Add `.autode/config/connections.yaml`, or set `AUTODE_SNOWFLAKE_ACCOUNT` / `AUTODE_DATABRICKS_WORKSPACE_URL` in the client's `env`. Entries that were refused, and why, are listed in `configErrors`.
- **"Oracle driver … is not ready".** Install it (above), then verify it. If you installed it in another folder, pass `--drivers <folder>` (the folder that contains `oracle/`).
- **"older than Oracle 12.1 … Thick mode".** The database is too old for Thin mode, which AutoDE doesn't support yet.
- **`PERMISSION_DENIED` mentioning `--allow-cli`.** The connection goes through the Snowflake CLI (a `cli` reference, or username/password). Add `--allow-cli` to the server's arguments, or switch to key-pair.
- **A skill prompt is missing.** It has not been reviewed for its current content. Review it in AutoDE: any change to a skill's files requires a new review.
