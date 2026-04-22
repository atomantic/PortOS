import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

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
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5554,
      open: false,
      proxy: {
        '/api': {
          target: API_TARGET,
          changeOrigin: true,
          secure: false
        },
        '/data': {
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
      rollupOptions: {
        output: {
          manualChunks: {
            // Core React dependencies
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            // Socket dependencies
            'vendor-realtime': ['socket.io-client'],
            // Drag and drop library (only used in CoS)
            'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
            // Icon library (largest dependency)
            'vendor-icons': ['lucide-react']
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
