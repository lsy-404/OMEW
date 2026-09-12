<script setup lang="ts">
import { HOME_UPDATES } from '../content/homeUpdates'
import AppIcon from './icons/AppIcon.vue'

const updateDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
})

function formatUpdateDate(value: string) {
  return updateDateFormatter.format(new Date(`${value}T00:00:00Z`))
}
</script>

<template>
  <section id="landing-updates" class="landing-updates" aria-labelledby="updates-title">
    <div class="landing-updates__inner">
      <header class="landing-updates__heading">
        <div>
          <p class="landing-updates__eyebrow">RECENT UPDATES</p>
          <h2 id="updates-title">最近更新</h2>
          <p>最近写进 OMEW 的变化，都已经抵达这个世界。</p>
        </div>
        <span class="landing-updates__state">
          <span aria-hidden="true" />
          持续更新中
        </span>
      </header>

      <ol class="landing-updates__list">
        <li v-for="update in HOME_UPDATES" :key="update.id" class="landing-update-card">
          <div class="landing-update-card__meta">
            <span>{{ update.category }}</span>
            <time :datetime="update.publishedAt">{{ formatUpdateDate(update.publishedAt) }}</time>
          </div>
          <h3>{{ update.title }}</h3>
          <p>{{ update.summary }}</p>
          <span class="landing-update-card__status">已上线</span>
        </li>
      </ol>

      <aside class="landing-updates__deployment-note" aria-labelledby="deployment-note-title">
        <div>
          <p class="landing-updates__deployment-label">DEPLOY WITH OVERTURE</p>
          <h3 id="deployment-note-title">部署属于自己的 OMEW</h3>
          <p>无需本地工具链。Overture 已预选 OMEW，并会引导你把所需资源部署到自己的 Cloudflare 账户。软件代码使用 AGPL-3.0，官方美术资产遵循独立的非商业使用条款。</p>
        </div>
        <a href="https://overture.lsy-demo.workers.dev/?src=lsy-404%2FOMEW" target="_blank" rel="noopener noreferrer">
          使用 Overture 部署
          <AppIcon name="chevron-right" :size="16" />
        </a>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.landing-updates {
  padding: clamp(3.5rem, 8vw, 7rem) clamp(1.25rem, 6vw, 7rem) clamp(4rem, 9vw, 8rem);
  color: var(--text-primary);
  background:
    radial-gradient(circle at 10% 0%, rgb(var(--colors-primary) / 0.13), transparent 34rem),
    color-mix(in srgb, var(--app-bg) 92%, rgb(var(--colors-primary)) 8%);
  border-top: 1px solid var(--stroke-divider);
}

.landing-updates__inner {
  max-width: 70rem;
  margin-inline: auto;
}

.landing-updates__heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 2rem;
  margin-bottom: 2rem;
}

.landing-updates__heading h2,
.landing-updates__heading p {
  margin: 0;
}

.landing-updates__heading h2 {
  font-size: clamp(1.7rem, 3vw, 2.5rem);
  letter-spacing: -0.035em;
}

.landing-updates__heading > div > p:last-child {
  margin-top: 0.65rem;
  color: var(--text-secondary);
}

.landing-updates__eyebrow {
  margin-bottom: 0.5rem !important;
  color: rgb(var(--colors-primary));
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.16em;
}

.landing-updates__state {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 600;
}

.landing-updates__state > span {
  width: 0.5rem;
  aspect-ratio: 1;
  border-radius: 50%;
  background: #3baa65;
  box-shadow: 0 0 0 0.25rem rgb(59 170 101 / 0.14);
}

.landing-updates__list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.landing-update-card {
  position: relative;
  min-height: 15rem;
  display: flex;
  flex-direction: column;
  padding: 1.35rem;
  overflow: hidden;
  border: 1px solid var(--card-stroke);
  border-radius: var(--radius-md);
  background: var(--card-bg);
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.08);
}

.landing-update-card::before {
  position: absolute;
  inset: 0 0 auto;
  height: 0.2rem;
  content: '';
  background: linear-gradient(90deg, rgb(var(--colors-primary)), rgb(var(--colors-primary) / 0.18));
}

.landing-update-card__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  color: var(--text-tertiary);
  font-size: 0.72rem;
}

.landing-update-card__meta > span {
  color: rgb(var(--colors-primary));
  font-weight: 700;
  letter-spacing: 0.04em;
}

.landing-update-card h3 {
  margin: 2rem 0 0;
  font-size: 1.18rem;
  letter-spacing: -0.015em;
}

.landing-update-card > p {
  margin: 0.75rem 0 0;
  color: var(--text-secondary);
  font-size: 0.9rem;
  line-height: 1.7;
}

.landing-update-card__status {
  align-self: start;
  margin-top: auto;
  padding-top: 1.4rem;
  color: var(--text-tertiary);
  font-size: 0.72rem;
  font-weight: 650;
}

.landing-updates__deployment-note {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2rem;
  margin-top: 1rem;
  padding: clamp(1.25rem, 3vw, 2rem);
  border: 1px solid var(--card-stroke);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--card-bg) 82%, rgb(var(--colors-primary)) 18%);
}

.landing-updates__deployment-label,
.landing-updates__deployment-note h3,
.landing-updates__deployment-note p {
  margin: 0;
}

.landing-updates__deployment-label {
  color: rgb(var(--colors-primary));
  font-size: 0.68rem;
  font-weight: 750;
  letter-spacing: 0.15em;
}

.landing-updates__deployment-note h3 {
  margin-top: 0.45rem;
  font-size: 1.05rem;
}

.landing-updates__deployment-note > div > p:last-child {
  margin-top: 0.45rem;
  color: var(--text-secondary);
  font-size: 0.86rem;
  line-height: 1.6;
}

.landing-updates__deployment-note a {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.35rem;
  padding: 0.65rem 0;
  color: rgb(var(--colors-primary));
  font-size: 0.84rem;
  font-weight: 700;
  text-decoration: none;
}

.landing-updates__deployment-note a:hover { text-decoration: underline; }
.landing-updates__deployment-note a:focus-visible {
  outline: 2px solid rgb(var(--colors-primary));
  outline-offset: 4px;
  border-radius: 3px;
}

@media (max-width: 700px) {
  .landing-updates__heading,
  .landing-updates__deployment-note {
    align-items: start;
    flex-direction: column;
  }

  .landing-updates__list { grid-template-columns: 1fr; }
  .landing-update-card { min-height: 13rem; }
}
</style>
