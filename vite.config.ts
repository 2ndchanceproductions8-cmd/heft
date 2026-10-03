import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rolldownOptions: {
      onwarn(warning, warn) {
        // lib/exercises.ts imports the workout store lazily to avoid an import cycle, not to split a chunk.
        if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT' && /workoutStore\.ts is dynamically imported by src\/lib\/exercises\.ts/.test(warning.message)) return;
        warn(warning);
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt': a new version waits until the user reloads (src/lib/pwa.tsx registers the worker and shows
      // the "new version" toast). 'autoUpdate' activated it mid-session and purged the old precache, so the
      // running page's lazy chunks 404'd.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        name: 'Heft — Workout Tracker',
        short_name: 'Heft',
        description: 'Log workouts, routines, PRs, time and calories. Offline-first.',
        theme_color: '#000000',
        // The launch splash stays black for every theme (the manifest is static); index.html applies the
        // saved theme before the first paint.
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell + catalog are precached; the 1,700 exercise frames are cached on first view
        // (Settings → "Download all exercise images" pre-fills that cache for full offline use).
        // wasm = the self-hosted zxing barcode decoder (Food tab), so barcode photos decode offline.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,wasm}'],
        globIgnores: ['ex/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/ex/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'exercise-images',
              expiration: { maxEntries: 4000, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
