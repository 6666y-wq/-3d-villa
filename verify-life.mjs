import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = `http://127.0.0.1:8011/index.html?life=${Date.now()}`;
const PORT = 9250;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = import.meta.dirname + '/';
const profile = mkdtempSync(join(tmpdir(), 'edge-villa-life-'));
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

const lifeExpr = `(() => {
  const d = window.__villaDebug;
  const life = d.life;
  const details = d.lifeDetails;
  return JSON.stringify({
    nightMix: Number(d.nightMix.toFixed(3)),
    porchLanterns: life.porchLanterns,
    bridgeLanterns: life.bridgeLanterns,
    stoneTableParts: life.stoneTableParts,
    bambooCulms: life.bambooCulms,
    bambooLeaves: life.bambooLeaves,
    reedStems: life.reedStems,
    skyLanterns: life.skyLanterns,
    skyLanternsVisible: life.skyLanternsVisible,
    boatY: Number(life.boatY.toFixed(4)),
    lanternEmissive: Number(life.lanternEmissive.toFixed(3)),
    boatPosition: details.boat.group.position.toArray().map((v) => Number(v.toFixed(3))),
    stoneTablePosition: details.stoneTable.position.toArray().map((v) => Number(v.toFixed(3))),
    bambooPosition: details.bamboo.position.toArray().map((v) => Number(v.toFixed(3))),
    reedMatrix0: Array.from(details.reeds.stemMesh.instanceMatrix.array.slice(0, 16)).map((v) => Number(v.toFixed(4))),
    skyY0: Number(details.skyLanterns.data[0].y.toFixed(4)),
    shadowCasters: (() => {
      let n = 0;
      const scan = (root) => root.traverse((o) => { if (o.isMesh && o.castShadow) n++; });
      scan(details.lanterns.porch);
      scan(details.lanterns.bridge);
      scan(details.stoneTable);
      scan(details.bamboo);
      scan(details.boat.group);
      scan(details.reeds.stemMesh);
      scan(details.reeds.headMesh);
      scan(details.skyLanterns.group);
      return n;
    })()
  });
})()`;

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + name, Buffer.from(r.data, 'base64'));
  console.log('saved', name);
}

async function view(cdp, pos, target) {
  await cdp.evalJs(`(() => {
    const d = window.__villaDebug;
    d.camera.position.set(${pos});
    d.controls.target.set(${target});
    d.controls.update();
    document.querySelector('.hud').style.display = 'none';
    document.querySelector('.floor-panel').style.display = 'none';
    return true;
  })()`);
  await sleep(700);
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

  const home = JSON.parse(await cdp.evalJs(`(() => {
    const d = window.__villaDebug;
    return JSON.stringify({
      pos: d.camera.position.toArray(),
      target: d.controls.target.toArray()
    });
  })()`));

  console.log('--- 白天状态 ---');
  const dayA = JSON.parse(await cdp.evalJs(lifeExpr));
  console.log(JSON.stringify(dayA));

  // 浮船周期约 8.4s：跨 2.5s 连续采样取峰谷差，避免恰好采在波峰附近造成误判
  let dayB = dayA;
  let boatMin = dayA.boatY;
  let boatMax = dayA.boatY;
  for (let i = 0; i < 5; i++) {
    await sleep(500);
    dayB = JSON.parse(await cdp.evalJs(lifeExpr));
    boatMin = Math.min(boatMin, dayB.boatY);
    boatMax = Math.max(boatMax, dayB.boatY);
  }
  const boatMoved = boatMax - boatMin > 0.01;
  const reedsMoved = dayB.reedMatrix0.some((v, i) => Math.abs(v - dayA.reedMatrix0[i]) > 0.0005);

  await view(cdp, '-11.5, 4.5, 5.5', '-5.8, 0.4, -0.3');
  await shot(cdp, 'preview-v10-life-day-table.png');
  await view(cdp, '13, 5, -2', '6.95, 1.5, -7.05');
  await shot(cdp, 'preview-v10-life-day-bamboo.png');
  await view(cdp, '14, 3.2, 28', '8.6, 0.6, 20.75');
  await shot(cdp, 'preview-v10-life-day-boat.png');
  await view(cdp, '0, 3.6, 13', '0, 2.2, 3.6');
  await shot(cdp, 'preview-v10-life-day-porch.png');

  await cdp.evalJs(`(() => {
    const d = window.__villaDebug;
    d.camera.position.set(${home.pos});
    d.controls.target.set(${home.target});
    d.controls.update();
    document.querySelector('.hud').style.display = '';
    document.querySelector('.floor-panel').style.display = '';
    return true;
  })()`);
  await sleep(500);

  await cdp.evalJs(`document.getElementById('daynight-btn').click()`);
  let night = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    night = JSON.parse(await cdp.evalJs(lifeExpr));
    if (night.nightMix >= 0.999) break;
  }
  console.log('--- 夜晚状态 ---');
  console.log(JSON.stringify(night));
  await sleep(500);
  await shot(cdp, 'preview-v10-life-night-overview.png');

  const skyAY = night.skyY0;
  await sleep(1200);
  const nightB = JSON.parse(await cdp.evalJs(lifeExpr));

  await view(cdp, '0, 3.6, 13', '0, 2.2, 3.6');
  await shot(cdp, 'preview-v10-life-night-porch.png');
  await view(cdp, '14, 3.2, 28', '8.6, 0.6, 20.75');
  await shot(cdp, 'preview-v10-life-night-boat.png');

  const errors = cdp.events.filter((e) =>
    (e.method === 'Runtime.exceptionThrown') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  );
  console.log('errors =', errors.length);
  for (const e of errors.slice(0, 8)) console.log(JSON.stringify(e.params).slice(0, 800));

  const checks = [
    ['门廊红灯笼 2 盏', dayA.porchLanterns === 2],
    ['桥头红灯笼 4 盏', dayA.bridgeLanterns === 4],
    ['石桌石凳 7 件', dayA.stoneTableParts === 7],
    ['竹林竹节实例 > 0', dayA.bambooCulms > 0],
    ['竹林叶片实例 > 0', dayA.bambooLeaves > 0],
    ['芦苇 52 根', dayA.reedStems === 52],
    ['孔明灯 14 盏', dayA.skyLanterns === 14],
    ['白天隐藏孔明灯', dayA.skyLanternsVisible === false],
    ['白天红灯笼自发光 0.7', Math.abs(dayA.lanternEmissive - 0.7) < 0.001],
    ['乌篷船在浮动', boatMoved],
    ['芦苇在摇摆', reedsMoved],
    ['所有新物件不投影', dayA.shadowCasters === 0],
    ['夜晚过渡完成', night && night.nightMix >= 0.999],
    ['夜晚显示孔明灯', night && night.skyLanternsVisible === true],
    ['夜晚红灯笼自发光 1.9', night && Math.abs(night.lanternEmissive - 1.9) < 0.001],
    ['孔明灯在上升', nightB.skyY0 > skyAY + 0.01],
    ['控制台无错误', errors.length === 0]
  ];

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
    if (!ok) failed++;
  }
  console.log(`RESULT: ${checks.length - failed}/${checks.length} passed`);
  process.exitCode = failed ? 1 : 0;

  cdp.ws.close();
} catch (err) {
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}

