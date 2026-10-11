<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { api } from '../api'
import { EMPTY_STATE } from '../assets/mew'
import { useAuth } from '../composables/useAuth'
import { useAuthModal } from '../composables/useAuthModal'
import { useChannel } from '../composables/useChannel'
import { useChatRoom } from '../composables/useChatRoom'
import { useEmotes } from '../composables/useEmotes'
import { useImageAttachments } from '../composables/useImageAttachments'
import { useInstanceConfig } from '../composables/useInstanceConfig'
import { useItemPermissions } from '../composables/useItemPermissions'
import { useStickyScroll } from '../composables/useStickyScroll'
import { useStronghold } from '../composables/useStronghold'
import { useStrongholdMembers } from '../composables/useStrongholdMembers'
import { actorLocalpart } from '../utils/actor'
import { buildEmoteLookup, standaloneEmoteToken } from '../utils/emote'
import { filterImageFiles } from '../utils/imageProcessing'
import { WinButton, WinInfoBar } from '../vendor/winui'
import EmotePicker from './EmotePicker.vue'
import EmptyState from './EmptyState.vue'
import AppIcon from './icons/AppIcon.vue'
import ItemContextMenu from './ItemContextMenu.vue'
import ImageEditor from './ImageEditor.vue'
import MessageBubble, { type MessageVM } from './MessageBubble.vue'

const auth = useAuth()
const { packs } = useEmotes()
const { openAuthModal } = useAuthModal()
const { isReadOnly, selectedNodeId } = useStronghold()
const { config: instanceConfig } = useInstanceConfig()
const { canEdit, canRetract } = useItemPermissions()
const { members } = useStrongholdMembers()
const { selectedChannel } = useChannel()
const {
  items,
  pending,
  historyLoading,
  hasMoreHistory,
  muted,
  loadOlder,
  loadUntil,
  sendText,
  resend,
  editMessage,
  retractMessage,
  toggleReaction,
} = useChatRoom()
const attachments = useImageAttachments()

const draft = ref('')
const editingSeq = ref<number | null>(null)
const editingText = ref('')
const showEmotePicker = ref(false)
const imageInput = ref<HTMLInputElement | null>(null)
const chatInput = ref<HTMLTextAreaElement | null>(null)
const imageQueue = ref<File[]>([])
const editingImage = ref<File | null>(null)
const canParticipate = computed(() => auth.isAuthenticated.value && !isReadOnly.value)
const emotesEnabled = computed(() => instanceConfig.value?.emotes_enabled !== false)
const reactionsEnabled = computed(() => instanceConfig.value?.reactions_enabled !== false)
const artAssetsEnabled = computed(() => instanceConfig.value?.art_assets_enabled !== false)
const CHAT_INPUT_MAX_HEIGHT = 140
const searchOpen = ref(false)
const searchQuery = ref('')
const searchSubmitted = ref(false)
const searchLoading = ref(false)
const searchResults = ref<Awaited<ReturnType<typeof api.searchRoomHistory>>>([])

// one shared context-menu instance for every message row (rather than one per
// row) - activeMessage tracks which row's right-click/long-press opened it.
const menuRef = ref<InstanceType<typeof ItemContextMenu> | null>(null)
const activeMessage = ref<MessageVM | null>(null)
const emoteLookup = computed(() => buildEmoteLookup(packs.value))

function displayName(actor: string): string {
  return members.value.find((m) => m.actor === actor)?.display_name ?? actorLocalpart(actor)
}

