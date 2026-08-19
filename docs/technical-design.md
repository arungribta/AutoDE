# AutoDE — Technical Design Document

**Last Updated:** 2026-08-18T23:40:00-05:00
**Version:** 0.2.0
**Status:** Phase 0-2 Complete, Phase 3a In Progress

---

## Table of Contents

1. [Overview & Architecture Philosophy](#1-overview--architecture-philosophy)
2. [UI Architecture](#2-ui-architecture)
3. [Context Layer](#3-context-layer)
4. [Multi-Platform Adapter Architecture](#4-multi-platform-adapter-architecture)
5. [Agent Orchestration](#5-agent-orchestration)
6. [LLM Integration](#6-llm-integration)
7. [Extension Architecture](#7-extension-architecture)
8. [File Structure](#8-file-structure)
9. [Implementation Phases](#9-implementation-phases)
10. [Design Decisions & Tradeoffs](#10-design-decisions--tradeoffs)

---

## 1. Overview & Architecture Philosophy

### 1.1 What is AutoDE?

AutoDE is an AI-augmented VS Code extension for Data Engineering. It provides:

- A **conversation-first workspace** for planning, executing, and refining data engineering pipelines
- A **production-grade context layer** (knowledge graph + vector search + token-aware retrieval) that grounds LLM prompts in actual database schemas and business context
- **Multi-platform adapter architecture** that abstracts away platform-specific metadata extraction, SQL dialects, and capabilities
- **Agent orchestration** with an orchestrating/planning agent that decomposes objectives into DAG-based execution plans and routes to specialized sub-agents

### 1.2 Core Design Principles

| Principle | Rationale |
|-----------|-----------|
| **Conversation-first** | The chat is the central nervous system. Everything else (context, settings, connection status) is surfaced within or adjacent to the conversation, not siloed in separate tabs. |
| **Platform-agnostic agents** | Sub-agents ask "what" (extract metadata, run query, generate DDL). Adapters know "how" (which system tables to query, which SQL dialect to use). |
| **Progressive disclosure** | Show essential status at a glance (top bar), reveal detail on demand (expandable panels, slide-outs). |
| **Context visibility** | The semantic layer (database schemas, business terms, verified queries) must be visible and interactive — users should see what context is being fed into each prompt. |
| **Atomic operations** | All writes to `.ai-context/` use temporary staging + atomic rename to prevent corruption. |
| **Zero UI blocking** | Heavy compute (embedding, graph traversal, large file parsing) runs off the Extension Host main thread. |

### 1.3 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     VS Code Extension Host                    │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ extension.ts │  │ agentHub.ts  │  │ webviewProvider.ts │  │
│  │ (activate)   │  │ (orchestrator│  │ (message bridge)   │  │
│  └──────┬───────┘  │ + LLM calls) │  └────────┬───────────┘  │
│         │          └──────┬───────┘           │              │
│         │                 │                   │              │
│  ┌──────┴─────────────────┴───────────────────┴──────────┐  │
│  │                  Core Services                         │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐  │  │
│  │  │ ConfigManager│ │CopilotAdapter│ │ProviderRegistry│  │  │
│  │  └──────────────┘ └──────────────┘ └───────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  Context Layer                         │  │
│  │  ┌──────────────┐ ┌──────────────────┐                │  │
│  │  │ GraphManager │ │ContextFileManager│                │  │
│  │  └──────────────┘ └──────────────────┘                │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │            Multi-Platform Adapter Layer                │  │
│  │  ┌────────────────┐ ┌───────────────────────────────┐ │  │
│  │  │ConnectionManager│ │BaseDataSourceAdapter (abstract)│ │  │
│  │  └────────────────┘ └───────────┬───────────────────┘ │  │
│  │                     ┌───────────┼───────────┐         │  │
│  │                     ▼           ▼           ▼         │  │
│  │              ┌──────────┐ ┌──────────┐ ┌──────────┐  │  │
│  │              │Snowflake │ │Databricks│ │ BigQuery │  │  │
│  │              │ Adapter  │ │ Adapter  │ │ Adapter  │  │  │
│  │              └──────────┘ └──────────┘ └──────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  Sub-Agents                            │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │  │
│  │  │ Discover │ │  Model   │ │  Build   │ │ Validate │ │  │
│  │  │  Agents  │ │  Agents  │ │  Agents  │ │  Agents  │ │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                     Webview (sidebar.html)                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Top Status Bar [Provider] [Connection] [Context] [Plan]│  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Chat Stream (messages, plan cards, context previews)   │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Context Drawer (collapsible)                           │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │ Chat Input + Action Bar                                │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Slide-Out Panels: Settings / Workflow Palette          │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. UI Architecture

### 2.1 Layout: Single-Column, Section-Based

The UI uses a single scrollable workspace with distinct sections. A thin, icon-based top bar provides quick navigation and status at a glance.

```
┌─────────────────────────────────┐
│ TOP STATUS BAR                  │  ← Provider, model, token usage, context stats
├─────────────────────────────────┤
│                                 │
│  CHAT / CONVERSATION STREAM     │  ← Primary interaction area
│  (scrollable)                   │
│    - User messages              │
│    - AI responses               │
│    - Embedded plan artifacts    │
│    - Execution progress cards   │
│    - Context assembly previews  │
│                                 │
├─────────────────────────────────┤
│  CONTEXT ASSEMBLY DRAWER        │  ← Collapsible: shows what context
│  (expandable)                   │     will be sent with next prompt
├─────────────────────────────────┤
│  CHAT INPUT + ACTION BAR        │  ← Message input, Send, Plan, Execute
└─────────────────────────────────┘
```

### 2.2 Top Status Bar

| Element | ID | Description |
|---------|-----|-------------|
| **Provider pill** | `providerPill` | Shows active LLM (e.g., "Copilot" with green dot). Clicking opens LLM settings. |
| **Connection pill** | `connPill` | Shows data platform connection status. Clicking opens connection settings. |
| **Context meter** | `ctxMetric` | Token/entity counter with mini progress bar. Clicking expands context drawer. |
| **Plan status** | `planMetric` | Shows plan step count and execution status. |
| **Refresh button** | `refreshBtn` | Triggers context re-index. |
| **Stop button** | `stopBtn` | Stops plan execution. |
| **Settings button** | `settingsBtn` | Opens slide-out settings panel. |
| **Workflow palette** | `paletteBtn` | (Phase 3a) Opens workflow palette. |

### 2.3 Chat Stream

The chat stream is the primary interaction surface. Every interaction — planning, execution, context queries — flows through this stream.

#### Message Types

| Type | CSS Class | Alignment | Description |
|------|-----------|-----------|-------------|
| User message | `.message.user` | Right | User's objective or follow-up. Accent-tinted background. |
| AI text response | `.message.ai` | Left | Markdown-rendered response with syntax-highlighted code blocks. |
| Plan artifact | `.plan-card` | Full-width | Interactive card with collapsible steps, timeline, and action buttons. |
| Context preview | `.ctx-preview` | Full-width | Collapsible block showing what context was used for a response. |
| Log entry | `.message.ai` (dimmed) | Left | System log messages at reduced opacity. |

#### Plan Card Structure

```
┌──────────────────────────────────────────────┐
│ 📋 EXECUTION PLAN                    [▼] [×] │
│                                              │
│ ○────●────◐────○  (execution timeline)       │
│                                              │
│ Step 1  ✅  Extract raw events from S3       │
│   Agent: ingestionAgent    Duration: 2.3s    │
│   └─ (expandable detail)                     │
│                                              │
│ Step 2  ⏳  Validate schema & null checks     │
│   Agent: sttmAgent         Depends on: Step 1│
│                                              │
│ [▶ Execute All]  [⏸ Pause]  [↻ Re-plan]     │
└──────────────────────────────────────────────┘
```

### 2.4 Context Drawer

A persistent, collapsible panel between the chat stream and input area:

- **Collapsed state**: 32px header showing summary stats
- **Expanded state**: Up to 260px showing entity chips organized by category
- **Categories**: Database Metadata, Business Context, Verified Queries
- **Chips**: Clickable pill-shaped elements that insert `@entityname` into the chat input
- **Actions**: Re-index button, Open .ai-context folder button

### 2.5 Slide-Out Settings Panel

Accessible via the ⚙ icon. Slides in from the right with a semi-transparent overlay.

**Inner tabs:**
- 🤖 **LLM Provider**: Card-based selection (Copilot, OpenAI, Anthropic, Azure OpenAI, Gemini, Ollama). Copilot card includes consent toggle (auto-saves) and Test/Handoff buttons.
- 🔌 **Connections**: Platform cards (Snowflake, Databricks, BigQuery, Redshift, Synapse) with credential fields, Connect button, and Source Assessment button.
- ⚙ **Preferences**: Read-only mode, auto-documentation, telemetry, cache duration, query timeout.

### 2.6 Workflow Palette (Phase 3a)

Accessible via a 🧰 icon. Phase-organized action cards:

| Phase | Agents |
|-------|--------|
| 🔍 **Discover** | Source Assessment, Data Lineage, Quality Profiler, Current-State Architecture |
| 🎨 **Model** | STTM Mapper, Data Modeler, Business Glossary |
| 🔨 **Build** | Ingestion Pipeline, Transform Scaffold, DDL Generator, Orchestration |
| ✅ **Validate & Document** | SQL Validator, Test Generator, Documentation, Future-State Architecture |

Each card shows: icon, name, description, `[▶ Run]` button. Cards are disabled if prerequisites aren't met.

### 2.7 @-Mention System

Typing `@` in the chat input triggers an autocomplete dropdown populated from the context layer:

- `@orders` → resolves to `RAW_DB.PUBLIC.ORDERS`
- `@MRR` → resolves to the business term definition
- `@daily_active_users` → inserts the reference SQL

### 2.8 Slash Commands

| Command | Action |
|---------|--------|
| `/plan` | Generate execution plan |
| `/execute` | Execute current plan |
| `/context` | Expand context drawer |
| `/connect` | Open connection settings |
| `/settings` | Open settings panel |
| `/sync` | Sync database metadata |
| `/reindex` | Rebuild context index |
| `/clear` | Reset session |
| `/export` | Export plan (future) |

### 2.9 CSS Design System

All colors use VS Code theme CSS variables for native look and feel:

| Token | Usage |
|-------|-------|
| `--vscode-editor-background` | Main background |
| `--vscode-sideBar-background` | Cards, input areas, panels |
| `--vscode-panel-border` | Subtle separators |
| `--vscode-button-background` | Primary actions, accent elements |
| `--vscode-foreground` | Primary text |
| `--vscode-descriptionForeground` | Secondary text, labels |

**Semantic colors:**
- Success: `#2ea043` (green) — connected, completed, passed
- Warning: `#d29922` (amber) — pending, degraded, needs attention
- Error: `#f85149` (red) — failed, disconnected, error
- Info: `#58a6ff` (blue) — informational, links

**Spacing scale:** 4px base unit → 4, 8, 12, 16, 20px
**Border radius:** 4px (small), 6px (standard), 8px (cards), 999px (pills/chips)
**Font sizes:** 11px (captions), 12px (body), 13px (headings), 14px (icons)
**Transitions:** 120ms (fast), 200ms (normal), 300ms (slow)

---

## 3. Context Layer

### 3.1 Knowledge Graph (GraphManager)

**File:** `src/context/GraphManager.ts`

Thread-safe in-memory graph using maps and indexes:

| Feature | Implementation |
|---------|---------------|
| Node storage | `Map<string, BaseNode>` |
| Edge storage | `Map<string, GraphEdge>` |
| FQN index | `Map<string, string>` (fqn → nodeId) |
| Label index | `Map<string, Set<string>>` (label → nodeIds) |
| Type index | `Map<string, Set<string>>` (type → nodeIds) |
| Concurrency | Simple mutex (`Promise` chain) |
| Serialization | `serializeSnapshot()` / `loadSnapshot()` for worker transfer |
| Traversal | BFS with decay factor: `Relevance = SeedScore × (DecayFactor)^(HopDistance)` |
| Lifecycle | Implements `vscode.Disposable` |

#### Node Types

| Type | Interface | Description |
|------|-----------|-------------|
| `table` | `TableNode` | Database table with FQN, database, schema |
| `column` | `ColumnNode` | Table column with data type, nullability, PK/FK flags |
| `semantic_view` | `TableNode` (isView=true) | Database view |
| `business_term` | `BusinessTermNode` | Business glossary term with optional formula |
| `business_rule` | `BusinessRuleNode` | Rule with STRICT/RECOMMENDED enforcement |
| `verified_query` | `VerifiedQueryNode` | Reference SQL with dialect and table references |

#### Edge Types

| Type | Description |
|------|-------------|
| `contains` | Table → Column |
| `foreign_key` | Table → Table |
| `maps_to` | Business Term → Table |
| `uses_table` | Verified Query → Table |
| `constrained_by` | Business Rule → Table |

### 3.2 ContextFileManager

**File:** `src/context/ContextFileManager.ts`

Manages the `.ai-context/` directory:

| Feature | Implementation |
|---------|---------------|
| File watching | `vscode.workspace.createFileSystemWatcher` with 300ms debounce |
| YAML parsing | Custom lightweight parser (no external dependency) |
| Business context | Parses `business-context.yaml` → BusinessTermNode + BusinessRuleNode |
| Verified queries | Parses `verified-queries.yaml` → VerifiedQueryNode |
| Schema graph | Loads `schema-graph.json` snapshots |
| Mentionable entities | `getMentionableEntities()` returns all tables, terms, queries for @-mention |
| Context stats | `getContextStats()` returns counts + token estimates |
| Prompt assembly | `buildContextPrompt()` formats Markdown context block for LLM prompts |
| Lifecycle | Implements `vscode.Disposable` |

#### .ai-context/ Directory Layout

```
.ai-context/
├── schema-graph.json          # Generated: serialized knowledge graph
├── schema-graph.schema.json   # JSON Schema for validation
├── business-context.yaml      # Human-curated: business terms + rules
├── verified-queries.yaml      # Human-curated: reference SQL queries
├── sttm-mapping.yaml          # Generated: source-to-target mappings
└── architecture.md            # Generated: architecture documentation
```

### 3.3 Context Retrieval & Prompt Assembly

The `buildContextPrompt()` method formats context as compact Markdown:

```
## Enterprise Context Layer

### Business Rules (STRICT)
- **Rule name**: Rule text

### Database Tables
- `DB.SCHEMA.TABLE` — Description

### Business Terms
- **Term Name** (formula: ...): Description

### Verified SQL Queries
- **Query Name** (dialect)
```

Token budget enforcement and pruning will be implemented in a future `ContextRetriever` module.

---

## 4. Multi-Platform Adapter Architecture

### 4.1 Design Rationale

Different data platforms have fundamentally different:
- **Metadata tables**: Snowflake's `INFORMATION_SCHEMA` vs Databricks' `system.information_schema` vs BigQuery's region-qualified `INFORMATION_SCHEMA`
- **SQL dialects**: Snowflake SQL vs Spark SQL vs GoogleSQL vs T-SQL
- **Authentication**: Key-pair, OAuth, tokens, service accounts, external browser
- **Capabilities**: Column profiling, lineage extraction, CDC, streaming

The adapter pattern isolates these differences behind a common interface, so sub-agents never need platform-specific code.

### 4.2 IDataSourceAdapter Interface

```typescript
interface IDataSourceAdapter {
  connect(credentials: Record<string, string>): Promise<ConnectionInfo>;
  disconnect(): Promise<void>;
  extractMetadata(options?: ExtractOptions): Promise<SchemaSnapshot>;
  executeQuery(sql: string, options?: QueryOptions): Promise<QueryResult>;
  getCapabilities(): PlatformCapabilities;
  translateDialect(sql: string, target: SqlDialect): string;
  getMetadataQueries(): PlatformMetadataQueries;
  persistSchemaContext(snapshot: SchemaSnapshot, uri: vscode.Uri): Promise<void>;
}
```

### 4.3 BaseDataSourceAdapter (Abstract Class)

**File:** `src/dqm/BaseAdapter.ts`

Provides:
- Common `extractMetadata()` orchestration (tables → columns → FKs → profiling)
- `snapshotToGraph()` conversion (SchemaSnapshot → knowledge graph nodes/edges)
- Atomic `persistSchemaContext()` (temp file → rename)
- Abstract methods that each platform adapter must implement

### 4.4 Platform-Specific Adapters

#### SnowflakeAdapter (`src/dqm/adapters/SnowflakeAdapter.ts`)

| Aspect | Detail |
|--------|--------|
| Metadata | `INFORMATION_SCHEMA.TABLES`, `.COLUMNS`, `.REFERENTIAL_CONSTRAINTS`, `.VIEWS` |
| Lineage | `SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY` (optional) |
| Profiling | Per-column `COUNT(DISTINCT)`, null count, `MIN`, `MAX` |
| Auth | Key-pair, OAuth, username/password, external browser, MCP |
| Capabilities | metadata ✓, profiling ✓, lineage ✓, CDC ✓, streaming ✓, DDL ✓ |
| Dialect | Snowflake SQL (native) |

#### DatabricksAdapter (`src/dqm/adapters/DatabricksAdapter.ts`)

| Aspect | Detail |
|--------|--------|
| Metadata | `system.information_schema.tables`, `.columns`, `.key_column_usage` |
| Profiling | `COUNT(DISTINCT)`, null count, `MIN`, `MAX` via Spark SQL |
| Auth | OAuth, personal access token |
| Capabilities | metadata ✓, profiling ✓, lineage ✗, CDC ✓ (Delta CDF), streaming ✓ |
| Dialect | Spark SQL — translates `UUID_STRING()` → `uuid()`, `ILIKE` → `lower() LIKE lower()` |

#### Future Adapters

| Adapter | Metadata Source | Key Differences |
|---------|----------------|-----------------|
| BigQuery | `region-us.INFORMATION_SCHEMA` | Region-qualified, different column types |
| Redshift | `PG_CATALOG` + `SVV_*` tables | PostgreSQL-based, different system tables |
| Synapse | `sys.tables`, `sys.columns` | T-SQL dialect, dedicated SQL pool vs serverless |

### 4.5 ConnectionManager

**File:** `src/dqm/ConnectionManager.ts`

| Method | Description |
|--------|-------------|
| `connect(platform, credentials)` | Disconnect existing, instantiate correct adapter, connect |
| `getActiveAdapter()` | Return current adapter or null |
| `extractMetadata(options?)` | Delegate to active adapter |
| `executeQuery(sql)` | Delegate to active adapter |
| `getCapabilities()` | Return active adapter's capabilities |
| `dispose()` | Disconnect and clean up |

Uses a `Map<DataPlatformProvider, AdapterFactory>` for adapter registration.

### 4.6 Type Definitions

**File:** `src/dqm/types.ts`

| Type | Purpose |
|------|---------|
| `PlatformCapabilities` | Boolean flags for metadata, profiling, lineage, CDC, streaming, DDL |
| `SqlDialect` | `'snowflake' \| 'spark_sql' \| 'google_sql' \| 'postgres' \| 'tsql' \| 'ansi'` |
| `ConnectionInfo` | Status, platform, database, schema, version, capabilities |
| `SchemaSnapshot` | Tables, views, columns, foreign keys, lineage edges |
| `TableMetadata` | FQN, type, row count, size, columns, comment |
| `ColumnMetadata` | Name, data type, nullability, PK/FK, ordinal, profile |
| `ColumnProfile` | Distinct count, null count, min/max, avg length |
| `ForeignKeyMetadata` | Source table/column → target table/column |
| `LineageEdge` | Column-level lineage with transform description |
| `PlatformMetadataQueries` | SQL query templates for metadata extraction |
| `QueryResult` | Columns, rows, row count, execution time |

---

## 5. Agent Orchestration

### 5.1 Orchestrating Agent (DataAgentHubHub)

**File:** `src/core/agentHub.ts`

The orchestrating agent is the central coordinator:

| Responsibility | Implementation |
|----------------|---------------|
| Intent understanding | LLM call with system prompt + context |
| Task decomposition | `buildPlanPrompt()` → LLM → `validatePlanResponse()` |
| Sub-agent routing | `AGENT_EXECUTORS` map: `AgentType → executor function` |
| Dependency resolution | DAG-based execution with `dependsOn` arrays |
| State management | `PlanState` with steps, status, runningStepId |
| Failure recovery | `handleFailure()` with re-plan option |
| Context injection | Passes schema context to LLM prompts |

### 5.2 Sub-Agent Catalog

#### Phase: Discover (Source-Side)

| Agent | Type Key | Description | Status |
|-------|----------|-------------|--------|
| Source Assessment | `sourceAssessmentAgent` | Extract schema metadata, profile columns, build knowledge graph | Phase 3a |
| Data Lineage Mapper | `lineageMapperAgent` | Trace column-level lineage across views/ETL | Future |
| Data Quality Profiler | `qualityProfilerAgent` | Run configurable quality checks | Future |
| Current-State Architect | `currentStateArchitectAgent` | Generate as-is architecture diagram | Future |

#### Phase: Model (Design)

| Agent | Type Key | Description | Status |
|-------|----------|-------------|--------|
| STTM Mapper | `sttmAgent` | Source-to-target mapping with column-level transformations | Enhanced in 3a |
| Data Modeler | `dataModelerAgent` | Dimensional/Data Vault/OBT model generation | Future |
| Business Glossary Builder | `glossaryBuilderAgent` | Extract/update business terms | Future |

#### Phase: Build (Target-Side)

| Agent | Type Key | Description | Status |
|-------|----------|-------------|--------|
| Ingestion Pipeline | `ingestionAgent` | Generate ingestion code (COPY, Python, Airbyte) | Enhanced in 3a |
| Transformation Scaffolder | `transformScaffoldAgent` | dbt project scaffolding | Future |
| DDL Generator | `ddlGeneratorAgent` | CREATE/ALTER statements | Future |
| Orchestration Generator | `orchestrationAgent` | Airflow/Dagster/Prefect DAGs | Future |

#### Phase: Validate & Document

| Agent | Type Key | Description | Status |
|-------|----------|-------------|--------|
| SQL Validator | `sqlValidatorAgent` | Validate SQL against schema graph | Future |
| Test Generator | `testGeneratorAgent` | dbt tests + custom quality tests | Future |
| Documentation Generator | `architectureAgent` | Data dictionary + architecture docs | Enhanced in 3a |
| Future-State Architect | `futureStateArchitectAgent` | To-be architecture diagram | Future |

### 5.3 Agent Execution Context

All sub-agents receive the same context:

```typescript
interface AgentExecutionContext {
  objective: string;
  schemaContext?: string;
  settings: DataAgentHubSettings;
  configManager: {
    getSecret: (key: string) => Promise<string | undefined>;
    getSettings: () => DataAgentHubSettings;
  };
  log: (message: string) => void;
}
```

### 5.4 Agent Execution Result

All sub-agents return the same contract:

```typescript
interface AgentExecutionResult {
  success: boolean;
  message: string;
  details?: Record<string, unknown>;
  error?: string;
}
```

### 5.5 Plan Execution Flow

```
User describes objective
        │
        ▼
Orchestrator generates plan (LLM)
        │
        ▼
Plan displayed as interactive card
        │
        ▼
User clicks "Execute All" (or steps run automatically)
        │
        ▼
DAG execution: for each ready step:
  ├── Check dependencies satisfied
  ├── Set step status → 'running'
  ├── Invoke sub-agent via AGENT_EXECUTORS[step.assignedAgent]
  ├── On success: status → 'completed'
  └── On failure: status → 'failed', offer re-plan
        │
        ▼
All steps complete → status → 'completed'
```

---

## 6. LLM Integration

### 6.1 Multi-Provider Model

**File:** `src/core/agentHub.ts` (`callConfiguredLlm`)

| Provider | Key | Implementation |
|----------|-----|---------------|
| GitHub Copilot | `copilot` | VS Code Language Model API via `CopilotAdapter` |
| OpenAI | `openai` | `fetch()` to `api.openai.com/v1/chat/completions` |
| Anthropic | `anthropic` | `fetch()` to `api.anthropic.com/v1/messages` |
| Azure OpenAI | `azure-openai` | `fetch()` to custom endpoint |
| Google Gemini | `gemini` | `fetch()` to `generativelanguage.googleapis.com` |
| Ollama (Local) | `ollama` | `fetch()` to `localhost:11434/api/chat` |

### 6.2 CopilotAdapter

**File:** `src/core/copilotAdapter.ts`

| Feature | Implementation |
|---------|---------------|
| Detection | Searches for `github.copilot-chat` extension |
| Model selection | `vscode.lm.selectChatModels({ vendor: 'copilot' })` |
| Consent gate | Checks `copilotProgrammaticConsent` setting |
| Request | `model.sendRequest(messages, { justification })` |
| Timeout | Configurable (default 30s) via `Promise.race` |
| Test | `testCall()` sends a simple prompt and checks response |

### 6.3 Chat vs. Plan Routing

| Path | Method | Prompt Style | Response Handling |
|------|--------|-------------|-------------------|
| **Chat** | `hub.chat()` | Conversational assistant | Raw text returned to UI |
| **Plan** | `hub.generatePlan()` | Strict JSON DAG format | Parsed + validated as `PlanStep[]` |

### 6.4 Prompt Engineering

**Chat prompt:**
```
You are AutoDE, an expert data engineering assistant running inside VS Code.
You help users with data engineering tasks including pipeline design, SQL authoring,
schema analysis, data modeling, ETL/ELT workflows, and data platform operations.

Respond conversationally and helpfully. If the user asks you to generate a plan,
suggest they click the "Generate Plan" button or use the /plan command.

{context block}

User message: {message}
```

**Plan prompt:**
```
You are an expert data engineering planning assistant. Create a strict execution DAG
for the following objective for the {provider} provider:

{context block}

Objective: {objective}

Return only a valid JSON array of objects. Each object must include:
{"id":"step-1","assignedAgent":"ingestionAgent","taskDescription":"...",
 "status":"pending","dependsOn":[],"validationRules":["..."]}.

Use only these assignedAgent values: ingestionAgent, sttmAgent, architectureAgent,
snowflakeExecutor. Order the DAG so each step is sequentially dependent.
```

---

## 7. Extension Architecture

### 7.1 Activation & Lifecycle

**File:** `src/extension.ts`

```
activate(context)
  ├── Create ConfigurationManager
  ├── Create DataAgentHubHub (orchestrator)
  ├── Create ConnectionManager (Phase 3a)
  ├── Create DataAgentHubWebviewProvider
  ├── Register commands:
  │   ├── openSidebar
  │   ├── generatePlan
  │   ├── executePlan
  │   ├── resetSession
  │   ├── testCopilot
  │   ├── listCopilotInfo
  │   ├── debugListExtensions
  │   ├── copilotHandoff
  │   ├── testConnection (Phase 3a)
  │   └── sourceAssessment (Phase 3a)
  └── Register webview view provider

deactivate()
  └── (cleanup handled by disposables)
```

### 7.2 WebviewProvider Message Protocol

**File:** `src/core/webviewProvider.ts`

| Message (Webview → Extension) | Handler | Description |
|------------------------------|---------|-------------|
| `chat` | `hub.chat()` | Conversational message |
| `generatePlan` | `hub.generatePlan()` | Generate execution plan |
| `executePlan` | `hub.executePlan()` | Execute current plan |
| `pausePlan` | `hub.pauseExecution()` | Pause execution |
| `resetPlan` | `hub.resetPlan()` | Reset session |
| `updateSettings` | `configManager.updateSettings()` | Save settings |
| `testCopilot` | Command proxy | Test Copilot connection |
| `openCopilotHandoff` | Command proxy | Open handoff editor |
| `reindex` | Command proxy | Rebuild context index |
| `openContextFolder` | File system | Open .ai-context in OS |
| `testConnection` | `ConnectionManager.connect()` | Connect to data platform |
| `sourceAssessment` | `ConnectionManager.extractMetadata()` | Extract + persist metadata |
| `runAgent` | Agent routing | Run a specific sub-agent |
| `settingsLoaded` | Re-send settings | Webview initial load |

| Message (Extension → Webview) | Purpose |
|------------------------------|---------|
| `stateUpdate` | Push plan state changes |
| `planUpdated` | Push new plan |
| `logEntry` | Push log message |
| `settingsLoaded` | Push settings + Copilot info |
| `settingsSaved` | Confirm settings saved |
| `error` | Push error message |
| `contextUpdate` | Push context stats + entities |
| `stepUpdate` | Push step status change |
| `chatResponse` | Push chat response |
| `agentStatus` | Push agent execution status |
| `sourceAssessmentComplete` | Push source assessment result |

### 7.3 Configuration Management

**File:** `src/core/configManager.ts`

| Method | Description |
|--------|-------------|
| `getSettings()` | Read all settings from VS Code configuration |
| `updateSettings(partial)` | Write settings to VS Code configuration |
| `setSecret(key, value)` | Store secret in VS Code secret storage |
| `getSecret(key)` | Retrieve secret from VS Code secret storage |
| `deleteSecret(key)` | Remove secret |
| `setLlmApiKey(value)` | Store LLM API key |
| `getLlmApiKey()` | Retrieve LLM API key |
| `setSnowflakePassword(value)` | Store Snowflake password |
| `getSnowflakePassword()` | Retrieve Snowflake password |

### 7.4 Registered Configuration Properties

All properties are under the `autoDataEngineeringHub` section:

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `defaultProvider` | enum | `snowflake` | Default data platform |
| `defaultSnowflakeAccount` | string | `""` | Snowflake account |
| `defaultSnowflakeUsername` | string | `""` | Snowflake username |
| `defaultSnowflakeWarehouse` | string | `""` | Snowflake warehouse |
| `defaultSnowflakeDatabase` | string | `""` | Snowflake database |
| `defaultSnowflakeSchema` | string | `PUBLIC` | Snowflake schema |
| `defaultSnowflakeRole` | string | `SYSADMIN` | Snowflake role |
| `defaultSnowflakeAuthMode` | enum | `key-pair` | Auth mode |
| `snowflakePrivateKeyPath` | string | `""` | Key path |
| `metadataCachingDurationMinutes` | number | `15` | Cache duration |
| `queryTimeoutSeconds` | number | `120` | Query timeout |
| `readOnlyMode` | boolean | `true` | Read-only mode |
| `enableSessionReuse` | boolean | `true` | Session reuse |
| `autoDocumentationEnabled` | boolean | `true` | Auto-documentation |
| `telemetryEnabled` | boolean | `false` | Telemetry opt-in |
| `activeLlmProvider` | enum | `copilot` | Active LLM provider |
| `activeLlmModel` | string | `gpt-4o-mini` | LLM model name |
| `llmEndpoint` | string | `""` | Custom LLM endpoint |
| `copilotProgrammaticConsent` | boolean | `false` | Copilot consent |
| `extensionDisplayName` | string | `Auto Data Engineering Hub` | Display name |
| `extensionDescription` | string | `...` | Description |

---

## 8. File Structure

```
AutoDE/
├── .ai-context/                          # Context layer artifacts
│   ├── schema-graph.json                 # Generated: knowledge graph snapshot
│   ├── business-context.yaml             # Human-curated: business terms + rules
│   ├── verified-queries.yaml             # Human-curated: reference SQL
│   ├── sttm-mapping.yaml                 # Generated: STTM mappings
│   └── architecture.md                   # Generated: architecture docs
│
├── docs/
│   ├── requirements.md                   # Original requirements specification
│   └── technical-design.md               # THIS DOCUMENT
│
├── media/
│   ├── logo.svg                          # Extension icon
│   ├── architecture.drawio               # Architecture diagram source
│   └── sidebar.html                      # Webview UI (single-file HTML+CSS+JS)
│
├── src/
│   ├── extension.ts                      # Activation, command registration
│   │
│   ├── core/
│   │   ├── agentHub.ts                   # Orchestrating agent + LLM calls
│   │   ├── configManager.ts              # VS Code settings + secrets
│   │   ├── copilotAdapter.ts             # GitHub Copilot integration
│   │   ├── extensionIdentity.ts          # Constants (IDs, keys)
│   │   ├── providerRegistry.ts           # Platform + LLM provider definitions
│   │   ├── types.ts                      # Core type definitions
│   │   └── webviewProvider.ts            # Webview message bridge
│   │
│   ├── context/
│   │   ├── ContextFileManager.ts         # .ai-context/ file management
│   │   ├── GraphManager.ts               # In-memory knowledge graph
│   │   └── types.ts                      # Context-specific types
│   │
│   ├── dqm/                              # Data Quality & Metadata (Phase 3a)
│   │   ├── BaseAdapter.ts                # Abstract base adapter
│   │   ├── ConnectionManager.ts          # Connection lifecycle
│   │   ├── types.ts                      # Adapter-specific types
│   │   └── adapters/
│   │       ├── SnowflakeAdapter.ts       # Snowflake implementation
│   │       └── DatabricksAdapter.ts      # Databricks implementation
│   │
│   ├── agents/                           # Sub-agents (Phase 3a)
│   │   ├── discover/
│   │   │   └── SourceAssessmentAgent.ts  # Metadata extraction
│   │   ├── model/
│   │   │   └── SttmMapperAgent.ts        # Source-to-target mapping
│   │   ├── build/
│   │   │   └── IngestionPipelineAgent.ts # Ingestion code generation
│   │   └── validate/
│   │       └── DocumentationAgent.ts     # Architecture documentation
│   │
│   ├── spokes/                           # Legacy spoke agents (to be migrated)
│   │   ├── architectureAgent.ts
│   │   ├── ingestionAgent.ts
│   │   ├── snowflakeExecutor.ts
│   │   └── sttmAgent.ts
│   │
│   └── features/                         # (Reserved for future use)
│       ├── agents/
│       └── providers/
│
├── test/
│   └── functional.test.cjs               # Functional tests
│
├── package.json                          # Extension manifest
├── tsconfig.json                         # TypeScript configuration
└── README.md                             # Project README
```

---

## 9. Implementation Phases

### Phase 0: UI Restructure ✅ COMPLETE

- [x] Replace four-tab layout with single-column, section-based layout
- [x] Redesign top status bar with provider pill, connection pill, context meter, plan status
- [x] Move Settings and Connect into slide-out panel
- [x] Implement context assembly drawer (collapsible)
- [x] Polish all CSS to match design specifications
- [x] Add welcome/onboarding block

### Phase 1: Chat Routing Fix + Codebase Cleanup ✅ COMPLETE

- [x] Add conversational `chat()` method to agentHub
- [x] Route regular messages to `chat` instead of `generatePlan`
- [x] Add `chatResponse` handler in webview
- [x] Auto-save Copilot consent toggle
- [x] Register `copilotProgrammaticConsent` configuration property
- [x] Remove stale duplicate re-export files (`src/agentHub.ts`, etc.)
- [x] Fix broken imports in spoke agents
- [x] Add slash command support (`/plan`, `/execute`, `/context`, etc.)

### Phase 2: Context Visibility & Interaction ✅ COMPLETE

- [x] Create `ContextFileManager` with YAML parsing, file watching, atomic writes
- [x] Wire `ContextFileManager` into `webviewProvider`
- [x] Post `contextUpdate` messages with real stats and entity lists
- [x] Update @-mention system to use real context entities
- [x] Populate context drawer chips from context layer
- [x] Add "Source Assessment" button to connection panel
- [x] Add `sourceAssessment` message handler

### Phase 3a: Multi-Platform Adapter Architecture + Workflow Palette ✅ COMPLETE

- [x] Create `docs/technical-design.md` (this document)
- [x] Create `src/dqm/types.ts` — adapter type definitions
- [x] Create `src/dqm/BaseAdapter.ts` — abstract base class
- [x] Create `src/dqm/adapters/SnowflakeAdapter.ts` — Snowflake implementation
- [x] Create `src/dqm/adapters/DatabricksAdapter.ts` — Databricks implementation
- [x] Create `src/dqm/ConnectionManager.ts` — connection lifecycle
- [x] Move spoke agents to `src/agents/` directory
- [x] Create `src/agents/discover/SourceAssessmentAgent.ts`
- [x] Enhance STTM, Ingestion, Documentation agents
- [x] Update `src/core/agentHub.ts` imports
- [x] Update `src/extension.ts` with ConnectionManager
- [x] Update `src/core/webviewProvider.ts` with new handlers
- [x] Build Workflow Palette UI in `media/sidebar.html`
- [x] Add palette CSS + JS
- [x] Compile + test

### Phase 3b: Enhanced Sub-Agents

- [ ] Data Modeler agent (dimensional + Data Vault)
- [ ] Transformation Scaffolder agent (dbt project generation)
- [ ] Data Lineage Mapper agent
- [ ] Data Quality Profiler agent

### Phase 3c: New Sub-Agents

- [ ] DDL Generator agent
- [ ] Orchestration Generator agent (Airflow/Dagster/Prefect)
- [ ] SQL Validator agent
- [ ] Test Generator agent
- [ ] Business Glossary Builder agent

### Phase 3d: Orchestrator Intelligence

- [ ] Context-aware action suggestions in chat
- [ ] Auto-invocation of sub-agents based on intent
- [ ] Plan diff & iteration
- [ ] Onboarding flow for first-time users
- [ ] Results preview for executed SQL
- [ ] Export functionality (Markdown/YAML)

---

## 10. Design Decisions & Tradeoffs

### 10.1 Why Conversation-First Over Tab-Based?

**Decision:** Single scrollable workspace with slide-out panels instead of multiple tabs.

**Rationale:**
- No tab switching during the core workflow (describe → plan → execute → refine)
- Context is always visible — users can expand the context drawer to see exactly what semantic metadata is being included
- Settings and connections move to a slide-out panel — not a tab competing for attention
- Cline's success validates this pattern: one unified conversation surface where configuration, context, and execution flow naturally from the chat

### 10.2 Why Adapter Pattern Over Code Generation?

**Decision:** Abstract `BaseDataSourceAdapter` with platform-specific implementations.

**Rationale:**
- Each platform has fundamentally different system tables, SQL dialects, and authentication
- Code generation would require maintaining templates for every platform × operation combination
- Adapter pattern allows adding new platforms by implementing one class
- Sub-agents stay clean and platform-agnostic
- The `PlatformCapabilities` model allows graceful degradation (e.g., Databricks doesn't support lineage extraction)

### 10.3 Why Phase-Organized Palette Over Source/Target Split?

**Decision:** Workflow palette organized by phase (Discover → Model → Build → Validate) rather than source vs. target sections.

**Rationale:**
- Real data engineering is iterative, not linear: Source Assessment → STTM → Modeling → back to Source for more profiling
- Rigid source/target separation forces context switching
- Phase organization matches how engineers think about their workflow
- The orchestrating agent understands which phase the user is in and suggests the next logical action

### 10.4 Why Atomic Writes for .ai-context/?

**Decision:** All writes use temporary staging + atomic rename.

**Rationale:**
- Prevents corruption if VS Code crashes mid-write
- The `schema-graph.json` file is always in a valid state
- On next boot, the engine loads the previous valid snapshot
- Implemented via `vscode.workspace.fs.writeFile(tempFile)` → `vscode.workspace.fs.rename(tempFile, targetFile, { overwrite: true })`

### 10.5 Why Single-File Webview (sidebar.html)?

**Decision:** All HTML, CSS, and JavaScript in one file.

**Rationale:**
- VS Code webviews have restrictions on loading external resources
- Single-file simplifies the build process (no bundler needed)
- The file is read via `fs.readFileSync` and injected directly
- For a sidebar-sized UI, the complexity doesn't yet warrant a framework
- Can be split later if the UI grows significantly

### 10.6 Why Custom YAML Parser Over js-yaml?

**Decision:** Lightweight custom parser for `.ai-context/` YAML files.

**Rationale:**
- Avoids adding a native dependency that complicates VSIX packaging
- The YAML structures needed (business-context.yaml, verified-queries.yaml) are simple and flat
- A full YAML parser would be overkill for these specific file formats
- Can be replaced with `js-yaml` later if more complex YAML structures are needed

---

## Appendix A: Webview Message Reference

### Webview → Extension

| Message Type | Payload | Handler |
|-------------|---------|---------|
| `chat` | `{ message: string, schemaContext?: string }` | `hub.chat()` |
| `generatePlan` | `{ objective: string, schemaContext?: string }` | `hub.generatePlan()` |
| `executePlan` | `{}` | `hub.executePlan()` |
| `pausePlan` | `{}` | `hub.pauseExecution()` |
| `resetPlan` | `{}` | `hub.resetPlan()` |
| `updateSettings` | `{ settings: Partial<DataAgentHubSettings> }` | `configManager.updateSettings()` |
| `testCopilot` | `{}` | Command proxy |
| `openCopilotHandoff` | `{ prompt?: string }` | Command proxy |
| `reindex` | `{}` | Command proxy |
| `openContextFolder` | `{}` | File system |
| `testConnection` | `{}` | `ConnectionManager.connect()` |
| `sourceAssessment` | `{}` | `ConnectionManager.extractMetadata()` |
| `runAgent` | `{ agent: string }` | Agent routing |
| `settingsLoaded` | `{}` | Re-send settings |

### Extension → Webview

| Message Type | Payload | Purpose |
|-------------|---------|---------|
| `stateUpdate` | `{ state: PlanState }` | Plan state changes |
| `planUpdated` | `{ plan: PlanStep[] }` | New plan generated |
| `logEntry` | `{ message: string }` | Log message |
| `settingsLoaded` | `{ ...DataAgentHubSettings, copilotInfo }` | Initial settings |
| `settingsSaved` | `{ success: boolean }` | Settings confirmation |
| `error` | `{ message: string }` | Error notification |
| `contextUpdate` | `{ stats, dbEntities, bizTerms, queries }` | Context data |
| `stepUpdate` | `{ stepId, status, details }` | Step status change |
| `chatResponse` | `{ message: string, error?: boolean }` | Chat response |
| `agentStatus` | `{ agent, status, result? }` | Agent execution status |
| `sourceAssessmentComplete` | `{ success: boolean, error? }` | Assessment result |

---

## Appendix B: CSS Variable Reference

| Variable | Fallback | Usage |
|----------|----------|-------|
| `--bg` | `#1f1f1f` | Main background |
| `--surface` | `#252526` | Cards, panels, input areas |
| `--surface-hover` | `rgba(255,255,255,0.03)` | Hover state |
| `--surface-active` | `rgba(255,255,255,0.06)` | Active/selected state |
| `--surface-elevated` | `rgba(255,255,255,0.04)` | Elevated surfaces |
| `--border` | `rgba(255,255,255,0.12)` | Standard borders |
| `--border-soft` | `rgba(255,255,255,0.08)` | Subtle borders |
| `--border-subtle` | `rgba(255,255,255,0.05)` | Very subtle borders |
| `--text` | `#cccccc` | Primary text |
| `--text-muted` | `#9d9d9d` | Secondary text |
| `--text-dim` | `rgba(255,255,255,0.45)` | Dimmed text |
| `--accent` | `#0e639c` | Primary accent |
| `--accent-hover` | `#1177bb` | Accent hover |
| `--accent-subtle` | `rgba(14,99,156,0.12)` | Subtle accent background |
| `--accent-border` | `rgba(14,99,156,0.25)` | Accent border |
| `--text-on-accent` | `#ffffff` | Text on accent |
| `--success` | `#2ea043` | Success green |
| `--warning` | `#d29922` | Warning amber |
| `--error` | `#f85149` | Error red |
| `--info` | `#58a6ff` | Info blue |
| `--radius` | `8px` | Card border radius |
| `--radius-sm` | `6px` | Small border radius |
| `--radius-xs` | `4px` | Extra small border radius |
| `--radius-pill` | `999px` | Pill border radius |
| `--spacing-xs` | `4px` | Extra small spacing |
| `--spacing-sm` | `8px` | Small spacing |
| `--spacing-md` | `12px` | Medium spacing |
| `--spacing-lg` | `16px` | Large spacing |
| `--spacing-xl` | `20px` | Extra large spacing |
| `--font-size` | `12px` | Base font size |
| `--font-size-sm` | `11px` | Small font size |
| `--font-size-lg` | `13px` | Large font size |
| `--font-size-xl` | `14px` | Extra large font size |
| `--transition-fast` | `0.12s ease` | Fast transitions |
| `--transition-normal` | `0.2s ease` | Normal transitions |
| `--transition-slow` | `0.3s ease` | Slow transitions |

---

*This document is version-controlled and should be updated whenever design decisions change during implementation.*