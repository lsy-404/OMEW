import { ref, watch } from 'vue'
import { api } from '../api'
import { createRoomTransport } from '../api/transport'
import type { ItemBody, MediaAttachment, PostReply, PostSummary, PostThread, ReactionEntry, RoomSummary } from '../api/types'
import type { RoomTransport } from '../api/roomSocket'
import { canCommitPostPage } from '../utils/postLoad'
import { markdownPreview } from '../utils/markdownPreview'
import { applyReactionToggle, invertReactionOp } from '../utils/reactions'
import { useAuth } from './useAuth'
import { usePostModal } from './usePostModal'
import { useSection } from './useSection'
import { useStronghold } from './useStronghold'

const POSTS_PAGE_SIZE = 20
const REPLIES_PAGE_SIZE = 30
// mirrors mock.ts/server's preview truncation length for a locally patched
// post's list-view preview after an edit.
const PREVIEW_LEN = 80

const posts = ref<PostSummary[]>([])
const postsLoading = ref(false)
const postsCursor = ref<string | null>(null)
const hasMorePosts = ref(true)
const connected = ref(false)

const thread = ref<PostThread | null>(null)
const threadLoading = ref(false)
const threadRepliesLoading = ref(false)
const threadHasMore = ref(false)
let openPostSeq: number | null = null

let transport: RoomTransport | null = null
// roomKey identifies the WS and loadKey suppresses duplicate loads.
let roomKey = ''
let loadKey = ''
// Incremented for every room transition so an older listPosts response cannot
// repopulate the shared list after the user has moved to another room (or back
// to a room with the same key).
let loadGeneration = 0

// item.create's broadcast excludes the sender (room-do.ts enqueueBroadcast
// passes the sender's own ws to exclude it from the batch fan-out) - the
// author only learns their own post/reply landed via the ack. Track what
// each in-flight client_id was creating so the ack handler can splice it
// into local state instead of waiting for a broadcast that will never come.
interface PendingCreate {
  kind: 'post' | 'reply'
  actor: string
  title?: string
  text: string
  cover?: string
  media?: MediaAttachment[]
  parentSeq?: number
}
const pendingCreates = new Map<string, PendingCreate>()

// tracks this client's own in-flight optimistic reaction op per target seq -
// used to roll back precisely on a transport failure or a matching error
// frame.
const pendingReactionOps = new Map<number, { name: string; op: 'add' | 'remove' }>()

function bumpPost(update: { post_seq: number; last_reply_seq: number; reply_count: number; preview: string; ts: number }) {
  const idx = posts.value.findIndex((p) => p.post_seq === update.post_seq)
  if (idx >= 0) {
    const next = { ...posts.value[idx]!, last_reply_seq: update.last_reply_seq, reply_count: update.reply_count, bumped_at: update.ts }
    posts.value.splice(idx, 1)
    posts.value.unshift(next)
  }
  if (thread.value && thread.value.post.post_seq === update.post_seq) {
    thread.value = { ...thread.value, post: { ...thread.value.post, reply_count: update.reply_count, bumped_at: update.ts } }
  }
}

