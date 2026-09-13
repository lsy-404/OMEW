<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PostReply } from '../api/types'
import { useAuth } from '../composables/useAuth'
import { useAuthModal } from '../composables/useAuthModal'
import { useContextMenuGesture } from '../composables/useContextMenuGesture'
import { useItemPermissions } from '../composables/useItemPermissions'
import { useInstanceConfig } from '../composables/useInstanceConfig'
import { usePostModal } from '../composables/usePostModal'
import { useSectionRoom } from '../composables/useSectionRoom'
import { useStronghold } from '../composables/useStronghold'
import { useStrongholdMembers } from '../composables/useStrongholdMembers'
import { actorLocalpart } from '../utils/actor'
import { markdownEmbedsImageUrl } from '../utils/markdownPreview'
import { WinButton } from '../vendor/winui'
import AvatarBadge from './AvatarBadge.vue'
import AppIcon from './icons/AppIcon.vue'
import ItemContextMenu from './ItemContextMenu.vue'
import MediaGrid from './MediaGrid.vue'
import ReactionChips from './ReactionChips.vue'

const MarkdownContent = defineAsyncComponent(() => import('./MarkdownContent.vue'))

const auth = useAuth()
const { openAuthModal } = useAuthModal()
const { isReadOnly } = useStronghold()
const { openPostSeq, close } = usePostModal()
const {
  thread,
  threadLoading,
  threadRepliesLoading,
  threadHasMore,
  openThread,
  closeThread,
  loadMoreReplies,
  createReply,
  toggleReaction,
  editItem,
  retractItem,
} = useSectionRoom()
const { members } = useStrongholdMembers()
const { canEdit, canRetract } = useItemPermissions()
const { config: instanceConfig } = useInstanceConfig()

const replyDraft = ref('')
const replyError = ref('')
const editingSeq = ref<number | null>(null)
const editingText = ref('')
const actionNotice = ref('')
const canParticipate = computed(() => auth.isAuthenticated.value && !isReadOnly.value)
const reactionsEnabled = computed(() => instanceConfig.value?.reactions_enabled !== false)
const builtinReactionsEnabled = computed(
  () => instanceConfig.value?.reactions_enabled !== false && instanceConfig.value?.builtin_reactions_enabled !== false,
)

function displayName(actor: string): string {
  return members.value.find((m) => m.actor === actor)?.display_name ?? actorLocalpart(actor)
}

