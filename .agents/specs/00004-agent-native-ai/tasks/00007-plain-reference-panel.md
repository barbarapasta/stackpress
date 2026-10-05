# Task 00007: Plain Reference Panel

## Task Summary

Ship a plain chat panel that works against the task 6 routes, so any Stackpress
app has a working agent interface. It carries no OfficePress styling.
Decisions: DEC-005, DEC-010, DEC-014. Journeys: J-001 to J-003, J-006, J-007,
J-010.

## Implementation Steps

1. Read how `stackpress-view` and `stackpress-admin` build, export, and test
   their browser components before choosing files. Keep server-only code out of
   the browser entry.
2. `src/client/`: a panel component and its hooks, exported from a browser-safe
   `client` subpath. Phrases go through the existing translation helpers.
3. Controls in the first trial:
   - conversation with streamed replies and follow-up state;
   - context chips taken from the page, each removable;
   - action cards showing the action name, result, and a status of running,
     done, failed, waiting, declined, or expired;
   - approve and decline on a waiting card;
   - Undo on a done card whose tool has an inverse;
   - history and new chat;
   - a model picker when more than one model is offered;
   - file attach that takes a file reference from an app-supplied upload
     handler. The panel never uploads by itself.
4. After an action finishes, refresh the page data.
5. Show a clear state when the agent is unavailable, the person is signed out,
   or the daily limit is reached.
6. Mount the panel in `templates/blog` so it can be reviewed.
7. Tests: rendering and interaction for each control; server render and
   hydration in the reference app; keyboard operation; a narrow screen.

## Verification Process

- The package and reference app suites pass, with package coverage above 90%.
- Route, server render, hydration, interaction, layout, and accessibility
  evidence is recorded, per the page and view evidence class.
- `yarn build` at the repository root.

## Acceptance Criteria

Screenshots or a recording of the panel in `templates/blog` doing a reversible
action, an approved irreversible action, a declined one, and an undo, on a wide
and a narrow screen.

## Implementation Notes

Done 2026-10-05. Every step is done.

**How the browser components are built here (step 1).** `stackpress-view` and `stackpress-admin` keep browser code
under `src/client/` with a README that says nothing from Node or from a server file may be imported, export it
from a `./client` subpath (`require` and `import` entries, a `typesVersions` entry, `jsx: react-jsx` in both
`tsconfig` files), ship a `styles.css` listed in `files` and `exports`, take words from `r22n`'s `useLanguage`,
and read colours from the app's theme variables. `stackpress-ai` now does the same. Neither package has component
tests, so there was no house pattern for them (see Verification).

**Files.** All new, in `packages/stackpress-ai/src/client/`: `README.md` (the same warning as the others); `types.ts`;
the plain modules `api.ts` (route client), `state.ts` (reducer), `controller.ts` (state, requests, what each answer
changes), `phrases.ts` (code to words); the hook glue `hooks.ts`; the components `AgentPanel.tsx` (the only
container, and the default export), `PanelView.tsx`, `ActionCard.tsx`, `Thread.tsx`, `ContextBar.tsx`,
`Composer.tsx`, `History.tsx`, `Gate.tsx`; and `index.ts`. Also `packages/stackpress-ai/styles.css`. Changed:
`package.json` (exports `./client`, `./client/*` and `./styles.css`, `typesVersions`, `files`, `r22n` as a
dependency, `react` an optional peer, `react`, `react-dom` and their types as dev dependencies, all at versions
already in `yarn.lock`), `tsconfig.cjs.json` and `tsconfig.esm.json` (`jsx`), `README.md` (a "Chat Panel" section).
Blog: `config/build.ts`, `develop.ts` and `client.ts` (`stackpress-ai/styles.css` in `cssFiles`), and the two
views `plugins/app/views/home.tsx` and `article.tsx`. The aggregate `stackpress` package is untouched; `stackpress-ai`
is not part of it.

**Structure.** The logic is plain and has no React: `createClient` (every route, the anti-forgery token, the
event stream and the single-answer form, one retry on a refused token), `applyEvent` and `fromThread` (progress events
and a stored thread into conversation items), and `createPanel` (a store with `getState`, `subscribe` and one method
per thing the person does). The components only draw its state. Everything that draws is a function from props to
elements with no hook, handed the translate function as a prop; `AgentPanel` is the one component with hooks
(`usePanel` on `useSyncExternalStore`, focus, scroll following). The server and the first render in the browser
agree: a closed panel from `getServerState`. What a reload kept (open, thread, draft, removed chips) is read
after mount.

