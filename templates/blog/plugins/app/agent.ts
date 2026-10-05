//modules
import type { HttpServer } from '@stackpress/ingest';
import type {
  Adapter,
  AdapterReply,
  AdapterRequest,
  AdapterTurn,
  AgentConfig,
  ToolConfig,
  ToolResolverServer
} from 'stackpress-ai';
import { createRuntime } from 'stackpress-ai';
//app
import type { Config } from '../../config/common.js';

//--------------------------------------------------------------------//
// Tools

//The tools the agent may use. Each is marked for the agent. The ones that
//change records run app events (events.ts) that check the access of the
//admin page for the same action before they run, so the agent never does
//more than the person could do themselves. They are also `user` tools with a
//scope, so an MCP client needs a user key with that scope to see them, and
//that key's profile roles must allow the action too.
export const tools: ToolConfig[] = [
  {
    name: 'article_find',
    title: 'Find Articles',
    description: 'Searches articles by a text query.',
    type: 'user',
    scopes: [ 'articles.write' ],
    method: 'GET',
    event: 'article-search',
    agent: true,
    input: {
      type: 'object',
      properties: { q: { type: 'string' } },
      additionalProperties: false
    }
  },
  //reversible: it names the tool that undoes it
  {
    name: 'article_publish',
    title: 'Publish Article',
    description: 'Publishes an article by id.',
    type: 'user',
    scopes: [ 'articles.write' ],
    method: 'PUT',
    event: 'app-article-publish',
    agent: true,
    inverse: 'article_unpublish',
    input: {
      type: 'object',
      required: [ 'id' ],
      properties: { id: { type: 'string' } },
      additionalProperties: false
    }
  },
  //the inverse takes the same input, so an undo can run with what was stored.
  //It is not offered to the model; only an undo runs it
  {
    name: 'article_unpublish',
    title: 'Unpublish Article',
    description: 'Puts an article back to the status it had before it was published.',
    type: 'user',
    scopes: [ 'articles.write' ],
    method: 'PUT',
    event: 'app-article-unpublish',
    input: {
      type: 'object',
      required: [ 'id' ],
      properties: { id: { type: 'string' } },
      additionalProperties: false
    }
  },
  //a sample of an inverse that needs more than the stored input. Issuing a
  //receipt makes a number that only its result holds, so voiding it needs the
  //original's result, and the void gets its own operation identifier from the
  //undo action. Both events are in plugin.ts and store nothing: this pair only
  //shows what `undoing(req)` tells an inverse. The input is the same for both
  {
    name: 'sample_receipt_issue',
    title: 'Issue Receipt',
    description: 'Issues a receipt number for an article by id.',
    type: 'user',
    scopes: [ 'articles.write' ],
    method: 'POST',
    event: 'app-receipt-issue',
    agent: true,
    inverse: 'sample_receipt_void',
    input: {
      type: 'object',
      required: [ 'article' ],
      properties: { article: { type: 'string' } },
      additionalProperties: false
    }
  },
  {
    name: 'sample_receipt_void',
    title: 'Void Receipt',
    description: 'Voids the receipt that was issued. Only an undo runs it.',
    type: 'user',
    scopes: [ 'articles.write' ],
    method: 'POST',
    event: 'app-receipt-void',
    input: {
      type: 'object',
      required: [ 'article' ],
      properties: { article: { type: 'string' } },
      additionalProperties: false
    }
  },
  //irreversible: the person approves it before it runs, and it has no undo
  {
    name: 'comment_delete',
    title: 'Delete Comment',
    description: 'Removes a comment by id. It is deactivated, not erased.',
    type: 'user',
    scopes: [ 'comments.write' ],
    method: 'DELETE',
    event: 'app-comment-remove',
    agent: true,
    irreversible: true,
    input: {
      type: 'object',
      required: [ 'id' ],
      properties: { id: { type: 'string' } },
      additionalProperties: false
    }
  }
];

//--------------------------------------------------------------------//
// Offline model

//The blog has no provider key by default. So that the chat routes can still
//be tried, a model that needs no key answers instead. It reads only the
//conversation it is given, so any server can answer any step: a message
//like "publish pokemon and delete comment abc" publishes the article, says
//so, then asks to delete the comment, which waits for approval. Anything
//else gets a note that no provider is set.
const OFFLINE = 'offline-no-provider-key';

