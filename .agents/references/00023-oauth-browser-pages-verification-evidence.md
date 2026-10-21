# OAuth Approval, Factor And Connections Pages — Verification Evidence

Detailed verification evidence for spec `00004-mcp-native-oauth` task
`00007-approval-factor-and-connections-pages.md`, split out under the
500-line Agent File limit. Load this file when you need the exact commands,
test inventory, per-adapter results, coverage figures, browser observations
or the screenshot list behind that task's verification claims; the task file
keeps only the summary, decisions, blockers and current status.

## Environment

Node v22.23.2 (`source ~/.nvm/nvm.sh && nvm use 22`), Yarn 1.22.22, worktree
`/home/solution-team/.paseo/worktrees/0m6vr1k2/icky-snail`, corrected Inquire
d5f5a07 (unpublished) through the root `resolutions` block (unchanged, not
committed). Browser: headless Chromium from the local Playwright cache
(`~/.cache/ms-playwright/chromium-1243`) driven by `playwright-core@1.57`
installed only into a deleted scratch folder. The Paseo browser host did not
respond (`browser_new_tab`/`browser_list_tabs` timed out twice the same way),
so it was not used.

## Automated Tests (all flat under `packages/stackpress-session/tests/oauth/`)

| File | Cases | What it proves |
| --- | --- | --- |
| `browser-app.ts` | helper | Real Ingest HTTP server on loopback with real session, auth, csrf and oauth plugins, real `OAuthStore` and `ProfileActions`/`AuthActions` over PGlite; real username sign-in page plus the existing sign-in 2FA step; renders the real views with `react-dom/server` and embeds props exactly like Reactus (raw `JSON.stringify` via `String.replace`) |
| `pages-authorize.test.ts` | 18 | J03 cookie flags/clean return/hash-only storage; J04 escaped name/hosts/service/scopes/operations and local notice; no JWT/cookie/header/state/PKCE in HTML or startup data; script-breakout client name; approve → code+state+iss and real token exchange; duplicate submit; deny; tampered hidden fields; forged/query-only CSRF; cross-browser and copied-cookie reuse; policy/role change; client return-address change; policy denial; policy narrowing; J07 suspended; expired/lost; unsafe/unknown client and return address; guest POST |
| `pages-factor.test.ts` | 12 | J05 real TOTP check, receipt bound and saved, preselection after check, full-selection receipt; changed (wider/narrower) selection; same code across two requests and true concurrency (exactly one accepted); copied receipt; per-request attempt limit with Retry-After; forged factor form; J06 missing factor on both pages; explicit app fallback; stale selection/other account/suspended; TOTP counter helper |
| `pages-connections.test.ts` | 10 | J14 sign-in return; J13 empty state and account link; own-only list, escaped names, no key/hash/JWT; saved disconnect ends verification, repeat succeeds; foreign/unknown/missing grant unavailable; forged form; save failure (PL/pgSQL trigger) claims nothing; J07 suspended; program key does not open the list; list outage |
| `pages-browser-edges.test.ts` | 7 | 503 before `finalize()`; none of the six routes is native and `session.access` still blocks guests; `limits.authorization` on start and approval POST; client-document host display and no stale fallback; JSON fallback; translated text from app language config; helper edge cases |
| `pages-browser-races.test.ts` | 6 | Changes landing between the page checks and the event's re-check (policy denial, resolved elsewhere, expiry), failed approval write then successful retry, rate-limit/pending store outages, factor store outages, factor page on denied/broken request |
| `factor-receipt-adapters.test.ts` | 4 | A >255-character signed receipt saves and verifies on PGlite, PostgreSQL, MySQL and SQLite |

Two checks were confirmed to fail without their fix before being kept:
the script-breakout test fails when the raw snapshot is passed to the
renderer (`<script>alert(1)` present), and the full-selection factor test plus
the PGlite receipt test fail with the old `VARCHAR(255)` column.

## Commands And Results

```bash
cd packages/stackpress-session
npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit   # clean
yarn build                                                                         # clean
timeout 900 yarn test        # baseline before changes: 430 passing, 46 pending, 0 failing
timeout 900 yarn test        # final, after all changes: 485 passing, 48 pending, 0 failing (42 test files)
```

All four databases, disposable tmpfs containers (`oauth-00007-pg`
postgres:17-alpine on 127.0.0.1:55571, `oauth-00007-mysql` mysql:8.4 on
127.0.0.1:55572), run under `flock /tmp/oauth-db.lock` with
`OAUTH_00003_*` and `OAUTH_00008_*` ports pointed at them, then stopped and
auto-removed (confirmed gone with `docker ps -a`):

```bash
npx ts-mocha -r tsx tests/oauth/store-adapters.test.ts tests/oauth/client-store-adapters.test.ts \
  tests/oauth/legacy-store-adapters.test.ts tests/oauth/factor-receipt-adapters.test.ts
# 96 passing, 0 pending, 0 failing (PGlite, PostgreSQL, MySQL, SQLite in every suite)
```

A first attempt showed 12 pending because the legacy suite reads
`OAUTH_00008_*` ports; it was rerun with both variable sets and every adapter
passed. No pre-existing container was touched.

## Coverage

`nyc` only counts files a test loads. The real-stack page tests load
pre-existing `src/auth`, `src/profile` and non-event `src/session` modules
that no earlier test loaded, so the package total now includes about 2,014
statements of untested pre-spec code.

