# Task 00010: Pilot Handoff

## Task Summary

Hand the finished package to the Operations Approvals pilot: a build the app
can install and a checklist of what the pilot must prove. The pilot itself is
specified in the Approvals repository under its own workflow. Decisions:
DEC-006, DEC-009, DEC-010, GAP-011.

## Implementation Steps

1. Pack `stackpress-ai` and any other changed package, and install the packed
   build into a clean temporary consumer to confirm it resolves.
2. Write `tasks/pilot-checklist.md` in this spec, covering:
   - installing the packed build on a new branch from main and running both
     suites on the app's Node version;
   - the app boundary: the anti-forgery token, the request method, and the
     path the boundary reads, checked with a forwarded call against the real
     workflow events and a disposable database;
   - hosting: streaming and the single-response fallback on the real platform,
     with a server built per request;
   - the file upload route that produces the reference a tool receives;
   - every action in R-012 offered as a tool, each marked reversible with its
     inverse or irreversible;
   - the personal security steps that must not be offered;
   - the OfficePress panel built to R-011 and DEC-010;
   - one acceptance check per journey in J-001 to J-010.
3. State in the checklist that app changes need a spec in the Approvals
   repository, and link this spec from it.
4. Do not change the Approvals repository in this task.

## Verification Process

- The packed build installs into the clean consumer and its promised imports
  resolve.
- Every checklist item traces to a decision, journey, or research record.
- Agent Workspace validation passes.

## Acceptance Criteria

The pilot checklist as a readable document.

## Implementation Notes

Done 2026-10-05. Steps 1 to 4 are done. No source changed in this repository and
nothing in the Approvals repository was touched.

**Packed build (step 1).** Only `stackpress-ai` needs packing: no file under any
other `packages/*` directory is modified or untracked (`git status --short
packages`), so no other package's published output changed. Command, from
`packages/stackpress-ai` on Node 22, after confirming no source file is newer
than the built `cjs` and `esm`:

```
npm pack --ignore-scripts --cache <tmp>/npm-cache --pack-destination <tmp>
```

Result: `stackpress-ai-0.10.8.tgz`, 109,425 bytes, 255 files, sha256
`53b6b4db884b430eb78d02e1be6ed8677e08360cad2fa484f2fc0d39b4167b20`, sha1
`0f0028191fca68e0fc933670f049ddfd3a4ccfc0`. A second pack gave the same sha256.
The tarball holds `LICENSE`, `README.md`, `package.json`, `schema.idea`,
`styles.css`, `cjs/` and `esm/`; no tests, maps, coverage or `.env`. The
temporary directory, and the tarball in it, were deleted; no tarball is in either
repository.

**Checklist (steps 2 and 3).** The checklist is five linked files, each under
200 lines, entered at `tasks/pilot-checklist.md`: overview and setup (section 0),
`pilot-checklist-boundary.md` (1), `pilot-checklist-hosting.md` (2),
`pilot-checklist-tools.md` (3, with the action inventory),
`pilot-checklist-acceptance.md` (4 to 7: panel, one check per journey,
inherited limits, what the Approvals spec links back to). Two files of about 340
lines each were written first and gave two new validator warnings (200-line
target), so they were split without cutting content. Every item has Show, Pass
when and From; decisions are marked **Decision** with options.

**Where the Approvals source differs from the brief for this task** (read at
commit 37e4486, the checked-out branch; run nowhere):

- Not all work goes through events. Email settings save and test, guest links,
  the file upload route, participant lookup and provisioning, add user, own
  profile, and theme are route handlers with no event. Several read the request
  path (`pathname.endsWith('/test')`, a `/requests/:id/guest-links` regex) or the
  URL query (participant lookup), which the agent's forwarded request lacks.
- The three command events are wrapped with `mutation: true`, so the
  anti-forgery token is required even if a tool says method GET; reads are not.
  `user-access-command` and several route handlers are plain actions that check
  the token themselves, not `protectedAction`.
- The boundary reads identifiers from the path only as a fallback to the input.
- Operation identifiers: `approval-workflow-command` results carry `operationId`
  at the top level, but the package's default read path is `operation`; the tool
  must set it. `user-access-command` results carry none.
- Local `main` is not where DEC-006 implies: `main` is 44 commits behind
  `origin/main`, and the checked-out branch is contained in `origin/main`, not
  in `main`.
- The app's `yarn push` is `setupStore`, which creates only an empty schema and
  refuses an existing database ("Store setup conflict"). Task 8's note that `push`
  adds just the four tables does not apply there.
