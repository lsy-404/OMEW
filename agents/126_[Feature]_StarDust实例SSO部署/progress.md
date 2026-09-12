# StarDust 实例 SSO 部署进度

- 2026-09-12：完成 Worker 版本、bindings、D1 migrations 与 custom domain 只读盘点。
- 2026-09-12：确认采用标准 confidential OIDC client、Authorization Code + PKCE、PAR 和 refresh/logout 会话闭环。
- 2026-09-12：完成两项 OIDC D1 migration 与首版生产部署；根据真实 502 探针补齐 Worker 公网 `fetch()` compatibility flag，并同步 Overture 产物。
- 2026-09-12：根据 Worker tail 精确定位到不受支持的 `redirect: "error"`；改为 manual 模式并继续拒绝所有非 2xx 响应，等待真实链路复验后决定是否保留 Service Binding。
- 2026-09-12：带 Service Binding 的授权起点、PAR 与登录回跳探针通过；移除验证用 binding，继续验证纯公开标准 OIDC 路径。
