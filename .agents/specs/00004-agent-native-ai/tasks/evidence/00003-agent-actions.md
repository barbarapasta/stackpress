# Task 00003 evidence: the generated admin list of agent actions

**Form produced: the real data response of the generated admin list route, not a
screenshot.** A headless Chromium is present (`~/.cache/ms-playwright`, revision
1243) and a matching `playwright-core` 1.63.0 sits in a sibling project, so the
browser itself is usable. The blog's page could not be rendered on this machine,
for two reasons seen in the server log:

- `stackpress serve` in development mode died while Vite optimised dependencies:
  `Could not resolve "react-shiki"` from `node_modules/frui/esm/view/Code.js`.
  `react-shiki` is not installed in this checkout (it exists only in other
  projects' `node_modules`). Installing it would change the shared install, so I
  did not. (Before that, Vite also failed with `EMFILE` on its file watcher and
  `Port 24678 is already in use`; other sessions' dev servers hold those.)
- In production mode the page routes need `.build/views`, which `yarn blog build`
  would produce with the same Vite step. Without it, a page request crashes the
  server (`Cannot resolve .../.build/views/error-*.js`).

So I served the blog with the production config (JSON routes need no view) and
read `GET /admin/agent-action/search?json`, the route the admin list page itself
loads its rows from. Every row below is that response.

## How it was produced

`templates/blog`, `yarn blog generate`, `yarn blog push` (tables created), then
the seed script in this folder, then `stackpress serve` on port 3412 through a
temporary config that only changed the port (3000 is taken here). The seed script
writes every record through `createStore()`, the store from this task: threads,
turns, actions, usage. The clock is moved by hand so the rows span a morning. That
is why `created` and `updated` of seeded rows are on 2026-10-04 evening while the
profiles were made when the script ran (2026-10-05 00:26 UTC). Signing in:
sign-in pages cannot render here, so the session cookie was minted by the app's own
session plugin (`session.create(...)`, as the sign-in event does) for a profile
with the `ADMIN` role. The token is not printed. Temporary files, the server and the
copy of `.build` were cleaned up afterwards (see the end).

```
$ curl -sSg -H "Cookie: session=$TOKEN" \
    "http://127.0.0.1:3412/admin/agent-action/search?json&sort[created]=asc"
HTTP 200      {"code": 200, "status": "OK", "total": 8, "results": [ ...8 rows... ]}
$ curl -s "http://127.0.0.1:3412/admin/agent-action/search?json"      # no cookie
HTTP 401
```

Two reads two seconds apart returned identical bodies.

## Who did what and when

The 8 rows, one per line, taken from `results` by a short Python snippet over the
saved response (`profile.name`, `tool`, `status`, `operation`, `irreversible`,
`error`; times are the response's `created` and `updated`, UTC, same day):

```
created  updated  who             tool             status    operation      irreversible  error
18:27:16 18:30:16 Maria Santos    approve_request  done      approval-4412  yes
18:35:16 18:42:16 Maria Santos    archive_article  undone    archive-8841   no
18:42:16 18:45:16 Maria Santos    restore_article  done      restore-8841   no            (reverses the archive row)
18:52:16 18:54:16 Maria Santos    delete_comment   declined  -              yes           Not now, leave it for moderation.
19:20:16 19:23:16 Jun Reyes       publish_article  done      publish-3310   no
19:29:16 19:32:16 Jun Reyes       publish_article  failed    -              no            Article has no category.
19:41:16 19:46:16 Jun Reyes       delete_article   expired   -              yes           (a new message arrived in the thread)
19:48:16 19:48:16 Jun Reyes       delete_comment   pending   -              yes
```

The statuses come from the store, not from the script writing them: `done` and
`failed` from `completeAction` after an approval claim, `declined` from
`declineAction`, `undone` from `markUndone`, `expired` from the user message
(`appendTurn`), and the last row is still `pending`.

The first row of the response, with the joined `profile` and `agentThread`
records cut down to a few fields (the other columns are in the response):

```json
{"id":"0muu5kutz000110ed7ec2778","threadId":"j5bsvsbtzavfxxpxsj9aq8ae",
 "turnId":"0muu5kutz0000d7294d57011","profileId":"mffwp8cyhpmjifinjnhovtnt",
 "tool":"approve_request","event":"approval-approve",
 "input":{"requestId":"REQ-4412"},"status":"done",
 "result":{"value":{"ok":true}},"error":null,"operation":"approval-4412",
 "reverses":null,"irreversible":true,
 "claim":"7f926f33-064e-4f4b-a4f0-dbe45bf6d6c5",
 "expires":"2026-10-04T18:42:16.000Z","created":"2026-10-04T18:27:16.000Z",
 "updated":"2026-10-04T18:30:16.631Z",
 "profile":{"id":"mffwp8cyhpmjifinjnhovtnt","name":"Maria Santos","type":"person",
            "roles":["USER"], "...":"other profile columns omitted here"},
 "agentThread":{"id":"j5bsvsbtzavfxxpxsj9aq8ae","title":"Close out Friday approvals",
                "model":"claude-sonnet-5-5","active":true,
                "created":"2026-10-04T18:26:16.000Z"}}
```

Things this response shows that the admin should know:

- `result` is boxed as `{"value": ...}`, because the generated JSON columns only
  hold objects (an array or scalar would be stored as `{}`). The store unboxes it.
- `claim`, the internal token of the approval, is returned by the admin routes.
  The store never returns it. Admin-only, but see the report.

The sibling lists answered too (same cookie): `agent-thread` 2 rows (Close out
Friday approvals, Maria Santos; Publish the October articles, Jun Reyes),
`agent-usage` 2 rows (Maria Santos 2026-10-04: 4200 in, 610 out, 3 turns; Jun
Reyes: 4000 in, 600 out, 4 turns, from two separate additions).

## How to see this yourself

From the repository root, Node 22. `yarn blog push` drops and recreates every
table in `templates/blog/.build`, so copy it first if you want it back.

```
cp -a templates/blog/.build /tmp/blog-build-backup
yarn build                                    # the blog loads the built package
yarn blog generate
yarn blog push                                # creates agent_thread, agent_turn, agent_action, agent_usage
cp .agents/specs/00004-agent-native-ai/tasks/evidence/00003-seed-agent-actions.ts \
   templates/blog/zz-seed-agent-actions.ts
(cd templates/blog && npx tsx zz-seed-agent-actions.ts)   # seeds through the store; prints ids
```

To open the real page (needs `react-shiki` installed, which was missing here):

```
yarn blog dev                                 # http://127.0.0.1:3000
# sign in at /auth/signin/username as  evidence-admin / evidence-pass-123
# (the seed creates that login; the sign-in form was not tried here)
# then open /admin/agent-action/search
```

To read the same data without a browser, on a spare port, mint a session as above
and call the route. Create `templates/blog/config/zz-evidence.ts` as a copy of
`config/production.ts` with `port: 3412` in `server`, then:

```
(cd templates/blog && npx stackpress serve --b config/zz-evidence) &
curl -sSg -H "Cookie: session=<token from session.create for an ADMIN profile>" \
  "http://127.0.0.1:3412/admin/agent-action/search?json&sort[created]=asc"
```

Clean up: stop the server, delete `zz-*` files, `rm -rf templates/blog/.build`
and copy the backup back.

## Cleanup done after capture

Server stopped (port 3412 free), `config/zz-evidence-00003.ts`,
`zz-seed-agent-actions.ts` and `zz-token.ts` deleted, no `.env` created,
`templates/blog/.build` restored from the copy taken before the first push
(`diff -rq` identical). The restored database therefore has no agent tables until
the next `yarn blog push`.
