<script setup lang="ts">
import { startAuthentication } from '@simplewebauthn/browser'
import { computed, reactive, ref, watch } from 'vue'
import { api, ApiRequestError } from '../api'
import type { AuthResponse, RootRequirement } from '../api/types'
import { useAuth } from '../composables/useAuth'
import { useInstanceConfig } from '../composables/useInstanceConfig'
import {
  downloadOwnershipBackup,
  envelopeToCiphertextField,
  generateOwnershipKey,
  type OwnershipEnvelope,
} from '../crypto/ownershipKey'
import { emailError, passwordError, requiredError, usernameError } from '../utils/validate'
import { WinButton, WinInfoBar, WinSelectorBar } from '../vendor/winui'

// The login/register form body is shared by AuthGate's full-screen gate and
// AuthModal's popup shell - hosts own the surrounding chrome
// (card border vs. modal panel), this only owns the form itself.

const auth = useAuth()
const { config: instanceConfig, loading: configLoading, error: configError } = useInstanceConfig()
const ssoRequired = computed(() => instanceConfig.value?.sso_mode === 'required')
const ssoAvailable = computed(() => instanceConfig.value?.sso_mode !== 'disabled' && instanceConfig.value?.sso_enabled === true)
const ssoBusy = ref(false)
const ssoError = ref('')

function startSso() {
  if (ssoBusy.value || !ssoAvailable.value) return
  ssoBusy.value = true
  ssoError.value = ''
  const returnTo = `${window.location.pathname}${window.location.search}`
  window.location.assign(`/api/auth/oidc/start?return_to=${encodeURIComponent(returnTo)}`)
}

type Tab = 'login' | 'register'
const tab = ref<Tab>('login')
const TAB_OPTIONS: { Text: string; value: Tab }[] = [
  { Text: '登录', value: 'login' },
  { Text: '注册', value: 'register' },
]
const tabSelected = computed(() => TAB_OPTIONS.find((o) => o.value === tab.value))
function onTabSelect(item: { value: Tab }) {
  tab.value = item.value
}

// a fresh visitor lands on the register tab when the instance takes open
// signups - a session that got kicked back here by a 401 stays on login.
// Runs once config is available, whether that's immediately (already cached
// by another consumer) or after the shared fetch resolves.
watch(
  instanceConfig,
  (cfg) => {
    if (cfg?.sso_mode === 'required') tab.value = 'login'
    else if (cfg?.allow_root && !auth.sessionExpired.value) tab.value = 'register'
  },
  { immediate: true },
)

function needs(req: RootRequirement) {
  return instanceConfig.value?.root_requirements.includes(req) ?? false
}

const loginForm = reactive({ username: '', password: '' })
const loginError = ref('')
const loginBusy = ref(false)

// two-step login: a successful password check on a TOTP-enabled account
// returns a pending token instead of a session - this only reveals the code
// step once that happens, per the progressive-disclosure writing rule.
const totpPending = ref<string | null>(null)
const totpCode = ref('')

async function submitLogin() {
  if (loginBusy.value) return
  loginError.value = [requiredError(loginForm.username, '用户名'), requiredError(loginForm.password, '密码')]
    .filter(Boolean)
    .join('；')
  if (loginError.value) return
  loginBusy.value = true
  try {
    const result = await auth.login({ username: loginForm.username, password: loginForm.password })
    if (result) {
      totpPending.value = result.pending
      totpCode.value = ''
    }
  } catch (err) {
    loginError.value =
      err instanceof ApiRequestError && err.code === 'AUTH_FAILED' ? '用户名或密码错误' : '登录失败，请稍后重试'
  } finally {
    loginBusy.value = false
  }
}

async function submitTotpLogin() {
  if (loginBusy.value || !totpPending.value) return
  loginError.value = requiredError(totpCode.value, '验证码')
  if (loginError.value) return
  loginBusy.value = true
  try {
    await auth.loginTotp(totpPending.value, totpCode.value.trim())
  } catch (err) {
    if (err instanceof ApiRequestError && err.code === 'TOTP_INVALID') {
      loginError.value = '验证码不正确'
    } else {
      // AUTH_FAILED here means the pending token itself was rejected (expired
      // or otherwise invalid, not a wrong code) - the code step can't recover
      // from that, so fall back to the password step automatically instead of
      // leaving the user stuck until they notice and click 返回.
      totpPending.value = null
      totpCode.value = ''
      loginError.value = '登录已超时，请重新输入密码'
    }
  } finally {
    loginBusy.value = false
  }
}

function cancelTotpLogin() {
  totpPending.value = null
  totpCode.value = ''
  loginError.value = ''
}

// ---- passkey login (independent, password-free) -------------------------

const supportsPasskeys = typeof window !== 'undefined' && !!window.PublicKeyCredential
const passkeyBusy = ref(false)
const passkeyError = ref('')

