//node
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
//modules
import type { AdapterTurn, Caller, Undoing } from 'stackpress-ai';
import type { Session } from 'stackpress/session';
import { runTurn, undo } from 'stackpress-ai/scripts';
//app
import type { Fixture, Role } from './support.js';
import { script } from '../plugins/app/agent.js';
import { closeFixtures, createFixture } from './support.js';

//The agent tools that change records run the blog's app events, which sit
// over the generated model events. These tests run the real tool path
// (callTool), the real access rules from config/common.ts, and the real
// generated Article and Comment events over an isolated in-memory database.

/** The caller record of a signed-in person, as the agent writes it. */
const person = (profileId: string): Caller => ({
  kind: 'person', profileId, roles: [], scopes: []
});

/**
 * A profile, an article and comment of it, and that profile's session request.
 */
async function seed(fx: Fixture, roles: Role[], status = 'DRAFT') {
  const owner = await fx.profile(roles);
  const article = await fx.make('article-create', {
    title: 'Hello', slug: `hello-${++slugs}`,
    contents: '<p>Hello</p>', profileId: owner.id, status
  });
  const comment = await fx.make('comment-create', {
    comment: 'Nice', articleId: article.id, profileId: owner.id
  });
  return { owner, article, comment, origin: await fx.signedIn(owner.id, roles) };
}

//every fixture opens its own in-memory database
after(closeFixtures);

/** A slug that differs on every call, so seeded articles never collide. */
let slugs = 0;

describe('the blog access rules', () => {
  test('only ADMIN may use the admin routes the tools stand in for', async () => {
    const fx = await createFixture();
    const session = fx.app.plugin<typeof Session>('session');
    for (const [ role, expected ] of [
      [ 'USER', false ], [ 'MANAGER', false ], [ 'ADMIN', true ]
    ] as [ Role, boolean ][]) {
      const request = await fx.signedIn('someone', [ role ]);
      for (const route of [
        '/admin/article/update/a1', '/admin/comment/remove/c1'
      ]) {
        assert.equal(
          await session.load(request).can({ method: 'POST', route }),
          expected,
          `${role} ${route}`
        );
      }
    }
  });
});

describe('publishing through the tool path', () => {
  for (const role of [ 'USER', 'MANAGER' ] as Role[]) {
    test(`${role} is refused and the article stays as it was`, async () => {
      const fx = await createFixture();
      const { owner, article, origin } = await seed(fx, [ role ]);
      const result = await fx.call(
        'article_publish', { id: article.id }, person(owner.id), origin
      );
      assert.equal(result.code, 403);
      assert.equal((await fx.row('article', article.id)).status, 'DRAFT');
    });
  }

  test('a GUEST session is refused', async () => {
    const fx = await createFixture();
    const { owner, article, origin } = await seed(fx, [ 'GUEST' ]);
    const result = await fx.call(
      'article_publish', { id: article.id }, person(owner.id), origin
    );
    assert.equal(result.code, 403);
    assert.equal((await fx.row('article', article.id)).status, 'DRAFT');
  });

  test('ADMIN publishes, and the result keeps the previous status', async () => {
    const fx = await createFixture();
    const { owner, article, origin } = await seed(fx, [ 'ADMIN' ], 'REVIEW');
    const result = await fx.call(
      'article_publish', { id: article.id }, person(owner.id), origin
    );
    assert.equal(result.code, 200);
    assert.deepEqual(result.results, {
      id: article.id, status: 'PUBLISHED', previous: 'REVIEW'
    });
    assert.equal((await fx.row('article', article.id)).status, 'PUBLISHED');
  });

  test('an unknown article is not found, not silently updated', async () => {
    const fx = await createFixture();
    const { owner, origin } = await seed(fx, [ 'ADMIN' ]);
    const result = await fx.call(
      'article_publish', { id: 'missing' }, person(owner.id), origin
    );
    assert.equal(result.code, 404);
  });

  test('a session token that was altered has no roles and is refused', async () => {
    const fx = await createFixture();
    const { owner, article } = await seed(fx, [ 'USER' ]);
    //a USER's token with its signature damaged, as one edited to say ADMIN is
    const token = await fx.token(owner.id, [ 'USER' ]);
    const [ header, payload, signature ] = token.split('.');
    const roles = Buffer.from(payload, 'base64url').toString().replace('USER', 'ADMIN');
    const forged = [ header, Buffer.from(roles).toString('base64url'), signature ].join('.');
    assert.notEqual(forged, token);
    const origin = fx.withToken(forged);
    const result = await fx.call(
      'article_publish', { id: article.id }, person(owner.id), origin
    );
    assert.equal(result.code, 403);
    assert.equal((await fx.row('article', article.id)).status, 'DRAFT');
  });
});

