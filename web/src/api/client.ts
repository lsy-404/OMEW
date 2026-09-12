import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/browser'
import { ApiRequestError } from './errors'
import type {
  AdminInstanceConfig,
  AdminInstanceConfigPatch,
  AdminUsersPage,
  AvatarUploadResult,
  AuthResponse,
  BanEntry,
  ChangePasswordPayload,
  CoverUploadResult,
  CreateRoomPayload,
  CreateStrongholdPayload,
  DirectoryEntry,
  DirectMessage,
  EditRetractResult,
  Emote,
  EmotePack,
  FeatureRestrictionMode,
  FeatureRestrictions,
  InstanceConfig,
  InviteCode,
  LoginPayload,
  MediaUploadResult,
  MemberGroupRef,
  MemberPage,
  MemberPatch,
  MemberTab,
  OwnershipResponse,
  Passkey,
  PasskeyAuthOptions,
  PasskeyRegistrationOptions,
  PostPage,
  PostThread,
  PublicUser,
  RegisterPayload,
  RoomPatch,
  RoomSummary,
  RoomTokenResponse,
  ServerGroup,
  ServerGroupCreatePayload,
  ServerGroupPatch,
  ServerRole,
  StorageUsage,
  StrongholdApplication,
  StrongholdApplicationState,
  StrongholdConfig,
  StrongholdConfigPatch,
  StrongholdMember,
  StrongholdSummary,
  TotpLoginResult,
  TotpSetupResponse,
} from './types'

// production always talks same-origin (the worker serves both /api and the
// built static assets, see server/wrangler.jsonc's `assets` block). Local dev
// normally reaches the backend through vite's server.proxy on the same
// origin too; VITE_API_BASE is only needed when the dev server and
// `wrangler dev` aren't reachable from each other on the same origin (split
// local ports without a working proxy in front) - empty string is the
// default and means "same origin".
export const API_BASE = import.meta.env.VITE_API_BASE ?? ''

// deny is a bitmask on the wire (types.ts DENY_CHANNEL_SPEAK=1 / DENY_SECTION_POST=2 /
// DENY_SECTION_REPLY=4 on the server); the UI works with three named booleans instead.
const DENY_DISCUSSION_BIT = 1
const DENY_IDEA_BIT = 2
const DENY_COMMENT_BIT = 4

function actorLocalpart(actor: string): string {
  return actor.replace(/^@/, '').split(':')[0] ?? actor
}

function denyToBooleans(deny: number): Pick<StrongholdMember, 'deny_discussion' | 'deny_idea' | 'deny_comment'> {
  return {
    deny_discussion: (deny & DENY_DISCUSSION_BIT) !== 0,
    deny_idea: (deny & DENY_IDEA_BIT) !== 0,
    deny_comment: (deny & DENY_COMMENT_BIT) !== 0,
  }
}

function booleansToDeny(patch: MemberPatch): number | undefined {
  if (patch.deny_discussion === undefined && patch.deny_idea === undefined && patch.deny_comment === undefined) {
    return undefined
  }
  let deny = 0
  if (patch.deny_discussion) deny |= DENY_DISCUSSION_BIT
  if (patch.deny_idea) deny |= DENY_IDEA_BIT
  if (patch.deny_comment) deny |= DENY_COMMENT_BIT
  return deny
}

interface WireMemberEntry {
  actor: string
  display_name: string
  avatar: string | null
  role: StrongholdMember['role']
  deny: number
  joined_at: number
  last_active_at: number | null
  is_guest: boolean
  home_domain?: string
}

interface WireBanEntry {
  actor: string
  operator: string
  banned_at: number
  expires_at: number | null
}

function toBanEntry(entry: WireBanEntry): BanEntry {
  return {
    actor: entry.actor,
    banned_by: entry.operator,
    banned_at: new Date(entry.banned_at).toISOString(),
    expires_at: entry.expires_at == null ? null : new Date(entry.expires_at).toISOString(),
  }
}

interface WireFeatureRestrictionState {
  owner: { paused: boolean; expires_at: number | null }
  server: { mode: FeatureRestrictionMode; expires_at: number | null }
  effective: { paused: boolean; source: 'none' | 'owner' | 'server'; expires_at: number | null }
}

