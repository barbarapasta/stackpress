# 00012 — Run the complete real-client journeys before release

Status: verified (2026-10-15, orchestrator review pass closed). Full P-003
checklist, real native-client recordings, the real approved-API-write
follow-up and a readable release-check report are in [reference
00028](../../../references/00028-oauth-real-client-journeys-release-check.md).
This task has visual acceptance — see Acceptance Notes; left at `verified`,
not self-accepted.
Owner: integrated Stackpress test app with real Codex, Claude Code and browser.
Stage: 6; mandatory P-003 release gate.
Depends on: [00011](00011-production-cross-surface-and-database-checks.md)
Journeys: J01–J14; required complete P-003 journey.
Contracts: [proofs](../proofs.md), [proof-results](../proof-results.md), [journeys](../journeys.md), [recovery](../recovery.md), [verification](../verification.md).

## Task Summary

Prove that people can sign in, approve, use, renew and disconnect through the finished library with actual native clients.

Follow the shared working and evidence rules in [sprint](sprint.md). The Frozen
contracts control behavior; these steps do not authorize changing them.

## Implementation Steps

1. Record exact Node, SDK, protocol, browser, Codex and Claude versions and app settings. Use real account sign-in, CSRF, extra-factor checks and generated stores, not the earlier simulated user fixture.
2. For each client, start from only the service URL and its normal login path, complete real browser approval and callback delivery, then invoke a protected tool and verify its business result.
3. Cover ordinary and stronger-check people, missing factor, denial, suspended accounts, public discovery/private schema relisting, expired/lost pending requests and owned/foreign connections.
4. Use short test-only lifetimes to check automatic renewal, both key parts rotating, unchanged final deadline, cancellation and next-call refusal on a long-lived connection. Test reapproval with a new connection afterward.
5. Use each genuinely issued key on approved ordinary API reads/writes, refuse unapproved operations/resources and prove the same disconnect ends MCP/API/renewal. Do not manually install a key in the native client.
6. Check explicit extra-permission/membership reapproval and documented native commands. Record unsupported automatic browser/escalation behavior honestly; no automatic repetition of writes after unknown outcomes.
7. Capture redacted browser recordings and a readable release-check report, including proxy/CORS and multi-process observations from 00011. Clean up test accounts/credentials/resources. Prepare release evidence without publishing or deploying.

## Verification Process

- Both native clients must complete required P-003 steps using the implemented library; fixture results from the earlier proof cannot substitute.
- Correlate actual protected business-event completion and returned client result; establish true callback delivery and long-lived next-call refusal, which earlier fixture checks did not prove.
- Map every J01–J14 branch to actual evidence or an explicit external handoff result. Failed/unrun requirements remain release blockers; shortening test clocks does not change production defaults.
- Run document/link/whitespace checks on the final report and verify redaction. After verification, present the existing visual evidence for user review; do not self-accept it or mark implementation complete prematurely.

## Acceptance Criteria

Review the real browser/client recordings and readable release-check report. Both clients must show successful approval, protected use, renewal, refusal after disconnect and explicit reapproval; stronger checks, denial and ownership boundaries must be visible. Known client limits must be stated, and no failed or unrun required check may be presented as passing.

## Implementation Notes

Done 2026-10-15 in this worktree (uncommitted), against 00011's verified work
and Inquire `d41472e` (unpublished, root `resolutions` block, unchanged and
not committed). Full detail in [reference
00028](../../../references/00028-oauth-real-client-journeys-release-check.md).

