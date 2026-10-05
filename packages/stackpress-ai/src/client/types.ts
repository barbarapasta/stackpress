//NOTE: Types only, and only from the package's own type file. These need
// to be client/browser safe.
import type {
  AgentEvent,
  AgentModelConfig,
  AgentThread,
  RefusalReason,
  ThreadAction,
  ThreadTurn,
  TurnStatus
} from '../types.js';

export type {
  AgentEvent,
  AgentModelConfig,
  AgentThread,
  RefusalReason,
  ThreadAction,
  ThreadTurn,
  TurnStatus
};

//--------------------------------------------------------------------//
// Route client

//the anti-forgery token the start route hands out, and the field name a
// write sends it back under
export type Csrf = { name: string, token: string };

export type Usage = {
  used: number,
  limit?: number,
  remaining?: number,
  resetsAt?: string
};

export type StartInfo = {
  models: AgentModelConfig[],
  model: string,
  usage: Usage,
  csrf: Csrf | null
};

//why a request failed, as far as the panel is concerned. The words of the
// server's answer are never kept: a person sees the panel's own phrase for
// the reason
export type Reason
  = RefusalReason
  | 'forbidden'
  | 'network'
  | 'aborted'
  | 'unknown';

export type Failure = {
  ok: false,
  status: number,
  reason: Reason,
  resetsAt?: string
};

export type Fetch = (
  input: string,
  init?: {
    method?: string,
    headers?: Record<string, string>,
    body?: string,
    credentials?: 'same-origin' | 'include' | 'omit',
    signal?: AbortSignal
  }
) => Promise<Response>;

export type ClientOptions = {
  //where the chat routes are mounted. Defaults to `/agent`
  base?: string,
  //defaults to the browser's `fetch`
  fetch?: Fetch,
  //ask for an event stream on a message and an approval. Defaults to true
  stream?: boolean
};

export type SendBody = {
  threadId?: string,
  message: string,
  model?: string,
  files?: string[],
  context?: { url?: string, items?: unknown[] }
};

export type Sent = {
  ok: true,
  //false when a stream ended before its `finished` event
  finished: boolean,
  //the single-response answer, when the server did not stream
  results?: Record<string, unknown>
};

//--------------------------------------------------------------------//
// Conversation

//one thing the app says the page is about. A string, or an object whose
// `label` names it on its chip
export type ContextItem = string | { label?: string, [key: string]: unknown };

export type CardStatus
  = 'running'
  | 'done'
  | 'failed'
  | 'waiting'
  | 'declined'
  | 'expired'
  | 'undone';

export type MessageItem = {
  kind: 'user' | 'agent',
  id: string,
  text: string,
  files?: string[],
  //true while text is still arriving
  streaming?: boolean
};

export type ActionItem = {
  kind: 'action',
  id: string,
  tool: string,
  input: Record<string, unknown>,
  status: CardStatus,
  result?: unknown,
  error?: string,
  //only set from what the server says
  undoable: boolean,
  expires?: string | null,
  //a request from this card's own buttons is in flight
  busy?: 'approve' | 'decline' | 'undo',
  //why the last undo did not happen
  undoError?: string
};

export type Item = MessageItem | ActionItem;

export type Conversation = {
  threadId?: string,
  title?: string,
  items: Item[],
  //tokens the run reported, to keep the allowance honest
  used: number,
  //actions that finished during the run
  finished: number,
  //how the run ended, when it did
  ended?: TurnStatus,
  //an error event of the run
  failure?: { status: TurnStatus, resetsAt?: string }
};

//--------------------------------------------------------------------//
// Panel

export type Phase
  = 'idle'
  | 'loading'
  | 'ready'
  | 'signed-out'
  | 'unavailable'
  | 'limit';

