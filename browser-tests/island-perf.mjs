/**
 * 小岛绘制性能基线（美术优化计划第 4.3 节、A4 / A5）。固定场景：8 座村落 + 3 座地标，
 * 夏季白天 10:30 与夜晚 21:30；桌面 1280×860 @2x、手机 390×844 @3x；CPU 不降速与 4 倍降速。
 *
 *   Prerequisites: docs/art/README.md (install playwright@1.63.0 and Chromium)
 *   npm run build                                         # foreground, finish first
 *   npx vite preview --port 4173 --strictPort              # terminal A, wait for ready
 *   node browser-tests/island-perf.mjs                 # 只测整帧
 *   PERF_LAYERS=1 node browser-tests/island-perf.mjs   # 再按图层拆分（A5 静态层缓存评估）
 *
 * 每个组合停掉 rAF 循环，先空跑 20 帧，再测 120 帧，报告中位数与 p95（毫秒）：
 *   step+draw  与第 1 节基线同一口径：同步执行一次 step(1/30) + draw() 的耗时。
 *              Canvas 2D 的绘制命令可能被浏览器攒着、到某一帧才集中光栅化，所以会出现零星的长帧。
 *   +flush     每帧画完再读回 1 个像素，逼浏览器当场光栅化：更接近一帧真实的总成本，没有攒批造成的长帧。
 * 两种口径都在每帧之间让出一次 requestAnimationFrame。
 * PERF_BATCH=1 时再加一列「连续」：与 step+draw 相同，但帧与帧之间不让出，一口气画完 120 帧。
 * 浏览器没有机会在帧间提交画布，绘制命令越攒越多，隔一段就集中光栅化一次，用来复现第 1 节看到的周期性长帧。
 *
 * PERF_LAYERS=1 时，按「+flush」口径估算跳过某一类景物的成本，但须保留
 * 这些景物给 drawLights() 注册的夜间灯光。固定场景为无节日的 2026-07-14：
 * 先逐帧记录完整绘制的灯光（包括萤火虫），再让完整绘制和省略图层的测试
 * 使用同一套逐帧灯光数据，且两边都承担相同的重放开销。
 * 仅估算图层绘制缓存的理论上限：光源注册本身仍可能需要动态维护。
 *
 * 环境变量：BASE_URL（默认 http://127.0.0.1:4173）、PW_CHANNEL、PERF_FRAMES（默认 120）、PERF_LAYERS、PERF_BATCH。
 */
import { chromium } from 'playwright';
import { captureFrameLights, measureFrameCost } from './island-perf-core.mjs';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const channel = process.env.PW_CHANNEL ?? '';
const FRAMES = Number(process.env.PERF_FRAMES ?? 120);
const WARMUP = 20;
const LAYERS = process.env.PERF_LAYERS === '1';
const BATCH = process.env.PERF_BATCH === '1';
const TZ = 'Asia/Shanghai';

