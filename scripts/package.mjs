import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import process from 'node:process'

/**
 * 打包极简探针主题包
 * 产物：release/theme.tar.gz（后台「主题 → 上传主题包」直接使用）
 * 结构：theme.json / LICENSE / dist / preview.png
 */
const meta = JSON.parse(readFileSync('theme.json', 'utf8'))
if (!/^[\w-]+$/.test(meta.short))
  throw new Error('Invalid theme short name')
for (const key of ['name', 'description', 'version', 'author', 'url']) {
  if (typeof meta[key] !== 'string' || !meta[key].trim())
    throw new Error(`Missing theme metadata: ${key}`)
}
if (!existsSync('dist/index.html'))
  throw new Error('Missing dist/index.html; run the build first')
if (!existsSync('preview.png'))
  throw new Error('Missing preview.png')

const staging = `release/${meta.short}`
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
for (const file of ['theme.json', 'LICENSE', 'dist'])
  cpSync(file, `${staging}/${file}`, { recursive: true })
cpSync('preview.png', `${staging}/preview.png`)

const archive = 'release/theme.tar.gz'
execFileSync('tar', ['--format=ustar', '-czf', archive, '-C', staging, 'theme.json', 'LICENSE', 'dist', 'preview.png'], {
  env: { ...process.env, COPYFILE_DISABLE: '1' },
})

// 版本化副本，方便手动下载归档
const versioned = `release/monitor-theme-${meta.short}-${meta.version}.tar.gz`
cpSync(archive, versioned)
writeFileSync(`${archive}.sha256`, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${archive.split('/').at(-1)}\n`)

const size = (readFileSync(archive).length / 1024 / 1024).toFixed(2)
console.log(`Theme package: ${archive} (${size} MB)`)
console.log(`Versioned copy: ${versioned}`)