**Exports.** `stackpress-ai/client`: `AgentPanel` (also the default), `PanelView`, `ActionCard`, `createPanel`,
`createClient`, `usePanel`, `applyEvent`, `fromThread`, `syncActions`, `addUser`, `emptyConversation`, `chips`,
`wire`, `parseEvents`, `reasonOf`, `toolLabel` and the types. `stackpress-ai/styles.css`. The built entry reaches
only `react`, `react/jsx-runtime` and `r22n` (checked from the compiled files and by a test of the sources). The
blog imports it and builds with it.

**Mounting in the blog, and what an app supplies.** `<AgentPanel signedIn={Boolean(session?.id)} />` inside
`LayoutPanel` on the home page; on the article page also `context` (the article and each comment as
`{ type, id, label }`) and `starters`. An app gives `context` (strings or objects with a `label`), `url` (defaults to
the browser's), `signedIn`, `starters`, `onRefresh`, and optionally `upload`, `base`, `stream`, `signInUrl`,
`defaultOpen`. `upload` is `(file) => Promise<string | { ref, name? }>`: the panel hands it a picked file and keeps
the reference; the panel sends no file anywhere. With no `upload` there is no attach control. The blog supplies none,
since it has no upload route, so attach is tested but was not driven in the browser.

**Decisions where the task was open.**

- *Refreshing the page.* Pages here are server rendered and hydrated with no client data layer, so there is nothing
  to re-fetch into. The default `onRefresh` reloads the page, once, when a run ends with an action finished (not on
  each event, and not for a decline or a failure), and the panel keeps its place across it in `sessionStorage`:
  open, thread, the draft, and removed chips for that page. An app with its own data layer passes `onRefresh`.
- *Order of a stored thread.* Turns and actions are stored apart and a clock cannot be trusted at one second
  resolution, so each action is placed after the turn that asked for it (`turnId`), and turns keep the order the
  server gave. An action with no turn goes last. The live run and a reloaded chat show the same order.
- *Undo asks for one answer, not a stream.* A stream does not carry whether the undo happened or was refused (that
  is in the single answer's `status` and `error`), so undo, like New chat, is a plain request. A refused undo shows
  the app's own reason on the card.
- *Words.* Every visible phrase and `aria-label` goes through `_`. The server's own words are never shown: a refusal
  is turned into the panel's sentence from its reason (`phrases.ts`), the one exception being the reason an app gave
  on a failed action or a refused undo, which is what J-003.2 and J-004 ask the card to show. A 200 that is not an
  answer of the routes (a proxy page) counts as a failure.
- *States.* Signed out (from the page's `signedIn`, no request; or a 401), unavailable (503, a missing route, a
  network failure, or a stream that ends `unavailable`), and daily limit (`remaining` of 0 at start, a 429, or a
  stream that ends `limit`). History is still readable at the limit; New chat is not.
- *Focus.* Opening focuses the message field; a waiting card, and a card the person just acted on, take focus
  themselves (the card, not Approve), so no key press can approve what was not read; closing returns focus to the
  button. Escape closes, except inside an open model list.
- *Following a reply.* New text follows the end only while the person is at the end; scrolled up, the view stays put
  and a "Jump to latest" button appears. Sending or opening a chat goes to the end.
- *Colours.* From the app's theme variables with plain fallbacks. The blog's light theme sets `--muted` too pale to
  read, so quieter text is the text colour softened (`color-mix`) rather than `--muted`; the white-on-accent pair is
  darkened a little for the same reason (found by measuring, below).
- *`frui` is not used.* Its components would add little to a chat panel and cost accessibility I would have to check;
  native `button`, `select`, `textarea` and `label` are used, with the theme variables `frui` shares. `r22n` is used.

**Deviations.** `package.json` gained `r22n` and a `react` optional peer (needed by a browser entry), and the README
a section. Outside `packages/stackpress-ai` only the blog files named above changed.

**Found in earlier tasks, not changed.** (1) `POST /agent/threads` leaves an empty "New chat" row in History each
time (the task 6 notes already say so); it shows in `00007-narrow-history.png`. (2) The turn order the thread route
returns is not fixed when several servers write in the same millisecond under a frozen clock (a per-request host in
the tests); in real time it is. The panel's `turnId` placement does not depend on it, but the order of the turns
themselves does. (3) A refused action's text comes back with the status appended ("The note changed since. (409
Conflict)") and the card shows it as stored. (4) The streamed form of undo was not tried (see above).

## Verification Notes

**Tests.** `yarn test` in `packages/stackpress-ai`. Before: 487 passing, 97.83 / 92.78 / 97.18 / 98.27
(statements / branches / functions / lines). After: 688 passing, 0 failing, 96.50 / 91.78 / 96.66 / 97.17. All four
stay above 90. 201 tests added in six files: `client-state` (reducer and stored threads), `client-api` (route client:
stream pieces, fallback, refusals, retry, abort), `client-panel` (the controller through a scripted server),
`client-view` (what is drawn, driven through the real controller; server render), `client-routes` (the panel against
the real plugin, the real anti-forgery plugin and a real signed session over HTTP, on a long-lived and a per-request
host: reversible, waiting, approve, decline, undo, refused undo, failed action, history, new chat, reload and
approve, limit, no key, signed out, tampered context, another person's chat) and `client-safe` (the entry reaches
only `react` and `r22n`; the manifest). Helpers `dom.ts` and `panel.ts`.

**Markup tests, and what was added.** No DOM library is installed and none was added; no dependency was added for
tests (`react` and `react-dom` were already in `node_modules`, and are now named as dev dependencies). Everything that
draws calls no hook, so `dom.ts` walks the elements those functions return (calling each component) down to HTML
elements, which can be searched by role and name and whose `onClick`, `onChange`, `onKeyDown` and `onSubmit` can be
called as a click or a key would call them. Tests drive the real controller through them. `renderToString`
covers server render. What this cannot do is fire events in a browser, move focus, or scroll: that is
`AgentPanel.tsx` and `hooks.ts`, which the real-browser run covers.

**Coverage and the components.** The components are inside the numbers: nyc instruments the `.tsx` files. In
`src/client` it reads 93.79 / 89.85 / 95.50 / 94.78. Two files are low and are not excluded: `AgentPanel.tsx` 47.82%
statements and `hooks.ts` 58.20% (effects, focus and scroll following do not run without a DOM; only their
server-render path is reached). Everything else in the folder is above 96% statements. The browser run is not in the
numbers.

**Mutation check, reverted (`diff -r` of `src/client` against a copy was empty).** Breaking each of these made the
client tests fail: the double click guard on Approve; the anti-forgery token left out of a write; Undo shown without
the server saying so; a removed chip still sent; stale answers applied after a new chat; cards placed by clock; a
limit refusal not reaching the limit state; no retry after a refused token; the composer shown at the limit; the
attach control shown with no handler; no refresh after an action; the declined status.

**Builds.** `yarn build` in the package, and at the repository root: exit 0. `yarn blog build` (about 165 s, five
times as the panel's styles were tuned): exit 0, and the built CSS holds the panel's rules. `templates/blog` has no
test files (`yarn test` there runs 0 tests), so there is no reference app suite to pass; the reference app evidence is
the browser run.

**Real browser.** `tasks/evidence/00007-panel.md` lists the images and the three runs
(`panel-browser-run.mjs`; logs `00007-browser-run-*.txt`; 88 checks in the main log, none failed, none in the other
two). The blog was served in production mode from a temporary config on ports 3471 to 3473 (access for `/logo.png`
and `/icon.png` added to the copy, as the 3A recipe says). `.build` was copied first and restored after (identical by
`diff -r`); the temporary configs were removed; the servers were stopped by pid. Seen working there: server
render; hydration with no console or page errors; opening by keyboard with focus in the field; a streamed reply and
the single-answer form; a reversible action finishing with Undo; a waiting card with its inputs, approved with a
double click (one request), declined by keyboard, undone; the page refreshing and the panel returning to its chat;
History, New chat, a removed chip not sent, the model picker's choice sent; signed out, the daily limit and
unavailable on a wide and a narrow screen; Escape and focus return; the accessibility tree; contrast measured from
computed colours (worst 5.56:1); a slow reply that followed the end, stayed put when scrolled up, and offered a way
back. The narrow screen: a full-screen sheet of exactly 390 x 844 with no sideways scroll and every control at least
32 px tall.

**Found while running it and fixed.** The first contrast check measured colours wrongly (a canvas now reads
them), and then showed `--muted` unreadable and white on the accent too faint; the chips filled a third of a narrow
screen (now one scrolling row); a removed chip came back after the page refreshed itself (removals are now kept for
that page, keyed by what the chip says); and the Undone and Declined screenshots first showed the bottom of the chat
(the script now scrolls the card into view). A 200 answer that was not JSON used to count as success (a test found it).

**Not verified.** No real provider (offline model only, and a stub in tests); PGlite only; file attach was not
driven in a browser (no upload handler in the blog); a dark theme; Firefox and Safari; a real screen reader (the
accessibility tree is what the browser reports); a host that buffers streamed output; `yarn install --frozen-lockfile`
(the added versions are all in `yarn.lock` already, which I read but did not install against).
`git diff --check`: clean. `python3 .agents/scripts/validate-agent-workspace.py`: only the two older warnings.
**Slip.** I ran `pkill -f never`, which matches any process on this machine whose command line
contains "never". It ended only my own shell command that I could find, but I cannot rule out another session's.

## Acceptance Notes
Accepted by the user on 2026-10-05, after reviewing the results ("Looks good to me").
