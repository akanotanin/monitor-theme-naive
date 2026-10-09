// 验收 Monitor Naive 对 hub 1.4.0 的四处适配 + 站点图标（release note 的「第三方主题请适配」那几条）。
//
// 用法：node tools/verify_hub140.mjs
//
// 每条断言都对应一个 hub 1.4.0 真实会变的行为，且**对着本地 dist 跑**（不碰任何线上站点）：
//   ① 推送压缩：带 ?gzip 时收得下二进制 gzip 帧；浏览器不支持（或旧 hub）时收得下文本帧
//   ② 离线时长：按 hub 下发的 last_seen_ago 算 —— 把页面时钟拨快 8 小时，显示仍应为「离线 2 分钟」
//   ③ 站点图标：index.html 引用 /favicon.svg 与 /apple-touch-icon.png；后者 180×180 且不透明
//   ④ 切回前台：隐藏时停止轮询并断开推送，回到前台立刻补拉一次 /api/nodes 并重连
//   ⑤ 历史档位：按 /api/me 的 history_days 生成（30 天保留 → 有「30 天」档，且真的按 720 小时取）
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { openSession } from './cdp.mjs'

const failures = []
let passed = 0

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

/** 夹具：一台在线 + 一台离线（离线那台按 hub 1.4.0 的字段给 last_seen_ago，last_seen 故意差了 8 小时） */
function fixture() {
  const preview = JSON.parse(readFileSync('tools/preview_nodes.json', 'utf8'))
  const base = preview.nodes[0]
  const now = Math.floor(Date.now() / 1000)
  return {
    nodes: [
      { ...base, id: 1, name: '东京 · 在线', online: true, last_seen: now, last_seen_ago: 1 },
      {
        ...base,
        id: 2,
        name: '大阪 · 离线',
        online: false,
        last_seen: now - 8 * 3600,
        last_seen_ago: 120,
        metrics: null,
      },
    ],
  }
}

/** 起桩服务器（每种场景一个端口），跑完回调就收掉 */
async function withServer(port, { config = {}, nodes = { nodes: [] }, extra = {} }, run) {
  const server = spawn(process.execPath, [
    'tools/serve.mjs',
    String(port),
    JSON.stringify(config),
    JSON.stringify(nodes),
    JSON.stringify(extra),
  ], { stdio: ['ignore', 'pipe', 'inherit'] })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/me`)).ok)
        break
    }
    catch {
      // 还没起来
    }
    await sleep(200)
  }
  try {
    await run()
  }
  finally {
    server.kill()
  }
}

const stats = async port => (await (await fetch(`http://127.0.0.1:${port}/__stats`)).json())

/** 开一页（可选：先注入一段脚本，在页面自己的脚本之前执行） */
async function openPage(port, path = '/', prelude = null) {
  const session = await openSession({ width: 1440, height: 1000 })
  if (prelude)
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: prelude })
  await session.goto(`http://127.0.0.1:${port}${path}`)
  return session
}

const body = session => session.evaluate('document.body.innerText')

// —— ① 推送压缩
console.log('# ① 推送帧：gzip 二进制 / 文本')
for (const [port, label, prelude, want] of [
  [5231, '浏览器能解 gzip（带 ?gzip）', null, { title: 'GZIP 帧已应用', gzip: true }],
  [5236, '浏览器不支持 DecompressionStream', 'delete window.DecompressionStream', { title: '文本帧已应用', gzip: false }],
]) {
  await withServer(port, { config: { dataUpdateInterval: 60 }, nodes: fixture(), extra: { push: true } }, async () => {
    const session = await openPage(port, '/', prelude)
    try {
      await session.waitFor(`document.body.innerText.includes('东京')`, 30000)
      const applied = await session.waitFor(`document.body.innerText.includes(${JSON.stringify(want.title)})`, 20000)
      const s = await stats(port)
      check(`${label}：WS 连接形态正确`, s.ws[0]?.gzip === want.gzip, `gzip=${s.ws[0]?.gzip}`)
      check(`${label}：推送帧真的被应用（页面上出现「${want.title}」）`, applied === true, applied ? '' : `当前文本：${(await body(session) || '').slice(0, 80).replace(/\n/g, ' ')}`)
    }
    finally {
      session.close()
    }
  })
}

