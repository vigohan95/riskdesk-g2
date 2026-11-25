// Browser demo: the unchanged glasses app + the unchanged desk, in one static page (no backend, no install).
//   cd app && npm run web        -> http://127.0.0.1:5180
//   cd app && npm run web:build  -> web/dist (static, e.g. GitHub Pages)
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: here('../web'),
  base: './',
  resolve: {
    alias: [
      { find: /^@evenrealities\/even_hub_sdk$/, replacement: here('../web/src/sdk-shim.ts') },
      { find: /^even-hub-sdk-real$/, replacement: here('./node_modules/@evenrealities/even_hub_sdk/dist/index.js') },
      { find: /^@evenrealities\/pretext$/, replacement: here('./node_modules/@evenrealities/pretext/dist/font_measure.js') },
      { find: /^node:(fs|path|crypto)$/, replacement: here('../web/src/node-stubs.ts') },
    ],
  },
  define: { 'import.meta.env.VITE_RISKDESK_SERVER': JSON.stringify('http://riskdesk.demo') },
  server: { host: '127.0.0.1', port: 5180, strictPort: true, fs: { allow: [here('..')] } },
  build: { target: 'esnext', outDir: here('../web/dist'), emptyOutDir: true },
})
