import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'app',
  ignores: [
    '**/dist/**',
    'auto-imports.d.ts',
    'components.d.ts',
    'komari-theme-naive-build-*.zip',
  ],
  typescript: true,
  unocss: true,
  vue: true,
  formatters: {
    css: true,
    html: true,
    markdown: true,
  },
}, {
  // tools/ 是本地的验收/取景脚本（不进主题包）：要往终端打进度、要顶层 await，
  // 这些规则对它们没意义，单独放行。
  name: 'theme-tools',
  files: ['tools/**/*.mjs'],
  rules: {
    'no-console': 'off',
    'antfu/no-top-level-await': 'off',
    'antfu/top-level-function': 'off',
  },
})
