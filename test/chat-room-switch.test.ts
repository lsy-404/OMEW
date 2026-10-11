import { effectScope, nextTick, type Ref } from "vue";
import { expect, it, vi } from "vitest";
import type { RoomSummary } from "../web/src/api/types";

const fixture = vi.hoisted(() => ({
  history: vi.fn(),
  channel: null as Ref<RoomSummary> | null,
  node: null as Ref<string> | null,
  preview: null as Ref<boolean> | null,
  transport: vi.fn(() => ({ connect() {}, close() {} })),
}));
vi.mock("../web/src/api", () => ({ api: { getRoomHistory: fixture.history } }));
vi.mock("../web/src/api/transport", () => ({
  createRoomTransport: fixture.transport,
}));
vi.mock("../web/src/composables/useAuth", async () => {
  const { ref } = await import("vue");
  const token = ref("fixture-session");
  const user = ref({ actor: "@member:example.test" });
  return { useAuth: () => ({ token, user }) };
});
vi.mock("../web/src/composables/useStronghold", async () => {
  const { ref } = await import("vue");
  const selectedNodeId = ref("community");
  const isReadOnly = ref(false);
  fixture.node = selectedNodeId;
  fixture.preview = isReadOnly;
  return { useStronghold: () => ({ selectedNodeId, isReadOnly }) };
});

it("reads public preview history without opening a member transport", async () => {
  fixture.transport.mockClear();
  fixture.history.mockResolvedValue({
    items: [],
    has_more: false,
    next_before: null,
  });
  fixture.preview!.value = true;
  fixture.channel!.value = { ...fixture.channel!.value, id: "preview" };
  const scope = effectScope();
  scope.run(() => useChatRoom());
  try {
    await nextTick();
    await nextTick();
    expect(fixture.history).toHaveBeenCalled();
    expect(fixture.transport).not.toHaveBeenCalled();
  } finally {
    fixture.node!.value = "";
    await nextTick();
    scope.stop();
  }
});
vi.mock("../web/src/composables/useChannel", async () => {
  const { ref } = await import("vue");
  fixture.channel = ref<RoomSummary>({
    id: "a",
    name: "A",
    type: "channel",
    description: null,
    capabilities: ["text"],
  });
  return { useChannel: () => ({ selectedChannel: fixture.channel }) };
});
import { useChatRoom } from "../web/src/composables/useChatRoom";

it("keeps a late history response out of the newly selected channel", async () => {
  fixture.node!.value = "community";
  fixture.preview!.value = false;
  fixture.channel!.value = { ...fixture.channel!.value, id: "a", name: "A" };
  let finishA!: (page: unknown) => void;
  let finishB!: (page: unknown) => void;
  const a = new Promise((resolve) => {
    finishA = resolve;
  });
  const b = new Promise((resolve) => {
    finishB = resolve;
  });
  fixture.history.mockImplementation((_token, _community, channel) =>
    channel === "a" ? a : b,
  );
  const scope = effectScope();
  const chat = scope.run(() => useChatRoom())!;
  try {
    fixture.channel!.value = { ...fixture.channel!.value, id: "b", name: "B" };
    await nextTick();
    const row = (text: string) => ({
      seq: 1,
      actor: "@member:example.test",
      kind: "post",
      ts: 1,
      body: { text },
    });
    finishB({ items: [row("channel B")], has_more: false, next_before: null });
    await nextTick();
    await nextTick();
    expect(chat.items.value).toMatchObject([{ body: { text: "channel B" } }]);
    finishA({ items: [row("channel A")], has_more: false, next_before: null });
    await nextTick();
    await nextTick();
    expect(chat.items.value).toMatchObject([{ body: { text: "channel B" } }]);
  } finally {
    scope.stop();
  }
});