async function connectRoom(nodeId: string, room: RoomSummary, readOnly: boolean) {
  const wsKey = `${nodeId}/${room.id}/${readOnly ? 'preview' : 'member'}`
  const key = wsKey
  if (key === loadKey) return
  loadKey = key
  const generation = ++loadGeneration
  const wsNeedsReconnect = wsKey !== roomKey
  roomKey = wsKey
  if (wsNeedsReconnect) {
    transport?.close()
    transport = null
    connected.value = false
    pendingCreates.clear()
  }
  posts.value = []
  postsCursor.value = null
  hasMorePosts.value = true
  thread.value = null
  openPostSeq = null

  await loadMorePosts(true, generation, key)
  if (loadKey !== key || loadGeneration !== generation) return

  if (!wsNeedsReconnect) return

  // Public previews read over REST; posting needs the member-only room WS.
  const auth = useAuth()
  if (readOnly || !auth.token.value) return

  transport = createRoomTransport({
    nodeId,
    resId: room.id,
    token: auth.token.value,
    actor: auth.user.value?.actor ?? '',
    handlers: {
      onOpen: () => {
        connected.value = true
      },
      onClose: () => {
        connected.value = false
      },
      onAck: (ack) => {
        if (!ack.client_id || typeof ack.seq !== 'number') return
        const pending = pendingCreates.get(ack.client_id)
        if (!pending) return
        pendingCreates.delete(ack.client_id)
        const ts = Date.now()
        if (pending.kind === 'post') {
          const entry: PostSummary = {
            post_seq: ack.seq,
            actor: pending.actor,
            created_at: ts,
            title: pending.title ?? '',
            cover: pending.cover ?? null,
            preview: markdownPreview(pending.text, PREVIEW_LEN),
            media: pending.media,
            last_reply_seq: ack.seq,
            reply_count: 0,
            bumped_at: ts,
          }
          if (!posts.value.some((p) => p.post_seq === ack.seq)) posts.value.unshift(entry)
          if (thread.value && thread.value.post.post_seq === ack.seq && pending.media?.length) {
            thread.value = { ...thread.value, post: { ...thread.value.post, media: pending.media } }
          }
        } else if (thread.value && thread.value.post.post_seq === pending.parentSeq) {
          const reply: PostReply = { seq: ack.seq, actor: pending.actor, ts, body: { text: pending.text, media: pending.media } }
          if (!thread.value.replies.some((r) => r.seq === reply.seq)) {
            thread.value = { ...thread.value, replies: [reply, ...thread.value.replies] }
          }
        }
      },
      onBump: (b) => bumpPost(b),
      onItem: (item) => {
        // a reply created elsewhere while a thread is open - append live.
        if (item.parent_seq != null && thread.value && item.root_seq === thread.value.post.post_seq) {
          const reply: PostReply = { seq: item.seq, actor: item.actor, ts: item.ts, body: item.body }
          if (!thread.value.replies.some((r) => r.seq === reply.seq)) {
            thread.value = { ...thread.value, replies: [reply, ...thread.value.replies] }
          }
        }
      },
      onUpdate: (u) => applyItemUpdate(u.target_seq, u.body as ItemBody),
      onDelete: (d) => applyItemDelete(d.target_seq),
      // absolute snapshot (m0-protocol §3.2a) - actor/name/op let any
      // connection of the same account maintain its own `mine`.
      onReaction: (frame) => {
        applyReactionSnapshot(frame.target_seq, frame.entries, frame.actor, frame.name, frame.op)
      },
      // reaction rejections carry target_seq + name so the exact optimistic
      // toggle can be rolled back; nothing else is handled here (section
      // rooms had no onError registered at all before this).
      onError: (e) => {
        if (e.target_seq != null && e.name) rollbackReaction(e.target_seq, e.name)
      },
    },
  })
  transport.connect()
}

// Shared by the room WS handlers above and editItem/retractItem below - a
// REST edit/retract patches state the same way a WS echo of item.update /
// item.delete would, so the UI updates whether or not this client's own
// connection also happens to receive that echo (mock never emits it).
function applyItemUpdate(targetSeq: number, body: ItemBody) {
  const postIdx = posts.value.findIndex((p) => p.post_seq === targetSeq)
  if (postIdx >= 0) {
    const current = posts.value[postIdx]!
    posts.value[postIdx] = {
      ...current,
      title: body.title ?? current.title,
      preview: body.text != null ? markdownPreview(body.text, PREVIEW_LEN) : current.preview,
    }
  }
  if (thread.value?.post.post_seq === targetSeq) {
    const current = thread.value.post
    thread.value = { ...thread.value, post: { ...current, title: body.title ?? current.title, text: body.text ?? current.text } }
  } else if (thread.value) {
    const replyIdx = thread.value.replies.findIndex((r) => r.seq === targetSeq)
    if (replyIdx >= 0) {
      const replies = [...thread.value.replies]
      replies[replyIdx] = { ...replies[replyIdx]!, body }
      thread.value = { ...thread.value, replies }
    }
  }
}

