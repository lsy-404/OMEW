import { computed, watchEffect, type Ref } from 'vue'
import { useStronghold } from './useStronghold'

// Keeps the browser tab title in sync with the selected stronghold and instance name.
export function useDocumentTitle(isHome?: Readonly<Ref<boolean>>, instanceName?: Readonly<Ref<string | null | undefined>>) {
  const { nodes, selectedNodeId } = useStronghold()
  const currentName = computed(() => nodes.value.find((n) => n.id === selectedNodeId.value)?.name ?? '')
  watchEffect(() => {
    const name = instanceName?.value?.trim() || 'OMEW'
    document.title = !isHome?.value && currentName.value ? `${name} - ${currentName.value}` : name
  })
}
