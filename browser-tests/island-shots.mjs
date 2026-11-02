/**
 * 小岛观感对照截图（美术优化计划第 4.1 节的截图矩阵）：固定数据、固定时刻，
 * 每期画面调整前后各跑一次，对比同名截图即可。id、Math.random 与动画时钟都已固定：
 * 截图前停掉 rAF 循环，按固定步长推进同样的帧数再画一帧，同一份代码两次运行得到同一张图。
 *
 *   npm run build && npx vite preview --port 4173 --strictPort &
 *   SHOT_DIR=shots/after node browser-tests/island-shots.mjs
 *   node browser-tests/shot-diff.mjs shots/before shots/after   # 逐像素对比两批截图
 *
 * 环境变量：BASE_URL（默认 http://127.0.0.1:4173）、PW_CHANNEL（默认空，用 Playwright 自带的
 * Chromium）、SHOT_DIR（截图目录，默认 shots）、SHOT_ONLY（只跑名字里含这些词的场景，逗号分隔，
 * 例如 SHOT_ONLY=decay,cult）。
 *
 * 矩阵（文件名 `<组>-<场景>-<视口>.png`）：
 *   time     夏季 10:30 / 18:50 / 21:30                     桌面 @2x、手机 @3x
 *   season   春 4 月、秋 10 月、冬 1 月（积雪）白天             桌面、手机
 *   decay    四座村落，最近一次推进在 0 / 8 / 15 / 29 天前      手机（不放大），另出遮住标签的 -blind 版
 *   cult     四个培育区同时处于 0–4 级（构造结算、日记事实）     手机，另出 -blind 版；桌面 2.8 倍每区一张
 *   close    2.8 倍：一座村落、码头、一座地标                   桌面
 *   theme    暗色主题下的白天与夜晚                             桌面
 *   cover    补充覆盖（不在计划矩阵里）：八种地标的昼 / 夜 / 雪、日程进行中、雨天、下雪、
 *            春节 / 端午 / 中秋 / 国庆 / 圣诞                     桌面
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const channel = process.env.PW_CHANNEL ?? '';
const shotDir = process.env.SHOT_DIR ?? 'shots';
const only = (process.env.SHOT_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TZ = 'Asia/Shanghai';

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

/** 选的日子都是晴天、不逢节日（ambience.weatherOf / festivalsOf），季节之间只比季节本身。 */
const SUMMER = '2026-07-14';
const SPRING = '2026-04-15';
const AUTUMN = '2026-10-20';
const WINTER = '2026-01-20';

/**
 * 场景：date + hm 决定季节与光线；seed 决定数据；zoom 是 2.8 倍近景的对准目标；
 * scheme 是系统配色（主题设置为「跟随系统」）；blind 另出一张不画标签的图，供第 4.2 节盲看。
 */
