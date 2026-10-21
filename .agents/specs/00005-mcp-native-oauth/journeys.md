# What People Will Do

This document walks through the planned experience for spec 00005: setting up
the feature, signing in, giving a program permission, using it, and stopping its
access. The review was completed on 2026-09-28; this plain-language rewrite is
dated 2026-09-29. The user accepted and froze these journeys on 2026-09-29.
They have not all been tested in the finished app.

The details come from the [brief](brief.md), [decisions](decisions.md),
[settings](configuration.md), [rules for requests and approval](events.md),
[database plan](storage.md), [getting back in after an error](recovery.md), and
[test results](proof-results.md). Existing behavior is described in the
[shared project guidance](../../context/interfaces-and-experience.md).

Here, a **program** means something such as Claude Code or Codex. An **access
key** lets it make approved requests. An **approval** is the person's saved
permission for that program, including its limits and end date. A key can expire
while the approval still allows the program to get a replacement.

“MCP” means the connection through which the program uses tools. “API” means
ordinary requests to the app. The plan covers both. The same key works only on
the tools and ordinary requests that the approval allows.

## What We Checked

We checked five parts of the experience:

- **F1 — Setup:** turn the feature on, or update an app that already uses keys.
- **F2 — Approval:** introduce a program, sign in, and allow or deny its request.
- **F3 — Use:** find tools and make allowed tool calls or ordinary app requests.
- **F4 — Get back in:** replace an expired key, approve again, or recover from a problem.
- **F5 — Manage access:** see approved programs and disconnect them.

There are two kinds of people: someone maintaining the app and someone using it.
The situations below describe what each person can currently do. They do not
introduce fixed account roles. A maintainer who uses a program also follows the
appropriate user journey.

Programs, browsers, databases, servers forwarding requests, and the app's access
and identity checks help these journeys work; they are not people in the table.
Introducing a program and finding its sign-in instructions belong to F2. Regular
removal of expired saved records supports F1 and F4.

Each U number names a person's goal. The matching J number describes the steps:
U03 is explained by J03, for example. The numbers keep this file connected to the
rest of the plan. Every table entry has been considered; none is unknown.

| Person's situation | F1 setup | F2 approval | F3 use | F4 get back in | F5 manage access |
| --- | --- | --- | --- | --- | --- |
| M1 maintaining a new setup | U01 | As a user | As a user | As a user | As a user |
| M2 maintaining an app with existing keys | U02 | As a user | As a user | As a user | As a user |
| P1 signed out, without usable approval | Maintainer only | U03 | U08 | U03 | U14 |
| P2 signed in, without usable approval | Maintainer only | U04 | U08 | U04 | U13 |
| P3 signed in, able to complete a required extra identity check | Maintainer only | U05 | U08 | U05 | U13 |
| P4 signed in, unable to complete a required extra identity check | Maintainer only | U06 | U08 | U06 | U13 |
| P5 approved and allowed to continue | Maintainer only | U04 | U08, U09 | U09 | U13 |
| P6 approved, but missing permission for this action | Maintainer only | U04 | U08, U10 | U10 | U13 |
| P7 key expired, but automatic replacement is still allowed | Maintainer only | U04 | U08, U11 | U11 | U13 |
| P8 approval ended, was cancelled, or was cancelled because an old code/key was reused | Maintainer only | U04 | U08, U12 | U12 | U13 |
| P9 account inactive or suspended | Maintainer only | U07 | U08, U07 | U07 | U07 |

“Maintainer only” means setup is not part of that user's authority. “As a user”
means the maintainer follows a user row when doing that activity; it is not part
of the setup job.

P6 includes an app changing which requests are covered or reducing permission.
P7 can replace a key automatically; P8 needs a new approval. P3 and P4 can apply
whenever someone approves, including when approving again from P5–P8. If the
browser signs someone out during a journey, they follow P1. Setting up sign-in
or an extra identity check uses the app's existing features; this work does not
add a new account-enrollment process.

## Each Person's Goal

The table records what starts each journey, what must already be true, and where
it should lead. The G numbers refer to the related topics in [decisions](decisions.md).
The source links at the start of this file apply throughout.

