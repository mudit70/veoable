# Veoable - System Architecture Document

## 1. Overview

This document describes the system architecture of Veoable, a code analysis platform that builds a knowledge graph from multi-repository codebases and exposes it through NLP, graphical, and MCP interfaces. The architecture is designed around a modular agent system for code analysis, a central knowledge graph for storage, and multiple interface layers for human and AI consumption.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      PRESENTATION LAYER                         │
│                                                                 │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ NLP Interface │  │ Graphical        │  │ Unified Interface│  │
│  │              │  │ Interface        │  │ Layer            │  │
│  │ (R-8.1.x)   │  │ (R-8.2.x)       │  │ (R-8.3.x)       │  │
│  └──────┬───────┘  └────────┬─────────┘  └────────┬─────────┘  │
│         └──────────────┬────┘                      │            │
│                        └──────────┬────────────────┘            │
└───────────────────────────────────┼─────────────────────────────┘
                                    │
┌───────────────────────────────────┼─────────────────────────────┐
│                       SERVICE LAYER                             │
│                                   │                             │
│  ┌────────────────────────────────▼──────────────────────────┐  │
│  │                  API Gateway / Router                      │  │
│  └──┬──────────┬──────────┬──────────┬───────────────┬───────┘  │
│     │          │          │          │               │          │
│  ┌──▼───┐  ┌──▼───┐  ┌──▼────┐  ┌──▼────────┐  ┌──▼───────┐  │
│  │Query │  │Impact│  │Dead   │  │Deploy     │  │Data      │  │
│  │Search│  │Analy.│  │Code   │  │Readiness  │  │Export    │  │
│  │Filter│  │      │  │Detect │  │           │  │          │  │
│  │(7.1) │  │(7.2) │  │(7.3)  │  │(7.4)      │  │(7.5)     │  │
│  └──┬───┘  └──┬───┘  └──┬────┘  └──┬────────┘  └──┬───────┘  │
│     └──────────┴─────────┴──────────┴──────────────┘           │
│                          │                                      │
│  ┌───────────────────────▼───────────────────────────────────┐  │
│  │              Analysis Orchestrator                         │  │
│  │         (coordinates analysis pipeline)                    │  │
│  └──┬──────────────┬────────────────────┬────────────────────┘  │
│     │              │                    │                       │
│  ┌──▼────────┐  ┌──▼─────────────┐  ┌──▼──────────────────┐   │
│  │ MCP       │  │ Notification   │  │ Response            │   │
│  │ Server    │  │ Service        │  │ Formatter           │   │
│  │ (R-6.2.x)│  │ (R-10.x)      │  │ (text/JSON/visual)  │   │
│  └───────────┘  └────────────────┘  └─────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────┼─────────────────────────────┐
│                    PROCESSING LAYER                              │
│                                   │                             │
│  ┌────────────────────────────────▼──────────────────────────┐  │
│  │                 Agent Runtime                              │  │
│  │   (manages agent lifecycle, message routing, JSON Schema)  │  │
│  └──┬──────────────────┬─────────────────────┬───────────────┘  │
│     │                  │                     │                  │
│  ┌──▼───────────────┐ ┌▼──────────────────┐ ┌▼───────────────┐ │
│  │ Detection        │ │ Detail            │ │ Flow           │ │
│  │ Engines          │ │ Analyzers         │ │ Stitcher       │ │
│  │                  │ │                   │ │                │ │
│  │ ┌──────────────┐ │ │ ┌───────────────┐ │ │ Deterministic  │ │
│  │ │ API Endpoint │ │ │ │ Endpoint      │ │ │ Matcher        │ │
│  │ │ Detection    │ │ │ │ Analyzer      │ │ │                │ │
│  │ │ Engine       │ │ │ │ (R-4.1.x)    │ │ │ AI Contextual  │ │
│  │ │ (R-3.1.x)   │ │ │ └───────────────┘ │ │ Analyzer       │ │
│  │ └──────────────┘ │ │ ┌───────────────┐ │ │                │ │
│  │ ┌──────────────┐ │ │ │ Caller        │ │ │ Human-in-the-  │ │
│  │ │ API Caller   │ │ │ │ Analyzer      │ │ │ Loop Resolver  │ │
│  │ │ Detection    │ │ │ │ (R-4.2.x)    │ │ │                │ │
│  │ │ Engine       │ │ │ └───────────────┘ │ │ (R-5.x)       │ │
│  │ │ (R-3.2.x)   │ │ │ ┌───────────────┐ │ │                │ │
│  │ └──────────────┘ │ │ │ Process       │ │ └────────────────┘ │
│  │ ┌──────────────┐ │ │ │ Analyzer      │ │                    │
│  │ │ Client-Side  │ │ │ │ (R-4.3.x)    │ │                    │
│  │ │ Process      │ │ │ └───────────────┘ │                    │
│  │ │ Detection    │ │ │                   │                    │
│  │ │ Engine       │ │ └───────────────────┘                    │
│  │ │ (R-3.3.x)   │ │                                          │
│  │ └──────────────┘ │                                          │
│  └──────────────────┘                                          │
└────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────┼────────────────────────────┐
│                       DATA LAYER                               │
│                                   │                            │
│  ┌────────────────────────────────▼─────────────────────────┐  │
│  │                  Knowledge Graph                          │  │
│  │                  (R-6.1.x)                                │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │ Project Store    │  │ Resolution Store │  │ Version /    │  │
│  │ (R-11.4.x)      │  │ (R-5.6)         │  │ Snapshot     │  │
│  │                  │  │                  │  │ Store        │  │
│  │ projects,        │  │ persisted        │  │ (R-6.1.5)   │  │
│  │ repositories,    │  │ ambiguity        │  │              │  │
│  │ labels           │  │ resolutions      │  │ graph diffs, │  │
│  │                  │  │                  │  │ timestamps   │  │
│  └──────────────────┘  └──────────────────┘  └──────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

