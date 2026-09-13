# 调研记录

- [仓库状态] -> 检查主 checkout 与 worktree -> 主 checkout 存在大量用户未提交改动；本任务从干净的 `main` (`c7943cd`) 创建独立 worktree，避免触碰或混入这些改动。
- [SSO 基线] -> fetch 并检查全部分支与提交图 -> `origin/main` 已包含通用 OIDC、StarDust 部署配置及论坛身份边界；本任务直接基于该最新主线继续。
- [历史验收信息] -> 检索本地记忆索引与近期 StarDust/OMEW 记录 -> 已确认此前只完成了 OIDC 用户名映射与论坛展示等修正；自动登录、禁用登出和已有 `sso-` 账户迁移仍需在当前源码与数据库结构中落实。
- [历史身份结构] -> 对比 `c7943cd` 前后的 OIDC 映射 -> 旧版为每个 OIDC 主体生成 `sso-` 加随机值的 `users.localpart`；新版新账号直接使用提供方用户名，并为 OIDC 身份增加独立 `username` 列。
- [关联完整性] -> 检查 D1 migration、Worker 路由、StrongholdDO 与 RoomDO -> `localpart` 是 D1 主键/外键基础，派生 actor 还散布在 D1 索引、媒体、私信及多个 DO SQLite 表；跨存储改主键无法形成单一原子事务。
- [迁移结论] -> 评估主键改名与显示别名 -> 保留旧 `localpart`/actor 作为稳定内部身份，在用户下一次 OIDC 登录时将有效 `preferred_username` 回填到 `oidc_identities.username`，并让所有用户展示从该列读取；这样不会断开任何外键、成员、帖子、私信或媒体关联。
- [专属实例边界] -> 检查 StarDust Wrangler 配置和嵌入访问门禁 -> `EMBED_ORIGIN` 已唯一标识仅允许嵌入访问的专属实例；与 `SSO_MODE=required` 组合即可推导自动登录及禁用登出，无需增加新的部署配置层。
- [Cloudflare 存储原则] -> 读取 Cloudflare 与 Durable Objects 技能并核对当前模型 -> D1 与各 DO 分属独立存储协调单元，支持采用稳定内部键和独立可见用户名的方案；本任务无需新增 DO RPC 或跨 DO 批量重写。
- [线上数据证据] -> 主任务只读盘点 `stardust-omew` D1 -> 当前仅 1 个历史 OIDC 账号，内部 `localpart` 仍为 `sso-…`，但 `oidc_identities.username` 已回填为 `mxjw`；统计为 `total_sso=1`、`missing_username=0`、`prefixed_username=0`。因此必须统一投影 alias，同时明确禁止修改实际内部主键。
- [类型检查首次失败] -> 在新 worktree 执行 `npm run typecheck` -> `npm ci` 后缺少 Wrangler 生成的 `server/worker-configuration.d.ts`，导致 Env、Workers runtime 类型批量缺失；运行仓库既有 `npm run types --workspace server` 后类型检查通过，不是实现缺陷。
- [依赖审计提示] -> `npm ci` -> npm 报告 4 个 high severity 漏洞；这是当前 lockfile 的既有依赖状态，本任务未执行会产生破坏性升级的 `npm audit fix --force`。
- [别名投影类型失败] -> 扩展 `AdminUserEntry` 后运行类型检查 -> mock 管理用户列表仍只返回内部 `localpart`；补充与真实 API 相同的 `username` 投影后恢复类型一致性。
