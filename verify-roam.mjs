import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = `http://127.0.0.1:8011/index.html?roam=${Date.now()}`;
const PORT = 9246;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = import.meta.dirname + '/';
const profile = mkdtempSync(join(tmpdir(), 'edge-villa-roam-'));
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
  async evalJs(expression, userGesture = false) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      userGesture
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    }
    return r.result.value;
  }
}

const stateExpr = `(() => {
  const d = window.__villaDebug;
  const r = d.roam;
  const pos = r.position;
  return JSON.stringify({
    ready: document.documentElement.dataset.villaReady || null,
    active: r.active,
    locked: r.locked,
    orbitEnabled: r.orbitEnabled,
    pointerEnabled: r.pointerEnabled,
    eyeHeight: r.eyeHeight,
    fov: r.fov,
    position: { x: Number(pos.x.toFixed(3)), y: Number(pos.y.toFixed(3)), z: Number(pos.z.toFixed(3)) },
    velocity: { x: Number(r.velocity.x.toFixed(3)), z: Number(r.velocity.z.toFixed(3)) },
    keys: r.keys,
    dataRoam: document.documentElement.dataset.roamActive,
    buttonText: document.getElementById('roam-btn').textContent.trim(),
    buttonPressed: document.getElementById('roam-btn').getAttribute('aria-pressed'),
    crosshair: document.getElementById('roam-crosshair').classList.contains('is-visible'),
    hint: document.getElementById('roam-hint').classList.contains('is-visible')
  });
})()`;

async function state(cdp) {
  return JSON.parse(await cdp.evalJs(stateExpr));
}

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('screenshot:', name);
}

function allKeysReleased(keys) {
  return Object.values(keys).every((v) => v === false);
}

