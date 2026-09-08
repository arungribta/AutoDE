# Auto Data Engineering Hub (AutoDE)

Auto Data Engineering Hub (AutoDE) is a VS Code extension that provides an AI-powered command-center for designing, planning, validating, and executing data engineering workflows. The extension is provider-agnostic (Snowflake-first) and supports multiple LLM providers. It features an agentic hub-and-spoke architecture, a DE Agent Workspace webview, plan-and-execute engine, and provider adapters.

This repository contains the extension source code, a webview-based UI (media/sidebar.html), and the core orchestration and provider adapter scaffolding.

---

## Features (current)

- **DE Agent Workspace** webview with a conversation-first flow (Objective → Plan → Execute → Refine)
- **GitHub Copilot integration** via VS Code's Language Model API (`vscode.lm`) — no API key, opt-in consent
- **Multi-LLM support** (OpenAI, Azure OpenAI, Anthropic, Gemini, Ollama, Copilot)
- **Agentic sub-agents**: Source Assessment, Data Modeler (dimensional / data-vault / OBT / 3NF), Transformation Scaffolder (dbt), STTM Mapper, Ingestion, Documentation
- **Workflow phases** (discover → model → build → validate) with artifacts written to a visible, configurable `auto-de/` folder
- **Context Layer** (`src/context/`) — in-memory graph (GraphManager), context file loading/watching, target-environment profiles
- **Data platform adapter layer** (`src/dqm/`) — Snowflake + Databricks adapters (see status caveats below)
- **Bottom panel dashboard** (`src/core/panelProvider.ts`) and **5 custom editors** (DataModel, STTM, Graph, Profile, Doc)
- **Webview CSP nonce injection** (`src/core/webviewSecurity.ts`) so inline scripts run under VS Code's default CSP

---

## Quick start (development)

Requirements:
- Node.js (LTS)
- npm
- Visual Studio Code

Commands (run from repository root):

1. Install dependencies

   npm install

2. Compile TypeScript

   npm run compile

   For incremental development, use:

   npm run watch

3. Open in VS Code

   - Open this folder in VS Code.
   - Run the "Auto Data Engineering Hub: Open Sidebar" command (Command Palette) or open the Activity Bar icon.

4. Package (optional)

   If you want a VSIX package you can install into VS Code, use `vsce` (not required):

   - Install vsce: `npm i -g vsce`
   - Package: `vsce package`

---

## Development notes

- Webview UI: `media/sidebar.html` (workspace), `media/panel.html` (dashboard), `media/editors/*.html` (custom editors) — all single-file HTML, served with a CSP nonce via `src/core/webviewSecurity.ts`.
- Core code:
  - `src/core/` — hub, webview/panel providers, config manager, Copilot adapter, types
  - `src/context/` — graph manager, context/project/target config managers
  - `src/dqm/` — data platform adapters (Snowflake, Databricks)
  - `src/agents/` — sub-agents (discover/model/build/validate)
  - `src/editors/` — custom text editors
- Settings are defined in `package.json` under the `contributes.configuration` section. Secrets (LLM keys, Snowflake password/passphrase) are stored via VS Code SecretStorage.
- **Known issue:** the Cline extension (`saoudrizwan.claude-dev`) can crash the Extension Development Host (SIGABRT / exit code 134) during startup. The F5 launch config disables it via `--disable-extension=saoudrizwan.claude-dev` to keep the dev host stable.

---

## Security & secrets

- Do not commit secrets (API keys, private keys)
- The extension uses VS Code SecretStorage for sensitive values. Use the extension settings UI or the webview settings controls to store secrets via the host extension (they will be saved using the ExtensionContext secrets API).

---

## Contributing

- Use feature branches and open a pull request against `main`.
- Keep changes small and focused; follow the existing TypeScript style.
- The project includes a Co-authored-by trailer for commits made through automated tools; keep it if merging automated commits.

---

## Context Layer Engine (implemented)

A Context Layer Engine has been added under `src/context/`. **Note:** it is currently in-memory only — the vector/embedding engine, ContextRetriever, and worker-thread offloading are not yet implemented. The target information architecture (layered context, unified metadata envelope, provenance, versioning) is specified in `docs/requirements.md` §3–§5, with the envelope JSON Schema at `docs/schemas/context-envelope.schema.json`.

- `src/context/types.ts` — strict TypeScript type definitions for nodes, edges, retrieval options, and diagnostics.
- `src/context/GraphManager.ts` — a thread-safe in-memory graph manager that provides:
  - fast lookup indexes for FQN, labels, and node types
  - neighborhood traversal with decay-based relevance scoring (seeded BFS)
  - snapshot serialization for worker transfer
  - disposable lifecycle (implements `vscode.Disposable` semantics)

The Context Layer is designed to be used with worker-thread-based engines (vectorization, hybrid retrieval) and to persist state atomically into the workspace `.ai-context/` directory.

## Architecture Diagram

A draw.io diagram depicting the Context Layer architecture and integration with the extension host and webview is available at `media/architecture.drawio`.

## Changes since last update

- Synced docs and phase tracking to v0.5.0 (Phases 0–5 committed).
- Added webview CSP nonce injection (`src/core/webviewSecurity.ts`) for the sidebar, panel, and custom editors.
- Documented accurate implementation status (see caveats below).

## Implementation status caveats

- `SnowflakeAdapter`/`DatabricksAdapter` `connect()` and `executeQuery()` are **stubs** — no real connection/query execution (empty results); metadata extraction is non-functional end-to-end.
- `GraphManager` is in-memory only; `isWorkerReady` is hardcoded and the ContextRetriever / vector engine / worker threads / `js-tiktoken` / `ajv` are not implemented.
- `deactivate()` is empty (no watcher/dispose/cleanup).

## Next steps (planned)

- Implement real Snowflake/Databricks adapter execution (wire `snowflake-sdk` into the adapter layer).
- Implement ContextRetriever + vector/worker engine (token-aware retrieval, embedding).
- Replace hand-rolled YAML parsers with a real parser + AJV validation.
- Implement `deactivate()` cleanup.
- Add unit/integration tests for the context layer, adapters, and agents.

---

## License

This project is licensed under the MIT License (see LICENSE file).

---

If you'd like the README content adjusted (more examples, architecture diagrams, or contributor guidance), tell me what to add and I'll update it and push a new commit.