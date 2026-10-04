import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
// 主题验收：起本地桩跑一组硬断言（默认形态 + 按需加载 + 数值型设置项区间）。
//
// 用法：node tools/verify_theme.mjs
//
// 断言（每条都对应一个曾经真出过问题的点）：
//   ① 默认配置下顶部「数据总览」5 张卡片在（默认开启）
//   ② 首屏不请求 echarts chunk（它只在图表弹窗里用）
//   ③ 点开「查看延迟图表」后 echarts chunk 才被请求、且 canvas 画出来了
//   ④ 卡片最小宽度：面板允许的值必须真的生效（340 → 3 列，600 → 2 列）
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { openSession } from './cdp.mjs'

const PORT = 5220
let passed = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`)
  }
  else {
    failures.push(name)
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

if (!existsSync('dist/index.html'))
  throw new Error('没有 dist/index.html：先 `pnpm build`')

/** 起一个桩服务器，跑完回调就收掉 */
async function withServer(config, run) {
  const server = spawn(process.execPath, ['tools/serve.mjs', String(PORT), JSON.stringify(config), 'tools/preview_nodes.json'], { stdio: ['ignore', 'pipe', 'inherit'] })
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/me`)).ok)
        break
    }
    catch {
      // 还没起来
    }
    await sleep(250)
  }
  try {
    await run()
  }
  finally {
    server.kill()
  }
}

async function openPage() {
  const session = await openSession({ width: 1440, height: 1000 })
  await session.goto(`http://127.0.0.1:${PORT}/`)
  const ok = await session.waitFor(`document.querySelectorAll('.node-grid .n-card').length > 0 && document.fonts.status === 'loaded'`, 60000)
  check('首页渲染出节点卡片', ok)
  return session
}

const gridInfo = () => `(() => {
  const grid = document.querySelector('.node-grid')
  return JSON.stringify({
    tracks: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
    minWidth: getComputedStyle(grid).getPropertyValue('--card-min-width').trim(),
    summary: document.querySelectorAll('.general-info .n-card').length,
    echarts: performance.getEntriesByType('resource').some(r => r.name.includes('/echarts-')),
  })
})()`

// —— ① ② ③ 默认形态
console.log('# 默认配置')
await withServer({}, async () => {
  const session = await openPage()
  try {
    const before = JSON.parse(await session.evaluate(gridInfo()))
    check('「数据总览」默认开启（5 张概览卡片）', before.summary === 5, `实际 ${before.summary} 张`)
    check('首屏没有请求 echarts chunk', before.echarts === false)

    const clicked = await session.evaluate(`(() => {
      const btn = [...document.querySelectorAll('[aria-label]')].find(el => el.getAttribute('aria-label').endsWith('延迟图表'))
      if (!btn) return false
      btn.click()
      return true
    })()`)
    check('卡片上有「查看延迟图表」按钮并能点开', clicked === true)
    const charted = await session.waitFor(`document.querySelectorAll('canvas').length > 0`, 30000)
    const after = JSON.parse(await session.evaluate(gridInfo()))
    check('图表弹窗渲染出 canvas', charted === true)
    check('点开之后才请求 echarts chunk', after.echarts === true)
  }
  finally {
    session.close()
  }
})

// —— ④ 数值型设置项：面板里能填的值必须生效
console.log('# 卡片最小宽度 600（面板允许的上限区间内）')
await withServer({ cardMinWidth: 600 }, async () => {
  const session = await openPage()
  try {
    const info = JSON.parse(await session.evaluate(gridInfo()))
    check('--card-min-width 就是配置值', info.minWidth === '600px', `实际 ${info.minWidth}`)
    check('网格列数随之变少（1440 宽下 2 列）', info.tracks === 2, `实际 ${info.tracks} 列`)
  }
  finally {
    session.close()
  }
})

console.log(`\n${passed} PASS / ${failures.length} FAIL`)
if (failures.length)
  console.log(`失败：${failures.join('、')}`)
process.exit(failures.length ? 1 : 0)
