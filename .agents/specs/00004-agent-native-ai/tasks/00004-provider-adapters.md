# Task 00004: Provider Adapters

## Task Summary

Turn the P-003 prototype into package code: one adapter contract and adapters
for Anthropic, OpenAI, and OpenRouter, plus a stub for tests. Decisions:
DEC-002, DEC-004, DEC-015. Evidence: P-003, R-007.

## Implementation Steps

1. Read the current provider documentation before editing; R-007 records what
   was true on 2026-10-04. For Anthropic code, load the Claude API reference
   first and follow it over anything recalled.
2. `src/types.ts`: add the adapter contract types from
   `proofs/agent-provider-parity/contract.mjs`: turn, tool call, reply, usage,
   and the adapter itself. Add an optional text callback for streaming.
3. `src/adapters/anthropic.ts`: official SDK, Messages API. Replay the model's
   own reply unchanged, send all tool results of a step in one message, check
   the stop reason before content, send tools strict, opt into the default
   refusal fallback, and stream long replies.
4. `src/adapters/openai.ts`: official SDK, Responses API. Pass earlier output
   items back with the tool output. Run without provider-side storage; confirm
   how in the current documentation and record it in Implementation Notes.
5. `src/adapters/openrouter.ts`: chat completions through the OpenAI SDK
   pointed at OpenRouter. Send the tool list on every request. The model is
   required in config.
6. `src/adapters/stub.ts`: scripted replies for tests and for the reference app
   when no key is set.
7. `src/adapters/index.ts`: choose the adapter from config and import its
   module only then, so an app installs only the SDK it uses. Declare the two
   SDKs as optional peer dependencies.
8. Map provider failures to typed errors the runtime can tell apart: rate
   limit, authentication, refusal, and other.
9. Tests: port the canned-reply checks from the prototype, including the
   model-switch checks in both directions. Add a live smoke script gated on
   `OPENROUTER_API_KEY` and kept out of the default test run.

## Verification Process

- `yarn test` in `packages/stackpress-ai` passes with coverage above 90%.
- The live smoke script passes through OpenRouter against one Claude model and
  one OpenAI model.
- Live Anthropic and OpenAI runs are recorded when their keys exist; until
  then their status is stated as canned-reply only.
- `yarn build` in the package.

## Acceptance Criteria

The visible output of the live smoke run: each model's tool call, answer, and
token usage.

## Implementation Notes

Done 2026-10-05. Every step above is done. Files, all in `packages/stackpress-ai`:
`src/types.ts` (adapter contract types appended), `src/adapters/` (`anthropic`,
`openai`, `openrouter`, `stub`, `index`, plus `errors` and `helpers`),
`package.json` (the two SDKs as optional peer dependencies and as exact-pinned
dev dependencies, and a `smoke` script), `yarn.lock` (only the two SDKs and their
dependencies were added), and tests `provider.ts` (shared helpers),
`anthropic.test.ts`, `openai.test.ts`, `openrouter.test.ts`, `adapters.test.ts`,
and the live script `tests/smoke-openrouter.ts`. SDK versions are the
prototype's: `@anthropic-ai/sdk` 0.131.0, `openai` 7.27.0.

**Documentation read before coding (2026-10-05).**

- Anthropic: the `claude-api` skill's TypeScript guide. Used:
  `beta.messages.stream(...).finalMessage()`; `betas: ['server-side-fallback-2026-07-01']`
  with `fallbacks: 'default'`; `output_config.effort` (default `medium`, set
  explicitly); `thinking` unset (always on, `disabled` is a 400); no forced
  `tool_choice`; stop reason read before content. The SDK's note on
  `BetaFallbackBlockParam` says to echo a `fallback` marker in place, while the
  skill says to leave out thinking and calls from before it. The adapter does
  both: the marker stays, and thinking and `tool_use` blocks before it are dropped.
