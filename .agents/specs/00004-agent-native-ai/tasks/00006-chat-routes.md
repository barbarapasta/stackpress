# Task 00006: Chat Routes

## Task Summary

Expose the turn workflow over HTTP for the panel: send, approve, decline, undo,
history, and new chat, with streaming and a single-response fallback.
Decisions: DEC-014, GAP-010. Journeys: J-001, J-002, J-006 to J-009.

## Implementation Steps

1. `src/pages/`: one page handler each for sending a message, approving,
   declining, undoing, listing threads, loading a thread, and starting a new
   chat. Each handler adapts the request and calls the task 5 events.
2. `src/plugin.ts`: register the routes during `route` only when `agent` config
   exists, under a configurable base path that defaults to `/agent`.
3. Checks on every write route, in this order: a verified person, a valid
   anti-forgery token, the usage limit, and thread ownership. Map them to 401,
   403, 429, and 403 or 404.
4. A read route that gives the panel what it needs to start: an anti-forgery
   token, the models offered, and the person's remaining allowance.
5. Streaming: when the request asks for an event stream, hand Ingest a stream
   body and write text, action, usage, and done events as they happen, as
   proved in P-002. Otherwise answer once with the same events.
6. Page context: accept the page address and context items with a message,
   resolve an enrichment event when the app listens for one, and pass the
   result to the model as hints. No check in this task reads context.
7. Document that an app using `session.access` must allow the agent routes for
   the roles that may use the agent.
8. Tests: every route on a long-lived server and on a server built per
   request; each refusal; stream and fallback producing the same events; a
   tampered context item changing nothing a person may do.

## Verification Process

- `yarn test` in `packages/stackpress-ai` passes with coverage above 90%.
- Auth, validation, event invocation, and status mapping are covered for each
  route, per the access-surface evidence class.
- `yarn build` in the package.

## Acceptance Criteria

A recorded request session against `templates/blog` using the stub model: a
streamed reply, a pause for approval, the approval, the resumed reply, and an
undo.

## Implementation Notes

Done 2026-10-05. Every step is done. Steps 1 and 2 of task 8 were done early with the
orchestrator's authorisation (see the end of these notes).

**Routes** (under `agent.base`, default `/agent`; registered in `route` only when `agent` config
exists, from `src/plugin.ts`; pages in `src/pages/`):

| Method | Path | Page | Event |
| --- | --- | --- | --- |
| GET | `/agent/start` | `start.ts` | `ai-start` + csrf token |
| GET | `/agent/threads` | `threads.ts` | `ai-threads` |
| GET | `/agent/threads/:threadId` | `thread.ts` | `ai-thread` |
| POST | `/agent/threads` | `create.ts` | `ai-new` |
| POST | `/agent/turn` | `send.ts` | `ai-turn` |
| POST | `/agent/actions/:actionId/approve` | `approve.ts` | `ai-approve` |
| POST | `/agent/actions/:actionId/decline` | `decline.ts` | `ai-decline` |
| POST | `/agent/actions/:actionId/undo` | `undo.ts` | `ai-undo` |

`src/pages/helpers.ts` holds the shared parts (no module-level state). The write pages are
`guard` then `run`; the read pages call the event and write its answer.

**Two events were added** (`ai-start`, `ai-new`, with `startInfo` and `newThread` in
`scripts/threads.ts`), because the start-up read and "new chat" had no task 5 event and pages
should only call events. `ai-new` creates an empty thread for the person, or hands back their
newest thread when it has no messages yet (`reused: true`), so opening New chat and leaving does
not fill History with empty threads. `AgentConfig.base` and the refusal reason `csrf` were added.

