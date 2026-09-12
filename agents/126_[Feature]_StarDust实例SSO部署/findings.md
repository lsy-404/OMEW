# StarDust 实例 SSO 部署调研

- `stardust-omew` 线上版本仍使用旧 `FIXED_STRONGHOLD` 与专用桥接 secret，标准 OIDC 路由返回 404。
- 当前主线已经用 `INSTANCE_MODE=single`、`ROOT_STRONGHOLD=medium5` 替代旧固定据点变量，并完整实现通用 OIDC Client。
- 生产 D1 尚未应用 `0022_oidc_sso.sql` 与 `0023_oidc_sessions.sql`。
- 线上缺少 `DEV_TOKEN_SECRET`；部署新版本前必须生成独立高熵值，旧会话将因此失效并统一重新认证。
- 专属实例保留公开只读浏览能力，但主站嵌入入口主动发起 OIDC；本地密码、注册与本地会话在 `required` 模式中均被拒绝。
- 首个线上探针显示 Provider 未收到出站请求；OIDC Client 与 Overture 部署包仍需 `global_fetch_strictly_public`，保证同区域 issuer 按公开入口路由。
- Worker tail 最终确认 502 的直接原因是 Workers 不实现 `redirect: "error"`，请求在出站前即抛出 `TypeError`；改用 `manual` 并沿用非 2xx 拒绝逻辑，可保持禁止上游重定向的安全边界。
- Service Binding 仅用于隔离验证修复，最终部署仍通过公开 issuer 通信，不让通用 OIDC Client 依赖特定 Provider Worker。
