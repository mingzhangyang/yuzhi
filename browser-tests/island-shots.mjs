/**
 * 小岛观感对照截图：固定数据、固定时刻，分别截桌面 / 手机、白天 / 夜里。
 * 每批画面调整前后各跑一次，对比同名截图即可。id 与 Math.random 都已固定，但小人仍按真实帧时间走动，
 * 位置会有细微差别。
 *
 *   npm run build && npx vite preview --port 4173 --strictPort &
 *   SHOT_DIR=shots/after node browser-tests/island-shots.mjs
 *
 * 环境变量：BASE_URL（默认 http://127.0.0.1:4173）、PW_CHANNEL（默认空，用 Playwright 自带的
 * Chromium）、SHOT_DIR（截图目录，默认 shots）。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const channel = process.env.PW_CHANNEL ?? '';
const shotDir = process.env.SHOT_DIR ?? 'shots';
const TZ = 'Asia/Shanghai';
const at = (hm) => new Date(`2026-07-14T${hm}:00+08:00`);

const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 },
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
];
const TIMES = [
  { name: 'day', hm: '10:30' },
  { name: 'night', hm: '21:30' },
];

/**
 * 四座村落：不同的完成量，让房子数量有多有少；每村都留几件未完成的任务，岛上才有人走动。
 * 另有三个已完成的项目立成地标（钟楼、藏书阁、风车各一）。
 */
async function seed(page) {
  await page.evaluate(async () => {
    const { store, actions: A } = window.yuzhi;
    const have = new Set(store.data.projects.map((p) => p.name));
    const make = (name, done, open) => {
      const p = A.createProject(store, name);
      for (let k = 0; k < done + open; k++) {
        const t = A.createTask(store, { title: `${name} ${k + 1}`, projectId: p.id });
        if (k < done) A.markTaskDone(store, t.id);
      }
      return p;
    };
    // 整批只提交一次：store 要等所有待提交的写入落盘才通知界面，逐条提交上百次会让画面迟迟不更新。
    store.batch(() => {
      for (const [name, done] of [['毕业论文', 21], ['旅行', 6], ['装修', 27]]) {
        if (!have.has(name)) A.completeProject(store, make(name, done, 0).id, 'landmark');
      }
      for (const [name, done, open] of [['写作', 18, 4], ['花园', 9, 3], ['搬家', 24, 5], ['学琴', 4, 2]]) {
        if (!have.has(name)) make(name, done, open);
      }
    });
    await store.flush();
  });
}

mkdirSync(shotDir, { recursive: true });
const browser = await chromium.launch({ channel: channel || undefined, headless: true });
try {
  for (const vp of VIEWPORTS) {
    for (const time of TIMES) {
      const { name: _name, ...opts } = vp;
      const context = await browser.newContext({ timezoneId: TZ, locale: 'zh-CN', ...opts });
      // 项目和任务的 id 决定小人的外貌、落脚点和哪几户亮灯；固定随机源，改前改后两次运行才画出同一个场景。
      await context.addInitScript(() => {
        let seed = 20260714;
        const rand = () => {
          seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        Math.random = rand;
        let n = 0;
        crypto.randomUUID = () => {
          n++;
          // uid() 只取前 16 位，计数器放在最前面保证唯一
          const part = () => Math.floor(rand() * 2 ** 32).toString(16).padStart(8, '0');
          const hex = n.toString(16).padStart(8, '0') + part() + part() + part();
          return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        };
      });
      const page = await context.newPage();
      await page.clock.setFixedTime(at(time.hm));
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => Boolean(window.yuzhi?.renderer && window.yuzhi?.store), undefined, { timeout: 20_000 });
      await page.waitForFunction(() => document.body.dataset.readOnly === 'false', undefined, { timeout: 20_000 });
      // main.ts 订阅 store 之后立即 update() 一次，renderer.scene 出现说明订阅已就位；
      // 早于此刻铺的数据要等下一次定时刷新才会画出来。
      await page.waitForFunction(() => Boolean(window.yuzhi.renderer.scene), undefined, { timeout: 20_000 });
      // 启动时持久化层可能还会重载一次数据，把刚铺的数据冲掉；等村落和地标真正出现，否则重铺。
      for (let tries = 0; ; tries++) {
        await seed(page);
        const ok = await page
          .waitForFunction(() => window.yuzhi.renderer.scene?.villages.length >= 4 && window.yuzhi.renderer.scene.landmarks.length >= 3, undefined, { timeout: 8000 })
          .then(() => true, () => false);
        if (ok) break;
        if (tries >= 2) throw new Error(`${vp.name}-${time.name}: seeded villages never appeared`);
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(3500);
      const file = join(shotDir, `${vp.name}-${time.name}.png`);
      await page.locator('#mapwrap').screenshot({ path: file });
      console.log(file);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
