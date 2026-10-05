# User Journeys

Journeys for the signed-in person using the built-in agent. Integration,
developer, and operator journeys are in
[Integration Journeys](journeys-integration.md). Step tags are scope then
implementability.

## J-001: Reversible Action From Chat

- Actor: signed-in person.
- Goal: get a reversible action done by asking.
- Trigger: the person sends a message in the agent panel.
- Preconditions: `agent` config present; the person is signed in and under the usage limit.
- Steps:
  1. [in-scope, implementable] The panel loads the thread and the page's context items.
  2. [in-scope, implementable] The server checks sign-in, the anti-forgery token, and the usage limit, then stores the message.
  3. [in-scope, implementable] The runtime sends the transcript and the tools this person may use to the chosen model; text streams back.
  4. [in-scope, implementable] The model requests a reversible tool; the runtime builds a new request with the person's session and the tool arguments and resolves the app event.
  5. [in-scope, implementable] The event authorizes as the person and commits; the runtime logs the action with the app's operation identifier and shows a Done card with Undo.
  6. [in-scope, implementable] The plain panel refreshes the page data. [external] The OfficePress panel shows the change in place.
- Scope notes: the OfficePress panel is built in OfficePress code under DEC-005.
- Implementable steps: 1 to 6.
- Evidence links: P-001, P-002, P-003, DEC-001, DEC-010, DEC-012.
- Gaps created or resolved: none.
- Acceptance impact: the pilot must show an action authorized as the person, logged, and visible on the page.

## J-002: Irreversible Action With Approval

- Actor: signed-in person.
- Goal: let the agent run an action that cannot be undone, with the person's consent.
- Trigger: the model requests an irreversible tool.
- Preconditions: as J-001.
- Steps:
  1. [in-scope, implementable] The runtime stores the turn as waiting and shows a card with the action name and inputs. Nothing runs.
  2. [in-scope, implementable] Approve: the runtime rechecks sign-in, runs the event as in J-001, shows Done with no Undo, and continues the turn.
  3. [in-scope, implementable] Decline: the runtime records the refusal, tells the model, and continues with no action.
  4. [in-scope, implementable] Recovery: after a reload or on another server, the stored turn is found; a repeated approval answers from the record and runs nothing.
  5. [in-scope, implementable] A pending approval expires when the person sends a new message or a configured time passes.
- Scope notes: a write tool that declares neither an inverse nor irreversibility is treated as irreversible.
- Implementable steps: 1 to 5.
- Evidence links: P-002, DEC-012.
- Gaps created or resolved: GAP-019 created for step 5.
- Acceptance impact: the pilot must show approve, decline, resume after reload, and no double run.

## J-003: Undo An Agent Action

- Actor: signed-in person.
- Goal: reverse an action the agent took.
- Trigger: the person clicks Undo on a Done card.
- Preconditions: the card is in the person's own thread and its tool declared an inverse.
- Steps:
  1. [in-scope, implementable] The runtime runs the inverse tool with the stored inputs through the same forwarded request, without a second approval.
  2. [in-scope, implementable] The event commits, or refuses because the record changed since; the card shows Undone or the reason.
  3. [in-scope, implementable] The log links the undo to the original action.
- Scope notes: undo is the person's own click, so it needs no approval card.
- Implementable steps: 1 to 3.
- Evidence links: DEC-012, R-011.
- Gaps created or resolved: none.
- Acceptance impact: the pilot must show one undo succeeding and one refused undo explained.

## J-004: The App Refuses The Action

- Actor: signed-in person.
- Goal: understand why the agent could not act.
- Trigger: the app event answers forbidden, not found, or conflict.
- Preconditions: as J-001.
- Steps:
  1. [in-scope, implementable] The runtime logs the refusal and returns it to the model as a failed tool result.
  2. [in-scope, implementable] The agent explains the refusal; the card shows Failed. The step limit stops retry loops.
- Scope notes: the app event is the final authority under DEC-001.
- Implementable steps: 1 and 2.
- Evidence links: R-005, P-001.
- Gaps created or resolved: none.
- Acceptance impact: the pilot must show a person without access being refused through the agent exactly as through the page.