// —— ② 离线时长按 hub 的时钟
console.log('# ② 离线时长（last_seen_ago）')
const SKEW = 'const __now = Date.now.bind(Date); Date.now = () => __now() + 8 * 3600 * 1000'
for (const [port, label, prelude] of [[5232, '页面时钟正常', null], [5237, '页面时钟快 8 小时', SKEW]]) {
  await withServer(port, { config: { dataUpdateInterval: 60 }, nodes: fixture() }, async () => {
    const session = await openPage(port, '/', prelude)
    try {
      await session.waitFor(`document.body.innerText.includes('大阪')`, 30000)
      const text = await body(session) ?? ''
      check(`${label}：显示 hub 下发的离线时长「离线 2 分钟」`, text.includes('离线 2 分钟'), text.includes('离线 2 分钟') ? '' : `没找到，相关片段：${text.split('\n').filter(l => l.includes('离线')).join(' | ')}`)
      check(`${label}：没有按浏览器时钟算成「8 小时」`, !text.includes('离线 8 小时'))
      check(`${label}：最后在线时间仍在（信息没丢）`, text.includes('最后在线'))
    }
    finally {
      session.close()
    }
  })
}

// —— ③ 站点图标
console.log('# ③ 站点图标')
await withServer(5233, { config: { dataUpdateInterval: 60 }, nodes: fixture() }, async () => {
  const session = await openPage(5233)
  try {
    await session.waitFor(`document.body.innerText.includes('东京')`, 30000)
    const links = await session.evaluate(`JSON.stringify({
      icon: document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? null,
      apple: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? null,
    })`)
    const parsed = JSON.parse(links ?? '{}')
    check('index.html 原样引用 /favicon.svg', parsed.icon === '/favicon.svg', String(parsed.icon))
    check('index.html 引用 /apple-touch-icon.png', parsed.apple === '/apple-touch-icon.png', String(parsed.apple))

    const apple = await session.evaluate(`(async () => {
      const load = async (url) => {
        const img = new Image()
        img.src = url
        try { await img.decode() } catch { return { url, error: '取不到或解不开' } }
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        let transparent = 0
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] !== 255)
            transparent++
        }
        return { url, width: img.width, height: img.height, transparent }
      }
      return JSON.stringify([
        await load('/apple-touch-icon.png'),
        await load('/apple-touch-icon-precomposed.png'),
      ])
    })()`)
    const decoded = JSON.parse(apple ?? '[]')
    check('apple-touch-icon 是 180×180', decoded[0]?.width === 180 && decoded[0]?.height === 180, `${decoded[0]?.width}×${decoded[0]?.height}`)
    check('apple-touch-icon 整幅不透明（iOS 不会填黑）', decoded[0]?.transparent === 0, `${decoded[0]?.transparent} 个透明像素`)
    // 老 iOS 直接来要 precomposed 这一条：主题目录里没有它，hub 会回 SPA 页（200 但是 text/html）
    check('apple-touch-icon-precomposed 也取得到 180×180 不透明', decoded[1]?.width === 180 && decoded[1]?.height === 180 && decoded[1]?.transparent === 0, decoded[1]?.error ?? `${decoded[1]?.width}×${decoded[1]?.height}，透明像素 ${decoded[1]?.transparent}`)
  }
  finally {
    session.close()
  }
})

// ico 与产物落位（不依赖浏览器）
const ico = readFileSync('public/favicon.ico')
const icoCount = ico.readUInt16LE(4)
const icoSizes = []
for (let i = 0; i < icoCount; i++) {
  const at = 6 + i * 16
  const offset = ico.readUInt32LE(at + 12)
  icoSizes.push(`${ico[at]}p${ico.readUInt32BE(offset) === 0x89504E47 ? '(png)' : '(?)'}`)
}
check('favicon.ico 有 16/32/48 三帧且都是 PNG', ico.readUInt16LE(2) === 1 && icoSizes.join(',') === '16p(png),32p(png),48p(png)', icoSizes.join(','))
for (const path of ['dist/favicon.svg', 'dist/favicon.ico', 'dist/apple-touch-icon.png', 'dist/apple-touch-icon-precomposed.png'])
  check(`构建产物里有 ${path}`, existsSync(path))
check('precomposed 那张与 apple-touch-icon 逐字节相同', readFileSync('public/apple-touch-icon-precomposed.png').equals(readFileSync('public/apple-touch-icon.png')))

