<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AuthGate from './components/AuthGate.vue'
import AuthModal from './components/AuthModal.vue'
import ColumnResizer from './components/ColumnResizer.vue'
import LeftColumn from './components/LeftColumn.vue'
import LandingPage from './components/LandingPage.vue'
import MiddleColumn from './components/MiddleColumn.vue'
import MobileNavBar from './components/MobileNavBar.vue'
import NodeRail from './components/NodeRail.vue'
import PostModal from './components/PostModal.vue'
import RightColumn from './components/RightColumn.vue'
import ServerAdminModal from './components/ServerAdminModal.vue'
import StrongholdAdminModal from './components/StrongholdAdminModal.vue'
import StrongholdOnboarding from './components/StrongholdOnboarding.vue'
import { useAuth } from './composables/useAuth'
import { LEFT_WIDTH_DEFAULT, LEFT_WIDTH_KEY, RIGHT_WIDTH_DEFAULT, RIGHT_WIDTH_KEY } from './composables/useColumnResize'
import { useDocumentTitle } from './composables/useDocumentTitle'
import { useInstanceConfig } from './composables/useInstanceConfig'
import { useAuthModal } from './composables/useAuthModal'
import { useRoute } from './composables/useRoute'
import { useShellView } from './composables/useShellView'
import { useStronghold } from './composables/useStronghold'

const auth = useAuth()
const { openAuthModal } = useAuthModal()
const isHome = ref(location.pathname === '/')
const routeInstalled = ref(!isHome.value)
let routeController: ReturnType<typeof useRoute> | null = routeInstalled.value ? useRoute() : null
// ServerAdminModal and StrongholdAdminModal are two independent
// PostModal-style floating overlays with separate entry points (task 039
// split, task 048 modal-ized) - the shell underneath keeps rendering while
// either is open, they never share state beyond these two booleans.
const serverAdminOpen = ref(false)
const strongholdAdminOpen = ref(false)
const strongholdAdminTab = ref<'members' | 'settings'>('members')
const { activeView } = useShellView()
const { config: instanceConfig, loading: instanceConfigLoading } = useInstanceConfig()
const { nodes, loading: strongholdsLoading, selectNode } = useStronghold()
const hasStrongholds = computed(() => nodes.value.length > 0)
useDocumentTitle(isHome)

// an unauthenticated visitor only hits the full-screen gate when the
// instance doesn't allow guest browsing (or its config hasn't loaded
// yet, same fallback as before) - otherwise the four-column shell renders
// directly in its read-only guest state (useStronghold's isGuestMode).
const showAuthGate = computed(() => !auth.isAuthenticated.value && !instanceConfig.value?.allow_guest_browsing)
const fixedStronghold = computed(() => instanceConfig.value?.fixed_stronghold ?? null)
const showLanding = computed(() => isHome.value && !instanceConfigLoading.value && !fixedStronghold.value)
const showFixedLoading = computed(() => isHome.value && (instanceConfigLoading.value || Boolean(fixedStronghold.value)))
const STAR_DUST_ORIGIN = 'https://stardustinfinity.top'
let lastStarDustBridgeToken: string | null = null

async function handleStarDustSession(event: MessageEvent) {
  if (event.origin !== STAR_DUST_ORIGIN || event.source !== window.parent) return
  if (event.data?.type !== 'star-dust-session' || typeof event.data.token !== 'string') return
  if (event.data.token === lastStarDustBridgeToken && auth.isAuthenticated.value) return
  lastStarDustBridgeToken = event.data.token
  try {
    await auth.loginWithStarDust(event.data.token)
  } catch {
    lastStarDustBridgeToken = null
  }
}

function announceEmbeddedReady() {
  if (window.parent !== window) window.parent.postMessage({ type: 'omew-ready' }, STAR_DUST_ORIGIN)
}

function syncFavicon(logoUrl: string | null | undefined) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (link) link.href = logoUrl || '/favicon.svg'
}

function installRoute(strongholdId?: string, strongholdSlug?: string) {
  if (strongholdSlug && location.pathname === '/') {
    history.pushState(null, '', `/a/${encodeURIComponent(strongholdSlug)}`)
  }
  isHome.value = false
  if (strongholdId) selectNode(strongholdId)
  if (!routeInstalled.value) {
    routeInstalled.value = true
    routeController = useRoute()
    return
  }
  if (strongholdSlug) {
    routeController?.navigate({ server: 'a', slug: strongholdSlug, kind: null, room: null, postSeq: null })
  }
}

