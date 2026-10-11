import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../server/src/api";
import { base64UrlEncode, signToken } from "../server/src/auth";
import {
  ownKeys,
  pinPeerKeys,
  signDocument,
} from "../server/src/federation-keys";
import { signedRequestHeaders } from "../server/src/federation";
import { verifyObject, type Envelope } from "../server/src/federation-codec";
import {
  apiRequest,
  connectRoom,
  ensureMigrated,
  itemCreateFrame,
  nextMessage,
  nextMessageOfType,
  sessionToken,
  TEST_SECRET,
} from "./helpers";
import type { RoomTokenClaims } from "../server/src/types";

const identity = Object.assign({}, env, {
  INSTANCE_DOMAIN: "identity.example",
  FEDERATION_PEERS: "local",
});
const host = Object.assign({}, env, {
  INSTANCE_DOMAIN: "local",
  FEDERATION_PEERS: "identity.example",
  TRUSTED_IDENTITY_SERVERS: "identity.example",
});
beforeAll(async () => {
  await ensureMigrated();
  await pinPeerKeys(host, "identity.example", await ownKeys(identity));
});

describe("federation session boundaries", () => {
  it("pages large signed events within the history transport budget without losing sequences", async () => {
    const room = `history-budget/ch/${crypto.randomUUID()}`;
    const { ws, stub } = await connectRoom(
      room,
      "@historybudget:local",
      "owner",
    );
    const writer = await connectRoom(room, "@historywriter:local", "member");
    try {
      for (let index = 1; index <= 25; index++) {
        const sender = index % 2 ? ws : writer.ws;
        sender.send(itemCreateFrame(`large-${index}`, "x".repeat(45_000)));
        expect(await nextMessageOfType(sender, "ack")).toMatchObject({
          type: "ack",
          status: "ok",
          seq: index,
        });
      }
      let after = 0;
      const received: number[] = [];
      for (let page = 0; page < 5 && after < 25; page++) {
        const history = await stub.getFederationHistory(room, after, null, 200);
        expect(
          new TextEncoder().encode(JSON.stringify(history)).length,
        ).toBeLessThan(1_048_000);
        const events = history.events as Envelope[];
        expect(events.length).toBeGreaterThan(0);
        received.push(...events.map((event) => event.seq!));
        after = events.at(-1)!.seq!;
      }
      expect(received).toEqual(
        Array.from({ length: 25 }, (_, index) => index + 1),
      );
    } finally {
      ws.close();
      writer.ws.close();
    }
  });
  it("rejects an unsignable local body before acknowledging or allocating its sequence", async () => {
    const room = `canonical-body/ch/${crypto.randomUUID()}`;
    const { ws, stub } = await connectRoom(room, "@canon:local", "owner");
    for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      ws.send(
        JSON.stringify({
          type: "item.create",
          client_id: `invalid-${value}`,
          kind: "post",
          body: { text: "unsafe", width: value },
        }),
      );
      expect(await nextMessage(ws)).toMatchObject({
        type: "error",
        code: "OMEW_MALFORMED",
      });
    }
    ws.send(itemCreateFrame("canonical-ok", "e\u0301"));
    expect(await nextMessage(ws)).toMatchObject({
      type: "ack",
      status: "ok",
      seq: 1,
    });
    expect(await stub.getHistory(null, 10, null)).toMatchObject({
      items: [{ seq: 1, body: { text: "é" } }],
    });
    ws.close();
  });
  it("exchanges an audience-bound assertion once and keeps a same-name guest out of local account settings", async () => {
    await sessionToken("@collision:local", "owner");
    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const raw = (await crypto.subtle.exportKey(
      "raw",
      pair.publicKey,
    )) as ArrayBuffer;
    const profile = await signDocument(identity, "openmew/user-profile/v1", {
      v: 1,
      actor: "@collision:identity.example",
      profile_version: 0,
      display_name: "Foreign account",
      status: "active",
      created_at: 100,
      ownership_key: {
        key_id: base64UrlEncode(
          new Uint8Array(await crypto.subtle.digest("SHA-256", raw)).slice(
            0,
            16,
          ),
        ),
        public_key: base64UrlEncode(new Uint8Array(raw)),
        created_at: 100,
      },
      key_history: [],
    });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        expect(String(input)).toBe(
          "https://identity.example/.well-known/openmew/users/collision",
        );
        return new Response(JSON.stringify(profile));
      });
    const now = Math.floor(Date.now() / 1000);
    const assertion = await signDocument(identity, "openmew/assertion/v1", {
      v: 1,
      typ: "openmew.assertion.v1",
      iss: "identity.example",
      sub: "@collision:identity.example",
      aud: "local",
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
      profile_version: 0,
    });
    const exchange = (body: unknown, instance: Env = host) =>
      worker.fetch(
        new Request("https://local/federation/session", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        instance,
      );
    try {
      const untrusted = await exchange(assertion, {
        ...host,
        TRUSTED_IDENTITY_SERVERS: "",
      });
      expect(untrusted.status).toBe(403);
      expect(await untrusted.json()).toMatchObject({
        error: { code: "OMEW_ORIGIN_NOT_TRUSTED" },
      });
      expect(spy).not.toHaveBeenCalled();
      expect(
        (await exchange({ ...assertion, aud: "other.example" })).status,
      ).toBe(403);
      const response = await exchange(assertion);
      expect(response.status).toBe(200);
      const result = (await response.json()) as { token: string };
      expect((await exchange(assertion)).status).toBe(409);
      const forbidden = await worker.fetch(
        new Request("https://local/api/me/display-name", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${result.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ display_name: "Taken over" }),
        }),
        host,
      );
      expect(forbidden.status).not.toBe(200);
      const local = await env.DB.prepare(
        "SELECT display_name,server_role FROM users WHERE localpart='collision'",
      ).first();
      expect(local).toEqual({
        display_name: "collision",
        server_role: "owner",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a previously minted room token after a password epoch changes", async () => {
    const actor = "@socketepoch:local";
    const token = await sessionToken(actor);
    const stronghold = env.STRONGHOLD_DO.getByName("socket-epoch");
    await stronghold.initConfig("socket-epoch", "Epoch", "private", actor);
    await stronghold.createRoom("chat", "channel", "Chat", ["text"], false);
    const minted = await apiRequest(
      "/stronghold/socket-epoch/rooms/chat/token",
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    );
    const roomToken = (await minted.json()) as { token: string };
    await env.DB.prepare(
      "UPDATE users SET sessions_revoked_at=? WHERE localpart='socketepoch'",
    )
      .bind(Date.now() + 1)
      .run();
    const response = await env.ROOM_DO.getByName("socket-epoch/ch/chat").fetch(
      "https://local/ws",
      {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": roomToken.token,
        },
      },
    );
    expect(response.status).toBe(401);
    expect(response.webSocket).toBeNull();
  });

  it("checks current role and deny bits when a stale permission snapshot reconnects", async () => {
    const actor = "@socketpermission:local";
    await sessionToken(actor);
    const stronghold = env.STRONGHOLD_DO.getByName("socket-permission");
    await stronghold.initConfig(
      "socket-permission",
      "Permissions",
      "public",
      "@operator:local",
    );
    await stronghold.createRoom("chat", "channel", "Chat", ["text"], false);
    await stronghold.addMember(actor, "member", 1);
    const claims: RoomTokenClaims = {
      v: 1,
      typ: "room",
      actor,
      room: "socket-permission/ch/chat",
      role: "owner",
      deny: 0,
      iat: Date.now(),
      exp: Math.floor(Date.now() / 1000) + 300,
      jti: crypto.randomUUID(),
    };
    const response = await env.ROOM_DO.getByName(claims.room).fetch(
      "https://local/ws",
      {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": await signToken(claims, TEST_SECRET),
        },
      },
    );
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    ws.send(itemCreateFrame("stale-permission", "must be denied"));
    expect(await nextMessage(ws)).toMatchObject({
      type: "error",
      code: "OMEW_FORBIDDEN",
    });
    ws.close();
  });
});

