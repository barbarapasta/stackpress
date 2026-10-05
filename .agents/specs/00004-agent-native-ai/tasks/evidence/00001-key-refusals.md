# Task 00001 evidence: key verification against templates/blog

**How this was produced: against the real `templates/blog` app.** The blog was
started with `stackpress serve` on `127.0.0.1:3411` using a temporary config that
only changes the port (port 3000 was taken by an unrelated process on this
machine; the temporary config was deleted afterwards). The `mcp` config is the
template's own `common.mcp` in `stateful` mode. The database is the template's
PGlite store after `yarn blog generate` and `yarn blog push`.

Seeded application keys (created with `application-create`; scopes set with a SQL
update because the emit CLI cannot pass an array):

| Key id | Secret | Scopes | Expires |
| --- | --- | --- | --- |
| `evidence-reader` | `reader-secret` | `articles.read` | 2030-01-01 |
| `evidence-writer` | `writer-secret` | `articles.read`, `articles.write` | 2030-01-01 |
| `evidence-expired` | `expired-secret` | `articles.read` | 2020-01-01 |

Server time of the run: 2026-10-04T23:40:21Z. Each block shows the `curl` command, then
the response it got, apart from dropping the `Date`, `Connection` and `Keep-Alive`
headers and from one trim: the two `tools/list` bodies (9 to 11 KB of input schemas
each) are replaced by a line that lists the tool names found in the real response and
says how many bytes were cut.

Every request is `curl -i -X POST $MCP` with `-H 'Content-Type: application/json'`
and `-H 'Accept: application/json, text/event-stream'`, where
`MCP=http://127.0.0.1:3411/mcp` and `INIT` is the body
`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"evidence","version":"1.0.0"}}}`.
Each command shows only the headers and body that differ.

## A. A valid key lists and calls a tool

### A1. Initialize with a valid key
Expect 200 and an `mcp-session-id`.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer evidence-reader:reader-secret' -d "$INIT"
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/event-stream
mcp-session-id: 18af2d6a-a3c2-4abf-9f43-b24f9382a5ca
content-length: 228

event: message
data: {"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"Stackpress Blog MCP","version":"1.0.0","title":"Stackpress AI Server"}},"jsonrpc":"2.0","id":1}
```
### A2. Initialized notification
Expect 202.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer evidence-reader:reader-secret' -H 'mcp-session-id: 18af2d6a-a3c2-4abf-9f43-b24f9382a5ca' -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
HTTP/1.1 202 Accepted
content-type: text/plain; charset=UTF-8
Transfer-Encoding: chunked
```
### A3. tools/list as the reader
The reader holds only `articles.read`, so tools needing `articles.write` are absent.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer evidence-reader:reader-secret' -H 'mcp-session-id: 18af2d6a-a3c2-4abf-9f43-b24f9382a5ca' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/event-stream
mcp-session-id: 18af2d6a-a3c2-4abf-9f43-b24f9382a5ca
content-length: 8782

event: message
data: [trimmed: 8765 bytes of tool schemas removed] tools = ["article_search", "article_detail", "comment_search"]
```
### A4. tools/call article_search as the reader
Expect 200 with a tool result. The blog database is empty, so the result is an empty list.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer evidence-reader:reader-secret' -H 'mcp-session-id: 18af2d6a-a3c2-4abf-9f43-b24f9382a5ca' -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"article_search","arguments":{"limit":1}}}'
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/event-stream
mcp-session-id: 18af2d6a-a3c2-4abf-9f43-b24f9382a5ca
Transfer-Encoding: chunked

event: message
data: {"result":{"content":[{"type":"text","text":"[]"}]},"jsonrpc":"2.0","id":3}
```
## B. A tool the key lacks a scope for is a real 403
### B1. tools/call article_update as the reader (needs articles.write)
The tool is registered but absent from the reader's own list. Without the full-registry check the SDK would answer "tool not found" inside a 200, because the per-caller registry no longer holds this tool. It is a 403 before the transport runs.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer evidence-reader:reader-secret' -H 'mcp-session-id: 18af2d6a-a3c2-4abf-9f43-b24f9382a5ca' -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"article_update","arguments":{}}}'
HTTP/1.1 403 Forbidden
Content-Type: application/json
Content-Length: 100

