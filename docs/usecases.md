# Veoable - Use Cases Document

## 1. Personas

### P1: Frontend Developer
Builds and maintains client-side UI components, state management, and user interactions. Works primarily in JavaScript/TypeScript frameworks (React, Vue, Angular, etc.). Needs to understand how UI actions connect to backend APIs and how responses update the DOM.

### P2: Backend Developer
Builds and maintains API endpoints, business logic, middleware, and database interactions. Works in JavaScript (Node.js), Python, Rust, or Go. Needs to understand which clients call their endpoints and what request/response contracts are expected.

### P3: Full-Stack Developer
Works across both frontend and backend codebases. Responsible for features that span the entire stack. Needs to trace flows end-to-end and understand the impact of changes on both sides.

### P4: Tech Lead / Architect
Responsible for system design, code quality, and architectural decisions across repositories. Needs a high-level view of how components interact, where complexity lives, and how changes propagate through the system.

### P5: QA / Test Engineer
Designs and executes test plans. Needs to understand all the paths a user action can take through the system to ensure adequate coverage. Concerned with edge cases, error handling paths, and data flow correctness.

### P6: DevOps / SRE Engineer
Manages deployment pipelines, infrastructure, monitoring, and incident response. Needs to quickly understand which endpoints are involved in an incident, what database tables they touch, and what client-side behavior triggers the problematic flow.

### P7: Product Manager
Defines product requirements and priorities. Not deeply technical but needs to understand what user-facing features exist, how they work at a high level, and what the impact of proposed changes would be.

### P8: New Team Member / Onboarding Developer
Recently joined the team and is unfamiliar with the codebase. Needs to quickly build a mental model of how the application works, what the major flows are, and where specific functionality lives.

### P9: AI Coding Assistant (via MCP)
An AI system (e.g., Claude, Copilot) that assists developers with coding tasks. Needs structured, compressed context about the codebase to provide accurate suggestions for debugging, fixing, and extending code.

### P10: Support Engineer
Handles customer-reported issues and escalations. Needs to quickly trace a user-reported behavior back through the UI, API calls, and database to identify where the problem originates.

---

## 2. Use Cases

### UC-1: Set Up a Project

**Personas:** P1, P2, P3, P4, P6

**Description:** A user creates a new Veoable project that groups together the repositories that make up their application.

**Preconditions:** User has access to the repositories to be analyzed.

**Flow:**
1. User opens the NLP or graphical interface.
2. User creates a new project and gives it a name.
3. User adds one or more repositories to the project.
4. User optionally labels each repository (e.g., "client", "server", "shared", "database migrations").
5. System confirms the project has been created.

**Postconditions:** A project exists with the specified repositories and labels, ready for analysis.

**Requirements:** R-7.1.1, R-7.1.2, R-7.2.1, R-7.2.2, R-8.4.1, R-8.4.2

---

### UC-2: Analyze Repositories and Build Knowledge Graph

**Personas:** P3, P4, P6, P8

**Description:** A user triggers analysis of all repositories in a project. The system runs detection engines, detail analyzers, and the flow stitcher to populate the knowledge graph.

**Preconditions:** A project with repositories has been created (UC-1).

**Flow:**
1. User selects a project and triggers analysis via NLP or graphical interface.
2. System launches API Endpoint Detection Engine agents for each relevant backend repository/framework.
3. System launches Client-Side API Caller Detection Engine agents for each relevant client repository/framework.
4. System launches Client-Side Process Detection Engine agents for each relevant client repository/framework.
5. Aggregator agents compile results from framework-specific agents.
6. Detail analyzers run against each discovered element (endpoints, callers, processes).
7. Flow stitcher attempts to connect elements into end-to-end flows using deterministic methods.
8. Where deterministic stitching fails, the system either prompts the user or delegates to AI for contextual analysis.
9. All results are stored in the knowledge graph.
10. User is notified that analysis is complete.

**Postconditions:** Knowledge graph is populated with nodes (processes, callers, endpoints, tables) and edges (relationships and flows).

**Requirements:** R-3.1.1 through R-3.3.6, R-4.1.1 through R-4.3.5, R-5.1 through R-5.5, R-6.1.1 through R-6.1.4, R-7.1.3, R-7.2.3

---

### UC-3: Discover All API Endpoints

**Personas:** P2, P3, P4, P5, P6

**Description:** A user wants to see a complete list of all API endpoints across the backend repositories in their project.

**Preconditions:** Analysis has been run (UC-2).

