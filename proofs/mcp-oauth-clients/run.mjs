import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixture } from '../mcp-oauth-shared-access/fixture.mjs';
import { command, until, authorizationUrl } from './process.mjs';
import { startModel } from './model.mjs';

const playwrightPath = process.env.OAUTH_PROOF_PLAYWRIGHT;
assert(playwrightPath, 'Set OAUTH_PROOF_PLAYWRIGHT to the installed playwright entrypoint.');
const { chromium } = await import(pathToFileURL(playwrightPath));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.OAUTH_PROOF_CHROMIUM || undefined
});
const work = await mkdtemp(join(tmpdir(), 'stackpress-client-proof-'));
const results = { timestamp: new Date().toISOString(), node: process.version, browser: await browser.version(), clients: [] };

/** Drives the fixture approval page and the CLI-supported headless callback. */
async function login(client, args, options, fixture) {
  const run = command(client, args, { ...options, tty: client === 'claude' });
  const traceStart = fixture.trace.length;
  const page = await browser.newPage();
  let callback;
  try {
    const url = await until(() => authorizationUrl(run.output(), fixture.origin),
      `${client} did not provide a fixture authorization URL.`, 25000);
    const redirect = new URL(url).searchParams.get('redirect_uri');
    assert(redirect, 'Client must send a return address.');
    await page.route(url => url.origin === new URL(redirect).origin
      && url.pathname === new URL(redirect).pathname, async route => {
      callback = route.request().url();
      await route.fulfill({ contentType: 'text/plain', body: 'Proof callback captured.' });
    });
    await page.goto(url);
    assert.match(await page.locator('body').innerText(), /fixture/i);
    await page.getByRole('button', { name: 'Approve fixture access' }).click();
    await until(() => callback || fixture.trace.slice(traceStart).some(item =>
      item.stage === 'token' && item.grantType === 'authorization_code'),
    'Browser did not receive the approval callback.');
    if (callback && run.child.exitCode === null) run.child.stdin.write(`${callback}\n`);
    const result = await Promise.race([
      run.finished,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Login timed out.')), 20000).unref())
    ]);
    if (result.code !== 0) throw new Error(`Login exited ${result.code}: ${safeOutput(result.output)}`);
    assert(fixture.trace.slice(traceStart).some(item => item.stage === 'token' && item.grantType === 'authorization_code'),
      'Native client did not exchange its authorization code.');
    return { passed: true, redirectScheme: new URL(redirect).protocol, redirectHost: new URL(redirect).hostname };
  } catch (error) {
    return { passed: false, error: `${error.message}; client output: ${safeOutput(run.output())}` };
  } finally {
    run.child.kill('SIGTERM');
    await page.close();
  }
}

/** Retains useful diagnostics while excluding callback and credential values. */
function safeOutput(output) {
  return output.replace(/https?:\/\/[^\s]+/g, '[URL]')
    .replace(/(?:Bearer|access_token|refresh_token|code_verifier)\S*\s*\S+/gi, '[credential redacted]')
    .slice(-2200);
}

/** Uses the real client's MCP code with an entirely local model stub. */
async function toolCall(kind, name, config, options, fixture) {
  const model = await startModel(name, 'read_articles');
  try {
    let args;
    let env = { ...options.env };
    if (kind === 'codex') {
      args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
        '-C', work, '-c', `mcp_servers.${name}.url="${fixture.mcpUrl}"`,
        '-c', 'mcp_oauth_credentials_store="file"',
        '-c', `mcp_servers.${name}.tools.read_articles.approval_mode="approve"`,
        '-c', 'model_provider="proof"', '-c', 'model="proof"',
        '-c', 'model_providers.proof.name="proof"',
        '-c', `model_providers.proof.base_url="${model.origin}"`,
        '-c', 'model_providers.proof.wire_api="responses"',
        '-c', 'model_providers.proof.requires_openai_auth=false',
        '-c', 'features.shell_tool=false',
        '-c', 'features.apps=false', '-c', 'features.plugins=false',
        '-c', 'features.multi_agent=false',
        'Call the proof read_articles MCP tool once.'];
    } else {
      env = { ...env, ANTHROPIC_BASE_URL: model.origin, ANTHROPIC_API_KEY: 'local-proof-only' };
      args = ['--print', '--no-session-persistence', '--strict-mcp-config',
        '--mcp-config', config, '--setting-sources', '', '--tools', '',
        '--allowedTools', `mcp__${name}__read_articles`, '--model', 'proof',
        'Call the proof read_articles MCP tool once.'];
    }
    const before = fixture.trace.length;
    const run = command(kind, args, { ...options, env });
    run.child.stdin.end();
    let result;
    try {
      result = await Promise.race([
        run.finished,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tool call timed out.')), 25000).unref())
      ]);
    } catch (error) {
      result = { code: null, output: error.message + '\n' + run.output() };
    } finally {
      run.child.kill('SIGTERM');
    }
    return {
      exitCode: result.code,
      modelCalls: model.calls,
      trace: fixture.trace.slice(before),
      diagnostic: safeOutput(result.output)
    };
  } finally {
    await model.close();
  }
}

