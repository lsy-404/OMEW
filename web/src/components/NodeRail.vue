<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAuth } from '../composables/useAuth'
import { navigateHome } from '../composables/useRoute'
import { useInstanceConfig } from '../composables/useInstanceConfig'
import { useStronghold } from '../composables/useStronghold'
import CreateStrongholdCard from './CreateStrongholdCard.vue'
import DirectoryModal from './DirectoryModal.vue'
import AppIcon from './icons/AppIcon.vue'

const auth = useAuth()
const { nodes, selectedNodeId, selectNode } = useStronghold()
const { config: instanceConfig } = useInstanceConfig()
const instanceName = computed(() => instanceConfig.value?.instance_name || 'OMEW')
const logoSrc = computed(() => instanceConfig.value?.logo_url || (instanceConfig.value?.art_assets_enabled !== false ? '/favicon.svg' : null))
const showCreate = ref(false)
const showDirectory = ref(false)

function onCreated() {
  showCreate.value = false
}

function handleLogoClick(event: MouseEvent) {
  event.preventDefault()
  navigateHome()
}
</script>

<template>
  <nav class="node-rail">
    <a
      class="node-rail__logo"
      href="/"
      :title="`返回 ${instanceName} 首页`"
      :aria-label="`返回 ${instanceName} 首页`"
      @click="handleLogoClick"
    >
      <img v-if="logoSrc" :src="logoSrc" alt="" aria-hidden="true" />
      <span v-else aria-hidden="true">O</span>
    </a>
    <ul class="node-rail__list">
      <li v-for="node in nodes" :key="node.id">
        <button
          class="node-rail__item"
          :class="{ 'node-rail__item--active': node.id === selectedNodeId }"
          type="button"
          :title="node.name"
          :aria-label="node.name"
          :aria-current="node.id === selectedNodeId ? 'page' : undefined"
          @click="selectNode(node.id)"
        >
          <img v-if="node.avatar" class="node-rail__avatar" :src="node.avatar" alt="" />
          <span v-else>{{ node.name.slice(0, 1) }}</span>
        </button>
      </li>
      <li v-if="auth.isAuthenticated.value">
        <button class="node-rail__item node-rail__item--add" type="button" title="发现据点" aria-label="发现据点" @click="showDirectory = true">
          <AppIcon name="compass" :size="18" />
        </button>
      </li>
      <li v-if="auth.isAuthenticated.value">
        <button class="node-rail__item node-rail__item--add" type="button" title="创建据点" aria-label="创建据点" @click="showCreate = true">
          <AppIcon name="add" :size="18" />
        </button>
      </li>
    </ul>

    <Teleport to="body">
      <div v-if="showCreate" class="node-rail__overlay" @click.self="showCreate = false">
        <div class="node-rail__dialog">
          <h2 class="node-rail__dialog-title">创建据点</h2>
          <CreateStrongholdCard @created="onCreated" />
        </div>
      </div>
    </Teleport>

    <DirectoryModal :open="showDirectory" @close="showDirectory = false" />
  </nav>
</template>

<style scoped>
.node-rail {
  flex: 0 0 var(--rail-width);
  width: var(--rail-width);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 0;
  background: var(--card-bg-secondary);
  backdrop-filter: blur(24px) saturate(160%);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  border-right: 1px solid var(--stroke-divider);
  overflow-y: auto;
}

.node-rail__logo {
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
  border: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 700;
  background: rgb(var(--colors-primary));
  color: var(--on-accent);
  margin-bottom: 0.5rem;
  cursor: pointer;
  overflow: hidden;
  text-decoration: none;
}

.node-rail__logo img {
  width: 100%;
  height: 100%;
  display: block;
}

.node-rail__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
  align-items: center;
}

.node-rail__item {
  width: 40px;
  height: 40px;
  aspect-ratio: 1;
  flex: 0 0 40px;
  box-sizing: border-box;
  padding: 0;
  border-radius: 50%;
  border: 2px solid transparent;
  background: var(--ctrl-fill-secondary);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  overflow: hidden;
  transition: background var(--fast-duration) var(--fast-out-slow-in);
}

.node-rail__item:hover {
  background: var(--ctrl-fill-tertiary);
}

.node-rail__item--active {
  border-color: rgb(var(--colors-primary));
  color: var(--text-primary);
}

.node-rail__avatar {
  width: 100%;
  height: 100%;
  display: block;
  border-radius: inherit;
  object-fit: cover;
}

.node-rail__item--add {
  font-size: 1.1rem;
  font-weight: 600;
  border-style: dashed;
  border-color: var(--ctrl-border);
}

.node-rail__overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: var(--overlay-scrim);
}

.node-rail__dialog {
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  border-radius: var(--radius-md);
  background: var(--dialog-background);
  border: 1px solid var(--card-stroke);
  box-shadow: var(--shadow-dialog);
}

.node-rail__dialog-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-primary);
}

@media (max-width: 768px) {
  .node-rail {
    display: none;
  }

  .shell__body[data-view='stronghold'] .node-rail {
    display: flex;
    flex-direction: row;
    flex: 0 0 auto;
    width: 100%;
    height: auto;
    padding: 0.5rem 0.75rem;
    overflow-x: auto;
    overflow-y: hidden;
    border-right: none;
    border-bottom: 1px solid var(--stroke-divider);
  }

  .shell__body[data-view='stronghold'] .node-rail__logo {
    margin-bottom: 0;
  }

  .shell__body[data-view='stronghold'] .node-rail__list {
    flex-direction: row;
    width: auto;
  }

  .shell__body[data-view='stronghold'] .node-rail__item {
    width: 44px;
    height: 44px;
    flex: 0 0 auto;
  }

  .shell__body[data-view='stronghold'] .node-rail__item:active {
    background: var(--ctrl-fill-tertiary);
  }
}
</style>