async function loginWithPasskey() {
  if (passkeyBusy.value) return
  passkeyError.value = ''
  passkeyBusy.value = true
  try {
    const { options, challenge_token } = await api.passkeyLoginOptions()
    const response = await startAuthentication({ optionsJSON: options })
    await auth.loginPasskey(response, challenge_token)
  } catch (err) {
    if (err instanceof ApiRequestError) passkeyError.value = '通行密钥登录失败'
    // a cancelled/failed browser ceremony throws a DOMException - silently
    // drop it, matching how the password form doesn't complain about a
    // simply-abandoned attempt.
  } finally {
    passkeyBusy.value = false
  }
}

const registerForm = reactive({
  username: '',
  password: '',
  email: '',
  code: '',
})
const registerError = ref('')
const registerBusy = ref(false)
const pendingBackup = ref<{ session: AuthResponse; pubkeyBase64: string; envelope: OwnershipEnvelope } | null>(null)

// exposed so a modal host can warn before discarding an unexported backup
defineExpose({ hasPendingBackup: computed(() => pendingBackup.value != null) })

// live per-keystroke feedback for username format - only surfaced once the
// user has actually typed something, so a fresh empty field stays quiet
const liveUsernameError = computed(() => (registerForm.username ? usernameError(registerForm.username) : ''))

function registerErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'REGISTRATION_DISABLED':
        return '本节点当前未开放注册'
      case 'INVITE_INVALID':
        return '邀请码无效或已被使用'
      case 'PHONE_UNSUPPORTED':
        return '本实例暂不支持手机注册'
      case 'USERNAME_INVALID':
        return '用户名不可用，请更换后重试'
      case 'USERNAME_RESERVED':
        return '该用户名为系统保留，请换一个'
      default:
        return '注册失败，请稍后重试'
    }
  }
  return '注册失败，请稍后重试'
}

async function submitRegister() {
  if (registerBusy.value) return
  const errors = [
    usernameError(registerForm.username),
    passwordError(registerForm.password),
    needs('email') ? emailError(registerForm.email) : '',
    needs('code') ? requiredError(registerForm.code, '邀请码') : '',
  ].filter(Boolean)
  registerError.value = errors.join('；')
  if (registerError.value) return
  registerBusy.value = true
  try {
    const { pubkeyBase64, envelope } = await generateOwnershipKey(registerForm.password)
    const session = await auth.register({
      username: registerForm.username,
      password: registerForm.password,
      email: needs('email') ? registerForm.email : undefined,
      code: needs('code') ? registerForm.code : undefined,
      ownership_pubkey: pubkeyBase64,
      ownership_ciphertext: envelopeToCiphertextField(envelope),
    })
    pendingBackup.value = { session, pubkeyBase64, envelope }
  } catch (err) {
    registerError.value = registerErrorMessage(err)
  } finally {
    registerBusy.value = false
  }
}

function exportBackup() {
  if (!pendingBackup.value) return
  downloadOwnershipBackup(pendingBackup.value.pubkeyBase64, pendingBackup.value.envelope, pendingBackup.value.session.user.username)
}

function finishRegistration() {
  if (!pendingBackup.value) return
  auth.setSession(pendingBackup.value.session)
}

watch(
  () => auth.ssoCompletionError.value,
  (error) => {
    if (error) ssoError.value = error
  },
  { immediate: true },
)
</script>