function toFeatureRestrictionState(entry: WireFeatureRestrictionState): FeatureRestrictions['chat'] {
  const toIso = (value: number | null) => (value == null ? null : new Date(value).toISOString())
  return {
    owner: { ...entry.owner, expires_at: toIso(entry.owner.expires_at) },
    server: { ...entry.server, expires_at: toIso(entry.server.expires_at) },
    effective: { ...entry.effective, expires_at: toIso(entry.effective.expires_at) },
  }
}

function toFeatureRestrictions(entry: { chat: WireFeatureRestrictionState; posts: WireFeatureRestrictionState }): FeatureRestrictions {
  return { chat: toFeatureRestrictionState(entry.chat), posts: toFeatureRestrictionState(entry.posts) }
}

// Groups are populated separately (server-level groups are no
// longer embedded by the stronghold member-list route) - see
// getStrongholdMembers's batch fetch against /api/server-groups/members.
function toStrongholdMember(entry: WireMemberEntry): StrongholdMember {
  return {
    actor: entry.actor,
    username: actorLocalpart(entry.actor),
    display_name: entry.display_name,
    avatar: entry.avatar,
    role: entry.role,
    ...denyToBooleans(entry.deny),
    joined_at: new Date(entry.joined_at).toISOString(),
    last_active_at: entry.last_active_at == null ? null : new Date(entry.last_active_at).toISOString(),
    is_guest: entry.is_guest,
    home_domain: entry.home_domain,
    groups: [],
  }
}

// batch actor(localpart)->groups lookup (GET /api/server-groups/members),
// capped at 100 entries per the contract - callers dedupe/chunk if needed,
// though every caller in this codebase stays well under that cap.
function fetchGroupsForLocalparts(token: string | null, localparts: string[]): Promise<Record<string, MemberGroupRef[]>> {
  if (!localparts.length) return Promise.resolve({})
  const qs = encodeURIComponent(localparts.join(','))
  return request<{ groups: Record<string, MemberGroupRef[]> }>(`/api/server-groups/members?localparts=${qs}`, {
    headers: optionalAuthHeaders(token),
  }).then((r) => r.groups)
}

// a 401 on an authenticated request means the stored session is dead
// (secret rotation, revocation); the handler drops the app back to the
// auth gate instead of letting every consumer retry into a loading loop.
// Guarded to authed requests only, so a failed login attempt (also 401)
// never clears an unrelated existing session.
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => ({}))
  // /api/* uses the flat {error: "CODE"} shape; the /stronghold/* dev-convenience
  // routes (WS token mint, history) use the nested {error: {code, message}} shape.
  const errVal = body?.error
  if (!res.ok || errVal) {
    const code = typeof errVal === 'string' ? errVal : (errVal?.code ?? 'UNKNOWN_ERROR')
    if (res.status === 401 && 'Authorization' in headers) onUnauthorized?.()
    throw new ApiRequestError(code, res.status)
  }
  return body as T
}

