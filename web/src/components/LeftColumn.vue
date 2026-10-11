<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '../api'
import { DEFAULT_NODE_PAGE_BG, EMPTY_STATE } from '../assets/mew'
import { useAuth } from '../composables/useAuth'
import { useAuthModal } from '../composables/useAuthModal'
import { useInstanceConfig } from '../composables/useInstanceConfig'
import { useSection } from '../composables/useSection'
import { useSectionRoom } from '../composables/useSectionRoom'
import { useStronghold } from '../composables/useStronghold'
import { useStrongholdConfig } from '../composables/useStrongholdConfig'
import { usePostModal } from '../composables/usePostModal'
import { WinButton } from '../vendor/winui'
import ComposePostModal from './ComposePostModal.vue'
import EmptyState from './EmptyState.vue'
import PostCard from './PostCard.vue'

const auth = useAuth()
const { openAuthModal } = useAuthModal()
const { isReadOnly, selectedNodeId } = useStronghold()
const { posts, postsLoading, hasMorePosts, loadMorePosts, postRoom, toggleReaction } = useSectionRoom()
const { sectionRooms, selectedSection, selectSection } = useSection()
const { currentNode } = useStronghold()
const { config } = useStrongholdConfig()
const { config: instanceConfig } = useInstanceConfig()
const { open: openPost } = usePostModal()

const showCompose = ref(false)
const searchOpen = ref(false)
const searchQuery = ref('')
const searchSubmitted = ref(false)
const searchLoading = ref(false)
const searchError = ref('')
const searchResults = ref<Awaited<ReturnType<typeof api.searchRoomHistory>>>([])
const canParticipate = computed(() => auth.isAuthenticated.value && !isReadOnly.value)
const artAssetsEnabled = computed(() => instanceConfig.value?.art_assets_enabled !== false)

const strongholdName = computed(() => config.value?.name ?? currentNode.value?.name ?? '')
const strongholdDescription = computed(() => config.value?.description ?? '')
const strongholdAvatar = computed(() => config.value?.avatar ?? currentNode.value?.avatar ?? null)
const strongholdCover = computed(() => config.value?.cover || currentNode.value?.cover || (artAssetsEnabled.value ? DEFAULT_NODE_PAGE_BG : null))

function openCompose() {
  showCompose.value = true
}

function closeCompose() {
  showCompose.value = false
}

async function searchPosts() {
  const query = searchQuery.value.trim()
  const section = selectedSection.value
  if (!query || !section || !selectedNodeId.value) return
  searchSubmitted.value = true
  searchLoading.value = true
  searchError.value = ''
  try {
    searchResults.value = await api.searchRoomHistory(auth.token.value, selectedNodeId.value, section.id, query)
  } catch {
    searchError.value = '搜索失败，请稍后重试'
    searchResults.value = []
  } finally {
    searchLoading.value = false
  }
}

function toggleSearch() {
  searchOpen.value = !searchOpen.value
  searchError.value = ''
  if (!searchOpen.value) {
    searchQuery.value = ''
    searchResults.value = []
    searchSubmitted.value = false
  }
}

watch([selectedNodeId, selectedSection], () => {
  searchResults.value = []
  searchError.value = ''
  searchSubmitted.value = false
})

watch(searchQuery, () => {
  searchSubmitted.value = false
})

function onSectionKeydown(event: KeyboardEvent, index: number) {
  if (!sectionRooms.value.length) return
  let nextIndex = index
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % sectionRooms.value.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + sectionRooms.value.length) % sectionRooms.value.length
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = sectionRooms.value.length - 1
  else return
  event.preventDefault()
  selectSection(sectionRooms.value[nextIndex]!)
  const target = event.currentTarget as HTMLElement
  target.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus()
}
</script>

