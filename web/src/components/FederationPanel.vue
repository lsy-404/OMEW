<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useAuth } from "../composables/useAuth";
import { API_BASE } from "../api/client";
import { RoomSocket } from "../api/roomSocket";
import type { RoomItem } from "../api/types";
import MarkdownContent from "./MarkdownContent.vue";
import MigrationPanel from "./MigrationPanel.vue";
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const auth = useAuth();
const tab = ref<"community" | "migration" | "manage">("community");
const peers = ref<string[]>([]);
const peer = ref("");
const trusted = ref(false);
const connected = ref(false);
const error = ref("");
const busy = ref(false);
const strongholds = ref<Array<{ id: string; name: string }>>([]);
const stronghold = ref("");
const rooms = ref<
  Array<{
    id: string;
    res_id?: string;
    type: string;
    name: string;
    capabilities?: string[];
  }>
>([]);
const room = ref("");
const items = ref<RoomItem[]>([]);
const text = ref("");
const title = ref("");
const replyTarget = ref<number | null>(null);
const live = ref(false);
const pinDocument = ref("");
let remoteToken = "";
let socket: RoomSocket | null = null;
let generation = 0;
async function request<T>(
  path: string,
  body?: unknown,
  remote = false,
  method?: string,
): Promise<T> {
  const response = await fetch(
    `${remote ? `https://${peer.value}` : API_BASE}${path}`,
    {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${remote ? remoteToken : auth.token.value}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : (result.error?.code ?? "请求失败"),
    );
  return result as T;
}
function stop() {
  generation++;
  socket?.close();
  socket = null;
  remoteToken = "";
  connected.value = false;
  live.value = false;
  items.value = [];
  rooms.value = [];
  strongholds.value = [];
  stronghold.value = "";
  room.value = "";
  trusted.value = false;
}
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "连接失败";
  } finally {
    busy.value = false;
  }
}
async function load() {
  await run(async () => {
    const result = await request<{ peers: string[] }>("/api/federation/peers");
    peers.value = result.peers;
    peer.value = result.peers[0] ?? "";
  });
}
async function connect() {
  if (!trusted.value || !peers.value.includes(peer.value)) return;
  await run(async () => {
    const assertion = await request<unknown>("/api/federation/assertion", {
      peer: peer.value,
    });
    const response = await fetch(`https://${peer.value}/federation/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(assertion),
    });
    const session = await response.json();
    if (!response.ok) throw new Error(session.error?.code ?? "身份交换失败");
    remoteToken = session.token;
    connected.value = true;
    const storageKey = `openmew-links:${auth.user.value?.actor}`;
    const stored = JSON.parse(
      localStorage.getItem(storageKey) ?? "[]",
    ) as string[];
    localStorage.setItem(
      storageKey,
      JSON.stringify([...new Set([...stored, peer.value])]),
    );
    const descriptor = await request<{
      public_strongholds: Array<{ id: string; name: string }>;
    }>("/api/federation/descriptor", { peer: peer.value });
    const memberships = await request<{
      strongholds: Array<{ id: string; name: string }>;
    }>("/api/me/strongholds", undefined, true);
    strongholds.value = [
      ...new Map(
        [...descriptor.public_strongholds, ...memberships.strongholds].map(
          (node) => [node.id, node],
        ),
      ).values(),
    ];
  });
}
async function openStronghold() {
  await run(async () => {
    socket?.close();
    items.value = [];
    await request(`/api/stronghold/${stronghold.value}/join`, {}, true);
    const result = await request<{
      rooms: Array<{
        id: string;
        res_id?: string;
        type: string;
        name: string;
        capabilities?: string[];
      }>;
    }>(`/api/stronghold/${stronghold.value}/rooms`, undefined, true);
    rooms.value = result.rooms;
    room.value = result.rooms[0]?.id ?? result.rooms[0]?.res_id ?? "";
  });
  if (room.value) await openRoom();
}
async function reloadItems() {
  const result = await request<{ items: RoomItem[] }>(
    `/stronghold/${stronghold.value}/rooms/${room.value}/history`,
    undefined,
    true,
  );
  items.value = [...result.items].reverse();
}
async function openRoom() {
  await run(async () => {
    socket?.close();
    const current = ++generation;
    const selected = rooms.value.find(
      (entry) => (entry.id ?? entry.res_id) === room.value,
    );
    await reloadItems();
    socket = new RoomSocket({
      wsPath: `wss://${peer.value}/stronghold/${stronghold.value}/rooms/${room.value}/ws`,
      mint: () =>
        request(
          `/stronghold/${stronghold.value}/rooms/${room.value}/token`,
          {},
          true,
        ),
      initialLastSeq: Math.max(0, ...items.value.map((item) => item.seq)),
      handlers: {
        onOpen() {
          if (current === generation) live.value = true;
        },
        onClose() {
          if (current === generation) live.value = false;
        },
        onItem(item) {
          if (current !== generation) return;
          if (!items.value.some((row) => row.seq === item.seq))
            items.value.push(item);
        },
        onAck() {
          if (current === generation)
            void reloadItems().catch((e) => {
              error.value = String(e);
            });
        },
        onUpdate(update) {
          const row = items.value.find(
            (item) => item.seq === update.target_seq,
          );
          if (row) row.body = update.body as RoomItem["body"];
        },
        onDelete(deletion) {
          items.value = items.value.filter(
            (item) => item.seq !== deletion.target_seq,
          );
        },
        onError(e) {
          error.value = e.code;
        },
        onResyncGap() {
          void reloadItems().catch((e) => {
            error.value = String(e);
          });
        },
      },
    });
    replyTarget.value = null;
    title.value = "";
    socket.connect();
    if (selected?.type === "section")
      await request("/api/federation/subscribe", {
        peer: peer.value,
        room: `${stronghold.value}/sec/${room.value}`,
      });
  });
}
function send() {
  if (!text.value.trim() || !socket || !live.value) return;
  const selected = rooms.value.find(
    (entry) => (entry.id ?? entry.res_id) === room.value,
  );
  const section = selected?.type === "section";
  if (section && replyTarget.value === null && !title.value.trim()) {
    error.value = "请填写帖子标题";
    return;
  }
  const sent = socket.createItem(
    crypto.randomUUID(),
    replyTarget.value === null ? "post" : "reply",
    {
      text: text.value,
      ...(section && replyTarget.value === null ? { title: title.value } : {}),
    },
    replyTarget.value,
  );
  if (sent) {
    text.value = "";
    title.value = "";
    replyTarget.value = null;
  }
}
async function admin(action: "discover" | "rotate" | "block" | "pin") {
  await run(async () => {
    await request(
      `/api/admin/federation/${action === "rotate" ? "keys/rotate" : action}`,
      action === "rotate"
        ? {}
        : action === "pin"
          ? { peer: peer.value, document: JSON.parse(pinDocument.value) }
          : { peer: peer.value },
    );
    error.value = "操作已完成";
  });
}
watch(
  () => props.open,
  (open) => {
    if (open) void load();
    else stop();
  },
);
watch(peer, () => stop());
watch(
  () => auth.token.value,
  () => stop(),
);
onBeforeUnmount(stop);
</script>
<template>
  <Teleport to="body">
    <div v-if="open" class="federation-overlay" @click.self="emit('close')">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="federation-title"
        class="federation-panel"
      >
        <header>
          <h2 id="federation-title">实例互联</h2>
          <button type="button" @click="emit('close')">关闭</button>
        </header>
        <nav aria-label="互联功能">
          <button type="button" @click="tab = 'community'">远端社区</button
          ><button type="button" @click="tab = 'migration'">账号迁移</button
          ><button
            v-if="auth.user.value?.server_role === 'owner'"
            type="button"
            @click="tab = 'manage'"
          >
            密钥与信任
          </button>
        </nav>
        <p v-if="error" role="status">{{ error }}</p>
        <MigrationPanel v-if="tab === 'migration'" />
        <template v-else>
          <label
            >实例<select v-model="peer" :disabled="busy">
              <option v-for="value in peers" :key="value" :value="value">
                {{ value }}
              </option>
            </select></label
          >
          <p v-if="!peers.length">此实例尚未配置联邦对端。</p>
          <template v-if="tab === 'manage'">
            <p>首次发现会绑定对端公钥。轮换必须通过已绑定的旧钥验证。</p>
            <button
              type="button"
              :disabled="busy || !peer"
              @click="admin('discover')"
            >
              发现或刷新对端公钥
            </button>
            <button type="button" :disabled="busy" @click="admin('rotate')">
              轮换本实例密钥
            </button>
            <button
              type="button"
              :disabled="busy || !peer"
              @click="admin('block')"
            >
              阻止此对端
            </button>
            <label
              >已核验的离线公钥文档<textarea v-model="pinDocument" />
            </label>
            <button
              type="button"
              :disabled="busy || !peer || !pinDocument"
              @click="admin('pin')"
            >
              绑定离线公钥
            </button>
          </template>
          <template v-else>
            <template v-if="!connected"
              ><label
                ><input v-model="trusted" type="checkbox" />我信任
                {{ peer }} 的运营者处理消息明文并为此实例内的发言背书。</label
              ><button
                type="button"
                :disabled="busy || !trusted || !peer"
                @click="connect"
              >
                连接社区
              </button></template
            >
            <template v-else>
              <label
                >据点<select v-model="stronghold" @change="openStronghold">
                  <option value="">选择据点</option>
                  <option
                    v-for="node in strongholds"
                    :key="node.id"
                    :value="node.id"
                  >
                    {{ node.name }}
                  </option>
                </select></label
              >
              <label v-if="rooms.length"
                >房间<select v-model="room" @change="openRoom">
                  <option
                    v-for="entry in rooms"
                    :key="entry.id ?? entry.res_id"
                    :value="entry.id ?? entry.res_id"
                  >
                    {{ entry.name }}
                  </option>
                </select></label
              >
              <div class="federation-content">
                <article v-for="item in items" :key="item.seq">
                  <small>{{ item.actor }}</small
                  ><strong v-if="item.body.title">{{ item.body.title }}</strong
                  ><MarkdownContent :text="item.body.text ?? ''" /><button
                    v-if="
                      item.parent_seq === null || item.parent_seq === undefined
                    "
                    type="button"
                    @click="replyTarget = item.seq"
                  >
                    回复
                  </button>
                </article>
              </div>
              <form v-if="room" @submit.prevent="send">
                <span v-if="replyTarget"
                  >回复 #{{ replyTarget }}
                  <button type="button" @click="replyTarget = null">
                    取消
                  </button></span
                ><input
                  v-if="
                    rooms.find((entry) => (entry.id ?? entry.res_id) === room)
                      ?.type === 'section' && replyTarget === null
                  "
                  v-model="title"
                  placeholder="帖子标题"
                  aria-label="帖子标题"
                /><textarea
                  v-model="text"
                  placeholder="消息或帖子正文"
                  aria-label="消息或帖子正文"
                /><button type="submit" :disabled="!live || !text.trim()">
                  发送
                </button>
              </form>
            </template>
          </template>
        </template>
      </section>
    </div>
  </Teleport>