- The Vercel path imports each plugin by hand in `config/vercel/handle.ts` and
  `build.ts`; the `plugins` list in `package.json` does not reach it. Its
  function bundle is built by `npm install --omit=dev` over the app's
  `dependencies` in another directory.
- `vercel.entry.ts` releases the request's database client as soon as
  `server.handle` resolves. The Node adapter pipes a stream body without waiting.
  A streamed turn may therefore find "Database client already released".
- R-012 lists "account notification settings"; the route is retired and answers
  403. R-012 omits `ADD_USER`, `RESEND_SETUP`, the admin email-change resend and
  cancel, own profile edit and theme, and participant provisioning.
- The upload route stores the file and attaches it in one step, so the planned
  "upload gives a reference, the tool receives it" flow does not map; and
  `ATTACH_FILE` through the command checks only the shape of the file address,
  not that an object exists (read, not run).
- The app has three suites under `yarn test` (schema, plugins, acceptance), not
  two; the package's suite is the other.

**Gap found for this application (not fixed; in the checklist as items 3.2 and
3.3).** An undo runs the inverse with the original's stored input only
(`scripts/approval.ts`, `inverse` gets `asInput(action.input)`). Every Approvals
command needs a fresh `operationId` and a current `expectedRevision`, and
creating or issuing needs an id from the result, so no Approvals command can have
a working `inverse` as the package stands. Separately, the agent offers every
`agent: true` tool to every signed-in person; only the event refuses.

**Left alone.** Side quests 00001B and 00003B are listed in the checklist as open
choices and were not started. `tasks/status.md` and the other task files were not
edited.

## Verification Notes

Run 2026-10-05 with Node 22.23.2 and Yarn 1.22.22.

- Clean consumer (a new directory under `/tmp`, deleted afterwards): `npm
  install` of the tarball plus `react` and `react-dom` installed 166 packages and
  recorded `file:` and an integrity hash. All 17 promised paths (`.`, `adapters`,
  `client`, `events`, `events/index`, `events/http`, `events/sse`, `events/stdio`,
  `scripts`, `scripts/index`, `scripts/http`, `scripts/sse`, `scripts/stdio`,
  `helpers`, `plugin`, `transform`, `types`) imported as ES modules once `ts-morph`
  (an optional peer) was added; without it only `transform` failed. Root exports
  are `AGENT_EVENTS`, `CONTEXT_EVENT`, `caller`, `contributeTool`,
  `createMcpServer`, `createRuntime`, `createStore`, `watch`, and the default
  plugin; `AgentPanel` and `createPanel` come from `client`. `styles.css`,
  `schema.idea`, `LICENSE`, `README.md` are on disk. `scripts/agent`,
  `package.json` and `schema.idea` are refused with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. In plain Node CommonJS, 9 of 17 paths load and
  8 throw `Cannot use 'import.meta' outside a module` (same as task 9);
  `require('stackpress-ai')` works under `node --import tsx`. Types were not
  re-checked here; task 9 did that.
- Published copy: `npm install stackpress-ai@0.10.8` from the registry has no
  `schema.idea`, no `styles.css`, no `AGENT_EVENTS`, and `require` throws the
  `import.meta` error. So the same-version trap is real.
- Same-version trap on yarn v1, throwaway project, deleted: with a warm cache,
  overwriting a `file:` tarball with different bytes (same name and version) and
  reinstalling kept the old bytes. After `yarn cache clean stackpress-ai` the
  reinstall with `--frozen-lockfile` failed with "Integrity check failed".
- `yarn test` in `packages/stackpress-ai`: 700 passing, 0 failing; coverage
  96.5 statements, 91.78 branches, 96.66 functions, 97.17 lines.
- `python3 .agents/scripts/validate-agent-workspace.py`: "OK, warnings only", the
  same two older line-count warnings (`references/00010`, `references/00014`); none
  for the five checklist files (105, 141, 123, 161 and 176 lines).
- `git diff --check`: clean. The untracked checklist files have no trailing
  whitespace (checked separately).
- Approvals repository: read only. `git status --short` there was the same before
  and after (its own untracked `artifacts/`, `.agents/skills/triage/` and similar
  files). No `.env` file of either repository was read.
- Not verified: nothing was run against Approvals, so every statement about its
  behavior (items 1.2, 2.4 and 3.2 above all) is from reading the source. The
  package suite on Node 24 was not run. The `file:` dependency problem in the
  Vercel bundle step (checklist 0.3) is inferred from `scripts/vercel.ts`.
  The hazard in 2.4(c) is inferred from `vercel.entry.ts`, `connect.ts` and
  Ingest's Node adapter.

## Acceptance Notes

Accepted by the user on 2026-10-05, after reviewing the results ("Looks good to me").
