<script setup lang="ts">
import { computed } from 'vue'
import type { ItemReactions, MediaAttachment } from '../api/types'
import { isCompactStandaloneEmote } from '../assets/mew-emotes'
import { useContextMenuGesture } from '../composables/useContextMenuGesture'
import { useEmotes } from '../composables/useEmotes'
import { buildEmoteLookup, parseMessageText, pureEmoteToken } from '../utils/emote'
import AvatarBadge from './AvatarBadge.vue'
import MediaGrid from './MediaGrid.vue'
import ReactionChips from './ReactionChips.vue'

export interface MessageVM {
  key: string
  seq: number | null
  actor: string
  displayName: string
  avatarUrl?: string | null
  content: string
  media?: MediaAttachment[]
  timestamp: string
  editedAt?: number
  mine: boolean
  editable: boolean
  retractable: boolean
  pending: boolean
  failed: boolean
  failReason?: 'denied' | 'network'
  reactions?: ItemReactions
  // gates both the reaction chips' click-to-toggle and whether the context
  // menu opens at all - false for guests and still-optimistic (seq === null)
  // messages, m0-protocol §3.2a requires a live room session to react.
  canReact: boolean
}

const props = defineProps<{ message: MessageVM; grouped?: boolean; editing?: boolean; reactionsEnabled: boolean }>()
const editingText = defineModel<string>('editingText', { default: '' })
const emit = defineEmits<{
  'cancel-edit': []
  'submit-edit': []
  resend: []
  'toggle-reaction': [name: string]
  'open-menu': [x: number, y: number]
}>()

const { packs } = useEmotes()
const emoteLookup = computed(() => buildEmoteLookup(packs.value))
const segments = computed(() => parseMessageText(props.message.content.trim(), emoteLookup.value))
const pureEmote = computed(() => pureEmoteToken(segments.value))
const compactPureEmote = computed(() => pureEmote.value !== null && isCompactStandaloneEmote(pureEmote.value.pack))
const isSingleMediaMessage = computed(
  () =>
    !props.editing &&
    !props.message.pending &&
    !props.message.failed &&
    !props.message.content.trim() &&
    props.message.media?.length === 1,
)

// the shared context menu lives once in ChatPane (see useContextMenuGesture's
// canOpen note - one instance per message would mean one set of global
// listeners each, linear with message count).
const gesture = useContextMenuGesture(
  (x, y) => emit('open-menu', x, y),
  () => props.message.canReact || props.message.editable || props.message.retractable,
)

// the in-place edit textarea needs its own native right-click menu (cut/
// copy/paste), so the custom menu only engages outside editing mode.
function onContextMenu(event: MouseEvent) {
  if (!props.editing) gesture.onContextMenu(event)
}
function onTouchStart(event: TouchEvent) {
  if (!props.editing) gesture.onTouchStart(event)
}
</script>

<template>
  <div
    class="message-row"
    :class="{
      'message-row--mine': message.mine,
      'message-row--grouped': grouped,
    }"
  >
    <AvatarBadge v-if="!grouped" class="message-row__avatar" :seed="message.displayName" :size="36" :avatar-url="message.avatarUrl ?? undefined" />
    <div v-else class="message-row__avatar-spacer" aria-hidden="true"></div>
    <div
      class="message-bubble"
      :class="{
        'message-bubble--mine': message.mine,
        'message-bubble--failed': message.failed,
        'message-bubble--emote-only': !editing && pureEmote,
        'message-bubble--compact-emote': !editing && compactPureEmote,
        'message-bubble--single-media': isSingleMediaMessage,
      }"
      @contextmenu="onContextMenu"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="gesture.onTouchMove"
      @touchend="gesture.onTouchEnd"
      @touchcancel="gesture.onTouchCancel"
    >
      <div v-if="!message.mine && !grouped" class="message-bubble__author">{{ message.displayName }}</div>

      <template v-if="editing">
        <textarea v-model="editingText" class="message-bubble__edit-input" rows="2" @keydown.esc="$emit('cancel-edit')"></textarea>
        <div class="message-bubble__edit-actions">
          <button type="button" class="message-bubble__link" @click="$emit('submit-edit')">保存</button>
          <button type="button" class="message-bubble__link" @click="$emit('cancel-edit')">取消</button>
        </div>
      </template>
      <template v-else>
        <div class="message-bubble__payload">
          <img
            v-if="pureEmote"
            class="message-bubble__big-emote"
            :class="{ 'message-bubble__big-emote--compact': compactPureEmote }"
            :src="pureEmote.url"
            :alt="message.content"
          />
          <div v-else-if="message.content" class="message-bubble__content">
            <template v-for="(segment, index) in segments" :key="index">
              <img
                v-if="segment.type === 'emote'"
                class="message-bubble__inline-emote"
                :src="segment.token.url"
                :alt="`:${segment.token.pack}:${segment.token.name}:`"
              />
              <template v-else>{{ segment.value }}</template>
            </template>
          </div>
          <MediaGrid v-if="message.media?.length" class="message-bubble__media" :media="message.media" />
        </div>
        <ReactionChips
          v-if="reactionsEnabled"
          :reactions="message.reactions"
          :can-toggle="message.canReact"
          @toggle="emit('toggle-reaction', $event)"
        />
        <div v-if="message.pending || message.failed" class="message-bubble__meta message-bubble__meta--status">
          <span v-if="message.pending">发送中…</span>
          <span v-else-if="message.failed && message.failReason === 'denied'">发送失败：你没有发言权限</span>
          <span v-else-if="message.failed">
            发送失败
            <button type="button" class="message-bubble__link" @click="$emit('resend')">重试</button>
          </span>
        </div>
      </template>
    </div>
    <div v-if="!message.pending && !message.failed" class="message-row__timestamp">
      <span>{{ message.timestamp }}</span>
      <span v-if="message.editedAt" class="message-row__edited" aria-label="已编辑" title="已编辑">E</span>
    </div>
  </div>
