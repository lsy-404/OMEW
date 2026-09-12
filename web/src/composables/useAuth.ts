import type { AuthenticationResponseJSON } from '@simplewebauthn/browser'
import { computed, ref } from 'vue'
import { api } from '../api'
import { setUnauthorizedHandler } from '../api/client'
import type { AuthResponse, AuthUser, LoginPayload, RegisterPayload } from '../api/types'

const TOKEN_KEY = 'openmew-token'
const USER_KEY = 'openmew-user'

function readStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as AuthUser
  } catch {
    return null
  }
}

const token = ref<string | null>(localStorage.getItem(TOKEN_KEY))
const user = ref<AuthUser | null>(readStoredUser())
// set when a 401 kicks an existing session out, so the auth gate keeps the
// login tab for returning users instead of the fresh-visitor register default
const sessionExpired = ref(false)

function persist() {
  if (token.value && user.value) {
    localStorage.setItem(TOKEN_KEY, token.value)
    localStorage.setItem(USER_KEY, JSON.stringify(user.value))
  } else {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  }
}

function setSession(session: AuthResponse) {
  token.value = session.token
  user.value = session.user
  sessionExpired.value = false
  persist()
}

// returns the pending token when the account has TOTP enabled (caller shows
// the code-entry step next) instead of committing a session directly.
async function login(payload: LoginPayload): Promise<{ totp_required: true; pending: string } | void> {
  const result = await api.login(payload)
  if ('totp_required' in result) return result
  setSession(result)
}

async function loginTotp(pending: string, code: string) {
  const session = await api.loginTotp(pending, code)
  setSession(session)
}

async function loginPasskey(response: AuthenticationResponseJSON, challengeToken: string) {
  const session = await api.loginPasskey(response, challengeToken)
  setSession(session)
}

const ssoCompletionError = ref('')
let ssoCompletionInFlight: Promise<void> | null = null

async function completeOidcLogin(code: string) {
  const session = await api.completeOidcLogin(code)
  setSession(session)
}

async function completeOidcLoginFromLocation() {
  if (typeof window === 'undefined' || ssoCompletionInFlight) return ssoCompletionInFlight
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const code = params.get('sso_complete')
  if (!code || params.getAll('sso_complete').length !== 1 || code.length > 512) return

  history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  ssoCompletionError.value = ''
  ssoCompletionInFlight = completeOidcLogin(code)
    .catch(() => {
      ssoCompletionError.value = 'SSO 登录未完成，请重试。'
    })
    .finally(() => {
      ssoCompletionInFlight = null
    })
  return ssoCompletionInFlight
}

// register() intentionally does NOT commit the session by itself — the
// caller (registration form) shows the ownership-key backup step first and
// commits explicitly via setSession() once the user has seen it.
async function register(payload: RegisterPayload): Promise<AuthResponse> {
  return api.register(payload)
}

function logout() {
  token.value = null
  user.value = null
  persist()
}

// applies a local patch to the stored user (e.g. right after totp
// activate/disable, before any server response carries the field back) and
// persists it so it survives a reload.
function updateUser(patch: Partial<AuthUser>) {
  if (!user.value) return
  user.value = { ...user.value, ...patch }
  persist()
}

setUnauthorizedHandler(() => {
  sessionExpired.value = true
  logout()
})

export function useAuth() {
  return {
    token,
    user,
    isAuthenticated: computed(() => !!token.value),
    sessionExpired,
    ssoCompletionError,
    isAdmin: computed(() => !!user.value?.is_admin),
    // server_role owner is unique/non-transferable (m0-protocol §7.10) - gates
    // the server-member-appointment section, distinct from isAdmin (owner|admin).
    isServerOwner: computed(() => user.value?.server_role === 'owner'),
    login,
    loginTotp,
    loginPasskey,
    completeOidcLoginFromLocation,
    register,
    setSession,
    updateUser,
    logout,
  }
}