const NOTE = 'No model provider is configured. '
  + 'Set a provider key to talk to a real model.';

const usage = { input: 20, output: 10 };

function reply(text: string, calls: AdapterReply['toolCalls'] = []): AdapterReply {
  return {
    text,
    toolCalls: calls,
    stop: calls.length ? 'tools' : 'end',
    usage,
    raw: null
  };
}

export function script(turns: AdapterTurn[]): AdapterReply {
  //what the current message asks, and how far this message has got
  let at = turns.length - 1;
  while (at >= 0 && turns[at].role !== 'user') at--;
  const user = at >= 0 ? turns[at] as { role: 'user', text: string } : null;
  const text = user?.text || '';
  const article = text.match(/publish\s+(?:the\s+)?([\w-]+)/i)?.[1];
  const comment = text.match(/comment\s+([\w-]+)/i)?.[1];
  const receipt = text.match(/receipt\s+(?:for\s+)?([\w-]+)/i)?.[1];
  if (!article && !receipt) return reply(NOTE);

  //each step of the message adds one reply, so the step is how many there are
  const step = turns.slice(at + 1).filter(turn => turn.role === 'assistant').length;
  const last = turns[turns.length - 1];
  const id = `offline-${at}-${step}`;
  //what the last tool call came back with. A refusal or a failure is said
  // as it is, and nothing after it runs
  const results = last.role === 'tool' ? last.results : [];
  const declined = results.some(result => /declined/.test(result.output));
  const failure = results.find(result => result.isError && !/declined/.test(result.output));
  //"issue a receipt for pokemon" issues one, then says so
  if (!article) {
    if (step === 0) {
      return reply('', [ { id, name: 'sample_receipt_issue', input: { article: receipt } } ]);
    }
    return reply(failure
      ? `I could not issue a receipt for ${receipt}. ${failure.output}`
      : `Issued a receipt for ${receipt}.`
    );
  }
  if (step === 0) {
    return reply(
      '', [ { id, name: 'article_publish', input: { id: article } } ]
    );
  }
  if (step === 1 && failure) {
    return reply(`I could not publish ${article}. ${failure.output}`);
  }
  if (step === 1 && comment) {
    return reply(
      `Published ${article}. Now I will delete comment ${comment}.`,
      [ { id, name: 'comment_delete', input: { id: comment } } ]
    );
  }
  if (failure) {
    return reply(`I could not delete comment ${comment}. ${failure.output}`);
  }
  return reply(
    declined
      ? 'Understood. I left the comment alone.'
      : comment
        ? 'All done. The article is published and the comment is gone.'
        : `Published ${article}.`
  );
}

const offline: Adapter = {
  provider: 'offline',
  model: OFFLINE,
  async send(request: AdapterRequest) {
    const result = script(request.turns);
    if (result.text) request.onText?.(result.text);
    return result;
  }
};

//--------------------------------------------------------------------//
// Runtime

/**
 * Replace the agent runtime with one that falls back to the offline model
 * for a provider whose key is not set in the environment. A key that is set
 * goes to the real provider as usual. Pass another environment to decide
 * which keys count as set, as the tests do with an empty one.
 */
export function useOffline(
  ctx: HttpServer<Config>,
  environment: Record<string, string | undefined> = process.env
) {
  const server = ctx as unknown as ToolResolverServer;
  const config = ctx.config.path<AgentConfig>('agent');
  const real = createRuntime(server);

  //the runtime looks keys up by name at call time. A missing one reads as
  //the marker, which `connect` below turns into the offline model
  const env: Record<string, string | undefined> = {};
  for (const { key } of Object.values(config?.providers || {})) {
    Object.defineProperty(env, key, {
      enumerable: true,
      get: () => environment[key] || OFFLINE
    });
  }

  ctx.register('agent', {
    ...real,
    env,
    connect: async (model: Parameters<typeof real.connect>[0], key: string) => (
      key === OFFLINE ? offline : real.connect(model, key)
    )
  });
}
