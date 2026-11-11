import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = `http://127.0.0.1:8011/index.html?courtyard=${Date.now()}`;
const PORT = 9244;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = import.meta.dirname + '/';
const profile = mkdtempSync(join(tmpdir(), 'edge-villa-courtyard-'));
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
    } catch { /* 等待端口 */ }
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
  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    }
    return r.result.value;
  }
}

const stateExpr = `(() => {
  const d = window.__villaDebug;
  const p = d.particles;
  return JSON.stringify({
    ready: document.documentElement.dataset.villaReady || null,
    nightMix: Number(d.nightMix.toFixed(3)),
    courtyardInScene: !!d.courtyard.parent,
    fenceMeshes: d.fenceGroup.children.length,
    trees: d.treeGroup.children.length,
    stoneSlabs: d.stonePath.count,
    petals: p.petalCount,
    petalVisible: p.petals.visible,
    petalOpacity: Number(p.petalMat.opacity.toFixed(3)),
    fireflies: p.fireflyCount,
    fireflyVisible: p.fireflies.visible,
    fireflyOpacity: Number(p.fireflyMat.opacity.toFixed(3)),
    stars: p.starCount,
    starsVisible: p.stars.visible,
    starOpacity: Number(p.starMat.opacity.toFixed(3)),
    bloomStrength: Number(d.bloom.strength.toFixed(3)),
    bloomRadius: d.bloom.radius,
    bloomThreshold: d.bloom.threshold,
    bloomEnabled: d.bloom.enabled,
    interior: d.interiorLights.map((l) => Number(l.intensity.toFixed(2))),
    floors: d.floorGroups.map((g) => g.visible),
    courtyardVisible: d.courtyard.visible
  });
})()`;

const petalExpr = `(() => {
  const p = window.__villaDebug.particles.petalData[0];
  return JSON.stringify({ x: p.x, y: p.y, rx: p.rotX, rz: p.rotZ });
})()`;

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + name, Buffer.from(r.data, 'base64'));
  console.log('saved', name);
}

try {
  const target = await findTarget();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.bringToFront');

  for (let i = 0; i < 90; i++) {
    const ready = await cdp.evalJs(`document.documentElement.dataset.villaReady === '1'`);
    if (ready) break;
    await sleep(400);
  }
  await sleep(1600);

  console.log('--- 白天初始 ---');
  const dayState = JSON.parse(await cdp.evalJs(stateExpr));
  console.log(JSON.stringify(dayState));

  const petalA = JSON.parse(await cdp.evalJs(petalExpr));
  await sleep(1200);
  const petalB = JSON.parse(await cdp.evalJs(petalExpr));
  console.log('petal move:', JSON.stringify({ petalA, petalB }));
  const petalMoved = Math.abs(petalB.y - petalA.y) > 0.05 && Math.abs(petalB.rx - petalA.rx) > 0.05;

  await shot(cdp, 'preview-v6-courtyard-day.png');

  await cdp.evalJs(`document.getElementById('daynight-btn').click()`);
  let nightState = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    nightState = JSON.parse(await cdp.evalJs(stateExpr));
    if (nightState.nightMix >= 0.999) break;
  }
  console.log('--- 夜晚稳定 ---');
  console.log(JSON.stringify(nightState));
  await sleep(600);
  await shot(cdp, 'preview-v6-courtyard-night.png');

  await cdp.evalJs(`document.querySelector('.floor-btn[data-floor="1"]').click()`);
  await sleep(900);
  const floorState = JSON.parse(await cdp.evalJs(stateExpr));
  console.log('--- 夜晚只看一楼 ---');
  console.log(JSON.stringify(floorState));
  await shot(cdp, 'preview-v6-courtyard-night-floor1.png');

  await cdp.evalJs(`document.querySelector('.floor-btn[data-floor="all"]').click()`);
  await sleep(500);

  await cdp.evalJs(`document.getElementById('daynight-btn').click()`);
  let dayAgain = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    dayAgain = JSON.parse(await cdp.evalJs(stateExpr));
    if (dayAgain.nightMix <= 0.001) break;
  }
  console.log('--- 切回白天 ---');
  console.log(JSON.stringify(dayAgain));

  const errors = cdp.events.filter((e) =>
    (e.method === 'Runtime.exceptionThrown') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  );
  console.log('errors =', errors.length);
  for (const e of errors.slice(0, 8)) {
    console.log(JSON.stringify(e.params).slice(0, 800));
  }

  const checks = [
    ['庭院挂载到场景', dayState.courtyardInScene === true],
    ['围栏构件数量 > 40', dayState.fenceMeshes > 40],
    ['Low-Poly 树 5 棵', dayState.trees === 5],
    ['石板路 12 块', dayState.stoneSlabs === 12],
    ['花瓣数量 260', dayState.petals === 260],
    ['白天显示花瓣', dayState.petalVisible === true && dayState.petalOpacity > 0.9],
    ['白天关闭泛光', dayState.bloomStrength === 0],
    ['白天跳过 Bloom Pass', dayState.bloomEnabled === false],
    ['白天隐藏萤火虫/星空', dayState.fireflyVisible === false && dayState.starsVisible === false],
    ['花瓣在飘落并旋转', petalMoved],
    ['夜晚过渡完成', nightState && nightState.nightMix >= 0.999],
    ['夜晚花瓣隐藏', nightState && nightState.petalVisible === false && nightState.petalOpacity < 0.02],
    ['夜晚显示萤火虫 60', nightState && nightState.fireflyVisible === true && nightState.fireflies === 60 && nightState.fireflyOpacity > 0.9],
    ['夜晚显示星空', nightState && nightState.starsVisible === true && nightState.starOpacity > 0.8],
    ['夜间泛光 0.32 / radius 0.36 / threshold 0.78',
      nightState &&
      Math.abs(nightState.bloomStrength - 0.32) < 0.01 &&
      nightState.bloomRadius === 0.36 &&
      nightState.bloomThreshold === 0.78],
    ['夜间启用 Bloom Pass', nightState && nightState.bloomEnabled === true],
    ['一楼二楼室内灯 1.5', nightState && nightState.interior[0] === 1.5 && nightState.interior[1] === 1.5],
    ['单层查看仍保留庭院', floorState.floors.join(',') === 'true,false,false' && floorState.courtyardVisible === true],
    ['楼层按钮恢复正常', dayAgain && dayAgain.floors.join(',') === 'true,true,true'],
    ['切回白天恢复樱花', dayAgain && dayAgain.nightMix <= 0.001 && dayAgain.petalVisible === true && dayAgain.fireflyVisible === false],
    ['控制台无错误', errors.length === 0]
  ];

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
    if (!ok) failed++;
  }
  process.exitCode = failed ? 1 : 0;
  console.log(`RESULT: ${checks.length - failed}/${checks.length} passed`);

  cdp.ws.close();
} catch (err) {
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