- OpenAI, how it runs without provider-side state (DEC-015 / GAP-016). From the
  function-calling guide and the reasoning guide: set `store: false` and send no
  `previous_response_id`; reasoning items returned with tool calls "must also be
  passed back with tool call outputs", via `toResponseInputItems(response.output)`.
  The reasoning guide says that with `store: false` reasoning items in `output`
  carry `encrypted_content` to pass back, that the API "no longer requires"
  `include: ["reasoning.encrypted_content"]` and still accepts it, and to
  "preserve every output item, append the next user message, and replay the
  complete history". So it can be done, and the adapter does exactly this: every
  request sets `store: false`, sends no `previous_response_id` or `conversation`,
  sends the whole transcript as `input`, and replays the model's own `output`
  items through `toResponseInputItems`. I did not send the legacy `include`,
  since it is not required and I could not confirm every model accepts it. The
  pages were read through a summarising fetcher, so the quotes are from that
  summary. Tests assert `store: false`, no `previous_response_id`, and an
  `encrypted_content` reasoning item sent back unchanged.
- OpenRouter: the tool-calling guide. `tools` on every request, `tool_choice`
  `auto`, `role: "tool"` results by `tool_call_id`, finish reasons `tool_calls`
  and `stop`. Unchanged from the prototype.

**How streaming works.** The request carries an optional `onText(text)`
callback; it only observes, and the returned reply is the full reply either way.
Anthropic always streams (`messages.stream`, then `finalMessage()`) so a long
reply cannot time out, and calls `onText` for each `text` event. OpenAI and
OpenRouter stream only when `onText` is given (`responses.stream` and
`chat.completions.stream`, ending in `finalResponse()` and
`finalChatCompletion()`), because they have no timeout reason to otherwise. A
refusal that arrives after text was already streamed leaves that text with the
caller; the reply itself has empty text and `stop: 'refusal'`.

**How typed errors work.** `src/adapters/errors.ts` has `ProviderError` with
`kind` (`rate_limit`, `authentication`, `refusal`, `other`), `provider`,
`status`, `retryAfter` (seconds, from the `retry-after` header when numeric), and
the SDK's error as `cause`. Every provider call runs through `guard()`, which
maps by HTTP status read from the SDK error, so the module needs no SDK: 401 is
`authentication`; 403 is `authentication` unless OpenRouter lists moderation
`reasons`, then `refusal`; 429 is `rate_limit` except code `insufficient_quota`,
which is `other` because waiting will not clear it; 400 with an OpenAI code of
`invalid_prompt`, `content_policy_violation` or `content_filter` is `refusal`;
everything else is `other`. A refusal that arrives as a normal answer (Anthropic
`stop_reason: refusal`, an OpenAI refusal part, an OpenRouter `content_filter`)
is not thrown: it is a reply with `stop: 'refusal'`, as in the prototype. Also
mapped to `other`: an OpenAI `failed` response, and an OpenRouter 200 answer
that carries an `error` body or no choices.

**Deviations from the prototype, and why.**

1. Tools are sent `strict` only when the schema can be strict (objects closed
   with `additionalProperties: false`, every property required, all the way
   down); otherwise as plain tools. Step 3 says send strict, and the prototype
   always did, but a strict tool with a schema that cannot be built that way is
   refused, and task 00002's tool schemas are not guaranteed to fit.
2. A reply that was refused, or cut off by the length limit while holding a call
   (for OpenAI, any incomplete one), gets `raw: null` and no tool calls. Replaying
   it as returned would send a call with no result, or a reasoning item with
   nothing after it. `null` makes later turns rebuild it from the neutral fields,
   and a neutral turn with no text and no calls is left out of the request,
   because the providers reject an empty assistant message.
3. Anthropic usage adds up `usage.iterations` when present, so tokens spent on
   a declined attempt before a server-side fallback are counted, and cache
   tokens are counted as input.
4. Anthropic `model_context_window_exceeded` maps to `length`. OpenAI arguments
   that are not a JSON object give `length` with no calls, not a `SyntaxError`.
