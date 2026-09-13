import { describe, expect, it } from 'vitest'
import useEmotes from '../web/src/composables/useEmotes.ts?raw'
import itemContextMenu from '../web/src/components/ItemContextMenu.vue?raw'
import reactionChips from '../web/src/components/ReactionChips.vue?raw'

describe('built-in emote and reaction resource switches', () => {
  it('loads the two bundled packs independently of general art assets', () => {
    expect(useEmotes).toContain('builtin_emotes_enabled')
    expect(useEmotes).toContain('reactions_enabled !== false && instanceConfig.value?.builtin_reactions_enabled !== false')
    expect(useEmotes).not.toContain('art_assets_enabled')
    expect(useEmotes).toContain('builtinReactionsEnabled.value ? [BUILTIN_REACTION_PACK]')
    expect(useEmotes).toContain('builtinEmotesEnabled.value ? [BUILTIN_EMOTE_PACK]')
  })

  it('keeps the reaction control separate from bundled reaction imagery', () => {
    expect(itemContextMenu).toContain('reactions_enabled !== false && instanceConfig.value?.builtin_reactions_enabled !== false')
    expect(reactionChips).toContain('reactions_enabled !== false && instanceConfig.value?.builtin_reactions_enabled !== false')
    expect(reactionChips).not.toContain('art_assets_enabled')
  })
})
