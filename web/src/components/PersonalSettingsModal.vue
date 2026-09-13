<script setup lang="ts">
import { startRegistration } from '@simplewebauthn/browser'
import QRCode from 'qrcode'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { api, ApiRequestError } from '../api'
import type { Passkey, PersonalSettingsSection } from '../api/types'
import { useAuth } from '../composables/useAuth'
import { useGifPlayback, type GifPlaybackMode } from '../composables/useGifPlayback'
import { useInstanceConfig } from '../composables/useInstanceConfig'
import { useTheme, type ThemeMode } from '../composables/useTheme'
import { envelopeToCiphertextField, parseOwnershipEnvelope, resealOwnershipKey, unsealOwnershipKey } from '../crypto/ownershipKey'
import { passwordError, requiredError, requiredMaxLengthError } from '../utils/validate'
import { WinButton, WinInfoBar, WinSelectorBar } from '../vendor/winui'
import AppIcon from './icons/AppIcon.vue'
import PersonalAvatarUploader from './PersonalAvatarUploader.vue'
import PersonalCoverUploader from './PersonalCoverUploader.vue'

// account-scoped settings: 安全(改密含 §7.9a 所有权托管密文解封-重封、TOTP、passkey)与
// 外观(主题三态)归入同一悬浮窗。chrome 沿用 ServerAdminModal/StrongholdAdminModal 的
// PostModal 式浮窗模式。

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const auth = useAuth()
const { config: instanceConfig } = useInstanceConfig()
const { mode, setMode } = useTheme()
const { mode: gifPlaybackMode, setMode: setGifPlaybackMode } = useGifPlayback()

function requestClose() {
  emit('close')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.open) requestClose()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString()
}

// ---- top-level tabs: 资料 / 安全 / 外观 ----

type PanelTab = PersonalSettingsSection
const PANEL_TAB_DEFINITIONS: { Text: string; value: PanelTab }[] = [
  { Text: '资料', value: 'profile' },
  { Text: '安全', value: 'security' },
  { Text: '外观', value: 'appearance' },
]
const PANEL_TAB_OPTIONS = computed(() => {
  const enabled = new Set(instanceConfig.value?.personal_settings_sections ?? [])
  return PANEL_TAB_DEFINITIONS.filter((option) => enabled.has(option.value))
})
const panelTab = ref<PanelTab>('profile')
const panelTabSelected = computed(() => PANEL_TAB_OPTIONS.value.find((o) => o.value === panelTab.value))
function onPanelTabSelect(item: { value: PanelTab }) {
  if (PANEL_TAB_OPTIONS.value.some((option) => option.value === item.value)) panelTab.value = item.value
}

// ---- 资料: display name ----
// The username (and the actor derived from it) is fixed at registration; this
// only changes how the account is shown in member lists and message bylines.

const displayName = ref('')
const avatar = ref<string | null>(null)
const cover = ref<string | null>(null)
const bio = ref('')
const bioError = ref('')
const bioSaving = ref(false)
const bioSaved = ref(false)
const displayNameError = ref('')
const displayNameSaving = ref(false)
const displayNameSaved = ref(false)

// called from the on-open reset below, alongside the other tabs' resets
function resetDisplayNameForm() {
  // a session stored before display_name existed carries only the username,
  // which is also what the server seeds the display name with
  displayName.value = auth.user.value?.display_name || auth.user.value?.username || ''
  avatar.value = auth.user.value?.avatar ?? null
  cover.value = auth.user.value?.cover ?? null
  bio.value = auth.user.value?.bio ?? ''
  bioError.value = ''
  bioSaved.value = false
  displayNameError.value = ''
  displayNameSaved.value = false
}

async function submitBio() {
  if (!auth.token.value) return
  const trimmed = bio.value.trim()
  if ([...trimmed].length > 512) {
    bioError.value = '自我介绍最多 512 个字符'
    return
  }
  bioSaving.value = true
  bioSaved.value = false
  bioError.value = ''
  try {
    const result = await api.setBio(auth.token.value, bio.value)
    bio.value = result.bio ?? ''
    auth.updateUser({ bio: result.bio })
    bioSaved.value = true
  } catch {
    bioError.value = '保存失败，请稍后重试'
  } finally {
    bioSaving.value = false
  }
}

