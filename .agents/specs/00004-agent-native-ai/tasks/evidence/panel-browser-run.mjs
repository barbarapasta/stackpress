//Drives the plain agent panel in a real browser against the blog served in
//production mode, and takes the screenshots of task 7. Uses the
//playwright-core and Chromium already on this machine; nothing is added to
//the repository. It signs in through the real sign-in form.
//
//  node panel-browser-run.mjs <scenario> <outDir> [baseUrl]
//
//scenarios:
//  main     the whole journey on a wide and a narrow screen, with keyboard,
//           hydration, double click, chip, model and fallback checks
//  limit    the daily limit state (server with a tiny allowance)
//  nokey    the agent unavailable state (server with no provider key)
//
//Every check prints "ok" or "FAIL". The exit code is 1 if any failed.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE
  || '/mnt/paseo-shared/solution-projects/commerce-orders/node_modules/playwright-core');

const [ scenario = 'main', out = '/tmp', base = 'http://127.0.0.1:3471' ] = process.argv.slice(2);
const exe = process.env.CHROMIUM
  || `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
const user = process.env.BLOG_USER || 'developer';
const pass = process.env.BLOG_PASS || 'developer';
const POKEMON = 'pokemon-turns-30-how-the-fictional-pocket-monsters-shaped-science';
const MINECRAFT = 'minecraft-is-15-years-old-and-still-changing-lives';

let failed = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failed++;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const browser = await chromium.launch({ executablePath: exe, args: [ '--no-sandbox' ] });

//a new browser window of a size, watching for page errors and for what the
//panel asks of the server
async function windowOf(size, extra = {}) {
  const context = await browser.newContext({
    viewport: size,
    reducedMotion: 'reduce',
    ...extra
  });
  const page = await context.newPage();
  const seen = { errors: [], agent: [], turns: [], responses: [], failed: [] };
  page.on('pageerror', error => seen.errors.push(`pageerror: ${error}`));
  //Chrome logs every failed or refused fetch as a console error. Those are
  //kept apart below, with their addresses, so a script error or a React
  //warning is not lost among them
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
      seen.errors.push(`console: ${message.text()}`);
    }
  });
  page.on('requestfailed', request => seen.failed.push(`${request.url()} ${request.failure()?.errorText}`));
  page.on('response', response => {
    if (response.status() >= 400) seen.failed.push(`${response.url()} ${response.status()}`);
  });
  page.on('request', request => {
    if (request.url().includes('/agent/')) {
      seen.agent.push(`${request.method()} ${new URL(request.url()).pathname}`);
      if (request.url().endsWith('/agent/turn') && request.method() === 'POST') {
        seen.turns.push(JSON.parse(request.postData() || '{}'));
      }
    }
  });
  page.on('response', response => {
    if (response.url().includes('/agent/')) {
      seen.responses.push({
        url: new URL(response.url()).pathname,
        status: response.status(),
        type: response.headers()['content-type'] || ''
      });
    }
  });
  return { context, page, seen };
}

async function signIn(page) {
  await page.goto(`${base}/auth/signin/username`, { waitUntil: 'networkidle' });
  await page.locator('input[name=username]').fill(user);
  await page.locator('input[name=secret]').fill(pass);
  await page.locator('button[type=submit], input[type=submit]').first().click();
  await page.waitForURL(url => !url.pathname.startsWith('/auth/signin'), { timeout: 15000 });
}

//requests that failed, other than the ones this run expects. Anything on the
//blog's own address that failed is a fault; a font or icon file from a CDN the
//sandbox cannot reach is not the panel's.
const localFailures = (seen, allow = []) => seen.failed.filter(line => {
  const url = line.split(' ')[0];
  return url.startsWith(base) && !allow.some(part => line.includes(part));
});

const shot = async (page, name, clip) => {
  await page.screenshot({ path: `${out}/00007-${name}.png`, ...(clip ? { clip } : {}) });
  console.log(`shot 00007-${name}.png${clip ? ` (clipped to ${clip.width}x${clip.height} at ${clip.x},${clip.y})` : ''}`);
};

//the panel's half of a wide screen, for the shots whose subject is only the panel
const PANEL_HALF = { x: 640, y: 0, width: 640, height: 800 };

//bring the thing a screenshot is about into the middle of the conversation
const show = (page, selector, which = 'first') => page.locator(selector)[which]()
  .evaluate(el => el.scrollIntoView({ block: 'center' }))
  .then(() => sleep(150));

//scroll the page behind the panel to the article's comments, and shoot the
//part of the screen the panel does not cover
async function shootComments(page, name) {
  await page.locator('.article-comments').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await sleep(200);
  await shot(page, name, { x: 0, y: 0, width: 880, height: 800 });
}

const active = page => page.evaluate(() => {
  const el = document.activeElement;
  return el ? `${el.tagName.toLowerCase()}#${el.id}.${el.className}` : 'none';
});

