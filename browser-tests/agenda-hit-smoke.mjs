/**
 * 日程此刻层的真实浏览器验收：在固定时刻铺好日程，用鼠标真实点击画布，
 * 确认告示牌、条幅、扫帚不会抢走村落、小人和杂务小屋的点击，并截图留档。
 *
 *   npm run build && npx vite preview --port 4173 --strictPort &
 *   node browser-tests/agenda-hit-smoke.mjs
 *
 * 环境变量：BASE_URL（默认 http://127.0.0.1:4173）、PW_CHANNEL（默认 chrome，
 * 设为空串则用 Playwright 自带的 Chromium）、SHOT_DIR（截图目录，不设则不截图）。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseURL = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const channel = process.env.PW_CHANNEL ?? 'chrome';
const shotDir = process.env.SHOT_DIR;
const timeout = 20_000;
const TZ = 'Asia/Shanghai';
const at = (hm) => new Date(`2026-10-04T${hm}:00+08:00`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function shot(page, name) {
  if (!shotDir) return;
  mkdirSync(shotDir, { recursive: true });
  await page.locator('#mapwrap').screenshot({ path: join(shotDir, `${name}.png`) });
}

async function runScenario(name, fn) {
  process.stdout.write(`\n[agenda-hit] ${name} ... `);
  await fn();
  console.log('ok');
}

/** 在页面里铺数据：三座村落 + 杂务 + 未归类，覆盖进行中 / 即将开始 / 只有全天 / 待结算 / 稍后。 */
async function seed(page) {
  await page.evaluate(() => {
    const { store, actions: A } = window.yuzhi;
    const live = A.createProject(store, '团队');
    const banner = A.createProject(store, '出行');
    const soon = A.createProject(store, '评审');
    for (let k = 0; k < 4; k++) A.createTask(store, { title: `团队任务 ${k + 1}`, projectId: live.id });
    A.createTask(store, { title: '评审任务', projectId: soon.id });
    const ev = (id, title, start, end, projectId, allDay = false) => ({
      id: `seed|${id}`, sourceId: 'seed', uid: id, title, allDay,
      start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      projectId, classified: projectId !== undefined,
    });
    const d = (hm, day = '04') => `2026-10-${day}T${hm}:00+08:00`;
    store.batch(() => {
      store.put('sources', { id: 'seed', name: '测试日历' });
      for (const e of [
        ev('live', '周会', d('14:00'), d('15:00'), live.id),
        ev('soon', '方案评审', d('14:40'), d('15:30'), soon.id),
        ev('trip', '出差', d('00:00'), d('00:00', '06'), banner.id, true),
        ev('chores-ended', '取快递', d('09:00'), d('09:30'), 'chores'),
        ev('chores-later', '买菜', d('17:00'), d('18:00'), 'chores'),
        ev('holiday', '国庆假期', d('00:00', '01'), d('00:00', '08'), undefined, true),
        ev('drift', '神秘会面', d('16:00'), d('17:00'), undefined),
      ]) store.put('events', e);
    });
    return { live: live.id, banner: banner.id, soon: soon.id };
  });
}

