# 任务进度

- 已完成：
  - 拆分内置表情与通用美术资源开关：`useEmotes` 的 `builtinEnabled` 不再依赖 `art_assets_enabled`。
  - 在 `/test` 增加 StarDust 组合回归：`ENABLE_EMOTES=1`、`USE_BUILTIN_EMOTES=1`、`USE_ART_ASSETS=0`，覆盖实例能力配置与 `/api/emotes` 可达性。
  - 完成 `test/typecheck/build/deploy:check` 验证，未进行推送与部署。
- 合并到集成分支后补充 `useEmotes` 不依赖通用美术资源开关的源码契约。
- 集成后联合 StarDust 配置、个人设置与单据点自动加入的 35 项目标测试通过。