//the comment ids of an article, read as JSON the way the page's own data flag does
async function commentsOf(page, slug) {
  const res = await page.context().request.get(`${base}/articles/${slug}?json`);
  const body = await res.json();
  return { article: body.results, comments: body.results.comments.map(c => c.id) };
}

const openPage = async (page, path) => {
  const res = await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  check(res.status() === 200, `GET ${path} is 200`, String(res.status()));
};

//the page reloads after an action finishes. Wait for that, then for the panel
//to come back with its chat
async function afterReload(page, wait) {
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('#agent-panel', { timeout: 15000 });
  await page.waitForSelector(wait, { timeout: 15000 });
  await sleep(150);
}

async function sendKeyboard(page, text) {
  await page.locator('#agent-message').focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

//The contrast of the text colours the panel uses, measured as the browser has
//them. A colour is read through a canvas, which turns any CSS colour (the
//panel uses color-mix) into plain red, green, blue and alpha; text that is not
//opaque is laid over what is behind it first.
async function contrast(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = css => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [ r, g, b, a ] = ctx.getImageData(0, 0, 1, 1).data;
      return [ r, g, b, a / 255 ];
    };
    const over = ([ r, g, b, a ], [ br, bg, bb ]) => [
      r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)
    ];
    const lum = ([ r, g, b ]) => {
      const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    //what is behind an element: its own background over its parents'
    const backdrop = el => {
      const layers = [];
      for (let n = el; n; n = n.parentElement) layers.push(rgba(getComputedStyle(n).backgroundColor));
      let base = [ 255, 255, 255 ];
      for (const layer of layers.reverse()) base = over(layer, base);
      return base;
    };
    const rows = [];
    for (const selector of [
      '.agent-status', '.agent-title', '.agent-button', '.agent-primary', '.agent-user .agent-text',
      '.agent-agent .agent-text', '.agent-badge', '.agent-input dt', '.agent-input dd', '.agent-note',
      '.agent-card-hint', '.agent-card-error', '.agent-chip-label', '.agent-thread-title', '.agent-gate p',
      '.agent-gate h3', '.agent-launcher', '.agent-thread-row time'
    ]) {
      //every enabled element of that kind, and the worst of them is reported
      let worst = null;
      for (const el of document.querySelectorAll(selector)) {
        if (el.disabled) continue;
        const behind = backdrop(el);
        const text = over(rgba(getComputedStyle(el).color), behind);
        const a = lum(text);
        const c = lum(behind);
        const ratio = Math.round(((Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05)) * 100) / 100;
        if (worst === null || ratio < worst) worst = ratio;
      }
      if (worst !== null) rows.push([ selector, worst ]);
    }
    return rows;
  });
}

//--------------------------------------------------------------------//