function avatarUrl(actor: string): string | null {
  return members.value.find((m) => m.actor === actor)?.avatar ?? null
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function canReactToMessage(text: string): boolean {
  return reactionsEnabled.value && canParticipate.value && standaloneEmoteToken(text, emoteLookup.value) === null
}

const messages = computed<MessageVM[]>(() => {
  const confirmed: MessageVM[] = items.value.map((item) => ({
    key: `s${item.seq}`,
    seq: item.seq,
    actor: item.actor,
    displayName: displayName(item.actor),
    avatarUrl: avatarUrl(item.actor),
    content: item.body.text ?? '',
    media: item.body.media,
    timestamp: formatTime(item.ts),
    editedAt: item.edited_at,
    mine: item.actor === auth.user.value?.actor,
    editable: canEdit(item.actor, item.ts),
    retractable: canRetract(item.actor, item.ts),
    pending: false,
    failed: false,
    reactions: item.reactions,
    canReact: canReactToMessage(item.body.text ?? ''),
  }))
  const optimistic: MessageVM[] = pending.value.map((p) => ({
    key: `p${p.clientId}`,
    seq: null,
    actor: auth.user.value?.actor ?? '',
    displayName: displayName(auth.user.value?.actor ?? ''),
    avatarUrl: auth.user.value?.avatar ?? null,
    content: p.text,
    media: p.media,
    timestamp: formatTime(p.ts),
    mine: true,
    editable: false,
    retractable: false,
    pending: p.status === 'sending',
    failed: p.status === 'failed',
    failReason: p.failReason,
    // no seq yet - nothing to attach a reaction to until the ack lands.
    canReact: false,
  }))
  return [...confirmed, ...optimistic]
})

const { el: scrollEl, pin, preserveOnPrepend } = useStickyScroll(() => messages.value.length)

const groupedMessages = computed(() =>
  messages.value.map((message, index) => {
    const previous = messages.value[index - 1]
    const grouped = previous !== undefined && previous.actor === message.actor && previous.mine === message.mine
    return { message, grouped }
  }),
)

function resizeInput() {
  const input = chatInput.value
  if (!input) return
  input.style.height = 'auto'
  const height = Math.min(input.scrollHeight, CHAT_INPUT_MAX_HEIGHT)
  input.style.height = `${height}px`
  input.style.overflowY = input.scrollHeight > CHAT_INPUT_MAX_HEIGHT ? 'auto' : 'hidden'
}

watch(draft, () => {
  void nextTick(resizeInput)
})

function submit() {
  if (muted.value || (!draft.value.trim() && !attachments.items.value.length)) return
  const text = draft.value
  const media = attachments.items.value.length ? [...attachments.items.value] : undefined
  draft.value = ''
  void nextTick(resizeInput)
  attachments.reset()
  sendText(text, media)
  pin()
}

function pickEmote(code: string) {
  showEmotePicker.value = false
  sendText(code)
  pin()
}

function onLoadOlder() {
  void preserveOnPrepend(loadOlder)
}

async function searchMessages() {
  const query = searchQuery.value.trim()
  const nodeId = selectedNodeId.value
  const room = selectedChannel.value
  if (!query || !nodeId || !room) return
  searchSubmitted.value = true
  searchLoading.value = true
  try {
    searchResults.value = await api.searchRoomHistory(auth.token.value, nodeId, room.id, query)
  } catch {
    searchResults.value = []
  } finally {
    searchLoading.value = false
  }
}

async function openSearchResult(seq: number) {
  if (!(await loadUntil(seq))) return
  searchOpen.value = false
  searchQuery.value = ''
  searchResults.value = []
  await nextTick()
  document.querySelector<HTMLElement>(`[data-message-seq="${seq}"]`)?.scrollIntoView({ block: 'center' })
}

watch(() => selectedChannel.value?.id, () => {
  searchResults.value = []
  searchSubmitted.value = false
})

function onEnter(event: KeyboardEvent) {
  if (event.shiftKey) return
  event.preventDefault()
  submit()
}

function pickImages() {
  imageInput.value?.click()
}

function onImageInputChange(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files?.length) queueImages(input.files)
  input.value = ''
}

function onPaste(event: ClipboardEvent) {
  const files = [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file != null)
  if (files.length) {
    event.preventDefault()
    queueImages(files)
  }
}

