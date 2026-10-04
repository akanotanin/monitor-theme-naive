// 极简 CDP 会话（无依赖，Node 22+ 自带 WebSocket）：开无头 Chrome、设视口、求值、截图。
//
// 为什么不用 puppeteer：这些脚本只在本地拍图/验收时跑，不想为它多一个几百 MB 的依赖。
// 只做四件事：setViewport / goto / evaluate / screenshot，够用即可。
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

/** Chrome 可执行文件：先看 CHROME_PATH，再按平台常见位置找 */
function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  const found = candidates.find(path => existsSync(path))
  if (!found)
    throw new Error(`找不到 Chrome，可用 CHROME_PATH 指定：试过 ${candidates.join(' / ')}`)
  return found
}

/**
 * 打开一个 CDP 会话
 * @param {{width?: number, height?: number, dpr?: number, mobile?: boolean}} options
 */
export async function openSession(options = {}) {
  const width = options.width ?? 1600
  const height = options.height ?? 1000
  const dpr = options.dpr ?? 1
  const port = 9460 + Math.floor(Math.random() * 200)
  const userDataDir = mkdtempSync(join(tmpdir(), 'monitor-theme-cdp-'))

  const chrome = spawn(chromePath(), [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1600,1000',
    'about:blank',
  ], { stdio: 'ignore' })

  // 等调试端口起来（最多 15 秒）
  let target
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find(item => item.type === 'page')
      if (target)
        break
    }
    catch {
      // 端口还没监听，继续等
    }
    await sleep(250)
  }
  if (!target)
    throw new Error('Chrome 调试端口没起来')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let nextId = 0
  const pending = new Map()
  const issues = []

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
      return
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error')
      issues.push(message.params.entry.text)
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type))
      issues.push(`[${message.params.type}] ${message.params.args.map(a => a.value ?? a.description ?? a.type).join(' ')}`)
    if (message.method === 'Runtime.exceptionThrown')
      issues.push(`[exception] ${message.params.exceptionDetails.text}`)
  })

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

  await new Promise(resolve => ws.addEventListener('open', resolve))
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: Boolean(options.mobile) })

  return {
    send,
    /** 求值（同步值直接返回；页面抛错时返回 null） */
    async evaluate(expression) {
      const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (res.result?.exceptionDetails)
        return null
      return res.result?.result?.value ?? null
    },
    /** 轮询直到表达式为真，返回是否在超时前成立 */
    async waitFor(expression, timeout = 30000) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if ((await this.evaluate(`!!(${expression})`)) === true)
          return true
        await sleep(400)
      }
      return false
    },
    setViewport: (w, h, scale = 1, mobile = false) =>
      send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile }),
    async goto(url) {
      await send('Page.navigate', { url })
    },
    /** 在页面里注入一段 CSS：用来隐藏滚动条、去掉动效等（不进主题代码） */
    async addStyle(css) {
      return this.evaluate(`(() => {
        let el = document.getElementById('__cdp_style__')
        if (!el) { el = document.createElement('style'); el.id = '__cdp_style__'; document.head.appendChild(el) }
        el.textContent = ${JSON.stringify(css)}
        return true
      })()`)
    },
    /** 截图；DPR=2 时得到的像素是视口的 2 倍 */
    async screenshot(path) {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path, Buffer.from(shot.result.data, 'base64'))
      return path
    },
    issues,
    close() {
      try {
        ws.close()
      }
      catch {
        // 已经断了就算了
      }
      chrome.kill()
    },
  }
}
