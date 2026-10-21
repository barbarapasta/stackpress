# 00007 — Build approval, extra-check and connected-program pages

Status: verified (2026-10-15). Code, tests, four-database runs and browser capture are complete; the package-wide coverage gap this task's tests surfaced was resolved by side task [00007A](00007A-session-package-coverage.md) (verified 2026-10-15). Acceptance is reserved for the user (see Acceptance Notes).
Evidence: [OAuth browser pages verification evidence](../../../references/00026-oauth-browser-pages-verification-evidence.md).
Owner: stackpress-session OAuth pages/views and existing account navigation.
Stage: 3, browser experience.
Depends on: [00005](00005-approval-key-lifecycle-and-policy.md), [00006](00006-oauth-protocol-routes-and-browser-guard.md)
Journeys: J03–J07, J13, J14; approval portions of J10/J12.
Contracts: [events](../events.md), [journeys](../journeys.md), [configuration](../configuration.md), [storage](../storage.md).

## Task Summary

Let people safely approve or deny programs, complete a required fresh check, and disconnect their own approvals.

Follow the shared working and evidence rules in [sprint](sprint.md). The Frozen
contracts control behavior; these steps do not authorize changing them.

## Implementation Steps

1. Add approval GET/POST and server-saved pending state bound to the safe browser continuation cookie. Reuse existing sign-in and safe same-app return; reload account, client and policy before displaying/submitting.
2. Show escaped client name/hosts, exact service, scope labels and API operations, with a local-program notice and no publisher-verification claim. Allow only narrowing selections; use translations and accessible form feedback.
3. Add the separate fresh-factor page using the existing verified TOTP mechanism. Bind a short-lived receipt to the person/request/final selections and save a consumed counter in OAuthFactorUse; never repurpose Auth.consumed.
4. Enforce CSRF and shared limits on browser POSTs. Missing/unavailable factor cannot be skipped unless app policy explicitly permits an alternative; changed selections invalidate the receipt.
5. Handle approve/deny, stale details, lost/expired pending state, duplicate submit, unsafe returns and callback failure exactly as J03–J07. Render only an explicitly safe snapshot, never complete me/request wrappers or key material.
6. Add owned connections listing/disconnect, empty state and account/back navigation. Check current account and ownership, confirm only saved cancellations, and keep legacy-key management separate.

## Verification Process

- Exercise the full J03–J07/J13/J14 browser paths with signed-out, ordinary, stronger-check, missing-factor and suspended accounts; include denied access and retry feedback.
- Test tampered hidden fields, cross-browser pending reuse, forged forms, role/client changes before submit, TOTP reuse/concurrency, changed selections, repeated revoke and foreign grant IDs.
- Inspect server-rendered HTML and browser startup data for secrets, session JWTs, authorization headers and unsafe client-supplied text. Check keyboard use, focus, labels, errors and translated states.
- Use the real session/store code rather than a simulated signed-in fixture. Save a small redacted recording/screenshots of approval, denial, factor failure and disconnect for review.

## Acceptance Criteria

Review the rendered approval, factor and connections pages, including their error/empty states. Names, requested access, hosts, approve/deny choices and cancellation results must be clear; navigation and keyboard use must work. Confirm that unavailable extra verification does not silently approve access.

## Implementation Notes

Built 2026-10-15 against the 00005 events and 00006 routes in this worktree
(uncommitted), Inquire d5f5a07 (unpublished, root `resolutions` block,
unchanged and not committed). Nothing was committed.

