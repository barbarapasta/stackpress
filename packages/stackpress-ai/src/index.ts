//client
//the package root is the server-side surface an app developer needs: the
// plugin, the way a plugin offers tools, the caller record, the agent runtime
// and its store, and the types of their config. Everything else is reached
// from a subpath: `stackpress-ai/adapters` for the provider adapters,
// `stackpress-ai/client` for the browser panel, and `stackpress-ai/scripts`
// for the lower level workflow functions. Do not import the root from browser
// code. It pulls in the MCP server and the agent, which are server only.

//these public types describe the config, auth, adapter and record contracts
// that downstream callers use when they configure the package. Public server
// types are also available from `stackpress-ai/types`; panel types live in
// `stackpress-ai/client`.
export type {
  ActionStatus,
  Adapter,
  AdapterConfig,
  AdapterRaw,
  AdapterReply,
  AdapterRequest,
  AdapterStop,
  AdapterTool,
  AdapterToolCall,
  AdapterToolResult,
  AdapterTurn,
  AdapterUsage,
  Admission,
  AgentAction,
  AgentConfig,
  AgentEvent,
  AgentHints,
  AgentLock,
  AgentModelConfig,
  AgentProvider,
  AgentRuntime,
  AgentStore,
  AgentThread,
  AgentTurn,
  AgentUsage,
  AnthropicOptions,
  Approval,
  AuthContext,
  Caller,
  Gate,
  JsonSchema,
  McpConfig,
  McpSessionMode,
  NewAction,
  NewTurn,
  NormalizedToolConfig,
  OpenAIOptions,
  OpenRouterOptions,
  Outcome,
  ProviderErrorKind,
  ProviderOptions,
  Refusal,
  RefusalReason,
  ResolvedResponse,
  RuntimeOptions,
  Sink,
  StoreOptions,
  StubOptions,
  StubReply,
  ThreadAction,
  ThreadResult,
  ThreadsResult,
  ThreadTurn,
  Token,
  ToolConfig,
  ToolRequest,
  ToolResolverServer,
  ToolResult,
  TurnInput,
  TurnResult,
  TurnStatus,
  UndoResult,
  Undoing,
  Usage
} from './types.js';

//these exports expose the plugin entrypoint and MCP factory at the package
// boundary so Stackpress and tests can load them from one place.
export { createMcpServer } from './plugin.js';
//plugins call contributeTool from an `ai-tools` listener to offer one of their
// own events as a tool, and events read who is calling with caller and, for an
// inverse, what it is undoing with undoing.
export { caller, contributeTool, undoing } from './scripts/tools.js';
//the agent runtime, the reports it sends while a turn runs, and the store
// that keeps its records
export { createRuntime, watch } from './scripts/agent.js';
export { createStore } from './scripts/store.js';
//the names of the events an app resolves or listens for
export { AGENT_EVENTS, CONTEXT_EVENT } from './events/helpers.js';
export { default } from './plugin.js';
