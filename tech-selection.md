# 技术选型（v1）

目标：简单有效、Apple 风格、可快速迭代。

## 1) 客户端（macOS）

- 框架：Tauri + React + TypeScript
- 原因：
  - 体积小、启动快、系统能力强（全局快捷键/文件监听/剪贴板）。
  - 比 Electron 更轻，适合长期桌面常驻。

## 2) UI（苹果风格）

- 设计系统：Tailwind CSS + Apple HIG Token（自定义）
- 组件库：
  - 优先：`shadcn/ui`（做轻量定制）
  - macOS 风格补充：`lucide` 图标 + SF Pro / 系统字体栈
- 视觉原则：
  - 半透明卡片、层级阴影、柔和边框、弱对比背景
  - 动效短促（120-220ms），避免花哨过渡

## 3) 本地数据与索引

- 元数据存储：SQLite（通过 Prisma 或 Drizzle）
- 全文检索：SQLite FTS5
- 向量索引：
  - MVP（推荐）：sqlite-vec（应用内模式，最简单）
  - 后期扩展：Postgres + pgvector（团队化/服务化阶段）
  - 备选：Qdrant（更大规模检索）

### 检索架构（MVP）

- 采用多路径检索，不走单一 vector：
  - 关键词检索：SQLite FTS5
  - 语义检索：sqlite-vec
  - 记忆检索：历史高反馈问答（memory）
- 最终排序：`FTS 结果 + 向量结果 + Memory 命中` 融合重排。

### 准确性增强路线（后续阶段）

- 知识图谱（KG）作为第四路径接入：
  - 从 `note.md`、`knpath.md`、`answer_logs` 提取实体与关系。
  - 查询时增加实体识别与图谱邻域扩展，再回链到文本证据。
- 再训练策略：
  - 先做重排学习（基于 `+1`、反馈与点击信号）。
  - 再做小模型 reranker 微调。
  - 最后才评估是否需要生成模型微调。

### 本地知识库交付策略

- MVP：默认使用应用内 SQLite 方案，不引入 Docker 依赖，降低上手门槛。
- 对普通用户：若不具备本地模型环境，优先推荐 API Key 模式。
- 产品后续：提供托管服务端能力，并在团队阶段支持 Postgres + pgvector。

## 4) AI 与 Embedding

- 默认：本地 embedding（Python `sentence-transformers`）
  - 推荐模型：`BAAI/bge-m3` 或 `intfloat/multilingual-e5-base`
  - 运行方式：应用内启动本地 Python Worker（独立进程）
- 兜底：OpenAI 兼容 API（用户配置 API Key）
- 可选：Ollama 作为替代本地后端（非默认）
- LLM 路由：统一 Adapter 层（本地/云同接口）

### Provider 接入（降维护成本）

- 推荐：`LiteLLM` 作为统一 Provider 网关（Python Worker 内）
  - 一套接口对接多家模型服务，减少自维护 SDK 成本。
  - 支持路由、fallback、重试、统一日志与 token 统计。
- 前端流式输出：可选 `Vercel AI SDK`（仅 UI/流式层）
  - 职责边界：前端只处理流式展示，不直接耦合各家 Provider SDK。
- 本地 embedding：继续使用 `sentence-transformers`（不走 LiteLLM）。

#### 建议架构

- Tauri App -> 本地 Python Gateway（FastAPI）
- Gateway 固定暴露：`/chat`、`/embed`、`/rerank`
- `/chat`：LiteLLM 管理云端 Provider 与 fallback
- `/embed`：sentence-transformers（本地优先）
- `/rerank`：本地模型或 API 可切换

#### 为什么这样选

- 避免每个 Provider 各写一套适配器。
- 统一错误处理与观测，便于后续服务化。
- 不牺牲本地优先策略，embedding 仍可离线可用。

### 为什么默认 `sentence-transformers`

- 在 embedding 场景里更直接：模型生态成熟、可控性强。
- 对你当前需求更贴合：本地知识库构建、批量向量化、可精细调参。
- 与 Python 生态兼容好：后续做 rerank、离线评估、模型切换更顺畅。

## 5) 文件与同步

- 源文件：iCloud Drive 下的 `raw.txt|md|rtf`
- 派生文件：`note.md` + `.state.json` + `.index/`
- 策略：
  - 监听文件变化并做防抖
  - 增量 patch 更新 `note.md`
  - 维护 `knpath.md` 记录知识路径（主题 -> 证据 -> 可复用回答）

## 5.1) 行为数据与反馈闭环（MVP 必做）

- 查询与回答记录（SQLite）：
  - `query_logs`：查询文本、时间、上下文、检索参数
  - `answer_logs`：回答内容、证据引用、模型信息、耗时
  - `feedback_logs`：反馈类型（如 `+1`）、关联回答、时间
- 用途：
  - `+1` 作为高质量信号，提升后续同类问题排序权重。
  - 基于高频 query + 高反馈 answer 生成/更新 memory。
  - 与 `knpath.md` 联动，形成可解释的知识演进路径。

## 5.2) 准确性评估指标（建议）

- 检索层：Recall@K、MRR、证据命中率。
- 回答层：有证据回答占比、人工抽检准确率、反馈正向率（`+1`）。
- 迭代门槛：未达到基线前，不进入高成本再训练阶段。

## 6) MCP Studio 与 Skill Inspector

- MCP：内置注册表 + 单 MCP 测试面板 + 开关状态
- Skill Inspector：
  - 输入：文本 / 链接 / 安装指南
  - 输出：结构解析、依赖拓扑、调用建议

## 7) 工程与发布

- 包管理：pnpm
- 代码质量：ESLint + Prettier + Vitest
- 打包发布：Tauri Build + GitHub Actions

## 8) 结论（MVP 最小可行栈）

- `Tauri + React + Tailwind + SQLite(FTS5+sqlite-vec) + sentence-transformers + OpenAI兼容兜底`

## 9) 用户分层策略（必须执行）

- 开发者/技术用户：
  - 优先本地知识库（SQLite + sqlite-vec）。
  - 可启用本地 embedding + 本地检索全链路。
- 非技术用户：
  - 默认 API Key 模式。
  - 未来可一键切换到官方托管知识库服务。

这是当前最“简单有效”的组合：开发门槛低、性能稳定、Apple 风格易落地、后续扩展到 CLI/MCP/iOS 也顺畅。