New files in `packages/stackpress-session/src/oauth/`:
- `pages/browser.ts`: shared guard and render helpers. Loads the browser
  profile from the ordinary session cookie; binds the pending request to the
  `oauth_continue` cookie (HttpOnly, SameSite=Lax, Path=`base`,
  Max-Age=`pendingSeconds`, Secure except in `development` with an HTTP
  loopback issuer; only its `pending-binding` hash is stored).
  `prepareApproval` reloads, in order: the pending request (another
  account's request is refused before its status is shown), the account
  (`loadSafeProfile`, J07), the client and its return address (no stale
  fallback), the service, the still-configured request, factor availability
  and `invokeApprovalPolicy`. Also: body-only CSRF (token must be in the POST
  body), TOTP counter matching with the existing `generateTOTP` (same ±1
  window as `verifyTOTP`; the time step is sampled before and after
  matching), and `renderBrowserPage`.
- `pages/authorize.ts` (GET start/display, POST approve/deny), `pages/factor.ts`
  (GET/POST), `pages/connections.ts` (GET list, POST `/connections/revoke`).
- `views/authorize.tsx`, `views/factor.tsx`, `views/connections.tsx`,
  `views/components.tsx`, `views/types.ts` (safe snapshot types),
  `views/snapshot.ts`.

Shared files changed, all additive (please reconcile with 00006/00009):
- `src/oauth/plugin.ts`: registers the six browser routes after the
  native routes. They are not in `isNativeRoute`, so `session.access` still
  applies; a test asserts all six are non-native.
- `package.json`: `./oauth/views/*` and `./{esm,cjs}/oauth/views/*` exports
  and `typesVersions` (configuration.md "OAuth view subpaths"). A concurrent
  `./oauth/metadata` export added by another task was preserved.
- `styles.css`: an appended `oauth-*` section.
- `src/oauth/storage/tables.ts` and `oauth.idea` (00003's files):
  `factor_receipt` is now `TEXT` / `Text?` instead of `VARCHAR(255)` /
  `String?`. The browser run found that 00005's `setPendingFactorReceipt`
  handoff stores the full signed receipt, which embeds the selection and is
  longer than 255 characters for ordinary selections. Saving failed and the
  error escaped as a raw 500. storage.md fixes no column type, so this is
  not a Frozen-contract change. Apps that already generated/migrated
  `oauth.idea` need a migration; 00010/00011 should cover it.

Not touched: `pages/{discovery,helpers,register,revoke,token}.ts`,
`events/authorizationStart.ts`, `events/clientRegister.ts`, every 00005/00006
event and test file, `packages/stackpress-ai`, `tasks/status.md`,
`status.md`.

Decisions recorded for later tasks:
1. These pages are not `ctx.view` routes. The generic view engine puts the
   full `me` result (session JWT), every request header, every cookie and all
   request data into page startup data, which events.md forbids. The pages
   call `ctx.view.render` with props built only from public brand/language/
   view configuration plus the snapshot; with `?json` or no renderer they
   return the same snapshot as JSON. Responses set `no-store`,
   `X-Frame-Options: DENY`, `frame-ancestors 'none'` and `no-referrer`.
2. Finding outside this task (not fixed here, upstream Reactus/stackpress-view
   issue — reported here for the Reactus maintainer, not changed in this
   worktree): Reactus inserts `JSON.stringify(props)` unescaped into
   `<script id="props">` via `String.replace`. Any page whose props hold
   user-controlled text can be script-injected (`</script>`) or corrupted
   (`$'`). These pages send the snapshot as one URI-encoded string that the
   view decodes, and a test proves a hostile client name stays inert. Other
   pages that use the generic engine remain exposed; recommend a Reactus/
   stackpress-view follow-up.
   - **Minimal reproduction (traced by reading source, not executed against
     a running app — it does not need to be, since the vulnerable step is
     entirely inside Reactus' own document template):** Reactus' document
     template builds the response body as
     `template.replace('<!--document-props-->', JSON.stringify(props))`
     (same shape the 00007 test harness mirrors exactly in
     `tests/oauth/browser-app.ts`'s `DOCUMENT_TEMPLATE`/`renderView`, which
     is how this was found and proven for this task's own pages). If any
     string value reachable from `props` contains the literal substring
     `</script`, `JSON.stringify` escapes neither `<` nor `/`, so the
     emitted HTML becomes `<script id="props">{"name":"</script><script>alert(1)</script>"}</script>`
     — the attacker's `<script>` tag runs as a sibling of the real one. No
     further app logic needs to be hit; `JSON.stringify` alone never
     escapes `</script`, unlike `JSON.stringify` used with a manual
     `.replace(/</g, '\\u003c')` guard, which Reactus does not apply here.
   - **Affected surface (existing stackpress-session pages that render
     user-controlled values into Reactus page props, traced via
     `src/session/pages/account.ts`'s `loadAccountProfile`):**
     `${auth.base}/account` and `${auth.base}/account/security` (both wired
     through `ctx.view.get(...)` in `src/session/plugin.ts` to the generic
     Reactus engine, per the Decisions note above) serve `profile.results`
     — including `name`, which the person can set to arbitrary text via
     `${auth.base}/account/update` — as `results` in the `StatusResponse`
     that `setViewProps` turns into page props. A profile renamed to
     `</script><script>...</script>` would therefore self-XSS on that
     person's own next visit to `/account`, and — more seriously — on any
     other surface that renders another account's `name` through the
     generic view engine (e.g. an admin profile list, if one is later
     built on the same pattern), since nothing here scopes the exposure to
     "your own" profile. This task's own OAuth pages are not on this list
     (see the Decisions note above: they deliberately avoid `ctx.view`
     routes for an unrelated reason — session-data leakage — which also
     happens to route around this Reactus issue). Not fixed here: out of
     this task's package/file scope (`stackpress-view`'s Reactus
     integration, not `stackpress-session`'s OAuth pages) and the Decisions
     note already correctly identified it as an upstream follow-up at
     verification time; this entry adds the concrete repro and surface the
     orchestrator asked for without touching Reactus or
     `session/pages/account.ts`.
3. Start flow: `GET /authorize?client_id=…` calls `oauth-authorization-start`
   (which enforces `limits.authorization`), sets the cookie and redirects
   (303) to the clean `/authorize`. Guests go to the existing
   `${auth.base}/signin?redirect_uri=${base}/authorize`; `/connections` uses
   `${base}/connections` as its return. Apps that enable `session.access`
   must grant GUESTs `GET ${base}/authorize` (for J03) and, if they want
   J14's redirect instead of a 401, `GET ${base}/connections`. 00010 should
   document this.
4. Approval submits only the person's exact choice. The page re-runs
   `invokeApprovalPolicy` for the submitted subset. Anything not offered
   now, or a policy answer that differs from the subset, redisplays with a
   notice instead of approving a different set. `oauth-authorize` then
   repeats its own checks; a disagreement there also redisplays.
5. Factor flow: an approve that needs a check redirects to
   `/factor?scope=…&operation=…&selected=1` (identifiers only). A valid code
   calls `checkAndAdvanceFactor(auth2faId, sha256("oauth-factor-incarnation:" + secret),
   profileId, counter)` and then `createFactorReceipt` for the
   policy-decided content and `setPendingFactorReceipt`. The approval page
   preselects only a receipt that verifies for this person and request.
   `oauth-authorize` receives the receipt read back from the pending row,
   never from the form. `Auth.consumed` is untouched.
6. Rate limits: `limits.authorization` covers start and approval POSTs (one
   shared bucket per issuer/source). The factor POST checks the source stage
   (`limits.factor.source`), then pending+profile
   (`limits.factor.attempts`), before the code is examined. Disconnect has
   no configured limit, and none was invented.
7a. **Orchestrator check (2026-10-15): `05-connections-list.png`'s "Claude
   Code (local)" row shows Permissions "Read articles" but API operations
   "articles.detail, articles.update"**, which looks inconsistent if
   `articles.update` requires an `articles:write` scope the grant does not
   carry. Checked against the Frozen contract, this is correct, by design,
   not a defect:
   - configuration.md's API opt-in example registers each operation's own
     `scopes` on the operation descriptor itself (`scopes: ['articles:read']`
     for `articles.detail`), fingerprinted with method/template/event/fixed
     data so "changing the operation cannot silently reuse approval" — scope
     requirements live on the *operation*, not on the grant's scope list.
   - events.md's approval policy result independently supplies `scopes` and
     `operations` ("membership and scopes remain independent checks"); the
     access-policy input/result pair for exchange/verify/refresh is likewise
     `{ scopes }` only, separate from API/MCP membership ("Empty-scope and
     any-match behavior stays with AI/API"). storage.md's `OAuthGrant` stores
     "scope set" and "approved API descriptor fingerprints" as two distinct
     fields for the same reason.
   - verification.md's Permission lists row states plainly: "key scopes and
     route/tool scopes are tested separately" — confirming both checks are
     meant to run independently at use time (00008/00009's dispatch layer,
     already verified), not be cross-validated against each other at
     approval/display time.
   - So an approval can legitimately carry an operation the grant's scope
     set does not (yet) authorize for scope-gated business logic; the use-
     time dispatcher is the thing that must refuse `articles.update` without
     `articles:write`, regardless of what the connections page lists as
     "approved." The screenshot reflects the demo harness's own policy
     function approving that combination for illustration, not a page- or
     event-layer bug. No fix made in `pages/authorize.ts`,
     `pages/connections.ts`, or 00005's `authorize.ts` event; this is
     recorded here instead per the orchestrator's instruction, since the
     Frozen contract already explains the behavior.
7. The connections list uses `oauth-grants-list` (active grants only) and
   names programs from saved data only (registered metadata or the cached
   client document; no network). Disconnect uses `oauth-grant-revoke`.
   Success is shown only after the event returns; `invalid_grant` is shown
   as "unavailable" without naming an owner; any other failure offers a
   retry. Legacy API keys are only mentioned as managed elsewhere.

Ingest form parsing (`formDataToObject`) collapses repeated keys to the last
value and casts digit strings to numbers. These pages therefore use
`scope[]`/`operation[]` arrays, re-stringify values, and pad the 6-digit code
like the existing sign-in 2FA page. The same parser means 00006's
`singleFormField` duplicate check never sees an array for plain repeated keys.
That is noted for 00006, not changed here. Ingest's HTTP dispatcher also calls
`setHeader('Set-Cookie')` once per cookie, so only the last cookie change per
response survives; each page response here changes at most one cookie.

## Verification Notes

All Verification Process items were run with real evidence. Details,
commands, per-file coverage, browser observations and screenshot captions
are in [OAuth browser pages verification evidence](../../../references/00026-oauth-browser-pages-verification-evidence.md).

- Paths and accounts: 53 new real-stack tests (real HTTP server, real
  sign-in including the existing 2FA step, real session JWT, csrf plugin,
  OAuthStore and Profile/Auth store over PGlite). They cover J03–J07, J13
  and J14 for signed-out, ordinary, stronger-check, missing-factor and
  suspended accounts, including denial and retry feedback.
- Attacks and races, all pass: tampered hidden fields; cross-browser and
  copied-cookie reuse; forged and query-only CSRF; role and client changes
  before submit; TOTP reuse and true concurrency (exactly one accepted);
  changed selections; copied receipts; repeated revoke; foreign and unknown
  grant IDs; store outages; races with the event's re-check.
- HTML and startup data: no session JWT, continuation cookie, headers,
  state/PKCE or key material, checked in tests and in the real Reactus page.
  A hostile client name cannot break out of the startup data script.
  Keyboard order, labels, `aria-invalid`/alerts and translated text were
  checked (translation via a test-supplied language map).
- Databases: every store suite passes on PGlite, PostgreSQL, MySQL and
  SQLite (96 passing, 0 pending) in disposable containers under
  `flock /tmp/oauth-db.lock`.
- Compile is clean (cjs+esm) and `yarn build` succeeds.
- Final `stackpress-session` `yarn test` (42 files, all flat): 485 passing,
  48 pending (PostgreSQL/MySQL legs without containers), 0 failing. The
  baseline run was 430/46/0.
- Coverage: the like-for-like scope (`src/oauth` + `src/session/events`)
  rose from 94.07% to 94.95% statements, and the new files are at 95.87%.
  The real-stack tests also newly load pre-existing, mostly untested
  `src/auth`/`src/profile`/`src/session` modules that nyc had never measured
  before, which dropped the package-wide total `yarn test` prints to 78.91%
  (a measurement change, not a regression in this task's own code).
  **Orchestrator ruling (2026-10-15):** the sprint's >90% rule applies to
  the whole package, not a like-for-like OAuth slice; side task
  [00007A](00007A-session-package-coverage.md) was opened (same precedent
  as 00002A) and added direct tests for the pre-existing auth/profile/
  session code. 00007A is verified: package-wide `yarn test` now reports
  91.03%/91.94% (statements/lines) on PGlite alone and 91.23%/92.15% with
  all four databases up — see 00007A's own Verification Notes for the full
  breakdown, commands and the one real pre-existing defect its tests
  surfaced and fixed (`AuthActions.create()`'s PGlite/PostgreSQL branch
  returned an encrypted-looking `token` instead of the plaintext value).
  No further 00007 code change was needed for this.
- Paseo browser tools timed out twice the same way and were not retried.
  The same flows ran in a real headless Chromium against one preview started
  through the `public-dev-server` skill (port 3017, local verification only;
  the public mapped URL was not reachable from this host). The preview has
  been stopped. 24 redacted screenshots (approval, denial, factor failure,
  disconnect and every other named state) are kept in
  `/tmp/oauth-00007-shots/` for review.

## Acceptance Notes

Not reviewed. Acceptance is reserved for the user and has not been
delegated. Present `/tmp/oauth-00007-shots/` (captions in the evidence
reference) for review of the approval, factor and connections pages,
including error and empty states, navigation and keyboard use, and
confirmation that an unavailable extra check never silently approves access
(shots 15 and 16, plus tests in `pages-factor.test.ts`). Record the user's
response here.
