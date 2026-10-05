# Task 00002 evidence: a plugin-contributed tool in templates/blog

**How this was produced: against the real `templates/blog` app.** The blog was
started with `stackpress serve` on `127.0.0.1:3412` through a temporary config
(`config/zz-evidence-00002.ts`) that imports `config/production.ts` and changes
only the port, because port 3000 is taken by an unrelated process on this
machine. The temporary config was deleted afterwards. The `mcp` config is the
template's own `common.mcp`, `stateful` mode. The database is the template's
PGlite store after `yarn blog generate` and `yarn blog push`.

The tool comes from `templates/blog/plugins/app/plugin.ts`: an `ai-tools`
listener calls `contributeTool(ctx, siteInfoTool)`. Nothing in
`templates/blog/config/` names it. The caller is public, so no key is sent.

Each block shows the `curl` command and the response it got, apart from
dropping the `Date`, `Connection` and `Keep-Alive` headers and one trim: the
`tools/list` body (8,992 bytes of input schemas) is cut after the contributed
tool's entry, which is verbatim, and says so. The full response lists
`["blog_site_info", "article_search", "article_detail", "comment_search"]`.

Every request is `curl -si -X POST $MCP` with `-H 'Content-Type: application/json'`
and `-H 'Accept: application/json, text/event-stream'`, where
`MCP=http://127.0.0.1:3412/mcp` and `INIT` is the body
`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"evidence","version":"1.0.0"}}}`.
Each command shows only the headers and body that differ. `$SID` is the
`mcp-session-id` returned by the first response.

## A. Open a session
### A1. Initialize
```
$ curl -si -X POST $MCP -d "$INIT"
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/event-stream
mcp-session-id: 8ed76e56-55d6-4ff1-ad84-efa85dfbe155
content-length: 228

event: message
data: {"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"Stackpress Blog MCP","version":"1.0.0","title":"Stackpress AI Server"}},"jsonrpc":"2.0","id":1}
```
### A2. Initialized notification
```
$ curl -si -X POST $MCP -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
HTTP/1.1 202 Accepted
content-type: text/plain; charset=UTF-8
Transfer-Encoding: chunked
```

## B. tools/list shows the contributed tool
`blog_site_info` is first in the list, ahead of the three public tools this
caller can already see from the config and the generated client.
```
$ curl -si -X POST $MCP -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/event-stream
mcp-session-id: 8ed76e56-55d6-4ff1-ad84-efa85dfbe155
content-length: 8992

event: message
data: {"result":{"tools":[{"name":"blog_site_info","title":"Blog Site Info","description":"Returns the blog name and who the tool call came from.","inputSchema":{"type":"object","properties":{}},"execution":{"taskSupport":"forbidden"}},...3 more tools...]},"jsonrpc":"2.0","id":2}
```
[trimmed: the other three tools' entries removed from the 8,992-byte body; names found in the real response: ["blog_site_info", "article_search", "article_detail", "comment_search"]]

## C. tools/call reaches the plugin's event with the caller record
The event reads `caller(req)` and returns its `kind`. `public` shows that the
record was recorded by the shared execution path and read back by the event,
which lives in the template, outside the package.
```
$ curl -si -X POST $MCP -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"blog_site_info","arguments":{}}}'
HTTP/1.1 200 OK
cache-control: no-cache
content-type: text/event-stream
mcp-session-id: 8ed76e56-55d6-4ff1-ad84-efa85dfbe155
Transfer-Encoding: chunked

event: message
data: {"result":{"content":[{"type":"text","text":"{\n  \"name\": \"Stackpress Blog MCP\",\n  \"caller\": \"public\"\n}"}]},"jsonrpc":"2.0","id":3}
```

## D. `mcp.tools` has no entry for it
The template's own config, loaded as the server loads it, run from
`templates/blog`:
```
mcp.tools entries (name, event):
  article_search | article-search
  article_create | article-create
  (no name) | article-detail-tool
  (no name) | article-update-tool
  (no name) | comment-search-tool
  (no name) | comment-create-tool
any entry named blog_site_info: false
any entry with event app-site-info: false
```
And a search of every config file for the tool name and its event:
```
$ grep -rn "blog_site_info\|app-site-info" config/
exit code: 1
```
Exit code 1 from `grep` means no match. The two `article_*` entries with a name
are config tools, and the four without one are plugin-mode entries that resolve
through the generated client. None of them is `blog_site_info`.
