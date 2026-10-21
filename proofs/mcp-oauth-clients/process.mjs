import { spawn } from 'node:child_process';

/** Starts a proof command without printing credentials or login URLs. */
export function command(file, args, options = {}) {
  const { tty = false, ...spawnOptions } = options;
  const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
  const executable = tty ? 'script' : file;
  const parameters = tty ? ['-q', '-e', '-c', [file, ...args].map(quote).join(' '), '/dev/null'] : args;
  const child = spawn(executable, parameters, {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...spawnOptions
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
  return { child, finished, output: () => output };
}

/** Waits for observable progress with a fixed deadline. */
export async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

/** Extracts only a URL hosted by the disposable proof server. */
export function authorizationUrl(output, origin) {
  const urls = output.match(/https?:\/\/[^\s\u001b\u0007]+/g) || [];
  return urls.find(value => value.startsWith(`${origin}/authorize?`));
}
