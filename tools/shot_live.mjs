// 对着**线上 hub**（或隧道里的那台）拍一张并读一组 DOM 事实：装的是不是这一版、图标取得到取不到。
// 用法：node tools/shot_live.mjs <baseUrl> <输出.png> [宽=1440] [高=1000] [DPR=1]
//   node tools/shot_live.mjs http://127.0.0.1:7980 shots/live.png
//   node tools/shot_live.mjs https://<域名> shots/live.png 390 844 2
//
// 与 shot_preview.mjs 的分工：那个起本地桩拍「仓库里这一版长什么样」，
// 这个打真站、回答「那台机器上现在跑的到底是不是我刚构建的这一份」。
import { mkdirSync, statSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { openSession } from './cdp.mjs'

const base = (process.argv[2] || 'http://127.0.0.1:7980').replace(/\/$/, '')
const out = process.argv[3] || 'shots/live.png'
const width = Number(process.argv[4] || 1440)
const height = Number(process.argv[5] || 1000)
const dpr = Number(process.argv[6] || 1)

mkdirSync(out.split('/').slice(0, -1).join('/') || '.', { recursive: true })

const session = await openSession({ width, height, dpr })
try {
  const head = await fetch(`${base}/`).then(r => r.text()).catch(() => '')
  const chunks = [...head.matchAll(/\/assets\/([\w.-]+\.js)/g)].map(m => m[1])
  console.log(`入口 chunk：${chunks.slice(0, 3).join(' / ') || '（没读到）'}`)

  await session.goto(`${base}/`)
  const ready = await session.waitFor(`document.querySelectorAll('.node-grid .n-card').length > 0 && document.fonts.status === 'loaded'`, 60000)
  if (!ready)
    console.warn('⚠ 就绪条件超时（卡片没出来），拍出来的图不能当证据')
  await sleep(3500)

  const facts = await session.evaluate(`(async () => {
    const probe = async (url) => {
      try {
        const r = await fetch(url, { cache: 'no-store' })
        return { url, status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength }
      }
      catch (e) { return { url, error: String(e) } }
    }
    return JSON.stringify({
      title: document.title,
      nodeCards: document.querySelectorAll('.node-grid .n-card').length,
      summaryCards: document.querySelectorAll('.general-info .n-card').length,
      icon: document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? null,
      apple: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? null,
      offline: document.body.innerText.includes('节点已离线'),
      icons: [await probe(new URL(document.querySelector('link[rel="icon"]').href).pathname),
              await probe(new URL(document.querySelector('link[rel="apple-touch-icon"]').href).pathname)],
    })
  })()`)
  const data = JSON.parse(facts ?? '{}')
  console.log(`标题 ${data.title} · 节点卡片 ${data.nodeCards} 张 · 概览 ${data.summaryCards} 张`)
  console.log(`标签页图标 ${data.icon} · iOS 图标 ${data.apple}`)
  for (const icon of data.icons ?? [])
    console.log(`  ${icon.url} → ${icon.status} ${icon.type} ${icon.bytes} B${icon.error ? ` (${icon.error})` : ''}`)

  const saved = await session.screenshot(out)
  console.log(`📷 ${saved}（${Math.round(statSync(saved).size / 1024)} KB，视口 ${width}x${height}@${dpr}）`)
  if (session.issues.length)
    console.log(`控制台报错/警告 ${session.issues.length} 条：\n  ${session.issues.slice(0, 5).join('\n  ')}`)
}
finally {
  session.close()
}
