// V8 视觉检查：森林密度 / 草丛成簇 / 夜间水面高光 / 标签样式
// 用法：先 `python -m http.server 8011`，再 `node inspect-v8.mjs`
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = `http://127.0.0.1:8011/villa.html?v8=${Date.now()}`;
const PORT = 9253;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = import.meta.dirname + '/';
const profile = mkdtempSync(join(tmpdir(), 'edge-villa-v8-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const t = list.find((x) => x.type === 'page' && x.url.includes('villa.html'));
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
  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  }
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  console.log('saved', name);
}

async function aim(cdp, pos, target) {
  await cdp.evalJs(`(() => {
    const d = window.__villaDebug;
    d.camera.position.set(${pos.join(',')});
    d.controls.target.set(${target.join(',')});
    d.controls.update();
  })()`);
  await sleep(900);
}

const stateExpr = `JSON.stringify({
  ready: document.documentElement.dataset.villaReady || null,
  forest: {
    treeCount: __villaDebug.forest.treeCount,
    leafCanopies: __villaDebug.forest.leafCanopies,
    pineCanopies: __villaDebug.forest.pineCanopies,
    trunkInstances: __villaDebug.forest.trunkInstances
  },
  grassCount: __villaDebug.garden.grassCount,
  grassClumpSize: __villaDebug.garden.grassClumpSize,
  water: {
    roughness: __villaDebug.water.roughness,
    metalness: __villaDebug.water.metalness,
    envMapIntensity: __villaDebug.water.envMapIntensity,
    emissiveIntensity: Number(__villaDebug.water.emissiveIntensity.toFixed(3))
  },
  bloom: {
    strength: Number(__villaDebug.bloom.strength.toFixed(3)),
    radius: __villaDebug.bloom.radius,
    threshold: __villaDebug.bloom.threshold,
    enabled: __villaDebug.bloom.enabled
  },
  exposure: Number(__villaDebug.toneMapping.exposure.toFixed(3)),
  environmentIntensity: Number(__villaDebug.environment.intensity.toFixed(3)),
  drawCalls: __villaDebug.garden.drawCalls,
  triangles: __villaDebug.garden.triangles,
  frameMs: __villaDebug.garden.frameMs
})`;

let cdp;
try {
  const target = await findTarget();
  cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  for (let i = 0; i < 80; i++) {
    if (await cdp.evalJs(`document.documentElement.dataset.villaReady === '1'`)) break;
    await sleep(400);
  }
  // 等 HDR / PMREM 完成，避免截图里环境反射还是空的
  for (let i = 0; i < 100; i++) {
    if (await cdp.evalJs(`window.__villaDebug.environment.ready === true`)) break;
    await sleep(400);
  }
  await sleep(1200);

  console.log('DAY STATE:', await cdp.evalJs(stateExpr));

  // 默认机位：河道 / 庭院 / 别墅一起入画，便于检查水面是否还有大光球
  await aim(cdp, [11, 10.5, 32], [0, 1.8, 12]);
  await shot(cdp, 'preview-v8-day.png');

  // 近景：看庭院草簇、树干与标签气泡
  await aim(cdp, [9.5, 3.2, 15.5], [0, 0.9, 2]);
  await shot(cdp, 'preview-v8-garden.png');

  // 高位广角：看外围森林密度
  await aim(cdp, [24, 19, 50], [0, 2, 0]);
  await shot(cdp, 'preview-v8-forest.png');

  await aim(cdp, [11, 10.5, 32], [0, 1.8, 12]);
  await cdp.evalJs(`document.getElementById('daynight-btn').click()`);
  for (let i = 0; i < 80; i++) {
    if (await cdp.evalJs(`window.__villaDebug.nightMix >= 0.999`)) break;
    await sleep(400);
  }
  await sleep(900);
  console.log('NIGHT STATE:', await cdp.evalJs(stateExpr));
  await shot(cdp, 'preview-v8-night.png');

  const errors = cdp.events.filter((e) =>
    e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  );
  console.log('errors =', errors.length);
  for (const e of errors.slice(0, 5)) console.log(JSON.stringify(e.params).slice(0, 800));
  if (errors.length) process.exitCode = 1;
} catch (err) {
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  try { cdp?.ws.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
