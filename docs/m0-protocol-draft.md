# OpenMew 联邦协议规范 v1(M0 初稿)

> 状态:normative draft
> 日期:2026-08-18
> 协议主版本:1

本文档使用 MUST / MUST NOT / SHOULD / SHOULD NOT / MAY,语义依 RFC 2119 与 RFC 8174。未标注关键字的段落为说明性文字,不构成一致性要求。

一致性实现分两类角色:**home**(某房间或某身份的权威实例)与 **peer**(其他实例)。同一部署对不同资源同时扮演两种角色。

---

## 1 术语与标识符

### 1.1 术语

| 术语 | 定义 |
|---|---|
| Instance | 一个 OpenMew 部署,由唯一 DNS 域标识。该域即其 `origin`。 |
| Stronghold | 据点。权限、可见性、成员关系的作用域。 |
| Room | Channel(聊天频道)与 Section(帖子分区)的统称。每个 Room 有唯一 home instance。 |
| Item | Room 内的一条内容(消息 / 主题帖 / 回复),由 `seq` 定位。 |
| Actor | 一个用户身份,形如 `@localpart:domain`。 |
| Home instance | 对 Room 而言是其唯一权威实例;对 Actor 而言是其注册实例。 |
| Guest identity | Actor 在非其注册实例上的本地身份行,承载该实例内的成员状态。 |
| Ownership key | 账号所有权密钥,账号归属的冷根,与实例密钥彼此独立,§6.7。 |
| Link | 边。`(actor, peer_instance)` 二元组,表示该 actor 在该实例持有宾客身份,§7.7。 |
| Envelope | 联邦事件信封,§2。 |

### 1.2 Actor 语法

```abnf
actor      = "@" localpart ":" domain
localpart  = lc-alnum *63( lc-alnum / "_" / "-" / "." )
lc-alnum   = %x61-7A / %x30-39          ; a-z 0-9
domain     = 1*253OCTET                 ; IDNA2008 A-label,小写 ASCII
```

- `localpart` MUST 为上述 ASCII 子集,长度 1–64,MUST NOT 以 `-` 或 `.` 结尾,MUST NOT 含连续 `.`。
- `localpart` MUST NOT 以 `_` 开头。`_` 前缀在 v1 保留,MUST NOT 出现在任何线上标识符中;系统事件按 §2.1 省略 `actor` 字段。
- `domain` MUST 为 IDNA2008 处理后的 A-label 形式并全小写。含非 ASCII 的输入 MUST 在注册/配置期转换,MUST NOT 在线上格式中出现 U-label。
- 用户名唯一性作用域为单实例。`@alice:a.example` 与 `@alice:b.example` 是两个不相关的身份。实现 MUST NOT 建立全局用户名命名空间。
- 跨实例上下文的 UI MUST 显示全限定 actor,MUST NOT 仅显示 `localpart` 或 `display_name`。

### 1.3 规范化

- 注册期输入的用户名 MUST 先经 PRECIS `UsernameCaseMapped` profile(RFC 8265)处理,再校验 §1.2 的 ASCII 子集;不通过者 MUST 拒绝注册,MUST NOT 静默改写。
- `display_name`、据点名、房间名 MUST 按 PRECIS `FreeformClass` / `OpaqueString`(RFC 8264)处理并以 NFC 存储与传输。这些字段 MUST NOT 参与任何身份判定、鉴权或去重。
- **接收端 MUST NOT 对线上标识符做静默规范化。** 收到的 `actor`、`origin`、房间标识符、媒体引用的字节序列 MUST 与其规范化结果逐字节相等,否则 MUST 拒绝该信封(`OMEW_NOT_CANONICAL`)。静默规范化会使同一逻辑标识符存在多种字节表示,破坏签名稳定性与去重键唯一性。

### 1.4 Confusable 拒绝规则

