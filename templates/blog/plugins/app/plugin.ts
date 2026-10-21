//modules
import type { HttpServer } from '@stackpress/ingest';
import type { DesktopMenuContribution } from 'stackpress-desktop/types';
import { contributeDesktopMenu } from 'stackpress-desktop/plugin';
import type { Config } from '../../config/common.js';
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

export default function plugin(server: HttpServer<Config>) {
  //native MCP/API OAuth policy listeners (spec 00004)
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
    server.on('blog-desktop-open-latest-posts', ({ res }) => {
      res.results({ desktopEvent: 'blog-desktop-open-latest-posts' });
    });
  });
  server.on('route', async _ => {
    server.import.get('/', () => import('./pages/home.js'));
    server.view.get('/', '@/plugins/app/views/home');

    server.import.get('/articles/:slug', () => import('./pages/article.js'));
    server.view.get('/articles/:slug', '@/plugins/app/views/article');
  });
};
