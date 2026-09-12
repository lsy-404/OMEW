<script setup lang="ts">
import { computed } from 'vue'
import { defaultAvatarUrl } from '../utils/avatar'
import { useInstanceConfig } from '../composables/useInstanceConfig'

const props = withDefaults(defineProps<{ seed: string; size?: number; avatarUrl?: string }>(), {
  size: 36,
})

const { config: instanceConfig } = useInstanceConfig()
const src = computed(() => props.avatarUrl || (instanceConfig.value?.art_assets_enabled !== false ? defaultAvatarUrl(props.seed) : null))
</script>

<template>
  <img
    v-if="src"
    class="avatar-badge"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :src="src"
    :alt="seed"
    :title="seed"
  />
  <span
    v-else
    class="avatar-badge avatar-badge--fallback"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :title="seed"
    aria-hidden="true"
  >{{ seed.slice(0, 1).toUpperCase() }}</span>
</template>

<style scoped>
.avatar-badge {
  flex: 0 0 auto;
  border-radius: 50%;
  object-fit: cover;
  user-select: none;
}

.avatar-badge--fallback {
  display: inline-grid;
  place-items: center;
  background: var(--ctrl-fill-secondary);
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 600;
}
</style>
