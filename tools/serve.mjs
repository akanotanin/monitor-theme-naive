// 本地静态伺服：仓库 dist/ 走本机，/api/* 全部桩掉，含 WebSocket 握手。
//
// 用法：node tools/serve.mjs [端口=5200] [config JSON 或文件] [nodes JSON 或文件]
//   node tools/serve.mjs 5200
//   node tools/serve.mjs 5200 '{"cardMinWidth":600}'
//   node tools/serve.mjs 5200 '' tools/preview_nodes.json
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

const PORT = Number(process.argv[2] || 5200)
const CONFIG = readJsonArg(process.argv[3], {})
const NODES = readJsonArg(process.argv[4], { nodes: [] })

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

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  if (path === '/api/ws' && String(req.headers.upgrade || '').toLowerCase() === 'websocket') {
    const key = req.headers['sec-websocket-key'] || ''
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    res.writeHead(101, { 'Upgrade': 'websocket', 'Connection': 'Upgrade', 'Sec-WebSocket-Accept': accept })
    const keep = setInterval(() => {
      try {
        res.socket.write(Buffer.from([0x89, 0x00]))
      }
      catch {
        clearInterval(keep)
      }
    }, 5000)
    req.socket.on('close', () => clearInterval(keep))
    return
  }

  if (path.startsWith('/api/')) {
    const body
      = path === '/api/me'
        ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: 'Monitor' }
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

  // 静态资源；未知路径回落 index.html（与 hub 的 SPA 行为一致）
  const file = path === '/' ? '/index.html' : path
  const full = join('dist', normalize(file).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(full) || statSync(full).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(full))
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[serve] http://127.0.0.1:${PORT}  config=${JSON.stringify(CONFIG)}  nodes=${(NODES.nodes ?? []).length} 台`)
})