const SCENES = [
  { name: 'time-day', date: SUMMER, hm: '10:30', vps: ['desktop', 'phone'], seed: 'base' },
  { name: 'time-dusk', date: SUMMER, hm: '18:50', vps: ['desktop', 'phone'], seed: 'base' },
  { name: 'time-night', date: SUMMER, hm: '21:30', vps: ['desktop', 'phone'], seed: 'base' },
  { name: 'season-spring', date: SPRING, hm: '10:30', vps: ['desktop', 'phone'], seed: 'base' },
  { name: 'season-autumn', date: AUTUMN, hm: '10:30', vps: ['desktop', 'phone'], seed: 'base' },
  { name: 'season-winter', date: WINTER, hm: '10:30', vps: ['desktop', 'phone'], seed: 'base' },
  { name: 'decay', date: SUMMER, hm: '10:30', vps: ['phone'], seed: 'decay', blind: true },
  ...[0, 1, 2, 3, 4].flatMap((level) => [
    { name: `cult-l${level}`, date: SUMMER, hm: '10:30', vps: ['phone'], seed: `cult${level}`, blind: true },
    ...['field', 'orchard', 'pond', 'garden'].map((area) => ({ name: `cult-l${level}-${area}`, date: SUMMER, hm: '10:30', vps: ['desktop'], seed: `cult${level}`, zoom: area })),
  ]),
  { name: 'close-village', date: SUMMER, hm: '10:30', vps: ['desktop'], seed: 'base', zoom: 'village' },
  { name: 'close-dock', date: SUMMER, hm: '10:30', vps: ['desktop'], seed: 'base', zoom: 'dock' },
  { name: 'close-landmark', date: SUMMER, hm: '10:30', vps: ['desktop'], seed: 'base', zoom: 'landmark' },
  { name: 'theme-dark-day', date: SUMMER, hm: '10:30', vps: ['desktop'], seed: 'base', scheme: 'dark' },
  { name: 'theme-dark-night', date: SUMMER, hm: '21:30', vps: ['desktop'], seed: 'base', scheme: 'dark' },
  // 补充覆盖：计划矩阵之外、颜色迁移（A2）也要逐像素对上的绘制分支
  { name: 'cover-landmarks-day', date: SUMMER, hm: '10:30', vps: ['desktop'], seed: 'landmarks' },
  { name: 'cover-landmarks-night', date: SUMMER, hm: '21:30', vps: ['desktop'], seed: 'landmarks' },
  { name: 'cover-landmarks-winter', date: WINTER, hm: '10:30', vps: ['desktop'], seed: 'landmarks' },
  { name: 'cover-agenda', date: SUMMER, hm: '10:30', vps: ['desktop'], seed: 'agenda' },
  { name: 'cover-rain', date: '2026-07-15', hm: '10:30', vps: ['desktop'], seed: 'base' },
  { name: 'cover-snowfall', date: '2026-01-24', hm: '10:30', vps: ['desktop'], seed: 'base' },
  { name: 'cover-chunjie', date: '2026-02-17', hm: '19:30', vps: ['desktop'], seed: 'base' },
  { name: 'cover-duanwu', date: '2026-06-19', hm: '10:30', vps: ['desktop'], seed: 'base' },
  { name: 'cover-zhongqiu', date: '2026-09-25', hm: '20:30', vps: ['desktop'], seed: 'base' },
  { name: 'cover-guoqing', date: '2026-10-01', hm: '10:30', vps: ['desktop'], seed: 'base' },
  { name: 'cover-christmas', date: '2026-12-25', hm: '18:00', vps: ['desktop'], seed: 'base' },
];

/**
 * 在页面里铺数据。整批只提交一次：store 要等所有待提交的写入落盘才通知界面，
 * 逐条提交上百次会让画面迟迟不更新。按项目名去重，重铺时不会重复。
 */
