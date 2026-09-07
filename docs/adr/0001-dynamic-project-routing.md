# ADR 0001: Route Shared Memory Credentials by Explicit Project Header

## Status

Accepted

## Context

`/memory/*` 使用共享鉴权 token 和显式的 `X-Project-Id` 作为请求入口。此前，
`ALLOWED_MEMORY_PROJECTS` 会对共享 token 再施加静态项目清单限制。运行时 middleware 为新仓库
生成项目 ID 后，必须修改 Worker 配置并重新部署，动态项目接入因此被阻断。

项目隔离本身不依赖这份清单：`X-Project-Id` 经过格式、长度和字符集校验，随后被用于 D1 的
`project_id` 过滤和 Vectorize namespace。迁移期的 `PROJECT_TOKENS_JSON` 与
`PERSONAL_MEMORY_TOKEN` 则仍然是绑定单一项目的旧凭据。

## Decision

1. 共享 `MEMORY_API_TOKEN`（未设置时兼容回退到 `API_TOKEN`）可以路由到任意通过
   `normalizeProjectId` 校验的项目 ID，不再读取 `ALLOWED_MEMORY_PROJECTS`。
2. 每个 memory 请求仍必须携带非空且合法的 `X-Project-Id`；服务端不从 token 推断项目，
   也不新增项目注册表或自动发现机制。
3. `PROJECT_TOKENS_JSON` 与 `PERSONAL_MEMORY_TOKEN` 继续要求请求头与其绑定项目完全一致。
   迁移期若保留 `ALLOWED_MEMORY_PROJECTS`，它只作为这些旧凭据的额外限制，并标记为 deprecated。
4. D1/Vectorize 的项目过滤和 namespace 隔离保持不变。

## Consequences

- 新仓库可以在不修改配置或重新部署 Worker 的情况下接入 memory API。
- 共享 token 成为所有合法项目 ID 的路由凭据，必须按全局 memory 权限管理；需要单项目限制时，
  应使用外部授权层或迁移期的项目绑定凭据。
- 旧配置不会立即失效，但 allowlist 不再是共享 token 的动态项目注册机制，后续可以在迁移完成后删除。
- 项目 ID 的格式边界、显式请求头校验和下游 project-scoped 查询继续作为数据隔离的安全边界。
