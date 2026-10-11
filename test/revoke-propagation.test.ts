import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DENY_CHANNEL_SPEAK } from "../server/src/types";
import {
  connectRoom,
  connectTips,
  ensureMigrated,
  itemCreateFrame,
  itemDeleteFrame,
  nextClose,
  nextMessage,
  nextMessageOfType,
  registerUser,
} from "./helpers";

const OWNERSHIP = { ownership_pubkey: "test-pubkey", ownership_ciphertext: "test-ciphertext-blob" };

// m0-protocol §7.3 revocation propagation: StrongholdDO pushes a local
// member.revoke frame to every room DO it owns whenever ban/kick/role-deny/group
// state changes, so an already-established WS connection is corrected or torn
// down immediately rather than waiting out its (<=300s) token exp. The room MUST
// be registered via StrongholdDO.createRoom for it to be a push target - same
// requirement as the existing edit-config push tests (stronghold-management.test.ts).

let strongholdSeq = 0;
async function freshStronghold(ownerActor: string): Promise<string> {
  const id = `revoke${Date.now()}${strongholdSeq++}`;
  const stub = env.STRONGHOLD_DO.getByName(id);
  await stub.initConfig(id, "Revoke Test Stronghold", "public", ownerActor);
  await stub.createRoom("general", "channel", "General", ["text"], false);
  return id;
}

beforeAll(async () => {
  await ensureMigrated();
});

