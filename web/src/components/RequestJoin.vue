<script setup lang="ts">
import { ref } from "vue";
import { API_BASE } from "../api/client";
import { useAuth } from "../composables/useAuth";
import { useStronghold } from "../composables/useStronghold";
import { WinButton } from "../vendor/winui";

const auth = useAuth();
const { loadStrongholds } = useStronghold();
const id = ref("");
const busy = ref(false);
const status = ref("");
async function submit() {
  if (busy.value || !auth.token.value || !id.value.trim()) return;
  busy.value = true;
  try {
    const response = await fetch(
      `${API_BASE}/api/stronghold/${encodeURIComponent(id.value.trim())}/join`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token.value}` },
      },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "申请失败");
    status.value =
      response.status === 202
        ? "申请已提交，等待据点管理员审核。"
        : "已加入据点。";
    if (response.status === 200 || response.status === 201)
      await loadStrongholds(true);
  } catch (e) {
    status.value = String(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <form
    v-if="auth.isAuthenticated.value"
    class="request-join"
    @submit.prevent="submit"
  >
    <label
      >通过据点 ID 加入或申请<input
        v-model="id"
        placeholder="据点 ID"
        maxlength="64"
    /></label>
    <WinButton
      Style="SubtleButtonStyle"
      :IsEnabled="!busy && !!id.trim()"
      @click="submit"
      >提交</WinButton
    >
    <p v-if="status" role="status">{{ status }}</p>
  </form>
</template>
<style scoped>
.request-join {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.6rem;
  padding-top: 0.8rem;
}
.request-join label {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.4rem;
}
.request-join input {
  background: var(--control-fill);
  border: 1px solid var(--control-stroke);
  border-radius: var(--radius-sm);
  padding: 0.5rem;
  color: var(--text-primary);
}
.request-join p {
  width: 100%;
  color: var(--text-secondary);
}
</style>