<template>
  <aside class="left-column">
    <div class="left-column__stronghold">
      <img v-if="strongholdCover" class="left-column__cover" :src="strongholdCover" :alt="strongholdName" />
      <div class="left-column__stronghold-body">
        <div class="left-column__stronghold-heading">
          <img v-if="strongholdAvatar" class="left-column__avatar" :src="strongholdAvatar" alt="" />
          <h2 class="left-column__stronghold-name">{{ strongholdName }}</h2>
        </div>
        <p class="left-column__stronghold-description">{{ strongholdDescription }}</p>
      </div>
    </div>

    <div class="left-column__header">
      <div class="left-column__toolbar">
        <div class="left-column__section-nav" role="tablist" aria-label="帖子话题组">
          <WinButton
            v-for="(room, index) in sectionRooms"
            :key="room.id"
            :Style="selectedSection?.id === room.id ? 'AccentButtonStyle' : 'DefaultButtonStyle'"
            class="left-column__section-button"
            role="tab"
            :aria-selected="selectedSection?.id === room.id"
            :tabindex="selectedSection?.id === room.id ? 0 : -1"
            :aria-label="`切换到话题组 ${room.name}`"
            :title="room.name"
            @click="selectSection(room)"
            @keydown="onSectionKeydown($event, index)"
          >
            <span class="left-column__section-hash" aria-hidden="true">#</span>
            <span class="left-column__section-label">{{ room.name }}</span>
          </WinButton>
          <WinButton
            v-if="!sectionRooms.length"
            Style="DefaultButtonStyle"
            class="left-column__section-button left-column__section-placeholder"
            role="tab"
            :aria-selected="false"
            :tabindex="-1"
            :IsEnabled="false"
            aria-label="暂无可用话题组"
          >
            <span class="left-column__section-hash" aria-hidden="true">#</span>
            <span class="left-column__section-label">帖子</span>
          </WinButton>
        </div>
        <div class="left-column__toolbar-action">
          <WinButton
            v-if="postRoom"
            Style="DefaultButtonStyle"
            class="left-column__search-toggle"
            :aria-expanded="searchOpen"
            aria-label="搜索当前话题组"
            title="搜索当前话题组"
            @click="toggleSearch"
          >
            <span aria-hidden="true">⌕</span>
          </WinButton>
          <WinButton
            v-if="postRoom && canParticipate"
            Style="AccentButtonStyle"
            class="left-column__compose-btn"
            @click="openCompose"
          >
            发帖
          </WinButton>
          <WinButton v-else-if="postRoom && !auth.isAuthenticated.value" Style="DefaultButtonStyle" class="left-column__compose-btn" @click="openAuthModal">
            登录后发帖
          </WinButton>
          <span v-else-if="postRoom" class="left-column__preview-hint">加入后发帖</span>
        </div>
      </div>
    </div>

    <ComposePostModal :open="showCompose" @close="closeCompose" />

    <form v-if="searchOpen" class="left-column__search" role="search" @submit.prevent="searchPosts">
      <input v-model="searchQuery" type="search" maxlength="200" placeholder="搜索当前话题组" aria-label="搜索帖子内容" />
      <WinButton Style="AccentButtonStyle" :IsEnabled="!!searchQuery.trim() && !searchLoading" type="submit">
        {{ searchLoading ? '搜索中…' : '搜索' }}
      </WinButton>
      <p v-if="searchError" class="left-column__search-state" role="alert">{{ searchError }}</p>
      <p v-else-if="!searchLoading && searchSubmitted && searchResults.length === 0" class="left-column__search-state">没有找到匹配内容</p>
      <button
        v-for="item in searchResults"
        :key="item.seq"
        type="button"
        class="left-column__search-result"
        @click="openPost(item.root_seq || item.seq, item.seq)"
      >
        <span>{{ item.text }}</span>
        <small>{{ new Date(item.ts).toLocaleString() }}</small>
      </button>
      <p v-if="!searchLoading && searchResults.length" class="left-column__search-state">找到 {{ searchResults.length }} 条</p>
    </form>

    <div class="left-column__feed">
      <PostCard
        v-for="post in posts"
        :key="post.post_seq"
        :post="post"
        @toggle-reaction="toggleReaction(post.post_seq, $event)"
      />
      <EmptyState v-if="!posts.length && !postsLoading" :image="artAssetsEnabled ? EMPTY_STATE.posts : null" text="暂无帖子" />
      <div v-if="hasMorePosts" class="left-column__more">
        <WinButton Style="SubtleButtonStyle" :IsEnabled="!postsLoading" @click="loadMorePosts">
          {{ postsLoading ? '加载中…' : '加载更多' }}
        </WinButton>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.left-column {
  flex: 0 0 var(--left-width);
  width: var(--left-width);
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--layer-default);
  backdrop-filter: blur(24px) saturate(160%);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  border-right: 1px solid var(--stroke-divider);
  overflow: hidden;
}

