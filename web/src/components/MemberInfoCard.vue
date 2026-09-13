<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, ApiRequestError } from '../api'
import type { PublicUser, StrongholdMember } from '../api/types'
import { useAuth } from '../composables/useAuth'
import { WinButton } from '../vendor/winui'
import AvatarBadge from './AvatarBadge.vue'
import DirectMessagePanel from './DirectMessagePanel.vue'

// Group membership is server-level and read-only here; assignment
// moved to ServerAdminModal's member rows, so this card just displays the
// badges already carried on `member.groups` (populated from the batch
// GET /api/server-groups/members lookup).
const props = withDefaults(defineProps<{ member: StrongholdMember; nodeId?: string; inline?: boolean }>(), { nodeId: '', inline: false })
defineEmits<{ close: [] }>()

const ROLE_LABEL: Record<string, string> = { owner: '领主', mod: '管理员', member: '成员' }

const auth = useAuth()
const profile = ref<PublicUser | null>(null)
const isBlocked = ref(false)
const actionError = ref('')
const blocking = ref(false)
const showMessages = ref(false)
const canInteract = computed(() => Boolean(auth.token.value && props.nodeId && auth.user.value?.actor !== props.member.actor))
const displayName = computed(() => profile.value?.display_name ?? props.member.display_name)
const cover = computed(() => profile.value?.cover ?? null)
const introduction = computed(() => profile.value?.bio ?? props.member.bio ?? '')

function actionErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'SELF_TARGET') return '不能对自己执行此操作。'
    if (err.code === 'FORBIDDEN') return '只有当前据点成员可以执行此操作。'
    if (err.code === 'NOT_FOUND') return '该成员已不在据点中。'
  }
  return '操作未完成，请稍后重试。'
}

async function loadBlockStatus() {
  if (!canInteract.value || !auth.token.value) return
  try {
    isBlocked.value = await api.isUserBlocked(auth.token.value, props.nodeId, props.member.actor)
  } catch (err) {
    actionError.value = actionErrorMessage(err)
  }
}

async function toggleBlock() {
  if (!canInteract.value || !auth.token.value || blocking.value) return
  blocking.value = true
  actionError.value = ''
  try {
    if (isBlocked.value) await api.unblockUser(auth.token.value, props.nodeId, props.member.actor)
    else await api.blockUser(auth.token.value, props.nodeId, props.member.actor)
    isBlocked.value = !isBlocked.value
    if (isBlocked.value) showMessages.value = false
  } catch (err) {
    actionError.value = actionErrorMessage(err)
  } finally {
    blocking.value = false
  }
}

onMounted(async () => {
  if (!auth.token.value) return
  try {
    profile.value = await api.getUser(auth.token.value, props.member.actor)
  } catch (err) {
    // profile lookup is a nice-to-have on top of the membership row we
    // already have — fall back silently to that row's own fields
    if (!(err instanceof ApiRequestError)) throw err
  }
  await loadBlockStatus()
})
</script>

