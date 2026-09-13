<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { api, ApiRequestError } from '../api'
import type {
  AdminInstanceConfig,
  AdminInstanceConfigPatch,
  AdminUserEntry,
  BanEntry,
  DirectoryEntry,
  Emote,
  EmotePack,
  FeatureRestrictionMode,
  FeatureRestrictions,
  InviteCode,
  InstanceMode,
  MemberGroupRef,
  RootRequirement,
  ServerGroup,
  ServerRole,
  StrongholdApplication,
  StrongholdCreationPolicy,
  SsoMode,
} from '../api/types'
import { useAuth } from '../composables/useAuth'
import { useInstanceConfig } from '../composables/useInstanceConfig'
import { useStorageUsage } from '../composables/useStorageUsage'
import { actorListError, domainListError, fileUploadError, formatBytes, trustedServersError } from '../utils/validate'
import { WinButton, WinComboBox, WinInfoBar, WinSelectorBar, WinToggleSwitch } from '../vendor/winui'
import GroupEditorModal from './GroupEditorModal.vue'
import ImageEditor from './ImageEditor.vue'

// Server-level administration only (m0-protocol §7.9/§7.10/§7.10a) - instance
// policy, server member appointment, server-level user groups, invite codes,
// stronghold creation review, instance emote packs. Deliberately holds
// nothing stronghold-scoped. StrongholdAdminModal is the sibling. This is a
// PostModal-style floating window, not a full-screen shell swap.
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const auth = useAuth()
const { config: instanceConfig } = useInstanceConfig()

const ROOT_REQUIREMENT_LABEL: Record<RootRequirement, string> = { email: '邮箱', phone: '手机号', code: '邀请码' }
const CREATION_POLICY_LABEL: Record<StrongholdCreationPolicy, string> = { open: '开放', restricted: '限制', application: '申请制' }
const CREATION_POLICY_OPTIONS = (Object.entries(CREATION_POLICY_LABEL) as Array<[StrongholdCreationPolicy, string]>).map(([Value, Text]) => ({ Value, Text }))
const INSTANCE_MODE_LABEL: Record<InstanceMode, string> = { multi: '多据点', single: '单据点' }
const INSTANCE_MODE_OPTIONS = (Object.entries(INSTANCE_MODE_LABEL) as Array<[InstanceMode, string]>).map(([Value, Text]) => ({ Value, Text }))
const SSO_MODE_LABEL: Record<SsoMode, string> = { disabled: '关闭', optional: '允许 SSO 与本地登录', required: '仅允许 SSO' }
const SSO_MODE_OPTIONS = (Object.entries(SSO_MODE_LABEL) as Array<[SsoMode, string]>).map(([Value, Text]) => ({ Value, Text }))

const TAB_OPTIONS: { Text: string; value: 'overview' | 'members' | 'bans' | 'groups' }[] = [
  { Text: '概览', value: 'overview' },
  { Text: '服务器成员', value: 'members' },
  { Text: '全局黑名单', value: 'bans' },
  { Text: '用户组', value: 'groups' },
]
const tab = ref<'overview' | 'members' | 'bans' | 'groups'>('overview')
const tabSelected = computed(() => TAB_OPTIONS.find((o) => o.value === tab.value))
function onTabSelect(item: { value: 'overview' | 'members' | 'bans' | 'groups' }) {
  tab.value = item.value
}

// ---- instance policy ---------------------------------------------------------

const policyLoading = ref(true)
const policyError = ref('')
const config = ref<AdminInstanceConfig | null>(null)
const policySaving = ref(false)
const policySaveError = ref('')
const policySaveOk = ref('')
const policyForm = reactive({
  instanceMode: 'multi' as InstanceMode,
  rootStronghold: '',
  allowRoot: true,
  rootRequirements: [] as RootRequirement[],
  trustedServers: '*',
  federationPeers: '',
  strongholdCreation: 'open' as StrongholdCreationPolicy,
  strongholdCreators: '',
  allowGuestBrowsing: true,
  maxFileBytes: 10_485_760,
  storageQuotaBytes: 209_715_200,
  ssoMode: 'disabled' as SsoMode,
  ssoIssuer: '',
  ssoClientId: '',
  ssoProviderName: '',
  ssoClientSecret: '',
})

function setPolicyForm(value: AdminInstanceConfig) {
  policyForm.instanceMode = value.instance_mode
  policyForm.rootStronghold = value.root_stronghold ?? ''
  policyForm.allowRoot = value.allow_root
  policyForm.rootRequirements = [...value.root_requirements]
  policyForm.trustedServers = value.trusted_identity_servers.join('\n')
  policyForm.federationPeers = value.federation_peers.join('\n')
  policyForm.strongholdCreation = value.stronghold_creation_policy
  policyForm.strongholdCreators = value.stronghold_creators.join('\n')
  policyForm.allowGuestBrowsing = value.allow_guest_browsing
  policyForm.maxFileBytes = value.max_file_bytes
  policyForm.storageQuotaBytes = value.user_storage_quota_bytes
  policyForm.ssoMode = value.sso_mode
  policyForm.ssoIssuer = value.sso_issuer
  policyForm.ssoClientId = value.sso_client_id
  policyForm.ssoProviderName = value.sso_provider_name
  policyForm.ssoClientSecret = ''
}

function policyLines(value: string): string[] {
  return [...new Set(value.split('\n').map((line) => line.trim()).filter(Boolean))]
}

async function loadConfig() {
  if (!auth.token.value) return
  policyLoading.value = true
  policyError.value = ''
  try {
    config.value = await api.getAdminConfig(auth.token.value)
    setPolicyForm(config.value)
  } catch {
    policyError.value = '无法加载实例政策'
  } finally {
    policyLoading.value = false
  }
}

