//modules
import { expect } from 'chai';
//client
import { runTurn } from '../src/scripts/turn.js';
import type { AgentEvent, StubReply, TurnResult } from '../src/types.js';
//tests
import { createEngine, createWorld, newPerson } from './harness.js';
import type { World, WorldOptions } from './harness.js';

//--------------------------------------------------------------------//
// Helpers shared by the workflow tests

export type Engine = Awaited<ReturnType<typeof createEngine>>;

export const HALF_HOUR = 30 * 60 * 1000;

export const says = (text: string, input = 10, output = 5): StubReply => ({
  text, usage: { input, output }
});

export const asks = (
  ...calls: [ string, string, Record<string, unknown>? ][]
): StubReply => ({
  toolCalls: calls.map(([ id, name, input ]) => ({ id, name, input: input || {} })),
  usage: { input: 10, output: 5 }
});

//one person, signed in, on a world of their own over the shared database
export async function setup(engine: Engine, options: WorldOptions = {}) {
  const world = createWorld(engine, {
    ...options,
    config: { approvalTtl: HALF_HOUR, ...options.config }
  });
  const profileId = newPerson('profile');
  const token = await world.token(profileId);
  return {
    world,
    profileId,
    token,
    //send a message as this person
    say: (message: string, extra: Record<string, unknown> = {}, sink?: (event: AgentEvent) => void) => {
      const data = { message, ...extra };
      return runTurn(world.rt, world.request(token, data), data, sink);
    }
  };
}

//narrow a result to an accepted one
export function accepted(result: { ok: boolean }) {
  expect(result.ok, JSON.stringify(result)).to.equal(true);
  return result as Extract<TurnResult, { ok: true }>;
}

export function refused(result: { ok: boolean }) {
  expect(result.ok).to.equal(false);
  return result as Extract<TurnResult, { ok: false }>;
}

//the stored actions of a thread, read from the database
export async function actionsOf(world: World, threadId: string) {
  return world.rows('agent_action', 'thread_id', threadId);
}

export async function turnsOf(world: World, threadId: string) {
  return world.rows('agent_turn', 'thread_id', threadId);
}

export const types = (events: AgentEvent[]) => events.map(event => event.type);