function avatarUrl(actor: string): string | undefined {
  return members.value.find((m) => m.actor === actor)?.avatar ?? undefined
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

watch(openPostSeq, (seq) => {
  editingSeq.value = null
  actionNotice.value = ''
  if (seq != null) void openThread(seq)
  else closeThread()
})

function submitReply() {
  replyError.value = ''
  if (!replyDraft.value.trim()) return
  const ok = createReply(replyDraft.value)
  if (!ok) {
    replyError.value = '发送失败，连接尚未就绪，请稍后再试'
    return
  }
  replyDraft.value = ''
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && openPostSeq.value != null) close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// ---- post body + reply context menu / reactions --------------------------

// original text of whatever's currently in editingSeq, to detect an
// unsaved change before switching to editing a different item.
function originalTextFor(seq: number): string | undefined {
  if (thread.value?.post.post_seq === seq) return thread.value.post.text
  return thread.value?.replies.find((r) => r.seq === seq)?.body.text
}

function startEdit(seq: number, text: string) {
  if (editingSeq.value != null && editingSeq.value !== seq) {
    const original = originalTextFor(editingSeq.value)
    const dirty = original != null && editingText.value !== original
    if (dirty && !confirm('放弃这条未保存的编辑？')) return
  }
  editingSeq.value = seq
  editingText.value = text
}

function cancelEdit() {
  editingSeq.value = null
  editingText.value = ''
}

async function submitEdit() {
  if (editingSeq.value == null) return
  const ok = await editItem(editingSeq.value, editingText.value)
  if (ok) cancelEdit()
}

async function onRetract(seq: number) {
  if (!confirm('撤回这条内容？')) return
  await retractItem(seq)
}

const postMenuRef = ref<InstanceType<typeof ItemContextMenu> | null>(null)
const postGesture = useContextMenuGesture(
  (x, y) => postMenuRef.value?.openAt(x, y),
  () => !!thread.value && (canParticipate.value || canEdit(thread.value.post.actor, thread.value.post.created_at) || canRetract(thread.value.post.actor, thread.value.post.created_at)),
)

// guards mirror MessageBubble's: the in-place edit textarea keeps its own
// native right-click menu instead of opening the custom one.
function onPostContextMenu(event: MouseEvent) {
  if (thread.value && editingSeq.value !== thread.value.post.post_seq) postGesture.onContextMenu(event)
}
function onPostTouchStart(event: TouchEvent) {
  if (thread.value && editingSeq.value !== thread.value.post.post_seq) postGesture.onTouchStart(event)
}

// One shared flyout for every reply row (rather than one instance per reply)
// - `activeReply` tracks which row's right-click/long-press opened it, so
// canEdit/canRetract/mine below reflect that specific reply.
const replyMenuRef = ref<InstanceType<typeof ItemContextMenu> | null>(null)
const activeReply = ref<PostReply | null>(null)

let replyPressTimer: ReturnType<typeof setTimeout> | null = null
let replyPressX = 0
let replyPressY = 0

function clearReplyPressTimer() {
  if (replyPressTimer != null) {
    clearTimeout(replyPressTimer)
    replyPressTimer = null
  }
}

async function openReplyMenu(reply: PostReply, x: number, y: number) {
  activeReply.value = reply
  // see ChatPane's onOpenMessageMenu: the menu reads its own props to size and
  // gate itself, so it can only open once this reply's values have rendered.
  await nextTick()
  replyMenuRef.value?.openAt(x, y)
}

// mirrors useContextMenuGesture's own canOpen/text-selection gating - this
// reply list is inline markup rather than a MessageBubble-style component,
// so it predates and duplicates that composable instead of using it.
function replyCanOpenMenu(reply: PostReply): boolean {
  return canParticipate.value || canEdit(reply.actor, reply.ts) || canRetract(reply.actor, reply.ts)
}

function hasTextSelection(): boolean {
  const selection = window.getSelection()
  return !!selection && !selection.isCollapsed && selection.toString().length > 0
}

function onReplyContextMenu(reply: PostReply, event: MouseEvent) {
  if (editingSeq.value === reply.seq) return
  if (!replyCanOpenMenu(reply) || hasTextSelection()) return
  event.preventDefault()
  event.stopPropagation()
  openReplyMenu(reply, event.clientX, event.clientY)
}

function onReplyTouchStart(reply: PostReply, event: TouchEvent) {
  if (editingSeq.value === reply.seq) return
  event.stopPropagation()
  clearReplyPressTimer()
  if (window.innerWidth > 768 || event.touches.length !== 1) return
  const touch = event.touches[0]!
  replyPressX = touch.clientX
  replyPressY = touch.clientY
  replyPressTimer = setTimeout(() => {
    replyPressTimer = null
    openReplyMenu(reply, replyPressX, replyPressY)
  }, 500)
}

function onReplyTouchMove(event: TouchEvent) {
  if (replyPressTimer == null) return
  const touch = event.touches[0]
  if (!touch) return
  if (Math.abs(touch.clientX - replyPressX) > 10 || Math.abs(touch.clientY - replyPressY) > 10) clearReplyPressTimer()
}

onBeforeUnmount(clearReplyPressTimer)

function onReplyEdit() {
  const reply = activeReply.value
  if (!reply) return
  startEdit(reply.seq, reply.body.text ?? '')
}

async function onReplyRetract() {
  const reply = activeReply.value
  if (!reply) return
  await onRetract(reply.seq)
}

function onReplyToggleReaction(reply: PostReply, name: string) {
  toggleReaction(reply.seq, name)
}

async function sharePost() {
  const post = thread.value?.post
  if (!post) return
  actionNotice.value = ''
  const shareData = { title: post.title, text: post.title, url: window.location.href }
  if (navigator.share) {
    try {
      await navigator.share(shareData)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) actionNotice.value = '未能打开系统转发'
    }
    return
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(shareData.url)
      actionNotice.value = '链接已复制'
      return
    }
    actionNotice.value = '当前浏览器不支持转发'
  } catch {
    actionNotice.value = '未能复制链接'
  }
}