async function savePolicy() {
  if (!auth.token.value || !auth.isServerOwner.value || policySaving.value) return
  policySaveError.value = ''
  policySaveOk.value = ''
  const validationError = trustedServersError(policyForm.trustedServers)
    || domainListError(policyForm.federationPeers)
    || actorListError(policyForm.strongholdCreators)
  if (validationError) {
    policySaveError.value = validationError
    return
  }
  if (!Number.isSafeInteger(policyForm.maxFileBytes) || policyForm.maxFileBytes <= 0) {
    policySaveError.value = '单文件大小上限必须是正整数'
    return
  }
  if (!Number.isSafeInteger(policyForm.storageQuotaBytes) || policyForm.storageQuotaBytes < policyForm.maxFileBytes) {
    policySaveError.value = '用户存储配额必须是不小于单文件上限的正整数'
    return
  }
  if (policyForm.instanceMode === 'single' && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(policyForm.rootStronghold)) {
    policySaveError.value = '单据点模式必须填写有效的主据点短名'
    return
  }
  if (policyForm.ssoMode !== 'disabled') {
    try {
      const issuer = new URL(policyForm.ssoIssuer)
      const localDevelopment = issuer.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(issuer.hostname)
      if ((!['https:', 'http:'].includes(issuer.protocol) || (issuer.protocol === 'http:' && !localDevelopment)) || issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error()
    } catch {
      policySaveError.value = 'SSO Issuer 必须是 HTTPS 地址（本地开发可使用 localhost）'
      return
    }
    if (!policyForm.ssoClientId.trim() || (!config.value?.sso_client_secret_configured && !policyForm.ssoClientSecret)) {
      policySaveError.value = '启用 SSO 时必须填写 Client ID 与 Client Secret'
      return
    }
  }
  policySaving.value = true
  try {
    const patch: AdminInstanceConfigPatch = {
      instance_mode: policyForm.instanceMode,
      root_stronghold: policyForm.rootStronghold,
      allow_root: policyForm.allowRoot,
      root_requirements: [...policyForm.rootRequirements],
      trusted_identity_servers: policyLines(policyForm.trustedServers),
      federation_peers: policyLines(policyForm.federationPeers),
      stronghold_creation_policy: policyForm.strongholdCreation,
      stronghold_creators: policyLines(policyForm.strongholdCreators),
      allow_guest_browsing: policyForm.allowGuestBrowsing,
      max_file_bytes: policyForm.maxFileBytes,
      user_storage_quota_bytes: policyForm.storageQuotaBytes,
      sso_mode: policyForm.ssoMode,
      sso_issuer: policyForm.ssoIssuer,
      sso_client_id: policyForm.ssoClientId,
      sso_provider_name: policyForm.ssoProviderName,
    }
    if (policyForm.ssoClientSecret) patch.sso_client_secret = policyForm.ssoClientSecret
    const updated = await api.patchAdminConfig(auth.token.value, patch)
    config.value = updated
    setPolicyForm(updated)
    policySaveOk.value = '配置已提交到 Cloudflare，新的请求会在配置版本接管后使用这些设置。'
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'CONFIG_UPSTREAM_UNAVAILABLE') {
      policySaveError.value = '实例尚未配置环境管理密钥，或 Cloudflare 暂时不可达。请通过 Overture 重新部署或补齐 Worker Secret。'
    } else if (error instanceof ApiRequestError && error.code === 'CONFIG_UPSTREAM_ERROR') {
      policySaveError.value = 'Cloudflare 拒绝了配置更新，请确认应用令牌仍有 Workers Scripts 写权限。'
    } else if (error instanceof ApiRequestError && error.code === 'CONFIG_INVALID') {
      policySaveError.value = '配置内容不符合服务器约束，请检查域名、账号与容量设置。'
    } else {
      policySaveError.value = '保存失败，请稍后重试。'
    }
  } finally {
    policySaving.value = false
  }
}

// ---- server member appointment + group assignment ---------------------------
// Every server admin can list accounts and maintain their server-level groups.
// Server-role appointment remains an owner-only action below.

const users = ref<AdminUserEntry[]>([])
const usersLoading = ref(false)
const usersError = ref('')
const usersCursor = ref<string | null>(null)
const roleChangingLocalpart = ref('')
const userGroups = ref<Record<string, MemberGroupRef[]>>({})
const openGroupPickerFor = ref('')
const groupTogglePending = ref('')
const globalBans = ref<BanEntry[]>([])
const globalBansError = ref('')
const globalBanBusyActor = ref('')
const globalBanExpiresAt = ref('')

function formatExpiry(expiresAt: string | null) {
  return expiresAt ? `自动解封：${new Date(expiresAt).toLocaleString()}` : '永久封禁'
}

function selectedGlobalExpiry(): number | null | undefined {
  if (!globalBanExpiresAt.value) return null
  const expiresAt = new Date(globalBanExpiresAt.value).getTime()
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    globalBansError.value = '自动解封时间必须晚于当前时间'
    return undefined
  }
  return expiresAt
}

function canGloballyBan(user: AdminUserEntry) {
  return user.server_role !== 'owner' && (auth.isServerOwner.value || user.server_role === 'user')
}

function canGloballyUnban(ban: BanEntry) {
  if (auth.isServerOwner.value) return true
  const localpart = ban.actor.replace(/^@/, '').split(':')[0]
  return users.value.find((user) => user.localpart === localpart)?.server_role === 'user'
}

function actorForLocalpart(localpart: string) {
  const actor = auth.user.value?.actor
  const domain = actor?.slice(actor.indexOf(':') + 1)
  return domain ? `@${localpart}:${domain}` : null
}

async function loadGlobalBans() {
  if (!auth.token.value || !auth.isAdmin.value) return
  globalBansError.value = ''
  try {
    globalBans.value = await api.listGlobalBans(auth.token.value)
  } catch {
    globalBansError.value = '加载全局黑名单失败'
  }
}

async function banGlobally(user: AdminUserEntry) {
  const actor = actorForLocalpart(user.localpart)
  if (!auth.token.value || !actor || !canGloballyBan(user) || globalBanBusyActor.value) return
  const expiresAt = selectedGlobalExpiry()
  if (expiresAt === undefined) return
  const duration = expiresAt == null ? '永久' : `至 ${new Date(expiresAt).toLocaleString()}`
  if (!confirm(`确定全局封禁「${user.username}」吗？该账号将无法访问本服务器；${duration}。`)) return
  globalBanBusyActor.value = user.localpart
  globalBansError.value = ''
  try {
    await api.banAccountGlobally(auth.token.value, actor, expiresAt)
    await loadGlobalBans()
  } catch {
    globalBansError.value = '全局封禁失败，请稍后重试'
  } finally {
    globalBanBusyActor.value = ''
  }
}

async function unbanGlobally(ban: BanEntry) {
  if (!auth.token.value || !canGloballyUnban(ban) || globalBanBusyActor.value) return
  globalBanBusyActor.value = ban.actor
  globalBansError.value = ''
  try {
    await api.unbanAccountGlobally(auth.token.value, ban.actor)
    await loadGlobalBans()
  } catch {
    globalBansError.value = '解除全局封禁失败，请稍后重试'
  } finally {
    globalBanBusyActor.value = ''
  }
}

async function loadUsers(reset = true) {
  if (!auth.token.value || !auth.isAdmin.value) return
  usersLoading.value = true
  usersError.value = ''
  try {
    const page = await api.getAdminUsers(auth.token.value, reset ? undefined : (usersCursor.value ?? undefined))
    users.value = reset ? page.users : [...users.value, ...page.users]
    usersCursor.value = page.next_cursor
    // scoped to this page only (USERS_PAGE_SIZE=50, well under the 100-localpart
    // lookup cap) - looking up the whole accumulated list would trip that cap
    // once enough pages load
    const pageLocalparts = page.users.map((u) => u.localpart)
    if (pageLocalparts.length) {
      const pageGroups = await api.getGroupsForMembers(auth.token.value, pageLocalparts)
      userGroups.value = reset ? pageGroups : { ...userGroups.value, ...pageGroups }
    } else if (reset) {
      userGroups.value = {}
    }
  } catch {
    usersError.value = '无法加载用户列表'
  } finally {
    usersLoading.value = false
  }
}

async function setUserRole(user: AdminUserEntry, role: Extract<ServerRole, 'admin' | 'user'>) {
  if (!auth.token.value || !auth.isServerOwner.value || roleChangingLocalpart.value) return
  usersError.value = ''
  roleChangingLocalpart.value = user.localpart
  try {
    await api.patchAdminUserRole(auth.token.value, user.localpart, role)
    user.server_role = role
  } catch {
    usersError.value = '操作失败，请稍后重试'
  } finally {
    roleChangingLocalpart.value = ''
  }
}

function hasGroup(localpart: string, groupId: string): boolean {
  return (userGroups.value[localpart] ?? []).some((g) => g.id === groupId)
}

