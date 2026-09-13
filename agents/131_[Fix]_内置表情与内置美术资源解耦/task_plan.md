# 表情与内置美术资源解耦计划

- [x] 在 `web/src/composables/useEmotes.ts` 中拆分内置表情与通用内置美术资源开关
- [x] 保持其他资源（头像、背景、空状态插画）继续受 `art_assets_enabled` 控制
- [x] 在 `/test` 增加 StarDust 组合回归：`ENABLE_EMOTES=1, USE_BUILTIN_EMOTES=1, USE_ART_ASSETS=0`
- [x] 跑 `test/typecheck/build/deploy:check` 关键链路，确认无其他回归
