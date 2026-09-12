import { describe, expect, it } from 'vitest'

import nodeRail from '../web/src/components/NodeRail.vue?raw'
import directoryModal from '../web/src/components/DirectoryModal.vue?raw'

describe('据点导轨公开大厅入口', () => {
  it('将左侧 OMEW logo 暴露为返回首页的链接', () => {
    expect(nodeRail).toContain('href="/"')
    expect(nodeRail).toContain('@click="handleLogoClick"')
    expect(nodeRail).not.toMatch(/node-rail__logo[\s\S]{0,180}@click="showDirectory = true"/)
    expect(nodeRail).toContain('<DirectoryModal :open="showDirectory" @close="showDirectory = false" />')
  })

  it('保留发现与创建据点入口', () => {
    expect(nodeRail).toContain('auth.isAuthenticated.value')
    expect(nodeRail).toContain('title="发现据点"')
    expect(nodeRail).toContain('title="创建据点"')
  })

  it('导轨在桌面端位于 shell 左侧，并保留移动端横向布局', () => {
    expect(nodeRail).toContain('border-right: 1px solid var(--stroke-divider)')
    expect(nodeRail).toContain('flex-direction: row;')
    expect(nodeRail).toContain('overflow-x: auto;')
  })

  it('公开据点大厅左侧优先展示据点 logo，缺失时才显示首字占位', () => {
    expect(directoryModal).toContain('<div class="directory-entry__avatar">')
    expect(directoryModal).toContain('<img v-if="entry.avatar" :src="entry.avatar" :alt="entry.name" />')
    expect(directoryModal).toContain('v-else class="directory-entry__avatar-placeholder"')
    expect(directoryModal).not.toContain('entry.cover')
  })

  it('将公开目录据点头像裁为不会被 flex 布局拉伸的方形', () => {
    expect(directoryModal).toMatch(/\.directory-entry__avatar\s*\{(?=[\s\S]*?flex-shrink:\s*0)(?=[\s\S]*?aspect-ratio:\s*1)/)
    expect(directoryModal).toMatch(/\.directory-entry__avatar img\s*\{[\s\S]*object-fit:\s*cover/)
  })
})
