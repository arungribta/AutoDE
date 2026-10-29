# AutoDE: instructions for coding agents

Read [docs/README.md](docs/README.md) first: it maps every document (requirements = what and why, technical-design = how, roadmap = order, status and decisions). These rules add to it.

## Platform-specific work belongs in skills, not in engine code

AutoDE stays platform-neutral. Work that is specific to Snowflake, Databricks, Oracle or any other platform is done by **AutoDE's agents, using platform skills (`skills/autode-<platform>-*`) and AutoDE's tools**. Changes to a platform are **runbooks** that a person approves and AutoDE's runner executes. Owner's decision (2026-10-28; MM1 decision log).

Before writing platform-specific TypeScript, apply this test. Only these four kinds of platform work may be code:

| Kind | Why it must be code | Where |
|---|---|---|
| **Safety checks**: is this SQL read-only or destructive; is this CLI command allowed; how a runbook step is classified | A model must never check its own output; one wrong call runs a `DROP` | `src/engine/platform/` (`sqlGuard.ts`, `dialectMarkers.ts`), `src/engine/runner/` |
| **Reading the estate**: catalog metadata, probes | Fast, cheap, identical on every run; everything downstream rests on it | `src/engine/platform/adapters/` |
| **Repeatable deliverables**: compiling a Pipeline Spec or a primitive to a dialect | Approvals are bound to exact content; CI and the eval compare outputs; the CLI has no model | `src/engine/transforms/` (prefer data: primitive definitions and dialect tables in YAML) |
| **Connections and credentials** | Agents never handle secrets | `src/engine/platform/` (`connectionsConfig.ts`, `credentials/`, `executionBackends/`) |

Everything else platform-specific is a skill: tags, grants, warehouses, schedules, deployment, platform feature choices, idiomatic platform code, troubleshooting. Do not add a TypeScript writer for it, even a small one.

- **Prefer data over branches:** a dialect table or a YAML definition beats `if (platform === 'snowflake')` spread through the code.
- **Say so when unsure.** If a task seems to need platform code outside these folders, stop and ask the owner rather than adding it.

**Enforced by** [test/architecture.test.cjs](test/architecture.test.cjs) (part of `npm test`).
- Platform statements and CLI commands outside the folders above, and platform branches per file, are checked against [test/architecture/platform-boundary.json](test/architecture/platform-boundary.json), which records today's exceptions with the reason for each.
- Never raise a count or add a file there to make the test pass. Move the work to a skill or runbook, or into an allowed folder. If an exception is truly needed, the owner agrees it, and its reason is recorded in the baseline and in the roadmap's decision log.