function openReactionPicker(event: MouseEvent) {
  if (!reactionsEnabled.value || !builtinReactionsEnabled.value) return
  actionNotice.value = ''
  if (!auth.isAuthenticated.value) {
    openAuthModal()
    return
  }
  if (!canParticipate.value) {
    actionNotice.value = '加入据点后即可添加反应'
    return
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  postMenuRef.value?.openAt(rect.left + rect.width / 2, rect.top)
}

function onActiveReplyToggleReaction(name: string) {
  if (activeReply.value) onReplyToggleReaction(activeReply.value, name)
}

const replyCanEdit = computed(() => (activeReply.value ? canEdit(activeReply.value.actor, activeReply.value.ts) : false))
const replyCanRetract = computed(() => (activeReply.value ? canRetract(activeReply.value.actor, activeReply.value.ts) : false))
const visiblePostMedia = computed(() => {
  const post = thread.value?.post
  if (!post?.media?.length) return []
  return post.media.filter((item) => !markdownEmbedsImageUrl(post.text, item.url))
})
</script>

<template>
  <Teleport to="body">
    <Transition name="post-modal">
      <div v-if="openPostSeq != null" class="post-modal-overlay" @click.self="close">
        <div class="post-modal" role="dialog" aria-modal="true">
          <WinButton Style="SubtleButtonStyle" class="post-modal__close" @click="close">关闭</WinButton>

          <div v-if="threadLoading && !thread" class="post-modal__loading">加载中…</div>

          <div v-else-if="thread" class="post-modal__scroll">
            <img v-if="thread.post.cover" class="post-modal__cover" :src="thread.post.cover" :alt="thread.post.title" />
            <div class="post-modal__body">
              <div
                class="post-modal__post-content"
                @contextmenu="onPostContextMenu"
                @touchstart.passive="onPostTouchStart"
                @touchmove.passive="postGesture.onTouchMove"
                @touchend="postGesture.onTouchEnd"
                @touchcancel="postGesture.onTouchCancel"
              >
                <h1 class="post-modal__title">{{ thread.post.title }}</h1>
                <div class="post-modal__author-row">
                  <AvatarBadge :seed="displayName(thread.post.actor)" :size="36" :avatar-url="avatarUrl(thread.post.actor)" />
                  <div class="post-modal__author-meta">
                    <span class="post-modal__author-name">{{ displayName(thread.post.actor) }}</span>
                    <span class="post-modal__time">{{ formatTime(thread.post.created_at) }}</span>
                  </div>
                </div>
                <template v-if="editingSeq === thread.post.post_seq">
                  <textarea v-model="editingText" class="post-modal__edit-input" rows="4" @keydown.esc="cancelEdit"></textarea>
                  <div class="post-modal__edit-actions">
                    <WinButton Style="SubtleButtonStyle" @click="submitEdit">保存</WinButton>
                    <WinButton Style="SubtleButtonStyle" @click="cancelEdit">取消</WinButton>
                  </div>
                </template>
                <template v-else>
                  <MarkdownContent :text="thread.post.text" />
                  <MediaGrid v-if="visiblePostMedia.length" :media="visiblePostMedia" />
                </template>
                <div class="post-modal__actions" role="group" aria-label="帖子操作">
                  <button type="button" class="post-modal__action" aria-label="转发" title="转发" @click="sharePost">
                    <AppIcon name="repeat" :size="19" />
                  </button>
                  <button v-if="reactionsEnabled && builtinReactionsEnabled" type="button" class="post-modal__action" aria-label="添加反应" title="添加反应" @click="openReactionPicker">
                    <AppIcon name="emote" :size="19" />
                  </button>
                </div>
                <p v-if="actionNotice" class="post-modal__action-notice" role="status">{{ actionNotice }}</p>
                <ReactionChips
                  v-if="reactionsEnabled"
                  :reactions="thread.post.reactions"
                  :can-toggle="reactionsEnabled && canParticipate"
                  @toggle="toggleReaction(thread.post.post_seq, $event)"
                />
                <ItemContextMenu
                  ref="postMenuRef"
                  :can-react="reactionsEnabled && canParticipate"
                  :can-edit="canEdit(thread.post.actor, thread.post.created_at)"
                  :can-retract="canRetract(thread.post.actor, thread.post.created_at)"
                  :mine="thread.post.reactions?.mine"
                  @add-reaction="toggleReaction(thread.post.post_seq, $event)"
                  @edit="startEdit(thread.post.post_seq, thread.post.text)"
                  @retract="onRetract(thread.post.post_seq)"
                />
              </div>

              <div class="post-modal__comments">
                <h2 class="post-modal__comments-title">评论（{{ thread.post.reply_count }}）</h2>
                <p v-if="!thread.replies.length" class="post-modal__comments-empty">暂无评论，来说两句吧。</p>
                <ul v-else class="post-modal__reply-list">
                  <li
                    v-for="reply in thread.replies"
                    :key="reply.seq"
                    class="post-modal__reply"
                    @contextmenu="onReplyContextMenu(reply, $event)"
                    @touchstart.passive="onReplyTouchStart(reply, $event)"
                    @touchmove.passive="onReplyTouchMove"
                    @touchend="clearReplyPressTimer"
                    @touchcancel="clearReplyPressTimer"
                  >
                    <AvatarBadge :seed="displayName(reply.actor)" :size="28" :avatar-url="avatarUrl(reply.actor)" />
                    <div class="post-modal__reply-body">
                      <div class="post-modal__reply-meta">
                        <span class="post-modal__reply-author">{{ displayName(reply.actor) }}</span>
                        <span class="post-modal__time">{{ formatTime(reply.ts) }}</span>
                      </div>
                      <template v-if="editingSeq === reply.seq">
                        <textarea v-model="editingText" class="post-modal__edit-input" rows="2" @keydown.esc="cancelEdit"></textarea>
                        <div class="post-modal__edit-actions">
                          <WinButton Style="SubtleButtonStyle" @click="submitEdit">保存</WinButton>
                          <WinButton Style="SubtleButtonStyle" @click="cancelEdit">取消</WinButton>
                        </div>
                      </template>
                      <template v-else>
                        <p class="post-modal__reply-text">{{ reply.body.text }}</p>
                        <MediaGrid v-if="reply.body.media?.length" :media="reply.body.media" />
                      </template>
                      <ReactionChips
                        v-if="reactionsEnabled"
                        :reactions="reply.reactions"
                        :can-toggle="reactionsEnabled && canParticipate"
                        @toggle="onReplyToggleReaction(reply, $event)"
                      />
                    </div>
                  </li>
                </ul>
                <ItemContextMenu
                  ref="replyMenuRef"
                  :can-react="reactionsEnabled && canParticipate"
                  :can-edit="replyCanEdit"
                  :can-retract="replyCanRetract"
                  :mine="activeReply?.reactions?.mine"
                  @add-reaction="onActiveReplyToggleReaction"
                  @edit="onReplyEdit"
                  @retract="onReplyRetract"
                />
                <div v-if="threadHasMore" class="post-modal__more">
                  <WinButton Style="SubtleButtonStyle" :IsEnabled="!threadRepliesLoading" @click="loadMoreReplies">
                    {{ threadRepliesLoading ? '加载中…' : '加载更多评论' }}
                  </WinButton>
                </div>

                <div v-if="canParticipate" class="post-modal__reply-form">
                  <textarea v-model="replyDraft" rows="2" placeholder="写评论…"></textarea>
                  <p v-if="replyError" class="field__error">{{ replyError }}</p>
                  <WinButton Style="AccentButtonStyle" class="post-modal__reply-submit" @click="submitReply">回复</WinButton>
                </div>
                <div v-else-if="!auth.isAuthenticated.value" class="post-modal__reply-form post-modal__reply-form--guest">
                  <p class="field__hint">登录后参与评论</p>
                  <WinButton Style="AccentButtonStyle" @click="openAuthModal">登录 / 注册</WinButton>
                </div>
                <div v-else class="post-modal__reply-form post-modal__reply-form--guest">
                  <p class="field__hint">加入据点后参与评论</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.post-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: var(--overlay-scrim);
}