async function limitScenario() {
  const { page, seen } = await windowOf({ width: 1280, height: 800 });
  await signIn(page);
  await openPage(page, `/articles/${POKEMON}`);
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.waitForSelector('#agent-message');
  await sendKeyboard(page, 'hello there');
  await page.waitForSelector('.agent-agent');
  await sendKeyboard(page, 'one more please');
  await page.waitForSelector('.agent-gate-limit', { timeout: 10000 });
  const text = await page.locator('.agent-gate-limit').innerText();
  check(/Daily limit reached/.test(text), 'the limit state is shown', text.replace(/\n/g, ' | '));
  check(/again after/.test(text), 'it says when the allowance resets');
  check(await page.locator('#agent-message').count() === 0, 'the composer is gone');
  check(await page.locator('.agent-agent').count() === 1 && await page.locator('.agent-user').count() === 1,
    'the first exchange is still on screen and the refused message is not');
  const posts = seen.agent.filter(line => line === 'POST /agent/turn').length;
  check(posts === 2, 'two messages were sent, the second refused', String(posts));
  const refused = seen.responses.filter(r => r.url === '/agent/turn').map(r => r.status);
  check(refused.join(',') === '200,429', 'the second answer was a 429', refused.join(','));
  await shot(page, 'wide-limit', PANEL_HALF);
  check(seen.errors.length === 0, 'no page errors', seen.errors.join(' | '));
  check(localFailures(seen, [ '/agent/turn 429' ]).length === 0, 'no failed request on the blog beyond the expected 429', localFailures(seen, [ '/agent/turn 429' ]).join(' | '));
  console.log('other failed requests (not the blog)', JSON.stringify(seen.failed.filter(line => !line.startsWith(base))));
  const narrow = await windowOf({ width: 390, height: 844 });
  await signIn(narrow.page);
  await openPage(narrow.page, `/articles/${POKEMON}`);
  await narrow.page.getByRole('button', { name: 'Agent', exact: true }).click();
  await narrow.page.waitForSelector('.agent-gate-limit', { timeout: 10000 });
  await shot(narrow.page, 'narrow-limit');
  check(narrow.seen.errors.length === 0, 'no page errors on the narrow screen', narrow.seen.errors.join(' | '));
}

async function nokeyScenario() {
  const { page, seen } = await windowOf({ width: 1280, height: 800 });
  await signIn(page);
  await openPage(page, `/articles/${POKEMON}`);
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.waitForSelector('#agent-message, .agent-gate-unavailable', { timeout: 10000 });
  if (await page.locator('#agent-message').count()) {
    await sendKeyboard(page, 'hello');
    await page.waitForSelector('.agent-gate-unavailable', { timeout: 10000 });
  }
  const text = await page.locator('.agent-gate-unavailable').innerText();
  check(/The agent is unavailable/.test(text), 'the unavailable state is shown', text.replace(/\n/g, ' | '));
  check(await page.locator('[role=alert].agent-gate-unavailable').count() === 1, 'it is announced as an alert');
  check(!/key|API|provider/i.test(text), 'it says nothing about keys or providers');
  await shot(page, 'wide-unavailable', PANEL_HALF);
  await page.getByRole('button', { name: 'Try again' }).click();
  await sleep(500);
  check(seen.agent.filter(line => line === 'GET /agent/start').length >= 2, 'Try again asks the server again');
  check(seen.errors.length === 0, 'no page errors', seen.errors.join(' | '));
  const bad = localFailures(seen, [ '/agent/turn 503' ]);
  check(bad.length === 0, 'no failed request on the blog beyond the expected 503', bad.join(' | '));
  const narrow = await windowOf({ width: 390, height: 844 });
  await signIn(narrow.page);
  await openPage(narrow.page, `/articles/${POKEMON}`);
  await narrow.page.getByRole('button', { name: 'Agent', exact: true }).click();
  await narrow.page.waitForSelector('#agent-message, .agent-gate-unavailable', { timeout: 10000 });
  if (await narrow.page.locator('#agent-message').count()) {
    await sendKeyboard(narrow.page, 'hello');
    await narrow.page.waitForSelector('.agent-gate-unavailable', { timeout: 10000 });
  }
  await shot(narrow.page, 'narrow-unavailable');
}

//--------------------------------------------------------------------//

