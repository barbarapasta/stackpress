# Task 00010A Evidence: An Inverse Told What It Is Undoing

Recorded 2026-10-05 against `templates/blog` in production mode on port 3472 (temporary config,
removed), no provider key, so the blog's offline model answered. A script signed in through the real
form as `developer` and made each request over HTTP. Its output is below, with the anti-forgery token
as `<csrf-token>` and no session token. Fields are selected from each response and re-indented;
values are as returned. The blog's `article_unpublish` cannot show the record, because `article-update`
returns the updated article and not the earlier status, so steps 1-5 use the new sample pair
`sample_receipt_issue` / `sample_receipt_void` (`plugins/app/agent.ts`, `plugin.ts`). Step 7 is the
unchanged inverse.

Sign-in through the form: 302 (a session cookie was set: true)

### 1. Send a message that issues a receipt

```
POST /agent/turn
{"csrf":"<csrf-token>","message":"Issue a receipt for pokemon"}
-> 200 application/json
```
Events of the turn (the `action-done` event and the final status):
```json
{
  "status": "done",
  "action-done": {
    "type": "action-done",
    "actionId": "0muutznk3000003319aed1b7",
    "tool": "sample_receipt_issue",
    "input": {
      "article": "pokemon"
    },
    "result": {
      "receipt": "R-9799a6a4",
      "article": "pokemon",
      "operation": "issue-bf9840d2-f8d0-46ec-a091-0f865a813f1b"
    },
    "operation": "issue-bf9840d2-f8d0-46ec-a091-0f865a813f1b",
    "undoable": true
  }
}
```

### 2. The thread: the issue is done and can be undone

```
GET /agent/threads/xapyhxm5krxrzta9ftbahen3
-> 200 application/json
```
```json
[
  {
    "id": "0muutznk3000003319aed1b7",
    "tool": "sample_receipt_issue",
    "status": "done",
    "undoable": true,
    "reverses": null,
    "operation": "issue-bf9840d2-f8d0-46ec-a091-0f865a813f1b"
  }
]
```

### 3. Undo it

```
POST /agent/actions/0muutznk3000003319aed1b7/undo
{"csrf":"<csrf-token>"}
-> 200 application/json
```
The response, in the order it came. The `action-done` of the inverse carries what the inverse event reported (its `told` is `undoing(req)`):
```json
{
  "status": "undone",
  "events": [
    {"type":"action-start","actionId":"0muutznnp00006b6a9263306","tool":"sample_receipt_void","input":{"article":"pokemon"}},
    {
      "type": "action-done",
      "actionId": "0muutznnp00006b6a9263306",
      "tool": "sample_receipt_void",
      "input": {
        "article": "pokemon"
      },
      "result": {
        "voided": "R-9799a6a4",
        "operation": "void-0muutznnp00006b6a9263306",
        "told": {
          "undoActionId": "0muutznnp00006b6a9263306",
          "original": {"id":"0muutznk3000003319aed1b7","tool":"sample_receipt_issue","input":{"article":"pokemon"},"result":{"article":"pokemon","receipt":"R-9799a6a4","operation":"issue-bf9840d2-f8d0-46ec-a091-0f865a813f1b"},"operation":"issue-bf9840d2-f8d0-46ec-a091-0f865a813f1b"}
        }
      },
      "operation": "void-0muutznnp00006b6a9263306",
      "undoable": false
    },
    {"type":"action-undone","actionId":"0muutznk3000003319aed1b7","tool":"sample_receipt_issue","undoActionId":"0muutznnp00006b6a9263306"},
    {"type":"finished","status":"done"}
  ],
  "action": {
    "id": "0muutznk3000003319aed1b7",
    "tool": "sample_receipt_issue",
    "status": "undone",
    "reverses": null,
    "operation": "issue-bf9840d2-f8d0-46ec-a091-0f865a813f1b"
  },
  "undo": {
    "id": "0muutznnp00006b6a9263306",
    "tool": "sample_receipt_void",
    "status": "done",
    "reverses": "0muutznk3000003319aed1b7",
    "operation": "void-0muutznnp00006b6a9263306"
  }
}
```

### 4. The thread after the undo

```
GET /agent/threads/xapyhxm5krxrzta9ftbahen3
-> 200 application/json
```
```json
[
  {
    "id": "0muutznk3000003319aed1b7",
    "tool": "sample_receipt_issue",
    "status": "undone",
    "undoable": false,
    "reverses": null,
    "operation": "issue-bf9840d2-f8d0-46ec-a091-0f865a813f1b"
  },
  {
    "id": "0muutznnp00006b6a9263306",
    "tool": "sample_receipt_void",
    "status": "done",
    "undoable": false,
    "reverses": "0muutznk3000003319aed1b7",
    "operation": "void-0muutznnp00006b6a9263306"
  }
]
```

### 5. A second Undo runs nothing

```
POST /agent/actions/0muutznk3000003319aed1b7/undo
{"csrf":"<csrf-token>"}
-> 200 application/json
```
```json
{
  "status": "settled",
  "events": [
    {"type":"finished","status":"settled"}
  ]
}
```

### 6. Publish an article: its inverse ignores the record

```
POST /agent/turn
{"csrf":"<csrf-token>","message":"Publish pokemon"}
-> 200 application/json
```

### 7. Undo the publish

```
POST /agent/actions/0muutznrt0000244f9889167/undo
{"csrf":"<csrf-token>"}
-> 200 application/json
```
```json
{
  "published": {
    "tool": "article_publish",
    "input": {
      "id": "pokemon"
    },
    "result.status": "PUBLISHED"
  },
  "undo": {
    "status": "undone",
    "tool": "article_unpublish",
    "input": {
      "id": "pokemon"
    },
    "result.status": "DRAFT",
    "reverses": "0muutznrt0000244f9889167"
  }
}
```

Shows: the void event reported the receipt number from the original's stored result, the original's
id, tool, input and operation, and `undoActionId`, the id of the action the undo is logged as (the
`void-` operation identifier is derived from it, and is captured on that action). A second Undo
ran nothing. The publish inverse needs none of it and behaves as before.
