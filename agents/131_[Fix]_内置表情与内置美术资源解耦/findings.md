# 任务调研记录

- 先前配置链路里，`USE_ART_ASSETS` 与 `USE_BUILTIN_EMOTES` 均来源于实例配置，但前端 `useEmotes` 用了 `artAssetsEnabled` 作为内置表情开关的前置条件，导致 `USE_ART_ASSETS=0` 会误禁用内置表情包。
- `useEmotes` 其余路径（头像、背景、空状态占位）已继续依赖 `art_assets_enabled`，并未把实例能力与内置表情混到一个值。
- `test/fixed-stronghold.test.ts` 已有 `USE_ART_ASSETS=0` + `USE_BUILTIN_EMOTES=0` 场景，可在其上补充 `USE_BUILTIN_EMOTES=1` 的回归。
- 集成分支额外增加浏览器端负向契约，确保内置表情组合逻辑不再读取 `art_assets_enabled`，避免只验证服务端配置而遗漏前端再次耦合。
