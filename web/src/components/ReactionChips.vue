<script setup lang="ts">
import type { ItemReactions } from '../api/types'
import { BUILTIN_REACTION_SET } from '../assets/mew-emotes'
import { computed } from 'vue'
import { useInstanceConfig } from '../composables/useInstanceConfig'

// canToggle: gated by the caller to auth state + a resolved seq (guests and
// still-optimistic items render read-only chips, per m0-protocol §3.2a -
// reacting requires a live room session).
defineProps<{ reactions?: ItemReactions; canToggle: boolean }>()
const emit = defineEmits<{ toggle: [name: string] }>()
const { config: instanceConfig } = useInstanceConfig()
const builtinReactionsEnabled = computed(
  () => instanceConfig.value?.reactions_enabled !== false && instanceConfig.value?.builtin_reactions_enabled !== false,
)
</script>

<template>
  <div v-if="reactions?.entries.length" class="reaction-chips">
    <button
      v-for="entry in reactions.entries"
      :key="entry.name"
      type="button"
      class="reaction-chip"
      :class="{ 'reaction-chip--mine': reactions.mine.includes(entry.name), 'reaction-chip--static': !canToggle }"
      :disabled="!canToggle"
      :title="entry.name"
      @click="emit('toggle', entry.name)"
    >
      <img v-if="builtinReactionsEnabled && BUILTIN_REACTION_SET[entry.name]" class="reaction-chip__image" :src="BUILTIN_REACTION_SET[entry.name]" :alt="entry.name" />
      <span v-else class="reaction-chip__fallback">{{ entry.name }}</span>
      <span class="reaction-chip__count">{{ entry.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.reaction-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.35rem;
}

.reaction-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--ctrl-border);
  background: var(--ctrl-fill-secondary);
  color: var(--text-secondary);
  font-size: 0.72rem;
  line-height: 1.5;
  cursor: pointer;
  transition:
    background var(--fast-duration) var(--fast-out-slow-in),
    border-color var(--fast-duration) var(--fast-out-slow-in);
}

.reaction-chip:hover:not(:disabled) {
  background: var(--ctrl-fill-tertiary);
}

.reaction-chip--static {
  cursor: default;
}

.reaction-chip--mine {
  border-color: rgb(var(--colors-primary));
  background: color-mix(in srgb, rgb(var(--colors-primary)) 16%, var(--ctrl-fill-secondary));
  color: var(--text-primary);
}

.reaction-chip__image {
  width: 16px;
  height: 16px;
  object-fit: contain;
  flex: 0 0 auto;
}

.reaction-chip__fallback {
  max-width: 8em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reaction-chip__count {
  font-variant-numeric: tabular-nums;
}
</style>
