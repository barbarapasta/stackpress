# Decisions And Gaps

Status: Frozen 2026-09-27 by explicit user instruction ("Freeze 🥶"). G-001 to G-010 were found by reading the current login code
in `plugins/agent-auth/` at commit `80cb6c6` and comparing it with what a
client such as Claude Code sends. Grill session of 2026-09-27: G-001,
G-002, G-004, G-005, G-006, G-007, and G-009 accepted by the user; G-003 and
G-008 settled by reading code; G-010 accepted at opening. Research of the
same day confirmed every accepted answer, sharpened five of them (noted
under each), and added G-011 to G-014, which the user accepted in a second
grill session the same day. Proofs P-001 and P-002 were proved the same
day, and the journeys map added G-015, accepted in a third session. Every
Gap G-001 to G-015 is answered. Exact answers are in
[questions](questions.md).

A few words used below:

- **Key**: the value a client sends with every request to prove who it is.
  In Resourcing it is `id:secret`, the id of a Session row and its secret.
- **Approval page**: the page where a signed-in person ticks what a client
  may do and clicks Grant.
- **Return address**: where the browser sends the person back after
  approval, so the client can collect its one-time code.
- **Index files**: the two small files a client reads to learn where the
  approval page is and how to use it.

## What Already Exists

Before the questions, what the new login can reuse without change:

- The "not logged in" answer that points the client to the index files.
- The two index files themselves.
- The hardened approval page: it checks the return address, limits the
  permissions to what the person's role allows, and hands out a one-time
  code rather than the key itself.
- Turning that one-time code into a key, renewal with a fresh token each
  time, spotting a stolen renewal token, cancelling a key, the Connected
  agents page, and Disconnect.
- The tool server, which re-checks the key on every single call.

## G-001 — How Does A Client Prove Who It Is Without A Password?

Today, to turn a one-time code into a key, the caller must present the
password of a registered application. Claude Code and Codex have no
password and were never registered. Spec 00031 (G-007) refused to hand keys
to strangers; this is different, because letting a client introduce itself
hands out nothing until a person approves.

- Proposed answer: accept clients that have no password. Two ways for a
  client to introduce itself, both without a password. Preferred: the
  client's name is a web address that serves a small page describing the
  client. Fallback: the client sends a short description of itself and gets
  an id back. Such a client is trusted only because it proves it started
  the login (G-002). Limit how often strangers may introduce themselves,
  and forget introductions that are never approved.
