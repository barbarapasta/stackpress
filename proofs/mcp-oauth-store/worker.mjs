//node
import { parentPort, workerData } from 'node:worker_threads';
//client
import { openAdapter } from './adapters.mjs';
import { operate } from './store.mjs';

// SQLite runs in independent OS processes to exercise file locking there too
const input = workerData || JSON.parse(process.env.OAUTH_PROOF_WORKER);
const channel = parentPort || {
  postMessage: message => process.send(message),
  once: (event, callback) => process.once(event, callback),
  close: () => process.disconnect()
};
const adapter = await openAdapter(input.config);
channel.postMessage({ type: 'ready' });
channel.once('message', async () => {
  channel.postMessage({ type: 'started' });
  try {
    const result = await operate(adapter, input.operation, async () => {
      channel.postMessage({ type: 'locked' });
      if (input.hold) {
        await new Promise(resolve => channel.once('message', resolve));
      }
    });
    channel.postMessage({ type: 'result', result, queries: adapter.queries });
  } catch (error) {
    channel.postMessage({
      type: 'result', result: { status: 'error', message: error.message },
      queries: adapter.queries
    });
  } finally {
    await adapter.close();
    channel.close();
  }
});
