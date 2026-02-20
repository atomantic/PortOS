/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'port-bg': '#0f0f0f',
        'port-card': '#1a1a1a',
        'port-border': '#2a2a2a',
        'port-accent': '#3b82f6',
        'port-success': '#22c55e',
        'port-warning': '#f59e0b',
        'port-error': '#ef4444'
      },
      keyframes: {
        scanline: {
          '0%': { top: '0%' },
          '100%': { top: '100%' },
        },
      },
      animation: {
        scanline: 'scanline 5s linear infinite',
      },
    },
  },
  plugins: [],
}
