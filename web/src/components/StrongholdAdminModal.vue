<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { api } from '../api'
import type { BanEntry, FeatureRestrictions, MemberPatch, MemberTab, RestrictedFeature, StrongholdConfigPatch, StrongholdMember } from '../api/types'
import { EMPTY_STATE } from '../assets/mew'
import { useAuth } from '../composables/useAuth'
import { useInstanceConfig } from '../composables/useInstanceConfig'
import { useStorageUsage } from '../composables/useStorageUsage'
import { useStronghold } from '../composables/useStronghold'
import { useStrongholdConfig } from '../composables/useStrongholdConfig'
import { useStrongholdMembers } from '../composables/useStrongholdMembers'
import { formatBytes, nonNegativeIntError, requiredMaxLengthError } from '../utils/validate'
import { WinButton, WinComboBox, WinInfoBar, WinSelectorBar, WinToggleSwitch } from '../vendor/winui'
import AvatarBadge from './AvatarBadge.vue'
import CoverUploader from './CoverUploader.vue'
import StrongholdAvatarUploader from './StrongholdAvatarUploader.vue'
import EmptyState from './EmptyState.vue'
import MemberInfoCard from './MemberInfoCard.vue'
import RoomManager from './SectionManager.vue'

// stronghold-scoped management only (members / blacklist / stronghold
// settings) - server-level administration (policy, server members, invite
// codes, emote packs, user groups) lives in the separate ServerAdminModal
// (task 039 split, task 048 moved groups off this panel entirely). A
// PostModal-style floating window, not a full-screen shell swap (task 048).
const props = withDefaults(defineProps<{ open: boolean; initialTab?: 'members' | 'settings' }>(), { initialTab: 'members' })
const emit = defineEmits<{ close: [] }>()

const auth = useAuth()
const { config: instanceConfig } = useInstanceConfig()
const artAssetsEnabled = computed(() => instanceConfig.value?.art_assets_enabled !== false)
const { currentNode, selectedNodeId, loadStrongholds } = useStronghold()
const { reload: reloadStrongholdConfig } = useStrongholdConfig()
const { myRole } = useStrongholdMembers()

const ROLE_LABEL: Record<string, string> = { owner: '领主', mod: '管理员', member: '成员' }
const MEMBER_SUBTABS: { Text: string; value: 'all' | 'restricted' }[] = [
  { Text: '全部', value: 'all' },
  { Text: '受限', value: 'restricted' },
]
const VISIBILITY_OPTIONS = [
  { Text: '公开', Value: 'public' },
  { Text: '私密', Value: 'private' },
]

type PanelTab = 'members' | 'banned' | 'channels' | 'sections' | 'settings'

const panelTab = ref<PanelTab>(props.initialTab)
// m0-protocol §7.10: a server owner/admin manages every stronghold with
// owner-equivalent permission even without a membership row - mirrors the
// server's overlayRole/effectiveRole gate (api.ts), not just the local role.
const canManage = computed(() => myRole.value === 'owner' || myRole.value === 'mod' || auth.isAdmin.value)
const isOwner = computed(() => myRole.value === 'owner')
// Server owner/admin receive the backend's owner-equivalent overlay for normal
// stronghold management. Actual ownership stays separate for deletion.
const hasOwnerOverlay = computed(() => isOwner.value || auth.isAdmin.value)
const canTransferOwnership = computed(() => isOwner.value || auth.isServerOwner.value)
const canDeleteStronghold = computed(() => isOwner.value || auth.isServerOwner.value)
const isForceDissolve = computed(() => auth.isServerOwner.value && !isOwner.value)

const panelTabOptions = computed(() => {
  const opts: { Text: string; value: PanelTab }[] = [{ Text: '成员', value: 'members' }]
  if (canManage.value) {
    opts.push({ Text: '黑名单', value: 'banned' })
    opts.push({ Text: '话题', value: 'channels' })
    opts.push({ Text: '话题组', value: 'sections' })
    opts.push({ Text: '设置', value: 'settings' })
  }
  return opts
})
const panelTabSelected = computed(() => panelTabOptions.value.find((o) => o.value === panelTab.value))
function onPanelTabSelect(item: { value: PanelTab }) {
  panelTab.value = item.value
}

