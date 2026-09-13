export type RootRequirement = 'email' | 'phone' | 'code'
export type StrongholdCreationPolicy = 'open' | 'restricted' | 'application'

export type InstanceMode = 'multi' | 'single'
export type SsoMode = 'disabled' | 'optional' | 'required'

export interface RootStronghold {
  id: string
  name: string
  slug: string
}

// server-level role (m0-protocol §7.10, migration 0008) - distinct from a
// per-stronghold StrongholdRole. 'owner' is the unique, non-transferable
// bootstrap account; 'admin' is appointed by the owner.
export type ServerRole = 'owner' | 'admin' | 'user'

// /api/instance/config (public, unauthenticated) - a deliberately thin
// projection of the server's internal config; see AdminInstanceConfig for
// the full admin-only shape (note the field is spelled differently there:
// stronghold_creation here vs. stronghold_creation_policy on admin - the
// public route renames it on the way out, creators/peers stay admin-only).
export interface InstanceConfig {
  instance_name: string
  instance_mode: InstanceMode
  root_stronghold: RootStronghold | null
  allow_root: boolean
  root_requirements: RootRequirement[]
  stronghold_creation: StrongholdCreationPolicy
  allow_guest_browsing: boolean
  sso_mode: SsoMode
  sso_enabled: boolean
  sso_provider_name: string
  sso_session_locked: boolean
  logo_url: string | null
  emotes_enabled: boolean
  builtin_emotes_enabled: boolean
  reactions_enabled: boolean
  art_assets_enabled: boolean
}

// /api/admin/instance/config - mirrors the server's internal InstanceConfig
// row (server/src/types.ts) field-for-field; deliberately not `extends
// InstanceConfig` since the two responses don't actually share a shape.
export interface AdminInstanceConfig {
  instance_mode: InstanceMode
  root_stronghold: string | null
  allow_root: boolean
  root_requirements: RootRequirement[]
  trusted_identity_servers: string[]
  max_file_bytes: number
  user_storage_quota_bytes: number
  federation_peers: string[]
  stronghold_creation_policy: StrongholdCreationPolicy
  stronghold_creators: string[]
  allow_guest_browsing: boolean
  sso_mode: SsoMode
  sso_issuer: string
  sso_client_id: string
  sso_provider_name: string
  sso_client_secret_configured: boolean
}

export interface AdminInstanceConfigPatch extends Partial<AdminInstanceConfig> {
  sso_client_secret?: string
}

export interface AuthUser {
  actor: string
  username: string
  // renameable; `username` (and the actor derived from it) is not
  display_name: string
  avatar: string | null
  cover: string | null
  bio: string | null
  is_admin: boolean
  server_role: ServerRole
  email: string | null
  email_verified: boolean
  // optional: only populated locally right after this session's own
  // totp activate/disable call (see useAuth.updateUser) - the server does
  // not yet project TOTP status onto AuthUser on any response, so a fresh
  // login/register always omits it. Absent is treated as "not enabled" by
  // every consumer in this codebase.
  totp_enabled?: boolean
}

export interface AuthResponse {
  token: string
  user: AuthUser
  auth_source?: 'local' | 'sso'
}

export interface UserProfile {
  actor: string
  username: string
  display_name: string
  avatar: string | null
  cover: string | null
  bio: string | null
  created_at: number
  is_guest: boolean
  home_domain?: string
}

export interface RegisterPayload {
  username: string
  password: string
  email?: string
  code?: string
  ownership_pubkey: string
  ownership_ciphertext: string
}

export interface LoginPayload {
  username: string
  password: string
}

export interface OwnershipResponse {
  ownership_pubkey: string
  ownership_ciphertext: string
}

export interface ChangePasswordPayload {
  old_password: string
  new_password: string
  new_ownership_ciphertext?: string
}

export interface InviteCode {
  code: string
  created_by: string
  created_at: number
  used_by: string | null
  used_at: number | null
}

export type StrongholdRole = 'owner' | 'mod' | 'member'
export type StrongholdVisibility = 'public' | 'private'
export type MemberTab = 'all' | 'restricted' | 'banned'

export interface StrongholdConfig {
  id: string
  name: string
  description: string
  avatar: string | null
  cover: string
  visibility: StrongholdVisibility
  allow_message_edit: boolean
  allow_message_retract: boolean
  edit_window_secs: number
}

