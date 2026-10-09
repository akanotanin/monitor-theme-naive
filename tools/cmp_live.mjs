// 比「刚打出来的包」与「线上主题目录」：线上是不是我这一份。
//
// 用法：先在那台机器上生成清单，再喂给这个脚本
//   ssh <机> 'T=/opt/monitor/data/themes/naive; find $T -type f -exec sha256sum {} + | sort -k2 | sed "s|  $T/|  |"' > live.sha256
//   node tools/cmp_live.mjs release/naive live.sha256
//
// 线上目录比包内多出来的文件（历次更新留下的老 chunk）是**预期的**：
// 更新走的是逐文件覆盖、不带 --delete，这样老缓存页面仍取得到它引用的旧文件名。
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import process from 'node:process'

const [stage, list] = process.argv.slice(2)
if (!stage || !list)
  throw new Error('用法：node tools/cmp_live.mjs <包内主题目录> <线上 sha256 清单>')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory())
      out.push(...walk(full))
    else if (entry.isFile())
      out.push(full)
  }
  return out
}

const local = new Map()
for (const file of walk(stage)) {
  const rel = relative(stage, file).split(sep).join('/')
  local.set(rel, createHash('sha256').update(readFileSync(file)).digest('hex'))
}

const live = new Map()
for (const line of readFileSync(list, 'utf8').split('\n')) {
  const text = line.trim()
  if (!text)
    continue
  const at = text.search(/\s/)
  if (at < 0)
    continue
  const hash = text.slice(0, at)
  const name = text.slice(at).trim().replace(/^\*/, '')
  if (/^[0-9a-f]{64}$/.test(hash))
    live.set(name, hash)
}

const missing = [...local.keys()].filter(key => !live.has(key))
const differing = [...local.keys()].filter(key => live.has(key) && live.get(key) !== local.get(key))
const extra = [...live.keys()].filter(key => !local.has(key))

console.log(`包内 ${local.size} 个文件 · 线上 ${live.size} 个文件`)
console.log(`线上缺失：${missing.length ? missing.join(', ') : '无'}`)
console.log(`内容不一致：${differing.length ? differing.join(', ') : '无'}`)
console.log(`线上多出来（历次更新留下的老 chunk）：${extra.length} 个`)
if (!extra.every(key => key.startsWith('dist/')))
  console.log(`⚠ 多出来的文件里有非 dist/ 的：${extra.filter(key => !key.startsWith('dist/')).join(', ')}`)
process.exit(missing.length || differing.length || !extra.every(key => key.startsWith('dist/')) ? 1 : 0)
