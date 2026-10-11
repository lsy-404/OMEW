import { API_BASE } from './client'
import type { ReactionEntry, RoomItem } from './types'

// mirrors API_BASE (client.ts) but as a ws(s):// origin - empty means "same
// origin as the page", matching the http fetch default.
function wsOrigin(): string {
  if (!API_BASE) {
    return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`
  }
  const url = new URL(API_BASE)
  return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`
}

export interface AckFrame {
  status: 'ok' | 'duplicate' | 'ignored'
  client_id?: string
  target_seq?: number
  seq?: number
  reason?: string
}

export interface UpdateFrame {
  seq: number
  target_seq: number
  body: unknown
  edited_at: number
}

export interface DeleteFrame {
  seq: number
  target_seq: number
  reason?: string
  by_role: string
}

export interface BumpFrame {
  post_seq: number
  last_reply_seq: number
  reply_count: number
  preview: string
  ts: number
}

export interface ErrorFrame {
  code: string
  message: string
  // reaction-specific rejections (m0-protocol §3.2a) carry these so the
  // client can roll back the exact optimistic toggle instead of guessing.
  target_seq?: number
  name?: string
}

// m0-protocol §3.2a broadcast shape: an absolute count snapshot, never a
// delta - `actor`/`name`/`op` identify who just toggled which reaction in
// what direction (any connection of the same account can maintain its own
// `mine` from them); the per-name counts in `entries` are the full picture
// for this target_seq.
export interface ReactionFrame {
  target_seq: number
  entries: ReactionEntry[]
  actor: string
  name: string
  op: 'add' | 'remove'
}

export interface RoomTokenClaims {
  role: string
  deny: number
}

export interface RoomSocketHandlers {
  onOpen?(): void
  onClose?(): void
  onAck?(ack: AckFrame): void
  onItem?(item: RoomItem): void
  onUpdate?(u: UpdateFrame): void
  onDelete?(d: DeleteFrame): void
  onBump?(b: BumpFrame): void
  onReaction?(r: ReactionFrame): void
  onError?(e: ErrorFrame): void
  onResyncGap?(): void
  // F6: the room token is a base64url JSON payload (server's auth.ts
  // signToken format, unverified here - purely a UI hint) carrying the
  // effective role/deny baked in server-side (permissions.ts) - decoding it
  // client-side lets the compose box front-run a mute instead of only
  // discovering it from a failed send.
  onToken?(claims: RoomTokenClaims): void
}

// decodes the unsigned JSON payload half of a signToken()-issued token
// (server's auth.ts: `${base64url(json)}.${base64url(sig)}`) - no signature
// check, this only ever informs client UI, the server re-checks deny on
// every frame regardless.
export function decodeTokenPayload(token: string): RoomTokenClaims | null {
  try {
    const [payload] = token.split('.')
    if (!payload) return null
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((payload.length + 3) % 4)
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    )
    const claims = JSON.parse(json) as Partial<RoomTokenClaims>
    if (typeof claims.role !== 'string' || typeof claims.deny !== 'number') return null
    return { role: claims.role, deny: claims.deny }
  } catch {
    return null
  }
}

// Shared by the real WS transport (below) and api/mock.ts's in-memory
// stand-in - composables talk to whichever one index.ts wires up without
// caring which it is.
export interface RoomTransport {
  connect(): void
  close(): void
  createItem(clientId: string, kind: 'post' | 'reply', body: Record<string, unknown>, parentSeq?: number | null): boolean
  toggleReaction(targetSeq: number, name: string, op: 'add' | 'remove'): boolean
}

const RECONNECT_DELAY_MS = 1500

// m0-protocol S5.3: a gap this small is worth an inline resync; anything
// bigger means the client fell too far behind and should reload via the
// REST history endpoint instead (see onResyncGap).
export class RoomSocket implements RoomTransport {
  private ws: WebSocket | null = null
  private closed = false
  private lastSeq: number
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly wsPath: string
  private readonly mint: () => Promise<{ token: string }>
  private readonly handlers: RoomSocketHandlers

  constructor(opts: {
    wsPath: string
    mint: () => Promise<{ token: string }>
    initialLastSeq?: number
    handlers: RoomSocketHandlers
  }) {
    this.wsPath = opts.wsPath
    this.mint = opts.mint
    this.lastSeq = opts.initialLastSeq ?? 0
    this.handlers = opts.handlers
  }

  connect(): void {
    this.closed = false
    void this.doConnect()
  }

