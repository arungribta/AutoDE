# UI2: one window, and the whole journey in view

**Status:** specified 2026-10-29 (owner); shipped in v0.56.0 (CHANGELOG.md 0.56.0; HOW: technical-design.md §7.8). **Deviations:** **One window:** the three views are editor tabs titled *AutoDE · …* in one group, each with the same tab bar linking the others (the Platform catalog opens the interim *AutoDE: Platform Operations* until POP4), not one webview hosting all three: merging the Explorer's and the Workflow view's separate apps into one page was left for when POP4 adds the catalog's own view. **The palette:** where you are and the one next action at the top; its other sections (decisions, problems, specification, context, artifacts, primitives) are folded under *More*, one click away, rather than removed, since several hold working features. **Coverage approval (PLN0):** approving the workflow records the coverage's approval with it (one action, coverage shown first); the separate, ordered coverage decision comes with the planner (PLN1). Coverage items are the specification's in-scope items and objectives; quality rules and constraints join in PLN1. **Several sources:** source connections are pooled; a target stays one live connection. **Journey actions for the interview and drafting** open the chat (where they happen today) rather than a new form. Before POP4 so the Platform catalog is built into the new window. Requirement: UI-8 in [requirements.md](../requirements.md). **Agreed design:** the clickable mock-up on the design canvas (owner's private artifact, *Workflow journey mock-up*, https://claude.ai/artifact/4FzrLXkrZE7bQNVJhoGsj2), approved by the owner on 2026-10-29. The owner plans more simplification in this round; further parts are added here as they are agreed.

## 1. Need

Testing AutoDE (owner, 2026-10-28 and 2026-10-29) showed three problems.

- **The early journey is invisible.** A new problem goes through the same path every time: the statement, the interview, discovery (sources into the estate, facts reviewed, the glossary, the semantic layer), the specification and its approval, and the choice of a workflow template. The Workflow view draws all of it as the template's first two stages, *specify* and *plan*. Nobody can see where they are, what is done, or what comes next.
- **What comes after is invisible until it is chosen.** The template's delivery stages appear only once the plan is approved. Their order and number aren't known when the template is chosen.
- **The Workflow Palette is crowded.** It tries to show this journey in too little space, mixed with everything else, and it confuses.

The Knowledge Explorer, the Workflow view and (from POP4) the Platform catalog are separate panels, hard to find and to move between.

## 2. Intent

- **One journey, always in view.** Every problem shows the same phases, ① Problem, ② Discovery, ③ Specification, ④ Workflow plan, then ⑤ Delivery, the chosen template's stages. You can always tell where you are, what is done, what waits for you, and what comes next.
- **One next step.** Every phase and step says who acts (you, AutoDE, or a named agent) and offers one action. The palette shrinks to the problem, where you are and that one action.
- **No second model.** Phases ① to ④ are the existing *specify* and *plan* stages, opened up into steps. The steps are computed from the state AutoDE already keeps, never stored again.
- **One window.** The Knowledge Explorer, the Workflow view and the Platform catalog are tabs of one AutoDE window, each its own view.
- **The same answer everywhere.** The panel, the Workflow tab, `autode workflow status` and `autode_workflow_status` show the same phases and steps.

## 3. The design

The mock-up's two artboards are the reference. What follows describes them.

### 3.1 The Workflow tab

From top to bottom:

1. **The window's tabs:** Knowledge Explorer, Workflow, Platform catalog.
2. **The problem:** its statement as the title, its mode (governed or exploration), and what the workspace holds (systems, tables, facts).
3. **You are here:** one line, the phase (*Phase 2 of 5 · Discovery*), the next step in words (*answer 3 interview questions on transformations*) and its button.
4. **The rail:** five phases, each with its status (✓ done, ● now, ◆ waiting for you, ○ not started) and a short summary (*4 of 7 interview parts · 12 facts to review*). Clicking a phase shows its steps; the current phase is selected by default.
5. **The phase's steps.** Each step has:
   - a status;
   - **who acts:** *You*, *AutoDE*, or the agent's role (*Knowledge engineer*, *Semantic modeler*, *Business analyst*);
   - one line on where it stands, with counts;
   - **one action:** *Answer 3 questions*, *Review 12 facts*, *Run it*, *Draft a model*, *Approve*. The current step's action is the primary button;
   - for a step that informs but doesn't block, the mark *checkpoint, not a gate*.