async function seed(page, kind) {
  await page.evaluate(async (kind) => {
    const { store, actions: A } = window.yuzhi;
    const have = new Set(store.data.projects.map((p) => p.name));
    window.__reseed();
    const today = store.today();
    const addDays = (d, n) => {
      const [y, m, day] = d.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10);
    };
    const make = (name, done, open) => {
      const p = A.createProject(store, name);
      for (let k = 0; k < done + open; k++) {
        const t = A.createTask(store, { title: `${name} ${k + 1}`, projectId: p.id });
        if (k < done) A.markTaskDone(store, t.id);
      }
      return p;
    };
    // 与「放几个示例村落」同一种回溯：项目、任务的创建日期和对应的操作事实一起挪到过去
    const backProject = (pid, date) => {
      store.put('projects', { ...store.project(pid), createdAt: date });
      for (const op of store.data.operations) if (op.projectId === pid && op.kind === 'project-created') store.put('operations', { ...op, date });
    };
    const taskOn = (pid, title, date) => {
      const t = A.createTask(store, { title, projectId: pid, scheduledFor: date });
      store.put('tasks', { ...store.taskRecord(t.id), createdAt: date });
      for (const op of store.data.operations) if (op.taskId === t.id && op.kind === 'task-created') store.put('operations', { ...op, date });
      return t;
    };

    store.batch(() => {
      if (kind === 'base' || kind === 'agenda') {
        // 四座村落：不同的完成量，让房子数量有多有少；每村都留几件未完成的任务，岛上才有人走动。
        // 另有三个已完成的项目立成地标（钟楼、藏书阁、风车各一）。
        for (const [name, done] of [['毕业论文', 21], ['旅行', 6], ['装修', 27]]) {
          if (!have.has(name)) A.completeProject(store, make(name, done, 0).id, 'landmark');
        }
        for (const [name, done, open] of [['写作', 18, 4], ['花园', 9, 3], ['搬家', 24, 5], ['学琴', 4, 2]]) {
          if (!have.has(name)) make(name, done, open);
        }
        if (kind === 'agenda' && !have.has('写作')) {
          // 写作村此刻正在开会、一刻钟内还有一场；杂务小屋此刻也有一件事在做
          const write = store.data.projects.find((p) => p.name === '写作');
          A.createSchedule(store, { title: '写作例会', date: today, start: '10:00', end: '11:00', projectId: write.id });
          A.createSchedule(store, { title: '编辑沟通', date: today, start: '10:40', end: '11:20', projectId: write.id });
          A.createSchedule(store, { title: '取快递', date: today, start: '10:15', end: '10:50' });
        }
      } else if (kind === 'landmarks') {
        // 八座地标，钟楼、藏书阁、风车、观星台、玻璃温室、海港会馆、纪念塔、山亭各一，大小相间
        ['钟声', '书阁', '风车', '星台', '温室', '港口', '纪念', '山亭'].forEach((name, k) => {
          if (!have.has(name)) A.completeProject(store, make(name, k % 2 ? 6 : 21, 0).id, 'landmark');
        });
      } else if (kind === 'decay') {
        // 四座同样大小的村落（15 块砖），最近一次真实推进分别在 0 / 8 / 15 / 29 天前：
        // 项目就在那天立起、当天做完全部 15 件事，之后每过一个空白日子就多一天冷清，
        // 依次落在正常 / 安静 / 蒙灰 / 搬离（logic/config.ts 的 STAGE_START）。
        for (const [name, ago] of [['晨读', 0], ['木工', 8], ['摄影', 15], ['外语', 29]]) {
          if (have.has(name)) continue;
          const p = A.createProject(store, name);
          if (ago === 0) {
            for (let k = 0; k < 15; k++) A.markTaskDone(store, A.createTask(store, { title: `${name} ${k + 1}`, projectId: p.id }).id);
          } else {
            const date = addDays(today, -ago);
            backProject(p.id, date);
            const decisions = new Map();
            for (let k = 0; k < 15; k++) decisions.set(`task|${taskOn(p.id, `${name} ${k + 1}`, date).id}`, { outcome: 'done' });
            A.settleDay(store, date, decisions);
          }
          for (let k = 0; k < 2; k++) A.createTask(store, { title: `${name} 待办 ${k + 1}`, projectId: p.id });
        }
        A.refreshStages(store);
      } else if (kind.startsWith('cult')) {
        // 培育区等级只由近期事实推出（logic/cultivation.ts）。没有村落，四个区域同时处在 level 级：
        //   农田：近 14 天任务结算分（done 2、partial 1），门槛 1 / 3 / 7 / 12
        //   果园：近 14 天定时日程结算分（done 2、partial 1、skipped 0.5），门槛 0.5 / 2 / 5 / 9
        //   鱼塘：近 14 天结算过的天数，门槛 1 / 4 / 8 / 12
        //   花园：近 30 天写过日记的天数，门槛 1 / 3 / 7 / 14
        // 日程都放在 8 天以前，不让杂务小屋的柴堆（近 7 天）跟着变。
        const level = Number(kind.slice(4));
        if (store.data.days.length || store.data.diaries.length) return;
        const days = [[], [8], [8, 9, 10, 11], [6, 7, 8, 9, 10, 11, 12, 13], [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]][level];
        const field = [[], ['partial'], ['done', 'done'], ['done', 'done', 'done', 'done'], ['done', 'done', 'done', 'done', 'done', 'done']][level];
        const orchard = [[], ['skipped'], ['done'], ['done', 'done', 'done'], ['done', 'done', 'done', 'done', 'done']][level];
        const diaryDays = [0, 1, 3, 7, 14][level];
        const plan = new Map(days.map((ago) => [ago, { decisions: new Map(), extra: [] }]));
        field.forEach((outcome, k) => {
          const ago = days[k % days.length];
          const date = addDays(today, -ago);
          const t = A.createTask(store, { title: `田里的活 ${k + 1}` });
          store.put('tasks', { ...store.taskRecord(t.id), createdAt: date });
          for (const op of store.data.operations) if (op.taskId === t.id && op.kind === 'task-created') store.put('operations', { ...op, date });
          const key = `task|${t.id}`;
          plan.get(ago).decisions.set(key, { outcome });
          plan.get(ago).extra.push({ key, type: 'task', id: t.id, title: t.title });
        });
        const old = days.filter((ago) => ago >= 8);
        orchard.forEach((outcome, k) => {
          const ago = old[k % old.length];
          const ev = A.createSchedule(store, { title: `果园日程 ${k + 1}`, date: addDays(today, -ago), start: `${String(9 + Math.floor(k / old.length)).padStart(2, '0')}:00`, end: `${String(9 + Math.floor(k / old.length)).padStart(2, '0')}:45` });
          plan.get(ago).decisions.set(`event|${ev.id}`, outcome === 'skipped' ? { outcome, reason: 'interrupted' } : { outcome });
        });
        for (const ago of [...days].sort((a, b) => b - a)) A.settleDay(store, addDays(today, -ago), plan.get(ago).decisions, plan.get(ago).extra);
        for (let k = 0; k < diaryDays; k++) A.createDiary(store, { text: `第 ${k + 1} 篇日记`, date: addDays(today, -k * 2) });
      }
    });
    await store.flush();
  }, kind);
}