function onAvatarChange(nextAvatar: string | null) {
  avatar.value = nextAvatar
  auth.updateUser({ avatar: nextAvatar })
}
function onCoverChange(nextCover: string | null) {
  cover.value = nextCover
  auth.updateUser({ cover: nextCover })
}

function limitBio() {
  const characters = [...bio.value]
  if (characters.length > 512) bio.value = characters.slice(0, 512).join('')
}

async function submitDisplayName() {
  if (!auth.token.value) return
  displayNameError.value = requiredMaxLengthError(displayName.value, 32, '显示名称')
  if (displayNameError.value) return
  displayNameSaving.value = true
  displayNameSaved.value = false
  try {
    const { display_name } = await api.setDisplayName(auth.token.value, displayName.value)
    displayName.value = display_name
    auth.updateUser({ display_name })
    displayNameSaved.value = true
  } catch {
    displayNameError.value = '保存失败，请稍后重试'
  } finally {
    displayNameSaving.value = false
  }
}

// ---- appearance ----

const MODE_OPTIONS: { Text: string; value: ThemeMode }[] = [
  { Text: '跟随系统', value: 'system' },
  { Text: '亮色', value: 'light' },
  { Text: '暗色', value: 'dark' },
]
const modeSelected = computed(() => MODE_OPTIONS.find((o) => o.value === mode.value))
function onModeSelect(item: { value: ThemeMode }) {
  setMode(item.value)
}

const GIF_PLAYBACK_OPTIONS: { Text: string; value: GifPlaybackMode }[] = [
  { Text: '禁用 GIF', value: 'disabled' },
  { Text: '只播放一遍', value: 'once' },
  { Text: '正常', value: 'normal' },
]
const gifPlaybackSelected = computed(() => GIF_PLAYBACK_OPTIONS.find((option) => option.value === gifPlaybackMode.value))
function onGifPlaybackSelect(item: { value: GifPlaybackMode }) {
  setGifPlaybackMode(item.value)
}

// ---- 安全 sub-tabs: 修改密码 / 通行密钥 / 两步验证 ----

const supportsPasskeys = typeof window !== 'undefined' && !!window.PublicKeyCredential
type SecurityTab = 'password' | 'passkeys' | 'totp'
const securityTab = ref<SecurityTab>('password')
const SECURITY_TAB_OPTIONS = computed(() => {
  const opts: { Text: string; value: SecurityTab }[] = [{ Text: '修改密码', value: 'password' }]
  if (supportsPasskeys) opts.push({ Text: '通行密钥', value: 'passkeys' })
  opts.push({ Text: '两步验证', value: 'totp' })
  return opts
})
const securityTabSelected = computed(() => SECURITY_TAB_OPTIONS.value.find((o) => o.value === securityTab.value))
function onSecurityTabSelect(item: { value: SecurityTab }) {
  securityTab.value = item.value
}

// ---- 修改密码 ----

// m0-protocol §7.9a: when the custody passphrase defaults to the login
// password, a password change must re-wrap the custody ciphertext too, or the
// old password silently keeps unlocking it forever. Best-effort: fetch the
// envelope, try to unseal it with the old password, and if that works reseal
// under the new one and submit alongside the password change. Any failure
// along this path (fetch, parse, wrong-passphrase unseal) just means "this
// account uses an independent custody passphrase" - the ciphertext is left
// untouched and only the login password changes.
async function rewrapOwnershipCiphertext(token: string, oldPassword: string, newPassword: string): Promise<string | undefined> {
  try {
    const { ownership_ciphertext } = await api.getOwnership(token)
    if (!ownership_ciphertext) return undefined
    const envelope = parseOwnershipEnvelope(ownership_ciphertext)
    const secretKey = await unsealOwnershipKey(oldPassword, envelope)
    if (!secretKey) return undefined
    const resealed = await resealOwnershipKey(secretKey, newPassword)
    return envelopeToCiphertextField(resealed)
  } catch {
    return undefined
  }
}

const pwForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })
const pwError = ref('')
const pwSuccess = ref(false)
const pwBusy = ref(false)

function resetPasswordForm() {
  pwForm.oldPassword = ''
  pwForm.newPassword = ''
  pwForm.confirmPassword = ''
  pwError.value = ''
  pwSuccess.value = false
}

async function submitPasswordChange() {
  pwSuccess.value = false
  const errors = [requiredError(pwForm.oldPassword, '当前密码'), passwordError(pwForm.newPassword)].filter(Boolean)
  if (pwForm.newPassword !== pwForm.confirmPassword) errors.push('两次输入的新密码不一致')
  pwError.value = errors.join('；')
  if (pwError.value || !auth.token.value) return
  pwBusy.value = true
  try {
    const newOwnershipCiphertext = await rewrapOwnershipCiphertext(auth.token.value, pwForm.oldPassword, pwForm.newPassword)
    await api.changePassword(auth.token.value, {
      old_password: pwForm.oldPassword,
      new_password: pwForm.newPassword,
      ...(newOwnershipCiphertext ? { new_ownership_ciphertext: newOwnershipCiphertext } : {}),
    })
    pwSuccess.value = true
    pwForm.oldPassword = ''
    pwForm.newPassword = ''
    pwForm.confirmPassword = ''
  } catch (err) {
    pwError.value = err instanceof ApiRequestError && err.code === 'AUTH_FAILED' ? '当前密码不正确' : '修改失败，请稍后重试'
  } finally {
    pwBusy.value = false
  }
}

// ---- 通行密钥 ----

const passkeys = ref<Passkey[]>([])
const passkeysLoading = ref(false)
const passkeysError = ref('')

async function loadPasskeys() {
  if (!auth.token.value) return
  passkeysLoading.value = true
  passkeysError.value = ''
  try {
    passkeys.value = await api.listPasskeys(auth.token.value)
  } catch {
    passkeysError.value = '通行密钥列表加载失败'
  } finally {
    passkeysLoading.value = false
  }
}

const addingPasskey = ref(false)
const newPasskeyName = ref('')
const addPasskeyBusy = ref(false)
const addPasskeyError = ref('')

function startAddPasskey() {
  addingPasskey.value = true
  newPasskeyName.value = ''
  addPasskeyError.value = ''
}

function cancelAddPasskey() {
  addingPasskey.value = false
}

async function submitAddPasskey() {
  if (!auth.token.value || !newPasskeyName.value.trim()) {
    addPasskeyError.value = '请输入名称'
    return
  }
  addPasskeyBusy.value = true
  addPasskeyError.value = ''
  try {
    const { options, challenge_token } = await api.passkeyRegOptions(auth.token.value)
    const response = await startRegistration({ optionsJSON: options })
    const created = await api.registerPasskey(auth.token.value, response, challenge_token, newPasskeyName.value.trim())
    passkeys.value = [...passkeys.value, created]
    addingPasskey.value = false
  } catch (err) {
    addPasskeyError.value = err instanceof ApiRequestError && err.code === 'PASSKEY_ALREADY_REGISTERED'
      ? '该通行密钥已注册'
      : '添加失败，请重试'
  } finally {
    addPasskeyBusy.value = false
  }
}

const renamingId = ref<string | null>(null)
const renameValue = ref('')

function startRename(passkey: Passkey) {
  renamingId.value = passkey.id
  renameValue.value = passkey.name
}

async function submitRename(passkey: Passkey) {
  if (!auth.token.value || !renameValue.value.trim()) return
  try {
    const updated = await api.renamePasskey(auth.token.value, passkey.id, renameValue.value.trim())
    passkeys.value = passkeys.value.map((p) => (p.id === updated.id ? updated : p))
  } finally {
    renamingId.value = null
  }
}

