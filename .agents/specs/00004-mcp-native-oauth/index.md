# Spec 00004 — Let MCP Clients Sign In To Stackpress

Status: **Frozen, 2026-09-29.** The user instructed: “Freeze then create task files.”
The accepted scope, final choices and proof limits are recorded in [freeze record](freeze.md).
Implementation plan: accepted; task files are open and implementation has not started.
Executed prototypes remain under root proofs/. Creating these tasks does not publish
packages, change application databases or approve completed implementation work.

A person should give an MCP client the app's address and sign in through the
browser. After approval, the client gets a key, renews it by itself, and stops
working when the person disconnects it. The same approved key will also work
on allowed ordinary API routes. The work covers `stackpress-session`,
`stackpress-ai`, and `stackpress-api`.

## Where To Start

- [Brief](brief.md): what the user wants, what is included, and which package
  should do each job. Also explains the few technical names used in this plan.
- [Design](design.md): how the code, settings, database, pages, and key checks
  should work together.
- [Configuration](configuration.md): exact settings/defaults, startup validation,
  route membership and public package exports; read when wiring an app.
- [Events](events.md): verified identity, fixed operations, app-policy contracts,
  approval/factor checks and safe browser data; read when implementing session.
- [Storage](storage.md): schema, atomic transitions, Inquire prerequisite and
  explicit legacy-key migration; read before changing stores or existing callers.
- [Recovery](recovery.md): client errors, permission reapproval, session binding,
  anonymous tool catalogs and browser/proxy rules; read for HTTP/SSE integration.
- [Journeys](journeys.md): complete actor/state matrix and scenario walkthrough;
  read when checking human-facing coverage and production acceptance.
- [Decisions](decisions.md): accepted storage, API support, access rules, proof findings, detailed-contract review items, and how the source application's decisions, G-001 through G-015, apply here.
- [Questions](questions.md): exact grill-session questions and answers; read
  when continuing the discussion.
- [Research](research.md): what we read, what the code does today, where the
  information came from, and what still needs checking.
- [Verification](verification.md): the six accepted build stages, including the
  blocking Inquire step, and every required production check.
- [Freeze record](freeze.md): user authorization, accepted proof limits and the
  checks completed before locking the plan.
- [Task plan](tasks/sprint.md): twelve implementation tasks, dependencies and
  complete test/journey coverage; read before starting work.
- [Task status](tasks/status.md): current progress, blockers and review requirements.
- [Proofs](proofs.md): required experiments, their current outcomes, and release checks.
- [Proof results](proof-results.md): read for executed evidence, reproduced defects,
  passing candidate designs, real-client results, and limits.
- [Status](status.md): what is done, what is open, and what to do next.

The source application's plan helps us understand the feature. Its reported
success does not prove that the Stackpress library will work the same way.
The plan is now the agreed build contract. Track work under `tasks/`; request
explicit reopening before changing a Frozen requirement. Task progress and
implementation notes do not reopen the agreed behavior.
