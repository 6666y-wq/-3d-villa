import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = `http://127.0.0.1:8000/villa.html?verify=${Date.now()}`;
const PORT = 9233;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = 'C:\\Users\\Admin1（无密码）\\.cline\\data\\workspaces\\chat\\3d-villa\\';
const profile = mkdtempSync(join(tmpdir(), 'edge-villa-'));
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
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && x.url.includes('villa.html'));
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
  btn: document.getElementById('daynight-btn').textContent.trim(),
  pressed: document.getElementById('daynight-btn').getAttribute('aria-pressed'),
  nightClass: document.getElementById('daynight-btn').classList.contains('is-night'),
  floorActive: document.querySelectorAll('.floor-btn[data-floor].is-active').length,
  floorCount: document.querySelectorAll('.floor-btn[data-floor]').length,
  canvas: (() => { const c = document.getElementById('scene'); return c.width + 'x' + c.height; })()
})`;

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
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Page.bringToFront');

  // 等模块脚本、按钮和首帧渲染就绪
  for (let i = 0; i < 75; i++) {
    const ready = await cdp.evalJs(
      `document.documentElement.dataset.villaReady === '1'`
    );
    if (ready) break;
    await sleep(400);
  }
  await sleep(1500);

  console.log('--- 初始（白天） ---');
  console.log(await cdp.evalJs(stateExpr));
  await shot(cdp, 'preview-day.png');

  await cdp.evalJs(`document.getElementById('daynight-btn').click()`);
  console.log('--- 点击后 ---');
  console.log(await cdp.evalJs(stateExpr));

  // 无头 SwiftShader 帧率低，dt 被钳到 0.1，固定 sleep 可能只走到中途；
  // 这里按 nightMix 轮询，确保截到真正的夜晚而不是黄昏。
  for (let i = 0; i < 150; i++) {
    const mix = await cdp.evalJs(`window.__villaDebug.nightMix`);
    if (mix >= 0.999) break;
    await sleep(400);
  }
  await sleep(700);
  console.log('--- 夜晚稳定 ---');
  console.log(await cdp.evalJs(stateExpr));
  const nightLook = JSON.parse(await cdp.evalJs(`(() => {
    const d = window.__villaDebug;
    return JSON.stringify({
      nightMix: d.nightMix,
      fogDensity: d.scene.fog.density,
      starsVisible: d.particles.stars.visible,
      starOpacity: d.particles.starMat.opacity,
      firefliesVisible: d.particles.fireflies.visible,
      fireflyLightsOn: d.fireflyLights.filter((l) => l.visible && l.intensity > 0).length,
      ripples: d.waterRipples.length,
      grassWindTime: d.grassWindUniforms.uTime.value
    });
  })()`));
  console.log(nightLook);
  await shot(cdp, 'preview-night.png');

  await cdp.evalJs(`document.getElementById('daynight-btn').click()`);
  for (let i = 0; i < 150; i++) {
    const mix = await cdp.evalJs(`window.__villaDebug.nightMix`);
    if (mix <= 0.001) break;
    await sleep(400);
  }
  await sleep(500);
  console.log('--- 切回白天 ---');
  console.log(await cdp.evalJs(stateExpr));
  const dayLook = JSON.parse(await cdp.evalJs(`(() => {
    const d = window.__villaDebug;
    return JSON.stringify({
      nightMix: d.nightMix,
      fogDensity: d.scene.fog.density,
      starsVisible: d.particles.stars.visible,
      exposure: d.renderer.toneMappingExposure
    });
  })()`));
  console.log(dayLook);
  await shot(cdp, 'preview-day-again.png');

  const errors = cdp.events.filter((e) =>
    (e.method === 'Runtime.exceptionThrown') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
  );
  console.log('errors =', errors.length);
  for (const e of errors.slice(0, 8)) {
    console.log(JSON.stringify(e.params).slice(0, 500));
  }

  const checks = [
    ['夜晚过渡到 nightMix = 1', Math.abs(nightLook.nightMix - 1) < 0.002],
    ['夜晚指数雾密度 0.015', Math.abs(nightLook.fogDensity - 0.015) < 1e-6],
    ['夜晚星空可见且不透明', nightLook.starsVisible === true && nightLook.starOpacity > 0.9],
    ['夜晚萤火虫可见', nightLook.firefliesVisible === true],
    ['2 盏萤火虫微光点光源已点亮', nightLook.fireflyLightsOn === 2],
    ['水面 9 个涟漪在运行', nightLook.ripples === 9],
    ['草叶风场时间在推进', nightLook.grassWindTime > 0.5],
    ['切回白天 nightMix = 0', Math.abs(dayLook.nightMix) < 0.002],
    ['白天雾密度 0.0075', Math.abs(dayLook.fogDensity - 0.0075) < 1e-6],
    ['白天星空自动隐藏', dayLook.starsVisible === false],
    ['白天曝光 1.2', Math.abs(dayLook.exposure - 1.2) < 0.02],
    ['控制台无错误', errors.length === 0]
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
    if (!ok) failed++;
  }
  console.log(`RESULT: ${checks.length - failed}/${checks.length} passed`);
  if (failed) process.exitCode = 1;

  cdp.ws.close();
} catch (err) {
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