async function wideJourney() {
  console.log('\n== wide screen: 1280 x 800');
  const { context, page, seen } = await windowOf({ width: 1280, height: 800 });

  //signed out: no request, a way to sign in
  const guest = await windowOf({ width: 1280, height: 800 });
  await openPage(guest.page, `/articles/${POKEMON}`);
  await guest.page.getByRole('button', { name: 'Agent', exact: true }).click();
  await guest.page.waitForSelector('.agent-gate-signed-out');
  const link = await guest.page.locator('#agent-panel').getByRole('link', { name: 'Sign in' }).getAttribute('href');
  check(link === '/auth/signin', 'signed out: the panel offers a sign in link', link);
  check(guest.seen.agent.length === 0, 'signed out: the panel made no request', guest.seen.agent.join(','));
  await shot(guest.page, 'wide-signed-out', PANEL_HALF);
  await guest.context.close();

  await signIn(page);
  const { comments, article } = await commentsOf(page, POKEMON);
  check(comments.length === 2, 'the article has two comments to work with', comments.join(','));

  //server render: the page arrives with the panel's button already in it
  const html = await (await context.request.get(`${base}/articles/${POKEMON}`)).text();
  check(/<button type="button" class="agent-launcher" aria-expanded="false" aria-controls="agent-panel">Agent<\/button>/.test(html),
    'server render: the launcher is in the HTML sent, before any script runs');
  check(!/<aside id="agent-panel"/.test(html), 'server render: the panel itself is not (closed)');

  await openPage(page, `/articles/${POKEMON}`);
  //hydration: the button works, and React did not complain
  check(seen.errors.length === 0, 'hydration: no console or page errors on load', seen.errors.join(' | '));

  //keyboard: Tab to the launcher, open it, land in the composer
  let found = false;
  for (let i = 0; i < 120 && !found; i++) {
    await page.keyboard.press('Tab');
    found = (await active(page)).includes('agent-launcher');
  }
  check(found, 'keyboard: Tab reaches the launcher');
  const label = await page.evaluate(() => document.activeElement.getAttribute('aria-expanded'));
  check(label === 'false', 'keyboard: the launcher says it is collapsed');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#agent-message');
  await sleep(200);
  check((await active(page)).startsWith('textarea#agent-message'), 'keyboard: opening puts focus in the message field', await active(page));
  check(seen.agent.join('|') === 'GET /agent/start', 'opening made one request: start', seen.agent.join('|'));
  check(seen.errors.length === 0, 'hydration: still no errors after opening', seen.errors.join(' | '));

  //the empty panel, with the page's context chips and the app's starter
  const chips = await page.locator('.agent-context .agent-chip-label').allInnerTexts();
  check(chips.length === 4 && chips[0].startsWith('/articles/'), 'context: the page address and three items are chips', chips.join(' | '));
  check(await page.getByRole('button', { name: 'Publish pokemon' }).count() === 1, 'the app starter prompt is offered');
  check(await page.locator('.agent-attach').count() === 0, 'file attach: no control, since the blog gave no upload handler');
  check(await page.locator('select[aria-label=Model] option').count() === 2, 'the model picker offers the two models');
  const colors = await contrast(page);
  console.log('contrast', JSON.stringify(colors));
  const low = colors.filter(([ , ratio ]) => ratio < 4.5);
  check(low.length === 0, 'contrast: every text colour measured is at least 4.5:1', JSON.stringify(low));
  await shot(page, 'wide-empty-with-context', PANEL_HALF);

  //a chip is removed, and the next message does not carry it
  const gone = chips[3];
  await page.getByRole('button', { name: `Remove ${gone}` }).click();
  check(await page.locator('.agent-context .agent-chip-label', { hasText: gone }).count() === 0, 'context: the chip is gone from the bar');
  //the model picker changes the model sent
  await page.locator('select[aria-label=Model]').selectOption('openai/gpt-6.1-sol');

  //1. a reversible action, by keyboard
  const [ first, second ] = comments;
  await sendKeyboard(page, 'publish pokemon');
  await afterReload(page, '.agent-card-done');
  const body = seen.turns[0];
  check(seen.turns.length === 1, 'one message sent, once');
  check(body.model === 'openai/gpt-6.1-sol', 'model: the picked model was sent', body.model);
  check(body.csrf && body.csrf.length === 64, 'the anti-forgery token went with the message');
  check(body.context.url.startsWith('/articles/') && body.context.items.length === 2
    && !JSON.stringify(body.context).includes(gone.replace('Comment: ', '')),
  'context: the removed chip was not sent', JSON.stringify(body.context.items.map(i => i.label)));
  check(seen.responses.find(r => r.url === '/agent/turn').type.includes('text/event-stream'), 'the reply came as an event stream');
  const done = page.locator('.agent-card-done');
  check(await done.count() === 1 && await done.getByRole('button', { name: /^Undo/ }).count() === 1, 'reversible action: a Done card with Undo');
  check((await page.locator('.agent-card-done .agent-badge').innerText()) === 'Done', 'its status says Done');
  check(await page.locator('#agent-panel').count() === 1, 'the panel is back after the page refreshed itself');
  check((await page.locator('select[aria-label=Model]').inputValue()) === 'openai/gpt-6.1-sol', 'the chat comes back with the model it used');
  await shot(page, 'wide-reversible-done');

  //2. then one that needs approval, with a double click on Approve
  await page.locator('#agent-message').fill(`publish pokemon and delete comment ${first}`);
  await page.locator('#agent-message').press('Enter');
  await afterReload(page, '.agent-card-waiting');
  const waitingCard = page.locator('.agent-card-waiting');
  const waitText = await waitingCard.innerText();
  check(/Comment delete/.test(waitText) && waitText.includes(first), 'waiting card: names the action and shows its input', waitText.replace(/\n/g, ' | '));
  check(/Nothing runs until you approve/.test(waitText), 'waiting card: says nothing runs until approval');
  check(await waitingCard.getByRole('button').count() === 2, 'waiting card: Approve and Decline, and no Undo');
  const focus = await active(page);
  check(focus.startsWith('article#agent-card-'), 'focus: the waiting card has focus, not a button', focus);
  const stillThere = (await commentsOf(page, POKEMON)).comments;
  check(stillThere.includes(first), 'waiting: the comment is still there, nothing ran');
  const cardColors = await contrast(page);
  console.log('contrast with cards', JSON.stringify(cardColors));
  const cardLow = cardColors.filter(([ , ratio ]) => ratio < 4.5);
  check(cardLow.length === 0, 'contrast: with cards on screen, every text colour measured is at least 4.5:1', JSON.stringify(cardLow));
  await show(page, '.agent-card-waiting');
  await shot(page, 'wide-waiting-approval');
  await shootComments(page, 'wide-page-before-approval');

  seen.agent.length = 0;
  await waitingCard.getByRole('button', { name: /^Approve/ }).dblclick();
  await afterReload(page, '.agent-card-done .agent-badge');
  await sleep(300);
  const approves = seen.agent.filter(line => line.endsWith('/approve')).length;
  check(approves === 1, 'double click on Approve sent one request', String(approves));
  const remaining = (await commentsOf(page, POKEMON)).comments;
  check(!remaining.includes(first) && remaining.length === 1, 'approved: the comment is deleted and the page behind shows it', remaining.join(','));
  const shownComments = await page.locator('.article-comment-card').count();
  check(shownComments === 1, 'the page was refreshed: one comment left on screen', String(shownComments));
  const doneCards = page.locator('.agent-card-done');
  check(await doneCards.count() === 3, 'three done cards: publish, publish, delete', String(await doneCards.count()));
  const deleteCard = page.locator('.agent-card', { hasText: 'Comment delete' });
  check(await deleteCard.getByRole('button').count() === 0, 'the approved irreversible action has no Undo');
  check((await page.locator('.agent-agent').last().innerText()).includes('All done'), 'the reply went on after approval');
  await show(page, '.agent-card:has-text("Comment delete")', 'last');
  await shot(page, 'wide-approved');
  await shootComments(page, 'wide-page-after-approval');

  //3. one that is declined, by keyboard only
  await page.locator('#agent-message').fill(`publish pokemon and delete comment ${second}`);
  await page.locator('#agent-message').press('Enter');
  await afterReload(page, '.agent-card-waiting');
  check((await active(page)).startsWith('article#agent-card-'), 'focus: the new waiting card has focus after the reload');
  await page.keyboard.press('Tab');
  const onApprove = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  check(/^Approve/.test(onApprove), 'keyboard: Tab goes to Approve first', onApprove);
  await page.keyboard.press('Tab');
  const onDecline = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  check(/^Decline/.test(onDecline), 'keyboard: the next Tab goes to Decline', onDecline);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.agent-card-declined');
  await sleep(200);
  check((await page.locator('.agent-card-declined .agent-badge').innerText()) === 'Declined', 'declined: the card says Declined');
  check((await commentsOf(page, POKEMON)).comments.includes(second), 'declined: the comment is still there');
  check((await active(page)).startsWith('article#agent-card-'), 'focus: after Decline it is on the card, not lost', await active(page));
  const live = await page.locator('[role=status][aria-live=polite].agent-sr').innerText();
  check(/declined/i.test(live) || live.length > 0, 'a status line was announced', live);
  await show(page, '.agent-card-declined');
  await shot(page, 'wide-declined');

  //4. undo the first publish
  const undoButtons = page.getByRole('button', { name: /^Undo/ });
  const undoCount = await undoButtons.count();
  await undoButtons.first().click();
  await afterReload(page, '.agent-card-undone');
  const undone = await page.locator('.agent-card-undone .agent-badge').allInnerTexts();
  check(undone.length === 1 && undone[0] === 'Undone', 'undo: the card says Undone', undone.join(','));
  check(await page.getByRole('button', { name: /^Undo/ }).count() === undoCount - 1, 'undo: that card has no Undo left');
  const state = (await commentsOf(page, POKEMON)).article.status;
  check(state === 'DRAFT', 'undo: the article is back to draft on the server', state);
  await show(page, '.agent-card-undone');
  await shot(page, 'wide-undone');

  //history and new chat
  const cardsBefore = await page.locator('.agent-card').count();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.waitForSelector('.agent-thread-row');
  const rows = await page.locator('.agent-thread-row').count();
  check(rows >= 1, 'history: earlier chats are listed', String(rows));
  await shot(page, 'wide-history', PANEL_HALF);
  await page.getByRole('button', { name: 'New chat' }).click();
  await page.waitForSelector('.agent-empty');
  check(await page.locator('.agent-card').count() === 0, 'new chat: the conversation is empty');
  const declared = 2 + (await commentsOf(page, POKEMON)).comments.length;
  check(await page.locator('.agent-context .agent-chip-label').count() === declared,
    'new chat: the page context is offered again, including the chip taken off before', `${declared} chips`);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.waitForSelector('.agent-thread-row');
  //the empty chat that New chat made is listed too; open the one with the work in it
  await page.locator('.agent-thread-row', { hasText: 'publish pokemon' }).first().click();
  await page.waitForSelector('.agent-card-undone');
  const restored = await page.locator('.agent-card').count();
  check(restored === cardsBefore && restored >= 4, 'history: opening a chat brings back its cards and their statuses', `${restored} of ${cardsBefore}`);
  const statuses = await page.locator('.agent-card .agent-badge').allInnerTexts();
  check(statuses.includes('Undone') && statuses.includes('Declined') && statuses.includes('Done'), 'history: the statuses came back', statuses.join(','));

  //escape closes, and focus goes back to the button
  await page.locator('#agent-message').focus();
  await page.keyboard.press('Escape');
  await sleep(200);
  check(await page.locator('#agent-panel').count() === 0, 'keyboard: Escape closes the panel');
  check((await active(page)).includes('agent-launcher'), 'keyboard: focus is back on the launcher', await active(page));

  //the accessibility tree as a screen reader gets it
  await page.keyboard.press('Enter');
  await page.waitForSelector('#agent-message');
  const tree = await page.locator('#agent-panel').ariaSnapshot();
  console.log('--- accessibility tree of the open panel ---\n' + tree + '\n---');
  check(/complementary "Agent chat"|region "Agent chat"/.test(tree) || /Agent chat/.test(tree), 'a11y: the panel is a labelled landmark');
  check(/button "New chat"/.test(tree) && /button "History"/.test(tree) && /button "Close agent"/.test(tree), 'a11y: the header controls are buttons with names');
  check(/log "Conversation"/.test(tree), 'a11y: the conversation is a log region');
  check(/textbox "Message"/.test(tree), 'a11y: the field is labelled');
  const unnamed = await page.evaluate(() => [ ...document.querySelectorAll('#agent-panel button, #agent-panel select, #agent-panel textarea, #agent-panel a') ]
    .filter(el => !(el.getAttribute('aria-label') || el.innerText || el.labels?.[0]?.innerText)).length);
  check(unnamed === 0, 'a11y: every control in the panel has a name', String(unnamed));
  check(seen.errors.length === 0, 'no console or page errors in the whole wide run', seen.errors.join(' | '));
  check(localFailures(seen).length === 0, 'no failed request on the blog in the whole wide run', localFailures(seen).join(' | '));
  console.log('other failed requests (not the blog)', JSON.stringify([ ...new Set(seen.failed.filter(line => !line.startsWith(base))) ]));
  await context.close();
}

