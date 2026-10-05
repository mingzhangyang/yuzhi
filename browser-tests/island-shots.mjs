/**
 * 小岛观感对照截图：固定数据、固定时刻，分别截桌面 / 手机、白天 / 夜里。
 * 每批画面调整前后各跑一次，对比同名截图即可。
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

/** 四座村落：不同的完成量，让房子数量有多有少；每村都留几件未完成的任务，岛上才有人走动。 */
async function seed(page) {
  await page.evaluate(() => {
    const { store, actions: A } = window.yuzhi;
    const plan = [['写作', 18, 4], ['花园', 9, 3], ['搬家', 24, 5], ['学琴', 4, 2]];
    const have = new Set(store.activeProjects().map((p) => p.name));
    for (const [name, done, open] of plan) {
      if (have.has(name)) continue;
      const p = A.createProject(store, name);
      for (let k = 0; k < done + open; k++) {
        const t = A.createTask(store, { title: `${name} ${k + 1}`, projectId: p.id });
        if (k < done) A.markTaskDone(store, t.id);
      }
    }
  });
}

mkdirSync(shotDir, { recursive: true });
const browser = await chromium.launch({ channel: channel || undefined, headless: true });
try {
  for (const vp of VIEWPORTS) {
    for (const time of TIMES) {
      const { name: _name, ...opts } = vp;
      const context = await browser.newContext({ timezoneId: TZ, locale: 'zh-CN', ...opts });
      const page = await context.newPage();
      await page.clock.setFixedTime(at(time.hm));
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => Boolean(window.yuzhi?.renderer && window.yuzhi?.store), undefined, { timeout: 20_000 });
      await page.waitForFunction(() => document.body.dataset.readOnly === 'false', undefined, { timeout: 20_000 });
      // 启动时持久化层可能还会重载一次数据，把刚铺的数据冲掉；等四座村落真正出现，否则重铺。
      for (let tries = 0; ; tries++) {
        await seed(page);
        const ok = await page
          .waitForFunction(() => window.yuzhi.renderer.scene?.villages.length >= 4, undefined, { timeout: 8000 })
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
