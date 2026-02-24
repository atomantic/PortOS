/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'port-bg': 'rgb(var(--port-bg) / <alpha-value>)',
        'port-card': 'rgb(var(--port-card) / <alpha-value>)',
        'port-border': 'rgb(var(--port-border) / <alpha-value>)',
        'port-accent': 'rgb(var(--port-accent) / <alpha-value>)',
        'port-success': 'rgb(var(--port-success) / <alpha-value>)',
        'port-warning': 'rgb(var(--port-warning) / <alpha-value>)',
        'port-error': 'rgb(var(--port-error) / <alpha-value>)',
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