- 注册期实现 MUST 计算候选 `localpart` 的 UTS #39 skeleton,与本实例既有 `localpart`(含已注销但仍保留的)的 skeleton 集合比对,碰撞 MUST 拒绝(`OMEW_NAME_CONFUSABLE`)。
- 实现 MUST 使用完整的 UTS #39 confusables 数据表,MUST NOT 以手写替换表近似。ASCII 子集下主要消解 `0/o`、`1/l`、`rn/m` 一类碰撞。
- 已注销用户名 SHOULD 永久保留占位,MUST NOT 在无冷却期的情况下重新分配。
- `display_name` 出现混合书写系统(UTS #39 mixed-script)时,UI SHOULD 加视觉标记。协议不因此拒绝事件。

### 1.5 资源标识符

```abnf
res-id     = lc-alnum *63( lc-alnum / "_" / "-" )
room-ref   = stronghold-id "/" ( "ch" / "sec" ) "/" res-id
room-uri   = "omew://" domain "/" room-ref
```

- `room` 字段承载 `room-ref`,其解析基准是信封的 `origin`(即 room home)。`room-uri` 用于外部链接与跨域引用。
- **房间的全限定标识 MUST 为 `(origin, room-ref)` 二元组。** `room-ref` 自身不含域,跨 origin 不唯一。任何缓存、接收高水位、订阅表、去重索引与展示索引 MUST 以该二元组为键,MUST NOT 仅以 `room-ref` 索引。
- `room-ref` 出现在 URL 路径中时 MUST 按其三段结构展开为三个路径段(`{stronghold-id}/{ch|sec}/{res-id}`),MUST NOT 整体百分号编码。
- Room 的 DO 命名 MUST 与 `room-ref` 一一对应且在房间生命周期内不变,且 `res-id` MUST NOT 在房间删除后被复用(§3.6)。
- 每据点 Channel ≤ 25、Section ≤ 10 为软上限。实现 MUST NOT 在协议层或存储层硬编码该数值,据点级 fan-out MUST 支持分批。

### 1.6 媒体引用

```abnf
media-ref  = "omew://" domain "/media/" media-id
media-id   = 43( base64url-char )       ; base64url(SHA-256(content)),无填充
```

- `media-id` MUST 为内容寻址值,即附件字节的 SHA-256 经无填充 base64url 编码。相同内容在同一实例内 MUST 映射到同一引用。
- 内容 payload 中的媒体 MUST 以对象形式携带元数据:`{ref, mime, size, width?, height?, blurhash?, alt?}`。接收端 MUST 以 `ref` 为准重新校验取回内容的 SHA-256,不匹配 MUST 丢弃(`OMEW_MEDIA_DIGEST_MISMATCH`)。
- 取回路径 MUST 为 `GET https://{domain}/media/{media-id}?room=<room-ref>`。实例 MUST 维护 `(media-id, room-ref)` 引用表,MUST 按 `room` 所属据点的可见性与请求方成员关系鉴权(§8.2),MUST 拒绝 `media-id` 未在该 `room` 中被引用过的请求(`OMEW_ROOM_NOT_FOUND`)。同一内容被多处引用时,任一有权限的引用即足以授权该次取回;内容去重 MUST NOT 导致越权可读。客户端 MUST NOT 假设可直连对象存储。
- 该引用表仅用于鉴权,MUST NOT 被当作媒体回收的引用计数。v1 不做媒体回收,范围声明见 §9.5。
- 跨实例的媒体代理取回 MUST 携带 §8.3.1 的联邦请求签名。
- `mime` MUST 在实例白名单内。白名单内容属实现策略,但实现 MUST 以服务端嗅探结果而非客户端声明为准。

---

## 2 事件信封

### 2.1 字段表

| 字段 | 类型 | 出现 | 说明 |
|---|---|---|---|
| `v` | integer | MUST | 协议主版本。本规范恒为 `1`。 |
| `id` | string | MUST | 事件标识符,UUIDv7 小写文本形式(36 字符)。在 `origin` 内 MUST 永不复用。 |
| `type` | string | MUST | 事件类型,§3。 |
| `origin` | string | MUST | 生成并签名本信封的实例域。 |
| `room` | string | 条件 | `room-ref`。以房间为作用域的事件(`item.*`、`tip.mention`)MUST 携带;据点级事件(`member.*`、`stronghold.*`、`tip.digest`)与身份域事件 MUST NOT 携带,其作用域以 payload 的 `stronghold` 表达。 |
| `actor` | string | 条件 | 动作发起者。系统事件 MAY 省略。 |
| `seq` | integer | 条件 | 房间内定序位置。仅由 room home 在定序完成后填入,§5。 |
| `ts` | integer | MUST | 生成时刻 Unix 毫秒。 |
| `payload` | object | MUST | 类型相关载荷,§3。 |
| `objects` | object | MAY | sideload 引用池。v1 仅定义 `users`,§7.4。 |
| `key_id` | string | MUST | 签名密钥标识,§6。 |
| `sig` | string | MUST | 无填充 base64url 编码的 Ed25519 签名(64 字节)。 |

- 单个信封序列化后 MUST NOT 超过 64 KiB。

### 2.2 规范化

签名与验签的输入 MUST 由 RFC 8785 JSON Canonicalization Scheme(JCS)产生。除 JCS 本身的规则外,本协议附加以下约束:

- **空值省略规则(全局)**:本规范定义的全部 JCS 签名对象——事件信封、实例描述符(§6.1)、用户档案文档(§6.1)、会话断言(§7.1)、轮换连续性输入(§6.3)、吊销输入(§6.5)、联邦请求签名输入(§8.3.1)——中,值为空的字段 MUST 省略,MUST NOT 写作 `null`。`null` 与字段缺失的二义性会破坏规范化结果的确定性,两个实现会对同一逻辑对象算出不同的签名字节。key set 文档(§6.1)按该节规定不自签名,不受本约束。
- 信封及 payload 中的所有整数 MUST 落在 ±(2^53 − 1) 内。JCS 的数字序列化依赖 IEEE-754 双精度,超出范围无确定表示。
- 信封顶层字段 MUST NOT 出现浮点数。payload 内 SHOULD NOT 出现浮点数;确有需要时 MUST 以字符串承载。
- 同一对象内 MUST NOT 出现重复键。解析器遇重复键 MUST 拒绝整个信封。
- 字符串 MUST 为有效 UTF-8,MUST NOT 含未配对代理项。

### 2.3 签名输入

```
signing_input = UTF8("openmew/event/v1") || 0x00 || JCS(envelope_without_sig)
```

- `envelope_without_sig` = 移除 `sig` 字段后的完整信封对象。**其余全部字段(含 `key_id` 与本规范未定义的扩展字段)MUST 被签名覆盖。**
- 域分隔前缀 `openmew/event/v1` MUST 存在。它使事件签名与 §7 的会话断言签名、§6 的轮换连续性签名、§6.1 的两份文档签名、§8.3.1 的请求签名互不可替换。
- 算法为 Ed25519(RFC 8032)。WebCrypto 中 MUST 使用标准算法标识符 `"Ed25519"`;MUST NOT 使用 `NODE-ED25519`。
- 中继实现 MUST NOT 剥离未知字段后转发。任何字段增删都会使签名失效。

### 2.4 验签伪码

```
function receive(raw_bytes, peer_ip):
    # 以下三步 MUST 在任何解析与任何出站请求之前完成(§11)
    rate_limit(peer_ip)                       or reject 429 OMEW_RATE_LIMITED
    assert len(raw_bytes) <= 64 KiB           or reject 413 OMEW_ENVELOPE_TOO_LARGE
    env = strict_json_parse(raw_bytes)        or reject 400 OMEW_MALFORMED

    if env.v != 1:                            reject 400 OMEW_UNSUPPORTED_VERSION
    if not known_peer(env.origin):            reject 403 OMEW_UNKNOWN_ORIGIN
    if blocked(env.origin):                   reject 403 OMEW_PEER_BLOCKED
    if abs(now_ms() - env.ts) > 300_000:      reject 400 OMEW_STALE_TS

    key = local_keystore(env.origin, env.key_id)      # 本地查,MUST NOT 触发出站
    if key is None:                           reject 403 OMEW_KEY_UNKNOWN
    if key.status == "revoked":               reject 403 OMEW_KEY_REVOKED
    if key.status == "retired" and now_ms() > key.retired_at + Q:
                                              reject 403 OMEW_KEY_UNKNOWN
                                              # Q = 队列最大重投期,§4.3 / §6.3

    input = UTF8("openmew/event/v1") || 0x00 || JCS(without(env, "sig"))
    if not ed25519_verify(key.public_key, input, b64url_decode(env.sig)):
                                              reject 403 OMEW_BAD_SIGNATURE

    if not identifiers_are_canonical(env):    reject 400 OMEW_NOT_CANONICAL
    if not actor_binding_ok(env):             reject 403 OMEW_ACTOR_MISMATCH   # §7.5

    if dedup_seen(env.origin, env.id):        return ack_duplicate(env)        # §4
    if not known_type(env.type):              return ack_ignored(env)          # §13,不写去重表

    seq = apply(env)                          # 定序、落库、tombstone 叠加
    dedup_record(env.origin, env.id, seq)     # 与 apply 同一事务
    return ack(env.id, seq)
```

`dedup_record` 与 `apply` MUST 处于同一事务。先记去重后落库会在崩溃时永久吞掉事件;先落库后记去重会在重投时产生重复。

### 2.5 测试向量

一致性测试向量在 M0 冻结前补齐,位置见附录 A。实现 MUST 通过全部向量方可宣称一致。测试向量为 M0 冻结的**阻塞项**,见附录 C。

---

## 3 事件类型表

### 3.1 通用规则

- 事件类型 MUST 命名空间化,形如 `<namespace>.<verb>`。v1 命名空间为 `item`、`tip`、`member`、`user`、`stronghold`、`voice`。
- 接收端对未知 `type` MUST 静默忽略:不落库、不分配 seq、**不写入去重表**、不返回错误(返回 202 与忽略计数)。详见 §13.2。
- 事件类型名一经发布 MUST NOT 复用。废弃的类型名永久保留为废弃状态。
- 本表定义**联邦事件**。客户端 WebSocket 帧复用同一类型命名与信封字段子集,由服务端签发,不要求客户端签名;标注「本地」的类型 MUST NOT 出现在联邦链路上。

**事件域划分**(决定 §7.5 的 actor 绑定规则):

| 域 | 含义 | 包含 |
|---|---|---|
| 据点域 | `origin` = 房间 / 据点 home | `item.*`、`member.*`(除 `member.join_request`)、`stronghold.*`、`tip.digest`、`tip.mention` |
| 身份域 | `origin` = actor 的注册实例 | `user.*`、`member.join_request` |

### 3.2 `item.*`

| 类型 | 定序 | payload 概要 |
|---|---|---|
| `item.create` | MUST 占 seq | `{client_id, kind, parent_seq?, body}` |
| `item.update` | MUST 占 seq | `{target_seq, body, edited_at}` |
| `item.delete` | MUST 占 seq | `{target_seq, reason?, by_role, shard_version?}` |
| `item.bump` | MUST NOT 占 seq | `{post_seq, last_reply_seq, reply_count, preview}` |

- `kind` v1 锁定枚举:`post`(主题帖 / 聊天消息)、`reply`(回复)。未知 `kind` MUST 按未知类型处理(静默忽略,§13.2)。
- `body` MUST 为 JSON 对象,MUST NOT 为裸字符串。v1 定义键:`text`(string,NFC)、`media`(array of 媒体对象,§1.6)、`quote`(`{room, seq}`)。三者 MUST 至少存在其一。
- **回复深度恒为一层**:`parent_seq` 非空时,其指向的 item MUST 自身 `parent_seq` 为空。违反 MUST 拒绝(`OMEW_REPLY_DEPTH`)。
- `item.update` 仅作者本人可发起;`item.delete` 由作者本人、房间 mod 或据点 owner 发起,`by_role` MUST 如实标注。
- `target_seq` MUST 指向同一房间内既存的 item,否则 MUST 拒绝(`OMEW_TARGET_NOT_FOUND`,404)。对已存在 tombstone 的 `target_seq` 发起 `item.update` MUST 拒绝(`OMEW_ITEM_DELETED`,409);重复的 `item.delete` MUST 按 §4.1 作幂等重复处理,MUST NOT 报错。
- `by_role` 枚举 `author` / `mod` / `owner`,MUST 与 §3.4 角色模型一致。home MUST 独立校验发起者实际具备该角色,MUST NOT 采信声明值。
- `item.delete` 的 `shard_version` 仅在法务级硬删除流程(§9.3)中携带。
- `item.bump` 语义见 §10.4,为幂等绝对快照。
- `client_id` 为客户端生成的幂等 nonce,1–64 个 ASCII 可打印字符,SHOULD 为 UUIDv4。语义见 §4.2。

### 3.2a `item.reaction`(能力位 `reactions` 激活)

依 §13 的延后引入机制激活 §3.8 预留的 `reactions` 能力位,对应 Mew 的 `*_engagement` 事件族。

| 类型 | 定序 | payload 概要 |
|---|---|---|
| `item.reaction` | MUST NOT 占 seq | `{target_seq, name, op}` |

- `op` ∈ `add` / `remove`。每 `(actor, target_seq, name)` 至多存在一份反应:重复 `add` MUST 幂等去重,不存在时的 `remove` MUST 幂等无害,二者均 MUST NOT 报错。
- `name` 为 1–64 个 ASCII 可打印字符的反应标识。服务端 MUST NOT 枚举校验 `name`(反应集属客户端资产,其演进不构成协议迁移),仅作长度与字符集校验。
- `target_seq` MUST 指向同一房间内既存 item(`OMEW_TARGET_NOT_FOUND`),对已 tombstone 的 target MUST 拒绝(`OMEW_ITEM_DELETED`)。反应类拒绝的错误帧 MUST 附带 `target_seq` 与 `name`,使客户端能精确回滚乐观状态。
- 反应为 engagement 状态,MUST 存于 item 主表之外的侧表,MUST NOT 进入归档分片(分片不可变,§9.2);热层之外的历史反应为尽力而为,实现 MUST 明示该边界。
- 反应快照不占 seq,故不入 §5.2 的 resync 修复面:resync 重放条目 MUST 随行其当前反应快照,未重放条目在断线期间的反应变更以重连后的读端点加载为准。此边界与热层边界同属 MUST 明示范围。
- 权限:反应不受 §3.4 `deny` 位约束——`deny` 约束内容写入,不约束 engagement;发起者 MUST 持有效房间会话(游客只读态不可反应)。限流 MUST 与内容写入共用按 actor 的 token bucket。
- 广播:服务端 MUST 广播绝对计数快照 `{target_seq, entries: [{name, count}], actor, name, op}`,其中 `entries` 为该 target 的全量反应计数(幂等绝对语义,同 `item.bump` 哲学);`actor`、`name` 与 `op` 供各端——含同一账号的其他连接——维护「本人已反应」标记。读端点(历史 / 帖子)MUST 随 item 返回 `entries` 及请求者视角的 `mine` 集合。
- 联邦:实例能力宣告就绪前,`item.reaction` MUST NOT 出现在联邦链路上,MUST NOT 写入去重表。

### 3.3 `tip.*`

| 类型 | 链路 | payload 概要 |
|---|---|---|
| `tip.update` | 本地(房间 DO → StrongholdDO) | `{room, latest_seq, ts}` |
| `tip.mention` | 据点域 S2S | `{room, seq, target_actor, excerpt}` |
| `tip.digest` | 据点域 S2S | `{for_actor, entries: [{stronghold, room, latest_seq, unread_hint}], ts}` |

- `tip.update` 与 `tip.digest` MUST 携带绝对值,MUST NOT 携带增量。合并与丢弃只有在绝对语义下才无害。
- `tip.update` MUST 先落 StrongholdDO 持久化存储再由 alarm 冲刷,MUST NOT 只驻留内存。各房间 DO MUST 在归档 alarm 上顺带重报 `latest_seq` 作对账。
- `tip.digest` 由据点所在实例推送至用户注册实例,用于跨实例未读汇聚。丢失可由下一次 digest 自愈,不需重传保证。
- **`tip.digest` 配额**:同一 `origin` 就同一据点 MUST NOT 发出多于 1 次 / 60 s 的 `tip.digest`。接收端对超出配额的部分 MUST 静默丢弃,MUST NOT 返回错误、MUST NOT 计入限流惩罚。
- `restricted: true` 的房间(§3.6)MUST NOT 出现在公开、宾客或普通成员的 tip 汇总中;本地 `owner` / `mod` 的据点级 tips MAY 包含其本就有权访问的受限房间。

### 3.4 `member.*`

| 类型 | 域 | payload 概要 |
|---|---|---|
| `member.join_request` | 身份域 | `{stronghold, subject, answers?: [{q_id, text}]}` |
| `member.add` | 据点域 | `{stronghold, subject, role, deny, restricted}` |
| `member.reject` | 据点域 | `{stronghold, subject, reason?}` |
| `member.update` | 据点域 | `{stronghold, subject, role, deny, restricted}` |
| `member.remove` | 据点域 | `{stronghold, subject}` |
| `member.ban` | 据点域 | `{stronghold, subject, reason?, banned_at}` |
| `member.unban` | 据点域 | `{stronghold, subject}` |

- `subject` 为被操作的 actor,MAY 为外域。`actor` 为执行操作者。两者 MUST 分开表达。`member.ban` 的操作者以信封 `actor` 为准,payload MUST NOT 另设 `operator` 字段。
- `restricted` 为布尔,`deny` 为整数位掩码;两者缺省分别视为 `false` 与 `0`。
- **角色模型固定三档**:`owner`(每据点唯一,可转让)、`mod`、`member`。v1 MUST NOT 支持自定义角色。角色 MUST 进入会话 token 的 claims(§7.3)。
- `deny` 为位掩码,MUST 按位解释:`1` = channel 发言、`2` = section 发帖、`4` = 回复。未定义位 MUST 忽略。
- **`deny` 位仅对 `member` 生效**:`owner` MUST 豁免一切 `deny` 位;对 `mod` 施加 `deny` MUST 先经 `member.update` 降级为 `member`,单条事件 MUST NOT 同时完成降级与施加 `deny`。签发会话 token 与房间 token 时,`owner` 与 `mod` 的 `deny` MUST 取 `0`(§7.3)。
- 惩戒两级:`restricted`(受限,可恢复)与 ban(黑名单)。`member.remove` 后可重新加入,`member.ban` 后 MUST 拒绝加入直至 `member.unban`。
- **加入申请属身份域**:`member.join_request` 的 `origin` MUST 为发起用户的注册实例,其 `actor` 的域 MUST 逐字节等于 `origin`(§7.5 规则 2)。据点 home 以**据点域**事件回应:批准发 `member.add`,驳回发 `member.reject`。协议不设独立的 `member.join_response`。
- 申请状态为三态:无回应即 `pending`;`member.reject` 或 `member.remove` 之后,subject MAY 重新发起 `member.join_request`(即 `rejected → pending` 与 `approved → pending` 均为合法转移,审核状态可复原);`member.ban` 期间的申请 MUST 拒绝(`OMEW_BANNED`)。
- v1 只做 join 一条申请流。**speak(发言权)申请流延后**,能力位预留 `speak_gate`,登记于 §13.4。
- `member.ban`、`member.remove`、`member.update` 生效时 MUST 触发 §7.3 的撤销传播,MUST NOT 依赖 token 自然过期。
- 据点 home 持有权威成员表,MUST 以规范化 actor 全串为键,MUST 支持外域 actor。用户注册实例持有的「我加入的据点」为便利缓存,最终一致,MUST NOT 作为访问控制依据。

### 3.5 `user.*`

| 类型 | payload 概要 |
|---|---|
| `user.update` | `{profile_version, display_name?, avatar?, bio?, ownership_key?, moved_to?, also_known_as?}` |
| `user.deactivate` | `{deactivated_at, reason?}` |
| `user.link` | `{peer}` |
| `user.link_confirm` | `{subject, first_seen_at}` |
| `user.unlink` | `{subject, reason?}` |
| `user.moved` | `{old, new, mode, proof, home_release?, ownership_key?, effective_at}` |
| `user.move_objection` | `{target_id, old, reason?}` |

- 本节全部类型 MUST NOT 占用 seq,MUST NOT 携带 `room`(§2.1),MUST NOT 进入房间接收高水位。
- `profile_version` MUST 单调递增。接收端 MUST 按版本 upsert,MUST 丢弃版本不高于本地缓存的更新。
- `user.update` 丢失可接受:下一条据点域事件的 `objects.users` sideload 即为对账通道(§7.4)。
- `user.deactivate` 的处理见 §7.6,其会话失效 MUST 经 §7.3 的撤销传播路径。
- `user.link` 由注册实例在签发 `aud = peer` 的断言时发出,`peer` 为目标实例域。接收端 MAY 据此记录待确认边,MUST NOT 据此创建宾客身份或授予任何访问——会话恒只由 §7.2 的断言建立。
- `user.link_confirm` / `user.unlink` 由宾客实例签发,MUST 省略 `actor`,`subject` 为该宾客 actor。语义与校验见 §7.7,绑定规则见 §7.5 规则 2。
- `user.moved` 是迁移**公告与公示期载体**,MUST NOT 单独触发归属改写;逐边生效以 §7.8 的挑战握手为准。`envelope.actor` MUST 为迁移后的新 actor,旧 actor 由 payload `old` 承载。
- `user.move_objection` 由旧 home 以其实例密钥签发,`target_id` 为被异议的 `user.moved` 信封 `id`,语义见 §7.8。
- `moved_to` 由旧 home 在常规迁移路径中经 `user.update` 置位,`also_known_as` 记录历史 actor 串。接收端 MUST NOT 仅据 `user.update` 改写归属,归属改写 MUST 经 §7.8 的所有权证明。
- `user.update` 的 `ownership_key` 仅在所有权密钥轮换时携带,MUST 按 §6.7 校验连续性链后方可替换本地钉扎值。

### 3.6 `stronghold.*`

| 类型 | payload 概要 |
|---|---|
| `stronghold.update` | `{stronghold, name, description?, visibility, icon?}` |
| `stronghold.room.create` | `{stronghold, room, type, name, capabilities: [], restricted?, position?}` |
| `stronghold.room.update` | `{stronghold, room, name?, capabilities?, restricted?, position?, archived?}` |
| `stronghold.room.delete` | `{stronghold, room}` |

- `visibility` 枚举 `public` / `private`,语义见 §8.2。
- `type` 枚举 `channel` / `section`。新房间形态经 `type` + `capabilities` 取值扩展,MUST NOT 通过新增事件类型或数据迁移引入。
- `capabilities` 为字符串数组,作用域为**房间**。v1 定义 `text`(所有房间 MUST 含)、`attachments`、`voice`。未知能力值 MUST 忽略。房间能力与实例能力(§6.1)为两套独立注册表(§13.3);据点级 MUST NOT 承载能力宣告。
- `restricted` 为布尔,缺省 `false`。`restricted: true` 的房间仅 `owner` 与 `mod` 可见可入(对齐 Mew `moderation_topic` 先例)。该类房间 MUST NOT 联邦——MUST NOT 出现在任何出站信封、订阅 fan-out 与历史回源响应中——且 MUST NOT 出现在目录、搜索结果或未授权角色的 tips 汇总中;本地 `owner` / `mod` MAY 接收。v1 不提供逐房间可见性矩阵,`restricted` 是「房间继承据点 `visibility`」(§8.2)的唯一例外。
- `position` 为可选整数排序键,纯展示用途,MUST NOT 影响任何协议语义。
- `stronghold.room.delete` 后,该房间 MUST 停止接受任何写事件,已注册的联邦订阅 MUST 全部作废并停止 fan-out;历史与 tombstone / revision 侧表(§9.1)MUST 整体保留可读,或按实例保留策略整体清除,MUST NOT 部分保留。`res-id` 在据点生命周期内 MUST NOT 复用,`next_seq` MUST NOT 重置。允许复用 `res-id` 会使 `(origin, room-ref)` 键在远端缓存中把新旧两个房间的内容混为一谈。

### 3.7 `voice.*`

`voice.join` / `voice.leave` / `voice.peers` / `voice.signal` / `voice.token`

- Web 客户端通过 LiveKit SDK 连接房间 SFU；`voice.join`、`voice.leave`、`voice.peers`、`voice.signal` 是保留的协议名,不是 OMEW 房间 WebSocket 帧。
- 已登录成员可对 `POST /stronghold/{id}/rooms/{resId}/voice-token` 请求临时凭据。服务端 MUST 每次重新校验有效 Session、当前据点成员与角色、封禁状态、私密据点成员资格及受限频道权限；目标 MUST 是含 `voice` capability 的 `channel`。
- 响应为 `{token, url, room, exp, can_publish}`。LiveKit grant MUST 限定到单一房间和当前 actor 身份,并 MUST 允许订阅；`can_publish` MUST 按现行角色与 `DENY_CHANNEL_SPEAK` 决定。拒绝发言的成员可收听但 MUST NOT 发布麦克风音轨。
- LiveKit access token 的有效期 MUST 不超过 120 秒。权限撤销时,服务端 MUST 移除在线参与者并撤销其在撤销时点前签发的 token,以阻止使用旧凭据重连。
- `voice.*` 状态 MUST NOT 进入联邦链路、应用数据库或消息去重表,MUST NOT 占用 seq。客户端媒体直接流向配置的 LiveKit SFU；Worker MUST NOT 中转或持久化媒体流。

### 3.8 Mew 事件词表裁剪对照

参考的 38 条 Mew 网关事件按下表裁剪为 v1 集合。「延后」项依靠 §13 的命名空间 + 未知类型静默忽略 + 能力宣告三条机制引入,不构成协议迁移。

| Mew 事件 | v1 处置 |
|---|---|
| `message_create` / `thought_create` / `comment_create` | 收录 → `item.create` |
| `message_update` / `thought_update` / `comment_update` | 收录 → `item.update` |
| `message_delete` / `thought_delete` / `comment_delete` | 收录 → `item.delete` |
| `node_member_add` / `_update` / `_remove` / `_ban` | 收录 → `member.add` / `.update` / `.remove` / `.ban` |
| `user_update` | 收录 → `user.update` |
| `topic_create` / `topic_update` / `topic_delete` | 收录 → `stronghold.room.*` |
| `node_update` | 收录 → `stronghold.update` |
| `message_acknowledge` | 不收录。ack 为传输层机制,§4.4 |
| `topic_position` / `node_position` / `node_topic_space_position_change` | 不收录。折叠为 `stronghold.room.update` 的 `position` |
| `node_create` / `node_delete` | 不收录。据点生命周期为实例本地操作 |
| `role_create` / `role_update` / `role_delete` / `role_position` | 不收录。v1 角色为固定枚举 |
| `message_engagement` / `thought_engagement` / `comment_engagement` | 收录 → `item.reaction`(§3.2a) |
| `thought_pin` / `thought_unpin` | 延后。能力位预留 `pins` |
| `user_typing` / `node_member_activity_change` | 不收录。v1 无 presence |
| `user_relationship_update` | 不收录。v1 无好友 / 私聊 |
| `notification` | 不收录为独立事件。跨实例提醒走 `tip.mention` / `tip.digest` |
| `app_update` | 不收录。客户端版本分发不走事件总线 |

---

## 4 幂等与去重

### 4.1 权威键

- 端到端去重键 MUST 为 `(origin, envelope.id)`。任何接收端 MUST 以此键判定重复,MUST NOT 使用 `(origin, seq)`。
- `(origin, seq)` MUST NOT 用作去重键。实时路径事件抵达 home 时尚无 `seq`,且 `item.bump` 等事件不占 seq,该键不成立。
- 重复投递 MUST 无副作用:不产生新 item、不推进 seq、不触发 fan-out、不发通知。

### 4.2 应用层键

- `(origin, client_id)` 为 home 侧应用层幂等键,仅用于「同一客户端的重发」判定,MUST NOT 跨实例使用。
- home MUST 在 item 表上维持 `UNIQUE(origin, client_id)`。
- 两层键 MUST 显式分开实现,MUST NOT 相互替代。

### 4.3 保留期

- 去重表 MUST 独立于归档淘汰。归档删除 item 行时 MUST NOT 删除对应的去重记录与 `(origin, client_id) → seq` 映射。
- 设 W = ts 新鲜度窗口半宽(§2.4,300 s),Q = 队列最大重投期。去重记录保留期 R MUST 满足:

```
R ≥ 2W + Q
```

- Cloudflare Queues 免费档保留固定 24 h → R MUST ≥ 24 h 10 min,实现 SHOULD 取 26 h。付费档保留最长 14 d → R MUST ≥ 14 d 10 min。
- 实现 MUST 在配置中显式声明 Q,MUST NOT 隐含假设。若出站重试需超过队列保留期,MUST 引入 D1 outbox 兜底并相应放大 R。
- **保留期上限**:去重记录与 `(origin, client_id) → seq` 映射在保留期 R 期满后 MAY 淘汰;二者 MUST NOT 因归档提前淘汰。淘汰是侧表增长的唯一收敛手段,R 已由上式给出下界。

### 4.4 ack 语义

- 首次成功处理 MUST 返回 `{status: "ok", id, seq?}`。不占用 seq 的类型(`item.bump` 等)MUST 省略 `seq` 字段,依 §2.2 的空值省略规则。
- `(origin, envelope.id)` 命中去重表 MUST 返回 `{status: "duplicate", id, seq}`,其中 `seq` 为**原次分配的 seq**。
- `UNIQUE(origin, client_id)` 冲突 MUST 返回 `{status: "duplicate", client_id, seq}`,`seq` 为原行的 seq。原行已归档时仍 MUST 能返回,因此 `(origin, client_id) → seq` 映射 MUST 存放在不随归档淘汰的独立表中。
- 客户端未收到 ack MUST 以相同 `client_id` 重发,重发 MUST 安全。
- 未知类型或未知 `kind` 被忽略时 MUST 返回 `{status: "ignored", id, reason: "unknown_type" | "unknown_kind"}`,HTTP 202。忽略不是错误,MUST NOT 返回 §12 的错误响应体。

---

## 5 seq 语义

### 5.1 不变量

- 每个 Room 维持一个 seq 计数器。`next_seq` MUST 持久化在 Room DO 的 storage 中,MUST NOT 从 item 表的 `MAX(seq)` 或 rowid 推导。
- seq 在房间生命周期内 MUST 严格递增,MUST NOT 复用,MUST NOT 因归档、删除、迁移或重启回退。
- 归档删除热表行 MUST NOT 影响 `next_seq`。
- 所有分页、引用、游标、已读位置 MUST 锚定 seq,MUST NOT 使用 timestamp。
- `item.delete` MUST NOT 释放被删 item 的 seq。

### 5.2 连续性

- home 在**同一房间 WebSocket 连接**上推送的、携带 `seq` 的帧,其 `seq` MUST 连续。客户端 MUST 校验连续性,并 MUST 在校验时跳过不携带 `seq` 的帧(`item.bump`、`voice.*` 等)。经 Queues 投递给联邦 peer 的事件不适用本条,其空洞按 §10.2 与 §10.3 收敛。
- WS attachment 中的 `last_seq` 定义为「**最后成功发送**的 seq」,MUST 在 `send()` 成功返回后更新,MUST NOT 在入队时更新。
- 广播与提交的顺序 MUST 为:SQLite 提交 → 立即向发送者单发 ack → 批量向其余连接广播。
- DO 进入休眠前 MUST 冲刷未广播的批次缓冲。已提交未广播的窗口内消息若因部署或异常重启丢失,MUST 可由客户端 resync 修复。

### 5.3 resync

- 客户端检测到 seq 缺口 MUST 发送 `resync {room, from_seq}`。
- home 收到 resync 后:缺口 ≤ 500 MUST 直接补推缺失区间;缺口 > 500 MUST 返回 `{gap: true, from, to}`,客户端改走历史 API 分页。
- 重连时客户端 MUST 上报 `last_seen_seq`,按同一规则处理。
- resync MUST 幂等,MUST NOT 因重复请求产生重复推送以外的副作用。

### 5.4 联邦侧 seq

- peer MUST 按 `(origin, room)` 维护接收高水位。
- peer MUST NOT 自行分配 seq。远端房间的 item 在本地缓存中 MUST 保留 home 分配的原 seq。
- 展示顺序 MUST 为 origin seq 序,MUST NOT 为本地接收顺序或 ts 序。

---

## 6 密钥管理

### 6.1 三端点

全部端点 MUST 经 HTTPS 提供,MUST 返回 `application/json`。

**`GET /.well-known/openmew/instance`** — 实例描述符,签名对象:

```json
{
  "v": 1,
  "instance": "a.example",
  "name": "",
  "software": "openmew",
  "version": "",
  "capabilities": ["federation.session", "federation.history", "media.attachments"],
  "public_strongholds": [
    {"id": "", "name": "", "description": "", "member_count": 0, "tags": []}
  ],
  "known_peers": ["b.example"],
  "key_id": "",
  "sig": ""
}
```

```
descriptor_input = UTF8("openmew/instance-descriptor/v1") || 0x00 || JCS(doc_without_sig)
```

- 仅 `visibility: public` 的据点 MAY 出现在 `public_strongholds`。
- `known_peers` 为 gossip 发现用,内容 MUST 视为 advisory,MUST NOT 作为信任依据。
- `capabilities` 为实例级能力宣告,§13.3。实例能力名 MUST 带前缀(`federation.` / `media.` 等)。

**`GET /.well-known/openmew/users/{localpart}`** — 用户档案文档,签名对象:

```json
{
  "v": 1,
  "actor": "@alice:a.example",
  "profile_version": 0,
  "display_name": "",
  "avatar": "omew://a.example/media/…",
  "bio": "",
  "created_at": 0,
  "status": "active",
  "ownership_key": {"key_id": "", "public_key": "", "created_at": 0},
  "key_history": [],
  "also_known_as": [],
  "key_id": "",
  "sig": ""
}
```

```
profile_input = UTF8("openmew/user-profile/v1") || 0x00 || JCS(doc_without_sig)
```

- `status` 枚举 `active` / `deactivated`。
- `moved_to` 为可选迁移字段,值为空时 MUST 省略(§2.2)。
- `ownership_key` 为该账号当前的所有权公钥条目,`key_history` 为历代条目数组(按 `created_at` 升序,首条为初始密钥,每条携带 `prev_key_id` 与 `continuity_sig`)。语义、轮换与钉扎规则见 §6.7。
- `key_id` / `sig` 是签发本文档的**实例**密钥,与 `ownership_key` 是两套独立体系,MUST NOT 相互替代。
- 不存在的 `localpart` MUST 返回 404,MUST NOT 泄露相近用户名。

**两份签名文档的通用规则**:MUST 由该实例 key set 中 `status: active` 的密钥签名;`key_id` MUST 被签名覆盖;`sig` 为移除自身后的 JCS 结果的 Ed25519 签名。验证规则同 §2.4——本地查钥、MUST NOT 触发出站、失败即拒。两个域分隔前缀使这两类签名与事件签名、断言签名互不可替换。

**`GET /.well-known/openmew/keys`** — key set,即本实例的信任锚:

```json
{
  "v": 1,
  "instance": "a.example",
  "keys": [
    {
      "key_id": "",
      "alg": "Ed25519",
      "public_key": "",
      "created_at": 0,
      "not_before": 0,
      "retired_at": null,
      "status": "active",
      "prev_key_id": null,
      "continuity_sig": null,
      "revoked_at": null,
      "revocation_sig": null
    }
  ]
}
```

- `public_key` 为 32 字节原始公钥的无填充 base64url 编码。
- `key_id` MUST 在实例内唯一且永不复用,SHOULD 为 `public_key` 的 SHA-256 前 16 字节的 base64url 形式。
- `status` 枚举 `active` / `retired` / `revoked`。
- keys 文档本身 MUST NOT 自签名。其真实性锚定于 TLS 与本地钉扎(§6.4)。**因不自签名,本文档不受 §2.2 空值省略规则约束**,上例中的 `null` 表示「该状态字段尚未取值」,是合法形式。文档内被签名覆盖的输入(`continuity_input`、`revocation_input`)仍 MUST 遵守该规则。

### 6.2 取回规则

- 拉取 MUST 使用 HTTPS 且 MUST 校验证书。MUST NOT 跟随任何重定向。
- 请求超时 MUST ≤ 5 s。响应体上限 MUST ≤ 64 KiB。
- MUST 仅对已配置的对端发起拉取。未知 origin MUST NOT 触发任何出站请求(§11.2)。
- 拉取结果 MUST 存入 D1 的 instances 表并在 Worker isolate 内存中作热缓存。
- **MUST NOT 使用 TTL 过期重拉模型。** 缓存失效仅由显式轮换或吊销触发。TTL 到期重拉会打开无钉扎的 MITM 换钥窗口。

### 6.3 轮换连续性

新密钥进入 `active` 状态前,其条目 MUST 携带 `prev_key_id` 与 `continuity_sig`:

```
continuity_input = UTF8("openmew/key-rotation/v1") || 0x00 ||
                   JCS({instance, key_id, public_key, created_at, prev_key_id})
continuity_sig   = Ed25519(sk_prev, continuity_input)
```

- `sk_prev` MUST 为 `prev_key_id` 对应的、当时处于 `active` 状态的私钥。
- 接收端 MUST 沿 `prev_key_id` 链回溯至本地已钉扎的密钥。链断、签名不符或回溯至未钉扎密钥 MUST 拒绝新密钥并告警(`OMEW_KEY_CONTINUITY_BROKEN`),MUST NOT 自动接受。
- 首个密钥(不含 `prev_key_id`)MUST 经首次钉扎建立信任,§6.4。
- **retired 宽限窗口**:旧密钥转 `retired` 后,以其签名的信封 MUST 在 `retired_at + Q` 之内继续被接受,之后 MUST 以 `OMEW_KEY_UNKNOWN` 拒绝(伪码见 §2.4)。Q 为实现声明的队列最大重投期(§4.3):免费档 24 h,付费档按声明值。宽限期取 Q 而非 2W,因为在途事件的最长滞留由队列重投期而非 ts 新鲜度窗口决定;取 2W 会使轮换期间的重投事件被成批拒绝。

### 6.4 钉扎

- 首次成功取回某实例的 keys 文档时,实现 MUST 钉扎 `(instance, key_id, public_key)`。
- 已钉扎的 `(key_id, public_key)` 映射 MUST NOT 改变。同一 `key_id` 出现不同 `public_key` MUST 拒绝并告警(`OMEW_KEY_PIN_MISMATCH`)。
- 运维 MAY 手工解除钉扎,该操作 MUST 记入审计日志。

### 6.5 吊销

- 吊销以 keys 文档为权威:条目 `status` 置 `revoked`,填 `revoked_at`,并附 `revocation_sig`:

```
revocation_input = UTF8("openmew/key-revocation/v1") || 0x00 ||
                   JCS({instance, key_id, revoked_at})
```

- `revocation_sig` MUST 由被吊销密钥自身或其后继 `active` 密钥签名。两者皆不可用时(私钥彻底丢失),吊销 MUST 经带外运维流程 + 强制解除钉扎完成。
- v1 不设主动推送的吊销事件。实例 MAY 在任意 HTTP 响应中携带 `OMEW-Revocation-Hint: <key_id>` 响应头;接收端收到后 SHOULD 立即重取该实例 keys 文档。该提示 MUST 视为不可信提示,MUST NOT 直接据其失效密钥。
- 密钥转 `revoked` 后,以其签名的信封 MUST 立即以 `OMEW_KEY_REVOKED` 拒绝,不设宽限期(§2.4)。**以被吊销密钥签名的历史事件保持有效**,吊销不追溯撤销既有内容。

### 6.6 失败模式

- 验签所需密钥在本地缺失、拉取失败或校验不通过时,处理结果 MUST 为**拒绝**。MUST NOT fail-open,MUST NOT 缓存空结果后放行。

### 6.7 账号所有权密钥

所有权密钥是账号归属的冷根。它与 §6.1–§6.6 的实例密钥是两套独立体系:实例密钥签名事件与文档,所有权密钥只签名所有权操作。

- 用途 MUST 严格限定为迁移证明(§7.8)与所有权密钥轮换。日常事件签名 MUST 仍由实例密钥完成(§2.3),所有权密钥 MUST NOT 进入热路径。
- 私钥 MUST 由客户端以 CSPRNG **随机**生成,MUST NOT 由服务端生成,MUST NOT 以明文形式传输至服务端。
- **私钥 MUST NOT 从任何口令确定性派生。** 两条理由:所有权公钥被全网钉扎且公开可见,确定性派生使任何人可对该公钥做离线字典攻击,弱口令直接被算出私钥;登录口令在常规登录流中会被 home 观测,派生方案使恶意 home 可直接推得私钥,「home 无法单方面转走账号」的核心性质随之失效。
- home MUST 只持有两项:公钥(随档案文档与 §7.4 sideload 传播)与一份口令加密的私钥密文。密文的加密钥 MUST 在客户端经 Argon2id 从**所有权口令**派生,该口令 MUST NOT 发送给任何服务器。**home MUST NOT 具备解密该密文的能力。**
- 密文 MUST 在注册时保存,并 MUST 可由账号本人随时导出。客户端 MUST 另提供明文私钥导出,且 MUST 与私钥一同导出其边表副本(§7.7)。
- **登录凭证与所有权口令 MUST 分离。** 推荐形态为 passkey 登录:用户唯一需记忆的口令即所有权口令,天然不经网络。退回密码登录的部署 MUST 采用与所有权口令不同的登录口令,或 MUST 明示降级风险——恶意 home 可截获登录口令并解密托管密文。OPAQUE 类 PAKE 为后续增强,v1 不做。
- 密文的离线破解面仅在 home 数据库泄露时存在(密文不公开),由 Argon2id 高成本参数缓解。
- 口令与导出备份俱失时,该账号 MUST 视为丧失迁移能力;其 home 托管的登录与日常使用 MUST NOT 因此受影响。
- `key_history` 条目形状:

```json
{"key_id": "", "public_key": "", "created_at": 0, "prev_key_id": "", "continuity_sig": ""}
```

- `public_key` 为 32 字节原始公钥的无填充 base64url 编码,`key_id` 规则同 §6.1。
- 轮换 MUST 由旧钥对新钥签名,机制与 §6.3 同构,域分隔前缀独立:

```
ownership_input = UTF8("openmew/ownership/v1") || 0x00 ||
                  JCS({actor, key_id, public_key, created_at, prev_key_id})
continuity_sig  = Ed25519(sk_prev, ownership_input)
```

- 接收端 MUST 沿 `prev_key_id` 链回溯至本地已钉扎的所有权公钥。链断、签名不符或回溯至未钉扎密钥 MUST 拒绝(`OMEW_OWNERSHIP_PROOF_INVALID`),MUST NOT 自动接受新钥。
- 实例首次经档案文档或 `objects.users` sideload 见到某 actor 的 `ownership_key` 时 MUST 钉扎 `(actor, key_id, public_key)`,规则同 §6.4:同一 `key_id` 出现不同 `public_key` MUST 拒绝并告警。**钉扎是灾难迁移可被独立验证的前提**,MUST NOT 省略。
- 所有权密钥不设吊销事件。密钥泄露的处置是尽快轮换;链上后继密钥进入钉扎后,MUST 仅接受链尾密钥发起的所有权操作。旧钥同时失控时,唯一路径是 §7.8 的常规迁移(需 home 放行),密钥单独不足以即刻夺取账号。

---

## 7 联邦会话

实时聊天走**客户端直连**:用户客户端持有多组 `(origin, token)`,直接与各实例的 API 与 Room DO 建连。S2S 保留为慢路径(密钥与档案发现、身份事件、跨实例 tips 汇聚、公开帖子流复制、审核事件、历史回填)。

### 7.1 断言 schema

用户注册实例(A)向其用户签发短时效断言,目标为另一实例(B):

```json
{
  "v": 1,
  "typ": "openmew.assertion.v1",
  "iss": "a.example",
  "sub": "@alice:a.example",
  "aud": "b.example",
  "jti": "",
  "iat": 0,
  "exp": 0,
  "profile_version": 0,
  "key_id": "",
  "sig": ""
}
```

```
assertion_input = UTF8("openmew/assertion/v1") || 0x00 || JCS(assertion_without_sig)
```

- `exp − iat` MUST ≤ 300 s。
- `aud` MUST 逐字节等于接收实例自身的域,否则 MUST 拒绝(`OMEW_AUDIENCE_MISMATCH`)。此校验防止断言被转投至第三实例。
- `sub` 的域 MUST 等于 `iss`。断言属身份域,§7.5 规则 2 适用。
- `jti` MUST 在实例内唯一。B MUST 在 `[iat, exp + 2W]` 区间内记录已用 `jti`,重复出现 MUST 拒绝(`OMEW_ASSERTION_REPLAY`)。
- 断言 MUST 经 §6 的 key set 验签,MUST NOT 接受未知 `iss`。

### 7.2 `POST /federation/session`

请求体为断言对象。B 的处理顺序 MUST 为:

1. 限流
2. 体积检查
3. 解析
4. `aud` 校验
5. `iss` 已知性校验
6. **`iss` blocklist 校验**——命中 MUST 返回 403 `OMEW_PEER_BLOCKED`(§8.5)
7. 验签
8. `exp` / `jti` 校验
9. **`sub` 在本实例的状态校验**——`profile_status: deactivated` MUST 返回 403 `OMEW_ACTOR_DEACTIVATED`;命中实例级封禁 MUST 返回 403 `OMEW_BANNED`。据点级封禁 MUST NOT 阻止会话签发,但被封禁据点 MUST NOT 出现在 token 的 `roles` claims 中,其房间与据点握手 MUST 返回 `OMEW_BANNED`
10. 宾客身份 upsert
11. 签发会话

响应:

```json
{
  "token": "",
  "actor": "@alice:a.example",
  "guest": true,
  "exp": 0,
  "instance": "b.example"
}
```

- 会话 token 生命周期 MUST ≤ 24 h。续期 MUST 需要新断言。
- 客户端 MUST 通过 CORS 跨域调用,MUST NOT 依赖 cookie。token MUST NOT 存放于可被其他源读取的位置。
- 实现 MUST NOT 使用 iframe 承载跨实例会话。第三方存储分区会使其失效,且引入远端 JS 执行面。

### 7.2a 实例本地认证增强(非规范性附录)

§7.9a 建立的注册口令仍为账户唯一根凭据、亦为托管密文的唯一锚点;本节定义的 TOTP 与 WebAuthn 通行密钥是叠加在该根凭据之上的**实例本地**认证便利,均不参与联邦、均不能独立解封或改写托管密文,且同时失去两项增强因子(若已启用)在保留口令的前提下不构成锁死——除非启用了 TOTP,口令登录本身始终保留为兜底路径,此时 TOTP 码是口令登录流程的必需第二因子。

- **TOTP**(RFC 6238,HMAC-SHA1,30 秒周期,6 位数字)是仅叠加在既有口令登录流程上的可选第二因子,不构成独立登录路径。验证码 MUST 在 ±1 时间步窗口内被接受,且同一账户的某一时间步至多被消费一次(以已记录的最近接受步防重放),对应「被截获的一次性码不得被无限期重放」的一般原则。
- WebAuthn 通行密钥是可选的、独立的、免口令登录路径——不叠加于口令或 TOTP 登录之上。通行密钥认证成功即直接签发会话。通行密钥凭据 scope 至本实例的 RP ID,不参与身份联邦、不与 m0-protocol 所有权密钥对派生或绑定,除产出与口令登录等效的会话 token 外不授予任何额外能力。

两种机制均不改变会话 token 本身的形状或生命周期(§7.2 既有的 24 h TTL bearer 会话 token,无论经由哪条登录路径签发均一致)。

### 7.3 会话 token claims

```json
{
  "v": 1,
  "actor": "@alice:a.example",
  "aud": "b.example",
  "guest": true,
  "roles": {"<stronghold_id>": "owner|mod|member"},
  "exp": 0,
  "jti": ""
}
```

WebSocket 握手用的房间级 token MUST 另行签发,claims MUST 额外绑定:

- `room`:目标 `room-ref`,以及其 DO id
- `deny`:整数位掩码,语义与 §3.4 同一套位定义,签发时取据点成员行的当前值;`owner` 与 `mod` MUST 签发为 `0`
- `exp`:MUST ≤ 300 s
- `jti`

规则:

- WS token MUST 经 `Sec-WebSocket-Protocol` 子协议头或连接后首帧传递,MUST NOT 出现在 URL query 中。query 会进入访问日志与 Referer。
- Room DO MUST 在握手时验签一次,并将 `{actor, room, role, deny, last_seq}` 写入 WS attachment(`role` 取自 token `roles` 中本据点的值,供 owner/mod 特权操作判定——如删除他人条目、置顶——免查库)。后续消息 MUST 只读 attachment,MUST NOT 每条消息查库。
- Room DO MUST 按 `deny` 位与房间 `type` 逐类判定写操作:`type: channel` 的 `item.create` 受位 `1` 约束;`type: section` 且 `parent_seq` 为空的 `item.create` 受位 `2` 约束;`parent_seq` 非空的 `item.create` 受位 `4` 约束。拒绝时 MUST 返回 `OMEW_FORBIDDEN`。
- attachment 上限为 16 KiB,实现 SHOULD 仍保持最小状态。
- 限流 MUST 按 `actor` 而非按连接施加 token bucket。

**据点级 WS token**

- 据点级 WS token 与房间级同构,claims 绑定 `stronghold`(及 StrongholdDO id)而非 `room`,并携带当前有效据点 `role` 以裁剪 `restricted` tips;`exp` MUST ≤ 300 s,MUST NOT 授予任何写权限。
- StrongholdDO MUST 拒绝携带房间级 token 的握手,Room DO MUST 拒绝携带据点级 token 的握手;不匹配 MUST 返回 `OMEW_SESSION_INVALID`。该 token 用于 §10.6 的 tips 通道。

**撤销传播**

- StrongholdDO 在处理 `member.ban`、`member.remove`、`member.update`、`user.deactivate` 与 blocklist 变更时,MUST 向该据点下持有该 actor 连接的 Room DO 投递本地帧 `member.revoke {actor, scope, effect}`(`effect` ∈ `close` / `update_deny`)。
- Room DO 收到后 MUST 立即改写或作废对应连接的 attachment;`effect: close` 时 MUST 以 `OMEW_SESSION_INVALID` 关闭连接。
- 会话与 WS token 的失效 MUST 经本路径实现,MUST NOT 依赖 token 自然过期。握手时验签一次的优化因此不与 §7.6、§3.4、§8.5 的即时失效要求冲突。
- `member.revoke` 为本地类型,MUST NOT 出现在联邦链路上,MUST NOT 占用 seq,MUST NOT 写入去重表。
- **残余风险窗口(MUST 明示)**:撤销传播在本实例内即时生效,但已签发、尚未与本实例交互的 token 仍在其 `exp` 前有效。残余窗口上界为房间 / 据点 WS token 的 300 s 与宾客会话 token 的 24 h。规范不假装该窗口为零;需要更短窗口的部署 MUST 通过缩短 `exp` 取得。

### 7.4 档案 sideload

- 据点域信封 MAY 携带 `objects.users`,内容为事件涉及 actor 的档案摘要数组:`[{actor, profile_version, display_name, avatar, ownership_key}]`。
- 接收端 MUST 按 `profile_version` upsert 进本地 `remote_users` 缓存,MUST 丢弃版本不高于本地的条目。
- 首见的 `ownership_key` MUST 按 §6.7 钉扎;与已钉扎链不符的条目 MUST 丢弃并告警,MUST NOT 覆盖已钉扎值,MUST NOT 因此丢弃信封其余内容。
- sideload 是 `user.update` 丢失时的对账通道。实现 MUST NOT 引入独立的档案同步协议。

### 7.5 actor 绑定规则

**规则 1a(home 作为据点域事件的产生方)**

- home 在把客户端帧转为据点域信封前 MUST 确认该 actor 持有本实例签发且未失效的会话。
- 外域 actor 的会话 MUST 曾由其注册实例的有效断言建立,且该注册实例 MUST NOT 在 blocklist 中。
- 不满足 MUST 拒绝(`OMEW_SESSION_INVALID`)。
- `envelope.actor` MAY 为外域;`envelope.origin` MUST 为 home 自身的域。

**规则 1b(peer 作为据点域事件的接收方)**

- peer MUST 校验 `envelope.origin` 与本地记录的 `(room-ref → home)` 映射一致,不一致 MUST 拒绝(`OMEW_ACTOR_MISMATCH`)。
- peer MUST NOT 对 `envelope.actor` 施加任何域一致性检查。actor 的会话真实性由 home 背书,peer 无从也无需验证——这正是下方「信任代价」一节的直接后果。
- 校验对象是本地映射而非信封自身:`room-ref` 不含域,拿信封的 `origin` 去解析信封自己的 `room` 是恒真式,不构成检验。

**规则 2(身份域事件)**

- `user.*` 与 `member.join_request` 事件的 `envelope.actor` 的域 MUST 逐字节等于 `envelope.origin`,否则 MUST 拒绝(`OMEW_ACTOR_MISMATCH`)。为 `@u:X` 说话的唯一合法签名者是 X。
- 会话断言适用同一规则(`sub` 域 == `iss`)。
- 唯一例外是宾客实例回报的 `user.link_confirm` 与 `user.unlink`(§7.7):二者 MUST 省略 `actor`,其 payload `subject` 的域 MUST 逐字节等于**接收方**自身的域,`envelope.origin` MUST 等于接收方边表中该边的 `peer_instance`。不满足 MUST 拒绝(`OMEW_ACTOR_MISMATCH`)。
- `user.moved` 不构成例外:其 `actor` 为迁移后的新 actor,域等于 `origin`(新 home);旧 actor 出现在 payload `old` 中,其归属由 §7.8 的所有权证明背书,MUST NOT 由 `origin` 背书。

**信任代价(MUST 明示)**

直连模式下,B 收到的是会话内明文,**B 的运营者可在其自有房间内伪造宾客 actor 的发言**。信任级别等同于中心化平台的服主。实现 MUST 在用户首次向外部实例建立会话时以 UI 明示这一点。断言的短时效仅限制了「无会话期伪造」的可抵赖性,不构成防护。

### 7.6 宾客身份生命周期

- B 在首次成功的 `POST /federation/session` 时创建宾客身份行。

**宾客身份行**(键 `actor`):

| 字段 | 类型 | 权威方 | 说明 |
|---|---|---|---|
| `actor` | string | — | PK,规范化全限定串 |
| `registered_origin` | string | — | 注册实例域,恒等于 `actor` 的域 |
| `profile_version` | integer | 注册实例 | 单调递增,upsert 依据 |
| `display_name` | string | 注册实例 | 档案缓存,NFC |
| `avatar` | string | 注册实例 | `media-ref` |
| `profile_status` | enum | 注册实例 | `active` / `deactivated` |
| `ownership_key` | object | 所有权密钥 | 已钉扎的当前所有权公钥条目,§6.7;注册实例 MUST NOT 单方面改写 |
| `first_seen_at` | integer | 本实例 | 首次建立会话时刻 |
| `last_assertion_at` | integer | 本实例 | 最近一次有效断言时刻 |
| `sessions_revoked_at` | integer | 本实例 | 最近一次批量撤销时刻(§7.3) |

**成员状态子表**(键 `(actor, stronghold_id)`):

| 字段 | 类型 | 权威方 | 说明 |
|---|---|---|---|
| `role` | enum | 本实例 | `owner` / `mod` / `member` |
| `deny` | integer | 本实例 | 位掩码,§3.4;`owner` / `mod` 恒为 `0` |
| `restricted` | boolean | 本实例 | 受限惩戒 |
| `banned_at` | integer | 本实例 | 黑名单,空表示未封禁 |
| `application_state` | enum | 本实例 | `pending` / `approved` / `rejected`,§3.4 |

- 标注为注册实例权威的列 MUST NOT 被本实例写入;标注为本实例权威的列 MUST NOT 被任何联邦事件改写。
- **权威划分 MUST 严格遵守**:注册实例权威 = 档案与存在性;B 权威 = 该 actor 在 B 各据点内的成员状态与惩戒。任一方 MUST NOT 越界改写对方权威数据。
- 收到 `user.deactivate` 后,B MUST 立即失效该 actor 的全部会话与 WS token(经 §7.3 的撤销传播路径),MUST 拒绝新会话建立(`OMEW_ACTOR_DEACTIVATED`)。宾客身份行与历史内容 MUST 保留(内容删除需另发 `item.delete`)。
- 注册实例永久下线时,其用户在 B 的宾客身份成为孤儿:已有成员状态与历史归属 MUST 保留可读,新会话 MUST 无法建立(断言不可验)。恢复路径为 §7.8 的灾难迁移:账号凭所有权密钥迁往新 home 后,B MUST 按 §7.8 把该宾客身份行重指向新 home,成员状态与惩戒 MUST 原样保留。

### 7.7 网状边注册表

宾客身份的建立是双向确认的握手,不是单向缓存。注册实例(A)持有**边表**,记录其用户在哪些实例持有宾客身份;宾客实例(B)持有反向指针,即 §7.6 的 `registered_origin`。

**边表行**(键 `(actor, peer_instance)`):`{actor, peer_instance, state, created_at, confirmed_at}`,`state` 枚举 `pending` / `confirmed`。

- A 在签发 `aud = B` 的断言时 MUST 写入 `state: pending` 的边,并 SHOULD 向 B 投递 `user.link`。
- B 首次为该 actor 创建宾客身份行后 MUST 向 A 投递 `user.link_confirm`;A 收到并通过 §7.5 规则 2 的例外校验后 MUST 置 `state: confirmed` 与 `confirmed_at`。
- B 清理闲置宾客身份时 MUST 投递 `user.unlink`,A 校验后 MUST 删除该边。B 在该 actor 仍持有有效成员状态或未结审核状态时 MUST NOT 发出 `user.unlink`。
- `user.update`、`user.deactivate` 与迁移公告的 fan-out MUST 沿边表投递,MUST NOT 依据「有关系的实例」这类模糊集合。`confirmed` 边 MUST 投递,`pending` 边 SHOULD 一并投递(宾客身份可能已建而确认在途)。
- 边表 MUST NOT 作为访问控制依据。授权恒由 §7.2 的会话与 §3.4 的成员表决定。A MUST NOT 据边表推断 B 内的成员状态;「我的据点」聚合视图的成员明细 MUST 由各 B 的读端点按 §8.2 提供。
- **客户端副本**:客户端 MUST 在每次成功的 `POST /federation/session` 后本地记录该边,并 MUST 维护一份可导出的边表副本(与所有权私钥同为导出数据,§6.7)。home MUST 向账号本人提供边表的读取与导出,供客户端对账。旧 home 永久下线时,该客户端副本是 §7.8 灾难路径唯一的边来源。
- 投递失败不构成不一致:丢失的确认由该用户下一次断言签发重新写入 `pending` 边,并由 B 的下一次 `user.link_confirm` 收敛。

### 7.8 账号迁移

迁移把账号的 home 从 A 换到 C。归属由所有权密钥(§6.7)背书,**MUST NOT 依赖 A 存活**。

**发起者**:用户,或 A 自身(计划性关停 / 迁站场景,由 A 提供边表并出具下述 `home_release` 配合)。任一情形下所有权证明 MUST 由所有权私钥签名,A MUST NOT 在无该签名时转移账号。

**传播责任在新权威**:所有权转移至 C 后,**C MUST 对边表中每个关联实例逐一发起并解决挑战握手**。C MUST 跟踪每边状态、对失败边重试直至全部解决,并 SHOULD 向用户呈现迁移进度。边表来源:常规路径取自 A,灾难路径取自客户端副本(§7.7)。

#### 7.8.1 挑战握手端点

两个端点 MUST 由每个实例提供。调用方为客户端(用户向 C 声明迁移)或新 home C(向各关联实例逐边解决);两种调用共用同一 schema。

**`POST /migration/challenge`** — 请求 `{old, new}`,响应:

```json
{"nonce": "", "challenge_origin": "b.example", "exp": 0}
```

- `nonce` MUST 为 ≥ 16 字节随机值的无填充 base64url 形式,MUST 一次性使用,`exp` 与签发时刻之差 MUST ≤ 600 s。
- `challenge_origin` MUST 逐字节等于**应答实例自身**的域。
- **每边 MUST 取新鲜 challenge**:`nonce` 与 `challenge_origin` 一同进入签名输入,使单一证明 MUST NOT 可跨边重放。

**`POST /migration/proof`** — 请求体:

```json
{
  "old": "@alice:a.example",
  "new": "@alice:c.example",
  "nonce": "",
  "challenge_origin": "b.example",
  "signed_at": 0,
  "ownership_key_id": "",
  "key_history": [],
  "home_release": {},
  "sig": ""
}
```

```
claim_input = UTF8("openmew/migration-claim/v1") || 0x00 ||
              JCS({old, new, nonce, challenge_origin, signed_at})
```

- `sig` MUST 由 `old` 的链尾所有权私钥产生。`key_history` MUST 携带自接收方已钉扎密钥起的完整轮换链(§6.7)。
- 接收端 MUST 依次校验:`challenge_origin` 等于自身域;`nonce` 为本端签发、未过期、未使用;`key_history` 链完整且回溯至本地钉扎值;`sig` 验证通过。任一失败 MUST 返回 403 `OMEW_OWNERSHIP_PROOF_INVALID`;`nonce` 过期或已用 MUST 返回 409 `OMEW_CHALLENGE_STALE`(调用方 MUST 重取 challenge 后重试)。
- **无本地钉扎的所有权公钥时 MUST 拒绝**(`OMEW_OWNERSHIP_PROOF_INVALID`),MUST NOT 退化为信任 C、MUST NOT 向 A 发起询问。
- `home_release` MUST NOT 进入 `claim_input`:它由 A 独立签名,接收端独立验签(§7.8.2)。接收端 MUST 以 `home_release` 是否存在且验签通过判定路径,`user.moved` 的 `mode` MUST 与该判定一致。
- C 侧受理迁移前 MUST 以同一流程验证发起者。C 的验证不构成对外权威,各关联实例 MUST 独立重做。
- 本端点由 C 调用时 MUST 携带 §8.3.1 的联邦请求签名;由客户端调用时 MUST 在本实例的注册或会话流内完成鉴权。

#### 7.8.2 双路径与生效

- `home_release` 为 A 签发的、`moved_to` 等于 `new` 的 `user.update` 信封完整副本。接收端 MUST 按 §2.3 独立验签该嵌套信封,MUST 校验其 `origin` 等于 `old` 的域。**嵌套信封为证据而非投递事件**:MUST 豁免 §2 的 ts ±W 新鲜度校验(逐边握手可跨小时至数天,慢边必然超窗),改为校验其 `ts` 距受理时刻 MUST ≤ 30 天(防陈年放行凭据复用);MUST NOT 写入去重表,MUST NOT 经此路径当作独立 `user.update` 应用——档案变更仍由正常 S2S 投递承载。
- **常规路径(`dual_sign`)**:证明携带 `home_release`。验证通过 MUST 立即重指向。
- **灾难路径(`disaster`)**:证明不携带 `home_release`。接收端 MUST 记为 `pending` 并置 `effective_at` = 对应 `user.moved` 信封 `ts` + 604800000(7 天公示期);未收到 `user.moved` 时以本端首次受理该证明的时刻起算。UI SHOULD 显示「迁移待生效」。
- 公示期内该 actor 在本实例的既有会话、成员状态与惩戒 MUST 不受影响;针对该 `old` 的重复迁移请求 MUST 返回 409 `OMEW_MIGRATION_PENDING`。
- `effective_at` 届满且未收到有效异议时,接收端 MUST 自行完成重指向,MUST NOT 要求 C 重新握手——该边已在证明受理时解决。
- **异议冻结**:公示期内收到 A 以其实例密钥签发、`target_id` 匹配的 `user.move_objection` 时,接收端 MUST 冻结该迁移:MUST NOT 重指向,并 MUST 对同一 `old` 的后续 `disaster` 证明返回 409 `OMEW_MIGRATION_FROZEN`。`effective_at` 之后送达的异议 MUST 忽略。
- **冻结为终局态**:协议 MUST NOT 自动裁决归属冲突。解除的唯一路径是收到同一 `old` 的常规路径证明(即 A 出具 `home_release`),此外 MUST 由带外流程处理。

#### 7.8.3 `user.moved` 与生效后的状态

- `user.moved` 由 C 沿边表广播,payload `{old, new, mode, proof, home_release?, ownership_key?, effective_at}`。`new` MUST 等于 `envelope.actor`,`mode` 枚举 `dual_sign` / `disaster`,`ownership_key` 仅在迁移同时轮换所有权密钥时携带(MUST 含 `continuity_sig`)。
- **`user.moved` 是公告与公示期载体,不是生效手段**:接收端 MUST NOT 仅据它重指向宾客身份,重指向 MUST 经 §7.8.1 的挑战握手。它的作用是公告迁移存在、锚定 `effective_at` 使异议有挂靠对象、并让边表外的 peer(如帖子流订阅方)更新展示归属。
- 重指向生效后:宾客身份行的 `registered_origin` MUST 改指 C;成员状态、惩戒、申请状态与历史归属 MUST 原样保留,MUST NOT 重置;边表 MUST 由 C 按 §7.7 与各关联实例重新握手建立。
- 旧 actor 串 MUST 记入新档案文档的 `also_known_as`。历史事件的 `actor` 字段 MUST 保持原值,MUST NOT 改写——已签名内容不可改写,历史归属经 `also_known_as` 解析。
- 生效后接收端 MUST 拒绝以 `old` 为 `sub` 的新断言(`OMEW_ACTOR_DEACTIVATED`),即使 A 复活并继续签发。

### 7.9 实例身份策略

实例 MUST 持有以下三项可配置策略,由实例管理员管理:

- **`allow_root`**(是否作为根节点):`false` 的实例 MUST 拒绝本地注册(不充当任何身份的注册权威),仅承载宾客身份与据点内容;其作为据点域 `origin` 的资格不受影响。
- **`root_requirements`** ⊆ {`email`, `phone`, `code`}:作为根节点时的注册门槛,逐项强制。`phone` 为**保留枚举值**——部署未接入短信通道时 MUST 返回明确错误,MUST NOT 静默跳过该项校验。
- **`trusted_identity_servers`**(承认哪些服务器的身份):域名列表,`"*"` 表示全部。`POST /federation/session` MUST 在验签**之前**按断言 `iss` 域比对该表;不在名单 MUST 返回 403 `OMEW_ORIGIN_NOT_TRUSTED`,且 MUST NOT 因此向该域发起密钥拉取(与 §11.2 未知 origin 零出站一致)。`"*"` 不豁免 §6 密钥验证与 §11 限流。将某域移出名单时,SHOULD 经 §7.3 撤销传播作废该域用户的现存会话;已落库的历史内容不受追溯。

- **`federation_peers`**(要加入的已知服务器):本实例主动发起联邦对等(订阅帖子流、目录聚合、历史回填等**出站**行为)的域名列表,由管理员配置。与 `trusted_identity_servers` 相互独立:后者管**身份准入**(谁的用户可来),本项管**内容对等**(我方主动连谁)。出站订阅与主动拉取 MUST 仅面向本列表中的域(与 §11.2 未知 origin 零出站一致);实例描述符的 `known_peers` 字段 SHOULD 以本列表为源。
- **`stronghold_creation`** ∈ {`open`, `restricted`, `application`}:据点创建策略——`open` 任何本地用户可建;`restricted` 仅管理员与指定名单(`stronghold_creators`)可建;`application` 须提交申请由管理员审批(三态 pending/approved/rejected,批准即以申请人为 owner 创建)。自运营模式下的实例治理项,属本地策略,不进联邦事件。

**策略载体**:上述全部实例策略(含 `allow_guest_browsing`、媒体限额)为**部署环境配置**(Worker env vars),由运营者在部署层设定,MUST NOT 提供运行时改写端点;应用侧管理界面 MAY 只读展示生效值。策略不进入信封与联邦事件;实例描述符(§6.1)MAY 以 `registration: open|invite|closed` 概要宣告注册开放度供客户端与目录展示。

### 7.9a 托管口令的默认合并(可用性修订)

§6.7 的所有权私钥托管口令 **MAY 默认复用登录口令**(注册界面不再单列),以降低注册摩擦;此时部署方接受「home 运营者可观测登录口令 → 理论上可解托管密文」的信任降级,MUST 在部署文档中如实声明。独立托管口令保留为进阶选项(硬化模式,恢复 §6.7 原语义)。两种模式下:私钥 MUST 仍为客户端随机生成(从口令派生仍被禁止,理由见 §6.7);**登录口令变更时,客户端 MUST 以旧口令解封、新口令重封托管密文并随改密请求一并提交**;解封失败(独立口令模式)则密文原样保留不动。

### 7.10 服务器级角色层

实例本地存在与据点角色正交的**服务器级角色**:`server_owner`(唯一,默认为首个本地注册用户)> `server_admin`(可多名,由 server_owner 任免)> 普通用户。层级语义:服务器拥有者 > 据点所有者 ≈ 服务器管理员 > 用户。

- server_owner 与 server_admin 在本实例**所有据点**默认持有据点管理身份:权限门 MUST 将其视同该据点 `owner`,**唯据点所有权转让除外**(仅真实据点 owner 或 server_owner 可发起);
- 服务器级角色为实例本地治理,MUST NOT 随联邦事件传播;宾客身份不获得任何服务器级角色;
- 会话 token MAY 携带 `server_role` 快照供展示或非授权用途,但本地可变服务器角色用于授权时 MUST 重新读取权威状态,或使用等价的会话版本 / 撤销机制保证降级即时生效;其 WS 撤销遵循 §7.3 撤销传播。

### 7.10a 服务器级用户组

服务器级角色(§7.10)之下,实例可定义任意数量的**服务器级用户组**,取代此前据点本地的自定义组机制。用户组横跨全部据点生效,仅可分配给**本实例本地注册用户**——宾客身份(§7.6)不可被分组。

**模型**

- 每个组持有:`name`、`color`(可选 `#RRGGBB`)、`position`(合成序,升序)、三个权限位 `allow_speak`/`allow_post`/`allow_reply`(三态:`-1` 拒绝 / `0` 不表态 / `1` 允许,语义对应 §3.4 `deny` 位掩码的 `1`/`2`/`4`)、`is_moderator` 标志。
- 一个本地用户 MAY 同时持有多个组。

**合成序**

对某据点内某 actor 的有效角色/deny,MUST 按以下顺序合成:

1. **据点成员基线**:该 StrongholdDO 权威成员表中的 `role`/`deny`(§7.10 之前既有语义不变)。`role` 非 `member`(即 `owner`/`mod`)时,组不参与合成,`deny` MUST 取 `0`。
2. **服务器组叠加**(仅当基线 `role = member` 时生效):按 `position` 升序遍历该用户持有的全部服务器组,每个非 `0` 的 `allow_speak`/`allow_post`/`allow_reply` 覆盖前序结果;任一持有组 `is_moderator = 1` 时,整体结果升格为 `mod`,`deny` MUST 取 `0`,后续 deny 位不再计算。
3. **成员级 deny 位**(§3.4 既有的单据点惩戒位)最后叠加,仅新增拒绝,不撤销组或基线已给出的允许。
4. **server_role owner/admin 短路**(§7.10):具备该服务器级角色的 actor,在本步骤之前即直接判定为该据点 `owner` 等效、`deny = 0`——据点所有权转让除外,组与基线合成对其不生效。

宾客 actor(§7.6)不持有服务器组,合成时其组集合恒为空集,只经历步骤 1、3、4。

**撤销传播**

服务器组的定义变更(权限位、`is_moderator`、`position`、删除)或分配变更(用户加入/移出某组)MUST 触发 §7.3 的撤销传播:对受影响的每个本地用户,逐一查询其在 D1 `stronghold_member_index` 中登记的全部据点 id,向每个据点的 StrongholdDO 触发既有撤销管线(重算该 actor 的有效角色/deny 并下发 `member.revoke` 本地帧,含房间 WS 改写/断连与 §10.6 tips WS 断连)。组定义级变更(权限位/`is_moderator`/`position`/删除)按该组当前全部成员展开为逐用户撤销。该批量撤销为 fire-and-forget,不阻塞管理操作本身的响应;失败的单据点推送不影响其余据点。

**管理面与展示**

- 服务器组的增删改查、排序、成员分配/撤销为服务器级管理面(server_role owner/admin)操作,MUST NOT 出现在据点级管理面。
- 供成员列表、消息徽章等展示场景使用的批量只读查询(actor 的组归属)MAY 对游客开放,受 `allow_guest_browsing` 策略(§7.9)约束,与 §7.9 讨论的其余只读展示面一致。

### 8.1 配置

- Room 配置 MUST 含 `type`(`channel` / `section`)与 `capabilities` 数组。新房间形态 MUST 通过取值扩展表达。
- Channel 与 Section 共用同一 seq 分配、存储 schema、归档与批广播实现。Channel 是「所有 `parent_seq IS NULL`」的退化情形。
- 实现 MUST NOT 为帖子回复单独开 DO。

### 8.2 可见性

- 可见性为**据点级**设置:`visibility: public | private`。房间继承所属据点的可见性,MUST NOT 单独覆盖。
- 唯一例外是房间 flag `restricted: true`(§3.6):该类房间仅 `owner` / `mod` 可见可入,MUST NOT 联邦,MUST NOT 进入目录、搜索或未授权角色的 tips 汇总;本地 `owner` / `mod` MAY 接收。v1 MUST NOT 实现逐房间可见性矩阵。
- `public` 据点:历史读取 MAY 无鉴权,响应 SHOULD 带 `Cache-Control` 以吃边缘缓存。
- `private` 据点:一切读路径 MUST 经鉴权代理,MUST 按成员关系授权。客户端 MUST NOT 获得对象存储的直连凭证。
- 搜索端点与 tips 端点 MUST 按同一可见性规则裁剪结果。

### 8.3 历史回源鉴权

- peer 向 home 回源历史时,home MUST 按据点可见性 + 请求方成员关系授权,MUST NOT 仅校验「请求方是已知联邦实例」。
- `public` 据点:peer 取得的历史分片 MAY 永久缓存至其自有存储。
- `private` 据点:历史 MUST 仅由 home 服务。peer MUST 以代理转发方式提供,MUST NOT 落盘持久化,内存 / 短 TTL 缓存 SHOULD ≤ 300 s。
- 回源请求 MUST 携带 §8.3.1 的联邦请求签名,并 MUST 标明代其请求的 actor。home MUST 按该 actor 在本据点的成员状态判定。
- 历史回源响应 MUST 携带分片元数据 `{shard_key, shard_version, seq_start, seq_end}`;peer 缓存分片时 MUST 连同 `shard_version` 一并存储(§9.3)。

### 8.3.1 联邦请求签名

联邦 GET 端点没有信封可签,MUST 使用独立的请求签名:

```
request_input = UTF8("openmew/request/v1") || 0x00 ||
                JCS({method, path, query, origin, on_behalf_of, ts, nonce})
```

经请求头携带:

```
Authorization: OpenMew key_id=…,ts=…,nonce=…,on_behalf_of=…,sig=…
```

- `ts` 适用 §11.4 的 ±300 s 新鲜度窗口,窗口外 MUST 拒绝(`OMEW_STALE_TS`)。
- `(origin, nonce)` 适用 §4.3 的去重保留期 R,重复 MUST 拒绝。
- `on_behalf_of` 为 §8.3 判定成员关系所依据的 actor;其域 MUST 可由 `origin` 背书(同 §7.5 规则 1a 的会话要求)。
- `path` 与 `query` MUST 取规范化后的字节形式;`room-ref` 在 `path` 中按 §1.5 展开为三段。
- 签名缺失或验证失败 MUST 返回 403 `OMEW_BAD_SIGNATURE`;`origin` 未配置为对端 MUST 返回 403 `OMEW_UNKNOWN_ORIGIN`。
- 本签名 MUST 用于所有联邦 GET 端点:历史回填(§10.3)、分片回源、媒体代理(§1.6),以及实例间调用的迁移握手端点(§7.8.1),后者的 `on_behalf_of` MUST 为迁移后的新 actor。

### 8.4 可见性变更

- **转 private 仅对未来生效。** 公开期间已被拉取或缓存的历史 MUST 视为无法追回。协议 MUST NOT 承诺撤回能力,实现 MUST 在变更确认界面明示这一点。
- 转 private 后,home MUST 立即对所有回源请求施加鉴权,MUST 停止签发无鉴权缓存响应,SHOULD 向已注册订阅的 peer 推送一次 `stronghold.update`。
- 转 public 时,历史 MUST 默认维持原可见性。owner MAY 显式选择一并公开历史,该操作 MUST 经二次确认。

### 8.5 退联邦

- 退联邦为本地策略,通过 blocklist 表达。实现 MUST NOT 向被阻断方发送预告事件。
- 生效后 home MUST:停止向该 peer 出站投递、删除其订阅注册、拒绝其入站信封(`OMEW_PEER_BLOCKED`,403)、拒绝其历史回源(`OMEW_FORBIDDEN`,403)、拒绝其用户的会话断言(`OMEW_PEER_BLOCKED`,§7.2 第 6 步)、**立即失效该 peer 名下全部 actor 的会话 token 与 WS 连接(经 §7.3 的撤销传播路径)**、**清除本地持有的该 peer private 据点历史的全部内存与短 TTL 缓存(MUST NOT 保留)**。
- 已缓存历史的处置:本地已缓存的对端 public 历史 MAY 保留(其内容原本即公开);对端已缓存的本方历史无法追回,规则同 §8.4。
- blocklist 变更 MUST 记入审计日志。

---

## 9 删除与编辑

### 9.1 tombstone 与 revision 两张侧表

- 删除以 `item.delete` 事件表达,MUST 签名,MUST 占用 seq。
- tombstone MUST 存放于**独立侧表**,MUST NOT 随归档淘汰。仅在热表行上打删除标记会使超出热窗口的内容永久不可删。
- 编辑同构:`item.update` MUST 写入 `revision(seq, body, edited_at, actor)` 侧表,同一 `seq` 为 upsert,冲突时 LWW by `edited_at`。该侧表同样 MUST NOT 随归档淘汰。归档分片正文不可变(§9.2),没有 revision 侧表则超出热窗口的内容永久不可编辑,或分片与实际内容长期不一致。
- 任何返回 item 的读路径(热表、归档分片、搜索、联邦回源)MUST 先叠加 revision 侧表取最新正文,再叠加 tombstone 侧表过滤。
- v1 的 `item.delete` MUST 只针对单条 `target_seq`。批量删除由发起方展开为多条事件。
- **侧表增长上限**:tombstone 侧表 MUST 按 `seq` 区间分段;某区间内的删除已固化进重写后的归档分片(该分片 `shard_version` 已 bump,§9.3)后,该段 MAY 淘汰,其余分段 MUST 永久保留。revision 侧表在其 `seq` 的最新正文被固化进重写分片后,该行 MAY 淘汰,否则 MUST 永久保留。容量量级:每条 tombstone 约 16 B,百万级删除约 16 MB,远低于 DO 的 10 GB 上限——分段淘汰是为长尾兜底,不是常规必需。

### 9.2 分片不可变

- 「分片不可变」的准确含义是**正文不可变**:归档到对象存储的 NDJSON 分片 MUST NOT 因常规删除或常规编辑而重写。
- 归档索引 MUST 含 `shard_version` 列。

### 9.3 硬删除逃生通道

法务级硬删除(需要正文从存储中真正消失)MUST 按以下顺序执行:

1. 重写受影响分片,剔除目标正文,写入新对象;同时清理该 `seq` 的 revision 侧表行;
2. bump 索引中的 `shard_version`;
3. 向已注册订阅的 peer 推送 `item.delete`,payload 增加 `shard_version`(该 item 所属分片重写后的新版本号)。

peer 收到后 MUST 比对本地缓存的分片版本(§8.3 的分片元数据),不一致 MUST 立即丢弃该分片缓存并按 §8.3 重取,MUST NOT 继续提供旧版本内容。

### 9.4 联邦合规义务

- peer 收到 `item.delete` MUST 在本地缓存、索引与搜索中标记删除,MUST NOT 继续向其用户提供该 item 正文。
- 协议无法强制不合规的 peer。唯一手段是 §8.5 的 blocklist。实现 MUST 在据点转公开的确认界面告知这一限度。

### 9.5 媒体对象回收(范围声明)

- v1 MUST NOT 实现媒体引用计数。
- `item.delete` 与 §9.3 的硬删除流程只承诺移除 item **正文**(热表行、revision 行、tombstone 叠加、必要时的分片重写)。被引用的媒体对象本身不在协议的删除范围内,其删除留给运营者工具处理。
- §1.6 的 `(media-id, room-ref)` 引用表仅用于鉴权,MUST NOT 被当作回收依据。
- 实现 SHOULD 在删除确认界面明示这一限度,MUST NOT 向用户承诺媒体已从存储中消失。

---

## 10 投递

### 10.1 队列

- 据点级 fan-out 与联邦出站投递 MUST 走 Queues,MUST NOT 在单个请求内循环 fetch。
- 出站 MUST 分批,批大小 MUST 可配置,MUST NOT 硬编码为据点上限值。
- 队列保留期到期即丢失投递。实现 MUST 声明其 Q 值(§4.3),对端宕机超过 Q 的场景 SHOULD 由 D1 outbox 兜底或由接收端经 §10.3 回填自愈。
- 投递重试耗尽的事件 MUST 进入死信队列并 MUST 产生结构化告警,MUST NOT 静默丢弃。接收端 MUST NOT 依赖出站投递保证补齐空洞,补齐路径恒为 §10.2 的乱序缓冲 + §10.3 的历史回填。

### 10.2 高水位与乱序缓冲

- peer MUST 按 `(origin, room)` 维护接收高水位。
- 收到 seq 高于高水位 + 1 的事件时,peer MUST 放入乱序缓冲而非直接展示。缓冲 SHOULD ≤ 200 条且 ≤ 30 s。
- 缓冲超时仍未补齐的空洞 MUST 触发历史 API 回填(§8.3)。
- 展示顺序 MUST 为 origin seq 序。

### 10.3 历史回填

- 回填以 `GET /rooms/{stronghold-id}/{ch|sec}/{res-id}/history?before=<seq>&limit=<n>` 表达,`limit` MUST ≤ 200。路径按 §1.5 展开,MUST NOT 把 `room-ref` 整体百分号编码。
- 联邦调用方 MUST 携带 §8.3.1 的请求签名。
- 回填结果 MUST 经 §9.1 的 revision 与 tombstone 叠加,MUST 经 §8.3 的可见性授权。
- 请求区间跨越尚未补齐的空洞时 MUST 返回 409 `OMEW_SEQ_GAP`,响应体 MUST 标明可用区间。

### 10.4 bump

- `item.bump` MUST 为**幂等绝对快照**:携带该帖当前的 `last_reply_seq` 与 `reply_count` 全量值,MUST NOT 携带增量。
- 合并规则为 LWW by `last_reply_seq`。较小的 `last_reply_seq` MUST 被丢弃。
- `item.bump` payload MUST NOT 携带自己的 `ts`,时间以信封顶层 `ts` 为准(§2.1),新鲜度窗口校验同样只作用于信封 `ts`。
- `preview` 为 string,NFC,MUST ≤ 200 字符。生成前 MUST 按 §9.1 叠加 revision 与 tombstone 侧表:已删除回复的正文 MUST NOT 出现在 preview 中,已编辑回复 MUST 取最新正文。preview 是绕过读路径过滤的旁路,必须显式封堵。
- 同一帖的 bump 发送间隔 MUST ≥ 2 s,窗口内 MUST 合并为一条。
- 客户端在(重)连接时 MUST 重拉一次分区排序索引作兜底,MUST NOT 仅依赖 bump 流维持排序。
- `item.bump` MUST NOT 占用 seq,MUST NOT 写入去重表(其幂等性由绝对快照语义保证)。

### 10.5 WebSocket 与批广播

- Room DO MUST 使用 Hibernation API(`state.acceptWebSocket()`),MUST NOT 使用 `server.accept()`。
- MUST NOT 使用 SSE。流式响应在 DO 上等同进行中请求,不受 hibernation 支持。
- 批广播合并窗口 SHOULD 为 50–100 ms。**窗口 timer MUST 只在存在待发批次时存在**:首条消息才 schedule,冲刷即 clear。常驻 timer 会使每个活跃房间成为常醒 DO。
- 客户端心跳 MUST 使用 `setWebSocketAutoResponse`,MUST NOT 用应用层消息实现。
- 顺序不变量见 §5.2。

### 10.6 tips 通道

- 在线客户端 MUST 向 StrongholdDO 建立一条休眠 WebSocket 接收 tips 推送,握手 MUST 使用 §7.3 的**据点级 WS token**。
- HTTP 轮询 MUST 降级为离线兜底与首屏一次性 GET,间隔 SHOULD ≥ 20 s。轮询作为常态通道会打穿请求配额。
- tips 状态 MUST 持久化于 StrongholdDO storage,冲刷由 alarm 兜底。
- tips 汇总 MUST 按 §8.2 与据点级 token 的当前有效 `role` 裁剪;`restricted` 房间 MUST NOT 发送给宾客或普通成员,本地 `owner` / `mod` MAY 接收。

---

## 11 Inbox 硬约束

### 11.0 端点

| 端点 | 方法 | 用途 |
|---|---|---|
| `/federation/inbox` | POST | 接收单信封,或 `{"batch": [envelope, …]}` 批量;批量上限依 §11.1 |
| `/federation/subscriptions` | POST | 注册 / 续订,请求体为签名对象 `{room, peer_instance, ttl}` |
| `/federation/subscriptions/{stronghold-id}/{ch\|sec}/{res-id}` | DELETE | 退订 |
| `/federation/session` | POST | 会话断言交换,§7.2 |
| `/migration/challenge` | POST | 签发迁移挑战 nonce,§7.8.1 |
| `/migration/proof` | POST | 受理所有权证明并解决该边,§7.8.1 |

- 投递目标固定为 `https://{peer_instance}/federation/inbox`。协议不接受自定义回调 URL。
- 全部端点 MUST 经 HTTPS 提供。GET 类联邦端点(历史、分片、媒体代理)MUST 按 §8.3.1 签名。

### 11.1 验签前

以下检查 MUST 在验签之前、按序执行:

1. 按对端 IP 与 `origin` 的粗粒度限流。超限 MUST 返回 429。
2. 请求体大小检查:单信封 MUST ≤ 64 KiB;批量请求 MUST ≤ 100 条且 ≤ 1 MiB。超限 MUST 返回 413。
3. 请求超时上限。
4. 严格 JSON 解析(拒绝重复键、拒绝尾随内容)。

验签成功前,响应 MUST NOT 携带任何实例内部信息(存在性、成员、房间列表、错误细节)。

### 11.2 未知 origin

- 未知 `origin` 的信封 MUST 直接返回 403 `OMEW_UNKNOWN_ORIGIN`。
- **未知 origin MUST NOT 触发任何出站请求**,包括密钥拉取与档案拉取。否则 Inbox 成为 SSRF 与反射放大的入口。
- 密钥拉取 MUST 仅对已配置的对端发起。

### 11.3 订阅注册

- 订阅注册与退订请求 MUST 验签。
- 订阅请求中声明的 `peer_instance` MUST 逐字节等于签名信封的 `origin`,不满足 MUST 拒绝(`OMEW_CALLBACK_DOMAIN`)。投递目标由 `peer_instance` 与固定路径 `/federation/inbox` 唯一确定,实现 MUST NOT 接受请求方指定的任意 URL——未校验归属的投递目标是 bump 反射 DDoS 的载体。
- 订阅表 MUST 存放于对应 Room DO 的 storage,记录 `(peer_instance, expires_at)`。续订为 upsert,fan-out 时 MUST 过滤过期行。
- 每对端订阅数 MUST 设配额上限(`OMEW_SUBSCRIPTION_QUOTA`)。
- 订阅 TTL SHOULD ≤ 7 d。
- `restricted: true` 的房间 MUST 拒绝一切订阅注册(§3.6)。

### 11.4 重放

- ts 新鲜度窗口 MUST 为 ±300 s。窗口外的信封 MUST 拒绝。
- 去重表保留期 MUST ≥ 2W + Q(§4.3)。保留期短于新鲜度窗口会使合法信封在淘汰后原样重放成功。
- peer MUST 按 `(origin, room)` 维护接收高水位;回退超出乱序缓冲范围的事件 SHOULD 记为异常。seq 是房间级计数器,per-origin 的单一高水位不成立。

---

## 12 错误码表

错误响应体 MUST 为 `{"code": "...", "message": "...", "retriable": bool}`。`message` MUST NOT 泄露内部状态。

| code | HTTP | 语义 | 可重试 |
|---|---|---|---|
| `OMEW_RATE_LIMITED` | 429 | 触发限流 | 是(退避) |
| `OMEW_ENVELOPE_TOO_LARGE` | 413 | 信封或批量体积超限 | 否 |
| `OMEW_MALFORMED` | 400 | JSON 解析失败 / 重复键 / 字段类型错 | 否 |
| `OMEW_UNSUPPORTED_VERSION` | 400 | `v` 不受支持 | 否 |
| `OMEW_NOT_CANONICAL` | 400 | 标识符非规范化形式 | 否 |
| `OMEW_STALE_TS` | 400 | `ts` 超出新鲜度窗口 | 是(校时后) |
| `OMEW_UNKNOWN_ORIGIN` | 403 | `origin` 未配置为对端 | 否 |
| `OMEW_PEER_BLOCKED` | 403 | 对端在 blocklist 中 | 否 |
| `OMEW_KEY_UNKNOWN` | 403 | `key_id` 本地不存在,或已 `retired` 且超出宽限期(§6.3) | 否 |
| `OMEW_KEY_REVOKED` | 403 | 签名密钥已吊销(§6.5) | 否 |
| `OMEW_KEY_CONTINUITY_BROKEN` | — | 轮换连续性链校验失败。本地状态,不作 HTTP 响应;其对入站请求的外显形式为 `OMEW_KEY_UNKNOWN` | 否 |
| `OMEW_KEY_PIN_MISMATCH` | — | 已钉扎 key_id 的公钥发生变化。本地状态,不作 HTTP 响应;外显同上 | 否 |
| `OMEW_BAD_SIGNATURE` | 403 | 签名验证失败(信封 §2.3 或请求 §8.3.1) | 否 |
| `OMEW_ACTOR_MISMATCH` | 403 | actor 绑定规则不满足(§7.5) | 否 |
| `OMEW_AUDIENCE_MISMATCH` | 403 | 断言 `aud` 不等于本实例 | 否 |
| `OMEW_ASSERTION_EXPIRED` | 401 | 断言过期 | 是(换新断言) |
| `OMEW_ASSERTION_REPLAY` | 403 | `jti` 重复 | 否 |
| `OMEW_SESSION_INVALID` | 401 | 会话 token 无效、已失效或类型不匹配(§7.3) | 是(重建会话) |
| `OMEW_ORIGIN_NOT_TRUSTED` | 403 | 断言 `iss` 域不在接收实例的 `trusted_identity_servers` 名单(§7.9) | 否 |
| `OMEW_ACTOR_DEACTIVATED` | 403 | actor 已被其注册实例停用,或已迁移至新 home(§7.8) | 否 |
| `OMEW_OWNERSHIP_PROOF_INVALID` | 403 | 所有权证明签名无效、密钥链断裂,或本地无钉扎公钥可验(§6.7 / §7.8.1) | 否 |
| `OMEW_CHALLENGE_STALE` | 409 | 迁移挑战 `nonce` 未知、过期或已使用 | 是(重取 challenge) |
| `OMEW_MIGRATION_PENDING` | 409 | 迁移处于公示期,尚未生效(§7.8.2) | 是(公示期满后) |
| `OMEW_MIGRATION_FROZEN` | 409 | 迁移已被旧 home 异议冻结,冻结为终局态(§7.8.2) | 否 |
| `OMEW_FORBIDDEN` | 403 | 成员关系、角色或 `deny` 位不足 | 否 |
| `OMEW_BANNED` | 403 | 该 actor 在本据点被封禁 | 否 |
| `OMEW_ROOM_NOT_FOUND` | 404 | 房间不存在、不可见,或媒体未在该房间中被引用 | 否 |
| `OMEW_TARGET_NOT_FOUND` | 404 | `target_seq` 不存在或不属于本房间 | 否 |
| `OMEW_ITEM_DELETED` | 409 | 对已删除 item 发起 `item.update` | 否 |
| `OMEW_REPLY_DEPTH` | 400 | 回复深度超过一层 | 否 |
| `OMEW_MEDIA_DIGEST_MISMATCH` | 422 | 媒体内容摘要与引用不符 | 否 |
| `OMEW_MEDIA_TOO_LARGE` | 413 | 附件超过实例上限 | 否 |
| `OMEW_MIME_REJECTED` | 415 | MIME 不在白名单 | 否 |
| `OMEW_CALLBACK_DOMAIN` | 400 | 订阅声明的 `peer_instance` 与签名 `origin` 不一致 | 否 |
| `OMEW_SUBSCRIPTION_QUOTA` | 429 | 对端订阅数超配额 | 是(退避) |
| `OMEW_NAME_CONFUSABLE` | 409 | 用户名 skeleton 与既有名碰撞 | 否 |
| `OMEW_NAME_TAKEN` | 409 | 用户名已占用 | 否 |
| `OMEW_SEQ_GAP` | 409 | 历史回填请求区间跨越未补齐的空洞(§10.3) | 是 |
| `OMEW_NOT_IMPLEMENTED` | 501 | 类型已定义但本实例未实现 | 否 |

未知 `type` 与未知 `kind` 不是错误,不在本表内,处置见 §13.2。

---

## 13 前向兼容与版本协商

### 13.1 版本

- `v` 为协议**主版本**,仅在破坏性变更时递增。
- `v` 不匹配 MUST 拒绝(`OMEW_UNSUPPORTED_VERSION`),MUST NOT 尝试降级解析。
- 非破坏性扩展 MUST NOT 递增 `v`,一律通过新事件类型 + 能力宣告引入。

### 13.2 未知类型与未知字段

- 未知 `type` MUST 静默忽略:不落库、不分配 seq、不触发 fan-out、不返回错误(202 + `{status: "ignored", reason: "unknown_type"}`)。
- 未知 `kind` 按未知类型同等处理,ack 的 `reason` 为 `"unknown_kind"`。**忽略不是错误**:`OMEW_KIND_UNSUPPORTED` 不是错误码,MUST NOT 出现在 §12 的错误码表或错误响应体中;它只作为 ack 的诊断标签存在。
- **未知类型 MUST NOT 写入去重表。** 去重表只记录已实际处理的事件;为忽略的事件写入去重记录会在对端升级后阻止其重投的正常处理。忽略是幂等的 no-op,重复忽略无害。
- 未知**字段** MUST 参与验签(§2.3),MAY 在语义上忽略,MUST NOT 在转发前剥离。
- 未知 `capabilities` 值 MUST 忽略。

### 13.3 能力宣告

- 实例能力经 `/.well-known/openmew/instance` 的 `capabilities` 数组宣告。
- 房间能力经 `stronghold.room.*` 的 `capabilities` 数组宣告。
- **实例能力与房间能力为两套独立注册表,同名字符串在两套中语义无关。** 实例能力 MUST 以 `federation.` / `media.` 等前缀限定;房间能力 MUST 为无前缀裸串。据点级 MUST NOT 承载能力宣告(§3.6)。
- 发送方 SHOULD 在投递前查询对端能力并跳过其不支持的事件类型;未查询直接投递也 MUST 安全(接收端静默忽略)。
- 能力名 MUST 为稳定字符串,一经发布 MUST NOT 改变语义。

### 13.4 命名保留

- 事件类型名、`kind` 值、`capabilities` 值、`key_id`、`res-id` 一经发布 MUST NOT 复用于不同语义。
- 能力位 `reactions` 已由 §3.2a 激活;已延后的能力位 `pins`(§3.8)与 `speak_gate`(§3.4)予以保留。
- 全部域分隔前缀(`openmew/event/v1`、`openmew/instance-descriptor/v1`、`openmew/user-profile/v1`、`openmew/assertion/v1`、`openmew/key-rotation/v1`、`openmew/key-revocation/v1`、`openmew/request/v1`、`openmew/ownership/v1`、`openmew/migration-claim/v1`)一经发布 MUST NOT 改变语义,新增用途 MUST 取新前缀。

---

## 附录 A 测试向量

全部向量已生成,位于 `test/vectors/m0-vectors.json`,由 `scripts/gen-vectors.mjs` 生成、`scripts/verify-vectors.mjs` 独立重验(零依赖,Node ≥ 20,Ed25519 经 `node:crypto`)。每组向量含:输入信封 JSON、JCS 输出的十六进制字节、`signing_input` 的十六进制字节、测试密钥对、期望签名(含 MUST-fail 否定用例)。

测试密钥均为向量文件 `keys` 节中登记的确定性派生 TEST ONLY 材料,与任何真实实例或账号无关:

| 标签 | key_id |
|---|---|
| `a.example` 实例密钥(第 1/2/3 代) | `aWSFGSK3vFR5mRZHPFa5UQ` / `c32Hwuke-2S_3QcmzbECng` / `P4Iv0tZ58S48ugVXIwMB1w` |
| `b.example` 实例密钥 | `-lkZYaKrWWheYiiuN73A7g` |
| `c.example` 实例密钥 | `oqv4jKLgrKE7Zg_QC5B1Ug` |
| `d.example` 实例密钥 | `_aLgCH2Tbf31v8-pDxZlFA` |
| `@alice:a.example` 所有权密钥(第 1/2/3 代) | `VLdTNz7O27kJHcWTAZCz2g` / `lUEy_4GaYq8Zi12uFghQeA` / `j9w44fnQfxofHlsaCCZZtw` |

| 编号 | 覆盖点 | 状态 |
|---|---|---|
| TV-01 | 最小 `item.create`,纯 ASCII text | 已生成 |
| TV-02 | 含 `objects.users` sideload | 已生成 |
| TV-03 | 含非 ASCII 正文(CJK + emoji + 组合字符),校验 NFC 与 JCS 转义 | 已生成 |
| TV-04 | 含媒体对象与 `omew://` 引用 | 已生成 |
| TV-05 | 含未知扩展字段,验证签名覆盖与不剥离 | 已生成(含剥离字段后验签必败的否定用例) |
| TV-06 | 键序颠倒的等价输入,验证 JCS 输出一致 | 已生成 |
| TV-07 | 会话断言(`openmew/assertion/v1` 域分隔) | 已生成 |
| TV-08 | 轮换连续性签名链(三代密钥) | 已生成(含 retired 超宽限期拒绝的否定用例) |
| TV-09 | 边界整数(±(2^53 − 1))与超界拒绝 | 已生成(含超界拒绝的否定用例) |
| TV-10 | confusable localpart 碰撞样本集 | 已生成(§1.4 所举 ASCII 子集示例,非完整 UTS #39 表,详见脚本注释) |
| TV-11 | 实例描述符与用户档案文档签名(两个域分隔前缀) | 已生成 |
| TV-12 | 联邦请求签名(`openmew/request/v1`) | 已生成 |
| TV-13 | 所有权密钥轮换链(三代)与 `key_history` 校验(`openmew/ownership/v1`) | 已生成(含链断裂拒绝的否定用例) |
| TV-14 | 迁移证明签名与跨边重放拒绝(`openmew/migration-claim/v1`,两条边各一份 nonce) | 已生成(含跨边重放拒绝的否定用例) |
| TV-15 | `user.moved` 双路径信封:`dual_sign` 含嵌套 `home_release` 验签、`disaster` 含公示期与异议冻结 | 已生成(含异议冻结后二次证明拒绝的否定用例) |

## 附录 B 遗留待决项

| 项 | 影响 | 状态 |
|---|---|---|
| 代码 License | 联邦生态形态、首次公开提交 | **已决:AGPL-3.0**。network copyleft 条款与联邦开放目标一致;资产授权与代码解耦不变 |
| GitHub 组织名备选 | 首次公开提交 | 待人工确认(`openmew` 账号已被占用) |
| 「Mew」商标风险 | 命名与公开发布 | 待人工确认 |
| 账号跨实例迁移 | 孤儿宾客身份、账号可携带性 | 协议已定义(§6.7 / §7.7 / §7.8);密钥生成与托管落 M1,迁移流程实现落 M5+,不阻塞 M0 |

## 附录 C M0 冻结条件清单

| 条件 | 状态 | 阻塞冻结 |
|---|---|---|
| 附录 A 全部测试向量补齐并纳入一致性测试套件 | 已完成:`test/vectors/m0-vectors.json`,`scripts/verify-vectors.mjs` 独立重验通过 | **是** |
| 所有权密钥字段与迁移事件定名冻结(§6.1 / §6.7 / §7.7 / §7.8) | 已定 | **是**(事后补钥会弱化归属证明) |
| 代码 License 确定 | 已决(AGPL-3.0) | 否 |
| GitHub 组织名备选确认 | 待人工确认 | 否(不影响协议文本) |
| 「Mew」商标风险确认 | 待人工确认 | 否(不影响协议文本) |