**Flow:**
1. User asks "Show me all API endpoints" via NLP interface, or navigates to the endpoint list in the graphical interface.
2. System queries the knowledge graph for all API endpoint nodes.
3. System returns a list of endpoints with their HTTP methods, paths, and source locations.
4. User can filter or search the list by path, method, framework, or repository.

**Postconditions:** User has a comprehensive view of the API surface area.

**Requirements:** R-3.1.4, R-3.1.6, R-6.1.4, R-7.1.4, R-7.2.4

---

### UC-4: Explore API Endpoint Details

**Personas:** P2, P3, P5, P6, P10

**Description:** A user selects a specific API endpoint and wants to understand exactly how it works.

**Preconditions:** Analysis has been run (UC-2).

**Flow:**
1. User selects an endpoint from the list (UC-3) or asks "How does the POST /api/orders endpoint work?"
2. System retrieves the detail analysis for that endpoint from the knowledge graph.
3. System presents:
   - The code flow and business logic of the endpoint.
   - The request format (parameters, body schema, headers).
   - The response format (status codes, body schema).
   - All database tables read from or written to, and the nature of those interactions (SELECT, INSERT, UPDATE, DELETE).
4. User can view this as natural language explanation, JSON, or a visual flow diagram.

**Postconditions:** User understands the internal workings of the endpoint.

**Requirements:** R-4.1.1 through R-4.1.4, R-7.3.1, R-7.3.2

---

### UC-5: Discover All Client-Side API Callers

**Personas:** P1, P3, P4, P5

**Description:** A user wants to see all the places in the frontend code that make API calls.

**Preconditions:** Analysis has been run (UC-2).

**Flow:**
1. User asks "Show me all API callers" or navigates to the caller list in the graphical interface.
2. System queries the knowledge graph for all client-side API caller nodes.
3. System returns a list of callers with their source locations, the endpoints they call, and the frameworks they belong to.
4. User can filter by endpoint called, framework, or repository.

**Postconditions:** User has a complete view of all client-side code that communicates with the backend.

**Requirements:** R-3.2.4, R-3.2.6, R-6.1.4, R-7.1.4, R-7.2.4

---

### UC-6: Explore Client-Side API Caller Details

**Personas:** P1, P3, P5, P10

**Description:** A user selects a specific client-side API caller and wants to understand its structure and behavior.

**Preconditions:** Analysis has been run (UC-2).

**Flow:**
1. User selects a caller from the list (UC-5) or asks "How does the fetchUserProfile API caller work?"
2. System retrieves the detail analysis from the knowledge graph.
3. System presents:
   - The structure of the caller (function signature, module location).
   - How the caller gets invoked (which processes/components call it).
   - The code flow when the caller executes.
   - The API calls it makes (endpoints, HTTP methods).
   - The request structure sent to each endpoint.
   - The response structure received.
   - How the response is handled (state updates, DOM changes, error handling).
4. User can view as text, JSON, or visual diagram.

**Postconditions:** User understands the full behavior of the API caller.

**Requirements:** R-4.2.1 through R-4.2.7, R-7.3.1, R-7.3.2

---

### UC-7: Discover All Client-Side Processes

**Personas:** P1, P3, P4, P5, P7

**Description:** A user wants to see all user-facing interactions and client-side processes in the application.

**Preconditions:** Analysis has been run (UC-2).

**Flow:**
1. User asks "Show me all client-side processes" or navigates to the process list in the graphical interface.
2. System queries the knowledge graph for all client-side process nodes.
3. System returns a list of processes with their type (UI action, event handler, lifecycle hook, etc.), source location, and whether they invoke API callers or are purely local.
4. User can filter by type, framework, or whether the process makes API calls.

**Postconditions:** User has a complete inventory of client-side entry points.

**Requirements:** R-3.3.4, R-3.3.6, R-6.1.4, R-7.1.4, R-7.2.4

---

### UC-8: Explore Client-Side Process Details

**Personas:** P1, P3, P5, P7, P10

**Description:** A user selects a specific client-side process and wants to understand what it does.

**Preconditions:** Analysis has been run (UC-2).

**Flow:**
1. User selects a process from the list (UC-7) or asks "What happens when the user clicks the Submit Order button?"
2. System retrieves the detail analysis from the knowledge graph.
3. System presents:
   - How the process is invoked (e.g., button click, form submit, route change).
   - The logic and code flow when invoked.
   - If it invokes API callers: which callers, which endpoints they hit.
   - If purely local: what state changes or DOM updates it performs.