async function toggleUserGroup(localpart: string, group: ServerGroup, assign: boolean) {
  if (!auth.token.value || groupTogglePending.value) return
  groupTogglePending.value = `${localpart}:${group.id}`
  usersError.value = ''
  try {
    if (assign) await api.assignServerGroupMember(auth.token.value, group.id, localpart)
    else await api.unassignServerGroupMember(auth.token.value, group.id, localpart)
    const current = userGroups.value[localpart] ?? []
    userGroups.value = {
      ...userGroups.value,
      [localpart]: assign
        ? [...current, { id: group.id, name: group.name, color: group.color }]
        : current.filter((g) => g.id !== group.id),
    }
  } catch {
    usersError.value = '分组操作失败，请稍后重试'
  } finally {
    groupTogglePending.value = ''
  }
}

// ---- server-level user groups ------------------------------------------------

const groups = ref<ServerGroup[]>([])
const groupsLoading = ref(false)
const groupsError = ref('')
const groupEditorOpen = ref(false)
const editingGroup = ref<ServerGroup | null>(null)

async function loadGroups() {
  if (!auth.token.value) return
  groupsLoading.value = true
  groupsError.value = ''
  try {
    groups.value = await api.getServerGroups(auth.token.value)
  } catch {
    groupsError.value = '加载用户组失败'
  } finally {
    groupsLoading.value = false
  }
}

// members tab also renders each user's group checkboxes (see user-row__groups
// below) - it needs the group list loaded just as much as the groups tab
// itself does, or a cold open straight into members shows an empty list
// until the user happens to also visit the groups tab (F7).
watch(
  [tab, () => props.open],
  ([t, open]) => {
    if (open && (t === 'groups' || t === 'members')) void loadGroups()
  },
  { immediate: true },
)

function openCreateGroup() {
  editingGroup.value = null
  groupEditorOpen.value = true
}

function openEditGroup(group: ServerGroup) {
  editingGroup.value = group
  groupEditorOpen.value = true
}

function onGroupSaved() {
  void loadGroups()
  if (auth.isAdmin.value) void loadUsers()
}

async function deleteGroupConfirm(group: ServerGroup) {
  if (!auth.token.value) return
  if (!confirm(`删除用户组「${group.name}」？成员会保留，但会失去这个组带来的权限与徽章。`)) return
  groupsError.value = ''
  try {
    await api.deleteServerGroup(auth.token.value, group.id)
    await loadGroups()
    if (auth.isAdmin.value) await loadUsers()
  } catch {
    groupsError.value = '删除失败，请稍后重试'
  }
}

async function moveGroup(index: number, direction: -1 | 1) {
  if (!auth.token.value) return
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= groups.value.length) return
  const reordered = [...groups.value]
  const tmp = reordered[index]!
  reordered[index] = reordered[targetIndex]!
  reordered[targetIndex] = tmp
  groupsError.value = ''
  try {
    groups.value = await api.reorderServerGroups(
      auth.token.value,
      reordered.map((g, i) => ({ id: g.id, position: i })),
    )
  } catch {
    groupsError.value = '排序失败，请稍后重试'
  }
}

// ---- invite codes --------------------------------------------------------------

const inviteCodes = ref<InviteCode[]>([])
const inviteCount = ref(1)
const inviteBusy = ref(false)
const inviteError = ref('')

async function loadInviteCodes() {
  if (!auth.token.value) return
  try {
    inviteCodes.value = await api.listInviteCodes(auth.token.value)
  } catch {
    // non-fatal — the invite list is secondary to the rest of this panel
  }
}

async function generateInviteCodes() {
  if (!auth.token.value) return
  inviteError.value = ''
  inviteBusy.value = true
  try {
    inviteCodes.value = await api.createInviteCodes(auth.token.value, inviteCount.value)
  } catch {
    inviteError.value = '生成失败，请稍后重试'
  } finally {
    inviteBusy.value = false
  }
}

// ---- stronghold creation applications -------------------------------------------

const pendingApplications = ref<StrongholdApplication[]>([])
const applicationsError = ref('')
const decidingId = ref('')
const approvedNotice = ref('')

async function loadPendingApplications() {
  if (!auth.token.value) return
  applicationsError.value = ''
  try {
    pendingApplications.value = await api.getAdminStrongholdApplications(auth.token.value, 'pending')
  } catch {
    applicationsError.value = '无法加载待审申请'
  }
}

async function decideApplication(id: string, state: 'approved' | 'rejected') {
  if (!auth.token.value || decidingId.value) return
  decidingId.value = id
  approvedNotice.value = ''
  try {
    await api.decideStrongholdApplication(auth.token.value, id, state)
    if (state === 'approved') approvedNotice.value = '已批准，据点已创建'
    await loadPendingApplications()
  } catch {
    applicationsError.value = '操作失败，请稍后重试'
  } finally {
    decidingId.value = ''
  }
}

// ---- instance emote packs (018 admin endpoints) ---------------------------------

const packs = ref<EmotePack[]>([])
const packsError = ref('')
const newPackName = ref('')
const packBusy = ref(false)
const newEmoteName = reactive<Record<string, string>>({})
const emoteUploading = reactive<Record<string, boolean>>({})
const emoteEditorFile = ref<File | null>(null)
const emoteEditorPack = ref<EmotePack | null>(null)
const { usage: storage } = useStorageUsage()

async function loadPacks() {
  if (!auth.token.value) return
  try {
    packs.value = await api.getEmotes(auth.token.value)
  } catch {
    packsError.value = '无法加载表情包列表'
  }
}

async function createPack() {
  if (!auth.token.value || packBusy.value) return
  packsError.value = ''
  const name = newPackName.value.trim()
  if (!name || name.length > 32 || name.includes(':')) {
    packsError.value = '表情包名称需为 1-32 字，且不能包含冒号'
    return
  }
  packBusy.value = true
  try {
    await api.createEmotePack(auth.token.value, name)
    newPackName.value = ''
    await loadPacks()
  } catch {
    packsError.value = '创建失败，请稍后重试'
  } finally {
    packBusy.value = false
  }
}

async function deletePack(pack: EmotePack) {
  if (!auth.token.value) return
  if (!confirm(`删除表情包「${pack.name}」？包内所有表情将一并移除。`)) return
  packsError.value = ''
  try {
    await api.deleteEmotePack(auth.token.value, pack.id)
    await loadPacks()
  } catch {
    packsError.value = '删除失败，请稍后重试'
  }
}

async function addEmote(pack: EmotePack, blob: Blob) {
  if (!auth.token.value || emoteUploading[pack.id]) return
  const name = (newEmoteName[pack.id] ?? '').trim()
  if (!name || name.length > 32 || name.includes(':')) {
    packsError.value = '表情名称需为 1-32 字，且不能包含冒号'
    return
  }
  const preflight = fileUploadError(blob, storage.value)
  if (preflight) {
    packsError.value = preflight
    return
  }
  packsError.value = ''
  emoteUploading[pack.id] = true
  try {
    const uploaded = await api.uploadMedia(auth.token.value, blob)
    await api.createEmote(auth.token.value, pack.id, name, uploaded.id)
    newEmoteName[pack.id] = ''
    await loadPacks()
  } catch {
    packsError.value = '添加失败，请稍后重试'
  } finally {
    emoteUploading[pack.id] = false
  }
}

