<script setup lang="ts">
import { computed } from 'vue'
import { navigateHome } from '../composables/useRoute'
import { useShellView } from '../composables/useShellView'
import { useInstanceConfig } from '../composables/useInstanceConfig'
import type { ShellView } from '../composables/useShellView'
import AppIcon from './icons/AppIcon.vue'
import type { IconName } from './icons/paths'

const { activeView, setView } = useShellView()
const { config: instanceConfig } = useInstanceConfig()
const fixedStronghold = computed(() => instanceConfig.value?.fixed_stronghold ?? null)
const logoSrc = computed(() => instanceConfig.value?.logo_url || (instanceConfig.value?.art_assets_enabled !== false ? '/favicon.svg' : null))

const tabs: { view: ShellView; label: string; icon: IconName }[] = [
  { view: 'posts', label: '帖子', icon: 'feed' },
  { view: 'chat', label: '聊天', icon: 'chat' },
  { view: 'stronghold', label: '据点', icon: 'home' },
]
</script>

<template>
  <nav class="mobile-nav">
    <a v-if="!fixedStronghold" class="mobile-nav__item mobile-nav__item--home" href="/" aria-label="返回 OMEW 首页" @click.prevent="navigateHome">
      <img v-if="logoSrc" :src="logoSrc" alt="" aria-hidden="true" />
      <span class="mobile-nav__label">首页</span>
    </a>
    <button
      v-for="tab in tabs"
      :key="tab.view"
      type="button"
      class="mobile-nav__item"
      :class="{ 'mobile-nav__item--active': tab.view === activeView }"
      @click="setView(tab.view)"
    >
      <AppIcon :name="tab.icon" :size="20" />
      <span class="mobile-nav__label">{{ tab.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.mobile-nav {
  display: none;
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  /* border-box: 总高需含 safe-area,否则 padding 会压扁按钮区 */
  height: calc(var(--navbar-height) + env(safe-area-inset-bottom));
  padding-bottom: env(safe-area-inset-bottom);
  background: var(--layer-default);
  backdrop-filter: blur(24px) saturate(160%);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  border-top: 1px solid var(--stroke-divider);
}

@media (max-width: 768px) {
  .mobile-nav {
    display: flex;
  }
}

.mobile-nav__item {
  flex: 1 1 0;
  height: var(--navbar-height);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.15rem;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  text-decoration: none;
  transition: background var(--fast-duration) var(--fast-out-slow-in), color var(--fast-duration);
}

.mobile-nav__item--home img {
  width: 20px;
  height: 20px;
  border-radius: 5px;
}

.mobile-nav__item:active {
  background: var(--ctrl-fill-secondary);
}

.mobile-nav__item--active {
  color: rgb(var(--colors-primary));
  font-weight: 600;
}

.mobile-nav__label {
  font-size: 0.7rem;
}
</style>
