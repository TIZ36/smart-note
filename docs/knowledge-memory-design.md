# 知识库闭环设计（MVP）

更新时间：2026-04-08

## 目标

- 知识库不是只有向量索引。
- 建立“检索 -> 回答 -> 反馈 -> 记忆更新”的闭环。
- 支持 `knpath.md` 与 memory 机制，持续提升回答质量。

## 1) 三路检索

- FTS（关键词）：命中精确词、标题词、术语。
- Vector（语义）：处理近义表达、模糊描述。
- Memory（经验）：命中历史高质量问答模板。

后续扩展第四路：

- KG（知识图谱）：实体关系推理与跨文档一致性校验。

最终结果做融合重排：

- `score = w1 * fts_score + w2 * vec_score + w3 * memory_score + w4 * feedback_boost`

扩展后：

- `score = w1 * fts_score + w2 * vec_score + w3 * memory_score + w4 * kg_score + w5 * feedback_boost`

## 2) 关键文件

- `raw.txt|md|rtf`：原始输入（事实源）
- `note.md`：结构化沉淀
- `knpath.md`：知识路径（主题、证据、复用结论）
- `.state.json`：增量处理状态

补充视图文件（按需生成）：

- `views/todo.md`：待办维度视图
- `views/requirements.md`：需求列表维度视图
- `views/project-<slug>.md`：单项目经验视图

## 3) SQLite 表设计（MVP）

### query_logs

- id
- query_text
- created_at
- retrieval_mode（fts/vector/hybrid/memory）
- topk
- latency_ms

### answer_logs

- id
- query_id
- answer_text
- evidence_refs（JSON，chunk/file/line）
- model_name
- prompt_version
- latency_ms
- created_at

### feedback_logs

- id
- answer_id
- feedback_type（`plus_one`/`down`/`flag`）
- created_at

### memories

- id
- memory_key（主题或问题模板）
- memory_text
- source_answer_ids（JSON）
- quality_score
- used_count
- updated_at

### kg_entities（后续）

- id
- entity_name
- entity_type
- aliases（JSON）
- updated_at

### kg_relations（后续）

- id
- head_entity_id
- relation_type
- tail_entity_id
- confidence
- source_ref（JSON，指向原文证据）
- updated_at

## 4) `+1` 反馈机制

- `+1` 不只是 UI 按钮，要进入训练信号：
  - 即时：提高该回答对应证据在同主题下的重排权重。
  - 周期：将高频 `+1` 答案提炼进 `memories`。
  - 审计：可追溯到原始 query 与证据链。

## 5) `knpath.md` 结构建议

```md
# Knowledge Path

## 主题：xxx
- 来源证据：note.md#Lxx / raw片段ID
- 常见问题：...
- 推荐回答骨架：...
- 高反馈样例：answer_id=...
- 最后更新：YYYY-MM-DD
```

## 6) 运行流程

1. 用户提问，写入 `query_logs`
2. 三路检索并融合重排（后续可加入 KG 路径）
3. 生成回答并记录 `answer_logs`
4. 用户点击 `+1`，写入 `feedback_logs`
5. 后台任务周期更新 `memories` 与 `knpath.md`

### raw -> note 维度整理流程（新增）

1. 抽取新增 raw 片段
2. 做维度分类（默认：`todo`、`requirement`、`project_experience`、`other`）
3. 写入 `note.md` 对应章节并附来源引用
4. 同步更新维度视图文件（`views/*.md`）
5. 若命中“独立视图主题”，写入对应专属视图

### 维度分类建议

- todo：包含“待办/todo/截止时间/跟进”等任务语义
- requirement：包含“需求/方案/验收/上线”等交付语义
- project_experience：包含“项目名 + 复盘/踩坑/经验/最佳实践”等经验语义
- other：无法确定类别时兜底

后续增强：

6. 周期抽取实体关系，更新 `kg_entities/kg_relations`
7. 对高频问题进行重排学习或 reranker 微调

## 7) MVP 验收

- 任意回答可回溯到 query、证据、模型。
- `+1` 后，同类 query 的排序有可观测提升。
- `knpath.md` 可自动新增/更新主题条目。
- memory 参与重排，不依赖人工手工维护。
- `raw` 混合输入可自动生成至少 3 个维度视图（todo/需求/项目经验）。
- 支持将指定主题设置为独立视图并持续增量维护。

## 8) 准确性增强验收（后续阶段）

- KG 参与后，关系型问题的人工抽检准确率较基线提升。
- 回答中可展示至少一条“关系路径 + 文本证据”链路。
- rerank 学习上线后，正向反馈率（`+1`）持续提升。
