import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const API_HOST = env.VITE_API_HOST || 'localhost';
  const API_TARGET = `http://${API_HOST}:5555`;

  return {
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5554,
    open: false,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true
      },
      '/socket.io': {
        target: API_TARGET,
        changeOrigin: true,
        ws: true
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Core React dependencies
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          // Socket and toast dependencies
          'vendor-realtime': ['socket.io-client', 'react-hot-toast'],
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