const VIEWPORTS = [
  { name: 'desktop 1280×860 @2x', viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 },
  { name: 'phone 390×844 @3x', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
];
const TIMES = [
  { name: 'day', hm: '10:30' },
  { name: 'night', hm: '21:30' },
];

/** 按图层拆分时省略景物绘制但保留完整逐帧灯光；static 为候选静态图层集合 */
const LAYER_STUBS = {
  trees: ['drawTree'],
  mountains: ['drawMountain'],
  houses: ['drawHouse'],
  landmarks: ['drawLandmark'],
  'well/granary/lighthouse': ['drawWell', 'drawGranary', 'drawLighthouse'],
  props: ['drawProp'],
  people: ['drawPerson'],
  sea: ['drawSea'],
  'sky+lights': ['drawCloudShadows', 'drawBirds', 'drawAmbient', 'drawStars', 'drawMoon', 'drawFireflies', 'drawLights'],
  labels: ['label'],
  static: ['drawTree', 'drawMountain', 'drawHouse', 'drawLandmark', 'drawWell', 'drawGranary', 'drawLighthouse', 'drawProp'],
};

async function seed(page) {
  await page.evaluate(async () => {
    const { store, actions: A } = window.yuzhi;
    window.__reseed();
    const have = new Set(store.data.projects.map((p) => p.name));
    const make = (name, done, open) => {
      const p = A.createProject(store, name);
      for (let k = 0; k < done + open; k++) {
        const t = A.createTask(store, { title: `${name} ${k + 1}`, projectId: p.id });
        if (k < done) A.markTaskDone(store, t.id);
      }
      return p;
    };
    store.batch(() => {
      for (const [name, done] of [['毕业论文', 21], ['旅行', 6], ['装修', 27]]) {
        if (!have.has(name)) A.completeProject(store, make(name, done, 0).id, 'landmark');
      }
      const villages = [['写作', 18, 4], ['花园', 9, 3], ['搬家', 24, 5], ['学琴', 4, 2], ['健身', 12, 3], ['摄影', 15, 4], ['读书', 27, 6], ['外语', 7, 2]];
      for (const [name, done, open] of villages) if (!have.has(name)) make(name, done, open);
    });
    await store.flush();
  });
}

/** Run the reusable, browser-side measurer. Source is also exercised by unit tests. */
async function measure(page, flush, stubs = [], yieldFrames = true, preserveLights = false) {
  return page.evaluate(measureFrameCost, {
    frames: FRAMES, warmup: WARMUP, flush, stubs, yieldFrames, preserveLights,
  });
}

const fmt = (x) => (x < 10 ? x.toFixed(1) : Math.round(x).toString());

const browser = await chromium.launch({ channel: channel || undefined, headless: true });
try {
  console.log(`frames=${FRAMES} warmup=${WARMUP}`);
  console.log(`| 视口 | CPU | 时段 | step+draw 中位 / p95 | 长帧(>50ms) | +flush 中位 / p95 | 地面缓存重建 |${BATCH ? ' 连续 中位 / p95 / 长帧 |' : ''}`);
  console.log(`|---|---|---|---|---|---|---|${BATCH ? '---|' : ''}`);
  const layerRows = [];
  for (const vp of VIEWPORTS) {
    for (const time of TIMES) {
      const { name: vpName, ...opts } = vp;
      const context = await browser.newContext({ timezoneId: TZ, locale: 'zh-CN', ...opts });
      // Deterministic IDs must be installed before the app creates records.
      await context.addInitScript(() => {
        let seed = 20260714;
        let counter = 0;
        window.__reseed = () => { seed = 20260714; counter = 0; };
        const rand = () => {
          seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        Math.random = rand;
        crypto.randomUUID = () => {
          counter++;
          const part = () => Math.floor(rand() * 2 ** 32).toString(16).padStart(8, '0');
          const hex = counter.toString(16).padStart(8, '0') + part() + part() + part();
          return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
            hex.slice(16, 20) + '-' + hex.slice(20);
        };
      });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date(`2026-07-14T${time.hm}:00+08:00`));
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => Boolean(window.yuzhi?.renderer?.scene), undefined, { timeout: 20_000 });
      await page.waitForFunction(() => document.body.dataset.readOnly === 'false', undefined, { timeout: 20_000 });
      await page.evaluate(() => window.yuzhi.renderer.stop());
      for (let tries = 0; ; tries++) {
        await seed(page);
        const ok = await page
          .waitForFunction(() => window.yuzhi.renderer.scene?.villages.length >= 8 && window.yuzhi.renderer.scene.landmarks.length >= 3, undefined, { timeout: 8000 })
          .then(() => true, () => false);
        if (ok) break;
        if (tries >= 2) throw new Error(`${vpName}-${time.name}: seeded villages never appeared`);
      }
      for (let k = 0; k < 3; k++) await page.keyboard.press('Escape');
      await page.evaluate(async () => {
        const r = window.yuzhi.renderer;
        r.draw();
        await Promise.all([...r.propArt.images.values()].map((img) => img.decode().catch(() => {})));
        // Snapshot a settled scene. Otherwise later layer measurements inherit
        // progressed walker trajectories, random particles and time offsets.
        for (const g of r.grow.values()) g.anim = 1;
        const walkers = [...r.walkers].map(([id, walker]) => [id, { ...walker }]);
        const grow = [...r.grow].map(([id, state]) => [id, { ...state }]);
        window.__resetPerfFrame = () => {
          window.__reseed();
          r.walkers = new Map(walkers.map(([id, walker]) => [id, { ...walker }]));
          r.grow = new Map(grow.map(([id, state]) => [id, { ...state }]));
          r.t = 0;
          r.pulses = [];
          r.bellRipples = [];
          r.pickedBottles = [];
          r.stageCues = [];
          r.granaryTransition = null;
          r.fogTransition = null;
          r.drifts = [];
          r.driftKind = '';
          r.sparks = [];
          r.nextRocket = 0;
          let seed = 7;
          r.rnd = () => {
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };
        };
      });
      const cdp = await context.newCDPSession(page);
      for (const rate of [1, 4]) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate });
        const a = await measure(page, false);
        const b = await measure(page, true);
        const batch = BATCH ? await measure(page, false, [], false) : null;
        const extra = batch ? ` ${fmt(batch.median)} / ${fmt(batch.p95)} / ${batch.long} |` : '';
        console.log(`| ${vpName} | ${rate}× | ${time.name} | ${fmt(a.median)} / ${fmt(a.p95)} | ${a.long} | ${fmt(b.median)} / ${fmt(b.p95)} | ${a.groundBuilds + b.groundBuilds} |${extra}`);
        if (LAYERS && rate === 4) {
          // Capture each frame's full lighting once, outside timing. The normalized
          // baseline and all layer omissions use the SAME drawLights adapter.
          const recorded = await page.evaluate(captureFrameLights, { frames: FRAMES, warmup: WARMUP });
          if (recorded.frames !== FRAMES + WARMUP) throw new Error('Incomplete lighting trace');
          const full = (await measure(page, true, [], true, true)).median;
          for (const [layer, stubs] of Object.entries(LAYER_STUBS)) {
            const m = await measure(page, true, stubs, true, true);
            layerRows.push(`| ${vpName} | ${time.name} | ${layer} | ${fmt(full - m.median)} | ${Math.round(((full - m.median) / full) * 100)}% |`);
          }
          layerRows.push(`| ${vpName} | ${time.name} | （整帧） | ${fmt(full)} | 100% |`);
        }
      }
      await context.close();
    }
  }
  if (layerRows.length) {
    console.log('\n4× 降速、+flush 口径；基线与省略图层均使用相同的逐帧完整灯光：');
    console.log('| 视口 | 时段 | 图层 | 每帧成本 | 占整帧 |');
    console.log('|---|---|---|---|---|');
    for (const row of layerRows) console.log(row);
  }
} finally {
  await browser.close();
}
