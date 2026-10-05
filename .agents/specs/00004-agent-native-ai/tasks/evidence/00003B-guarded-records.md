# Task 00003B evidence: generated edits of agent records are refused

**How this was produced: real requests against the real `templates/blog` app.**
The blog was built (`yarn blog generate`, `push`, `build`), seeded through the
agent store (`00003-seed-agent-actions.ts`), and started with `stackpress serve`
on `127.0.0.1:3411` with a temporary config that changed only the port (deleted
afterwards). The `agent` plugin was active, so its guards were registered.

The requests are made as the seeded admin, signed in through the real username
form with curl. The cookie jar is shown as `$COOKIES` and the page's anti-forgery
token as `$CSRF`; neither value is printed. The admin pages are the generated ones;
`json=1` asks them for JSON instead of the HTML view. `$TURN`, `$ACTION` and
`$THREAD` are ids of seeded rows. Run on 2026-10-05.

## What it shows

 - The admin list of agent actions still loads (A1, A2).
 - An admin edit of a stored turn is refused with 403 and the turn is unchanged
   (B1, B2).
 - An admin delete of a logged action is refused and the action is still there
   (C1, C2). So is an admin rewrite of it (D1, D2).
 - An admin cannot add a made-up action to the log either (E1, E2): only the store
   creates these rows.

### A1. The admin list of agent actions still loads
The generated list page reads through the unguarded search event. Expect 200 and the rows.
```
$ curl -b $COOKIES $BLOG/admin/agent-action/search   # then the page title and its row count
HTTP 200
<title>Search Agent Actions</title>
Showing 1 - 8 of 8
```
### A2. The same list as JSON (first row, three fields)
Expect 200 with a total. The row's claim token is not shown here.
```
$ curl -b $COOKIES '$BLOG/admin/agent-action/search?json&take=1'
HTTP200
{"code": 200, "status": "OK", "total": 8, "first": {"id": "0muuiaoju00019a2c822fcf0", "tool": "publish_article", "status": "done"}}
```
### B1. An admin edits a stored turn
The admin update page posts to the generated update event, which is guarded. Expect 403 and the package's message.
```
$ curl -i -b $COOKIES -X POST $BLOG/admin/agent-turn/update/$TURN -d csrf=$CSRF -d json=1 --data-urlencode 'text=EDITED BY ADMIN'
HTTP/1.1 403 Forbidden
Content-Type: application/json
Content-Length: 141

{"code":403,"status":"Forbidden","error":"Agent records can only be changed through the agent store.","errors":{"event":"agent-turn-update"}}
```
### B2. The turn is unchanged
Expect the original text.
```
$ curl -b $COOKIES '$BLOG/admin/agent-turn/detail/$TURN?json'
HTTP200
{"id": "0muuiaoju0000eedc3e98be9", "role": "assistant", "text": "Publishing the first article."}
```
### C1. An admin deletes a logged action
The admin remove page confirms with a GET carrying the flag and the token. Expect 403.
```
$ curl -i -b $COOKIES -G $BLOG/admin/agent-action/remove/$ACTION -d csrf=$CSRF -d json=1 -d confirmed=1
HTTP/1.1 403 Forbidden
Content-Type: application/json
Content-Length: 143

{"code":403,"status":"Forbidden","error":"Agent records can only be changed through the agent store.","errors":{"event":"agent-action-remove"}}
```
### C2. The action is still there
Total before: 8. Total after: 8.
```
$ curl -b $COOKIES '$BLOG/admin/agent-action/detail/$ACTION?json'
{"id": "0muuiaoju00019a2c822fcf0", "tool": "publish_article", "status": "done", "active": null}
```
### D1. An admin rewrites a logged action
Expect 403.
```
$ curl -i -b $COOKIES -X POST $BLOG/admin/agent-action/update/$ACTION -d csrf=$CSRF -d json=1 -d status=failed -d error=rewritten
HTTP/1.1 403 Forbidden
Content-Type: application/json
Content-Length: 143

{"code":403,"status":"Forbidden","error":"Agent records can only be changed through the agent store.","errors":{"event":"agent-action-update"}}
```
### D2. The action is unchanged

```
$ curl -b $COOKIES '$BLOG/admin/agent-action/detail/$ACTION?json'
{"status": "done", "error": null}
```
### E1. An admin adds a made-up action to the log
Only the store may create rows. Expect 403.
```
$ curl -i -b $COOKIES -X POST $BLOG/admin/agent-action/create -d csrf=$CSRF -d json=1 -d threadId=$THREAD -d turnId=$TURN -d profileId=x -d tool=made_up -d event=made-up -d irreversible=0
HTTP/1.1 403 Forbidden
Content-Type: application/json
Content-Length: 143

{"code":403,"status":"Forbidden","error":"Agent records can only be changed through the agent store.","errors":{"event":"agent-action-create"}}
```
### E2. The log did not grow

```
$ curl -b $COOKIES '$BLOG/admin/agent-action/search?json&take=1'   # total
Actions in the log after all of the above: 8 (before: 8)
```
