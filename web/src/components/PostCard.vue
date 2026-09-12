<script setup lang="ts">
import { computed } from 'vue'
import type { PostSummary } from '../api/types'
import { useAuth } from '../composables/useAuth'
import { usePostModal } from '../composables/usePostModal'
import { useInstanceConfig } from '../composables/useInstanceConfig'
import { useStronghold } from '../composables/useStronghold'
import { useStrongholdMembers } from '../composables/useStrongholdMembers'
import { actorLocalpart } from '../utils/actor'
import AvatarBadge from './AvatarBadge.vue'
import AppIcon from './icons/AppIcon.vue'
import ReactionChips from './ReactionChips.vue'

const props = defineProps<{ post: PostSummary }>()
const emit = defineEmits<{ 'toggle-reaction': [name: string] }>()
const { open } = usePostModal()
const { members } = useStrongholdMembers()
const { isReadOnly } = useStronghold()
const auth = useAuth()
const { config: instanceConfig } = useInstanceConfig()
const reactionsEnabled = computed(() => instanceConfig.value?.reactions_enabled !== false)

const authorName = () => members.value.find((m) => m.actor === props.post.actor)?.display_name ?? actorLocalpart(props.post.actor)
const authorAvatar = () => members.value.find((m) => m.actor === props.post.actor)?.avatar ?? undefined

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <article
    class="post-card"
    :class="{ 'post-card--cover': !!post.cover }"
    role="button"
    tabindex="0"
    @click="open(post.post_seq)"
    @keydown.enter="open(post.post_seq)"
    @keydown.space.prevent="open(post.post_seq)"
  >
    <img v-if="post.cover" class="post-card__cover" :src="post.cover" alt="" />
    <div class="post-card__body">
      <h3 class="post-card__title">{{ post.title }}</h3>
      <p class="post-card__preview">{{ post.preview }}</p>
      <div v-if="reactionsEnabled && post.reactions?.entries.length" class="post-card__reactions" @click.stop>
        <ReactionChips :reactions="post.reactions" :can-toggle="reactionsEnabled && auth.isAuthenticated.value && !isReadOnly" @toggle="emit('toggle-reaction', $event)" />
      </div>
      <div class="post-card__meta">
        <span class="post-card__author-group">
          <AvatarBadge :seed="authorName()" :size="24" :avatar-url="authorAvatar()" />
          <span class="post-card__author">{{ authorName() }}</span>
        </span>
        <span class="post-card__time">
          <template v-if="post.reply_count > 0">{{ post.reply_count }} 回复<AppIcon name="dot" :size="4" class="post-card__dot" /></template>{{ formatTime(post.bumped_at) }}
        </span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.post-card {
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  background: var(--card-bg);
  border: 1px solid var(--card-stroke);
  backdrop-filter: blur(20px) saturate(160%);
  -webkit-backdrop-filter: blur(20px) saturate(160%);
  overflow: hidden;
  cursor: pointer;
  transition: background var(--fast-duration) var(--fast-out-slow-in);
}

.post-card:hover {
  background: var(--card-bg-secondary);
}

.post-card:focus-visible {
  outline: 2px solid rgb(var(--colors-primary));
  outline-offset: -2px;
}

.post-card__cover {
  width: 100%;
  height: var(--feed-cover-height);
  object-fit: cover;
}

.post-card__body {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.75rem 0.9rem;
}

.post-card__title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
}

.post-card__preview {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.45;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}


.post-card__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

.post-card__author-group {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.post-card__dot {
  margin: 0 0.3em;
  vertical-align: middle;
}
</style>
