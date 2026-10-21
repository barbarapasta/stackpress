# Where The Plan Stands

Spec: `00004-mcp-native-oauth`.
Status: **Frozen, 2026-09-29.** User instruction: “Freeze then create task files.”
Implementation status: **accepted**. The twelve tasks are **open**; none has started.
See the [freeze record](freeze.md), [task plan](tasks/sprint.md) and [task tracker](tasks/status.md).
The requested planning and authorized prototype pass are complete. Production
implementation, publishing, app database changes and deployment have not started.

## Completed Planning

| Item | Result | Next action |
| --- | --- | --- |
| Scope and product answers | G-001/G-002/G-003 and Q-007–Q-013 retained exactly; 14 question records, none awaiting an answer | Follow the Frozen contracts |
| G-004 database feasibility | Candidate passes all four databases; current Inquire ownership defect reproduced | Implement/pin the upstream fix before OAuth stores |
| G-005 connections and recovery | HTTP/SSE mechanics proved; accepted explicit reapproval covers failed automatic permission upgrades | Test the accepted fallback in production integration |
| G-006 settings and events | Exact config, defaults, routes, identity, app policy, limits, approval and exports accepted | Implement required policy listeners and serving finalization |
| G-007 shared service | Exact resource plus explicit saved API operation fingerprints | Test actual generated/parameterized API routes |
| Existing MCP keys | Explicit service-binding migration and hardened validation accepted; ordinary API behavior preserved | Implement and document the accepted upgrade |
| Research | R-001–R-007 complete for planning | Recheck pinned versions while building |
| User journeys | Complete coverage: 5 features, 11 actor states, 55 intersections, 14 Use Cases/journeys | Run production journeys after implementation |
| Build order | Six stages complete; Stage 2a Inquire blocks Stage 2b session stores | Twelve tasks created after Freeze; begin with task 00001 |
| Shared project guidance | Stable accepted ownership/access rules promoted to interface context; exact contracts/evidence remain spec-local | Revisit verified implementation facts at closeout |
| Document checks | Validator and whitespace checks passed, with allowed length warnings | Maintain checks through implementation |

## Evidence And Release Boundary

P-001 proves candidate feasibility on PGlite/PostgreSQL/MySQL/SQLite; unmodified
shared adapters fail isolation. P-004 passes 35 candidate assertions. P-002 passes
corrected HTTP/SSE mechanics but automatic permission escalation fails; the
accepted fallback is explicit native reapproval, with no permission widening.
P-003 native fixtures pass 12 checks per Codex/Claude client. The complete real
Stackpress sign-in/CSRF/factor/generated-store journey remains inconclusive until
implementation and is a mandatory release gate. These distinctions remain in
[proof results](proof-results.md); no failure or unrun check was changed to a pass.

All journey categories have a disposition, including denial, missing factor,
suspension, expiry, scope changes, races, interruption, retry and dependencies.
Specification behavior and the final technical choices are accepted at Freeze.
Research and Proofs: **Frozen**; P-003 production execution is explicitly deferred
to mandatory task 00012 after implementation, with no release waiver. External handoffs are
clear boundaries, not promises about every third-party client interface.

The user accepted legacy bindings, named app rules, protected-schema visibility,
explicit reapproval and post-implementation P-003 sequencing. No unresolved Freeze
blocker or pending question remains. Creating tasks is authorized by the same
instruction and does not require another confirmation. Implementation execution,
publication/deployment and task acceptance are not performed in this turn.

## Files And Preservation

Five focused contracts were added: [configuration](configuration.md),
[events](events.md), [storage](storage.md), [recovery](recovery.md), and
[journeys](journeys.md). The existing design, decisions, brief, research,
verification, proof ledger, question follow-up and index now route to them.
The spec manifest records Freeze and task creation. Exact user answers, all fifteen
source-app decision mappings, source copies, proof outputs and unrelated work
are preserved. The plain-language /bro style applies to the new text; precise
code names remain where developers need them.

Load the [earlier planning and proof status](../../references/00021-mcp-oauth-proof-pass-status.md)
only when tracing the prior draft/proof pass, its validations and then-open topics.
That Reference File is an exact preservation of the previous status; its open
contract statements are superseded by this owner's current status. Earlier exact
question history remains in the two question references linked by questions.md.

Three proof agents reviewed the new contracts independently. Their corrections
include transaction statement order, current exchange checks, bounded client
storage, source limits, named replay state, safe catalog projection, exact startup
call sites and truthful legacy verification requirements. They changed no files
in this pass. No production source, dependencies or executable proofs were changed;
runtime suites were not rerun for these document-only edits. Freeze promotes only
accepted stable direction, clearly separated from current shipped behavior.

## Validation And Next Step

`python3 .agents/scripts/validate-agent-workspace.py` reports warnings only;
all files stay within the 500-line maximum. Coherent documents above 200 lines
retain their full content. `git diff --check` passes. An explicit spec-file
whitespace/link-preservation check supplements Git because the user's existing
ignore rules exclude new agent files. No ignore or staging changes were made.

Recommended next step: work on task 00001 in the owning Inquire repository, then
follow task dependencies. If that checkout or corrected dependency is unavailable,
record the blocker; never bypass the ownership fix in production stores. This
turn froze the plan and created tasks, without starting implementation.

## Implementation Tracker

| Plan | Status | Task state | Acceptance mode |
| --- | --- | --- | --- |
| [Twelve-task build plan](tasks/sprint.md) | accepted | All open; 0 started, 0 verified, 0 accepted | Explicit user review for visual outputs; no delegated acceptance |

Update progress in tasks/status.md and the task notes. A task without visual
acceptance ends at verified; a browser/document/report task reaches accepted only
after the user reviews its verified output. No new Reference Files were required.
