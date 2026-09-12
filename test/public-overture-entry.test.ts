import { describe, expect, it } from 'vitest'

import readme from '../README.md?raw'
import landingUpdates from '../web/src/components/LandingUpdates.vue?raw'

const overtureUrl = 'https://overture.lsy-demo.workers.dev/?src=lsy-404%2FOMEW'

describe('公开 Overture 部署入口', () => {
  it('首页直接打开预选 OMEW 的在线部署器', () => {
    expect(landingUpdates).toContain(`href="${overtureUrl}"`)
    expect(landingUpdates).toContain('使用 Overture 部署')
    expect(landingUpdates).not.toContain('查看项目源码')
    expect(landingUpdates).not.toContain('href="https://github.com/wuyilingwei/OMEW"')
  })

  it('README 使用相同的在线部署入口而不是 Overture 源码仓库', () => {
    expect(readme).toContain(`](${overtureUrl})`)
    expect(readme).not.toContain('https://github.com/wuyilingwei/overture')
    expect(readme).not.toContain('打开你部署的 Overture')
  })
})
