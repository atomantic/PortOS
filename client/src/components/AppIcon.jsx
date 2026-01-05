// App icons - SVG icons for different app types
// Each icon follows the 24x24 viewBox pattern used by lucide-react

const icons = {
  // PortOS - portal/gateway logo (from Logo.jsx)
  portos: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="4 2" opacity="0.5" />
      <circle cx="12" cy="12" r="6" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <line x1="12" y1="6" x2="12" y2="2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="6" y1="12" x2="2" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="18" y1="12" x2="22" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),

  // Web/Browser app
  web: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <ellipse cx="12" cy="12" rx="4" ry="10" stroke="currentColor" strokeWidth="2" />
      <line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" strokeWidth="2" />
      <path d="M4.5 7h15M4.5 17h15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),

  // API/Server
  api: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="3" y="4" width="18" height="5" rx="1" stroke="currentColor" strokeWidth="2" />
      <rect x="3" y="15" width="18" height="5" rx="1" stroke="currentColor" strokeWidth="2" />
      <circle cx="6" cy="6.5" r="1" fill="currentColor" />
      <circle cx="6" cy="17.5" r="1" fill="currentColor" />
      <line x1="12" y1="9" x2="12" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),

  // Database
  database: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <ellipse cx="12" cy="5" rx="9" ry="3" stroke="currentColor" strokeWidth="2" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" stroke="currentColor" strokeWidth="2" />
      <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" stroke="currentColor" strokeWidth="2" />
    </svg>
  ),

  // Game/Dice
  game: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      <circle cx="16" cy="8" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="8" cy="16" r="1.5" fill="currentColor" />
      <circle cx="16" cy="16" r="1.5" fill="currentColor" />
    </svg>
  ),

  // Book/Story
  book: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" stroke="currentColor" strokeWidth="2" />
      <path d="M8 7h8M8 11h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),

  // Robot/Bot
  bot: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="3" y="8" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <circle cx="9" cy="13" r="2" fill="currentColor" />
      <circle cx="15" cy="13" r="2" fill="currentColor" />
      <line x1="12" y1="5" x2="12" y2="8" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="4" r="1.5" fill="currentColor" />
      <path d="M8 17h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),

  // Code/Terminal
  code: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M7 10l3 2-3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="13" y1="14" x2="17" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),

  // Wrench/Tool
  tool: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.77 3.77z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),

  // Rocket
  rocket: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11.95A22.18 22.18 0 0112 15z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),

  // Heart
  heart: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),

  // Music
  music: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M9 18V5l12-2v13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6" cy="18" r="3" stroke="currentColor" strokeWidth="2" />
      <circle cx="18" cy="16" r="3" stroke="currentColor" strokeWidth="2" />
    </svg>
  ),

  // Sparkles/Magic
  sparkles: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 3l.5 1.5L7 5l-1.5.5L5 7l-.5-1.5L3 5l1.5-.5L5 3z" fill="currentColor" />
      <path d="M19 17l.5 1.5L21 19l-1.5.5L19 21l-.5-1.5L17 19l1.5-.5L19 17z" fill="currentColor" />
    </svg>
  ),

  // Shield/Security
  shield: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),

  // Layers/Stack
  layers: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="2 17 12 22 22 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="2 12 12 17 22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),

  // Package (default)
  package: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M16.5 9.4l-9-5.19M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="22.08" x2="12" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),

  // Coin/Currency
  coin: ({ size, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <path d="M12 6v12M9 9c0-1.1.9-2 2-2h2a2 2 0 110 4h-2a2 2 0 100 4h2a2 2 0 002-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
};

// List of available icon names for the picker
export const iconNames = Object.keys(icons);

export default function AppIcon({ icon, size = 24, className = '' }) {
  const IconComponent = icons[icon] || icons.package;
  return <IconComponent size={size} className={className} />;
}
