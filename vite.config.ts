import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'
import Components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vite'

// 使用 createRequire 读取 package.json，避免额外的 JSON 类型配置
const require = createRequire(import.meta.url)
const packageJson = require('./package.json')

/** 开发服务器代理的目标 Hub，默认指向本机的极简探针 */
const hub = process.env.MONITOR_HUB || 'http://127.0.0.1:28080'

/** 当前 Git commit hash（短格式） */
function getCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  }
  catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig({
  // 定义全局常量，在构建时注入
  define: {
    __BUILD_VERSION__: JSON.stringify(packageJson.version),
    __BUILD_GIT_HASH__: JSON.stringify(getCommitHash()),
  },
  plugins: [
    vue(),
    UnoCSS(),
    AutoImport({
      imports: [
        'vue',
        {
          'naive-ui': [
            'useDialog',
            'useMessage',
            'useNotification',
            'useLoadingBar',
          ],
        },
      ],
    }),
    Components({
      resolvers: [NaiveUiResolver()],
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    // 开发时把接口请求代理到真实的极简探针 Hub，设置 MONITOR_HUB 可指向远端
    proxy: {
      '/api': {
        target: hub,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    // 调整 chunk 大小警告阈值
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // 只拆 vendor，别把 echarts 单独成块：rolldown 会把 @vue/* 运行时与 tslib
        // 一起塞进「echarts」那个块，首屏为了拿到 vue 运行时就得连带下载整包 echarts
        // （611 KB / gzip 214 KB）。交给默认分包后，echarts 只跟着 PingChart / LoadChart
        // 按需加载，首屏不再碰它。
        manualChunks(id) {
          if (id.includes('/node_modules/naive-ui/')) {
            return 'naive-ui'
          }
          if (['/node_modules/vue/', '/node_modules/vue-router/', '/node_modules/pinia/', '/node_modules/@vue/', '/node_modules/tslib/'].some(dependency => id.includes(dependency))) {
            return 'vue-vendor'
          }
          if (id.includes('/node_modules/@vueuse/core/')) {
            return 'vueuse'
          }
          return undefined
        },
      },
    },
  },
})
