# Brief

Status: Frozen 2026-09-27 by explicit user instruction ("Freeze 🥶").

## What The User Asked For

On 2026-09-27, after Spec 00031 was closed out, the user asked "How do we
solve manual-renewal limitation?", confirmed the direction "Native MCP OAuth
+ PKCE for Claude Code, Codex, and other standard MCP clients", asked "Are we
ready for this specification?", and answered the readiness report with "Go."

Earlier in the same conversation the user chose to finish Spec 00031 first
("I want first to finish this specification before proceeding to MCP-native
OAuth Authorization Code + PKCE"), asked which approach is the best standard
when connected with Spec 00031, and accepted that the standard client login
is the main way in while Spec 00031 stays as the way in for tools and agents
that cannot open a browser.

## What We Will Build

- **A standard login for MCP clients.** A client that Resourcing has never
  heard of can find the approval page, send the person there, and collect a
  key afterwards. The client proves it is the same program that started the
  login by showing a secret it made up at the start. No password for the
  client is needed.
- **Instructions a client can follow by itself.** Resourcing already
  answers "not logged in" with a pointer to two small index files. Those
  files will be completed so a client can find the approval page, learn
  how to introduce itself, and learn which address the key is meant for.
- **The same key as Spec 00031.** The key, the renewal token, the
  permissions, the lifetimes per role, the Connected agents list, and
  Disconnect are reused. The client renews on its own using the renewal
  we already have.
- **A reply the client understands.** The key comes back in the field the
  client expects to find it in.
- **A test with the real clients.** The proof that this works is the real
  Claude Code command adding Resourcing by address, the person approving in
  the browser, a tool call working, the key renewing with no help,
  Disconnect, and the next call being refused.
- **Updated instructions** in the agent access guide.

## What We Will Not Build

- A new sign-in, a sealed-token key, or an outside login service such as
  WorkOS AuthKit. Resourcing issues its own keys, as Spec 00031 decided
  (D-002).
- Removal of the code-based login, the WorkOS-style login, or the helper.
- A helper script that feeds keys to Claude Code, or a local go-between
  program. Both were considered as workarounds and are not the product.
- Changes to what each permission may read. The three read-only
  permissions and tools of Spec 00031 are the first release here too.
- The Spec 00031 operator steps: sending the Stackpress fixes upstream,
  updating existing databases, and re-issuing old keys. They gate
  production, not this spec.

## Who Is Involved

- **Employee (USER):** approves a client that may do only what they can do.
- **Administrator (ADMIN):** may approve the same, plus an administrator
  key with the two-factor check and the shorter life from Spec 00031.
- **MCP client:** Claude Code, Codex, or another program that follows the
  standard client login. Never registered in advance.
- **Website (existing):** a registered site using the old approval page.
  Keeps working unchanged.

## Where The Facts Came From

- The readiness review of 2026-09-27 of the login code in
  `plugins/agent-auth/` at commit `80cb6c6`: what exists, and the gaps
  between it and what a client sends. Recorded in [decisions](decisions.md).
- The Spec 00031 rules promoted to
  [architecture-and-access.md](../../context/agent-access.md#api-keys-and-agent-access--frozen-spec-00031-2026-09-24).
- The user's own test on the Spec 00031 preview: an administrator key ran
  out after fifteen minutes before the client was set up, because Claude
  Code's fixed setting never asks for a renewal.
- Online sources are queued in [research](research.md) and are not yet
  treated as facts.

## When This Is Done

A person runs one command that names only the Resourcing address, is sent
to the browser, signs in, ticks permissions, and comes back to a working
client. The client uses the tools its permissions allow, renews the key by
itself after it runs out, and after Disconnect the next call is refused.
The old website login, the code-based login, and the helper still work.