function applyItemDelete(targetSeq: number) {
  posts.value = posts.value.filter((p) => p.post_seq !== targetSeq)
  if (thread.value?.post.post_seq === targetSeq) {
    thread.value = null
    openPostSeq = null
    usePostModal().close()
  } else if (thread.value) {
    thread.value = { ...thread.value, replies: thread.value.replies.filter((r) => r.seq !== targetSeq) }
  }
}

function applyReactionSnapshot(targetSeq: number, entries: ReactionEntry[], actor: string, name: string, op: 'add' | 'remove') {
  const auth = useAuth()
  const isSelf = actor === auth.user.value?.actor
  if (isSelf) pendingReactionOps.delete(targetSeq)
  // self-authored broadcast (this tab or another session of the same
  // account): apply the frame's name/op to `mine`; other actors' toggles
  // leave it as-is.
  function nextMine(prevMine: string[]): string[] {
    if (!isSelf) return prevMine
    const set = new Set(prevMine)
    if (op === 'add') set.add(name)
    else set.delete(name)
    return [...set]
  }
  const postIdx = posts.value.findIndex((p) => p.post_seq === targetSeq)
  if (postIdx >= 0) {
    const prevMine = posts.value[postIdx]!.reactions?.mine ?? []
    posts.value[postIdx] = { ...posts.value[postIdx]!, reactions: { entries, mine: nextMine(prevMine) } }
  }
  if (thread.value?.post.post_seq === targetSeq) {
    const prevMine = thread.value.post.reactions?.mine ?? []
    thread.value = { ...thread.value, post: { ...thread.value.post, reactions: { entries, mine: nextMine(prevMine) } } }
  } else if (thread.value) {
    const replyIdx = thread.value.replies.findIndex((r) => r.seq === targetSeq)
    if (replyIdx >= 0) {
      const replies = [...thread.value.replies]
      const prevMine = replies[replyIdx]!.reactions?.mine ?? []
      replies[replyIdx] = { ...replies[replyIdx]!, reactions: { entries, mine: nextMine(prevMine) } }
      thread.value = { ...thread.value, replies }
    }
  }
}

function applyLocalReactionDelta(seq: number, name: string, op: 'add' | 'remove') {
  const postIdx = posts.value.findIndex((p) => p.post_seq === seq)
  if (postIdx >= 0) posts.value[postIdx] = { ...posts.value[postIdx]!, reactions: applyReactionToggle(posts.value[postIdx]!.reactions, name, op) }
  if (thread.value?.post.post_seq === seq) {
    thread.value = { ...thread.value, post: { ...thread.value.post, reactions: applyReactionToggle(thread.value.post.reactions, name, op) } }
  } else if (thread.value) {
    const replyIdx = thread.value.replies.findIndex((r) => r.seq === seq)
    if (replyIdx >= 0) {
      const replies = [...thread.value.replies]
      replies[replyIdx] = { ...replies[replyIdx]!, reactions: applyReactionToggle(replies[replyIdx]!.reactions, name, op) }
      thread.value = { ...thread.value, replies }
    }
  }
}

// inverts whatever optimistic op is still pending for (seq, name) - used both
// when the transport can't even send the toggle and when a matching error
// frame arrives later.
function rollbackReaction(seq: number, name: string) {
  const pendingOp = pendingReactionOps.get(seq)
  pendingReactionOps.delete(seq)
  if (pendingOp && pendingOp.name === name) applyLocalReactionDelta(seq, name, invertReactionOp(pendingOp.op))
}

// rebuilds the full body of a post/reply from currently-held state, for
// editItem below to merge the new text into (server replaces the body
// wholesale rather than merging, so the client must send every field back).
function currentBody(targetSeq: number): ItemBody | null {
  if (thread.value?.post.post_seq === targetSeq) {
    const post = thread.value.post
    const body: ItemBody = { text: post.text }
    if (post.title) body.title = post.title
    if (post.cover) body.cover = post.cover
    if (post.media?.length) body.media = post.media
    return body
  }
  const reply = thread.value?.replies.find((r) => r.seq === targetSeq)
  return reply ? { ...reply.body } : null
}

