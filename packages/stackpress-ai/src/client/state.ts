//NOTE: Browser safe. The conversation as plain data, and the functions that
// turn what the routes report into it. No React in here.
import type {
  ActionItem,
  AgentEvent,
  AgentThread,
  CardStatus,
  Conversation,
  Item,
  ThreadAction,
  ThreadTurn
} from './types.js';

//--------------------------------------------------------------------//
// Constants

//the status a stored action stands at, as a card shows it
const STATUSES: Record<string, CardStatus> = {
  pending: 'waiting',
  approved: 'running',
  declined: 'declined',
  done: 'done',
  failed: 'failed',
  undone: 'undone',
  expired: 'expired'
};

//--------------------------------------------------------------------//
// Functions

export function emptyConversation(threadId?: string): Conversation {
  return { threadId, items: [], used: 0, finished: 0 };
}

/**
 * The name of a tool as a person reads it: `article_publish` is shown as
 * "Article publish".
 */
export function toolLabel(name: string) {
  const text = name.replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What a stored action's status is called on a card.
 */
export function cardStatus(status: string): CardStatus {
  return STATUSES[status] || 'failed';
}

/**
 * One line that says what a finished action produced, taken from the
 * first of the usual naming fields the result has. A result without any
 * gets no line, and is still available in full on the card.
 */
export function resultLine(result: unknown) {
  if (typeof result === 'string') return result.slice(0, 160);
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  for (const key of [ 'title', 'name', 'summary', 'message', 'comment', 'id' ]) {
    const value = record[key];
    if (typeof value === 'string' && value) return value.slice(0, 160);
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

/**
 * Add what the person typed.
 */
export function addUser(
  conversation: Conversation,
  text: string,
  files?: string[]
): Conversation {
  const id = `user-${conversation.items.length}`;
  const item: Item = files?.length
    ? { kind: 'user', id, text, files }
    : { kind: 'user', id, text };
  return { ...conversation, items: [ ...conversation.items, item ] };
}

/**
 * Take back the last thing the person typed, when it was not sent.
 */
export function dropLast(conversation: Conversation): Conversation {
  const items = conversation.items.slice();
  const last = items[items.length - 1];
  if (last?.kind === 'user') items.pop();
  return { ...conversation, items };
}

/**
 * Change one card, or nothing when there is no such card.
 */
export function patchAction(
  conversation: Conversation,
  id: string,
  patch: Partial<ActionItem>
): Conversation {
  let found = false;
  const items = conversation.items.map(item => {
    if (item.kind !== 'action' || item.id !== id) return item;
    found = true;
    return { ...item, ...patch };
  });
  return found ? { ...conversation, items } : conversation;
}

/**
 * End any message that was still arriving.
 */
export function settle(conversation: Conversation): Conversation {
  if (!conversation.items.some(item => item.kind === 'agent' && item.streaming)) {
    return conversation;
  }
  return {
    ...conversation,
    items: conversation.items.map(item => (
      item.kind === 'agent' && item.streaming
        ? { ...item, streaming: false }
        : item
    ))
  };
}

/**
 * Apply one report of a run. A message grows in place, so the page does not
 * rebuild what was already read. In `undo` mode the actions of the inverse
 * are not shown as cards of their own: the card undone says it all.
 */
export function applyEvent(
  conversation: Conversation,
  event: AgentEvent,
  mode: 'turn' | 'undo' = 'turn'
): Conversation {
  switch (event.type) {
    case 'thread':
      return {
        ...conversation,
        threadId: event.threadId,
        title: event.title
      };
    case 'text': {
      if (typeof event.text !== 'string' || !event.text) return conversation;
      const items = conversation.items.slice();
      const last = items[items.length - 1];
      if (last?.kind === 'agent' && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + event.text };
      } else {
        items.push({
          kind: 'agent',
          id: `agent-${items.length}`,
          text: event.text,
          streaming: true
        });
      }
      return { ...conversation, items };
    }
    case 'action-start':
    case 'action-waiting':
    case 'action-done':
    case 'action-failed': {
      if (typeof event.actionId !== 'string') return conversation;
      const known = conversation.items.some(
        item => item.kind === 'action' && item.id === event.actionId
      );
      if (mode === 'undo' && !known) return conversation;
      const patch: Partial<ActionItem> = {
        tool: event.tool,
        input: event.input && typeof event.input === 'object' ? event.input : {}
      };
      if (event.type === 'action-start') {
        patch.status = 'running';
      } else if (event.type === 'action-waiting') {
        patch.status = 'waiting';
        patch.expires = event.expires;
      } else if (event.type === 'action-done') {
        patch.status = 'done';
        patch.result = event.result;
        patch.undoable = event.undoable === true;
        patch.error = undefined;
      } else {
        patch.status = 'failed';
        patch.error = event.error;
        patch.undoable = false;
      }
      const base = settle(conversation);
      const next = known
        ? patchAction(base, event.actionId, patch)
        : {
          ...base,
          items: [
            ...base.items,
            {
              kind: 'action' as const,
              id: event.actionId,
              undoable: false,
              ...patch
            } as ActionItem
          ]
        };
      return event.type === 'action-done' && mode === 'turn'
        ? { ...next, finished: next.finished + 1 }
        : next;
    }
    case 'action-declined':
      return patchAction(settle(conversation), event.actionId, {
        status: 'declined',
        undoable: false
      });
    case 'action-undone':
      return patchAction(conversation, event.actionId, {
        status: 'undone',
        undoable: false,
        undoError: undefined
      });
    case 'usage':
      return {
        ...conversation,
        used: conversation.used
          + (Number(event.input) || 0)
          + (Number(event.output) || 0)
      };
    case 'error':
      return {
        ...conversation,
        failure: { status: event.status, resetsAt: event.resetsAt }
      };
    case 'finished':
      return { ...settle(conversation), ended: event.status };
    default:
      return conversation;
  }
}

/**
 * Build the conversation of a stored thread. Turns and actions are stored
 * apart, and a clock cannot be trusted to tell which came first, so the
 * order comes from how they are tied together: the turns are in the order the
 * server gave them, and each action goes right after the turn that asked for
 * it, as the live run showed it. An action with no turn to follow goes last.
 * The undo of an action is not a card of its own: the action it reversed
 * shows Undone.
 */
export function fromThread(
  thread: AgentThread,
  turns: ThreadTurn[],
  actions: ThreadAction[]
): Conversation {
  const items: Item[] = [];
  const shown = actions.filter(action => !action.reverses);
  const placed = new Set<string>();
  for (const turn of turns) {
    if (turn.role === 'user') {
      items.push({
        kind: 'user',
        id: turn.id,
        text: turn.text || '',
        ...(turn.files?.length ? { files: turn.files } : {})
      });
    } else if (turn.role === 'assistant' && turn.text) {
      items.push({ kind: 'agent', id: turn.id, text: turn.text });
    }
    for (const action of shown) {
      if (action.turnId === turn.id) {
        items.push(cardOf(action));
        placed.add(action.id);
      }
    }
  }
  for (const action of shown) {
    if (!placed.has(action.id)) items.push(cardOf(action));
  }
  return {
    threadId: thread.id,
    title: thread.title,
    items,
    used: 0,
    finished: 0
  };
}

/**
 * Bring the cards already on the page in line with what the server stores,
 * without touching any message. A card the page does not have is left out.
 */
export function syncActions(
  conversation: Conversation,
  actions: ThreadAction[]
): Conversation {
  const stored = new Map(
    actions.filter(action => !action.reverses).map(action => [ action.id, action ])
  );
  return {
    ...conversation,
    items: conversation.items.map(item => {
      const action = item.kind === 'action' ? stored.get(item.id) : undefined;
      return action ? { ...item, ...cardOf(action), busy: undefined } : item;
    })
  };
}

//--------------------------------------------------------------------//
// Helpers

function cardOf(action: ThreadAction): ActionItem {
  const input = action.input;
  const card: ActionItem = {
    kind: 'action',
    id: action.id,
    tool: action.tool,
    input: input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {},
    status: cardStatus(action.status),
    undoable: action.undoable === true && action.status === 'done'
  };
  if (action.result !== undefined && action.result !== null) {
    card.result = action.result;
  }
  if (action.error) card.error = action.error;
  if (action.expires) card.expires = String(action.expires);
  return card;
}