---

## 3. Layer Descriptions

### 3.1 Presentation Layer

The presentation layer handles all direct user interaction. It contains three components that work together.

**NLP Interface (R-8.1.x)**
- Accepts natural language input from users.
- Translates user intent into structured queries against the service layer.
- Returns responses as natural language text.
- Supports all system operations: project management, analysis triggers, queries, impact analysis, dead code detection, deploy readiness checks.
- Primary interface for personas: all developers, QA, support, DevOps/SRE.

**Graphical Interface (R-8.2.x)**
- Renders the knowledge graph as an interactive, layered diagram.
- Provides visual controls: zoom, pan, filter by repository/framework/element type/flow.
- Supports click-to-drill-down on any node to view full details.
- Provides forms and controls for project management and analysis triggers.
- Primary interface for personas: tech leads, product managers, new team members.

**Unified Interface Layer (R-8.3.x)**
- Bridges the NLP and graphical interfaces.
- When a user asks a question via NLP, this layer routes the response to both the text renderer and the graph visualizer.
- Allows the user to choose response format: text only, visual only, or both.
- Handles NLP-driven graph highlighting: when a user asks a question, the relevant subgraph is highlighted in the graphical interface (R-8.2.7).

### 3.2 Service Layer

The service layer contains the business logic for querying, analysis orchestration, and external integration.

**API Gateway / Router**
- Single entry point for all requests from the presentation layer and the MCP server.
- Routes requests to the appropriate service: query, analysis, impact analysis, export, etc.
- Enforces consistent request/response schemas.

**Query and Analysis Services (R-7.x)**

| Service | Purpose | Key Operations |
|---|---|---|
| Query Search & Filter (R-7.1.x) | Search and filter discovered elements | Filter endpoints by method/path/framework/repo; filter callers by endpoint/framework/repo; filter processes by type/framework/repo; keyword search across all types |
| Impact Analysis (R-7.2.x) | Determine blast radius of changes | Given a component, traverse graph to find all directly and transitively affected components; return as list or visual subgraph |
| Dead Code Detection (R-7.3.x) | Find orphaned components | Detect uncalled endpoints, unreachable callers, orphaned processes, missing endpoints |
| Deploy Readiness (R-7.4.x) | Assess change impact on flows | Given changed components/files, identify all affected end-to-end flows; highlight changed layers |
| Data Export (R-7.5.x) | Export results | Export any query result or analysis output as JSON using shared schemas |

**Analysis Orchestrator**
- Coordinates the full analysis pipeline (UC-2, UC-18).
- Determines which detection engines to launch based on repository labels and detected languages/frameworks.
- Sequences the pipeline: detection -> detail analysis -> flow stitching.
- Manages the human-in-the-loop workflow when the flow stitcher encounters ambiguities.
- On re-analysis, compares new results to the previous graph version and produces a change summary (R-9.3).
- Publishes progress events and completion notifications via the Notification Service.

**MCP Server (R-6.2.x)**
- Implements the Model Context Protocol.
- Exposes the knowledge graph to AI coding assistants (UC-14).
- Supports three categories of MCP tools:
  - **Flow queries:** Retrieve complete end-to-end flows as structured JSON (R-6.2.3).
  - **Element queries:** Retrieve details of individual endpoints, callers, or processes (R-6.2.4).
  - **Impact queries:** Given a component, return all affected components (R-6.2.5).
- Routes all queries through the same Query and Analysis Services used by the human interfaces, ensuring consistency.

**Notification Service (R-10.x)**
- Publishes events for analysis progress, completion, and ambiguity resolution requests.
- Both the NLP and graphical interfaces subscribe to these events.
- Supports progress indication (which engines are running, percentage complete).
- Delivers ambiguity resolution prompts to the active interface when the flow stitcher pauses.

