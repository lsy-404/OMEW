import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import { Room, RoomEvent, Track, type Participant, type RemoteTrack } from 'livekit-client'
import { ApiRequestError, api } from '../api'
import { useAuth } from './useAuth'

type VoiceState = 'idle' | 'connecting' | 'connected' | 'reconnecting'

function joinError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'OMEW_VOICE_UNAVAILABLE') return '服务器尚未配置语音服务'
    if (error.code === 'OMEW_ROOM_NOT_FOUND') return '此频道未启用语音，或你无权访问'
    if (error.code === 'OMEW_BANNED' || error.code === 'FORBIDDEN') return '加入据点后才能收听语音'
    if (error.code === 'AUTH_REQUIRED') return '请先登录并加入据点'
  }
  return '加入语音失败，请检查网络后重试'
}

export function useVoice(audioRoot: Ref<HTMLElement | null>) {
  const auth = useAuth()
  const state = ref<VoiceState>('idle')
  const canPublish = ref(false)
  const microphoneEnabled = ref(false)
  const participants = ref<Array<{ identity: string; name: string; speaking: boolean }>>([])
  const error = ref('')
  let activeRoom: Room | null = null
  let operationId = 0
  const audioTracks = new Set<RemoteTrack>()

  const connected = computed(() => state.value === 'connected' || state.value === 'reconnecting')

  function refreshParticipants(room: Room) {
    const speakers = new Set(room.activeSpeakers.map((participant) => participant.identity))
    participants.value = [room.localParticipant, ...room.remoteParticipants.values()].map((participant: Participant) => ({
      identity: participant.identity,
      name: participant.name || participant.identity,
      speaking: speakers.has(participant.identity),
    }))
  }

  function attachAudio(track: RemoteTrack) {
    if (track.kind !== Track.Kind.Audio) return
    const element = track.attach() as HTMLAudioElement
    element.autoplay = true
    element.setAttribute('playsinline', '')
    element.setAttribute('aria-hidden', 'true')
    audioRoot.value?.appendChild(element)
    audioTracks.add(track)
  }

  function detachAudio(track: RemoteTrack) {
    for (const element of track.detach()) element.remove()
    audioTracks.delete(track)
  }

  function bindEvents(room: Room) {
    const updateParticipants = () => refreshParticipants(room)
    room
      .on(RoomEvent.ParticipantConnected, updateParticipants)
      .on(RoomEvent.ParticipantDisconnected, updateParticipants)
      .on(RoomEvent.ActiveSpeakersChanged, updateParticipants)
      .on(RoomEvent.TrackSubscribed, (track) => attachAudio(track))
      .on(RoomEvent.TrackUnsubscribed, (track) => detachAudio(track))
      .on(RoomEvent.Reconnecting, () => { state.value = 'reconnecting' })
      .on(RoomEvent.Reconnected, () => { state.value = 'connected'; refreshParticipants(room) })
      .on(RoomEvent.Disconnected, () => { void cleanup(room, false, '语音连接已断开') })
  }

  async function cleanup(room = activeRoom, disconnect = true, notice = '') {
    if (!room) return
    if (activeRoom === room) {
      operationId += 1
      activeRoom = null
      state.value = 'idle'
      canPublish.value = false
      microphoneEnabled.value = false
      participants.value = []
    }
    room.removeAllListeners()
    for (const track of audioTracks.values()) {
      for (const element of track.detach()) element.remove()
    }
    audioTracks.clear()
    if (disconnect) await room.disconnect(true)
    error.value = notice
  }

  async function join(strongholdId: string, roomId: string, options: { origin?: string; sessionToken?: string } = {}) {
    const token = options.sessionToken ?? auth.token.value
    if (!token || activeRoom || state.value === 'connecting') return
    state.value = 'connecting'
    error.value = ''
    const room = new Room({ adaptiveStream: false, dynacast: false })
    const thisOperation = ++operationId
    activeRoom = room
    bindEvents(room)
    try {
      const audioUnlock = room.startAudio().catch(() => {})
      const credentials = await api.mintVoiceToken(token, strongholdId, roomId, options.origin)
      if (activeRoom !== room || operationId !== thisOperation) return
      canPublish.value = credentials.can_publish
      await room.connect(credentials.url, credentials.token)
      if (activeRoom !== room || operationId !== thisOperation) return
      state.value = 'connected'
      refreshParticipants(room)
      await audioUnlock
      if (credentials.can_publish) await setMicrophone(true)
    } catch (cause) {
      if (activeRoom === room) {
        await cleanup(room, true)
        error.value = joinError(cause)
      }
    }
  }

  async function setMicrophone(enabled: boolean) {
    const room = activeRoom
    if (!room || !connected.value || !canPublish.value) return
    error.value = ''
    try {
      if (enabled) {
        await room.localParticipant.setMicrophoneEnabled(true)
      } else {
        const microphone = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
        if (microphone) await room.localParticipant.unpublishTrack(microphone, true)
      }
      microphoneEnabled.value = enabled
    } catch {
      microphoneEnabled.value = false
      error.value = '麦克风不可用，请检查浏览器权限与设备'
    }
  }

  async function toggleMicrophone() {
    await setMicrophone(!microphoneEnabled.value)
  }

  async function leave() {
    error.value = ''
    await cleanup(activeRoom, true)
  }

  onBeforeUnmount(() => { void leave() })

  return { state, connected, canPublish, microphoneEnabled, participants, error, join, leave, toggleMicrophone }
}
