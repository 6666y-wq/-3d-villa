import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9275;
const APP = `http://127.0.0.1:8011/index.html?ui=${Date.now()}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = import.meta.dirname + '/';
const profile = mkdtempSync(join(tmpdir(), 'edge-villa-ui-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EDGE, [
  '--headless=new', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--window-size=1600,900', '--window-position=0,0', APP
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
      const timer = setTimeout(() => rej(new Error(`${method} timeout`)), 20000);
      this.pending.set(id, {
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalJs(expression, userGesture = false) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, userGesture, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    }
    return r.result.value;
  }
}

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('screenshot:', name);
}

const S = {
  wall: `JSON.stringify({
    xray: window.__villaDebug.xray.enabled,
    opacity: window.__villaDebug.xray.wallOpacity,
    transparent: window.__villaDebug.wallMat.transparent,
    depthWrite: window.__villaDebug.wallMat.depthWrite,
    shadowed: window.__villaDebug.outerWallMeshes.filter((m) => m.castShadow).length,
    total: window.__villaDebug.outerWallMeshes.length,
    text: document.getElementById('xray-btn').textContent.trim(),
    pressed: document.getElementById('xray-btn').getAttribute('aria-pressed')
  })`,
  floor: `JSON.stringify({
    groups: window.__villaDebug.floorGroups.map((g) => g.visible),
    ceilings: window.__villaDebug.ceilingSlabs.map((s) => ({ f: s.userData.floorIndex, v: s.visible })),
    labels: window.__villaDebug.floorLabels.map((l) => l.element.style.display),
    extra: window.__villaDebug.extraFloorLabels.map((a) => a.map((l) => l.element.style.display)),
    lights: window.__villaDebug.interiorLights.map((l) => Number(l.intensity.toFixed(2))),
    roofGhost: window.__villaDebug.floorGroups.map((g) => {
      let ghosted = 0; let solid = 0;
      g.traverse((o) => {
        if (!o.userData.isRoofPanel) return;
        const m = o.material;
        if (m && m.transparent && m.opacity < 1) ghosted++; else solid++;
      });
      return [ghosted, solid];
    })
  })`,
  roam: `JSON.stringify({
    active: window.__villaDebug.roam.active,
    pos: (() => {
      const p = window.__villaDebug.roam.position;
      return [Number(p.x.toFixed(3)), Number(p.y.toFixed(3)), Number(p.z.toFixed(3))];
    })(),
    feetY: Number(window.__villaDebug.roam.feetY.toFixed(3)),
    floor: window.__villaDebug.roam.floorIndex
  })`
};

const results = [];
const check = (name, ok, detail) => {
  results.push([name, Boolean(ok)]);
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
};


try {
  const target = await findTarget();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Page.bringToFront');
  for (let i = 0; i < 60; i++) {
    if (await cdp.evalJs(`document.documentElement.dataset.villaReady === '1'`)) break;
    await sleep(300);
  }
  await sleep(1200);

  const before = JSON.parse(await cdp.evalJs(S.wall));
  check('初始墙体实体', before.opacity === 1 && before.transparent === false && before.depthWrite === true && before.shadowed === before.total, before);

  await cdp.evalJs(`document.getElementById('xray-btn').click()`, true);
  await sleep(600);
  const xrayOn = JSON.parse(await cdp.evalJs(S.wall));
  check('透视开启', xrayOn.xray === true && xrayOn.opacity === 0.18 && xrayOn.transparent === true && xrayOn.depthWrite === false, xrayOn);
  check('透视时外墙不投影', xrayOn.shadowed === 0, xrayOn.shadowed);
  check('透视按钮状态', xrayOn.pressed === 'true' && xrayOn.text === '👁️ 恢复实体墙', xrayOn.text);
  await shot(cdp, 'preview-v7-xray.png');

  await cdp.evalJs(`document.getElementById('xray-btn').click()`, true);
  await sleep(700);
  const xrayOff = JSON.parse(await cdp.evalJs(S.wall));
  check('透视关闭恢复', xrayOff.opacity === 1 && xrayOff.transparent === false && xrayOff.shadowed === xrayOff.total, xrayOff);

  // 剖切视图拉近相机，方便检查室内家具与屋顶透明度
  await cdp.evalJs(`(() => {
    const { camera, controls } = window.__villaDebug;
    camera.position.set(9.2, 8.6, 12.4);
    controls.target.set(0, 3.4, 0);
    controls.update();
  })()`);
  await cdp.evalJs(`document.querySelector('.floor-btn[data-floor="1"]').click()`, true);
  await sleep(1200);
  await shot(cdp, 'preview-v7-floor1.png');
  await cdp.evalJs(`(() => {
    const { camera, controls } = window.__villaDebug;
    camera.position.set(0.2, 21, 2.6);
    controls.target.set(0.2, 0.4, 0.2);
    controls.update();
  })()`);
  await sleep(900);
  await shot(cdp, 'preview-v7-floor1-top.png');

  await cdp.evalJs(`document.querySelector('.floor-btn[data-floor="2"]').click()`, true);
  await sleep(1500);
  const f2 = JSON.parse(await cdp.evalJs(S.floor));
  check('只看二楼：组可见性', f2.groups[0] === false && f2.groups[1] === true && f2.groups[2] === false, f2.groups);
  check('只看二楼：顶板隐藏', f2.ceilings.filter((c) => c.f === 1).every((c) => c.v === false), f2.ceilings);
  check('只看二楼：标签隔离', f2.labels[0] === 'none' && f2.labels[1] === '' && f2.labels[2] === 'none' && f2.extra[0].every((v) => v === 'none') && f2.extra[2].every((v) => v === 'none'), f2.labels);
  check('只看二楼：灯光隔离', f2.lights[0] === 0 && f2.lights[1] > 0 && f2.lights[2] === 0, f2.lights);
  check('只看二楼：屋顶全部半透明', f2.roofGhost[1][0] > 0 && f2.roofGhost[1][1] === 0, f2.roofGhost);
  await shot(cdp, 'preview-v7-floor2.png');
  await cdp.evalJs(`(() => {
    const { camera, controls } = window.__villaDebug;
    camera.position.set(0.2, 24, 2.6);
    controls.target.set(0.2, 3.2, 0.2);
    controls.update();
  })()`);
  await sleep(900);
  await shot(cdp, 'preview-v7-floor2-top.png');

  await cdp.evalJs(`document.querySelector('.floor-btn[data-floor="all"]').click()`, true);
  await sleep(1000);
  const all = JSON.parse(await cdp.evalJs(S.floor));
  check('回到全部：屋顶恢复实体', all.roofGhost.every(([ghosted]) => ghosted === 0) && all.roofGhost.some(([, solid]) => solid > 0), all.roofGhost);


  await cdp.evalJs(`document.getElementById('roam-btn').click()`, true);
  await sleep(900);
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }))`);
  await sleep(4400);
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }))`);
  await sleep(500);
  const indoor = JSON.parse(await cdp.evalJs(S.roam));
  check('走进一楼客厅', indoor.active && indoor.pos[2] < 3.0 && indoor.pos[2] > -3.0 && indoor.feetY === 0.34 && indoor.floor === 0, indoor);
  await shot(cdp, 'preview-v7-interior.png');

  await cdp.evalJs(`(() => {
    const c = window.__villaDebug.camera;
    c.position.set(1.975, 2.04, 2.85);
    c.rotation.set(0, 0, 0, 'YXZ');
  })()`);
  await sleep(400);
  await shot(cdp, 'preview-v7-stairs.png');
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }))`);
  await sleep(2400);
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }))`);
  await sleep(300);
  await cdp.evalJs(`(() => {
    const c = window.__villaDebug.camera;
    c.rotation.set(0, Math.PI, 0, 'YXZ');
  })()`);
  await sleep(700);
  const upstairs = JSON.parse(await cdp.evalJs(S.roam));
  check('沿楼梯上到二楼', upstairs.feetY === 3.14 && upstairs.floor === 1 && upstairs.pos[2] < -1.6, upstairs);
  await shot(cdp, 'preview-v7-upstairs.png');
  await cdp.evalJs(`(() => {
    const c = window.__villaDebug.camera;
    c.rotation.set(-0.95, Math.PI, 0, 'YXZ');
  })()`);
  await sleep(600);
  await shot(cdp, 'preview-v7-stairwell.png');

  const errors = cdp.events.filter((e) =>
    (e.method === 'Runtime.exceptionThrown') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  );
  check('控制台无错误', errors.length === 0, errors.length);
  for (const e of errors.slice(0, 5)) console.log(JSON.stringify(e.params).slice(0, 700));

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`RESULT: ${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
  cdp.ws.close();
} catch (err) {
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(600);
  process.exit(process.exitCode || 0);
}

