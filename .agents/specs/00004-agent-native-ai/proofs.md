# Proofs

Status: P-001, P-002, and P-003 proved on 2026-10-04. Prototypes are under root
`proofs/<proof-slug>/` and stay outside `.agents/`.

## P-001: Session-Forwarded Tool Call

Gap: GAP-001.

Hypothesis: A tool execution path can run an application event with the
originating request so the app's own session check accepts the signed-in user.

Scope: A minimal Stackpress app with one event that authenticates from the
session token on the request, called once with plain data and once with the
forwarded request.

Expected signal: The forwarded call is authorized as the signed-in user and the
plain-data call is refused.

Failure signal: The event cannot be reached with a usable session, or forwarding
leaks the chat request's own body into the event input.

Non-goals: Model calls, interface work, Approvals code changes.

Prototype path: `proofs/agent-session-forwarding/`.

Result: Proved on 2026-10-04 with published `@stackpress/ingest` and
`stackpress-session` 0.10.8 on Node 24.21.0. Run `npm install` then
`npm run prove` in the prototype folder; 7 of 7 checks passed.

- Plain data, the form `registerCallTools` uses today, is refused even when the
  person is signed in, because Ingest builds a request with no session.
- Forwarding the chat request itself is accepted as the person but passes the
  chat body to the event as input. Rejected.
- A new request built with `ctx.request()` from the caller's session data and
  only the tool arguments is accepted as the person, receives only the tool
  arguments, and is refused for a signed-out caller and a tampered token.

Still unknown: the prototype event checks the session only. The Approvals
action boundary also requires a valid CSRF token on writes, branches on the
request method, and reads identifiers from the request path. Whether a
forwarded request satisfies that boundary is not proved here; it is a pilot
proof against the real app with a disposable database.

## P-002: Streaming And Resumable Turns

Gap: GAP-010.

Hypothesis: A chat turn can stream on a Node host, fall back to a single
response on a per-request host, and resume after an approval pause from stored
state alone.

Scope: One endpoint, a stub model that emits text and one tool request, and a
stored turn record, exercised on a long-lived server and on a server built per
request.

Expected signal: Both hosts complete the same turn, and the paused turn resumes
on a fresh server instance.

Failure signal: Streaming cannot be written through the response on either host,
or resume needs process memory.

Non-goals: Real provider calls, panel design.

Prototype path: `proofs/agent-turn-streaming/`.

Result: Proved on 2026-10-04 with published `@stackpress/ingest` 0.10.8 on Node
24.21.0. Run `npm install` then `npm run prove` in the prototype folder; 16 of
16 checks passed.

- A route streams by handing Ingest a stream body. Events arrived in separate
  reads spread over time on a long-lived server and on a host that builds a new
  server for every request.
- The single-response fallback returned the same events on both hosts.
- A turn that paused for approval stored its state, ran no tool while waiting,
  and resumed on a different server instance, including across hosts.
- A repeated approval answered from the stored record and did not run the tool
  a second time.

Still unknown: both hosts ran locally through the Node adapter. Behavior on the
real hosting platform, where a function may be cut off or its output buffered,
is not proved, and the WHATWG adapter was not exercised. The store was a file
standing in for the database.

## P-003: Provider Adapter Parity

Gap: GAP-006, GAP-015. Decision: DEC-004.

Hypothesis: One conversation loop drives Anthropic, OpenAI, and OpenRouter
through adapters, with no provider-specific branch in the loop.

Scope: A two-step lookup with one tool. Each adapter runs against canned
replies handed to the provider's real SDK, so the SDK builds the request and
parses the reply. The OpenRouter adapter also runs live against a Claude model
and an OpenAI model.

Expected signal: Every run produces the same transcript shape, runs the tool
once with the right input, answers from the tool result, and reports usage.

Failure signal: The loop needs to know which provider it is talking to.

Non-goals: Model quality comparison, pricing decisions, provider streaming.

Prototype path: `proofs/agent-provider-parity/`.

Result: Proved on 2026-10-04 with `@anthropic-ai/sdk` 0.131.0 and `openai`
7.27.0 on Node 24.21.0. Run `npm install` then `npm run prove`; set
`OPENROUTER_API_KEY` for the live part. 37 of 37 checks passed, 27 canned and
10 live.

- The loop file names no provider, and all three adapters produced the same
  transcript shape.
- Live through OpenRouter, `anthropic/claude-opus-5.5` and `openai/gpt-6.1-sol`
  each called the tool once with the right input and answered from its result.
  Reported usage was 1,003 input and 106 output tokens, and 248 and 43.
- A transcript written by one provider was rebuilt for another in both
  directions with nothing provider-specific sent across, which is what a model
  picker needs.
- The Anthropic adapter replays its own reply unchanged, thinking block
  included, and sends all tool results of a step in one message.

Still unknown: the Anthropic and OpenAI adapters ran against canned replies
only; a live run needs their own keys. Provider streaming was not exercised.
Whether the OpenAI adapter can avoid provider-side storage is GAP-016.