export interface StrongholdConfigPatch {
  name?: string
  description?: string
  avatar?: string | null
  cover?: string
  visibility?: StrongholdVisibility
  allow_message_edit?: boolean
  allow_message_retract?: boolean
  edit_window_secs?: number
}

export type RestrictedFeature = 'chat' | 'posts'
export type FeatureRestrictionMode = 'inherit' | 'force_allow' | 'force_pause'

export interface FeatureRestrictionState {
  owner: { paused: boolean; expires_at: string | null }
  server: { mode: FeatureRestrictionMode; expires_at: string | null }
  effective: { paused: boolean; source: 'none' | 'owner' | 'server'; expires_at: string | null }
}

// Chat and posts are independently governed: a server override takes priority
// over the actual stronghold owner's temporary pause for that one feature.
export interface FeatureRestrictions {
  chat: FeatureRestrictionState
  posts: FeatureRestrictionState
}

// A member's server-level group badge, as returned by the batch
// read-only lookup (GET /api/server-groups/members) - deliberately thin,
// just enough to render a badge. Read-only on the stronghold side; group
// definition and assignment both live at the server level now.
export interface MemberGroupRef {
  id: string
  name: string
  color: string | null
}

export interface StrongholdMember {
  actor: string
  username: string
  display_name: string
  avatar: string | null
  role: StrongholdRole
  deny_discussion: boolean
  deny_idea: boolean
  deny_comment: boolean
  joined_at: string
  /** Last authenticated activity observed locally; null is not online/offline. */
  last_active_at: string | null
  is_guest: boolean
  home_domain?: string
  groups: MemberGroupRef[]
  /** Optional profile summary; older servers may omit it. */
  bio?: string | null
}

// tri-state permission value used by server groups: -1 deny / 0 inherit / 1 allow.
export type GroupPermValue = -1 | 0 | 1

// A server-level user group (m0-protocol §7.10a, server's ServerGroup / D1
// server_groups) - replaces stronghold-local groups.
// Position is ascending synthesis order and doubles as display order.
export interface ServerGroup {
  id: string
  name: string
  color: string | null
  position: number
  allow_speak: GroupPermValue
  allow_post: GroupPermValue
  allow_reply: GroupPermValue
  is_moderator: boolean
}

export interface ServerGroupCreatePayload {
  name: string
  color?: string | null
  allow_speak?: GroupPermValue
  allow_post?: GroupPermValue
  allow_reply?: GroupPermValue
  is_moderator?: boolean
  position?: number
}

export interface ServerGroupPatch {
  name?: string
  color?: string | null
  position?: number
  allow_speak?: GroupPermValue
  allow_post?: GroupPermValue
  allow_reply?: GroupPermValue
  is_moderator?: boolean
}

export interface MemberPatch {
  role?: StrongholdRole
  deny_discussion?: boolean
  deny_idea?: boolean
  deny_comment?: boolean
}

export interface MemberPage {
  members: StrongholdMember[]
  next_cursor: string | null
}

export interface BanEntry {
  actor: string
  username?: string
  banned_by: string
  banned_at: string
  expires_at: string | null
}

export interface PublicUser {
  actor: string
  username: string
  display_name: string
  avatar: string | null
  cover: string | null
  created_at?: string
  bio: string | null
  is_guest: boolean
  home_domain?: string
}

export interface DirectMessage {
  id: string
  sender_actor: string
  recipient_actor: string
  body: string
  created_at: string
}

// GET /api/admin/users is available to server owners and admins; only PATCH
// /api/admin/users/:localpart remains server-owner-only.
export interface AdminUserEntry {
  localpart: string
  username: string
  server_role: ServerRole
  created_at: number
}

export interface AdminUsersPage {
  users: AdminUserEntry[]
  next_cursor: string | null
}

// ---- strongholds / rooms --------------------------------------------------

export type RoomType = 'channel' | 'section'

export interface RoomSummary {
  id: string
  name: string
  type: RoomType
  description: string | null
  post_count?: number
}

export interface RoomPatch {
  name?: string
  description?: string | null
  position?: number
  restricted?: boolean
}

export interface StrongholdSummary {
  id: string
  name: string
  avatar: string | null
  cover: string | null
  slug: string
  rooms: RoomSummary[]
}

