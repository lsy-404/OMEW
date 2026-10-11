<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api, ApiRequestError } from '../api'
import type { RoomSummary } from '../api/types'
import { useAuth } from '../composables/useAuth'
import { useStronghold } from '../composables/useStronghold'
import { maxLengthError, requiredMaxLengthError } from '../utils/validate'
import { WinButton } from '../vendor/winui'
import AppIcon from './icons/AppIcon.vue'

const props = withDefaults(defineProps<{ type?: 'channel' | 'section' }>(), { type: 'section' })

const roomLabel = computed(() => (props.type === 'channel' ? '话题' : '话题组'))
const roomCountLabel = computed(() => (props.type === 'channel' ? '' : '篇帖子'))

const auth = useAuth()
const { selectedNodeId, loadStrongholds } = useStronghold()

const busy = ref(false)
const listError = ref('')

// the by-id rooms endpoint is the only one carrying post_count - the cached
// stronghold list deliberately skips it, so load rooms here rather than
// deriving them from currentNode.
const rooms = ref<RoomSummary[]>([])

async function loadSections() {
  if (!selectedNodeId.value) return
  try {
    const loadedRooms = await api.getStrongholdRooms(auth.token.value, selectedNodeId.value)
    rooms.value = loadedRooms.filter((r) => r.type === props.type)
  } catch {
    listError.value = `加载${roomLabel.value}失败`
  }
}

onMounted(loadSections)
watch(selectedNodeId, loadSections)

const editingId = ref<string | null>(null)
const editingName = ref('')
const editingDescription = ref('')
const editingVoiceEnabled = ref(false)
const editError = ref('')
const descError = ref('')

function startEdit(room: RoomSummary) {
  editingId.value = room.id
  editingName.value = room.name
  editingDescription.value = room.description ?? ''
  editingVoiceEnabled.value = room.capabilities.includes('voice')
  editError.value = ''
  descError.value = ''
}

function cancelEdit() {
  editingId.value = null
  editError.value = ''
  descError.value = ''
}

async function saveEdit(room: RoomSummary) {
  if (!auth.token.value) return
  editError.value = requiredMaxLengthError(editingName.value, 32, '名称')
  descError.value = maxLengthError(editingDescription.value, 64, '描述')
  if (editError.value || descError.value) return
  busy.value = true
  try {
    await api.patchRoom(auth.token.value, selectedNodeId.value, room.id, {
      name: editingName.value.trim(),
      description: editingDescription.value.trim() || null,
      capabilities: [...room.capabilities.filter((capability) => capability !== 'voice'), ...(editingVoiceEnabled.value ? ['voice'] : [])],
    })
    await Promise.all([loadStrongholds(true), loadSections()])
    editingId.value = null
  } catch {
    editError.value = '保存失败，请稍后重试'
  } finally {
    busy.value = false
  }
}

async function reorder(list: RoomSummary[]) {
  const token = auth.token.value
  if (!token) return
  busy.value = true
  listError.value = ''
  try {
    // 房间的 position 可以为空（建房间时不设），只改被交换/拖动的两项会让它们排到未设过的
    // 房间之后，所以每次排序都按下标重写整列。
    await Promise.all(list.map((r, i) => api.patchRoom(token, selectedNodeId.value, r.id, { position: i })))
    await Promise.all([loadStrongholds(true), loadSections()])
  } catch {
    listError.value = '排序失败，请稍后重试'
  } finally {
    busy.value = false
  }
}

async function move(room: RoomSummary, dir: -1 | 1) {
  const list = [...rooms.value]
  const idx = list.findIndex((r) => r.id === room.id)
  const swap = idx + dir
  if (idx < 0 || swap < 0 || swap >= list.length) return
  ;[list[idx], list[swap]] = [list[swap]!, list[idx]!]
  await reorder(list)
}

// ---- drag reorder (desktop only, ≤768px 断点回退到上下移按钮) ----
const dragFromIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

function onDragStart(idx: number, ev: DragEvent) {
  dragFromIndex.value = idx
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('text/plain', String(idx))
  }
}

