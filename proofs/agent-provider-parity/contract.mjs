//Spec 00004 P-003: the one conversation loop every provider runs through.
//
//This file must stay free of any provider's name or wire format. Adapters
//translate the neutral transcript below into what their provider expects.
//
//Transcript turns:
// - { role: 'user', text }
// - { role: 'assistant', text, toolCalls: [{ id, name, input }], usage, raw }
// - { role: 'tool', results: [{ id, name, output, isError? }] }
//
//`raw` is the adapter's own record of the reply. The loop never reads it; it
//only carries it so the same adapter can replay the reply unchanged later.
//
//adapter.send({ system, tools, turns }) resolves to
// { text, toolCalls, stop: 'end' | 'tools' | 'length' | 'refusal' | 'pause',
//   usage: { input, output }, raw }

/**
 * Run one conversation until the model stops asking for tools.
 */
export async function runTurn({ adapter, system, tools, turns, execute, maxSteps = 6 }) {
  for (let step = 0; step < maxSteps; step++) {
    const reply = await adapter.send({ system, tools, turns });
    turns.push({
      role: 'assistant',
      text: reply.text,
      toolCalls: reply.toolCalls,
      usage: reply.usage,
      raw: reply.raw
    });
    if (reply.stop !== 'tools') {
      return reply.stop;
    }
    //run every requested tool and answer them together in one turn
    const results = await Promise.all(reply.toolCalls.map(async call => {
      try {
        return { id: call.id, name: call.name, output: JSON.stringify(await execute(call)) };
      } catch (error) {
        return { id: call.id, name: call.name, output: String(error.message), isError: true };
      }
    }));
    turns.push({ role: 'tool', results });
  }
  return 'steps';
}

/**
 * Describe a transcript by turn kind so two runs can be compared.
 */
export function shape(turns) {
  return turns.map(turn => {
    if (turn.role !== 'assistant') return turn.role;
    return turn.toolCalls.length
      ? `assistant:tools(${turn.toolCalls.map(call => call.name).join(',')})`
      : 'assistant:text';
  });
}

/**
 * Add up the usage the adapters reported across a transcript.
 */
export function usage(turns) {
  return turns.filter(turn => turn.role === 'assistant').reduce(
    (sum, turn) => ({
      input: sum.input + (turn.usage?.input || 0),
      output: sum.output + (turn.usage?.output || 0)
    }),
    { input: 0, output: 0 }
  );
}
