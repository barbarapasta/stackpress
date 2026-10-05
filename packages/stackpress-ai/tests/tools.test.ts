//modules
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { server as http } from '@stackpress/ingest/http';
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import {
  callerFromAuth,
  findForbiddenCall,
  normalizeTool,
  withToolData
} from '../src/helpers.js';
import { createMcpServer } from '../src/plugin.js';
import {
  TOOLS_EVENT,
  caller,
  callTool,
  collectTools,
  contributeTool,
  loadRegistry,
  undoing
} from '../src/scripts/tools.js';
import type {
  AuthContext,
  Caller,
  ToolConfig,
  ToolResolverServer,
  Undoing
} from '../src/types.js';
import { createApplication, createSession } from './helpers.js';

//these suites run against a real Ingest server so the contribution event, the
// request that reaches a tool event, and its response are the real ones.

//what an undo tells an inverse's event
const undone: Undoing = {
  undoActionId: 'undo_1',
  original: { id: 'act_1', tool: 'make', input: { a: 1 }, result: { id: 'x' }, operation: 'op_1' }
};

//this helper builds a real server with the given mcp tools in its config
function create(tools: ToolConfig[] = []) {
  const app = http();
  app.config.set({ mcp: { tools } });
  return app as unknown as ToolResolverServer;
}

//this helper adds a listener that contributes tools every time the registry
// is built, the way a plugin would.
function contribute(ctx: ToolResolverServer, ...tools: ToolConfig[]) {
  ctx.on(TOOLS_EVENT, ({ ctx }) => {
    contributeTool(ctx, tools);
  });
}

//this tool event echoes what it received: input, the caller record, and the
// session and method of its request.
function echo(ctx: ToolResolverServer, event = 'echo') {
  ctx.on(event, ({ req, res }) => {
    res.results({
      input: req.data(),
      caller: caller(req) || null,
      session: req.session.data,
      method: req.method
    });
  });
}

//this helper normalizes one tool the way the registry would
function tool(config: Partial<ToolConfig> = {}) {
  return normalizeTool({
    name: 'echo',
    event: 'echo',
    method: 'POST',
    ...config
  })!;
}

type Echo = {
  input: Record<string, unknown>,
  caller: Caller | null,
  session: Record<string, unknown>,
  method: string
};

