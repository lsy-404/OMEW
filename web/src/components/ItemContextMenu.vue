<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { BUILTIN_REACTION_SET } from '../assets/mew-emotes'
import { computed } from 'vue'
import { useInstanceConfig } from '../composables/useInstanceConfig'
import { WinMenuFlyout } from '../vendor/winui'

// Right-click/long-press menu shared by chat messages, post bodies and post
// replies (see useContextMenuGesture for the open-gesture wiring). Reactions
// use a compact grid above the labelled commands. Renders through
// WinMenuFlyout's default slot with an empty `Items` array because the grid
// isn't expressible as a flyout item.
const props = defineProps<{ canReact: boolean; canEdit: boolean; canRetract: boolean; mine?: string[] }>()
const emit = defineEmits<{ 'add-reaction': [name: string]; edit: []; retract: [] }>()

const open = ref(false)
const anchorRect = ref<{ top: number; left: number; right: number; bottom: number; width: number; height: number } | null>(null)

const reactionNames = Object.keys(BUILTIN_REACTION_SET)
const { config: instanceConfig } = useInstanceConfig()
const artAssetsEnabled = computed(() => instanceConfig.value?.art_assets_enabled !== false)

function close() {
  open.value = false
}

// WinMenuFlyout estimates its own popup height from `Items` (always [] here,
// since this menu renders through the default slot) and gets it badly wrong
// for the actual content - openAt() below works around that by estimating a
// real size from this component's own CSS metrics and clamping/flipping the
// anchor itself instead of trusting WinMenuFlyout's placement math.
const REACTION_CELL = 32
const REACTION_GAP = 4
const REACTION_PAD = 4 // one side
const NARROW_VIEWPORT = 360
const SEPARATOR_HEIGHT = 9 // 1px rule + 2*4px margin
const LIST_ITEM_HEIGHT = 36 // .win-menu-flyout-item: 32px min-height + 2*2px margin
const CHROME = 16 // WinMenuFlyout's own border + padding around the slot
const MENU_GAP = 6 // matches WinMenuFlyout's default Gap prop
const VIEWPORT_MARGIN = 8
const MIN_WIDTH = 160

function estimateMenuSize(): { width: number; height: number } {
  const commandCount = [props.canEdit, props.canRetract].filter(Boolean).length
  const commandsHeight = commandCount * LIST_ITEM_HEIGHT
  if (!props.canReact) return { width: MIN_WIDTH + CHROME, height: commandsHeight + CHROME }

  const REACTION_COLUMNS = window.innerWidth <= NARROW_VIEWPORT ? 4 : 6
  const reactionRows = Math.ceil(reactionNames.length / REACTION_COLUMNS)
  const gridWidth = REACTION_COLUMNS * REACTION_CELL + (REACTION_COLUMNS - 1) * REACTION_GAP + REACTION_PAD * 2
  const gridHeight = reactionRows * REACTION_CELL + (reactionRows - 1) * REACTION_GAP + REACTION_PAD * 2
  const separator = commandCount > 0 ? SEPARATOR_HEIGHT : 0
  return {
    width: Math.max(MIN_WIDTH, gridWidth) + CHROME,
    height: gridHeight + separator + commandsHeight + CHROME,
  }
}

function openAt(x: number, y: number) {
  if (!props.canReact && !props.canEdit && !props.canRetract) return
  const { width: menuW, height: menuH } = estimateMenuSize()
  const vw = window.innerWidth
  const vh = window.innerHeight

  const desiredLeft = x - menuW / 2
  const clampedLeft = Math.min(Math.max(desiredLeft, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, vw - menuW - VIEWPORT_MARGIN))
  const left = clampedLeft + menuW / 2

  // WinMenuFlyout infers its own up/down direction, and its height guess comes
  // from `Items` - always [] here, so it always concludes "fits below" and then
  // clamps the popup to whatever room is left, scrolling the overflow. Rather
  // than fight that inference, hand it an anchor that is already high enough
  // for the menu to fit below: it opens downward from there, which lands the
  // popup above the pointer when the pointer is near the bottom edge.
  const top = Math.min(y, Math.max(VIEWPORT_MARGIN, vh - menuH - MENU_GAP - VIEWPORT_MARGIN))

  anchorRect.value = { top, left, right: left, bottom: top, width: 0, height: 0 }
  open.value = true
}

function pick(name: string) {
  emit('add-reaction', name)
  close()
}

function onEditClick() {
  emit('edit')
  close()
}

function onRetractClick() {
  emit('retract')
  close()
}

// WinMenuFlyout's own Escape handling only fires from inside its built-in
// Items renderer (unused here, see the note above) - this menu's slot
// content needs its own Escape-to-dismiss independent of focus.
function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') close()
}

watch(open, (value) => {
  if (value) window.addEventListener('keydown', onWindowKeydown)
  else window.removeEventListener('keydown', onWindowKeydown)
})

onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))

defineExpose({ openAt })
</script>

<template>
  <WinMenuFlyout :Open="open" :AnchorRect="anchorRect" :Items="[]" Placement="Bottom" @close="close">
    <div class="item-context-menu">
      <div v-if="canReact" class="item-context-menu__reactions" role="group" aria-label="添加反应">
        <button
          v-for="name in reactionNames"
          :key="name"
          type="button"
          class="item-context-menu__reaction"
          :class="{ 'item-context-menu__reaction--mine': mine?.includes(name) }"
          :title="name"
          @click="pick(name)"
        >
          <img v-if="artAssetsEnabled && BUILTIN_REACTION_SET[name]" :src="BUILTIN_REACTION_SET[name]" :alt="name" />
          <span v-else class="item-context-menu__reaction-fallback">{{ name }}</span>
        </button>
      </div>
      <div v-if="canReact && (canEdit || canRetract)" class="item-context-menu__separator" role="separator"></div>
      <div v-if="canEdit || canRetract" role="menu" class="win-menu-flyout-items">
        <button v-if="canEdit" type="button" class="win-menu-flyout-item" role="menuitem" @click="onEditClick">
          <span class="win-menu-flyout-label">编辑</span>
        </button>
        <button v-if="canRetract" type="button" class="win-menu-flyout-item" role="menuitem" @click="onRetractClick">
          <span class="win-menu-flyout-label">撤回</span>
        </button>
      </div>
    </div>
  </WinMenuFlyout>
</template>

<style scoped>
.item-context-menu {
  min-width: 160px;
  max-width: calc(100vw - 2rem);
}

.item-context-menu__reactions {
  display: grid;
  grid-template-columns: repeat(6, 32px);
  justify-content: center;
  gap: 4px;
  padding: 4px;
}

.item-context-menu__separator {
  height: 1px;
  margin: 4px 0;
  background: var(--stroke-divider);
}

.item-context-menu__reaction {
  width: 32px;
  height: 32px;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  background: transparent;
  transition: background var(--fast-duration) var(--fast-out-slow-in);
}

.item-context-menu__reaction:hover {
  background: var(--ctrl-fill-secondary);
}

.item-context-menu__reaction--mine {
  border-color: rgb(var(--colors-primary));
  background: color-mix(in srgb, rgb(var(--colors-primary)) 16%, transparent);
}

.item-context-menu__reaction img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.item-context-menu__reaction-fallback {
  display: block;
  overflow: hidden;
  font-size: 0.62rem;
  line-height: 1.1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 360px) {
  .item-context-menu__reactions {
    grid-template-columns: repeat(4, 32px);
  }
}
</style>