- Status: accepted by the user 2026-09-27 ("Yes, both ways, web address
  preferred"). See [questions](questions.md) Q-001.
- Confirmed by research 2026-09-27: both clients use the web-address way
  when we say `client_id_metadata_document_supported: true` and allow
  `none` as the key-page method. Rules for fetching a client's page: only
  `https` with a path, the page must name the same address exactly, never
  follow redirects, never fetch private or local addresses in production,
  stop after 5 kilobytes, cache by web headers, never cache errors. The
  description-and-id way stores a row per stranger, so it gets the
  existing per-address limit and a short expiry until first approval.

## G-002 — Must The Client Prove It Started The Login?

Nothing in the code checks this today. The standard way: the client makes
up a secret at the start, sends a scrambled copy of it with the login
request, and shows the real secret when collecting the key. Anyone who
steals the one-time code on its own cannot use it.

- Proposed answer: require this on every login from a client without a
  password. Accept only the scrambled form (called S256); reject the plain
  form and reject a missing one.
- Status: accepted by the user 2026-09-27 ("Yes, required, scrambled form
  only"). See [questions](questions.md) Q-002.
- Confirmed by research: the index file must list `S256`, or clients
  refuse to log in at all. The one-time code row needs a column for the
  scrambled secret.

## G-003 — Which Page Is The Approval Page For Clients?

The approval page exists at `/auth/oauth`, but the index files do not name
it, so a client cannot find it. They also do not say that the "prove you
started it" step or the return code are supported.

- Proposed answer: name the existing page in the index files and teach it
  the extra fields a client sends: the kind of reply wanted, a value the
  client uses to match the reply to its request, the scrambled secret from
  G-002, and the address the key is meant for (G-006). One page for
  websites and clients alike. If the vendor's page gets in the way, add a
  separate page for clients and name that instead.
- Status: evidence-resolved 2026-09-27. Our copy of the page runs before
  the vendor's and stops it; the vendor's page ignores extra fields. See
  [questions](questions.md) Q-008.

## G-004 — Which Return Addresses Are Allowed?

Today the return address must exactly match one on the registered
application's list. A client on a laptop listens on the laptop itself, on a
port number that can change from run to run.

- Proposed answer: for clients without a password, accept the return
  addresses the client names when it introduces itself. For addresses on
  the laptop itself, match everything except the port number, which may
  vary; the standard for desktop apps allows this. Never send the browser
  to an address that fails the check.
- Status: accepted by the user 2026-09-27 ("Yes, any port on the
  machine's own address"). See [questions](questions.md) Q-003.
- Sharpened by research: the machine's own address must be accepted under
  all three spellings, `localhost`, `127.0.0.1`, and `[::1]`, because the
  rules prefer the numeric forms while both clients declare `localhost`
  too. Claude Code returns to `http://localhost:<port>/callback`; Codex to
  `http://127.0.0.1:<port>/callback`. Path stays exact; see G-011 for the
  one case where Codex changes it.

## G-005 — Which Field Holds The Key In The Reply?

When a key is issued, the reply puts only the Session id in the field
called `access_token` and the usable `id:secret` in a field called
`access_key`. A standard client reads `access_token` and sends that, so it
would be refused. The WorkOS-style login already puts `id:secret` in
`access_token`.

- Proposed answer: for the client login and its renewal, put `id:secret` in
  `access_token`. Keep `access_key` for our helper. Decide whether websites
  on the old login keep the vendor's meaning or move too.
- Status: accepted by the user 2026-09-27 and confirmed after a plain
  explanation ("Yes, it stands"). Clients get `id:secret` in
  `access_token`; websites keep the vendor meaning until the vendor fix
  lands, at which point everyone moves at once. See
  [questions](questions.md) Q-004 and Q-004a. (Clerical correction
  2026-09-27 after Freeze: this line had kept its pre-answer wording.)

## G-006 — Which Address Is The Key For, And Do We Check?

One index file says the key is for `/api`, but the tool server lives at
`/api/mcp`, and a standard client asks for a key "for `/api/mcp`". Today
nothing ties a key to any address.

- Proposed answer: say the key is for the tool server's address, publish
  the index file for that address, accept the "for which address" field
  on both the approval page and the key exchange, and write it on the
  Session. The tool server refuses a key issued for a different address.
  Decide whether the plain `/api` pages keep accepting the same key.
- Status: accepted by the user 2026-09-27 ("Tie it to /api/mcp; plain
  /api pages still accept it for now"). See [questions](questions.md)
  Q-005.
- Sharpened by research: the address is written exactly `<origin>/api/mcp`
  with no trailing slash. The index file for it is served at
  `/.well-known/oauth-protected-resource/api/mcp` as well as at the root,
  and the "not logged in" answer points at the address-specific one.
  Claude Code sends that value back and checks it matches the tool server;
  Codex sends nothing unless configured, so a missing value defaults to
  the tool server's address. The Session row needs a column for it. Keys
  from the other logins are covered by G-013.

## G-007 — Does The Administrator Limit Stay?

Spec 00031 (D-007) gives an administrator key fifteen minutes, renewable
for up to twenty-four hours. Automatic renewal removes the manual pain, but
the twenty-four-hour limit still means a new browser approval every day.

- Proposed answer: keep both lifetimes as they are. The limit was a safety
  decision, not an accident. Say in the guide that daily re-approval is
  expected for administrator keys.
- Status: accepted by the user 2026-09-27 ("Keep both limits as they
  are"). Spec 00031 D-007 is not reopened. See [questions](questions.md)
  Q-006.

## G-008 — How Does A Client Show Up In Connected Agents?

Spec 00031 gives each person one "Agent access" entry, created the first
time they approve something, and lists their keys under it. A client that
introduces itself brings its own name.

- Proposed answer: a key made by this login is listed under Connected
  agents with the client's own name and can be disconnected the same way.
  It sits under the person's existing "Agent access" entry; the client's
  introduction is recorded beside it, not as a new entry per person per
  client.
- Status: evidence-resolved 2026-09-27. The Connected agents list already
  shows every USER or ADMIN key with its client name and hides website
  keys. See [questions](questions.md) Q-009.

## G-009 — How Are Errors Shown?

The Spec 00031 rule is that every page a person sees is a normal page,
never a browser error. The standard says: if the return address is valid,
send the person back to it with an error code; if it is not valid, never
send them anywhere and show the error.

- Proposed answer: follow the standard. A bad client or bad return address
  shows a normal page with the error text. A person saying no, an unknown
  permission, or a server fault sends the person back to the client with
  the standard error code and the client's matching value.
- Status: accepted by the user 2026-09-27 ("Send them back with the
  standard error code"). No conflict with context; the "normal page" rule
  was about our own pages, not the client's return address. See
  [questions](questions.md) Q-007.

## G-010 — What Is Shared With Spec 00031 And What Must Not Move?

- Shared and unchanged: the key shape, permissions and their per-role
  limits, lifetimes, renewal and stolen-token detection, cancelling,
  Connected agents, Disconnect, the three tools, the tool server's
  per-call check, and secrets stored scrambled.
- Unchanged ways in: the code-based login, the WorkOS-style login, and the
  helper.
- Changed here: the index files, what the approval page accepts, the key
  exchange for clients without a password, the reply field, tying a key to
  an address, and the agent access guide.
- Status: accepted as the working boundary at opening. Any change to a
  Frozen Spec 00031 file will be written down as a reopen request first.

## G-011 — Should Resourcing Name Itself On Every Redirect Back?

New from research. The rules allow the server to add an `iss` field naming
the login service on every redirect back to the client, and to say so in
the index file. When a server does not say so, Codex adds a random id to
its return address path to protect itself, which would fail our
exact-path check under G-004.

- Proposed answer: yes. Add the `iss` field to every redirect back,
  success or error, and say so in the index file. Then both clients use a
  plain `/callback` path and the exact-path rule holds.
- Status: accepted by the user 2026-09-27 ("Yes"). See
  [questions](questions.md) Q-010.

## G-012 — What Must The Approval Page Show About The Client?

New from research. The rules say the approval page must clearly show the
host of the client's return address, and should warn when a client's only
return addresses are on the person's own machine. Today the page shows the
application's name only.

- Proposed answer: show the client's declared name, the web address it
  introduced itself with (its host at least), and the return address host.
  When the return address is on the person's own machine, say in plain
  words that the key will be sent to a program running on this computer.
- Status: accepted by the user 2026-09-27 ("Yes, all three plus the
  note"). Exact wording goes to the user journeys map. See
  [questions](questions.md) Q-011.

## G-013 — Do Keys From The Other Logins Get The Address Too?

New from research. Once the tool server refuses a key issued for another
address (G-006), keys from the code-based login, the WorkOS-style login,
and the website login have no address written on them and would be
refused too, unless the tool server treats "no address" as acceptable.

- Proposed answer: write the tool server's address on every key issued by
  the code-based and WorkOS-style logins as well, since those keys exist
  for the tool server. Website keys get no address and are not accepted by
  the tool server, which matches today's behaviour. During rollout, keys
  issued before the change keep working until they expire.
- Status: accepted by the user 2026-09-27 ("Yes"). Adds a value to keys
  from the Spec 00031 logins without changing any Spec 00031 rule, so
  Spec 00031 is not reopened. See [questions](questions.md) Q-012.

## G-014 — Which Permissions Are Named In The "Not Logged In" Answer?

New from research. Clients take the permissions named in the "not logged
in" answer as the truth, else the list in the index file, else ask for
none. Claude Code adds `offline_access` if we list it, which we must not.

- Proposed answer: the "not logged in" answer names the three read
  permissions of Spec 00031; the index file lists the same three; nothing
  lists `offline_access`. The approval page still trims to what the
  person's role allows, and the reply says what was granted. When a tool
  call lacks a permission, answer 403 with `insufficient_scope` and the
  permission needed, so the client can ask for more.
- Status: accepted by the user 2026-09-27 ("Yes to all three"). See
  [questions](questions.md) Q-013.

## G-015 — Does The Client Approval Page Ask The Administrator For A Fresh Two-Factor Code?

New from the journeys map (J-002). Spec 00031 (G-008, D-003) makes every
administrator approval an administrator key that needs a fresh two-factor
code on the confirm page, and offers only a user-key approval when no
verified factor exists. The proof's approval page skipped this step as a
shortcut.

- Proposed answer: yes, inherit the rule as it is. The client approval page
  asks the administrator for a fresh code before Allow, and offers a
  user-key approval only when no verified factor exists. No new rule; the
  same check the device confirm page already uses.
- Status: accepted by the user 2026-09-27 ("Yes, inherit the rule as it
  is"). See [questions](questions.md) Q-014.