// the member-list sub-tab is driven by panelTab: 'banned' forces the banned
// view with no sub-tab UI, 'members' exposes 全部/受限 underneath it.
const memberSubtab = ref<'all' | 'restricted'>('all')
const memberTab = computed<MemberTab>(() => (panelTab.value === 'banned' ? 'banned' : memberSubtab.value))
const memberSubtabSelected = computed(() => MEMBER_SUBTABS.find((o) => o.value === memberSubtab.value))
function onMemberSubtabSelect(item: { value: 'all' | 'restricted' }) {
  memberSubtab.value = item.value
}

function isSelf(member: StrongholdMember) {
  return member.username === auth.user.value?.username
}

// ---- members / banned list ----
const members = ref<StrongholdMember[]>([])
const membersLoading = ref(false)
const membersError = ref('')
const actionError = ref('')
const infoCardMember = ref<StrongholdMember | null>(null)
const bansByActor = ref<Record<string, BanEntry>>({})
const strongholdBanExpiresAt = ref('')

function formatExpiry(expiresAt: string | null) {
  return expiresAt ? `自动解封：${new Date(expiresAt).toLocaleString()}` : '永久封禁'
}

function selectedStrongholdExpiry(): number | null | undefined {
  if (!strongholdBanExpiresAt.value) return null
  const expiresAt = new Date(strongholdBanExpiresAt.value).getTime()
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    actionError.value = '自动解封时间必须晚于当前时间'
    return undefined
  }
  return expiresAt
}

async function loadMembers() {
  if (!auth.token.value || !props.open) return
  membersLoading.value = true
  membersError.value = ''
  try {
    const [page, bans] = await Promise.all([
      api.getStrongholdMembers(auth.token.value, selectedNodeId.value, memberTab.value),
      memberTab.value === 'banned' ? api.listBans(auth.token.value, selectedNodeId.value) : Promise.resolve([]),
    ])
    members.value = page.members
    bansByActor.value = Object.fromEntries(bans.map((ban) => [ban.actor, ban]))
  } catch {
    membersError.value = '加载成员列表失败'
  } finally {
    membersLoading.value = false
  }
}

watch([memberTab, selectedNodeId, () => props.open], loadMembers, { immediate: true })

async function runAction(action: (token: string) => Promise<unknown>) {
  if (!auth.token.value) return
  actionError.value = ''
  try {
    await action(auth.token.value)
    await loadMembers()
  } catch {
    actionError.value = '操作失败，请稍后重试'
  }
}

function toggleDeny(member: StrongholdMember, field: 'deny_discussion' | 'deny_idea' | 'deny_comment') {
  // the real API's deny is a single bitmask overwrite (not per-bit), so the
  // patch always carries the full current tri-state with just the toggled
  // field flipped - client.ts recombines these three into one deny value.
  const patch: MemberPatch = {
    deny_discussion: member.deny_discussion,
    deny_idea: member.deny_idea,
    deny_comment: member.deny_comment,
    [field]: !member[field],
  }
  runAction((token) => api.patchMember(token, selectedNodeId.value, member.actor, patch))
}

function promote(member: StrongholdMember) {
  runAction((token) => api.patchMember(token, selectedNodeId.value, member.actor, { role: 'mod' }))
}

function demote(member: StrongholdMember) {
  runAction((token) => api.patchMember(token, selectedNodeId.value, member.actor, { role: 'member' }))
}

function kick(member: StrongholdMember) {
  if (!confirm(`将「${member.display_name}」移出据点？此操作可撤销——对方之后可以重新申请加入。`)) return
  runAction((token) => api.removeMember(token, selectedNodeId.value, member.actor))
}

function ban(member: StrongholdMember) {
  const expiresAt = selectedStrongholdExpiry()
  if (expiresAt === undefined) return
  const duration = expiresAt == null ? '永久' : `至 ${new Date(expiresAt).toLocaleString()}`
  if (!confirm(`确定据点级封禁「${member.display_name}」吗？对方将无法加入本据点；${duration}。`)) return
  runAction((token) => api.banMember(token, selectedNodeId.value, member.actor, expiresAt))
}

function unban(member: StrongholdMember) {
  runAction((token) => api.unbanMember(token, selectedNodeId.value, member.actor))
}