5. `ProviderError` is also thrown for an unknown provider, a missing SDK package
   (the message names it), and OpenRouter built without a model or a key.
6. The model identifiers are configuration. Defaults: Anthropic
   `claude-opus-5-5`, OpenAI `gpt-6.1-sol`; OpenRouter has none and throws
   without one. `AdapterConfig` in `types.ts` is the option shape the later config
   task will fill from app config; no config reading was added here.

**Left alone.** Nothing is exported from `src/index.ts` and there is no
`./adapters` entry in `exports` or `typesVersions`; task 00009 owns the public
surface. Nothing under `proofs/` was touched. With no key at all the Anthropic
and OpenAI SDKs fail with their own error (OpenAI at construction, Anthropic at
the first request), not mapped to `authentication` because no status exists to
read; the runtime should check for a key first. The SDKs retry 429 and 5xx twice
on their own and no `maxRetries` option is exposed.

## Verification Notes

Run 2026-10-05 on Node 22.23.2 with Yarn 1.22.22. Everything below was run, not
inferred, unless it says otherwise.

- `yarn test` in `packages/stackpress-ai`: exit 0. Before: 198 tests, coverage
  96.92 / 93.23 / 96.03 / 97.46 (statements / branches / functions / lines).
  After: 266 passing, 97.54 / 93.78 / 97.02 / 97.95. The 68 new tests are
  `anthropic` 16, `openai` 18, `openrouter` 15, `adapters` 19. `src/adapters`
  alone is 99.58 / 94.94 / 100 / 99.56. The smoke script is not in that run.
  Mutation check: with the OpenRouter `clean()` step disabled, the test that
  guards it failed; the file was restored.
- The canned-reply tests run the real SDKs against a custom `fetch`. They port
  the prototype's checks and the model switches in both directions between all
  three providers and between two models of one provider, and add streaming,
  refusals, cut-off replies, the fallback echo rules, and each typed error.
- `yarn build` in the package: exit 0 (CJS, ESM, declarations; `cjs/adapters`
  and `esm/adapters` emitted). `yarn build` at the repository root: exit 0,
  53 s, and it builds `stackpress-ai`.
- Lazy loading, checked against the built output with a script outside the
  repository: in CJS (`require.cache`) and in ESM (a module resolve hook), loading
  the chooser loads no SDK file, choosing `stub` loads none, choosing `anthropic`
  loads only `@anthropic-ai/sdk`, then choosing `openai` loads `openai`. A unit
  test also asserts that the chooser calls only the chosen loader.
- Live smoke through OpenRouter, `yarn smoke` equivalent, one run per model,
  streaming, 2,000 token cap, both PASS. Evidence:
  `tasks/evidence/00004-live-smoke.md`. `anthropic/claude-opus-5.5`: tool called
  once with `{"requestId":"REQ-42"}`, answered from the result, 1,003 tokens in,
  104 out. `openai/gpt-6.1-sol`: same, 248 in, 43 out. The key was never printed
  or written; the script redacts it from its output and the captured output was
  checked to not contain it. Without the key the script prints a skip line and
  exits 0, and it is not in the `yarn test` glob.
- **What has not run live:** the Anthropic adapter and the OpenAI adapter have
  never run against their own providers; there are no keys. They are verified
  with canned replies through the real SDKs only. The live run exercised the
  OpenRouter adapter and its streaming path; the non-streaming OpenRouter path
  was live-checked only by the P-003 prototype, not again here. The `store: false`
  Responses call and the Anthropic fallback beta header are therefore unproven
  against the real services: they follow the documentation but no provider has
  accepted them.
- `git diff --check`: clean (exit 0), and no trailing whitespace in the new
  untracked files. `python3 .agents/scripts/validate-agent-workspace.py`: "OK,
  warnings only", the same two line-count warnings as before this task
  (`references/00010` and `references/00014`).

## Acceptance Notes

Accepted by the user on 2026-10-05, after reviewing the results ("Looks good to me").
