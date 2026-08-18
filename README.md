# Auto Data Engineering Hub (AutoDE)

Auto Data Engineering Hub (AutoDE) is a VS Code extension that provides an AI-powered command-center for designing, planning, validating, and executing data engineering workflows. The extension is provider-agnostic (Snowflake-first) and supports multiple LLM providers. It features an agentic hub-and-spoke architecture, a DE Agent Workspace webview, plan-and-execute engine, and provider adapters.

This repository contains the extension source code, a webview-based UI (media/sidebar.html), and the core orchestration and provider adapter scaffolding.

---

## Features (current)

- DE Agent Workspace webview (command-center):
  - Top status strip with connection and token metrics
  - Single main column with tabs: "DE Agent Workspace", "Data Integration", "LLM Settings"
  - Context section (metadata) that appears when a data connection is established
  - Objective → Plan → Execute workflow with a collapsible execution plan
  - Chat refinement loop to iterate on plans
- Provider abstraction foundation (Snowflake adapter hardened)
- Snowflake key-pair authentication support in settings
- Strong typing and a hub-and-spoke architecture for future agents and providers
- UI visual polish toward a modern, minimal command-center aesthetic

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

- Webview UI: `media/sidebar.html` — contains the DE Agent Workspace UI and is intentionally self-contained for easy iteration. Edits here affect the extension UI after recompiling and reloading the extension host.
- Core code:
  - `src/core/` — hub, webview provider, config manager, types
  - `src/features/providers/` — provider adapters (Snowflake adapter currently implemented)
  - `src/features/agents/spokes/` — agent implementations (ingestion, architecture, snowflake executor, etc.)
- Settings are defined in `package.json` under the `contributes.configuration` section. Secrets (LLM keys, Snowflake private key passphrase) are stored via VS Code SecretStorage.

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

## Next steps (planned)

- Implement the Context Layer module (metadata API) and wire it into the Snowflake adapter so the webview can fetch live provider metadata.
- Add unit tests for the context layer and plan validation.
- Implement provider adapters for Databricks, BigQuery, Redshift, and Synapse.
- Enhance the plan/execution engine with versioned plans and improved logs.

---

## License

This project is licensed under the MIT License (see LICENSE file).

---

If you'd like the README content adjusted (more examples, architecture diagrams, or contributor guidance), tell me what to add and I'll update it and push a new commit.