{"jsonrpc":"2.0","error":{"code":-32002,"message":"Forbidden MCP tool call: article_update"},"id":4}
```
### B2. tools/call a name that is not registered
Not a scope problem, so it still reaches the SDK (200 with a tool error), proving the 403 is specific to registered tools.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer evidence-reader:reader-secret' -H 'mcp-session-id: 18af2d6a-a3c2-4abf-9f43-b24f9382a5ca' -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}'
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/event-stream
mcp-session-id: 18af2d6a-a3c2-4abf-9f43-b24f9382a5ca
content-length: 156

event: message
data: {"result":{"content":[{"type":"text","text":"MCP error -32602: Tool no_such_tool not found"}],"isError":true},"jsonrpc":"2.0","id":5}
```
## C. The same tool is visible to a key that holds the scope
### C1. Initialize as the writer
Expect 200 and a new session.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer evidence-writer:writer-secret' -d "$INIT"
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/event-stream
mcp-session-id: 458148b8-2a4c-4de2-a962-2a021e7470fe
content-length: 228

event: message
data: {"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"Stackpress Blog MCP","version":"1.0.0","title":"Stackpress AI Server"}},"jsonrpc":"2.0","id":1}
```
### C2. tools/list as the writer
Now the `articles.write` tools appear.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer evidence-writer:writer-secret' -H 'mcp-session-id: 458148b8-2a4c-4de2-a962-2a021e7470fe' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/event-stream
mcp-session-id: 458148b8-2a4c-4de2-a962-2a021e7470fe
content-length: 10959

event: message
data: [trimmed: 10942 bytes of tool schemas removed] tools = ["article_search", "article_create", "article_detail", "article_update", "comment_search"]
```
## D. Keys that fail verification are answered 401
### D1. Unknown key
Previously an unknown key was downgraded to a public caller (R-002; not re-run here).
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer nobody:whatever' -d "$INIT"
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
Content-Type: application/json
Content-Length: 76

{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":null}
```
### D2. Expired key (`expires` 2020-01-01)
Previously an expired key kept working (R-002; not re-run here).
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer evidence-expired:expired-secret' -d "$INIT"
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
Content-Type: application/json
Content-Length: 76

{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":null}
```
### D3. Wrong secret
The id is real but the secret does not match.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer evidence-reader:not-the-secret' -d "$INIT"
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
Content-Type: application/json
Content-Length: 76

{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":null}
```
### D4. Secretless key (id only)
Previously the secret was only checked for non-GET tools (R-002; not re-run here).
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer evidence-reader' -d "$INIT"
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
Content-Type: application/json
Content-Length: 76

{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":null}
```
### D5. Valid session id, key swapped for an unknown one
A session cannot be used with a key other than the one it was opened with.
```
$ curl -i -X POST $MCP -H 'Authorization: Bearer nobody:whatever' -H 'mcp-session-id: 18af2d6a-a3c2-4abf-9f43-b24f9382a5ca' -d '{"jsonrpc":"2.0","id":6,"method":"tools/list","params":{}}'
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
Content-Type: application/json
Content-Length: 76

{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":null}
```
## Not shown here

- A key that dies while a session is open (J-011 step 5) is covered by package
  tests that run the real HTTP and SSE transports
  (`packages/stackpress-ai/tests/live.test.ts`), not by this transcript. I
  did not try to deactivate a key while the blog server held its PGlite store open.
- The SSE transport is not enabled in the blog template's `mcp` config, so its
  refusals are evidenced by the package tests only.
