import { describe, it, expect } from 'vitest';
import {
  ANSI_DAY,
  ANSI_NIGHT,
  buildTerminalTheme,
  parseCssColorToHex,
} from './terminalTheme.js';

const COLORS = {
  bg: '#fafafa',
  fg: '#171717',
  accent: '#2563eb',
  card: '#ffffff',
  error: '#dc2626',
  success: '#16a34a',
  warning: '#f59e0b',
};

describe('parseCssColorToHex', () => {
  it('parses the space-separated RGB triple form (--port-* color vars)', () => {
    expect(parseCssColorToHex('15 15 15')).toBe('#0f0f0f');
    expect(parseCssColorToHex('250 250 250')).toBe('#fafafa');
  });

  it('parses the rgb()/rgba() function form (--port-terminal-* tokens)', () => {
    expect(parseCssColorToHex('rgb(7 7 7)')).toBe('#070707');
    expect(parseCssColorToHex('rgb(247 247 248)')).toBe('#f7f7f8');
  });

  it('drops alpha from rgba()/slash-alpha forms', () => {
    expect(parseCssColorToHex('rgb(5 12 16 / 0.86)')).toBe('#050c10');
    expect(parseCssColorToHex('rgba(255, 255, 255, 0.85)')).toBe('#ffffff');
  });

  it('returns the fallback for missing or unparseable values', () => {
    expect(parseCssColorToHex('')).toBe('#000000');
    expect(parseCssColorToHex(undefined)).toBe('#000000');
    expect(parseCssColorToHex('not a color', '#abcdef')).toBe('#abcdef');
    expect(parseCssColorToHex('1 2', '#abcdef')).toBe('#abcdef');
  });

  it('clamps and rounds out-of-range / fractional channel values', () => {
    expect(parseCssColorToHex('300 -5 127.6')).toBe('#ff0080');
  });
});

describe('buildTerminalTheme', () => {
  it('drives base ANSI colors from the supplied theme colors in both modes', () => {
    for (const mode of ['day', 'night']) {
      const theme = buildTerminalTheme(COLORS, mode);
      expect(theme.background).toBe(COLORS.bg);
      expect(theme.foreground).toBe(COLORS.fg);
      expect(theme.cursor).toBe(COLORS.accent);
      expect(theme.red).toBe(COLORS.error);
      expect(theme.green).toBe(COLORS.success);
      expect(theme.yellow).toBe(COLORS.warning);
      expect(theme.blue).toBe(COLORS.accent);
    }
  });

  it('uses the dark-tuned night palette and falls back to card/fg for black/white', () => {
    const theme = buildTerminalTheme(COLORS, 'night');
    expect(theme.black).toBe(COLORS.card);
    expect(theme.white).toBe(COLORS.fg);
    expect(theme.magenta).toBe(ANSI_NIGHT.magenta);
    expect(theme.brightWhite).toBe(ANSI_NIGHT.brightWhite);
    expect(theme.brightBlack).toBe(ANSI_NIGHT.brightBlack);
  });

  it('uses the light-tuned day palette with explicit dark black/white', () => {
    const theme = buildTerminalTheme(COLORS, 'day');
    // On a light theme card is white, so "black" must NOT inherit it.
    expect(theme.black).toBe(ANSI_DAY.black);
    expect(theme.black).not.toBe(COLORS.card);
    expect(theme.white).toBe(ANSI_DAY.white);
    expect(theme.magenta).toBe(ANSI_DAY.magenta);
    expect(theme.brightWhite).toBe(ANSI_DAY.brightWhite);
  });

  it('treats any non-day mode as night', () => {
    expect(buildTerminalTheme(COLORS, undefined)).toEqual(buildTerminalTheme(COLORS, 'night'));
    expect(buildTerminalTheme(COLORS, 'whatever')).toEqual(buildTerminalTheme(COLORS, 'night'));
  });

  it('renders the day bright variants darker than their night counterparts (contrast on light bg)', () => {
    const day = buildTerminalTheme(COLORS, 'day');
    const night = buildTerminalTheme(COLORS, 'night');
    const luma = (hex) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return 0.299 * r + 0.587 * g + 0.114 * b;
    };
    for (const key of ['brightRed', 'brightGreen', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite']) {
      expect(luma(day[key])).toBeLessThan(luma(night[key]));
    }
  });

  it('uses a lighter selection alpha for day mode', () => {
    expect(buildTerminalTheme(COLORS, 'day').selectionBackground).toBe(COLORS.accent + '33');
    expect(buildTerminalTheme(COLORS, 'night').selectionBackground).toBe(COLORS.accent + '40');
  });

  it('populates every xterm slot with a valid hex in both modes', () => {
    // A typo'd ANSI_* key would leave a slot `undefined` (an invalid xterm color)
    // without tripping the mode-equivalence tests above — assert each slot explicitly.
    const SLOTS = [
      'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground',
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
      'brightMagenta', 'brightCyan', 'brightWhite',
    ];
    for (const mode of ['day', 'night']) {
      const theme = buildTerminalTheme(COLORS, mode);
      for (const slot of SLOTS) {
        // selectionBackground carries an 8-digit alpha suffix; the rest are 6-digit.
        expect(theme[slot], `${mode} ${slot}`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
      }
    }
  });
});
