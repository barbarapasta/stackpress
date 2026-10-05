# Pilot Checklist: Tools And The Action Inventory

Section 3 of the [pilot checklist](pilot-checklist.md). Do not start it before
item 1.4 in [the app's boundary](pilot-checklist-boundary.md) has passed. Items
marked **Decision** are for the app's owners. Next:
[panel, journeys, limits](pilot-checklist-acceptance.md).

## 3. Tools

- [ ] **3.1 Offer actions as tools from a plugin.** In an app plugin, listen
  for the `ai-tools` event and call `contributeTool(ctx, { ... })` (imported
  from `stackpress-ai`); no `mcp.tools` entry is needed. Each tool needs:
  `event` (the Approvals event name), `method`, `input` (a JSON Schema; make it
  closed with `additionalProperties: false`, because the command envelope
  refuses unknown fields), `agent: true` (the agent offers only tools that say
  so), `type: 'user'` with a scope (the default `public` would show a write tool
  to callers with no key if `mcp` is ever enabled), `operation` (item 1.7), and
  for a write either `inverse` (a tool name) or `irreversible: true`; a write
  with neither is treated as irreversible and waits for approval. Event names
  must contain no `:`, and must not begin with `account` or `users`: the app
  registers `account:build-view` and `users:*` listeners, and the framework
  reads a colon name as a prefix pattern.
  Pass when: a script lists the tools with `agent: true` (`collectTools`) and
  compares their names with the allow-list in the pilot spec; it fails on any
  extra and on any name in the "must not be offered" list below. From: DEC-007,
  J-012, task 2 and task 5 notes.
- [ ] **3.2 Decision: how an undo is built for Approvals commands.** An undo
  runs the inverse tool with the original action's **stored input**, and since
  task 00010A its event is also told what it is undoing: `undoing(req)` (from
  `stackpress-ai`) returns the original's id, tool, input, **result** (as the
  log returns it) and `operation`, and `undoActionId`, the id of the undo
  action. It is kept apart from the input, and is `undefined` outside an undo.
  Approvals commands still need things the package does not supply: a fresh
  `operationId` that is a **UUID** (an `undoActionId` is not one, so the app
  derives a stable UUID from it, such as a hash of it formatted as a UUID),
  an `expectedRevision` (the result's `request.revision` makes the undo refuse
  if the record moved since, or the event reads the current one), the id that
  only the result holds (`original.result`), and the command envelope's shape.
  So an inverse **tool** here must name an **app wrapper event** that reads
  `undoing(req)`, builds the command and calls the same workflow as the route.
  Earlier values (the draft before `UPDATE_DRAFT`, the template before
  `SAVE_TEMPLATE`, the profile before an edit) are available only if the
  original's event returns them in its result; the package cannot know them.
  Options: (a) **every write is irreversible** (one approval click, no Undo):
  lowest risk, and the pilot cannot show a successful undo; (b) **app wrapper
  inverse events** for the pairs marked reversible below, using the record; the
  pairs that need earlier values return them from the original's wrapper, or
  stay irreversible. The package change that option (c) asked for is done.
  A refused undo that is tried again is a new undo action with a new
  `undoActionId`, so a derived `operationId` differs per attempt; that is right
  only if the refused attempt left no receipt. Evidence on the sample blog:
  `evidence/00010A-undo-session.md`.
  Pass when: the choice is recorded and the inventory below is updated to
  match; under (b), one undo shows Undone with the inverse's receipt carrying
  the derived operation identifier, and a second one on a moved record shows
  the app's reason. From: DEC-012, task 5 notes, task 6 notes, task 00010A.
