# Task 00004 evidence: live smoke run through OpenRouter

**Form produced: the real, unedited output of the smoke script, run live on
2026-10-05 at about 00:44 UTC.** One two-step lookup with one small tool
(`request_lookup`), one run per model, through the same chooser and OpenRouter
adapter the runtime uses, with streaming on and a 2,000 token output cap. The
script prints no request and no header, and redacts the key from anything it
prints; the key itself is not in this file.

Command, run in `packages/stackpress-ai` (the key came from the environment of
this one command and is not shown here):

```
OPENROUTER_API_KEY=<key> yarn smoke      # tsx tests/smoke-openrouter.ts
```

What this does and does not show:

- It shows the OpenRouter adapter, with its streaming path, working live against
  one Claude model and one OpenAI model: each called the tool once with the right
  input, answered from the result, streamed its text, and reported usage.
- It does not show the **Anthropic** or **OpenAI** adapters running live. There
  are no Anthropic or OpenAI keys; those two adapters are verified only with
  canned replies handed to the real SDKs.
- The tool call ids differ by model because OpenRouter forwards each provider's own
  ids (`toolu_` for Claude, `call_` for OpenAI).

## Output

```
question: What are the title and status of request REQ-42? Use the request_lookup tool.
tool: request_lookup, record returned: {"id":"REQ-42","title":"Blue heron budget 7731","status":"SUBMITTED"}

=== anthropic/claude-opus-5.5 (via openrouter, streaming, max 2000 tokens)
assistant: stop tools, 453 tokens in, 55 out
  tool call: request_lookup({"requestId":"REQ-42"}) id toolu_016yBCLUT7UTdC2WdwQf73f5
tool result: request_lookup -> {"id":"REQ-42","title":"Blue heron budget 7731","status":"SUBMITTED"}
assistant: stop end, 550 tokens in, 49 out
  text: Request REQ-42 is titled **"Blue heron budget 7731"** and its status is **SUBMITTED**.
answer: Request REQ-42 is titled **"Blue heron budget 7731"** and its status is **SUBMITTED**.
usage: 1003 tokens in, 104 out
streamed: 3 text chunks, 86 characters
RESULT PASS

=== openai/gpt-6.1-sol (via openrouter, streaming, max 2000 tokens)
assistant: stop tools, 97 tokens in, 21 out
  tool call: request_lookup({"requestId":"REQ-42"}) id call_bAQn1QUWIPX8AcKq6r5iKKC9
tool result: request_lookup -> {"id":"REQ-42","title":"Blue heron budget 7731","status":"SUBMITTED"}
assistant: stop end, 151 tokens in, 22 out
  text: - **Title:** Blue heron budget 7731 - **Status:** SUBMITTED
answer: - **Title:** Blue heron budget 7731 - **Status:** SUBMITTED
usage: 248 tokens in, 43 out
streamed: 20 text chunks, 59 characters
RESULT PASS

all model runs passed
```
