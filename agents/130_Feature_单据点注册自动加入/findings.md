# 技术发现

- [单据点根据点定位] -> `ensureRootStronghold` 以已注册的 slug 解析确定性 StrongholdDO -> 根据点存在后可直接复用其 RPC，不需要新增 D1 成员关系写入。
- [注册成功定义] -> 本地注册在用户 D1 写入后才签发会话；OIDC 在映射用户后才创建登录完成码 -> 自动加入必须置于这两个可见成功边界之前。
- [重复语义] -> `StrongholdDO.addMember` 使用 actor 唯一约束 upsert，且维护 `stronghold_member_index` -> 已存在且未封禁的成员可安全视为已完成。
- [失败处理] -> 单据点根缺失时注册返回 503，且用户行不会保留 -> 不会产生未入驻但已登录的表面成功。
