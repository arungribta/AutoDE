# Workflow planning: coverage, composed workflows and clarification

**Status:** specified 2026-10-30 (owner). **PLN0 shipped in v0.56.0** (CHANGELOG.md 0.56.0): coverage items, the engine's starting coverage and checks, `coverage.yaml`, the plan step's coverage table, placing from the panel, `autode workflow coverage` and `autode_coverage` / `autode_place_coverage`; a workflow can't be approved while an item is open, and its approval records the coverage's. Built in two phases (roadmap): **PLN0** the deterministic coverage check, with UI2 (v0.56.0); **PLN1** the planner that composes a workflow from coverage, with a clarification round (v0.56.4). Requirement: ORC-12 in [requirements.md](../requirements.md). **Builds on:** [workflow-templates.md](workflow-templates.md) (stage kinds, templates, the plan gate), [ui-simplification.md](ui-simplification.md) (the journey view that shows it), the interview (mcp-engine §9.2 PA3) and the decisions (ORC-8).

## 1. Need

A workflow is drafted from one of three templates (greenfield, modernization, estate merge), picked by a keyword match over the specification. The planner can refine the draft, but nothing compares what the approved specification asks for with what the workflow will deliver:
- a scope item that no stage delivers drops out silently;
- an engagement that fits none of the templates (a migration with BI, a data product, a modernization that adds a semantic layer) gets the nearest template, or greenfield by default;
- work no stage kind fits (ML features, streaming operations) can't be planned at all;
- a question the plan depends on (which source feeds an item, what "near real time" means) is guessed or left for a later stage to discover.

The owner asked (2026-10-30) for a planner that recommends a workflow on the fly from AutoDE's approved skills and tools, based on coverage, with both the coverage and the workflow approved by a person before work starts, and a second interview round when the plan needs answers.

## 2. Intent