**Response Formatter**
- Transforms raw query results into the requested output format.
- Three output modes: natural language text, structured JSON, and visual flow diagram data.
- Used by the unified interface layer to serve the user's chosen format (R-8.3.3).
- For JSON output, uses the shared schemas defined for inter-agent communication (R-11.1.3).

### 3.3 Processing Layer

The processing layer contains all code analysis logic, organized as a multi-agent system.

**Agent Runtime**
- Manages the lifecycle of all agents: startup, execution, message passing, shutdown.
- Enforces JSON Schema contracts on all inter-agent messages (R-11.1.1).
- Routes messages between framework agents and their aggregator agents.
- Supports adding new agents without modifying the runtime (R-11.2.3, R-11.3.3).

The processing layer contains three subsystems, each described in detail below.

### 3.4 Data Layer

The data layer provides persistent storage for all system state.

**Knowledge Graph (R-6.1.x)**
- Central store for all analysis results.
- Contains nodes and edges as defined in the data model (Section 5).
- Supports versioning/timestamps so changes between analyses can be identified (R-6.1.5).
- Queryable by the service layer to answer questions about the codebase.

**Project Store (R-11.4.x)**
- Stores project definitions: name, associated repositories, repository labels.
- Tracks which repositories belong to which project.

**Resolution Store (R-5.6)**
- Persists user-provided ambiguity resolutions from the flow stitching process.
- Keyed by the ambiguous reference (e.g., a dynamic URL pattern) and the resolved target.
- Consulted during re-analysis to avoid re-prompting for previously resolved ambiguities.
- Resolutions are invalidated if the underlying code reference changes.

**Version / Snapshot Store (R-6.1.5, R-9.x)**
- Stores graph snapshots or diffs between analysis runs.
- Enables the change summary produced on re-analysis (R-9.3).
- Supports deploy readiness queries that compare current state to a previous baseline.

---

## 4. Processing Layer - Detailed Design

### 4.1 Detection Engines

Each detection engine follows the same architectural pattern: multiple framework-specific agents report to one aggregator agent.

```
┌─────────────────────────────────────────────────────┐
│              Detection Engine (one per type)         │
│                                                     │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐         │
│  │ Express   │ │ Flask     │ │ Actix     │  ...     │
│  │ Agent     │ │ Agent     │ │ Agent     │         │
│  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘         │
│        │              │              │               │
│        │    JSON Schema messages     │               │
│        │              │              │               │
│        ▼              ▼              ▼               │
│  ┌──────────────────────────────────────────────┐   │
│  │           Aggregator Agent                    │   │
│  │  (compiles, deduplicates, validates results)  │   │
│  └──────────────────────┬───────────────────────┘   │
└─────────────────────────┼───────────────────────────┘
                          │
                          ▼
                   Knowledge Graph
```

**Three detection engine instances exist:**

| Engine | Framework Agents | Aggregator | Output Node Type |
|---|---|---|---|
| API Endpoint Detection (R-3.1.x) | Express, Fastify, Koa, NestJS, Flask, Django, FastAPI, Actix, Axum, Rocket, net/http, Gin, Echo, Fiber | API List Generator Agent | API Endpoint |
| Client-Side Caller Detection (R-3.2.x) | React, Vue, Angular, Svelte, Python client, Rust client, Go client | API Caller List Generator Agent | Client-Side API Caller |
| Client-Side Process Detection (R-3.3.x) | React, Vue, Angular, Svelte, Python client, Rust client, Go client | Client-Side List Generator Agent | Client-Side Process |

**Framework Agent responsibilities:**
- Parse source code for the specific framework's patterns (e.g., `app.get()` for Express, `@app.route()` for Flask).
- Extract required metadata per detected element (R-3.1.7, R-3.2.7, R-3.3.7).
- Return results as JSON Schema-conformant messages to the aggregator.

**Aggregator Agent responsibilities:**
- Receive results from all framework agents for a given repository/project.
- Compile, deduplicate, and validate.
- Write consolidated results to the knowledge graph.

### 4.2 Detail Analyzers

Detail analyzers perform deep analysis on individual elements already discovered by the detection engines. They are triggered by the analysis orchestrator after detection is complete.

```
┌──────────────────────────────────────────┐
│ Endpoint Detail Analyzer (R-4.1.x)       │
│                                          │
│  Input: API Endpoint node from graph     │
│                                          │
│  Analysis steps:                         │
│  1. Parse endpoint handler code          │
│  2. Trace code flow and business logic   │
│  3. Extract request schema               │
│  4. Extract response schemas (all codes) │
│  5. Discover database interactions       │
│  6. Map error handling paths             │
│                                          │
│  Output: EndpointDetail JSON attached    │
│          to the endpoint node            │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│ Caller Detail Analyzer (R-4.2.x)         │
│                                          │
│  Input: API Caller node from graph       │
│                                          │
│  Analysis steps:                         │
│  1. Parse caller function/module         │
│  2. Identify invocation points           │
│  3. Trace code flow                      │
│  4. Extract API calls made               │
│  5. Extract request/response structures  │
│  6. Analyze response handling            │
│                                          │
│  Output: CallerDetail JSON attached      │
│          to the caller node              │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│ Process Detail Analyzer (R-4.3.x)        │
│                                          │
│  Input: Client-Side Process node         │
│                                          │
│  Analysis steps:                         │
│  1. Identify invocation trigger          │
│  2. Trace code flow and logic            │
│  3. Identify API callers invoked (or     │
│     mark as purely local)               │
│  4. Map state changes and DOM updates    │
│                                          │
│  Output: ProcessDetail JSON attached     │
│          to the process node             │
└──────────────────────────────────────────┘
```