</template>

<style scoped>
.message-row {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  justify-content: flex-start;
  /* spacing rhythm: a new speaker gets a clear gap, consecutive messages
     from the same speaker (same author + same mine state) sit close together */
  margin-top: 0.9rem;
}

.message-row:first-child {
  margin-top: 0;
}

.message-row--grouped {
  margin-top: 0.15rem;
}

.message-row--mine {
  /* row-reverse flips the main axis: default flex-start packing already
     places content at the visual right edge; flex-end would send it left */
  flex-direction: row-reverse;
}

.message-row__timestamp {
  display: inline-flex;
  align-items: baseline;
  gap: 0.2rem;
  flex: 0 0 auto;
  align-self: flex-end;
  padding-bottom: 0.05rem;
  color: var(--text-tertiary);
  font-size: 0.7rem;
  line-height: 1;
  white-space: nowrap;
  opacity: 0.72;
}

.message-row__edited {
  font-weight: 600;
}

.message-row__avatar {
  margin-bottom: 0.1rem;
}

.message-row__avatar-spacer {
  /* keeps grouped rows aligned with ungrouped ones once the avatar is hidden;
     matches AvatarBadge's rendered size (36px) passed above */
  flex: 0 0 auto;
  width: 36px;
}

.message-bubble {
  max-width: 60%;
  min-width: 0;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  background: var(--card-bg);
  border: 1px solid var(--card-stroke);
  color: var(--text-primary);
}

.message-bubble--mine {
  background: rgb(var(--colors-primary));
  border-color: transparent;
  color: var(--on-accent);
}

.message-bubble--failed {
  border-color: var(--SystemFillColorCriticalBrush);
}

.message-bubble--emote-only {
  background: transparent;
  border-color: transparent;
  padding: 0;
}

.message-bubble--single-media {
  background: transparent;
  border-color: transparent;
  padding: 0;
}

.message-bubble__payload {
  min-width: 0;
}

.message-bubble--single-media .message-bubble__media {
  margin-top: 0;
}

.message-bubble__big-emote {
  display: block;
  max-width: 128px;
  max-height: 128px;
  object-fit: contain;
}

.message-bubble__big-emote--compact {
  width: auto;
  height: calc(1.26rem + 1rem + 2px);
  max-width: 3rem;
}

.message-bubble__inline-emote {
  height: 1.5em;
  width: auto;
  vertical-align: -0.3em;
  object-fit: contain;
}

.message-bubble__author {
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-bottom: 0.15rem;
}

.message-bubble__content {
  font-size: 0.9rem;
  line-height: 1.4;
  white-space: pre-wrap;
}

.message-bubble--mine .message-bubble__content {
  color: inherit;
}

.message-bubble__meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.7rem;
  color: var(--text-tertiary);
  margin-top: 0.2rem;
  justify-content: flex-end;
}

.message-bubble--mine .message-bubble__meta {
  color: color-mix(in srgb, var(--on-accent) 70%, transparent);
}

.message-bubble--emote-only .message-bubble__meta {
  /* no colored background behind an emote-only bubble - meta text needs the
     regular tertiary color instead of the on-accent mix above */
  color: var(--text-tertiary);
}

.message-bubble__link {
  border: none;
  background: transparent;
  padding: 0;
  font: inherit;
  font-size: 0.7rem;
  color: inherit;
  text-decoration: underline;
}

.message-bubble__edit-input {
  width: 100%;
  min-width: 180px;
  font: inherit;
  padding: 0.35rem 0.5rem;
  border-radius: var(--radius-xs);
  border: 1px solid var(--ctrl-border);
  background: var(--ctrl-fill-secondary);
  color: var(--text-primary);
  resize: vertical;
}

.message-bubble__edit-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 0.3rem;
}

@media (max-width: 768px) {
  .message-bubble {
    max-width: 80%;
    min-width: 0;
  }

}
</style>