| Goal and journey | Part and person | Starting point and goal | Expected result; related decisions |
| --- | --- | --- | --- |
| U01/J01 | F1, M1 | Maintainer has an app and wants browser-based program sign-in with any of the four supported databases | Programs can find and use the service after checks pass; G-004/G-006/G-007 |
| U02/J02 | F1, M2 | App has existing keys; maintainer wants selected keys to keep working with MCP | Selected keys are assigned to that service; ordinary API use continues; G-003/G-004 |
| U03/J03 | F2/F4, P1 | Signed-out person opens a checked sign-in request from a program | Sign in, then return to approval; G-006 |
| U04/J04 | F2/F4, P2/P5/P6/P7/P8 | Signed-in person reviews a valid request | Allow limited access or safely deny it; G-006/G-007 |
| U05/J05 | F2/F4, P3 | App requires an extra identity check that the person can complete | Record success for this approval only; G-006 |
| U06/J06 | F2/F4, P4 | Person cannot complete a required extra check | Explain how to set it up or get help; never approve silently; G-006 |
| U07/J07 | F2/F3/F4/F5, P9 | Person with an inactive account tries to continue | Refuse private access and explain where to get account help; G-006 |
| U08/J08 | F3, P1–P9 | Person wants to see tools or use a public tool without signing in | Show public information without exposing private data; G-003/G-005 |
| U09/J09 | F3/F4, P5 | Person uses approved tools or ordinary app requests | Return allowed results and keep the original approval limits; G-003/G-005/G-007 |
| U10/J10 | F3/F4, P6 | Person wants an action their approval does not cover | Approve allowed extra access, then reconnect; G-005/G-007 |
| U11/J11 | F3/F4, P7 | Key expired while replacement is still allowed | Program replaces it automatically where supported; G-004/G-005 |
| U12/J12 | F3/F4, P8 | Approval has ended and person wants to continue | New approval and a new connection; G-005/G-006 |
| U13/J13 | F5, P2–P8 | Signed-in person wants to inspect or disconnect their programs | Cancel the selected approval for both MCP and API; G-001/G-006 |
| U14/J14 | F5, P1 | Signed-out person wants their connected-program list | Sign in safely, then see the list; G-006 |

## How To Read The Steps

Each step has a label that says who owns the work, whether the expected behavior
is described, and whether anything must be built first:

- **Planned:** part of this work; the expected behavior is described and ready to build.
- **Waiting:** part of this work and described, but it needs the database-library
  fix or other unfinished parts before it can work.
- **Elsewhere:** handled by an existing app feature or another program. The plan
  says where we hand over; actual behavior still needs checking there.

A clear description does not mean the step is built, tested, or approved. A small
test version passing is not enough to claim the full journey works. The user
accepted the existing-key change in G-003 and the way to ask for more access in
G-005 when freezing the plan. That does not mean their implementation has passed.

## J01 — Set Up The Feature

**Goal U01; F1.** A maintainer turns on browser-based program sign-in, chooses
how MCP will run, and selects which ordinary API requests may use the new keys.

1. **Planned:** Set the exact addresses, display names, permissions and app rules.
   Missing or conflicting settings stop startup and explain which setting is wrong.
2. **Waiting:** Install the corrected Inquire database library. Add the required
   database definitions and create/update a separate test database. Repeat the
   code-generation step and run the checks for all four supported database choices.
3. **Waiting:** Start the app and any separate MCP server. Check sign-in instructions,
   forwarding servers, allowed browser addresses, and every relevant request path
   with the normal browser access checks turned on. Advertise only features that work.
4. **Waiting:** Run the account, program and API journeys. Check that packages build,
   can be imported, and meet the required test coverage. Release through the
   maintainer's normal process only after those checks pass.

If a required library or database update fails, stop setup, fix it and rerun the
affected checks. The result should be a documented working setup, ready to operate.

## J02 — Keep Selected Existing Keys Working

**Goal U02; F1.** A maintainer enables the new sign-in feature on an MCP service
that already accepts older keys.

1. **Planned:** Privately list the keys to keep. Preview the update without changing
   anything. Report invalid records, conflicting key names and the service each
   key will be assigned to, without printing secret values.
