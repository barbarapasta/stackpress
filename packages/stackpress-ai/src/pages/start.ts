//modules
import { action } from '@stackpress/ingest/Server';
//client
import type { CsrfPlugin } from '../types.js';
import { AGENT_EVENTS } from '../events/helpers.js';
import { answer, call } from './helpers.js';

/**
 * What the panel needs to start: an anti-forgery token, the models on
 * offer, and the person's remaining allowance.
 */
export default action(async function AgentStart({ ctx, req, res }) {
  const response = await call(ctx, req, res, AGENT_EVENTS.start);
  if (response === undefined) return;
  const results = response?.results as Record<string, unknown> | undefined;
  if (response && (response.code || 200) < 400 && results) {
    //the token already in the person's session is kept, so a second tab
    // does not spoil the first. Without the plugin there is no token, and
    // the write routes refuse
    const csrf = ctx.plugin<CsrfPlugin>('csrf');
    const name = ctx.config.path<string>('csrf.name', 'csrf');
    const kept = req.session.get(name);
    results.csrf = csrf
      ? {
        name,
        token: typeof kept === 'string' && kept
          ? kept
          : csrf.generate(res, ctx)
      }
      : null;
  }
  answer(res, response);
});