<template>
  <Teleport to="body" :disabled="inline">
    <div class="member-info-overlay" :class="{ 'member-info-overlay--inline': inline }" @click.self="$emit('close')">
      <div class="member-info-card" :class="{ 'member-info-card--inline': inline }" role="dialog" :aria-modal="inline ? undefined : true" :aria-label="displayName">
        <WinButton Style="SubtleButtonStyle" class="member-info-card__close" @click="$emit('close')">关闭</WinButton>
        <div class="member-info-card__cover" :class="{ 'member-info-card__cover--empty': !cover }" :style="cover ? { backgroundImage: `url(${cover})` } : undefined" />
        <div class="member-info-card__identity">
          <AvatarBadge :seed="member.username" :size="56" :avatar-url="profile?.avatar ?? member.avatar ?? undefined" />
          <div>
            <h2 class="member-info-card__name">{{ displayName }}</h2>
            <p class="member-info-card__username">@{{ profile?.username ?? member.username }}</p>
          </div>
        </div>
        <p v-if="member.is_guest" class="member-info-card__guest">宾客 · 来自 {{ member.home_domain }}</p>
        <p v-if="introduction" class="member-info-card__bio">{{ introduction }}</p>
        <p v-else class="member-info-card__bio member-info-card__bio--empty">这个人还没有留下自我介绍。</p>
        <dl class="member-info-card__meta">
          <dt>角色</dt>
          <dd>{{ ROLE_LABEL[member.role] }}</dd>
          <dt>加入时间</dt>
          <dd>{{ new Date(member.joined_at).toLocaleDateString() }}</dd>
        </dl>

        <div v-if="member.groups.length" class="member-info-card__groups">
          <h3 class="member-info-card__groups-title">用户组</h3>
          <ul class="member-info-card__group-list">
            <li v-for="group in member.groups" :key="group.id" class="member-info-card__group-row">
              <span class="member-info-card__group-badge">
                <span class="member-info-card__group-dot" :style="{ backgroundColor: group.color ?? 'var(--ctrl-fill-tertiary)' }" />
                {{ group.name }}
              </span>
            </li>
          </ul>
        </div>
        <div v-if="canInteract" class="member-info-card__actions">
          <WinButton Style="AccentButtonStyle" :IsEnabled="!isBlocked" @click="showMessages = !showMessages">{{ showMessages ? '收起私聊' : '私聊' }}</WinButton>
          <WinButton Style="SubtleButtonStyle" :IsEnabled="!blocking" @click="toggleBlock">{{ blocking ? '处理中…' : isBlocked ? '解除拉黑' : '拉黑' }}</WinButton>
        </div>
        <p v-if="actionError" class="member-info-card__error" role="alert">{{ actionError }}</p>
        <DirectMessagePanel v-if="canInteract && showMessages && !isBlocked" :node-id="nodeId" :target-actor="member.actor" :target-name="displayName" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.member-info-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  background: var(--overlay-scrim-soft);
}

.member-info-overlay--inline {
  position: static;
  display: block;
  padding: .25rem 0 .55rem;
  background: none;
}

.member-info-card {
  position: relative;
  width: 100%;
  max-width: 320px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.4rem;
  padding: 2rem 1.5rem 1.5rem;
  border-radius: var(--radius-md);
  background: var(--dialog-background);
  border: 1px solid var(--card-stroke);
  box-shadow: var(--shadow-dialog);
}

.member-info-card--inline {
  max-width: none;
  padding: 0 0 .75rem;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.member-info-card__close {
  position: absolute;
  top: 0.6rem;
  right: 0.6rem;
}

.member-info-card--inline .member-info-card__close { top: .25rem; right: 0; }

.member-info-card__cover {
  height: 5rem;
  margin: -2rem -1.5rem 0;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  background-position: center;
  background-size: cover;
}

.member-info-card--inline .member-info-card__cover {
  height: 4.25rem;
  margin: 0;
  border-radius: var(--radius-sm);
}

.member-info-card__cover--empty { background: linear-gradient(135deg, var(--accent-fill, #5b74d6), var(--card-bg)); }

.member-info-card__identity { display: flex; align-items: end; gap: .6rem; margin-top: -1.35rem; padding: 0 .1rem; }
.member-info-card__identity :deep(.avatar-badge) { border: 2px solid var(--flyout-bg, var(--layer-default)); }
.member-info-card--inline .member-info-card__identity { margin-top: -.9rem; }

.member-info-card__name {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-primary);
}

.member-info-card__username { margin: .1rem 0 0; color: var(--text-secondary); font-size: .72rem; }

.member-info-card__guest {
  margin: 0;
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.member-info-card__bio { margin: .2rem 0 0; color: var(--text-secondary); font-size: .76rem; line-height: 1.45; overflow-wrap: anywhere; }
.member-info-card__bio--empty { color: var(--text-tertiary); font-style: italic; }

.member-info-card__meta {
  width: 100%;
  margin: 0.75rem 0 0;
  padding-top: 0.75rem;
  border-top: 1px solid var(--stroke-divider);
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.3rem 0.75rem;
  font-size: 0.82rem;
}

.member-info-card__meta dt {
  color: var(--text-tertiary);
}

.member-info-card__meta dd {
  margin: 0;
  color: var(--text-primary);
  text-align: right;
}

.member-info-card__groups {
  width: 100%;
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--stroke-divider);
}

.member-info-card__groups-title {
  margin: 0 0 0.4rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
}

.member-info-card__group-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.member-info-card__group-badge {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.82rem;
  color: var(--text-primary);
}

.member-info-card__group-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.member-info-card__actions { display: flex; gap: .4rem; margin-top: .7rem; }
.member-info-card__error { margin: 0; color: var(--critical-text); font-size: .72rem; }
</style>
