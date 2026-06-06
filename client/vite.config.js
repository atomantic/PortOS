import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ANALYZE_BUNDLE = process.env.ANALYZE === 'true';

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

// Dev proxy target: probe for the self-signed/LE cert under data/certs/. If the
// server is running HTTPS, the dev proxy must target HTTPS too (or requests
// through Vite return "socket hang up"). `secure: false` accepts the cert
// whether it's the trusted LE one or the self-signed fallback.
const CERT_PATH = resolve(__dirname, '..', 'data', 'certs', 'cert.pem');
const API_SCHEME = existsSync(CERT_PATH) ? 'https' : 'http';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const API_HOST = env.VITE_API_HOST || 'localhost';
  const API_TARGET = `${API_SCHEME}://${API_HOST}:5555`;

  return {
    define: {
      __APP_VERSION__: JSON.stringify(rootPkg.version)
    },
    plugins: [
      react(),
      ANALYZE_BUNDLE && visualizer({
        filename: 'dist/bundle-report.html',
        gzipSize: true,
        brotliSize: true,
        template: 'treemap',
      }),
    ].filter(Boolean),
    server: {
      host: '0.0.0.0',
      port: 5554,
      // Fail loudly if 5554 is taken instead of auto-incrementing. Without this,
      // Vite walks up to the next free port and can land on a reserved PortOS
      // port (5555 API, 5556 browser CDP) — squatting on the CDP port makes the
      // browser keep-alive read Vite's HTML index and spam JSON-parse errors.
      strictPort: true,
      open: false,
      allowedHosts: ['.ts.net', 'localhost'],
      proxy: {
        '/api': {
          target: API_TARGET,
          changeOrigin: true,
          secure: false
        },
        '/data/images': {
          target: API_TARGET,
          changeOrigin: true,
          secure: false
        },
        '/data/videos': {
          target: API_TARGET,
          changeOrigin: true,
          secure: false
        },
        '/data/video-thumbnails': {
          target: API_TARGET,
          changeOrigin: true,
          secure: false
        },
        '/socket.io': {
          target: API_TARGET,
          changeOrigin: true,
          ws: true,
          secure: false
        }
      }
    },
    build: {
      rolldownOptions: {
        output: {
          // Vite 8 ships the rolldown bundler, whose canonical chunking API is
          // `output.codeSplitting.groups` — each group captures the modules whose
          // id matches `test` into a named chunk. This replaces the legacy
          // `rollupOptions.output.manualChunks` function (still accepted via
          // rolldown's compat layer, but slated to drop in a future Vite). The
          // groups below reproduce the same four vendor chunks as before.
          // Note: use `[\\/]` (not `/`) for the path separator so the regexes
          // also match on Windows.
          codeSplitting: {
            groups: [
              // Core React dependencies
              { name: 'vendor-react', test: /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom)[\\/]/ },
              // Socket dependencies
              { name: 'vendor-realtime', test: /[\\/]node_modules[\\/]socket\.io-client[\\/]/ },
              // Drag and drop library (only used in CoS)
              { name: 'vendor-dnd', test: /[\\/]node_modules[\\/]@dnd-kit[\\/]/ },
              // Icon library (largest dependency)
              { name: 'vendor-icons', test: /[\\/]node_modules[\\/]lucide-react[\\/]/ },
            ]
          }
        }
      },
      // Enable source maps for debugging in production
      sourcemap: false,
      // Increase chunk size warning limit (icons are large)
      chunkSizeWarningLimit: 600
    }
  };
});
