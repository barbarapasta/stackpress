//Seeds the blog's development database through the agent store, so the
//generated admin list of agent actions has rows to show. Every row is written
//by createStore(); nothing is inserted by hand. Run it from templates/blog
//after `yarn blog push`, with the server stopped (PGlite allows one process):
//  cp <this file> templates/blog/zz-seed-agent-actions.ts
//  yarn --cwd templates/blog tsx zz-seed-agent-actions.ts
import bootstrap from './config/develop.js';
import { createStore } from 'stackpress-ai';

const server = await bootstrap();
const ctx = server as any;

//the clock the store reads, moved by hand so the rows span a working morning
let at = Date.now() - 6 * 3600 * 1000;
const store = createStore(ctx, { now: () => new Date(at), approvalTtl: 15 * 60 * 1000 });
const after = (minutes: number) => { at += minutes * 60 * 1000; };

async function person(name: string, roles: string[]) {
  const made = await ctx.resolve('profile-create', { name, type: 'person', roles });
  return made.results.id as string;
}

//who signs in to the admin, and the two people the agent acts for
const admin = await person('Evidence Admin', [ 'ADMIN' ]);
await ctx.resolve('auth-create', {
  profileId: admin, type: 'username', token: 'evidence-admin',
  secret: 'evidence-pass-123', verified: true
});
const maria = await person('Maria Santos', [ 'USER' ]);
const jun = await person('Jun Reyes', [ 'USER' ]);

//one assistant turn that asked for an action, then the action itself
async function ask(profileId: string, threadId: string, text: string) {
  return store.appendTurn(threadId, profileId, { role: 'assistant', text, provider: 'openrouter', model: 'claude-sonnet-5-5', inputTokens: 900, outputTokens: 120 });
}

async function run(
  profileId: string, threadId: string, turnId: string,
  tool: string, event: string, input: Record<string, unknown>,
  how: { irreversible?: boolean, operation?: string, reverses?: string },
  end: 'done' | 'failed' | 'declined' | 'pending',
  detail?: string
) {
  const action = await store.createAction({ threadId, turnId, profileId, tool, event, input, ...how });
  after(2);
  if (end === 'pending') return action;
  if (end === 'declined') {
    await store.declineAction(action.id, profileId, detail);
    return action;
  }
  const approval = await store.approveAction(action.id, profileId);
  after(1);
  await store.completeAction(action.id, approval!.claim!, end === 'done'
    ? { status: 'done', result: { ok: true }, operation: how.operation }
    : { status: 'failed', error: detail });
  return action;
}

//Maria: closing out approvals
const mt = await store.createThread({ profileId: maria, title: 'Close out Friday approvals', model: 'claude-sonnet-5-5' });
await store.appendTurn(mt.id, maria, { role: 'user', text: 'Approve request 4412 and tidy the old drafts.' });
after(1);
const m1 = await ask(maria, mt.id, 'I will approve request 4412 first.');
const approved = await run(maria, mt.id, m1.id, 'approve_request', 'approval-approve', { requestId: 'REQ-4412' }, { irreversible: true, operation: 'approval-4412' }, 'done');
after(5);
const m2 = await ask(maria, mt.id, 'Archiving the stale draft now.');
const archived = await run(maria, mt.id, m2.id, 'archive_article', 'article-archive', { slug: 'old-launch-notes' }, { operation: 'archive-8841' }, 'done');
after(4);
await store.markUndone(archived.id, maria);
await run(maria, mt.id, m2.id, 'restore_article', 'article-restore', { slug: 'old-launch-notes' }, { reverses: archived.id, operation: 'restore-8841' }, 'done');
after(7);
const m3 = await ask(maria, mt.id, 'I can delete the flagged comment, but it cannot be undone.');
await run(maria, mt.id, m3.id, 'delete_comment', 'comment-delete', { commentId: 'c-2291' }, { irreversible: true }, 'declined', 'Not now, leave it for moderation.');

//Jun: publishing
after(25);
const jt = await store.createThread({ profileId: jun, title: 'Publish the October articles', model: 'claude-sonnet-5-5' });
await store.appendTurn(jt.id, jun, { role: 'user', text: 'Publish the October articles and remove the duplicate.' });
after(1);
const j1 = await ask(jun, jt.id, 'Publishing the first article.');
await run(jun, jt.id, j1.id, 'publish_article', 'article-publish', { slug: 'october-roundup' }, { operation: 'publish-3310' }, 'done');
after(6);
await run(jun, jt.id, j1.id, 'publish_article', 'article-publish', { slug: 'draft-without-category' }, {}, 'failed', 'Article has no category.');
after(9);
const j2 = await ask(jun, jt.id, 'Deleting the duplicate article is permanent. Approve to continue.');
await run(jun, jt.id, j2.id, 'delete_article', 'article-delete', { slug: 'october-roundup-copy' }, { irreversible: true }, 'pending');
//Jun changes their mind in a new message, which ends the wait
after(3);
await store.appendTurn(jt.id, jun, { role: 'user', text: 'Actually, keep the copy for now.' });
after(2);
const j3 = await ask(jun, jt.id, 'Understood. Removing the spam comment instead; this needs approval too.');
await run(jun, jt.id, j3.id, 'delete_comment', 'comment-delete', { commentId: 'c-2305' }, { irreversible: true }, 'pending');

//what the providers reported for those turns, added to each person's day
await store.addUsage(maria, { inputTokens: 4200, outputTokens: 610, turns: 3 });
await store.addUsage(jun, { inputTokens: 3100, outputTokens: 480, turns: 3 });
await store.addUsage(jun, { inputTokens: 900, outputTokens: 120, turns: 1 });

console.log('seeded', { admin, maria, jun, approved: approved.id });
process.exit(0);