function onEmoteFileChange(pack: EmotePack, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) {
    emoteEditorPack.value = pack
    emoteEditorFile.value = file
  }
  input.value = ''
}

async function confirmEmote(blob: Blob) {
  const pack = emoteEditorPack.value
  if (pack) await addEmote(pack, blob)
  emoteEditorFile.value = null
  emoteEditorPack.value = null
}

async function deleteEmote(emote: Emote) {
  if (!auth.token.value) return
  packsError.value = ''
  try {
    await api.deleteEmote(auth.token.value, emote.id)
    await loadPacks()
  } catch {
    packsError.value = '删除失败，请稍后重试'
  }
}

// ---- stronghold slug (短名地址管理) -----------------------------------

const strongholds = ref<DirectoryEntry[]>([])
const strongholdsError = ref('')
const editingSlugId = ref('')
const editingSlugValue = ref('')
const slugError = ref('')
const slugBusy = ref(false)
const serverRestrictions = ref<Record<string, FeatureRestrictions>>({})
const serverRestrictionDrafts = reactive<Record<string, { mode: FeatureRestrictionMode; expiresAt: string }>>({})
const serverRestrictionsError = ref('')
const serverRestrictionBusy = ref('')
const FEATURE_LABEL = { chat: '聊天', posts: '发帖' } as const
const SERVER_RESTRICTION_OPTIONS = [
  { Text: '继承据点领主设置', Value: 'inherit' },
  { Text: '服务器强制允许', Value: 'force_allow' },
  { Text: '服务器强制暂停', Value: 'force_pause' },
]

function restrictionDraftKey(nodeId: string, feature: 'chat' | 'posts') {
  return `${nodeId}:${feature}`
}

function toDateTimeLocal(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function getServerRestrictionDraft(nodeId: string, feature: 'chat' | 'posts') {
  return serverRestrictionDrafts[restrictionDraftKey(nodeId, feature)] ?? { mode: 'inherit' as const, expiresAt: '' }
}

function setServerRestrictionMode(nodeId: string, feature: 'chat' | 'posts', mode: FeatureRestrictionMode) {
  const key = restrictionDraftKey(nodeId, feature)
  const current = getServerRestrictionDraft(nodeId, feature)
  serverRestrictionDrafts[key] = { ...current, mode, expiresAt: mode === 'inherit' ? '' : current.expiresAt }
}

function setServerRestrictionExpiry(nodeId: string, feature: 'chat' | 'posts', event: Event) {
  const key = restrictionDraftKey(nodeId, feature)
  const current = getServerRestrictionDraft(nodeId, feature)
  serverRestrictionDrafts[key] = { ...current, expiresAt: (event.target as HTMLInputElement).value }
}

function effectiveRestrictionSummary(nodeId: string, feature: 'chat' | 'posts') {
  const effective = serverRestrictions.value[nodeId]?.[feature].effective
  if (!effective) return '状态加载中'
  if (!effective.paused) return '当前可用'
  const source = effective.source === 'server' ? '服务器覆盖' : '据点领主'
  return effective.expires_at ? `当前已暂停（${source}，自动恢复：${new Date(effective.expires_at).toLocaleString()}）` : `当前已暂停（${source}，未设置自动恢复）`
}

async function loadServerRestrictions(nodeId: string) {
  if (!auth.token.value || !auth.isAdmin.value) return
  const restrictions = await api.getFeatureRestrictions(auth.token.value, nodeId)
  serverRestrictions.value = { ...serverRestrictions.value, [nodeId]: restrictions }
  for (const feature of ['chat', 'posts'] as const) {
    serverRestrictionDrafts[restrictionDraftKey(nodeId, feature)] = {
      mode: restrictions[feature].server.mode,
      expiresAt: toDateTimeLocal(restrictions[feature].server.expires_at),
    }
  }
}

async function saveServerRestriction(nodeId: string, feature: 'chat' | 'posts') {
  if (!auth.token.value || !auth.isAdmin.value || serverRestrictionBusy.value) return
  const draft = getServerRestrictionDraft(nodeId, feature)
  let expiresAt: number | null = null
  if (draft.mode !== 'inherit' && draft.expiresAt) {
    expiresAt = new Date(draft.expiresAt).getTime()
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      serverRestrictionsError.value = '自动恢复时间必须晚于当前时间'
      return
    }
  }
  serverRestrictionBusy.value = restrictionDraftKey(nodeId, feature)
  serverRestrictionsError.value = ''
  try {
    await api.patchServerFeatureRestriction(auth.token.value, nodeId, feature, draft.mode, expiresAt)
    await loadServerRestrictions(nodeId)
  } catch {
    serverRestrictionsError.value = '保存服务器覆盖失败，请稍后重试'
  } finally {
    serverRestrictionBusy.value = ''
  }
}

async function loadStrongholdsList() {
  strongholdsError.value = ''
  try {
    strongholds.value = await api.getDirectory()
    if (auth.isAdmin.value) await Promise.all(strongholds.value.map((stronghold) => loadServerRestrictions(stronghold.id)))
  } catch {
    strongholdsError.value = '无法加载据点列表'
  }
}

function startEditSlug(s: DirectoryEntry) {
  editingSlugId.value = s.id
  editingSlugValue.value = s.slug
  slugError.value = ''
}

function cancelEditSlug() {
  editingSlugId.value = ''
  slugError.value = ''
}