function onDrop(event: DragEvent) {
  event.preventDefault()
  const files = [...(event.dataTransfer?.files ?? [])]
  if (files.length) queueImages(files)
}

async function queueImages(files: Iterable<File>) {
  const { accepted, rejected } = await filterImageFiles(files)
  if (rejected) attachments.error.value = '仅支持图片文件'
  imageQueue.value.push(...accepted)
  if (!editingImage.value) editingImage.value = imageQueue.value.shift() ?? null
}

async function confirmImage(blob: Blob) {
  await attachments.addProcessed(blob)
  editingImage.value = imageQueue.value.shift() ?? null
}

function cancelImage() {
  editingImage.value = imageQueue.value.shift() ?? null
}

function startEdit(message: MessageVM) {
  if (message.seq == null) return
  editingSeq.value = message.seq
  editingText.value = message.content
}

function cancelEdit() {
  editingSeq.value = null
  editingText.value = ''
}

async function submitEdit() {
  if (editingSeq.value == null) return
  const ok = await editMessage(editingSeq.value, editingText.value)
  if (ok) cancelEdit()
}

async function onRetract(message: MessageVM) {
  if (message.seq == null) return
  if (!confirm('撤回这条消息？')) return
  await retractMessage(message.seq)
}

function onResend(message: MessageVM) {
  const clientId = message.key.startsWith('p') ? message.key.slice(1) : ''
  if (clientId) resend(clientId)
}

function onToggleReaction(message: MessageVM, name: string) {
  if (message.seq == null || !message.canReact) return
  toggleReaction(message.seq, name)
}

async function onOpenMessageMenu(message: MessageVM, x: number, y: number) {
  activeMessage.value = message
  // the menu sizes and gates itself off its props, which only carry this
  // message's permissions after the next render - opening in the same tick
  // reads the previous row's values, or none at all on the first open.
  await nextTick()
  menuRef.value?.openAt(x, y)
}

function onMenuEdit() {
  if (activeMessage.value) startEdit(activeMessage.value)
}

function onMenuRetract() {
  if (activeMessage.value) void onRetract(activeMessage.value)
}

function onMenuAddReaction(name: string) {
  if (activeMessage.value) onToggleReaction(activeMessage.value, name)
}

// a room switch always lands on the newest message, whatever the reader's
// position in the previous room was
watch(() => selectedChannel.value?.id, pin, { flush: 'post' })
</script>

