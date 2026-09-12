<script setup lang="ts">
import { computed, ref } from 'vue'
import { EMPTY_STATE } from '../assets/mew'
import { useInstanceConfig } from '../composables/useInstanceConfig'
import { WinButton } from '../vendor/winui'
import CreateStrongholdCard from './CreateStrongholdCard.vue'
import DirectoryModal from './DirectoryModal.vue'

const showDirectory = ref(false)
const { config: instanceConfig } = useInstanceConfig()
const artAssetsEnabled = computed(() => instanceConfig.value?.art_assets_enabled !== false)
</script>

<template>
  <div class="onboarding">
    <div class="onboarding-card">
      <img v-if="artAssetsEnabled" class="onboarding-card__image" :src="EMPTY_STATE.onboarding" alt="" />
      <h1 class="onboarding-card__title">选择你的第一个据点</h1>
      <p class="onboarding-card__hint">加入现有的公开据点，立刻开始聊天和发帖。</p>
      <WinButton Style="AccentButtonStyle" class="onboarding-card__join" @click="showDirectory = true">
        发现并加入据点
      </WinButton>
      <div class="onboarding-card__divider" role="separator"><span>或者创建新据点</span></div>
      <CreateStrongholdCard />
    </div>
    <DirectoryModal :open="showDirectory" @close="showDirectory = false" />
  </div>
</template>

<style scoped>
.onboarding {
  position: relative;
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem 1rem;
}

.onboarding-card {
  width: 100%;
  max-width: 400px;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  padding: 2rem;
  border-radius: var(--radius-md);
  background: var(--card-bg);
  border: 1px solid var(--card-stroke);
  backdrop-filter: blur(24px) saturate(160%);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  box-shadow: var(--shadow-card);
}

.onboarding-card__image {
  width: 96px;
  height: 96px;
  object-fit: contain;
  align-self: center;
}

.onboarding-card__title {
  margin: 0;
  text-align: center;
  font-size: 1.3rem;
  font-weight: 700;
  color: var(--text-primary);
}

.onboarding-card__hint {
  margin: -0.4rem 0 0;
  text-align: center;
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.onboarding-card__join {
  width: 100%;
}

.onboarding-card__divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: var(--text-tertiary);
  font-size: 0.78rem;
}

.onboarding-card__divider::before,
.onboarding-card__divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--stroke-divider);
}

.onboarding-card__divider span {
  white-space: nowrap;
}
</style>