.post-modal {
  position: relative;
  width: 56%;
  min-width: 320px;
  max-width: 720px;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-md);
  background: var(--dialog-background);
  border: 1px solid var(--card-stroke);
  box-shadow: var(--shadow-dialog);
  overflow: hidden;
}

.post-modal-enter-active,
.post-modal-leave-active {
  transition: opacity var(--normal-duration) var(--fast-out-slow-in);
}

.post-modal-enter-active .post-modal,
.post-modal-leave-active .post-modal {
  transition:
    opacity var(--normal-duration) var(--fast-out-slow-in),
    transform var(--normal-duration) var(--fast-out-slow-in);
}

.post-modal-enter-from,
.post-modal-leave-to {
  opacity: 0;
}

.post-modal-enter-from .post-modal,
.post-modal-leave-to .post-modal {
  opacity: 0;
  transform: scale(0.94) translateY(12px);
}

@media (prefers-reduced-motion: reduce) {
  .post-modal-enter-active,
  .post-modal-leave-active,
  .post-modal-enter-active .post-modal,
  .post-modal-leave-active .post-modal {
    transition: none !important;
  }
}

.post-modal__close {
  position: absolute;
  top: 0.6rem;
  right: 0.6rem;
  z-index: 1;
}

.post-modal__loading {
  padding: 3rem 1.5rem;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 0.85rem;
}

