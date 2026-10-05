//client
import type { AdapterTool, AdapterToolCall, JsonSchema } from '../types.js';

//this is a strict tool schema in the sense both providers enforce: an object
// that closes itself to unknown keys and lists every key as required, all the
// way down. A schema that cannot meet that is sent as a plain tool, because a
// strict tool the provider cannot build is a refused request.
export function isStrict(schema: JsonSchema): boolean {
  if (schema.type === 'object') {
    const properties = (schema.properties || {}) as Record<string, JsonSchema>;
    const keys = Object.keys(properties);
    const required = Array.isArray(schema.required) ? schema.required : [];
    return schema.additionalProperties === false
      && keys.every(key => required.includes(key))
      && keys.every(key => isStrict(properties[key]));
  }
  if (schema.type === 'array' && schema.items && typeof schema.items === 'object') {
    return isStrict(schema.items as JsonSchema);
  }
  return true;
}

//the strict flag for one tool
export function strict(tool: AdapterTool) {
  return isStrict(tool.input);
}

//model arguments arrive as a JSON string. An empty one is no arguments, and
// one that does not parse to an object (a reply cut off mid-call) is null.
export function parseInput(text: string | null | undefined) {
  try {
    const input = JSON.parse(text || '{}');
    return input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

//this drops calls whose input could not be read, and says whether any were
export function readableCalls(calls: (Omit<AdapterToolCall, 'input'> & {
  input: Record<string, unknown> | null
})[]) {
  const readable = calls.filter(call => call.input) as AdapterToolCall[];
  return { calls: readable, damaged: readable.length !== calls.length };
}
