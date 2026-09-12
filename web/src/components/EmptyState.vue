<script setup lang="ts">
defineProps<{ image?: string | null; text: string }>()
</script>

<template>
  <div class="empty-state">
    <img v-if="image" class="empty-state__image" :src="image" alt="" />
    <p class="empty-state__text">{{ text }}</p>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  padding: 2rem 1rem;
  text-align: center;
}

.empty-state__image {
  width: 96px;
  height: 96px;
  object-fit: contain;
  opacity: 0.9;
}

.empty-state__text {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-tertiary);
}
</style>
