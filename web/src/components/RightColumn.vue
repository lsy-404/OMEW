<script setup lang="ts">
import { computed, ref } from 'vue'
import { api } from '../api'
import { useAuth } from '../composables/useAuth'
import { useAuthModal } from '../composables/useAuthModal'
import { useInstanceConfig } from '../composables/useInstanceConfig'
import { useStronghold } from '../composables/useStronghold'
import { useStrongholdMembers } from '../composables/useStrongholdMembers'
import { useTheme } from '../composables/useTheme'
import { WinButton, WinDropDownButton } from '../vendor/winui'
import AvatarBadge from './AvatarBadge.vue'
import PersonalSettingsModal from './PersonalSettingsModal.vue'
import StrongholdMemberRoster from './StrongholdMemberRoster.vue'

const emit = defineEmits<{ 'open-server-admin': []; 'open-panel': ['members' | 'settings'] }>()

const { mode, cycleTheme } = useTheme()
const auth = useAuth()
const { config: instanceConfig } = useInstanceConfig()
const { selectedNodeId, isPublicPreview, isReadOnly, loadStrongholds } = useStronghold()
const { myRole } = useStrongholdMembers()
const { openAuthModal } = useAuthModal()

const personalName = computed(() => auth.user.value?.display_name || auth.user.value?.username || '')
const personalCover = computed(() => auth.user.value?.cover ?? null)

const modeLabel: Record<string, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色',
}

// m0-protocol §7.10: a server owner/admin manages every stronghold with
// owner-equivalent permission even without a membership row - same overlay
// StrongholdAdminModal applies to its own canManage.
const canManage = computed(() => myRole.value === 'owner' || myRole.value === 'mod' || auth.isAdmin.value)

const showPersonalSettings = ref(false)
const joining = ref(false)
const joinError = ref('')

const userMenu = computed(() => ({
  Items: [
    ...(auth.isAdmin.value ? [{ Text: '服务器管理', Value: 'server-admin' }] : []),
    { Text: '个人设置', Value: 'personal-settings' },
    ...(instanceConfig.value?.sso_session_locked ? [] : [{ Text: '登出', Value: 'logout' }]),
  ],
}))

function onUserMenuSelect(item: { Value: string }) {
  if (item.Value === 'server-admin') emit('open-server-admin')
  else if (item.Value === 'personal-settings') showPersonalSettings.value = true
  else if (item.Value === 'logout') auth.logout()
}

async function joinCurrentStronghold() {
  if (!auth.token.value || !selectedNodeId.value || joining.value) return
  joining.value = true
  joinError.value = ''
  try {
    await api.joinStronghold(auth.token.value, selectedNodeId.value)
    await loadStrongholds(true)
  } catch {
    joinError.value = '加入失败，请稍后重试'
  } finally {
    joining.value = false
  }
}
</script>

