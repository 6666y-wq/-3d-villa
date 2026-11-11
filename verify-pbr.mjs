import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = `http://127.0.0.1:8011/villa.html?pbr=${Date.now()}`;
const PORT = 9251;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = 'C:\\Users\\Admin1（无密码）\\.cline\\data\\workspaces\\chat\\3d-villa\\';
const MODEL = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r169/examples/models/gltf/LeePerrySmith/LeePerrySmith.glb';
const profile = mkdtempSync(join(tmpdir(), 'edge-villa-pbr-'));
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
      const t = list.find((x) => x.type === 'page' && x.url.includes('villa.html'));
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
  async evalJs(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    }
    return r.result.value;
  }
}

async function waitFor(cdp, expression, timeout = 30000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try {
      last = await cdp.evalJs(expression);
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await sleep(400);
  }
  throw new Error(`等待超时: ${expression} (last=${JSON.stringify(last)})`);
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
}

const stateExpr = `(() => {
  const d = window.__villaDebug;
  return JSON.stringify({
    ready: document.documentElement.dataset.villaReady || null,
    envReady: d.environment.ready,
    envIntensity: Number(d.environment.intensity.toFixed(3)),
    envIsTexture: !!(d.scene.environment && d.scene.environment.isTexture),
    envMapping: d.scene.environment ? d.scene.environment.mapping : null,
    toneMapping: d.toneMapping.mode,
    exposure: Number(d.toneMapping.exposure.toFixed(3)),
    outputPassLast: d.toneMapping.outputPassLast,
    shadowMapType: d.renderer.shadowMap.type,
    shadowRadius: d.sun.shadow.radius,
    roundedRadius: d.roundedBox.radius,
    roundedSegments: d.roundedBox.segments,
    cachedGeometries: d.roundedBox.cachedGeometries,
    wallGeo: d.floorWallMeshes[0].geometry.constructor.name,
    stoneGeo: d.stonePath.geometry.constructor.name,
    wallRoughness: d.wallMat.roughness,
    roofRoughness: d.roofMat.roughness,
    roofMetalness: d.roofMat.metalness,
    roofEnv: d.roofMat.envMapIntensity,
    glassRoughness: d.glassMat.roughness,
    glassMetalness: d.glassMat.metalness,
    glassEnv: d.glassMat.envMapIntensity,
    glassOpacity: Number(d.glassMat.opacity.toFixed(3)),
    fogType: d.scene.fog
      ? (d.scene.fog.isFogExp2 ? 'FogExp2' : (d.scene.fog.isFog ? 'Fog' : 'unknown'))
      : null,
    fogDensity: Number(d.scene.fog.density.toFixed(4)),
    waterRipples: d.waterRipples.length,
    waterBumpScale: Number(d.water.bumpScale.toFixed(4)),
    waterOpacity: Number(d.water.opacity.toFixed(3)),
    grassWindTime: Number(d.grassWindUniforms.uTime.value.toFixed(2)),
    starCount: d.particles.starCount,
    starSize: d.particles.starMat.size,
    starVisible: d.particles.stars.visible,
    starOpacity: Number(d.particles.starMat.opacity.toFixed(3)),
    starTintSpread: (() => {
      const a = d.particles.stars.geometry.attributes.color.array;
      let spread = 0;
      for (let i = 0; i < Math.min(a.length, 300); i += 3) {
        spread = Math.max(spread, Math.abs(a[i] - a[i + 2]));
      }
      return Number(spread.toFixed(3));
    })(),
    fireflyLights: d.fireflyLights.length,
    fireflyLightSum: d.fireflyLights.reduce((s, l) => s + l.intensity, 0),
    fenceGlassRoughness: d.fenceGlassMat.roughness,
    fenceGlassMetalness: d.fenceGlassMat.metalness,
    fenceGlassEnv: d.fenceGlassMat.envMapIntensity,
    waterRoughness: d.water.roughness,
    waterMetalness: d.water.metalness,
    waterEnv: d.water.envMapIntensity,
    waterEmissive: d.water.emissiveIntensity,
    grassBump: !!d.courtyardGroundMat.bumpMap,
    grassBumpScale: d.courtyardGroundMat.bumpScale,
    trees: d.treeGroup.children.length,
    grassCount: d.garden.grassCount,
    grassClumpSize: d.garden.grassClumpSize,
    forestTrees: d.forest.treeCount,
    forestTrunks: d.forest.trunkInstances,
    forestLeaf: d.forest.leafCanopies,
    forestPine: d.forest.pineCanopies,
    shrubCount: d.garden.shrubCount,
    stoneCount: d.garden.stoneCount,
    leafCount: d.garden.leafCount,
    drawCalls: d.garden.drawCalls,
    triangles: d.garden.triangles,
    frameMs: d.garden.frameMs,
    bridgePlanks: d.bridgeGroup.getObjectByName('bridge-planks').count,
    bridgeFrame: d.bridgeGroup.getObjectByName('bridge-frame').count,
    waterBump: !!d.riverWaterMat.bumpMap,
    externalModels: d.externalModels.children.length,
    geometries: d.renderer.info.memory.geometries,
    composerPasses: d.composer.passes.length,
    nightMix: Number(d.nightMix.toFixed(3)),
    bloomEnabled: d.bloom.enabled,
    bloomStrength: Number(d.bloom.strength.toFixed(3)),
    bloomRadius: d.bloom.radius,
    bloomThreshold: d.bloom.threshold
  });
})()`;

