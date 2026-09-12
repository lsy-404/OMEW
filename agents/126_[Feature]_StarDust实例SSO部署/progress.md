# StarDust 实例 SSO 部署进度

- 2026-09-12：完成 Worker 版本、bindings、D1 migrations 与 custom domain 只读盘点。
- 2026-09-12：确认采用标准 confidential OIDC client、Authorization Code + PKCE、PAR 和 refresh/logout 会话闭环。
- 2026-09-12：完成两项 OIDC D1 migration 与首版生产部署；根据真实 502 探针补齐 Worker 公网 `fetch()` compatibility flag，并同步 Overture 产物。
- 2026-09-12：根据 Worker tail 精确定位到不受支持的 `redirect: "error"`；改为 manual 模式并继续拒绝所有非 2xx 响应，等待真实链路复验后决定是否保留 Service Binding。
- 2026-09-12：带 Service Binding 的授权起点、PAR 与登录回跳探针通过；移除验证用 binding，继续验证纯公开标准 OIDC 路径。
- 2026-09-12：纯公开 OIDC 启动、PAR、Provider 登录回跳再次通过；生产仅保留 `DEV_TOKEN_SECRET` 与 `SSO_CLIENT_SECRET`，旧专用桥接 secret 已删除。
- 2026-09-12：完整验证通过 75 个测试文件、487 项测试，并通过类型检查、Web 构建、通用与专属 Wrangler dry-run、Overture 包一致性检查。
- 2026-09-12：Edge 从 StarDust `/omew` 自动完成授权、回调与一次性 completion，OMEW 在 `/` 显示已登录统一身份和 `medium5`；刷新后会话继续有效，未出现本地登录表单。
