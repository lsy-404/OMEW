<script setup lang="ts">
import RequestJoin from './RequestJoin.vue'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, ApiRequestError } from '../api'
import type { DirectoryEntry } from '../api/types'
import { useAuth } from '../composables/useAuth'
import { useStronghold } from '../composables/useStronghold'
import { WinButton } from '../vendor/winui'

// authenticated discovery + join (F1): NodeRail opens this alongside "创建
// 据点" so a logged-in user without any stronghold yet has a way to find and
// join a public one - the guest shell already gets a directory via
// useStronghold's guest path, this is the member-side equivalent.

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const auth = useAuth()
const { joinedNodeIds, selectedNodeId, loadStrongholds } = useStronghold()

const entries = ref<DirectoryEntry[]>([])
const loading = ref(false)
const loadError = ref('')
const joiningId = ref('')

function isJoined(id: string): boolean {
  return joinedNodeIds.value.has(id)
}

async function loadDirectory() {
  loading.value = true
  loadError.value = ''
  try {
    entries.value = await api.getDirectory()
  } catch {
    loadError.value = '无法加载据点目录'
  } finally {
    loading.value = false
  }
}

async function join(entry: DirectoryEntry) {
  if (!auth.token.value || joiningId.value || isJoined(entry.id)) return
  joiningId.value = entry.id
  try {
    await api.joinStronghold(auth.token.value, entry.id)
    await loadStrongholds(true)
    selectedNodeId.value = entry.id
    emit('close')
  } catch (err) {
    loadError.value = err instanceof ApiRequestError ? '加入失败，请稍后重试' : '网络错误，请稍后重试'
  } finally {
    joiningId.value = ''
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void loadDirectory()
  },
)

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.open) emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="directory-modal">
      <div v-if="open" class="directory-modal-overlay" @click.self="emit('close')">
        <div class="directory-modal" role="dialog" aria-modal="true">
          <div class="directory-modal__header">
            <h2 class="directory-modal__title">发现据点</h2>
            <WinButton Style="SubtleButtonStyle" @click="emit('close')">关闭</WinButton>
          </div>

          <div class="directory-modal__scroll">
            <p v-if="loading" class="directory-modal__status">加载中…</p>
            <p v-else-if="loadError" class="directory-modal__status directory-modal__status--error">{{ loadError }}</p>
            <p v-else-if="!entries.length" class="directory-modal__status">暂无可加入的公开据点</p>

            <ul v-else class="directory-modal__list">
              <li v-for="entry in entries" :key="entry.id" class="directory-entry">
                <div class="directory-entry__avatar">
                  <img v-if="entry.avatar" :src="entry.avatar" :alt="entry.name" />
                  <span v-else class="directory-entry__avatar-placeholder" aria-hidden="true">{{ entry.name.slice(0, 1) }}</span>
                </div>
                <div class="directory-entry__body">
                  <span class="directory-entry__name">{{ entry.name }}</span>
                  <p v-if="entry.description" class="directory-entry__desc">{{ entry.description }}</p>
                  <span class="directory-entry__meta">{{ entry.member_count }} 位成员</span>
                </div>
                <WinButton
                  Style="AccentButtonStyle"
                  class="directory-entry__join"
                  :IsEnabled="!isJoined(entry.id) && joiningId !== entry.id"
                  @click="join(entry)"
                >
                  {{ isJoined(entry.id) ? '已加入' : joiningId === entry.id ? '加入中…' : '加入' }}
                </WinButton>
              </li>
            </ul>
            <RequestJoin />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.directory-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: var(--overlay-scrim);
}

.directory-modal {
  position: relative;
  width: 56%;
  min-width: 320px;
  max-width: 560px;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-md);
  background: var(--dialog-background);
  border: 1px solid var(--card-stroke);
  box-shadow: var(--shadow-dialog);
  overflow: hidden;
}

.directory-modal-enter-active,
.directory-modal-leave-active {
  transition: opacity var(--normal-duration) var(--fast-out-slow-in);
}

.directory-modal-enter-active .directory-modal,
.directory-modal-leave-active .directory-modal {
  transition:
    opacity var(--normal-duration) var(--fast-out-slow-in),
    transform var(--normal-duration) var(--fast-out-slow-in);
}

.directory-modal-enter-from,
.directory-modal-leave-to {
  opacity: 0;
}

.directory-modal-enter-from .directory-modal,
.directory-modal-leave-to .directory-modal {
  opacity: 0;
  transform: scale(0.94) translateY(12px);
}

@media (prefers-reduced-motion: reduce) {
  .directory-modal-enter-active,
  .directory-modal-leave-active,
  .directory-modal-enter-active .directory-modal,
  .directory-modal-leave-active .directory-modal {
    transition: none !important;
  }
}

.directory-modal__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem 0.5rem;
}

.directory-modal__title {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text-primary);
}

.directory-modal__scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 0.5rem 1.25rem 1.25rem;
}

.directory-modal__status {
  padding: 2rem 0;
  text-align: center;
  font-size: 0.85rem;
  color: var(--text-tertiary);
}

.directory-modal__status--error {
  color: var(--critical-text);
}

.directory-modal__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.directory-entry {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem;
  border-radius: var(--radius-sm);
  background: var(--ctrl-fill-secondary);
}

.directory-entry__avatar {
  flex: 0 0 44px;
  flex-shrink: 0;
  width: 44px;
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: rgb(var(--colors-primary));
  color: var(--on-accent);
}

.directory-entry__avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.directory-entry__avatar-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  font-weight: 700;
}

.directory-entry__body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.directory-entry__name {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-primary);
}

.directory-entry__desc {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.4;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.directory-entry__meta {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

.directory-entry__join {
  flex: 0 0 auto;
}

@media (max-width: 768px) {
  .directory-modal-overlay {
    padding: 0;
  }

  .directory-modal {
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    border-radius: 0;
    background: var(--dialog-background);
  }
}
</style>
