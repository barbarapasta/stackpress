# Integration Journeys

Journeys for callers other than the signed-in person in the panel. Person
journeys are in [User Journeys](journeys.md). Step tags are scope then
implementability.

## J-011: Outside AI Tool With An Access Key

- Actor: an outside AI tool connecting over MCP.
- Goal: list and call the tools its key allows.
- Trigger: the tool connects over HTTP or SSE with a key.
- Preconditions: `mcp` config present; the app issued the key.
- Steps:
  1. [in-scope, implementable] A known, active, unexpired key with a matching secret connects and lists only tools for which it holds every scope.
  2. [in-scope, implementable] A call runs through the shared execution path; the event receives the caller record and the inputs.
  3. [in-scope, implementable] An unknown, inactive, expired, or secretless key is answered 401.
  4. [in-scope, implementable] A call missing a scope is answered 403.
  5. [in-scope, implementable] A key that dies ends its live connection.
  6. [in-scope, evidence-only] The stdio transport stays unfiltered for local operators.
  7. [external, evidence-only] The app checks that a key was issued for its own address.
- Scope notes: issuing keys and consent pages belong to the app.
- Implementable steps: 1 to 5.
- Evidence links: DEC-003, DEC-013, R-002, R-004.
- Gaps created or resolved: none.
- Acceptance impact: package tests must cover each refusal on both network transports.

## J-012: A Plugin Registers A Tool

- Actor: application developer.
- Goal: offer one of the app's own actions as a tool.
- Trigger: the developer adds a listener for the tool contribution event.
- Preconditions: the plugin loads with `stackpress-ai`.
- Steps:
  1. [in-scope, implementable] The listener returns a tool definition: name, description, input schema, event, method, visibility, and either an inverse tool or an irreversible mark.
  2. [in-scope, implementable] The registry merges contributed tools; config entries override by name.
  3. [in-scope, implementable] The tool is offered to outside callers and the built-in agent according to its visibility.
  4. [in-scope, implementable] The event receives the caller record apart from its inputs.
- Scope notes: a write tool with neither an inverse nor an irreversible mark is treated as irreversible.
- Implementable steps: 1 to 4.
- Evidence links: R-009, DEC-012, DEC-013.
- Gaps created or resolved: none.
- Acceptance impact: a tool must be registrable without editing `mcp.tools`.

## J-013: An Operator Turns The Agent On

- Actor: deployment operator.
- Goal: enable the built-in agent for a deployment.
- Trigger: the operator adds the `agent` config section.
- Preconditions: a provider key in the server environment.
- Steps:
  1. [in-scope, implementable] The operator sets providers, models, and the per-person limit in config, and adds the package's schema line.
  2. [in-scope, implementable] The agent routes register only when `agent` config exists.
  3. [in-scope, implementable] A missing key makes the agent report itself unavailable without stopping the server.
- Scope notes: no provider keeps conversation state under DEC-015.
- Implementable steps: 1 to 3.
- Evidence links: DEC-002, DEC-004, DEC-015, R-008.
- Gaps created or resolved: none.
- Acceptance impact: an app without `agent` config must behave as before.

## J-014: A Background Run With No Person

- Actor: an application job.
- Goal: run an agent turn on a schedule or trigger.
- Trigger: a job calls the agent turn event.
- Preconditions: none met; no person is signed in.
- Steps:
  1. [deferred, not-implementable] The job supplies an identity to act as.
- Scope notes: DEC-001 requires a signed-in person, and automations are a non-goal. The turn event accepts only requests that carry a person's session.
- Implementable steps: none.
- Evidence links: DEC-001, DEC-008.
- Gaps created or resolved: GAP-018 created.
- Acceptance impact: none for this spec.