Detail results are stored as properties on the corresponding knowledge graph nodes. This means any query that retrieves a node can also retrieve its full detail analysis.

### 4.3 Flow Stitcher

The flow stitcher connects elements from different layers into complete end-to-end flows. It runs after both detection and detail analysis are complete.

```
                    Flow Stitcher Pipeline
                    ─────────────────────

 Step 1: Deterministic Stitching
 ┌─────────────────────────────────────────────────┐
 │  For each client-side process:                   │
 │  1. Follow import/call chains to find which      │
 │     API callers it invokes.                      │
 │  2. Match caller's target URL/path to detected   │
 │     API endpoint route paths.                    │
 │  3. From endpoint detail, identify database      │
 │     tables touched.                              │
 │  4. Trace response path back: endpoint ->        │
 │     caller response handler -> process DOM       │
 │     update.                                      │
 │                                                  │
 │  Methods: import resolution, static URL match,   │
 │  constant propagation, type analysis.            │
 │                                                  │
 │  Output: fully stitched flows (marked as         │
 │  "deterministic") + unresolved references.       │
 └──────────────────────┬──────────────────────────┘
                        │
                        ▼ unresolved references
 Step 2: Ambiguity Resolution
 ┌─────────────────────────────────────────────────┐
 │  For each unresolved reference:                  │
 │                                                  │
 │  2a. Check Resolution Store for a previously     │
 │      persisted resolution. If found and code     │
 │      has not changed, apply it.                  │
 │                                                  │
 │  2b. If no stored resolution, offer two paths:   │
 │      - Human-in-the-loop: present the ambiguous  │
 │        caller, candidate endpoints, and ask      │
 │        user to select or provide context.        │
 │      - AI contextual analysis: send the          │
 │        ambiguous reference + candidates to an    │
 │        AI model for contextual matching.         │
 │                                                  │
 │  2c. Record the resolution in the Resolution     │
 │      Store for future re-use.                    │
 │                                                  │
 │  Output: remaining flows stitched (marked as     │
 │  "contextual" or "user-resolved").               │
 └──────────────────────┬──────────────────────────┘
                        │
                        ▼
 Step 3: Flow Assembly
 ┌─────────────────────────────────────────────────┐
 │  Assemble complete flow objects:                 │
 │                                                  │
 │  Flow {                                          │
 │    process  -> caller(s) -> endpoint(s)          │
 │              -> db interactions -> responses     │
 │              -> client handling -> DOM updates   │
 │                                                  │
 │    stitching_metadata: {                         │
 │      each link marked as "deterministic",        │
 │      "ai-contextual", or "user-resolved"         │
 │    }                                             │
 │  }                                               │
 │                                                  │
 │  Write assembled flows to the knowledge graph    │
 │  as edges connecting existing nodes.             │
 └─────────────────────────────────────────────────┘
```

---

## 5. Data Model

### 5.1 Knowledge Graph Node Types

```
┌─────────────────────────────────────────────────────────────┐
│                     Node Types                               │
├──────────────────────┬──────────────────────────────────────┤
│ ClientSideProcess    │ id: string                           │
│                      │ type: "ui_action" | "event_handler"  │
│                      │       | "lifecycle_hook" | "other"   │
│                      │ name: string                         │
│                      │ source_file: string                  │
│                      │ source_line: number                  │
│                      │ framework: string                    │
│                      │ repository: string                   │
│                      │ invokes_api_callers: boolean         │
│                      │ detail: ProcessDetail | null         │
├──────────────────────┼──────────────────────────────────────┤
│ ClientSideAPICaller  │ id: string                           │
│                      │ name: string                         │
│                      │ source_file: string                  │
│                      │ source_line: number                  │
│                      │ framework: string                    │
│                      │ repository: string                   │
│                      │ target_endpoints: string[]           │
│                      │ detail: CallerDetail | null          │
├──────────────────────┼──────────────────────────────────────┤
│ APIEndpoint          │ id: string                           │
│                      │ http_method: string                  │
│                      │ route_path: string                   │
│                      │ source_file: string                  │
│                      │ source_line: number                  │
│                      │ framework: string                    │
│                      │ repository: string                   │
│                      │ detail: EndpointDetail | null        │
├──────────────────────┼──────────────────────────────────────┤
│ DatabaseTable        │ id: string                           │
│                      │ name: string                         │
│                      │ schema: string | null                │
│                      │ repository: string | null            │
└──────────────────────┴──────────────────────────────────────┘
```

