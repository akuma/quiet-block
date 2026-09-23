/**
 * End-to-end smoke test in a real Chrome.
 *
 * Launches Chrome with the built extension loaded, then drives it over the
 * DevTools Protocol to check the things unit tests cannot: that the rules
 * actually install, that an advertising request is really blocked, that
 * cosmetic hiding really hides, and that a whitelisted site is left alone.
 *
 * Not part of `bun run verify` because it needs a Chrome binary and a spare
 * profile. Run it manually:
 *
 *   bun run build && bun run e2e
 *
 * Looks for Chrome at the usual macOS location; override with CHROME_BIN.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quietblock-e2e-'));
const profileDir = path.join(workDir, 'profile');
let DEBUG_PORT = 0;

/**
 * Browsers that can load an unpacked extension from the command line.
 *
 * Recent Google Chrome builds refuse `--load-extension` outside Chromium
 * ("--load-extension is not allowed in Google Chrome"), so Edge is tried as
 * well - it is Chromium-based and implements the same extension APIs. Override
 * the whole search with CHROME_BIN.
 */
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

/** Picks the first browser that actually loads the extension. */
async function pickBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    const exists = await fs
      .access(candidate)
      .then(() => true)
      .catch(() => false);
    if (exists) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Minimal DevTools Protocol client
 * ------------------------------------------------------------------ */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const settle = this.pending.get(message.id);
        if (settle) {
          this.pending.delete(message.id);
          settle(message);
        }
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => {
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  /** Evaluates an expression in a target and returns its value. */
  async evaluate(sessionId, expression) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`evaluate failed: ${description}`);
    }
    return result.result.value;
  }

  drainEvents(method) {
    const found = this.events.filter((event) => event.method === method);
    this.events = this.events.filter((event) => event.method !== method);
    return found;
  }

  close() {
    this.ws.close();
  }
}

async function connect(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`WebSocket failed: ${webSocketDebuggerUrl}`)), {
      once: true,
    });
  });
  return new Cdp(ws);
}

