# Spec 00032 — Let MCP Clients Log In By Themselves

Status: Frozen 2026-09-27 by explicit user instruction ("Freeze 🥶"), after three grill sessions, six research topics, Proofs P-001
and P-002 with real clients, and the journeys map.

## What This Spec Is About

Spec 00031 gave command-line tools and AI agents a way to log in: the tool
asks for a code, the person approves it in the browser, and the tool gets a
key. That works. But Claude Code and Codex do not run that flow on their
own. Today a person has to run our helper program, copy the key into the
client's settings by hand, and do it all again when the key runs out. A key
approved by an administrator runs out after fifteen minutes, so in practice
it is a fifteen-minute connection.

Claude Code, Codex, and similar programs (MCP clients) already know one
standard way to log in to a remote service. When the service says "you are
not logged in" and points to its instructions, the client opens the
browser, the person approves, and from then on the client keeps its key and
renews it by itself. Nobody copies anything.

This spec plans that way in for Resourcing:

1. The person gives their client only the Resourcing address.
2. The client reads our instructions and finds the approval page.
3. The person signs in as usual and ticks what the client may do.
4. The client receives a key and a renewal token and uses them by itself.
5. The key is the same limited key Spec 00031 already issues, so the
   Connected agents page, Disconnect, renewal, and the tools stay as they
   are.

## Read In This Order

1. [Brief](brief.md) — what the user asked for, what is in and out, who is
   involved.
2. [Decisions and gaps](decisions.md) — the answers we propose and the open
   questions that block Freeze.
3. [Research](research.md) — what must be read and tried before the open
   questions can be answered.
4. [Proofs](proofs.md) — the end-to-end experiment planned with the real
   clients.
5. [Status](status.md) — the freeze checklist and the next step.
6. [Questions](questions.md) — the grill-session ledger with exact
   questions and exact answers; load when resuming or reviewing answers.
7. [Journeys](journeys.md) — ten journeys with scope and feasibility marks,
   grounded in the proofs; load when planning tasks or acceptance.
8. [Implementation plan](tasks/sprint.md) and [task status](tasks/status.md)
   — proposed task order, verification, and acceptance; task files live
   beside them.

## What This Spec Does Not Change

- How people sign in. The sign-in pages and the two-factor step are reused.
- The shape of the key, the permissions, the renewal rules, and the
  Connected agents page from Spec 00031. See
  [API keys and agent access](../../context/agent-access.md#api-keys-and-agent-access--frozen-spec-00031-2026-09-24).
- The code-based login, the WorkOS-style login, and the `stackpress login`
  helper. They stay for tools that cannot open a browser.
- The key our server uses to talk to office-forms.

## Related Records

- [Spec 00031](../00031-agent-device-authorization/index.md) — the Frozen
  code-based login and the safety fixes this spec builds on. Load only to
  check a shared rule; do not edit it.
- [Agent access guide](../../../docs/agent-access.md) — the instructions
  people follow to connect and disconnect. This spec will change them.