(async () => {
  let cdp = null;
  try {
    const target = await findTarget();
    cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    await waitFor(cdp, `document.documentElement.dataset.villaReady === '1'`, 30000);
    console.log('--- 页面就绪 ---');

    // HDR 需要下载 + PMREM 预滤波，给足时间
    await waitFor(cdp, `window.__villaDebug.environment.ready === true`, 45000);
    await sleep(1200);

    const dayState = JSON.parse(await cdp.evalJs(stateExpr));
    console.log('--- 白天 / PBR 状态 ---');
    console.log(JSON.stringify(dayState, null, 2));
    await shot(cdp, 'preview-v9-pbr-day.png');

    // GLTFLoader 冒烟测试：加载一个官方示例模型到远处，验证 loadModel() 可用
    const loaded = await cdp.evalJs(`(() => {
      const d = window.__villaDebug;
      return d.loadModel(${JSON.stringify(MODEL)}, [42, 0, 42], { scale: 0.5 })
        .then((model) => {
          let meshes = 0;
          model.traverse((o) => { if (o.isMesh) meshes++; });
          return JSON.stringify({ meshes, groups: d.externalModels.children.length });
        });
    })()`, true);
    const modelState = JSON.parse(loaded);
    console.log('--- GLTFLoader ---');
    console.log(JSON.stringify(modelState));

    // 切到夜晚，验证环境光 / 曝光 / OutputPass 链路仍然工作
    await cdp.evalJs(`document.getElementById('daynight-btn').click()`);
    await waitFor(cdp, `window.__villaDebug.nightMix >= 0.999`, 30000);
    await sleep(700);
    const nightState = JSON.parse(await cdp.evalJs(stateExpr));
    console.log('--- 夜晚状态 ---');
    console.log(JSON.stringify(nightState, null, 2));
    await shot(cdp, 'preview-v9-pbr-night.png');

    const errors = cdp.events.filter((e) =>
      (e.method === 'Runtime.exceptionThrown') ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    );
    console.log('errors =', errors.length);
    for (const e of errors.slice(0, 8)) {
      console.log(JSON.stringify(e.params).slice(0, 900));
    }

    const checks = [
      ['页面初始化完成', dayState.ready === '1'],
      ['scene.environment 已赋值', dayState.envReady === true && dayState.envIsTexture === true],
      ['环境贴图使用 CubeUV / PMREM', dayState.envMapping === 306],
      ['白天环境光强度 0.55', Math.abs(dayState.envIntensity - 0.55) < 0.02],
      ['ACESFilmicToneMapping 已开启', dayState.toneMapping === 4],
      ['OutputPass 位于 composer 末尾', dayState.outputPassLast === true],
      ['白天曝光 1.2（CONFIG.exposure.day）', Math.abs(dayState.exposure - 1.2) < 0.02],
      ['PCF 阴影 + radius 4（radius 真正生效）', dayState.shadowMapType === 1 && dayState.shadowRadius === 4],
      ['墙体哑光：roughness 0.9', Math.abs(dayState.wallRoughness - 0.9) < 1e-6],
      ['指数雾 FogExp2 / 白天密度 0.0075', dayState.fogType === 'FogExp2' && Math.abs(dayState.fogDensity - 0.0075) < 1e-6],
      ['圆角半径 0.05 / 分段 2', dayState.roundedRadius === 0.05 && dayState.roundedSegments === 2],
      ['圆角几何体已缓存复用', dayState.cachedGeometries > 50],
      ['墙体使用 RoundedBoxGeometry', dayState.wallGeo === 'RoundedBoxGeometry'],
      ['石板路使用 RoundedBoxGeometry', dayState.stoneGeo === 'RoundedBoxGeometry'],
      ['屋檐 roughness 0.58 / metalness 0.3 / env 0.75',
        Math.abs(dayState.roofRoughness - 0.58) < 1e-6 &&
        Math.abs(dayState.roofMetalness - 0.3) < 1e-6 &&
        Math.abs(dayState.roofEnv - 0.75) < 1e-6],
      ['窗户玻璃 roughness 0.1 / metalness 0.8 / env 0.5 / opacity 0.6',
        Math.abs(dayState.glassRoughness - 0.1) < 1e-6 &&
        Math.abs(dayState.glassMetalness - 0.8) < 1e-6 &&
        Math.abs(dayState.glassEnv - 0.5) < 1e-6 &&
        Math.abs(dayState.glassOpacity - 0.6) < 1e-3],
      ['围栏玻璃 roughness 0.32 / metalness 0.02 / env 0.4',
        Math.abs(dayState.fenceGlassRoughness - 0.32) < 1e-6 &&
        Math.abs(dayState.fenceGlassMetalness - 0.02) < 1e-6 &&
        Math.abs(dayState.fenceGlassEnv - 0.4) < 1e-6],
      ['水面已去镜面：roughness 0.68 / metalness 0 / env 0.35',
        Math.abs(dayState.waterRoughness - 0.68) < 1e-6 &&
        Math.abs(dayState.waterMetalness) < 1e-6 &&
        Math.abs(dayState.waterEnv - 0.35) < 1e-6],
      ['草坪 bumpMap 生效', dayState.grassBump === true && Math.abs(dayState.grassBumpScale - 0.06) < 1e-6],
      ['低模树仍为 5 棵（外部树未启用）', dayState.trees === 5],
      ['草地 4800 个实例 / 10 个一簇（单个 InstancedMesh）',
        dayState.grassCount === 4800 && dayState.grassClumpSize === 10],
      ['外围森林 200 棵 / 200 树干 / 600 个树冠实例',
        dayState.forestTrees === 200 &&
        dayState.forestTrunks === 200 &&
        dayState.forestLeaf + dayState.forestPine === 600],
      ['灌木 60 丛 / 石头 80 块（实例化）', dayState.shrubCount === 60 && dayState.stoneCount === 80],
      ['落叶 50 片（动态实例化）', dayState.leafCount === 50],
      ['木桥桥面 22 块 / 栏杆框架 28 件', dayState.bridgePlanks === 22 && dayState.bridgeFrame === 28],
      ['河水 bumpMap 生效且随呼吸变化', dayState.waterBump === true &&
        dayState.waterBumpScale > 0.18 && dayState.waterBumpScale < 0.22],
      ['水面 9 个扩散涟漪', dayState.waterRipples === 9],
      ['水面透明度随呼吸浮动', dayState.waterOpacity > 0.85 && dayState.waterOpacity < 1.0],
      ['草叶风场 shader 时间在推进', dayState.grassWindTime > 0.5],
      ['白天 Bloom 关闭', dayState.bloomEnabled === false && dayState.bloomStrength === 0],
      // 空腔外墙 + 窗套 + 屋顶分件后 draw call 上升到 900 左右；
      // 仍在桌面端可接受范围，这里只作为“别失控”的上限守卫。
      ['新增内容后 draw call 仍然很少', dayState.drawCalls > 0 && dayState.drawCalls < 1200],
      ['loadModel 成功加载 GLB', modelState.meshes > 0 && modelState.groups === 1],
      ['夜晚环境光降到 0.12', Math.abs(nightState.envIntensity - 0.12) < 0.02],
      ['夜晚曝光 1.12（CONFIG.exposure.night）', Math.abs(nightState.exposure - 1.12) < 0.02],
      ['夜晚指数雾加浓到 0.015', Math.abs(nightState.fogDensity - 0.015) < 1e-6],
      ['夜晚水面只保留 0.35 冷蓝自发光', Math.abs(nightState.waterEmissive - 0.35) < 0.02],
      ['星空 1100 颗 / 1.7px 可见', nightState.starCount === 1100 &&
        Math.abs(nightState.starSize - 1.7) < 1e-6 &&
        nightState.starVisible === true && nightState.starOpacity > 0.9],
      ['星色蓝 / 黄随机而非纯白', nightState.starTintSpread > 0.05],
      ['2 盏萤火虫微光点光源', nightState.fireflyLights === 2 && nightState.fireflyLightSum > 0.2],
      ['夜晚泛光 0.32 / radius 0.36 / threshold 0.78',
        nightState.bloomEnabled === true &&
        Math.abs(nightState.bloomStrength - 0.32) < 0.02 &&
        Math.abs(nightState.bloomRadius - 0.36) < 1e-6 &&
        Math.abs(nightState.bloomThreshold - 0.78) < 1e-6],
      ['渲染器持有大量真实几何体', dayState.geometries > 100],
      ['OutputPass 位于链路末端（3 个 Pass）', dayState.composerPasses === 3],
      ['控制台无错误', errors.length === 0]
    ];

    let failed = 0;
    for (const [name, ok] of checks) {
      console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
      if (!ok) failed++;
    }
    process.exitCode = failed ? 1 : 0;
    console.log(`RESULT: ${checks.length - failed}/${checks.length} passed`);
  } catch (err) {
    console.error('FAILED:', err);
    process.exitCode = 1;
  } finally {
    try { if (cdp) cdp.ws.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    await sleep(800);
    process.exit(process.exitCode || 0);
  }
})();