function currentMine(targetSeq: number): string[] {
  if (thread.value?.post.post_seq === targetSeq) return thread.value.post.reactions?.mine ?? []
  const reply = thread.value?.replies.find((r) => r.seq === targetSeq)
  if (reply) return reply.reactions?.mine ?? []
  return posts.value.find((p) => p.post_seq === targetSeq)?.reactions?.mine ?? []
}

async function loadMorePosts(reset = false, expectedGeneration = loadGeneration, expectedKey = loadKey) {
  const { selectedNodeId } = useStronghold()
  const { selectedSection } = useSection()
  const auth = useAuth()
  const room = selectedSection.value
  if (!selectedNodeId.value || !room) return
  if (!reset && (postsLoading.value || !hasMorePosts.value)) return
  postsLoading.value = true
  try {
    const page = await api.listPosts(
      auth.token.value,
      selectedNodeId.value,
      room.id,
      reset ? null : postsCursor.value,
      POSTS_PAGE_SIZE,
    )
    // A room switch can happen while REST is in flight. Only the latest
    // request may commit, otherwise the old page briefly flashes and then
    // disappears when the new room load completes.
    if (!canCommitPostPage(loadGeneration, loadKey, expectedGeneration, expectedKey)) return
    posts.value = reset ? page.posts : [...posts.value, ...page.posts]
    postsCursor.value = page.next_cursor
    hasMorePosts.value = page.next_cursor != null
  } catch {
    // keep whatever we already had
  } finally {
    if (canCommitPostPage(loadGeneration, loadKey, expectedGeneration, expectedKey)) postsLoading.value = false
  }
}

