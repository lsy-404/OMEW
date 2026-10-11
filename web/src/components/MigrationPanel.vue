<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { API_BASE } from "../api/client";
import { useAuth } from "../composables/useAuth";
import {
  parseOwnershipEnvelope,
  resealOwnershipKey,
  unsealOwnershipKey,
} from "../crypto/ownershipKey";
import {
  decodeBase64,
  migrationProof,
  ownershipId,
  urlBase64,
} from "../crypto/migration";
const auth = useAuth();
const oldActor = ref("");
const passphrase = ref("");
const release = ref("");
const destination = ref("");
const status = ref("");
const busy = ref(false);
const edges = ref<Array<{ peer: string; state: string; error?: string }>>([]);
let backup: Record<string, unknown> | null = null;
let seed: Uint8Array<ArrayBuffer> | null = null;
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${auth.token.value}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : (result.error?.code ?? "请求失败"),
    );
  return result as T;
}
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  status.value = "";
  try {
    await action();
  } catch (e) {
    status.value = e instanceof Error ? e.message : "操作失败";
  } finally {
    busy.value = false;
  }
}
async function exportBackup(plaintext = false) {
  await run(async () => {
    const ownership = await api<{
      ownership_pubkey: string;
      ownership_ciphertext: string;
    }>("/api/me/ownership");
    const actor = auth.user.value!.actor;
    const [profile, keyset, links] = await Promise.all([
      fetch(
        `${API_BASE}/.well-known/openmew/users/${actor.slice(1, actor.indexOf(":"))}`,
      ).then((response) => response.json()),
      fetch(`${API_BASE}/.well-known/openmew/keys`).then((response) =>
        response.json(),
      ),
      api<{ edges: Array<{ peer_instance: string }> }>("/api/me/links"),
    ]);
    const local = JSON.parse(
      localStorage.getItem(`openmew-links:${actor}`) ?? "[]",
    ) as string[];
    const payload: Record<string, unknown> = {
      actor,
      pubkey: ownership.ownership_pubkey,
      ...parseOwnershipEnvelope(ownership.ownership_ciphertext),
      profile,
      instance_keys: keyset,
      edges: [
        ...new Set([
          ...links.edges.map((edge) => edge.peer_instance),
          ...local,
        ]),
      ],
    };
    if (plaintext) {
      const unlocked = await unsealOwnershipKey(
        passphrase.value,
        parseOwnershipEnvelope(ownership.ownership_ciphertext),
      );
      if (!unlocked) throw new Error("所有权口令不能解锁密钥");
      payload.private_seed = urlBase64(unlocked);
      unlocked.fill(0);
    }
    download(
      payload,
      plaintext
        ? "omew-private-migration-backup.json"
        : "omew-migration-backup.json",
    );
    status.value = plaintext
      ? "明文私钥备份已导出，请妥善离线保管。"
      : "加密密钥、边表和签名档案已一起导出。";
  });
}
async function importBackup(event: Event) {
  await run(async () => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 65536) throw new Error("备份文件过大");
    const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
    if (typeof parsed.pubkey !== "string")
      throw new Error("不是所有权密钥备份");
    backup = parsed;
    oldActor.value = typeof parsed.actor === "string" ? parsed.actor : "";
    status.value = "已读取备份。密钥会在此设备上解锁。";
  });
}
async function executeMigration() {
  await run(async () => {
    if (!backup || !auth.user.value) throw new Error("请先选择备份");
    if (passphrase.value.length < 8)
      throw new Error("所有权口令至少需要八个字符");
    const newActor = auth.user.value.actor;
    if (oldActor.value === newActor)
      throw new Error("请在目标实例的新账号中进行迁移");
    seed?.fill(0);
    seed =
      typeof backup.private_seed === "string"
        ? decodeBase64(backup.private_seed)
        : await unsealOwnershipKey(
            passphrase.value,
            parseOwnershipEnvelope(JSON.stringify(backup)),
          );
    if (!seed || seed.length !== 32) throw new Error("所有权口令不能解锁密钥");
    if (
      (await ownershipId(seed)) !==
      String(
        (backup.profile as { ownership_key?: { key_id: string } } | undefined)
          ?.ownership_key?.key_id ?? (await ownershipId(seed)),
      )
    )
      throw new Error("备份公钥与私钥不匹配");
    const homeRelease = release.value.trim()
      ? JSON.parse(release.value)
      : undefined;
    const history =
      (backup.profile as { key_history?: unknown[] } | undefined)
        ?.key_history ?? [];
    const current = await api<{
      migrations: Array<{
        old_actor: string;
        mode: string;
        state: string;
        effective_at: number;
        proof: string;
      }>;
    }>("/api/me/migration/status");
    const previous = current.migrations.find(
      (entry) => entry.old_actor === oldActor.value,
    );
    let proof: Record<string, unknown>;
    let accepted: { mode: string; state: string; effective_at: number };
    if (previous && previous.state !== "frozen") {
      proof = JSON.parse(previous.proof);
      accepted = previous;
    } else {
      const challenge = await api<{ nonce: string; challenge_origin: string }>(
        "/api/me/migration/prepare",
        {
          old: oldActor.value,
          ...(backup.profile ? { profile: backup.profile } : {}),
        },
      );
      proof = await migrationProof(
        seed,
        oldActor.value,
        newActor,
        challenge,
        history,
        homeRelease,
      );
      accepted = await api<{
        mode: string;
        state: string;
        effective_at: number;
      }>("/migration/proof", proof);
    }
    const custody = await resealOwnershipKey(seed, passphrase.value);
    await api("/api/me/migration/custody", {
      old: oldActor.value,
      ownership_ciphertext: JSON.stringify(custody),
    });
    const peerNames = Array.isArray(backup.edges)
      ? backup.edges.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    await api("/api/me/migration/announce", { proof, peers: peerNames });
    const prepared = await api<{
      edges: Array<{
        peer: string;
        state: string;
        challenge?: { nonce: string; challenge_origin: string };
        error?: string;
      }>;
    }>("/api/me/migration/edges", { old: oldActor.value, peers: peerNames });
    edges.value = [];
    for (const edge of prepared.edges) {
      if (edge.challenge) {
        try {
          const edgeProof = await migrationProof(
            seed,
            oldActor.value,
            newActor,
            edge.challenge,
            history,
            homeRelease,
          );
          const delivery = await api<{ state: string; error?: string }>(
            "/api/me/migration/edge-proof",
            {
              peer: edge.peer,
              proof: edgeProof,
            },
          );
          edge.state = delivery.state;
          edge.error = delivery.error;
        } catch (e) {
          edge.error = String(e);
          edge.state = "pending";
        }
      }
      edges.value.push(edge);
    }
    status.value =
      accepted.mode === "dual_sign"
        ? "所有权证明已受理；各实例的迁移进度见下方。"
        : `灾难迁移已受理，计划于 ${new Date(accepted.effective_at).toLocaleString()} 生效。未解决的实例可点击继续重试。`;
  });
}
async function refresh() {
  await run(async () => {
    const result = await api<{
      edges: Array<{ peer: string; state: string; error?: string }>;
      migrations: Array<{ old_actor: string; state: string; error?: string }>;
    }>("/api/me/migration/status");
    edges.value = result.edges;
    const current = result.migrations.find(
      (migration) => migration.old_actor === oldActor.value,
    );
    if (current) status.value = current.error ?? current.state;
  });
}
async function exportRelease() {
  await run(async () => {
    if (!destination.value.trim()) throw new Error("请填写新账号的完整身份");
    const result = await api("/api/me/migration/release", {
      new: destination.value.trim(),
    });
    download(result, "omew-migration-release.json");
    status.value = "放行证明已导出；请在新实例迁移时附上此文档。";
  });
}
function clearSecret() {
  seed?.fill(0);
  seed = null;
  passphrase.value = "";
  backup = null;
}
watch(() => auth.token.value, clearSecret);
onBeforeUnmount(clearSecret);
</script>
<template>
  <section class="migration-panel">
    <h3>备份当前账号</h3>
    <p>
      备份包含加密所有权密钥、关联实例和签名档案。旧实例下线时仍需各实例已绑定的公钥才能验证。
    </p>
    <label
      >所有权口令<input v-model="passphrase" type="password" autocomplete="off"
    /></label>
    <div>
      <button type="button" :disabled="busy" @click="exportBackup()">
        导出加密备份</button
      ><button
        type="button"
        :disabled="busy || !passphrase"
        @click="exportBackup(true)"
      >
        导出含明文私钥的备份
      </button>
    </div>
    <h3>迁入当前账号</h3>
    <label
      >选择备份<input
        type="file"
        accept="application/json,.json"
        :disabled="busy"
        @change="importBackup" /></label
    ><label
      >旧账号完整身份<input
        v-model="oldActor"
        placeholder="@user:instance.example" /></label
    ><label
      >旧实例放行证明（可选）<textarea
        v-model="release"
        placeholder="JSON；未提供时进入七天公示期"
      /></label
    ><button
      type="button"
      :disabled="busy || !oldActor"
      @click="executeMigration"
    >
      验证所有权并迁移</button
    ><button type="button" :disabled="busy" @click="refresh">刷新进度</button>
    <ul>
      <li v-for="edge in edges" :key="edge.peer">
        {{ edge.peer }}：{{
          edge.state === "resolved"
            ? "已验证"
            : edge.state === "awaiting_proof"
              ? "等待密钥证明"
              : "待重试"
        }}
        <span v-if="edge.error">{{ edge.error }}</span>
      </li>
    </ul>
    <h3>计划迁出</h3>
    <label
      >新账号完整身份<input
        v-model="destination"
        placeholder="@user:new.example" /></label
    ><button
      type="button"
      :disabled="busy || !destination"
      @click="exportRelease"
    >
      导出旧实例放行证明
    </button>
    <p v-if="status" role="status">{{ status }}</p>
  </section>
</template>
<style scoped>
.migration-panel {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.migration-panel h3,
.migration-panel p {
  margin: 0;
}
.migration-panel label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.migration-panel input,
.migration-panel textarea {
  padding: 0.6rem;
  border: 1px solid var(--ctrl-border);
  background: var(--ctrl-fill-secondary);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
}
.migration-panel textarea {
  resize: none;
  min-height: 6rem;
}
.migration-panel button {
  padding: 0.6rem;
  margin-right: 0.4rem;
  border: 1px solid var(--ctrl-border);
  background: var(--ctrl-fill-secondary);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
}
.migration-panel button:disabled {
  opacity: 0.5;
}
</style>
