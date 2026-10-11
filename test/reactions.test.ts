import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DENY_CHANNEL_SPEAK } from "../server/src/types";
import {
  apiRequest,
  connectRoom,
  ensureMigrated,
  itemCreateFrame,
  itemDeleteFrame,
  itemReactionFrame,
  itemUpdateFrame,
  nextMessage,
  nextMessageOfType,
  postCreateFrame,
  replyCreateFrame,
  sessionToken,
} from "./helpers";

// m0-protocol §3.2a item.reaction: side-table engagement toggle, never occupies
// seq, absolute-count broadcast snapshot, not gated by deny bits.

beforeAll(async () => {
  await ensureMigrated();
});

let strongholdSeq = 0;
async function freshStronghold(ownerActor: string): Promise<{ id: string; roomRef: string }> {
  const id = `react${Date.now()}${strongholdSeq++}`;
  const stub = env.STRONGHOLD_DO.getByName(id);
  await stub.initConfig(id, "Reaction Test Stronghold", "public", ownerActor);
  await stub.createRoom("general", "channel", "General", ["text"], false);
  return { id, roomRef: `${id}/ch/general` };
}

async function freshSectionStronghold(ownerActor: string): Promise<{ id: string; resId: string; roomRef: string }> {
  const id = `reactsec${Date.now()}${strongholdSeq++}`;
  const resId = "posts";
  const stub = env.STRONGHOLD_DO.getByName(id);
  await stub.initConfig(id, "Reaction Section Test", "public", ownerActor);
  await stub.createRoom(resId, "section", "Posts", ["text"], false);
  return { id, resId, roomRef: `${id}/sec/${resId}` };
}

// The item.create batch and the item.reaction batch aren't guaranteed to land
// as one flush or two (depends on whether the create's own batch timer already
// fired) - drain batches until one actually carries an item.reaction frame,
// rather than assuming it's alone in the first batch that arrives.
async function findReactionBroadcast(ws: WebSocket, maxDrain = 10): Promise<Record<string, unknown>> {
  for (let i = 0; i < maxDrain; i++) {
    const batch = await nextMessageOfType(ws, "batch");
    const items = batch.items as Record<string, unknown>[];
    const found = items.find((entry) => entry.type === "item.reaction");
    if (found) return found;
  }
  throw new Error(`no item.reaction frame seen within ${maxDrain} batches`);
}

