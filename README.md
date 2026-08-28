# cf-mem

一个部署在 Cloudflare Workers 上的 RAG 与持久记忆后端。

- 用 Workers AI 生成 embedding
- 用 D1 保存原文、证据和结构化 Claims
- 用 Vectorize 做相似度搜索
- 按项目 token 隔离数据

## 先看这里

| 你想做什么 | 从哪里开始 |
| --- | --- |
| 第一次部署 | [三分钟部署](#三分钟部署) |
| 查看完整配置 | [`docs/configuration.md`](docs/configuration.md) |
| 查看 Claims 设计 | [`docs/durable-memory-design.md`](docs/durable-memory-design.md) |
| 查看所有接口和进阶说明 | [`docs/complete-guide.md`](docs/complete-guide.md) |

## 三分钟部署

### 1. 安装并登录

需要一个 Cloudflare 账号，并在本机完成 Wrangler 登录：

```bash
npm install
npx wrangler login
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml` 已被 Git 忽略，只在本地保存部署配置。

### 2. 创建 Cloudflare 资源

以下资源名称需要和 `wrangler.toml` 保持一致。已经存在的资源不要重复创建。

```bash
npx wrangler d1 create cf-text
npx wrangler vectorize create cf-vector --dimensions 1024 --metric cosine
npx wrangler vectorize create cf-claims --dimensions 1024 --metric cosine
```

把创建 D1 时返回的 `database_id` 填入本地 `wrangler.toml`，然后创建 Claims 的过滤索引：

```bash
for property in status scope_kind scope_id type workspace_id; do
  npx wrangler vectorize create-metadata-index cf-claims \
    --property-name "$property" --type string
done
```

最后应用数据库迁移：

```bash
npx wrangler d1 migrations apply cf-text --remote
```

### 3. 配置鉴权

```bash
# 使用 embedding 或网页接口时需要
npx wrangler secret put API_TOKEN

# 使用项目级 /memory/* 时需要
npx wrangler secret put PROJECT_TOKENS_JSON
```

`PROJECT_TOKENS_JSON` 是项目 ID 到 token 的映射，例如：

```json
{"proj-a":"替换成项目A的随机token"}
```

不要把 token 写进 `wrangler.toml`，也不要提交到 Git。

### 4. 部署

```bash
npm run typecheck
npm run deploy
```

部署完成后，使用 Wrangler 输出的地址检查：

```bash
curl -sS -H "Authorization: Bearer $API_TOKEN" \
  https://<your-worker>/health
```

## 需要配置什么？

大多数部署只需要根据实际接口选择上面的 secret。其他功能按需开启：

| 功能 | 额外配置 |
| --- | --- |
| 原始记忆 `/memory/*` | `PROJECT_TOKENS_JSON` |
| 个人记忆自动提炼 | `PERSONAL_MEMORY_TOKEN`、`PERSONAL_MEMORY_OWNER_ID`、模型接口配置 |
| 网页搜索和抓取 | `TAVILY_API_TOKEN`、`TAVILY_BASE_URL` |
| 搜索精排 | `RERANK_DEFAULT_ENABLED`，或请求中的 `rerank.enabled` |
| 管理后台 | Cloudflare Access、`ADMIN_ALLOWED_EMAIL` |
| 语义去重 | 默认已启用；需要 `cf-claims` 及其 metadata index |

完整配置表、默认值和 secret 用法见
[`docs/configuration.md`](docs/configuration.md)。不要为了使用基础 embedding 接口预先配置
项目记忆、个人记忆、Tavily、精排或管理后台。

## 最小调用示例

### 生成 embedding

```bash
curl -sS \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  https://<your-worker>/v1/embeddings \
  -d '{"input":["你好，世界"]}'
```

### 写入原始记忆

```bash
curl -sS \
  -H "Authorization: Bearer $PROJECT_TOKEN" \
  -H "Content-Type: application/json" \
  https://<your-worker>/memory/index \
  -d '{"text":"用户喜欢简洁的回答。","metadata":{"session_id":"s1","kind":"note"}}'
```

### 搜索原始记忆

```bash
curl -sS \
  -H "Authorization: Bearer $PROJECT_TOKEN" \
  -H "Content-Type: application/json" \
  https://<your-worker>/memory/search \
  -d '{"query":"用户喜欢什么样的回答？","topK":5}'
```

### 写入持久记忆

```bash
curl -sS \
  -H "Authorization: Bearer $PROJECT_TOKEN" \
  -H "Content-Type: application/json" \
  https://<your-worker>/memory/claims \
  -d '{
    "operation": "create",
    "claim": {
      "scope_kind": "user",
      "scope_id": "user-123",
      "type": "preference",
      "subject": "response",
      "memory_key": "response.language",
      "value": "zh-CN",
      "canonical_text": "用户偏好使用中文回复。",
      "provenance": "user_explicit",
      "confidence": 0.98,
      "evidence_segment_ids": ["<已有segment-id>"]
    }
  }'
```

Claims 的 `create` 会先检查身份键，再在同一项目、scope、类型和 workspace 内做语义去重。
相似事实会 reinforce；可能是更新或冲突的内容不会被静默覆盖。完整规则见
[`docs/durable-memory-design.md`](docs/durable-memory-design.md)。

## 接口概览

| 路径 | 用途 |
| --- | --- |
| `GET /health` | 检查服务是否可达 |
| `POST /embed`、`POST /v1/embeddings` | 生成 embedding |
| `POST /memory/index` | 写入原始记忆 |
| `POST /memory/search` | 搜索原始记忆 |
| `POST /memory/claims` | 创建或变更持久记忆 |
| `GET /memory/claims` | 查看 Claims |
| `POST /memory/context` | 获取当前有效记忆上下文 |
| `POST /memory/profile/ingest` | 提交个人记忆提炼证据 |
| `POST /memory/extraction/ingest` | 提交已索引证据进行自动提炼 |
| `POST /web/extract` | 提取网页正文 |
| `POST /web/search`、`POST /web/crawl` | 转发 Tavily 请求 |
| `/admin` | Cloudflare Access 保护的管理后台 |

`POST /memory/context` 对空输入、斜杠命令和短确认词会跳过语义 embedding 与 Vectorize 查询，
但仍会返回按 scope 确定性匹配的 Claims。

所有接口的完整请求格式、限制和返回值见
[`docs/complete-guide.md`](docs/complete-guide.md)。

## 项目结构

```text
src/
  index.ts       # 路由和全局鉴权
  api/           # HTTP 接口
  ai/            # Workers AI 调用
  db/            # D1 数据访问
  vector/        # Vectorize 数据访问
  memory/        # 原始记忆和持久记忆逻辑
migrations/      # D1 迁移
docs/            # 配置、设计和完整参考
```

## 日常维护

```bash
npm run typecheck
npx wrangler d1 migrations list cf-text --remote
npx wrangler vectorize list-metadata-index cf-claims
npm run deploy
```

Worker 每五分钟执行一次 Cron，用于处理个人记忆提炼任务和清理过期原始记忆。
Nudge 会将没有角色标记的 `kind: "user"` 原始文本作为用户证据处理；混合角色文本仍只提取 `[user]` 内容。
Nudge 处理带前缀的 `session_id` 时按实际分隔符提取外部 Session ID，不依赖 `source_app` 的字符串长度。
显式 extraction ingest 和 profile ingest flush 在成功入队后也会标记相关 Segment，避免 Nudge 重复拾取。
当提炼端点连续失败触发断路器时，Cron 会暂停提炼；排队任务会延后到冷却结束，
不会因此增加 Job 或原始段落的失败计数。
语义去重灰区中的 LLM 裁决也使用同一个断路器，上游故障时会快速跳过裁决并保留未合并 Claim。
断路器状态暂时无法从 D1 读取时按关闭处理，优先保证请求继续执行；D1 恢复后才会继续记录断路状态。
生产环境建议使用自定义域名，并将 `workers_dev = false`，尤其是启用管理后台时。

## 升级

拉取新版本后先应用迁移，再部署：

```bash
npx wrangler d1 migrations apply cf-text --remote
npm run typecheck
npm run deploy
```

旧版本如果没有按项目 namespace 写入 Vectorize，需要按照
[`docs/complete-guide.md`](docs/complete-guide.md) 的升级说明重新索引。