function uploadBlob<T extends MediaUploadResult>(
  path: string,
  token: string,
  file: File | Blob,
  onProgress?: (percent: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}${path}`)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onload = () => {
      let body: { error?: string | { code?: string } } & Partial<T> = {}
      try {
        body = JSON.parse(xhr.responseText || '{}')
      } catch {
        // non-JSON body treated as UNKNOWN_ERROR below
      }
      const errVal = body.error
      if (xhr.status < 200 || xhr.status >= 300 || errVal) {
        const code = typeof errVal === 'string' ? errVal : (errVal?.code ?? 'UNKNOWN_ERROR')
        if (xhr.status === 401) onUnauthorized?.()
        reject(new ApiRequestError(code, xhr.status))
        return
      }
      resolve(body as T)
    }
    xhr.onerror = () => reject(new ApiRequestError('NETWORK_ERROR', 0))
    xhr.send(file)
  })
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

// several stronghold-scoped reads (config/rooms/posts) are open to an
// unauthenticated guest on a public stronghold when the instance policy
// allows it (server's resolveGuestOrMember) - a null token just
// means "send the request without an Authorization header" and the server
// sorts out member vs. guest from there.
function optionalAuthHeaders(token: string | null): HeadersInit | undefined {
  return token ? authHeaders(token) : undefined
}

export const realApi = {
  getInstanceConfig: () => request<InstanceConfig>('/api/instance/config'),

  completeOidcLogin: (code: string) =>
    request<AuthResponse>('/api/auth/oidc/complete', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  getDirectory: () => request<{ strongholds: DirectoryEntry[] }>('/api/directory').then((r) => r.strongholds),

  register: (payload: RegisterPayload) =>
    request<AuthResponse>('/api/register', { method: 'POST', body: JSON.stringify(payload) }),

  login: (payload: LoginPayload) =>
    request<TotpLoginResult>('/api/login', { method: 'POST', body: JSON.stringify(payload) }),

  // ---- TOTP second factor (spec §7.2a) -----------------------------------

  totpSetup: (token: string) =>
    request<TotpSetupResponse>('/api/me/totp/setup', { method: 'POST', headers: authHeaders(token) }),

  totpActivate: (token: string, code: string) =>
    request<{ ok: true }>('/api/me/totp/activate', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ code }),
    }),

  totpDisable: (token: string, password: string, code: string) =>
    request<{ ok: true }>('/api/me/totp/disable', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ password, code }),
    }),

  loginTotp: (pending: string, code: string) =>
    request<AuthResponse>('/api/login/totp', { method: 'POST', body: JSON.stringify({ pending, code }) }),

  // ---- passkeys (WebAuthn, spec §7.2a) -----------------------------------

  listPasskeys: (token: string) =>
    request<{ passkeys: Passkey[] }>('/api/me/passkeys', { headers: authHeaders(token) }).then((r) => r.passkeys),

  passkeyRegOptions: (token: string) =>
    request<PasskeyRegistrationOptions>('/api/me/passkeys/options', { method: 'POST', headers: authHeaders(token) }),

  registerPasskey: (token: string, response: RegistrationResponseJSON, challengeToken: string, name: string) =>
    request<Passkey>('/api/me/passkeys', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ response, challenge_token: challengeToken, name }),
    }),

  renamePasskey: (token: string, id: string, name: string) =>
    request<Passkey>(`/api/me/passkeys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ name }),
    }),

  deletePasskey: (token: string, id: string) =>
    request<void>(`/api/me/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders(token) }),

  passkeyLoginOptions: () => request<PasskeyAuthOptions>('/api/login/passkey/options', { method: 'POST' }),

  loginPasskey: (response: AuthenticationResponseJSON, challengeToken: string) =>
    request<AuthResponse>('/api/login/passkey', {
      method: 'POST',
      body: JSON.stringify({ response, challenge_token: challengeToken }),
    }),

  changePassword: (token: string, payload: ChangePasswordPayload) =>
    request<void>('/api/me/password', { method: 'POST', headers: authHeaders(token), body: JSON.stringify(payload) }),

  setDisplayName: (token: string, displayName: string) =>
    request<{ display_name: string }>('/api/me/display-name', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ display_name: displayName }),
    }),

  setBio: (token: string, bio: string) =>
    request<{ bio: string | null }>('/api/me/bio', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ bio }),
    }),

  getOwnership: (token: string) => request<OwnershipResponse>('/api/me/ownership', { headers: authHeaders(token) }),

  getAdminConfig: (token: string) =>
    request<AdminInstanceConfig>('/api/admin/instance/config', { headers: authHeaders(token) }),

  patchAdminConfig: (token: string, patch: AdminInstanceConfigPatch) =>
    request<AdminInstanceConfig>('/api/admin/instance/config', {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify(patch),
    }),

  // ---- server-level role appointment -------------------------------------------
  // Account listing supports server-group assignment for owners/admins; role
  // appointment itself remains server-owner-only.

  getAdminUsers: (token: string, after?: string) =>
    request<AdminUsersPage>(`/api/admin/users${after ? `?after=${encodeURIComponent(after)}` : ''}`, {
      headers: authHeaders(token),
    }),

  patchAdminUserRole: (token: string, localpart: string, serverRole: Extract<ServerRole, 'admin' | 'user'>) =>
    request<{ localpart: string; server_role: ServerRole }>(`/api/admin/users/${encodeURIComponent(localpart)}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ server_role: serverRole }),
    }),

  listInviteCodes: (token: string) =>
    request<{ codes: InviteCode[] }>('/api/admin/invite-codes', { headers: authHeaders(token) }).then((r) => r.codes),

  createInviteCodes: (token: string, count?: number) =>
    request<{ codes: InviteCode[] }>('/api/admin/invite-codes', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ count }),
    }).then((r) => r.codes),

  // ---- strongholds ----------------------------------------------------------

  listMyStrongholds: (token: string) =>
    request<StrongholdSummary[]>('/api/me/strongholds', { headers: authHeaders(token) }),

  // under the "application" creation policy the server returns a pending
  // application instead of a stronghold (202, not 201) - the caller
  // distinguishes by checking for `application_id`.
  createStronghold: (token: string, payload: CreateStrongholdPayload) =>
    request<StrongholdConfig | { application_id: string; state: 'pending' }>('/api/strongholds', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    }),

  joinStronghold: (token: string, nodeId: string) =>
    request<unknown>(`/api/stronghold/${nodeId}/join`, { method: 'POST', headers: authHeaders(token) }),

  // 'a' = this instance; other server ids currently always 404 (federation TBD).
  resolveStronghold: (server: string, slug: string) =>
    request<{ stronghold_id: string }>(
      `/api/resolve/${encodeURIComponent(server)}/${encodeURIComponent(slug)}`,
    ),

  patchStrongholdSlug: (token: string, nodeId: string, slug: string) =>
    request<{ id: string; slug: string }>(`/api/admin/strongholds/${nodeId}/slug`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ slug }),
    }),

  createRoom: (token: string, nodeId: string, payload: CreateRoomPayload) =>
    request<RoomSummary>(`/api/stronghold/${nodeId}/rooms`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    }),

  // guest-readable on a public stronghold when the instance allows it - a
  // member (token set) sees every room, a guest only the non-restricted ones
  // (server-side filter, not duplicated here).
  getStrongholdRooms: (token: string | null, nodeId: string) =>
    request<RoomSummary[]>(`/api/stronghold/${nodeId}/rooms`, { headers: optionalAuthHeaders(token) }),

  getStrongholdConfig: (token: string | null, nodeId: string) =>
    request<StrongholdConfig>(`/api/stronghold/${nodeId}/config`, { headers: optionalAuthHeaders(token) }),

  getFeatureRestrictions: (token: string, nodeId: string) =>
    request<{ chat: WireFeatureRestrictionState; posts: WireFeatureRestrictionState }>(
      `/api/stronghold/${nodeId}/feature-restrictions`,
      { headers: authHeaders(token) },
    ).then(toFeatureRestrictions),

  patchOwnerFeatureRestriction: (token: string, nodeId: string, feature: 'chat' | 'posts', paused: boolean, expiresAt: number | null) =>
    request<unknown>(`/api/stronghold/${nodeId}/feature-restrictions/owner`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ feature, paused, expires_at: expiresAt }),
    }),

  patchServerFeatureRestriction: (token: string, nodeId: string, feature: 'chat' | 'posts', mode: FeatureRestrictionMode, expiresAt: number | null) =>
    request<unknown>(`/api/stronghold/${nodeId}/feature-restrictions/server`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ feature, mode, expires_at: expiresAt }),
    }),

  patchStrongholdConfig: (token: string, nodeId: string, patch: StrongholdConfigPatch) =>
    request<StrongholdConfig>(`/api/stronghold/${nodeId}/config`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify(patch),
    }),

  deleteStronghold: (token: string, nodeId: string) =>
    request<void>(`/api/stronghold/${nodeId}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),

  patchRoom: (token: string, nodeId: string, resId: string, patch: RoomPatch) =>
    request<RoomSummary>(`/api/stronghold/${nodeId}/rooms/${resId}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify(patch),
    }),

  deleteRoom: (token: string, nodeId: string, resId: string) =>
    request<void>(`/api/stronghold/${nodeId}/rooms/${resId}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),

  // ---- room WS token / history ------------------------------------------------
  // Note: these two live at /stronghold/* (not /api/*) - matches the server's
  // dev-convenience route family that also owns the WS upgrade itself.

  mintRoomToken: (token: string, nodeId: string, resId: string) =>
    request<RoomTokenResponse>(`/stronghold/${nodeId}/rooms/${resId}/token`, {
      method: 'POST',
      headers: authHeaders(token),
    }),

  // guest-readable on a public stronghold when the instance allows it, same
  // gate as history's sibling reads above (server's inline check next to
  // this route, since /stronghold/* predates resolveGuestOrMember).
  getRoomHistory: (token: string | null, nodeId: string, resId: string, before?: number | null, limit?: number) => {
    const params = new URLSearchParams()
    if (before != null) params.set('before', String(before))
    if (limit != null) params.set('limit', String(limit))
    const qs = params.toString()
    return request<{ items: import('./types').RoomItem[] }>(
      `/stronghold/${nodeId}/rooms/${resId}/history${qs ? `?${qs}` : ''}`,
      { headers: optionalAuthHeaders(token) },
    ).then((r) => r.items)
  },

  editItem: (token: string, nodeId: string, resId: string, seq: number, content: unknown) =>
    request<EditRetractResult>(`/api/stronghold/${nodeId}/rooms/${resId}/items/${seq}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ content }),
    }),

  retractItem: (token: string, nodeId: string, resId: string, seq: number) =>
    request<EditRetractResult>(`/api/stronghold/${nodeId}/rooms/${resId}/items/${seq}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),

  // ---- posts (section rooms, read-only; writes go over the room WS) -----------

  listPosts: (
    token: string | null,
    nodeId: string,
    resId: string,
    after?: string | null,
    limit?: number,
  ) => {
    const params = new URLSearchParams()
    if (after) params.set('after', after)
    if (limit != null) params.set('limit', String(limit))
    const qs = params.toString()
    return request<PostPage>(`/api/stronghold/${nodeId}/rooms/${resId}/posts${qs ? `?${qs}` : ''}`, {
      headers: optionalAuthHeaders(token),
    })
  },

  getPost: (token: string | null, nodeId: string, resId: string, seq: number, before?: number | null, limit?: number) => {
    const params = new URLSearchParams()
    if (before != null) params.set('before', String(before))
    if (limit != null) params.set('limit', String(limit))
    const qs = params.toString()
    return request<PostThread>(`/api/stronghold/${nodeId}/rooms/${resId}/posts/${seq}${qs ? `?${qs}` : ''}`, {
      headers: optionalAuthHeaders(token),
    })
  },

  // ---- members / bans / ownership ----------------------------------------------

  getStrongholdMembers: async (token: string, nodeId: string, tab: MemberTab, after?: string): Promise<MemberPage> => {
    const r = await request<{ entries: WireMemberEntry[]; next_cursor: string | null }>(
      `/api/stronghold/${nodeId}/members?tab=${tab}${after ? `&after=${encodeURIComponent(after)}` : ''}`,
      { headers: authHeaders(token) },
    )
    const members = r.entries.map(toStrongholdMember)
    const localparts = [...new Set(members.map((m) => m.username))]
    const groups = await fetchGroupsForLocalparts(token, localparts)
    for (const member of members) member.groups = groups[member.username] ?? []
    return { members, next_cursor: r.next_cursor }
  },

  patchMember: (token: string, nodeId: string, actor: string, patch: MemberPatch) =>
    request<WireMemberEntry>(`/api/stronghold/${nodeId}/members/${encodeURIComponent(actor)}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ role: patch.role, deny: booleansToDeny(patch) }),
    }).then(toStrongholdMember),

  removeMember: (token: string, nodeId: string, actor: string) =>
    request<void>(`/api/stronghold/${nodeId}/members/${encodeURIComponent(actor)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),

  listBans: (token: string, nodeId: string) =>
    request<{ entries: WireBanEntry[] }>(
      `/api/stronghold/${nodeId}/bans`,
      { headers: authHeaders(token) },
    ).then((r): BanEntry[] => r.entries.map(toBanEntry)),

  banMember: (token: string, nodeId: string, actor: string, expiresAt: number | null = null) =>
    request<void>(`/api/stronghold/${nodeId}/bans/${encodeURIComponent(actor)}`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ expires_at: expiresAt }),
    }),

  unbanMember: (token: string, nodeId: string, actor: string) =>
    request<void>(`/api/stronghold/${nodeId}/bans/${encodeURIComponent(actor)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),

  // ---- server-wide account bans -----------------------------------------------

  listGlobalBans: (token: string) =>
    request<{ entries: WireBanEntry[] }>('/api/admin/bans', { headers: authHeaders(token) }).then((r): BanEntry[] => r.entries.map(toBanEntry)),

  banAccountGlobally: (token: string, actor: string, expiresAt: number | null = null) =>
    request<void>(`/api/admin/bans/${encodeURIComponent(actor)}`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ expires_at: expiresAt }),
    }),

  unbanAccountGlobally: (token: string, actor: string) =>
    request<void>(`/api/admin/bans/${encodeURIComponent(actor)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),

  transferOwnership: (token: string, nodeId: string, toActor: string) =>
    request<void>(`/api/stronghold/${nodeId}/transfer`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ to: toActor }),
    }),

  // ---- server-level user groups (admin API) -------------------------------------

  getServerGroups: (token: string) =>
    request<{ groups: ServerGroup[] }>('/api/admin/server-groups', { headers: authHeaders(token) }).then((r) => r.groups),

  createServerGroup: (token: string, payload: ServerGroupCreatePayload) =>
    request<ServerGroup>('/api/admin/server-groups', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    }),

  updateServerGroup: (token: string, groupId: string, patch: ServerGroupPatch) =>
    request<ServerGroup>(`/api/admin/server-groups/${encodeURIComponent(groupId)}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify(patch),
    }),

  deleteServerGroup: (token: string, groupId: string) =>
    request<void>(`/api/admin/server-groups/${encodeURIComponent(groupId)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),

  reorderServerGroups: (token: string, positions: { id: string; position: number }[]) =>
    request<{ groups: ServerGroup[] }>('/api/admin/server-groups', {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ positions }),
    }).then((r) => r.groups),

  assignServerGroupMember: (token: string, groupId: string, localpart: string) =>
    request<void>(`/api/admin/server-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(localpart)}`, {
      method: 'PUT',
      headers: authHeaders(token),
    }),

  unassignServerGroupMember: (token: string, groupId: string, localpart: string) =>
    request<void>(`/api/admin/server-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(localpart)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),

  // Read-only batch lookup, guest-readable per instance policy -
  // shared by the stronghold member list (badges) and the server admin
  // panel's member group controls.
  getGroupsForMembers: (token: string | null, localparts: string[]) => fetchGroupsForLocalparts(token, localparts),

  getUser: (token: string, actor: string) =>
    request<{ actor: string; display_name: string; avatar: string | null; cover: string | null; created_at?: number; bio: string | null; is_guest: boolean; home_domain?: string }>(
      `/api/users/${encodeURIComponent(actor)}`,
      { headers: authHeaders(token) },
    ).then(
      (u): PublicUser => ({
        actor: u.actor,
        username: actorLocalpart(u.actor),
        display_name: u.display_name,
        avatar: u.avatar,
        cover: u.cover,
        created_at: u.created_at == null ? undefined : new Date(u.created_at).toISOString(),
        bio: u.bio,
        is_guest: u.is_guest,
        home_domain: u.home_domain,
      }),
    ),

  isUserBlocked: (token: string, nodeId: string, actor: string) =>
    request<{ blocked: boolean }>(`/api/stronghold/${nodeId}/blocks/${encodeURIComponent(actor)}`, {
      headers: authHeaders(token),
    }).then((r) => r.blocked),

  blockUser: (token: string, nodeId: string, actor: string) =>
    request<void>(`/api/stronghold/${nodeId}/blocks/${encodeURIComponent(actor)}`, {
      method: 'PUT', headers: authHeaders(token),
    }),

  unblockUser: (token: string, nodeId: string, actor: string) =>
    request<void>(`/api/stronghold/${nodeId}/blocks/${encodeURIComponent(actor)}`, {
      method: 'DELETE', headers: authHeaders(token),
    }),

  getDirectMessages: (token: string, nodeId: string, actor: string) =>
    request<{ messages: Array<Omit<DirectMessage, 'created_at'> & { created_at: number }> }>(
      `/api/stronghold/${nodeId}/direct-messages/${encodeURIComponent(actor)}`,
      { headers: authHeaders(token) },
    ).then((r) => r.messages.map((message) => ({ ...message, created_at: new Date(message.created_at).toISOString() }))),

  sendDirectMessage: (token: string, nodeId: string, actor: string, body: string) =>
    request<Omit<DirectMessage, 'created_at'> & { created_at: number }>(
      `/api/stronghold/${nodeId}/direct-messages/${encodeURIComponent(actor)}`,
      { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ body }) },
    ).then((message) => ({ ...message, created_at: new Date(message.created_at).toISOString() })),

  // ---- emotes -----------------------------------------------------------------

  getEmotes: (token: string) => request<{ packs: EmotePack[] }>('/api/emotes', { headers: authHeaders(token) }).then((r) => r.packs),

  // ---- instance emote pack administration (admin endpoints) ---------------------

  createEmotePack: (token: string, name: string) =>
    request<EmotePack>('/api/admin/emote-packs', { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ name }) }),

  deleteEmotePack: (token: string, packId: string) =>
    request<void>(`/api/admin/emote-packs/${encodeURIComponent(packId)}`, { method: 'DELETE', headers: authHeaders(token) }),

  createEmote: (token: string, packId: string, name: string, mediaId: string) =>
    request<Emote>(`/api/admin/emote-packs/${encodeURIComponent(packId)}/emotes`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ name, media_id: mediaId }),
    }),

  deleteEmote: (token: string, emoteId: string) =>
    request<void>(`/api/admin/emotes/${encodeURIComponent(emoteId)}`, { method: 'DELETE', headers: authHeaders(token) }),

  // ---- media / storage ----------------------------------------------------------
  // POST /api/media takes the file as a raw request body (Content-Type: the file's
  // mime, browser sets Content-Length) - not multipart/form-data. XHR (not fetch) so
  // upload progress is observable.

  uploadMedia: (token: string, file: File | Blob, onProgress?: (percent: number) => void) =>
    uploadBlob<MediaUploadResult>('/api/media', token, file, onProgress),

  uploadAvatar: (token: string, file: File | Blob, onProgress?: (percent: number) => void) =>
    uploadBlob<AvatarUploadResult>('/api/me/avatar', token, file, onProgress),

  uploadCover: (token: string, file: File | Blob, onProgress?: (percent: number) => void) =>
    uploadBlob<CoverUploadResult>('/api/me/cover', token, file, onProgress),

  clearAvatar: (token: string) =>
    request<{ avatar: null }>('/api/me/avatar', { method: 'DELETE', headers: authHeaders(token) }),

  clearCover: (token: string) =>
    request<{ cover: null }>('/api/me/cover', { method: 'DELETE', headers: authHeaders(token) }),

  getStorageUsage: (token: string) => request<StorageUsage>('/api/me/storage', { headers: authHeaders(token) }),

  // ---- stronghold creation applications -----------------------------------------

  getMyStrongholdApplications: (token: string) =>
    request<{ applications: StrongholdApplication[] }>('/api/me/stronghold-applications', {
      headers: authHeaders(token),
    }).then((r) => r.applications),

  getAdminStrongholdApplications: (token: string, state?: StrongholdApplicationState) =>
    request<{ applications: StrongholdApplication[] }>(
      `/api/admin/stronghold-applications${state ? `?state=${state}` : ''}`,
      { headers: authHeaders(token) },
    ).then((r) => r.applications),

  decideStrongholdApplication: (token: string, id: string, state: 'approved' | 'rejected') =>
    request<{ id: string; state: string }>(`/api/admin/stronghold-applications/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ state }),
    }),
}
