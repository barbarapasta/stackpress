# Pilot Checklist: Operations Approvals

This is what the Operations Approvals pilot has to prove, written for someone
who was not here while the agent was built. It is split into five files so each
stays short; item numbers run through all of them.

Parts, in the order to work them: [overview and setup](pilot-checklist.md)
(section 0), [the app's boundary](pilot-checklist-boundary.md) (1),
[hosting and the database](pilot-checklist-hosting.md) (2),
[tools and the action inventory](pilot-checklist-tools.md) (3), and
[panel, journeys, limits](pilot-checklist-acceptance.md) (4 to 7).

Work down the list in order: later items depend on earlier ones.

## Where things stand (written 2026-10-05)

- **What exists.** `stackpress-ai`, in the Stackpress monorepo, now holds a
  built-in chat agent. A signed-in person chats; the agent calls the app's own
  events as that person, asks the person to approve anything that cannot be
  undone, keeps a log of every action, and enforces a daily token limit per
  person. It ships chat routes under `/agent`, four stored record tables, three
  model providers (Anthropic, OpenAI, OpenRouter) and a plain reference panel.
- **State.** Finished and tested, but unreleased: the work sits uncommitted on
  branch `stupid-bat` of the Stackpress repository and the version is still
  0.10.8. The registry's `stackpress-ai@0.10.8` does not contain it.
- **Proven.** On the sample blog app, with an in-memory database and Node 22:
  700 package tests pass, a real-browser run of the plain panel, and a live
  OpenRouter run on two models.
- **Not proven.** Anything against Approvals. A write through Approvals'
  boundary (item 1.2 to 1.4; it is the biggest open question). A real database
  server. Anthropic and OpenAI against their own services. Vercel. Node 24 for
  the package's own suite.
- **Ready to start?** Sections 0 and 1 need no model key and no panel. Nothing
  that writes (section 3 onward) should be built before item 1.4 passes.

Every item says what to show, how you will know it passed, and where it comes
from. Items marked **Decision** are for the app's owners, not tests. Do not
assume an item will pass; record failures as findings, with the output.

## 0. Before touching code

- [ ] **0.1 Write the Approvals spec first.** Application changes need a spec
  under the Approvals repository's own `.agents/specs/`, following its
  `.agents/workflows/spec-driven-development.md` and starting from
  `.agents/specs/manifest.md` (SpecKit is deprecated there). The existing specs
  run 00001 to 00008, with two folders numbered 00007, so check the manifest for
  the next number. The agent changes authorization (item 1.3), persistence
  (four tables, item 2.1) and interface (a panel the approved wireframe does
  not contain), and the app's planning policy says such conflicts go in the
  spec's decision ledger before any code.
  Pass when: a spec folder exists with a brief, a decision ledger holding every
  **Decision** item below, and a link back to this spec (list in section 7 of the [last file](pilot-checklist-acceptance.md)).
  From: brief, GAP-011.
- [ ] **0.2 Branch from the right base.** The local `main` in the Approvals
  checkout was 44 commits behind `origin/main` on 2026-10-05. The branch that
  was checked out (`feat/guest-reviewer-comments`) is contained in
  `origin/main`, not in local `main`. Fetch, then branch from `origin/main`.
  Pass when: `git merge-base --is-ancestor feat/guest-reviewer-comments origin/main`
  succeeds and the new branch starts at `origin/main`.
  Note: the action inventory in [the tools file](pilot-checklist-tools.md) was read at commit 37e4486 of that
  branch. Between it and `origin/main`, `plugins/users/boundary.ts`, the event
  files and `config/vercel/*` are unchanged, but `package.json` now has
  `"vercel-build": "node --import tsx scripts/vercel-build.ts"` and
  `config/build.ts` and `config/static-gateway.ts` changed. Re-read those two
  before item 2.2. From: DEC-006.
- [ ] **0.3 Install the packed build without the same-version trap.**
  Build and pack in the Stackpress repo on Node 22:
  `yarn build` in `packages/stackpress-ai` (the `cjs` and `esm` folders are
  git-ignored and must be current), then
  `npm pack --ignore-scripts --pack-destination <a folder outside both repos>`.
  The corrected tree verified in task 00010B on 2026-10-05 packs to `stackpress-ai-0.10.8.tgz`, 119,016 bytes,
  263 files, sha256
  `0e0cbabdc9886437f198d6f86caf611e5b6f35a9a246c38b905f4c9d6660d09c`, sha1
  `3086885360da481e84245ad5821516cc34879e75` (packing twice gave identical
  bytes). If the source changed since, the numbers will differ; record yours.
  The trap: the registry already has a different `stackpress-ai@0.10.8`. In a
  throwaway yarn v1 project, replacing a tarball with different bytes under the
  same name and version was tried; with a warm cache the **old** bytes installed silently,
  and after `yarn cache clean stackpress-ai` the lockfile's recorded checksum
  made `--frozen-lockfile` fail with "Integrity check failed". So after every
  rebuild: `yarn cache clean stackpress-ai`, delete the `stackpress-ai` entry
  from `yarn.lock`, run `yarn add file:<path>/stackpress-ai-0.10.8.tgz` again.
  Pass when: the `resolved` line in `yarn.lock` ends in the tarball's sha1;
  `node_modules/stackpress-ai/schema.idea` and `styles.css` exist (the
  registry copy has neither); `yarn why stackpress-session`,
  `stackpress-api` and `stackpress-schema` each show one copy.
  **Decision (hosted runs only):** a `file:` path in `yarn.lock` cannot resolve
  on Vercel, and `scripts/vercel.ts` (`buildHandlePackage`) copies the app's
  `dependencies` into the function's own `package.json` and runs
  `npm install --omit=dev` in another directory, where a relative `file:` path
  breaks (read from source, not run). Options: commit the tarball inside the
  pilot branch and rewrite the path for that step; or publish a pilot version
  under a different number or tag, which needs a version bump the Stackpress
  spec deliberately did not make. Local runs need neither. From: GAP-011.
- [ ] **0.4 Baseline both suites on Node 24.** The app declares Node 24; the
  package's own suite has only been run on Node 22 (the earlier proofs ran
  Node 24 with published packages). Before any change, on the new branch, run
  `yarn install`, `yarn test` (it runs the schema, plugins and acceptance
  suites) and `yarn typecheck` in Approvals, and `yarn test` in
  `packages/stackpress-ai` on Node 24.
  Pass when: you have a recorded green baseline, or a recorded list of what
  already fails, so later failures are attributable. Unknown: whether either
  suite is green on Node 24 today; neither has been run there for this work.
  From: GAP-011, task 9 notes.