describe("item.reaction (m0-protocol §3.2a)", () => {
  it("adds a reaction and returns an absolute count snapshot to the sender", async () => {
    const owner = "@reactowner1:local";
    const { roomRef } = await freshStronghold(owner);
    const { ws } = await connectRoom(roomRef, owner, "owner");

    ws.send(itemCreateFrame("m1", "hello"));
    const ack = await nextMessage(ws);
    const seq = ack.seq as number;

    ws.send(itemReactionFrame(seq, "thumbsup", "add"));
    const snapshot = await nextMessage(ws);
    expect(snapshot).toMatchObject({
      type: "item.reaction",
      target_seq: seq,
      entries: [{ name: "thumbsup", count: 1 }],
      actor: owner,
      op: "add",
    });
  });

  it("treats a duplicate add as an idempotent no-op", async () => {
    const owner = "@reactowner2:local";
    const { roomRef } = await freshStronghold(owner);
    const { ws } = await connectRoom(roomRef, owner, "owner");

    ws.send(itemCreateFrame("m1", "hello"));
    const seq = (await nextMessage(ws)).seq as number;

    ws.send(itemReactionFrame(seq, "fire", "add"));
    await nextMessage(ws);
    ws.send(itemReactionFrame(seq, "fire", "add"));
    const second = await nextMessage(ws);
    expect(second).toMatchObject({
      type: "item.reaction",
      entries: [{ name: "fire", count: 1 }],
      op: "add",
    });
  });

  it("removes a reaction, dropping it from the entries snapshot", async () => {
    const owner = "@reactowner3:local";
    const { roomRef } = await freshStronghold(owner);
    const { ws } = await connectRoom(roomRef, owner, "owner");

    ws.send(itemCreateFrame("m1", "hello"));
    const seq = (await nextMessage(ws)).seq as number;

    ws.send(itemReactionFrame(seq, "heart", "add"));
    await nextMessage(ws);

    ws.send(itemReactionFrame(seq, "heart", "remove"));
    const afterRemove = await nextMessage(ws);
    expect(afterRemove).toMatchObject({ type: "item.reaction", entries: [], op: "remove" });
  });

  it("treats a remove with no existing reaction as a silent no-op", async () => {
    const owner = "@reactowner4:local";
    const { roomRef } = await freshStronghold(owner);
    const { ws } = await connectRoom(roomRef, owner, "owner");

    ws.send(itemCreateFrame("m1", "hello"));
    const seq = (await nextMessage(ws)).seq as number;

    ws.send(itemReactionFrame(seq, "never-added", "remove"));
    const result = await nextMessage(ws);
    expect(result).toMatchObject({ type: "item.reaction", entries: [], op: "remove" });
  });

  it("rejects a reaction on an unknown target", async () => {
    const owner = "@reactowner5:local";
    const { roomRef } = await freshStronghold(owner);
    const { ws } = await connectRoom(roomRef, owner, "owner");

    ws.send(itemReactionFrame(999999, "thumbsup", "add"));
    const err = await nextMessage(ws);
    expect(err).toMatchObject({ type: "error", code: "OMEW_TARGET_NOT_FOUND" });
  });

  it("rejects a reaction on a tombstoned target", async () => {
    const owner = "@reactowner6:local";
    const { roomRef } = await freshStronghold(owner);
    const { ws } = await connectRoom(roomRef, owner, "owner");

    ws.send(itemCreateFrame("m1", "hello"));
    const seq = (await nextMessage(ws)).seq as number;

    ws.send(itemDeleteFrame(seq));
    await nextMessage(ws);

    ws.send(itemReactionFrame(seq, "thumbsup", "add"));
    const err = await nextMessage(ws);
    expect(err).toMatchObject({ type: "error", code: "OMEW_ITEM_DELETED" });
  });

  it("rejects a malformed name and a malformed op", async () => {
    const owner = "@reactowner7:local";
    const { roomRef } = await freshStronghold(owner);
    const { ws } = await connectRoom(roomRef, owner, "owner");

    ws.send(itemCreateFrame("m1", "hello"));
    const seq = (await nextMessage(ws)).seq as number;

    ws.send(JSON.stringify({ type: "item.reaction", target_seq: seq, name: "", op: "add" }));
    expect(await nextMessage(ws)).toMatchObject({ type: "error", code: "OMEW_MALFORMED" });

    ws.send(JSON.stringify({ type: "item.reaction", target_seq: seq, name: "ok", op: "toggle" }));
    expect(await nextMessage(ws)).toMatchObject({ type: "error", code: "OMEW_MALFORMED" });
  });

  it("lets a member with denied write bits still react", async () => {
    const owner = "@reactowner8:local";
    const target = "@reactdenied8:local";
    const { roomRef } = await freshStronghold(owner);
    const { ws: ownerWs } = await connectRoom(roomRef, owner, "owner");
    const { ws: memberWs } = await connectRoom(roomRef, target, "member", DENY_CHANNEL_SPEAK);

    ownerWs.send(itemCreateFrame("m1", "hello"));
    const seq = (await nextMessage(ownerWs)).seq as number;

    // Confirms the deny bit really is blocking ordinary writes for this connection.
    memberWs.send(itemCreateFrame("m2", "should be denied"));
    expect(await nextMessageOfType(memberWs,"error")).toMatchObject({ type: "error", code: "OMEW_FORBIDDEN" });

    // But reacting is engagement, not content write - §3.4 deny bits MUST NOT apply.
    memberWs.send(itemReactionFrame(seq, "thumbsup", "add"));
    const snapshot = await nextMessageOfType(memberWs,"item.reaction");
    expect(snapshot).toMatchObject({
      type: "item.reaction",
      target_seq: seq,
      entries: [{ name: "thumbsup", count: 1 }],
      actor: target,
      op: "add",
    });
  });

  it("broadcasts the absolute snapshot to other connections in the room", async () => {
    const owner = "@reactowner9:local";
    const bystander = "@reactbystander9:local";
    const { roomRef } = await freshStronghold(owner);
    const { ws: ownerWs } = await connectRoom(roomRef, owner, "owner");
    const { ws: bystanderWs } = await connectRoom(roomRef, bystander, "member");

    ownerWs.send(itemCreateFrame("m1", "hello"));
    const seq = (await nextMessage(ownerWs)).seq as number;

    // Subscribe before triggering: the broadcast fires off the same synchronous
    // handler that answers the sender, so the listener must already be attached.
    const reactionBroadcast = findReactionBroadcast(bystanderWs);
    const snapshotPromise = nextMessage(ownerWs);
    ownerWs.send(itemReactionFrame(seq, "fire", "add"));

    const snapshot = await snapshotPromise;
    expect(snapshot).toMatchObject({ type: "item.reaction", entries: [{ name: "fire", count: 1 }] });

    const reactionFrame = await reactionBroadcast;
    expect(reactionFrame).toMatchObject({
      target_seq: seq,
      entries: [{ name: "fire", count: 1 }],
      actor: owner,
      op: "add",
    });
  });

  it("returns entries and the requester's mine set on history read-back", async () => {
    const owner = "@reacthist10:local";
    const { id, roomRef } = await freshStronghold(owner);
    const { ws } = await connectRoom(roomRef, owner, "owner");

    ws.send(itemCreateFrame("m1", "hello"));
    const seq = (await nextMessage(ws)).seq as number;

    ws.send(itemReactionFrame(seq, "heart", "add"));
    await nextMessage(ws);

    const token = await sessionToken(owner);
    const res = await apiRequest(`/stronghold/${id}/rooms/general/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { seq: number; reactions: { entries: unknown[]; mine: string[] } }[] };
    const item = body.items.find((i) => i.seq === seq);
    expect(item?.reactions).toMatchObject({ entries: [{ name: "heart", count: 1 }], mine: ["heart"] });
  });

  it("returns entries and mine on getPost read-back, empty mine for a non-reacting member", async () => {
    const owner = "@reactpost11:local";
    const other = "@reactpostother11:local";
    const { id, resId, roomRef } = await freshSectionStronghold(owner);
    const stub = env.STRONGHOLD_DO.getByName(id);
    await stub.addMember(other, "member");
    const { ws } = await connectRoom(roomRef, owner, "owner");

    ws.send(postCreateFrame("m1", "A title", "post body"));
    const seq = (await nextMessage(ws)).seq as number;

    ws.send(itemReactionFrame(seq, "star", "add"));
    await nextMessage(ws);

    const ownerToken = await sessionToken(owner);
    const ownerRes = await apiRequest(`/api/stronghold/${id}/rooms/${resId}/posts/${seq}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const ownerBody = (await ownerRes.json()) as { post: { reactions: { entries: unknown[]; mine: string[] } } };
    expect(ownerBody.post.reactions).toMatchObject({ entries: [{ name: "star", count: 1 }], mine: ["star"] });

    const otherToken = await sessionToken(other);
    const otherRes = await apiRequest(`/api/stronghold/${id}/rooms/${resId}/posts/${seq}`, {
      headers: { Authorization: `Bearer ${otherToken}` },
    });
    const otherBody = (await otherRes.json()) as { post: { reactions: { entries: unknown[]; mine: string[] } } };
    expect(otherBody.post.reactions).toMatchObject({ entries: [{ name: "star", count: 1 }], mine: [] });
  });
});

describe("item.update edit projection through the section read path", () => {
  it("re-projects a section post's edited body and re-folded preview on getPost and listPosts", async () => {
    const owner = "@reactedit12:local";
    const { id, resId, roomRef } = await freshSectionStronghold(owner);
    const { ws } = await connectRoom(roomRef, owner, "owner");

    ws.send(postCreateFrame("m1", "Original Title", "original body text"));
    const seq = (await nextMessage(ws)).seq as number;

    const longText = "b".repeat(120);
    ws.send(JSON.stringify({ type: "item.update", target_seq: seq, body: { title: "Edited Title", text: longText } }));
    await nextMessage(ws);

    const token = await sessionToken(owner);
    const postRes = await apiRequest(`/api/stronghold/${id}/rooms/${resId}/posts/${seq}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { post: { title: string; text: string; preview: string; edited_at?: number } };
    expect(postBody.post.title).toBe("Edited Title");
    expect(postBody.post.text).toBe(longText);
    expect(postBody.post.preview).toBe(longText.slice(0, 80));
    expect(postBody.post.edited_at).toBeTypeOf("number");

    const listRes = await apiRequest(`/api/stronghold/${id}/rooms/${resId}/posts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { posts: { post_seq: number; title: string; preview: string }[] };
    const listed = listBody.posts.find((p) => p.post_seq === seq);
    expect(listed?.title).toBe("Edited Title");
    expect(listed?.preview).toBe(longText.slice(0, 80));
  });

  it("re-projects a reply's edited body on getPost", async () => {
    const owner = "@reactreplyedit13:local";
    const { id, resId, roomRef } = await freshSectionStronghold(owner);
    const { ws } = await connectRoom(roomRef, owner, "owner");

    ws.send(postCreateFrame("m1", "Title", "post body"));
    const postSeq = (await nextMessage(ws)).seq as number;

    ws.send(replyCreateFrame("m2", postSeq, "original reply"));
    const replySeq = (await nextMessage(ws)).seq as number;

    ws.send(itemUpdateFrame(replySeq, "edited reply text"));
    await nextMessage(ws);

    const token = await sessionToken(owner);
    const res = await apiRequest(`/api/stronghold/${id}/rooms/${resId}/posts/${postSeq}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replies: { seq: number; body: { text: string }; edited_at?: number }[] };
    const reply = body.replies.find((r) => r.seq === replySeq);
    expect(reply?.body.text).toBe("edited reply text");
    expect(reply?.edited_at).toBeTypeOf("number");
  });
});

describe("item.reaction malformed-frame type guards (m0-protocol §3.2a revision)", () => {
  it("rejects a non-string name, echoing target_seq and the raw name in the error frame", async () => {
    const owner = "@reactguard14:local";
    const { roomRef } = await freshStronghold(owner);
    const { ws } = await connectRoom(roomRef, owner, "owner");

    ws.send(itemCreateFrame("m1", "hello"));
    const seq = (await nextMessage(ws)).seq as number;

    ws.send(JSON.stringify({ type: "item.reaction", target_seq: seq, name: { bad: true }, op: "add" }));
    const err = await nextMessage(ws);
    expect(err.type).toBe("error");
    expect(err.code).toBe("OMEW_MALFORMED");
    expect(err.target_seq).toBe(seq);
    expect(err.name).toEqual({ bad: true });
  });

  it("rejects a non-safe-integer target_seq (boolean coercion, fractional) without ever storing it", async () => {
    const owner = "@reactguard15:local";
    const { roomRef } = await freshStronghold(owner);
    const { ws } = await connectRoom(roomRef, owner, "owner");

    ws.send(itemCreateFrame("m1", "hello"));
    await nextMessage(ws);

    ws.send(JSON.stringify({ type: "item.reaction", target_seq: true, name: "ok", op: "add" }));
    const boolErr = await nextMessage(ws);
    expect(boolErr).toMatchObject({ type: "error", code: "OMEW_MALFORMED", name: "ok", target_seq: true });

    ws.send(JSON.stringify({ type: "item.reaction", target_seq: 1.5, name: "ok", op: "add" }));
    const fractionalErr = await nextMessage(ws);
    expect(fractionalErr).toMatchObject({ type: "error", code: "OMEW_MALFORMED", name: "ok", target_seq: 1.5 });
  });
});