export function useSectionRoom() {
  const { selectedNodeId, isReadOnly } = useStronghold()
  const { selectedSection } = useSection()
  const postRoom = selectedSection

  watch(
    [selectedNodeId, selectedSection, isReadOnly],
    ([nodeId, room, readOnly]) => {
      if (nodeId && room) void connectRoom(nodeId, room, readOnly)
      else {
        loadGeneration += 1
        transport?.close()
        transport = null
        roomKey = ''
        loadKey = ''
        postsLoading.value = false
        posts.value = []
        thread.value = null
      }
    },
    { immediate: true },
  )

  function createPost(title: string, text: string, cover?: string, media?: MediaAttachment[]) {
    const auth = useAuth()
    // `connected` prevents a target-section switch from briefly reusing the
    // previous room's live socket while its replacement is being established.
    if (!transport || !connected.value || !auth.user.value) return false
    const clientId = crypto.randomUUID()
    const trimmedTitle = title.trim()
    const trimmedText = text.trim()
    const trimmedCover = cover?.trim() || undefined
    const body: Record<string, unknown> = { title: trimmedTitle, text: trimmedText }
    if (trimmedCover) body.cover = trimmedCover
    if (media?.length) body.media = media
    const ok = transport.createItem(clientId, 'post', body)
    if (ok) {
      pendingCreates.set(clientId, {
        kind: 'post',
        actor: auth.user.value.actor,
        title: trimmedTitle,
        text: trimmedText,
        cover: trimmedCover,
        media,
      })
    }
    return ok
  }

  async function openThread(postSeq: number, targetReplySeq: number | null = null) {
    const auth = useAuth()
    const nodeId = selectedNodeId.value
    const room = postRoom.value
    openPostSeq = postSeq
    if (!nodeId || !room) return
    threadLoading.value = true
    thread.value = null
    try {
      let result = await api.getPost(auth.token.value, nodeId, room.id, postSeq, null, REPLIES_PAGE_SIZE)
      while (targetReplySeq != null && !result.replies.some((reply) => reply.seq === targetReplySeq) && result.next_before != null) {
        const older = await api.getPost(auth.token.value, nodeId, room.id, postSeq, result.next_before, REPLIES_PAGE_SIZE)
        result = { post: result.post, replies: [...result.replies, ...older.replies], next_before: older.next_before }
      }
      if (openPostSeq !== postSeq) return // superseded
      thread.value = result
      threadHasMore.value = result.next_before != null
    } finally {
      threadLoading.value = false
    }
  }

  function closeThread() {
    openPostSeq = null
    thread.value = null
  }

  async function loadMoreReplies() {
    const auth = useAuth()
    const nodeId = selectedNodeId.value
    const room = postRoom.value
    if (!nodeId || !room || !thread.value || threadRepliesLoading.value || !threadHasMore.value) return
    const before = thread.value.next_before
    if (before == null) return
    threadRepliesLoading.value = true
    try {
      const result = await api.getPost(auth.token.value, nodeId, room.id, thread.value.post.post_seq, before, REPLIES_PAGE_SIZE)
      thread.value = { post: thread.value.post, replies: [...thread.value.replies, ...result.replies], next_before: result.next_before }
      threadHasMore.value = result.next_before != null
    } finally {
      threadRepliesLoading.value = false
    }
  }

  function createReply(text: string, media?: MediaAttachment[]) {
    const auth = useAuth()
    if (!transport || !thread.value || !auth.user.value) return false
    const clientId = crypto.randomUUID()
    const trimmedText = text.trim()
    const postSeq = thread.value.post.post_seq
    const body: Record<string, unknown> = { text: trimmedText }
    if (media?.length) body.media = media
    const ok = transport.createItem(clientId, 'reply', body, postSeq)
    if (ok) {
      pendingCreates.set(clientId, { kind: 'reply', actor: auth.user.value.actor, text: trimmedText, media, parentSeq: postSeq })
    }
    return ok
  }

  // fire-and-forget: optimistic flip now, reconciled by the absolute
  // snapshot frame whichever path it arrives on (direct or batched), or
  // rolled back on a send failure / matching error frame (see onError above).
  function toggleReaction(seq: number, name: string) {
    if (!transport) return
    const op: 'add' | 'remove' = currentMine(seq).includes(name) ? 'remove' : 'add'
    applyLocalReactionDelta(seq, name, op)
    pendingReactionOps.set(seq, { name, op })
    const ok = transport.toggleReaction(seq, name, op)
    if (!ok) rollbackReaction(seq, name)
  }

  // generic item.update/item.delete (m0-protocol §3.2) - same REST surface
  // ChatPane's messages use, applied here to a section room's post/reply
  // items. Patches local state directly on REST success via the same
  // applyItemUpdate/applyItemDelete the WS echo (if any) would also call.
  async function editItem(seq: number, text: string): Promise<boolean> {
    const auth = useAuth()
    const nodeId = selectedNodeId.value
    const room = postRoom.value
    const original = currentBody(seq)
    if (!auth.token.value || !nodeId || !room || !original) return false
    try {
      const trimmed = text.trim()
      // full-body edit (server replaces wholesale, doesn't merge) - carry the
      // post's title/cover/media (or the reply's media) along so they
      // don't get silently dropped; preview is left out, the server recomputes it.
      const body: ItemBody = { ...original, text: trimmed }
      await api.editItem(auth.token.value, nodeId, room.id, seq, body)
      applyItemUpdate(seq, body)
      return true
    } catch {
      return false
    }
  }

  async function retractItem(seq: number): Promise<boolean> {
    const auth = useAuth()
    const nodeId = selectedNodeId.value
    const room = postRoom.value
    if (!auth.token.value || !nodeId || !room) return false
    try {
      await api.retractItem(auth.token.value, nodeId, room.id, seq)
      applyItemDelete(seq)
      return true
    } catch {
      return false
    }
  }

  return {
    postRoom,
    posts,
    postsLoading,
    hasMorePosts,
    connected,
    loadMorePosts: () => loadMorePosts(false),
    createPost,
    thread,
    threadLoading,
    threadRepliesLoading,
    threadHasMore,
    openThread,
    closeThread,
    loadMoreReplies,
    createReply,
    toggleReaction,
    editItem,
    retractItem,
  }
}