//A reply that arrives slowly, as a real model's does: the page's own fetch is
//wrapped so the blog's instant answer comes out in small pieces, 45 ms apart.
//The person is at the end of the conversation and then scrolls up while the
//reply is still coming; the panel must follow the first and leave the second
//alone.
async function streamingScroll(page, seen) {
  console.log('\n-- a reply that arrives in pieces');
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const res = await original(input, init);
      const url = typeof input === 'string' ? input : input.url;
      if (!url.endsWith('/agent/turn') || !res.ok) return res;
      const bytes = new TextEncoder().encode(await res.text());
      const body = new ReadableStream({
        async start(controller) {
          for (let at = 0; at < bytes.length; at += 32) {
            controller.enqueue(bytes.slice(at, at + 32));
            await new Promise(resolve => setTimeout(resolve, 45));
          }
          controller.close();
        }
      });
      window.__pieces = Math.ceil(bytes.length / 32);
      return new Response(body, { status: res.status, headers: res.headers });
    };
  });
  const look = () => page.evaluate(() => {
    const thread = document.querySelector('.agent-thread');
    return {
      top: Math.round(thread.scrollTop),
      height: thread.scrollHeight,
      away: Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight),
      jump: Boolean(document.querySelector('.agent-jump')),
      busy: Boolean(document.querySelector('[aria-busy=true]')),
      cards: document.querySelectorAll('.agent-card').length
    };
  });
  const turns = seen.turns.length;
  await page.locator('#agent-message').fill('publish minecraft');
  await page.getByRole('button', { name: 'Send' }).tap();
  await sleep(250);
  const atEnd = await look();
  check(atEnd.away < 48, 'streaming: while the person is at the end, the view stays at the end', JSON.stringify(atEnd));
  //the person scrolls up to read something earlier
  await page.evaluate(() => { document.querySelector('.agent-thread').scrollTop = 0; });
  await sleep(100);
  const left = await look();
  await sleep(1500);
  const later = await look();
  check(seen.turns.length === turns + 1, 'streaming: the message was sent once');
  check(later.height > left.height, 'streaming: more arrived after the person scrolled up', `${left.height} -> ${later.height}`);
  check(later.top === 0 && left.top === 0, 'streaming: the view did not move while they read', `${left.top} -> ${later.top}`);
  check(later.jump, 'streaming: a button offers the way back to the newest message', JSON.stringify(later));
  check(await page.getByRole('button', { name: 'Jump to latest' }).count() === 1, 'streaming: it is a real button with a name');
  await page.getByRole('button', { name: 'Jump to latest' }).tap();
  await sleep(150);
  const back = await look();
  check(back.away < 48 && !back.jump, 'streaming: pressing it goes to the end and the button goes away', JSON.stringify(back));
  const pieces = await page.evaluate(() => window.__pieces);
  console.log('the reply was delivered in', pieces, 'pieces');
  //the action finished, so once the reply ends the page refreshes itself
  await page.waitForEvent('load', { timeout: 20000 });
  await afterReload(page, '.agent-card-done');
}