<template>
  <section class="chat-pane">
    <form v-if="selectedChannel" class="chat-pane__search" role="search" @submit.prevent="searchMessages">
      <WinButton Style="SubtleButtonStyle" :aria-expanded="searchOpen" aria-label="搜索当前聊天" @click="searchOpen = !searchOpen">
        ⌕
      </WinButton>
      <template v-if="searchOpen">
        <input v-model="searchQuery" type="search" maxlength="200" placeholder="搜索当前聊天" aria-label="搜索聊天消息" />
        <WinButton Style="AccentButtonStyle" :IsEnabled="!!searchQuery.trim() && !searchLoading" type="submit">
          {{ searchLoading ? '搜索中…' : '搜索' }}
        </WinButton>
        <div v-if="searchSubmitted" class="chat-pane__search-results" aria-live="polite">
          <button v-for="item in searchResults" :key="item.seq" type="button" @click="openSearchResult(item.seq)">
            <span>{{ item.text }}</span><small>{{ new Date(item.ts).toLocaleString() }}</small>
          </button>
          <span v-if="!searchLoading && !searchResults.length">没有找到匹配内容</span>
        </div>
      </template>
    </form>
    <div ref="scrollEl" class="chat-pane__messages">
      <div v-if="hasMoreHistory" class="chat-pane__load-more">
        <WinButton Style="SubtleButtonStyle" :IsEnabled="!historyLoading" @click="onLoadOlder">
          {{ historyLoading ? '加载中…' : '加载更早的消息' }}
        </WinButton>
      </div>
      <EmptyState v-if="!groupedMessages.length && !historyLoading" :image="artAssetsEnabled ? EMPTY_STATE.chat : null" text="还没有消息，说点什么吧" />
      <MessageBubble
        v-for="entry in groupedMessages"
        :key="entry.message.key"
        :data-message-seq="entry.message.seq ?? undefined"
        :message="entry.message"
        :grouped="entry.grouped"
        :editing="entry.message.seq !== null && editingSeq === entry.message.seq"
        :reactions-enabled="reactionsEnabled"
        v-model:editing-text="editingText"
        @cancel-edit="cancelEdit"
        @submit-edit="submitEdit"
        @resend="onResend(entry.message)"
        @toggle-reaction="onToggleReaction(entry.message, $event)"
        @open-menu="(x, y) => onOpenMessageMenu(entry.message, x, y)"
      />
      <ItemContextMenu
        ref="menuRef"
        :can-react="activeMessage?.canReact ?? false"
        :can-edit="activeMessage?.editable ?? false"
        :can-retract="activeMessage?.retractable ?? false"
        :mine="activeMessage?.reactions?.mine"
        @add-reaction="onMenuAddReaction"
        @edit="onMenuEdit"
        @retract="onMenuRetract"
      />
    </div>
    <div v-if="canParticipate" class="chat-pane__compose-wrap" @dragover.prevent @drop="onDrop">
      <WinInfoBar v-if="muted" :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Warning">
        你在此据点被禁言
      </WinInfoBar>
      <WinInfoBar
        v-if="attachments.error.value"
        :IsOpen="true"
        :IsClosable="false"
        :IsIconVisible="false"
        Severity="Error"
        class="chat-pane__attach-error"
      >
        {{ attachments.error.value }}
      </WinInfoBar>
      <div v-if="attachments.items.value.length" class="chat-pane__attachments">
        <div v-for="item in attachments.items.value" :key="item.id" class="chat-pane__attachment">
          <img :src="item.url" alt="" />
          <button type="button" class="chat-pane__attachment-remove" title="移除" @click="attachments.remove(item.id)">
            <AppIcon name="close" :size="12" />
          </button>
        </div>
      </div>
      <div class="chat-pane__compose">
        <EmotePicker v-if="showEmotePicker && emotesEnabled" @pick="pickEmote" @close="showEmotePicker = false" />
        <WinButton
          v-if="emotesEnabled"
          Style="SubtleButtonStyle"
          class="chat-pane__emote-btn"
          title="表情"
          :IsEnabled="!muted"
          @click="showEmotePicker = !showEmotePicker"
        >
          <AppIcon name="emote" :size="18" />
        </WinButton>
        <input ref="imageInput" class="chat-pane__image-input" type="file" accept="image/*" multiple @change="onImageInputChange" />
        <WinButton
          Style="SubtleButtonStyle"
          class="chat-pane__image-btn"
          title="发送图片"
          :IsEnabled="!attachments.uploading.value && !muted"
          @click="pickImages"
        >
          <AppIcon name="image" :size="18" />
        </WinButton>
        <textarea
          ref="chatInput"
          v-model="draft"
          class="chat-pane__input"
          rows="1"
          :placeholder="muted ? '你在此据点被禁言' : '说点什么…'"
          :disabled="muted"
          @keydown.enter="onEnter"
          @input="resizeInput"
          @paste="onPaste"
        ></textarea>
        <WinButton Style="AccentButtonStyle" class="chat-pane__send" :IsEnabled="!muted" @click="submit">发送</WinButton>
      </div>
    </div>
    <div v-else-if="!auth.isAuthenticated.value" class="chat-pane__compose-wrap chat-pane__compose-wrap--guest">
      <p class="chat-pane__guest-text">登录后参与聊天</p>
      <WinButton Style="AccentButtonStyle" @click="openAuthModal">登录 / 注册</WinButton>
    </div>
    <div v-else class="chat-pane__compose-wrap chat-pane__compose-wrap--guest">
      <p class="chat-pane__guest-text">加入据点后参与聊天</p>
    </div>
    <ImageEditor :file="editingImage" :uploading="attachments.uploading.value" @confirm="confirmImage" @cancel="cancelImage" />
  </section>
