# Task 00001B evidence: a valid key that sees no tools

**How this was produced: real requests against the real `templates/blog` app.**
The blog was built (`yarn blog generate`, `push`, `build`) and started with
`stackpress serve` on `127.0.0.1:3411`, using a temporary config copied from
`config/production.ts`. The temporary config changed only the port (3000 is held
by another session) and the `mcp.tools` list: every tool, including the one the
blog contributes, was marked `type: 'app'` with the scope `articles.write`. The
blog's own config has a public tool, which every caller always sees, so without
this change no key could see an empty list there. The config was deleted
afterwards. The `mcp` transport is the template's own, in `stateful` mode.

The key is an application with the single scope `unrelated.scope`, so it is valid
(active, not expired, right secret) and matches no tool. It was created with
`application-create` through the blog's own bootstrap. Its id and secret are not
shown: the commands use `$NARROW_KEY` and `$NARROW_ID`, and the session ids that
the server issued appear as `$SESSION`. Every request is `curl -i -X POST $MCP`
with `-H 'Content-Type: application/json'` and
`-H 'Accept: application/json, text/event-stream'`, where
`MCP=http://127.0.0.1:3411/mcp` and `INIT` is
`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"evidence","version":"1.0.0"}}}`.
The `Date`, `Connection` and `Keep-Alive` headers are dropped. Run on 2026-10-05.

Before this change, A1 answered 500 "Resolved MCP tool registry is empty." (this is
what the task describes; it was not re-run on the old code).

## What it shows

 - A valid key with no matching scope connects (A1, A2) and `tools/list` returns an
   empty list, not an error (A3).
 - It is still refused a call to a tool it lacks the scope for (A4), and a wrong
   secret is still refused (B1).
 - A caller with no key connects and sees an empty list too (C1, C2).

### A1. Initialize with a valid key that no tool accepts
Expect 200 and an session id, not a 500.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer $NARROW_KEY' -d "$INIT"
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/event-stream
mcp-session-id: $SESSION
content-length: 228

event: message
data: {"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"Stackpress Blog MCP","version":"1.0.0","title":"Stackpress AI Server"}},"jsonrpc":"2.0","id":1}
```
### A2. Initialized notification
Expect 202.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer $NARROW_KEY' -H 'mcp-session-id: $SESSION' -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
HTTP/1.1 202 Accepted
content-type: text/plain; charset=UTF-8
Transfer-Encoding: chunked
```
### A3. tools/list
Expect 200 and an empty `tools` array, not an error.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer $NARROW_KEY' -H 'mcp-session-id: $SESSION' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/event-stream
mcp-session-id: $SESSION
content-length: 69

event: message
data: {"result":{"tools":[]},"jsonrpc":"2.0","id":2}
```
### A4. Call a tool the key lacks the scope for
Still refused: seeing nothing does not grant anything. Expect 403.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer $NARROW_KEY' -H 'mcp-session-id: $SESSION' -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"article_search","arguments":{}}}'
HTTP/1.1 403 Forbidden
Content-Type: application/json
Content-Length: 100

{"jsonrpc":"2.0","error":{"code":-32002,"message":"Forbidden MCP tool call: article_search"},"id":3}
```
### B1. A wrong secret is still refused
Expect 401 with `WWW-Authenticate: Bearer`.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer $NARROW_ID:wrong' -d "$INIT"
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
Content-Type: application/json
Content-Length: 76

{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":null}
```
### C1. Initialize with no key (a public caller)
Every tool needs a scope here, so a public caller sees nothing either. Expect 200.
```
$ curl -i -X POST $MCP -d "$INIT"
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/event-stream
mcp-session-id: $SESSION
content-length: 228

event: message
data: {"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"Stackpress Blog MCP","version":"1.0.0","title":"Stackpress AI Server"}},"jsonrpc":"2.0","id":1}
```
### C2. tools/list with no key
Expect 200 and an empty `tools` array.
```
$ curl -i -X POST $MCP -H 'mcp-session-id: $SESSION' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/event-stream
mcp-session-id: $SESSION
content-length: 69

event: message
data: {"result":{"tools":[]},"jsonrpc":"2.0","id":2}
```