### 5.2 Knowledge Graph Edge Types

```
┌─────────────────────┬────────────────────┬─────────────────────┐
│ Edge Type           │ From -> To         │ Properties           │
├─────────────────────┼────────────────────┼─────────────────────┤
│ INVOKES             │ Process -> Caller  │ stitching_method:    │
│                     │                    │   "deterministic" |  │
│                     │                    │   "ai-contextual" |  │
│                     │                    │   "user-resolved"    │
├─────────────────────┼────────────────────┼─────────────────────┤
│ CALLS               │ Caller -> Endpoint │ stitching_method     │
│                     │                    │ request_schema: JSON │
├─────────────────────┼────────────────────┼─────────────────────┤
│ READS_FROM          │ Endpoint -> Table  │ query_type: "SELECT" │
│                     │                    │ description: string  │
├─────────────────────┼────────────────────┼─────────────────────┤
│ WRITES_TO           │ Endpoint -> Table  │ query_type: "INSERT" │
│                     │                    │   | "UPDATE"         │
│                     │                    │   | "DELETE"          │
│                     │                    │ description: string  │
├─────────────────────┼────────────────────┼─────────────────────┤
│ RESPONDS_TO         │ Endpoint -> Caller │ response_schema: JSON│
│                     │                    │ status_codes: int[]  │
├─────────────────────┼────────────────────┼─────────────────────┤
│ PART_OF_FLOW        │ any node -> Flow   │ position: number     │
│                     │                    │ (order in the chain) │
└─────────────────────┴────────────────────┴─────────────────────┘
```

### 5.3 Detail Objects

These are attached as properties on their respective nodes.

**EndpointDetail (R-4.1.x)**
```json
{
  "code_flow": [ { "step": 1, "description": "...", "source_ref": "file:line" } ],
  "request_schema": { "parameters": {}, "body": {}, "headers": {} },
  "response_schemas": [
    { "status_code": 200, "body": {} },
    { "status_code": 400, "body": {} }
  ],
  "database_interactions": [
    { "table": "users", "operation": "SELECT", "description": "..." }
  ],
  "error_handling": [
    { "condition": "...", "response_code": 400, "description": "..." }
  ]
}
```

**CallerDetail (R-4.2.x)**
```json
{
  "function_signature": "...",
  "module_location": "file:line",
  "invoked_by": [ { "process_id": "...", "description": "..." } ],
  "code_flow": [ { "step": 1, "description": "...", "source_ref": "file:line" } ],
  "api_calls": [
    {
      "endpoint_id": "...",
      "http_method": "POST",
      "request_structure": {},
      "response_structure": {}
    }
  ],
  "response_handling": {
    "state_updates": [ "..." ],
    "dom_changes": [ "..." ],
    "error_handling": [ "..." ]
  }
}
```

**ProcessDetail (R-4.3.x)**
```json
{
  "trigger": { "type": "button_click", "element": "...", "source_ref": "file:line" },
  "code_flow": [ { "step": 1, "description": "...", "source_ref": "file:line" } ],
  "api_callers_invoked": [ { "caller_id": "...", "description": "..." } ],
  "is_local_only": false,
  "local_effects": {
    "state_changes": [ "..." ],
    "dom_updates": [ "..." ]
  }
}
```

### 5.4 Flow Object

A flow is not a separate node but a named traversal path through the graph:

```json
{
  "flow_id": "flow_submit_order",
  "name": "Submit Order",
  "chain": [
    { "layer": "process",    "node_id": "proc_001", "stitching": "deterministic" },
    { "layer": "caller",     "node_id": "call_005", "stitching": "deterministic" },
    { "layer": "endpoint",   "node_id": "ep_012",   "stitching": "ai-contextual" },
    { "layer": "database",   "node_id": "tbl_003",  "stitching": "deterministic" },
    { "layer": "response",   "endpoint_to_caller": true },
    { "layer": "dom_update", "description": "Order confirmation displayed" }
  ],
  "version": "2026-04-04T19:30:00Z"
}
```

### 5.5 Project and Resolution Models

**Project**
```json
{
  "project_id": "proj_001",
  "name": "E-Commerce App",
  "repositories": [
    { "url": "...", "local_path": "...", "label": "client" },
    { "url": "...", "local_path": "...", "label": "server" },
    { "url": "...", "local_path": "...", "label": "database migrations" }
  ],
  "last_analysis": "2026-04-04T19:30:00Z"
}
```

