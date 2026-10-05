//Signs in to a running blog through its real username form, opens one page
//and saves a full-page screenshot. Uses the playwright-core and Chromium that
//are already on this machine; nothing is added to the repository.
//  node screenshot-blog-page.mjs <out.png> [path] [baseUrl]
//WIDTH sets the viewport width (default 2400, wide enough for the list columns).
//Reads BLOG_USER and BLOG_PASS from the environment (the seed script's login
//is evidence-admin / evidence-pass-123). Exits non-zero on an error page.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE
  || '/mnt/paseo-shared/solution-projects/commerce-orders/node_modules/playwright-core');

const [ out, path = '/admin/agent-action/search', base = 'http://127.0.0.1:3411' ] = process.argv.slice(2);
const user = process.env.BLOG_USER || 'evidence-admin';
const pass = process.env.BLOG_PASS || 'evidence-pass-123';
const exe = process.env.CHROMIUM || `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;

const browser = await chromium.launch({ executablePath: exe, args: [ '--no-sandbox' ] });
const page = await browser.newPage({ viewport: { width: Number(process.env.WIDTH || 2400), height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(`${base}/auth/signin/username`, { waitUntil: 'networkidle' });
await page.locator('input[name=username]').fill(user);
await page.locator('input[name=secret]').fill(pass);
await page.locator('button[type=submit], input[type=submit]').first().click();
await page.waitForURL(u => !u.pathname.startsWith('/auth/signin'), { timeout: 15000 });
const res = await page.goto(base + path, { waitUntil: 'networkidle' });
console.log('status', res.status(), 'url', page.url(), 'title', await page.title());
if (errors.length) console.log('pageerrors', errors);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
if (res.status() !== 200 || !page.url().endsWith(path.split('?')[0]) && !page.url().includes(path)) process.exit(1);