- **Coverage is the contract between the specification and the workflow.** Every in-scope item is delivered by named stages, done outside AutoDE by a person, or explicitly out of scope with a reason. Nothing drops silently.
- **The planner proposes; the engine checks; a person approves.** The model maps scope to stages and composes the workflow; deterministic rules check the result; nothing starts before a person approves the coverage and then the workflow.
- **Only what is approved.** The planner uses the stage kinds, templates, skills and tools AutoDE has (shipped or the team's approved ones). It never writes a skill or invents a stage kind. What can't be served is a **gap**, visible and counted.
- **Ask, don't guess.** Where coverage depends on an answer, the planner asks the person in a short clarification round, and records the answer.
- **The plan follows the work.** When a later stage finds something that changes coverage (a third source system, an item it can't deliver), the planner proposes a revision, approved the same way.

## 3. The design

### 3.1 Coverage

A **coverage** is a list of the approved specification's in-scope items, each with its status:

| Status | Meaning | Needs |
|---|---|---|
| `covered` | Delivered by the named stages of the workflow | one or more stage ids; each stage's brief names the item |
| `manual` | Done by a person outside AutoDE, tracked in the workflow | a `manual` stage (§3.3) |
| `out-of-scope` | Not delivered by this problem | a reason (a later problem, already exists, dropped by the stakeholder) |
| `gap` | Needed, but no approved skill or stage kind can deliver it | what is missing (a stage kind, a platform skill, a capability) |
| `question` | Can't be placed until the person answers | the question (§3.4) |

- **Items:** each `scope.in` entry and each objective of the specification, plus the specification's quality rules and constraints that a stage must act on (masking personal data, a freshness target). Each item keeps its source (the section and entry) so a specification change marks exactly the affected items stale.
- **Where it lives:** `coverage.yaml` in the problem's folder, beside the workflow: items, statuses, stage ids, reasons, and who proposed and approved it.
- **Deterministic checks (PLN0)**, run by the engine on every coverage, proposed or edited:
  - every in-scope item has exactly one entry, and every entry names an item of the current specification;
  - a `covered` item names stages that exist in the workflow; a `manual` item names a `manual` stage;
  - a `gap` or `out-of-scope` item has a reason;
  - every stage in the workflow covers at least one item, or is mandatory in its template (reconciliation, validation): a stage that delivers nothing is flagged;
  - every stage has at least one skill that serves its kind and the problem's platforms (from the skill registry); a stage with none is a gap.

  No `question` may be left when the coverage is approved.
- **PLN0 without the planner:** the engine proposes a starting coverage from the deterministic draft by matching items to stage kinds (a "load" item to the build stage, a "report" item to BI migration). It marks what it can't match as `question`, for the person or the planner to place. This is a starting point, not a judgement: it is labelled as the engine's.

### 3.2 Composed workflows

The planner composes the workflow from coverage, inside rules the engine enforces:
- **Start from a template.** The planner picks the closest template (the engine's suggestion is its first option) and adds, drops or reorders stages with a reason each, as today.
- **Combine templates.** It may add stages from another template (a modernization with the estate merge's entity resolution, or with BI migration). They keep their dependencies and gates, and they are marked with their template of origin.
- **No template.** Where none fits, the planner may build the workflow from stage kinds alone. The workflow is marked *composed*, the approver sees that, and every rule below still holds.
- **Rules that hold for every workflow:**
  - only known stage kinds; each stage's skills come from the registry (shipped, or the team's approved);
  - the template's mandatory stages stay (a modernization keeps reconciliation; a composed workflow that moves data between systems gets reconciliation and validation);
  - gates keep their order: specification, then plan, then the stages; a model's approval follows the mapping's; deployment follows validation;
  - everything consumed has a producer (today's check);
  - every `covered` item's stages are in the workflow, and every stage covers an item or is mandatory (§3.1).

### 3.3 The `manual` stage kind

A new stage kind for work a person does outside AutoDE: building an ML feature pipeline, configuring a streaming service, a stakeholder sign-off in another tool.
- It has a title, the coverage items it delivers, what it consumes and produces (named artifacts, possibly *external*), and an owner.
- AutoDE assigns no agent to it and runs nothing. The person marks it done with a note (and, optionally, files as evidence), on any surface.
- It keeps the workflow complete: its dependencies and the stale rules apply as for any stage.
- Every `manual` stage also counts toward the **gap list** for the team: work AutoDE could take on with a new skill (through the skill lifecycle, never on the fly).

### 3.4 The clarification round

When placing items needs answers, the planner opens a **second interview round** (the interview's own machinery: parts, questions, recorded answers, on every surface):
- **Only questions that block coverage:** an ambiguous item ("near real time": minutes or hours?), an unknown source for an item, a delivery choice the specification left open (a semantic layer or plain marts). Each question names the items it blocks.
- **Bounded:** at most about seven questions per round, most important first. "Assume and flag" is offered for each: the planner's assumption is recorded (ORC-11, exploration mode) and the item is marked as resting on it.
- **Where answers go:**
  - an answer that **clarifies** is recorded as a fact or an assumption on the item, and the planner places it;
  - an answer that **changes scope** (a new item, a dropped one) becomes a proposed **specification revision** through the existing flow. Coverage waits for the revision to be approved.
- A later round can follow only if an answer raised a new blocking question. Each round is listed in the journey's history.

### 3.5 Two approvals, in order

1. **Coverage** (what will be delivered): a decision of kind `coverage`, with the items by status, the gaps, the out-of-scope reasons and the assumptions. It can be approved only with no `question` left and the checks of §3.1 passing.
2. **Workflow** (how): the existing plan gate (`autode_propose_workflow`). It checks the workflow against the approved coverage.

They are shown on one review screen (UI2's plan step), coverage first. If an approved coverage changes (the specification was revised, or an item was moved), the workflow becomes **stale** and is re-approved. If only the workflow changes, coverage stays approved as long as its checks pass.

### 3.6 Re-planning while the work runs

A stage that finds something which changes coverage reports it, and the planner proposes a **revision** of the coverage and workflow:
- source assessment finds a source system the specification didn't name;
- a stage can't deliver an item it was given (no skill for the platform, a constraint it can't meet);
- a clarification answer arrives late.

The revision is approved like the first plan. Stages already done stay done unless their inputs changed (the existing stale and reopen rules). A revision never removes a completed stage's record.

### 3.7 Surfaces

The same engine functions behind every surface (surface parity):
- **MCP:** `autode_coverage` (read; the checks' result), `autode_propose_coverage`, `autode_planning_questions` (the open clarification round), with `autode_propose_workflow` and the interview tools as today.
- **CLI:** `autode coverage [show | check | propose <file>]`; `autode workflow propose`.
- **VS Code:** UI2's plan step: the coverage table (items by status, with their stages), the gap list, the questions, and the two approvals.
- **The planner** is the existing `planner` agent with the `autode-core-workflow-planning` skill, extended (v2) with coverage, composition and the clarification round. Its allowed tools add the coverage and interview tools; it can't write skills or files outside the problem.

### 3.8 What the model does and what the engine does

| Model (the planner) | Engine |
|---|---|
| Reads the specification's scope; proposes the item-to-stage mapping, statuses and reasons | Lists the items from the specification; checks the coverage (§3.1) |
| Chooses and combines templates, adds stages with reasons, writes briefs | Enforces the composition rules (§3.2) |
| Writes the clarification questions; proposes where answers go | Runs the round through the interview; routes a scope change to a specification revision |
| Proposes revisions when stages report | Marks stale; refuses a revision that breaks the rules |

## 4. Phases

- **PLN0 (v0.56.0, with UI2):** coverage as a file and a decision kind; the deterministic checks; the engine's starting coverage from the draft; the coverage table and gap list in the plan step; `autode_coverage`, `autode coverage show|check`. No planner changes: a person places the `question` items.
- **PLN1 (v0.56.4):** the planner composes from coverage (§3.2: combined templates, composed workflows); the `manual` stage kind; the clarification round; the two ordered approvals; re-planning from stage reports; `autode_propose_coverage`, `autode_planning_questions`; the planning skill v2; eval cases (below).

## 5. Acceptance

- **Nothing drops silently:** on the reference problem with one scope item no template stage delivers, the coverage lists it as `question` (PLN0) or `gap` or `manual` (PLN1), and the workflow can't be approved without it placed.
- **Checks, not prose:** a coverage naming a stage that isn't in the workflow, an item that isn't in the specification, or a `gap` without a reason is refused, with the item named.
- **Only approved skills:** a stage whose kind and platform no skill serves is reported as a gap; the planner never proposes a skill.
- **Rules hold in composed workflows:** a composed workflow that moves data without reconciliation is refused; combined-template stages keep their gates.
- **Clarification:** an ambiguous item produces a question naming it; the answer places the item; a scope-changing answer becomes a specification revision, and coverage waits for it.
- **Order and staleness:** the workflow can't be approved before its coverage; a specification revision marks the affected items and the workflow stale.
- **Every surface:** the CLI, MCP and the panel show the same coverage and checks (one test compares them).
- **Evaluated:** the eval set gains three reference problems with expected coverage: one per template, plus an unusual one (a modernization with BI migration and an ML feature handover). The planner's coverage is compared item by item.

## 6. Rejected

- **A planner that writes skills or stage kinds on the fly:** unreviewed capability (owner: approved skills and tools only). New skills go through the skill lifecycle; new kinds through a release.
- **Coverage as the planner's narrative:** not checkable; the engine must be able to refuse it.
- **One combined approval:** a coverage change would reset the workflow's approval silently. Two approvals, shown together, keep what changed visible.
- **Unbounded clarification:** planning turns into an open-ended conversation; the round is capped, with "assume and flag".

## 7. Open

- **The `manual` stage kind** (§3.3) is included as AutoDE recommended; the owner hasn't confirmed it yet.
- Whether quality rules and constraints are coverage items in PLN0 or only from PLN1.
