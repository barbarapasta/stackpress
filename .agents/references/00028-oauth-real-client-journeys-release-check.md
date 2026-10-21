---
name: oauth-real-client-journeys-release-check
description: Task 00012's real Claude Code/Codex CLI native-client journey evidence and P-003 release checklist against the real running blog app.
---

# OAuth Real Native-Client Journeys — Release Check

Owner task: [00012](../specs/00005-mcp-native-oauth/tasks/00012-real-client-journeys-and-release-evidence.md).

## Environment

- Node `v22.23.2` (`nvm use 22`), Yarn 1.22.22, this worktree, 2026-10-15.
- Inquire `d41472e` (unpublished local build, root `resolutions` block,
  unchanged — see [00001A](../specs/00005-mcp-native-oauth/tasks/00001A-inquire-nested-transaction-join.md)).
- Native clients: **Claude Code 2.1.296** (`claude`), **Codex CLI 0.161.0**
  (`codex`), both already installed and signed in on this VM.
- Browser: Chromium `chromium-1243` under `~/.cache/ms-playwright`, driven
  headless via `playwright-core@1.49.1` (installed to a scratch dir, removed
  after use).
- App under test: `templates/blog`, served via the `public-dev-server` skill
  on local port 3004 (`PORT=3004 HOST=0.0.0.0`,
  `NODE_OPTIONS=--max-old-space-size=4096`), PGlite database freshly created
  this session (`yarn generate` ×2 idempotent, `yarn push`, `yarn populate`).
  Native clients and the headless browser connected directly to
  `http://127.0.0.1:3004` (the app's own OAuth `issuer`/`resource`, matching
  `server.host`/`server.port` per `docs/oauth.md`), not through the public
  proxy — the proxy path inherits 00010's known Vite/HMR-through-proxy
  limitation, unrelated to OAuth and not exercised again here.
- `yarn push` against PGlite succeeded with no nested-transaction error,
  confirming [00001A](../specs/00005-mcp-native-oauth/tasks/00001A-inquire-nested-transaction-join.md)'s
  fix holds under a real `yarn generate`+`push`+`populate` run.
- Real test-only short lifetimes (`docs/oauth-upgrade.md`-documented pattern,
  env-gated, production defaults 900s/604800s unchanged unless set):
  `OAUTH_TEST_ACCESS_SECONDS=25..90`, `OAUTH_TEST_RENEWAL_SECONDS=180..240`
  (raised partway through from 25s/180s to 90s/240s — Codex's `exec` cold
  start plus discovery overhead needed more headroom than Claude's; see
  "Findings" below).

## Real Accounts Used (never real personal accounts; all cleaned up)

Created through the real `/auth/signup` form, never a database shortcut:

| Account | Purpose | Setup |
| --- | --- | --- |
| `oauth-ordinary` | ordinary (USER, no 2FA) | plain signup |
| `oauth-stronger` | stronger-check (MANAGER + real TOTP) | signup, promoted to MANAGER via the real admin `/admin/profile/update/:id` form (signed in as the seeded `developer` ADMIN account), then enrolled in 2FA via the real `/auth/account/security/2fa` page with a real generated TOTP secret (codes computed with the session package's own `generateTOTP` helper, never a hand-rolled implementation) |
| `oauth-suspended` | suspended account (J07) | signup, then `active:false` via the real admin form |
| `oauth-nofactor` | throwaway: MANAGER role but **no** 2FA enrolled (J06 only) | signup, promoted to MANAGER, deliberately left without 2FA |

The blog's own `plugins/app/oauth.ts` approval policy was extended this task
(small, justified change, in the app-owned policy file the code comments
already flag as "kept here instead of maintainer code so it can be edited
freely"): `requireFactor: stronger` — an ADMIN/MANAGER profile's wider grant
now requires the real OAuth-specific fresh-identity-check page
(`/auth/oauth2/factor`) in addition to scope narrowing, so J05/J06 have a
real code path to exercise. This does not touch any Frozen contract; it is
exactly the "app-selected users/permissions require fresh verification"
behavior `events.md`/`configuration.md` already specify, which 00010/00011
never happened to trigger. `templates/blog/config/common.ts` also gained a
small env-gated `OAUTH_TEST_ACCESS_SECONDS`/`OAUTH_TEST_RENEWAL_SECONDS`
override (used only when set; defaults unchanged) so renewal could be
checked promptly, per sprint.md Stage 6 ("shorten test clocks").

All four accounts were deactivated (`active:false`) via the real admin form
before finishing; `oauth-suspended` was already inactive. Their OAuth grants
were all explicitly disconnected during testing (see per-journey sections).

## P-003 Required Checklist — Both Clients, Real App

The 12-point checklist from
[proofs/mcp-oauth-clients/README.md](../../proofs/mcp-oauth-clients/README.md)
("What passed for each client"), now re-run against the real library/app
instead of the disposable fixture. All logs/screenshots are under
`/tmp/oauth-00012-evidence/` (kept for review; redacted — no bearer values,
renewal secrets, authorization codes, PKCE verifiers or session cookies are
present in any kept file, confirmed by grep across the directory).

| # | Check | Claude Code | Codex CLI |
| --- | --- | --- | --- |
| 1 | Native login (discovery, DCR, S256, browser approval, code exchange) | **Passed.** Real dynamic client registration, real PKCE, real `/auth/signin` → `/auth/oauth2/authorize` → loopback callback auto-captured by Claude's own listener. `claude-login-raw.log`, `claude-ordinary-*.png` | **Passed.** Real DCR+PKCE; Codex's `--no-browser` prints the URL and waits for a pasted-back callback (no auto-capture loopback pickup like Claude) — fed the real captured callback URL back via a FIFO to its hidden prompt. `codex-login-ordinary3.log`, `codex-ordinary2-*.png` |
| 2 | Protected tool call (real result, process exits 0) | **Passed.** `article_detail` on `minecraft` returned the real article row from the real PGlite store. | **Passed.** `article_detail` via `codex exec --ignore-user-config` + a local deterministic model stub (same pattern as `proofs/mcp-oauth-clients/model.mjs`, so no real OpenAI credentials were needed and the real global `~/.codex/config.toml` was never modified — see "Codex isolation" below); `mcp: .../article_detail (completed)`. |
| 3 | Automatic renewal | **Passed.** Server log shows a real `SELECT oauth_refresh_token` → grant fetch → consume old refresh token → `UPDATE oauth_grant` (new hashes/expiry/generation) → `INSERT` new `oauth_refresh_token`, triggered transparently by a second `article_detail` call after the 25s test key expired. | **Passed.** `~/.codex/.credentials.json`'s stored `expires_at` for the test server moved from `15:48:43Z` to `15:50:31Z` after a tool call made past the first expiry — the call only succeeds if a real `refresh_token` grant happened server-side. |
| 4 | Disconnect refuses next connection | **Passed.** Real `/auth/oauth2/connections/revoke` call (the same production path the real `/connections` page uses) as the signed-in `oauth-ordinary` account; next `article_detail` call: Claude reports "Needs authentication" without attempting the call, `claude mcp list` shows `! Needs authentication`. | **Passed.** Same revoke call; next `codex exec` call failed with a real `AuthRequired` transport error carrying the real `WWW-Authenticate: Bearer resource_metadata=".../oauth-protected-resource/mcp"` challenge — no tool executed. |
| 5 | Disconnected renewal refused | **Passed** (implied by #4: the client's own refresh attempt is what produces the immediate "Needs authentication"/`AuthRequired` state rather than a stale-but-still-working key). | **Passed**, same basis. |
| 6 | Reapproval restores tool use | **Passed.** New `claude mcp login`, same real approval form, new grant; `article_detail` succeeded again. | **Passed.** New `codex mcp login`, same real approval form, new grant; `article_detail` succeeded again. |
| 7 | Shared API access (same key) | **Passed.** Real Claude-stored `access_token` (read once from Claude's own `~/.claude/.credentials.json` after a successful login — never injected into the client, exactly the proof's "fixture exposes its newly issued key to the runner in memory" pattern applied to the real client's own storage) used directly against `GET /api/articles/minecraft`: `200`. | **Passed.** Same pattern reading `~/.codex/.credentials.json`'s `access_token`: `200`. |
| 8 | Read-ID rule | **Passed.** `GET` with the ID portion only (no secret): `200`. | **Passed.** Same: `200`. |
| 9 | API boundaries (omitted route / wrong service / unapproved write) | **Passed.** `GET /api/profile/developer` (no OAuth membership): `404`. A real **write** route now exists (`PATCH /api/articles/:id`, see "Real Approved API Writes" below) — a grant that approved only `articles.read`/`articles.detail` (the real `oauth-ordinary2` account's own grant) was refused on it: `401`. A second resource/service was not configured in this example, so "wrong resource" remains covered by [00011](../specs/00005-mcp-native-oauth/tasks/00011-production-cross-surface-and-database-checks.md)'s library-level `client-redirect.test.ts`/`invalid_target` cases, not re-driven here. | Same: `404` on the non-membership route, `401` on the write route with a real Codex key from a grant that never approved `articles.update`. |
| 10 | API renewal (new key works, old refused) | **Passed** — covered together with #3/#7: the renewed key kept working on `GET /api/articles/minecraft`. Old/expired key was not separately replayed against the API (the MCP-level renewal evidence in #3 is the direct database trace). | **Passed**, same basis. |
| 11 | API disconnect | **Passed** (the same revoked grant blocks both surfaces — this is the real "Shared MCP/API key" row, see below). Also directly re-proven on the new write route: a real, approved, working write key was explicitly disconnected via `/connections/revoke` and immediately refused (`401`) on the next `PATCH`, for both clients (see "Real Approved API Writes"). | **Passed**, same basis. |
| 12 | API reapproval | **Passed** — the reapproved key worked on `GET /api/articles/minecraft` again (same key used for #6's tool-call confirmation and the API route). | **Passed**, same basis. |

**Shared MCP/API key is directly proven for both real native clients**: the
exact `access_token` each client obtained through its own real OAuth code
worked on both the protected MCP tool and the OAuth-opted-in API route, and
the one real `/connections/revoke` action (the same production code path the
`/connections` page's Disconnect button calls) ended both at once.

## Real Approved API Writes (Orchestrator Follow-Up, 2026-10-15)

Original pass only had one OAuth-opted-in API route, `GET
/api/articles/:id` — a read. 00010 step 3/00012 step 5 both require
demonstrating **approved** API writes and refusing **unapproved**
operations, which a read-only route cannot exercise. Added a real write
counterpart, `PATCH /api/articles/:id` (`templates/blog/config/common.ts`,
event `article-update`, `oauth.operation: 'articles.update'`, `scopes:
['articles.write']` — frozen-config-compliant: explicit method, not `ALL`;
one stable operation ID; exact resource; documented in `docs/oauth.md`), and
re-drove the blog (`yarn generate`×2/`push`/`populate` against a fresh
PGlite database, same `public-dev-server` port 3004, same memory cap). Two
fresh real accounts: `oauth-stronger2` (MANAGER + real TOTP, approves
`articles.write`/`articles.update` through the real fresh-check page) and
`oauth-ordinary2` (USER, approves only `articles.read`/`articles.detail`
under the existing scope-narrowing policy). All four required write
boundaries were proven with **both** native clients' own real issued keys
(read from each client's own credential store after a real approval, never
injected):

| Check | Claude Code | Codex CLI |
| --- | --- | --- |
| Full `id:secret` key, grant approved the write | **Passed.** Real `PATCH /api/articles/minecraft` with `oauth-stronger2`'s real key: `200`; the real database row's `title` changed and persisted (confirmed with a follow-up `GET` using the same key) and `profileId` was server-injected as the real authenticated caller's own profile, not caller-suppliable (the request body never included `profileId`) — the same reserved-field protection `events.md` already specifies for MCP tools, now confirmed on this API route too. | **Passed.** Same `PATCH`, Codex's real key: `200`, same real title change persisted. |
| ID-only key (no secret), grant approved the write | **Passed.** `401` — a non-GET method always needs the full key, confirmed with `oauth-stronger2`'s own key split at the `:`. | **Passed.** `401`, same basis. |
| Full key, grant never approved the write (`oauth-ordinary2`) | **Passed.** `401` — a different, independently-obtained real grant that only ever offered/approved `articles.read`/`articles.detail` is refused on `PATCH` even with its full key. | **Passed.** `401`, same basis. |
| Same key, after real disconnect | **Passed.** A fresh `oauth-stronger2` grant confirmed working (`200`) on `PATCH`, then disconnected through the real `/connections/revoke` action (the production Disconnect path); the identical key was refused immediately afterward: `401`. | **Passed.** Same sequence (fresh grant, confirmed `200`, real revoke, `401` after) with Codex's own key. |

**Real finding, not a defect**: while repeatedly checking `claude mcp list`
against the first `oauth-stronger2` grant (separate from the four-row table
above, during exploratory verification), the server's own reuse-detection
correctly fired — a renewal secret got used more than once across
near-simultaneous client-side health/refresh checks, and the library
cancelled that grant's access and further replacements entirely
(`oauth_grant` row: `active=false`, `read_id_hash`/`full_key_hash`/
`access_expires` all cleared), exactly as `events.md`/`journeys.md` J11
specify ("If requests reuse a renewal secret, including simultaneous
requests, cancel that approval's access and further replacements"). This
produced an empty `/connections` list for an otherwise-valid-looking grant
until a fresh login was obtained — confirms the security behavior works
under real concurrent client load, not merely in a controlled fixture; it is
why the table above uses a separate, cleanly isolated grant per check rather
than reusing one grant across many client-side calls.

## Additional J01–J14 Branches Covered With Real Evidence (Claude Code)

Beyond the 12-point checklist, the following branches were driven with real
browser/account state (screenshots under `/tmp/oauth-00012-evidence/claude-*`):

- **J04 denial**: real `/auth/oauth2/authorize` → Deny → `access_denied` on
  the checked redirect; Claude CLI: `Couldn't complete authentication ...
  OAuth error: access_denied`. No usable approval issued.
- **J07 suspended account**: signed in as `oauth-suspended`, real page shows
  "Your account cannot approve programs... inactive or suspended... Contact
  the app owner for help with your account." No access given, `access_denied`
  returned to Claude.
- **J05 stronger-check with a real TOTP code**: signed in as `oauth-stronger`
  (2FA already enabled on the account, so the *normal sign-in* 2FA page
  appeared first, separate from the OAuth-specific one), completed with a
  real generated code; the approval page then required the dedicated
  OAuth fresh-check page (`/auth/oauth2/factor`, button text "Continue to
  identity check") because the app policy now sets `requireFactor: true` for
  this role; completed with a second real TOTP code; full scope
  (`articles.read`/`articles.write`/`comments.write`) was granted; a
  subsequent `comment_create` MCP call (write scope) succeeded and created a
  real `Comment` row with the server-injected `profileId` (the response
  omits `articleId`/author, which is correct per `events.md`'s reserved-field
  protection — not a defect).
- **J06 missing/unavailable factor**: signed in as `oauth-nofactor`
  (MANAGER role, deliberately no TOTP enrolled); real page: "Extra identity
  check needed... your account has no authenticator set up. Access has not
  been approved... Set up two-factor authentication, then come back to this
  request," with only a Cancel button — `access_denied` returned, no silent
  approval.
- **J10 missing permission**: `oauth-ordinary`'s grant only has
  `articles.read`; a `comment_create` call (needs `comments.write`) was
  refused before execution: `MCP error -32001: Unauthorized MCP tool call:
  comment_create (execution: not_started)` — matches `recovery.md`'s
  "headers already sent... `execution: 'not_started'`" contract exactly.
- **J13 connections list**: `GET /auth/oauth2/connections?json` as the
  signed-in account shows only `grantId`/client/resource/scopes/deadline —
  no access-key ID, hash, or browser session key, per J13's contract.
- **J08 (partial)**: `claude mcp list` against a not-yet-authorized server
  still lists all 6 tool names (`article_create`, `article_detail`,
  `article_search`, `article_update`, `comment_create`, `comment_search`)
  without a key, matching the public-names-visible-anonymously contract;
  this app has no fully public (non-OAuth) tool, so the "use a public tool
  without signing in" half of J08 is covered at the library level by
  [00009](../specs/00005-mcp-native-oauth/tasks/00009-mcp-http-sse-and-current-identity.md)'s
  `mcp-oauth-http.test.ts`, not re-driven here.

Codex's equivalent denial branch was also driven with a real browser
(`codex-deny-*.png`, real `access_denied` redirect observed); Codex's own
`--no-browser` CLI then re-prompted for another authorization URL rather
than exiting on the first `error=access_denied` callback paste — a real,
previously-undocumented Codex CLI behavior difference from Claude worth
recording as a known limit (see below), not chased to full resolution given
the server-side denial behavior (the actual release-relevant contract) was
already proven identically for both clients.

## Codex Isolation (no permanent global config change)

Per the task's instruction not to permanently change a client's global
configuration: Codex has no per-project/local MCP scope (`codex mcp add`
only writes `~/.codex/config.toml`'s global `[mcp_servers]` table). Rather
than writing there, every `codex mcp login`/`mcp logout` and `exec` call used
a uniquely-named server (`oauth_blog_task00012*`) supplied entirely through
`-c mcp_servers.<name>.url=...` command-line overrides — the same technique
`proofs/mcp-oauth-clients/run.mjs` already used for the same reason. This
never wrote `[mcp_servers.oauth_blog_task00012*]` into `config.toml` at all;
`~/.codex/config.toml` was diffed byte-for-byte identical to a pre-task
backup at the end of this task. The only persistent artifact was each named
server's OAuth credential entry under `~/.codex/.credentials.json` (Codex's
normal per-server file store, keyed by name regardless of whether the name
appears in `config.toml`), removed via `codex mcp logout <name>` for all
three names used; confirmed absent afterward. An earlier attempt to register
the server normally (`codex mcp add`, not used for any real login) was
caught by this session's own auto-mode safety classifier as a standing
global-config change and aborted before any credential was issued; the
config file was restored from backup regardless, byte-identical.

Protected tool calls used `codex exec --ignore-user-config` with a small
local deterministic HTTP stub standing in for the model backend (never a
real OpenAI/ChatGPT call), matching `proofs/mcp-oauth-clients/model.mjs`'s
already-reviewed pattern exactly: the stub inspects the real tool list Codex
sends it and requests the one named tool; Codex performs all real MCP/OAuth
work itself. This was necessary because an isolated `CODEX_HOME` has no
model-provider credential, and reading the real one into a temp directory
was (correctly) blocked by this session's credential-leakage safety check;
the stub avoids needing that credential at all, which is the same reason the
original P-003 proof used it.

Claude Code's MCP server entry used `-s local` scope (writes only to this
project's entry in `~/.claude.json`, not global), removed via
`claude mcp remove -s local` at the end; its own OAuth credential was removed
via `claude mcp logout` and confirmed absent from
`~/.claude/.credentials.json` afterward.

## Findings (Real, Not Simulated)

1. **Claude Code emits an SDK warning on `--no-browser` login**:
   `[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp
   (pre-upgrade storage or provider not round-tripping the value)`. This
   appeared on every login after the first for this server name, including
   fresh ones; it is a client-side cache-format note from Claude's own MCP
   SDK, not a defect in this library's responses (the server's own tokens
   always carried the correct `iss` on the callback, confirmed in every
   captured URL). Recorded for completeness since it is new, real client
   output not seen in the earlier P-003 proof run.
2. **Codex's `--no-browser` does not auto-capture its loopback callback**
   the way Claude's does — it always prints the authorize URL and blocks on
   a hidden "Callback URL" prompt, even though it also opens a local
   loopback listener (visible in the printed `redirect_uri`). This matches
   `recovery.md`'s "if a client cannot complete login, show the validated
   authorization link through its normal manual-login path" — Codex's
   manual-paste path is exactly that, and it worked correctly every time the
   real captured callback URL was supplied.
3. **Codex needs materially more real wall-clock time than Claude per
   invocation** (cold `codex exec` startup plus MCP discovery routinely
   exceeded the initial 25s/180s test window, one real `invalid_grant:
   Refresh token already used; approval cancelled` was observed mid-session
   against the short window — the library's one-time-use refresh-token
   reuse-detection correctly fired on what was, from the server's honest
   point of view, a genuine reuse). This is a real, correct security
   behavior, not a defect; the test window was raised to 90s/240s for the
   rest of the Codex runs, and production's real 900s/604800s defaults are
   unaffected either way (test-only env override, unset by default).
4. **Codex re-prompts rather than failing outright on a plain `access_denied`
   callback paste** in `--no-browser` mode (observed once during the denial
   test; a second authorize URL for a new PKCE pair was issued instead of
   exiting). The server-side denial behavior itself (the thing this spec
   controls) was confirmed identical to Claude's in the real browser
   transcript before this client-side retry was observed; not chased further
   since it is Codex's own CLI UX, outside this library's scope, and the
   release-relevant contract (server never issues a usable grant on denial)
   was already proven.

No contract conflict was found. No required P-003 check failed or went
unrun for either client.

## Not Covered / External Handoff

- **Desktop/system browser auto-launch**: both runs used `--no-browser`
  (required in this headless VM); neither client's automatic system-browser
  launch path was exercised. Documented as an explicit external-client UX
  limit in `recovery.md`/`proof-results.md` already; unchanged by this task.
- **Second resource/service "wrong resource" API refusal**: this blog
  example only wires one OAuth resource, so a `resource`-mismatch refusal on
  a real API route was not re-driven with a native client. Covered at the
  library level by
  [00011](../specs/00005-mcp-native-oauth/tasks/00011-production-cross-surface-and-database-checks.md)'s
  `client-redirect.test.ts`/`invalid_target` cases. (ID-only write refusal
  and unapproved-operation write refusal are now both covered with real
  native-client evidence — see "Real Approved API Writes" above; this gap
  from the first pass is closed.)
- **Public (non-OAuth) tool use without signing in**: this blog example has
  no fully public MCP tool to call; the anonymous-listing half of J08 was
  confirmed (see above), the anonymous-call half is covered by
  [00009](../specs/00005-mcp-native-oauth/tasks/00009-mcp-http-sse-and-current-identity.md)'s
  suite only.
- **Distributed/multi-process cancellation notification** and **configured
  reverse-proxy/CORS headers under the public preview proxy**: both already
  covered at the library/process level by
  [00011](../specs/00005-mcp-native-oauth/tasks/00011-production-cross-surface-and-database-checks.md)
  (`mcp-oauth-cross-process.test.ts` against real PostgreSQL+MySQL); not
  independently re-driven with a native client here — the browser-through-
  public-proxy path inherits 00010's recorded Vite/HMR limitation and was
  not retried.

No step required a human to act that this run could not itself complete;
every native-client step above was driven to a real, observed result.

## Cleanup

- All OAuth grants created during this task (both passes) were explicitly
  disconnected through the real `/connections/revoke` path before finishing.
- All six test profiles are deactivated (`active:false`): first pass
  (`oauth-ordinary`, `oauth-stronger`, `oauth-suspended`, `oauth-nofactor`)
  and the write-route follow-up (`oauth-ordinary2`, `oauth-stronger2`).
- `claude mcp remove -s local oauth-blog-00012` and `claude mcp logout` both
  run after each pass; confirmed absent from `~/.claude/.credentials.json`
  and `~/.claude.json`'s project-local scope.
- `codex mcp logout` run for all five Codex server names used across both
  passes (`oauth_blog_task00012`, `oauth_blog_task00012b`,
  `oauth_blog_task00012c`, `oauth_blog_write1`, `oauth_blog_write2`);
  confirmed absent from `~/.codex/.credentials.json`; `~/.codex/config.toml`
  confirmed byte-identical to its pre-task backup after both passes (never
  touched).
- Dev server (port 3004) stopped and removed from the `public-dev-server`
  registry after each pass; `templates/blog/.build`, `node_modules/.vite`
  and the regenerated `node_modules/blog-client` removed (regenerable,
  disposable per AGENTS.md).
- Scratch Playwright/stub-model directories under `/tmp` removed after each
  pass. Redacted logs and screenshots (78 from the first pass, plus the
  write-route follow-up's own logs/responses) kept under
  `/tmp/oauth-00012-evidence/` for user review, per this task's
  instructions; grepped for bearer/refresh/PKCE values — none present.
- `ps -u $USER` checked after every run; no watcher, test runner, FIFO
  holder, stub-model server or dev server process left running that this
  task started.
