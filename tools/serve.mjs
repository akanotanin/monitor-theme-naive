// 本地静态伺服：仓库 dist/ 走本机，/api/* 全部桩掉，含 WebSocket 握手与（可选）推送帧。
//
// 用法：node tools/serve.mjs [端口=5200] [config JSON 或文件] [nodes JSON 或文件] [extra JSON 或文件]
//   node tools/serve.mjs 5200
//   node tools/serve.mjs 5200 '{"cardMinWidth":600}'
//   node tools/serve.mjs 5200 '' tools/preview_nodes.json
//   node tools/serve.mjs 5200 '' '' '{"history_days":30,"push":true}'
//
// extra 里的两项是给 hub 1.4.0 的验收用的：
//   history_days —— /api/me 里下发（不传就当作旧 hub：没有这个字段）
//   push         —— WS 连上后推一帧；带 ?gzip 的连推 gzip 二进制帧，否则推文本帧（hub 1.4.0 的行为）
// 另外 /__stats 回一份请求计数（轮询次数、WS 连接与是否带 gzip、请求过的历史窗口、静态路径），
// 验收脚本靠它判断「切到后台真的不再轮询」这类行为。
//
// 为什么自己桩 WebSocket：只桩 REST 的话页面顶部会挂「实时连接中断，正在尝试重连」，
// 拍进预览图里会被当成主题的毛病（而它自己会消失，早晚两张图还不一样）。
// 握手成功后不推任何数据即可——主题本来就把 /api/nodes 轮询当兜底，数据照常刷新。
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import process from 'node:process'
import { gzipSync } from 'node:zlib'

const PORT = Number(process.argv[2] || 5200)
const CONFIG = readJsonArg(process.argv[3], {})
const NODES = readJsonArg(process.argv[4], { nodes: [] })
const EXTRA = readJsonArg(process.argv[5], {})

/** 验收脚本读的请求计数 */
const stats = { nodes: 0, metrics: [], ws: [], paths: [], nodeTimes: [] }

/** 一帧 WebSocket 消息（服务端发出的帧不加掩码） */
function wsFrame(payload, opcode) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  }
  else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  }
  else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/** 推送帧里的节点：沿用桩数据的第一台，只把名字换成能一眼认出「这一帧真的被应用了」的标记 */
function pushedNodes(name) {
  const first = NODES.nodes?.[0] ?? { id: 1, name: '桩节点', online: true, metrics: null }
  return [{ ...first, name }]
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

function readJsonArg(arg, fallback) {
  if (!arg)
    return fallback
  return existsSync(arg) ? JSON.parse(readFileSync(arg, 'utf8')) : JSON.parse(arg)
}

/** 历史窗口：给图表一点形状（1 小时、两条线路），免得图是空的 */
function historyWindow() {
  const now = Math.floor(Date.now() / 1000)
  const window = { metrics: [], ping: [], probes: { 1: '电信', 2: '联通' }, loss: { 1: 0, 2: 0 } }
  for (let i = 60; i > 0; i--) {
    const ts = now - i * 60
    window.metrics.push({ ts, cpu: 10 + (i % 7), mem_used: 1073741824 + i * 1000, disk_used: 10737418240, net_rx: 524288 + i, net_tx: 131072 + i })
    window.ping.push({ ts, task_id: 1, latency: 20 + (i % 11), loss: 0 })
    window.ping.push({ ts, task_id: 2, latency: 30 + (i % 17), loss: 0 })
  }
  return window
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  if (path === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(stats))
  }

  if (path.startsWith('/api/')) {
    if (path === '/api/nodes') {
      stats.nodes += 1
      stats.nodeTimes.push(Date.now())
    }
    if (/^\/api\/nodes\/\d+\/metrics$/.test(path))
      stats.metrics.push(Number(url.searchParams.get('hours')))
    const body
      = path === '/api/me'
        ? {
            authed: false,
            github: false,
            public_page: true,
            site: `http://127.0.0.1:${PORT}`,
            site_name: 'Monitor',
            ...(typeof EXTRA.history_days === 'number' ? { history_days: EXTRA.history_days } : {}),
          }
        : path === '/api/nodes'
          ? { nodes: NODES.nodes ?? [], admin: false }
          : /^\/api\/nodes\/\d+\/metrics$/.test(path)
            ? historyWindow()
            : path.endsWith('/config')
              ? CONFIG
              : path === '/api/version'
                ? { version: '1.3.2' }
                : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }

  stats.paths.push(path)

  // 静态资源；未知路径回落 index.html（与 hub 的 SPA 行为一致）
  const file = path === '/' ? '/index.html' : path
  const full = join('dist', normalize(file).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(full) || statSync(full).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(full))
})

/**
 * WebSocket 升级只在这里处理：Node 的 http server 在没有 'upgrade' 监听器时
 * 会直接把带 Upgrade 头的连接掐掉（客户端报 1006、拿不到任何响应），
 * 所以以前写在 'request' 分支里那份握手其实从来没成立过。
 */
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (url.pathname !== '/api/ws') {
    socket.destroy()
    return
  }
  const key = req.headers['sec-websocket-key'] || ''
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  // hub 1.4.0：带 ?gzip 就推 gzip 二进制帧，不带（旧 hub / 旧浏览器）就推文本帧
  const wantsGzip = url.searchParams.has('gzip')
  stats.ws.push({ gzip: wantsGzip })
  let push = null
  if (EXTRA.push) {
    push = setTimeout(() => {
      const payload = JSON.stringify({ nodes: pushedNodes(wantsGzip ? 'GZIP 帧已应用' : '文本帧已应用'), admin: false })
      try {
        socket.write(wsFrame(wantsGzip ? gzipSync(payload) : Buffer.from(payload, 'utf8'), wantsGzip ? 2 : 1))
      }
      catch {
        // 连接已经断了就算了
      }
    }, 1200)
  }
  const keep = setInterval(() => {
    try {
      socket.write(Buffer.from([0x89, 0x00]))
    }
    catch {
      clearInterval(keep)
    }
  }, 5000)
  socket.on('close', () => {
    clearInterval(keep)
    if (push)
      clearTimeout(push)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve] http://127.0.0.1:${PORT}  config=${JSON.stringify(CONFIG)}  nodes=${(NODES.nodes ?? []).length} 台`)
})