async function deletePasskey(passkey: Passkey) {
  if (!auth.token.value) return
  if (!confirm(`确定删除通行密钥「${passkey.name}」？`)) return
  await api.deletePasskey(auth.token.value, passkey.id)
  passkeys.value = passkeys.value.filter((p) => p.id !== passkey.id)
}

// ---- 两步验证 TOTP ----

type TotpStep = 'status' | 'setup-scan' | 'setup-verify' | 'disable'
const totpStep = ref<TotpStep>('status')
const totpEnabled = computed(() => !!auth.user.value && auth.user.value.totp_enabled === true)

const totpSecret = ref('')
const totpQrDataUrl = ref('')
const totpCode = ref('')
const totpBusy = ref(false)
const totpError = ref('')

async function beginTotpSetup() {
  if (!auth.token.value) return
  totpBusy.value = true
  totpError.value = ''
  try {
    const { secret, otpauth_url } = await api.totpSetup(auth.token.value)
    totpSecret.value = secret
    totpQrDataUrl.value = await QRCode.toDataURL(otpauth_url)
    totpStep.value = 'setup-scan'
  } catch {
    totpError.value = '初始化失败，请重试'
  } finally {
    totpBusy.value = false
  }
}

function goToVerify() {
  totpCode.value = ''
  totpError.value = ''
  totpStep.value = 'setup-verify'
}

async function submitTotpActivate() {
  if (!auth.token.value) return
  totpBusy.value = true
  totpError.value = ''
  try {
    await api.totpActivate(auth.token.value, totpCode.value.trim())
    auth.updateUser({ totp_enabled: true })
    totpStep.value = 'status'
  } catch (err) {
    totpError.value = err instanceof ApiRequestError && err.code === 'TOTP_INVALID' ? '验证码不正确' : '激活失败，请重试'
  } finally {
    totpBusy.value = false
  }
}

const disableForm = reactive({ password: '', code: '' })

function beginTotpDisable() {
  disableForm.password = ''
  disableForm.code = ''
  totpError.value = ''
  totpStep.value = 'disable'
}

async function submitTotpDisable() {
  if (!auth.token.value) return
  totpBusy.value = true
  totpError.value = ''
  try {
    await api.totpDisable(auth.token.value, disableForm.password, disableForm.code.trim())
    auth.updateUser({ totp_enabled: false })
    totpStep.value = 'status'
  } catch (err) {
    totpError.value = err instanceof ApiRequestError && err.code === 'TOTP_INVALID' ? '验证码不正确' : '密码或验证码不正确'
  } finally {
    totpBusy.value = false
  }
}