</template>
<style scoped>
.federation-overlay {
  position: fixed;
  inset: 0;
  z-index: 55;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--overlay-scrim);
  padding: 1rem;
}
.federation-panel {
  background: var(--dialog-background);
  border: 1px solid var(--card-stroke);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  padding: 1.25rem;
  width: min(760px, 100%);
  max-height: 90dvh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}
.federation-panel header,
.federation-panel nav {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  justify-content: space-between;
}
.federation-panel h2 {
  margin: 0;
}
.federation-panel label,
.federation-panel form {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.federation-panel select,
.federation-panel input,
.federation-panel textarea {
  background: var(--ctrl-fill-secondary);
  color: var(--text-primary);
  border: 1px solid var(--ctrl-border);
  border-radius: var(--radius-sm);
  padding: 0.6rem;
}
.federation-panel button {
  padding: 0.5rem 0.7rem;
  color: var(--text-primary);
  background: var(--ctrl-fill-secondary);
  border: 1px solid var(--ctrl-border);
  border-radius: var(--radius-sm);
}
.federation-panel button:disabled {
  opacity: 0.5;
}
.federation-content {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-height: 40dvh;
  overflow: auto;
}
.federation-content article {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  background: var(--card-bg-secondary);
  padding: 0.75rem;
}
.federation-panel textarea {
  resize: none;
  min-height: 5rem;
}
</style>
