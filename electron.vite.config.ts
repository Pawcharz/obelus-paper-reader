import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { cpSync, existsSync } from 'node:fs'

/**
 * PDF.js needs these at runtime for some papers: character maps, standard fonts, colour profiles,
 * and `wasm/`, its decoders for scanned pages (JBIG2, JPEG 2000). Without `wasm/` a scanned paper
 * shows blank pages.
 */
function copyPdfAssets() {
  return {
    name: 'copy-pdf-assets',
    buildStart() {
      for (const d of ['cmaps', 'standard_fonts', 'iccs', 'wasm']) {
        const to = resolve(__dirname, 'src/renderer/public/pdfjs', d)
        if (!existsSync(to)) cpSync(resolve(__dirname, 'node_modules/pdfjs-dist', d), to, { recursive: true })
      }
    }
  }
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [copyPdfAssets(), react()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
