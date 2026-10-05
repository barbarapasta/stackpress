//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import { box, createStore, today, unbox } from '../src/scripts/store.js';
import type { StoreOptions } from '../src/types.js';
//tests
import { createHarness } from './harness.js';
import type { Harness } from './harness.js';

//a person, a thread, and one assistant turn that asked for an action
async function seed(harness: Harness, profileId = 'profile_a', options: StoreOptions = {}) {
  const store = harness.store(options);
  const thread = await store.createThread({ profileId, title: 'Close approvals' });
  const turn = await store.appendTurn(thread.id, profileId, {
    role: 'assistant',
    text: 'I will approve it.',
    toolCalls: [ { id: 'call_1', name: 'approve_request' } ]
  });
  const action = (extra = {}) => store.createAction({
    threadId: thread.id,
    turnId: turn.id,
    profileId,
    tool: 'approve_request',
    event: 'approval-approve',
    input: { id: 'req_1' },
    irreversible: true,
    ...extra
  });
  return { store, thread, turn, action, profileId };
}

//--------------------------------------------------------------------//
// Tests

describe('agent store', () => {
  describe('threads and owner isolation', () => {
    it('creates a thread and loads it only for its owner', async () => {
      const harness = await createHarness();
      const store = harness.store();
      const thread = await store.createThread({
        profileId: 'profile_a', title: 'Mine', model: 'claude-sonnet-5-5'
      });
      expect(thread).to.include({ profileId: 'profile_a', title: 'Mine' });
      expect(thread.model).to.equal('claude-sonnet-5-5');
      expect(thread.active).to.equal(true);
      //every time the store writes comes from its own clock
      expect(new Date(thread.created).toISOString()).to.equal('2026-10-05T10:00:00.000Z');
      expect(new Date(thread.updated).toISOString()).to.equal('2026-10-05T10:00:00.000Z');

      expect((await store.getThread(thread.id, 'profile_a'))?.id).to.equal(thread.id);
      expect(await store.getThread(thread.id, 'profile_b')).to.equal(null);
      expect(await store.getThread('missing', 'profile_a')).to.equal(null);
    });

    it('lists only the person\'s own active threads, latest activity first', async () => {
      const harness = await createHarness();
      const store = harness.store();
      const first = await store.createThread({ profileId: 'profile_a', title: 'First' });
      harness.advance(1000);
      const second = await store.createThread({ profileId: 'profile_a', title: 'Second' });
      await store.createThread({ profileId: 'profile_b', title: 'Theirs' });
      harness.advance(1000);
      //activity on the first thread moves it to the top
      await store.appendTurn(first.id, 'profile_a', { role: 'user', text: 'hi' });

      const mine = await store.listThreads('profile_a');
      expect(mine.map(thread => thread.title)).to.deep.equal([ 'First', 'Second' ]);
      expect(mine.every(thread => thread.profileId === 'profile_a')).to.equal(true);
      expect(await store.listThreads('profile_c')).to.deep.equal([]);
      expect((await store.listThreads('profile_a', { take: 1 })).length).to.equal(1);
      expect((await store.listThreads('profile_a', { skip: 1 }))[0].id).to.equal(second.id);

      //an inactive thread is hidden unless asked for
      await harness.engine.query('UPDATE agent_thread SET active = FALSE WHERE id = ?', [ second.id ]);
      expect((await store.listThreads('profile_a')).length).to.equal(1);
      expect((await store.listThreads('profile_a', { inactive: true })).length).to.equal(2);
    });

    it('refuses another person\'s thread for turns and actions', async () => {
      const harness = await createHarness();
      const { store, thread, turn } = await seed(harness);

      let error: Error | undefined;
      try {
        await store.appendTurn(thread.id, 'profile_b', { role: 'user', text: 'hi' });
      } catch (e) { error = e as Error; }
      expect(error?.message).to.equal('Thread not found.');

      error = undefined;
      try {
        await store.createAction({
          threadId: thread.id, turnId: turn.id, profileId: 'profile_b',
          tool: 't', event: 'e'
        });
      } catch (e) { error = e as Error; }
      expect(error?.message).to.equal('Thread not found.');

      expect(await store.listTurns(thread.id, 'profile_b')).to.deep.equal([]);
      expect(await store.listActions(thread.id, 'profile_b')).to.deep.equal([]);
      //nothing was written by the refused calls
      expect((await store.listTurns(thread.id, 'profile_a')).length).to.equal(1);
      expect(await store.listActions(thread.id, 'profile_a')).to.deep.equal([]);
    });
  });

  describe('turns are append only', () => {
    it('offers no way to edit or delete a turn', async () => {
      const store = (await createHarness()).store();
      const names = Object.keys(store);
      expect(names.filter(name => /update|edit|delete|remove|purge|replace/i.test(name)))
        .to.deep.equal([]);
      //the only turn methods add or read
      expect(names.filter(name => /turn/i.test(name)).sort())
        .to.deep.equal([ 'appendTurn', 'listTurns' ]);
    });

    it('keeps earlier turns unchanged as later ones are appended', async () => {
      const harness = await createHarness();
      const { store, thread, profileId } = await seed(harness);
      const before = await store.listTurns(thread.id, profileId);
      await store.appendTurn(thread.id, profileId, { role: 'user', text: 'next' });
      await store.appendTurn(thread.id, profileId, { role: 'assistant', text: 'ok' });
      const after = await store.listTurns(thread.id, profileId);
      expect(after.length).to.equal(3);
      expect(after[0]).to.deep.equal(before[0]);
    });

    it('stores the provider reply exactly as given', async () => {
      const harness = await createHarness();
      const { store, thread, profileId } = await seed(harness);
      //whitespace, key order, a number JSON would rewrite, and unicode
      const raw = '{ "z": 1.0,  "a": [1,2],\n "text": "café \\u00e9" }';
      const turn = await store.appendTurn(thread.id, profileId, {
        role: 'assistant', text: 'hi', provider: 'openrouter',
        model: 'm1', raw, inputTokens: 12, outputTokens: 7
      });
      expect(turn.raw).to.equal(raw);
      expect(await harness.column('agent_turn', 'raw', turn.id)).to.equal(raw);
      const stored = (await store.listTurns(thread.id, profileId)).find(t => t.id === turn.id);
      expect(stored?.raw).to.equal(raw);
      expect(stored).to.include({ provider: 'openrouter', model: 'm1', inputTokens: 12, outputTokens: 7 });
    });

    it('stores a reply given as an object as its JSON text', async () => {
      const harness = await createHarness();
      const { store, thread, profileId } = await seed(harness);
      const turn = await store.appendTurn(thread.id, profileId, {
        role: 'assistant', raw: { id: 'msg_1', parts: [ 1, 2 ] }
      });
      expect(turn.raw).to.equal('{"id":"msg_1","parts":[1,2]}');
    });

    it('round trips tool calls, tool results, and file references', async () => {
      const harness = await createHarness();
      const { store, thread, profileId } = await seed(harness);
      const turn = await store.appendTurn(thread.id, profileId, {
        role: 'tool',
        toolCalls: [ { id: 'c1', name: 'x', input: { n: 1 } } ],
        toolResults: 'plain string result',
        files: [ 'upload:abc', 'upload:def' ]
      });
      const [ , read ] = await store.listTurns(thread.id, profileId);
      expect(read.id).to.equal(turn.id);
      expect(read.toolCalls).to.deep.equal([ { id: 'c1', name: 'x', input: { n: 1 } } ]);
      expect(read.toolResults).to.equal('plain string result');
      expect(read.files).to.deep.equal([ 'upload:abc', 'upload:def' ]);
      expect(read.inputTokens).to.equal(0);
    });

    it('lists turns in the order they were appended, even within one instant', async () => {
      const harness = await createHarness();
      const { store, thread, profileId } = await seed(harness);
      //the clock never moves, so only the store's own ordering can sort these
      for (let i = 0; i < 25; i++) {
        await store.appendTurn(thread.id, profileId, { role: 'user', text: `m${i}` });
      }
      const turns = await store.listTurns(thread.id, profileId);
      expect(turns.slice(1).map(turn => turn.text))
        .to.deep.equal(Array.from({ length: 25 }, (_, i) => `m${i}`));
    });

    it('gives ids that sort in order across a clock that moves', async () => {
      const harness = await createHarness();
      const store = harness.store();
      const thread = await store.createThread({ profileId: 'profile_a', title: 'T' });
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        harness.advance(i % 2 ? 0 : 1);
        ids.push((await store.appendTurn(thread.id, 'profile_a', { role: 'user' })).id);
      }
      expect([ ...ids ].sort()).to.deep.equal(ids);
    });
  });

  describe('actions', () => {
    it('creates a pending action with the app\'s operation id and links', async () => {
      const harness = await createHarness();
      const { action, thread, turn } = await seed(harness);
      const created = await action({ operation: 'approval-4412', reverses: 'prior_1' });
      expect(created).to.include({
        threadId: thread.id, turnId: turn.id, profileId: 'profile_a',
        tool: 'approve_request', event: 'approval-approve',
        status: 'pending', operation: 'approval-4412',
        reverses: 'prior_1', irreversible: true
      });
      expect(created.input).to.deep.equal({ id: 'req_1' });
      //the claim token never leaves the store
      expect(created).to.not.have.property('claim');
      expect(new Date(created.created).toISOString()).to.equal('2026-10-05T10:00:00.000Z');
      expect(new Date(created.updated).toISOString()).to.equal('2026-10-05T10:00:00.000Z');
    });

    it('sets the expiry from the approval lifetime unless one is given', async () => {
      const harness = await createHarness();
      const { action } = await seed(harness, 'profile_a', { approvalTtl: 60_000 });
      const timed = await action();
      expect(new Date(timed.expires as string).getTime())
        .to.equal(harness.clock.at.getTime() + 60_000);
      const open = await action({ expires: null });
      expect(open.expires).to.equal(null);
      const set = await action({ expires: new Date('2026-12-01T00:00:00.000Z') });
      expect(new Date(set.expires as string).toISOString()).to.equal('2026-12-01T00:00:00.000Z');
      //with no lifetime configured, nothing expires by time
      const plain = await (await seed(harness)).action();
      expect(plain.expires).to.equal(null);
    });

    it('lists a thread\'s actions in order and reads one for its owner only', async () => {
      const harness = await createHarness();
      const { store, thread, action, profileId } = await seed(harness);
      const one = await action({ operation: 'a' });
      const two = await action({ operation: 'b' });
      const listed = await store.listActions(thread.id, profileId);
      expect(listed.map(row => row.operation)).to.deep.equal([ 'a', 'b' ]);
      expect((await store.getAction(one.id, profileId))?.id).to.equal(one.id);
      expect(await store.getAction(two.id, 'profile_b')).to.equal(null);
      expect(await store.getAction('missing', profileId)).to.equal(null);
    });

    it('lets a person not own an action stay pending until its owner approves', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness);
      const pending = await action();

      //another person, or a call with no valid owner, changes nothing
      expect(await store.approveAction(pending.id, 'profile_b')).to.equal(null);
      expect(await store.declineAction(pending.id, 'profile_b')).to.equal(null);
      expect(await store.markUndone(pending.id, 'profile_b')).to.equal(null);
      expect((await store.getAction(pending.id, profileId))?.status).to.equal('pending');

      //it runs only after the owner approves
      const approval = await store.approveAction(pending.id, profileId);
      expect(approval?.claimed).to.equal(true);
      expect(approval?.action.status).to.equal('approved');
    });
  });

  describe('pause and resume', () => {
    it('finds the waiting action from another store instance and settles it once', async () => {
      const harness = await createHarness();
      const { store, thread, action, profileId } = await seed(harness);
      const pending = await action();
      await store.appendTurn(thread.id, profileId, { role: 'assistant', text: 'waiting for approval' });

      //"another server": a fresh store over the same database
      const resumed = harness.store();
      const [ stored ] = await resumed.listActions(thread.id, profileId);
      expect(stored).to.include({ id: pending.id, status: 'pending' });
      expect((await resumed.listTurns(thread.id, profileId)).length).to.equal(2);

      const approval = await resumed.approveAction(pending.id, profileId);
      expect(approval?.claimed).to.equal(true);
      await resumed.completeAction(pending.id, approval!.claim!, {
        status: 'done', result: { approved: true }, operation: 'approval-77'
      });
      //turn order is exact within one store, and across stores when their
      // appends are at least a millisecond apart, which any real pause is
      harness.advance(1);
      await resumed.appendTurn(thread.id, profileId, { role: 'tool', toolResults: { approved: true } });

      //the first store sees the same record and the whole transcript
      const settled = await store.getAction(pending.id, profileId);
      expect(settled).to.include({ status: 'done', operation: 'approval-77' });
      expect(settled?.result).to.deep.equal({ approved: true });
      expect((await store.listTurns(thread.id, profileId)).map(turn => turn.role))
        .to.deep.equal([ 'assistant', 'assistant', 'tool' ]);
    });
  });

  describe('approval', () => {
    it('answers a repeated approval from the stored outcome and runs nothing', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness);
      const pending = await action();
      const first = await store.approveAction(pending.id, profileId);
      await store.completeAction(pending.id, first!.claim!, {
        status: 'done', result: [ 'ok' ]
      });
      const updated = await harness.column('agent_action', 'updated', pending.id);

      harness.advance(5000);
      const again = await store.approveAction(pending.id, profileId);
      expect(again?.claimed).to.equal(false);
      expect(again).to.not.have.property('claim');
      expect(again?.action).to.include({ status: 'done' });
      expect(again?.action.result).to.deep.equal([ 'ok' ]);
      //nothing was written by the repeat
      expect(await harness.column('agent_action', 'updated', pending.id)).to.deep.equal(updated);
    });

    it('lets exactly one of many simultaneous approvals claim and run the tool', async () => {
      const harness = await createHarness();
      //each approval comes from its own store, as if from different servers
      const { action, profileId } = await seed(harness);
      const pending = await action();
      const stores = Array.from({ length: 8 }, () => harness.store());

      const results = await Promise.all(
        stores.map(store => store.approveAction(pending.id, profileId))
      );
      const winners = results.filter(result => result?.claimed);
      expect(winners.length).to.equal(1);
      expect(winners[0]?.claim).to.be.a('string');
      //the claim on the row is the winner's, and every other call saw approved
      expect(await harness.column('agent_action', 'claim', pending.id))
        .to.equal(winners[0]?.claim);
      expect(results.every(result => result?.action.status === 'approved')).to.equal(true);

      //only the winner can settle it
      const settle = (claim: string) => stores[0].completeAction(
        pending.id, claim, { status: 'done', result: { ran: true } }
      );
      await settle('a-losing-token');
      expect(await harness.column('agent_action', 'status', pending.id)).to.equal('approved');
      await settle(winners[0]!.claim!);
      expect(await harness.column('agent_action', 'status', pending.id)).to.equal('done');
    });

    it('lets an approval and a decline race with one outcome', async () => {
      const harness = await createHarness();
      const { action, profileId } = await seed(harness);
      for (let i = 0; i < 6; i++) {
        const pending = await action();
        const [ approval, declined ] = await Promise.all([
          harness.store().approveAction(pending.id, profileId),
          harness.store().declineAction(pending.id, profileId, 'no')
        ]);
        //both see the same final status, and the tool runs only if approval won
        expect(approval?.action.status).to.be.oneOf([ 'approved', 'declined' ]);
        const final = await harness.column('agent_action', 'status', pending.id);
        expect(declined?.status).to.equal(final);
        expect(Boolean(approval?.claimed)).to.equal(final === 'approved');
      }
    });

    it('records a decline with its reason and keeps it declined', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness);
      const pending = await action();
      const declined = await store.declineAction(pending.id, profileId, 'Not now');
      expect(declined).to.include({ status: 'declined', error: 'Not now' });

      //later approval and decline calls change nothing
      const approval = await store.approveAction(pending.id, profileId);
      expect(approval?.claimed).to.equal(false);
      expect(approval?.action.status).to.equal('declined');
      expect((await store.declineAction(pending.id, profileId, 'other'))?.error).to.equal('Not now');
    });

    it('declines with no reason', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness);
      const declined = await store.declineAction((await action()).id, profileId);
      expect(declined).to.include({ status: 'declined', error: null });
    });

    it('settles done or failed only from approved and only once', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness);

      //a pending action cannot be settled, even with a made-up token
      const pending = await action();
      await store.completeAction(pending.id, 'guess', { status: 'done' });
      expect((await store.getAction(pending.id, profileId))?.status).to.equal('pending');

      const approval = await store.approveAction(pending.id, profileId);
      await store.completeAction(pending.id, approval!.claim!, {
        status: 'failed', error: 'The request was already closed.'
      });
      const failed = await store.getAction(pending.id, profileId);
      expect(failed).to.include({ status: 'failed', error: 'The request was already closed.' });
      expect(failed?.result).to.equal(undefined);

      //a second settlement cannot overwrite the first
      await store.completeAction(pending.id, approval!.claim!, { status: 'done', result: 1 });
      expect((await store.getAction(pending.id, profileId))?.status).to.equal('failed');
    });

    it('marks a done action undone, and only a done one', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness);

      const pending = await action({ irreversible: false });
      expect((await store.markUndone(pending.id, profileId))?.status).to.equal('pending');

      const approval = await store.approveAction(pending.id, profileId);
      await store.completeAction(pending.id, approval!.claim!, { status: 'done' });
      expect((await store.markUndone(pending.id, profileId))?.status).to.equal('undone');
      //undone stays undone
      expect((await store.markUndone(pending.id, profileId))?.status).to.equal('undone');
      expect((await store.approveAction(pending.id, profileId))?.claimed).to.equal(false);
    });

    it('lets exactly one of several undo claims win', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness);
      const pending = await action({ irreversible: false });
      const approval = await store.approveAction(pending.id, profileId);
      await store.completeAction(pending.id, approval!.claim!, { status: 'done' });

      const claims = await Promise.all(Array.from({ length: 6 }, () =>
        harness.store().claimUndo(pending.id, profileId)
      ));
      const winners = claims.filter(claim => claim?.claimed);
      expect(winners.length).to.equal(1);
      expect(winners[0]!.claim).to.be.a('string');
      expect(claims.every(claim => claim?.action.status === 'undone')).to.equal(true);
      //the token stays inside the store, on the row
      expect(await harness.column('agent_action', 'claim', pending.id))
        .to.equal(winners[0]!.claim);
      //a later call is a repeat
      expect((await store.claimUndo(pending.id, profileId))?.claimed).to.equal(false);
    });

    it('only lets the owner claim an undo, and only for a done action', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness);
      const pending = await action({ irreversible: false });
      expect(await store.claimUndo(pending.id, 'profile_b')).to.equal(null);

      //a pending action is not done, so nothing is claimed or changed
      const early = await store.claimUndo(pending.id, profileId);
      expect(early?.claimed).to.equal(false);
      expect(early?.action.status).to.equal('pending');
      expect(await store.claimUndo('missing', profileId)).to.equal(null);
    });

    it('gives an undo claim back only to the claim holder', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness);
      const pending = await action({ irreversible: false });
      const approval = await store.approveAction(pending.id, profileId);
      await store.completeAction(pending.id, approval!.claim!, { status: 'done' });
      const claimed = await store.claimUndo(pending.id, profileId);

      await store.releaseUndo(pending.id, 'a-wrong-token');
      expect((await store.getAction(pending.id, profileId))?.status).to.equal('undone');
      await store.releaseUndo(pending.id, claimed!.claim!);
      expect((await store.getAction(pending.id, profileId))?.status).to.equal('done');
      //and it can be claimed again
      expect((await store.claimUndo(pending.id, profileId))?.claimed).to.equal(true);
    });

    it('lets exactly one of several decline claims win', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness);
      const pending = await action();
      const claims = await Promise.all(Array.from({ length: 6 }, () =>
        harness.store().claimDecline(pending.id, profileId, 'No thanks')
      ));
      expect(claims.filter(claim => claim?.claimed).length).to.equal(1);
      expect(claims.every(claim => claim?.action.status === 'declined')).to.equal(true);
      expect((await store.getAction(pending.id, profileId))?.error).to.equal('No thanks');
    });

    it('claims a decline only for the owner and only while pending', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness);
      const pending = await action();
      expect(await store.claimDecline(pending.id, 'profile_b')).to.equal(null);
      expect(await store.claimDecline('missing', profileId)).to.equal(null);
      expect((await store.getAction(pending.id, profileId))?.status).to.equal('pending');

      //an approved action cannot be declined and is left as it is
      await store.approveAction(pending.id, profileId);
      const late = await store.claimDecline(pending.id, profileId, 'Too late');
      expect(late?.claimed).to.equal(false);
      expect(late?.action.status).to.equal('approved');
      expect(late?.action.error ?? null).to.equal(null);
    });

    it('links an undo to the action it reverses', async () => {
      const harness = await createHarness();
      const { store, action, thread, profileId } = await seed(harness);
      const original = await action({ irreversible: false });
      const undo = await action({ tool: 'reopen_request', reverses: original.id });
      const listed = await store.listActions(thread.id, profileId);
      expect(listed.find(row => row.id === undo.id)?.reverses).to.equal(original.id);
    });
  });

  describe('expiry', () => {
    it('expires pending approvals when the person sends a new message', async () => {
      const harness = await createHarness();
      const { store, thread, action, profileId } = await seed(harness);
      const waiting = await action();
      const claimed = await action();
      const claim = (await store.approveAction(claimed.id, profileId))!.claim!;

      //an assistant or tool turn does not end a wait
      await store.appendTurn(thread.id, profileId, { role: 'assistant', text: 'still here' });
      await store.appendTurn(thread.id, profileId, { role: 'tool' });
      expect((await store.getAction(waiting.id, profileId))?.status).to.equal('pending');

      await store.appendTurn(thread.id, profileId, { role: 'user', text: 'never mind' });
      expect((await store.getAction(waiting.id, profileId))?.status).to.equal('expired');
      //an approval already claimed is not pulled back
      expect((await store.getAction(claimed.id, profileId))?.status).to.equal('approved');
      await store.completeAction(claimed.id, claim, { status: 'done' });
      expect((await store.getAction(claimed.id, profileId))?.status).to.equal('done');

      //an expired approval can no longer be approved
      const late = await store.approveAction(waiting.id, profileId);
      expect(late?.claimed).to.equal(false);
      expect(late?.action.status).to.equal('expired');
    });

    it('leaves other threads\' approvals alone on a new message', async () => {
      const harness = await createHarness();
      const { store, thread, action, profileId } = await seed(harness);
      const other = await store.createThread({ profileId, title: 'Other' });
      const otherTurn = await store.appendTurn(other.id, profileId, { role: 'assistant' });
      const there = await store.createAction({
        threadId: other.id, turnId: otherTurn.id, profileId,
        tool: 't', event: 'e'
      });
      const here = await action();

      await store.appendTurn(thread.id, profileId, { role: 'user', text: 'hi' });
      expect((await store.getAction(here.id, profileId))?.status).to.equal('expired');
      expect((await store.getAction(there.id, profileId))?.status).to.equal('pending');

      //the same call for a thread expires just that thread
      await store.expirePending(other.id);
      expect((await store.getAction(there.id, profileId))?.status).to.equal('expired');
    });

    it('expires an approval when its time has passed', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness, 'profile_a', { approvalTtl: 60_000 });
      const pending = await action();

      //before the time it can still be approved
      harness.advance(59_000);
      const early = await action();
      expect((await store.approveAction(early.id, profileId))?.claimed).to.equal(true);

      //after it, the approval is settled as expired and nothing runs
      harness.advance(2_000);
      const late = await store.approveAction(pending.id, profileId);
      expect(late?.claimed).to.equal(false);
      expect(late?.action.status).to.equal('expired');
      expect(await harness.column('agent_action', 'claim', pending.id)).to.equal(null);
    });

    it('expires every approval past its time in one sweep', async () => {
      const harness = await createHarness();
      const { store, thread, action, profileId } = await seed(harness, 'profile_a', { approvalTtl: 60_000 });
      const due = await action();
      const open = await action({ expires: null });
      const approved = await action();
      await store.approveAction(approved.id, profileId);

      harness.advance(30_000);
      await store.expirePending();
      expect((await store.getAction(due.id, profileId))?.status).to.equal('pending');

      harness.advance(31_000);
      await store.expirePending();
      const statuses = Object.fromEntries(
        (await store.listActions(thread.id, profileId)).map(row => [ row.id, row.status ])
      );
      expect(statuses).to.deep.equal({
        [due.id]: 'expired',
        //no expiry set, and a claimed approval, are both untouched
        [open.id]: 'pending',
        [approved.id]: 'approved'
      });
    });
  });

  describe('usage', () => {
    it('reads zero for a person with no usage today', async () => {
      const harness = await createHarness();
      const usage = await harness.store().getUsage('profile_a');
      expect(usage).to.include({
        profileId: 'profile_a', day: '2026-10-05',
        inputTokens: 0, outputTokens: 0, turns: 0
      });
    });

    it('adds up usage for a person and a day', async () => {
      const harness = await createHarness();
      const store = harness.store();
      const first = await store.addUsage('profile_a', { inputTokens: 100, outputTokens: 20 });
      expect(first).to.include({ id: 'profile_a:2026-10-05', inputTokens: 100, outputTokens: 20, turns: 1 });
      expect(new Date(first!.created).toISOString()).to.equal('2026-10-05T10:00:00.000Z');
      await store.addUsage('profile_a', { inputTokens: 50, outputTokens: 5, turns: 2 });
      await store.addUsage('profile_a', {});

      expect(await store.getUsage('profile_a')).to.include({
        inputTokens: 150, outputTokens: 25, turns: 4
      });
      //one row per person and day
      const rows = await harness.engine.query('SELECT * FROM agent_usage');
      expect(rows.length).to.equal(1);
    });

    it('keeps people and days apart', async () => {
      const harness = await createHarness();
      const store = harness.store();
      await store.addUsage('profile_a', { inputTokens: 10 });
      await store.addUsage('profile_b', { inputTokens: 7 });
      harness.advance(24 * 3600 * 1000);
      await store.addUsage('profile_a', { inputTokens: 3 });

      expect((await store.getUsage('profile_a')).inputTokens).to.equal(3);
      expect((await store.getUsage('profile_b')).inputTokens).to.equal(0);
      harness.advance(-24 * 3600 * 1000);
      expect((await store.getUsage('profile_a')).inputTokens).to.equal(10);
      expect((await store.getUsage('profile_b')).inputTokens).to.equal(7);
    });

    it('counts every simultaneous addition, from separate stores', async () => {
      const harness = await createHarness();
      await Promise.all(Array.from({ length: 12 }, () =>
        harness.store().addUsage('profile_a', { inputTokens: 10, outputTokens: 1 })
      ));
      expect(await harness.store().getUsage('profile_a')).to.include({
        inputTokens: 120, outputTokens: 12, turns: 12
      });
      expect((await harness.engine.query('SELECT * FROM agent_usage')).length).to.equal(1);
    });

    it('does not let a negative or fractional figure reduce the total', async () => {
      const harness = await createHarness();
      const store = harness.store();
      await store.addUsage('profile_a', { inputTokens: 10, outputTokens: 10 });
      const after = await store.addUsage('profile_a', {
        inputTokens: -500, outputTokens: 2.9, turns: -1
      });
      expect(after).to.include({ inputTokens: 10, outputTokens: 12, turns: 1 });
    });

    it('keys the day by UTC', () => {
      expect(today(new Date('2026-10-05T23:59:59.999Z'))).to.equal('2026-10-05');
      expect(today(new Date('2026-10-06T00:00:00.000Z'))).to.equal('2026-10-06');
    });
  });

  describe('errors', () => {
    it('throws the event\'s own error', async () => {
      const harness = await createHarness();
      const store = harness.store();
      harness.failing['agent-thread-create'] = { code: 400, error: 'Invalid parameters' };
      let error: Error | undefined;
      try {
        await store.createThread({ profileId: 'profile_a', title: '' });
      } catch (e) { error = e as Error; }
      expect(error?.message).to.equal('Invalid parameters');
    });

    it('falls back to the status text, then to a plain message', async () => {
      const harness = await createHarness();
      const store = harness.store();
      harness.failing['agent-thread-search'] = { code: 500 } as never;
      let error: Error | undefined;
      try { await store.listThreads('profile_a'); } catch (e) { error = e as Error; }
      expect(error?.message).to.equal('"agent-thread-search" failed');
      harness.failing['agent-thread-search'] = { code: 500, status: 'Server Error' } as never;
      try { await store.listThreads('profile_a'); } catch (e) { error = e as Error; }
      expect(error?.message).to.equal('Server Error');
    });

    it('throws when a lookup fails for a reason other than not found', async () => {
      const harness = await createHarness();
      harness.failing['agent-thread-detail'] = { code: 500, error: 'Database is down' };
      let error: Error | undefined;
      try { await harness.store().getThread('t', 'p'); } catch (e) { error = e as Error; }
      expect(error?.message).to.equal('Database is down');
    });

    it('throws when no event answers', async () => {
      const harness = await createHarness();
      harness.ctx.resolve = (async () => null) as never;
      let error: Error | undefined;
      try { await harness.store().listThreads('p'); } catch (e) { error = e as Error; }
      expect(error?.message).to.equal('Nothing answered the "agent-thread-search" event.');
    });

    it('treats a missing list as empty', async () => {
      const harness = await createHarness();
      harness.ctx.resolve = (async () => ({ code: 200 })) as never;
      expect(await harness.store().listThreads('p')).to.deep.equal([]);
    });

    it('throws when the database plugin is missing', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness);
      const pending = await action();
      (harness.ctx as unknown as { registered: Record<string, unknown> }).registered.database = undefined;
      let error: Error | undefined;
      try { await store.approveAction(pending.id, profileId); } catch (e) { error = e as Error; }
      expect(error?.message).to.equal('The database plugin is not registered.');
    });

    it('does not claim when the claim statement fails', async () => {
      const harness = await createHarness();
      const { store, action, profileId } = await seed(harness);
      const pending = await action();
      const real = harness.engine.query.bind(harness.engine);
      harness.engine.query = (async () => { throw new Error('connection lost'); }) as never;
      let error: Error | undefined;
      try { await store.approveAction(pending.id, profileId); } catch (e) { error = e as Error; }
      harness.engine.query = real as never;
      expect(error?.message).to.equal('connection lost');
      expect(await harness.column('agent_action', 'status', pending.id)).to.equal('pending');
    });

    it('rethrows a usage creation failure that is not a race', async () => {
      const harness = await createHarness();
      harness.failing['agent-usage-create'] = { code: 400, error: 'Invalid parameters' };
      let error: Error | undefined;
      try { await harness.store().addUsage('profile_a', {}); } catch (e) { error = e as Error; }
      expect(error?.message).to.equal('Invalid parameters');
    });

    it('works with the real clock when none is given', async () => {
      const harness = await createHarness();
      const store = createStore(harness.ctx);
      const thread = await store.createThread({ profileId: 'profile_a', title: 'T' });
      await store.appendTurn(thread.id, 'profile_a', { role: 'user', text: 'hi' });
      expect((await store.getUsage('profile_a')).day).to.equal(today(new Date()));
    });
  });

  describe('boxing', () => {
    it('wraps and unwraps values the JSON columns cannot hold directly', () => {
      expect(box([ 1, 2 ])).to.deep.equal({ value: [ 1, 2 ] });
      expect(box(0)).to.deep.equal({ value: 0 });
      expect(box(undefined)).to.equal(undefined);
      expect(box(null)).to.equal(null);
      expect(unbox({ value: 'x' })).to.equal('x');
      expect(unbox(null)).to.equal(undefined);
      expect(unbox({})).to.equal(undefined);
    });
  });
});
