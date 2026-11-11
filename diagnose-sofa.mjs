import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9251;
const APP = 'http://127.0.0.1:8011/index.html?diag=' + Date.now();
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = import.meta.dirname + '/';
const profile = mkdtempSync(join(tmpdir(), 'edge-villa-diag-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1600,900', '--window-position=0,0', APP
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

try {
  const target = await findTarget();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.bringToFront');

  for (let i = 0; i < 75; i++) {
    const ready = await cdp.evalJs(`document.documentElement.dataset.villaReady === '1' && !!window.__villaDebug`);
    if (ready) break;
    await sleep(400);
  }
  await sleep(1200);
  await cdp.evalJs(`document.querySelector('.floor-btn[data-floor="1"]').click()`);
  await sleep(1500);

  const dump = await cdp.evalJs(`(() => {
    const out = [];
    window.__villaDebug.floorGroups[0].traverse((o) => {
      if (!o.isMesh || !o.material || !o.material.color) return;
      const c = o.material.color.getHexString();
      if (['4a4d55', '606570', 'c7ccd3', '7d8794', 'b99a72'].includes(c)) {
        out.push({ color: c, pos: o.position.toArray(), geo: o.geometry.parameters, visible: o.visible });
      }
    });
    return JSON.stringify(out);
  })()`);
  console.log('MESHES:', dump);

  const paint = await cdp.evalJs(`(() => {
    window.__villaDebug.floorGroups[0].traverse((o) => {
      if (!o.isMesh || !o.material || !o.material.color) return;
      const c = o.material.color.getHexString();
      if (c === '4a4d55') o.material.color.set(0xff0000);
      if (c === '606570') o.material.color.set(0x00ff00);
      if (c === 'c7ccd3') o.material.color.set(0x0000ff);
    });
    return 'painted';
  })()`);
  console.log('PAINT:', paint);
  await sleep(600);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + 'diagnose-sofa.png', Buffer.from(shot.data, 'base64'));
  console.log('saved diagnose-sofa.png');

  cdp.ws.close();
} catch (err) {
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
