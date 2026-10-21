# Status

Spec status: Frozen 2026-09-27 by explicit user instruction ("Freeze 🥶").
Implementation status: `accepted` 2026-09-27; all eight tasks reached
`verified` the same day, delegated task by task to autonomous agents
(Sonnet 5, medium reasoning, auto mode) and reviewed by the orchestrator.
The user accepted the four visual artifacts on 2026-09-27, so the
implementation is `completed`. See [tasks/status.md](tasks/status.md).
Staging rollout requested by the user the same day ("apply it to staging
environment. I will test it myself").

## Freeze Checklist

| Item | Where it stands | What happens next |
|---|---|---|
| Brief, scope, non-goals, who is involved | drafted 2026-09-27 | User reads and adjusts |
| Check against other specs | done for Spec 00031 at opening | G-010 lists the shared rules; no Frozen file is edited |
| Open questions and proposed answers | grill pass frozen 2026-09-27 after three sessions: thirteen answered by the user, two settled by code, one accepted at opening; none open | Nothing; every Gap G-001 to G-015 is answered |
| Research | complete 2026-09-27; all accepted answers confirmed; the four questions it added are answered | Ready to Freeze |
| Proofs | P-001 and P-002 proved 2026-09-27 on the preview with Claude Code 2.1.283 and Codex 0.157.0 | Frozen with the spec; prototype stays under `proofs/mcp-native-oauth/` |
| User journeys | ten journeys drafted 2026-09-27 in [journeys](journeys.md); G-015 accepted | Done |
| Context promotion | done 2026-09-27: `.agents/context/agent-access.md` created (Spec 00031 section moved there, Spec 00032 contract added); index updated | Frozen |
| Freeze | complete 2026-09-27 | Plan tasks under `tasks/` with the Spec Task Implementation Workflow |

## Grill Record

Session 1, 2026-09-27. Seven questions asked one at a time, seven answered;
Q-004 was confirmed after a plain explanation (Q-004a). Session 2, the same
day, asked the four questions research added; all four answered. Every
accepted answer matched the proposed default. See
[questions](questions.md).

## Research Record

R-001 to R-006 run 2026-09-27. Every answer accepted in the grill session
held up. Five were sharpened (both spellings of the machine's own address,
top-level reply fields, the exact tool server address and its own index
file, the fetch rules for a client's page, and the rate limit for the
description-and-id way). Four new questions were found: G-011 naming
Resourcing on every redirect back, G-012 what the approval page shows about
the client, G-013 writing the address on keys from the other logins, G-014
which permissions the "not logged in" answer names.

## Proof Record

P-001 and P-002 run 2026-09-27. The user approved the Claude Code page in
their own browser and confirmed its content; the two-factor step and the
paste-back flow were exercised. Because the clients' callback listeners
live on the host where the clients run, the remaining rounds were completed
by a headless browser on that host. Every accepted answer held with both
real clients. One research correction: Codex sends the tool server address
by default. Shortcuts taken in the prototype are listed in
`proofs/mcp-native-oauth/results.json` and must not be carried into
implementation.

## Context Promotion Candidates (at Freeze)

- The standard client login as the main way in for MCP clients, beside the
  Spec 00031 logins, sharing one Session model.
- The index-file facts every future spec inherits: the tool server address
  is `<origin>/api/mcp`, clients by web address are supported, `S256` is
  required, Resourcing names itself on redirect, `offline_access` is never
  listed.
- The reply rule: the whole key in `access_token` for client logins, at the
  top level.
- The proof learning: both clients renew by themselves and drop the key
  after Disconnect; the callback listener lives where the client runs.

## Freeze Record

The user opened the spec on 2026-09-27 ("Go."), answered thirteen grill
questions across three sessions the same day, confirmed the research queue,
approved the Claude Code page in their own browser during P-001, and
instructed Freeze ("Freeze 🥶") after the journeys map.

Clerical correction 2026-09-27 after Freeze: the G-005 status line in
decisions.md still carried its pre-answer wording ("unresolved, owner
user") because a plain-language rewrite had changed the sentence the
acceptance update matched. The recorded answer (Q-004, Q-004a) was never in
doubt; the line now states it. No decision changed.

## Staging Rollout Record (2026-09-27)

At the user's request ("apply it to staging environment. I will test it
myself"): implementation committed as `68c7e68`; the additive migration
was planned read-only against the staging database (8 statements, digest
`e72a699a…9370b98`: the `agent_client` table, `session.resource`, five
`authorization_code` columns, and a backfill of one existing agent key
with `https://staging.resourcing.shoppable.ph/api/mcp`), then applied with
that digest, and a re-plan reported nothing left to apply. The branch was
merged into `staging` as `b9a79a9` and pushed; Vercel builds staging from
that branch. Not verified from here: the staging Vercel environment's
variables (the local `.env.staging` copy has no
`RESOURCING_AGENT_ES256_KEY_RING`, which only the WorkOS-style login
needs; the standard client login does not use it). `main` is five commits
ahead of `staging` and was not merged in; that sync is a separate step.

## Production Preparation Record (2026-09-28)

The user confirmed the staging test passed (tool call, Connected agents,
Disconnect) and asked for production prerequisites. Checked: the branch
merges into `main` cleanly; production held no Application or Session
rows, so nothing fails closed and no key re-issue applies. Done at the
user's request: the production database was migrated with the reviewed
plan-then-apply flow (first pass 11 statements, digest `eb325585…0715`:
the Spec 00031 tables and columns plus `agent_client` and
`session.resource`; second pass 2 unique indexes, digest `5df34c06…fdc9`;
re-plan clean); an ES256 key ring was generated and appended to the local
`.env.live` as `RESOURCING_AGENT_ES256_KEY_RING` (mode 0600, gitignored;
it still has to be copied into the Vercel production environment); the
branch was pushed and pull request #85 into `main` opened so the Vercel
packaging workflow runs.

## Production Deploy Record (2026-09-28)

The user set `RESOURCING_AGENT_ES256_KEY_RING` in the Vercel production
environment and merged PR #85 into `main` at 03:09 UTC (`7bd6066`), which
is the production deploy. The pull request's Vercel preview build and
review check passed; its CI packaging job failed with the runner out of
memory in the schema-generation step because the workflow builds every
generated admin screen while Vercel's own build command sets
`SKIP_ADMIN_GENERATION=1`. That CI gap is tracked as a follow-up fix to the
workflow, not a product defect. Production verified live at 03:18 UTC: the login index file names the
approval page and client-by-web-address support, the address-specific
document names `https://resourcing.shoppable.ph/api/mcp`, a keyless tool
call answers 401 with the pointer and the three permissions, and the
approval page sends a signed-out visitor to sign-in.

## Open Items For The User

Sync `staging` with `main`; submit the vendor patches; test the standard
client login on production with your own account when convenient.
2. Decide whether the proof's cleanup is complete: the proof plugin entry
   was removed from `package.json`, both clients' proof server entries were
   removed, and the preview was stopped.

## Blockers

None in the workspace. File editing works in this session. Spec 00031 and
its G-012 correction are both committed.

Loose ends outside this spec, written down so nobody rediscovers them:

- The browser test `tests/client-qa/agent-access.spec.ts` expects an empty
  Connected agents list after the last Disconnect and fails when an earlier
  test left an agent behind. The test needs fixing; the product behaves
  correctly.
- Spec 00031 operator steps remain: send the Stackpress fixes upstream, run
  `yarn migrate:agent-auth` on existing databases, re-issue old keys.
