//NOTE: Browser safe. The panel's own words for what the controller reports
// as codes. Each takes the translate function (`_` of `useLanguage()` in
// r22n), so every visible phrase goes through the same helper the rest of
// the app uses. The server's own words are never shown to a person.
import type { ActionItem, CardStatus, NoticeCode, Say } from './types.js';
import { toolLabel } from './state.js';

export type { Say };

//--------------------------------------------------------------------//
// Functions

/**
 * A time as the person's own locale writes it.
 */
export function when(time: string | undefined) {
  const date = new Date(time || '');
  if (!time || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

/**
 * What a short message above the composer says.
 */
export function noticeText(code: NoticeCode, _: Say) {
  switch (code) {
    case 'network':
      return _('The agent could not be reached. Check your connection and try again.');
    case 'csrf':
      return _('Your session needed refreshing. Send that again.');
    case 'invalid':
      return _('That could not be sent. Check it and try again.');
    case 'not-found':
      return _('That chat or action is no longer available.');
    case 'conflict':
      return _('That has already been handled.');
    case 'interrupted':
      return _('The connection dropped before the reply ended. What was saved is shown.');
    case 'settled':
      return _('That action was already answered. The card shows where it stands.');
    case 'steps':
      return _('The agent stopped after too many steps. Ask again to continue.');
    case 'length':
      return _('The reply was cut short.');
    case 'refusal':
      return _('The model declined to answer that.');
    case 'busy':
      return _('This chat is still working on something. Try again in a moment.');
    case 'attach-failed':
      return _('The file could not be attached.');
    case 'attach-limit':
      return _('No more files can be attached to one message.');
    case 'forbidden':
      return _('Your account does not have access to the agent.');
    default:
      return _('The agent could not finish that. Try again.');
  }
}

/**
 * What a screen reader is told when something changes.
 */
export function announceText(code: string, tool: string | undefined, _: Say) {
  const name = tool ? toolLabel(tool) : '';
  switch (code) {
    case 'sending':
      return _('Message sent.');
    case 'replied':
      return _('The agent replied.');
    case 'waiting':
      return _('Waiting for your approval: %s.', name);
    case 'done':
      return _('%s finished.', name);
    case 'failed':
      return _('%s failed.', name);
    case 'declined':
      return _('%s was declined.', name);
    case 'approving':
      return _('Approving %s.', name);
    case 'declining':
      return _('Declining %s.', name);
    case 'undoing':
      return _('Undoing %s.', name);
    case 'undone':
      return _('%s was undone.', name);
    case 'undo-refused':
      return _('%s could not be undone.', name);
    case 'attached':
      return _('File attached.');
    default:
      return '';
  }
}

/**
 * The status of a card in words, counting a request in flight.
 */
export function statusText(
  status: CardStatus,
  busy: ActionItem['busy'],
  _: Say
) {
  if (busy === 'approve') return _('Approving');
  if (busy === 'decline') return _('Declining');
  if (busy === 'undo') return _('Undoing');
  switch (status) {
    case 'running':
      return _('Running');
    case 'done':
      return _('Done');
    case 'failed':
      return _('Failed');
    case 'waiting':
      return _('Waiting for approval');
    case 'declined':
      return _('Declined');
    case 'expired':
      return _('Expired');
    default:
      return _('Undone');
  }
}