function transfer(member: StrongholdMember) {
  if (!confirm(`将领主权限转让给「${member.display_name}」？转让后你将不再拥有该据点的管理权限。`)) return
  runAction((token) => api.transferOwnership(token, selectedNodeId.value, member.actor))
}

// ---- settings tab ----
const settingsLoading = ref(true)
const settingsError = ref('')
const settingsSaving = ref(false)
const settingsSaveOk = ref(false)
const strongholdDeleting = ref(false)
const strongholdDeleteError = ref('')
const restrictions = ref<FeatureRestrictions | null>(null)
const restrictionsError = ref('')
const restrictionsSaving = ref<RestrictedFeature | null>(null)
const FEATURE_LABEL: Record<RestrictedFeature, string> = { chat: '聊天', posts: '发帖' }
const ownerRestrictionDraft = reactive<Record<RestrictedFeature, { paused: boolean; expiresAt: string }>>({
  chat: { paused: false, expiresAt: '' },
  posts: { paused: false, expiresAt: '' },
})
const form = reactive({
  name: '',
  description: '',
  avatar: '',
  cover: '',
  visibility: 'public' as 'public' | 'private',
  allow_message_edit: true,
  allow_message_retract: true,
  edit_window_secs: 300,
})

async function loadSettings() {
  if (!auth.token.value || !props.open) return
  settingsLoading.value = true
  settingsError.value = ''
  restrictionsError.value = ''
  try {
    const [config, nextRestrictions] = await Promise.all([
      api.getStrongholdConfig(auth.token.value, selectedNodeId.value),
      api.getFeatureRestrictions(auth.token.value, selectedNodeId.value),
    ])
    form.name = config.name
    form.description = config.description
    form.avatar = config.avatar ?? ''
    form.cover = config.cover
    form.visibility = config.visibility
    form.allow_message_edit = config.allow_message_edit
    form.allow_message_retract = config.allow_message_retract
    form.edit_window_secs = config.edit_window_secs
    restrictions.value = nextRestrictions
    for (const feature of ['chat', 'posts'] as const) {
      ownerRestrictionDraft[feature].paused = nextRestrictions[feature].owner.paused
      ownerRestrictionDraft[feature].expiresAt = toDateTimeLocal(nextRestrictions[feature].owner.expires_at)
    }
  } catch {
    settingsError.value = '无法加载据点设置'
  } finally {
    settingsLoading.value = false
  }
}

function toDateTimeLocal(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function restrictionSummary(feature: RestrictedFeature) {
  const restriction = restrictions.value?.[feature]
  if (!restriction) return '状态加载中'
  if (!restriction.effective.paused) return '当前可用'
  const scope = restriction.effective.source === 'server' ? '服务器覆盖' : '据点领主'
  const ends = restriction.effective.expires_at ? `，自动恢复：${new Date(restriction.effective.expires_at).toLocaleString()}` : '，未设置自动恢复'
  return `当前已暂停（${scope}${ends}）`
}

async function saveOwnerFeatureRestriction(feature: RestrictedFeature) {
  if (!auth.token.value || !isOwner.value || restrictionsSaving.value) return
  const draft = ownerRestrictionDraft[feature]
  let expiresAt: number | null = null
  if (draft.paused && draft.expiresAt) {
    expiresAt = new Date(draft.expiresAt).getTime()
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      restrictionsError.value = '自动恢复时间必须晚于当前时间'
      return
    }
  }
  restrictionsSaving.value = feature
  restrictionsError.value = ''
  try {
    await api.patchOwnerFeatureRestriction(auth.token.value, selectedNodeId.value, feature, draft.paused, expiresAt)
    restrictions.value = await api.getFeatureRestrictions(auth.token.value, selectedNodeId.value)
  } catch {
    restrictionsError.value = '保存功能暂停设置失败，请稍后重试'
  } finally {
    restrictionsSaving.value = null
  }
}

watch([selectedNodeId, () => props.open], loadSettings, { immediate: true })

// storage usage: informational only, shown alongside the settings tab so an
// owner/mod can see how much of the instance quota this account has used.
const { usage: storage } = useStorageUsage()