describe("signed storage and private content boundaries", () => {
  it("pages every legacy item before advancing to the signed event stream", async () => {
    const room = "legacy-contract/ch/general";
    const stub = env.ROOM_DO.getByName(room);
    await runInDurableObject(stub, (_instance, state) => {
      for (let seq = 1; seq <= 40; seq++)
        state.storage.sql.exec(
          "INSERT INTO item(seq,parent_seq,root_seq,actor,origin,client_id,kind,ts,body) VALUES (?,NULL,?,'@legacy:local','local',?,'post',100,?)",
          seq,
          seq,
          `legacy-${seq}`,
          JSON.stringify({ text: `Legacy message ${seq}` }),
        );
      state.storage.sql.exec("UPDATE meta SET value=41 WHERE key='next_seq'");
    });
    const found: number[] = [];
    let before: number | null = null;
    do {
      const page = await stub.getFederationHistory(room, 0, null, 16, before);
      expect(page.baseline).toBe(40);
      found.push(
        ...(page.snapshot as Array<{ seq: number }>).map((item) => item.seq),
      );
      before = (page.snapshot_next_before as number | undefined) ?? null;
    } while (before !== null);
    expect(found).toHaveLength(40);
    expect(new Set(found).size).toBe(40);
    expect(found.at(-1)).toBe(1);
  });
  it("broadcasts a verifiable envelope and keeps it in signed room history", async () => {
    const { ws: sender, stub } = await connectRoom(
      "signed-contract/ch/general",
      "@signedauthor:local",
    );
    const { ws: reader } = await connectRoom(
      "signed-contract/ch/general",
      "@signedreader:local",
      "member",
    );
    sender.send(itemCreateFrame("signed-message", "A signed message"));
    expect(await nextMessage(sender)).toMatchObject({
      type: "ack",
      status: "ok",
    });
    const frame = await nextMessage(reader);
    const envelope = (frame.items as Array<{ envelope: Envelope }>)[0]!
      .envelope;
    const keys = (await ownKeys(env)) as {
      keys: Array<{ key_id: string; public_key: string }>;
    };
    const key = keys.keys.find((key) => key.key_id === envelope.key_id)!;
    expect(
      await verifyObject("openmew/event/v1", envelope, key.public_key),
    ).toBe(true);
    expect(
      await verifyObject(
        "openmew/event/v1",
        { ...envelope, payload: { body: { text: "tampered" } } },
        key.public_key,
      ),
    ).toBe(false);
    const history = await stub.getFederationHistory(
      "signed-contract/ch/general",
      0,
      null,
      10,
    );
    expect(history.events).toEqual([envelope]);
    sender.close();
    reader.close();
  });

  it("refuses S2S history for a private room even when the signed caller is a member", async () => {
    const actor = "@collision:identity.example";
    const stronghold = env.STRONGHOLD_DO.getByName("private-replica");
    await stronghold.initConfig(
      "private-replica",
      "Private",
      "private",
      "@privateowner:local",
    );
    await stronghold.createRoom("posts", "section", "Posts", ["text"], false);
    await stronghold.addMember(actor);
    const path = "/rooms/private-replica/sec/posts/history";
    const response = await worker.fetch(
      new Request(`https://local${path}`, {
        headers: await signedRequestHeaders(identity, "GET", path, actor),
      }),
      host,
    );
    expect(response.status).toBe(403);
    await stronghold.updateConfig({ visibility: "public" });
    const publicResponse = await worker.fetch(
      new Request(`https://local${path}`, {
        headers: await signedRequestHeaders(identity, "GET", path, actor),
      }),
      host,
    );
    expect(publicResponse.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT r2_key FROM federation_events WHERE room='private-replica/sec/posts'",
      ).all(),
    ).toMatchObject({ results: [] });
  });
});
