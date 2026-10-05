//modules
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type Server from '@stackpress/ingest/Server';
import type { Application, Session } from 'stackpress-api/types';

//this exported schema alias keeps config serializable while still letting the
// package treat tool input and output contracts as JSON Schema documents.
export type JsonSchema = Record<string, unknown>;

//this token shape is shared by auth helpers once a bearer header is parsed and
// split into its public id and optional secret.
export type Token = {
  token: string,
  id: string,
  secret: string
};

//this small promise wrapper keeps the long-running transport scripts attached
// to the CLI command until the underlying network server closes.
export type Promiser<T = void> = {
  resolve: (value: T | PromiseLike<T>) => void,
  reject: (reason?: unknown) => void
};

//this mode tells the HTTP transport whether MCP sessions are persisted across
// requests or rebuilt for each request.
export type McpSessionMode = 'stateful' | 'stateless';

//this config shape describes the top-level MCP settings that Stackpress reads
// when it builds transport servers and registers tools from config.
export type McpConfig = {
  description?: string,
  host?: string,
  mode?: McpSessionMode,
  messages?: string,
  name?: string,
  port?: number,
  route?: string,
  sse?: {
    host?: string,
    key?: string,
    port?: number,
    route?: string
  },
  title?: string,
  tools?: ToolConfig[],
  version?: string
};

//this is the serializable tool config contract that template configs and
// plugin-resolved tool definitions must satisfy.
export type ToolConfig = {
  mode?: 'event' | 'plugin',
  type?: 'public' | 'app' | 'user',
  name?: string,
  title?: string,
  description?: string,
  method?: string,
  input?: JsonSchema,
  output?: JsonSchema,
  event: string,
  scopes?: string[],
  data?: Record<string, unknown>,
  //the name of the tool that reverses this one, which lets the person undo it
  inverse?: string,
  //a tool that cannot be reversed pauses for approval and shows no undo. A
  // write tool with neither an inverse nor this mark is treated the same way.
  irreversible?: boolean,
  //whether the built-in agent is offered this tool. Off unless set.
  agent?: boolean,
  //a dotted path into the event's results that holds the app's own
  // identifier for what changed, which the agent logs with the action.
  // Defaults to `operation`
  operation?: string
};

//this normalized tool shape is what the runtime keeps after defaults,
// inference, and validation have already been applied.
export type NormalizedToolConfig = ToolConfig & {
  mode: 'event',
  type: 'public' | 'app' | 'user',
  name: string,
  title: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  scopes: string[],
  data: Record<string, unknown>
};

//this auth union keeps the live caller context attached to either an
// application session, a user session, or no identity at all. The invalid
// kind marks a key that was presented but failed verification, so it is
// refused instead of being downgraded to a public caller.
export type AuthContext
  = { kind: 'public' }
  | { kind: 'invalid' }
  | { kind: 'app', token: Token, application: Application }
  | { kind: 'user', token: Token, session: Session };

//this caller record is what a tool event is told about who is calling. It is
// built by the system after the key or sign-in was checked and is kept apart
// from tool input, which can never set or override it. Read it from the
// request with the caller() helper.
export type Caller = {
  kind: 'public' | 'app' | 'user' | 'person',
  profileId?: string,
  sessionId?: string,
  applicationId?: string,
  roles?: string[],
  scopes: string[]
};

//this undoing record is what an inverse tool's event is told about the action
// it is undoing. Like the caller record it is built by the system, only while
// an undo runs, and kept apart from the tool input, which can never set it.
// The inverse still gets the original's stored input as its input. Read the
// record from the request with the undoing() helper.
export type Undoing = {
  //the action the undo is logged as. It exists before the inverse runs, and
  // an undo is claimed once, so an app can derive a stable operation
  // identifier for its own command from it
  undoActionId: string,
  //the action being undone, as the store returns it to callers
  original: {
    id: string,
    tool: string,
    input: Record<string, unknown>,
    //what the original's event returned, or undefined when it returned nothing
    result?: unknown,
    //the operation identifier captured on the original, if its tool names one
    operation: string | null
  }
};

//this result is what the shared execution path returns for one tool call.
export type ToolResult = {
  code: number,
  status?: string,
  results?: unknown,
  error?: string
};

//this loader returns the full normalized tool registry, before any per-caller
// filtering, so transports can tell a forbidden tool from a missing one.
export type ToolRegistry = () => Promise<NormalizedToolConfig[]>;

//this factory contract is what Stackpress stores under ctx.register('mcp')
// so transports can request a fresh MCP server on demand for one resolved
// caller auth context.
export type McpPlugin = (auth?: AuthContext) => Promise<McpServer | null>;