function cancelTotpFlow() {
  totpStep.value = 'status'
  totpError.value = ''
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      panelTab.value = PANEL_TAB_OPTIONS.value[0]?.value ?? 'profile'
      resetDisplayNameForm()
      securityTab.value = 'password'
      resetPasswordForm()
      addingPasskey.value = false
      totpStep.value = 'status'
      if (PANEL_TAB_OPTIONS.value.some((option) => option.value === 'security')) void loadPasskeys()
    }
  },
)
watch(PANEL_TAB_OPTIONS, (options) => {
  if (props.open && !options.some((option) => option.value === panelTab.value)) {
    panelTab.value = options[0]?.value ?? 'profile'
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="personal-modal">
      <div v-if="open && PANEL_TAB_OPTIONS.length" class="personal-modal-overlay" @click.self="requestClose">
        <div class="personal-modal" role="dialog" aria-modal="true" aria-label="个人设置">
          <div class="personal-modal__header">
            <h1 class="personal-modal__title">个人设置</h1>
            <WinButton Style="SubtleButtonStyle" @click="requestClose">关闭</WinButton>
          </div>

          <WinSelectorBar
            class="personal-modal__tabs"
            :Items="PANEL_TAB_OPTIONS"
            :SelectedItem="panelTabSelected"
            @update:SelectedItem="onPanelTabSelect"
          />

          <div class="personal-modal__scroll">
            <div v-if="panelTab === 'profile'" class="personal-modal__body">
              <section class="settings-section">
                <div class="profile-avatar-field">
                  <span class="field__label">头像</span>
                  <PersonalAvatarUploader
                    v-if="auth.token.value"
                    :model-value="avatar"
                    :token="auth.token.value"
                    :seed="auth.user.value?.username ?? ''"
                    @update:model-value="onAvatarChange"
                  />
                </div>
                <div class="profile-cover-field">
                  <span class="field__label">个人封面</span>
                  <PersonalCoverUploader v-if="auth.token.value" :model-value="cover" :token="auth.token.value" @update:model-value="onCoverChange" />
                </div>
                <form class="profile-form" @submit.prevent="submitDisplayName">
                  <div class="field">
                    <label class="field__label" for="profile-display-name">显示名称</label>
                    <input id="profile-display-name" v-model="displayName" type="text" maxlength="32" />
                    <p class="field__hint">成员列表与消息署名显示这个名字。用户名 {{ auth.user.value?.username }} 不可更改。</p>
                  </div>
                  <WinInfoBar v-if="displayNameError" :IsOpen="true" :IsClosable="false" Severity="Error">
                    {{ displayNameError }}
                  </WinInfoBar>
                  <WinInfoBar v-else-if="displayNameSaved" :IsOpen="true" :IsClosable="false" Severity="Success">
                    已保存
                  </WinInfoBar>
                  <WinButton Style="AccentButtonStyle" :IsEnabled="!displayNameSaving" @click="submitDisplayName">
                    {{ displayNameSaving ? '保存中…' : '保存' }}
                  </WinButton>
                </form>
                <form class="profile-form" @submit.prevent="submitBio">
                  <div class="field">
                    <label class="field__label" for="profile-bio">自我介绍</label>
                    <textarea id="profile-bio" v-model="bio" rows="4" placeholder="介绍一下自己…" @input="limitBio" />
                    <p class="field__hint">{{ [...bio.trim()].length }}/512</p>
                  </div>
                  <WinInfoBar v-if="bioError" :IsOpen="true" :IsClosable="false" Severity="Error">{{ bioError }}</WinInfoBar>
                  <WinInfoBar v-else-if="bioSaved" :IsOpen="true" :IsClosable="false" Severity="Success">已保存</WinInfoBar>
                  <WinButton Style="AccentButtonStyle" :IsEnabled="!bioSaving" @click="submitBio">{{ bioSaving ? '保存中…' : '保存介绍' }}</WinButton>
                </form>
              </section>
            </div>

            <div v-else-if="panelTab === 'security'" class="personal-modal__body">
              <WinSelectorBar
                class="security-subtabs"
                :Items="SECURITY_TAB_OPTIONS"
                :SelectedItem="securityTabSelected"
                @update:SelectedItem="onSecurityTabSelect"
              />

              <!-- 修改密码 -->
              <section v-if="securityTab === 'password'" class="settings-section">
                <form class="password-form" @submit.prevent="submitPasswordChange">
                  <div class="field">
                    <label class="field__label" for="pw-old">当前密码</label>
                    <input id="pw-old" v-model="pwForm.oldPassword" type="password" autocomplete="current-password" required />
                  </div>
                  <div class="field">
                    <label class="field__label" for="pw-new">新密码</label>
                    <input id="pw-new" v-model="pwForm.newPassword" type="password" autocomplete="new-password" minlength="10" required />
                  </div>
                  <div class="field">
                    <label class="field__label" for="pw-confirm">确认新密码</label>
                    <input
                      id="pw-confirm"
                      v-model="pwForm.confirmPassword"
                      type="password"
                      autocomplete="new-password"
                      minlength="10"
                      required
                    />
                  </div>
                  <WinInfoBar v-if="pwError" :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Error">
                    {{ pwError }}
                  </WinInfoBar>
                  <WinInfoBar v-if="pwSuccess" :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Success">
                    密码已更新
                  </WinInfoBar>
                  <WinButton Style="AccentButtonStyle" class="password-form__submit" type="submit" :IsEnabled="!pwBusy">
                    {{ pwBusy ? '提交中…' : '确认修改' }}
                  </WinButton>
                </form>
              </section>

              <!-- 通行密钥 -->
              <section v-else-if="securityTab === 'passkeys'" class="settings-section">
                <p class="settings-section__hint">
                  通行密钥使用设备本地认证器（指纹、面容或安全密钥）免密登录，仅对本节点生效。
                </p>
                <WinInfoBar v-if="passkeysError" :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Error">
                  {{ passkeysError }}
                </WinInfoBar>

                <div v-if="passkeysLoading" class="settings-section__loading">加载中…</div>
                <ul v-else-if="passkeys.length" class="passkey-list">
                  <li v-for="pk in passkeys" :key="pk.id" class="passkey-list__item">
                    <AppIcon name="key" :size="18" class="passkey-list__icon" />
                    <div class="passkey-list__body">
                      <template v-if="renamingId === pk.id">
                        <input
                          v-model="renameValue"
                          class="passkey-list__rename-input"
                          type="text"
                          maxlength="40"
                          @keyup.enter="submitRename(pk)"
                          @keyup.escape="renamingId = null"
                        />
                      </template>
                      <template v-else>
                        <span class="passkey-list__name">{{ pk.name }}</span>
                        <span class="passkey-list__meta">添加于 {{ formatDate(pk.created_at) }}</span>
                      </template>
                    </div>
                    <div class="passkey-list__actions">
                      <template v-if="renamingId === pk.id">
                        <WinButton Style="SubtleButtonStyle" @click="submitRename(pk)">保存</WinButton>
                        <WinButton Style="SubtleButtonStyle" @click="renamingId = null">取消</WinButton>
                      </template>
                      <template v-else>
                        <WinButton Style="SubtleButtonStyle" @click="startRename(pk)">重命名</WinButton>
                        <WinButton Style="SubtleButtonStyle" title="删除通行密钥" aria-label="删除通行密钥" @click="deletePasskey(pk)">
                          <AppIcon name="delete" :size="15" />
                        </WinButton>
                      </template>
                    </div>
                  </li>
                </ul>
                <p v-else class="settings-section__empty">还没有添加任何通行密钥</p>

                <div v-if="addingPasskey" class="passkey-add-form">
                  <input
                    v-model="newPasskeyName"
                    class="passkey-add-form__input"
                    type="text"
                    maxlength="40"
                    placeholder="给这个通行密钥起个名字，例如「我的笔记本」"
                    @keyup.enter="submitAddPasskey"
                  />
                  <p v-if="addPasskeyError" class="field__error">{{ addPasskeyError }}</p>
                  <div class="passkey-add-form__actions">
                    <WinButton Style="AccentButtonStyle" :IsEnabled="!addPasskeyBusy" @click="submitAddPasskey">
                      {{ addPasskeyBusy ? '等待设备确认…' : '开始注册' }}
                    </WinButton>
                    <WinButton Style="SubtleButtonStyle" @click="cancelAddPasskey">取消</WinButton>
                  </div>
                </div>
                <WinButton v-else Style="DefaultButtonStyle" @click="startAddPasskey">添加通行密钥</WinButton>
              </section>

              <!-- 两步验证 -->
              <section v-else class="settings-section">
                <template v-if="totpStep === 'status'">
                  <p class="settings-section__hint">
                    启用两步验证后，使用密码登录时需额外输入验证器 App 生成的 6 位一次性验证码。
                  </p>
                  <WinInfoBar :IsOpen="true" :IsClosable="false" :IsIconVisible="false" :Severity="totpEnabled ? 'Success' : 'Informational'">
                    {{ totpEnabled ? '两步验证已启用' : '两步验证未启用' }}
                  </WinInfoBar>
                  <WinButton v-if="!totpEnabled" Style="AccentButtonStyle" :IsEnabled="!totpBusy" @click="beginTotpSetup">
                    {{ totpBusy ? '准备中…' : '启用两步验证' }}
                  </WinButton>
                  <WinButton v-else Style="DefaultButtonStyle" @click="beginTotpDisable">禁用两步验证</WinButton>
                  <p v-if="totpError" class="field__error">{{ totpError }}</p>
                </template>

                <template v-else-if="totpStep === 'setup-scan'">
                  <p class="settings-section__hint">用验证器 App 扫描下方二维码，或手动输入密钥。</p>
                  <img v-if="totpQrDataUrl" :src="totpQrDataUrl" alt="TOTP 二维码" class="totp-qr" />
                  <p class="totp-secret">{{ totpSecret }}</p>
                  <div class="passkey-add-form__actions">
                    <WinButton Style="AccentButtonStyle" @click="goToVerify">下一步</WinButton>
                    <WinButton Style="SubtleButtonStyle" @click="cancelTotpFlow">取消</WinButton>
                  </div>
                </template>

                <template v-else-if="totpStep === 'setup-verify'">
                  <p class="settings-section__hint">输入验证器 App 当前显示的 6 位验证码以完成激活。</p>
                  <div class="field">
                    <label class="field__label" for="totp-activate-code">验证码</label>
                    <input
                      id="totp-activate-code"
                      v-model="totpCode"
                      type="text"
                      inputmode="numeric"
                      pattern="[0-9]{6}"
                      maxlength="6"
                      autocomplete="one-time-code"
                      @keyup.enter="submitTotpActivate"
                    />
                  </div>
                  <p v-if="totpError" class="field__error">{{ totpError }}</p>
                  <div class="passkey-add-form__actions">
                    <WinButton Style="AccentButtonStyle" :IsEnabled="!totpBusy" @click="submitTotpActivate">
                      {{ totpBusy ? '验证中…' : '确认激活' }}
                    </WinButton>
                    <WinButton Style="SubtleButtonStyle" @click="cancelTotpFlow">取消</WinButton>
                  </div>
                </template>

                <template v-else-if="totpStep === 'disable'">
                  <p class="settings-section__hint">输入当前密码与验证码以禁用两步验证。</p>
                  <div class="field">
                    <label class="field__label" for="totp-disable-password">当前密码</label>
                    <input id="totp-disable-password" v-model="disableForm.password" type="password" autocomplete="current-password" />
                  </div>
                  <div class="field">
                    <label class="field__label" for="totp-disable-code">验证码</label>
                    <input
                      id="totp-disable-code"
                      v-model="disableForm.code"
                      type="text"
                      inputmode="numeric"
                      pattern="[0-9]{6}"
                      maxlength="6"
                      autocomplete="one-time-code"
                    />
                  </div>
                  <p v-if="totpError" class="field__error">{{ totpError }}</p>
                  <div class="passkey-add-form__actions">
                    <WinButton Style="AccentButtonStyle" :IsEnabled="!totpBusy" @click="submitTotpDisable">
                      {{ totpBusy ? '提交中…' : '确认禁用' }}
                    </WinButton>
                    <WinButton Style="SubtleButtonStyle" @click="cancelTotpFlow">取消</WinButton>
                  </div>
                </template>
              </section>
            </div>

            <div v-else class="personal-modal__body">
              <section class="settings-section">
                <div class="appearance-setting">
                  <h3 id="appearance-theme" class="appearance-setting__title">主题</h3>
                  <p class="settings-section__hint">选择跟随系统外观，或固定使用亮色 / 暗色。</p>
                  <WinSelectorBar
                    aria-labelledby="appearance-theme"
                    :Items="MODE_OPTIONS"
                    :SelectedItem="modeSelected"
                    @update:SelectedItem="onModeSelect"
                  />
                </div>
                <div class="appearance-setting">
                  <h3 id="appearance-gif" class="appearance-setting__title">GIF 动画</h3>
                  <p class="settings-section__hint">禁用时仅显示第一帧；也可只播放一遍，或按图片原设定正常播放。</p>
                  <WinSelectorBar
                    aria-labelledby="appearance-gif"
                    :Items="GIF_PLAYBACK_OPTIONS"
                    :SelectedItem="gifPlaybackSelected"
                    @update:SelectedItem="onGifPlaybackSelect"
                  />
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.personal-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: var(--overlay-scrim);
}

.personal-modal {
  position: relative;
  width: 100%;
  max-width: 460px;
  height: 70vh;
  max-height: 620px;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-md);
  background: var(--dialog-background);
  border: 1px solid var(--card-stroke);
  box-shadow: var(--shadow-dialog);
  overflow: hidden;
}

.personal-modal-enter-active,
.personal-modal-leave-active {
  transition: opacity var(--normal-duration) var(--fast-out-slow-in);
}

.personal-modal-enter-active .personal-modal,
.personal-modal-leave-active .personal-modal {
  transition:
    opacity var(--normal-duration) var(--fast-out-slow-in),
    transform var(--normal-duration) var(--fast-out-slow-in);
}

.personal-modal-enter-from,
.personal-modal-leave-to {
  opacity: 0;
}

.personal-modal-enter-from .personal-modal,
.personal-modal-leave-to .personal-modal {
  opacity: 0;
  transform: scale(0.94) translateY(12px);
}

@media (prefers-reduced-motion: reduce) {
  .personal-modal-enter-active,
  .personal-modal-leave-active,
  .personal-modal-enter-active .personal-modal,
  .personal-modal-leave-active .personal-modal {
    transition: none !important;
  }
}

.personal-modal__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 1.1rem 1.25rem 0;
}