async function saveSlug(s: DirectoryEntry) {
  if (!auth.token.value || slugBusy.value) return
  const next = editingSlugValue.value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(next)) {
    slugError.value = '短名只能用小写字母、数字与连字符'
    return
  }
  slugBusy.value = true
  slugError.value = ''
  try {
    const result = await api.patchStrongholdSlug(auth.token.value, s.id, next)
    s.slug = result.slug
    editingSlugId.value = ''
  } catch (err) {
    if (err instanceof ApiRequestError && err.code === 'MALFORMED') slugError.value = '短名只能用小写字母、数字与连字符'
    else if (err instanceof ApiRequestError && err.code === 'ALREADY_EXISTS') slugError.value = '该短名已被占用'
    else slugError.value = '保存失败，请稍后重试'
  } finally {
    slugBusy.value = false
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

watch(
  () => props.open,
  (open) => {
    if (!open) return
    tab.value = 'overview'
    loadConfig().then(() => {
      if (config.value?.stronghold_creation_policy === 'application') void loadPendingApplications()
    })
    loadInviteCodes()
    loadPacks()
    loadStrongholdsList()
    if (auth.isAdmin.value) {
      void loadUsers()
      void loadGlobalBans()
    }
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <Transition name="admin-modal">
      <div v-if="open" class="admin-modal-overlay" @click.self="close">
        <div class="admin-modal" role="dialog" aria-modal="true" aria-label="服务器管理">
          <div class="admin-modal__header">
            <h1 class="admin-modal__title">服务器管理</h1>
            <WinButton Style="SubtleButtonStyle" @click="close">关闭</WinButton>
          </div>

          <WinSelectorBar class="admin-modal__tabs" :Items="TAB_OPTIONS" :SelectedItem="tabSelected" @update:SelectedItem="onTabSelect" />

          <div class="admin-modal__scroll">
            <div v-if="policyLoading" class="admin-modal__loading">正在加载…</div>
            <WinInfoBar v-else-if="policyError" :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Error">
              {{ policyError }}
            </WinInfoBar>

            <div v-else-if="tab === 'overview'" class="admin-modal__body">
              <section v-if="instanceConfig?.emotes_enabled !== false" class="admin-card">
                <h2 class="admin-card__title">实例政策</h2>
                <template v-if="auth.isServerOwner.value">
                  <WinInfoBar :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Informational">
                    保存会使用实例预存的 Cloudflare 应用令牌创建新的 Worker 配置版本；令牌不会发送到浏览器。
                  </WinInfoBar>
                  <form v-if="config" class="policy-form" @submit.prevent="savePolicy">
                    <div class="policy-form__switches">
                      <WinToggleSwitch v-model="policyForm.allowRoot">允许本实例注册账号</WinToggleSwitch>
                      <WinToggleSwitch v-model="policyForm.allowGuestBrowsing">允许游客浏览公开据点</WinToggleSwitch>
                    </div>

                    <div class="field">
                      <span class="field__label">运行模式</span>
                      <WinComboBox
                        :ItemsSource="INSTANCE_MODE_OPTIONS"
                        SelectedValuePath="Value"
                        v-model:SelectedValue="policyForm.instanceMode"
                      />
                    </div>
                    <div v-if="policyForm.instanceMode === 'single'" class="field">
                      <label class="field__label" for="policy-root-stronghold">主据点短名</label>
                      <input id="policy-root-stronghold" v-model.trim="policyForm.rootStronghold" maxlength="32" pattern="[a-z0-9][a-z0-9-]{0,31}" />
                      <p class="field__hint">单据点模式下主据点直接挂在 /，首页、据点切换栏和创建入口都会隐藏。</p>
                    </div>

                    <fieldset class="policy-form__fieldset">
                      <legend class="field__label">统一登录</legend>
                      <div class="field">
                        <span class="field__label">SSO 模式</span>
                        <WinComboBox
                          :ItemsSource="SSO_MODE_OPTIONS"
                          SelectedValuePath="Value"
                          v-model:SelectedValue="policyForm.ssoMode"
                        />
                      </div>
                      <template v-if="policyForm.ssoMode !== 'disabled'">
                        <div class="field">
                          <label class="field__label" for="policy-sso-issuer">OIDC Issuer</label>
                          <input id="policy-sso-issuer" v-model.trim="policyForm.ssoIssuer" type="url" placeholder="https://identity.example" />
                        </div>
                        <div class="field">
                          <label class="field__label" for="policy-sso-client-id">Client ID</label>
                          <input id="policy-sso-client-id" v-model.trim="policyForm.ssoClientId" autocomplete="off" />
                        </div>
                        <div class="field">
                          <label class="field__label" for="policy-sso-provider-name">登录按钮名称</label>
                          <input id="policy-sso-provider-name" v-model.trim="policyForm.ssoProviderName" maxlength="64" placeholder="SSO" />
                        </div>
                        <div class="field">
                          <label class="field__label" for="policy-sso-client-secret">Client Secret</label>
                          <input id="policy-sso-client-secret" v-model="policyForm.ssoClientSecret" type="password" autocomplete="new-password" placeholder="留空表示保持现有密钥" />
                          <p class="field__hint">当前密钥：{{ config?.sso_client_secret_configured ? '已配置' : '未配置' }}。密钥只写入 Worker Secret。</p>
                        </div>
                      </template>
                    </fieldset>

                    <fieldset class="policy-form__fieldset">
                      <legend class="field__label">注册门槛</legend>
                      <label v-for="(label, requirement) in ROOT_REQUIREMENT_LABEL" :key="requirement" class="policy-form__check">
                        <input v-model="policyForm.rootRequirements" type="checkbox" :value="requirement" />
                        <span>{{ label }}</span>
                      </label>
                      <p v-if="policyForm.rootRequirements.includes('phone')" class="field__hint">当前版本尚未接入短信通道；启用手机号会暂停新账号注册。</p>
                    </fieldset>

                    <div class="field">
                      <label class="field__label" for="policy-trusted-servers">信任身份服务器（每行一个域名，可用 *）</label>
                      <textarea id="policy-trusted-servers" v-model="policyForm.trustedServers" rows="3" spellcheck="false"></textarea>
                    </div>
                    <div class="field">
                      <label class="field__label" for="policy-federation-peers">联邦对等实例（每行一个域名）</label>
                      <textarea id="policy-federation-peers" v-model="policyForm.federationPeers" rows="3" spellcheck="false"></textarea>
                    </div>
                    <div class="field">
                      <span class="field__label">建据点策略</span>
                      <WinComboBox
                        :ItemsSource="CREATION_POLICY_OPTIONS"
                        SelectedValuePath="Value"
                        v-model:SelectedValue="policyForm.strongholdCreation"
                      />
                    </div>
                    <div v-if="policyForm.strongholdCreation === 'restricted'" class="field">
                      <label class="field__label" for="policy-stronghold-creators">允许建点的账号（每行一个完整 actor）</label>
                      <textarea id="policy-stronghold-creators" v-model="policyForm.strongholdCreators" rows="3" spellcheck="false" placeholder="@name:example.com"></textarea>
                    </div>
                    <div class="policy-form__limits">
                      <div class="field">
                        <label class="field__label" for="policy-max-file">单文件大小上限（字节）</label>
                        <input id="policy-max-file" v-model.number="policyForm.maxFileBytes" type="number" min="1" step="1" />
                        <p class="field__hint">{{ formatBytes(policyForm.maxFileBytes) }}</p>
                      </div>
                      <div class="field">
                        <label class="field__label" for="policy-storage-quota">每用户存储配额（字节）</label>
                        <input id="policy-storage-quota" v-model.number="policyForm.storageQuotaBytes" type="number" min="1" step="1" />
                        <p class="field__hint">{{ formatBytes(policyForm.storageQuotaBytes) }}</p>
                      </div>
                    </div>
                    <p v-if="policySaveError" class="field__error">{{ policySaveError }}</p>
                    <p v-if="policySaveOk" class="admin-modal__save-ok" role="status">{{ policySaveOk }}</p>
                    <div class="policy-form__actions">
                      <WinButton type="submit" Style="AccentButtonStyle" :IsEnabled="!policySaving">
                        {{ policySaving ? '正在更新 Cloudflare…' : '保存并更新实例' }}
                      </WinButton>
                      <WinButton type="button" Style="SubtleButtonStyle" :IsEnabled="!policySaving" @click="config && setPolicyForm(config)">撤销未保存更改</WinButton>
                    </div>
                  </form>
                </template>
                <template v-else>
                  <WinInfoBar :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Informational">
                    服务器管理员可以查看实例政策，只有服务器领主可以更新部署环境。
                  </WinInfoBar>
                </template>
                <dl v-if="config && !auth.isServerOwner.value" class="policy-summary">
                  <dt>运行模式</dt>
                  <dd>{{ INSTANCE_MODE_LABEL[config.instance_mode] }}<template v-if="config.instance_mode === 'single'">（{{ config.root_stronghold || '未设置主据点' }}）</template></dd>
                  <dt>SSO 模式</dt>
                  <dd>{{ SSO_MODE_LABEL[config.sso_mode] }}<template v-if="config.sso_mode !== 'disabled'">（{{ config.sso_client_secret_configured ? '已配置' : '未配置' }}）</template></dd>
                  <dt>根节点（开放注册）</dt>
                  <dd>{{ config.allow_root ? '已开启' : '已关闭' }}</dd>
                  <dt>注册门槛</dt>
                  <dd>{{ config.root_requirements.length ? config.root_requirements.map((r) => ROOT_REQUIREMENT_LABEL[r]).join('、') : '无' }}</dd>
                  <dt>信任身份服务器</dt>
                  <dd>{{ config.trusted_identity_servers.join('、') || '无' }}</dd>
                  <dt>联邦对等实例</dt>
                  <dd>{{ config.federation_peers.join('、') || '无' }}</dd>
                  <dt>建据点策略</dt>
                  <dd>{{ CREATION_POLICY_LABEL[config.stronghold_creation_policy] }}</dd>
                  <dt v-if="config.stronghold_creation_policy === 'restricted'">允许建点的用户</dt>
                  <dd v-if="config.stronghold_creation_policy === 'restricted'">{{ config.stronghold_creators.join('、') || '无' }}</dd>
                  <dt>游客浏览</dt>
                  <dd>{{ config.allow_guest_browsing ? '已开启' : '已关闭' }}</dd>
                </dl>
              </section>

              <section class="admin-card">
                <h2 class="admin-card__title">邀请码</h2>
                <div class="admin-invite__controls">
                  <div class="field admin-invite__count">
                    <label class="field__label" for="invite-count">生成数量</label>
                    <input id="invite-count" v-model.number="inviteCount" type="number" min="1" max="50" />
                  </div>
                  <WinButton Style="DefaultButtonStyle" :IsEnabled="!inviteBusy" @click="generateInviteCodes">
                    {{ inviteBusy ? '生成中…' : '生成邀请码' }}
                  </WinButton>
                </div>
                <p v-if="inviteError" class="field__error">{{ inviteError }}</p>

                <ul v-if="inviteCodes.length" class="admin-invite__list">
                  <li v-for="invite in inviteCodes" :key="invite.code" class="admin-invite__item">
                    <code>{{ invite.code }}</code>
                    <span class="admin-invite__status" :class="{ 'admin-invite__status--used': invite.used_by != null }">
                      {{ invite.used_by != null ? '已使用' : '未使用' }}
                    </span>
                  </li>
                </ul>
                <p v-else class="field__hint">暂无邀请码。</p>
              </section>

              <section class="admin-card">
                <h2 class="admin-card__title">据点短名</h2>
                <WinInfoBar :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Informational">
                  短名用于据点的地址（如 /a/短名），改名会让旧链接失效。
                </WinInfoBar>
                <p v-if="strongholdsError" class="field__error">{{ strongholdsError }}</p>
                <p v-if="!strongholds.length && !strongholdsError" class="field__hint">暂无据点</p>
                <ul v-else class="admin-slug__list">
                  <li v-for="s in strongholds" :key="s.id" class="admin-slug__item">
                    <img v-if="s.avatar" class="admin-slug__avatar" :src="s.avatar" alt="" />
                    <span class="admin-slug__name">{{ s.name }}</span>
                    <template v-if="editingSlugId === s.id">
                      <div class="field admin-slug__edit">
                        <input v-model="editingSlugValue" type="text" maxlength="32" @keyup.enter="saveSlug(s)" @keyup.escape="cancelEditSlug" />
                        <p v-if="slugError" class="field__error">{{ slugError }}</p>
                      </div>
                      <WinButton Style="AccentButtonStyle" :IsEnabled="!slugBusy" @click="saveSlug(s)">保存</WinButton>
                      <WinButton Style="SubtleButtonStyle" :IsEnabled="!slugBusy" @click="cancelEditSlug">取消</WinButton>
                    </template>
                    <template v-else>
                      <code class="admin-slug__value">{{ s.slug }}</code>
                      <WinButton Style="SubtleButtonStyle" @click="startEditSlug(s)">改名</WinButton>
                    </template>
                  </li>
                </ul>
              </section>

              <section v-if="auth.isAdmin.value" class="admin-card">
                <h2 class="admin-card__title">据点聊天与发帖覆盖</h2>
                <WinInfoBar :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Informational">
                  服务器覆盖优先于据点领主设置。聊天与发帖可分别设置；选择继承会立刻恢复领主设置的优先级。
                </WinInfoBar>
                <p v-if="serverRestrictionsError" class="field__error">{{ serverRestrictionsError }}</p>
                <div v-for="s in strongholds" :key="`restrictions-${s.id}`" class="admin-feature-restriction">
                  <h3>{{ s.name }}</h3>
                  <div v-for="feature in (['chat', 'posts'] as const)" :key="feature" class="admin-feature-restriction__row">
                    <strong>{{ FEATURE_LABEL[feature] }}</strong>
                    <span class="field__hint">{{ effectiveRestrictionSummary(s.id, feature) }}</span>
                    <WinComboBox
                      :ItemsSource="SERVER_RESTRICTION_OPTIONS"
                      SelectedValuePath="Value"
                      :SelectedValue="getServerRestrictionDraft(s.id, feature).mode"
                      @update:SelectedValue="setServerRestrictionMode(s.id, feature, $event as FeatureRestrictionMode)"
                    />
                    <div v-if="getServerRestrictionDraft(s.id, feature).mode !== 'inherit'" class="field">
                      <label class="field__label" :for="`server-${s.id}-${feature}-resume-at`">自动恢复时间（可选）</label>
                      <input :id="`server-${s.id}-${feature}-resume-at`" :value="getServerRestrictionDraft(s.id, feature).expiresAt" type="datetime-local" @input="setServerRestrictionExpiry(s.id, feature, $event)" />
                    </div>
                    <WinButton Style="AccentButtonStyle" :IsEnabled="!serverRestrictionBusy" @click="saveServerRestriction(s.id, feature)">
                      {{ serverRestrictionBusy === restrictionDraftKey(s.id, feature) ? '保存中…' : '保存服务器覆盖' }}
                    </WinButton>
                  </div>
                </div>
              </section>

              <section v-if="config?.stronghold_creation_policy === 'application'" class="admin-card">
                <h2 class="admin-card__title">建点申请审批</h2>
                <p v-if="approvedNotice" class="admin-modal__save-ok">{{ approvedNotice }}</p>
                <p v-if="applicationsError" class="field__error">{{ applicationsError }}</p>
                <p v-if="!pendingApplications.length" class="field__hint">暂无待审申请</p>
                <ul v-else class="admin-applications__list">
                  <li v-for="app in pendingApplications" :key="app.id" class="admin-applications__item">
                    <div class="admin-applications__meta">
                      <span class="admin-applications__name">{{ app.name }}</span>
                      <span class="admin-applications__actor">{{ app.actor }}</span>
                      <p v-if="app.description" class="admin-applications__desc">{{ app.description }}</p>
                    </div>
                    <div class="admin-applications__actions">
                      <WinButton Style="AccentButtonStyle" :IsEnabled="!decidingId" @click="decideApplication(app.id, 'approved')">
                        批准
                      </WinButton>
                      <WinButton Style="SubtleButtonStyle" :IsEnabled="!decidingId" @click="decideApplication(app.id, 'rejected')">
                        拒绝
                      </WinButton>
                    </div>
                  </li>
                </ul>
              </section>

              <section class="admin-card">
                <h2 class="admin-card__title">实例表情包</h2>
                <p v-if="packsError" class="field__error">{{ packsError }}</p>
                <div class="admin-pack__create">
                  <input v-model="newPackName" type="text" maxlength="32" placeholder="新表情包名称" />
                  <WinButton Style="DefaultButtonStyle" :IsEnabled="!packBusy" @click="createPack">
                    {{ packBusy ? '创建中…' : '新建表情包' }}
                  </WinButton>
                </div>

                <div v-if="!packs.length" class="field__hint">暂无表情包</div>
                <div v-for="pack in packs" :key="pack.id" class="admin-pack">
                  <div class="admin-pack__header">
                    <span class="admin-pack__name">{{ pack.display ?? pack.name }}</span>
                    <WinButton Style="SubtleButtonStyle" class="win-btn--danger" @click="deletePack(pack)">删除表情包</WinButton>
                  </div>
                  <ul v-if="pack.emotes.length" class="admin-pack__emotes">
                    <li v-for="emote in pack.emotes" :key="emote.id" class="admin-pack__emote">
                      <img :src="emote.url" :alt="emote.name" class="admin-pack__emote-img" />
                      <span class="admin-pack__emote-name">:{{ pack.name }}:{{ emote.name }}:</span>
                      <WinButton Style="SubtleButtonStyle" @click="deleteEmote(emote)">删除</WinButton>
                    </li>
                  </ul>
                  <p v-else class="field__hint">此包暂无表情</p>
                  <div class="admin-pack__add">
                    <input v-model="newEmoteName[pack.id]" type="text" maxlength="32" placeholder="新表情名称" />
                    <label class="admin-pack__upload-btn">
                      {{ emoteUploading[pack.id] ? '上传中…' : '选择图片并添加' }}
                      <input
                        type="file"
                        accept="image/*"
                        class="admin-pack__file-input"
                        :disabled="emoteUploading[pack.id]"
                        @change="onEmoteFileChange(pack, $event)"
                      />
                    </label>
                  </div>
                </div>
              </section>
            </div>

            <div v-else-if="tab === 'members'" class="admin-modal__body">
              <template v-if="auth.isAdmin.value">
                <p class="field__hint">
                  管理每个用户的服务器级用户组与全局封禁。仅服务器领主可任免服务器管理员；领主身份唯一且不可通过此处转移。
                </p>
                <p v-if="usersError" class="field__error">{{ usersError }}</p>
                <div class="field">
                  <label class="field__label" for="global-ban-expires-at">全局封禁自动解封时间（可选）</label>
                  <input id="global-ban-expires-at" v-model="globalBanExpiresAt" type="datetime-local" />
                  <p class="field__hint">留空为永久封禁；服务器管理员只能全局封禁普通账号。</p>
                </div>
                <ul v-if="users.length" class="user-list">
                  <li v-for="user in users" :key="user.localpart" class="user-row">
                    <div class="user-row__main">
                      <span class="user-row__name">{{ user.username }}</span>
                      <span class="user-row__role" :class="`user-row__role--${user.server_role}`">{{ user.server_role }}</span>
                      <span class="user-row__date">{{ new Date(user.created_at).toLocaleDateString() }}</span>
                      <div class="user-row__actions">
                        <WinButton
                          v-if="auth.isServerOwner.value && user.server_role === 'user'"
                          Style="SubtleButtonStyle"
                          :IsEnabled="!roleChangingLocalpart"
                          @click="setUserRole(user, 'admin')"
                        >
                          设为管理员
                        </WinButton>
                        <WinButton
                          v-else-if="auth.isServerOwner.value && user.server_role === 'admin'"
                          Style="SubtleButtonStyle"
                          :IsEnabled="!roleChangingLocalpart"
                          @click="setUserRole(user, 'user')"
                        >
                          撤销管理员
                        </WinButton>
                        <span v-else-if="user.server_role === 'owner'" class="field__hint">领主</span>
                        <WinButton
                          v-if="canGloballyBan(user)"
                          Style="AccentButtonStyle"
                          class="win-btn--danger"
                          :IsEnabled="!globalBanBusyActor"
                          @click="banGlobally(user)"
                        >
                          全局封禁
                        </WinButton>
                        <WinButton
                          Style="SubtleButtonStyle"
                          @click="openGroupPickerFor = openGroupPickerFor === user.localpart ? '' : user.localpart"
                        >
                          分组
                        </WinButton>
                      </div>
                    </div>
                    <div class="user-row__groups">
                      <span v-for="g in userGroups[user.localpart] ?? []" :key="g.id" class="group-badge">
                        <span class="group-badge__dot" :style="{ backgroundColor: g.color ?? 'var(--ctrl-fill-tertiary)' }" />
                        {{ g.name }}
                      </span>
                      <span v-if="!(userGroups[user.localpart] ?? []).length" class="field__hint">未分组</span>
                    </div>
                    <div v-if="openGroupPickerFor === user.localpart" class="user-row__group-picker">
                      <p v-if="!groups.length" class="field__hint">尚未创建任何服务器用户组</p>
                      <label v-for="g in groups" :key="g.id" class="user-row__group-checkbox">
                        <input
                          type="checkbox"
                          :checked="hasGroup(user.localpart, g.id)"
                          :disabled="groupTogglePending === `${user.localpart}:${g.id}`"
                          @change="toggleUserGroup(user.localpart, g, ($event.target as HTMLInputElement).checked)"
                        />
                        <span class="group-badge__dot" :style="{ backgroundColor: g.color ?? 'var(--ctrl-fill-tertiary)' }" />
                        {{ g.name }}
                      </label>
                    </div>
                  </li>
                </ul>
                <p v-else-if="!usersLoading" class="field__hint">暂无用户</p>
                <WinButton v-if="usersCursor" Style="DefaultButtonStyle" :IsEnabled="!usersLoading" @click="loadUsers(false)">
                  {{ usersLoading ? '加载中…' : '加载更多' }}
                </WinButton>
              </template>
              <p v-else class="field__hint">仅服务器管理员可查看与管理服务器成员</p>
            </div>

            <div v-else-if="tab === 'bans'" class="admin-modal__body">
              <template v-if="auth.isAdmin.value">
                <p class="field__hint">全局封禁会阻止账号访问整个服务器，不影响其他服务器；到期后自动解除。</p>
                <p v-if="globalBansError" class="field__error">{{ globalBansError }}</p>
                <p v-if="!globalBans.length && !globalBansError" class="field__hint">全局黑名单为空</p>
                <ul v-else class="user-list">
                  <li v-for="ban in globalBans" :key="ban.actor" class="user-row">
                    <div class="user-row__main">
                      <span class="user-row__name">@{{ ban.username ?? ban.actor.replace(/^@/, '').split(':')[0] }}</span>
                      <span class="field__hint">{{ formatExpiry(ban.expires_at) }}</span>
                      <div class="user-row__actions">
                        <WinButton
                          v-if="canGloballyUnban(ban)"
                          Style="SubtleButtonStyle"
                          :IsEnabled="!globalBanBusyActor"
                          @click="unbanGlobally(ban)"
                        >
                          解除全局封禁
                        </WinButton>
                      </div>
                    </div>
                  </li>
                </ul>
              </template>
              <p v-else class="field__hint">仅服务器管理员可查看全局黑名单</p>
            </div>

            <div v-else-if="tab === 'groups'" class="admin-modal__body">
              <div class="groups-toolbar">
                <WinButton Style="AccentButtonStyle" @click="openCreateGroup">建组</WinButton>
              </div>

              <div v-if="groupsLoading" class="admin-modal__loading">加载中…</div>
              <WinInfoBar v-else-if="groupsError" :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Error">
                {{ groupsError }}
              </WinInfoBar>
              <p v-else-if="!groups.length" class="field__hint">暂无用户组</p>

              <ul v-else class="group-list">
                <li v-for="(group, index) in groups" :key="group.id" class="group-row">
                  <span class="group-row__dot" :style="{ backgroundColor: group.color ?? 'var(--ctrl-fill-tertiary)' }" />
                  <span class="group-row__name">{{ group.name }}</span>
                  <span v-if="group.is_moderator" class="group-row__mod-badge">管理员组</span>
                  <div class="group-row__actions">
                    <WinButton Style="SubtleButtonStyle" :IsEnabled="index > 0" @click="moveGroup(index, -1)">上移</WinButton>
                    <WinButton Style="SubtleButtonStyle" :IsEnabled="index < groups.length - 1" @click="moveGroup(index, 1)">下移</WinButton>
                    <WinButton Style="SubtleButtonStyle" @click="openEditGroup(group)">编辑</WinButton>
                    <WinButton Style="AccentButtonStyle" class="win-btn--danger" @click="deleteGroupConfirm(group)">删除</WinButton>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <GroupEditorModal :open="groupEditorOpen" :group="editingGroup" @close="groupEditorOpen = false" @saved="onGroupSaved" />
  <ImageEditor :file="emoteEditorFile" :uploading="emoteEditorPack ? !!emoteUploading[emoteEditorPack.id] : false" @confirm="confirmEmote" @cancel="emoteEditorFile = null; emoteEditorPack = null" />
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
  gap: 1rem;
  padding: 1rem 1.25rem 1.5rem;
}

.admin-modal__loading {
  padding: 1rem 1.25rem;
  color: var(--text-tertiary);
  font-size: 0.85rem;
}

.admin-modal__save-ok {
  margin: 0;
  font-size: 0.8rem;
  color: var(--SystemFillColorSuccessBrush);
}

.admin-card {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 1.1rem 1.25rem;
  border-radius: var(--radius-md);
  background: var(--card-bg);
  border: 1px solid var(--card-stroke);
}

.admin-card__title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text-primary);
}