4. User can view as text, JSON, or visual diagram.

**Postconditions:** User understands the full behavior triggered by the client-side process.

**Requirements:** R-4.3.1 through R-4.3.5, R-7.3.1, R-7.3.2

---

### UC-9: Trace an End-to-End Flow

**Personas:** P1, P2, P3, P4, P5, P6, P7, P8, P10

**Description:** A user wants to see the complete journey of a user action from UI through backend to database and back.

**Preconditions:** Analysis has been run and flows have been stitched (UC-2).

**Flow:**
1. User asks "Show me the end-to-end flow when a user submits an order" or selects a flow from the graphical interface.
2. System retrieves the stitched flow from the knowledge graph.
3. System presents the full chain:
   - **Client-side process:** The UI action or trigger (e.g., button click on "Submit Order").
   - **Client-side API caller:** The function that constructs and sends the API request.
   - **API endpoint:** The backend handler that receives the request.
   - **Business logic:** Validation, transformations, and orchestration in the backend.
   - **Database interactions:** Tables read/written, queries executed.
   - **Response chain:** Data returned from database to endpoint to API caller to UI.
   - **DOM update:** How the UI changes after the response is processed.
4. System indicates which links in the chain were stitched deterministically vs. via contextual analysis.
5. User can view as a natural language narrative, a JSON object, or an interactive visual flow diagram.

**Postconditions:** User has a complete understanding of the flow from trigger to outcome.

**Requirements:** R-5.1 through R-5.5, R-7.3.1, R-7.3.2, R-7.3.3

---

### UC-10: Resolve Ambiguous Flow Stitching

**Personas:** P3, P4

**Description:** During analysis, the system encounters a case where it cannot deterministically match a client-side API call to a backend endpoint (e.g., URL is dynamically constructed). It asks the user for help.

**Preconditions:** Analysis is in progress (UC-2), and the flow stitcher has encountered an ambiguous connection.

**Flow:**
1. System identifies that a client-side caller references an endpoint URL that cannot be deterministically resolved (e.g., `fetch(\`/api/${resource}/${id}\`)`).
2. System presents the user with the ambiguous caller and a list of candidate endpoints.
3. User either:
   a. Manually selects the correct endpoint(s) from the candidate list.
   b. Provides additional context (e.g., "this always calls /api/users/{id}").
   c. Delegates to AI contextual analysis to infer the match.
4. System records the resolution and applies it to the flow.

**Postconditions:** The ambiguous link is resolved and the end-to-end flow is complete.

**Requirements:** R-5.3, R-5.4, R-5.5

---

### UC-11: Impact Analysis for a Planned Change

**Personas:** P1, P2, P3, P4, P7

**Description:** A developer or product manager wants to understand what would be affected if a specific endpoint, caller, or process is modified.

**Preconditions:** Analysis has been run (UC-2).

**Flow:**
1. User asks "What would be affected if I change the POST /api/orders endpoint?" or selects an element in the graphical interface and requests impact analysis.
2. System traverses the knowledge graph to find:
   - All client-side API callers that call this endpoint.
   - All client-side processes that invoke those callers.
   - All database tables this endpoint interacts with.
   - All other endpoints that share those database tables.
3. System presents the impact as a list of affected components and/or a visual subgraph.
4. User can drill into any affected component for details.

**Postconditions:** User understands the blast radius of a proposed change.

**Requirements:** R-6.1.1 through R-6.1.4, R-7.1.4, R-7.2.4, R-7.3.2

---

### UC-12: Debug a Production Incident

**Personas:** P6, P10, P2, P3

**Description:** An SRE or support engineer is investigating a production incident and needs to quickly understand the flow involved in the failing behavior.

**Preconditions:** Analysis has been run (UC-2). An incident has been reported involving specific user-facing behavior.

**Flow:**
1. Support engineer or SRE identifies the symptom (e.g., "users report error when submitting payment").
2. User asks "Show me the flow for payment submission" via NLP interface.
3. System returns the end-to-end flow (UC-9) for the relevant client-side process.
4. User examines each layer:
   - Which API endpoint handles this?
   - What database operations does it perform?
   - What error handling exists at each layer?
   - What does the client do if the API returns an error?
5. User identifies the likely failure point and hands off to the appropriate team.

**Postconditions:** Incident is narrowed down to a specific layer and component.

**Requirements:** R-5.1, R-5.2, R-4.1.1 through R-4.1.4, R-7.1.4

---