.personal-modal__title {
  margin: 0;
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--text-primary);
}

.personal-modal__tabs {
  flex: 0 0 auto;
  margin: 0.9rem 1.25rem 0;
  padding: 0.25rem;
  border-radius: var(--radius-sm);
  background: var(--ctrl-fill-secondary);
}

.personal-modal__scroll {
  flex: 1 1 auto;
  overflow-y: auto;
}

.personal-modal__body {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 1rem 1.25rem 1.5rem;
}

.security-subtabs {
  align-self: flex-start;
  margin-bottom: 0.2rem;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.settings-section__hint {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.settings-section__loading,
.settings-section__empty {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-tertiary);
}

.appearance-setting {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding-bottom: 0.85rem;
  border-bottom: 1px solid var(--divider-stroke);
}

.appearance-setting:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}

.appearance-setting__title {
  margin: 0;
  color: var(--text-primary);
  font-size: 0.92rem;
  font-weight: 600;
}

.profile-form,
.password-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.profile-avatar-field {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.profile-cover-field {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.profile-form :deep(.win-button) {
  align-self: flex-start;
}

.password-form__submit {
  width: 100%;
  justify-content: center;
  margin-top: 0.15rem;
}

.passkey-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.passkey-list__item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 0.65rem;
  border-radius: var(--radius-sm);
  background: var(--ctrl-fill-secondary);
}

.passkey-list__icon {
  flex: 0 0 auto;
  color: var(--text-secondary);
}

.passkey-list__body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.passkey-list__name {
  font-size: 0.86rem;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.passkey-list__meta {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

.passkey-list__rename-input {
  width: 100%;
}

.passkey-list__actions {
  flex: 0 0 auto;
  display: flex;
  gap: 0.25rem;
}

.passkey-add-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.passkey-add-form__actions {
  display: flex;
  gap: 0.5rem;
}

.totp-qr {
  width: 180px;
  height: 180px;
  align-self: center;
  border-radius: var(--radius-sm);
  background: rgb(var(--surface-fixed-light));
  padding: 0.5rem;
}

.totp-secret {
  align-self: center;
  font-family: ui-monospace, monospace;
  font-size: 0.85rem;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  word-break: break-all;
}

@media (max-width: 768px) {
  .personal-modal-overlay {
    padding: 0;
  }

  .personal-modal {
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    border-radius: 0;
    background: var(--dialog-background);
  }
}
</style>
