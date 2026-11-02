# 屿志美术素材

本目录保存 2026-10-04 确定的《屿志》视觉方向与生成素材。

后续的画面与素材优化按 [`docs/美术优化计划.md`](../美术优化计划.md) 分期推进；计划里的原则与本文的「使用原则」一致，有冲突时以计划中已定的决定为准。

## 视觉参考

- `art-direction-board.webp`：整体视觉方向板，定义等距小岛、四季、色彩、材质和氛围。
- `landmark-concepts.webp`：8 个永久地标概念：钟楼、藏书阁、观星台、玻璃温室、风车工坊、海港会馆、纪念塔、山亭。

## 画布调色板

Canvas 小岛上的所有颜色集中在 `src/island/render/palette.ts`：方向板的 10 个基础色（`BOARD`，取样值待人工校准），按材质和物件归组的当前用色，以及季节、积雪、衰败、透明度的派生函数。绘制代码里不再写颜色字面量，`tests/palette.test.ts` 会检查；地图景物的标记色 `MARKER` 仍在 `style.ts`，与图例、追踪栏共用。

改画面前后用截图矩阵对照。**每次截图都要先完成当前源码的构建**；`vite preview` 只读取已有 `dist`，不会自动重新编译。必须等预览服务器启动后再运行截图脚本，不能把 build 和 preview 一起放到后台。

**代码改动前**，在终端 A 依次执行（`npm run build` 完成以后才启动预览，预览保持在前台运行）：

```sh
npm run build
npx vite preview --host 127.0.0.1 --port 4173 --strictPort
```

看到预览服务就绪后，在终端 B 执行（`curl` 失败时不要截图）：

```sh
curl --fail --silent --show-error http://127.0.0.1:4173/ > /dev/null
SHOT_DIR=shots/before node browser-tests/island-shots.mjs
```

**完成源码 / 颜色修改后**，先在终端 A 用 Ctrl+C **停止旧预览**，用新源码重新构建并启动预览，再在终端 B 检查可用性、截图并比较：

```sh
# 终端 A：必须等待 build 完成，且预览服务重新启动
npm run build
npx vite preview --host 127.0.0.1 --port 4173 --strictPort
```

```sh
# 终端 B：确认当前构建的预览已经就绪
curl --fail --silent --show-error http://127.0.0.1:4173/ > /dev/null
SHOT_DIR=shots/after node browser-tests/island-shots.mjs
node browser-tests/shot-diff.mjs shots/before shots/after shots/diff
```

`SHOT_DIR` 应为专用截图目录。截图脚本会清理目录根层旧 PNG，因此 `SHOT_ONLY=...` 跑子集不会混入旧截图；其他文件、子目录不受影响。`shot-diff.mjs` 拒绝空截图集。差异图 `shots/diff` 也应使用专用目录：工具会写入 `.shot-diff-output.json` 记录自己生成的 PNG，下一次运行只清理清单中的旧差异图，不影响其他文件。若目录里已有**未被清单管理**的 PNG（包括旧版脚本留下的图片），工具会拒绝覆盖；请检查并手动归档，或改用空的差异图目录。

## 运行时环境道具

共 34 个道具，每个道具一张独立 WebP，位于 `src/assets/island/props/<id>.webp`；尺寸与落地锚点记录在 `src/island/prop-sprites.ts`。

- 图片经 Vite 打包，文件名带内容 hash，换图后不会命中旧缓存。
- 运行时按需加载：只有实际绘制过的道具才会被请求。
- 目前接入的位置（`src/island/render/props-layout.ts`）：码头的木箱、木桶、绳圈、渔网、叠放木箱和路牌；村落广场旁的市集摊位、灯柱、长椅、水缸、花盆；院落一侧的晾衣绳、菜畦、手推车、草垛等。摆放只由地块和项目 id 决定，冬季积雪时整批不摆。
- 锚点为内容底边中点，`IslandPropArt.draw(ctx, id, x, y, width)` 中的 `(x, y)` 即道具落地点。

### 原稿与切图流程

原稿保存在仓库根目录 `art/source/`（无损 WebP，不进入运行时包）：

- `props-harbor.webp`：港口 / 村落道具 18 个
- `props-nature.webp`：自然道具 16 个

修改或新增道具时，更新原稿与 `scripts/slice-props.py` 中的 id 列表，然后重新生成：

```sh
pip install pillow numpy scipy
python3 scripts/slice-props.py
```

脚本按 alpha 连通域找出每个物体，去掉抠图残留的低 alpha 光晕并把边缘 alpha 拉满，用实心像素颜色替换半透明边缘（去色边），裁切后留 2px 透明边，按原稿 0.75 倍统一缩放导出，并重新生成 `prop-sprites.ts`。不要手动修改生成结果。

## 使用原则

- 保持现有程序化海浪、天气、昼夜、积雪、人物和树木动画。
- 贴图用于增强视觉锚点和环境丰富度，不替换整个 Canvas 绘制体系。
- 港口 / 村落中较中性的木箱、木桶、绳索、码头件、标牌、长椅等可优先接入。
- 当前自然道具主要表现春夏状态；不要无条件用于冬季积雪场景，等待季节变体或统一季节化处理。
- 永久地标以概念板为造型参考，优先使用可程序化重绘的清晰轮廓，而不是直接把整栋概念图贴进场景。八种地标都已程序化实现（`src/island/render/paint/structures.ts`、`landmarks.ts`），按地标位 `index % 8` 轮换：0–2 号保持最早的钟楼、藏书阁、风车工坊，3–7 号依次是观星台、玻璃温室、海港会馆、纪念塔、山亭。

这些素材由 OpenAI 图像生成工具为本项目生成。