//this HTTP session shape keeps one MCP server paired with one transport so
// later requests can route back to the same live session.
export type McpHttpSession = {
  auth: AuthContext,
  server: McpServer,
  transport: StreamableHTTPServerTransport
};

//this SSE session shape mirrors the HTTP session pairing but uses the older
// SSE transport contract.
export type McpSseSession = {
  auth: AuthContext,
  server: McpServer,
  transport: SSEServerTransport
};

//this resolve response keeps the helper boundary aligned with Stackpress
// resolve() calls that may or may not return results.
export type ResolvedResponse<T> = {
  results?: T
};

export type { McpServer };

//this server contract narrows Stackpress with the resolve() shape that the
// ai package depends on when it builds tools and serves calls.
export type ToolResolverServer = Server & {
  resolve<T = unknown>(
    event: string,
    payload?: Record<string, unknown> | ToolRequest
  ): Promise<(ResolvedResponse<T> & {
    code?: number,
    status?: string,
    error?: string
  }) | null>
};

//this request shape is whatever the server builds with ctx.request()
export type ToolRequest = ReturnType<Server['request']>;

//this generated client tools shape is what the ai runtime looks for after the
// client package has been produced by the idea pipeline.
export type ClientTools = {
  listen: (server: Server) => void
};

//this generated client contract extends the normal client plugin surface with
// the optional top-level tools registry emitted by the ai transform.
export type Client = {
  tools?: ClientTools
};

//this plugin shape is what ctx.plugin('client') returns once the generated
// client package can be imported.
export type ClientPlugin = (nullable?: boolean) => Promise<Client | null>;

//--------------------------------------------------------------------//
// Agent records

//this status is where a stored action stands. Only a pending action can be
// approved, declined, or expired.
export type ActionStatus =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'done'
  | 'failed'
  | 'undone'
  | 'expired';

//these record shapes mirror the models in schema.idea as the generated
// events return them.
export type AgentThread = {
  id: string,
  profileId: string,
  title: string,
  model?: string | null,
  active: boolean,
  created: Date | string,
  updated: Date | string
};

export type AgentTurn = {
  id: string,
  threadId: string,
  role: string,
  text?: string | null,
  toolCalls?: unknown,
  toolResults?: unknown,
  files?: string[],
  provider?: string | null,
  model?: string | null,
  raw?: string | null,
  inputTokens: number,
  outputTokens: number,
  created: Date | string
};

export type AgentAction = {
  id: string,
  threadId: string,
  turnId: string,
  profileId: string,
  tool: string,
  event: string,
  input?: unknown,
  status: ActionStatus,
  result?: unknown,
  error?: string | null,
  operation?: string | null,
  reverses?: string | null,
  irreversible: boolean,
  claim?: string | null,
  //the message the action was proposed under, and the digest of the tool's
  // execution contract at that time. Both are kept by the store
  epoch?: string | null,
  contract?: string | null,
  expires?: Date | string | null,
  created: Date | string,
  updated: Date | string
};

export type AgentUsage = {
  id: string,
  profileId: string,
  day: string,
  inputTokens: number,
  outputTokens: number,
  turns: number,
  created: Date | string,
  updated: Date | string
};

//a lock the store keeps for the agent: the one provider call at a time a
// person may have under a daily limit, or the right to store a message or run
// an approved action in a thread. Only the store reads or changes it
export type AgentLock = {
  id: string,
  profileId: string,
  holder?: string | null,
  epoch?: string | null,
  since?: Date | string | null,
  created: Date | string,
  updated: Date | string
};

//this is the part of the database plugin the store needs for the claims
// that a generated event cannot make atomic. It is the inquire engine.
export type StoreEngine = {
  dialect: { q: string },
  query(query: string, values?: unknown[]): Promise<unknown[]>
};

//these options are plain arguments, so the store never reads agent config
export type StoreOptions = {
  //how long a pending approval stays valid, in milliseconds. Without one
  // a pending approval only expires when a new message arrives
  approvalTtl?: number,
  //the clock, so tests and callers control "now"
  now?: () => Date
};

//--------------------------------------------------------------------//
// Provider adapters

//this is one tool the model may call, in the neutral shape every adapter
// translates into its provider's wire format.
export type AdapterTool = {
  name: string,
  description: string,
  input: JsonSchema
};

//this is one call the model asked for. The id is the provider's own call
// identifier and is what the matching result must answer.
export type AdapterToolCall = {
  id: string,
  name: string,
  input: Record<string, unknown>
};

//this is the answer to one call. Every result of one step travels together
// in one tool turn.
export type AdapterToolResult = {
  id: string,
  name: string,
  output: string,
  isError?: boolean
};

//this is what was spent on one reply, counted in tokens.
export type AdapterUsage = {
  input: number,
  output: number
};