<template>
  <h1 class="auth-card__title">OpenMew</h1>

  <div v-if="configLoading" class="auth-card__loading">正在获取节点信息…</div>

  <template v-else>
    <WinInfoBar v-if="configError" :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Error">
      {{ configError }}
    </WinInfoBar>

    <WinSelectorBar
      v-if="instanceConfig?.allow_root && !ssoRequired"
      class="auth-card__tabs"
      :Items="TAB_OPTIONS"
      :SelectedItem="tabSelected"
      @update:SelectedItem="onTabSelect"
    />

    <template v-if="tab === 'login'">
      <template v-if="ssoRequired">
        <p class="field__hint">本节点仅允许使用统一身份登录。</p>
        <WinButton
          Style="AccentButtonStyle"
          class="auth-form__submit"
          type="button"
          :IsEnabled="ssoAvailable && !ssoBusy"
          @click="startSso"
        >
          {{ ssoBusy ? '正在跳转…' : `使用 ${instanceConfig?.sso_provider_name || 'SSO'} 登录` }}
        </WinButton>
        <WinInfoBar v-if="!ssoAvailable" :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Error">
          管理员尚未完成 SSO 配置。
        </WinInfoBar>
        <p v-if="ssoError" class="field__error">{{ ssoError }}</p>
      </template>

      <template v-else>
      <form v-if="!totpPending" class="auth-form" novalidate @submit.prevent="submitLogin">
        <div class="field">
          <label class="field__label" for="login-username">用户名</label>
          <input id="login-username" v-model.trim="loginForm.username" type="text" autocomplete="username" />
        </div>
        <div class="field">
          <label class="field__label" for="login-password">密码</label>
          <input id="login-password" v-model="loginForm.password" type="password" autocomplete="current-password" />
        </div>
        <p v-if="loginError" class="field__error">{{ loginError }}</p>
        <WinButton Style="AccentButtonStyle" class="auth-form__submit" type="submit" :IsEnabled="!loginBusy">
          {{ loginBusy ? '登录中…' : '登录' }}
        </WinButton>

        <template v-if="supportsPasskeys">
          <div class="auth-form__divider">或</div>
          <WinButton
            Style="DefaultButtonStyle"
            class="auth-form__submit"
            type="button"
            :IsEnabled="!passkeyBusy"
            @click="loginWithPasskey"
          >
            {{ passkeyBusy ? '等待设备确认…' : '使用通行密钥登录' }}
          </WinButton>
          <p v-if="passkeyError" class="field__error">{{ passkeyError }}</p>
        </template>
      </form>

      <form v-else class="auth-form" novalidate @submit.prevent="submitTotpLogin">
        <p class="field__hint">该账号已启用两步验证，请输入验证器 App 当前显示的 6 位验证码。</p>
        <div class="field">
          <label class="field__label" for="login-totp-code">验证码</label>
          <input
            id="login-totp-code"
            v-model="totpCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            autocomplete="one-time-code"
            autofocus
          />
        </div>
        <p v-if="loginError" class="field__error">{{ loginError }}</p>
        <WinButton Style="AccentButtonStyle" class="auth-form__submit" type="submit" :IsEnabled="!loginBusy">
          {{ loginBusy ? '验证中…' : '验证并登录' }}
        </WinButton>
        <WinButton Style="SubtleButtonStyle" class="auth-form__submit" type="button" @click="cancelTotpLogin">返回</WinButton>
      </form>

      <template v-if="ssoAvailable">
        <div class="auth-form__divider">或</div>
        <WinButton
          Style="DefaultButtonStyle"
          class="auth-form__submit"
          type="button"
          :IsEnabled="!ssoBusy"
          @click="startSso"
        >
          {{ ssoBusy ? '正在跳转…' : `使用 ${instanceConfig?.sso_provider_name || 'SSO'} 登录` }}
        </WinButton>
        <p v-if="ssoError" class="field__error">{{ ssoError }}</p>
      </template>
      </template>
    </template>

    <template v-else>
      <div v-if="pendingBackup" class="auth-form">
        <WinInfoBar :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Success">
          注册成功。请务必导出并妥善保管所有权密钥备份——导出内容含你的加密私钥，是账号迁移的唯一凭证，服务器不会保存明文私钥。
        </WinInfoBar>
        <WinButton Style="DefaultButtonStyle" @click="exportBackup">导出所有权密钥备份</WinButton>
        <WinButton Style="AccentButtonStyle" class="auth-form__submit" @click="finishRegistration">
          进入 OpenMew
        </WinButton>
      </div>

      <form v-else class="auth-form" novalidate @submit.prevent="submitRegister">
        <div class="field">
          <label class="field__label" for="register-username">用户名</label>
          <input id="register-username" v-model.trim="registerForm.username" type="text" autocomplete="username" maxlength="32" />
          <p v-if="liveUsernameError" class="field__error">{{ liveUsernameError }}</p>
        </div>
        <div class="field">
          <label class="field__label" for="register-password">密码</label>
          <input id="register-password" v-model="registerForm.password" type="password" autocomplete="new-password" />
        </div>
        <div v-if="needs('email')" class="field">
          <label class="field__label" for="register-email">邮箱</label>
          <input id="register-email" v-model.trim="registerForm.email" type="email" autocomplete="email" />
        </div>
        <WinInfoBar v-if="needs('phone')" :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Warning">
          本实例暂不支持手机注册
        </WinInfoBar>
        <div v-if="needs('code')" class="field">
          <label class="field__label" for="register-code">邀请码</label>
          <input id="register-code" v-model.trim="registerForm.code" type="text" />
        </div>

        <p class="field__hint">
          账号所有权密钥将使用登录密码托管加密，无需单独设置。
        </p>

        <p v-if="registerError" class="field__error">{{ registerError }}</p>
        <WinButton Style="AccentButtonStyle" class="auth-form__submit" type="submit" :IsEnabled="!registerBusy">
          {{ registerBusy ? '注册中…' : '注册' }}
        </WinButton>
      </form>
    </template>

    <WinInfoBar v-if="instanceConfig && !instanceConfig.allow_root" :IsOpen="true" :IsClosable="false" :IsIconVisible="false" Severity="Informational">
      本节点不开放注册。如需账号，请联系节点管理员。
    </WinInfoBar>
  </template>
</template>

<style scoped>
.auth-card__title {
  margin: 0;
  text-align: center;
  font-size: 1.3rem;
  font-weight: 700;
  color: var(--text-primary);
}

.auth-card__loading {
  text-align: center;
  font-size: 0.85rem;
  color: var(--text-tertiary);
}

.auth-card__tabs {
  padding: 0.25rem;
  border-radius: var(--radius-sm);
  background: var(--ctrl-fill-secondary);
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.auth-form__submit {
  width: 100%;
  justify-content: center;
  margin-top: 0.15rem;
}

.auth-form__divider {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.75rem;
  color: var(--text-tertiary);
}

.auth-form__divider::before,
.auth-form__divider::after {
  content: '';
  flex: 1 1 auto;
  height: 1px;
  background: var(--stroke-divider);
}

</style>