async function saveSettings() {
  if (!auth.token.value) return
  settingsError.value = requiredMaxLengthError(form.name, 32, '名称') || nonNegativeIntError(form.edit_window_secs, '编辑/撤回窗口秒数')
  if (settingsError.value) return
  settingsSaving.value = true
  settingsSaveOk.value = false
  const patch: StrongholdConfigPatch = {
    name: form.name,
    description: form.description,
    avatar: form.avatar || null,
    cover: form.cover,
    allow_message_edit: form.allow_message_edit,
    allow_message_retract: form.allow_message_retract,
    edit_window_secs: form.edit_window_secs,
  }
  if (hasOwnerOverlay.value) patch.visibility = form.visibility
  try {
    await api.patchStrongholdConfig(auth.token.value, selectedNodeId.value, patch)
    // two independent caches read what was just saved: the stronghold list
    // behind the rail and the tab title, and the config behind the home card
    // and the edit/retract affordances. Neither refetches on its own.
    await Promise.all([loadStrongholds(true), reloadStrongholdConfig()])
    settingsSaveOk.value = true
  } catch {
    settingsError.value = '保存失败，请稍后重试'
  } finally {
    settingsSaving.value = false
  }
}

async function deleteStronghold() {
  if (!auth.token.value || !currentNode.value || !canDeleteStronghold.value || strongholdDeleting.value) return
  const name = currentNode.value.name
  const action = isForceDissolve.value ? '强制解散' : '删除'
  if (!confirm(`确定${action}据点「${name}」吗？所有话题、话题组、消息和成员关系将永久移除。`)) return
  if (!confirm(`这是最终确认：${action}「${name}」后无法恢复。`)) return

  strongholdDeleting.value = true
  strongholdDeleteError.value = ''
  try {
    await api.deleteStronghold(auth.token.value, selectedNodeId.value)
    // loadStrongholds selects the first remaining node (or empty state) when
    // the deleted id disappears, so the rail cannot retain a dead target.
    await loadStrongholds(true)
    emit('close')
  } catch {
    strongholdDeleteError.value = '删除据点失败，请稍后重试'
  } finally {
    strongholdDeleting.value = false
  }
}

function close() {
  emit('close')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.open) close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// re-sync to the tab the caller opened with each time the modal reopens -
