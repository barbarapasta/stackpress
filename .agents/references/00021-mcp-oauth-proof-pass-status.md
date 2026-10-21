# Where The Plan Stands

Spec: `00004-mcp-native-oauth`.
Status: Draft plan, 2026-09-28. Not Frozen or approved for implementation.
The user asked for a library plan, then authorized all proofs and parallel agents.
Prototype work is complete for this pass. Production implementation, publishing,
application database changes, and deployment have not started.

## What Is Done And What Is Open

| Item | Status | Next step |
| --- | --- | --- |
| Source app and repository rules | Read | Keep app decisions separate from approved library decisions |
| Which package owns keys | G-001 accepted: new records in session | Keep existing API records in place |
| Ordinary API support | G-002 accepted for the first release | Add API integration and shared-key tests |
| Allowed addresses for a shared key | G-007 mechanism proved: exact service plus saved operation membership | Finalize public fields and test generated production routes |
| Source decisions | All fifteen explained | Review where library settings differ from app-specific rules |
| Existing keys and callers | G-003 product choices accepted, including empty lists | Implement/test the preserved rules; prove mixed-tool OAuth under G-005 |
| Settings and app-supplied rules | G-006 partly answered: lifetimes, extra checks, and client policy | Research remaining settings, event contracts, and limits |
| Database support | G-004 feasibility proved on all four real databases | Implement Inquire connection ownership before production stores |
| MCP connection behavior | G-005 partly proved; HTTP/SSE candidate checks pass, automatic scope upgrades fail | Resolve client recovery contract and production integration |
| Research | Source and runtime evidence recorded in R-003/R-004/R-006 | Finish public contracts and browser integration design |
| Small technical tests | All four have executed evidence | See proof-results.md for passing candidates and explicit limits |
| People's paths through the feature | Both native clients pass 12 fixture checks each | Complete real Stackpress browser/account journey after implementation |
| Build order | Six stages proposed | Create tasks under tasks/ after the plan is Frozen |
| Shared project guidance | Not changed | Proposals are not yet accepted project facts |
| Document checks | See record below | Keep links, requirements, and saved source copies intact |

## Files Produced

The plan has ten files: index, brief, design, decisions, research, verification,
proofs, proof-results, status, and the grill-session questions. The spec list links to them. Four source documents were
copied exactly under resources; application code remains in its own repository.
The early question history now lives in two linked Reference Files. Each final
file is within the 500-line limit and keeps connected questions together.

The plain-language rewrite changes wording, not decisions. It retains the user
request, included/excluded work, all source decisions G-001 through G-015,
current package responsibilities, missing features, proposed settings/events/
models/routes/imports, security rules, upgrade choices, build stages, tests,
people's journeys, technical experiments, source versions/links, and next steps.
Exact code names remain where developers need them. Saved source copies and
existing accepted guidance/Frozen specs were not rewritten.

## What To Decide Next

G-001/G-002 are settled: new OAuth records belong to session, and the first
release supports the same approved key on MCP tools and ordinary API routes.
The read/write rule is also settled: keep IDs for reads and full keys for other
operations, for existing and new keys. Q-004 accepts any one matching permission
from a non-empty list. Q-005 keeps public/protected MCP tools at the same
address. Q-006 preserves empty-list behavior: API rejects; MCP accepts a valid
key of the correct type. Q-007 requires all four existing databases for the
first release. Q-008 sets new OAuth access keys to 15 minutes by default,
configurable. Q-009 sets renewal to 7 days from original approval, also
configurable. Q-010 lets apps choose when an extra two-factor check is needed.
Q-011 permits compatible clients to request approval by default, with an optional
allowed-client list. Q-012 requires apps to enable new keys explicitly for each
user API route; existing API key support stays in place.

Q-013 also accepts protected names/descriptions in anonymous tool lists;
execution stays protected. No user question is currently pending. Next settle
the remaining public contracts and client recovery behavior using the proof
findings. The full P-003 production journey remains a release requirement. Freeze the plan only when the important questions are answered or
explicitly deferred through the repository's spec workflow.

## Check Record

The original draft passed `python3 .agents/scripts/validate-agent-workspace.py`
with three existing line-count warnings in references 00010/00014 and the
spec-user-journeys workflow. It also passed `git diff --check`. All four saved
source files matched the originals exactly.

The plain-language rewrite also passed both checks. The validator now reports
four warnings: the three above and the design file at 220 lines. The design stays
in one file because its sections explain one connected feature; it is within
the allowed 500-line limit. Comparison with the earlier draft checked the
requirements, links, decision IDs, and test IDs. The four saved source documents
still match their originals exactly. No runtime tests were run for this
wording-only change.


## Grill Session

In progress at the user's request, with plain-language questions one at a time.
G-001/G-002/G-003 product choices are answered. G-004 feasibility is proved
on all four databases, with required Inquire changes identified. G-006 has configurable 15-minute access keys, 7-day renewal,
app-selected extra approval checks, and open client requests with an optional
allowed-client list. Q-010 does not weaken ordinary sign-in; Q-011 grants no
access without user approval.

Counts: 14 question records answered or resolved through follow-up, 0 awaiting
an answer. G-001/G-002/G-003 are accepted; G-004/G-007 mechanisms are supported
by proof evidence with implementation prerequisites. G-005/G-006 remain partly
open. No new gap IDs added; P-002 sharpened the existing compatibility gap.

Updated the questions, decisions, design, brief, and tests. The complete early
question records are moved into two linked Reference Files without summaries or
lost answers, keeping the active question file below the workspace limit.
Production library code and application databases remain unchanged. Executed
prototypes and disposable databases were used for the authorized proofs. The
plan remains Draft.
Q-012 is recorded in questions, decisions, design, brief, and verification/proof
requirements. The earlier bounded SDK source review was followed by executed
P-004 and native-client checks. Their separate results are in proof-results.md.
No new Reference Files were needed for this pass.
The new Q-013 answer is accepted and recorded. All four proofs now have execution
records. The grill pass and whole spec remain open because compatibility and
detailed contract work remain.

The latest grill update is checked with the workspace validator and
`git diff --check`. The earlier question-record split also passed a content
comparison. This update preserves that history and the user's exact answer.
Coherent files under 500 lines may produce length warnings. The earlier wording
updates needed no runtime tests; this authorized proof pass ran the recorded
prototype suites, strict transport TypeScript checks, and the narrow existing
STDIO regression. See proof-results.md for exact outcomes.


## Authorized Proof Pass

The user requested orchestration of all proofs and allowed parallel agents.
P-001 and P-004 establish candidate feasibility. P-002 establishes corrected
HTTP/SSE mechanics but records failing automatic permission escalation. P-003
passes native-client fixture checks while the complete production journey stays
unproved until the implementation exists. No failing requirement is waived.

Reports, runners, and sanitized JSON are under root proofs/. Three agents owned
separate proof directories; the coordinator ran native-client/browser checks,
reviewed findings, and reconciled the plan. Independent reviews caught and
corrected unknown-tool/control gaps and strengthened native tool-result checks.
All proof-created database containers and client credentials were cleaned up.

No production package suite or coverage claim is made from these prototypes.
Context promotion was reviewed and deliberately left spec-local while public
contracts and owning-library changes remain unsettled. No draft was Frozen.
Recommended next work: finalize the remaining contracts and client recovery
behavior, then prepare the Inquire prerequisite and Stackpress implementation.
