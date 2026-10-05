# OfficePress Research

Findings from OfficePress repositories and design sources, most of them
private. Kept apart from [Research](research.md) so this detail can be handled
on its own. Recorded under DEC-011.

## R-003: OfficePress Organization Survey

Status: Complete first pass on 2026-10-04.

Sources: repository listings, root manifests, and the public `officepress`
knowledge base, read through the user's GitHub access. Seven active apps were
checked: Approvals, Inventory, Support, Forms, Orders, Inbox, and Resourcing.
Organization code search returned nothing, so cross-repository claims rest on
those seven manifests only.

Findings:

- All seven pin Stackpress 0.10.8 and are built from hand-written plugins.
- Only Resourcing loads `stackpress-ai`.
- Six of seven depend on Inngest for background work.
- The shared app design already specifies a header agent button and a panel with
  context, conversation, action cards with undo, and a composer.
- The product catalogue lists a separate Agent product and governed MCP access
  in Tables.

Affected: DEC-005, DEC-007, DEC-008, GAP-008, GAP-012.

## R-004: Resourcing Agent Access Workarounds

Status: Complete first pass on 2026-10-04.

Sources: Resourcing `plugins/agent-auth`, including its `overrides/` and `mcp/`
folders.

Findings:

- A local override and an unsubmitted upstream patch harden key handling:
  refuse unknown, inactive, expired, or secretless keys; require the secret on
  every method; require every scope; close a connection when its key dies.
- The patch states it was written against compiled output and not run against a
  live server; the local override is the tested path.
- Scope failures need a real HTTP 403 before the transport, because a tool
  event's status never reaches the client.
- An adapter rebuilds an actor with roles from `profileId` and `sessionId` for
  every tool event.
- The app sets `mcp` config inside its plugin body to satisfy the synchronous
  config check.

Remaining: read the SSE path and the audience check before fixing GAP-004 scope.

Affected: GAP-002, GAP-003, GAP-004.

## R-005: Operations Approvals As Pilot

Status: Complete first pass on 2026-10-04.

Sources: the local checkout named in DEC-006.

Findings:

- Work runs through command and read events; generated model events for six
  protected models are rejected by a guard.
- Command events verify the signed-in person from the session token on the
  request and re-read current access before acting.
- Commands carry a caller-supplied operation identifier and an expected
  revision, and results are recorded as receipts.
- The Vercel entry builds a server per request.
- The checkout installs published packages, has no `stackpress-ai`, and declares
  Node 24. Its checked-out feature branch is merged into the main branch per
  local refs; untracked artifact files remain in the working tree.

Affected: GAP-001, GAP-007, GAP-008, GAP-010, GAP-011.

## R-011: OfficePress Agent Design

Status: Complete on 2026-10-04.

Source: `officepress.pen` in the OfficePress repository's
`.agents/resources/officepress-design/`, read as JSON on 2026-10-04.

Findings:

- Every app header ends with four 36 px outlined circles in the order
  notifications, agent, theme, user.
- The agent opens a 400 px panel docked right under the header that pushes
  content; mobile uses a full-height sheet.
- Panel header: agent mark, `<App> Agent` name, a status line, and New chat,
  History, Expand, and Close controls.
- Context bar: removable context chips naming what the agent is looking at.
- Thread: user messages, agent messages, follow-up chips, and action cards that
  show an action name, a result line, a Done or Running status, and Undo.
- Composer: Attach, Mention, a model picker defaulting to Auto, Voice, and Send,
  with the line "Every action is logged and can be undone."
- Empty state: a greeting and four starter prompts.
- The page reflects agent changes as they happen. The notifications popover has
  an Agent tab, and app settings has an Agent tab.

Affected: DEC-010, GAP-007, GAP-008, GAP-009, GAP-010, GAP-014.

## R-012: Approvals Action Inventory

Status: First pass on 2026-10-04. A full pass belongs to the pilot app's spec.

Sources: event registrations and write routes in the local checkout.

Findings:

- Request workflow command with thirteen actions: create, create and submit,
  create from template, copy, update draft, update and submit, submit, restart,
  cancel, decide, comment, attach file, remove file.
- Request workflow, invitation, and template read events.
- Invitation command, template command (save, remove), and user access command
  (update user, remove user).
- Email settings save and test, account notification settings, guest links, and
  participant lookup.
- Identity steps: sign-in, password reset, account challenge, and guest review
  by signed-out guests.

Affected: DEC-009, GAP-008, GAP-013.