**Anti-forgery.** `GET /start` answers `csrf: { name, token }` (name from `csrf.name`). It keeps
the token already in the person's session cookie, so a second tab does not spoil the first, and
only calls the `csrf` plugin's `generate` when there is none. Every write sends it back in the body
under that name, or in an `X-CSRF-Token` header (copied into the body field only when the body has
none), and the page calls the plugin's own `valid`. No `csrf` plugin: every write refuses 503.
Order on a write: 401 (the same `person()` the workflow uses), 403 bad token (`reason: csrf`;
the plugin's own 419 is replaced), then the workflow's own refusals.

**Streaming.** A write streams when `Accept` has `text/event-stream` or the body or query has
`stream` true/1. The page attaches `watch(req, fn)`, starts the event, and waits for the first event
or the end. No event first means a refusal, answered as plain JSON with its status. Otherwise the
page hands Ingest a `ReadableStream` (`text/event-stream`, `Cache-Control: no-cache`,
`X-Accel-Buffering: no`) and writes `data: {event}` per report. Without a stream request the page
answers `results` with `events`: the same list. A reader that leaves only makes the page stop
writing (a failed `enqueue` is swallowed, as is `close`); the event is never cancelled, so the
workflow finishes and stores its result. An unexpected failure ends a stream with
`error` + `finished: failed` events of fixed text, and a JSON answer with 500 and the same text.

**Refusals to statuses** (the workflow's codes pass through, with `{ code, status, error, errors:
{ reason, resetsAt? } }`; the body is set by the page so an app's error page never renders it):
401 not signed in; 403 anti-forgery (`csrf`); 400 invalid message, files or model; 404 a thread or
action that is missing or not the person's (task 5's rule, same text for both); 429 at the daily
limit (`resetsAt` kept); 503 no provider key, or no `csrf` plugin. A failure that names no known
reason (an exception, a 5xx without one) is answered 500 `unavailable` with fixed text and logged;
provider text never reaches the body.

**Page context.** `context: { url, items }` is cut to a url of 500 characters and up to 20 items
that are strings or objects of at most 1000 characters; anything else is dropped. A non-object is
ignored. If the app listens for `ai-context` (new `CONTEXT_EVENT`), it gets a new request with
the person's session and only `{ url, items }`; a 200 answer's `url` or `items` replace the sent
ones, and an error or throw leaves them. The result becomes the turn's `context`, which task 5
puts in the system text as hints. Nothing in the pages or the workflow reads it to decide.
`POST /threads` returns the resolved context for the panel. Approve, decline and undo take none.

**Blog (task 8 steps 1 and 2, early, permanent).** `config/common.ts`: an `agent` section (keys
from `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY`; models `claude-opus-5-5` (default, "Claude Opus 5.5") and `openai/gpt-6.1-sol` ("GPT-6.1 Sol"), the identifiers verified on 2026-10-04 and 2026-10-05 and the one the task 4 live smoke run passed with; a limit; 30 minute approvals). The first version used `claude-sonnet-5-5` and `openai/gpt-4o-mini`, which were not verified; they were changed after the session was recorded, which ran on the offline model and is unaffected and
`/agent/**` in the ADMIN, MANAGER and USER access lists, not GUEST; `production.ts` and
`develop.ts` gain `agent: common.agent` (they list their sections by hand). `plugins/app/agent.ts`
(new) holds four tools contributed from the plugin's `ai-tools` listener: `article_find` (read),
`article_publish` (reversible, inverse `article_unpublish` over `article-update` with fixed
`status`, same `{ id }` input so an undo can run on what was stored), and `comment_delete`
(irreversible, `comment-remove`). All are `type: 'user'` with a scope, because the default type
is `public` and would offer writes to unauthenticated MCP callers. The inverse is not marked
`agent`. Documentation steps of task 8 were not touched.

**The stub script.** The package's stub answers by call count per adapter instance, and every
turn opens a new adapter, so a multi-turn script cannot live there. Instead the blog replaces the
registered `agent` runtime in its `route` listener (`useOffline`) using the package's public
`createRuntime` options: `env` reads each provider key at call time and returns a marker when it is
unset, and `connect` returns a small offline adapter for the marker and the real adapter
otherwise. The offline model reads only the transcript it is given (a message of the form
"publish <article> and delete comment <id>" gives publish, text, then a delete that pauses; anything
else gets the "no provider" note), so any server can answer any step. No package behaviour was
added for it. The app's `route` listener runs after the package's `listen` registered the runtime.

**Deviations.** Two added events (above). `AGENT_EVENTS` gained two names, so two assertions in
`agent-events.test.ts` changed. `stackpress-csrf` was added as a dev dependency of the package for
the tests (a workspace package; yarn v1 `yarn.lock` has no entry for workspaces). README: a
"Chat Routes" section, the two events in the table, and one sentence changed.

**Left alone.** An empty History row is possible if someone starts a chat and never sends
(reuse limits it to one). The undo of `article_publish` sets the article to `DRAFT`, not to
whatever it was before; correct for a draft, wrong for one that was `REVIEW`. The workflow's
forwarded request still carries the person's whole session (including the `csrf` cookie) to tool
events, as before. The production error-view crash of task 3A was not touched: refusals here carry
a body so the error page is skipped.


## Verification Notes

- `yarn test` in `packages/stackpress-ai`. Before: 387 passing, 98.12 / 93.64 / 97.42 / 98.46
  (statements / branches / functions / lines). After: 487 passing, 0 failing, 97.83 / 92.78 /
  97.18 / 98.27. 100 tests added: `routes.test.ts` 99 (each route on a long-lived and on a
  per-request server, one shared PGlite database; the real plugin, real `stackpress-csrf` plugin
  and real signed session over a real HTTP listener; stub model only) and one in
  `agent-events.test.ts`; one assertion in each of two existing tests changed. All four numbers
  stay above 90, and they fell slightly because the new event adapters' stop-on-error guard and
  some defensive branches in the pages are not reached.
- Covered per host: start; send once and streamed (separate reads over at least the pause, the
  per-request host built a server for each request); single answer and streamed answer carrying
  the same events for the same request (header and flag), also for approve; approve, repeated
  approve, decline, undo, refused undo; the action taken from the address and not the body;
  history, loading, another person's thread and action answering 404 with the same text as a
  missing one; new chat, reuse, bad model; refusals 401 (every route, tampered sign-in), 403
  (none, empty, wrong, another person's, no cookie, header form), 401 before 403, 503 with no
  csrf plugin, 400, 404, 429 with `resetsAt` (also when streamed), 503 no key, no provider text
  (streamed and not), no exception text (not streamed, streamed after events began, reads, new
  chat); a reader that leaves mid-stream with the turn finishing in the database; context as a
  hint and not stored, enrichment with the person's session, enrichment failing, cutting, a
  tampered context changing nothing (caller, thread, tool input, app refusals, the other person's
  rows) and not approving another person's action; base path; no `agent` config registers no
  route; the exact route list.
- Not run as a mutation check. The tests were written against the behaviour first, and failures
  found while writing them were real (a leaked exception text, a double-wrapped error body, a
  script order), fixed in the pages or tests.
- `yarn build` in the package and at the repository root: exit 0. `git diff --check`: clean.
  `python3 .agents/scripts/validate-agent-workspace.py`: only the two older warnings.
- Recorded session: `tasks/evidence/00006-chat-session.md` (118 lines), from a script that
  made the requests against the blog served in production mode on port 3466. Recipe as in 3A,
  with changes: the push after a removed database did not create the tables until
  `.build/revisions` was removed too, and `yarn blog populate` seeded the data. `.build` was
  restored from a copy, the temporary config removed, and the server stopped by its pid.
- Not verified: no real provider; PGlite only; the blog was not run with the `agent` section
  removed (the package test for no `agent` config covers the routes, and the blog's only other
  changes are the access lines, the tool contribution and a `route` listener that does nothing
  without `agent`); behaviour behind a host that buffers output (the P-002 caveat); the panel.


## Acceptance Notes

Accepted by the user on 2026-10-05, after reviewing the results ("Looks good to me").