describe('undo through the tool path', () => {
  /** An admin's article, published through the tool, in REVIEW before. */
  async function published(fx: Fixture) {
    const admin = await seed(fx, [ 'ADMIN' ], 'REVIEW');
    const result = await fx.call(
      'article_publish', { id: admin.article.id }, person(admin.owner.id), admin.origin
    );
    assert.equal(result.code, 200);
    return { ...admin, result };
  }
  /** What an undo tells the inverse about the publish it undoes. */
  const undone = (article: string, result: unknown): Undoing => ({
    undoActionId: 'undo-1',
    original: {
      id: 'action-1',
      tool: 'article_publish',
      input: { id: article },
      operation: null,
      result
    }
  });

  test('ADMIN undo restores the status it had', async () => {
    const fx = await createFixture();
    const { owner, article, origin, result } = await published(fx);
    const back = await fx.call(
      'article_unpublish', { id: article.id }, person(owner.id), origin,
      undone(article.id, result.results)
    );
    assert.equal(back.code, 200);
    assert.equal((await fx.row('article', article.id)).status, 'REVIEW');
  });

  for (const role of [ 'USER', 'MANAGER' ] as Role[]) {
    test(`${role} cannot undo, and the article stays published`, async () => {
      const fx = await createFixture();
      const { article, result } = await published(fx);
      const other = await seed(fx, [ role ]);
      const back = await fx.call(
        'article_unpublish', { id: article.id }, person(other.owner.id), other.origin,
        undone(article.id, result.results)
      );
      assert.equal(back.code, 403);
      assert.equal((await fx.row('article', article.id)).status, 'PUBLISHED');
    });
  }

  test('an undo with no record puts the article back to draft', async () => {
    const fx = await createFixture();
    const { owner, article, origin } = await published(fx);
    const back = await fx.call(
      'article_unpublish', { id: article.id }, person(owner.id), origin
    );
    assert.equal(back.code, 200);
    assert.equal((await fx.row('article', article.id)).status, 'DRAFT');
  });
});

describe('removing a comment through the tool path', () => {
  for (const role of [ 'USER', 'MANAGER' ] as Role[]) {
    test(`${role} is refused and the comment stays`, async () => {
      const fx = await createFixture();
      const { owner, comment, origin } = await seed(fx, [ role ]);
      const result = await fx.call(
        'comment_delete', { id: comment.id }, person(owner.id), origin
      );
      assert.equal(result.code, 403);
      assert.equal((await fx.row('comment', comment.id)).active, true);
    });
  }

  test('ADMIN removes it', async () => {
    const fx = await createFixture();
    const { owner, comment, origin } = await seed(fx, [ 'ADMIN' ]);
    const result = await fx.call(
      'comment_delete', { id: comment.id }, person(owner.id), origin
    );
    assert.equal(result.code, 200);
    assert.equal((await fx.row('comment', comment.id)).active, false);
  });
});

