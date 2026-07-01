# Veoable - Requirements Document

## 1. Overview

Veoable is a code analysis platform that takes code written by AI (or humans) and analyzes it in explainable ways. It builds a knowledge graph of API endpoints, client-side API callers, and UI interaction elements across multiple repositories. It then stitches together end-to-end flows so a user can trace what happens from a user interaction through API calls, database interactions, responses, and DOM updates. This compressed context can be fed back to AI for more accurate debugging, fixing, and feature work.

## 2. System Architecture

The system is composed of the following major subsystems:

1. **Detection Engines** - Modular, multi-language/framework agents that discover code elements
2. **Detail Analyzers** - Deep analysis of individual code elements (endpoints, callers, processes)
3. **Flow Stitcher** - Connects discovered elements into end-to-end flows
4. **Knowledge Graph** - Stores all derived information as a queryable graph
5. **Query and Analysis Services** - Impact analysis, dead code detection, deploy readiness, and search/filter
6. **MCP Server** - Exposes the knowledge graph to AI systems
7. **NLP Interface** - Natural language interaction with the system
8. **Graphical Interface** - Visual interaction with the knowledge graph
9. **Unified Interface Layer** - Connects NLP and graphical interfaces

---

## 3. Detection Engines

### 3.1 API Endpoint Detection Engine (Issue #1)

**Purpose:** Detect all API endpoints present in backend codebases.

**Use Cases:** UC-2, UC-3, UC-16

**Requirements:**

- R-3.1.1: The engine MUST be modular, with a separate module (agent) per language/framework.
- R-3.1.2: The following language/framework modules MUST be supported:
  - JavaScript backend frameworks (Express, Fastify, Koa, Hapi, NestJS, etc.)
  - Python backend frameworks (Flask, Django, FastAPI, etc.)
  - Rust backend frameworks (Actix, Axum, Rocket, etc.)
  - Go backend frameworks (net/http, Gin, Echo, Fiber, etc.)
- R-3.1.3: Each framework module acts as an independent agent focused on its own language and framework.
- R-3.1.4: All agents MUST report to a central **API List Generator Agent** which compiles results from all framework agents.
- R-3.1.5: Communication between agents MUST use JSON Schema for structured data exchange.
- R-3.1.6: The API List Generator Agent MUST present compiled results to the user.
- R-3.1.7: Each detected endpoint MUST include at minimum: HTTP method, route path, source file location, and framework identifier.

### 3.2 Client-Side API Caller Detection Engine (Issue #2)

**Purpose:** Detect all client-side API callers that invoke API endpoints.

**Use Cases:** UC-2, UC-5, UC-16

**Requirements:**

- R-3.2.1: The engine MUST be modular, with a separate module (agent) per language/framework.
- R-3.2.2: The following language/framework modules MUST be supported:
  - JavaScript frontend frameworks (React, Vue, Angular, Svelte, etc.)
  - Python client code
  - Rust client code
  - Go client code
- R-3.2.3: Each framework module acts as an independent agent focused on its own language and framework.
- R-3.2.4: All agents MUST report to a central **API Caller List Generator Agent** which compiles results.
- R-3.2.5: Communication between agents MUST use JSON Schema for structured data exchange.
- R-3.2.6: The API Caller List Generator Agent MUST present compiled results to the user.
- R-3.2.7: Each detected caller MUST include at minimum: source file location, the endpoint(s) it calls, and framework identifier.

### 3.3 Client-Side Process Detection Engine (Issue #3)

**Purpose:** Detect client-side processes (e.g., UI actions, event handlers) that invoke client-side API callers.

**Use Cases:** UC-2, UC-7

**Requirements:**

- R-3.3.1: The engine MUST be modular, with a separate module (agent) per language/framework.
- R-3.3.2: The following language/framework modules MUST be supported:
  - JavaScript frontend frameworks (React, Vue, Angular, Svelte, etc.)
  - Python client code
  - Rust client code
  - Go client code
- R-3.3.3: Each framework module acts as an independent agent focused on its own language and framework.
- R-3.3.4: All agents MUST report to a central **Client-Side List Generator Agent** which compiles results.
- R-3.3.5: Communication between agents MUST use JSON Schema for structured data exchange.
- R-3.3.6: The Client-Side List Generator Agent MUST present compiled results to the user.
- R-3.3.7: Each detected process MUST include at minimum: process type (UI action, event handler, lifecycle hook, etc.), source file location, framework identifier, and whether it invokes API callers or is purely local.