.post-modal__scroll {
  overflow-y: auto;
}

.post-modal__cover {
  width: 100%;
  height: 220px;
  object-fit: cover;
}

.post-modal__body {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 1.5rem 1.75rem 2rem;
}

.post-modal__post-content {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.post-modal__title {
  margin: 0;
  padding-right: 3rem;
  font-size: 1.3rem;
  font-weight: 700;
  color: var(--text-primary);
}

.post-modal__author-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.post-modal__author-meta {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.post-modal__author-name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
}

.post-modal__time {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

.post-modal__paragraph {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.7;
  color: var(--text-secondary);
  white-space: pre-wrap;
}

.post-modal__edit-input {
  width: 100%;
  font: inherit;
  padding: 0.5rem 0.7rem;
  border-radius: var(--radius-xs);
  border: 1px solid var(--ctrl-border);
  background: var(--ctrl-fill-secondary);
  color: var(--text-primary);
  resize: vertical;
}

.post-modal__edit-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.post-modal__actions {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding-top: 0.1rem;
}

.post-modal__action {
  display: inline-grid;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 50%;
  background: var(--ctrl-fill-secondary);
  color: var(--text-secondary);
  transition:
    background var(--fast-duration) var(--fast-out-slow-in),
    color var(--fast-duration) var(--fast-out-slow-in),
    border-color var(--fast-duration) var(--fast-out-slow-in);
}

.post-modal__action:hover {
  border-color: var(--ctrl-border);
  background: var(--ctrl-fill-tertiary);
  color: var(--text-primary);
}

.post-modal__action:focus-visible {
  outline: 2px solid rgb(var(--colors-primary));
  outline-offset: 2px;
}

.post-modal__action-notice {
  margin: -0.45rem 0 0;
  color: var(--text-tertiary);
  font-size: 0.75rem;
}

.post-modal__comments {
  margin-top: 0.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--stroke-divider);
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.post-modal__comments-title {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
}

.post-modal__comments-empty {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-tertiary);
}

.post-modal__reply-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.post-modal__reply {
  display: flex;
  gap: 0.5rem;
}

.post-modal__reply-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.post-modal__reply-meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.post-modal__reply-author {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-primary);
}

.post-modal__reply-text {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
}

.post-modal__more {
  display: flex;
  justify-content: center;
}

.post-modal__reply-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.3rem;
}

.post-modal__reply-form textarea {
  font: inherit;
  padding: 0.55rem 0.7rem;
  border-radius: var(--radius-xs);
  border: 1px solid var(--ctrl-border);
  background: var(--ctrl-fill-secondary);
  color: var(--text-primary);
  resize: vertical;
}

.post-modal__reply-submit {
  align-self: flex-end;
}

.post-modal__reply-form--guest {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 0.9rem;
  border-radius: var(--radius-sm);
  background: var(--ctrl-fill-secondary);
}

.post-modal__reply-form--guest .field__hint {
  margin: 0;
}

@media (max-width: 768px) {
  .post-modal-overlay {
    padding: 0;
  }

  .post-modal {
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    border-radius: 0;
    background: var(--dialog-background);
  }
}
</style>