## J-005: A Personal Security Step Is Requested

- Actor: signed-in person.
- Goal: for example, reset a password by asking the agent.
- Trigger: the person asks for sign-in, password, email-verification, or guest-review help.
- Preconditions: as J-001.
- Steps:
  1. [external, evidence-only] The app registers no tool for these steps.
  2. [in-scope, implementable] The agent has no such tool, says so, and points to the account page.
- Scope notes: excluded by DEC-009.
- Implementable steps: 2.
- Evidence links: DEC-009, R-012.
- Gaps created or resolved: none.
- Acceptance impact: the pilot tool list must not contain these steps.

## J-006: Page Context

- Actor: signed-in person.
- Goal: say "this" and have the agent know what is meant.
- Trigger: the person opens the panel on a page.
- Preconditions: the page declares context items.
- Steps:
  1. [in-scope, implementable] The panel shows the page address and declared items as removable chips.
  2. [in-scope, implementable] Removed items are not sent with the next message.
  3. [in-scope, implementable] The server may enrich items through an app event; no authorization uses them.
- Scope notes: context is a hint under DEC-014.
- Implementable steps: 1 to 3.
- Evidence links: DEC-014, R-011.
- Gaps created or resolved: none.
- Acceptance impact: a tampered context item must not widen what the person can do.

## J-007: History, New Chat, And Model Choice

- Actor: signed-in person.
- Goal: return to an earlier chat, start a new one, or change the model.
- Trigger: the person uses History, New chat, or the model picker.
- Preconditions: stored threads exist for the person.
- Steps:
  1. [in-scope, implementable] History lists only the person's own threads; opening one replays its transcript and cards.
  2. [in-scope, implementable] New chat starts an empty thread with the current page context.
  3. [in-scope, implementable] A new model choice applies from the next reply; earlier turns are rebuilt for it.
- Scope notes: threads are private to their owner.
- Implementable steps: 1 to 3.
- Evidence links: P-003, DEC-004, DEC-010.
- Gaps created or resolved: none.
- Acceptance impact: one person must not be able to open another person's thread.

## J-008: Usage Limit Reached

- Actor: signed-in person.
- Goal: none; the limit protects the shared key.
- Trigger: the person sends a message after reaching the daily limit.
- Preconditions: a per-person limit is configured.
- Steps:
  1. [in-scope, implementable] The server refuses before any provider call and says when the limit resets.
- Scope notes: recorded usage comes from provider replies.
- Implementable steps: 1.
- Evidence links: DEC-002, P-003.
- Gaps created or resolved: none.
- Acceptance impact: a refused message must cost nothing.

## J-009: Sign-In Expired Or Wrong Person

- Actor: person whose sign-in ended, or a different signed-in person.
- Goal: none; this is a permission failure.
- Trigger: a message, approval, or undo arrives without a valid sign-in for the thread's owner.
- Preconditions: a thread exists.
- Steps:
  1. [in-scope, implementable] The server refuses; no provider call and no tool run happen.
  2. [in-scope, implementable] A pending approval stays stored and runs only after its owner signs in again and approves.
- Scope notes: none.
- Implementable steps: 1 and 2.
- Evidence links: P-001, DEC-001.
- Gaps created or resolved: none.
- Acceptance impact: an approval sent by another person must be refused.

## J-010: Attach A File

- Actor: signed-in person.
- Goal: have the agent attach a file to a record.
- Trigger: the person adds a file in the composer and asks the agent to attach it.
- Preconditions: the app has a file action, as Approvals does.
- Steps:
  1. [unknown, blocked] The file reaches app storage before the tool call.
  2. [in-scope, implementable] The turn carries a file reference, and the tool receives the reference.
- Scope notes: the app owns upload and storage.
- Implementable steps: 2.
- Evidence links: DEC-010, R-012.
- Gaps created or resolved: GAP-017 created.
- Acceptance impact: the pilot's file actions depend on GAP-017.