/** 画布坐标 → 页面坐标；同时给出渲染器自己判断的命中结果，便于对照。 */
async function points(page) {
  return page.evaluate(() => {
    const { renderer: r } = window.yuzhi;
    const rect = document.getElementById('map').getBoundingClientRect();
    const tw = r.view.tw;
    const scene = r.scene;
    const page = ([x, y]) => ({ x: rect.left + x, y: rect.top + y, local: { x, y } });
    const village = (name) => scene.villages.find((v) => v.name === name);
    const center = (v) => r.map.villages[v.slot].center;
    const out = {};
    for (const v of scene.villages) {
      const c = center(v);
      const [ax, ay] = r.villageAgendaAnchor(v);
      out[v.name] = {
        id: v.projectId,
        well: page(r.iso(c.i, c.j)),
        board: page([ax, ay]),
        banner: page([ax - tw * 0.17, ay - tw * 0.28]),
        label: v.agenda,
      };
    }
    const walkers = [...r.walkers.values()].filter((w) => w.slot === village('团队').slot).map((w) => {
      const [x, y] = r.iso(w.x, w.y);
      return { id: w.id, ...page([x, y - Math.max(5, tw * 0.2) * 0.7]) };
    });
    const [hx, hy] = r.iso(r.map.chores.i, r.map.chores.j);
    out.chores = { hut: page([hx + tw * 0.1, hy - tw * 0.1]), broom: page(r.choresAgendaAnchor()), view: scene.chores };
    out.walkers = walkers;
    const [lx, ly] = r.iso(r.map.lighthouse.i, r.map.lighthouse.j);
    const [bx, by] = r.lighthouseBannerAnchor();
    out.lighthouse = { banner: page([bx - tw * 0.16, by]), tower: page([lx, ly - tw * 1.2]), banners: scene.lighthouseBanners };
    out.bottles = scene.drifting.map((d, k) => {
      const at = r.driftBottleAnchor(k);
      return { title: d.title, onSea: r.onSea(at[0], at[1]), ...page(at) };
    });
    return out;
  });
}

async function hitAt(page, p) {
  return page.evaluate((pt) => window.yuzhi.renderer.hitAt(pt), p.local);
}

async function click(page, p) {
  await page.keyboard.press('Escape');
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
  return page.evaluate(() => ({
    view: window.yuzhi.tracker.view,
    info: document.getElementById('mapinfo').hidden ? null : document.getElementById('mapinfo').innerText,
  }));
}

const browser = await chromium.launch({ channel: channel || undefined, headless: true });

