import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9271;
const APP = `http://127.0.0.1:8011/index.html?smoke=${Date.now()}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = import.meta.dirname + '/';
const profile = mkdtempSync(join(tmpdir(), 'edge-villa-smoke-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new',
  '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars',
  '--window-size=1600,900', '--window-position=0,0',
  APP
], { stdio: 'ignore' });

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
      const list = await res.json();
      const t = list.find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) return t;
    } catch { /* wait */ }
    await sleep(400);
  }
  throw new Error('no target');
}

class CDP {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('ws timeout')), 5000);
      ws.onopen = () => { clearTimeout(timer); res(); };
      ws.onerror = (e) => { clearTimeout(timer); rej(e); };
    });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const p = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${method} timeout`)), 15000);
      this.pending.set(id, {
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}

try {
  const target = await findTarget();
  console.log('target ok');
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await sleep(4000);
  console.log('ready =', await cdp.evalJs(`document.documentElement.dataset.villaReady || null`));
  console.log('hasDebug =', await cdp.evalJs(`!!window.__villaDebug`));
  console.log('info =', await cdp.evalJs(`(() => {
    if (!window.__villaDebug) return null;
    const d = window.__villaDebug;
    return JSON.stringify({
      floors: d.floorGroups.length,
      outerWalls: d.outerWallMeshes.length,
      interiorWalls: d.interior.wallCount,
      ceilings: d.ceilingSlabs.length,
      steps: d.stairs.stepCount,
      rails: d.stairs.railCount,
      floorsY: d.interior.floorHeights,
      xray: d.xray.enabled,
      opacity: d.wallMat.opacity
    });
  })()`));
  const errors = cdp.events.filter((e) =>
    (e.method === 'Runtime.exceptionThrown') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  );
  console.log('errors =', errors.length);
  for (const e of errors.slice(0, 6)) console.log(JSON.stringify(e.params).slice(0, 900));
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'preview-v7-smoke.png'), Buffer.from(r.data, 'base64'));
  console.log('screenshot saved');
  cdp.ws.close();
} catch (err) {
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(600);
  process.exit(process.exitCode || 0);
}
