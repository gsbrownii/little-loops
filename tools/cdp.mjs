// Minimal headless-Chrome driver over the DevTools Protocol. Zero dependencies (Node >= 22:
// global WebSocket + fetch). Used by tools/smoke-test.mjs and for manual QA scripts.
//
//   import { launch } from './cdp.mjs';
//   const b = await launch({ width: 390, height: 844, touch: true });  // also starts a static server
//   await b.goto();                       // app root (or b.goto('#/robot'))
//   await b.tap('.splash-play');          // CSS selector or { x, y }
//   await b.drag('.card[data-card="up"]', '.strip-slot');
//   const v = await b.eval('document.body.dataset.screen');
//   await b.screenshot('shot.png');
//   console.log(b.errors);                // console errors + uncaught exceptions
//   await b.close();
//
// Env: CHROME_PATH overrides the browser executable.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './serve.mjs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  const p = CANDIDATES.find((c) => fs.existsSync(c));
  if (!p) throw new Error('Chrome/Edge not found. Set CHROME_PATH.');
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({
  width = 1024, height = 768, touch = true, mobile = touch, dpr = 1,
  serve = true, base = '/', url: baseURL = null, headless = true,
} = {}) {
  let server = null;
  if (serve && !baseURL) {
    server = await startServer({ port: 0, base, quiet: true });
    baseURL = server.url;
  }
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-chrome-'));
  const args = [
    headless ? '--headless=new' : '',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--window-size=${width},${height}`,
    'about:blank',
  ].filter(Boolean);
  const proc = spawn(findChrome(), args, { stdio: 'ignore' });

  // Chrome writes the chosen port to DevToolsActivePort.
  const portFile = path.join(userDir, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(100);
    try { port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]); } catch { /* not yet */ }
  }
  if (!port) { proc.kill(); throw new Error('Chrome did not start (no DevToolsActivePort).'); }

  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* retry */ }
    if (!target) await sleep(100);
  }
  if (!target) { proc.kill(); throw new Error('No page target.'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onclose = () => {
    // Never leave an await hanging if Chrome goes away.
    for (const { reject } of pending.values()) reject(new Error('Chrome connection closed'));
    pending.clear();
  };
  let nextId = 1;
  const pending = new Map();
  const waiters = [];
  const logs = [];
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      logs.push({ type: msg.params.type, text });
      if (msg.params.type === 'error') errors.push(`console.error: ${text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(`exception: ${d.exception?.description || d.text}`);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      logs.push({ type: e.level, text: `${e.text} ${e.url || ''}` });
      if (e.level === 'error') errors.push(`log: ${e.text} ${e.url || ''}`);
    }
    for (const w of [...waiters]) {
      if (w.method === msg.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.params); }
    }
    for (const fn of subscribers.get(msg.method) || []) {
      try { fn(msg.params); } catch { /* a test's listener must not break the driver */ }
    }
  };
  const subscribers = new Map(); // method -> Set<fn>  (api.on)

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const once = (method, timeout = 15000) => new Promise((resolve, reject) => {
    const w = { method, resolve };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout waiting for ${method}`)); } }, timeout);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');

  const api = {
    baseURL,
    logs,
    errors,
    send,

    /** Listen to a DevTools event, e.g. on('Fetch.requestPaused', (p) => ...). Returns an unsubscribe function. */
    on(method, fn) {
      if (!subscribers.has(method)) subscribers.set(method, new Set());
      subscribers.get(method).add(fn);
      return () => subscribers.get(method).delete(fn);
    },

    async setViewport(w, h, { touch: t = touch, mobile: m = mobile } = {}) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: m });
      await send('Emulation.setTouchEmulationEnabled', t ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    },

    /** Navigate: no arg = app root; '#/robot' = hash route; full URL also accepted. */
    async goto(where = '', { wait = 400 } = {}) {
      const url = /^(https?|file):/.test(where) ? where : baseURL + where;
      const r = await send('Page.navigate', { url });
      if (r.errorText) throw new Error(`navigate failed: ${r.errorText} (${url})`);
      // Poll instead of waiting for load events (hash-only navigations don't fire them).
      const noHash = url.split('#')[0];
      await api.waitFor(`location.href.split('#')[0] === ${JSON.stringify(noHash)} && document.readyState === 'complete'`, { timeout: 20000 });
      await sleep(wait);
    },

    async reload({ wait = 400 } = {}) {
      await api.eval('window.__llReloadMarker = 1');
      await send('Page.reload', { ignoreCache: false });
      await api.waitFor(`!window.__llReloadMarker && document.readyState === 'complete'`, { timeout: 20000 });
      await sleep(wait);
    },

    /** Evaluate an expression (may be async) and return its JSON value. */
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    },

    /** Center of the first element matching selector (or null). */
    async center(selector) {
      return api.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    },

    async point(where) {
      if (typeof where === 'string') {
        const c = await api.center(where);
        if (!c) throw new Error(`No element for selector: ${where}`);
        return c;
      }
      return where;
    },

    /** Tap (touch) or click (mouse) a selector or {x, y}. Generates pointer + click events. */
    async tap(where, { wait = 150 } = {}) {
      const { x, y } = await api.point(where);
      if (touch) {
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
        await sleep(40);
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }
      await sleep(wait);
    },

    /** Press and hold for `ms` (e.g. the 3 s parent gate). */
    async hold(where, ms = 3300) {
      const { x, y } = await api.point(where);
      if (touch) {
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
        await sleep(ms);
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await sleep(ms);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }
      await sleep(200);
    },

    /** Drag from one selector/point to another with intermediate moves. */
    async drag(from, to, { steps = 12, wait = 200 } = {}) {
      const a = await api.point(from);
      const b = await api.point(to);
      if (touch) {
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y, id: 1 }] });
        for (let i = 1; i <= steps; i++) {
          const x = a.x + ((b.x - a.x) * i) / steps;
          const y = a.y + ((b.y - a.y) * i) / steps;
          await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
          await sleep(16);
        }
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
        for (let i = 1; i <= steps; i++) {
          const x = a.x + ((b.x - a.x) * i) / steps;
          const y = a.y + ((b.y - a.y) * i) / steps;
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
          await sleep(16);
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      }
      await sleep(wait);
    },

    async screenshot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    },

    /** Wait until a JS expression is truthy (polls). */
    async waitFor(expression, { timeout = 10000, interval = 100 } = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try { if (await api.eval(expression)) return true; } catch { /* keep polling */ }
        await sleep(interval);
      }
      throw new Error(`waitFor timed out: ${expression}`);
    },

    async offline(on) {
      await send('Network.emulateNetworkConditions', { offline: !!on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    },

    /** Emulate print media (for checking #print-root output) or screen (null). */
    async media(type) {
      await send('Emulation.setEmulatedMedia', { media: type || '' });
    },

    sleep,

    async close() {
      try { await Promise.race([send('Browser.close'), sleep(1500)]); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
      await sleep(300);
      try { proc.kill(); } catch { /* ignore */ }
      if (server) await server.close();
      try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* Windows may hold files briefly */ }
    },
  };

  await api.setViewport(width, height);
  return api;
}
