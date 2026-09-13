# 调研记录

- [现象] `USE_ART_ASSETS` 原先控制反应图片显示，而内置表情使用 `USE_BUILTIN_EMOTES`。
  -> [结论] 新增 `USE_BUILTIN_REACTIONS` / `builtin_reactions_enabled`，不能复用总美术开关或表情包开关。
- [约束] `ENABLE_REACTIONS` 是反应功能总开关，Room Durable Object 已在写路径执行服务端拒绝。
  -> [结论] 新开关只控制内置反应资源供给与渲染，不改变反应功能总开关语义。
- [资源边界] 标准表情与反应虽然来自同一组客户端素材，但使用不同 pack id、token namespace 和 UI 入口。
  -> [结论] `BUILTIN_EMOTE_PACK` 与 `BUILTIN_REACTION_PACK` 分别受自己的部署开关控制，二者都不依赖 `USE_ART_ASSETS`。
