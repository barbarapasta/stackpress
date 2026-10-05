# Native client OAuth proof

Codex **0.157.0** and Claude Code **2.1.283** each passed **12 checks** against
the disposable shared-access fixture. The run used Node **22.23.2** and Chromium
**153.0.8010.12**. See [results.json](results.json) for the timestamp and redacted
protocol observations.

This proves native client interoperability with the candidate. P-003's complete
Stackpress application journey remains unproved: the real session OAuth pages,
database records, sign-in integration, and two-factor checks are not built yet.
The proof does not substitute simulated sign-in for that release requirement.

## Run

Install the repository's normal dependencies and make the `codex` and `claude`
commands available. Supply paths to an installed Playwright module and matching
Chromium executable. No workspace dependencies or manifests are changed.

```bash
OAUTH_PROOF_PLAYWRIGHT=/path/to/playwright/index.mjs \
OAUTH_PROOF_CHROMIUM=/path/to/chromium \
yarn node proofs/mcp-oauth-clients/run.mjs
```

Use Node 22 on PATH. The runner also needs the Linux `script` command: Claude's
headless login requires a terminal. Paths used for the recorded run were
`/tmp/pwcheck/node_modules/playwright/index.mjs` and
`/home/solution-team/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`.
A later machine must supply its own available browser installation.

The runner opens temporary loopback servers and browser contexts. Claude gets
an isolated temporary configuration directory. Codex uses a unique proof server
name supplied through command-line configuration and its normal OAuth file
store; the runner logs that server out afterward. It never changes HOME or
CODEX_HOME, edits the user's configured MCP server list, or reads existing
credentials into the proof. The recorded run removed both proof credentials,
closed its browser/servers, and removed its temporary client directory.

## What passed for each client

| Check | Required observation |
| --- | --- |
| Native login | Actual CLI discovery, registration, S256 request, browser approval, code exchange |
| Protected tool | Actual SDK callback runs as fixture-user, result reaches the matching model tool call, CLI exits successfully |
| Automatic renewal | Server expires the access key, CLI sends refresh_token, retries and completes the protected tool |
| Disconnect | Next native client connection is refused with 401; no protected callback runs |
| Disconnected renewal | Refresh attempt receives invalid_grant |
| Reapproval | Native login and browser approval restore successful protected tool use |
| Shared API access | Native client's issued full key works on approved API GET and POST |
| Read-ID rule | The issued ID alone works on GET and is refused on POST |
| API boundaries | Omitted route enablement and a different service are both refused |
| API renewal | New key works and old key is refused |
| API disconnect | Cancelled key is refused |
| API reapproval | Newly approved key works again |

All positive tool checks require exit code zero, a `mcp-tool-completed` server
observation, and the matching successful result returned to the model stub.
A printed success sentence or a returned error is insufficient. Assertions fail
the command if any client check or credential cleanup fails.

The native client obtains and stores its keys through its own OAuth code.
For the API checks only, the fixture exposes its newly issued invented key to
the runner in memory. The runner sends it directly to API routes; it never
injects a copied key into Codex or Claude. Results contain no bearer values,
renewal secrets, authorization codes, PKCE verifiers, or callback URLs.

## How the browser and model are exercised

[run.mjs](run.mjs) launches each native `mcp login --no-browser` command and opens
its authorization URL in real Chromium. Chromium submits the fixture's approval
form. The runner can intercept the resulting callback and supply it to the
CLI's supported headless prompt. If the CLI receives its loopback callback
first, its completed exchange is accepted instead. This tests native headless
login with a real browser form; it does not claim desktop browser auto-launch
or exclusive coverage of the real loopback listener delivery path.

The fixture openly labels its person as simulated. It does not ask for real
account credentials or connect to an application database.

[model.mjs](model.mjs) serves a deterministic local model response asking for
only `read_articles`. Native Codex and Claude still perform discovery, tool
calls, auth, renewal and retries themselves. No external model invocation is
needed. Codex apps/plugins/subagents are disabled for the tool runs, and only
proof tool names are retained in model observations.

The synthetic read tool is preapproved in the client invocation, using Claude's
specific allowed-tool option and Codex's per-tool approval setting. That is
separate from the server's OAuth approval and does not skip any server check.
The [Codex configuration reference](https://developers.openai.com/codex/config-reference)
documents the per-tool `approval_mode` setting. No unrelated tool is approved.

## Limits

- Renewal is tested after server-side expiry produces 401; this does not measure
  proactive renewal scheduling or waiting through the default 15-minute lifetime.
- Each tool probe starts a new CLI process. Disconnect is proved on the next
  connection, not on a tool already running inside a long-lived client session.
  P-002 owns saved-session and in-flight cancellation behavior.
- Login is explicitly invoked using the client's normal MCP login command.
  SDK automatic first protected-call login is tested by P-002/P-004, not by
  this native CLI run. Neither result proves every client UI opens automatically.
- Dynamic registration is exercised. HTTPS hosting, client metadata documents,
  real account state, browser CSRF, fresh two-factor checks, generated stores,
  distributed limits, and production API/AI handlers remain implementation tests.
- Permission escalation is not claimed. P-002 records the SDK's repeated-403
  failure when an unchanged refresh grant cannot supply the requested scope.

[Shared fixture](../mcp-oauth-shared-access/README.md) documents its exact service
membership design and limitations. [Transport proof](../mcp-oauth-transport/README.md)
covers request identity and current Stackpress transport defects.