Changed files, all in `templates/blog` (the example app, 00012's own scope):
`config/common.ts` (env-gated `OAUTH_TEST_ACCESS_SECONDS`/
`OAUTH_TEST_RENEWAL_SECONDS` override, unset by default — production
900s/604800s defaults unchanged), `plugins/app/oauth.ts` (added
`requireFactor: stronger` to the approval policy so J05/J06's fresh-check
path has a real code path in this example; app-owned policy decision per
its own comments, no Frozen-contract change). No `packages/*` source
changed by this task. Four real test accounts created through the real
`/auth/signup` form (`oauth-ordinary`, `oauth-stronger` with real TOTP,
`oauth-suspended`, throwaway `oauth-nofactor`), never a database shortcut.

**2026-10-15 follow-up (orchestrator review).** 00010 step 3/00012 step 5
both require demonstrating approved API *writes*, not only reads; the
example only ever had one `GET /api/articles/:id` route. Added a real write
counterpart, `PATCH /api/articles/:id` (`config/common.ts`, event
`article-update`, `oauth.operation: 'articles.update'`, `scopes:
['articles.write']`; frozen-config-compliant: explicit method, one stable
operation ID, exact resource), and documented it in `docs/oauth.md`'s API
opt-in example. A short dated note was also added to
[00010](00010-package-exports-blog-and-upgrade-docs.md)'s own Implementation
Notes. Two more real accounts (`oauth-ordinary2`, `oauth-stronger2` with
real TOTP) were created for this pass; no other source changed.

## Verification Notes

Full environment, exact commands, the complete P-003 12-point checklist for
both clients, additional J01–J14 branches, real findings and cleanup record
are in [reference
00028](../../../references/00028-oauth-real-client-journeys-release-check.md).
Summary: both Claude Code 2.1.296 and Codex CLI 0.161.0 completed native
login (real DCR/PKCE/browser approval/callback), a protected MCP tool call,
automatic renewal (real server-side refresh-token rotation observed, both
via direct database trace for Claude and via the client's own stored-token
expiry moving forward for Codex), refusal on the next call after a real
`/connections/revoke` disconnect, and reapproval — against the real
`templates/blog` app, real accounts, real browser forms, no simulated
sign-in. Shared MCP/API key, read-ID rule and API route-membership
boundaries were also proven with each client's own real issued key (read
from the client's own credential store, never injected into it). Denial,
suspended-account refusal, a real TOTP stronger-check approval (J05) and a
missing-factor refusal (J06) were additionally driven with Claude Code and a
real browser. No required P-003 check failed or went unrun for either
client; no Frozen-contract conflict found.

**2026-10-15 follow-up.** The new `PATCH /api/articles/:id` write route was
proven with both clients' own real, separately-obtained issued keys: full
`id:secret` key with an approved write succeeds and persists the real
database change (with the caller's `profileId` server-injected, matching
events.md's reserved-field protection); the ID-only part of the same key is
refused; a different real grant that never approved `articles.write`/
`articles.update` is refused; and the identical working key is refused
immediately after a real `/connections/revoke` disconnect. All four checks
passed for both Claude Code and Codex. A real security finding (not a
defect) was also observed and recorded: the server's renewal-reuse
cancellation correctly fired once during exploratory multi-call checking,
matching events.md/J11's documented behavior exactly. `python3
.agents/scripts/validate-agent-workspace.py`: no ERROR after this pass;
pre-existing line-count WARNs only. `npx tsc --noEmit -p
templates/blog/tsconfig.json`: only the pre-existing, unrelated
`contributeDesktopMenu` error remains; nothing from the new route.

Cleanup: all grants from both passes disconnected, all six test profiles
deactivated, both clients' local credentials/config entries removed and
confirmed absent (`~/.codex/config.toml` confirmed byte-identical to its
pre-task backup after both passes — never permanently modified), dev server
stopped and deregistered after each pass, scratch removed. Redacted
screenshots and logs (78 from the first pass plus this follow-up's own
logs/responses) kept under `/tmp/oauth-00012-evidence/` for user review
(grepped clean of bearer/refresh/PKCE values).

## Acceptance Notes

Not reviewed. Present reference 00028's full report together with the
screenshots/logs under `/tmp/oauth-00012-evidence/` for explicit user
acceptance; acceptance has not been delegated. Both clients show successful
approval, protected use, renewal, refusal after disconnect and explicit
reapproval; stronger checks (J05/J06), denial (J04) and the suspended-
account boundary (J07) are visible in the Claude Code recordings; approved
API writes, ID-only write refusal, unapproved-operation write refusal and
post-disconnect write refusal are now proven for both clients (see
reference 00028's "Real Approved API Writes" section). Known client limits
(Codex's manual-paste `--no-browser` callback flow, its denial-path
re-prompt behavior, and the untested system-browser auto-launch path for
both clients) are stated in reference 00028, not presented as passing.