async function getJson(url) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Chrome is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chrome did not become reachable at ${url}`);
}

/**
 * Chrome derives an unpacked extension's id from the absolute path of the
 * directory it was loaded from, so we can tell our own extension apart from the
 * component extensions that every profile also loads.
 */
async function computeExtensionId(extensionPath) {
  const crypto = await import('node:crypto');
  const hex = crypto.createHash('sha256').update(path.resolve(extensionPath)).digest('hex').slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (character) =>
    'abcdefghijklmnop'['0123456789abcdef'.indexOf(character)],
  );
}

/* ------------------------------------------------------------------ *
 * Test harness
 * ------------------------------------------------------------------ */

const results = { passed: [], failed: [] };

function check(name, condition, detail = '') {
  if (condition) {
    results.passed.push(name);
    console.log(`  ok   ${name}`);
  } else {
    results.failed.push(`${name}${detail ? `: ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const TEST_PAGE = `<!doctype html>
<html><head><title>QuietBlock e2e</title></head>
<body>
  <div class="e2e-ad" id="ad">advertisement</div>
  <div class="normal" id="normal">content</div>
  <img id="ad-image" src="https://e2e-blocked.test/pixel.gif" alt="" />
  <script src="https://e2e-allowed.test/script.js"></script>
</body></html>`;

async function main() {
  DEBUG_PORT = await freePort();
  const port = await freePort();
  const expectedId = await computeExtensionId(dist);

  /**
   * Launches a browser with the extension and waits until either our
   * extension appears in the target list or the browser turns out to refuse
   * `--load-extension`. Returns null when the browser cannot load it.
   */
  const launch = async (bin) => {
    const child = spawn(bin, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      'about:blank',
    ]);
    child.stderr.on('data', () => {});
    try {
      const version = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      for (let attempt = 0; attempt < 40; attempt++) {
        const list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
        const target = list.find((entry) => {
          const id = entry.url.match(/chrome-extension:\/\/([a-z0-9]+)/)?.[1];
          return id === expectedId;
        });
        if (target) return { child, version };
        await sleep(500);
      }
    } catch {
      // fall through to the "could not load" path below
    }
    try {
      child.kill('SIGKILL');
    } catch {}
    return null;
  };

  let loaded = null;
  for (const candidate of CHROME_CANDIDATES) {
    const exists = await fs
      .access(candidate)
      .then(() => true)
      .catch(() => false);
    if (!exists) continue;
    loaded = await launch(candidate);
    if (loaded) break;
    console.log(`  .. ${path.basename(candidate)} cannot load unpacked extensions, trying the next one`);
  }

  if (!loaded) {
    console.error(
      'No installed browser would load the unpacked extension. Recent Google Chrome builds ' +
        'refuse --load-extension; Edge or Chromium works. Set CHROME_BIN to point at one.',
    );
    process.exit(1);
  }

  const chrome = loaded.child;
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(TEST_PAGE);
  });
  await new Promise((resolve) => server.listen(port, resolve));
  const cleanup = () => {
    try {
      chrome.kill('SIGKILL');
    } catch {}
    server.close();
  };
  process.on('exit', cleanup);

  let browser;
  try {
    console.log(`\n${loaded.version.Browser}\n`);
    browser = await connect(loaded.version.webSocketDebuggerUrl);

    /**
     * Chrome no longer puts the request object on Network.loadingFailed, so the
     * url has to be looked up from the matching requestWillBeSent event.
     */
    const urlsByRequestId = new Map();
    const recordUrls = () => {
      for (const event of browser.drainEvents('Network.requestWillBeSent')) {
        urlsByRequestId.set(event.params.requestId, event.params.request?.url ?? '');
      }
    };
    const blockedUrlsFrom = () => {
      recordUrls();
      const failed = browser.drainEvents('Network.loadingFailed');
      return failed
        .filter((event) => String(event.params.errorText).includes('BLOCKED'))
        .map((event) => urlsByRequestId.get(event.params.requestId) ?? '(unknown)');
    };

    check('extension loads in the browser', true, expectedId);

    const openPage = async (url) => {
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      const page = {
        sessionId,
        send: (method, params = {}) => browser.send(method, params, sessionId),
        evaluate: (expression) => browser.evaluate(sessionId, expression),
        close: () => browser.send('Target.closeTarget', { targetId }),
      };
      await page.send('Network.enable');
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      await page.send('Log.enable');
      await page.send('Page.navigate', { url });
      return page;
    };

    const control = await openPage(`chrome-extension://${expectedId}/options/options.html`);
    const runInExtension = control.evaluate;

    // Wait until the extension APIs are actually available in the page.
    for (let attempt = 0; attempt < 40; attempt++) {
      const ready = await control.evaluate(
        `typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.declarativeNetRequest`,
      );
      if (ready) break;
      await sleep(250);
    }
    check('options page has extension APIs', true);

    // 1. Rule installation. EasyList has to download, so poll for it.
    let state = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      const raw = await runInExtension(
        `chrome.storage.local.get('state').then(r => JSON.stringify(r.state ?? null))`,
      );
      state = raw ? JSON.parse(raw) : null;
      const installed = (state?.subscriptions ?? []).reduce((sum, s) => sum + s.dnrRuleCount, 0);
      if (installed > 100) break;
      await sleep(500);
    }

    const subscriptions = state?.subscriptions ?? [];
    const starter = subscriptions.find((s) => s.id === 'builtin-starter');
    const easylist = subscriptions.find((s) => s.id === 'easylist');
    check('starter list is built in', (starter?.ruleCount ?? 0) > 50, `${starter?.ruleCount} rules`);
    check('EasyList downloaded and compiled', (easylist?.ruleCount ?? 0) > 1000, `${easylist?.ruleCount} rules`);
    check('EasyList compiled to far fewer Chrome rules', (easylist?.dnrRuleCount ?? 0) < (easylist?.ruleCount ?? 0),
      `${easylist?.dnrRuleCount} Chrome rules for ${easylist?.ruleCount} filter rules`);

    const ruleCount = await runInExtension(
      'chrome.declarativeNetRequest.getDynamicRules().then(r => r.length)',
    );
    check('Chrome accepted the rule batch', ruleCount > 100, `${ruleCount} dynamic rules`);

    // 2. Custom rules, so the test page has something specific to match.
    // 2. Custom rules, so the test page has something specific to match.
    const customRules = '! e2e rules\n##.e2e-ad\n||e2e-blocked.test^\n@@||e2e-allowed.test^';
    const setResult = JSON.parse(
      await runInExtension(
        `chrome.runtime.sendMessage({type:'setCustomRules', text:${JSON.stringify(customRules)}}).then(r => JSON.stringify(r))`,
      ),
    );
    check('custom rules are accepted', setResult?.ok === true, JSON.stringify(setResult));
    await sleep(2500);

    // 3. Blocking and cosmetic hiding on a normal page.
    const page = await openPage(`http://localhost:${port}/`);
    await sleep(2500);

    const blocked = blockedUrlsFrom(page);
    check(
      'advertising request is blocked',
      blocked.some((url) => url.includes('e2e-blocked.test')),
      blocked.join(', ') || 'nothing was blocked',
    );
    check(
      'exception rule leaves the allowed request alone',
      !blocked.some((url) => url.includes('e2e-allowed.test')),
      blocked.join(', '),
    );

    console.log('  .. cosmetic injection:', await page.evaluate(`JSON.stringify({
      host: location.hostname,
      style: !!document.getElementById('quietblock-cosmetic'),
      styleLength: document.getElementById('quietblock-cosmetic')?.textContent?.length ?? 0,
    })`));
    const displays = JSON.parse(
      await page.evaluate(`JSON.stringify({
        ad: document.getElementById('ad') ? getComputedStyle(document.getElementById('ad')).display : 'missing',
        normal: document.getElementById('normal') ? getComputedStyle(document.getElementById('normal')).display : 'missing',
      })`),
    );
    check('cosmetic rule hides the ad element', displays.ad === 'none', `display=${displays.ad}`);
    check('ordinary content is untouched', displays.normal !== 'none', `display=${displays.normal}`);

    // 4. Statistics pick the block up.
    await sleep(500);
    const stats = await runInExtension(`chrome.runtime.sendMessage({type:'getState'}).then(r => JSON.stringify(r.stats))`);
    const parsedStats = JSON.parse(stats);
    check('blocked request is counted', parsedStats.todayTotal > 0, `today=${parsedStats.todayTotal}`);

    // 5. Whitelisting the site stops blocking and hiding.
    // The tab id has to come from the extension's own view of the browser,
    // which is also what the popup does.
    const tabId = await runInExtension(`
      chrome.tabs.query({}).then(tabs => {
        const tab = tabs.find(t => (t.url ?? '').startsWith('http://localhost:${port}/'));
        return tab ? String(tab.id) : 'none';
      })`);
    check('the test tab is visible to the extension', tabId !== 'none', tabId);
    if (tabId !== 'none') {
      await runInExtension(`chrome.runtime.sendMessage({type:'setWhitelisted', tabId:${tabId}})`);
    }
    await sleep(1000);

    const allowedPage = await openPage(`http://localhost:${port}/`);
    await sleep(2000);
    const allowedBlocked = blockedUrlsFrom(allowedPage);
    check(
      'whitelisted site is not blocked',
      allowedBlocked.length === 0,
      allowedBlocked.join(', '),
    );
    const whitelistedDisplay = await allowedPage.evaluate(
      `document.getElementById('ad') ? getComputedStyle(document.getElementById('ad')).display : 'missing'`,
    );
    check('whitelisted site is not hidden', whitelistedDisplay !== 'none', `display=${whitelistedDisplay}`);

    // 6. The global switch removes the rules entirely.
    const rulesBeforeOff = await runInExtension(
      'chrome.declarativeNetRequest.getDynamicRules().then(r => r.length)',
    );
    await runInExtension(`chrome.runtime.sendMessage({type:'setGlobalEnabled', enabled:false})`);
    await sleep(1500);
    const rulesAfterOff = await runInExtension(
      'chrome.declarativeNetRequest.getDynamicRules().then(r => r.length)',
    );
    check('global switch removes the rules', rulesAfterOff === 0, `${rulesAfterOff} rules left`);

    // 7. Turning it back on restores them.
    await runInExtension(`chrome.runtime.sendMessage({type:'setGlobalEnabled', enabled:true})`);
    await sleep(2000);
    const rulesAfterOn = await runInExtension(
      'chrome.declarativeNetRequest.getDynamicRules().then(r => r.length)',
    );
    check('re-enabling restores the rules', rulesAfterOn === rulesBeforeOff, `${rulesAfterOn} vs ${rulesBeforeOff}`);

    await page.close();
    await allowedPage.close();
  } finally {
    cleanup();
  }

  console.log(`\n${results.passed.length} passed, ${results.failed.length} failed`);
  if (results.failed.length > 0) {
    for (const failure of results.failed) console.log(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  await fs.rm(workDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