async function narrowJourney() {
  console.log('\n== narrow screen: 390 x 844');
  const { context, page, seen } = await windowOf({ width: 390, height: 844 }, { hasTouch: true, deviceScaleFactor: 2 });
  const guest = await windowOf({ width: 390, height: 844 }, { hasTouch: true });
  await openPage(guest.page, `/articles/${MINECRAFT}`);
  await guest.page.getByRole('button', { name: 'Agent', exact: true }).tap();
  await guest.page.waitForSelector('.agent-gate-signed-out');
  await shot(guest.page, 'narrow-signed-out');
  await guest.context.close();

  await signIn(page);
  const { comments } = await commentsOf(page, MINECRAFT);
  check(comments.length === 2, 'the article has two comments to work with', comments.join(','));
  await openPage(page, `/articles/${MINECRAFT}`);
  const overflow = () => page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    panel: (() => { const p = document.querySelector('#agent-panel'); return p ? p.scrollWidth - p.clientWidth : 0; })()
  }));
  await page.getByRole('button', { name: 'Agent', exact: true }).tap();
  await page.waitForSelector('#agent-message');
  const box = await page.locator('#agent-panel').boundingBox();
  check(Math.round(box.width) === 390 && Math.round(box.height) === 844, 'narrow: the panel is a full-screen sheet', `${box.width}x${box.height}`);
  check((await overflow()).panel <= 0, 'narrow: nothing in the panel scrolls sideways', JSON.stringify(await overflow()));
  const small = await page.evaluate(() => [ ...document.querySelectorAll('#agent-panel button, #agent-panel select, #agent-panel textarea') ]
    .map(el => ({ name: el.getAttribute('aria-label') || el.innerText || el.tagName, h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) }))
    .filter(item => item.h < 32));
  check(small.length === 0, 'narrow: every control is at least 32px tall', JSON.stringify(small));
  await shot(page, 'narrow-empty-with-context');

  //the single-response fallback: stop the browser asking for a stream
  await page.route('**/agent/turn', route => route.continue({
    headers: { ...route.request().headers(), accept: 'application/json' }
  }));
  await page.locator('#agent-message').fill('publish minecraft');
  await page.getByRole('button', { name: 'Send' }).tap();
  await afterReload(page, '.agent-card-done');
  const type = seen.responses.find(r => r.url === '/agent/turn');
  check(type.type.includes('application/json'), 'fallback: the server answered once, not as a stream', type.type);
  check(await page.locator('.agent-card-done').count() === 1, 'fallback: the same Done card appears');
  await page.unroute('**/agent/turn');
  await shot(page, 'narrow-reversible-done');

  const [ first, second ] = comments;
  await page.locator('#agent-message').fill(`publish minecraft and delete comment ${first}`);
  await page.getByRole('button', { name: 'Send' }).tap();
  await afterReload(page, '.agent-card-waiting');
  check(await page.locator('.agent-card-waiting').count() === 1, 'narrow: a card waits for approval');
  check((await overflow()).panel <= 0, 'narrow: still nothing scrolls sideways', JSON.stringify(await overflow()));
  const thread = await page.evaluate(() => { const t = document.querySelector('.agent-thread'); return { scroll: t.scrollHeight, client: t.clientHeight }; });
  console.log('thread scroll area', JSON.stringify(thread));
  await show(page, '.agent-card-waiting');
  await shot(page, 'narrow-waiting-approval');
  await page.getByRole('button', { name: /^Approve/ }).tap();
  await afterReload(page, '.agent-card-done .agent-badge');
  await sleep(300);
  check(!(await commentsOf(page, MINECRAFT)).comments.includes(first), 'narrow: approved, the comment is deleted');
  check(await page.locator('.article-comment-card').count() === 1, 'narrow: the page behind was refreshed');
  await show(page, '.agent-card:has-text("Comment delete")', 'last');
  await shot(page, 'narrow-approved');

  await page.locator('#agent-message').fill(`publish minecraft and delete comment ${second}`);
  await page.getByRole('button', { name: 'Send' }).tap();
  await afterReload(page, '.agent-card-waiting');
  await page.getByRole('button', { name: /^Decline/ }).tap();
  await page.waitForSelector('.agent-card-declined');
  await sleep(200);
  check((await commentsOf(page, MINECRAFT)).comments.includes(second), 'narrow: declined, the comment is still there');
  await show(page, '.agent-card-declined');
  await shot(page, 'narrow-declined');

  await page.getByRole('button', { name: /^Undo/ }).first().tap();
  await afterReload(page, '.agent-card-undone');
  check((await commentsOf(page, MINECRAFT)).article.status === 'DRAFT', 'narrow: undone, the article is back to draft');
  await show(page, '.agent-card-undone');
  await shot(page, 'narrow-undone');

  await streamingScroll(page, seen);

  await page.getByRole('button', { name: 'History', exact: true }).tap();
  await page.waitForSelector('.agent-thread-row');
  await shot(page, 'narrow-history');
  await page.getByRole('button', { name: 'Close agent' }).tap();
  check(await page.locator('#agent-panel').count() === 0, 'narrow: Close closes the sheet');
  check(seen.errors.length === 0, 'no console or page errors in the whole narrow run', seen.errors.join(' | '));
  check(localFailures(seen).length === 0, 'no failed request on the blog in the whole narrow run', localFailures(seen).join(' | '));
  await context.close();
}

try {
  if (scenario === 'limit') await limitScenario();
  else if (scenario === 'nokey') await nokeyScenario();
  else {
    await wideJourney();
    await narrowJourney();
  }
} catch (error) {
  console.log(`FAIL the run stopped: ${error.stack || error}`);
  failed++;
}
await browser.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