---

## 4. Detail Analyzers

### 4.1 API Endpoint Detail Analyzer (Issue #5)

**Purpose:** Provide deep analysis of how a specific API endpoint functions.

**Use Cases:** UC-4, UC-12, UC-15, UC-16

**Requirements:**

- R-4.1.1: For each API endpoint, the system MUST discover and present the code flow and logic.
- R-4.1.2: The system MUST discover the format of requests (parameters, body schema, headers) and responses (status codes, body schema) between the endpoint and its callers.
- R-4.1.3: The system MUST discover all database interactions performed by the endpoint, including the nature of each interaction (SELECT, INSERT, UPDATE, DELETE) and the tables involved.
- R-4.1.4: The system MUST discover error handling paths within the endpoint, including what error responses are returned under what conditions.
- R-4.1.5: Output MUST be available in three formats: natural language explanation, JSON, and visual flow diagram.

### 4.2 Client-Side API Caller Detail Analyzer (Issue #6)

**Purpose:** Provide deep analysis of how a client-side API caller is structured and behaves.

**Use Cases:** UC-6, UC-15

**Requirements:**

- R-4.2.1: The system MUST show the structure of the client-side API caller (function signature, module location).
- R-4.2.2: The system MUST show how the API caller gets invoked (which processes/components call it).
- R-4.2.3: The system MUST show the code flow when the caller executes.
- R-4.2.4: The system MUST show which API calls the caller makes (endpoints, HTTP methods).
- R-4.2.5: The system MUST show the structure of the request sent to each endpoint and the response received.
- R-4.2.6: The system MUST show how the response is handled (state updates, DOM changes, error handling).
- R-4.2.7: Output MUST be available in three formats: natural language explanation, JSON, and visual flow diagram.

### 4.3 Client-Side Process Detail Analyzer (Issue #7)

**Purpose:** Provide deep analysis of any client-side process.

**Use Cases:** UC-8, UC-15

**Requirements:**

- R-4.3.1: The system MUST discover and show the logic and code flow when a client-side process is invoked.
- R-4.3.2: The system MUST show how the process is invoked (e.g., button click, form submit, route change, programmatic trigger).
- R-4.3.3: If the process invokes an API caller, the system MUST show which API caller is invoked and which API endpoint gets called.
- R-4.3.4: If the client-side process is purely local (no API calls), this MUST be indicated, along with what state changes or DOM updates it performs.
- R-4.3.5: Output MUST be available in three formats: natural language explanation, JSON, and visual flow diagram.

---

## 5. End-to-End Flow Stitcher (Issue #4)

**Purpose:** Build a complete picture of end-to-end flows from client-side process through to database and back.

**Use Cases:** UC-2, UC-9, UC-10, UC-12, UC-15, UC-20

**Requirements:**

- R-5.1: The system MUST build a list of all end-to-end flows beginning at a client-side process.
- R-5.2: Each flow MUST show the following chain:
  1. Client-side process (e.g., UI action)
  2. Client-side API caller(s) invoked
  3. API endpoint(s) called
  4. Business logic (validation, transformations, orchestration in the backend)
  5. Database interactions performed
  6. Responses from each layer back to the client
  7. Handling of the response on the client side, including DOM changes
- R-5.3: The stitching mechanism MUST use **deterministic methods** as much as possible (e.g., direct code references, import chains, explicit URL matching).
- R-5.4: When deterministic stitching is not possible (e.g., the API endpoint URL is constructed differently on client vs. server), the system MUST support two fallback strategies:
  - **Human-in-the-loop:** Present the user with the ambiguous caller, a list of candidate endpoints, and allow the user to manually select the correct match or provide additional context.
  - **AI contextual analysis:** Delegate to AI to perform contextual matching and provide the mapping.
- R-5.5: The system MUST clearly indicate which parts of a flow were stitched deterministically and which required contextual analysis.
- R-5.6: User-provided resolutions for ambiguous stitching MUST be recorded and persisted so they are reused on subsequent analyses without re-prompting.

---

## 6. Knowledge Graph and MCP Server (Issue #8)

**Purpose:** Store all derived information in a queryable graph and expose it to AI systems.