// —— ④ 切回前台
console.log('# ④ 切回前台')
// 在页面里盯着 WebSocket：桩服务器不回关闭帧，socket.close() 之后浏览器要等自己的超时才发 close 事件，
// 所以「断开」看立刻会变的 readyState（2=CLOSING），「重连」看新建了几条连接
const WS_HOOK = `(() => {
  const Original = window.WebSocket
  window.__wsOpened = 0
  window.__wsList = []
  window.WebSocket = function (...args) {
    const ws = new Original(...args)
    window.__wsOpened += 1
    window.__wsList.push(ws)
    return ws
  }
  window.WebSocket.prototype = Original.prototype
})()`
/** 把页面伪装成切到后台 / 回到前台（headless 里没有真的标签页切换） */
const setHidden = session => session.evaluate(`(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
  return true
})()`)
const setVisible = session => session.evaluate(`(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
  return true
})()`)

// ④a：间隔 3 秒，藏着的时候不该再有人去问 —— 这一段判的是「真的停下来了」
await withServer(5234, { config: { dataUpdateInterval: 3 }, nodes: fixture() }, async () => {
  const session = await openPage(5234)
  try {
    await session.waitFor(`document.body.innerText.includes('东京')`, 30000)
    await sleep(3500)
    const before = await stats(5234)
    check('前台时确实在轮询（3 秒一次）', before.nodes >= 2, `/api/nodes × ${before.nodes}`)
    await setHidden(session)
    await sleep(8000)
    const hidden = await stats(5234)
    check('切到后台后不再轮询', hidden.nodes === before.nodes, `${before.nodes} → ${hidden.nodes}`)
  }
  finally {
    session.close()
  }
})

// ④b：间隔 60 秒 —— 回到前台那一次补拉只可能来自 visibilitychange，不会混进定时轮询
await withServer(5239, { config: { dataUpdateInterval: 60 }, nodes: fixture() }, async () => {
  const session = await openPage(5239, '/', WS_HOOK)
  try {
    await session.waitFor(`document.body.innerText.includes('东京')`, 30000)
    await sleep(1000)
    check('前台时推送连接是开着的', (await session.evaluate('window.__wsList[0]?.readyState')) === 1)

    await setHidden(session)
    await sleep(1500)
    const hidden = await stats(5239)
    check('切到后台后推送连接被断开（不再 OPEN）', (await session.evaluate('window.__wsList[0]?.readyState')) !== 1, `readyState=${await session.evaluate('window.__wsList[0]?.readyState')}`)

    await setVisible(session)
    let resumed = hidden
    for (let i = 0; i < 6 && resumed.nodes === hidden.nodes; i++) {
      await sleep(250)
      resumed = await stats(5239)
    }
    check('回到前台立刻补拉一次 /api/nodes（1.5 秒内，且只补一次）', resumed.nodes === hidden.nodes + 1, `${hidden.nodes} → ${resumed.nodes}`)
    check('回到前台重连推送（新开一条且已连上）', (await session.evaluate('window.__wsOpened')) >= 2 && (await session.evaluate('window.__wsList.at(-1)?.readyState')) === 1)
  }
  finally {
    session.close()
  }
})

// —— ⑤ 历史档位跟着 history_days 走
console.log('# ⑤ 历史档位（history_days）')
for (const [port, label, extra, want] of [
  [5235, 'hub 说保留 30 天', { history_days: 30 }, { has: '30 天', hours: 720 }],
  [5238, '旧 hub 没有 history_days', {}, { has: null, hours: 168 }],
]) {
  await withServer(port, { config: { dataUpdateInterval: 60 }, nodes: fixture(), extra }, async () => {
    const session = await openPage(port, '/instance/1')
    try {
      const ready = await session.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '7 天')`, 30000)
      check(`${label}：负载图表的时间档位出来了`, ready === true)
      const labels = JSON.parse(await session.evaluate(`JSON.stringify([...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /小时|天|实时/.test(t)))`) ?? '[]')
      if (want.has) {
        check(`${label}：档位里有「${want.has}」`, labels.includes(want.has), labels.join(' / '))
      }
      else {
        check(`${label}：档位不超过 7 天`, !labels.some(t => t === '30 天' || t === '90 天'), labels.join(' / '))
      }
      // 真按这个窗口取一次数
      const target = want.has ?? '7 天'
      await session.evaluate(`(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(target)})
        if (btn) btn.click()
        return !!btn
      })()`)
      await sleep(1200)
      const seen = (await stats(port)).metrics
      check(`${label}：切到「${target}」真的按 ${want.hours} 小时取数`, seen.includes(want.hours), `取过的窗口：${seen.join(',')}`)
    }
    finally {
      session.close()
    }
  })
}

console.log(`\n${passed} PASS / ${failures.length} FAIL`)
if (failures.length)
  console.log(`失败：\n  - ${failures.join('\n  - ')}`)
process.exit(failures.length ? 1 : 0)
