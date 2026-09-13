import { computed, ref, watch } from 'vue'
import { api } from '../api'
import type { EmotePack } from '../api/types'
import { BUILTIN_EMOTE_PACK, BUILTIN_REACTION_PACK } from '../assets/mew-emotes'
import { useAuth } from './useAuth'
import { useInstanceConfig } from './useInstanceConfig'

const instancePacks = ref<EmotePack[]>([])
const loading = ref(false)
let loaded = false
const { config: instanceConfig } = useInstanceConfig()
const enabled = computed(() => instanceConfig.value?.emotes_enabled !== false)
const builtinEmotesEnabled = computed(() => enabled.value && instanceConfig.value?.builtin_emotes_enabled !== false)
const builtinReactionsEnabled = computed(
  () => instanceConfig.value?.reactions_enabled !== false && instanceConfig.value?.builtin_reactions_enabled !== false,
)

async function loadEmotes() {
  const auth = useAuth()
  if (!auth.token.value || loading.value) return
  loading.value = true
  try {
    instancePacks.value = await api.getEmotes(auth.token.value)
    loaded = true
  } catch {
    // non-fatal - picker just falls back to the built-in pack, :pack:name: codes render as plain text
  } finally {
    loading.value = false
  }
}

// enabled built-in packs are listed last, so they win on a same-name
// collision against the emote lookup (buildEmoteLookup keeps the last entry
// written for a given "pack:name" key).
const packs = computed<EmotePack[]>(() => [
  ...(enabled.value ? instancePacks.value : []),
  ...(builtinReactionsEnabled.value ? [BUILTIN_REACTION_PACK] : []),
  ...(builtinEmotesEnabled.value ? [BUILTIN_EMOTE_PACK] : []),
])

export function useEmotes() {
  const auth = useAuth()
  watch(
    [auth.isAuthenticated, enabled],
    ([authenticated, emotesEnabled]) => {
      if (authenticated && emotesEnabled && !loaded) void loadEmotes()
      else if (!authenticated || !emotesEnabled) {
        instancePacks.value = []
        loaded = false
      }
    },
    { immediate: true },
  )
  return { packs: computed(() => (enabled.value ? packs.value : [])), loading, enabled }
}