// otherwise a second open (e.g. from a different entry button) keeps
// whatever tab was left selected from the previous visit.
watch(
  () => props.open,
  (open) => {
    if (open) panelTab.value = props.initialTab === 'settings' ? 'settings' : 'members'
  },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="admin-modal">
      <div v-if="open" class="admin-modal-overlay" @click.self="close">
        <div class="admin-modal" role="dialog" aria-modal="true" aria-label="据点管理">
          <div class="admin-modal__header">
            <h1 class="admin-modal__title">{{ currentNode?.name }}</h1>
            <WinButton Style="SubtleButtonStyle" @click="close">关闭</WinButton>
          </div>

          <WinSelectorBar
            class="admin-modal__tabs"
            :Items="panelTabOptions"
            :SelectedItem="panelTabSelected"
            @update:SelectedItem="onPanelTabSelect"
          />

          <div class="admin-modal__scroll">
            <div v-if="panelTab === 'members' || panelTab === 'banned'" class="admin-modal__body">
              <WinSelectorBar
                v-if="panelTab === 'members'"
                class="member-subtabs"
                :Items="MEMBER_SUBTABS"
                :SelectedItem="memberSubtabSelected"
                @update:SelectedItem="onMemberSubtabSelect"
              />

              <p v-if="actionError" class="field__error">{{ actionError }}</p>
              <div v-if="panelTab === 'members' && canManage" class="field">
                <label class="field__label" for="stronghold-ban-expires-at">据点封禁自动解封时间（可选）</label>
                <input id="stronghold-ban-expires-at" v-model="strongholdBanExpiresAt" type="datetime-local" />
                <p class="field__hint">留空为永久封禁；该设置只影响本据点。</p>
              </div>
              <div v-if="membersLoading" class="admin-modal__loading">加载中…</div>
              <WinInfoBar v-else-if="membersError" :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Error">
                {{ membersError }}
              </WinInfoBar>
              <EmptyState v-else-if="!members.length" :image="artAssetsEnabled ? EMPTY_STATE.members : null" :text="panelTab === 'banned' ? '黑名单为空' : '暂无成员'" />

              <ul v-else class="member-list">
                <li v-for="member in members" :key="member.actor" class="member-row">
                  <button type="button" class="member-row__identity" @click="infoCardMember = member">
                    <AvatarBadge :seed="member.username" :size="36" :avatar-url="member.avatar ?? undefined" />
                    <span class="member-row__names">
                      <span class="member-row__display-name">{{ member.display_name }}</span>
                      <span class="member-row__actor">{{ member.actor }}</span>
                      <span v-if="member.groups.length" class="member-row__groups">
                        <span v-for="g in member.groups" :key="g.id" class="group-badge">
                          <span class="group-badge__dot" :style="{ backgroundColor: g.color ?? 'var(--ctrl-fill-tertiary)' }" />
                          {{ g.name }}
                        </span>
                      </span>
                    </span>
                  </button>
                  <span class="member-row__role" :class="`member-row__role--${member.role}`">{{ ROLE_LABEL[member.role] }}</span>
                  <span v-if="panelTab === 'banned' && bansByActor[member.actor]" class="field__hint">
                    {{ formatExpiry(bansByActor[member.actor].expires_at) }}
                  </span>

                  <template v-if="panelTab !== 'banned'">
                    <div class="member-row__deny">
                      <WinToggleSwitch
                        :modelValue="member.deny_discussion"
                        :IsEnabled="canManage && !isSelf(member) && member.role === 'member'"
                        @update:modelValue="toggleDeny(member, 'deny_discussion')"
                      >
                        讨论
                      </WinToggleSwitch>
                      <WinToggleSwitch
                        :modelValue="member.deny_idea"
                        :IsEnabled="canManage && !isSelf(member) && member.role === 'member'"
                        @update:modelValue="toggleDeny(member, 'deny_idea')"
                      >
                        想法
                      </WinToggleSwitch>
                      <WinToggleSwitch
                        :modelValue="member.deny_comment"
                        :IsEnabled="canManage && !isSelf(member) && member.role === 'member'"
                        @update:modelValue="toggleDeny(member, 'deny_comment')"
                      >
                        评论
                      </WinToggleSwitch>
                    </div>

                    <div v-if="canManage && !isSelf(member) && member.role !== 'owner'" class="member-row__actions">
                      <WinButton v-if="hasOwnerOverlay && member.role === 'member'" Style="SubtleButtonStyle" @click="promote(member)">
                        任命管理员
                      </WinButton>
                      <WinButton v-if="hasOwnerOverlay && member.role === 'mod'" Style="SubtleButtonStyle" @click="demote(member)">
                        撤销管理员
                      </WinButton>
                      <template v-if="hasOwnerOverlay || member.role !== 'mod'">
                        <WinButton Style="SubtleButtonStyle" @click="kick(member)">踢出</WinButton>
                        <WinButton Style="AccentButtonStyle" class="win-btn--danger" @click="ban(member)">据点封禁</WinButton>
                      </template>
                      <WinButton v-if="canTransferOwnership" Style="AccentButtonStyle" class="win-btn--danger" @click="transfer(member)">
                        转让领主
                      </WinButton>
                    </div>
                  </template>

                  <div v-else class="member-row__actions">
                    <WinButton v-if="canManage" Style="SubtleButtonStyle" @click="unban(member)">解除据点封禁</WinButton>
                  </div>
                </li>
              </ul>
            </div>

            <div v-else-if="panelTab === 'channels'" class="admin-modal__body">
              <RoomManager type="channel" />
            </div>

            <div v-else-if="panelTab === 'sections'" class="admin-modal__body">
              <RoomManager type="section" />
            </div>

            <div v-else class="admin-modal__body">
              <div v-if="settingsLoading" class="admin-modal__loading">加载中…</div>
              <template v-else>
                <WinInfoBar v-if="settingsError" :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Error">
                  {{ settingsError }}
                </WinInfoBar>

                <div class="field">
                  <label class="field__label" for="sh-name">名称</label>
                  <input id="sh-name" v-model="form.name" type="text" maxlength="32" />
                </div>
                <div class="field">
                  <label class="field__label" for="sh-desc">描述</label>
                  <textarea id="sh-desc" v-model="form.description" class="field__textarea--fixed" rows="3"></textarea>
                </div>
                <div class="field">
                  <span class="field__label">据点头像</span>
                  <StrongholdAvatarUploader v-if="auth.token.value" v-model="form.avatar" :token="auth.token.value" />
                </div>
                <div class="field">
                  <span class="field__label">封面</span>
                  <CoverUploader v-if="auth.token.value" v-model="form.cover" :token="auth.token.value" />
                </div>
                <div class="field">
                  <span class="field__label">可见性</span>
                  <WinComboBox
                    :ItemsSource="VISIBILITY_OPTIONS"
                    SelectedValuePath="Value"
                    v-model:SelectedValue="form.visibility"
                    :IsEnabled="hasOwnerOverlay"
                  />
                  <p v-if="!hasOwnerOverlay" class="field__hint">仅领主或服务器管理员可修改可见性</p>
                </div>
                <WinToggleSwitch v-model="form.allow_message_edit">允许编辑消息</WinToggleSwitch>
                <WinToggleSwitch v-model="form.allow_message_retract">允许撤回消息</WinToggleSwitch>
                <div class="field">
                  <label class="field__label" for="sh-window">编辑/撤回窗口（秒，0 表示不限）</label>
                  <input id="sh-window" v-model.number="form.edit_window_secs" type="number" min="0" step="1" />
                </div>

                <section class="stronghold-feature-restrictions" aria-label="聊天与发帖暂停">
                  <h2>聊天与发帖暂停</h2>
                  <p v-if="restrictionsError" class="field__error">{{ restrictionsError }}</p>
                  <div v-for="feature in (['chat', 'posts'] as RestrictedFeature[])" :key="feature" class="stronghold-feature-restrictions__row">
                    <div>
                      <strong>{{ FEATURE_LABEL[feature] }}</strong>
                      <p class="field__hint">{{ restrictionSummary(feature) }}</p>
                    </div>
                    <template v-if="isOwner">
                      <WinToggleSwitch v-model="ownerRestrictionDraft[feature].paused">暂停{{ FEATURE_LABEL[feature] }}</WinToggleSwitch>
                      <div v-if="ownerRestrictionDraft[feature].paused" class="field">
                        <label class="field__label" :for="`owner-${feature}-resume-at`">自动恢复时间（可选）</label>
                        <input :id="`owner-${feature}-resume-at`" v-model="ownerRestrictionDraft[feature].expiresAt" type="datetime-local" />
                      </div>
                      <WinButton Style="AccentButtonStyle" :IsEnabled="restrictionsSaving !== feature" @click="saveOwnerFeatureRestriction(feature)">
                        {{ restrictionsSaving === feature ? '保存中…' : `保存${FEATURE_LABEL[feature]}设置` }}
                      </WinButton>
                    </template>
                  </div>
                  <p v-if="!isOwner" class="field__hint">仅据点实际领主可设置据点级暂停；服务器覆盖请在服务器管理中操作。</p>
                </section>

                <div class="admin-modal__save">
                  <p v-if="settingsSaveOk" class="admin-modal__save-ok">已保存</p>
                  <WinButton Style="AccentButtonStyle" :IsEnabled="!settingsSaving" @click="saveSettings">
                    {{ settingsSaving ? '保存中…' : '保存设置' }}
                  </WinButton>
                </div>

                <section v-if="canDeleteStronghold" class="stronghold-danger" aria-label="危险操作">
                  <h2>危险操作</h2>
                  <p v-if="isForceDissolve">服务器所有者可强制解散此据点；全部成员、话题、话题组和消息将永久清除，且不可恢复。</p>
                  <p v-else>删除据点会永久清除成员、话题、话题组和全部消息，且不可恢复。</p>
                  <p v-if="strongholdDeleteError" class="field__error">{{ strongholdDeleteError }}</p>
                  <WinButton Style="AccentButtonStyle" class="win-btn--danger" :IsEnabled="!strongholdDeleting" @click="deleteStronghold">
                    {{ strongholdDeleting ? '处理中…' : isForceDissolve ? '强制解散据点' : '删除据点' }}
                  </WinButton>
                </section>

                <p v-if="storage" class="admin-modal__storage">
                  存储用量：{{ formatBytes(storage.used) }} / {{ formatBytes(storage.quota) }}（单文件上限 {{ formatBytes(storage.max_file) }}）
                </p>
              </template>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <MemberInfoCard v-if="infoCardMember" :member="infoCardMember" @close="infoCardMember = null" />
</template>

<style scoped>
.admin-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: var(--overlay-scrim);
}