  private async doConnect(): Promise<void> {
    if (this.closed) return
    let token: string
    try {
      token = (await this.mint()).token
    } catch {
      this.scheduleReconnect()
      return
    }
    if (this.closed) return
    const claims = decodeTokenPayload(token)
    if (claims) this.handlers.onToken?.(claims)

    const url = /^wss?:\/\//.test(this.wsPath) ? this.wsPath : `${wsOrigin()}${this.wsPath}`
    const ws = new WebSocket(url, [token])
    this.ws = ws

    ws.addEventListener('open', () => {
      this.handlers.onOpen?.()
      if (this.lastSeq > 0) this.sendRaw({ type: 'resync', from_seq: this.lastSeq })
    })
    ws.addEventListener('message', (evt) => this.handleMessage(evt))
    ws.addEventListener('close', () => {
      this.handlers.onClose?.()
      if (!this.closed) this.scheduleReconnect()
    })
    // 'close' always follows 'error' for browser WebSocket - reconnection is
    // handled there; this listener only exists so a failed connection
    // doesn't surface as an unhandled event.
    ws.addEventListener('error', () => {})
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.doConnect()
    }, RECONNECT_DELAY_MS)
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }

  createItem(clientId: string, kind: 'post' | 'reply', body: Record<string, unknown>, parentSeq?: number | null): boolean {
    return this.sendRaw({ type: 'item.create', client_id: clientId, kind, parent_seq: parentSeq ?? null, body })
  }

  editItem(targetSeq: number, body: Record<string, unknown>): boolean {
    return this.sendRaw({ type: 'item.update', target_seq: targetSeq, body })
  }

  deleteItem(targetSeq: number, reason?: string): boolean {
    return this.sendRaw({ type: 'item.delete', target_seq: targetSeq, reason })
  }

  toggleReaction(targetSeq: number, name: string, op: 'add' | 'remove'): boolean {
    return this.sendRaw({ type: 'item.reaction', target_seq: targetSeq, name, op })
  }

  private sendRaw(frame: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(frame))
    return true
  }

  private handleMessage(evt: MessageEvent): void {
    if (typeof evt.data !== 'string') return
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(evt.data)
    } catch {
      return
    }

    switch (frame.type) {
      case 'ack':
        if (typeof frame.seq === 'number') this.bumpSeq(frame.seq)
        this.handlers.onAck?.(frame as unknown as AckFrame)
        return
      case 'error':
        this.handlers.onError?.(frame as unknown as ErrorFrame)
        return
      case 'batch': {
        const items = Array.isArray(frame.items) ? (frame.items as Record<string, unknown>[]) : []
        this.checkForGap(items)
        for (const raw of items) this.dispatchItem(raw)
        return
      }
      case 'item.bump':
        this.handlers.onBump?.(frame as unknown as BumpFrame)
        return
      // m0-protocol §3.2a: the actor who just toggled a reaction gets the
      // absolute snapshot pushed straight back, outside any batch - other
      // connections see the same frame shape but nested in a 'batch' below.
      case 'item.reaction':
        this.handlers.onReaction?.(frame as unknown as ReactionFrame)
        return
      case 'resync_gap':
        this.handlers.onResyncGap?.()
        return
      default:
        return
    }
  }

  // Detects a hole between what we already have and what this batch starts
  // with, and asks the server to backfill it - covers frames dropped while
  // briefly disconnected without waiting for a full reconnect cycle.
  private checkForGap(items: Record<string, unknown>[]): void {
    if (this.lastSeq <= 0) return
    const seqs = items.map((i) => i.seq).filter((s): s is number => typeof s === 'number')
    if (seqs.length === 0) return
    const minSeq = Math.min(...seqs)
    if (minSeq > this.lastSeq + 1) {
      this.sendRaw({ type: 'resync', from_seq: this.lastSeq })
    }
  }

  private dispatchItem(raw: Record<string, unknown>): void {
    if (typeof raw.seq === 'number') this.bumpSeq(raw.seq)
    switch (raw.type) {
      case 'item.create':
        this.handlers.onItem?.(raw as unknown as RoomItem)
        return
      case 'item.update':
        this.handlers.onUpdate?.(raw as unknown as UpdateFrame)
        return
      case 'item.delete':
        this.handlers.onDelete?.(raw as unknown as DeleteFrame)
        return
      case 'item.reaction':
        this.handlers.onReaction?.(raw as unknown as ReactionFrame)
        return
      default:
        return
    }
  }

  private bumpSeq(seq: number): void {
    if (seq > this.lastSeq) this.lastSeq = seq
  }
}
