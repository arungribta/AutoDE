# AutoDE documentation map

Each document answers one kind of question. When two disagree, the precedence rule below decides.

## Layout

| Where | What |
|---|---|
| [requirements.md](requirements.md) | **The root:** every requirement, what and why, with its status; it links to the specification of each one still to be built |
| [roadmap.md](roadmap.md) | Order, status, the backlog and the decision log |
| [specs/](specs/) | Phase specifications, each reached from requirements.md §1.1 |
| [design/](design/) | How AutoDE is built: the technical design, design records such as the code audit |
| [testing/](testing/) | How it is checked by hand, release by release; the automated suites and the eval are in [../test/](../test/) |
| [guides/](guides/) | For people: using AutoDE, its CLI and MCP setup, writing and porting skills, the skill catalog, and the onboarding guide for engineers |
| [schemas/](schemas/) | JSON Schemas of AutoDE's data formats |

| Question | Document | Notes |
|---|---|---|
| **What** must AutoDE do, and **why**? (shipped behaviour) | [requirements.md](requirements.md) | Authoritative for shipped behaviour and for the product-wide principles (P1–P9, C1–C9). Requirements have IDs (`WS-1`, `GRD-4` …) and a status. |
| What and why, for **planned** work | [specs/](specs/): [mcp-engine.md](specs/mcp-engine.md) · [context-layer.md](specs/context-layer.md) · [platform-operations.md](specs/platform-operations.md) · [ui-simplification.md](specs/ui-simplification.md) · [workflow-templates.md](specs/workflow-templates.md) | Phase specifications: WHAT/WHY plus the implementation contract for phases not yet built, each indexed in requirements.md §1.1. A migration-track spec (M1–M3) will join them. |
| **When**, and is it done? | [roadmap.md](roadmap.md) | The only place for phase order and status, the unscheduled backlog, and the decision log. |
| **How** is it built? | [technical-design.md](design/technical-design.md) | Architecture, modules, data formats, algorithms, trade-offs. |
| What **changed** in each version? | [CHANGELOG.md](../CHANGELOG.md) | Newest first, including deliberate deviations from the specs. |
| How do I **use** AutoDE as a data engineer? | [user-guide.md](guides/user-guide.md) | Setup, a first business problem end to end, and every feature in detail. The README's extended version. Updated with each release. |
| How do I get oriented as a new engineer maintaining AutoDE's code? | [engineering-onboarding-guide.md](guides/engineering-onboarding-guide.md) | Orientation for new engineers: the concept map (the ideas a data engineer works with and the guarantee each carries), flows, code tour, daily loop, how to extend, known risks. Links into the documents above for detail. |
| How do I use AutoDE from Claude Code, Codex, VS Code agent mode, Cursor or Cline? | [mcp-setup.md](guides/mcp-setup.md) | MCP server configuration per host and what it offers (v0.35.0; `autode mcp` since v0.42.0). |
| Which stages does an engagement go through? | [workflow-templates.md](specs/workflow-templates.md) | Stage kinds and the greenfield, modernization and estate-merge templates, with sources (v0.44.0). |
| How do I run AutoDE's checks in CI, or approve a decision from a terminal? | [cli.md](guides/cli.md) | The `autode` command line: commands, the `check` gate, decisions, exit codes (v0.42.0). |
| How do I verify a release by hand? | [manual-verification.md](testing/manual-verification.md) | F5 checklist, one part per version (v0.25.0 on). |
| Data formats | [schemas/](schemas/) | JSON Schemas for context envelopes and primitive definitions. |
| Which skills does AutoDE have, and which vendor skills does it work with? | [skills.md](guides/skills.md) | Generated catalog: AutoDE's skills, the interview packs, external skills with their licences and how to install them. |
| How do I write my own skill, or bring in one written for another agent? | [skills-authoring.md](guides/skills-authoring.md) | Knowledge and procedure skills, the Port a Skill wizard and CLI, licences, updates, and the limit on hosts. |
| What do the Snowflake, Databricks, dbt and reconciliation skills do, and how are they tested and kept from changing a platform directly? | [platform-skills.md](guides/platform-skills.md) | When a stage gets each platform skill, runbooks, the guard hook, vendor skills, and the worked-example check. |
| How will the panel show where a problem stands, and what is changing in the next round of UI simplification? | [ui-simplification.md](specs/ui-simplification.md) | UI2: one AutoDE window (Explorer, Workflow, Platform catalog); the whole journey (problem, discovery, specification, plan, delivery) with one next step; a smaller palette. |
| How does AutoDE interact with a platform without platform-specific code, and stay current when platforms change? | [platform-operations.md](specs/platform-operations.md) | Platform operations: one YAML file per interaction, one executor, called by the engine and by agents; changes only as runbooks; a catalog to review operations and edit the skills that use them. Why it exists: §1. Phases POP1–POP5. |
| What did the October 2026 code audit remove, and what is stranded or overlapping and waiting for a decision? | [code-audit-2026-10.md](design/code-audit-2026-10.md) | Dead code removed, with the reason for each; stranded and overlapping paths with recommendations; what stays parked for the roadmap. |
| How is AutoDE measured? | [../test/reference/retail-orders/README.md](../test/reference/retail-orders/README.md) | Reference problem and `npm run eval`; frozen reports in `baselines/`. |

## Precedence when documents disagree

1. **Behaviour that has shipped:** the code, then the latest [CHANGELOG.md](../CHANGELOG.md) entry, then requirements.md. A disagreement is a documentation bug; record it in the roadmap.
2. **Planned behaviour:** the phase specification, as ordered by roadmap.md.
3. **Order and status:** roadmap.md, over any plan text elsewhere (plan sections in earlier versions of requirements.md and technical-design.md, at `fc16b0d`, are historical).

## Rules for keeping these documents straight

- **WHAT/WHY and HOW stay apart.** Requirements don't name files, classes or CLI flags; technical design doesn't restate requirements.
- **When a phase ships:** its WHAT/WHY moves into requirements.md, its HOW into technical-design.md, its spec section shrinks to a pointer, it gets a CHANGELOG entry and a ✅ in the roadmap; the onboarding guide and the manual-verification checklist are updated for anything a newcomer or a tester needs. `npm run docs:generate` refreshes the generated parts of technical-design.md, and `npm test` fails when they are stale.
- **requirements.md points to the specs, never repeats them:** its §1.1 map and the *Planned work* line under each capability say where planned work is specified.
- **New plans go in the roadmap,** never in a new section of another document. New phase specifications go in the relevant spec (or a new spec listed here).
- **Phase identifiers are unique:** `1`–`6`, `S1`–`S3`, `DRV1`/`DRV2`, `GOV`, `PA1`–`PA4` (mcp-engine spec); `C1`–`C6`, `C4a`/`C4b`, `K1`/`K2` (context-layer spec); `LAY` (roadmap decision, technical-design §2.1–2.2); `M1`–`M3`, `RET` (to be specified). Shipped work is referred to by version.
- **New documents are added to this map,** or they don't exist.
