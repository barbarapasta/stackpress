# Task 00006 Evidence: A Chat Session Against The Blog

Recorded 2026-10-05 against `templates/blog` served in production mode on port
3466 (a temporary config, since removed), with no provider key set, so the agent
answered with the blog's offline model (`plugins/app/agent.ts`). Nothing below
was written by hand: a script signed in through the real sign-in form
(`developer`, with the form's own anti-forgery token), made each request in order
over HTTP, and printed what came back. The recording script lives outside the
repository (`/tmp`). Cuts are marked with `…`; no session token is shown, and the
anti-forgery token is replaced with `<csrf-token>`. Times on streamed lines are
milliseconds from the request. The offline model answers instantly, so all events
of a step land within about a millisecond; the spread over time is covered by the
package tests, which delay the model.

The sample model identifiers in the blog config were changed after this recording, from
`claude-sonnet-5-5` and `openai/gpt-4o-mini` to `claude-opus-5-5` and `openai/gpt-6.1-sol`;
the session ran on the offline model, so its output is unaffected (the model names shown in
the responses are the old ones, as recorded).

The message names an article and a comment. The offline model first calls
`article_publish` (reversible), says so, then calls `comment_delete`
(irreversible), which pauses for approval.

(article pokemon is DRAFT before the session)

### Start: token, models, allowance

```
GET /agent/start
-> 200 application/json
{"code":200,"status":"OK","results":{"ok":true,"models":[{"provider":"anthropic","model":"claude-sonnet-5-5","title":"Claude Sonnet 5.5"},{"provider":"openrouter","model":"openai/gpt-4o-mini","title":"GPT-4o mini"}],"model":"claude-sonnet-5-5","usage":{"used":0,"limit":200000,"remaining":200000,"resetsAt":"2026-10-06T00:00:00.000Z"},"csrf":{"name":"csrf","token":"<csrf-token>"}},"total":1}
```

### 1. Send a message, streamed

```
POST /agent/turn    Accept: text/event-stream
{"csrf":"<csrf-token>","message":"Publish pokemon and delete comment kr2wnbgx20meiqp7lhqxnanh","context":{"url":"/articles/pokemon","items":[{"type":"article","id":"pokemon"}]}}
-> 200 text/event-stream
+ 210ms data: {"type":"thread","threadId":"tin0zwmu2kvluz6grjgjlarb","title":"Publish pokemon and delete comment kr2wnbgx20meiqp7lhqxnanh"}
+ 210ms data: {"type":"usage","input":20,"output":10}
+ 210ms data: {"type":"action-start","actionId":"0muulmg4l0000d26b31cbf2a","tool":"article_publish","input":{"id":"pokemon"}}
+ 210ms data: {"type":"action-done","actionId":"0muulmg4l0000d26b31cbf2a","tool":"article_publish","input":{"id":"pokemon"},"result":{"id":"pokemon","profileId":"developer","title":"Pokémon turns 30 — how the fictional pocket monsters shaped science","slug":"pokemon-turns-30-how-the-fictional-pocket-monsters-shaped-science","banner":"ht …
+ 210ms data: {"type":"text","text":"Published pokemon. Now I will delete comment kr2wnbgx20meiqp7lhqxnanh."}
+ 210ms data: {"type":"usage","input":20,"output":10}
+ 210ms data: {"type":"action-waiting","actionId":"0muulmg6k000082becbb4827","tool":"comment_delete","input":{"id":"kr2wnbgx20meiqp7lhqxnanh"},"expires":"2026-10-05T02:26:24.000Z"}
+ 210ms data: {"type":"finished","status":"waiting"}
```

(article pokemon is PUBLISHED after the first reply, before approval)

### 2. The thread while it waits for approval

```
GET /agent/threads/tin0zwmu2kvluz6grjgjlarb
-> 200 application/json
{"code":200,"status":"OK","results":{"thread":"tin0zwmu2kvluz6grjgjlarb","turns":["user: Publish pokemon and delete comment kr2wnbgx20meiqp7lhqxnanh","assistant: (tool call)","assistant: Published pokemon. Now I will delete comment kr2wnbgx20meiqp7lhqxnanh."],"actions":[{"id":"0muulmg4l0000d26b31cbf2a","tool":"article_publish","status":"done","undoable":true,"reverses":null},{"id":"0muulmg6k000082becbb4827","tool":"comment_delete","status":"pending","undoable":false,"reverses":null}]},"total":1}
```

### 3. Approve the waiting action, streamed

```
POST /agent/actions/0muulmg6k000082becbb4827/approve    Accept: text/event-stream
{"csrf":"<csrf-token>"}
-> 200 text/event-stream
+ 104ms data: {"type":"action-start","actionId":"0muulmg6k000082becbb4827","tool":"comment_delete","input":{"id":"kr2wnbgx20meiqp7lhqxnanh"}}
+ 104ms data: {"type":"action-done","actionId":"0muulmg6k000082becbb4827","tool":"comment_delete","input":{"id":"kr2wnbgx20meiqp7lhqxnanh"},"result":{"id":"kr2wnbgx20meiqp7lhqxnanh","articleId":"minecraft","profileId":"developer","comment":"Looking forward to the next 15 years of Minecraft!","active":false,"created":"2026-10-05T01:56:19 …
+ 104ms data: {"type":"text","text":"All done. The article is published and the comment is gone."}
+ 104ms data: {"type":"usage","input":20,"output":10}
+ 104ms data: {"type":"finished","status":"done"}
```

### 4. A repeated approval runs nothing

```
POST /agent/actions/0muulmg6k000082becbb4827/approve
{"csrf":"<csrf-token>"}
-> 200 application/json
{"code":200,"status":"OK","results":{"ok":true,"threadId":"tin0zwmu2kvluz6grjgjlarb","status":"settled","events":[{"type":"finished","status":"settled"}],"action":{"id":"0muulmg6k000082becbb4827","threadId":"tin0zwmu2kvluz6grjgjlarb","turnId":"0muulmg6200000ee7fc204a6","profileId":"developer","tool":"comment_delete","event":"comment-remove","input":{"id":"kr2wnbgx20meiqp7lhqxnanh"},"status":"done","result":{"id":"kr2wnbgx20meiqp7lhqxnanh","active":false,"comment":"Looking forward to the next 15 years of Minecraft!","created":"2026-10-05T01:56:19.000Z","updated":"2026-10-05T01:56:19.000Z","articleId":"minecraft","profileId":"developer"},"error":null,"operation":null,"reverses":null,"irreversible":true,"expires":"2026-10-05T02:26:24.000Z","created":"2026-10-05T01:56:24.000Z","updated":"2026-10-05T01:56:24.904Z"},"replayed":true},"total":1}
```

### 5. Undo the publish

```
POST /agent/actions/0muulmg4l0000d26b31cbf2a/undo
{"csrf":"<csrf-token>"}
-> 200 application/json
{"code":200,"status":"OK","results":{"ok":true,"threadId":"tin0zwmu2kvluz6grjgjlarb","status":"undone","events":[{"type":"action-start","actionId":"0muulmgcd0000260433df94a","tool":"article_unpublish","input":{"id":"pokemon"}},{"type":"action-done","actionId":"0muulmgcd0000260433df94a","tool":"article_unpublish","input":{"id":"pokemon"},"result":{"id":"pokemon","profileId":"developer","title":"Pokémon turns 30 — how the fictional pocket monsters shaped science","slug":"pokemon-turns-30-how-the-fictional-pocket-monsters-shaped-science","banner":"https://g.foolcdn.com/editorial/images/598665/pokemon-go.jpg","contents":"<p>On 27 February 1996, Japanese game designer Satoshi Tajiri \n        released the first ever Pokémon games for the Nintendo Game Boy. What \n        started as a childhood passion for collecting insects grew into a giant \n        franchise and global phenomenon with them …
```

(article pokemon is DRAFT after the undo)

### 6. The thread after approval and undo

```
GET /agent/threads/tin0zwmu2kvluz6grjgjlarb
-> 200 application/json
{"code":200,"status":"OK","results":{"thread":"tin0zwmu2kvluz6grjgjlarb","turns":["user: Publish pokemon and delete comment kr2wnbgx20meiqp7lhqxnanh","assistant: (tool call)","assistant: Published pokemon. Now I will delete comment kr2wnbgx20meiqp7lhqxnanh.","assistant: All done. The article is published and the comment is gone."],"actions":[{"id":"0muulmg4l0000d26b31cbf2a","tool":"article_publish","status":"undone","undoable":false,"reverses":null},{"id":"0muulmg6k000082becbb4827","tool":"comment_delete","status":"done","undoable":false,"reverses":null},{"id":"0muulmgcd0000260433df94a","tool":"article_unpublish","status":"done","undoable":false,"reverses":"0muulmg4l0000d26b31cbf2a"}]},"total":1}
```

### 7. History

```
GET /agent/threads
-> 200 application/json
{"code":200,"status":"OK","results":{"ok":true,"threads":[{"id":"tin0zwmu2kvluz6grjgjlarb","profileId":"developer","title":"Publish pokemon and delete comment kr2wnbgx20meiqp7lhqxnanh","model":"claude-sonnet-5-5","active":true,"created":"2026-10-05T01:56:24.000Z","updated":"2026-10-05T01:56:24.000Z"}]},"total":1}
```

### 8. A write with a wrong anti-forgery token

```
POST /agent/turn
{"csrf":"x","message":"hi"}
-> 403 application/json
{"code":403,"status":"Forbidden","error":"This request could not be verified. Reload the panel and try again.","errors":{"reason":"csrf"}}
```

What it shows: the reply streams in order (steps 1 and 3); the reversible tool ran
at once and the irreversible one paused with nothing deleted (step 1, the status
line after it); approval ran it once and resumed the reply (step 3), and a repeated
approval ran nothing (step 4); undo ran the inverse and linked the two actions
(steps 5 and 6, with `reverses`); a wrong token is refused (step 8). The undo moves
the article back to a draft, which is where this session started it.