describe('ai/tools', () => {
  describe('collectTools', () => {
    it('should list a contributed tool with no mcp.tools entry', async () => {
      const ctx = create();
      contribute(ctx, {
        name: 'blog_ping',
        description: 'Ping the blog.',
        event: 'blog-ping'
      });

      const tools = await collectTools(ctx);

      expect(tools).to.have.length(1);
      expect(tools[0]).to.include({
        name: 'blog_ping',
        title: 'Blog Ping',
        type: 'public',
        method: 'GET',
        event: 'blog-ping'
      });
    });

    it('should infer the name of a contribution from its event', async () => {
      const ctx = create();
      contribute(ctx, { event: 'blog-ping' });
      expect((await collectTools(ctx)).map(tool => tool.name))
        .to.deep.equal([ 'blog_ping' ]);
    });

    it('should accept one contribution or a list', async () => {
      const ctx = create();
      ctx.on(TOOLS_EVENT, ({ ctx }) => {
        contributeTool(ctx, { name: 'one', event: 'one' });
        contributeTool(ctx, [
          { name: 'two', event: 'two' },
          { name: 'three', event: 'three' }
        ]);
      });
      expect((await collectTools(ctx)).map(tool => tool.name))
        .to.deep.equal([ 'one', 'two', 'three' ]);
    });

    it('should let a config entry override the contributed fields by name', async () => {
      const ctx = create([
        {
          name: 'blog_ping',
          description: 'Overridden.',
          type: 'app',
          scopes: [ 'blog.read' ],
          data: { extra: 1 }
        } as ToolConfig
      ]);
      contribute(ctx, {
        name: 'blog_ping',
        title: 'Contributed Title',
        description: 'Contributed.',
        event: 'blog-ping',
        method: 'POST',
        data: { fixed: true }
      });

      const tools = await collectTools(ctx);

      //one tool, not two: the config entry merged into the contribution
      expect(tools).to.have.length(1);
      expect(tools[0]).to.deep.include({
        name: 'blog_ping',
        //overridden by config
        description: 'Overridden.',
        type: 'app',
        scopes: [ 'blog.read' ],
        //kept from the contribution because config did not set them
        title: 'Contributed Title',
        event: 'blog-ping',
        method: 'POST'
      });
      expect(tools[0].data).to.deep.equal({ fixed: true, extra: 1 });
    });

    it('should keep configured tools that nothing contributed', async () => {
      const ctx = create([
        { name: 'configured', event: 'configured' }
      ]);
      contribute(ctx, { name: 'contributed', event: 'contributed' });
      expect((await collectTools(ctx)).map(tool => tool.name))
        .to.deep.equal([ 'contributed', 'configured' ]);
    });

    it('should work with no listener on the contribution event', async () => {
      const ctx = create([ { name: 'configured', event: 'configured' } ]);
      expect((await collectTools(ctx)).map(tool => tool.name))
        .to.deep.equal([ 'configured' ]);
    });

    it('should reject two contributions of the same name', async () => {
      const ctx = create();
      contribute(ctx, { name: 'twin', event: 'a' });
      contribute(ctx, { name: 'twin', event: 'b' });
      let message = '';
      try {
        await collectTools(ctx);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).to.equal('Tool "twin" was contributed more than once.');
    });

    it('should detect a duplicate by the inferred name too', async () => {
      const ctx = create();
      contribute(ctx, { event: 'blog-ping' });
      contribute(ctx, { name: 'blog_ping', event: 'other' });
      let message = '';
      try {
        await collectTools(ctx);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).to.contain('"blog_ping"');
    });

    it('should recover after a failed collection', async () => {
      const ctx = create();
      let duplicate = true;
      ctx.on(TOOLS_EVENT, ({ ctx }) => {
        contributeTool(ctx, { name: 'twin', event: 'a' });
        if (duplicate) contributeTool(ctx, { name: 'twin', event: 'b' });
      });
      let failed = false;
      await collectTools(ctx).catch(() => { failed = true; });
      duplicate = false;
      const tools = await collectTools(ctx);
      expect(failed).to.equal(true);
      expect(tools.map(tool => tool.name)).to.deep.equal([ 'twin' ]);
    });

    it('should drop a contribution that cannot become a tool', async () => {
      const ctx = create();
      contribute(
        ctx,
        { name: 'bad_method', event: 'x', method: 'FETCH' },
        { name: 'no_event' } as ToolConfig,
        { name: 'good', event: 'good' }
      );
      expect((await collectTools(ctx)).map(tool => tool.name))
        .to.deep.equal([ 'good' ]);
    });

    it('should resolve a contribution that defers to a plugin event', async () => {
      const ctx = create();
      ctx.on('deferred', ({ res }) => {
        res.results({ name: 'deferred_tool', event: 'deferred-run' });
      });
      contribute(ctx, { mode: 'plugin', event: 'deferred' });
      const tools = await collectTools(ctx);
      expect(tools.map(tool => tool.name)).to.deep.equal([ 'deferred_tool' ]);
    });

    it('should skip a deferred entry whose plugin event gives nothing', async () => {
      //neither the contribution nor the configured entry resolves to a tool
      const ctx = create([ { mode: 'plugin', event: 'silent-config' } ]);
      contribute(
        ctx,
        { mode: 'plugin', event: 'silent' },
        { name: 'kept', event: 'kept' }
      );
      expect((await collectTools(ctx)).map(tool => tool.name))
        .to.deep.equal([ 'kept' ]);
    });

    it('should keep concurrent collections apart', async () => {
      const ctx = create();
      contribute(ctx, { name: 'once', event: 'once' });
      //a mixed-up collection would hold the contribution twice and throw
      const lists = await Promise.all([
        collectTools(ctx),
        collectTools(ctx),
        collectTools(ctx)
      ]);
      for (const tools of lists) {
        expect(tools.map(tool => tool.name)).to.deep.equal([ 'once' ]);
      }
    });

    it('should refuse a contribution made outside the contribution event', () => {
      const ctx = create();
      expect(() => contributeTool(ctx, { name: 'late', event: 'late' }))
        .to.throw('Tools can only be contributed while the ai-tools event resolves.');
    });
  });

  describe('shared registry', () => {
    it('should list contributed tools through createMcpServer', async () => {
      const ctx = create();
      contribute(ctx, { name: 'blog_ping', event: 'blog-ping' });
      ctx.on('blog-ping', ({ res }) => res.results({ pong: true }));

      const server = await createMcpServer(ctx);
      const [ near, far ] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test', version: '1.0.0' });
      await Promise.all([ server!.connect(near), client.connect(far) ]);

      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name)).to.deep.equal([ 'blog_ping' ]);
      const called = await client.callTool({ name: 'blog_ping', arguments: {} });
      expect(called.isError).to.not.equal(true);
      expect(called.content).to.deep.equal([
        { type: 'text', text: JSON.stringify({ pong: true }, null, 2) }
      ]);
    });

    it('should let the 403 check see a contributed tool the caller lacks', async () => {
      const ctx = create();
      contribute(ctx, {
        name: 'blog_write',
        event: 'blog-write',
        type: 'app',
        method: 'POST',
        scopes: [ 'blog.write' ]
      });
      const auth: AuthContext = {
        kind: 'app',
        token: { token: 'app_1:secret', id: 'app_1', secret: 'secret' },
        application: createApplication({ scopes: [ 'blog.read' ] })
      };
      const forbidden = await findForbiddenCall(
        loadRegistry(ctx),
        auth,
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'blog_write' } }
      );
      expect(forbidden).to.deep.equal({ id: 7, name: 'blog_write' });
    });
  });

  describe('undoing', () => {
    it('should read nothing for an ordinary call and for a request that is not from callTool', async () => {
      const ctx = create();
      let seen: unknown = 'unset';
      ctx.on('echo', ({ req, res }) => {
        seen = undoing(req);
        res.results({ ok: true });
      });
      await callTool(ctx, tool(), {}, { kind: 'public', scopes: [] });
      expect(seen).to.equal(undefined);
      expect(undoing({})).to.equal(undefined);
    });

    it('should read the record of the call that was given one, apart from the input', async () => {
      const ctx = create();
      let input: unknown;
      let seen: unknown;
      ctx.on('echo', ({ req, res }) => {
        input = req.data();
        seen = undoing(req);
        res.results({ ok: true });
      });
      await callTool(ctx, tool(), { a: 1 }, { kind: 'user', scopes: [] }, undefined, undone);
      expect(seen).to.deep.equal(undone);
      expect(input).to.include({ a: 1 });
      expect(input).to.not.have.any.keys('undoing', 'undoActionId', 'original');
    });

    it('should not carry the record from one call to the next', async () => {
      const ctx = create();
      const seen: unknown[] = [];
      ctx.on('echo', ({ req, res }) => {
        seen.push(undoing(req));
        res.results({ ok: true });
      });
      const who: Caller = { kind: 'user', scopes: [] };
      await callTool(ctx, tool(), {}, who, undefined, undone);
      await callTool(ctx, tool(), {}, who);
      expect(seen).to.deep.equal([ undone, undefined ]);
    });

    it('should not read a record from input that names one', async () => {
      const ctx = create();
      let seen: unknown = 'unset';
      ctx.on('echo', ({ req, res }) => {
        seen = undoing(req);
        res.results({ ok: true });
      });
      await callTool(ctx, tool(), { undoing: undone, undoActionId: 'undo_1' }, { kind: 'user', scopes: [] });
      expect(seen).to.equal(undefined);
    });
  });

  describe('callTool', () => {
    it('should return the code, results, and no error for a good event', async () => {
      const ctx = create();
      ctx.on('echo', ({ res }) => res.results({ ok: true }));
      const result = await callTool(ctx, tool(), {}, { kind: 'public', scopes: [] });
      expect(result.code).to.equal(200);
      expect(result.results).to.deep.equal({ ok: true });
      expect(result.error).to.equal(undefined);
    });

    it('should return the code and error of a refused event', async () => {
      const ctx = create();
      ctx.on('echo', ({ res }) => {
        res.setError('Not for you.', {}, [], 403);
      });
      const result = await callTool(ctx, tool(), {}, { kind: 'public', scopes: [] });
      expect(result).to.deep.include({
        code: 403,
        status: 'Forbidden',
        error: 'Not for you.'
      });
    });

    it('should answer 400 for input that breaks the tool schema', async () => {
      const ctx = create();
      echo(ctx);
      const result = await callTool(
        ctx,
        tool({
          input: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: [ 'id' ]
          }
        }),
        {},
        { kind: 'public', scopes: [] }
      );
      expect(result.code).to.equal(400);
      expect(result.error).to.be.a('string').and.not.equal('');
      //the event never ran
      expect(result.results).to.equal(undefined);
    });

    it('should hand the event the tool method', async () => {
      const ctx = create();
      echo(ctx);
      const result = await callTool(
        ctx,
        tool({ method: 'DELETE' }),
        {},
        { kind: 'public', scopes: [] }
      );
      expect((result.results as Echo).method).to.equal('DELETE');
    });

    it('should keep the caller record out of the input and on the request', async () => {
      const ctx = create();
      echo(ctx);
      const who: Caller = {
        kind: 'app',
        applicationId: 'app_1',
        scopes: [ 'blog.read' ]
      };
      const result = await callTool(ctx, tool(), { q: 'x' }, who);
      const seen = result.results as Echo;
      expect(seen.caller).to.deep.equal(who);
      expect(seen.input).to.deep.equal({ q: 'x', applicationId: 'app_1' });
      expect(JSON.stringify(seen.input)).to.not.contain('scopes');
    });

    it('should not let input set the caller record', async () => {
      const ctx = create();
      echo(ctx);
      const result = await callTool(
        ctx,
        tool(),
        { caller: { kind: 'app', scopes: [ 'admin' ] }, kind: 'user' },
        { kind: 'public', scopes: [] }
      );
      const seen = result.results as Echo;
      expect(seen.caller).to.deep.equal({ kind: 'public', scopes: [] });
    });

    it('should give each call its own caller record', async () => {
      const ctx = create();
      echo(ctx);
      const [ a, b ] = await Promise.all([
        callTool(ctx, tool(), {}, { kind: 'app', applicationId: 'a', scopes: [] }),
        callTool(ctx, tool(), {}, { kind: 'app', applicationId: 'b', scopes: [] })
      ]);
      expect((a.results as Echo).caller?.applicationId).to.equal('a');
      expect((b.results as Echo).caller?.applicationId).to.equal('b');
    });

    it('should return nothing for a request no call made', () => {
      expect(caller(create().request())).to.equal(undefined);
    });

    describe('identity fields in input', () => {
      const spoof = {
        profileId: 'someone-else',
        applicationId: 'other-app',
        sessionId: 'other-session',
        keep: 'me'
      };

      it('should strip them for a public caller', async () => {
        const ctx = create();
        echo(ctx);
        const result = await callTool(
          ctx, tool(), spoof, { kind: 'public', scopes: [] }
        );
        expect((result.results as Echo).input).to.deep.equal({ keep: 'me' });
      });

      it('should strip them for a person caller', async () => {
        const ctx = create();
        echo(ctx);
        const origin = ctx.request({ session: new Map() as never });
        const result = await callTool(
          ctx, tool(), spoof, { kind: 'person', profileId: 'p1', scopes: [] }, origin
        );
        expect((result.results as Echo).input).to.deep.equal({ keep: 'me' });
      });

      it('should overwrite them from an app caller', async () => {
        const ctx = create();
        echo(ctx);
        const result = await callTool(
          ctx,
          tool(),
          spoof,
          { kind: 'app', applicationId: 'app_1', scopes: [] }
        );
        //an app has no profile or session, so those spoofed fields are gone
        expect((result.results as Echo).input).to.deep.equal({
          keep: 'me',
          applicationId: 'app_1'
        });
      });

      it('should overwrite them from a user caller', async () => {
        const ctx = create();
        echo(ctx);
        const result = await callTool(
          ctx,
          tool(),
          spoof,
          {
            kind: 'user',
            profileId: 'profile_1',
            applicationId: 'app_1',
            sessionId: 'session_1',
            scopes: []
          }
        );
        expect((result.results as Echo).input).to.deep.equal({
          keep: 'me',
          profileId: 'profile_1',
          applicationId: 'app_1',
          sessionId: 'session_1'
        });
      });

      it('should keep identity fields that configured data sets', () => {
        const data = withToolData(
          tool({ data: { applicationId: 'configured' } }),
          { applicationId: 'input' },
          { kind: 'public', scopes: [] }
        );
        expect(data).to.deep.equal({ applicationId: 'configured' });
      });

      it('should not change the input object it was given', () => {
        const input = { ...spoof };
        withToolData(tool(), input, { kind: 'public', scopes: [] });
        expect(input).to.deep.equal(spoof);
      });
    });

    describe('person session forwarding', () => {
      //this event refuses unless its own request carries a signed-in session,
      // as an app event that reads its caller from the session would
      function guarded(ctx: ToolResolverServer) {
        ctx.on('guarded', ({ req, res }) => {
          const session = req.session.data;
          if (!session.token) {
            res.setError('Sign in first.', {}, [], 403);
            return;
          }
          res.results({
            actor: session.token,
            input: req.data(),
            caller: caller(req) || null,
            url: req.url.toString()
          });
        });
      }

      const person: Caller = {
        kind: 'person',
        profileId: 'profile-123',
        roles: [ 'USER' ],
        scopes: []
      };

      it('should carry the origin session and only the tool arguments', async () => {
        const ctx = create();
        guarded(ctx);
        //the origin is a chat request: its own body, query and headers must
        // not reach the tool
        const origin = ctx.request({
          url: 'http://example.test/agent/chat?leak=query',
          method: 'POST',
          data: { message: 'chat body', secret: 'chat-only' },
          post: { message: 'chat body', secret: 'chat-only' },
          headers: { cookie: 'session=cookie-value', authorization: 'Bearer x' },
          session: new Map([ [ 'token', 'signed-token' ] ])
        });

        const result = await callTool(
          ctx,
          tool({ event: 'guarded' }),
          { requestId: 'req-1' },
          person,
          origin
        );

        expect(result.code).to.equal(200);
        const seen = result.results as {
          actor: string,
          input: Record<string, unknown>,
          caller: Caller,
          url: string
        };
        expect(seen.actor).to.equal('signed-token');
        expect(seen.input).to.deep.equal({ requestId: 'req-1' });
        expect(seen.caller).to.deep.equal(person);
        //the address keeps its path and drops the query
        expect(seen.url).to.equal('http://example.test/agent/chat');
      });

      it('should never forward the origin request itself', async () => {
        const ctx = create();
        let received: unknown;
        ctx.on('capture', ({ req, res }) => {
          received = req;
          res.results({});
        });
        const origin = ctx.request({ session: new Map([ [ 'token', 't' ] ]) });
        await callTool(
          ctx, tool({ event: 'capture' }), {}, person, origin
        );
        expect(received).to.not.equal(origin);
      });

      it('should be refused by the event when the person is signed out', async () => {
        const ctx = create();
        guarded(ctx);
        const origin = ctx.request({ session: new Map() as never });
        const result = await callTool(
          ctx, tool({ event: 'guarded' }), {}, person, origin
        );
        expect(result.code).to.equal(403);
        expect(result.error).to.equal('Sign in first.');
      });

      it('should answer 401 for a person with no origin request', async () => {
        const ctx = create();
        guarded(ctx);
        const result = await callTool(
          ctx, tool({ event: 'guarded' }), {}, person
        );
        expect(result.code).to.equal(401);
      });

      it('should not give an app caller the origin session', async () => {
        const ctx = create();
        guarded(ctx);
        const origin = ctx.request({ session: new Map([ [ 'token', 't' ] ]) });
        const result = await callTool(
          ctx,
          tool({ event: 'guarded' }),
          {},
          { kind: 'app', applicationId: 'app_1', scopes: [] },
          origin
        );
        expect(result.code).to.equal(403);
      });
    });
  });

  describe('two loaded copies of the module', () => {
    //a plugin that imports this package as ESM while the server loads it as
    // CJS holds a second copy of the module. Contributions and caller records
    // must cross between the copies.
    async function copy() {
      return await import('../src/scripts/tools.js?second-copy') as typeof import('../src/scripts/tools.js');
    }

    it('should accept a contribution made through another copy', async () => {
      const other = await copy();
      expect(other.collectTools).to.not.equal(collectTools);
      const ctx = create();
      ctx.on(TOOLS_EVENT, ({ ctx }) => {
        other.contributeTool(ctx, { name: 'across', event: 'across' });
      });
      expect((await collectTools(ctx)).map(tool => tool.name))
        .to.deep.equal([ 'across' ]);
    });

    it('should read a caller record recorded through another copy', async () => {
      const other = await copy();
      const ctx = create();
      ctx.on('echo', ({ req, res }) => {
        res.results({ kind: other.caller(req)?.kind });
      });
      const result = await callTool(ctx, tool(), {}, { kind: 'public', scopes: [] });
      expect(result.results).to.deep.equal({ kind: 'public' });
    });

    it('should read an undoing record recorded through another copy, and the reverse', async () => {
      const other = await copy();
      const ctx = create();
      ctx.on('echo', ({ req, res }) => {
        res.results({ here: undoing(req)?.undoActionId, there: other.undoing(req)?.undoActionId });
      });
      const who: Caller = { kind: 'user', scopes: [] };
      const forward = await callTool(ctx, tool(), {}, who, undefined, undone);
      const back = await other.callTool(ctx, tool(), {}, who, undefined, undone);
      expect(forward.results).to.deep.equal({ here: 'undo_1', there: 'undo_1' });
      expect(back.results).to.deep.equal({ here: 'undo_1', there: 'undo_1' });
    });

    it('should add the undoing lookup to a store an earlier copy made without it', async () => {
      const key = Symbol.for('stackpress-ai.tools');
      const shared = (globalThis as Record<symbol, { undoings?: WeakMap<object, Undoing> }>)[key];
      const kept = shared.undoings;
      delete shared.undoings;
      try {
        await import('../src/scripts/tools.js?old-store');
        expect(shared.undoings).to.be.instanceOf(WeakMap);
      } finally {
        shared.undoings = kept;
      }
    });
  });

  describe('callerFromAuth', () => {
    it('should build a record for each verified kind', () => {
      expect(callerFromAuth()).to.deep.equal({ kind: 'public', scopes: [] });
      expect(callerFromAuth({ kind: 'public' }))
        .to.deep.equal({ kind: 'public', scopes: [] });
      expect(callerFromAuth({
        kind: 'app',
        token: { token: 'a:s', id: 'a', secret: 's' },
        application: createApplication({ id: 'app_9', scopes: [ 'x' ] })
      })).to.deep.equal({ kind: 'app', applicationId: 'app_9', scopes: [ 'x' ] });
      expect(callerFromAuth({
        kind: 'user',
        token: { token: 's:s', id: 's', secret: 's' },
        session: createSession({ scopes: [ 'y' ] })
      })).to.deep.equal({
        kind: 'user',
        profileId: 'profile_1',
        sessionId: 'session_1',
        applicationId: 'app_1',
        scopes: [ 'y' ]
      });
    });

    it('should build nothing for a key that failed verification', () => {
      expect(callerFromAuth({ kind: 'invalid' })).to.equal(null);
    });

    it('should copy the scopes so the record cannot change the key', () => {
      const application = createApplication({ scopes: [ 'x' ] });
      const record = callerFromAuth({
        kind: 'app',
        token: { token: 'a:s', id: 'a', secret: 's' },
        application
      })!;
      record.scopes.push('admin');
      expect(application.scopes).to.deep.equal([ 'x' ]);
    });
  });
});
