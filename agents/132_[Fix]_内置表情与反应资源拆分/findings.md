# 调研记录

- [现象] `USE_ART_ASSETS` 原先控制反应图片显示，而内置表情使用 `USE_BUILTIN_EMOTES`。
  -> [结论] 新增 `USE_BUILTIN_REACTIONS` / `builtin_reactions_enabled`，不能复用总美术开关或表情包开关。
- [约束] `ENABLE_REACTIONS` 是反应功能总开关，Room Durable Object 已在写路径执行服务端拒绝。
  -> [结论] 新开关只控制内置反应资源供给与渲染，不改变反应功能总开关语义。
- [资源边界] 标准表情与反应虽然来自同一组客户端素材，但使用不同 pack id、token namespace 和 UI 入口。
  -> [结论] `BUILTIN_EMOTE_PACK` 与 `BUILTIN_REACTION_PACK` 分别受自己的部署开关控制，二者都不依赖 `USE_ART_ASSETS`。
- [生产验收] StarDust 的配置投影显示两项内置资源均开启且其他美术关闭；实际表情选择器分别渲染“反应”和“标准表情”区块。
  -> [结论] 三项资源策略可按部署组合生效，关闭其他美术不再影响两类内置资源。
