//Spec 00004 P-001 (GAP-001): can a tool call carry the signed-in user into
//an event that authenticates from the session token on the request?
//
//The event below copies how an application event reads its caller: it asks
//the session plugin for the token on the request it was given and verifies
//it. The chat route then calls that event three ways, the way an agent
//runtime could, and reports what the event saw each time.

//node
import assert from 'node:assert/strict';
//modules
import { server as http } from '@stackpress/ingest/http';
import { Session } from 'stackpress-session';

const KEY = 'session';
const SEED = 'proof-seed-not-a-secret';
const USER = { id: 'profile-123', name: 'Proof User', roles: [ 'USER' ] };

const app = http();
app.register('session', Session.configure(KEY, SEED, {}));

//an application event that trusts only the session on its own request
app.on('whoami', async ({ req, res, ctx }) => {
  const session = ctx.plugin('session');
  const data = await session.load(req).data();
  if (!data) {
    res.setError('An authenticated profile is required.', {}, [], 403);
    return;
  }
  res.results({ actor: data.id, input: req.data() });
});

//what a tool call would pass as its arguments
const TOOL_INPUT = { requestId: 'req-1', comment: 'tool argument' };

//the chat endpoint: the agent runtime lives behind this route
app.post('/agent/chat', async ({ req, res, ctx }) => {
  //A. today's stackpress-ai form: plain data, no request
  const plain = await ctx.resolve('whoami', { ...TOOL_INPUT });
  //B. forward the chat request itself
  const same = await ctx.resolve('whoami', req, ctx.response());
  //C. build a new request that carries the caller's session and only the
  //   tool arguments as data
  const forwarded = await ctx.resolve('whoami', ctx.request({
    data: { ...TOOL_INPUT },
    headers: { 'user-agent': String(req.headers.get('user-agent') || '') },
    method: 'POST',
    session: req.session.data,
    url: req.url
  }), ctx.response());
  res.results({ plain, same, forwarded });
});

const token = await Session.create(USER);
const listener = app.create();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const { port } = listener.address();

async function chat(cookie) {
  const response = await fetch(`http://127.0.0.1:${port}/agent/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify({ message: 'chat body must not reach the tool', secret: 'chat-only' })
  });
  return (await response.json()).results;
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push([ 'PASS', name ]);
  } catch (error) {
    checks.push([ 'FAIL', `${name} :: ${error.message}` ]);
  }
}

try {
  const signedIn = await chat(`${KEY}=${token}`);
  const signedOut = await chat();
  const forged = await chat(`${KEY}=${token.slice(0, -4)}AAAA`);

  check('A. plain data is refused even when the person is signed in', () => {
    assert.equal(signedIn.plain.code, 403);
  });
  check('B. forwarding the chat request is accepted as the person', () => {
    assert.equal(signedIn.same.results?.actor, USER.id);
  });
  check('B. forwarding the chat request leaks the chat body into the event', () => {
    assert.equal(signedIn.same.results?.input?.secret, 'chat-only');
  });
  check('C. a new request with the caller session is accepted as the person', () => {
    assert.equal(signedIn.forwarded.results?.actor, USER.id);
  });
  check('C. the event receives only the tool arguments', () => {
    assert.deepEqual(signedIn.forwarded.results?.input, TOOL_INPUT);
  });
  check('C. a signed-out caller is refused', () => {
    assert.equal(signedOut.forwarded.code, 403);
  });
  check('C. a tampered token is refused', () => {
    assert.equal(forged.forwarded.code, 403);
  });
} finally {
  await new Promise(resolve => listener.close(resolve));
}

for (const [ status, name ] of checks) console.log(status, name);
const failed = checks.filter(([ status ]) => status === 'FAIL').length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
