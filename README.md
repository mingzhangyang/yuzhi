# 屿志 · 一座由你的日子长成的岛

个人效率平台：你的工作和生活会自动长成一座等距视角的小岛。你负责定规则和做选择，小岛负责记账、提醒和讲故事。

- 产品与 MVP 交接文档：[`docs/屿志MVP交接文档.md`](docs/屿志MVP交接文档.md)
- 现实生活培育区开放设计：[`docs/现实生活培育区设计.md`](docs/现实生活培育区设计.md)
- Architecture v2 完结记录：[`docs/ARCHITECTURE_V2_COMPLETION.md`](docs/ARCHITECTURE_V2_COMPLETION.md)
- 架构调整方案（已完成，维护参考）：[`docs/架构调整方案.md`](docs/架构调整方案.md)
- 参考源码（禾境）：[`reference/hejing.html`](reference/hejing.html)，原始压缩包 `reference/hejing-repo.zip`

## 运行

```bash
npm install
npm run dev        # 本地开发，http://localhost:5173（/api/ics 由 Vite 中间件提供）
npm test           # 规则层单元测试（vitest）
npm run build      # 类型检查 + 打包到 dist/
```

## 部署到 Cloudflare

生产环境只使用 **Cloudflare Workers + Static Assets**。Wrangler 会把 `dist/` 作为 SPA 静态资源，并让 `/api/*`、`/en` 与 `/en/*` 优先进入 `worker/index.ts`；其中英文路由由 Worker 在返回 HTML 前写入英文 SEO / social metadata，`.ics` 代理只转发、不保存，拒绝内网地址、限制 5MB、只放行日历内容。

目标生产域名是 `https://yuzhi.orangely.xyz`。仓库里的 `wrangler.toml` 已固定：

- Worker 名称：`yuzhi`
- Custom Domain：`yuzhi.orangely.xyz`
- `workers.dev`：关闭
- Version preview URLs：关闭
- SPA fallback：开启
- Worker-first 路由：`/api/*`、`/en`、`/en/*`（英文 HTML 由 Worker 预先本地化 metadata）

本地验证与手动部署：

```bash
npm run build
npm run check:worker     # Wrangler dry-run，验证 Worker bundle、静态资源和配置
npm run dev:worker       # 本地 Workers runtime
npm run deploy           # 手动生产发布
```

### Cloudflare Workers Builds（GitHub）

在 Cloudflare 控制台选择 **Workers & Pages → Create application → Import a repository**，连接 `mingzhangyang/yuzhi`。使用仓库根目录，配置：

- Production branch：`main`
- Build command：`npm run build`
- Deploy command：`npx wrangler deploy`
- Preview Builds：**关闭**

Cloudflare 的 Preview Builds 是项目级设置，不能由 `wrangler.toml` 代替；连接仓库时需要在 **Settings → Build → Branch control** 确认关闭。这样只有推送到 `main` 才会构建并发布。

## 目录

```
src/
  types.ts            数据模型（交接文档第 14 节，加了几处必要字段）
  db.ts               IndexedDB（idb）读写、JSON 备份导出/导入
  persistence-startup.ts 启动持久层所有权转移、失败清理与受控内存降级
  app-session.ts      启动/接管/恢复/bfcache/关闭的应用会话编排
  store.ts            内存数据 + 写穿持久层 + 变化通知 + 村落状态缓存
  actions.ts          公共 action 聚合出口（composition-only）
  actions/            项目/任务/结算/日历/落成领域实现与 shared helper
  single-writer.ts    多标签页写权限协调（Web Locks + BroadcastChannel）
  logic/              纯规则，不碰 DOM，都有测试
    config.ts         所有可调数值（阶段天数、推迟阈值、做了一部分的权重……）
    days.ts           每天的结算条目、未结算日子、3 天归档
    decay.ts          衰败与恢复（逐日重放）
    metrics.ts        四项指标
    chronicle.ts      编年史的一句话
    summary.ts        一生之书小结（落成仪式、档案馆）
    classify.ts       日历事件归类规则
  ics.ts              ical.js 解析：RRULE、例外、EXDATE、时区
  calendar.ts         订阅链接 / 上传文件 / 自动刷新
  island/             小岛：地形生成（map.ts）与 Canvas 绘制、交互（render.ts）
  ui/                 指标卡、追踪栏（含档案馆）、晚间结算、落成仪式、对话框
shared/icsProxy.ts    .ics 代理核心，Worker 与 Vite 开发服务器共用
worker/index.ts       Cloudflare Worker 入口（静态资源 + /api/ics）
tests/                单元测试
```

