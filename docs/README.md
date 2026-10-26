# AutoDE documentation map

Each document answers one kind of question. When two disagree, the precedence rule below decides.

| Question | Document | Notes |
|---|---|---|
| **What** must AutoDE do, and **why**? (shipped behaviour) | [requirements.md](requirements.md) | Authoritative for shipped behaviour and for the product-wide principles (P1–P9, C1–C9). Requirements have IDs (`WS-1`, `GRD-4` …) and a status. |
| What and why, for **planned** work | [mcp-engine-requirements.md](mcp-engine-requirements.md) — MCP server, engine boundary, the portable architecture (§3.1: skills, tools, decisions, standalone package), platform access, governance · [context-layer-requirements.md](context-layer-requirements.md) — ledger, context packs, grounding, estate catalogs, business-problem documents, semantic model | Phase specifications: WHAT/WHY plus the implementation contract for phases not yet built. A migration-track spec (M1–M3) will join them. |
| **When**, and is it done? | [roadmap.md](roadmap.md) | The only place for phase order and status, the unscheduled backlog, and the decision log. |
| **How** is it built? | [technical-design.md](technical-design.md) | Architecture, modules, data formats, algorithms, trade-offs. |
| What **changed** in each version? | [CHANGELOG.md](../CHANGELOG.md) | Newest first, including deliberate deviations from the specs. |
| How do I get oriented as a new engineer? | [engineering-onboarding-guide.md](engineering-onboarding-guide.md) | Orientation for new engineers: the concept map (the ideas a data engineer works with and the guarantee each carries), flows, code tour, daily loop, how to extend, known risks. Links into the documents above for detail. |
| How do I use AutoDE from Claude Code, Codex, VS Code agent mode, Cursor or Cline? | [mcp-setup.md](mcp-setup.md) | MCP server configuration per host and what it offers (v0.35.0; `autode mcp` since v0.42.0). |
| Which stages does an engagement go through? | [workflow-templates.md](workflow-templates.md) | Stage kinds and the greenfield, modernization and estate-merge templates, with sources (v0.44.0). |
| How do I run AutoDE's checks in CI, or approve a decision from a terminal? | [cli.md](cli.md) | The `autode` command line: commands, the `check` gate, decisions, exit codes (v0.42.0). |
| How do I verify a release by hand? | [manual-verification.md](manual-verification.md) | F5 checklist for v0.25.0–v0.36.0, one part per version. |
| Data formats | [schemas/](schemas/) | JSON Schemas for context envelopes and primitive definitions. |
| Which skills does AutoDE have, and which vendor skills does it work with? | [skills.md](skills.md) | Generated catalog: AutoDE's skills, the interview packs, external skills with their licences and how to install them. |
| What do the Snowflake, Databricks, dbt and reconciliation skills do, and how are they tested and kept from changing a platform directly? | [platform-skills.md](platform-skills.md) | When a stage gets each platform skill, runbooks, the guard hook, vendor skills, and the worked-example check. |
| What did the October 2026 code audit remove, and what is stranded or overlapping and waiting for a decision? | [code-audit-2026-10.md](code-audit-2026-10.md) | Dead code removed, with the reason for each; stranded and overlapping paths with recommendations; what stays parked for the roadmap. |
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
