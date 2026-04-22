# SmartNote — 示例笔记

*这是一份示例笔记，帮你 30 秒内了解 SmartNote 能做什么。*
*看完后可以打开自己的笔记文件，或者直接在这份上继续编辑。*

## 决策记录

2026-04-15 与团队讨论，决定采用 **PostgreSQL + pgvector** 作为生产环境检索后端，理由：
- 混合检索（FTS + 向量）在单库内完成，运维简单
- 写入路径能利用事务保证一致性
- 成本优于 Pinecone / Weaviate

放弃的备选：Qdrant（独立部署复杂）、Elasticsearch + 单独向量库（双系统同步麻烦）。

## 常用命令

- 日常启动后端：`./scripts/restart-server.sh`
- 启动云端栈：`./cloud/scripts/quickstart.sh`
- 签发 API Key：`./cloud/scripts/issue_key.sh my-machine`

## Todo

- [ ] 补齐 cloud 端 wiki 同步（目前只返回空 list）
- [ ] 加 RLS policy 到 memories 表
- [ ] 写 30 个 case 的测试套件

## Credentials（示例 — 不要填真实值）

API_KEY_EXAMPLE=sn_live_<prefix>_<secret>

## 读书笔记：Designing Data-Intensive Applications

第 7 章讲的事务隔离级别，Snapshot Isolation 在并发读写混合场景下的收益最大，
但实现代价高。多数应用 Read Committed 就够了。

## 会议纪要 — 产品同步 2026-04-18

- 阿琳：用户反馈第一次打开 App 不知道该干啥，建议做引导
- 小林：同意，下周做个 5 分钟的 first-run 流
- 我：同步一下 Cloud Sync 那边的 bug，smart_table 行列更新没触发增量，已修
- 结论：本周重点是首次体验 + MCP 一键安装

---

*提示*：左下角 **Cloud Sync** 图标点开，可以把这份笔记推到云端，让你的 Cursor 和 Claude Code 直接读到。