### 6.1 Knowledge Graph

**Use Cases:** UC-2, UC-3, UC-5, UC-7, UC-9, UC-11, UC-13, UC-14, UC-16, UC-17, UC-19, UC-20

**Requirements:**

- R-6.1.1: The graph MUST consist of **nodes** representing:
  - Client-side processes / UI actions
  - Client-side API callers
  - API endpoints
  - Database tables
- R-6.1.2: The graph MUST have **edges/connections** representing the relationships between these nodes, including:
  - "invokes" (process -> caller)
  - "calls" (caller -> endpoint)
  - "reads from" / "writes to" (endpoint -> table)
  - "responds to" (endpoint -> caller, for response flow)
- R-6.1.3: Results of all analysis done by other subsystems (detection engines, detail analyzers, flow stitcher) MUST be stored in this graph.
- R-6.1.4: The graph MUST be queryable by other systems to answer questions about the codebase.
- R-6.1.5: The graph MUST support versioning or timestamps so that changes between analyses can be identified.

### 6.2 MCP Server

**Use Cases:** UC-14

**Requirements:**

- R-6.2.1: An MCP (Model Context Protocol) server MUST be provided.
- R-6.2.2: The MCP server MUST allow AI systems to query the knowledge graph and ask questions about the codebase.
- R-6.2.3: The MCP server MUST support querying for complete end-to-end flows, returning the full stitched chain (process -> caller -> endpoint -> database -> responses -> DOM update) in a structured JSON format.
- R-6.2.4: The MCP server MUST support querying for details of individual elements (endpoints, callers, processes).
- R-6.2.5: The MCP server MUST support impact analysis queries (given a component, return all affected components).

---

## 7. Query and Analysis Services

### 7.1 Search and Filtering

**Purpose:** Allow users to search and filter across all discovered elements.

**Use Cases:** UC-3, UC-5, UC-7, UC-9

**Requirements:**

- R-7.1.1: Users MUST be able to filter API endpoints by HTTP method, route path, framework, and repository.
- R-7.1.2: Users MUST be able to filter client-side API callers by endpoint called, framework, and repository.
- R-7.1.3: Users MUST be able to filter client-side processes by type (UI action, event handler, lifecycle hook), framework, repository, and whether they invoke API callers.
- R-7.1.4: Users MUST be able to search across all element types by keyword.
- R-7.1.5: Filtering and search MUST be available in both the NLP and graphical interfaces.

### 7.2 Impact Analysis

**Purpose:** Determine the blast radius of a proposed change to any component.

**Use Cases:** UC-11, UC-20

**Requirements:**

- R-7.2.1: Given a component (endpoint, caller, process, or database table), the system MUST traverse the knowledge graph and return all directly and transitively affected components.
- R-7.2.2: Impact analysis for an API endpoint MUST identify: all client-side callers that call it, all client-side processes that invoke those callers, all database tables it interacts with, and all other endpoints that share those tables.
- R-7.2.3: Impact analysis for a client-side process MUST identify: all callers it invokes, all endpoints those callers hit, and all database tables involved.
- R-7.2.4: The impact MUST be presentable as a list of affected components and as a visual subgraph.
- R-7.2.5: Users MUST be able to drill into any affected component for its full details.

### 7.3 Dead Code and Orphan Detection

**Purpose:** Identify components that are not connected to any active flow.

**Use Cases:** UC-19

**Requirements:**

- R-7.3.1: The system MUST detect API endpoint nodes with no incoming edges from any API caller ("uncalled endpoints").
- R-7.3.2: The system MUST detect API caller nodes with no incoming edges from any client-side process ("unreachable callers").
- R-7.3.3: The system MUST detect client-side processes that are not reachable from any UI element ("orphaned processes").
- R-7.3.4: The system MUST detect endpoints that are referenced by callers but are not defined in any analyzed repository ("missing endpoints").
- R-7.3.5: Results MUST be presented as a list of orphaned components, categorized by type.

### 7.4 Deploy Readiness and Change Impact

**Purpose:** Determine which end-to-end flows are affected by a set of code changes.

**Use Cases:** UC-20

**Requirements:**

- R-7.4.1: Given a list of changed components (endpoints, callers, processes, or files), the system MUST identify all end-to-end flows that pass through those components.
- R-7.4.2: For each affected flow, the system MUST highlight which layers in the flow are touched by the changes.
- R-7.4.3: Results MUST be presentable as a list and as a visual flow diagram with changed layers highlighted.