实体保留自身字段，`entries` / `operations` 保存结算与操作事实，`snapshots` / `chronicle` 保存历史采样与冻结叙述；一生之书、打断记录、阶段和有效任务状态由 read model 计算。旧版 `life` / `interruptions` 在历史保全、校验及业务事务提交成功后才删除。每个用户动作使用一个持久化 batch；多标签页只有 Web Locks 的 writer 接收新动作，已接受写入在释放锁前完成提交及通知，读者接管取得锁后，须刷新成功才开放新动作。

架构状态（2026-10-04）：**Architecture v2 已完成，项目进入维护 / 演进状态。** Phase 0–5 与 Batch A–D 均已完成并通过最终对照验收；本轮计划不再追加新的 Phase。正式完结记录见 [`docs/ARCHITECTURE_V2_COMPLETION.md`](docs/ARCHITECTURE_V2_COMPLETION.md)，长期架构不变量与历史实施细节见[架构调整方案第 10 节](docs/架构调整方案.md#10-阶段状态与实施记录)。后续若需要新的结构性调整，应新建独立 RFC / architecture plan，而不是继续延长本计划。

## 已完成（对应交接文档第 16 节开发顺序 1–9）

1. 项目骨架：禾境的等距地块、季节配色、小房子、小人、标签、明暗两套设计变量、指标卡走势小图都搬了过来；三座聚落换成最多 8 个村落槽位，加了码头与船、粮仓、山顶灯塔、杂务小屋。
2. 数据层：IndexedDB 存取，导出 / 导入 JSON 备份（「⋯」菜单）；日记与本地创建日程也进入同一备份。
3. 手动创建项目和任务；没选村落的任务乘船停在码头，可安排进村落、选日期或婉拒。
4. 晚间结算：右滑做了（砖块飞进村落）、左滑没做（四个原因可选）、轻点做了一部分、「全部做了」、「今天还做了别的事…」。桌面上同时有 ✓ ½ ✕ 按钮。
5. 衰败阶段（正常 / 安静 / 蒙灰 / 搬离）与画面变化：行人变少、屋顶蒙灰、杂草、木板封窗、居民背着包袱走向码头、夜里亮灯的窗户变少；进入搬离时询问重新启动 / 缩小规模 / 正式关闭。
6. 四项指标与编年史。
7. Cloudflare Worker + .ics 链接订阅与文件上传 + 归类规则（第一次手动指定，之后自动归位，杂务区放没有归属的事件）。
8. 海雾（未结算的日子）与超过 3 天自动归档为「未记录」。
9. 手机端：地图在上、指标两列、追踪栏变成从底部拉起的面板，结算为全屏面板、滑动优先。

**落成仪式（第二版的第一块）**：项目页的「完成项目 · 落成仪式」（村里的事都做完时会有提示）。小岛暂停，显示一生之书小结——立项日期、用时、完成的事、砖、推迟次数、主要卡点（没做的原因、一再推迟的事）、关键转折（第一块砖、阶段起伏、重新启动 / 缩小规模、最忙的一天）。然后由你选择：

- **立为地标**：村落腾空，合成一座永久建筑，立在海岸上（石台 + 主屋，规模大的多一座塔，插着村落颜色的旗）。每圈海岸能放 8、12、16… 座地标，放满就向外长出一圈新陆地，像年轮；原有的地形、村落和地标位置都不变（地块随机数按坐标哈希，见 `src/island/map.ts`）。
- **收进档案馆**：项目放进山顶的灯塔。点灯塔（或「⋯ → 档案馆」）可以看：海岸上的地标、按年份排的「落成之书」、正式关闭的「未竟之书」。
- 选择可以反悔：地标可以收进档案馆，档案里的项目可以重新立为地标；未竟之书里的项目可以重新立起成村落。
- 没做完的任务随项目完成一起放下，不算没做。

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

码头安排时的代价提示、AI「问项目近况」、Google / Outlook 授权同步、Apple CalDAV、账号和多设备同步。