/** 铺好的数据真正出现在画面里了吗（启动时持久化层可能还会重载一次，把刚铺的数据冲掉） */
function seeded(kind) {
  return (k) => {
    const s = window.yuzhi.renderer.scene;
    if (!s) return false;
    if (k === 'base') return s.villages.length >= 4 && s.landmarks.length >= 3;
    if (k === 'agenda') return s.villages.length >= 4 && s.landmarks.length >= 3 && s.villages.some((v) => v.agenda?.phase === 'live');
    if (k === 'landmarks') return s.landmarks.length >= 8;
    if (k === 'decay') return s.villages.map((v) => v.stage).sort().join() === '0,1,2,3';
    const level = Number(k.slice(4));
    return s.cultivation.length === 4 && s.cultivation.every((a) => a.level === level);
  };
}

/** 2.8 倍放大，把目标挪到画面正中 */
async function zoomTo(page, target) {
  await page.evaluate((target) => {
    const r = window.yuzhi.renderer;
    const m = r.map;
    const s = r.scene;
    let at;
    if (target === 'village') {
      const vv = s.villages.slice().sort((a, b) => b.houses - a.houses)[0];
      at = m.villages[vv.slot].center;
    } else if (target === 'dock') {
      at = { i: m.dock.i + m.pierDir[0] * 0.5, j: m.dock.j + m.pierDir[1] * 0.5 };
    } else if (target === 'landmark') {
      at = m.landmarks[s.landmarks[0].index];
    } else {
      at = m.cultivation[target];
    }
    r.zoomAt(2.8 / r.view.zoom);
    const [x, y] = r.iso(at.i, at.j);
    r.view.panX += r.view.w / 2 - x;
    r.view.panY += r.view.h / 2 - y + r.view.tw * 0.25;
    r.layout();
  }, target);
}