function onDragOver(idx: number, ev: DragEvent) {
  ev.preventDefault()
  dragOverIndex.value = idx
}

function onDragLeave(idx: number) {
  if (dragOverIndex.value === idx) dragOverIndex.value = null
}

function onDragEnd() {
  dragFromIndex.value = null
  dragOverIndex.value = null
}

async function onDrop(idx: number, ev: DragEvent) {
  ev.preventDefault()
  const from = dragFromIndex.value
  dragFromIndex.value = null
  dragOverIndex.value = null
  if (from === null || from === idx) return
  const list = [...rooms.value]
  const [moved] = list.splice(from, 1)
  if (!moved) return
  list.splice(idx, 0, moved)
  await reorder(list)
}

async function remove(room: RoomSummary) {
  if (!auth.token.value) return
  const detail = props.type === 'channel' ? '其中的聊天记录将一并移除，此操作不可撤销。' : '其中的帖子将一并移除，此操作不可撤销。'
  if (!confirm(`删除${roomLabel.value}「${room.name}」？${detail}`)) return
  busy.value = true
  listError.value = ''
  try {
    await api.deleteRoom(auth.token.value, selectedNodeId.value, room.id)
    await Promise.all([loadStrongholds(true), loadSections()])
  } catch (err) {
    listError.value = err instanceof ApiRequestError && err.code === 'LAST_ROOM_OF_TYPE' ? `至少保留一个${roomLabel.value}` : '删除失败，请稍后重试'
  } finally {
    busy.value = false
  }
}

// ---- create ----
const newName = ref('')
const createError = ref('')
const creating = ref(false)
const createVoiceEnabled = ref(false)

