//node
import { randomUUID } from 'node:crypto';
//modules
import type { HttpServer } from '@stackpress/ingest';
import type { DesktopMenuContribution } from 'stackpress-desktop/types';
import { caller, contributeTool, undoing } from 'stackpress-ai';
import { contributeDesktopMenu } from 'stackpress-desktop/plugin';
//app
import type { Config } from '../../config/common.js';
import { tools, useOffline } from './agent.js';
import { publish, remove, unpublish } from './events.js';
import oauth from './oauth.js';

const desktopMenu: DesktopMenuContribution = {
  id: 'blog:open-latest-posts',
  menu: 'help',
  label: 'Open Latest Posts',
  //Not `blog:desktop-open-latest-posts`: Ingest's ExpressEmitter (used
  //for every `server.on`/`resolve` event, not only HTTP routes) treats
  //any `:word` inside a registered name as a route-style variable
  //placeholder and rewrites the whole registration into a wildcard
  //pattern. A colon-containing name whose prefix is shared by another
  //real event (here, both this event and the OAuth policy listeners
  //`blog-oauth-approval`/`blog-oauth-access` start with "blog" and
  //contain no `/`) silently matches and runs on that other event too,
  //letting this handler's `res.results()` clobber the real one's -
  //found while 00011 verified the real OAuth approval flow against this
  //example app, where the desktop-menu handler's result was silently
  //overwriting every `blog-oauth-approval`/`blog-oauth-access` call.
  event: 'blog-desktop-open-latest-posts',
  priority: 20
};

const desktopMenuContributed = new WeakSet<object>();

//this tool is offered to MCP callers by the plugin itself, so the `mcp.tools`
// config has no entry for it.
const siteInfoTool = {
  name: 'blog_site_info',
  title: 'Blog Site Info',
  description: 'Returns the blog name and who the tool call came from.',
  type: 'public' as 'public',
  method: 'GET' as 'GET',
  event: 'app-site-info'
};

export default function plugin(server: HttpServer<Config>) {
  //native MCP/API OAuth policy listeners (spec 00005)
  oauth(server);
  server.on('listen', async _ => {
    //on error, show error page
    server.on('error', () => import('./pages/error.js'));
    //on response, check for errors
    server.on('response', async ({ req, res, ctx }) => {  
      if (res.error) {
        await ctx.emit('error', req, res);
      }
    });
    server.on('desktop:menu', ({ ctx }) => {
      if (desktopMenuContributed.has(ctx)) {
        return;
      }
      contributeDesktopMenu(ctx, desktopMenu);
      desktopMenuContributed.add(ctx);
    });
    server.on('ai-tools', ({ ctx }) => {
      contributeTool(ctx, siteInfoTool);
      //the tools the built-in agent may use
      for (const tool of tools) {
        contributeTool(ctx, tool);
      }
    });
    //the events behind the agent tools that change records
    server.on('app-article-publish', publish);
    server.on('app-article-unpublish', unpublish);
    server.on('app-comment-remove', remove);
    server.on('app-site-info', ({ req, res, ctx }) => {
      res.results({
        name: ctx.config.path('mcp.name', 'Blog'),
        caller: caller(req)?.kind || null
      });
    });
    //the sample receipt pair of agent.ts. Issuing makes a number, and its
    // operation identifier is a new one each time. Like the other sample
    // events they store nothing and check nothing; an app's own events check
    // that this person may do this
    server.on('app-receipt-issue', ({ req, res }) => {
      const article = req.data<string>('article');
      res.results({
        receipt: `R-${randomUUID().slice(0, 8)}`,
        article,
        operation: `issue-${randomUUID()}`
      });
    });
    //an undo reads what it is undoing from the record, not from its input,
    // which is only the original's stored input. The record is undefined on
    // any other call of this event
    server.on('app-receipt-void', ({ req, res }) => {
      const told = undoing(req);
      if (!told) {
        res.setError('A receipt is voided only by undoing its issue.', {}, [], 409);
        return;
      }
      const issued = told.original.result as { receipt: string };
      res.results({
        voided: issued.receipt,
        //a stable identifier for this command, derived from the undo action
        operation: `void-${told.undoActionId}`,
        told
      });
    });
    server.on('blog-desktop-open-latest-posts', ({ res }) => {
      res.results({ desktopEvent: 'blog-desktop-open-latest-posts' });
    });
  });
  server.on('route', async _ => {
    //with no provider key set, the agent answers with an offline model
    if (server.config.has('agent')) {
      useOffline(server);
    }

    server.import.get('/', () => import('./pages/home.js'));
    server.view.get('/', '@/plugins/app/views/home');

    server.import.get('/articles/:slug', () => import('./pages/article.js'));
    server.view.get('/articles/:slug', '@/plugins/app/views/article');
  });
};
