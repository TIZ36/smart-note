# SmartNote — UX 重新设计候选（2026-04-28）

3 个互斥方向。每个方向是**视角问题**，不是细节问题——选哪个决定了之后所有功能往哪个形状靠。

## 怎么选

```
                 适合"我要做的就是写"      适合"我有大量结构化内容"      适合"我想看 agent 在干什么"
                 ─────────────────────       ─────────────────────         ─────────────────────
                          C                            B                            A
                       Atelier                      Library                       Stream
                  笔记编辑器即首页               稳态左树+右内容             活动流为家
```

| 方向 | 一句话 | 心智模型 | 锚点用户 | 风险 |
|---|---|---|---|---|
| **A. Stream** | "你的知识库是活的、有心跳" | activity feed | 重度 agent 协作者 | 大量稳态内容会感觉混乱 |
| **B. Library** | "Cloud 不是地方，是状态" | 一棵统一的树 | broad knowledge worker | 不够独特 |
| **C. Atelier** | "工具围着你转，不是你围着工具转" | 笔记 = 桌面 | 严肃写作者 | 首次打开需要 splash |

## 文件

- [a-stream.html](./a-stream.html) — Stream 方向（静态）
- [b-library.html](./b-library.html) — Library 方向（静态）
- [c-atelier.html](./c-atelier.html) — Atelier 方向（静态）
- [**c-atelier-interactive.html**](./c-atelier-interactive.html) — **C 方向 + 5 个子状态 + 完整动效**

每个文件**单独打开**，没有外部依赖：
- Mac/Linux: `open docs/design-mocks/a-stream.html`
- 或者直接拖到浏览器

### Interactive 版能展示的子状态

C 的可交互原型覆盖以下子状态，通过**真实交互触发**（不是 demo 切换器）：

| 子状态 | 触发 | 动效 |
|---|---|---|
| Home | 默认 | 进入时整体 fade-in |
| ⌘K command palette | 顶端 chip / `⌘K` / 左 rail 搜索图标 | 180ms slide-down + opacity，实时过滤 results |
| Agent activity drawer | callout 里 "See activity" / 顶端 chip | 280ms slide-down 覆盖 canvas |
| Tag filter (dim non-matching lines) | 点 tag chip / 顶端 chip | 200ms opacity dim 非匹配段 |
| Memory expand | 点右侧 memory 卡片 | 200ms grid-template-rows 展开详情 + accept/edit/reject |
| Workspace sheet | 左 rail 底部盾牌图标 / 顶端 chip | 320ms slide-up from bottom |
| Inline callout dismiss | callout 里 "hide" | 220ms grid-template-rows + opacity 折叠 |

所有动效遵守：
- `cubic-bezier(0.22, 1, 0.36, 1)` ease-out-quart
- 只动 `transform` / `opacity` / `grid-template-rows`（不动 layout 属性）
- `prefers-reduced-motion: reduce` 全部禁用
- 底部进度条还有一个**持续运转的 ambient 动画**（每 1.2s 推进 6%），表达"agent 在工作"的存在感

### 试这些路径

打开 `c-atelier-interactive.html`，按顺序走：

1. 按 `⌘K`（或 `Ctrl+K`）→ 命令面板浮起，输入 "回传" 实时过滤，`Esc` 关闭
2. 点 inline callout 里 "See activity" → 整个 canvas 滑下一层活动 drawer
3. 点右侧 memory 卡片 → 详情就地展开，出现 accept/edit/reject
4. 点右侧 tag chip（技术方案，默认 active）→ 编辑器里非匹配段变灰
5. 点左下盾牌图标 → 工作区面板从底部 slide up，显示 devices / plan / provider
6. 点 callout 的 "hide" → 折叠；按 "Reset" chip 复原

## 设计 context（共用）

按 `.impeccable.md`：
- 主题：暖纸 light（#faf9f7 系），dark 是 OKLCH 冷蓝
- accent：单一蓝（`oklch(0.65 0.15 250)`），稀疏使用
- 字体：System UI stack，13px 基底，靠 weight + spacing 拉层级
- 间距：4 倍数（4/8/12/16/24/32）
- **绝不**：drop shadow / glassmorphism / gradient text / left-stripe accent
- 动效：reserved，150–220ms ease-out
- 反例：不像 Notion / Linear / Vercel

## 选定后

告诉我选哪个（或选哪个组合方向），我跑 `/impeccable craft` 把它建成可跑的原型，再迭代到产品。

## 现状对照（决定要扔的包袱）

1. Tabs 当"地方"（Notes/Wiki/Search/Cloud/Settings 5 孤岛）
2. Cloud 当远程目的地（去 Cloud tab 才看得到 sync 状态）
3. Memory 不可见（Drafts 子区没人主动去看）
4. Search 全屏 commit（必须 commit 才能搜）
5. Ingest 是对话框（点完合上 = 黑盒）
6. Devices / Subscription 埋深（月级别的事埋在三层 tab 下）
7. 没有"发生了什么"时间线（库在长但你不知道）

3 个方向都解决 1 (tab 孤岛) 和 6 (设置埋深)。**A 解决全部 7 个**，**B 解决 1/2/6/7**，**C 解决 1/2/4/5/6**。