describe("member.revoke propagation (m0-protocol §7.3)", () => {
  it("closes a banned member's live WS connection", async () => {
    const owner = "@revokeowner1:local";
    const target = "@revokebanned1:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(target, "member");
    const roomRef = `${id}/ch/general`;
    const { ws } = await connectRoom(roomRef, target, "member");

    // Subscribe before triggering the ban - StrongholdDO awaits the room push
    // synchronously, so the close can already have fired by the time banMember's
    // own promise resolves.
    const closePromise = nextClose(ws);
    await stub.banMember(target, owner);

    const closeEvent = await closePromise;
    expect(closeEvent.code).toBe(1008);
    expect(closeEvent.reason).toBe("OMEW_SESSION_INVALID");
  });

  it("closes a kicked member's live WS connection", async () => {
    const owner = "@revokeowner2:local";
    const target = "@revokekicked2:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(target, "member");
    const roomRef = `${id}/ch/general`;
    const { ws } = await connectRoom(roomRef, target, "member");

    const closePromise = nextClose(ws);
    const removed = await stub.removeMember(target);
    expect(removed).toBe(true);

    const closeEvent = await closePromise;
    expect(closeEvent.code).toBe(1008);
  });

  it("updates a live connection's deny bits so its next write is rejected", async () => {
    const owner = "@revokeowner3:local";
    const target = "@revokedeny3:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(target, "member", 0);
    const roomRef = `${id}/ch/general`;
    const { ws } = await connectRoom(roomRef, target, "member", 0);

    // Deny wasn't in effect at handshake time - this message goes through.
    ws.send(itemCreateFrame("m1", "before deny"));
    const ack1 = await nextMessage(ws);
    expect(ack1).toMatchObject({ type: "ack", status: "ok" });

    const updated = await stub.updateMember(target, { deny: DENY_CHANNEL_SPEAK });
    expect(updated?.deny).toBe(DENY_CHANNEL_SPEAK);

    // Same connection, no reconnect - attachment must already carry the new deny.
    ws.send(itemCreateFrame("m2", "after deny"));
    const err = await nextMessage(ws);
    expect(err).toMatchObject({ type: "error", code: "OMEW_FORBIDDEN" });
  });

  // Groups are server-level D1 rows (server_groups/user_server_groups)
  // rather than a per-DO table - inserted directly here to isolate this suite's
  // focus (StrongholdDO's revocation push) from the admin HTTP surface, which
  // has its own coverage in test/server-groups.test.ts. revokeActor is the
  // public entry point the admin routes call after a D1 group mutation.
  it("revokes a moderator group's live privilege without disconnecting the socket", async () => {
    const owner = "@revokeowner4:local";
    const target = "@revokemod4:local";
    const victim = "@revokevictim4:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    const groupId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO server_groups (id, name, color, position, allow_speak, allow_post, allow_reply, is_moderator, created_at) VALUES (?, 'Mods', NULL, 0, 0, 0, 0, 1, ?)"
    ).bind(groupId, Date.now()).run();
    await stub.addMember(target, "member");
    const localpart = target.slice(1, target.indexOf(":"));
    await registerUser({ username: localpart, password: "password123", ...OWNERSHIP });
    await env.DB.prepare("UPDATE users SET server_role='user' WHERE localpart=?").bind(localpart).run();
    await env.DB.prepare("INSERT INTO user_server_groups (localpart, group_id) VALUES (?, ?)").bind(localpart, groupId).run();

    const roomRef = `${id}/ch/general`;
    // Token mint (api.ts) would have resolved this member to "mod" via
    // effectiveRole at handshake time - simulated directly here, same as every
    // other connectRoom call in this suite.
    const { ws: modWs } = await connectRoom(roomRef, target, "mod");
    const { ws: victimWs } = await connectRoom(roomRef, victim, "member");

    victimWs.send(itemCreateFrame("m1", "first"));
    const ack1 = await nextMessageOfType(victimWs, "ack");
    const seq1 = ack1.seq as number;

    modWs.send(itemDeleteFrame(seq1));
    const deleteAck = await nextMessageOfType(modWs, "ack");
    expect(deleteAck).toMatchObject({ type: "ack", status: "ok", target_seq: seq1 });

    await env.DB.prepare("DELETE FROM user_server_groups WHERE localpart = ? AND group_id = ?").bind(localpart, groupId).run();
    await stub.revokeActor(target);

    victimWs.send(itemCreateFrame("m2", "second"));
    const ack2 = await nextMessageOfType(victimWs, "ack");
    const seq2 = ack2.seq as number;

    // Same socket, still open (this was update_deny, not close) - but the
    // privilege is gone now that the moderator group no longer applies.
    modWs.send(itemDeleteFrame(seq2));
    const forbidden = await nextMessageOfType(modWs, "error");
    expect(forbidden).toMatchObject({ type: "error", code: "OMEW_FORBIDDEN" });
  });

  it("leaves an unrelated member's connection untouched by another member's ban", async () => {
    const owner = "@revokeowner5:local";
    const target = "@revokebanned5:local";
    const bystander = "@revokebystander5:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(target, "member");
    await stub.addMember(bystander, "member");
    const roomRef = `${id}/ch/general`;
    const { ws: targetWs } = await connectRoom(roomRef, target, "member");
    const { ws: bystanderWs } = await connectRoom(roomRef, bystander, "member");

    const closePromise = nextClose(targetWs);
    await stub.banMember(target, owner);
    await closePromise;

    // The bystander's connection never got touched by target's revoke frame.
    bystanderWs.send(itemCreateFrame("m1", "still here"));
    const ack = await nextMessage(bystanderWs);
    expect(ack).toMatchObject({ type: "ack", status: "ok" });

    bystanderWs.close();
  });

  it("re-derives a held-group member's deny bits when groups are reordered", async () => {
    const owner = "@revokeowner6:local";
    const target = "@revokereorder6:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    // A (position 0) denies speak, B (position 1) allows it - synthesis applies
    // ascending positions with later ones winning, so the member starts allowed.
    const groupAId = crypto.randomUUID();
    const groupBId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO server_groups (id, name, color, position, allow_speak, allow_post, allow_reply, is_moderator, created_at) VALUES (?, 'A', NULL, 0, -1, 0, 0, 0, ?)"
    ).bind(groupAId, Date.now()).run();
    await env.DB.prepare(
      "INSERT INTO server_groups (id, name, color, position, allow_speak, allow_post, allow_reply, is_moderator, created_at) VALUES (?, 'B', NULL, 1, 1, 0, 0, 0, ?)"
    ).bind(groupBId, Date.now()).run();
    await stub.addMember(target, "member");
    const localpart = target.slice(1, target.indexOf(":"));
    await registerUser({ username: localpart, password: "password123", ...OWNERSHIP });
    await env.DB.prepare("INSERT INTO user_server_groups (localpart, group_id) VALUES (?, ?), (?, ?)")
      .bind(localpart, groupAId, localpart, groupBId)
      .run();

    const roomRef = `${id}/ch/general`;
    const { ws } = await connectRoom(roomRef, target, "member", 0);

    ws.send(itemCreateFrame("m1", "before reorder"));
    expect(await nextMessage(ws)).toMatchObject({ type: "ack", status: "ok" });

    // Swapping the two makes A's deny the last word - same socket must lose
    // speak without a reconnect.
    await env.DB.batch([
      env.DB.prepare("UPDATE server_groups SET position = 1 WHERE id = ?").bind(groupAId),
      env.DB.prepare("UPDATE server_groups SET position = 0 WHERE id = ?").bind(groupBId),
    ]);
    await stub.revokeActor(target);

    ws.send(itemCreateFrame("m2", "after reorder"));
    expect(await nextMessage(ws)).toMatchObject({ type: "error", code: "OMEW_FORBIDDEN" });
  });

  it("closes a banned member's tips WS on the stronghold itself", async () => {
    const owner = "@revokeowner7:local";
    const target = "@revoketips7:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(target, "member");

    // connectTips captures the first snapshot before accepting the client socket;
    // this test intentionally ignores it and only cares about close propagation.
    const { ws: targetTips } = await connectTips(id, target);
    const { ws: ownerTips } = await connectTips(id, owner);

    let ownerClosed = false;
    ownerTips.addEventListener("close", () => { ownerClosed = true; }, { once: true });

    const closePromise = nextClose(targetTips);
    await stub.banMember(target, owner);

    const closeEvent = await closePromise;
    expect(closeEvent.code).toBe(1008);
    expect(closeEvent.reason).toBe("OMEW_SESSION_INVALID");
    // The ban's revoke chain has fully unwound by here (synchronous await path),
    // so a wrongly-targeted close would already have fired.
    expect(ownerClosed).toBe(false);

    ownerTips.close();
  });

  it("propagates both role changes of an ownership transfer to live connections", async () => {
    const owner = "@revokeowner8:local";
    const heir = "@revokeheir8:local";
    const id = await freshStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(heir, "member");
    const roomRef = `${id}/ch/general`;
    const { ws: oldOwnerWs } = await connectRoom(roomRef, owner, "owner");
    const { ws: newOwnerWs } = await connectRoom(roomRef, heir, "member");

    newOwnerWs.send(itemCreateFrame("m1", "from the heir"));
    const ack1 = await nextMessageOfType(newOwnerWs, "ack");
    const seq1 = ack1.seq as number;

    const config = await stub.transferOwnership(owner, heir);
    expect(config?.owner_actor).toBe(heir);

    // The demoted owner's attachment lost its moderation power in place...
    oldOwnerWs.send(itemDeleteFrame(seq1));
    expect(await nextMessageOfType(oldOwnerWs, "error")).toMatchObject({ code: "OMEW_FORBIDDEN" });

    // ...but still writes as a plain member (deny 0).
    oldOwnerWs.send(itemCreateFrame("m2", "as a member now"));
    const ack2 = await nextMessageOfType(oldOwnerWs, "ack");
    expect(ack2).toMatchObject({ status: "ok" });
    const seq2 = ack2.seq as number;

    // The promoted owner's attachment picked the upgrade up without a reconnect.
    newOwnerWs.send(itemDeleteFrame(seq2));
    expect(await nextMessageOfType(newOwnerWs, "ack")).toMatchObject({ status: "ok", target_seq: seq2 });
  });
});
