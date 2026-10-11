import { computed, ref, watch } from 'vue'
import { api } from '../api'
import type { MemberTab, StrongholdMember } from '../api/types'
import { useAuth } from './useAuth'
import { useStronghold } from './useStronghold'

const members = ref<StrongholdMember[]>([])
const loading = ref(false)
const loadError = ref('')
let loadedForNode = ''

async function loadMembers(nodeId: string, tab: MemberTab = 'all') {
  const auth = useAuth()
  const { isReadOnly } = useStronghold()
  if (!auth.token.value || isReadOnly.value) return
  loading.value = true
  loadError.value = ''
  try {
    const page = await api.getStrongholdMembers(auth.token.value, nodeId, tab)
    members.value = page.members
    loadedForNode = nodeId
  } catch {
    loadError.value = '无法加载成员列表'
  } finally {
    loading.value = false
  }
}

export function useStrongholdMembers() {
  const auth = useAuth()
  const { selectedNodeId, isReadOnly } = useStronghold()

  // keep the "all" roster fresh whenever the active stronghold changes, so
  // myRole below stays correct without every caller having to trigger a load
  watch(
    [selectedNodeId, isReadOnly],
    ([nodeId, readOnly]) => {
      if (readOnly) {
        members.value = []
        loadedForNode = ''
      } else if (nodeId && nodeId !== loadedForNode) {
        void loadMembers(nodeId, 'all')
      }
    },
    { immediate: true },
  )

  const myRole = computed(() => {
    const actor = auth.user.value?.actor
    if (!actor) return null
    return members.value.find((member) => member.actor === actor)?.role ?? null
  })

  return { members, loading, loadError, myRole, loadMembers }
}
