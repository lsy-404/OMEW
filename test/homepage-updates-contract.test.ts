import { describe, expect, it } from 'vitest'
import landing from '../web/src/components/LandingPage.vue?raw'
import updatesView from '../web/src/components/LandingUpdates.vue?raw'
import { HOME_UPDATES } from '../web/src/content/homeUpdates'

describe('OMEW homepage updates contract', () => {
  it('keeps a curated, newest-first list of shipped updates outside the page template', () => {
    expect(HOME_UPDATES.length).toBeGreaterThanOrEqual(3)
    expect(new Set(HOME_UPDATES.map((update) => update.id)).size).toBe(HOME_UPDATES.length)

    const timestamps = HOME_UPDATES.map((update) => Date.parse(`${update.publishedAt}T00:00:00Z`))
    expect(timestamps.every(Number.isFinite)).toBe(true)
    expect(timestamps).toEqual([...timestamps].sort((left, right) => right - left))

    for (const update of HOME_UPDATES) {
      expect(update.category.trim()).not.toBe('')
      expect(update.title.trim()).not.toBe('')
      expect(update.summary.trim().length).toBeGreaterThan(20)
    }
  })

  it('renders recent updates after the public stronghold directory with semantic dates and status', () => {
    expect(landing).toMatch(
      /import\s+LandingUpdates\s+from\s+['"]\.\/LandingUpdates\.vue['"]/,
    )
    expect(landing.indexOf('<LandingUpdates')).toBeGreaterThan(landing.indexOf('landing-page__directory'))
    expect(updatesView).toMatch(
      /import\s+\{\s*HOME_UPDATES\s*\}\s+from\s+['"]\.\.\/content\/homeUpdates['"]/,
    )
    expect(updatesView).toMatch(/v-for="update in HOME_UPDATES"/)
    expect(updatesView).toMatch(/<time\s+:datetime="update\.publishedAt"/)
    expect(updatesView).toContain('最近更新')
    expect(updatesView).toContain('已上线')
  })

  it('keeps the license boundary while sending visitors to the Overture deployer', () => {
    expect(updatesView).toContain('AGPL-3.0')
    expect(updatesView).toContain('非商业使用条款')
    expect(updatesView).toContain('https://overture.lsy-demo.workers.dev/?src=lsy-404%2FOMEW')
    expect(updatesView).not.toContain('href="https://github.com/wuyilingwei/OMEW"')
  })

  it('adapts the update grid for narrow screens', () => {
    expect(updatesView).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*\.landing-updates__list\s*\{[^}]*grid-template-columns:\s*1fr/)
  })
})
