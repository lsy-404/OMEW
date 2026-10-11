# Federation and account migration

## Configure two instances

Set `INSTANCE_DOMAIN` to each instance's actual DNS hostname, without a scheme or path. Each side lists the other in `FEDERATION_PEERS`. `TRUSTED_IDENTITY_SERVERS` controls admission of foreign identities independently. HTTPS is required between peers; redirect targets and unconfigured origins are rejected. The default peer list is empty.

The instance owner opens **实例互联与账号迁移 → 密钥与信任**, selects a configured peer, and discovers its keys. First discovery pins its key set. Later rotations require a signature chain from a pinned key. A separately verified key document can be pinned offline for disaster recovery. Blocking a peer revokes its guest sessions and connections.

The repository Wrangler configurations use two Queues. Create them before the first deployment:

```sh
pnpm exec wrangler queues create omew-federation
pnpm exec wrangler queues create omew-federation-dead
```

Stardust uses `stardust-omew-federation` and `stardust-omew-federation-dead`. Apply all D1 migrations before switching traffic. The five-minute scheduled handler repairs deliveries, renews subscriptions, fills history gaps, settles migrations, and retries SFU revocations. Overture installs the schedule and uses the persistent D1 outbox directly because its resource API does not provision Queues.

## Browse and subscribe

An authenticated local user opens **实例互联与账号迁移**, acknowledges the peer's ability to read plaintext and impersonate guests in its own rooms, then connects. The browser exchanges a short-lived assertion for a peer session and connects directly to the selected room's home. Peer tokens stay in memory. Public communities support joining, chat, posts, replies, image attachments, and voice when the room enables it.

Opening a remote section registers a renewable post-stream subscription. A signed event log, an ordered receiver high-water mark, a durable outbox, and signed history pages repair missed delivery. Unknown event types and local reactions do not enter the receiver's dedupe ledger. Private and restricted rooms do not supply cacheable federation history. Previously public copies cannot be recalled from another operator. Returning a private stronghold to public keeps its old history available to existing members while anonymous and newly joined readers see the new public history.

Private strongholds accept a join application by ID. Local applications appear in the stronghold administrator's member panel. Foreign applications are signed by the applicant's identity instance and delivered to the room home; the applicant must first establish a guest session there. Approval grants access; an application alone grants none.

## Export and migrate an account

Export the encrypted ownership key and edge list from **账号迁移** before losing the old home. Keep its ownership passphrase separately. A plaintext export is available only after unlocking the key; treat that export as a private key backup.

Register a fresh destination account and import the old backup before using the destination as a federated identity. A destination with an unrelated pinned ownership key or conflicting memberships cannot silently merge identities.

For a normal migration, the old account exports its signed home release naming the new actor. The destination checks both that release and the client's ownership signature. For a disaster migration, the destination must already trust the old instance key and the old ownership key; a backup by itself does not establish trust. The client signs a fresh challenge for the destination and for every old edge. A proof for one instance cannot be replayed at another.

Disaster proofs remain pending for seven days. An authenticated objection from the old home freezes the corresponding announcement. Announcements alone do not transfer membership. Accepted edges preserve roles, bans, restrictions, and historical authorship. Failed network deliveries remain visible and retry in the background; expired challenges need the unlocked client to sign again. Use **刷新迁移状态** to inspect remaining edges and local conflicts.

Migration moves ownership-key custody by re-encrypting the imported seed in the browser. Password recovery cannot decrypt or rewrap a key protected by an unknown old ownership passphrase; keep that passphrase or its backup.

## Signing keys and operations

Own instance keys are encrypted in D1 using `DEV_TOKEN_SECRET`. Back up that secret with the D1 dump and R2 objects. Changing it without rewrapping the stored instance keys makes those keys unavailable. Retired public keys remain available for historical signature verification; revoked keys cannot authenticate new traffic.

Queue failures emit structured `federation.delivery_failed` and `federation.dead_letter` logs. Capacity thresholds emit `operations.threshold_exceeded`; RoomDO reports at 8 GiB against its 10 GiB storage limit. Connect these events to the deployment's Cloudflare log alerts. D1 `federation_delivery` retains terminal deliveries with `state='dead'` for operator inspection.

The transport uses `OMEW-Origin` as explicit signer metadata; when omitted for a directly registered actor, the request verifier derives it from `on_behalf_of`. Request signatures cover the protocol's fixed method/path/query/origin/actor/time/nonce tuple. History responses carry an outer `openmew/history/v1` signature. Legacy room data bootstraps through signed snapshot pages using `snapshot_before` and `snapshot_next_before`, then resumes the signed event sequence.
