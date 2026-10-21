import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/** Supplies deterministic tool requests without contacting a model provider. */
export async function startModel(serverName, selectedTool) {
  const calls = [];
  let expectedCallId;
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const anthropic = request.url.includes('/messages');
    const tools = body.tools || [];
    const functions = tools.flatMap(tool => tool.type === 'namespace'
      ? (tool.tools || []).map(item => ({ ...item, namespace: tool.name, qualifiedName: `${tool.name}.${item.name}` }))
      : [tool]);
    const chosen = functions.find(tool => (tool.qualifiedName || tool.name)?.includes(serverName)
      && tool.name.endsWith(selectedTool));
    const completed = anthropic
      ? body.messages?.some(message => Array.isArray(message.content)
        && message.content.some(item => item.type === 'tool_result'
          && item.tool_use_id === expectedCallId && !item.is_error
          && JSON.stringify(item.content).includes('fixture-user')))
      : body.input?.some(item => item.type === 'function_call_output'
        && item.call_id === expectedCallId
        && JSON.stringify(item.output).includes('fixture-user'));
    const callTool = chosen && !completed && !expectedCallId;
    calls.push({
      path: request.url,
      tools: functions.map(tool => tool.qualifiedName || tool.name).filter(name => name?.includes(serverName)),
      requestedTool: callTool ? (chosen?.qualifiedName || chosen?.name) : undefined,
      receivedToolResult: Boolean(completed)
    });
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    });
    function event(type, value) {
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    }
    const id = `proof_${randomUUID()}`;
    if (callTool) expectedCallId = id;
    if (anthropic) {
      event('message_start', { message: {
        id, type: 'message', role: 'assistant', model: body.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      } });
      if (callTool) {
        event('content_block_start', { index: 0,
          content_block: { type: 'tool_use', id, name: chosen.name, input: {} } });
        event('content_block_delta', { index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' } });
      } else {
        event('content_block_start', { index: 0,
          content_block: { type: 'text', text: '' } });
        event('content_block_delta', { index: 0,
          delta: { type: 'text_delta', text: 'Proof completed.' } });
      }
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: {
        stop_reason: callTool ? 'tool_use' : 'end_turn', stop_sequence: null
      }, usage: { output_tokens: 1 } });
      event('message_stop', {});
    } else {
      const item = callTool ? {
        id, type: 'function_call', call_id: id, name: chosen.name, namespace: chosen.namespace, arguments: '{}', status: 'completed'
      } : {
        id, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Proof completed.', annotations: [] }]
      };
      event('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
      event('response.output_item.added', { output_index: 0, item });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', { response: {
        id, object: 'response', status: 'completed', output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      } });
    }
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise(resolve => server.close(resolve))
  };
}