.policy-summary {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.35rem 1rem;
  font-size: 0.82rem;
}

.policy-summary dt {
  color: var(--text-tertiary);
}

.policy-summary dd {
  margin: 0;
  color: var(--text-primary);
  word-break: break-word;
}

.policy-form {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

.policy-form__switches,
.policy-form__limits,
.policy-form__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem 1rem;
}

.policy-form__limits > .field {
  flex: 1 1 220px;
}

.policy-form__fieldset {
  margin: 0;
  padding: 0;
  border: 0;
}

.policy-form__check {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0.35rem 1rem 0 0;
  color: var(--text-primary);
  font-size: 0.8rem;
}

.policy-form textarea,
.policy-form input[type='number'] {
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--ctrl-border);
  border-radius: var(--radius-xs);
  background: var(--ctrl-fill-secondary);
  color: var(--text-primary);
  font: inherit;
}

.policy-form textarea {
  resize: none;
}

.user-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.user-row {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.7rem;
  border-radius: var(--radius-xs);
  background: var(--ctrl-fill-secondary);
}

.user-row__main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
}

.user-row__name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
}

.user-row__role {
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  background: var(--ctrl-fill-tertiary);
  color: var(--text-secondary);
}

.user-row__role--owner {
  background: rgb(var(--colors-primary));
  color: var(--on-accent);
}

