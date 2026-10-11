<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useVoice } from '../composables/useVoice'
import { WinButton } from '../vendor/winui'

const props = defineProps<{ strongholdId: string; roomId: string; roomName: string; origin?: string; sessionToken?: string }>()
const audioRoot = ref<HTMLElement | null>(null)
const voice = useVoice(audioRoot)

function join() {
  void voice.join(props.strongholdId, props.roomId, { origin: props.origin, sessionToken: props.sessionToken })
}

watch(() => [props.strongholdId, props.roomId, props.origin, props.sessionToken], () => { void voice.leave() })
onBeforeUnmount(() => { void voice.leave() })
</script>

<template>
  <section class="voice-panel" aria-label="频道语音">
    <div class="voice-panel__heading">
      <div class="voice-panel__title">
        <strong>语音</strong>
        <span>{{ roomName }}</span>
      </div>
      <span class="voice-panel__state" :class="`voice-panel__state--${voice.state.value}`">
        {{ voice.state.value === 'connected' ? '已连接' : voice.state.value === 'reconnecting' ? '正在重连' : voice.state.value === 'connecting' ? '连接中' : '未加入' }}
      </span>
    </div>

    <div v-if="voice.connected.value" class="voice-panel__content">
      <ul class="voice-panel__participants" aria-label="语音参与者">
        <li v-for="participant in voice.participants.value" :key="participant.identity" :class="{ 'voice-panel__participant--speaking': participant.speaking }">
          <span class="voice-panel__indicator" aria-hidden="true" />
          <span class="voice-panel__participant-name">{{ participant.name }}</span>
          <span v-if="participant.identity === voice.participants.value[0]?.identity" class="voice-panel__you">你</span>
        </li>
      </ul>
      <div class="voice-panel__actions">
        <WinButton v-if="voice.audioBlocked.value" Style="AccentButtonStyle" @click="voice.resumeAudio">开启声音</WinButton>
        <WinButton
          v-if="voice.canPublish.value"
          Style="SubtleButtonStyle"
          :IsEnabled="voice.state.value === 'connected'"
          :aria-label="voice.microphoneEnabled.value ? '静音麦克风' : '开启麦克风'"
          @click="voice.toggleMicrophone"
        >
          {{ voice.microphoneEnabled.value ? '静音' : '开启麦克风' }}
        </WinButton>
        <span v-else class="voice-panel__listen-only">仅可收听</span>
        <WinButton Style="SubtleButtonStyle" class="win-btn--danger" @click="voice.leave">退出语音</WinButton>
      </div>
    </div>

    <div v-else class="voice-panel__join-row">
      <p>加入后可收听此频道的语音</p>
      <WinButton Style="AccentButtonStyle" :IsEnabled="voice.state.value !== 'connecting'" @click="join">
        {{ voice.state.value === 'connecting' ? '连接中…' : '加入语音' }}
      </WinButton>
    </div>

    <p v-if="voice.error.value" class="voice-panel__error" role="status">{{ voice.error.value }}</p>
    <div ref="audioRoot" class="voice-panel__audio" aria-hidden="true" />
  </section>
</template>

<style scoped>
.voice-panel {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.7rem 0.85rem;
  border: 1px solid var(--card-stroke);
  border-radius: var(--radius-sm);
  background: var(--card-bg);
}

.voice-panel__heading,
.voice-panel__title,
.voice-panel__join-row,
.voice-panel__actions {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}

.voice-panel__heading,
.voice-panel__join-row {
  justify-content: space-between;
}

.voice-panel__title { min-width: 0; }
.voice-panel__title span,
.voice-panel__state,
.voice-panel__listen-only { color: var(--text-secondary); font-size: 0.85rem; }
.voice-panel__state--connected { color: var(--accent); }
.voice-panel__join-row p { margin: 0; color: var(--text-secondary); font-size: 0.9rem; }
.voice-panel__content { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.voice-panel__participants { display: flex; flex-wrap: wrap; gap: 0.35rem 0.8rem; list-style: none; margin: 0; padding: 0; }
.voice-panel__participants li { display: inline-flex; align-items: center; min-width: 0; gap: 0.35rem; font-size: 0.9rem; }
.voice-panel__participant-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.voice-panel__indicator { width: 0.5rem; height: 0.5rem; flex: 0 0 auto; border-radius: 50%; background: var(--text-secondary); }
.voice-panel__participant--speaking .voice-panel__indicator { background: var(--accent); box-shadow: 0 0 0 0.2rem color-mix(in srgb, var(--accent) 18%, transparent); }
.voice-panel__you { color: var(--text-secondary); font-size: 0.75rem; }
.voice-panel__actions { flex: 0 0 auto; }
.voice-panel__error { margin: 0; color: var(--danger); font-size: 0.85rem; }
.voice-panel__audio { display: none; }

@media (max-width: 560px) {
  .voice-panel__content { align-items: flex-start; flex-direction: column; }
  .voice-panel__join-row { align-items: flex-start; flex-direction: column; }
}
</style>
