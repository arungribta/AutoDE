# Using AutoDE from other coding agents (MCP)

AutoDE ships an MCP server that gives Claude Code, VS Code's agent mode, Cursor and any other MCP client the same deterministic engine the AutoDE panel uses: reviewed transform primitives that compile to SQL, Pipeline Spec validation and compilation, AutoDE's requirements-interview prompts, the context layer (what the estate and the business problem hold), and a grounding check for SQL.

Everything the server offers is **read-only**. It never writes to your workspace and never calls an LLM. Your agent writes files with its own tools, after you approve them.

## What you need

- Node.js 18 or later on your `PATH`. Alternatively, use VS Code's own runtime, as described [below](#without-nodejs).
- The server file `dist/mcp-server.js`. It has no dependencies, and you can find it in either of two places:
  - **Installed extension:** `~/.vscode/extensions/<publisher>.auto-data-engineering-hub-<version>/dist/mcp-server.js` (Windows: `%USERPROFILE%\.vscode\extensions\…`). The folder name changes with every extension update, so update the path after updating. A command that writes a stable path for you comes in a later release.
  - **Source checkout:** run `npm install` and then `npm run compile`. The server is `<checkout>/dist/mcp-server.js`.
- A workspace that AutoDE has worked in, meaning it has an `.ai-context/` folder. Without one, the primitive and Pipeline Spec tools still work, but the context tools find nothing.

The server takes two arguments:

| Argument | Meaning |
|---|---|
| `--workspace <folder>` | The project whose `.ai-context/` the server reads. Defaults to the current directory. |
| `--resources <folder>` | The extension's root folder, which holds the bundled interview prompts and primitives. Found automatically next to the server file, so pass it only if you copied `mcp-server.js` somewhere else. |

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

**Prompts**
- `autode_interview_<part>`: AutoDE's requirements interview, one prompt per part.
- `autode_skill_<id>`: an imported tool skill, listed only if it has been reviewed or trusted in AutoDE (**AutoDE: Review Tool Skill**).

**Resources**
- The active business problem's specification, Pipeline Spec and context documents, under `autode://spec/…` and `autode://context/…`.
- Each primitive, under `autode://primitives/{kind}`.
- Every resource carries a `revision`, so a client that edits the file later can tell whether it changed in the meantime.

**Errors.** A failed tool call returns `isError: true` with `{ code, message, retryable, details }`, for example `VALIDATION_FAILED`, `UNKNOWN_PRIMITIVE`, `NOT_FOUND` or `PERMISSION_DENIED`. The server removes secrets from every response and log line.

## Not yet available

The following arrive in later releases:
- Data-platform tools: list connections, extract metadata, explain and run read-only queries.
- Proposing facts to AutoDE's context.
- Automatic registration in VS Code.
- A stable server path that survives extension updates.

## Troubleshooting

- **No tools show up.** Run the configured command yourself. The server prints `autode MCP server <version> — workspace <folder>` to stderr and then waits for input; press Ctrl+C to stop it.
- **The context tools return nothing.** Check that `--workspace` points at the folder that contains `.ai-context/`.
- **A skill prompt is missing.** It has not been reviewed for its current content. Review it in AutoDE: any change to a skill's files requires a new review.
