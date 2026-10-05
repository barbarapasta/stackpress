//client
//the transports start the MCP server and are the entrypoints the CLI events
// run. They have always been public from here.
export { default as http } from './http.js';
export { default as sse } from './sse.js';
export { default as stdio } from './stdio.js';

//the tool registry and the shared way a tool is run
export {
  TOOLS_EVENT,
  callTool,
  caller,
  collectTools,
  contributeTool,
  failed,
  loadRegistry,
  undoing
} from './tools.js';

//the lower level agent workflow. Most apps resolve the agent events instead
// of calling these, and import the runtime and store from the package root.
export { createRuntime, watch } from './agent.js';
export type { AgentRuntime, RuntimeOptions, Sink } from './agent.js';
export { createStore } from './store.js';
export type {
  AgentStore,
  Approval,
  NewAction,
  NewTurn,
  Outcome
} from './store.js';
export { runTurn } from './turn.js';
export { approve, decline, undo } from './approval.js';
export { listThreads, loadThread } from './threads.js';