6. **About this step**, beside the steps:
   - **why it is here** (what it is for, or which template rule added it);
   - **what it is waiting on**;
   - its **parts** where it has some (the interview's parts, each with its status);
   - its **history**, from the event log: what happened, when, through which channel.
7. **⑤ Delivery · preview:**
   - the suggested template's stages, **greyed until the plan is approved**, numbered after *specify* and *plan*;
   - a switch between the templates (*greenfield · suggested*, *modernization*, *estate merge*), each with the reason it fits or doesn't, from its `suggestWhen` rules and the statement;
   - a stage repeated per source system drawn with **one lane per system** (shop, crm);
   - optional and conditional stages **dashed**.

   After approval the preview becomes the real stages, with their agents, inputs and gates, as the Workflow view shows them today.

### 3.2 The phases and their steps

| Phase | Steps | From | Done when |
|---|---|---|---|
| ① Problem | statement written · statement confirmed | the specification's draft and `problemStatementApproved` | you confirm the statement |
| ② Discovery | **sources in the estate** (per system, with table counts) · **interview** (its parts: requirements, sources, data flow, transformations, quality, constraints, governance when personal data is involved) · **facts to review** (proposed and needs-review, from the ledger) · **glossary** (terms, and those that fit no category) · **semantic layer** (models over the problem's tables) | the estate and catalog; the interview state; the ledger; the glossary; the semantic layer; capture coverage (v0.48) | the specification's inputs are covered. The glossary and semantic layer are **checkpoints, not gates**: shown and explained, never blocking on their own |
| ③ Specification | drafted · revised · approved | the specification document and its history | you approve it |
| ④ Workflow plan | template suggested (with its reason) · alternatives · plan approved | the template catalogue, `suggestFor`, the workflow proposal and decision | you approve the plan |
| ⑤ Delivery | the template's stages | the workflow instance | each stage at its gate, as today |

A step's **who** comes from what it needs: a person's answer or approval is *You*; AutoDE's own work (bringing in metadata, computing coverage) is *AutoDE*; an agent's work names its role. Its **one action** is the command that moves it forward; there is no action when nothing is needed.

### 3.3 The palette: where am I

The Workflow Palette keeps only:
- the problem's short title, with **＋ New** and **⇄ Switch**;
- a five-segment bar for the phases;
- the phase (*② Discovery · phase 2 of 5*) and the next step in words;
- that step's **one action**;
- what waits for you (*12 facts wait for you*);
- *Open the workflow*.

Everything else moves to the Workflow tab or stays one click away.

### 3.4 One source of truth

A new engine function, `journeyFor(scope)` (`src/engine/workflows/journey.ts`):
- computes the phases and steps from existing state: the specification, the interview, the estate and catalog, the ledger, the glossary, the semantic layer, capture coverage, the template catalogue and suggestion, the workflow instance, decisions and the event log;
- stores nothing;
- gives each step its status, who acts, its line, its action (a command id with arguments), why it is here, what it waits on, its parts and its history.

The Workflow tab, the palette, the chat's front door, `autode workflow status` (phases first, then the stages) and `autode_workflow_status` (a `journey` field) all render it.

### 3.5 One window

The Knowledge Explorer, the Workflow view and (from POP4) the Platform catalog become tabs of one AutoDE webview panel. Each keeps its own view and state when hidden. They are reachable from the panel's header, the commands they have today, and each other's links (an asset in a step opens in the Explorer tab).

### 3.6 Several sources at once (owner, 2026-10-30)

The estate already holds several source systems beside a target (STC-10), `connections.yaml` any number of connections, and the CLI and MCP connect them at once by id. The panel still holds one live source and one live target. UI2 brings it level:
- a **connection pool** keyed by connection id in the extension, the way the MCP server holds them, in place of the one source and one target manager;
- a **Sources** list in the settings: every source connection with its platform, system, environment and state (connected, needs a test, failed), each connected and tested on its own; the target the same, one or more;
- **discovery per source or across all:** the journey's discovery steps show each source system's progress (tables read, facts waiting), and a stage that reads the estate names which connection it uses;
- commands that act on "the" source (Refresh Observed Lineage, Browse, Disconnect) ask which one when there are several.

### 3.7 Coverage in the plan step (PLN0; owner, 2026-10-30)

The plan step shows the **coverage** of the approved specification ([workflow-planning.md](workflow-planning.md) §3.1, §4): each in-scope item with the stages that deliver it, or out of scope with a reason, or a gap, or a question still to place; the engine's checks; and the coverage approval before the workflow's. The person places the open items (the planner does it from PLN1, v0.56.5).

## 4. Acceptance

- **The journey from day one:** a new problem with only a statement shows the five phases, ① *now*, and the suggested template's stages as a preview.
- **Where you are:** on the reference problem, mid-interview, the rail shows ① done and ② now. The *You are here* line names the interview part and its open question count, and its button opens that part.
- **Steps from state:** each discovery step's line matches the state it reads (tables per system, facts waiting, terms without a category, models over the problem's tables), checked on the reference and the realistic estate. The glossary and semantic layer never block approval.
- **Preview:** switching the template redraws the delivery preview from the template files, with lanes per source system and optional stages dashed. After approval the stages are real.
- **History:** a step's history lists its events, with time and channel.
- **One source:** the Workflow tab, the palette, `autode workflow status` and `autode_workflow_status` give the same phases and steps (one test compares them).
- **One window:** the three views are tabs of one panel, each keeping its state when hidden.
- **Coverage:** on the reference problem the plan step lists every in-scope item with its stages; an item no stage delivers is an open question, and the workflow can't be approved until it is placed and the coverage approved.
- **Several sources:** with a Snowflake and a Redshift source connected at once, both show as connected, discovery reads each into its own system, and a command acting on a source asks which.
- **Usable:** keyboard and screen reader (UI-4); VS Code's themes; the step list and the preview wrap at narrow widths; empty states say what to do next.

## 5. Open

- The other parts of the second simplification round the owner has in mind (§1's crowding beyond the palette): added here as they are agreed.