describe('callers that are not a signed-in person', () => {
  /** The caller of a verified MCP user key that has the tools' scopes. */
  const key = (profileId: string): Caller => ({
    kind: 'user', profileId, sessionId: 's1', scopes: [ 'articles.write', 'comments.write' ]
  });

  test('a user key follows its profile roles, not its scopes', async () => {
    const fx = await createFixture();
    const low = await seed(fx, [ 'USER' ]);
    const manager = await seed(fx, [ 'MANAGER' ]);
    const admin = await seed(fx, [ 'ADMIN' ]);
    for (const { owner, article } of [ low, manager ]) {
      const result = await fx.call('article_publish', { id: article.id }, key(owner.id));
      assert.equal(result.code, 403);
      assert.equal((await fx.row('article', article.id)).status, 'DRAFT');
    }
    const result = await fx.call(
      'article_publish', { id: admin.article.id }, key(admin.owner.id)
    );
    assert.equal(result.code, 200);
    assert.equal((await fx.row('article', admin.article.id)).status, 'PUBLISHED');
  });

  test('a user key cannot name another profile through its input', async () => {
    const fx = await createFixture();
    const low = await seed(fx, [ 'USER' ]);
    const admin = await seed(fx, [ 'ADMIN' ]);
    const result = await fx.call(
      'article_publish',
      { id: low.article.id, profileId: admin.owner.id },
      key(low.owner.id)
    );
    assert.equal(result.code, 400);
    assert.equal((await fx.row('article', low.article.id)).status, 'DRAFT');
  });

  test('a key follows the profile as it is now, not as it was', async () => {
    const fx = await createFixture();
    const { owner, article } = await seed(fx, [ 'ADMIN' ]);
    await fx.engine.query(
      'UPDATE profile SET roles = ? WHERE id = ?', [ JSON.stringify([ 'USER' ]), owner.id ]
    );
    const result = await fx.call('article_publish', { id: article.id }, key(owner.id));
    assert.equal(result.code, 403);
    assert.equal((await fx.row('article', article.id)).status, 'DRAFT');
  });

  test('a key for a missing or inactive profile is refused', async () => {
    const fx = await createFixture();
    const admin = await seed(fx, [ 'ADMIN' ]);
    const missing = await fx.call(
      'article_publish', { id: admin.article.id }, key('nobody')
    );
    assert.equal(missing.code, 403);
    await fx.engine.query('UPDATE profile SET active = FALSE WHERE id = ?', [ admin.owner.id ]);
    const inactive = await fx.call(
      'article_publish', { id: admin.article.id }, key(admin.owner.id)
    );
    assert.equal(inactive.code, 403);
    assert.equal((await fx.row('article', admin.article.id)).status, 'DRAFT');
  });

  test('app keys, public callers and unrecorded calls are refused', async () => {
    const fx = await createFixture();
    const { article, comment } = await seed(fx, [ 'ADMIN' ]);
    for (const who of [
      { kind: 'app', applicationId: 'a1', scopes: [ 'articles.write', 'comments.write' ] },
      { kind: 'public', scopes: [] }
    ] as Caller[]) {
      for (const [ name, input ] of [
        [ 'article_publish', { id: article.id } ],
        [ 'comment_delete', { id: comment.id } ]
      ] as [ string, Record<string, unknown> ][]) {
        assert.equal((await fx.call(name, input, who)).code, 403, `${who.kind} ${name}`);
      }
    }
    //the event itself, called with no caller recorded
    const direct = await fx.app.resolve(
      'app-article-publish',
      fx.app.request({ data: { id: article.id } })
    );
    assert.equal(direct.code, 401);
    assert.equal((await fx.row('article', article.id)).status, 'DRAFT');
    assert.equal((await fx.row('comment', comment.id)).active, true);
  });
});

describe('the offline model', () => {
  const usage = { input: 1, output: 1 };
  //the conversation after the model asked for one tool and it answered
  const answered = (
    message: string, name: string, output: string, isError?: boolean
  ): AdapterTurn[] => [
    { role: 'user', text: message },
    {
      role: 'assistant', text: '', usage, raw: null,
      toolCalls: [ { id: 'c1', name, input: {} } ]
    },
    { role: 'tool', results: [ { id: 'c1', name, output, isError } ] }
  ];

  test('a refused publish is reported and no deletion is asked for', () => {
    const reply = script(answered(
      'publish pokemon and delete comment abc',
      'article_publish', 'You are not allowed to do this.', true
    ));
    assert.deepEqual(reply.toolCalls, []);
    assert.match(reply.text, /could not publish pokemon/);
    assert.match(reply.text, /not allowed/);
    assert.doesNotMatch(reply.text, /Published|done|gone/);
  });

  test('a failed deletion is reported, not claimed', () => {
    const turns = answered(
      'publish pokemon and delete comment abc', 'article_publish', '{}'
    );
    turns.push(
      {
        role: 'assistant', text: '', usage, raw: null,
        toolCalls: [ { id: 'c2', name: 'comment_delete', input: {} } ]
      },
      {
        role: 'tool',
        results: [ { id: 'c2', name: 'comment_delete', output: 'Not Found', isError: true } ]
      }
    );
    const reply = script(turns);
    assert.match(reply.text, /could not delete comment abc/);
    assert.doesNotMatch(reply.text, /All done|gone/);
  });

  test('a declined deletion and a success keep their own wording', () => {
    assert.match(script(answered(
      'publish pokemon', 'article_publish', '{}'
    )).text, /^Published pokemon/);
    const declined = answered('publish pokemon and delete comment abc', 'article_publish', '{}');
    declined.push(
      {
        role: 'assistant', text: '', usage, raw: null,
        toolCalls: [ { id: 'c2', name: 'comment_delete', input: {} } ]
      },
      {
        role: 'tool',
        results: [ { id: 'c2', name: 'comment_delete', output: 'The person declined.', isError: true } ]
      }
    );
    assert.match(script(declined).text, /left the comment alone/);
  });
});

