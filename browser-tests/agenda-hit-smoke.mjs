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
    const endedOnly = A.createProject(store, '结算');
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
        ev('live-ended', '站会', d('09:00'), d('09:30'), live.id),
        ev('live-next', '下一场讨论', d('14:40'), d('15:20'), live.id),
        ev('live-later', '回顾', d('17:00'), d('18:00'), live.id),
        ev('trip2', '团建', d('00:00'), d('00:00', '05'), banner.id, true),
        ev('long-holiday', '跨洲项目季度集中协调与复盘日', d('00:00'), d('00:00', '05'), 'chores', true),
        ev('birthday', '生日', d('00:00'), d('00:00', '05'), 'chores', true),
        ev('soon', '方案评审', d('14:40'), d('15:30'), soon.id),
        ev('ended-only', '晨间复盘', d('09:00'), d('09:30'), endedOnly.id),
        ev('trip', '出差', d('00:00'), d('00:00', '06'), banner.id, true),
        ev('chores-ended', '取快递', d('09:00'), d('09:30'), 'chores'),
        ev('chores-later', '买菜', d('17:00'), d('18:00'), 'chores'),
        ev('chores-next', '倒垃圾', d('17:40'), d('18:10'), 'chores'),
        ev('holiday', '国庆假期', d('00:00', '01'), d('00:00', '08'), undefined, true),
        ev('drift', '神秘会面', d('16:00'), d('17:00'), undefined),
        ev('drift2', '匿名讨论', d('16:10'), d('17:10'), undefined),
        ev('drift3', '未知访谈', d('16:20'), d('17:20'), undefined),
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
        banner: page((([b]) => b ? [b.x, b.y] : [ax, ay - tw * 0.28])(r.villageBannerLayout(v))),
        banner2: page((([, b]) => b ? [b.x, b.y] : [ax, ay - tw * 0.28])(r.villageBannerLayout(v))),
        labelPoint: page(r.villageLabelAnchor(v)),
        label: v.agenda,
      };
    }
    const walkers = [...r.walkers.values()].filter((w) => w.slot === village('团队').slot).map((w) => {
      const [x, y] = r.iso(w.x, w.y);
      return { id: w.id, ...page([x, y - Math.max(4, tw * 0.15) * 0.7]) };
    });
    const [hx, hy] = r.iso(r.map.chores.i, r.map.chores.j);
    const broom = r.choresAgendaAnchor();
    out.chores = {
      hut: page([hx + tw * 0.1, hy - tw * 0.1]),
      broom: page(broom),
      broomTip: page([broom[0] + tw * 0.1, broom[1] - tw * 0.38]),
      view: scene.chores,
      labelText: r.choresLabelText(scene.chores),
    };
    out.walkers = walkers;
    const [lx, ly] = r.iso(r.map.lighthouse.i, r.map.lighthouse.j);
    const [bx, by] = r.lighthouseBannerAnchor();
    const firstBanner = scene.lighthouseBanners[0] ?? '';
    out.lighthouse = {
      banner: page([bx, by]),
      bannerEdge: page([bx + r.bannerWidth(firstBanner) * 0.44, by]),
      tower: page([lx, ly - tw * 1.2]),
      banners: scene.lighthouseBanners,
    };
    out.bottles = scene.drifting.map((d, k) => {
      const at = r.driftBottleAnchor(k);
      return { title: d.title, onSea: r.onSea(at[0], at[1]), ...page(at) };
    });
    out.pier = Array.from({ length: r.map.pierLen + 1 }, (_, k) => {
      const [di, dj] = r.map.pierDir;
      return page(r.iso(r.map.dock.i + di * (k + 0.2), r.map.dock.j + dj * (k + 0.2)));
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

/**
 * 告示牌的说明文字。小人会走动，可能正好挡在牌子前（小人优先是预期行为）：
 * 没挡住时真实点击并读信息卡，挡住时直接取渲染器给这一点的说明。
 */
async function boardInfo(page, p) {
  const hit = await hitAt(page, p);
  if (hit?.kind === 'agenda') return (await click(page, p)).info;
  return page.evaluate((pt) => {
    const info = window.yuzhi.renderer.inspect(pt)?.info;
    return info ? [info.title, ...info.lines].join('\n') : null;
  }, p.local);
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

  await runScenario('离村小人经过栈桥：前景任务命中优先于码头', async () => {
    const probe = await page.evaluate(() => {
      const r = window.yuzhi.renderer;
      const walker = [...r.walkers.values()].find((w) => w.slot === r.scene.villages.find((v) => v.name === '团队').slot);
      if (!walker) return null;
      const [di, dj] = r.map.pierDir;
      const local = r.iso(r.map.dock.i + di * 0.2, r.map.dock.j + dj * 0.2);
      const s0 = Math.max(5, r.view.tw * 0.2);
      const world = r.tileCoords({ x: local[0], y: local[1] + s0 * 0.7 });
      const original = { x: walker.x, y: walker.y, tx: walker.tx, ty: walker.ty, leaving: walker.leaving };
      walker.x = world.fi;
      walker.y = world.fj;
      walker.tx = world.fi;
      walker.ty = world.fj;
      walker.leaving = true;
      const hit = r.hitAt({ x: local[0], y: local[1] });
      Object.assign(walker, original);
      return { hit, dock: r.dockHitAt({ x: local[0], y: local[1] }), taskId: walker.id };
    });
    assert(probe?.dock, `departing walker probe did not overlap the pier: ${JSON.stringify(probe)}`);
    assert(probe.hit?.kind === 'task' && probe.hit.id === probe.taskId,
      `departing walker was intercepted by dock: ${JSON.stringify(probe)}`);
  });

  await runScenario('只有待结算日程：村名标签可点击，键盘也能浏览到说明', async () => {
    const v = p['结算'];
    assert(v.label?.phase === 'ended' && v.label.ended === 1, `ended-only agenda: ${JSON.stringify(v.label)}`);
    const hit = await hitAt(page, v.labelPoint);
    assert(hit?.kind === 'agenda' && hit.target === v.id, `ended-only label hit: ${JSON.stringify(hit)}`);
    const clicked = await click(page, v.labelPoint);
    assert(clicked.info, 'ended-only label did not open agenda info');
    const keyboardReachable = await page.evaluate(() => {
      const r = window.yuzhi.renderer;
      for (let i = 0; i < 200; i++) {
        const item = r.browseScenery(1);
        if (item && JSON.stringify(item.info).includes('结算')) return true;
      }
      return false;
    });
    assert(keyboardReachable, 'ended-only agenda was missing from keyboard scenery browsing');
  });

  await runScenario('稍后和待结算同时存在：标签和说明两样都写', async () => {
    const v = p['团队'];
    assert(v.label?.later === 1 && v.label?.ended === 1, `团队 agenda: ${JSON.stringify(v.label)}`);
    const label = await page.evaluate(() => window.yuzhi.renderer.scene.villages.find((x) => x.name === '团队').agenda);
    assert(label.phase === 'live', `expected live phase, got ${label.phase}`);
    const lines = await boardInfo(page, v.board);
    assert(lines?.includes('下一场讨论') && lines.includes('14:40 开始'),
      `live project hid overlapping soon details: ${JSON.stringify(lines)}`);
    assert(lines?.includes('稍后还有 1 场') && lines.includes('1 场已经结束'), `团队 board info: ${JSON.stringify(lines)}`);
  });

  await runScenario('即将开始：点告示牌显示开始时间', async () => {
    const info = await boardInfo(page, p['评审'].board);
    assert(info?.includes('14:40 开始'), `soon info missing start time: ${JSON.stringify(info)}`);
    await click(page, p['评审'].board);
    await shot(page, '2-soon-info');
  });

  await runScenario('只有全天条幅：没有告示牌、没有「稍后 1 场」，点条幅看全天说明，点中心开项目', async () => {
    const v = p['出行'];
    assert(v.label?.later === 0, `banner-only village counted later sessions: ${JSON.stringify(v.label)}`);
    const boardHit = await hitAt(page, v.board);
    assert(boardHit?.kind !== 'agenda', `invisible notice board still hit: ${JSON.stringify(boardHit)}`);
    assert(v.label?.phase === 'allday', `banner-only village phase: ${JSON.stringify(v.label)}`);
    const banner = await click(page, v.banner);
    assert(banner.info?.includes('今天全天：') && banner.info.includes('出差') && banner.info.includes('团建') && !banner.info.includes('稍后'), `banner info: ${JSON.stringify(banner.info)}`);
    const upper = await hitAt(page, v.banner2);
    assert(upper?.kind === 'agenda', `second stacked banner not hittable: ${JSON.stringify(upper)}`);
    await shot(page, '3-banner-info');
    const center = await click(page, v.well);
    assert(center.view.kind === 'project' && center.view.id === v.id, `banner village center opened ${JSON.stringify(center.view)}`);
  });

  await runScenario('灯塔条幅：真实宽度都可点击，高缩放也不漏边缘，塔身仍进档案馆', async () => {
    assert(p.lighthouse.banners.includes('国庆假期'), `lighthouse banners: ${JSON.stringify(p.lighthouse.banners)}`);
    assert(p.lighthouse.banners.includes('跨洲项目季度集中协调与复盘日'), `long lighthouse banner missing: ${JSON.stringify(p.lighthouse.banners)}`);
    const banner = await click(page, p.lighthouse.banner);
    assert(banner.info?.includes('跨洲项目季度集中协调与复盘日'), `lighthouse banner info: ${JSON.stringify(banner)}`);
    await page.evaluate(() => window.yuzhi.renderer.zoomBy(2));
    await page.waitForTimeout(250);
    p = await points(page);
    const edge = await hitAt(page, p.lighthouse.bannerEdge);
    assert(edge?.kind === 'agenda' && edge.target === '__lighthouse__', `zoomed lighthouse banner edge missed: ${JSON.stringify(edge)}`);
    await page.evaluate(() => window.yuzhi.renderer.resetView());
    await page.waitForTimeout(250);
    p = await points(page);
    await shot(page, '3b-lighthouse-banner-info');
    const tower = await click(page, p.lighthouse.tower);
    assert(tower.view.kind === 'archive', `lighthouse tower opened ${JSON.stringify(tower)}`);
  });

  await runScenario('窄屏多个漂流瓶：点击每个瓶心都选中最近的那一只', async () => {
    await page.setViewportSize({ width: 320, height: 760 });
    await page.waitForTimeout(350);
    p = await points(page);
    assert(p.bottles.length === 3, `expected three narrow-screen bottles: ${JSON.stringify(p.bottles)}`);
    for (const bottle of p.bottles) {
      const hit = await hitAt(page, bottle);
      assert(hit?.kind === 'drift' && hit.title === bottle.title,
        `tap on ${bottle.title} selected ${JSON.stringify(hit)} from ${JSON.stringify(p.bottles)}`);
    }
    for (const plank of p.pier) {
      const hit = await hitAt(page, plank);
      assert(hit?.kind === 'dock', `visible narrow pier was intercepted by ${JSON.stringify(hit)}`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(350);
    p = await points(page);
  });

  await runScenario('漂流瓶：在海面上、不被码头标签盖住，点开即捞起并只移除被点中的组', async () => {
    assert(p.bottles.length === 3 && p.bottles[0].title === '神秘会面', `bottles: ${JSON.stringify(p.bottles)}`);
    assert(p.bottles.every((b) => b.onSea), `some bottles are not on open water: ${JSON.stringify(p.bottles)}`);
    const hit = await hitAt(page, p.bottles[0]);
    assert(hit?.kind === 'drift' && hit.title === '神秘会面', `bottle hit resolved to ${JSON.stringify(hit)}`);
    await page.keyboard.press('Escape');
    await page.mouse.click(p.bottles[0].x, p.bottles[0].y);
    await page.waitForFunction(() => !document.getElementById('mdl').hidden && document.getElementById('mdlBox').innerText.includes('神秘会面'), undefined, { timeout });
    await shot(page, '3c-drift-classify');
    await page.keyboard.press('Escape');
    const left = await page.evaluate(() => window.yuzhi.renderer.scene.drifting.map((item) => item.title));
    assert(left.length === 2 && !left.includes('神秘会面'),
      `picked bottle did not remove exactly its own group: ${JSON.stringify(left)}`);
  });

  await runScenario('键盘浏览漂流瓶：Enter 可捞起并打开归类，卡片提供可聚焦动作', async () => {
    const before = await page.evaluate(() => window.yuzhi.renderer.scene.drifting.length);
    await page.locator('#map').focus();
    let found = false;
    for (let i = 0; i < 240; i++) {
      await page.keyboard.press('ArrowRight');
      found = await page.locator('#mapinfo .mi-action').isVisible().catch(() => false);
      if (found) break;
    }
    assert(found, 'keyboard browsing never exposed the bottle action');
    const action = page.locator('#mapinfo .mi-action');
    assert(await action.isEnabled(), 'writer bottle action was disabled');
    const tabIndex = await action.evaluate((button) => button.tabIndex);
    assert(tabIndex >= 0, `bottle action was not focusable: tabIndex=${tabIndex}`);

    // Focus remains on the canvas, so Enter exercises the canvas activation path.
    await page.locator('#map').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => !document.getElementById('mdl').hidden && document.getElementById('mdlBox').innerText.includes('属于哪里'),
      undefined,
      { timeout },
    );
    await page.keyboard.press('Escape');
    const after = await page.evaluate(() => window.yuzhi.renderer.scene.drifting.length);
    assert(after === before - 1, `keyboard pickup did not remove exactly one bottle: ${before} -> ${after}`);
  });

  await runScenario('杂务待结算 / 稍后：点小屋打开杂务追踪栏', async () => {
    assert(!p.chores.view.live && p.chores.view.ended === 1 && p.chores.view.later === 2, `unexpected chores state ${JSON.stringify(p.chores.view)}`);
    const r = await click(page, p.chores.hut);
    assert(r.view.kind === 'chores', `chores hut opened ${JSON.stringify(r)}`);
    const broom = await hitAt(page, p.chores.broom);
    assert(broom?.kind !== 'agenda', `undrawn broom still hit: ${JSON.stringify(broom)}`);
  });

  await runScenario('杂务即将开始：扫帚靠在门口，点扫帚显示开始时间', async () => {
    await page.clock.setFixedTime(at('16:50'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(600);
    p = await points(page);
    assert(p.chores.view.soon?.title === '买菜', `chores not soon: ${JSON.stringify(p.chores.view)}`);
    assert(p.chores.labelText.includes('杂务 0') && p.chores.labelText.includes('买菜 将开始') && p.chores.labelText.includes('稍后 1') && p.chores.labelText.includes('待结算 1'),
      `soon chores label hid count or concurrent totals: ${p.chores.labelText}`);
    const broom = await click(page, p.chores.broom);
    assert(broom.info?.includes('17:00 开始'), `soon broom info: ${JSON.stringify(broom)}`);
    await shot(page, '4a-1650-chores-soon');
  });

  await runScenario('窄屏：扫帚命中跟随真实形状，不覆盖杂务小屋', async () => {
    await page.setViewportSize({ width: 320, height: 760 });
    await page.waitForTimeout(350);
    p = await points(page);
    const hutHit = await hitAt(page, p.chores.hut);
    assert(hutHit?.kind === 'chores', `narrow chores hut hit: ${JSON.stringify(hutHit)}`);
    const tipHit = await hitAt(page, p.chores.broomTip);
    assert(tipHit?.kind === 'agenda' && tipHit.target === 'chores', `narrow broom tip hit: ${JSON.stringify(tipHit)}`);
    const hut = await click(page, p.chores.hut);
    assert(hut.view.kind === 'chores' && !hut.info, `narrow chores hut opened ${JSON.stringify(hut)}`);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(350);
    p = await points(page);
  });

  await runScenario('杂务进行中：点扫帚看说明，点小屋仍然打开杂务', async () => {
    await page.clock.setFixedTime(at('17:30'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(600);
    p = await points(page);
    assert(p.chores.view.live?.title === '买菜' && p.chores.view.soon?.title === '倒垃圾',
      `chores did not preserve live + soon: ${JSON.stringify(p.chores.view)}`);
    assert(p.chores.labelText.includes('杂务 0') && p.chores.labelText.includes('买菜 至') && p.chores.labelText.includes('倒垃圾 将开始') && p.chores.labelText.includes('待结算 1'),
      `live chores label hid concurrent details: ${p.chores.labelText}`);
    const broom = await click(page, p.chores.broom);
    assert(broom.info?.includes('买菜') && broom.info.includes('倒垃圾') && broom.info.includes('17:40 开始'),
      `broom info hid concurrent soon event: ${JSON.stringify(broom)}`);
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