//a short message above the composer. The panel turns the code into words
export type NoticeCode
  = 'network'
  | 'csrf'
  | 'invalid'
  | 'not-found'
  | 'conflict'
  | 'failed'
  | 'interrupted'
  | 'settled'
  | 'steps'
  | 'length'
  | 'refusal'
  | 'busy'
  | 'attach-failed'
  | 'attach-limit'
  | 'forbidden';

export type Notice = { code: NoticeCode };

//a chip on the context bar
export type Chip = { key: string, label: string };

export type FileChip = { ref: string, name: string };

//what the app's upload handler may answer with: the reference to the stored
// file, and optionally the name to show
export type Uploaded = string | { ref: string, name?: string };

export type Upload = (file: File) => Promise<Uploaded>;

export type Threads = {
  status: 'idle' | 'loading' | 'ready' | 'error',
  rows: AgentThread[]
};

export type PanelState = {
  open: boolean,
  phase: Phase,
  view: 'chat' | 'history',
  models: AgentModelConfig[],
  model: string,
  usage?: Usage,
  //when a daily limit resets
  resetsAt?: string,
  conversation: Conversation,
  running: boolean,
  threads: Threads,
  url?: string,
  context: ContextItem[],
  removed: string[],
  files: FileChip[],
  uploading: boolean,
  draft: string,
  notice?: Notice,
  //something for a screen reader to say. `seq` makes a repeat count
  announce?: { code: string, tool?: string, seq: number },
  //the card to move focus to
  focus?: { id: string, seq: number }
};

export type PanelOptions = {
  //where the chat routes are mounted. Defaults to `/agent`
  base?: string,
  //the page address the agent is told about. Defaults to the browser's
  url?: string,
  //what the page declares itself to be about
  context?: ContextItem[],
  //false when nobody is signed in: the panel then asks for a sign in and
  // makes no request
  signedIn?: boolean,
  //turns a file the person picked into a reference the app stored. The
  // panel never uploads. Without it there is no attach control
  upload?: Upload,
  //called after an action finished so the page shows what changed.
  // Defaults to reloading the page
  onRefresh?: () => void | Promise<void>,
  //open the panel when it is first drawn
  defaultOpen?: boolean,
  fetch?: Fetch,
  stream?: boolean,
  //where the panel keeps its place across a reload. Defaults to the
  // browser's session storage; `null` keeps nothing
  storage?: Memory | null
};

export type Memory = {
  getItem(key: string): string | null,
  setItem(key: string, value: string): void,
  removeItem(key: string): void
};

//--------------------------------------------------------------------//
// View

//the translate function of `useLanguage()` in r22n
export type Say = (phrase: string, ...variables: (string | number)[]) => string;

//what the components may ask the panel to do. Each is a request: what
// the server answers is what the page then shows
export type PanelActions = {
  toggle(): void,
  close(): void,
  retry(): void,
  newChat(): void,
  showHistory(): void,
  showChat(): void,
  openThread(id: string): void,
  send(text?: string): void,
  approve(id: string): void,
  decline(id: string): void,
  undo(id: string): void,
  removeContext(key: string): void,
  setDraft(text: string): void,
  setModel(model: string): void,
  dismiss(): void,
  attach(file: File): void,
  removeFile(ref: string): void
};

//what the drawing needs, besides the state: the words, the actions, and
// the places the container reaches into the page for focus and scrolling
export type ViewProps = {
  state: PanelState,
  actions: PanelActions,
  _: Say,
  //where a signed-out person goes to sign in
  signInUrl: string,
  //prompts offered on an empty chat
  starters: string[],
  //false when the app gave no upload handler: there is then no control
  canAttach: boolean,
  refs?: {
    launcher?: { current: HTMLButtonElement | null },
    panel?: { current: HTMLElement | null },
    composer?: { current: HTMLTextAreaElement | null },
    thread?: { current: HTMLDivElement | null }
  },
  onScroll?: () => void,
  //shown on the "jump to latest" button when the person has scrolled up
  //and something new arrived
  behind?: boolean,
  jump?: () => void
};