| Scope | Before (baseline run) | After (final run) |
| --- | --- | --- |
| Package `All files` as printed by `yarn test` | 94.07% stmts / 88.43% branches | 78.91% stmts / 71.11% branches |
| Like-for-like: `src/oauth/**` + `src/session/events/**` | 94.07% | 94.95% stmts (2388/2515) / 88.96% branches |
| Task 00007 new source files | — | 95.87% stmts (626/653) / 86.78% branches |
| Newly loaded pre-existing auth/profile/session modules | not measured | 58.89% stmts (1186/2014) |

The 48 pending tests are the 46 PostgreSQL/MySQL adapter skips already
present in the baseline plus this task's two PostgreSQL/MySQL receipt legs,
all of which passed in the container run above. Per new file (after, first
post-change run): `pages/authorize.ts` 97.24%, `pages/browser.ts` 94.52%,
`pages/connections.ts` 95.58%, `pages/factor.ts` 94.31%,
`views/authorize.tsx` 100%, `views/components.tsx` 90.32%,
`views/connections.tsx` 100%, `views/factor.tsx` 97.29%, `views/snapshot.ts`
75% (one defensive branch), `storage/tables.ts` 100%.

## Browser Observations (real Reactus dev renderer, headless Chromium)

- Approval page focus order (Tab from page start): Read articles, Change
  articles, `GET /api/articles/:id`, `PUT /api/articles/:id`, Approve, Deny,
  Manage connected programs, Account settings. Narrowing and approving were
  done by keyboard only (Space on a checkbox, Enter on Approve).
- Connections focus order: Disconnect Claude Code (local), Disconnect Codex
  CLI <local build>, Back to account settings; each Disconnect button has an
  accessible name naming its program.
- Every visible input has a programmatic label; the factor code input carries
  `aria-describedby` for its help text and, after a failure,
  `aria-invalid="true"` plus the `role="alert"` error message.
- Startup data (`<script id="props">`) on the approval and connections
  pages: session token empty, request headers `{}`, no `demo-state`, no
  `code_challenge`/verifier, no Authorization text; the session JWT and the
  HttpOnly continuation cookie values appear nowhere in the HTML. The only
  cookie value present is the CSRF token in the hidden form field, which the
  double-submit form requires.
- Cookies: `oauth_continue` HttpOnly, SameSite=Lax, path `/auth/oauth2`;
  Secure is omitted only because the preview ran in `development` mode with
  an HTTP loopback issuer (production always sets Secure). The existing
  `session` cookie is not HttpOnly — pre-existing session-plugin behaviour,
  out of this task's scope.
- `autoFocus` on the factor input was not observed as focused in the
  headless measurement (active element empty); the field is still first in
  tab order. Recorded as observed, not claimed.
- Dev-only console noise: Vite's client probed HMR port 24678, which belongs
  to another project's dev server on this shared VM; HMR was disabled for the
  preview. Not an application error.

## Screenshots (`/tmp/oauth-00007-shots/`, kept for user review)

| File | Caption |
| --- | --- |
| `01-j03-signed-out-redirected-to-signin.png` | Signed-out person following a program link lands on the existing sign-in chooser with a same-app return to the approval page |
| `02-authorize-ordinary-account.png` | Approval page for an ordinary account: client name, registered ID, return host and address, exact service, scope labels, API operations, local-program notice, Approve/Deny |
| `03-approve-success-callback.png` | After a keyboard-only narrowed approval, the demo program's callback received code (redacted), state and iss and exchanged it for `articles:read` only |
| `04a-authorize-second-program-escaped-name.png` | Second program whose name contains `<local build>`, shown as escaped text |
| `04-deny-callback.png` | Deny returned `error=access_denied` with the original state and iss; no code |
| `04b-authorize-after-deny.png` | Revisiting the denied request shows the local "You denied this request" page |
| `04c-authorize-already-finished.png` | Revisiting a completed request (duplicate submit / lost callback) shows "already finished; nothing new was issued" with restart guidance |
| `05-connections-list.png` | Connected-programs list with two active approvals and Disconnect buttons |
| `06-disconnect-confirmation.png` | Confirmation after a saved disconnect; the remaining connection is still listed |
| `07-connections-empty-state.png` | Empty state after disconnecting the last program, with the back-to-account link |
| `08-j14-connections-signed-out-signin.png` | Signed-out visit to the list goes to sign-in with a safe return |
| `08b-j14-after-signin-connections.png` | After sign-in the person returns to their list (empty for this account at that point) |
| `09-authorize-factor-required.png` | Stronger-check account: approval page says an authenticator check is required; button reads "Continue to identity check" |
| `10-factor-page.png` | Separate factor page listing exactly the access being verified, labelled code field |
| `11-factor-failure-invalid-code.png` | Factor failure: field marked invalid with an alert explaining the bad code |
| `12-authorize-factor-verified.png` | Back on approval with "Identity check complete for the selection shown" |
| `13-factor-approve-success-callback.png` | Approval after the check reached the program and exchanged for both scopes |
| `14-factor-code-reused.png` | Same authenticator code on a new request is refused as already used |
| `15-factor-unavailable-no-approval.png` | Missing-factor account: explanation, set-up link and cancel only; no Approve button (HTTP 403) |
| `16-factor-page-unavailable.png` | Opening the factor page directly without an authenticator shows the same refusal |
| `17-inactive-account-refused.png` | Suspended account refused on the approval page with an account-help message |
| `17b-inactive-account-connections.png` | Suspended account cannot open the connections list |
| `18-lost-request-restart.png` | Signed-in visit with no saved request shows restart instructions |
| `19-unsafe-return-address-local-error.png` | Unregistered return address stays on a local error page; no redirect |
| `observations.json` | Focus orders, label audits, startup-data audit and alert texts recorded by the driver |

The screenshots contain only demo accounts, public client IDs and redacted
codes; no session JWT, CSRF value, TOTP secret, access key or renewal token
is visible.
