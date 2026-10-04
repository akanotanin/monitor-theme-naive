import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
// 拍主题预览图（preview.png）：起本地桩 → 无头 Chrome 截默认形态 → 打印几何判据。
//
// 用法：node tools/shot_preview.mjs [--write] [宽=1600] [高=1000] [DPR=2] [config JSON] [输出路径=shots/preview.png]
//   node tools/shot_preview.mjs                       # 拍一张候选图到 shots/
//   node tools/shot_preview.mjs --write               # 顺便覆盖仓库根的 preview.png
//   node tools/shot_preview.mjs --write 1600 1000 2 '{"showGeneralCards":true}'
//
// 三个「不这么干就会翻车」的点：
//   1. 滚动条要藏：页面 main 是 min-h-screen，头部又占 64px，所以页面总比视口高一点点 ——
//      不藏的话预览图右缘会带一条滚动条（这是站长会直接指出来的瑕疵）。
//      藏法是在页面里注入 CSS（不进主题代码），并用 clientWidth == innerWidth 断言「真的没画出来」。
//   2. 等条件而不是 sleep：卡片出现 + 字体 loaded + 进度条已有宽度；之后再多等一个轮询周期（默认 3.5s），
//      否则拍到的可能是刚渲染、数值还没刷新的样子。
//   3. 拍完要量：最后一张卡片的底边必须小于视口高度（不然就是裁到了内容），留白过大也要说一声。
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { openSession } from './cdp.mjs'

const args = process.argv.slice(2)
const write = args.includes('--write')
const positional = args.filter(arg => arg !== '--write')
const width = Number(positional[0] || 1600)
const height = Number(positional[1] || 1000)
const dpr = Number(positional[2] || 2)
const config = positional[3] || '{}'
const outPath = positional[4] || 'shots/preview.png'
const PORT = 5210

if (!existsSync('dist/index.html'))
  throw new Error('没有 dist/index.html：先 `pnpm build`')

mkdirSync('shots', { recursive: true })

const server = spawn(process.execPath, ['tools/serve.mjs', String(PORT), config, 'tools/preview_nodes.json'], { stdio: ['ignore', 'pipe', 'inherit'] })
server.stdout.on('data', data => process.stdout.write(`${data}`))

let session
try {
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

  session = await openSession({ width, height, dpr })
  await session.goto(`http://127.0.0.1:${PORT}/`)

  const ready = await session.waitFor(
    `document.querySelectorAll('.node-grid .n-card').length > 0
      && document.fonts.status === 'loaded'
      && document.querySelectorAll('.n-progress').length > 0`,
    60000,
  )
  if (!ready)
    console.warn('⚠ 就绪条件超时，拍出来的图不能当证据')

  await sleep(3500) // 一个轮询周期（dataUpdateInterval 默认 3s），让读数落到最终值

  // 藏滚动条（只影响这张图，不改主题代码）
  await session.addStyle('html{scrollbar-width:none}::-webkit-scrollbar{display:none}')
  await sleep(300)

  const metrics = await session.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.node-grid .n-card')]
    const grid = document.querySelector('.node-grid')
    return {
      summaryCards: document.querySelectorAll('.general-info .n-card').length,
      nodeCards: cards.length,
      columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
      minWidth: grid ? getComputedStyle(grid).getPropertyValue('--card-min-width').trim() : '',
      lastCardBottom: Math.round(Math.max(...cards.map(card => card.getBoundingClientRect().bottom))),
      scrollHeight: document.body.scrollHeight,
      scrollbarHidden: document.documentElement.clientWidth === window.innerWidth,
      fonts: document.fonts.status,
    }
  })()`)

  const saved = await session.screenshot(outPath)
  const size = statSync(saved).size

  console.log(`\n📷 ${saved}（${Math.round(size / 1024)} KB，视口 ${width}x${height}@${dpr} → 图 ${width * dpr}x${height * dpr}）`)
  console.log(`   概览卡片 ${metrics.summaryCards} 张 / 节点卡片 ${metrics.nodeCards} 张 / ${metrics.columns} 列（最小宽度 ${metrics.minWidth}）`)
  console.log(`   内容底边 ${metrics.lastCardBottom}px vs 视口 ${height}px（留白 ${height - metrics.lastCardBottom}px）· 字体 ${metrics.fonts}`)
  console.log(`   滚动条：${metrics.scrollbarHidden ? '已隐藏（clientWidth == innerWidth）' : '⚠ 还在（clientWidth != innerWidth）'}`)
  if (metrics.lastCardBottom > height)
    console.warn('⚠ 内容被视口裁掉了：把高度调大或减少节点数后重拍')
  if (size < 40 * 1024)
    console.warn('⚠ 图只有几十 KB，八成是空白/骨架屏，别当证据用')
  if (!metrics.scrollbarHidden)
    console.warn('⚠ 滚动条没藏住')

  if (write) {
    copyFileSync(saved, 'preview.png')
    console.log('   → 已覆盖仓库根 preview.png')
  }
  if (session.issues.length)
    console.log(`   控制台报错/警告 ${session.issues.length} 条：\n     ${session.issues.slice(0, 5).join('\n     ')}`)
}
finally {
  session?.close()
  server.kill()
}
