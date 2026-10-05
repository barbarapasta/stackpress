//modules
import { undoing } from 'stackpress-ai';
import { action } from 'stackpress/server';
//app
import { adminRoute, authorize } from './access.js';

//--------------------------------------------------------------------//
// Constants

const STATUSES = [ 'DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED' ];

//--------------------------------------------------------------------//
// Events

//The events behind the agent tools that change records. The generated model
// events check nothing, so these ask for the access the admin page of the
// same action needs before they run one, and give them only the fields the
// change needs. A tool's input and fixed data never decide the change.

/**
 * Publish an article. The result keeps the status it had, which an undo needs.
 */
export const publish = action(async function ArticlePublish({ req, res, ctx }) {
  const id = req.data<string>('id');
  if (typeof id !== 'string' || !id) {
    res.setError('Invalid Parameters', { id: 'Missing or invalid value' })
      .statusCode(400, 'Bad Request');
    return;
  }
  const verdict = await authorize(ctx, req, adminRoute(ctx, 'article', 'update', id));
  if (!verdict.allowed) {
    res.setError(verdict.error).statusCode(verdict.code, verdict.status);
    return;
  }
  const found = await ctx.resolve<{ status?: string }>(
    'article-get',
    ctx.request({ data: { key: 'id', value: id } })
  );
  if (found.code !== 200 || !found.results) {
    res.setError('Not Found').statusCode(404, 'Not Found');
    return;
  }
  const updated = await ctx.resolve(
    'article-update',
    ctx.request({ data: { id, status: 'PUBLISHED' } })
  );
  if (updated.code !== 200) {
    res.fromStatusResponse(updated);
    return;
  }
  res.results({ id, status: 'PUBLISHED', previous: found.results.status });
});

/**
 * Move an article out of publication. Only an undo runs it as a tool: it puts
 * back the status that the publish found, or draft when it is not known.
 */
export const unpublish = action(async function ArticleUnpublish({ req, res, ctx }) {
  const id = req.data<string>('id');
  if (typeof id !== 'string' || !id) {
    res.setError('Invalid Parameters', { id: 'Missing or invalid value' })
      .statusCode(400, 'Bad Request');
    return;
  }
  const verdict = await authorize(ctx, req, adminRoute(ctx, 'article', 'update', id));
  if (!verdict.allowed) {
    res.setError(verdict.error).statusCode(verdict.code, verdict.status);
    return;
  }
  const result = undoing(req)?.original.result as { previous?: string } | undefined;
  const status = result?.previous && STATUSES.includes(result.previous)
    ? result.previous
    : 'DRAFT';
  const found = await ctx.resolve(
    'article-get',
    ctx.request({ data: { key: 'id', value: id } })
  );
  if (found.code !== 200 || !found.results) {
    res.setError('Not Found').statusCode(404, 'Not Found');
    return;
  }
  const updated = await ctx.resolve(
    'article-update',
    ctx.request({ data: { id, status } })
  );
  if (updated.code !== 200) {
    res.fromStatusResponse(updated);
    return;
  }
  res.results({ id, status });
});

/**
 * Remove a comment. It has no undo.
 */
export const remove = action(async function CommentRemove({ req, res, ctx }) {
  const id = req.data<string>('id');
  if (typeof id !== 'string' || !id) {
    res.setError('Invalid Parameters', { id: 'Missing or invalid value' })
      .statusCode(400, 'Bad Request');
    return;
  }
  const verdict = await authorize(ctx, req, adminRoute(ctx, 'comment', 'remove', id));
  if (!verdict.allowed) {
    res.setError(verdict.error).statusCode(verdict.code, verdict.status);
    return;
  }
  const found = await ctx.resolve(
    'comment-get',
    ctx.request({ data: { key: 'id', value: id } })
  );
  if (found.code !== 200 || !found.results) {
    res.setError('Not Found').statusCode(404, 'Not Found');
    return;
  }
  const removed = await ctx.resolve(
    'comment-remove',
    ctx.request({ data: { id } })
  );
  if (removed.code !== 200) {
    res.fromStatusResponse(removed);
    return;
  }
  res.results({ id });
});