<template>
  <aside class="right-column">
    <div class="right-column__topbar">
      <template v-if="auth.isAuthenticated.value">
        <WinDropDownButton :Flyout="userMenu" @select="onUserMenuSelect">
          <span class="right-column__user">
            <AvatarBadge :seed="auth.user.value?.username ?? ''" :size="24" :avatar-url="auth.user.value?.avatar ?? undefined" />
            <span class="right-column__username">{{ auth.user.value?.username }}</span>
          </span>
        </WinDropDownButton>
      </template>
      <template v-else>
        <WinButton Style="SubtleButtonStyle" class="right-column__theme-btn" @click="cycleTheme">
          主题：{{ modeLabel[mode] }}
        </WinButton>
        <WinButton Style="AccentButtonStyle" class="right-column__login-btn" @click="openAuthModal">
          登录 / 注册
        </WinButton>
      </template>
    </div>

    <section v-if="auth.isAuthenticated.value" class="right-column__personal-card" aria-label="个人资料封面">
      <div class="right-column__personal-cover">
        <img v-if="personalCover" :src="personalCover" :alt="`${personalName} 的个人封面`" />
        <div v-else class="right-column__personal-cover-placeholder" aria-hidden="true" />
      </div>
      <div class="right-column__personal-identity">
        <AvatarBadge
          :seed="auth.user.value?.username ?? ''"
          :size="40"
          :avatar-url="auth.user.value?.avatar ?? undefined"
        />
        <span class="right-column__personal-copy">
          <strong>{{ personalName }}</strong>
          <span>@{{ auth.user.value?.username }}</span>
        </span>
      </div>
    </section>

    <div class="right-column__actions">
      <template v-if="!isReadOnly">
        <WinButton Style="DefaultButtonStyle" class="right-column__action" @click="emit('open-panel', 'members')">
          成员列表
        </WinButton>
        <WinButton
          v-if="canManage"
          Style="DefaultButtonStyle"
          class="right-column__action"
          @click="emit('open-panel', 'settings')"
        >
          据点设置
        </WinButton>
      </template>
      <template v-else-if="isPublicPreview">
        <WinButton
          Style="AccentButtonStyle"
          class="right-column__action"
          :IsEnabled="!joining"
          @click="joinCurrentStronghold"
        >
          {{ joining ? '加入中…' : '加入据点' }}
        </WinButton>
        <p v-if="joinError" class="right-column__join-error">{{ joinError }}</p>
      </template>
      <WinButton v-else Style="AccentButtonStyle" class="right-column__action" @click="openAuthModal">
        登录以加入据点
      </WinButton>
    </div>

    <StrongholdMemberRoster />
    <PersonalSettingsModal :open="showPersonalSettings" @close="showPersonalSettings = false" />
  </aside>
</template>

<style scoped>
.right-column {
  flex: 0 0 var(--right-width);
  width: var(--right-width);
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  background: var(--app-bg);
  border-left: 1px solid var(--stroke-divider);
  overflow: hidden;
}

.right-column__topbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.right-column__topbar > :last-child {
  margin-left: auto;
}

.right-column__theme-btn,
.right-column__login-btn {
  font-size: 0.8rem;
}

.right-column__user {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.right-column__username {
  font-size: 0.85rem;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.right-column__personal-card {
  flex: 0 0 auto;
  overflow: hidden;
  border: 1px solid var(--card-stroke);
  border-radius: var(--radius-sm);
  background: var(--card-bg);
}

.right-column__personal-cover {
  width: 100%;
  aspect-ratio: 3 / 1;
  overflow: hidden;
  background: var(--ctrl-fill-secondary);
}

.right-column__personal-cover img,
.right-column__personal-cover-placeholder {
  width: 100%;
  height: 100%;
}

.right-column__personal-cover img {
  display: block;
  object-fit: cover;
}

.right-column__personal-cover-placeholder {
  background:
    radial-gradient(circle at 78% 28%, color-mix(in srgb, var(--accent) 30%, transparent), transparent 42%),
    linear-gradient(135deg, var(--ctrl-fill-secondary), var(--layer-default));
}

.right-column__personal-identity {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.7rem 0.8rem;
}

.right-column__personal-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.12rem;
}

.right-column__personal-copy strong,
.right-column__personal-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.right-column__personal-copy strong {
  color: var(--text-primary);
  font-size: 0.88rem;
  font-weight: 600;
}

.right-column__personal-copy span {
  color: var(--text-secondary);
  font-size: 0.72rem;
}

.right-column__actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.right-column__join-error {
  margin: 0;
  color: var(--critical-text);
  font-size: 0.78rem;
}

.right-column__action {
  width: 100%;
  justify-content: center;
}

@media (max-width: 768px) {
  .right-column {
    display: none;
  }

  .shell__body[data-view='stronghold'] .right-column {
    display: flex;
    flex: 1 1 auto;
    width: 100%;
    min-height: 0;
    border-left: none;
  }
}
</style>
