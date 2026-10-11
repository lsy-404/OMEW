import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureMigrated } from "./helpers";
import {
  acceptEnvelope,
  handleFederationInbox,
  newEvent,
  readReplica,
  verifyEnvelope,
} from "../server/src/federation";
import {
  ownKeys,
  pinPeerKeys,
  rotateOwnKey,
} from "../server/src/federation-keys";
import {
  acceptMigrationProof,
  announceMigration,
  issueMigrationChallenge,
  settleMigrations,
} from "../server/src/account-migration";
import {
  keyId,
  ProtocolError,
  signObject,
  type JsonObject,
} from "../server/src/federation-codec";
import { localProfile, pinOwnership } from "../server/src/federation-profiles";
import { base64UrlEncode } from "../server/src/auth";

function instance(name: string, peer: string): Env {
  return Object.assign({}, env, {
    INSTANCE_DOMAIN: name,
    FEDERATION_PEERS: peer,
    TRUSTED_IDENTITY_SERVERS: peer,
  });
}
const home = instance("home.example", "peer.example");
const peer = instance("peer.example", "home.example");
async function inbox(value: unknown): Promise<Response> {
  return handleFederationInbox(
    new Request("https://peer.example/federation/inbox", {
      method: "POST",
      body: JSON.stringify(value),
      headers: { "CF-Connecting-IP": "198.51.100.10" },
    }),
    peer,
  );
}
beforeAll(async () => {
  await ensureMigrated();
  await pinPeerKeys(peer, "home.example", await ownKeys(home));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("unexpected outbound request"),
  );
});
afterAll(() => vi.restoreAllMocks());
describe("federation delivery contracts", () => {
  it("normalizes locally generated Unicode metadata before signing", async () => {
    const event = await newEvent(home, "stronghold.update", {
      stronghold: "unicode",
      name: "e\u0301",
    });
    expect(event.payload.name).toBe("é");
    expect(await verifyEnvelope(peer, event)).toMatchObject({
      payload: { name: "é" },
    });
  });
  it("applies only a contiguous room sequence and folds edits and deletion", async () => {
    const room = "replica/sec/posts";
    await env.DB.prepare(
      "INSERT INTO federation_rooms(origin,room,subscribed_until) VALUES (?,?,?)",
    )
      .bind("home.example", room, Date.now() + 60000)
      .run();
    const second = await newEvent(
      home,
      "item.create",
      {
        client_id: "second",
        kind: "reply",
        parent_seq: 1,
        body: { text: "reply" },
      },
      { room, seq: 2, actor: "@author:home.example" },
    );
    expect((await inbox(second)).status).toBe(202);
    expect(await readReplica(peer, "home.example", room)).toEqual([]);
    const first = await newEvent(
      home,
      "item.create",
      {
        client_id: "first",
        kind: "post",
        body: { title: "Contract", text: "original" },
      },
      { room, seq: 1, actor: "@author:home.example" },
    );
    expect((await inbox(first)).status).toBe(202);
    expect(
      (await readReplica(peer, "home.example", room)).map((item) => item.seq),
    ).toEqual([2, 1]);
    const edit = await newEvent(
      home,
      "item.update",
      {
        target_seq: 1,
        body: { title: "Contract", text: "corrected" },
        edited_at: Date.now(),
      },
      { room, seq: 3, actor: "@author:home.example" },
    );
    await inbox(edit);
    expect(
      (await readReplica(peer, "home.example", room)).find(
        (item) => item.seq === 1,
      )?.body,
    ).toEqual({ title: "Contract", text: "corrected" });
    await inbox(
      await newEvent(
        home,
        "item.delete",
        { target_seq: 1, by_role: "author" },
        { room, seq: 4, actor: "@author:home.example" },
      ),
    );
    expect(
      (await readReplica(peer, "home.example", room)).map((item) => item.seq),
    ).toEqual([2]);
    expect((await (await inbox(first)).json()) as unknown).toEqual({
      receipts: [{ id: first.id, status: "duplicate", seq: 1 }],
    });
  });
  it("rejects tampering, unknown origin and stale timestamps without discovery requests", async () => {
    const event = await newEvent(
      home,
      "user.link",
      { peer: "peer.example" },
      { actor: "@author:home.example" },
    );
    expect(
      (await inbox({ ...event, payload: { peer: "attacker.example" } })).status,
    ).toBe(403);
    expect((await inbox({ ...event, origin: "unknown.example" })).status).toBe(
      403,
    );
    expect(
      (
        await inbox(
          await newEvent(
            home,
            "user.link",
            { peer: "peer.example" },
            { actor: "@author:home.example", ts: Date.now() - 301000 },
          ),
        )
      ).status,
    ).toBe(400);
    expect((await inbox({ ...event, id: "bad-id" })).status).toBe(400);
  });
  it("ignores an unknown event without consuming its dedupe key", async () => {
    const event = await newEvent(home, "future.extension", { safe: true });
    expect((await (await inbox(event)).json()) as unknown).toEqual({
      receipts: [{ id: event.id, status: "ignored" }],
    });
    expect(
      await env.DB.prepare(
        "SELECT id FROM federation_seen WHERE origin=? AND id=?",
      )
        .bind(event.origin, event.id)
        .first(),
    ).toBeNull();
  });
  it("keeps pinned keys immutable and accepts a valid rotation chain", async () => {
    const keys = await ownKeys(home);
    const first = (keys.keys as JsonObject[])[0]!;
    const other = await ownKeys(instance("other.example", "peer.example"));
    await expect(
      pinPeerKeys(peer, "home.example", {
        ...keys,
        keys: [
          { ...first, public_key: (other.keys as JsonObject[])[0]!.public_key },
        ],
      }),
    ).rejects.toBeInstanceOf(ProtocolError);
    await rotateOwnKey(home);
    await pinPeerKeys(peer, "home.example", await ownKeys(home));
    expect(
      await verifyEnvelope(
        peer,
        await newEvent(
          home,
          "user.link",
          { peer: "peer.example" },
          { actor: "@author:home.example" },
        ),
      ),
    ).toEqual(expect.objectContaining({ origin: "home.example" }));
  });
});
describe("ownership migration", () => {
  it("requires a fresh proof for each edge and preserves sanctions after the notice period", async () => {
    const oldActor = "@migrant:home.example";
    const newActor = "@migrant:peer.example";
    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
    if (!(raw instanceof ArrayBuffer)) throw new Error("unexpected key format");
    const publicKey = base64UrlEncode(new Uint8Array(raw));
    const id = await keyId(publicKey);
    await pinOwnership(peer, oldActor, {
      key_id: id,
      public_key: publicKey,
      created_at: 100,
    });
    await env.DB.prepare(
      "INSERT INTO guest_identity(actor,registered_origin,profile_version,profile_status,first_seen_at,last_assertion_at) VALUES (?,?,0,'active',?,?)",
    )
      .bind(oldActor, "home.example", Date.now(), Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO users(localpart,display_name,status,created_at,server_role) VALUES ('migrant','Migrant','active',?,'user')",
    )
      .bind(Date.now())
      .run();
    const stronghold = env.STRONGHOLD_DO.getByName("migration-contract");
    await stronghold.initConfig(
      "migration-contract",
      "Migration",
      "public",
      "@operator:peer.example",
    );
    await stronghold.addMember(oldActor, "member", 3, true);
    await stronghold.banMember(oldActor, "@operator:peer.example");
    const before = await stronghold.getMember(oldActor);
    const challenge = await issueMigrationChallenge(peer, oldActor, newActor);
    const claim = {
      old: oldActor,
      new: newActor,
      nonce: challenge.nonce,
      challenge_origin: challenge.challenge_origin,
      signed_at: Date.now(),
    };
    const proof = {
      ...claim,
      ownership_key_id: id,
      key_history: [],
      sig: await signObject(
        "openmew/migration-claim/v1",
        claim,
        pair.privateKey,
      ),
    };
    await expect(
      acceptMigrationProof(
        peer,
        { ...proof, challenge_origin: "other.example" },
        newActor,
      ),
    ).rejects.toBeInstanceOf(ProtocolError);
    const result = await acceptMigrationProof(peer, proof, newActor);
    expect(result.state).toBe("pending");
    const announcement = await announceMigration(peer, newActor, proof, []);
    const retry = await announceMigration(peer, newActor, proof, []);
    expect(retry.id).toBe(announcement.id);
    expect(retry.ts).toBe(announcement.ts);
    await expect(
      acceptMigrationProof(peer, proof, newActor),
    ).rejects.toMatchObject({ code: "OMEW_CHALLENGE_STALE" });
    expect(await stronghold.getMember(oldActor)).toEqual(before);
    await env.DB.prepare(
      "UPDATE account_migrations SET effective_at=? WHERE old_actor=?",
    )
      .bind(Date.now() - 1, oldActor)
      .run();
    await settleMigrations(peer);
    const after = await stronghold.getMember(newActor);
    expect(after).toEqual({ ...before, actor: newActor });
    expect(await stronghold.getMember(oldActor)).toBeNull();
    expect((await localProfile(peer, newActor)).ownership_key).toEqual({
      key_id: id,
      public_key: publicKey,
      created_at: 100,
    });
    expect(
      await env.DB.prepare(
        "SELECT new_actor FROM actor_aliases WHERE old_actor=?",
      )
        .bind(oldActor)
        .first(),
    ).toEqual({ new_actor: newActor });
  });

  it("reports a membership conflict as pending after a valid dual-signed release", async () => {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const oldActor = `@m${suffix}:home.example`;
    const newActor = `@m${suffix}:peer.example`;
    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = base64UrlEncode(
      new Uint8Array(
        (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
      ),
    );
    const id = await keyId(publicKey);
    await pinOwnership(peer, oldActor, {
      key_id: id,
      public_key: publicKey,
      created_at: 100,
    });
    await env.DB.prepare(
      "INSERT INTO users(localpart,display_name,status,created_at,server_role) VALUES (?,?,'active',?,'user')",
    )
      .bind(`m${suffix}`, "Migration", Date.now())
      .run();
    const stronghold = env.STRONGHOLD_DO.getByName(`dual-${suffix}`);
    await stronghold.initConfig(
      `dual-${suffix}`,
      "Conflict",
      "private",
      "@operator:peer.example",
    );
    await stronghold.addMember(oldActor, "member", 3);
    await stronghold.addMember(newActor, "mod", 0);
    const challenge = await issueMigrationChallenge(peer, oldActor, newActor);
    const claim = {
      old: oldActor,
      new: newActor,
      nonce: challenge.nonce,
      challenge_origin: challenge.challenge_origin,
      signed_at: Date.now(),
    };
    const proof = {
      ...claim,
      ownership_key_id: id,
      key_history: [],
      sig: await signObject(
        "openmew/migration-claim/v1",
        claim,
        pair.privateKey,
      ),
      home_release: await newEvent(
        home,
        "user.update",
        { moved_to: newActor },
        { actor: oldActor },
      ),
    };
    const result = await acceptMigrationProof(peer, proof, newActor);
    expect(result).toMatchObject({
      mode: "dual_sign",
      state: "pending",
      error: expect.stringContaining("OMEW_MIGRATION_CONFLICT"),
    });
    expect(await stronghold.getMember(oldActor)).toMatchObject({
      role: "member",
      deny: 3,
    });
    expect(await stronghold.getMember(newActor)).toMatchObject({
      role: "mod",
      deny: 0,
    });
    expect(
      await env.DB.prepare(
        "SELECT new_actor FROM actor_aliases WHERE old_actor=?",
      )
        .bind(oldActor)
        .first(),
    ).toBeNull();
    await stronghold.removeMember(newActor);
    await settleMigrations(peer);
    expect(await stronghold.getMember(oldActor)).toBeNull();
    expect(await stronghold.getMember(newActor)).toMatchObject({
      role: "member",
      deny: 3,
    });
    expect(
      await env.DB.prepare(
        "SELECT state,error FROM account_migrations WHERE old_actor=?",
      )
        .bind(oldActor)
        .first(),
    ).toEqual({ state: "completed", error: null });
  });
});
