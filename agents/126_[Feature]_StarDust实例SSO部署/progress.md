# StarDust 实例 SSO 部署进度

- 2026-09-12：完成 Worker 版本、bindings、D1 migrations 与 custom domain 只读盘点。
- 2026-09-12：确认采用标准 confidential OIDC client、Authorization Code + PKCE、PAR 和 refresh/logout 会话闭环。
- 2026-09-12：完成两项 OIDC D1 migration 与首版生产部署；根据真实 502 探针补齐 Worker 公网 `fetch()` compatibility flag，并同步 Overture 产物。
