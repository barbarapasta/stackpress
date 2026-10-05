//this is the live smoke run for the provider adapters. It is not a test and
// is not part of `yarn test`: it spends a little real money through OpenRouter.
//
//  OPENROUTER_API_KEY=... yarn smoke
//
//It runs one two-step lookup with one small tool against one Claude model and
// one OpenAI model, through the same chooser and adapter the runtime uses, with
// streaming on. Set OPENROUTER_MODELS to a comma list to try other models.
//
//The key is read from the environment and goes nowhere else. Nothing here
// prints a request or its headers, and everything that is printed passes
// through redact() first.

//client
import createAdapter, { ProviderError } from '../src/adapters/index.js';
import { QUESTION, SYSTEM, TOOLS, RECORD, runTurn, usage } from './provider.js';
import type { AdapterToolCall, AdapterTurn } from '../src/types.js';

const key = (process.env.OPENROUTER_API_KEY || '').trim();
const models = (process.env.OPENROUTER_MODELS || 'anthropic/claude-opus-5.5,openai/gpt-6.1-sol')
  .split(',').map(model => model.trim()).filter(Boolean);

//a small output cap: this is a two-step lookup
const MAX_TOKENS = 2000;

const redact = (text: unknown) => {
  const value = String(text);
  return key ? value.split(key).join('[redacted]') : value;
};
const say = (text = '') => console.log(redact(text));
const one = (text: string) => text.replace(/\s+/g, ' ').trim();

if (!key) {
  say('SKIP live smoke: OPENROUTER_API_KEY is not set, so nothing was run.');
  process.exit(0);
}

let failed = 0;
say(`question: ${QUESTION}`);
say(`tool: ${TOOLS[0].name}, record returned: ${JSON.stringify(RECORD)}`);

for (const model of models) {
  say();
  say(`=== ${model} (via openrouter, streaming, max ${MAX_TOKENS} tokens)`);
  const calls: AdapterToolCall[] = [];
  const chunks: string[] = [];
  const turns: AdapterTurn[] = [ { role: 'user', text: QUESTION } ];
  try {
    const adapter = await createAdapter({
      provider: 'openrouter', apiKey: key, maxTokens: MAX_TOKENS, model
    });
    const stop = await runTurn({
      adapter,
      turns,
      onText: text => chunks.push(text),
      execute: async call => {
        calls.push(call);
        return RECORD;
      }
    });
    const answer = (turns[turns.length - 1] as { text?: string }).text || '';
    for (const turn of turns) {
      if (turn.role === 'assistant') {
        say(`assistant: stop ${turn.toolCalls.length ? 'tools' : 'end'}, `
          + `${turn.usage.input} tokens in, ${turn.usage.output} out`);
        for (const call of turn.toolCalls) {
          say(`  tool call: ${call.name}(${JSON.stringify(call.input)}) id ${call.id}`);
        }
        if (turn.text) say(`  text: ${one(turn.text)}`);
      } else if (turn.role === 'tool') {
        for (const result of turn.results) {
          say(`tool result: ${result.name} -> ${result.output}`);
        }
      }
    }
    const total = usage(turns);
    say(`answer: ${one(answer)}`);
    say(`usage: ${total.input} tokens in, ${total.output} out`);
    say(`streamed: ${chunks.length} text chunks, ${chunks.join('').length} characters`);

    //the same checks the canned tests make, against the live reply
    const problems: string[] = [];
    if (stop !== 'end') problems.push(`the turn ended with "${stop}"`);
    if (calls.length !== 1) problems.push(`the tool ran ${calls.length} times`);
    if (calls[0] && calls[0].input.requestId !== 'REQ-42') {
      problems.push(`the tool input was ${JSON.stringify(calls[0].input)}`);
    }
    if (!/7731/.test(answer) || !/SUBMITTED/i.test(answer)) {
      problems.push('the answer does not come from the tool result');
    }
    if (total.input <= 0 || total.output <= 0) problems.push('no usage was reported');
    if (!chunks.length) problems.push('no text was streamed');
    say(problems.length ? `RESULT FAIL: ${problems.join('; ')}` : 'RESULT PASS');
    failed += problems.length ? 1 : 0;
  } catch (error) {
    failed++;
    //only the typed fields and the provider's own message: never a request
    if (error instanceof ProviderError) {
      say(`RESULT FAIL: ${error.kind} (status ${error.status ?? 'none'}): ${one(error.message).slice(0, 200)}`);
      if (error.kind === 'authentication') {
        say('The key was rejected, so no further model was tried.');
        break;
      }
    } else {
      say(`RESULT FAIL: ${one((error as Error).message || 'unknown error').slice(0, 200)}`);
    }
  }
}

say();
say(failed ? `${failed} model run(s) failed` : 'all model runs passed');
process.exit(failed ? 1 : 0);