### 7.5 Data Export

**Purpose:** Allow users to export analysis results for external consumption.

**Use Cases:** UC-16

**Requirements:**

- R-7.5.1: Users MUST be able to export any query result, report, or analysis output as JSON.
- R-7.5.2: Exported JSON MUST use the same schemas used for inter-agent communication.

---

## 8. User Interfaces

### 8.1 NLP Interface (Issue #9)

**Purpose:** Allow users to interact with the system using natural language.

**Use Cases:** UC-1, UC-2, UC-3, UC-4, UC-5, UC-6, UC-7, UC-8, UC-9, UC-11, UC-12, UC-13, UC-15, UC-18, UC-19, UC-20

**Requirements:**

- R-8.1.1: Users MUST be able to **create a project** that groups together multiple repositories.
- R-8.1.2: Users MUST be able to optionally **label repositories** to describe whether they contain client-side code or API endpoint code.
- R-8.1.3: Users MUST be able to trigger **analysis of repositories** for knowledge graph creation.
- R-8.1.4: Users MUST be able to trigger **re-analysis** to update the knowledge graph after code changes.
- R-8.1.5: Users MUST be able to **ask questions** about the knowledge graph and receive natural language responses.
- R-8.1.6: Users MUST be able to invoke all query and analysis services (search/filter, impact analysis, dead code detection, deploy readiness) via natural language.

### 8.2 Graphical Interface (Issue #10)

**Purpose:** Allow users to interact with the system through a visual interface.

**Use Cases:** UC-1, UC-2, UC-3, UC-5, UC-7, UC-9, UC-11, UC-13, UC-17, UC-18

**Requirements:**

- R-8.2.1: Users MUST be able to **create a project** that groups together multiple repositories.
- R-8.2.2: Users MUST be able to optionally **label repositories** to describe whether they contain client-side code or API endpoint code.
- R-8.2.3: Users MUST be able to trigger **analysis of repositories** for knowledge graph creation.
- R-8.2.4: Users MUST be able to trigger **re-analysis** to update the knowledge graph after code changes.
- R-8.2.5: Users MUST be able to **ask questions** about the knowledge graph and see visual responses.
- R-8.2.6: The knowledge graph MUST be rendered as an **interactive diagram** with the following capabilities:
  - Zoom and pan.
  - Filter by repository, framework, element type, or flow.
  - Click on any node to drill into its details (endpoint detail, caller detail, process detail).
  - Layered layout: client-side processes as entry points, API callers as intermediate nodes, API endpoints as backend nodes, database tables as data layer nodes, with edges showing data flow.
- R-8.2.7: The graphical interface MUST support highlighting specific subgraphs in response to NLP queries.

### 8.3 Unified Interface Layer (Issue #11)

**Purpose:** Connect the NLP and graphical interfaces so users get both textual and visual responses.

**Use Cases:** UC-4, UC-6, UC-8, UC-9, UC-11, UC-13, UC-17

**Requirements:**

- R-8.3.1: Users MUST be able to ask questions via the NLP interface and receive responses in **natural language form**.
- R-8.3.2: Users MUST be able to ask questions via the NLP interface and receive responses in **graphical/diagram form**.
- R-8.3.3: The system MUST allow the user to choose the response format: text only, visual only, or both.

---

## 9. Incremental Re-Analysis

**Purpose:** Keep the knowledge graph up to date as the codebase evolves.

**Use Cases:** UC-18

**Requirements:**

- R-9.1: The system MUST support re-running analysis on a previously analyzed project.
- R-9.2: On re-analysis, the system MUST update the knowledge graph to reflect new, modified, and removed elements.
- R-9.3: The system MUST provide a summary of what changed since the last analysis (added, modified, removed nodes and edges).
- R-9.4: Previously recorded ambiguity resolutions (R-5.6) MUST be preserved and reused unless the underlying code has changed.

---

## 10. Analysis Notifications

**Purpose:** Keep users informed of analysis progress and completion.

**Use Cases:** UC-2, UC-18

**Requirements:**