.user-row__role--admin {
  background: rgb(var(--colors-primary) / 0.16);
  color: rgb(var(--colors-primary));
}

.user-row__date {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

.user-row__actions {
  display: flex;
  gap: 0.35rem;
  margin-left: auto;
}

.user-row__groups {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
}

.user-row__group-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  padding: 0.5rem 0.6rem;
  border-radius: var(--radius-xs);
  background: var(--ctrl-fill-tertiary);
}

.user-row__group-checkbox {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.78rem;
  color: var(--text-primary);
  cursor: pointer;
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

.admin-applications__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.admin-applications__item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  padding: 0.6rem 0.75rem;
  border-radius: var(--radius-xs);
  background: var(--ctrl-fill-secondary);
}

.admin-applications__meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.admin-applications__name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
}

.admin-applications__actor {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

.admin-applications__desc {
  margin: 0.2rem 0 0;
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.admin-applications__actions {
  display: flex;
  gap: 0.4rem;
  flex: 0 0 auto;
}

.admin-invite__controls {
  display: flex;
  align-items: flex-end;
  gap: 0.75rem;
}

.admin-invite__count {
  max-width: 120px;
}

.admin-invite__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.admin-invite__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.45rem 0.6rem;
  border-radius: var(--radius-xs);
  background: var(--ctrl-fill-secondary);
  font-size: 0.82rem;
}

.admin-invite__status {
  color: var(--text-tertiary);
}

.admin-invite__status--used {
  color: var(--SystemFillColorCriticalBrush);
}

.admin-slug__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.admin-slug__item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.6rem;
  border-radius: var(--radius-xs);
  background: var(--ctrl-fill-secondary);
}

