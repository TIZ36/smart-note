# Provider 策略（MVP）

更新时间：2026-04-08

## 目标

- 降低多 Provider 维护成本。
- 保持本地优先与 API 兜底并存。
- 为后续服务端化预留统一抽象。

## 结论

- 不建议手写多家 SDK 适配。
- 使用 `LiteLLM` 作为统一聊天/推理 Provider 网关。
- embedding 继续走本地 `sentence-transformers`。

## 架构

- 客户端：Tauri（只调用本地网关）
- 本地网关：Python FastAPI
  - `/chat` -> LiteLLM
  - `/embed` -> sentence-transformers
  - `/rerank` -> 本地模型或 API

## Provider 接入层分工

- LiteLLM 负责：
  - 多家模型统一 API
  - fallback、重试、超时
  - 基础 token 使用统计
- App 负责：
  - provider 配置管理（API Key、模型名、优先级）
  - 失败回退策略可视化
  - 成本与延迟展示

## 最小支持矩阵（MVP）

- OpenAI 兼容接口（默认）
- Anthropic（可选）
- Gemini（可选）
- 本地模型（Ollama，可选）

## 配置示例

```yaml
providers:
  primary:
    name: openai_compatible
    model: gpt-4o-mini
  fallback:
    - name: anthropic
      model: claude-3-5-haiku
  local_optional:
    name: ollama
    model: qwen2.5:7b
embedding:
  mode: local
  model: BAAI/bge-m3
```

## 演进路径

1. MVP：本地网关 + LiteLLM + 本地 embedding
2. Beta：加入配额、Provider 健康检查、按成本路由
3. 商业化：网关迁移到托管服务，客户端只保留配置和观测