/** 停掉 rAF 循环后按固定步长推进：动画时钟、小人走动和随机数消耗都与真实帧率无关。 */
async function settle(page, seconds) {
  await page.evaluate((frames) => {
    const r = window.yuzhi.renderer;
    window.__reseed();
    r.t = 0;
    // 停表之前真实帧里飘起来的花瓣、落叶、雪和烟花不能带进来，否则两次运行的起点不同
    r.drifts = [];
    r.driftKind = '';
    r.sparks = [];
    r.nextRocket = 0;
    // 模拟层自己的随机源（雨丝、烟花、小人选目的地）也归位，与 simulation.ts 的 mulberry32(7) 同一算法
    let a = 7;
    r.rnd = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let k = 0; k < frames; k++) {
      r.t += 1 / 60;
      r.step(1 / 60);
    }
    r.draw();
  }, Math.round(seconds * 60));
}

/** 不画标签再出一张：label() 换成空函数画一帧，再换回来 */
async function drawBlind(page) {
  await page.evaluate(() => {
    const r = window.yuzhi.renderer;
    const label = r.label;
    r.label = () => {};
    try {
      r.draw();
    } finally {
      r.label = label;
    }
  });
}

async function shoot(browser, scene, vpName) {
  const context = await browser.newContext({ timezoneId: TZ, locale: 'zh-CN', colorScheme: scene.scheme ?? 'light', ...VIEWPORTS[vpName] });
  try {
    // 项目和任务的 id 决定小人的外貌、落脚点和哪几户亮灯；固定随机源，改前改后两次运行才画出同一个场景。
    await context.addInitScript(() => {
      let seed = 20260714;
      let n = 0;
      // 随机数和 id 计数器一起归位：重铺数据时分配到的 id 与第一次完全相同
      window.__reseed = () => {
        seed = 20260714;
        n = 0;
      };
      const rand = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      Math.random = rand;
      crypto.randomUUID = () => {
        n++;
        // uid() 只取前 16 位，计数器放在最前面保证唯一
        const part = () => Math.floor(rand() * 2 ** 32).toString(16).padStart(8, '0');
        const hex = n.toString(16).padStart(8, '0') + part() + part() + part();
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      };
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(`${scene.date}T${scene.hm}:00+08:00`));
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.yuzhi?.renderer && window.yuzhi?.store), undefined, { timeout: 20_000 });
    await page.waitForFunction(() => document.body.dataset.readOnly === 'false', undefined, { timeout: 20_000 });
    await page.waitForFunction(() => Boolean(window.yuzhi.renderer.scene), undefined, { timeout: 20_000 });
    await page.evaluate(() => window.yuzhi.renderer.stop());
    for (let tries = 0; ; tries++) {
      await seed(page, scene.seed);
      const ok = await page.waitForFunction(seeded(scene.seed), scene.seed, { timeout: 8000 }).then(() => true, () => false);
      if (ok) break;
      if (tries >= 2) throw new Error(`${scene.name}-${vpName}: seeded scene never appeared`);
    }
    // 关掉欢迎页、「搬离」询问之类的对话框
    for (let k = 0; k < 3; k++) await page.keyboard.press('Escape');
    if (scene.zoom) await zoomTo(page, scene.zoom);
    // 道具贴图在第一次绘制时才开始加载；先画一帧，等它们都解码完，截图里才不会缺道具
    await page.evaluate(async () => {
      const r = window.yuzhi.renderer;
      r.draw();
      await Promise.all([...r.propArt.images.values()].map((img) => img.decode().catch(() => {})));
    });
    await settle(page, 3.5);
    const files = [];
    const file = join(shotDir, `${scene.name}-${vpName}.png`);
    await page.locator('#mapwrap').screenshot({ path: file });
    files.push(file);
    if (scene.blind) {
      await drawBlind(page);
      const blind = join(shotDir, `${scene.name}-${vpName}-blind.png`);
      await page.locator('#mapwrap').screenshot({ path: blind });
      files.push(blind);
    }
    return files;
  } finally {
    await context.close();
  }
}

mkdirSync(shotDir, { recursive: true });
const browser = await chromium.launch({ channel: channel || undefined, headless: true });
try {
  for (const scene of SCENES) {
    if (only.length && !only.some((w) => scene.name.includes(w))) continue;
    for (const vp of scene.vps) {
      for (const file of await shoot(browser, scene, vp)) console.log(file);
    }
  }
} finally {
  await browser.close();
}
