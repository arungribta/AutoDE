# Writing and porting skills

> **Describes:** v0.46.0. For data engineers who want to add a capability to AutoDE: their own conventions, a procedure they repeat, or a skill written for another agent. No code is needed.

A **skill** is a folder with a `SKILL.md` file: a short YAML header and Markdown instructions, plus any scripts or reference files it uses. This is the [Agent Skills](https://agentskills.io) format that Claude, Cortex Code, the Copilot CLI and others read, so a skill you write for AutoDE also works in those agents, and theirs work in AutoDE.

AutoDE's own skills live in [`skills/`](../skills) and are described in [skills.md](skills.md) and [platform-skills.md](platform-skills.md). This guide is about **your team's skills**: the ones you import into a workspace.

## Two kinds of skill

| | Knowledge | Procedure |
|---|---|---|
| What it is | Guidance an agent reads: conventions, rules, reference | Steps an agent carries out with tools |
| Example | [team-sql-conventions](../examples/skills/team-sql-conventions/SKILL.md) | [table-freshness-check](../examples/skills/table-freshness-check/SKILL.md) |
| How AutoDE uses it | Joins the context packs whose question it matches (a quarter of the pack's budget at most, two skills at most), so every agent working on that question sees it | Runs from *AutoDE: Run Tool Skill*, or joins a stage's assignment if it declares stage kinds |
| Review before publishing | Recommended | Required, if it has scripts or tools that write or run commands |

AutoDE decides the kind from what the skill declares: scripts, or tools that write or run commands, make it a procedure. A model can propose a different reading when you port it, and you decide.

## Writing one

```markdown
---
name: team-sql-conventions
description: The team's SQL and naming conventions for warehouse models. Read it before writing or reviewing SQL models.
license: MIT
metadata:
  stageKinds: [build, modelling] # optional: the stages whose assignments it joins
  platforms: [snowflake]       # optional: default any
  owner: data-platform-team    # optional
---

# Team SQL conventions
...
```

- **`name`**: lowercase words joined by dashes, the same as the folder's name.
- **`description`**: what it does and when to use it. Hosts decide when to use a skill from this sentence, and AutoDE matches knowledge skills to a pack's question by it, so name the things people ask about ("naming", "incremental loads", "freshness").
- **`allowed-tools`**: only for a procedure: the tools it needs, for example `Read, Bash(snow:*)`. AutoDE gives a skill only the tools it declares, and only where AutoDE runs it (see *The limit* below).
- **`license`**: say it, so your team knows whether they may share the skill.
- **`metadata.stageKinds`**: the stage kinds it helps with (`specify`, `source-assessment`, `mapping`, `modelling`, `build`, `deploy`, `reconcile`, `document` and the others in [workflow-templates.md](workflow-templates.md)). Published and reviewed, it then joins the assignment of every such stage, next to AutoDE's own skills. It adds instructions, never tools: the stage's permission tier still decides what the agent may do.

Write instructions as you would for a new colleague: what to do, in what order, what to check, what never to do. Keep secrets out: a skill is copied into the workspace and usually into Git.

## Porting one

From the Skills view, the **+** button (*AutoDE: Port a Skill…*) opens the wizard:

1. **Source.** A Git repository (https, with an optional branch or tag), a folder, or a dbt package. *Try AutoDE's examples* uses the two examples above. A Git repository is cloned into a temporary folder; its file list is checked first (at most 2,000 files and 30 MB, no paths that leave the repository, no links, no submodules), and nothing reaches your workspace before you import.
2. **Choose.** If the source has several skills, pick one.
3. **What it does.** The capability report: its kind, size and source; its licence; what it reads, which of its changes become decisions you approve, whether it writes files or runs scripts and commands; the CLIs and MCP servers it needs (AutoDE's install guide is named for the Snowflake and Databricks CLIs); overlaps with skills you have; anything that stops the import. With a model configured you can ask it for a proposal (kind, how its tools map to AutoDE's, prerequisites): accept it, accept it with the other kind, or reject it.
4. **Import.** The skill is copied into `.autode/config/skills/tool-skills/<name>/`, unreviewed (and a draft if *Tool Skill Management* is on). Then **Review** it (AutoDE's review screen; choose *reviewed* or *trusted*) and **Publish** it.

The same steps work in a terminal:

```bash
autode skills analyze https://github.com/org/skills.git --skill skills/conventions
autode skills import  https://github.com/org/skills.git --skill skills/conventions
autode skills review  conventions            # a person, in a terminal
autode skills publish conventions            # a person, in a terminal
autode skills update  conventions            # re-fetch, show the diff, apply after you confirm
```

And an agent in another host can analyse a source with `autode_skills_analyze` (an https URL or a workspace folder), but importing, reviewing and publishing stay with a person.

**Licences.** A skill whose licence doesn't allow copying it (for example the Databricks License on Databricks' own agent skills) is refused; use the vendor's skills where the vendor's host installs them (the Skills view lists them under *External skills*). An unrecognised licence is a warning: read it before sharing the skill.

## Updating

*Update Skill from Its Source* (the sync button on an imported skill, or `autode skills update <name>`) fetches the source again, shows what changed file by file, and applies it only when you confirm. The new content is **unreviewed**: it stops running, and leaves assignments and context packs, until someone reviews it again. Trust always belongs to the content that was read.

## The limit

AutoDE enforces a skill's tools where AutoDE runs it: VS Code and the CLI. In another host (Claude Code, Cortex Code, the Copilot CLI) the host's own tools run, and what protects AutoDE's state there is that every change goes through a decision a person approves. The capability report says so for every skill that writes or runs commands.
