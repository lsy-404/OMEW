# 调研记录

- [用户契约] -> StarDust 专属论坛不提供安全选项卡；内置表情包保持启用，其他 OMEW 内置美术资源保持禁用。
- [配置基线] -> `server/wrangler.stardust.jsonc` 当前已经使用 `ENABLE_EMOTES=1`、`USE_BUILTIN_EMOTES=1`、`USE_ART_ASSETS=0`，本任务需要将该组合纳入回归测试并保持不变。
- [现有设置入口] -> `PersonalSettingsModal.vue` 把资料、安全、外观写成固定数组，打开时无条件回到资料并加载通行密钥；`RightColumn.vue` 也无条件提供个人设置入口，没有实例级可用性定义或深链接。
- [能力定义] -> 新增部署变量 `PERSONAL_SETTINGS_SECTIONS`，允许 `profile`、`security`、`appearance` 的 CSV allowlist；未配置时保留全部默认选项，显式空值允许完全隐藏个人设置入口，未知值忽略。
- [顺序语义] -> allowlist 只决定可用性，服务端始终按资料、安全、外观的产品顺序返回，避免部署变量顺序与前端固定标签顺序产生歧义。
- [前端边界] -> 公共实例配置投影 `personal_settings_sections`；个人设置菜单、顶层选项卡、选项切换与安全数据加载共同服从该列表，避免只隐藏标签但仍访问安全接口。
- [表情耦合根因] -> `useEmotes.ts` 当前把 `art_assets_enabled` 纳入 `builtinEnabled`，导致 `USE_ART_ASSETS=0` 错误关闭内置表情；该缺陷由独立子任务 131 修复并回归 StarDust 配置组合。
- [首次类型检查] -> 目标测试 20 项通过后 `vue-tsc` 报 mock 的设置 section 推断为宽泛 `string[]` -> 为 mock `getInstanceConfig` 声明 `Promise<InstanceConfig>` 返回类型，使 allowlist 使用正式联合类型。
- [集成后首次全量测试] -> 503 项中 `stronghold-management` 的 WebSocket 测试先收到 batch 而非预期 error -> 失败路径不触及本次设置、注册或表情代码，隔离重跑以判断并发消息时序波动。
- [隔离重跑] -> 单独执行 `stronghold-management` -> 31 项全部通过，确认首次失败为全量并行中的既有消息时序波动。
- [最终全量验证] -> 使用 2 个 Vitest worker 降低并发干扰 -> 76 个测试文件、503 项全部通过；类型检查、构建与 Worker dry-run 通过。
- [新增用户契约] -> 内置标准表情包与内置反应资源也必须分开 -> 现有 `USE_BUILTIN_EMOTES` 同时注入 `BUILTIN_EMOTE_PACK` 和 `BUILTIN_REACTION_PACK`，反应图片还错误受 `art_assets_enabled` 控制；任务 132 将新增独立内置反应能力并保持反应总开关优先。
- [四开关边界] -> `ENABLE_EMOTES` / `ENABLE_REACTIONS` 分别是功能总开关，`USE_BUILTIN_EMOTES` / `USE_BUILTIN_REACTIONS` 分别控制两组内置资源；`USE_ART_ASSETS` 只控制其他默认美术，不再进入表情或反应资源判断。
- [最终集成验证] -> 7 个目标测试文件 43 项通过，类型检查、构建、普通与 StarDust 两套 Worker dry-run 均通过；随后以 2 个 Vitest worker 运行 77 个文件、508 项全量测试，全部通过。
- [生产配置] -> `/api/instance/config` 返回 `personal_settings_sections=[profile,appearance]`、两项内置资源开启、其他美术关闭；独立根路径和登出接口继续返回 403。
- [真实入口] -> 刷新星尘站嵌入论坛后，个人设置仅显示“资料”“外观”，没有“安全”；表情选择器分别显示“反应”和“标准表情”两个区块。
- [单据点行为] -> 部署前浏览器中的当前 OIDC 用户尚显示“加入据点”，部署并刷新完成自动登录后已成为 `medium5` 成员，发帖与聊天输入恢复可用。
