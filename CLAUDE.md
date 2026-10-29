# AutoDE: instructions for coding agents

Read [docs/README.md](docs/README.md) first: it maps every document (requirements = what and why, technical-design = how, roadmap = order, status and decisions). These rules add to it.

## Platform-specific work belongs in skills and platform operations, not in engine code

AutoDE stays platform-neutral, so that a platform change (a new object kind, a renamed view, a new CLI command) is handled by updating data and skills, never by releasing new code. Owner's decision, 2026-10-28; the MM1 decision log, and [docs/platform-operations.md](docs/platform-operations.md).

- **Every interaction with a platform is a platform operation:** a YAML file per interaction (read the estate, sample, read lineage, set a tag, grant, dry run), with typed parameters and a SQL or CLI template per platform. One platform-neutral executor runs them. Deterministic code calls an operation by its id; agents call the same operations through AutoDE's tools; changes run only as approved runbooks. Write new platform interactions as operation files.
- **Platform knowledge and judgement live in skills** (`skills/autode-<platform>-*`): which operations to use, platform feature choices, idiomatic platform code, troubleshooting. Skills refer to operations by id rather than carrying their own SQL.
- **The only platform-aware TypeScript** is the machinery that has to be code, in its own folders:

| Machinery | Why it is code | Where |
|---|---|---|
| The operation executor, parameter binding and result mapping | One tested engine for every operation | `src/engine/platform/` |
| Safety checks: is this SQL read-only or destructive; is this CLI command allowed; how a runbook step is classified | A model must never check its own output | `src/engine/platform/` (`sqlGuard.ts`, `dialectMarkers.ts`), `src/engine/runner/` |
| Connections, drivers and credentials | Agents never handle secrets | `src/engine/platform/` |
| Compiling deliverables to a dialect (Pipeline Specs, primitives) | Approvals are bound to exact content; the CLI has no model | `src/engine/transforms/`, driven by `primitive-definitions/` |

Prefer data over branches: an operation file, a dialect table or a YAML definition beats `if (platform === 'snowflake')` spread through the code. If a task seems to need platform code outside these folders, stop and ask the owner rather than adding it.

**Enforced by** [test/architecture.test.cjs](test/architecture.test.cjs) (part of `npm test`).
- Platform statements and CLI commands outside the folders above, and platform branches per file, are checked against [test/architecture/platform-boundary.json](test/architecture/platform-boundary.json), which records today's exceptions with the reason for each.
- Never raise a count or add a file there to make the test pass. Move the work into an operation file, a skill or an allowed folder. If an exception is truly needed, the owner agrees it, and its reason is recorded in the baseline and in the roadmap's decision log.