- R-10.1: The system MUST notify the user when analysis is complete.
- R-10.2: The system SHOULD provide progress indication during analysis (e.g., which engines are running, percentage complete).
- R-10.3: If the flow stitcher encounters ambiguities requiring human input, the system MUST notify the user and pause stitching for those flows until resolved.

---

## 11. Cross-Cutting Requirements

### 11.1 Data Format

- R-11.1.1: All inter-agent communication MUST use JSON Schema.
- R-11.1.2: All analysis output (endpoint details, caller details, process details, flows) MUST be available in JSON format.
- R-11.1.3: Exported data MUST use the same JSON schemas as inter-agent communication (R-7.5.2).

### 11.2 Multi-Language Support

- R-11.2.1: All detection engines MUST support JavaScript, Python, Rust, and Go.
- R-11.2.2: JavaScript support MUST cover multiple frameworks (both frontend and backend).
- R-11.2.3: The architecture MUST allow adding new language/framework modules without modifying the core system.

### 11.3 Agent Architecture

- R-11.3.1: Each language/framework module operates as an independent agent.
- R-11.3.2: Agents report to aggregator agents (API List Generator, API Caller List Generator, Client-Side List Generator).
- R-11.3.3: The system MUST support adding new agents for additional languages/frameworks.

### 11.4 Project Management

- R-11.4.1: The system MUST support the concept of a **project** that groups multiple repositories.
- R-11.4.2: Repositories within a project MUST be optionally labelable (e.g., "client", "server", "shared", "database migrations").

---

## 12. Issue Traceability Matrix

| Requirement Section | GitHub Issue(s) |
|---|---|
| 3.1 API Endpoint Detection | #1 |
| 3.2 Client-Side API Caller Detection | #2 |
| 3.3 Client-Side Process Detection | #3 |
| 4.1 API Endpoint Detail Analyzer | #5 |
| 4.2 Client-Side API Caller Detail Analyzer | #6 |
| 4.3 Client-Side Process Detail Analyzer | #7 |
| 5. End-to-End Flow Stitcher | #4 |
| 6. Knowledge Graph and MCP Server | #8 |
| 7. Query and Analysis Services | Derived from UC-11, UC-16, UC-19, UC-20 |
| 8.1 NLP Interface | #9 |
| 8.2 Graphical Interface | #10 |
| 8.3 Unified Interface Layer | #11 |
| 9. Incremental Re-Analysis | Derived from UC-18 |
| 10. Analysis Notifications | Derived from UC-2, UC-18 |

---

## 13. Use Case Traceability Matrix

| Requirement | Use Cases |
|---|---|
| R-3.1.x API Endpoint Detection | UC-2, UC-3, UC-16 |
| R-3.2.x Client-Side Caller Detection | UC-2, UC-5, UC-16 |
| R-3.3.x Client-Side Process Detection | UC-2, UC-7 |
| R-4.1.x Endpoint Detail Analyzer | UC-4, UC-12, UC-15, UC-16 |
| R-4.2.x Caller Detail Analyzer | UC-6, UC-15 |
| R-4.3.x Process Detail Analyzer | UC-8, UC-15 |
| R-5.x Flow Stitcher | UC-2, UC-9, UC-10, UC-12, UC-15, UC-20 |
| R-6.1.x Knowledge Graph | UC-2, UC-3, UC-5, UC-7, UC-9, UC-11, UC-13, UC-14, UC-16, UC-17, UC-19, UC-20 |
| R-6.2.x MCP Server | UC-14 |
| R-7.1.x Search and Filtering | UC-3, UC-5, UC-7, UC-9 |
| R-7.2.x Impact Analysis | UC-11, UC-20 |
| R-7.3.x Dead Code Detection | UC-19 |
| R-7.4.x Deploy Readiness | UC-20 |
| R-7.5.x Data Export | UC-16 |
| R-8.1.x NLP Interface | UC-1, UC-2, UC-3 through UC-9, UC-11, UC-12, UC-13, UC-15, UC-18, UC-19, UC-20 |
| R-8.2.x Graphical Interface | UC-1, UC-2, UC-3, UC-5, UC-7, UC-9, UC-11, UC-13, UC-17, UC-18 |
| R-8.3.x Unified Interface | UC-4, UC-6, UC-8, UC-9, UC-11, UC-13, UC-17 |
| R-9.x Incremental Re-Analysis | UC-18 |
| R-10.x Analysis Notifications | UC-2, UC-10, UC-18 |