function syncHomeFromAddress() {
  if (fixedStronghold.value && location.pathname === '/') {
    installRoute(fixedStronghold.value.id, fixedStronghold.value.slug)
    return
  }
  isHome.value = location.pathname === '/'
}

function openStrongholdAdmin(tab: 'members' | 'settings') {
  strongholdAdminTab.value = tab
  strongholdAdminOpen.value = true
}

watch(auth.isAuthenticated, (authenticated) => {
  if (authenticated && !isHome.value) installRoute()
  if (!authenticated) {
    serverAdminOpen.value = false
    strongholdAdminOpen.value = false
  }
})

watch(
  fixedStronghold,
  (fixed) => {
    if (fixed && location.pathname === '/') installRoute(fixed.id, fixed.slug)
  },
  { immediate: true },
)

watch(
  () => instanceConfig.value?.logo_url,
  (logoUrl) => syncFavicon(logoUrl),
  { immediate: true },
)

onMounted(() => {
  window.addEventListener('popstate', syncHomeFromAddress)
  window.addEventListener('message', handleStarDustSession)
  announceEmbeddedReady()
})
onBeforeUnmount(() => {
  window.removeEventListener('popstate', syncHomeFromAddress)
  window.removeEventListener('message', handleStarDustSession)
})
</script>

<template>
  <div class="shell">
    <LandingPage
      v-if="showLanding"
      :authenticated="auth.isAuthenticated.value"
      :guest-browsing-allowed="instanceConfig?.allow_guest_browsing ?? false"
      :logo-url="instanceConfig?.logo_url ?? null"
      @authenticate="openAuthModal"
      @browse="installRoute"
    />

    <div v-else-if="showFixedLoading" class="shell__loading" role="status" aria-live="polite" aria-busy="true">
      <span class="shell__loading-spinner" aria-hidden="true" />
      <span>正在进入 {{ fixedStronghold?.name ?? 'OMEW' }}…</span>
    </div>

    <AuthGate v-else-if="showAuthGate" />

    <div
      v-else-if="strongholdsLoading && !hasStrongholds"
      class="shell__loading"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span class="shell__loading-spinner" aria-hidden="true" />
      <span>正在加载据点…</span>
    </div>

    <StrongholdOnboarding v-else-if="auth.isAuthenticated.value && !hasStrongholds" />

    <template v-else>
      <div class="shell__body" :data-view="activeView">
        <NodeRail />
        <LeftColumn />
        <ColumnResizer :var-name="'--left-width'" :storage-key="LEFT_WIDTH_KEY" :default-percent="LEFT_WIDTH_DEFAULT" />
        <MiddleColumn />
        <ColumnResizer
          :var-name="'--right-width'"
          :storage-key="RIGHT_WIDTH_KEY"
          :default-percent="RIGHT_WIDTH_DEFAULT"
          invert
        />
        <RightColumn @open-server-admin="serverAdminOpen = true" @open-panel="openStrongholdAdmin" />
      </div>
      <MobileNavBar />
      <PostModal />
    </template>

    <AuthModal />
    <ServerAdminModal :open="serverAdminOpen" @close="serverAdminOpen = false" />
    <StrongholdAdminModal :open="strongholdAdminOpen" :initial-tab="strongholdAdminTab" @close="strongholdAdminOpen = false" />
  </div>
</template>

<style scoped>
.shell {
  position: relative;
  height: 100%;
}

.shell__body {
  display: flex;
  flex-direction: row;
  height: 100%;
}

.shell__loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  height: 100%;
  color: var(--text-tertiary);
  font-size: 0.85rem;
}

.shell__loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--ctrl-border);
  border-top-color: rgb(var(--colors-primary));
  border-radius: 50%;
  animation: shell-loading-spin 0.8s linear infinite;
}

@keyframes shell-loading-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .shell__loading-spinner {
    animation: none;
  }
}

@media (max-width: 768px) {
  .shell__body {
    flex-direction: column;
    padding-bottom: calc(var(--navbar-height) + env(safe-area-inset-bottom));
  }
}
</style>