async function create() {
  if (!auth.token.value) return
  createError.value = requiredMaxLengthError(newName.value, 32, '名称')
  if (createError.value) return
  creating.value = true
  try {
    await api.createRoom(auth.token.value, selectedNodeId.value, {
      name: newName.value.trim(),
      type: props.type,
      capabilities: ['text', ...(props.type === 'channel' && createVoiceEnabled.value ? ['voice'] : [])],
    })
    await Promise.all([loadStrongholds(true), loadSections()])
    newName.value = ''
    createVoiceEnabled.value = false
  } catch {
    createError.value = '创建失败，请稍后重试'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="section-manager">
    <p v-if="listError" class="field__error">{{ listError }}</p>
    <p v-if="!rooms.length" class="field__hint">暂无{{ roomLabel }}</p>

    <ul v-else class="section-list">
      <li
        v-for="(room, idx) in rooms"
        :key="room.id"
        class="section-row"
        :class="{ 'section-row--drag-over': dragOverIndex === idx, 'section-row--dragging': dragFromIndex === idx }"
        @dragover="onDragOver(idx, $event)"
        @dragleave="onDragLeave(idx)"
        @drop="onDrop(idx, $event)"
      >
        <span
          class="drag-handle only-desktop"
          draggable="true"
          title="拖拽排序"
          @dragstart="onDragStart(idx, $event)"
          @dragend="onDragEnd"
        >
          <span class="drag-handle__bar" /><span class="drag-handle__bar" /><span class="drag-handle__bar" />
        </span>
        <template v-if="editingId === room.id">
          <div class="field section-row__edit">
            <input v-model="editingName" type="text" maxlength="32" @keyup.enter="saveEdit(room)" @keyup.escape="cancelEdit" />
            <p v-if="editError" class="field__error">{{ editError }}</p>
            <input v-model="editingDescription" type="text" maxlength="64" :placeholder="`${roomLabel}描述（可选，≤64 字）`" @keyup.enter="saveEdit(room)" @keyup.escape="cancelEdit" />
            <p v-if="descError" class="field__error">{{ descError }}</p>
            <label v-if="props.type === 'channel'" class="room-capability">
              <input v-model="editingVoiceEnabled" type="checkbox" />
              启用语音
            </label>
          </div>
          <div class="section-row__actions">
            <WinButton Style="AccentButtonStyle" :IsEnabled="!busy" @click="saveEdit(room)">保存</WinButton>
            <WinButton Style="SubtleButtonStyle" :IsEnabled="!busy" @click="cancelEdit">取消</WinButton>
          </div>
        </template>
        <template v-else>
          <div class="section-row__info">
            <span class="section-row__name">{{ room.name }}</span>
            <span class="section-row__desc" :class="{ 'section-row__desc--empty': !room.description }">
              {{ room.description || '暂无描述' }}
            </span>
          </div>
          <span v-if="roomCountLabel" class="section-row__count">{{ room.post_count ?? 0 }} {{ roomCountLabel }}</span>
          <div class="section-row__actions">
            <button type="button" class="icon-btn only-mobile" title="上移" :disabled="busy || idx === 0" @click="move(room, -1)">
              <AppIcon name="chevron-right" :size="16" class="icon-btn__rotate-up" />
            </button>
            <button
              type="button"
              class="icon-btn only-mobile"
              title="下移"
              :disabled="busy || idx === rooms.length - 1"
              @click="move(room, 1)"
            >
              <AppIcon name="chevron-right" :size="16" class="icon-btn__rotate-down" />
            </button>
            <WinButton Style="SubtleButtonStyle" :IsEnabled="!busy" @click="startEdit(room)">编辑</WinButton>
            <WinButton Style="SubtleButtonStyle" class="win-btn--danger" :IsEnabled="!busy" @click="remove(room)">删除</WinButton>
          </div>
        </template>
      </li>
    </ul>

    <div class="section-create">
      <div class="field section-create__field">
        <input v-model="newName" type="text" maxlength="32" :placeholder="`新建${roomLabel}名称`" @keyup.enter="create" />
        <p v-if="createError" class="field__error">{{ createError }}</p>
        <label v-if="props.type === 'channel'" class="room-capability">
          <input v-model="createVoiceEnabled" type="checkbox" />
          启用语音
        </label>
      </div>
      <WinButton Style="DefaultButtonStyle" :IsEnabled="!creating" @click="create">
        {{ creating ? '创建中…' : `新建${roomLabel}` }}
      </WinButton>
    </div>
  </div>
</template>

<style scoped>
.section-manager {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.section-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.section-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  padding: 0.65rem 0.85rem;
  border-radius: var(--radius-sm);
  background: var(--card-bg);
  border: 1px solid var(--card-stroke);
}

.section-row__info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.section-row__name {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-row__desc {
  font-size: 0.75rem;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-row__desc--empty {
  font-style: italic;
}

.section-row__count {
  flex: 0 0 auto;
  font-size: 0.75rem;
  color: var(--text-tertiary);
}

.section-row__edit {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.section-row__edit input + input {
  margin-top: 0.1rem;
}

.section-row__actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-left: auto;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--card-stroke);
  border-radius: var(--radius-sm);
  background: var(--ctrl-fill-secondary);
  color: var(--text-secondary);
  cursor: pointer;
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.icon-btn__rotate-up {
  transform: rotate(-90deg);
}

.icon-btn__rotate-down {
  transform: rotate(90deg);
}

.section-create {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding-top: 0.4rem;
  border-top: 1px solid var(--card-stroke);
}

.room-capability {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  width: fit-content;
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.section-create__field {
  flex: 1 1 auto;
  margin: 0;
}

.drag-handle {
  display: inline-flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 20px;
  height: 28px;
  cursor: grab;
}

.drag-handle__bar {
  width: 14px;
  height: 2px;
  border-radius: 1px;
  background: var(--text-tertiary);
}

.section-row--drag-over {
  border-color: rgb(var(--colors-primary));
  background: var(--card-bg-secondary);
}

.section-row--dragging {
  opacity: 0.5;
}

.only-mobile {
  display: none;
}

@media (max-width: 768px) {
  .only-desktop {
    display: none !important;
  }

  .only-mobile {
    display: inline-flex !important;
  }
}
</style>