describe('the agent turn', () => {
  /** What the agent said last in a thread, and how many actions it took. */
  async function said(fx: Fixture) {
    const turns = await fx.engine.query<Record<string, string>>(
      "SELECT text FROM agent_turn WHERE role = 'assistant' ORDER BY created DESC, id DESC"
    );
    const actions = await fx.engine.query<Record<string, string>>(
      'SELECT tool, status FROM agent_action'
    );
    return { texts: turns.map(turn => turn.text), actions };
  }

  for (const role of [ 'USER', 'MANAGER' ] as Role[]) {
    test(`${role} asks the agent to publish and nothing changes`, async () => {
      const fx = await createFixture();
      const { article, origin } = await seed(fx, [ role ]);
      const data = { message: `publish ${article.id}` };
      origin.data.set(data);
      const turn = await runTurn(fx.runtime, origin, data);
      assert.equal(turn.ok, true);
      assert.equal((await fx.row('article', article.id)).status, 'DRAFT');
      const actions = await fx.engine.query<Record<string, unknown>>(
        'SELECT tool, status FROM agent_action'
      );
      assert.deepEqual(actions.map(a => a.status), [ 'failed' ]);
      const { texts } = await said(fx);
      assert.ok(texts.some(text => /could not publish/.test(text)), texts.join('|'));
      assert.ok(texts.every(text => !/Published|done|gone/.test(text)), texts.join('|'));
    });

    test(`${role} asking to publish and delete a comment gets no deletion`, async () => {
      const fx = await createFixture();
      const { article, comment, origin } = await seed(fx, [ role ]);
      const data = { message: `publish ${article.id} and delete comment ${comment.id}` };
      origin.data.set(data);
      const turn = await runTurn(fx.runtime, origin, data);
      assert.equal(turn.ok && turn.status, 'done');
      const { texts, actions } = await said(fx);
      assert.deepEqual(actions.map(a => a.tool), [ 'article_publish' ]);
      assert.ok(texts.every(text => !/Published|done|gone/.test(text)), texts.join('|'));
      assert.equal((await fx.row('article', article.id)).status, 'DRAFT');
      assert.equal((await fx.row('comment', comment.id)).active, true);
    });
  }

  test('ADMIN asking for a missing article gets a failure, not a claim', async () => {
    const fx = await createFixture();
    const { origin } = await seed(fx, [ 'ADMIN' ]);
    const data = { message: 'publish missing-article and delete comment abc' };
    origin.data.set(data);
    const turn = await runTurn(fx.runtime, origin, data);
    assert.equal(turn.ok && turn.status, 'done');
    const { texts, actions } = await said(fx);
    assert.deepEqual(actions.map(a => a.status), [ 'failed' ]);
    assert.ok(texts.some(text => /could not publish missing-article/.test(text)));
    assert.ok(texts.every(text => !/Published|done|gone/.test(text)), texts.join('|'));
  });

  test('ADMIN publishes through the agent and undoes it', async () => {
    const fx = await createFixture();
    const { article, origin } = await seed(fx, [ 'ADMIN' ]);
    const data = { message: `publish ${article.id}` };
    origin.data.set(data);
    const turn = await runTurn(fx.runtime, origin, data);
    assert.equal(turn.ok, true);
    assert.equal((await fx.row('article', article.id)).status, 'PUBLISHED');
    const [ action ] = await fx.engine.query<Record<string, string>>(
      "SELECT id FROM agent_action WHERE tool = 'article_publish'"
    );
    const input = { actionId: action.id };
    origin.data.set(input);
    const back = await undo(fx.runtime, origin, input);
    assert.equal(back.ok && back.status, 'undone');
    assert.equal((await fx.row('article', article.id)).status, 'DRAFT');
  });
});
