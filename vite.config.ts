import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { loadEnv, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vitest/config'
import { buildGamedataPublication, GAMEDATA_MANIFEST_PATH } from './src/data/gamedataPublication.ts'
import { CANONICAL_URL, parseMovedTo } from './src/site.ts'

// Must match the GitHub Pages repo path (https://wuwa-opt.github.io/wuwaC/).
const BASE = '/wuwaC/'

const require = createRequire(import.meta.url)
const TESSERACT_VERSION = (JSON.parse(readFileSync(require.resolve('tesseract.js/package.json'), 'utf8')) as { version: string }).version
/** Versioned so the CacheFirst route below can never mix two releases. */
const OCR_DIR = `ocr/${TESSERACT_VERSION}/`

/**
 * Echo scanner OCR runtime, self-hosted under `<base>ocr/<version>/` so scanning
 * works offline and never touches a CDN (tesseract.js defaults to
 * jsdelivr). Served from node_modules in dev, emitted as assets in build.
 * Only the LSTM core variants are shipped (the scanner runs OEM 1); the
 * browser fetches exactly one of the three. `eng` is the 4.0.0 best_int
 * model the Phase 0 evaluation used (scripts/scan-eval.ts).
 */
const OCR_ASSETS: Record<string, string> = {
  'worker.min.js': require.resolve('tesseract.js/dist/worker.min.js'),
  'tesseract-core-relaxedsimd-lstm.wasm.js': require.resolve('tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js'),
  'tesseract-core-simd-lstm.wasm.js': require.resolve('tesseract.js-core/tesseract-core-simd-lstm.wasm.js'),
  'tesseract-core-lstm.wasm.js': require.resolve('tesseract.js-core/tesseract-core-lstm.wasm.js'),
  'eng.traineddata.gz': require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'),
}

function ocrAssets(): Plugin {
  return {
    name: 'wuwa-ocr-assets',
    configureServer(server) {
      server.middlewares.use(`${BASE}${OCR_DIR}`, (req, res, next) => {
        const source = OCR_ASSETS[(req.url ?? '').replace(/^\//, '').split('?')[0]]
        if (source === undefined) return next()
        res.setHeader('Content-Type', source.endsWith('.gz') ? 'application/octet-stream' : 'text/javascript')
        createReadStream(source).pipe(res)
      })
    },
    generateBundle() {
      for (const [name, source] of Object.entries(OCR_ASSETS)) {
        this.emitFile({ type: 'asset', fileName: `${OCR_DIR}${name}`, source: readFileSync(source) })
      }
    },
  }
}

/**
 * Reviewed game data, published same-origin next to the app (see
 * src/data/gamedataPublication.ts): `gamedata/manifest.json` plus the
 * content-addressed `gamedata/snapshot-<checksum>.json`, both built from the
 * committed snapshot, so `npm run build`/`preview` and the Pages deploy carry
 * them with no extra step. The dev server serves the same two files live.
 * The service worker never caches them (the IndexedDB cache owns game data).
 */
const SNAPSHOT_FILE = fileURLToPath(new URL('./src/data/generated/snapshot.json', import.meta.url))

function gamedataPublication(): Plugin {
  const publish = () => buildGamedataPublication(JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) as unknown)
  return {
    name: 'wuwa-gamedata',
    configureServer(server) {
      server.middlewares.use(`${BASE}gamedata/`, (req, res, next) => {
        const { manifest, payload } = publish()
        const name = `gamedata/${(req.url ?? '').replace(/^\//, '').split('?')[0]}`
        const body = name === GAMEDATA_MANIFEST_PATH ? JSON.stringify(manifest) : name === manifest.path ? payload : null
        if (body === null) return next()
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(body)
      })
    },
    generateBundle() {
      const { manifest, payload } = publish()
      this.emitFile({ type: 'asset', fileName: GAMEDATA_MANIFEST_PATH, source: JSON.stringify(manifest) })
      this.emitFile({ type: 'asset', fileName: manifest.path, source: payload })
    },
  }
}

/**
 * Content-Security-Policy as a <meta> (GitHub Pages can't set headers), added
 * to production builds only: the dev server injects inline scripts/styles
 * (React refresh, HMR) that this policy would block. Meta CSP cannot express
 * `frame-ancestors`, `report-uri` or `sandbox`, so clickjacking protection is
 * not available on this host.
 *
 * - The one inline script (theme bootstrap in index.html) is allowed by
 *   sha256 hash computed here from the emitted HTML, never 'unsafe-inline'.
 * - 'wasm-unsafe-eval' is for the OCR core (WebAssembly.instantiate); its
 *   worker is spawned from a blob: URL that importScripts() the same-origin
 *   runtime under `ocr/`, hence `worker-src blob:`.
 * - connect-src: same-origin only — the game-data refresh reads the
 *   published `gamedata/` files; browsers never call the provider API.
 * - img-src: provider icon CDN (`iconUrl` in the snapshot); other hosts fall
 *   back to the initials badge.
 * - media-src blob: the Echo scanner opens a screen recording the user
 *   picked through an object URL (scanner/videoFrames.ts). No network
 *   media is ever loaded; without it Chromium rejects the load ("Media load
 *   rejected by URL safety check").
 */
const CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' {INLINE_HASHES}",
  "worker-src 'self' blob:",
  "style-src 'self'",
  "img-src 'self' data: blob: https://api.encore.moe",
  "font-src 'self'",
  'media-src blob:',
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
]

function contentSecurityPolicy(): Plugin {
  return {
    name: 'wuwa-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
          (m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`,
        )
        const content = CSP_DIRECTIVES.join('; ').replace('{INLINE_HASHES}', hashes.join(' '))
        return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content }, injectTo: 'head-prepend' }]
      },
    },
  }
}

/**
 * Two deploy modes from one codebase.
 * - Live (default): index.html's canonical / og:url / og:image all come from
 *   `CANONICAL_URL` (src/site.ts), substituted for the SITE_URL placeholder.
 * - Moved: set `VITE_MOVED_TO` (the old repo's deploy does, from a repo
 *   variable) and the app shows a persistent "moved" banner with a backup
 *   export. The value is validated here, so a malformed one fails the build.
 */
function siteMode(): Plugin {
  return {
    name: 'wuwa-site-mode',
    config(_, { mode }) {
      parseMovedTo(loadEnv(mode, process.cwd(), 'VITE_').VITE_MOVED_TO)
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replaceAll('%SITE_URL%', CANONICAL_URL),
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: BASE,
  define: {
    // Consumed by src/scanner/engine.ts (declared in src/vite-env.d.ts).
    __WUWA_OCR_DIR__: JSON.stringify(OCR_DIR),
  },
  plugins: [
    react(),
    tailwindcss(),
    siteMode(),
    ocrAssets(),
    gamedataPublication(),
    contentSecurityPolicy(),
    // Offline support + update prompt for the hosted build. The service
    // worker is build-only (devOptions off), so `npm run dev` and Vitest are
    // unaffected. Game data is deliberately NOT cached here — neither
    // encore.moe art nor the same-origin `gamedata/` publication; the
    // snapshot cache in IndexedDB (data/activeSnapshot.ts) owns game data.
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      devOptions: { enabled: false },
      manifest: {
        name: 'WuWa Optimizer',
        short_name: 'WuWa Opt',
        description: 'Local-first Echo inventory and damage optimizer for Wuthering Waves.',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        background_color: '#fbf4f1',
        theme_color: '#fbf4f1',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,gif,woff2}'],
        // ~7 MB of OCR runtime: never precached (most visitors never scan);
        // cached on first scan by the `wuwa-ocr` route below instead.
        // `gamedata/**` (manifest + payload) is never precached either: the
        // manifest must always come from the network, and the IndexedDB
        // cache owns adopted snapshots. (No runtime route matches it.)
        globIgnores: ['ocr/**', 'gamedata/**'],
        // The game-data snapshot chunk is ~2 MB; precache it so offline works.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Echo scanner OCR runtime (same-origin, version in the path).
            // tesseract.js's own IndexedDB cache is disabled in
            // scanner/engine.ts — its store name is unprefixed.
            urlPattern: ({ url }) => url.pathname.startsWith(`${BASE}ocr/`),
            handler: 'CacheFirst',
            options: {
              cacheName: 'wuwa-ocr',
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 10 },
            },
          },
        ],
      },
    }),
  ],
  build: {
    rolldownOptions: {
      plugins: [
        {
          // src/data/index.ts imports the bundled snapshot as a string
          // (`?raw`) and JSON.parses it: much cheaper at startup than
          // evaluating a multi-MB object literal. The committed file is
          // pretty-printed for reviewable diffs; ship it minified (~2x
          // smaller string). Build-only — dev/tests read the file as-is.
          name: 'wuwa-minify-snapshot-json',
          transform(_code, id) {
            if (!/src[\\/]data[\\/]generated[\\/]snapshot\.json\?raw$/.test(id)) return null
            const minified = JSON.stringify(JSON.parse(readFileSync(id.replace(/\?raw$/, ''), 'utf8')))
            return { code: `export default ${JSON.stringify(minified)}`, map: null }
          },
        },
      ],
      output: {
        // Separate long-lived chunks so a code-only deploy doesn't make
        // returning visitors re-download the multi-MB game-data snapshot
        // (and vice versa for a data-only re-sync).
        codeSplitting: {
          groups: [
            { name: 'snapshot', test: /src[\\/]data[\\/]generated[\\/]/ },
            // tesseract.js (+ its deps) stays out of `vendor`: only the
            // lazily imported scanner engine needs it, so it rides in that
            // chunk and visitors who never scan never download it.
            { name: 'vendor', test: /node_modules[\\/](?!(?:tesseract\.js|bmp-js|idb-keyval|is-url|regenerator-runtime|wasm-feature-detect|zlibjs)[\\/])/ },
          ],
        },
      },
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./src/ui/test-setup.ts'],
        },
      },
    ],
  },
})