2. **Waiting:** Save those explicit assignments. Check examples of existing app
   and user keys for both reads and changes, including unchanged API replies.
   Then enable the new sign-in feature for that service.
3. **Planned:** Refuse MCP keys that have no assignment and explain why. The
   maintainer can assign a valid intended key or ask for a new approval. First use
   must not silently assign a key, and ordinary API keys must not all be converted.

Repeating the update for the same key kind, ID and service must not create another
assignment. Failed database changes must leave no partial update. Turning the new
feature off restores the previous MCP behavior and loses its added protections;
it is a maintainer's way to undo the upgrade, not a way to repair an access problem.
Selected old keys keep working there and remain managed through the old screens.

## J03 — Sign In Before Approving

**Goal U03; F2 and F4.** A person follows a program's sign-in link while signed out.

1. **Planned:** Check the program, its request and the address to return to. Unsafe
   requests stay on an error page in this app with restart instructions. Save a
   valid request on the server so it survives sign-in.
2. **Elsewhere:** Use the app's existing sign-in and normal extra identity checks.
   Save only a safe return to this app's approval page. A failed sign-in stays
   in the sign-in process.
3. **Planned:** Reload the saved request and current account. Continue to J04,
   J05 or J06 according to the app's rules. If the request expired or was lost,
   explain how to restart sign-in from the program. Issue no access key.

## J04 — Approve Or Say No

**Goal U04; F2 and F4.** A signed-in person opens a valid request awaiting approval.

1. **Planned:** Show the program, its website, the return address, the service,
   permissions and ordinary API actions it wants to use. Display supplied text
   safely so it cannot run code. Offer only choices the app currently allows;
   hidden form values cannot add permission.
2. **Planned:** If the person says no, return a refusal only to
   the checked address, keeping the original request reference and the identity
   of the server handling sign-in. Approval checks that the form came from the expected browser,
   the account and program are still valid, this request belongs to the person,
   and any required extra identity check succeeded.
3. **Waiting:** Complete the saved request and issue one short-lived sign-in code
   together, with no partial database change. The program exchanges that code for
   keys using the [required proof that it started sign-in](events.md): it shows
   the original secret whose fingerprint it sent when starting the request. Submitting
   twice shows a completion page instead of issuing a second code.
4. **Elsewhere:** The program finishes signing in and connects. If the browser
   cannot return or the program loses the key reply, explain how to restart.
   Reusing an already-used code can cancel that approval. A new approval needs
   a new MCP connection.

If the rules, program details or selected access changed, show them again for
approval. If a required service fails, issue no code and allow another attempt
while the saved request is still valid. The person ends with an allowed connection
or a clear refusal. Access keys must never be included in the approval page's data.

## J05 — Complete An Extra Identity Check

**Goal U05; F2 and F4.** The app requires a fresh check, and the person has a way
to complete it, such as their existing authenticator.

1. **Planned:** Show the separate approval check form. Check that it came from the
   expected browser and belongs to the saved approval request. Limit attempts
   across all servers before checking the submitted code.
2. **Waiting:** Accept a valid authenticator code only once for this check and
   save that fact without allowing simultaneous attempts to reuse it. Save a
   short-lived confirmation for this account, request and selected access, then
   return to J04. Show a clear field error for a bad code. Too many attempts must
   say when to retry; an expired confirmation requires another check.

Changing the account or requested permissions invalidates that confirmation.
Copying or reusing it cannot approve a different request.

## J06 — Explain Why The Extra Check Cannot Be Completed

**Goal U06; F2 and F4.** The required check is unavailable or cannot be completed.

1. **Planned:** Explain the problem without approving access. Offer the app's
   existing setup or account-help path, cancellation, or an alternative that the
   app's rules explicitly allow.
2. **Elsewhere:** The app handles setup or help. Returning restarts or rechecks
   J04/J05; it does not reuse an unchecked approval.

Never silently skip the check. Leaving the page lets the saved request expire
without issuing keys.

## J07 — Refuse Access For An Inactive Account

