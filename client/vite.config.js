import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5555,
    proxy: {
      '/api': {
        target: 'http://localhost:5554',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:5554',
        changeOrigin: true,
        ws: true
      }
    }
  }
});
