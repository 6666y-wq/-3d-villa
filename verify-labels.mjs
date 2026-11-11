import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = `http://127.0.0.1:8011/index.html?verify=${Date.now()}`;
const PORT = 9255;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = import.meta.dirname + '/';
const profile = mkdtempSync(join(tmpdir(), 'edge-villa-labels-'));
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
  for (let i = 0; i < 75; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) return t;
    } catch { /* 端口还没起来 */ }
    await sleep(400);
  }
  throw new Error('找不到 villa 页面 target');
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
      } else if (msg.method) c.events.push(msg);
    };
    return c;
  }
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalJs(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    }
    return r.result.value;
  }
}

const stateExpr = `JSON.stringify({
  active: [...document.querySelectorAll('.floor-btn[data-floor].is-active')].map(b => b.dataset.floor),
  groups: window.__villaDebug.floorGroups.map(g => ({ name: g.name, visible: g.visible })),
  labels: window.__villaDebug.floorLabels.map(l => {
    const s = getComputedStyle(l.element);
    return {
      name: l.name,
      text: l.element.textContent,
      visible: l.visible,
      display: l.element.style.display,
      rect: (() => { const r = l.element.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
      bg: s.backgroundColor,
      color: s.color,
      radius: s.borderRadius,
      shadow: s.textShadow,
      glow: s.boxShadow
    };
  }),
  wallOpacity: window.__villaDebug.wallMat.opacity,
  interiorLights: window.__villaDebug.interiorLights.map(l => l.intensity),
  labelLayer: (() => {
    const el = document.querySelector('.label-layer');
    if (!el) return null;
    const s = getComputedStyle(el);
    return { position: s.position, zIndex: s.zIndex, pointerEvents: s.pointerEvents, size: el.style.width + ' x ' + el.style.height };
  })(),
  nightMix: window.__villaDebug.nightMix
})`;

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + name, Buffer.from(r.data, 'base64'));
  console.log('saved', name);
}

async function clickFloor(cdp, key, file) {
  await cdp.evalJs(`document.querySelector('.floor-btn[data-floor="${key}"]').click()`);
  await sleep(1400);
  console.log(`--- floor ${key} ---`);
  console.log(await cdp.evalJs(stateExpr));
  await shot(cdp, file);
}

try {
  const target = await findTarget();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Page.bringToFront');

  for (let i = 0; i < 75; i++) {
    const ready = await cdp.evalJs(
      `document.documentElement.dataset.villaReady === '1' && !!window.__villaDebug`
    );
    if (ready) break;
    await sleep(400);
  }
  await sleep(1600);

  console.log('--- initial / all ---');
  console.log(await cdp.evalJs(stateExpr));
  await shot(cdp, 'preview-v5-all.png');

  await clickFloor(cdp, '1', 'preview-v5-floor1.png');
  await clickFloor(cdp, '2', 'preview-v5-floor2.png');
  await clickFloor(cdp, '3', 'preview-v5-floor3.png');

  await cdp.evalJs(`document.querySelector('.floor-btn[data-floor="all"]').click()`);
  await sleep(900);
  await cdp.evalJs(`document.getElementById('daynight-btn').click()`);
  await sleep(4500);
  await shot(cdp, 'preview-v5-night-all.png');
  await clickFloor(cdp, '1', 'preview-v5-night-floor1.png');

  console.log('--- night floor 1 ---');
  console.log(await cdp.evalJs(stateExpr));

  const errors = cdp.events.filter((e) =>
    (e.method === 'Runtime.exceptionThrown') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  );
  console.log('errors =', errors.length);
  for (const e of errors.slice(0, 8)) {
    console.log(JSON.stringify(e.params).slice(0, 600));
  }

  cdp.ws.close();
} catch (err) {
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