</template>

<style scoped>
.chat-pane {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.chat-pane__search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--stroke-divider);
}

.chat-pane__search input {
  min-width: 0;
  flex: 1;
}

.chat-pane__search-results {
  position: absolute;
  z-index: 5;
  inset: 100% 0 auto;
  display: grid;
  max-height: 16rem;
  overflow-y: auto;
  background: var(--layer-default);
  border: 1px solid var(--stroke-divider);
  box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 18%);
}

.chat-pane__search-results button {
  display: grid;
  gap: 0.25rem;
  padding: 0.65rem 0.8rem;
  color: var(--text-primary);
  text-align: left;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--stroke-divider);
}

.chat-pane__search-results button:hover {
  background: var(--layer-secondary);
}

.chat-pane__search-results small,
.chat-pane__search-results > span {
  padding: 0.5rem 0.8rem;
  color: var(--text-tertiary);
}

.chat-pane__messages {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  /* vertical rhythm between rows now lives in MessageBubble's own margin
     (grouped vs. ungrouped), so no uniform gap here */
}

.chat-pane__load-more {
  display: flex;
  justify-content: center;
  margin-bottom: 0.75rem;
}

.chat-pane__compose-wrap {
  flex: 0 0 auto;
  background: var(--layer-default);
  backdrop-filter: blur(24px) saturate(160%);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  border-top: 1px solid var(--stroke-divider);
}

.chat-pane__compose-wrap--guest {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
}

.chat-pane__guest-text {
  margin: 0;
  font-size: 0.85rem;
  color: var(--text-tertiary);
}

.chat-pane__attach-error {
  margin: 0.6rem 1rem 0;
}

.chat-pane__attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding: 0.6rem 1rem 0;
}

.chat-pane__attachment {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: var(--radius-xs);
  overflow: hidden;
  border: 1px solid var(--card-stroke);
}

.chat-pane__attachment img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.chat-pane__attachment-remove {
  position: absolute;
  top: 0;
  right: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: var(--overlay-scrim-strong);
  color: var(--text-on-dark);
}

.chat-pane__compose {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
}

.chat-pane__emote-btn,
.chat-pane__image-btn {
  flex: 0 0 auto;
  min-height: 40px;
  padding: 0 0.7rem;
  border-radius: var(--radius-md);
  font-size: 1.1rem;
}

.chat-pane__image-input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.chat-pane__input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 40px;
  max-height: 140px;
  padding: 0.5rem 0.85rem;
  border-radius: var(--radius-md);
  background: var(--ctrl-fill-default);
  border: 1px solid var(--ctrl-border);
  border-bottom: 2px solid transparent;
  color: var(--text-primary);
  font: inherit;
  line-height: 1.4;
  overflow-y: hidden;
  resize: none;
  transition:
    border-color var(--fast-duration) var(--fast-out-slow-in),
    background var(--fast-duration) var(--fast-out-slow-in);
}

.chat-pane__input::placeholder {
  color: var(--text-tertiary);
}

.chat-pane__input:hover {
  background: var(--ctrl-fill-secondary);
}

.chat-pane__input:focus {
  outline: none;
  background: var(--ctrl-fill-default);
  border-bottom-color: rgb(var(--colors-primary));
}

.chat-pane__send {
  flex: 0 0 auto;
  min-height: 40px;
  padding: 0 1.1rem;
  border-radius: var(--radius-md);
}
</style>