try {
  const context = await browser.newContext({ timezoneId: TZ, locale: 'zh-CN', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.clock.setFixedTime(at('14:30'));
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.yuzhi?.renderer && window.yuzhi?.store), undefined, { timeout });
  await page.waitForFunction(() => document.body.dataset.readOnly === 'false', undefined, { timeout });
  await seed(page);
  // 关掉导入后可能弹出的归类对话框，再等小人走到井边
  await page.keyboard.press('Escape');
  await page.waitForTimeout(4000);
  let p = await points(page);
  await shot(page, '1-1430-overview');

  await runScenario('进行中：点井边（村落中心）打开项目或聚在井边的小人，而不是日程说明', async () => {
    const r = await click(page, p['团队'].well);
    // 开会时小人聚在井边，点中小人（任务）同样正确；不能是日程说明卡
    const ok = (r.view.kind === 'project' && r.view.id === p['团队'].id) || r.view.kind === 'task';
    assert(ok && !r.info, `expected project or task view without info card, got ${JSON.stringify(r)}`);
  });

  await runScenario('进行中：聚在井边的小人都能点开任务', async () => {
    assert(p.walkers.length >= 2, `expected gathered walkers, got ${p.walkers.length}`);
    let ok = 0;
    for (const w of p.walkers) {
      const hit = await hitAt(page, w);
      if (hit?.kind === 'task') ok++;
    }
    // 小人可能互相挡住，但至少大多数要能点到任务，且不能有一个被判成日程
    const agendaHits = [];
    for (const w of p.walkers) {
      const hit = await hitAt(page, w);
      if (hit?.kind === 'agenda') agendaHits.push(w.id);
    }
    assert(agendaHits.length === 0, `walkers resolved to agenda: ${agendaHits.join(', ')}`);
    assert(ok >= Math.ceil(p.walkers.length / 2), `only ${ok}/${p.walkers.length} walkers hit as tasks`);
    const r = await click(page, p.walkers[0]);
    assert(r.view.kind === 'task', `real click on walker opened ${JSON.stringify(r.view)}`);
  });

  await runScenario('即将开始：点告示牌显示开始时间', async () => {
    const r = await click(page, p['评审'].board);
    assert(r.info?.includes('14:40 开始'), `soon info missing start time: ${JSON.stringify(r.info)}`);
    await shot(page, '2-soon-info');
  });

  await runScenario('只有全天条幅：没有告示牌、没有「稍后 1 场」，点条幅看全天说明，点中心开项目', async () => {
    const v = p['出行'];
    assert(v.label?.later === 0, `banner-only village counted later sessions: ${JSON.stringify(v.label)}`);
    const boardHit = await hitAt(page, v.board);
    assert(boardHit?.kind !== 'agenda', `invisible notice board still hit: ${JSON.stringify(boardHit)}`);
    const banner = await click(page, v.banner);
    assert(banner.info?.includes('今天全天：出差') && !banner.info.includes('稍后'), `banner info: ${JSON.stringify(banner.info)}`);
    await shot(page, '3-banner-info');
    const center = await click(page, v.well);
    assert(center.view.kind === 'project' && center.view.id === v.id, `banner village center opened ${JSON.stringify(center.view)}`);
  });

  await runScenario('灯塔条幅：看得见、点得到，点塔身仍然进档案馆', async () => {
    assert(p.lighthouse.banners.includes('国庆假期'), `lighthouse banners: ${JSON.stringify(p.lighthouse.banners)}`);
    const banner = await click(page, p.lighthouse.banner);
    assert(banner.info?.includes('国庆假期'), `lighthouse banner info: ${JSON.stringify(banner)}`);
    await shot(page, '3b-lighthouse-banner-info');
    const tower = await click(page, p.lighthouse.tower);
    assert(tower.view.kind === 'archive', `lighthouse tower opened ${JSON.stringify(tower)}`);
  });

  await runScenario('漂流瓶：在海面上、不被码头标签盖住，点开即捞起并打开归类', async () => {
    assert(p.bottles.length === 1 && p.bottles[0].title === '神秘会面', `bottles: ${JSON.stringify(p.bottles)}`);
    assert(p.bottles[0].onSea, `bottle is not on open water: ${JSON.stringify(p.bottles[0])}`);
    const hit = await hitAt(page, p.bottles[0]);
    assert(hit?.kind === 'drift', `bottle hit resolved to ${JSON.stringify(hit)}`);
    await page.keyboard.press('Escape');
    await page.mouse.click(p.bottles[0].x, p.bottles[0].y);
    await page.waitForFunction(() => !document.getElementById('mdl').hidden && document.getElementById('mdlBox').innerText.includes('神秘会面'), undefined, { timeout });
    await shot(page, '3c-drift-classify');
    await page.keyboard.press('Escape');
    const left = await page.evaluate(() => window.yuzhi.renderer.scene.drifting.length);
    assert(left === 0, `bottle still floating after pick: ${left}`);
  });

  await runScenario('杂务待结算 / 稍后：点小屋打开杂务追踪栏', async () => {
    assert(!p.chores.view.live && p.chores.view.ended === 1 && p.chores.view.later === 1, `unexpected chores state ${JSON.stringify(p.chores.view)}`);
    const r = await click(page, p.chores.hut);
    assert(r.view.kind === 'chores', `chores hut opened ${JSON.stringify(r)}`);
    const broom = await hitAt(page, p.chores.broom);
    assert(broom?.kind !== 'agenda', `undrawn broom still hit: ${JSON.stringify(broom)}`);
  });

  await runScenario('杂务进行中：点扫帚看说明，点小屋仍然打开杂务', async () => {
    await page.clock.setFixedTime(at('17:30'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(600);
    p = await points(page);
    assert(p.chores.view.live?.title === '买菜', `chores not live: ${JSON.stringify(p.chores.view)}`);
    const broom = await click(page, p.chores.broom);
    assert(broom.info?.includes('买菜'), `broom info: ${JSON.stringify(broom)}`);
    await shot(page, '4-1730-chores-live');
    const hut = await click(page, p.chores.hut);
    assert(hut.view.kind === 'chores', `chores hut opened ${JSON.stringify(hut)}`);
    await page.keyboard.press('Escape');
    await shot(page, '5-1730-overview');
  });

  await context.close();
} finally {
  await browser.close();
}
console.log('\n[agenda-hit] all scenarios passed');