try {
  const target = await findTarget();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  for (let i = 0; i < 100; i++) {
    const ready = await cdp.evalJs(`document.documentElement.dataset.villaReady || ''`);
    if (ready === '1') break;
    await sleep(300);
  }
  await sleep(1000);

  const initial = await state(cdp);
  console.log('--- 初始上帝视角 ---');
  console.log(JSON.stringify(initial));

  // 真实点击按钮（CDP 以用户手势触发指针锁定）
  await cdp.evalJs(`document.getElementById('roam-btn').click()`, true);
  await sleep(1000);
  const entered = await state(cdp);
  console.log('--- 点击漫游按钮 ---');
  console.log(JSON.stringify(entered));
  if (entered.locked) await shot(cdp, 'preview-v6-roam.png');

  // 键盘事件：按下 W 前进 1.6 秒，再松开
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }))`);
  await sleep(1600);
  const moving = await state(cdp);
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }))`);
  await sleep(500);
  const stopped = await state(cdp);
  console.log('--- W 前进中 / 松开后 ---');
  console.log(JSON.stringify({ moving, stopped }));

  // 从院门外一直往前：先经过台基踏步，再从半开的入户门进入一楼客厅
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }))`);
  await sleep(3200);
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }))`);
  await sleep(400);
  const indoor = await state(cdp);
  console.log('--- 穿过入户门进入一楼 ---');
  console.log(JSON.stringify(indoor));
  await shot(cdp, 'preview-v7-verify-indoor.png');

  // 一楼楼梯：站在楼梯口前（东侧），沿坡道走上二楼
  await cdp.evalJs(`(() => {
    const c = window.__villaDebug.camera;
    c.position.set(1.975, 2.04, 2.85);
    c.rotation.set(0, 0, 0, 'YXZ');
  })()`);
  await sleep(300);
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }))`);
  await sleep(2400);
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }))`);
  await sleep(400);
  const upstairs = await state(cdp);
  console.log('--- 沿楼梯走上二楼 ---');
  console.log(JSON.stringify(upstairs));

  // 贴到台基前再横穿庭院，撞庭院围栏边界（x 应停在 8.1 附近）
  // 注意 z 取 4.5：离外墙 pad 边界（3.6 + 0.46 = 4.06）有余量，又避开 (6.2, 5.6) 的四角灌木
  await cdp.evalJs(`(() => {
    const c = window.__villaDebug.camera;
    c.position.set(0, 1.7, 4.5);
    c.rotation.set(0, 0, 0, 'YXZ');
  })()`);
  await sleep(300);
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', bubbles: true }))`);
  await sleep(4200);
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', bubbles: true }))`);
  await sleep(400);
  const fenceHit = await state(cdp);
  console.log('--- 抵住庭院边界 ---');
  console.log(JSON.stringify(fenceHit));

  // 桥面通行：传送到引桥，面朝 +Z，一路走过木桥到对岸
  await cdp.evalJs(`(() => {
    const c = window.__villaDebug.camera;
    c.position.set(0, 1.7, 14);
    c.rotation.set(0, Math.PI, 0, 'YXZ');
  })()`);
  await sleep(300);
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }))`);
  await sleep(6000);
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }))`);
  await sleep(400);
  const bridgeCross = await state(cdp);
  console.log('--- 走过木桥到对岸 ---');
  console.log(JSON.stringify(bridgeCross));

  // 桥面中段向右横移：栏杆收窄，不能走进河里
  await cdp.evalJs(`(() => {
    const c = window.__villaDebug.camera;
    c.position.set(0, 1.7, 21.5);
    c.rotation.set(0, 0, 0, 'YXZ');
  })()`);
  await sleep(300);
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', bubbles: true }))`);
  await sleep(3000);
  await cdp.evalJs(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', bubbles: true }))`);
  await sleep(400);
  const bridgeRail = await state(cdp);
  console.log('--- 桥上被栏杆挡住 ---');
  console.log(JSON.stringify(bridgeRail));

  // 退出漫游：恢复 OrbitControls / 相机位置 / 按键状态
  await cdp.evalJs(`document.getElementById('roam-btn').click()`, true);
  await sleep(900);
  const exited = await state(cdp);
  console.log('--- 退出漫游 ---');
  console.log(JSON.stringify(exited));

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
    ['页面与调试钩子就绪', initial.ready === '1'],
    ['默认是上帝视角', initial.active === false && initial.orbitEnabled === true && initial.pointerEnabled === false],
    ['按钮初始文案正确', initial.buttonText === '🚶 漫游模式' && initial.buttonPressed === 'false'],
    ['点击后进入漫游', entered.active === true],
    ['指针锁定成功', entered.locked === true],
    ['OrbitControls 已禁用', entered.orbitEnabled === false],
    ['PointerLockControls 已启用', entered.pointerEnabled === true],
    ['按钮切换为退出漫游', entered.buttonText === '🚶 退出漫游' && entered.buttonPressed === 'true'],
    ['准星与提示出现', entered.crosshair === true && entered.hint === true],
    ['漫游使用 62° 视野', entered.fov === 62],
    ['视点高度 1.7m', entered.position.y === 1.7],
    ['从院门外石径开始', Math.abs(entered.position.x) < 0.01 && Math.abs(entered.position.z - 12.2) < 0.01],
    ['W 键触发前进', moving.keys.KeyW === true && moving.position.z < entered.position.z - 0.5],
    ['移动中高度不变', moving.position.y === 1.7 && stopped.position.y === 1.7],
    ['松开 W 后按键复位', stopped.keys.KeyW === false && Math.abs(stopped.velocity.z) < 0.05],
    ['能从入户门走进一楼客厅', indoor.position.z < 3.0 && indoor.position.z > -3.0 && Math.abs(indoor.position.x) < 0.3],
    ['室内视点高度 = 台基 + 室内地面 + 1.7m', Math.abs(indoor.position.y - 2.04) < 0.02],
    ['沿楼梯走上二楼', Math.abs(upstairs.position.y - 4.84) < 0.02 && upstairs.position.z < -1.6],
    ['不会穿过庭院围栏', fenceHit.position.x > 8.09 && fenceHit.position.x < 8.11],
    ['能从引桥走过木桥到对岸', Math.abs(bridgeCross.position.x) < 0.05 && bridgeCross.position.z > 25.6],
    ['桥面行走高度保持 1.7m', bridgeCross.position.y === 1.7],
    ['桥上被栏杆限制，不会走进河里', bridgeRail.position.x > 0.85 && bridgeRail.position.x < 0.89],
    ['退出后恢复上帝视角', exited.active === false && exited.orbitEnabled === true && exited.pointerEnabled === false],
    ['退出后按钮复位', exited.buttonText === '🚶 漫游模式' && exited.buttonPressed === 'false'],
    ['退出后准星与提示隐藏', exited.crosshair === false && exited.hint === false],
    ['退出后按键与速度清零', allKeysReleased(exited.keys) && exited.velocity.x === 0 && exited.velocity.z === 0],
    ['退出后相机回到原位', exited.position.y > 5],
    ['退出后恢复 42° 视野', exited.fov === 42],
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
