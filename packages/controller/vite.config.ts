import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Build for the standalone controller popover.
 *
 * Mirrors packages/ios/vite.config.transcript.ts, which is the proven way to
 * run Nimbalyst's transcript UI outside Electron -- same runtime aliases, same
 * `include` so the runtime's TSX compiles as part of this build.
 *
 * Two deliberate differences from the iOS config: the output stays ES modules
 * (the WKWebView `file://` IIFE workaround is not needed in a Tauri webview,
 * which serves over a real origin), and there is no wkwebview-compat plugin.
 */
export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'automatic',
      include: ['**/*.tsx', '**/*.ts', '**/*.jsx', '**/*.js', '../runtime/**/*.{tsx,ts,jsx,js}'],
    }),
  ],
  resolve: {
    alias: {
      '@nimbalyst/runtime': fileURLToPath(new URL('../runtime/src', import.meta.url)),
      '@nimbalyst/extension-sdk/file-tree': fileURLToPath(
        new URL('../extension-sdk/src/fileDirectoryTree.ts', import.meta.url)
      ),
      '@nimbalyst/extension-sdk': fileURLToPath(new URL('../extension-sdk/src', import.meta.url)),
      // The runtime's transcript parsers import Node's `path`; see src/shims/path.ts.
      path: fileURLToPath(new URL('./src/shims/path.ts', import.meta.url)),
    },
  },
  base: './',
  server: {
    port: 5275,
    // Web Crypto only exists in a secure context, so reaching this dev server
    // from another machine over plain http://<ip> makes pairing fail on
    // `crypto.subtle` being undefined. Tailscale's HTTPS proxy fixes that, and
    // Vite must accept its Host header for the proxy to reach us.
    allowedHosts: ['.ts.net'],
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
