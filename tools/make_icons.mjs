// 生成主题自带的站点图标：public/apple-touch-icon.png（180×180、不透明）、
// public/apple-touch-icon-precomposed.png（同一张图，老 iOS 走这条路径）、
// 与 public/favicon.ico（16/32/48，透明底）。
//
// 源是 public/favicon.svg —— 与标签页用的是同一份图形，换图标只改那一个文件。
// hub 1.4.0 起，站长没在面板里设图标时这几条路径回落到主题目录里的同名文件，
// 所以它们必须随包分发（iOS 主屏幕图标要 180×180 且不透明，透明的会被填黑）；
// precomposed 那条不带上，老 iOS 会拿到 hub 的 SPA 回落页（200 但是 text/html），图标就是空的。
//
// 用法：node tools/make_icons.mjs [--check]
//   --check 只重新渲染并与已提交的文件比字节，不写入（不一致时退出码 1）
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { openSession } from './cdp.mjs'

const CHECK = process.argv.includes('--check')
const SOURCE = 'public/favicon.svg'
const APPLE = 'public/apple-touch-icon.png'
const PRECOMPOSED = 'public/apple-touch-icon-precomposed.png'
const ICO = 'public/favicon.ico'
const ICO_SIZES = [16, 32, 48]

if (!existsSync(SOURCE))
  throw new Error(`缺少 ${SOURCE}`)

/** 把 favicon.svg 抠成指定边长的一页 HTML（尺寸写在 svg 上，别靠 CSS 缩放） */
function page(svg, size, opaque) {
  const sized = svg.replace(/<!--[\s\S]*?-->/g, '').replace('<svg', `<svg width="${size}" height="${size}"`)
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:${opaque ? '#fff' : 'transparent'}}</style>${sized}`
}

/** 在无头 Chrome 里把一页 HTML 渲染成 PNG 字节 */
async function render(session, svg, size, opaque) {
  await session.send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false })
  await session.send('Emulation.setDefaultBackgroundColorOverride', {
    color: opaque ? { r: 255, g: 255, b: 255, a: 1 } : { r: 0, g: 0, b: 0, a: 0 },
  })
  await session.goto(`data:text/html;charset=utf-8,${encodeURIComponent(page(svg, size, opaque))}`)
  await session.waitFor(`document.readyState === 'complete'`, 10000)
  const shot = await session.send('Page.captureScreenshot', { format: 'png' })
  return Buffer.from(shot.result.data, 'base64')
}

/** 把若干 PNG 拼成一个 ICO（Vista 起容器里直接放 PNG） */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const directory = Buffer.alloc(16 * images.length)
  let cursor = 6 + directory.length
  images.forEach((image, index) => {
    const at = index * 16
    const edge = image.size >= 256 ? 0 : image.size
    directory.writeUInt8(edge, at)
    directory.writeUInt8(edge, at + 1)
    directory.writeUInt8(0, at + 2)
    directory.writeUInt8(0, at + 3)
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(image.data.length, at + 8)
    directory.writeUInt32LE(cursor, at + 12)
    cursor += image.data.length
  })
  return Buffer.concat([header, directory, ...images.map(image => image.data)])
}

/** PNG 头里的宽高（顺便当一次「产物真的是这个尺寸」的断言） */
function pngSize(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504E47)
    throw new Error('产物不是 PNG')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

const session = await openSession({ width: 180, height: 180 })
let apple
let icon
try {
  const svg = readFileSync(SOURCE, 'utf8')

  apple = await render(session, svg, 180, true)
  const size = pngSize(apple)
  if (size.width !== 180 || size.height !== 180)
    throw new Error(`apple-touch-icon 渲染成了 ${size.width}×${size.height}`)

  // iOS 会把透明像素填黑：这一张必须整幅不透明（alpha 全为 255）
  const transparent = await session.evaluate(`(async () => {
    const img = new Image()
    img.src = 'data:image/png;base64,${apple.toString('base64')}'
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let count = 0
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 255)
        count++
    }
    return count
  })()`)
  if (transparent !== 0)
    throw new Error(`apple-touch-icon 有 ${transparent} 个像素不是全不透明`)

  const frames = []
  for (const edge of ICO_SIZES) {
    const png = await render(session, svg, edge, false)
    const got = pngSize(png)
    if (got.width !== edge || got.height !== edge)
      throw new Error(`favicon.ico 的 ${edge} 帧渲染成了 ${got.width}×${got.height}`)
    frames.push({ size: edge, data: png })
  }
  icon = ico(frames)
}
finally {
  session.close()
}

const hash = buffer => createHash('sha256').update(buffer).digest('hex')

if (CHECK) {
  let bad = 0
  for (const [path, produced] of [[APPLE, apple], [PRECOMPOSED, apple], [ICO, icon]]) {
    const same = existsSync(path) && hash(readFileSync(path)) === hash(produced)
    console.log(`${same ? '✔' : '✖'} ${path}${same ? '' : ' 与渲染结果不一致（重跑一次不带 --check 即可更新）'}`)
    if (!same)
      bad++
  }
  process.exitCode = bad ? 1 : 0
}
else {
  writeFileSync(APPLE, apple)
  writeFileSync(PRECOMPOSED, apple)
  writeFileSync(ICO, icon)
  console.log(`✔ ${APPLE} 180×180、不透明（${apple.length} B）`)
  console.log(`✔ ${PRECOMPOSED} 同上（同一份字节）`)
  console.log(`✔ ${ICO} ${ICO_SIZES.join('/')}px（${icon.length} B）`)
}