// Public directory entry (GET /api/directory) - unauthenticated
// discovery listing, distinct from StrongholdSummary which carries rooms and
// is only ever returned to an authenticated member.
export interface DirectoryEntry {
  id: string
  name: string
  description: string | null
  avatar: string | null
  cover: string | null
  slug: string
  member_count: number
}

export interface CreateStrongholdPayload {
  name: string
  description?: string
  visibility?: StrongholdVisibility
}

export interface CreateRoomPayload {
  name: string
  type: RoomType
}

// ---- room items (chat messages / posts / replies) -------------------------

// image attachment as carried on an item.create WS frame's free-form body -
// server doesn't validate the shape (017/019), this is a client-side contract.
export interface MediaAttachment {
  id: string
  url: string
  mime: string
}

export interface ItemBody {
  text?: string
  title?: string
  cover?: string
  preview?: string
  media?: MediaAttachment[]
  quote?: unknown
}

// m0-protocol §3.2a: absolute per-name count for one item, plus the
// requester's own reaction names (`mine`) - read endpoints project both,
// never a delta.
export interface ReactionEntry {
  name: string
  count: number
}

export interface ItemReactions {
  entries: ReactionEntry[]
  mine: string[]
}

export interface RoomItem {
  seq: number
  parent_seq: number | null
  root_seq: number | null
  actor: string
  kind: 'post' | 'reply'
  ts: number
  body: ItemBody
  edited_at?: number
  reactions?: ItemReactions
}

export interface RoomTokenResponse {
  token: string
  room: string
  exp: number
}

export interface EditRetractResult {
  seq: number | null
  target_seq: number
}

// ---- posts (section rooms) -------------------------------------------------

export interface PostSummary {
  post_seq: number
  actor: string
  created_at: number
  title: string
  cover: string | null
  preview: string
  media?: MediaAttachment[]
  last_reply_seq: number
  reply_count: number
  bumped_at: number
  reactions?: ItemReactions
}

export interface PostPage {
  posts: PostSummary[]
  next_cursor: string | null
}

export interface PostDetail extends PostSummary {
  text: string
}

export interface PostReply {
  seq: number
  actor: string
  ts: number
  body: ItemBody
  reactions?: ItemReactions
}

export interface PostThread {
  post: PostDetail
  replies: PostReply[]
  next_before: number | null
}

// ---- stronghold creation applications (application policy) ----------------

export type StrongholdApplicationState = 'pending' | 'approved' | 'rejected'

export interface StrongholdApplication {
  id: string
  actor: string
  name: string
  description: string | null
  visibility: StrongholdVisibility
  state: StrongholdApplicationState
  created_at: number
  decided_by: string | null
  decided_at: number | null
}

// ---- media / emotes / storage ----------------------------------------------

export interface MediaUploadResult {
  id: string
  url: string
  size: number
  mime: string
}

export interface AvatarUploadResult extends MediaUploadResult {
  avatar: string
}

export interface CoverUploadResult extends MediaUploadResult {
  cover: string
}

export interface StorageUsage {
  used: number
  quota: number
  max_file: number
}

// ---- second factor / passkeys (instance-local auth, spec §7.2a) -----------

export interface TotpSetupResponse {
  secret: string
  otpauth_url: string
}

// discriminated by presence of totp_required: password login either lands
// straight in AuthResponse or hands back a short-lived pending token that
// only /api/login/totp will accept.
export type TotpLoginResult = { totp_required: true; pending: string } | AuthResponse

export interface Passkey {
  id: string
  name: string
  created_at: number
}

export interface PasskeyRegistrationOptions {
  options: import('@simplewebauthn/browser').PublicKeyCredentialCreationOptionsJSON
  challenge_token: string
}

export interface PasskeyAuthOptions {
  options: import('@simplewebauthn/browser').PublicKeyCredentialRequestOptionsJSON
  challenge_token: string
}

export interface Emote {
  id: string
  name: string
  media_id: string
  url: string
}

export interface EmotePack {
  id: string
  name: string
  // optional human-readable label for the pack header, distinct from `name`
  // (which is the stable key embedded in :pack:name: tokens) - only the
  // built-in default pack sets this, instance packs fall back to `name`.
  display?: string
  emotes: Emote[]
}