.admin-modal {
  position: relative;
  width: 100%;
  max-width: 680px;
  height: 82vh;
  max-height: 720px;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-md);
  background: var(--dialog-background);
  border: 1px solid var(--card-stroke);
  box-shadow: var(--shadow-dialog);
  overflow: hidden;
}

.admin-modal-enter-active,
.admin-modal-leave-active {
  transition: opacity var(--normal-duration) var(--fast-out-slow-in);
}

.admin-modal-enter-active .admin-modal,
.admin-modal-leave-active .admin-modal {
  transition:
    opacity var(--normal-duration) var(--fast-out-slow-in),
    transform var(--normal-duration) var(--fast-out-slow-in);
}

.admin-modal-enter-from,
.admin-modal-leave-to {
  opacity: 0;
}

.admin-modal-enter-from .admin-modal,
.admin-modal-leave-to .admin-modal {
  opacity: 0;
  transform: scale(0.94) translateY(12px);
}

@media (prefers-reduced-motion: reduce) {
  .admin-modal-enter-active,
  .admin-modal-leave-active,
  .admin-modal-enter-active .admin-modal,
  .admin-modal-leave-active .admin-modal {
    transition: none !important;
  }
}

.admin-modal__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 1.1rem 1.25rem 0;
}

.admin-modal__title {
  margin: 0;
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--text-primary);
}

