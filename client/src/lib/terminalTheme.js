// Pure helpers for building the xterm.js terminal palette from the active PortOS
// theme. Kept side-effect-free (no DOM reads) so it can be unit-tested; the Shell
// page reads CSS custom properties off the document and hands resolved colors in.
//
// The base 8 ANSI colors (red/green/yellow/blue) come from theme CSS vars so they
// track each theme's identity. The remaining slots are mode-tuned literals: the
// night palette is bright/pastel for dark backgrounds, while the day palette is
// darkened and saturated so colored CLI output stays legible on a light terminal
// background (the old single dark-tuned palette washed out in daytime themes).

// Bright/pastel ANSI slots tuned for dark backgrounds. `black`/`white` are null so
// the builder falls back to the theme's card/foreground (their dark-mode behavior).
export const ANSI_NIGHT = {
  black: null,
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: null,
  brightBlack: '#404040',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
};

// Darkened, saturated ANSI slots tuned for light backgrounds. `black`/`white` are
// explicit here (theme card is white in daytime themes, so it can't stand in for
// "black"), and the bright variants get *more* contrast — i.e. darker, not lighter.
export const ANSI_DAY = {
  black: '#1f2937',
  magenta: '#a21caf',
  cyan: '#0e7490',
  white: '#52525b',
  brightBlack: '#71717a',
  brightRed: '#b91c1c',
  brightGreen: '#15803d',
  brightYellow: '#a16207',
  brightBlue: '#1d4ed8',
  brightMagenta: '#86198f',
  brightCyan: '#155e75',
  brightWhite: '#27272a',
};

// Parse a CSS color value into a `#rrggbb` hex string. Handles both forms PortOS
// uses for theme variables: the space-separated RGB triple (`15 15 15`, used by
// the `--port-*` color vars) and the rgb()/rgba() function form (`rgb(7 7 7 / 0.86)`,
// used by the `--port-terminal-*` tokens). Alpha is dropped — xterm renders an
// opaque terminal. Returns `fallback` when the value is missing or unparseable.
export function parseCssColorToHex(raw, fallback = '#000000') {
  if (!raw) return fallback;
  const nums = String(raw)
    .replace(/rgba?\(|\)|\//g, ' ')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  if (nums.length < 3) return fallback;
  return (
    '#' +
    nums
      .slice(0, 3)
      .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
      .join('')
  );
}

// Build the xterm `theme` object from resolved theme colors and the active mode.
//   colors: { bg, fg, accent, card, error, success, warning } — all #rrggbb hex
//   mode:   'day' | 'night' (anything other than 'day' is treated as night)
export function buildTerminalTheme(colors, mode) {
  const { bg, fg, accent, card, error, success, warning } = colors;
  const ansi = mode === 'day' ? ANSI_DAY : ANSI_NIGHT;
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: accent + (mode === 'day' ? '33' : '40'),
    black: ansi.black ?? card,
    red: error,
    green: success,
    yellow: warning,
    blue: accent,
    magenta: ansi.magenta,
    cyan: ansi.cyan,
    white: ansi.white ?? fg,
    brightBlack: ansi.brightBlack,
    brightRed: ansi.brightRed,
    brightGreen: ansi.brightGreen,
    brightYellow: ansi.brightYellow,
    brightBlue: ansi.brightBlue,
    brightMagenta: ansi.brightMagenta,
    brightCyan: ansi.brightCyan,
    brightWhite: ansi.brightWhite,
  };
}