**Goal U07; F2, F3, F4 and F5.** A person with an inactive or suspended account
tries to approve, use or renew access, or open their connected-program list.

1. **Planned:** Reload the current account and refuse the protected action. Give
   a safe explanation and point to the app's existing account-help path.
2. **Elsewhere:** The app handles account help. This sign-in feature does not
   restore deleted accounts or provide a new account-recovery process.

Do not restore the old approval or reveal another person's connected programs.

## J08 — See Tools And Use Public Tools Without Signing In

**Goal U08; F3.** A person adds the server address without an access key.

1. **Waiting:** The program connects and sees public tools, plus the names and
   descriptions of protected tools. Protected entries include only the empty
   input description required by the connection format. After approval, the
   program asks for the list again to learn the full details and required inputs.
2. **Waiting:** Public tools work without sign-in. A protected tool responds with
   a sign-in request and instructions that lead to J03/J04. If the program
   supplies an invalid key, refuse it; do not quietly ignore it.

Once a connection belongs to an approval, later requests need its matching key,
even for public tools. Start a new connection without a key to use the public
path again. No protected action runs without approval.

## J09 — Use An Approved Tool Or API Request

**Goal U09; F3 and F4.** A person asks the program to use an approved action.

1. **Waiting:** Check the current key, account, service, exact approved API action,
   whether this is an app or user key, and whether it is a read or change. For a
   non-empty required-permission list, any one match is enough. Reject attempts
   to supply a false account identity, then add the identity checked by the server.
2. **Waiting:** Check again immediately before starting a protected action, then
   return its result. Requests running at the same time must not share or mix up
   identities. A replacement key for the same approval can keep its connection.

A missing or wrong secret, wrong service, unknown tool, mismatched identity, or
unapproved browser address follows the [error and recovery rules](recovery.md).
A late refusal says the action did not start only when that is
known. If the connection times out after the action starts, its outcome may be
unknown: do not automatically repeat an action that changes data. The action's
own code still checks who owns the records and whether the person may use them.
After a successful result, the person can continue using the program.

## J10 — Ask For More Permission

**Goal U10; F3 and F4.** The current approval does not cover the requested action,
or the app has changed which ordinary requests that approval covers.

1. **Waiting:** Refuse the action and explain why new approval is needed.
   Do not run the action.
2. **Elsewhere:** The person uses the program's documented sign-out/sign-in steps.
   Ask for the needed permissions where supported; otherwise use the set the
   server offers. Signing out locally does not cancel the old saved approval.
3. **Waiting:** Follow J04/J05 and allow only access the app currently permits.
   Start a new approval and MCP connection, then retry the refused action. If
   the app does not allow the access, explain that instead of repeatedly asking
   the person to approve something they cannot have.

## J11 — Replace An Expired Key Automatically

**Goal U11; F3 and F4.** The key expires before the approval's replacement deadline.

1. **Waiting:** Tell the program the key is no longer valid.
   It uses its current renewal secret to request a replacement. Replace both
   parts of the access key together, without adding permissions or API actions.
2. **Waiting:** Continue J09 using the same approval and connection. If requests
   reuse a renewal secret, including simultaneous requests, cancel that approval's
   access and further replacements. Expired, reused or cancelled renewal secrets
   lead to J12 instead of endless retries.

A database outage allows another attempt later. If the replacement was saved but
its reply was lost, J12 may be necessary. Old key IDs and full keys never work
again. Replacing a key never moves the original approval deadline.

## J12 — Approve Again After Access Ends

**Goal U12; F3 and F4.** The approval deadline passed, someone disconnected it,
or reuse of an old code or renewal secret caused cancellation.

1. **Waiting:** Refuse access and key replacement for both MCP and API, and explain
   how to approve again.
2. **Elsewhere:** The person explicitly restarts sign-in from their program,
   then follows J03/J04/J05.
3. **Waiting:** Create a new approval and connection. The old keys remain invalid.

Someone who disconnected intentionally can simply stop. Approval is never given
automatically on their behalf. If only the MCP connection was lost, start a new
connection; that alone does not require a new approval.

## J13 — See And Disconnect Approved Programs