//why a reply ended. 'tools' means the model is waiting for tool results,
// 'length' means it ran out of room, 'refusal' means the provider declined,
// and 'pause' means the provider paused a turn that can be resumed.
export type AdapterStop = 'end' | 'tools' | 'length' | 'refusal' | 'pause';

//this is the adapter's own record of a reply. Only the adapter that wrote it
// reads it, and only for the same model, so the same reply can be sent back
// unchanged. Everything in it must survive JSON.
export type AdapterRaw = {
  provider: string,
  model: string,
  [key: string]: unknown
};

//a transcript is append-only. An assistant turn keeps the neutral fields for
// any adapter plus the raw record for the adapter that wrote it. A null raw
// marks a reply that must never be replayed as it came back (a refused or cut
// off one), so it is rebuilt from the neutral fields instead.
export type AdapterTurn
  = { role: 'user', text: string }
  | {
    role: 'assistant',
    text: string,
    toolCalls: AdapterToolCall[],
    usage: AdapterUsage,
    raw: AdapterRaw | null
  }
  | { role: 'tool', results: AdapterToolResult[] };

//this is what the runtime hands an adapter for one model call. The optional
// callback receives text as it is generated and never changes the reply.
export type AdapterRequest = {
  system: string,
  tools: AdapterTool[],
  turns: AdapterTurn[],
  onText?: (text: string) => void
};

//this is what an adapter answers with.
export type AdapterReply = {
  text: string,
  toolCalls: AdapterToolCall[],
  stop: AdapterStop,
  usage: AdapterUsage,
  raw: AdapterRaw | null
};

//this is the one contract the conversation loop talks to. The loop never
// reads which provider is behind it.
export type Adapter = {
  provider: string,
  model: string,
  send(request: AdapterRequest): Promise<AdapterReply>
};

//this is the kind of failure a provider reported, as the runtime tells them
// apart: wait and retry, fix the key, show a refusal, or give up.
export type ProviderErrorKind
  = 'rate_limit'
  | 'authentication'
  | 'refusal'
  | 'other';