.admin-slug__name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-slug__avatar {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--card-stroke);
}

.admin-slug__value {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.admin-slug__edit {
  flex: 1 1 160px;
  min-width: 0;
  margin: 0;
}

.admin-pack__create {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.admin-pack__create input,
.admin-pack__add input {
  flex: 1 1 160px;
  min-width: 0;
  padding: 0.5rem 0.7rem;
  border-radius: var(--radius-xs);
  border: 1px solid var(--ctrl-border);
  background: var(--ctrl-fill-secondary);
  color: var(--text-primary);
  font: inherit;
}

.admin-pack {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--stroke-divider);
}

.admin-pack__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.admin-pack__name {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text-primary);
}

.admin-pack__emotes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.admin-pack__emote {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.5rem;
  border-radius: var(--radius-xs);
  background: var(--ctrl-fill-secondary);
}

.admin-pack__emote-img {
  width: 28px;
  height: 28px;
  object-fit: contain;
  flex: 0 0 auto;
}

.admin-pack__emote-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 0.78rem;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-pack__add {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}

.admin-pack__upload-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 0.5rem 0.9rem;
  border-radius: var(--radius-xs);
  background: var(--ctrl-fill-tertiary);
  color: var(--text-primary);
  font-size: 0.82rem;
  cursor: pointer;
}

.admin-pack__file-input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.groups-toolbar {
  display: flex;
  justify-content: flex-end;
}

.group-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.group-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.85rem;
  border-radius: var(--radius-sm);
  background: var(--card-bg);
  border: 1px solid var(--card-stroke);
}

.group-row__dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.group-row__name {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text-primary);
}

.group-row__mod-badge {
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: rgb(var(--colors-primary) / 0.16);
  color: rgb(var(--colors-primary));
  font-size: 0.68rem;
  font-weight: 600;
}

.group-row__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-left: auto;
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
