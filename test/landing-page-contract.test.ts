import { describe, expect, it } from 'vitest'
import assetNotice from '../assets/mew/NOTICE.md?raw'
import app from '../web/src/App.vue?raw'
import assetIndex from '../web/src/assets/mew/index.ts?raw'
import landing from '../web/src/components/LandingPage.vue?raw'
import landingWorld from '../web/src/components/LandingWorld.vue?raw'
import mobileNav from '../web/src/components/MobileNavBar.vue?raw'
import nodeRail from '../web/src/components/NodeRail.vue?raw'
import routeSource from '../web/src/composables/useRoute.ts?raw'
import documentTitleSource from '../web/src/composables/useDocumentTitle.ts?raw'

describe('OMEW landing page contract', () => {
  it('keeps the root landing page independent of authentication and scopes route setup to deep links', () => {
    expect(app).toMatch(/import\s+LandingPage\s+from\s+["']\.\/components\/LandingPage\.vue/)
    expect(app).toMatch(/<LandingPage\b/)
    expect(app).toMatch(/useRoute\s*\(/)
    expect(app).toMatch(/auth\.isAuthenticated\.value/)
    expect(app).toMatch(/guestBrowsingAllowed|guest-browsing-allowed/)
    expect(app).toMatch(/<AuthModal\b/)
    expect(app).not.toMatch(/<AuthModal\b[^>]*(?:v-if|v-else|v-else-if)=/)
    expect(app).toMatch(/routeInstalled/)
    expect(app).toMatch(/isHome\s*=\s*ref\(location\.pathname\s*===\s*['"]\/['"]\)/)
    expect(app).toMatch(/showLanding\s*=\s*computed\(\(\)\s*=>\s*isHome\.value\s*&&\s*!instanceConfigLoading\.value\s*&&\s*!singleMode\.value\)/)
    expect(app).toMatch(/:authenticated="auth\.isAuthenticated\.value"/)
    expect(app).toMatch(/authenticated\s*&&\s*!isHome\.value/)
    expect(app).toMatch(/routeInstalled[\s\S]{0,500}useRoute\s*\(/)
    expect(routeSource).toMatch(/function\s+reconcileFromLiveState\s*\([^)]*\)\s*\{\s*if\s*\(location\.pathname\s*===\s*['"]\/['"]\)\s*return/)
  })

  it('defines the landing-page visual and interaction vocabulary', () => {
    expect(landing).toMatch(/LandingWorld/)
    expect(landing).toMatch(/(?:logoUrl|OMEW Logo)/)
    expect(landing).toMatch(/WinButton/)
    expect(landing).toMatch(/@Click=/)
    expect(landing).toMatch(/(?:登录|注册)/)
    expect(landing).toMatch(/guestBrowsingAllowed|guest-browsing-allowed/)
    expect(landing).toMatch(/浏览公开据点/)
    expect(landing).toMatch(/emit\(['"]authenticate['"]\)/)
    expect(landing).toMatch(/emit\(['"]browse['"],/)
    expect(landing).not.toMatch(/mew-fg|Mew Online/)
  })

  it('contains desktop/narrow-screen and reduced-motion presentation contracts', () => {
    expect(landing).toMatch(/@media\s*\([^)]*(?:max-width|min-width)/)
    expect(landingWorld).toMatch(/@media\s*\([^)]*(?:max-width|min-width)/)
    expect(landingWorld).toMatch(/prefers-reduced-motion\s*:\s*reduce/)
  })

  it('loads the public directory directly below the hero and covers its complete states', () => {
    expect(landing).toMatch(/useStronghold\s*\(\)/)
    expect(landing).toMatch(/publicDirectory:\s*entries/)
    expect(landing).toMatch(/loadPublicDirectory/)
    expect(landing).not.toMatch(/api\.getDirectory\s*\(\)/)
    expect(landing).toContain('正在加载公开据点')
    expect(landing).toContain('无法加载据点目录')
    expect(landing).toContain('还没有公开据点')
    expect(landing).toMatch(/v-for="entry in entries"/)
    expect(landing).toContain('entry.cover')
    expect(landing).toContain('entry.description')
    expect(landing).toContain('entry.member_count')
    expect(landing).toMatch(/class="landing-directory-card"[\s\S]*@click="emit\('browse', entry\.id, entry\.slug\)"/)
  })

  it('owns vertical scrolling because the application shell clips document overflow', () => {
    expect(landing).toMatch(/\.landing-page\s*\{(?=[\s\S]*?height:\s*100%)(?=[\s\S]*?overflow-y:\s*auto)(?=[\s\S]*?overflow-x:\s*hidden)/)
  })

  it('passes the clicked stronghold id and slug into route installation so the chosen card is selected', () => {
    expect(app).toMatch(/function\s+installRoute\s*\(strongholdId\?\s*:\s*string,\s*strongholdSlug\?\s*:\s*string\)/)
    expect(app).toMatch(/if\s*\(strongholdId\)\s*selectNode\(strongholdId\)/)
    expect(app).toMatch(/`\/a\/\$\{encodeURIComponent\(strongholdSlug\)\}`/)
    expect(app).toMatch(/routeController\?\.navigate\(\{\s*server:\s*['"]a['"],\s*slug:\s*strongholdSlug/)
    expect(app).toMatch(/const\s*\{[^}]*selectNode[^}]*\}\s*=\s*useStronghold\s*\(\)/)
  })

  it('keeps every homepage directory avatar in a non-shrinking square crop', () => {
    expect(landing).toMatch(/\.landing-directory-card__avatar\s*\{(?=[\s\S]*?aspect-ratio:\s*1)(?=[\s\S]*?flex-shrink:\s*0)/)
    expect(landing).toMatch(/\.landing-directory-card__avatar img\s*\{[\s\S]*object-fit:\s*cover/)
  })

  it('bundles and exports every licensed home-world layer', () => {
    expect(assetIndex).toContain("import homeWorldUrl from './home-world.jpg'")
    expect(assetIndex).toContain("import homeAtmosphereUrl from './home-atmosphere.png'")
    expect(assetIndex).toContain("import homeCityUrl from './home-city.png'")
    expect(assetIndex).toContain("import homeCloudsUrl from './home-clouds.png'")
    expect(assetIndex).toContain("import homeForegroundUrl from './home-foreground.png'")
    expect(assetIndex).toContain("import homeGlowFarUrl from './home-glow-far.png'")
    expect(assetIndex).toContain("import homeGlowNearUrl from './home-glow-near.png'")
    expect(assetIndex).toContain('export const HOME_WORLD = homeWorldUrl')
    expect(assetIndex).toContain('export const HOME_WORLD_LAYERS')
  })

  it('records the updated official Mew artwork count', () => {
    expect(assetNotice).toMatch(/官方插画（116 张/)
    expect(assetNotice).toContain('官方客户端与站点资源')
  })

  it('reconstructs the eight-depth dream scene with pointer smoothing and passive touch drift', () => {
    expect(landingWorld).toMatch(/v-for="\(layer, index\) in layers"/)
    expect(landingWorld).toContain("key: 'sky'")
    expect(landingWorld).toContain("key: 'atmosphere'")
    expect(landingWorld).toContain("key: 'glow-far'")
    expect(landingWorld).toContain("key: 'glow-near'")
    expect(landingWorld).toContain("key: 'city'")
    expect(landingWorld).toContain("key: 'clouds-far'")
    expect(landingWorld).toContain("key: 'clouds-near'")
    expect(landingWorld).toContain("key: 'foreground'")
    expect(landingWorld).toMatch(/window\.addEventListener\(['"]pointermove['"]/)
    expect(landingWorld).toMatch(/requestAnimationFrame\(animateTowardPointer\)/)
    expect(landingWorld).toMatch(/currentX\s*\+=\s*\(targetX\s*-\s*currentX\)\s*\*\s*ease/)
    expect(landingWorld).toMatch(/landing-glow-clockwise/)
    expect(landingWorld).toMatch(/landing-glow-counterclockwise/)
    expect(landingWorld).toMatch(/landing-touch-drift/)
    expect(landingWorld).toMatch(/pointer:\s*coarse/)
  })

  it('renders atmosphere as the front-most veil over the visual scene', () => {
    const layerKeys = [...landingWorld.matchAll(/key:\s*'([^']+)'/g)].map((match) => match[1])
    expect(layerKeys).toContain('atmosphere')
    const atmosphereIndex = layerKeys.indexOf('atmosphere')
    for (const subject of ['sky', 'clouds-far', 'city', 'clouds-near', 'foreground']) {
      expect(atmosphereIndex).toBeGreaterThan(layerKeys.indexOf(subject))
    }
  })

  it('restores separate far-cloud and near-cloud planes while keeping a front mist veil', () => {
    expect(landingWorld).toMatch(/key:\s*'clouds-far',\s*src:\s*HOME_WORLD_LAYERS\.atmosphere/)
    expect(landingWorld).toMatch(/key:\s*'clouds-near',\s*src:\s*HOME_WORLD_LAYERS\.clouds/)
    expect(landingWorld).toMatch(/clouds-far \.landing-world__art\s*\{[^}]*opacity:\s*0\.66/)
    expect(landingWorld).toMatch(/clouds-near \.landing-world__art\s*\{[^}]*opacity:\s*0\.86/)
    expect(landingWorld).toMatch(/atmosphere \.landing-world__art\s*\{[^}]*opacity:\s*0\.32/)
  })

  it('pulls the city and foreground planes back without flattening their depth order', () => {
    const scaleOf = (key: string) => Number(landingWorld.match(new RegExp(`key: '${key}'[^\\n]*scale: ([0-9.]+)`))?.[1])
    const depthOf = (key: string) => Number(landingWorld.match(new RegExp(`key: '${key}'[^\\n]*depthX: ([0-9.]+)`))?.[1])
    expect(scaleOf('city')).toBeLessThanOrEqual(0.98)
    expect(scaleOf('foreground')).toBeLessThanOrEqual(1.02)
    expect(scaleOf('atmosphere')).toBeLessThanOrEqual(1.04)
    expect(depthOf('clouds-far')).toBeLessThan(depthOf('city'))
    expect(depthOf('city')).toBeLessThan(depthOf('clouds-near'))
    expect(depthOf('clouds-near')).toBeLessThan(depthOf('foreground'))
  })

  it('gives the far and near halos visibly different depth or placement parameters', () => {
    const far = landingWorld.match(/key:\s*'glow-far'[^\n]*/)?.[0] ?? ''
    const near = landingWorld.match(/key:\s*'glow-near'[^\n]*/)?.[0] ?? ''
    expect(far).not.toBe('')
    expect(near).not.toBe('')
    expect(far).not.toBe(near)
    expect(far).toMatch(/depthX|depthY|scale|idleFromX|idleFromY|idleToX|idleToY/)
    expect(near).toMatch(/depthX|depthY|scale|idleFromX|idleFromY|idleToX|idleToY/)
  })

  it('keeps both halo centers aligned across desktop and mobile while separating their radii', () => {
    const desktop = landingWorld.slice(landingWorld.indexOf('.landing-world__layer--glow-far'))
    expect(desktop).toMatch(/\.landing-world__layer--glow-far[^}]*\binset:\s*0/)
    expect(desktop).toMatch(/\.landing-world__layer--glow-near[^}]*\binset:\s*0/)
    const sizes = [...desktop.matchAll(/glow-near \.landing-world__art\s*\{[^}]*width:\s*([^;]+)/g)].map((match) => match[1])
    expect(sizes).toHaveLength(2)
    expect(sizes[0]).not.toBe(sizes[1])
    expect(desktop).toMatch(/glow-near \.landing-world__art\s*\{(?=[^}]*position:\s*absolute)(?=[^}]*top:\s*50%)(?=[^}]*left:\s*50%)(?=[^}]*translate:\s*-50% -50%)/)
    const far = landingWorld.match(/key:\s*'glow-far'[^\n]*/)?.[0] ?? ''
    const near = landingWorld.match(/key:\s*'glow-near'[^\n]*/)?.[0] ?? ''
    const motion = (line: string) => line.match(/depthX:\s*[^,]+|depthY:\s*[^,]+|idle(?:From|To)[XY]:\s*'[^']+'/g)
    expect(motion(far)).toEqual(motion(near))
    expect(landingWorld).toMatch(/glow-far['"]\s*\|\|\s*layer\.key\s*===\s*['"]glow-near/)
  })

  it('shows the landing page only at the root while retaining the application shell for deep links', () => {
    expect(app).toMatch(/isHome\s*=\s*ref\(location\.pathname\s*===\s*['"]\/['"]\)/)
    expect(app).toMatch(/routeInstalled\s*=\s*ref\(!isHome\.value\)/)
    expect(app).toMatch(/(?:AuthGate|shell__body|StrongholdOnboarding)/)
  })

  it('keeps the root page title independent of the selected stronghold', () => {
    expect(app).toMatch(/useDocumentTitle\(isHome\)/)
    expect(documentTitleSource).toMatch(
      /!isHome\?\.value[\s\S]{0,140}`OMEW - \$\{currentName\.value\}`\s*:\s*['"]OMEW['"]/,
    )
  })

  it('makes the desktop logo and mobile home entry return to the root homepage', () => {
    expect(nodeRail).toContain('href="/"')
    expect(nodeRail).toContain('返回 OMEW 首页')
    expect(nodeRail).not.toMatch(/node-rail__logo[\s\S]{0,160}@click="showDirectory\s*=\s*true"/)
    expect(mobileNav).toMatch(/class="mobile-nav__item mobile-nav__item--home"\s+href="\/"/)
    expect(mobileNav).toContain('首页')
    expect(nodeRail).toContain('@click="handleLogoClick"')
    expect(mobileNav).toMatch(/@click\.prevent="navigateHome"/)
    expect(routeSource).toMatch(/(?:export\s+)?function\s+navigateHome\s*\(\)[\s\S]{0,220}history\.pushState\(null,\s*['"]{2},\s*['"]\/['"]\)/)
    expect(routeSource).toMatch(/dispatchEvent\(new PopStateEvent\(['"]popstate['"]\)\)/)
  })

  it('keeps the directory below the first screen and gives each card an exact browse target', () => {
    expect(landing.indexOf('landing-page__directory')).toBeGreaterThan(landing.indexOf('landing-page__hero-screen'))
    expect(landing).toMatch(/\.landing-page\s*\{[\s\S]*overflow-y:\s*auto/)
    expect(landing).toMatch(/@click="emit\(['"]browse['"],\s*entry\.id,\s*entry\.slug\)/)
  })

  it('uses continuation actions instead of login copy for authenticated visitors', () => {
    expect(landing).toMatch(/defineProps<\{[^}]*authenticated[^}]*\}>/)
    expect(landing).toMatch(/authenticated[\s\S]{0,700}(?:进入据点|继续浏览|公开据点)/)
    expect(landing).toMatch(/authenticated[\s\S]{0,700}登录或注册/)
  })

  it('keeps the hero copy explicit about OMEW identity and architecture', () => {
    const hero = landing.slice(0, landing.indexOf('<section class="landing-page__features"'))
    expect(hero).toContain('OMEW')
    expect(hero).toMatch(/Open Member of Excellent World/i)
    expect(hero).toMatch(/MEW.*(?:停止运营|停运)|(?:停止运营|停运).*MEW/)
    expect(hero).toMatch(/(?:完全重写|重写).*继承者|继承者.*(?:完全重写|重写)/)
    expect(hero).toMatch(/高性能/)
    expect(hero).toMatch(/轻架构/)
    expect(hero).toMatch(/去中心化/)
    expect(hero).toMatch(/多服务商互联/)
  })
})