- [ ] **3.3 Decision: every signed-in person is offered every `agent` tool.**
  The package does not read a tool's `type` or `scopes` for a person; the event
  alone decides. So a non-admin's model is also told about the admin tools
  (template save, user removal), will try them on request, and gets a 403.
  Options: accept (the refusal is the app's and shows on the card); keep admin
  tools out of the tool list through an app wrapper; change the package to
  filter by role. Pass when: a USER asking for an admin action gets a card that
  says it failed with the app's reason, nothing changed, and nothing logged
  as done. From: DEC-001, J-004.
- [ ] **3.4 The upload route and file references.** The intended flow is: the
  panel's `upload(file)` callback sends the file to the app's own route, the
  turn carries only the returned reference (`files`: up to 20 strings of up to
  500 characters), and the tool receives the reference. Approvals does not fit
  that flow as it stands. `POST /requests/:requestId/files`
  (`plugins/approvals/pages/request-file.ts`, `uploadFile`) needs `operationId`,
  `expectedRevision` and the bytes, writes the object to Bunny storage **and**
  runs `ATTACH_FILE` in the same step, only on a draft the person owns (limit
  ten files), and answers `{ file, revision }`. The upload therefore already
  attaches. Separately, `ATTACH_FILE` through the command accepts any file
  address that has the managed shape for that request (`parseManagedFileUrl`);
  the source shows no check that the object exists (read, not run). A model-supplied
  reference could attach a file that is not there.
  **Decision:** (a) upload is the attach: the panel callback uploads to the draft
  named by the page context and the agent gets the reference; do not offer
  `ATTACH_FILE` as a tool; `REMOVE_FILE` stays; (b) a new staging upload that
  stores without attaching, plus an existence check in `ATTACH_FILE`, then offer
  the tool; (c) no file support in the first trial.
  Show: from a browser, with the real session and token, upload through the
  chosen route and see the reference reach a tool call unchanged; send
  `ATTACH_FILE` with a made-up storage id and expect refusal (if it commits,
  that is an app defect whatever is decided here). Pass when: both hold, and
  storage is enabled in the test environment (otherwise the route answers 503
  `FILES_DISABLED`). From: GAP-017, J-010, DEC-010.

### Action inventory (proposals, for the pilot spec to settle)

Read from the Approvals source at commit 37e4486. Event and action names are as
they appear there. The proposal column is the author's reading, not a decision:
the pilot's own spec settles each row. "Reversible" rows depend on item 3.2 being resolved
other than by (a). This differs from the first-pass inventory in two ways: it
adds `ADD_USER`, `RESEND_SETUP` and the email-change admin actions, and it
drops "account notification settings", because `POST /auth/account/notifications`
is retired: `plugins/account/plugin.ts` routes it to the private-access
guard, which answers 403, and `notificationPage` is marked "Retired per-user
channel consent".

**Events (can be tools once items 1.3 to 1.5 are settled):**

| Event | Action or operation | Proposal | Reason |
| --- | --- | --- | --- |
| `approval-workflow-read` | `WORKSPACE` (`view`, `q`, `statuses`, `role`, `skip`, `take`) | Read | Lists the person's queues. |
| `approval-workflow-read` | `DETAIL` (default; `requestId`, `submissionEventId`) | Read | Holds the revision every command needs. |
| `approval-workflow-read` | `PROFILE_CHOICES` | Read | Replaces `GET /api/approvals/participants`, whose handler reads the URL query the agent does not forward. |
| `approval-invitation-read` | `FOR_REQUEST` | Read | Requester only; the event enforces it. |
| `approval-template-read` | `CATALOG`; `ADMIN_LIST`, `ADMIN_DETAIL`, `ADMIN_PROFILE_CHOICES` | Read | The last three are admin only. |
| `approval-workflow-command` | `CREATE` | Reversible, inverse `CANCEL` on `creationId` | A draft can be cancelled. |
| | `CREATE_FROM_TEMPLATE` | Reversible, inverse `CANCEL` | Creates a draft. |
| | `COPY` | Reversible, inverse `CANCEL` | Creates a draft. |
| | `UPDATE_DRAFT` | Reversible, inverse `UPDATE_DRAFT` with the earlier draft | Needs the earlier draft, which neither the input nor the result holds unless the original's wrapper returns it; otherwise irreversible. |
| | `CREATE_AND_SUBMIT`, `UPDATE_AND_SUBMIT`, `SUBMIT` | Irreversible | Notifies approvers; `CANCEL` withdraws but cannot unsend. |
| | `RESTART` | Irreversible | Starts a new approval round and notifies again. |
| | `CANCEL` | Irreversible | Only draft or pending requests can be cancelled; no action that reopens one was found. |
| | `DECIDE` (`APPROVE` or `REJECT`) | Irreversible | An approver's decision; no action reverses it. |
| | `COMMENT` | Irreversible | Visible to others; no removal action. |
| | `ATTACH_FILE` | See item 3.4 | Reversible by `REMOVE_FILE` in principle; unsafe as a free-form tool. |
| | `REMOVE_FILE` | Irreversible | Removes the stored object unless kept for history. |
| `approval-invitation-command` | `ISSUE`, `RESEND` | Irreversible | Sends an email to an outside address. |
| | `REVOKE` | Irreversible | No re-enable. |
| `approval-template-command` (admin) | `SAVE_TEMPLATE` | Reversible, inverse `SAVE_TEMPLATE` with the previous version | Versions are kept, but the previous content is not in the input, or in the result unless the original's wrapper returns it. |
| | `REMOVE_TEMPLATE` | Irreversible | No restore action was found. |
| `user-access-command` (admin, POST) | `UPDATE_USER` (`name`, `title`, `access`, `email`) | Irreversible | An access change bumps the person's `authEpoch` and ends their sessions; an email change sends a verification message. High impact. |
| | `REMOVE_USER` | Irreversible | State becomes REMOVED; no restore action was found. |

**Route-only actions (no event; each needs an app wrapper event first, because
the tool runner resolves events by name and the forwarded request has a different
path and no query):**

| Route and handler | Action | Proposal | Reason |
| --- | --- | --- | --- |
| `POST /requests/:requestId/guest-links` (`manageGuestLinks`) | `ISSUE` (`submissionId`, `recipientId`, `operationId`); `REVOKE` (`id`) | `ISSUE` reversible, inverse `REVOKE`; `REVOKE` irreversible | The handler takes `requestId` from the path. The inverse needs the new link id from the result, which `undoing(req)` now gives it. |
| `POST /admin/email` (`plugins/email/command-route.ts`) | `SAVE_EMAIL_SETTINGS` | Irreversible; **Decision** whether to offer | It carries SMTP credentials, which would pass through the model, the stored turn and the action log. |
| `POST /admin/email/test` | `TEST_EMAIL_SETTINGS` | Irreversible | Sends a real email; the handler picks its action from `pathname.endsWith('/test')`. |
| `POST /api/approvals/participants` (`provision-route.ts`) | provision a participant by `email` | Irreversible | Creates a pending account and queues a message. |
| `POST /admin/users`, `/admin/users/:id` (`challengeCommandRoute`) | `ADD_USER`, `RESEND_SETUP` | Irreversible | Creates an account and sends a setup email. |
| same route | `RESEND_EMAIL_CHANGE`, `CANCEL_EMAIL_CHANGE` | **Decision** | Admin management of another person's pending email change, which sits beside the excluded verification step. |
| `POST /auth/account/update` (`selfProfilePage`) | edit own `name`, `image` | Reversible, inverse the same call with the earlier values; **Decision** whether the personal account page counts | The earlier values are not in the input, or in the result unless the original's wrapper returns them. |
| `POST /auth/account/theme` (`saveThemeRoute`) | `theme` | Reversible, same route with the earlier theme; **Decision** | A personal preference. |
| `POST /requests/:requestId/files/:storageId/remove` | remove file | Same as `REMOVE_FILE` | Duplicate of the command. |

**Personal security steps that must not become tools.** They prove who a person
is, or serve signed-out visitors; the agent acts under an identity already
proved. Sign-in and sign-out (`auth-signin`, `/auth/signin/*`, `/auth/signout`);
password change (`POST /auth/account/security/password`, `selfPasswordPage`);
forgot and reset password (`POST /auth/forgot-password`, `/auth/reset-password`);
account setup and email-change verification (`POST /auth/setup`,
`/auth/verify-email-change`); the `account-challenge-command` event; the
person's own email change (`SELF_EMAIL_CHANGE`, `RESEND_SELF_EMAIL_CHANGE`,
`CANCEL_SELF_EMAIL_CHANGE` on `/auth/account/update`); invitation redemption
(`REDEEM`, `REDEMPTION_PAGE`, `POST /invitations/:invitationId/redeem|switch`);
guest review by signed-out guests (`/guest-reviews/:guestId`, its `/files` and
`/comments` routes); the `/internal/*` routes; and the generated model events,
which the app already rejects for its protected models.
Pass when: the tool list contains none of these; asking "reset my password"
makes the agent say it has no such tool and point to `/auth/account`, with no tool
run and nothing logged. From: DEC-009, J-005, first-pass inventory.

- [ ] **3.5 Every inventory row has a tool, an exclusion, or a recorded
  reason.** For each row the pilot spec settles Read, Reversible (and its
  inverse), Irreversible, or Not offered, and each offered tool has a test
  through the boundary choice of item 1.3: success, a person without access
  (refused exactly as through the page), a stale revision, and for irreversible
  tools the approval pause. Pass when: no row is unaccounted for. The
  instruction was that the agent must do every action available there; where
  an action is excluded (SMTP secrets, for example), the owners' decision says
  so. From: DEC-009, DEC-012.