### UC-13: Onboard to an Unfamiliar Codebase

**Personas:** P8, P3

**Description:** A new team member needs to quickly understand how the application works without reading every file.

**Preconditions:** Analysis has been run (UC-2).

**Flow:**
1. New developer opens the graphical interface and sees the knowledge graph visualization.
2. They see an overview: major client-side processes, API endpoints, and their connections.
3. They ask questions via NLP: "What are the main user flows?", "How does authentication work?", "Which endpoints write to the users table?"
4. System answers each question using the knowledge graph, providing both textual explanations and visual diagrams.
5. Developer drills into specific flows (UC-9) to understand areas they will be working on.

**Postconditions:** New developer has a working mental model of the application architecture and key flows.

**Requirements:** R-6.1.4, R-7.1.4, R-7.2.4, R-7.2.5, R-7.3.1, R-7.3.2

---

### UC-14: AI-Assisted Code Modification via MCP

**Personas:** P9 (AI Coding Assistant)

**Description:** An AI coding assistant uses the MCP server to get structured context about the codebase before making changes.

**Preconditions:** Analysis has been run (UC-2). MCP server is running. AI assistant is configured to use the MCP server.

**Flow:**
1. Developer asks their AI assistant: "Fix the bug where updating a user's email doesn't reflect in the profile page."
2. AI assistant queries the MCP server: "What is the end-to-end flow for updating user email?"
3. MCP server returns the stitched flow from the knowledge graph: the UI component, the API caller, the PUT /api/users/:id endpoint, the database UPDATE query, the response handling, and the DOM update.
4. AI assistant uses this compressed context to identify the likely issue (e.g., the response handler doesn't update the local state after a successful API call).
5. AI assistant proposes an accurate fix with full awareness of the flow.

**Postconditions:** AI provides a targeted, context-aware fix instead of a generic suggestion.

**Requirements:** R-6.2.1, R-6.2.2, R-6.1.4

---

### UC-15: Write a Test Plan for a Feature

**Personas:** P5

**Description:** A QA engineer needs to create a comprehensive test plan for a feature and wants to ensure all paths are covered.

**Preconditions:** Analysis has been run (UC-2).

**Flow:**
1. QA engineer asks "Show me all the end-to-end flows related to the checkout process."
2. System returns all flows that involve checkout-related client-side processes.
3. For each flow, the QA engineer examines:
   - The happy path (normal operation).
   - Error handling at each layer (what happens if the API returns 400, 500, timeout).
   - Database constraints that could cause failures.
   - Client-side validation before the API call.
4. QA engineer uses the detail analyzers (UC-4, UC-6, UC-8) to understand edge cases.
5. QA engineer builds a test plan that covers all discovered paths.

**Postconditions:** Test plan covers the full scope of the feature's behavior across all layers.

**Requirements:** R-5.1, R-5.2, R-4.1.1 through R-4.3.5, R-7.1.4

---

### UC-16: Audit the API Surface Area

**Personas:** P4, P6

**Description:** A tech lead or SRE wants to audit the complete API surface of the application for security review, documentation, or deprecation planning.

**Preconditions:** Analysis has been run (UC-2).

**Flow:**
1. User asks "Show me all API endpoints with their callers and database interactions."
2. System returns a comprehensive report from the knowledge graph showing:
   - Every endpoint, its HTTP method and path.
   - Which client-side callers invoke each endpoint.
   - Which database tables each endpoint touches.
   - Endpoints with no known callers (potentially dead code or external-only).
   - Endpoints that are called but not defined in the analyzed repositories (potential missing dependencies).
3. User exports the report as JSON for further processing or compliance documentation.

**Postconditions:** User has a full audit of the API surface with caller and data dependencies.

**Requirements:** R-3.1.6, R-3.2.6, R-4.1.1 through R-4.1.4, R-6.1.4, R-8.1.2

---

### UC-17: Visualize System Architecture

**Personas:** P4, P7, P8

**Description:** A user wants to see a high-level visual representation of how the system's components are connected.

**Preconditions:** Analysis has been run (UC-2).

**Flow:**
1. User opens the graphical interface.
2. System renders the knowledge graph as an interactive diagram showing:
   - Client-side processes as entry points.
   - API callers as intermediate nodes.
   - API endpoints as backend nodes.
   - Database tables as data layer nodes.
   - Edges showing the flow of data between them.
3. User can zoom, filter by repository/framework, and click nodes to drill into details.
4. User can ask follow-up questions via NLP that highlight specific subgraphs in the visualization.

**Postconditions:** User has a visual mental model of the entire system architecture.

**Requirements:** R-6.1.1, R-6.1.2, R-7.2.4, R-7.2.5, R-7.3.2, R-7.3.3

---

### UC-18: Re-Analyze After Code Changes

**Personas:** P1, P2, P3, P4, P6

**Description:** After code changes are merged, a user wants to update the knowledge graph to reflect the current state of the codebase.

**Preconditions:** A project exists and was previously analyzed. Code changes have been made to one or more repositories.

**Flow:**
1. User triggers re-analysis via NLP ("Re-analyze the project") or graphical interface.
2. System re-runs the detection engines, detail analyzers, and flow stitcher.
3. System updates the knowledge graph with new, modified, and removed elements.
4. User can review what changed since the last analysis.

**Postconditions:** Knowledge graph reflects the current state of all repositories.

**Requirements:** R-7.1.3, R-7.2.3, R-6.1.3

---

### UC-19: Identify Dead Code and Unused Endpoints

**Personas:** P2, P3, P4

**Description:** A developer or tech lead wants to identify endpoints or client-side code that are no longer connected to any active flow.

**Preconditions:** Analysis has been run (UC-2).

**Flow:**
1. User asks "Are there any endpoints with no callers?" or "Show me unused API callers."
2. System queries the knowledge graph for:
   - API endpoint nodes with no incoming edges from API callers.
   - API caller nodes with no incoming edges from client-side processes.
   - Client-side processes that are not reachable from any UI element.
3. System presents the list of orphaned components.
4. User investigates whether these are truly dead code or are invoked via paths not yet captured (e.g., external integrations, cron jobs).

**Postconditions:** User has a list of potentially dead code for cleanup or further investigation.

**Requirements:** R-6.1.1, R-6.1.2, R-6.1.4, R-7.1.4

---

### UC-20: Deploy Readiness Check

**Personas:** P6, P4

**Description:** Before deploying a release, a DevOps engineer or tech lead wants to understand which end-to-end flows are affected by the changes in the release.

**Preconditions:** Analysis has been run for both the current and previous states of the codebase, or the user provides a list of changed files/endpoints.

**Flow:**
1. User asks "Which flows are affected by changes to the /api/payments endpoint and the CheckoutForm component?"
2. System traverses the knowledge graph to find all flows that pass through the specified components.
3. System presents the affected flows and highlights which layers in each flow touch the changed components.
4. DevOps engineer uses this to determine which smoke tests and monitoring to prioritize post-deployment.

**Postconditions:** Deployment team knows which user-facing flows to test and monitor after release.

**Requirements:** R-5.1, R-5.2, R-6.1.4, R-7.1.4

---

## 3. Persona-to-Use Case Matrix

| Use Case | P1 Frontend | P2 Backend | P3 Full-Stack | P4 Tech Lead | P5 QA | P6 DevOps/SRE | P7 Product | P8 New Member | P9 AI/MCP | P10 Support |
|---|---|---|---|---|---|---|---|---|---|---|
| UC-1: Set Up Project | x | x | x | x | | x | | | | |
| UC-2: Analyze Repos | | | x | x | | x | | x | | |
| UC-3: Discover Endpoints | | x | x | x | x | x | | | | |
| UC-4: Endpoint Details | | x | x | | x | x | | | | x |
| UC-5: Discover Callers | x | | x | x | x | | | | | |
| UC-6: Caller Details | x | | x | | x | | | | | x |
| UC-7: Discover Processes | x | | x | x | x | | x | | | |
| UC-8: Process Details | x | | x | | x | | x | | | x |
| UC-9: E2E Flow Trace | x | x | x | x | x | x | x | x | | x |
| UC-10: Resolve Ambiguity | | | x | x | | | | | | |
| UC-11: Impact Analysis | x | x | x | x | | | x | | | |
| UC-12: Debug Incident | | x | x | | | x | | | | x |
| UC-13: Onboarding | | | x | | | | | x | | |
| UC-14: AI via MCP | | | | | | | | | x | |
| UC-15: Write Test Plan | | | | | x | | | | | |
| UC-16: API Audit | | | | x | | x | | | | |
| UC-17: Visualize Architecture | | | | x | | | x | x | | |
| UC-18: Re-Analyze | x | x | x | x | | x | | | | |
| UC-19: Dead Code Detection | | x | x | x | | | | | | |
| UC-20: Deploy Readiness | | | | x | | x | | | | |
