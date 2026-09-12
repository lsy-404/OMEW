# StarDust 实例 SSO 部署计划

- [x] 确认专属 Worker、custom domain、D1 与现有 secret
- [x] 核对通用 OIDC Client 和单据点运行契约
- [x] 将专属实例配置为 `required` 并登记生产 issuer/client
- [x] 生成独立会话密钥与 client secret，执行 OIDC migrations
- [x] 完整验证后部署 `stardust-omew`
- [x] 删除双方不再使用的旧专用桥接 secret
- [x] 验证 discovery、PAR、回调、自动登录与 `medium5` 根据点
- [x] 提交并合并主线
