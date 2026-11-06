---
name: autode-core-platform-onboarding
description: Onboard a new system to AutoDE (a warehouse, catalog, BI tool or anything with a SQL, CLI, API or file interface) from the onboarding template - answers checked, proposed as one bundle for a person to approve, tried through a conformance run on a real connection, then reviewed by a person. Use it when a user wants AutoDE to work with a system it doesn't know.
allowed-tools: [Read, mcp__autode__autode_platform_template, mcp__autode__autode_platform_onboard, mcp__autode__autode_platform_onboarding_status, mcp__autode__autode_propose_conformance_review, mcp__autode__autode_platform_operations, mcp__autode__autode_platform_catalog, mcp__autode__autode_platform_run, mcp__autode__autode_platform_conformance, mcp__autode__autode_list_connections]
metadata:
  scope: core
  stageKinds: []
  platforms: [any]
  version: 1
  owner: AutoDE
  maturity: tested
---
# Onboarding a system

A system is added with files, not code: a definition, its operations and implementations, and skills. You fill in the answers; AutoDE checks them and writes the files only when they are ready. A person approves, always.

## 1. Start from the template

1. `autode_platform_template` with no arguments lists the categories. Pick the one closest to the system, then call it again with `category` and the `id` you want.
2. If a similar platform already exists, call it with `like` (for example a warehouse near one AutoDE has) and change what differs. The id and title are replaced so it is not mistaken for the original.
3. Prefer the API or CLI the user already has and signs in to. Ask which they use before choosing a transport.

## 2. Fill in the answers

- Every implementation needs a **recorded example**: the parameters it ran with and a row the system returned from a real read-only run (`autode_platform_run`, or the user's own CLI or API call). Never write one you only expect to work.
- Refer to existing operations by id (`autode_platform_operations` shows them); add a new operation only when none fits.
- **Never put a credential in a file.** Connection fields marked secret are supplied when connecting.
- Write the setup skill: how to install, sign in without a prompt, and what to do when it fails.

## 3. Check, then propose

1. `autode_platform_onboard` with `action: check` lists each step, what is missing and the files it would write. Fix and check again until it says ready. Nothing is written by a check.
2. Some things need AutoDE's code: a new transport, a new sign-in method, a new compile dialect. The check says so as `neededCode`. **Stop and tell the user plainly**; do not work around it. Leave compile targets out to onboard the system as a source only.
3. `action: propose` writes the files and one decision. **A person approves it** (`autode decisions approve <id>`). You cannot, so say it waits for them.

## 4. Conformance, then review

1. `autode_platform_onboarding_status` says where the system is and the next step. If its CLI is missing, it shows the install command and the setup skill's steps; give them to the user.
2. Once approved the system is on trial: only conformance runs read from it. With a connection, run `autode_platform_conformance`.
3. `autode_propose_conformance_review` files the run for review. **A person reviews and approves it**; then the system counts and stages can use it.

If a run shows an operation failing, fix that implementation and propose it again; do not edit around the check.

## 5. Sharing a system as a pack

A pack is a folder of a team's approved platform files and published skills, so another workspace can have the same system without redoing the onboarding.

- **Export only what is approved.** `autode_platform_pack_export` refuses drafts, systems still on trial, recorded examples that hold rows of data and anything that looks like a credential; fix what it lists, have a person approve again, then export. Do not work around a refusal.
- **Stay inside the workspace.** As an agent you read and write packs only in folders inside the workspace; a folder outside it is refused. If the user's pack is elsewhere, ask them to copy it into the workspace.
- **Check before importing.** `autode_platform_pack_inspect` shows what the pack adds, replaces and overrides of what AutoDE ships, and every problem. `reviewed` is the exporter's word about a conformance review, not a fact here: say so.
- **A person approves the import.** `autode_platform_pack_import` writes the files as drafts and files one decision; you cannot approve it. Its skills arrive as unreviewed drafts that a person reviews and publishes. Use `replace` only when the user asked to replace approved files or skills here.
