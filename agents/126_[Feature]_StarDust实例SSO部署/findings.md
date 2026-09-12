# StarDust 实例 SSO 部署调研

- `stardust-omew` 线上版本仍使用旧 `FIXED_STRONGHOLD` 与专用桥接 secret，标准 OIDC 路由返回 404。
- 当前主线已经用 `INSTANCE_MODE=single`、`ROOT_STRONGHOLD=medium5` 替代旧固定据点变量，并完整实现通用 OIDC Client。
- 生产 D1 尚未应用 `0022_oidc_sso.sql` 与 `0023_oidc_sessions.sql`。
- 线上缺少 `DEV_TOKEN_SECRET`；部署新版本前必须生成独立高熵值，旧会话将因此失效并统一重新认证。
- 专属实例保留公开只读浏览能力，但主站嵌入入口主动发起 OIDC；本地密码、注册与本地会话在 `required` 模式中均被拒绝。
- 首次线上探针发现 Worker 的默认全局 `fetch()` 会绕过同区域 Worker，自定义域上的 Provider 未被调用；OIDC Client 与 Overture 部署包必须启用 `global_fetch_strictly_public`，让 discovery、PAR、token、UserInfo 和 logout 均按公开 issuer 路由。
