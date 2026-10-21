# Freeze Record

Spec 00004 is **Frozen on 2026-09-29**.

The user first asked whether the plan was ready to freeze. The final choices
were presented, the user reviewed the journey document in plain language, then
instructed: “Freeze then create task files.” That accepts the completed plan
and authorizes task creation from its build sequence. No extra approval is needed
to create those files. It does not accept unfinished code, delegate task acceptance,
authorize deployment/publication, or claim that release checks have passed.

## Accepted Final Choices

- New OAuth records and verification belong to session; AI and API use them.
- Existing MCP keys need explicit service bindings when OAuth is enabled;
  ordinary legacy API behavior remains unchanged.
- Apps use named rules to decide who may approve and use permissions.
- Anonymous clients see protected names/descriptions and only the minimal
  required input description. Full protected schemas need permission and relisting.
- More permission may require explicit sign-in, new approval and a new connection.
- The Inquire transaction fix is required before production OAuth storage.
- Complete app/browser/native-client checks happen after implementation and
  remain required before release.

All other detailed defaults and contracts in configuration, events, storage,
recovery, design and verification are accepted with this plan. No additional
product scope is introduced by breaking the work into tasks.

## Freeze Requirements

| Requirement | Result |
| --- | --- |
| Scope and goals | Accepted brief; unchanged planning scope and package ownership |
| Decisions | G-001–G-007 answered; final technical choices accepted by this instruction |
| Research | R-001–R-007 complete for implementation planning |
| P-001 | Candidate feasibility proved on all four databases; required upstream correction retained |
| P-002 | Corrected transport mechanics proved; automatic escalation failed with accepted explicit-reapproval fallback |
| P-003 | Native fixture checks passed; complete production journey deferred to mandatory task 00012 after implementation |
| P-004 | Shared-resource mechanism proved; actual generated/API integration remains required |
| Journeys | Complete: 5 features, 11 person states, 55 combinations, 14 goals/journeys |
| Shared context | Stable accepted ownership/access direction promoted; detailed contracts and evidence remain here |
| Conflicts | No unresolved conflict with current context; future behavior is labelled unimplemented |
| Blockers | None for Freeze; Inquire and production checks still constrain implementation/release |

Research and Proofs: **Frozen** with the outcomes and deferral above. A deferred
production proof is not a passing proof. Preserve the existing sanitized results;
record new implementation evidence in tasks rather than rewriting past results.

## Tasks And Later Changes

The [task plan](tasks/sprint.md) follows the accepted six stages. The user explicitly
requested final task files; do not add another review-first permission loop.
Implementation plan status is accepted; all twelve tasks start open. Execution
and acceptance remain unstarted. Tasks without a visual review finish at verified;
ones with a visual review need explicit user acceptance after verification.

Frozen requirements need explicit permission to reopen. Implementation progress,
evidence and blockers belong in the task files and task status; maintain the
implementation tracker in status.md without silently changing the agreed behavior.

Document validation covers links, line limits, preservation of exact question
history/source copies, task dependencies, test/journey coverage and whitespace.
No production runtime suite is claimed from this document-only Freeze pass.


## Shared-Context Check

Only the accepted future direction was added to interface context and its router
entry. Existing runtime facts, signatures and generated contracts were unchanged.
The following six small retrieval samples were checked using that context alone:

| Use | Retrieved statement | Review result |
| --- | --- | --- |
| Documentation | Session will own new approval/key checks; AI/API retain their surface checks | Ownership preserved; future tense |
| Article | One approval can cover MCP and explicitly approved API operations | No same-host expansion or shipped-support claim |
| Diagram | Person → session approval; AI/API → common verification → allowed action | No session dependency on AI/API and no connection-ID authority |
| Teaching | A read ID is a credential; another method requires id:secret | Tool method and wrong-secret non-downgrade preserved |
| Marketing | Native OAuth is an accepted upcoming direction, with production/client checks still due | No announcement of availability or universal automatic permission upgrades |
| Contributor | Preserve API opt-in, old-key binding, current checks and four-database requirement | No prototype substituted for the Inquire fix or release evidence |

These are document retrieval checks, not runtime tests. No new taxonomy, public
signature or generated code was introduced by context promotion.

Final checks passed: workspace validator (allowed length warnings only), whitespace,
12 task section/status checks, acyclic dependencies, ownership of all 22 required
test families and 14 journeys, exact original question/source-mapping preservation,
unchanged proof results and four unchanged saved source documents. Git ignores new
agent files under the existing user rules, so explicit file checks supplemented
Git diff checks; no ignore/staging changes were made.

## Post-Freeze Amendments

- A-001 (2026-10-15, user-approved): OAuth admin pages are admin-only and left out
  of the default menu, like Auth, Application and Session, instead of not existing
  at all. See [decisions](decisions.md#amendment-a-001--admin-access-to-oauth-records).
