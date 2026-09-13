# OpenMew (OMEW)

开源、可自部署的兴趣社群平台：以「据点」组织实时聊天频道与帖子分区。Cloudflare Workers 全栈，单人可运维；多实例联邦协议已经冻结，运行时仍在后续版本中实现。

Open-source, self-hostable community platform built around strongholds, realtime chat channels, and post sections. It runs entirely on Cloudflare Workers; the federation protocol is specified while the cross-instance runtime remains planned work.

## OMEW 1.0.0

首个正式版本已经完成单实例社区闭环：公开首页与据点目录、账号与通行密钥、实时聊天、Markdown 帖子、图片与表情、成员资料、私信、权限组、封禁和临时功能限制。

推荐通过 [Overture 在线部署器](https://overture.lsy-demo.workers.dev/?src=lsy-404%2FOMEW) 安装。链接已经预选 `lsy-404/OMEW`，无需本地工具链；安装器会列出将创建的 Worker、D1、R2、Durable Objects 与所需权限，再把 OMEW 部署到你自己的 Cloudflare 账户。

为了让服务器领主可以在 OMEW 内更新实例政策，Overture 会要求一个由部署者创建的长期 Cloudflare Account API Token，并作为 Worker Secret 保存。该令牌需要账户级 Workers Scripts 写权限，也能影响同账户中的其他 Worker，因此推荐为 OMEW 使用专用 Cloudflare 账户。

### 登录与运行模式

OMEW 使用标准 OIDC Authorization Code + PKCE 接入统一登录。Worker 环境变量 `SSO_MODE` 可设为 `disabled`（关闭，默认）、`optional`（允许 SSO 与本地登录）或 `required`（仅允许 SSO）；启用时还需配置 `SSO_ISSUER`、`SSO_CLIENT_ID`，并把 `SSO_CLIENT_SECRET` 作为 Worker Secret 写入。OMEW 通过 Issuer 的 discovery 文档发现授权端点和签名密钥，不绑定任何特定站点。

客户端会协商并支持 Refresh Token 轮换、RP-Initiated Logout、PAR、JAR/JARM、DPoP；其中 PAR 在提供方声明后默认启用，JARM 与 DPoP 通过 `SSO_USE_JARM=1` / `SSO_USE_DPOP=1` 开启，JAR 还需要把 `SSO_JAR_PRIVATE_JWK` 的对应公钥登记到提供方。Device Authorization、CIBA、SAML 2.0 和 SCIM 2.0 的 provider/供应职责由共享协议提供方承担，OMEW 不把这些管理协议伪装成浏览器登录功能。

若只运行一个据点，可将 `INSTANCE_MODE=single` 与 `ROOT_STRONGHOLD=<据点短名>` 一起设置。该模式会把指定据点作为 `/` 的主内容，隐藏首页和据点导航栏，并拒绝其他据点的访问、创建、删除与转让；`INSTANCE_MODE=multi` 保留普通多据点首页。

个人设置可用区块由 `PERSONAL_SETTINGS_SECTIONS` 的 CSV allowlist 定义，可选值为 `profile`、`security`、`appearance`；未配置时全部启用，显式空值会隐藏个人设置入口。`USE_BUILTIN_EMOTES` 与 `USE_ART_ASSETS` 相互独立，因此可保留内置表情包并关闭默认头像、背景和空状态插画。

## 文档 / Docs

- [项目书 v0.2](docs/proposal-v0.2.md) —— 设计文档(架构、数据模型、联邦、成本)
- [M0 协议规范草案](docs/m0-protocol-draft.md) —— 事件信封、签名、联邦会话、迁移协议

## 状态 / Status

1.0.0 单实例核心可用；M0 联邦协议草案完成，跨实例联邦、归档搜索与语音仍属于后续里程碑。

## License

OMEW **软件代码**采用 [AGPL-3.0-only](LICENSE)，包括商业使用在内均依照 AGPL 执行。

OMEW Logo、favicon 与 Mew 官方美术不属于 AGPL，仅依照[《OMEW 资产使用条款》](ASSET-LICENSE.md)授权用于非商业部署。仅接受无对价的纯自愿捐助不视为商业使用；捐助最多可获捐助头衔或经本人同意展示身份，众筹不属于纯捐助。符合条款的非侵入式广告仅可覆盖必要服务成本。带有其他收入或商业行为的部署必须移除或替换全部 Logo 与 Mew 官方美术资产。

`stamp-*` 第三方贴纸未获得仓库可转授的许可，不属于上述非商业授权；使用或分发前须自行取得许可或删除。详细来源与边界见 [Mew 资产 NOTICE](assets/mew/NOTICE.md)及 [Logo NOTICE](assets/logo/NOTICE.md)。
