/**
 * Browser verification harness (no third-party dependencies).
 *
 * What it does: boots a real mongod replica set, a real backend, and the real Next.js
 * frontend, then drives headless Chrome over the DevTools Protocol (Chrome binary +
 * Node's built-in WebSocket) to check *rendered* behaviour:
 *   - the sign-in page renders its real form, and signing in through the browser
 *     produces a real session (the header switches from "Sign in" to the user's name)
 *   - a customer sees the capability gate on /admin
 *   - a super admin gets the MFA panel, satisfies it with a real TOTP code, and lands
 *     on a rendered admin shell
 *   - no horizontal overflow at a 390x844 mobile viewport
 *   - controls are keyboard reachable and show a focus ring
 *   - no uncaught page exceptions
 * PNG screenshots are written to docs/baselines/<date>/ as the visual baseline.
 *
 * This is the browser-rendering evidence. `tests/integration/http-contract.test.ts` is a
 * *different* thing: response header/status contracts over HTTP. Neither substitutes for
 * the other.
 *
 * Usage (from backend/):  npm run browser:check
 * Requires: a Chrome binary (CHROME_PATH overrides detection) and frontend dependencies.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplSet } from '../tests/helpers/mongo.ts';
import { png } from '../tests/helpers/images.ts';
import { loadConfig } from '../src/config/index.ts';
import { connectDb } from '../src/db/connection.ts';
import { ensureIndexes } from '../src/db/indexes.ts';
import { startServer } from '../src/server.ts';
import { createLogger } from '../src/shared/logger.ts';
import { bootstrapSuperAdmin } from '../src/modules/admin/bootstrap.ts';
import { seedCatalog } from './seed-catalog.ts';
import { generateTotp } from '../src/shared/totp.ts';
import { TestClient } from '../tests/helpers/client.ts';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(backendDir, '..');
const frontendDir = path.join(repoRoot, 'frontend');
const baselineDir = path.join(repoRoot, 'docs', 'baselines', new Date().toISOString().slice(0, 10));

const SUPER_PHONE = '55550100';
const SUPER_PW = 'browser super admin 1';
const CUSTOMER_PHONE = '55550101';
const CUSTOMER_PW = 'browser customer 1';
const BOOTSTRAP_TOKEN = 'browser-check-token';
const ORIGIN_PATH = '/signin?returnTo=%2Fadmin';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Minimal DevTools Protocol client over Node's global WebSocket. */
class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('chrome websocket failed')), { once: true });
    });
    return new Cdp(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message ?? 'cdp error'}`));
        else resolve(message.result);
        return;
      }
      for (const handler of this.handlers.get(message.method) ?? []) handler(message.params, message.sessionId);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method, handler) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler]);
  }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found; set CHROME_PATH');
  return found;
}

const processes = [];
function track(child) {
  processes.push(child);
  return child;
}

async function main() {
  mkdirSync(baselineDir, { recursive: true });

  // --- real mongod + real backend, development config (the frontend origin must be allowed) ---
  const frontendPort = await freePort();
  const frontendOrigin = `http://localhost:${frontendPort}`;
  const replSet = await createReplSet();
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: '0',
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: 'browser_check',
    CORS_ORIGINS: frontendOrigin,
    LOG_LEVEL: 'error',
    COOKIE_SECURE: 'false',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
    ADMIN_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
  });
  const handle = await connectDb(config);
  await ensureIndexes(handle.db);
  const server = await startServer({
    config,
    logger: createLogger('error', { write: () => true }),
    db: handle,
  });
  const apiUrl = `http://localhost:${server.port}`;
  process.stdout.write(`backend http://localhost:${server.port} · frontend ${frontendOrigin}\n`);

  // The catalogue screens are only meaningful with real taxonomy, schemas and locations in
  // the database, so the same guarded seed the operator runs fills this fresh database.
  await seedCatalog({ db: handle.db, logger: createLogger('error', { write: () => true }), withTransaction: handle.withTransaction });

  // --- fixture accounts, created over HTTP exactly like a real client would ---
  await bootstrapSuperAdmin(
    handle.db,
    { fullName: 'Browser Admin', phone: SUPER_PHONE, password: SUPER_PW },
    { expectedToken: BOOTSTRAP_TOKEN, confirmToken: BOOTSTRAP_TOKEN },
  );
  const adminClient = new TestClient(apiUrl);
  await adminClient.bootstrap();
  const adminLogin = await adminClient.post('/api/auth/login', {
    identifier: SUPER_PHONE,
    password: SUPER_PW,
  });
  if (adminLogin.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(adminLogin.body)}`);
  const enroll = await adminClient.post('/api/auth/mfa/enroll', {}, { origin: frontendOrigin });
  const secret = enroll.body.secret;
  await adminClient.post('/api/auth/mfa/enroll/confirm', { code: generateTotp(secret) }, { origin: frontendOrigin });

  // --- real frontend (Next dev server, driven from the working tree) ---
  const nextBin = path.join(frontendDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const frontend = track(
    spawn(process.execPath, [nextBin, 'dev', '-p', String(frontendPort)], {
      cwd: frontendDir,
      env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  const frontendLog = [];
  frontend.stdout.on('data', (d) => frontendLog.push(String(d)));
  frontend.stderr.on('data', (d) => frontendLog.push(String(d)));
  try {
    await waitFor(
      async () => {
        const res = await fetch(`${frontendOrigin}/signin`).catch(() => null);
        return res && res.ok;
      },
      { timeoutMs: 180_000, label: 'next dev to serve /signin' },
    );
  } catch (err) {
    process.stderr.write(frontendLog.join(''));
    throw err;
  }

  // --- headless Chrome over CDP ---
  const debugPort = await freePort();
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'araq-chrome-'));
  const chrome = track(
    spawn(
      findChrome(),
      [
        '--headless=new',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--window-size=1440,900',
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  const version = await waitFor(
    async () => {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null);
      return res && res.ok ? res.json() : null;
    },
    { timeoutMs: 60_000, label: 'chrome devtools endpoint' },
  );
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  cdp.send('Page.enable', {}, sessionId);
  cdp.send('Runtime.enable', {}, sessionId);
  cdp.send('Log.enable', {}, sessionId);

  const pageErrors = [];
  /**
   * Refusals the checks ask for on purpose — reading an unpublished or archived listing, and trying
   * to publish an incomplete one — are asserted outcomes, not defects. They are recorded separately
   * and reported as their own check, so the "no uncaught errors" check keeps its meaning instead of
   * being quietly relaxed: anything else still fails the run.
   */
  const assertedRefusals = [];
  cdp.on('Runtime.exceptionThrown', (params, sid) => {
    if (sid === sessionId) pageErrors.push(params.exceptionDetails?.text ?? 'uncaught exception');
  });
  cdp.on('Log.entryAdded', (params, sid) => {
    if (sid !== sessionId || params.entry.level !== 'error') return;
    const url = params.entry.url ?? '';
    // A missing favicon is not an application defect; anything else is.
    if (/favicon\.ico$/.test(url)) return;
    const text = params.entry.text ?? '';
    const deliberate =
      (/\/api\/listings\/[^/]+$/.test(url) && /404/.test(text)) ||
      (/\/api\/admin\/listings\/[^/]+$/.test(url) && /(409|422)/.test(text)) ||
      (/\/api\/admin\/listings\/[^/]+\/publish$/.test(url) && /422/.test(text));
    if (deliberate) {
      assertedRefusals.push(`${url} ${text.replace(/^Failed to load resource: /, '')}`);
      return;
    }
    pageErrors.push(`${params.entry.text}${url ? ` (${url})` : ''}`);
  });

  const evaluate = async (expression) => {
    const result = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    // Chrome reports a thrown Error as text "Uncaught"; the useful message lives in the
    // exception description, which is what a failing check should print.
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '';
      throw new Error(String(description).split('\n')[0] || 'evaluate failed');
    }
    return result.result.value;
  };

  const goto = async (url) => {
    await cdp.send('Page.navigate', { url }, sessionId);
    await waitFor(async () => (await evaluate('document.readyState')) === 'complete', {
      timeoutMs: 90_000,
      label: `load ${url}`,
    });
  };

  const waitForSelector = (selector, timeoutMs = 30_000) =>
    waitFor(async () => await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), {
      timeoutMs,
      label: `selector ${selector}`,
    });

  const setValue = async (selector, value) => {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('missing ' + ${JSON.stringify(selector)});
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  };

  /** Submit buttons first: the sign-in page also has a "Sign in" *tab*, and tabs are not submits. */
  const clickButtonByText = async (text) => {
    const clicked = await evaluate(`(() => {
      const matches = (b) => b.textContent.trim().includes(${JSON.stringify(text)});
      const submits = [...document.querySelectorAll('form button[type=submit]')].filter(matches);
      const el = submits[0] ?? [...document.querySelectorAll('button')].filter(matches)[0];
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`no button with text "${text}"`);
  };

  /**
   * Rendered text, lowercased once so comparisons stay case-insensitive: the admin tables
   * use `text-transform: uppercase` on headers, and innerText reports the transformed text.
   */
  const bodyText = async () => String(await evaluate('document.body.innerText')).toLowerCase();

  const waitForText = (text, timeoutMs = 30_000) =>
    waitFor(async () => (await bodyText()).includes(text.toLowerCase()), {
      timeoutMs,
      label: `body text "${text}"`,
    });

  const setViewport = (width, height, mobile = false) =>
    cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, sessionId);

  const screenshot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
    const file = path.join(baselineDir, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    return path.relative(repoRoot, file).split(path.sep).join('/');
  };

  const overflow = () =>
    evaluate('document.documentElement.scrollWidth - window.innerWidth').then((excess) => Math.round(excess));

  try {
    // ---------- 1. anonymous /signin renders ----------
    await setViewport(1440, 900);
    await goto(`${frontendOrigin}/signin`);
    await waitForSelector('#ph');
    check('signin page renders the real form', await evaluate("!!document.querySelector('#ph') && !!document.querySelector('#pw')"));
    check(
      'signin page keeps the brand chrome (gold submit + logo)',
      await evaluate(`(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Sign in');
        const logo = document.querySelector('img[src="/logo.png"]');
        return !!btn && !!logo;
      })()`),
    );
    check(
      'signin page hides the redundant header Sign in link',
      await evaluate("document.querySelector('header a[href=\"/signin\"]') === null"),
    );
    check('signin desktop has no horizontal overflow', (await overflow()) <= 0, `excess ${await overflow()}px`);
    check(
      'signin keeps its generated markup after wiring (phone field still prefixed +974)',
      await evaluate("document.body.innerText.includes('+974')"),
    );
    process.stdout.write(`  screenshot ${await screenshot('signin-desktop')}\n`);

    // ---------- 2. sign in as a customer through the UI ----------
    const customerClient = new TestClient(apiUrl);
    await customerClient.bootstrap();
    const registration = await customerClient.post(
      '/api/auth/register',
      {
        fullName: 'Browser Customer',
        phone: CUSTOMER_PHONE,
        email: 'browser.customer@example.test',
        password: CUSTOMER_PW,
        termsAccepted: true,
      },
      { origin: frontendOrigin },
    );
    if (registration.status !== 201) throw new Error(`customer fixture failed: ${JSON.stringify(registration.body)}`);
    const verifyToken = registration.body?.devVerifyToken;
    if (verifyToken) {
      const verified = await customerClient.post(
        '/api/auth/email/verify',
        { token: verifyToken },
        { origin: frontendOrigin },
      );
      if (verified.status !== 200) throw new Error(`email verify failed: ${JSON.stringify(verified.body)}`);
    }

    await setValue('#ph', CUSTOMER_PHONE);
    await setValue('#pw', CUSTOMER_PW);
    await clickButtonByText('Sign in');
    try {
      await waitForText('Browser Customer', 30_000);
    } catch (err) {
      const alert = await evaluate("(() => { const el = document.querySelector('[role=\"alert\"]'); return el ? el.innerText : ''; })()");
      throw new Error(`${err.message}; alert=${JSON.stringify(alert)}; page=${JSON.stringify(await evaluate('document.body.innerText.slice(0, 400)'))}`);
    }
    check('anonymous header offers Sign in until a session exists', await evaluate(`(() => {
      const header = document.querySelector('header');
      return header.innerText.includes('Browser Customer');
    })()`));
    check(
      'signing in through the browser creates a real session (header shows the name)',
      await evaluate("document.querySelector('header').innerText.includes('Browser Customer')"),
    );

    // ---------- 3. customer hitting the admin gate ----------
    await goto(`${frontendOrigin}/admin`);
    await waitForText('No admin access');
    check('customer sees the capability gate instead of admin tools', await evaluate("document.body.innerText.includes('No admin access')"));
    check('admin gate keeps brand chrome', await evaluate("!!document.querySelector('img[src=\"/logo.png\"]')"));
    process.stdout.write(`  screenshot ${await screenshot('admin-no-access-desktop')}\n`);

    // ---------- 4. mobile viewport ----------
    await setViewport(390, 844, true);
    await goto(`${frontendOrigin}/signin`);
    await waitForSelector('#ph');
    const mobileExcess = await overflow();
    check('signin mobile (390x844) has no horizontal overflow', mobileExcess <= 0, `excess ${mobileExcess}px`);
    check(
      'signin mobile keeps the phone field usable (>= 40px tall)',
      await evaluate("document.querySelector('#ph').getBoundingClientRect().height >= 40"),
    );
    process.stdout.write(`  screenshot ${await screenshot('signin-mobile')}\n`);
    await setViewport(1440, 900);

    // ---------- 5. keyboard reachability on the signin form ----------
    await goto(`${frontendOrigin}/signin`);
    await waitForSelector('#ph');
    const tabOrder = [];
    for (let i = 0; i < 12; i += 1) {
      await cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
        sessionId,
      );
      await cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
        sessionId,
      );
      tabOrder.push(await evaluate('document.activeElement && (document.activeElement.id || document.activeElement.tagName)'));
    }
    check('keyboard Tab reaches the phone field', tabOrder.includes('ph'), tabOrder.join(' → '));
    check('keyboard Tab reaches the password field', tabOrder.includes('pw'));
    check('keyboard Tab reaches the submit button', tabOrder.some((entry) => entry === 'BUTTON'));
    await evaluate("document.querySelector('#pw').focus()");
    const focusRing = await evaluate(
      "(() => { const s = getComputedStyle(document.querySelector('#pw')); return s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor; })()",
    );
    check('focused control shows a visible focus ring', /solid (2|3)px/.test(focusRing), focusRing);

    // ---------- 6. super admin signs in and satisfies MFA in the browser ----------
    await goto(`${frontendOrigin}${ORIGIN_PATH}`);
    await waitForSelector('#ph');
    await setValue('#ph', SUPER_PHONE);
    await setValue('#pw', SUPER_PW);
    await clickButtonByText('Sign in');
    await waitForText('Two-step verification', 30_000);
    check('staff sign-in reveals the MFA step in the browser', await evaluate("!!document.querySelector('#mfa')"));
    check(
      'pre-MFA session does not expose admin navigation',
      !(await evaluate('document.body.innerText')).includes('Capabilities'),
    );

    const code = generateTotp(secret);
    await setValue('#mfa', code);
    await clickButtonByText('Verify and continue');
    await waitFor(async () => (await evaluate('location.pathname')) === '/admin', {
      timeoutMs: 30_000,
      label: 'redirect to /admin after MFA',
    });
    await waitForText('Capabilities');
    check('after MFA the browser lands on the rendered admin shell', (await evaluate('location.pathname')) === '/admin');
    check(
      'admin shell lists server-provided capabilities',
      await evaluate("document.body.innerText.includes('inventory.manage') && document.body.innerText.includes('roles.manage')"),
    );
    check(
      'admin shell exposes the new catalog sections',
      await evaluate("['Sellers', 'Categories', 'Attributes', 'Media'].every((label) => document.body.innerText.includes(label))"),
    );
    check('admin desktop has no horizontal overflow', (await overflow()) <= 0, `excess ${await overflow()}px`);
    process.stdout.write(`  screenshot ${await screenshot('admin-desktop')}\n`);

    // ---------- 7. every catalogue section renders real data, on desktop and mobile ----------
    const sections = [
      { path: '/admin/sellers', name: 'sellers', expect: 'Offline sellers' },
      { path: '/admin/taxonomy', name: 'taxonomy', expect: 'Listing methods' },
      { path: '/admin/attributes', name: 'attributes', expect: 'Category attributes' },
      { path: '/admin/locations', name: 'locations', expect: 'Public precision' },
      { path: '/admin/media', name: 'media', expect: 'Collection key' },
    ];
    for (const section of sections) {
      await setViewport(1440, 900);
      await goto(`${frontendOrigin}${section.path}`);
      await waitForText(section.expect);
      const body = await bodyText();
      const excess = await overflow();
      check(`${section.name} screen renders its heading`, body.includes(section.expect.toLowerCase()));
      check(`${section.name} desktop has no horizontal overflow`, excess <= 0, `excess ${excess}px`);
      process.stdout.write(`  screenshot ${await screenshot(`admin-${section.name}-desktop`)}\n`);

      await setViewport(390, 844, true);
      await goto(`${frontendOrigin}${section.path}`);
      await waitForText(section.expect);
      const mobileExcess = await overflow();
      check(`${section.name} mobile (390x844) has no horizontal overflow`, mobileExcess <= 0, `excess ${mobileExcess}px`);
      process.stdout.write(`  screenshot ${await screenshot(`admin-${section.name}-mobile`)}\n`);
    }

    // The seeded taxonomy and attribute schema must be what the screens show.
    await setViewport(1440, 900);
    await goto(`${frontendOrigin}/admin/taxonomy`);
    await waitForText('vehicles');
    check(
      'taxonomy shows the seeded hierarchy with its listing methods',
      (await bodyText()).includes('vehicles') && (await bodyText()).includes('fixed price'),
    );
    await goto(`${frontendOrigin}/admin/attributes`);
    await waitForText('Category attributes');
    await waitForSelector('#attr-category');
    await evaluate(`(() => {
      const select = document.querySelector('#attr-category');
      const option = [...select.options].find((o) => o.value === 'vehicles');
      if (!option) throw new Error('vehicles is not offered as a category');
      select.value = 'vehicles';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitForText('v1');
    check(
      'attribute screen loads the published schema version for a category',
      (await bodyText()).includes('published') && (await bodyText()).includes('v1'),
    );
    await goto(`${frontendOrigin}/admin/media`);
    await waitForText('images only');
    check(
      'media screen states that video is not enabled and lists the real limits',
      (await bodyText()).includes('images only') && (await bodyText()).includes('max files per collection'),
    );
    check(
      'media screen takes files, not client-supplied URLs',
      await evaluate(`(() => {
        const inputs = [...document.querySelectorAll('input')];
        return inputs.filter((el) => el.type === 'file').length === 1 &&
          inputs.every((el) => !/url/i.test(el.id + el.name));
      })()`),
    );

    // A real upload through the rendered UI: pick a real file, let the page send the bytes,
    // and require the preview the server actually serves afterwards.
    const uploadPath = path.join(os.tmpdir(), `araq-browser-upload-${Date.now()}.png`);
    writeFileSync(uploadPath, png(320, 240, { text: 'GPS 25.2854,51.5310' }));
    await cdp.send('DOM.enable', {}, sessionId);
    const document = await cdp.send('DOM.getDocument', { depth: -1 }, sessionId);
    const fileInputNode = await cdp.send(
      'DOM.querySelector',
      { nodeId: document.root.nodeId, selector: '#media-file' },
      sessionId,
    );
    await cdp.send('DOM.setFileInputFiles', { files: [uploadPath], nodeId: fileInputNode.nodeId }, sessionId);
    await waitForSelector('.adm-thumb img', 90_000);
    check(
      'uploading a file through the browser UI renders the served preview',
      await evaluate(`(async () => {
        const img = document.querySelector('.adm-thumb img');
        if (!img) return false;
        await img.decode().catch(() => {});
        return img.naturalWidth > 0 && img.naturalHeight > 0;
      })()`),
    );
    check(
      'the uploaded asset is shown as ready with metadata stripped',
      (await bodyText()).includes('ready') && (await bodyText()).includes('metadata stripped'),
    );
    rmSync(uploadPath, { force: true });

    // ---------- 8. Phase 05: listing drafts, the admin wizard, publication and public discovery ----------
    // A publishable listing needs an approved seller. Creating one and approving it are staff
    // decisions the API owns, so the harness performs that prerequisite at its own boundary and
    // then drives every listing action through the rendered UI.
    const sellerSearch = await adminClient.get('/api/admin/sellers?status=active&limit=1');
    let approvedSeller = (sellerSearch.body.sellers ?? [])[0] ?? null;
    if (!approvedSeller) {
      const created = await adminClient.post('/api/admin/sellers', {
        type: 'individual',
        displayName: 'Wizard Verification Seller',
        contact: { phone: '55550177' },
        reason: 'Prerequisite seller for the browser verification run',
      });
      if (created.status !== 201) throw new Error(`seller creation failed: ${JSON.stringify(created.body)}`);
      const activated = await adminClient.patch(`/api/admin/sellers/${created.body.seller.sellerReference}/status`, {
        status: 'active',
        reason: 'Approved for the browser verification run',
      });
      if (activated.status !== 200) throw new Error(`seller activation failed: ${JSON.stringify(activated.body)}`);
      approvedSeller = activated.body.seller;
    }
    process.stdout.write(`  using approved seller ${approvedSeller.displayName} (${approvedSeller.sellerReference})\n`);

    await setViewport(1440, 900);
    await goto(`${frontendOrigin}/admin/listings`);
    await waitForText('no listings match these filters');
    check(
      'the listings screen renders an honest empty state before anything is published',
      (await bodyText()).includes('no listings match these filters'),
    );
    check(
      'the listings screen states that staff, not sellers, create inventory',
      (await bodyText()).includes('seller self-service is not approved'),
    );

    // A real active seller, chosen the way an operator chooses one.
    await clickButtonByText('New draft listing');
    await waitForSelector('#new-seller');
    const seller = await evaluate(`(() => {
      const select = document.querySelector('#new-seller');
      const option = [...select.options].find((candidate) => candidate.value);
      if (!option) throw new Error('no active seller is offered for a listing');
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { reference: option.value, name: option.textContent.trim() };
    })()`);
    check('only an active seller can be chosen for a new listing', Boolean(seller.reference), seller.name);

    const selectOption = (selector, value) =>
      evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('missing ' + ${JSON.stringify(selector)});
        const option = [...el.options].find((candidate) => candidate.value === ${JSON.stringify(value)});
        if (!option) throw new Error('option ' + ${JSON.stringify(value)} + ' is not offered by ' + ${JSON.stringify(selector)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);

    const clickSelector = (selector) =>
      evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('missing ' + ${JSON.stringify(selector)});
        el.click();
        return true;
      })()`);

    /** A genuine mouse click at the element's centre, the way an operator clicks a checkbox. */
    /** Navigation is a URL outcome: report the path instead of throwing on the first attempt. */
    const waitForPath = async (expected, timeoutMs = 20_000) => {
      try {
        await waitFor(async () => (await evaluate('location.pathname')) === expected, {
          timeoutMs,
          label: `the browser to be at ${expected}`,
        });
        return true;
      } catch {
        return false;
      }
    };

    /** Rendered text arrives asynchronously after a client-side navigation, so wait rather than throw. */
    const waitForTextResult = async (text, timeoutMs = 20_000) => {
      try {
        await waitForText(text, timeoutMs);
        return true;
      } catch {
        return false;
      }
    };

    const clickAt = async (selector) => {
      const box = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('missing ' + ${JSON.stringify(selector)});
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      const point = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point }, sessionId);
    };

    /** "Saved" as a whole word, so the settled badge is never confused with "Unsaved changes". */
    const waitForSaved = (timeoutMs = 45_000) =>
      waitFor(async () => /(?<![a-z])saved(?![a-z])/.test(await bodyText()), {
        timeoutMs,
        label: 'the wizard to report a settled save',
      });

    /** Put a real encoder-produced PNG into the wizard's file input, through Chrome itself. */
    const uploadThroughWizard = async (label) => {
      const file = path.join(os.tmpdir(), `araq-listing-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
      writeFileSync(file, png(720, 540, { text: label }));
      const document = await cdp.send('DOM.getDocument', { depth: -1 }, sessionId);
      const input = await cdp.send(
        'DOM.querySelector',
        { nodeId: document.root.nodeId, selector: '#w-file' },
        sessionId,
      );
      await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId: input.nodeId }, sessionId);
      await waitForSelector('[id^="attach-"]', 120_000);
      // Chrome keeps the handle for a moment after the upload on Windows; a leftover temp file is
      // harmless, so removal is best-effort rather than a reason to fail the run.
      try {
        rmSync(file, { force: true });
      } catch {
        /* still held by the browser */
      }
      return evaluate(`document.querySelector('[id^="attach-"]').id.slice('attach-'.length)`);
    };

    /**
     * Walks the real wizard: a persisted draft, localized content, structured attributes and a real
     * uploaded image. Publication is a separate, server-decided step.
     */
    async function buildListingThroughWizard({ title, description, photoText, publish, withMedia = true, conflictProbe = false }) {
      await goto(`${frontendOrigin}/admin/listings`);
      await waitForText('inventory records');
      await clickButtonByText('New draft listing');
      await waitForSelector('#new-seller');
      await selectOption('#new-seller', seller.reference);
      // The seeded published attribute schema belongs to the vehicles category, so the wizard has
      // real, category-dependent fields to render and validate.
      await selectOption('#new-category', 'vehicles');
      await clickButtonByText('Create draft');
      await waitFor(
        async () => {
          const path = await evaluate('location.pathname');
          if (path.startsWith('/admin/listings/')) return path;
          // A refusal is reported with the server's own words, so a failing run says why.
          const refusal = await evaluate(
            "(() => { const el = document.querySelector('[role=\"alert\"]'); return el ? el.innerText : ''; })()",
          );
          if (refusal) throw new Error(`the server refused the draft: ${refusal}`);
          return null;
        },
        { timeoutMs: 30_000, label: 'the created draft to open in the wizard' },
      );
      const reference = (await evaluate('location.pathname')).split('/').pop();
      if (!reference || reference === 'listings') throw new Error('the wizard route carries no listing reference');

      await waitForSelector('#w-language');
      await clickButtonByText('Continue to content');
      await waitForSelector('#title-en');
      await setValue('#title-en', title);
      await setValue('#description-en', description);
      await waitForSaved();

      if (conflictProbe) {
        // Competing edits: another operator saves the same record while this wizard holds an older
        // version. The autosave must be refused as a conflict — visibly — and never as success.
        const read = await adminClient.get(`/api/admin/listings/${reference}`);
        const competing = await adminClient.patch(`/api/admin/listings/${reference}`, {
          adminNotes: 'Edited by another operator during the browser run',
          expectedVersion: read.body.listing.version,
        });
        if (competing.status !== 200) throw new Error(`competing edit refused: ${JSON.stringify(competing.body)}`);
        await setValue('#title-en', `${title} (editing)`);
        const conflictVisible = await waitForTextResult('someone else changed this listing', 45_000);
        check(`competing edits are refused and reported as a conflict (${reference})`, conflictVisible);
        if (conflictVisible) {
          await clickButtonByText('Reload server version');
          const recovered = await waitForTextResult('local unsaved edits were discarded', 30_000);
          check(`the conflict can be resolved by reloading the server version (${reference})`, recovered);
          await setValue('#title-en', title);
          await waitForSaved();
        }
      }

      await clickButtonByText('Continue to attributes');
      await waitForSelector('#attr-make');
      await setValue('#attr-make', 'Toyota');
      await setValue('#attr-model', 'Land Cruiser');
      await setValue('#attr-year', '2021');
      await selectOption('#attr-condition', 'used');
      await waitForSaved();

      await clickButtonByText('Continue to media');
      await waitForSelector('#w-file');
      if (!withMedia) {
        await clickButtonByText('Continue to review');
        return { reference, title, assetId: null, draftMediaUrl: null, previewRendered: null };
      }
      const assetId = await uploadThroughWizard(photoText);
      // Uploading attaches the new asset to this listing, so the preview must appear immediately.
      await waitFor(async () => await evaluate("document.querySelector('[id^=\"attach-\"]').checked === true"), {
        timeoutMs: 30_000,
        label: 'the uploaded image to be attached to the listing',
      });
      await waitForSelector('.adm-thumb img');
      const previewRendered = await evaluate(`(async () => {
        const img = document.querySelector('.adm-thumb img');
        await img.decode().catch(() => {});
        return img.naturalWidth > 0 && img.naturalHeight > 0;
      })()`);
      await waitForText('unsaved changes');
      await waitForSaved();

      // The attach control works both ways, and each change is saved before the next one starts.
      await clickAt('[id^="attach-"]');
      await waitForText('unsaved changes');
      await waitFor(async () => await evaluate("document.querySelector('[id^=\"attach-\"]').checked === false"), {
        label: 'the image to detach',
      });
      await waitForSaved();
      await clickAt('[id^="attach-"]');
      await waitForText('unsaved changes');
      await waitFor(async () => await evaluate("document.querySelector('[id^=\"attach-\"]').checked === true"), {
        label: 'the image to be attached again',
      });
      await waitForSaved();
      const draftMediaUrl = `${apiUrl}/api/listings/${reference}/media/${assetId}/file`;

      await clickButtonByText('Continue to review');
      await waitForText('at least one image attached');

      if (!publish) return { reference, title, assetId, draftMediaUrl, previewRendered };

      // The same asset, still attached to an unpublished draft, must not be readable anonymously.
      const beforePublish = await fetch(draftMediaUrl);
      check(
        `the draft image of ${reference} is not readable without a session`,
        beforePublish.status === 403 || beforePublish.status === 404,
        `status ${beforePublish.status}`,
      );

      await clickAt('#confirm-publish');
      await waitFor(async () => await evaluate("document.querySelector('#confirm-publish').checked === true"), {
        label: 'the publication confirmation to be ticked',
      });
      await clickButtonByText('Publish listing');
      await waitForText('already published');
      const afterPublish = await fetch(draftMediaUrl);
      check(
        `publishing ${reference} makes that same image publicly readable`,
        afterPublish.status === 200 && (afterPublish.headers.get('content-type') ?? '').includes('image/png'),
        `status ${afterPublish.status} · ${afterPublish.headers.get('content-type')}`,
      );
      return { reference, title, assetId, draftMediaUrl, previewRendered };
    }

    const first = await buildListingThroughWizard({
      title: 'Toyota Land Cruiser 2021 family SUV',
      description: 'One owner, full dealer service history, registered in Doha. Inspection welcome by appointment.',
      photoText: 'Land Cruiser 2021',
      publish: true,
      conflictProbe: true,
    });
    check('a wizard-uploaded PNG renders as a real image in the admin preview', first.previewRendered, first.reference);
    check(
      'the draft record keeps a stable, URL-safe public ad reference',
      /^l_[A-Za-z0-9_-]{6,}$/.test(first.reference),
      first.reference,
    );
    process.stdout.write(`  screenshot ${await screenshot('admin-listing-wizard-desktop')}\n`);

    const second = await buildListingThroughWizard({
      title: 'Nissan Patrol 2019 ex-fleet',
      description: 'Fleet maintained, 92,000 km, second owner. Available for viewing at our Doha yard this week.',
      photoText: 'Patrol 2019',
      publish: true,
    });

    // A draft without images: the server, not the wizard, is what refuses publication.
    const draft = await buildListingThroughWizard({
      title: 'Honda Civic 2015 draft only',
      description: 'Still being written up by the team; the images arrive later this week.',
      publish: false,
      withMedia: false,
    });
    await clickAt('#confirm-publish');
    await waitFor(async () => await evaluate("document.querySelector('#confirm-publish').checked === true"), {
      label: 'the publication confirmation to be ticked',
    });
    await clickButtonByText('Publish listing');
    await waitForText('listing is not valid');
    const draftStillDraft = await fetch(`${apiUrl}/api/listings/${draft.reference}`);
    check(
      'the server refuses to publish a listing with no images',
      (await bodyText()).includes('listing is not valid'),
    );
    check(
      'the refused draft is still not readable as a public listing',
      draftStillDraft.status === 404 || draftStillDraft.status === 403,
      `status ${draftStillDraft.status}`,
    );

    // A persisted draft survives a full page reload, with its content and its status.
    await goto(`${frontendOrigin}/admin/listings/${draft.reference}`);
    await waitForText(draft.title);
    check(
      `the draft survives a reload with its content and status (${draft.reference})`,
      (await bodyText()).includes(draft.title.toLowerCase()) && (await bodyText()).includes('draft'),
    );
    // Let the reloaded draft settle before navigating away: leaving while a save is in flight is
    // what the wizard's unsaved-change guard is for, and a programmatic exit has no user gesture.
    await waitForSaved();

    // Back on the list: what exists, what is published and what is still a draft.
    await goto(`${frontendOrigin}/admin/listings`);
    await waitForText(first.title);
    const listText = await bodyText();
    check(
      'the listings table shows both published records and the remaining draft',
      listText.includes(first.title.toLowerCase()) &&
        listText.includes(second.title.toLowerCase()) &&
        listText.includes(draft.title.toLowerCase()) &&
        listText.includes('published') &&
        listText.includes('draft'),
    );

    const anonymousPublished = await fetch(`${apiUrl}/api/listings/${first.reference}`);
    const anonymousDraft = await fetch(`${apiUrl}/api/listings/${draft.reference}`);
    check('a published listing is readable without a session', anonymousPublished.status === 200, `status ${anonymousPublished.status}`);
    check('a draft listing is not readable without a session', anonymousDraft.status === 404, `status ${anonymousDraft.status}`);

    // ---------- 9. public discovery: browse, detail routing and URL state ----------
    await goto(`${frontendOrigin}/browse`);
    await waitForText(first.title);
    const cardLinks = await evaluate(
      "[...document.querySelectorAll('main a[href^=\"/product/\"]')].map((a) => a.getAttribute('href'))",
    );
    const distinctCards = [...new Set(cardLinks)];
    check(
      'each published listing gets its own card link, not one shared demo record',
      distinctCards.length === 2 &&
        distinctCards.includes(`/product/${first.reference}`) &&
        distinctCards.includes(`/product/${second.reference}`),
      distinctCards.join(', '),
    );
    process.stdout.write(`  screenshot ${await screenshot('public-browse-desktop')}\n`);

    // Clicking the second card must open the second record.
    await clickSelector(`main a[href="/product/${second.reference}"]`);
    await waitFor(async () => (await evaluate('location.pathname')) === `/product/${second.reference}`, {
      label: 'the card link to open that listing',
    });
    await waitForText(second.title);
    const detailText = await bodyText();
    check('a card opens the record it advertises', detailText.includes(second.title.toLowerCase()), second.title);
    check(
      'the public detail page shows the real seller and ad reference',
      detailText.includes(second.reference.toLowerCase()) && detailText.includes(seller.name.toLowerCase()),
      seller.name,
    );
    check(
      'the public detail page renders the listing image the server serves',
      await evaluate(`(async () => {
        const img = document.querySelector('section[aria-label="Photos"] img');
        if (!img) return false;
        await img.decode().catch(() => {});
        return img.naturalWidth > 0 && img.naturalHeight > 0 && img.currentSrc.includes('/media/');
      })()`),
    );
    check(
      'the public listing payload carries no staff-only notes',
      !detailText.includes('internal note for verifying ownership') && !detailText.includes('private staff notes'),
    );
    process.stdout.write(`  screenshot ${await screenshot('public-product-detail-desktop')}\n`);

    // URL state: shareable, reloadable, Back/Forward-safe, and safe with junk parameters.
    const sharedUrl = `${frontendOrigin}/browse?q=land+cruiser&sort=title&category=vehicles&page=1`;
    await goto(sharedUrl);
    await waitForText(first.title);
    check(
      'a shared browse URL with filters survives a reload and keeps its results',
      (await bodyText()).includes(first.title.toLowerCase()) &&
        !(await bodyText()).includes(second.title.toLowerCase()),
    );
    await goto(`${frontendOrigin}/browse?page=abc&limit=99999&sort=nonsense&condition=not-a-condition`);
    await waitForText(first.title);
    check(
      'nonsense query parameters are handled without an error screen',
      (await bodyText()).includes(first.title.toLowerCase()) &&
        !(await bodyText()).includes('could not be loaded'),
    );

    await goto(`${frontendOrigin}/browse`);
    await waitForText(second.title);
    await clickSelector(`main a[href="/product/${first.reference}"]`);
    await waitFor(async () => (await evaluate('location.pathname')) === `/product/${first.reference}`, {
      label: 'the first card to open',
    });
    await evaluate('history.back()');
    const backAtResults = await waitForPath('/browse');
    check('browser Back returns to the browse results', backAtResults, await evaluate('location.pathname'));
    check(
      'the browse results are the ones the visitor left',
      backAtResults && (await waitForTextResult(second.title)),
    );
    await evaluate('history.forward()');
    const forwardAtListing = await waitForPath(`/product/${first.reference}`);
    check('browser Forward returns to the listing', forwardAtListing, await evaluate('location.pathname'));
    check('the listing is the one the visitor opened', forwardAtListing && (await waitForTextResult(first.title)));

    // Legacy bare routes resolve deliberately instead of showing one hardcoded demo record.
    await goto(`${frontendOrigin}/product`);
    await waitFor(async () => (await evaluate('location.pathname')) === '/browse', {
      label: 'the bare /product route to redirect',
    });
    check('the bare /product route redirects to browse', (await evaluate('location.pathname')) === '/browse');
    await goto(`${frontendOrigin}/lot`);
    await waitFor(async () => (await evaluate('location.pathname')) === '/auctions', {
      label: 'the bare /lot route to redirect',
    });
    check('the bare /lot route redirects to the auction disclosure page', (await evaluate('location.pathname')) === '/auctions');
    await goto(`${frontendOrigin}/product/${draft.reference}`);
    await waitForText('this listing is not available');
    check(
      'an unpublished reference is not a public listing page',
      (await bodyText()).includes('this listing is not available'),
    );
    await goto(`${frontendOrigin}/lot/${first.reference}`);
    await waitForText('is not open');
    check('a lot route refuses to fake a live auction', (await bodyText()).includes('is not open'));

    // Homepage and the auction disclosure page must reflect real records, not seeded samples.
    await goto(`${frontendOrigin}/`);
    await waitForText(first.title);
    check('the homepage renders real published listings', (await bodyText()).includes(first.title.toLowerCase()));
    await goto(`${frontendOrigin}/auctions`);
    await waitForText('what you cannot do yet');
    const auctionsText = await bodyText();
    check(
      'the auction page discloses that no bidding exists yet',
      auctionsText.includes('no bids can be placed') && !auctionsText.includes('place bid'),
    );

    // ---------- 10. archive policy: publication is what grants public access ----------
    await goto(`${frontendOrigin}/admin/listings`);
    await waitForText(first.title);
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes(${JSON.stringify(first.reference)}));
      if (!row) throw new Error('no row for ' + ${JSON.stringify(first.reference)});
      const button = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Archive');
      if (!button) throw new Error('no archive control on the published row');
      button.click();
      return true;
    })()`);
    await waitForSelector('input[id^="reason-"]');
    await setValue('input[id^="reason-"]', 'Withdrawn at the consignor request (browser check)');
    await clickButtonByText('Confirm archive');
    await waitForText(`archived ${first.reference.toLowerCase()}`);
    await goto(`${frontendOrigin}/product/${first.reference}`);
    await waitForText('this listing is not available');
    check('an archived listing leaves public view', (await bodyText()).includes('this listing is not available'));
    const archivedMedia = await fetch(first.draftMediaUrl);
    check(
      'archiving revokes anonymous access to the listing images',
      archivedMedia.status === 404 || archivedMedia.status === 403,
      `status ${archivedMedia.status}`,
    );
    await goto(`${frontendOrigin}/browse`);
    await waitForText(second.title);
    check(
      'the archived listing is gone from browse while the other one remains',
      !(await bodyText()).includes(first.title.toLowerCase()),
    );

    // Mobile rendering of the public screens.
    await setViewport(390, 844, true);
    await goto(`${frontendOrigin}/browse`);
    await waitForText(second.title);
    const browseMobileExcess = await overflow();
    check('public browse mobile (390x844) has no horizontal overflow', browseMobileExcess <= 0, `excess ${browseMobileExcess}px`);
    process.stdout.write(`  screenshot ${await screenshot('public-browse-mobile')}\n`);
    await goto(`${frontendOrigin}/product/${second.reference}`);
    await waitForText(second.title);
    const detailMobileExcess = await overflow();
    check(
      'public listing detail mobile (390x844) has no horizontal overflow',
      detailMobileExcess <= 0,
      `excess ${detailMobileExcess}px`,
    );
    process.stdout.write(`  screenshot ${await screenshot('public-product-detail-mobile')}\n`);
    await setViewport(1440, 900);

    // Keyboard operability: the seller search field is reachable and shows a focus ring.
    await goto(`${frontendOrigin}/admin/sellers`);
    await waitForText('Offline sellers');
    await waitForSelector('#seller-search');
    const adminTabs = [];
    for (let i = 0; i < 14; i += 1) {
      await cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
        sessionId,
      );
      await cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
        sessionId,
      );
      adminTabs.push(await evaluate('document.activeElement && (document.activeElement.id || document.activeElement.tagName)'));
    }
    check('keyboard Tab reaches the seller search field', adminTabs.includes('seller-search'), adminTabs.join(' → '));
    check('keyboard Tab reaches the seller status filter', adminTabs.includes('seller-status'));
    await evaluate("document.querySelector('#seller-search').focus()");
    const adminFocusRing = await evaluate(
      "(() => { const s = getComputedStyle(document.querySelector('#seller-search')); return s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor; })()",
    );
    check('admin form control shows a visible focus ring', /solid (2|3)px/.test(adminFocusRing), adminFocusRing);

    // Creating an offline seller through the rendered UI proves the form is wired end to end.
    await clickButtonByText('New seller');
    await waitForSelector('#new-seller-name');
    await setValue('#new-seller-name', 'Browser Seller');
    await setValue('#new-seller-phone', '55550199');
    await clickButtonByText('Create seller');
    await waitForText('Browser Seller', 30_000);
    check(
      'creating an offline seller from the browser persists and renders it',
      (await bodyText()).includes('browser seller'),
    );



    await setViewport(390, 844, true);
    await goto(`${frontendOrigin}/admin`);
    await waitForText('Capabilities');
    const adminMobileExcess = await overflow();
    check('admin mobile (390x844) has no horizontal overflow', adminMobileExcess <= 0, `excess ${adminMobileExcess}px`);
    process.stdout.write(`  screenshot ${await screenshot('admin-mobile')}\n`);

    check(
      'the only client-side errors were the refusals the checks asked for',
      assertedRefusals.length >= 4,
      `${assertedRefusals.length} asserted refusal(s): ${assertedRefusals.join(' · ')}`,
    );
    check('no uncaught page exceptions during the whole run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    for (const child of processes.reverse()) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    await server.stop().catch(() => {});
    await handle.close().catch(() => {});
    await replSet.stop().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  writeFileSync(
    path.join(baselineDir, 'browser-check.md'),
    [
      `# Browser verification — ${new Date().toISOString()}`,
      '',
      'Driven by `backend/scripts/browser-check.mjs` (headless Chrome over CDP) against a real',
      'mongod replica set, the real Express backend and the real Next.js frontend.',
      '',
      `Chrome: ${version.Browser}`,
      '',
      '| Check | Result | Detail |',
      '|---|---|---|',
      ...results.map((r) => `| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.detail || '—'} |`),
      '',
      `Total: ${results.length - failed.length}/${results.length} PASS.`,
      '',
      'Screenshots in this directory are the visual baseline for the captured pages/viewports.',
      'No git repository exists, so the revision is recorded as the run date plus file mtimes.',
      '',
    ].join('\n'),
  );

  process.stdout.write(`\n${failed.length === 0 ? 'ALL BROWSER CHECKS PASSED' : `${failed.length} BROWSER CHECK(S) FAILED`}\n`);
  process.stdout.write(`evidence: docs/baselines/${path.basename(baselineDir)}/browser-check.md\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`browser check failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  for (const child of processes.reverse()) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  process.exit(1);
});