**Ambiguity Resolution**
```json
{
  "resolution_id": "res_001",
  "ambiguous_reference": "fetch(`/api/${resource}/${id}`)",
  "source_file": "src/api/client.js",
  "source_line": 42,
  "resolved_endpoint_id": "ep_012",
  "resolution_method": "user-resolved",
  "resolved_at": "2026-04-04T19:35:00Z",
  "code_hash": "a1b2c3d4"
}
```

---

## 6. Agent Communication Architecture

### 6.1 Message Protocol

All inter-agent communication uses JSON Schema-validated messages (R-11.1.1). Every message follows this envelope:

```json
{
  "$schema": "https://veoable.dev/schemas/agent-message/v1",
  "message_id": "uuid",
  "from_agent": "express-endpoint-detector",
  "to_agent": "api-list-generator",
  "message_type": "detection_result",
  "timestamp": "ISO-8601",
  "payload": { }
}
```

### 6.2 Agent Hierarchy

```
                    Analysis Orchestrator
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
      ┌──────────┐  ┌──────────┐  ┌──────────┐
      │ API List │  │ Caller   │  │ Process  │
      │ Generator│  │ List Gen │  │ List Gen │
      │ Agent    │  │ Agent    │  │ Agent    │
      └────┬─────┘  └────┬─────┘  └────┬─────┘
           │              │              │
     ┌─────┼─────┐  ┌────┼────┐   ┌────┼────┐
     ▼     ▼     ▼  ▼    ▼    ▼   ▼    ▼    ▼
  Express Flask Gin React Vue Svlt React Vue Svlt
  Agent  Agent Agnt Agnt Agnt Agnt Agnt  Agnt Agnt
```

The orchestrator tells each aggregator which repositories and frameworks to analyze. Each aggregator spawns the relevant framework agents, collects their results, and writes the consolidated output to the knowledge graph.

### 6.3 Adding a New Framework Agent

To add support for a new framework (R-11.2.3, R-11.3.3):

1. Implement a new framework agent conforming to the agent interface (accepts repository path, returns JSON Schema-conformant detection results).
2. Register the agent with the appropriate aggregator (endpoint, caller, or process).
3. The agent runtime and aggregator handle routing automatically — no changes to existing agents, the orchestrator, or the service layer.

---

## 7. Analysis Pipeline

The analysis orchestrator coordinates the following pipeline when analysis is triggered (UC-2, UC-18):

```
 User triggers analysis
         │
         ▼
 ┌───────────────────┐
 │ 1. Resolve Project│  Load project config, repository paths, labels.
 │    Configuration  │  On re-analysis, load previous graph version.
 └────────┬──────────┘
          │
          ▼
 ┌───────────────────┐
 │ 2. Framework      │  Scan each repository to determine which
 │    Detection      │  languages and frameworks are present.
 │                   │  Use repo labels as hints (client vs. server).
 └────────┬──────────┘
          │
          ▼
 ┌───────────────────┐
 │ 3. Run Detection  │  Launch all three detection engines in parallel.
 │    Engines        │  Each engine spawns relevant framework agents.
 │    (parallel)     │  Aggregators compile and write to graph.
 │                   │  >> Notification: "Detection complete" <<
 └────────┬──────────┘
          │
          ▼
 ┌───────────────────┐
 │ 4. Run Detail     │  For each discovered node, run the appropriate
 │    Analyzers      │  detail analyzer. Can run in parallel across
 │    (parallel)     │  nodes. Attach detail objects to graph nodes.
 │                   │  >> Notification: "Detail analysis complete" <<
 └────────┬──────────┘
          │
          ▼
 ┌───────────────────┐
 │ 5. Run Flow       │  Deterministic stitching first.
 │    Stitcher       │  Check Resolution Store for known ambiguities.
 │                   │  Prompt user or delegate to AI for remaining.
 │                   │  >> Notification: "Ambiguity needs resolution" <<
 │                   │  >> (pauses per-flow until resolved)           <<
 │                   │  Write assembled flows to graph.
 └────────┬──────────┘
          │
          ▼
 ┌───────────────────┐
 │ 6. Version and    │  Stamp graph with version/timestamp.
 │    Finalize       │  On re-analysis: diff against previous version,
 │                   │  produce change summary (R-9.3).
 │                   │  >> Notification: "Analysis complete" <<
 └────────┬──────────┘
          │
          ▼
    Knowledge Graph
     ready to query
```

---

## 8. Query Execution Paths

### 8.1 Human Query (NLP or Graphical)

```
User ──► NLP Interface ──► Unified Interface Layer ──► API Gateway
              or                                           │
         Graphical Interface                               │
                                                           ▼
                                                    Query Service
                                                    (search, impact,
                                                     dead code, etc.)
                                                           │
                                                           ▼
                                                    Knowledge Graph
                                                           │
                                                           ▼
                                                    Response Formatter
                                                    (text / JSON / visual)
                                                           │
                                                           ▼
                                              Unified Interface Layer
                                              ┌────────────┴────────────┐
                                              ▼                         ▼
                                         NLP response           Graph highlight /
                                         (natural language)     visual diagram
```