.admin-modal__tabs {
  flex: 0 0 auto;
  margin: 0.9rem 1.25rem 0;
  padding: 0.25rem;
  border-radius: var(--radius-sm);
  background: var(--ctrl-fill-secondary);
}

.admin-modal__scroll {
  flex: 1 1 auto;
  overflow-y: auto;
}

.admin-modal__body {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 1rem 1.25rem 1.5rem;
}

.admin-modal__loading {
  color: var(--text-tertiary);
  font-size: 0.85rem;
}

.admin-modal__storage {
  margin: 0;
  font-size: 0.78rem;
  color: var(--text-tertiary);
}

.member-subtabs {
  align-self: flex-start;
  margin-bottom: 0.2rem;
}

.member-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.member-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  padding: 0.65rem 0.85rem;
  border-radius: var(--radius-sm);
  background: var(--card-bg);
  border: 1px solid var(--card-stroke);
}

.member-row__identity {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
  min-width: 0;
}

.member-row__names {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.member-row__display-name {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text-primary);
}

.member-row__actor {
  font-size: 0.72rem;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-row__groups {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.2rem;
}

.group-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: var(--ctrl-fill-tertiary);
  color: var(--text-secondary);
  font-size: 0.68rem;
}

.group-badge__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.member-row__role {
  flex: 0 0 auto;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  background: var(--ctrl-fill-tertiary);
  color: var(--text-secondary);
}

.member-row__role--owner {
  background: rgb(var(--colors-primary));
  color: var(--on-accent);
}

.member-row__role--mod {
  background: rgb(var(--colors-primary) / 0.16);
  color: rgb(var(--colors-primary));
}

.member-row__deny {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
  font-size: 0.76rem;
  color: var(--text-secondary);
}

.member-row__deny :deep(.win-switch-root) {
  min-width: 0;
}

.member-row__deny :deep(.win-switch-wrap) {
  gap: 6px;
  min-height: auto;
}

.member-row__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-left: auto;
}

.admin-modal__save {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.admin-modal__save-ok {
  margin: 0;
  font-size: 0.8rem;
  color: var(--SystemFillColorSuccessBrush);
}

.stronghold-danger {
  margin-top: 1.5rem;
  padding: 1rem;
  border: 1px solid color-mix(in srgb, var(--SystemFillColorCriticalBrush) 48%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--SystemFillColorCriticalBrush) 8%, transparent);
}

.stronghold-danger h2 {
  margin: 0;
  font-size: 0.95rem;
  color: var(--SystemFillColorCriticalBrush);
}

.stronghold-danger p {
  margin: 0.45rem 0 0.8rem;
  font-size: 0.82rem;
  color: var(--text-secondary);
}

@media (max-width: 768px) {
  .admin-modal-overlay {
    padding: 0;
  }

  .admin-modal {
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    border-radius: 0;
    background: var(--dialog-background);
  }
}
</style>