.left-column__header {
  flex: 0 0 auto;
  padding: 0.55rem 0.75rem;
  color: var(--text-primary);
  background: var(--app-bg);
  border-bottom: 1px solid var(--stroke-divider);
}

.left-column__stronghold {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  margin: 0.75rem 0.75rem 0;
  border-radius: var(--radius-sm);
  background: var(--card-bg);
  border: 1px solid var(--card-stroke);
  backdrop-filter: blur(20px) saturate(160%);
  -webkit-backdrop-filter: blur(20px) saturate(160%);
  overflow: hidden;
}

.left-column__cover {
  width: 100%;
  height: 96px;
  object-fit: cover;
}

.left-column__stronghold-body {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.75rem 0.85rem;
}

.left-column__stronghold-heading {
  display: flex;
  align-items: center;
  gap: 0.55rem;
}

.left-column__avatar {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--card-stroke);
}

.left-column__stronghold-name {
  margin: 0;
  font-size: 0.98rem;
  font-weight: 600;
  color: var(--text-primary);
}

.left-column__stronghold-description {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.left-column__toolbar {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 0.45rem;
  min-height: 2rem;
}

.left-column__toolbar-action {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
}

.left-column__search-toggle { width: 2rem; min-width: 2rem; padding-inline: 0; }
.left-column__search { display: flex; flex: 0 0 auto; flex-direction: column; gap: .45rem; padding: .6rem .75rem; border-bottom: 1px solid var(--stroke-divider); background: var(--layer-default); }
.left-column__search input { min-width: 0; padding: .48rem .6rem; border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--control-fill); color: var(--text-primary); font: inherit; }
.left-column__search-state { margin: 0; color: var(--text-tertiary); font-size: .72rem; }
.left-column__search-result { display: flex; flex-direction: column; gap: .25rem; max-height: 7rem; overflow: hidden; padding: .5rem; border: 1px solid var(--card-stroke); border-radius: var(--radius-sm); background: var(--card-bg); color: var(--text-primary); text-align: left; cursor: pointer; }
.left-column__search-result span { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; font-size: .76rem; line-height: 1.4; }
.left-column__search-result small { color: var(--text-tertiary); font-size: .67rem; }

.left-column__compose-btn {
  white-space: nowrap;
  font-size: 0.78rem;
}

.left-column__preview-hint {
  font-size: 0.78rem;
  font-weight: 400;
  color: var(--text-tertiary);
}

.left-column__section-nav {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  gap: 0.35rem;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--ctrl-border) transparent;
  padding: 0.1rem 0;
}

.left-column__section-button {
  flex: 0 0 auto;
  min-width: 0;
  max-width: 12rem;
  min-height: 2.25rem;
  padding: 0.35rem 0.65rem;
  border-radius: 0.25rem;
  font-size: 0.82rem;
  flex-direction: row;
  gap: 0.3rem;
}

.left-column__section-hash {
  display: block;
  flex: 0 0 auto;
  font-size: 1rem;
  line-height: 1;
  font-weight: 700;
}

.left-column__section-label {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.2;
}

.left-column__section-placeholder {
  cursor: default;
}

.left-column__feed {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0 0.75rem 1rem;
  overflow-y: auto;
}

.left-column__more {
  display: flex;
  justify-content: center;
  padding: 0.5rem 0;
}

@media (max-width: 768px) {
  .left-column {
    display: none;
  }

  .shell__body[data-view='posts'] .left-column {
    display: flex;
    flex: 1 1 auto;
    width: 100%;
    min-height: 0;
    border-right: none;
  }

  .left-column__header {
    padding-inline: 0.6rem;
  }

  .left-column__toolbar {
    gap: 0.35rem;
  }

  .left-column__section-button {
    max-width: 9rem;
    padding-inline: 0.55rem;
  }
}
</style>