### 8.2 AI Query (MCP)

```
AI Assistant ──► MCP Server ──► API Gateway ──► Query Service
                                                     │
                                                     ▼
                                              Knowledge Graph
                                                     │
                                                     ▼
                                              Response Formatter
                                              (JSON only)
                                                     │
                                                     ▼
                                              MCP Server ──► AI Assistant
```

### 8.3 Impact Analysis Query

```
User: "What is affected if I change POST /api/orders?"
                          │
                          ▼
                   Impact Analysis Service
                          │
      ┌───────────────────┼───────────────────────┐
      │                   │                       │
      ▼                   ▼                       ▼
 Find callers       Find DB tables          Find sibling
 that CALL          endpoint READS_FROM     endpoints sharing
 this endpoint      or WRITES_TO            same tables
      │                   │                       │
      ▼                   │                       │
 Find processes           │                       │
 that INVOKE              │                       │
 those callers            │                       │
      │                   │                       │
      └───────────────────┼───────────────────────┘
                          │
                          ▼
                  Collect all affected
                  nodes and subgraph
                          │
                    ┌─────┴─────┐
                    ▼           ▼
              Component     Visual
              list          subgraph
```

---

## 9. Interface Component Architecture

### 9.1 NLP Interface Internals

```
┌────────────────────────────────────────────────────┐
│                  NLP Interface                      │
│                                                    │
│  ┌──────────────┐    ┌──────────────────────────┐  │
│  │ Input Parser │───►│ Intent Classifier         │  │
│  │              │    │                           │  │
│  └──────────────┘    │ Intents:                  │  │
│                      │  - create_project         │  │
│                      │  - add_repository         │  │
│                      │  - trigger_analysis       │  │
│                      │  - query_endpoints        │  │
│                      │  - query_callers          │  │
│                      │  - query_processes        │  │
│                      │  - query_flow             │  │
│                      │  - impact_analysis        │  │
│                      │  - dead_code_check        │  │
│                      │  - deploy_readiness       │  │
│                      │  - export_data            │  │
│                      └─────────────┬────────────┘  │
│                                    │               │
│                                    ▼               │
│                      ┌──────────────────────────┐  │
│                      │ Query Builder             │  │
│                      │ (translates intent +      │  │
│                      │  entities into structured │  │
│                      │  API calls)               │  │
│                      └─────────────┬────────────┘  │
│                                    │               │
│                                    ▼               │
│                           Service Layer API        │
└────────────────────────────────────────────────────┘
```

### 9.2 Graphical Interface Internals

```
┌────────────────────────────────────────────────────┐
│              Graphical Interface                    │
│                                                    │
│  ┌───────────────────────────────────────────────┐ │
│  │ Graph Renderer                                │ │
│  │                                               │ │
│  │  - Layered layout engine                      │ │
│  │    (processes → callers → endpoints → tables) │ │
│  │  - Zoom / pan controls                        │ │
│  │  - Node click → detail panel                  │ │
│  │  - Edge hover → relationship info             │ │
│  │  - Subgraph highlighting API                  │ │
│  │    (driven by NLP queries via Unified Layer)  │ │
│  └───────────────────────────────────────────────┘ │
│                                                    │
│  ┌───────────────┐  ┌────────────────────────────┐ │
│  │ Filter Panel  │  │ Detail Panel               │ │
│  │               │  │                            │ │
│  │ - Repository  │  │ Shows EndpointDetail,      │ │
│  │ - Framework   │  │ CallerDetail, or           │ │
│  │ - Element type│  │ ProcessDetail for the      │ │
│  │ - Flow        │  │ selected node.             │ │
│  └───────────────┘  │                            │ │
│                     │ Tabs: Text | JSON | Diagram│ │
│  ┌───────────────┐  └────────────────────────────┘ │
│  │ Project Panel │                                 │
│  │               │                                 │
│  │ - Create/edit │                                 │
│  │   projects    │                                 │
│  │ - Add repos   │                                 │
│  │ - Set labels  │                                 │
│  │ - Trigger     │                                 │
│  │   analysis    │                                 │
│  └───────────────┘                                 │
└────────────────────────────────────────────────────┘
```

---

## 10. MCP Server Tool Definitions

The MCP server exposes the following tools to AI systems:

| Tool Name | Description | Input | Output |
|---|---|---|---|
| `get_flow` | Retrieve a complete end-to-end flow | `{ flow_id }` or `{ query: "..." }` | Flow JSON (Section 5.4) |
| `list_flows` | List all flows, optionally filtered | `{ filter: { process?, endpoint?, table? } }` | Array of flow summaries |
| `get_endpoint_detail` | Get full analysis of an endpoint | `{ endpoint_id }` or `{ method, path }` | EndpointDetail JSON |
| `get_caller_detail` | Get full analysis of an API caller | `{ caller_id }` | CallerDetail JSON |
| `get_process_detail` | Get full analysis of a process | `{ process_id }` | ProcessDetail JSON |
| `list_endpoints` | List all endpoints with filters | `{ filter: { method?, path?, framework?, repo? } }` | Array of endpoint summaries |
| `list_callers` | List all API callers with filters | `{ filter: { endpoint?, framework?, repo? } }` | Array of caller summaries |
| `list_processes` | List all processes with filters | `{ filter: { type?, framework?, repo? } }` | Array of process summaries |
| `impact_analysis` | Get blast radius of a component | `{ component_id, component_type }` | Affected components list |
| `find_dead_code` | Find orphaned components | `{ type?: "endpoint" \| "caller" \| "process" }` | Orphaned component list |

---

## 11. Incremental Re-Analysis Design

When re-analysis is triggered (UC-18), the system follows a modified pipeline:

```
 ┌──────────────────────────────────────────────────┐
 │ 1. Snapshot current graph as "previous version"  │
 └──────────────────────┬───────────────────────────┘
                        │
 ┌──────────────────────▼───────────────────────────┐
 │ 2. Run full detection + analysis pipeline        │
 │    (same as initial analysis, Section 7)         │
 └──────────────────────┬───────────────────────────┘
                        │
 ┌──────────────────────▼───────────────────────────┐
 │ 3. Consult Resolution Store for ambiguities      │
 │    - If code_hash matches: reuse resolution      │
 │    - If code_hash differs: re-prompt user or AI  │
 └──────────────────────┬───────────────────────────┘
                        │
 ┌──────────────────────▼───────────────────────────┐
 │ 4. Diff new graph against previous version       │
 │                                                  │
 │    Change summary includes:                      │
 │    - Added nodes and edges                       │
 │    - Removed nodes and edges                     │
 │    - Modified nodes (detail changes)             │
 │    - New flows, removed flows, changed flows     │
 └──────────────────────┬───────────────────────────┘
                        │
 ┌──────────────────────▼───────────────────────────┐
 │ 5. Stamp new graph version, store diff           │
 │    Notify user with change summary               │
 └──────────────────────────────────────────────────┘
```

---

## 12. Requirements Traceability

| Architecture Component | Requirements | Use Cases |
|---|---|---|
| NLP Interface | R-8.1.x | UC-1 through UC-9, UC-11, UC-12, UC-13, UC-15, UC-18, UC-19, UC-20 |
| Graphical Interface | R-8.2.x | UC-1, UC-2, UC-3, UC-5, UC-7, UC-9, UC-11, UC-13, UC-17, UC-18 |
| Unified Interface Layer | R-8.3.x | UC-4, UC-6, UC-8, UC-9, UC-11, UC-13, UC-17 |
| API Gateway | R-8.1.x, R-8.2.x, R-6.2.x | All |
| Query Search & Filter | R-7.1.x | UC-3, UC-5, UC-7, UC-9 |
| Impact Analysis Service | R-7.2.x | UC-11, UC-20 |
| Dead Code Detection | R-7.3.x | UC-19 |
| Deploy Readiness Service | R-7.4.x | UC-20 |
| Data Export Service | R-7.5.x | UC-16 |
| Analysis Orchestrator | R-3.x, R-4.x, R-5.x, R-9.x, R-10.x | UC-2, UC-10, UC-18 |
| MCP Server | R-6.2.x | UC-14 |
| Notification Service | R-10.x | UC-2, UC-10, UC-18 |
| Response Formatter | R-4.1.5, R-4.2.7, R-4.3.5, R-8.3.x | UC-4, UC-6, UC-8, UC-9, UC-13, UC-17 |
| Agent Runtime | R-11.1.1, R-11.3.x | UC-2, UC-18 |
| API Endpoint Detection Engine | R-3.1.x | UC-2, UC-3, UC-16 |
| Client-Side Caller Detection Engine | R-3.2.x | UC-2, UC-5, UC-16 |
| Client-Side Process Detection Engine | R-3.3.x | UC-2, UC-7 |
| Endpoint Detail Analyzer | R-4.1.x | UC-4, UC-12, UC-15, UC-16 |
| Caller Detail Analyzer | R-4.2.x | UC-6, UC-15 |
| Process Detail Analyzer | R-4.3.x | UC-8, UC-15 |
| Flow Stitcher | R-5.x | UC-2, UC-9, UC-10, UC-12, UC-15, UC-20 |
| Knowledge Graph | R-6.1.x | UC-2, UC-3, UC-5, UC-7, UC-9, UC-11, UC-13, UC-14, UC-16, UC-17, UC-19, UC-20 |
| Project Store | R-11.4.x | UC-1 |
| Resolution Store | R-5.6, R-9.4 | UC-10, UC-18 |
| Version / Snapshot Store | R-6.1.5, R-9.x | UC-18, UC-20 |
