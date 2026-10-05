# Task 00003A: Make The Reference App's Pages Render

## Task Summary

Side quest of [Task 00003](00003-records-and-turn-store.md). The pages of
`templates/blog` cannot be rendered in this checkout, so no task can produce a
screenshot. Task 3 found two causes: the development server dies in Vite
because `react-shiki`, which a `frui` view imports, is not installed; and the
production server needs a view build that runs the same Vite step. Both predate
this spec.

Added without waiting for review because it is plainly required and has no
meaningful alternative: tasks 00003, 00007, and 00008 are accepted by looking
at rendered pages.

## Implementation Steps

1. Find why `react-shiki` is missing: check what `frui` declares for it and
   what `templates/blog/package.json` lists. Add the dependency where it
   belongs, at the version `frui` expects, and install.
2. Get one rendering path working without disturbing other sessions on this
   machine. Other sessions hold the default Vite ports and many file watchers,
   so prefer the production path: `yarn blog build`, then serve on a spare port.
3. Sign in the way a person would, or record why that is not possible here.
4. Capture the generated admin list of agent actions from task 3 as
   `evidence/00003-agent-actions.png`, using the seed script already in the
   evidence folder.
5. Record the exact commands in Verification Notes so later tasks can reuse
   them.

## Verification Process

- A page of `templates/blog` renders in a headless browser with no server
  error.
- `yarn build` at the repository root still passes.
- No leftover server process, temporary config, or environment file.

## Acceptance Criteria

The screenshot of the admin list of agent actions, showing who did what and
when.

## Implementation Notes

- **Missing package.** `frui` 0.2.9 imports `react-shiki` in `esm/view/Code.js`
  but lists it only under its `devDependencies` (`0.9.1`), so nothing installs
  it for an application. Added `"react-shiki": "0.9.1"` to `dependencies` in
  `templates/blog/package.json` (same version `frui` builds against) and ran
  `yarn install`; `yarn.lock` gained the package and its transitive packages
  (shiki, hast/mdast/micromark utilities), and two existing `debug` entries got
  an extra range.
- **Rendering path.** The production path: `yarn blog build` (about 150 s),
  then `stackpress serve` on port 3411 through a temporary config, signed in
  with a headless Chromium. No watcher, no Vite dev server, no port 24678.
- **Second problem found: a missing `error` view crashes the production
  server.** `templates/blog/plugins/app/plugin.ts` renders
  `@/plugins/app/views/error` on any HTML error, but that view is never
  registered with `server.view`, so `yarn blog build` does not build it and
  the server dies with `Cannot resolve .../.build/views/error-*.js`. The
  trigger was `/logo.png`: every page links it, but the production config's
  access lists omit it, so the browser's request is refused, which renders the
  error page, which crashes the server. Not fixed here (template change); the
  temporary config adds `GET /logo.png` and `GET /icon.png` to the four access
  lists to avoid it. Any other refused or missing HTML route still crashes
  the server.
- **Sign-in.** Done as a person would: the username form at
  `/auth/signin/username` with the login the seed script creates
  (`evidence-admin`). No session token was minted or written anywhere.
- Added `tasks/evidence/screenshot-blog-page.mjs`: signs in through the form,
  opens a page, saves a full-page screenshot, exits non-zero on a non-200.
  It uses the `playwright-core` 1.63.0 of a sibling project and Chromium
  revision 1243 already on the machine; nothing was added to the repository.
- Screenshot: `tasks/evidence/00003-agent-actions.png` (2400 px wide so the
  Expires, Created and Updated columns fit): eight rows, who (Jun Reyes, Maria
  Santos), tool, event, status, operation, reverses and times.

## Verification Notes

Run, in this checkout, Node 22:

- `yarn build` (root): passed.
- `yarn test` in `packages/stackpress-ai`: 266 passing, 0 failing.
- `yarn blog build`, `generate`, `push`, seed, serve, sign in through the
  form, open `/admin/agent-action/search`: HTTP 200, title "Search Agent
  Actions", "Showing 1 - 8 of 8", no page error. Image opened and checked.
- `git diff --check` clean; workspace validator: same two warnings as before.

### How to render and screenshot a blog page

From the repository root. `yarn blog push` drops and recreates every table, so
back up `.build` first. Port 3411 (3000 is taken); check it is free with
`ss -ltn | grep 3411`.

```
source ~/.nvm/nvm.sh && nvm use 22
cp -a templates/blog/.build /tmp/blog-build-backup
yarn build
yarn blog generate
yarn blog push
yarn blog build                                    # about 150 s; makes .build/views
E=.agents/specs/00004-agent-native-ai/tasks/evidence
cp $E/00003-seed-agent-actions.ts templates/blog/zz-seed-agent-actions.ts
(cd templates/blog && npx tsx zz-seed-agent-actions.ts); rm templates/blog/zz-seed-agent-actions.ts
```

Temporary config: copy `templates/blog/config/production.ts` to
`templates/blog/config/zz-render.ts`, then in the copy add `port: 3411` after
`mode: 'production'` in `server`, and add
`{ method: 'GET', route: '/logo.png' }, { method: 'GET', route: '/icon.png' },`
after each `'/favicon.png'` line in the four `access` lists (see the crash
above). Then:

```
(cd templates/blog && setsid npx stackpress serve --b config/zz-render > /tmp/blog-serve.log 2>&1 &)
sleep 12; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3411/auth/signin/username   # 200
node $E/screenshot-blog-page.mjs /tmp/out.png /admin/agent-action/search     # any path
```

Stop the server by the pid that owns the port, not by `pkill -f` (that matched
the calling shell once): `kill $(ss -ltnp | grep ':3411' | grep -o 'pid=[0-9]*' | cut -d= -f2)`.

Clean up: stop the server, `rm templates/blog/config/zz-render.ts`,
`rm -rf templates/blog/.build && cp -a /tmp/blog-build-backup templates/blog/.build`,
`rm -rf /tmp/blog-build-backup`. `templates/blog/public/assets` and
`public/client` are ignored build output left in place. The restored database
has no seeded rows or agent tables until the next `yarn blog push`. No `.env` is
needed or created.

### Not done

Development mode (`yarn blog dev`) was not tried: other sessions hold Vite's
port and file watchers.

## Acceptance Notes

Accepted by the user on 2026-10-05, after reviewing the results ("Looks good to me").