//a fetch the SDK should use instead of its own, which is how tests hand the
// real SDK canned replies.
export type AdapterFetch = (
  url: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

//these options are shared by every adapter that talks to a provider
export type ProviderOptions = {
  apiKey?: string,
  fetch?: AdapterFetch,
  maxTokens?: number
};

export type AnthropicOptions = ProviderOptions & {
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  model?: string
};

export type OpenAIOptions = ProviderOptions & {
  model?: string
};

//OpenRouter reaches many providers, so there is no default model
export type OpenRouterOptions = ProviderOptions & {
  model: string
};

//one scripted answer. Unset fields default to a plain finished text reply.
export type StubReply = {
  text?: string,
  toolCalls?: AdapterToolCall[],
  stop?: AdapterStop,
  usage?: AdapterUsage
};

//the stub answers each call from the next script entry. An Error entry is
// thrown, which is how a test makes the provider fail.
export type StubOptions = {
  model?: string,
  replies?: (StubReply | Error)[]
};

//this is the config the adapter chooser reads. Each variant carries only the
// options its provider understands.
export type AdapterConfig
  = ({ provider: 'anthropic' } & AnthropicOptions)
  | ({ provider: 'openai' } & OpenAIOptions)
  | ({ provider: 'openrouter' } & OpenRouterOptions)
  | ({ provider: 'stub' } & StubOptions);

//--------------------------------------------------------------------//
// Agent runtime

//the providers the built-in agent can talk to
export type AgentProvider = 'anthropic' | 'openai' | 'openrouter';

//one model the person may pick. The model identifier is the provider's own
// and is also what the picker stores, so it must be unique in the list.
export type AgentModelConfig = {
  provider: AgentProvider,
  model: string,
  title?: string
};

//this is the `agent` config section. The agent only activates when it exists.
export type AgentConfig = {
  //the name of the environment variable that holds each provider's key. The
  // key itself never goes in config and never reaches the browser
  providers: Partial<Record<AgentProvider, { key: string }>>,
  //the model identifier used when the person has not picked one
  model: string,
  //the models offered in the picker. The default has to be one of them
  models: AgentModelConfig[],
  //text added to the agent's instructions
  instructions?: string,
  //tokens, input and output together, one person may use per UTC day. Without
  // one there is no limit
  limit?: number,
  //how long a pending approval stays valid, in milliseconds
  approvalTtl?: number,
  //how many model calls one turn may make. Defaults to 8
  steps?: number,
  //where the chat routes are mounted. Defaults to `/agent`
  base?: string
};

//the plain hints a page can send with a message. They help the model
// understand "this"; nothing decides anything from them.
export type AgentHints = {
  url?: string,
  items?: unknown[]
};

//this is what one message carries. Who sent it is never part of it: that
// comes only from the request's verified session.
export type TurnInput = {
  //an existing thread of the person, or none to start one
  threadId?: string,
  message: string,
  //a model from the configured list
  model?: string,
  //references to files the app already stored, passed to tools unchanged
  files?: string[],
  context?: AgentHints
};

//how a run ended. 'waiting' means an action needs the person's approval,
// 'settled' means an approval, decline, or undo found the action already
// settled and ran nothing.
export type TurnStatus =
  | 'done'
  | 'waiting'
  | 'steps'
  | 'length'
  | 'refusal'
  | 'limit'
  | 'unavailable'
  | 'busy'
  | 'failed'
  | 'settled';

//these are the reports a run makes as it happens. A callback receives them
// one by one so a route can stream them, and the same list comes back in the
// result for a caller that does not stream.
export type AgentEvent
  = { type: 'thread', threadId: string, title: string }
  | { type: 'text', text: string }
  | {
    type: 'action-start',
    actionId: string,
    tool: string,
    input: Record<string, unknown>
  }
  | {
    type: 'action-waiting',
    actionId: string,
    tool: string,
    input: Record<string, unknown>,
    expires: string | null
  }
  | {
    type: 'action-done',
    actionId: string,
    tool: string,
    input: Record<string, unknown>,
    result: unknown,
    operation?: string,
    undoable: boolean
  }
  | {
    type: 'action-failed',
    actionId: string,
    tool: string,
    input: Record<string, unknown>,
    error: string,
    code?: number
  }
  | { type: 'action-declined', actionId: string, tool: string }
  | {
    type: 'action-undone',
    actionId: string,
    tool: string,
    undoActionId: string
  }
  | { type: 'usage', input: number, output: number }
  | {
    type: 'error',
    status: TurnStatus,
    message: string,
    retryAfter?: number,
    resetsAt?: string
  }
  | { type: 'finished', status: TurnStatus };

//why a request was refused before anything ran
export type RefusalReason =
  | 'unauthorized'
  | 'invalid'
  | 'not_found'
  | 'conflict'
  | 'busy'
  | 'limit'
  | 'csrf'
  | 'unavailable';

//a request that was refused. It cost nothing and changed nothing
export type Refusal = {
  ok: false,
  code: number,
  reason: RefusalReason,
  error: string,
  //when a daily limit resets
  resetsAt?: string
};

//what a message, an approval, or a decline answers with
export type TurnResult = Refusal | {
  ok: true,
  threadId: string,
  status: TurnStatus,
  events: AgentEvent[],
  //the action an approval or decline was about
  action?: AgentAction,
  //true when the action had already been answered and nothing ran
  replayed?: boolean
};

//what an undo answers with. 'refused' means the app would not reverse it
export type UndoResult = Refusal | {
  ok: true,
  threadId: string,
  status: 'undone' | 'refused' | 'settled',
  events: AgentEvent[],
  action: AgentAction,
  undo?: AgentAction,
  error?: string
};

//one turn as the person sees it. Tool turns and the provider's own record
// of a reply stay on the server
export type ThreadTurn = {
  id: string,
  role: string,
  text?: string | null,
  files?: string[],
  model?: string | null,
  created: Date | string
};

//one action as the person sees it, with whether Undo applies
export type ThreadAction = AgentAction & { undoable: boolean };

//what loading and listing threads answer with
export type ThreadResult = Refusal | {
  ok: true,
  thread: AgentThread,
  turns: ThreadTurn[],
  actions: ThreadAction[]
};

export type ThreadsResult = Refusal | {
  ok: true,
  threads: AgentThread[]
};

//what the panel needs to start: the models it may offer, which one is the
// default, and how much of the daily allowance the person has left
export type StartResult = Refusal | {
  ok: true,
  models: AgentModelConfig[],
  model: string,
  usage: {
    used: number,
    //only when a limit is configured
    limit?: number,
    remaining?: number,
    resetsAt?: string
  }
};

//what starting a new chat answers with. A new chat that was never used is
// handed out again instead of piling up empty threads
export type NewThreadResult = Refusal | {
  ok: true,
  thread: AgentThread,
  reused: boolean
};

//the anti-forgery plugin as the chat routes use it
export type CsrfPlugin = {
  valid(req: unknown, res: unknown): boolean,
  generate(res: unknown, ctx: unknown): string
};

//these runtime and store types are defined beside the code that uses them, and
// the package root exports them. They are re-exported here so this file keeps
// the full list of public types.
export type { AgentRuntime, RuntimeOptions, Sink } from './scripts/agent.js';
export type {
  Admission,
  AgentStore,
  Approval,
  Gate,
  NewAction,
  NewTurn,
  Outcome,
  Usage
} from './scripts/store.js';
