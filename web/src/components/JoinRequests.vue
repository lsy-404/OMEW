<script setup lang="ts">
import { ref, watch } from "vue";
import { API_BASE } from "../api/client";
import { useAuth } from "../composables/useAuth";
import { WinButton } from "../vendor/winui";

const props = defineProps<{ strongholdId: string }>();
const auth = useAuth();
const entries = ref<Array<{ actor: string; display_name: string }>>([]);
const error = ref("");
const busy = ref(false);

async function request(path: string, body?: unknown) {
  const response = await fetch(
    `${API_BASE}/api/stronghold/${props.strongholdId}/join-requests${path}`,
    {
      method: body ? "PATCH" : "GET",
      headers: {
        Authorization: `Bearer ${auth.token.value}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.code ?? result.error ?? "请求失败");
  return result;
}
async function load() {
  if (!props.strongholdId || !auth.token.value) return;
  try {
    entries.value = (await request("")).entries;
    error.value = "";
  } catch (e) {
    error.value = String(e);
  }
}
async function decide(actor: string, state: "approved" | "rejected") {
  if (busy.value) return;
  busy.value = true;
  try {
    await request(`/${encodeURIComponent(actor)}`, { state });
    await load();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
watch(() => props.strongholdId, load, { immediate: true });
</script>
<template>
  <section class="join-requests">
    <p>加入申请</p>
    <p v-if="error" role="status">{{ error }}</p>
    <p v-if="!entries.length">暂无待审核申请</p>
    <div v-for="entry in entries" :key="entry.actor" class="join-request">
      <span
        >{{ entry.display_name }} <small>{{ entry.actor }}</small></span
      >
      <WinButton
        Style="SubtleButtonStyle"
        :IsEnabled="!busy"
        @click="decide(entry.actor, 'approved')"
        >批准</WinButton
      >
      <WinButton
        Style="SubtleButtonStyle"
        :IsEnabled="!busy"
        @click="decide(entry.actor, 'rejected')"
        >拒绝</WinButton
      >
    </div>
    <WinButton Style="SubtleButtonStyle" @click="load">刷新申请</WinButton>
  </section>
</template>
<style scoped>
.join-requests {
  padding: 0.6rem 0;
  border-top: 1px solid var(--card-stroke);
}
.join-request {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.4rem 0;
  flex-wrap: wrap;
}
.join-request span {
  flex: 1;
  overflow-wrap: anywhere;
}
.join-request small {
  color: var(--text-secondary);
}
</style>
