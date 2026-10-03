# 屿志 · 一座由你的日子长成的岛

个人效率平台：你的工作和生活会自动长成一座等距视角的小岛。你负责定规则和做选择，小岛负责记账、提醒和讲故事。

- 产品与 MVP 交接文档：[`docs/屿志MVP交接文档.md`](docs/屿志MVP交接文档.md)
- 参考源码（禾境）：[`reference/hejing.html`](reference/hejing.html)，原始压缩包 `reference/hejing-repo.zip`

## 运行

```bash
npm install
npm run dev        # 本地开发，http://localhost:5173（/api/ics 由 Vite 中间件提供）
npm test           # 规则层单元测试（vitest）
npm run build      # 类型检查 + 打包到 dist/
```

## 部署到 Cloudflare

两种方式都可以，代码共用同一份 `.ics` 代理（`shared/icsProxy.ts`：只转发、不保存；拒绝内网地址、限制 5MB、只放行日历内容）。第一次部署前先 `npx wrangler login`。

### 方式一：Worker + 静态资源（推荐）

```bash
npm run deploy           # 构建后 wrangler deploy，发布到 https://yuzhi.<你的子域>.workers.dev
npm run preview:worker   # 本地预览（wrangler dev）
```

配置在 `wrangler.toml`：`dist/` 作为静态资源，`/api/ics` 由 `worker/index.ts` 处理。

### 方式二：Pages

```bash
npm run deploy:pages     # 构建后 wrangler pages deploy dist（第一次会创建 yuzhi 项目）
npm run preview:pages    # 本地预览（wrangler pages dev）
```

`/api/ics` 由 `functions/api/ics.ts`（Pages Function）提供。也可以在 Cloudflare 后台把 GitHub 仓库连到 Pages：构建命令 `npm run build`，输出目录 `dist`。

## 目录

```
src/
  types.ts            数据模型（交接文档第 14 节，加了几处必要字段）
  db.ts               IndexedDB（idb）读写、JSON 备份导出/导入
  store.ts            内存数据 + 写穿持久层 + 变化通知 + 村落状态缓存
  actions.ts          所有改动数据的操作：项目、任务、码头、结算、归档、关闭/重启/缩小、归类
  logic/              纯规则，不碰 DOM，都有测试
    config.ts         所有可调数值（阶段天数、推迟阈值、做了一部分的权重……）
    days.ts           每天的结算条目、未结算日子、3 天归档
    decay.ts          衰败与恢复（逐日重放）
    metrics.ts        四项指标
    chronicle.ts      编年史的一句话
    classify.ts       日历事件归类规则
  ics.ts              ical.js 解析：RRULE、例外、EXDATE、时区
  calendar.ts         订阅链接 / 上传文件 / 自动刷新
  island/             小岛：地形生成（map.ts）与 Canvas 绘制、交互（render.ts）
  ui/                 指标卡、追踪栏、晚间结算、对话框
shared/icsProxy.ts    .ics 代理核心，Worker、Pages Function 与 Vite 开发服务器共用
worker/index.ts       Cloudflare Worker 入口（静态资源 + /api/ics）
functions/api/ics.ts  Cloudflare Pages Function
tests/                单元测试
```

## 已完成（对应交接文档第 16 节开发顺序 1–9）

1. 项目骨架：禾境的等距地块、季节配色、小房子、小人、标签、明暗两套设计变量、指标卡走势小图都搬了过来；三座聚落换成最多 8 个村落槽位，加了码头与船、粮仓、山顶灯塔、杂务小屋。
2. 数据层：IndexedDB 存取，导出 / 导入 JSON 备份（「⋯」菜单）。
3. 手动创建项目和任务；没选村落的任务乘船停在码头，可安排进村落、选日期或婉拒。
4. 晚间结算：右滑做了（砖块飞进村落）、左滑没做（四个原因可选）、轻点做了一部分、「全部做了」、「今天还做了别的事…」。桌面上同时有 ✓ ½ ✕ 按钮。
5. 衰败阶段（正常 / 安静 / 蒙灰 / 搬离）与画面变化：行人变少、屋顶蒙灰、杂草、木板封窗、居民背着包袱走向码头、夜里亮灯的窗户变少；进入搬离时询问重新启动 / 缩小规模 / 正式关闭。
6. 四项指标与编年史。
7. Cloudflare Worker（Pages Function）+ .ics 链接订阅与文件上传 + 归类规则（第一次手动指定，之后自动归位，杂务区放没有归属的事件）。
8. 海雾（未结算的日子）与超过 3 天自动归档为「未记录」。
9. 手机端：地图在上、指标两列、追踪栏变成从底部拉起的面板，结算为全屏面板、滑动优先。

另外：黄昏 / 夜晚跟随现实时间（夜里窗户和灯塔会亮），季节跟随现实日期，一键「放几个示例村落」方便体验。

## 对「还没定的问题」先做的取舍（都在 `src/logic/config.ts` 里可调）

| 问题 | 先这样做 |
|---|---|
| 英文名 | 未定，代码里用 `yuzhi` |
| 「做了一部分」各算多少 | 推进度算半件（`PARTIAL_WEIGHT = 0.5`）；衰败里算一天真实推进；任务自动挪到第二天，不计推迟 |
| 没有日期的任务是否出现在结算列表 | 不自动出现。结算时可以用「今天还做了别的事…」拉进来，或在追踪栏点 ✓ 直接记下做完 |
| 一个村落最多几个小人走动 | 8 个（`MAX_WALKERS`），且按阶段只显示一部分；标签上显示总数「N人」 |

还有几处交接文档没写死、实现时做的决定：

- **衰败的算法**：从立项日起逐日重放。没有任何条目的日子时间照样流逝（荒置 +1）；有推进的日子回退一个阶段（回到上一阶段的起点，所以荒了一个月认真 3 天就恢复）；只有「没精力 / 不重要了」的日子不计；未结算和「未记录」的日子不产生后果（但单独记下的「做了」照样算推进）。今天只有结算过才计入。
- **「被打断」**：和普通没做一样计荒置一天，不额外加重；在码头留下打断记录，并统计最近打断多落在哪个村落。
- **「推到明天」**：任务挪到第二天、推迟次数 +1；同一任务累计 ≥ 3 次，村落额外加重一档。重新启动 / 缩小规模会清零推迟次数。
- **「没做」但没选原因 / 被打断 / 没精力**：任务留在原日期，变成「过期」，计入积压，可在码头一键排到今天。
- **缩小规模**：勾掉的任务被放下，村落回到「安静」阶段的起点。
- **正式关闭**：未完成的任务一并放下，项目进入「未竟之书」（「⋯」菜单可看，可重新立起）。
- **全天日历事件**：不进结算、不占粮仓时间（避免节假日、生日刷屏）。
- **村落长大**：每 3 块砖（确认做了的条目）多盖一间房，最多 10 间。
- **黄昏**：17:30 以后，或打开结算面板时；20:30 以后是夜里。

## 先不做（交接文档第 12 节）

落成仪式、地标、档案馆（灯塔先作为装饰）、码头安排时的代价提示、AI「问项目近况」、Google / Outlook 授权同步、Apple CalDAV、账号和多设备同步。
