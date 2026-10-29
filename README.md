# AutoDE — Auto Data Engineering Hub

AutoDE is a data engineering workspace for VS Code. It takes a business problem from the first conversation to deployed, documented pipelines on Snowflake or Databricks (with Oracle as a source), with AI agents doing the drafting and a person deciding.

- **You decide.** Specifications, workflows, mappings, models, Pipeline Specs and platform changes wait for a person. Agents propose; they never approve.
- **Grounded.** AutoDE knows the estate (the real tables and columns) and the facts about it, each with its evidence and trust. Generated SQL is checked against the estate and the approved semantic layer (no invented joins or metrics), and every deliverable carries a manifest of what it relied on. The Knowledge Explorer shows everything AutoDE knows, and the same is available to the CLI and to agents.
- **Generated, not freehand.** Pipelines are described as data and compiled by reviewed primitives into SQL for Snowflake, Databricks, BigQuery, PostgreSQL or SQL Server.
- **Nothing changes a platform without you.** Platform changes run as approved runbooks, step by step, with dry runs and a tamper-evident log.
- **Works where you work.** The VS Code panel, a terminal (`autode`), and agent hosts such as Claude Code, Cortex Code and the GitHub Copilot CLI over MCP, all on the same files.

## Get started

1. Install the `.vsix`: Extensions view → **… → Install from VSIX…**.
2. Open your project folder and click the AutoDE icon in the activity bar.
3. Choose a model in the panel's settings (GitHub Copilot, Claude Code, OpenAI, Azure OpenAI, Anthropic, Gemini or Ollama).
4. Connect your source and target platforms and **Save as named connection**.
5. **＋ New** business problem, and describe the work.

**Read the [user guide](docs/guides/user-guide.md)**: setup, a first problem end to end, and every feature in detail.

## Documentation

| For | Read |
|---|---|
| Data engineers using AutoDE | [User guide](docs/guides/user-guide.md), [CLI](docs/guides/cli.md), [agent hosts and MCP](docs/guides/mcp-setup.md), [writing and porting skills](docs/guides/skills-authoring.md) |
| Engineers maintaining AutoDE | [Engineering onboarding guide](docs/guides/engineering-onboarding-guide.md), [technical design](docs/design/technical-design.md) |
| What and why, what's next | [Requirements](docs/requirements.md), [roadmap](docs/roadmap.md), [changelog](CHANGELOG.md) |

[docs/README.md](docs/README.md) lists every document and which question it answers.

## Build from source

Node.js (LTS) and npm:

```bash
npm install
npm run compile        # TypeScript, then the bundles in dist/
npm test               # the functional suite
npm run package:cli    # the autode CLI tarball, in dist/
```

Open the folder in VS Code and press F5 to run the extension in a development host. See the [engineering onboarding guide](docs/guides/engineering-onboarding-guide.md) before changing code.

## License

AutoDE is free to use for any purpose, including commercial use, under the MIT License (see [LICENSE](LICENSE)): you may use, copy, modify, merge, publish, distribute, sublicense and sell it, provided the copyright and licence notice stay with substantial copies. It comes without warranty.

The packaged extension bundles open-source libraries under their own permissive licences; their notices are generated at build time into `dist/THIRD-PARTY-NOTICES.md` and ship inside the package.
