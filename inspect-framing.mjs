import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = `http://127.0.0.1:8011/index.html?frame=${Date.now()}`;
const PORT = 9252;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = import.meta.dirname + '/';
const profile = mkdtempSync(join(tmpdir(), 'edge-villa-frame-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VARIANTS = [
  { name: 'frame-a.png', pos: [15.5, 12, 29], target: [0, 1.4, 4] },
  { name: 'frame-b.png', pos: [13, 13.5, 33], target: [0, 1.6, 8] },
  { name: 'frame-c.png', pos: [11, 10.5, 32], target: [0, 1.8, 12] },
  { name: 'frame-d.png', pos: [17, 15, 36], target: [0, 1.8, 8] },
  { name: 'frame-e.png', pos: [9, 9, 30], target: [0, 2.4, 13] }
];

const child = spawn(EDGE, [
  '--headless=new', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--window-size=1600,900', '--window-position=0,0',
  APP
], { stdio: 'ignore' });

async function findTarget() {
  for (let i = 0; i < 75; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const p = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
      }
    };
    return c;
  }
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}

let cdp;
try {
  const target = await findTarget();
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  for (let i = 0; i < 80; i++) {
    if (await cdp.evalJs(`document.documentElement.dataset.villaReady === '1'`)) break;
    await sleep(400);
  }
  for (const v of VARIANTS) {
    await cdp.evalJs(`(() => {
      const d = window.__villaDebug;
      d.camera.position.set(${v.pos.join(',')});
      d.controls.target.set(${v.target.join(',')});
      d.controls.update();
    })()`);
    await sleep(900);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, v.name), Buffer.from(data, 'base64'));
    console.log('saved', v.name);
  }
  console.log('stats', await cdp.evalJs(`JSON.stringify(window.__villaDebug.garden)`));
} catch (err) {
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  try { cdp?.ws.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