**Goal U13; F5.** A signed-in person with an active account opens their connections.

1. **Planned:** Show a safe summary of their own approvals, or explain that there
   are none. Do not show access-key IDs, saved secret fingerprints or browser
   sign-in keys.
2. **Waiting:** When they submit Disconnect, check that the form came from the
   expected browser and that they own the approval. Save the cancellation fully,
   confirm success and stay on the list. Repeating the cancellation for their
   already-cancelled approval still succeeds.
3. **Waiting:** Refuse the next MCP call, API request and key replacement for that
   approval. Work that already started is not undone. Other approvals still work.
   A delayed notification must not let access continue.

An unknown approval or someone else's approval is shown as unavailable. If saving
fails, offer retry without claiming cancellation succeeded. Provide a link back
to account settings. Older keys remain managed through their existing screens.

## J14 — Sign In To See Connected Programs

**Goal U14; F5.** A signed-out person wants to open their connected-program list.

1. **Elsewhere:** Follow the app's existing sign-in process with a safe return
   to the list.
2. **Planned:** Reload the current account and follow J13, or J07 if access is
   denied. A program's access key does not authorize viewing all of a person's
   connected programs.

## Things That Can Go Wrong, And What Happens Next

We checked all twelve situations below for every goal. The table points to the
journeys that explain them. Where a situation does not apply, the reason is stated.

| Situation | Where it is covered, or why it does not apply |
| --- | --- |
| Everything works, or the journey reaches its intended end | J01–J14; explaining refusal or offering help is the intended result in J06/J07 |
| Information is missing, wrong or conflicting | J01/J02 settings and key IDs; J03/J04 requests and selections; J05 identity code; J08–J12 actions and keys; J13 ownership. J06/J07/J14 start from already-checked requests. |
| The person must sign in or prove who they are | J03–J07/J11/J12/J14; J08 allows public use; J09/J10/J13 check the current identity; J01/J02 require maintainer authority. |
| The person is not allowed to do something | J01/J02 maintainer authority; J04–J07 app rules; J08–J13 action/ownership checks; J03/J14 use existing sign-in. |
| Something expired, was cancelled or became unavailable | J01/J02 required libraries and database state; J03–J06 saved requests and check confirmations; J07 suspended account; J08–J13 keys, approvals and connections; J14 browser sign-in. |
| This is the first visit, or there is nothing to show | J01 first setup; J02 selecting no keys changes nothing; J03/J04 first approval; J08 public tool list; J13 empty connections. Others follow these journeys or need existing access first. |
| Someone repeats an action | J02 repeated key assignment; J04 repeated approval/code use; J05 reused identity code; J09 no automatic repeat of changes; J11 competing key replacements; J13 repeated disconnect. Other page visits and reads do not create duplicate changes. |
| Someone cancels, retries, waits too long or loses the connection | J01/J02 failed setup; J03–J06 expired/abandoned requests; J08–J12 connection recovery; J13 retry after failure; J07 help; J14 existing sign-in cancellation. |
| Another service fails | J01/J02 database; J03/J14 sign-in; J04–J06 program details, app rules or extra check; J08–J13 storage/program/network; J07 account help. |
| Information changes, or two requests arrive together | J01/J02 database/settings checks; J04/J05 current rules and check confirmation; J07 current account; J09–J13 fresh checks and complete database updates. J03/J06/J08/J14 lead to these checks. |
| The person needs an explanation and a way to continue | J01–J14 and the recovery document. Do not assume the program automatically asks for more permission. |
| The journey ends, and the person needs to know what changed | J01–J14 state the result and next step. Tests against the finished implementation are still required. |

## Is This Ready?

The review covers five features and eleven different situations people can be in:
55 combinations in total, with fourteen goals and fourteen journeys. Every kind
of success, failure and recovery listed above has been considered. No additional
missing behavior was found beyond the final review already recorded under
G-003/G-005/G-006/G-007.

The behavior is described and accepted as the build plan. Describing another program's part does not guarantee that it works in every
program. The Inquire fix and the full P-003 test against the finished app must
pass before release. They do not stop us from finishing the plan, and they must
not be reported as passing before they are actually checked.