try {
  for (const kind of ['codex', 'claude']) {
    const name = `stackpress_proof_${kind}_${process.pid}`;
    const fixture = await startFixture({ accessSeconds: 900 });
    let latestKey;
    const issue = fixture.records.issue;
    fixture.records.issue = grant => {
      const tokens = issue(grant);
      latestKey = tokens.access_token;
      return tokens;
    };
    async function api(key, path = '/api/articles', method = 'GET') {
      return (await fetch(`${fixture.origin}${path}`, {
        method, headers: { Authorization: `Bearer ${key}` }
      })).status;
    }
    function completed(result) {
      return result.exitCode === 0 && result.trace.some(item => item.stage === 'mcp-tool-completed'
        && item.tool === 'read_articles' && item.user === 'fixture-user')
        && result.modelCalls.some(item => item.receivedToolResult);
    }
    const env = { ...process.env, BROWSER: 'true', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const options = { cwd: work, env };
    const config = join(work, `${kind}.json`);
    const row = { name: kind, simulatedSignIn: true, deterministicModel: true };
    const overrides = ['-c', `mcp_servers.${name}.url="${fixture.mcpUrl}"`,
      '-c', 'mcp_oauth_credentials_store="file"'];
    if (kind === 'claude') {
      env.CLAUDE_CONFIG_DIR = join(work, 'claude-config');
      const add = await command(kind, ['mcp', 'add', '--transport', 'http',
        '--scope', 'user', name, fixture.mcpUrl], options).finished;
      assert.equal(add.code, 0, 'Cannot configure proof Claude server.');
    }
    await writeFile(config, JSON.stringify({ mcpServers: { [name]: { type: 'http', url: fixture.mcpUrl } } }));
    try {
      row.version = (await command(kind, ['--version'], options).finished).output.trim();
      row.login = await login(kind, ['mcp', 'login', name, '--no-browser',
        ...(kind === 'codex' ? overrides : [])], options, fixture);
      row.loginTrace = [...fixture.trace];
      if (row.login.passed) {
        row.tool = await toolCall(kind, name, config, options, fixture);
        const firstKey = latestKey;
        row.api = {
          fullKeyRead: await api(firstKey),
          idRead: await api(firstKey.split(':')[0]),
          fullKeyWrite: await api(firstKey, '/api/articles', 'POST'),
          idWrite: await api(firstKey.split(':')[0], '/api/articles', 'POST'),
          omittedRoute: await api(firstKey, '/api/omitted'),
          wrongResource: await api(firstKey, '/api/other')
        };
        fixture.expireAll();
        row.renewal = await toolCall(kind, name, config, options, fixture);
        row.api.renewedKey = await api(latestKey);
        row.api.oldKey = await api(firstKey);
        fixture.revokeAll();
        row.revoked = await toolCall(kind, name, config, options, fixture);
        row.api.revokedKey = await api(latestKey);
        row.reapproval = await login(kind, ['mcp', 'login', name, '--no-browser',
          ...(kind === 'codex' ? overrides : [])], options, fixture);
        row.restored = await toolCall(kind, name, config, options, fixture);
        row.api.reapprovedKey = await api(latestKey);
        row.checks = {
          nativeLogin: row.login.passed,
          protectedToolCompleted: completed(row.tool),
          automaticRenewal: row.renewal.trace.some(item => item.stage === 'token'
            && item.grantType === 'refresh_token') && completed(row.renewal),
          disconnectRefusesNextConnection: row.revoked.trace.some(item =>
            item.stage === 'mcp-refused' && item.status === 401)
            && !row.revoked.trace.some(item => item.stage === 'mcp-tool-completed'),
          disconnectedRenewalRefused: row.revoked.trace.some(item =>
            item.stage === 'error' && item.scope === 'invalid_grant'),
          reapprovalRestoresTool: row.reapproval.passed && completed(row.restored),
          sameNativeKeyApi: row.api.fullKeyRead === 200 && row.api.fullKeyWrite === 200,
          idOnlyReads: row.api.idRead === 200 && row.api.idWrite === 401,
          apiBoundaries: row.api.omittedRoute === 403 && row.api.wrongResource === 403,
          apiRenewal: row.api.renewedKey === 200 && row.api.oldKey === 401,
          apiDisconnect: row.api.revokedKey === 401,
          apiReapproval: row.api.reapprovedKey === 200
        };
      }
    } finally {
      const cleanup = await command(kind, ['mcp', 'logout', name,
        ...(kind === 'codex' ? overrides : [])], options).finished;
      row.credentialsRemoved = cleanup.code === 0;
      await fixture.close();
      results.clients.push(row);
      console.log(`${kind}: ${Object.values(row.checks || {}).filter(Boolean).length}/${Object.keys(row.checks || {}).length} checks, login ${row.login?.passed}, cleanup ${row.credentialsRemoved}`);
    }
  }
} finally {
  await browser.close();
  await rm(work, { recursive: true, force: true });
  await writeFile(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
}

assert(results.clients.every(row => row.login?.passed && row.credentialsRemoved
  && row.checks && Object.values(row.checks).every(Boolean)), 'A native client proof check failed; inspect results.json.');
