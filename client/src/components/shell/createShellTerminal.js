import { Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { buildTerminalTheme, parseCssColorToHex } from '../../lib/terminalTheme';
import { isFocusEscapeKey } from '../../lib/a11yKeyboard';

export const TERMINAL_SCROLLBACK_LINES = 5000;

// The xterm construction both Shell views share — the PortOS PTY view
// (hooks/useShellSession.js) and the iTerm2 view (hooks/useItermSession.js) —
// so the font stack, theme, links and keyboard-escape rule cannot drift apart.

// Read the active theme's colors off the document and assemble the xterm palette.
// The day/night mode comes from the `data-port-theme-mode` attribute applyTheme()
// stamps on <html>, so this stays correct without threading React state in.
// Background/foreground prefer the dedicated --port-terminal-* tokens (hand-tuned
// per theme) and fall back to the page bg/text.
export const readTerminalTheme = () => {
  const root = document.documentElement;
  const mode = root.dataset.portThemeMode === 'day' ? 'day' : 'night';
  const css = (varName) => getComputedStyle(root).getPropertyValue(varName).trim();
  return buildTerminalTheme({
    bg: parseCssColorToHex(css('--port-terminal-bg') || css('--port-bg'), '#070707'),
    fg: parseCssColorToHex(css('--port-terminal-text') || css('--port-text'), '#e5e5e5'),
    accent: parseCssColorToHex(css('--port-accent')),
    card: parseCssColorToHex(css('--port-card')),
    error: parseCssColorToHex(css('--port-error')),
    success: parseCssColorToHex(css('--port-success')),
    warning: parseCssColorToHex(css('--port-warning')),
  }, mode);
};

/** Create, open and return an xterm Terminal mounted in `container`. */
export const createShellTerminal = (container, options = {}) => {
  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontSize: 14,
    fontFamily: '"Roboto Mono for Powerline", "MesloLGS NF", "MesloLGS Nerd Font", "Hack Nerd Font", "FiraCode Nerd Font", "JetBrainsMono Nerd Font", Menlo, Monaco, "Courier New", monospace',
    theme: readTerminalTheme(),
    scrollback: TERMINAL_SCROLLBACK_LINES,
    allowProposedApi: true,
    // Screen-reader mode is what makes xterm build its .xterm-accessibility
    // live region — without it every rendered row stays aria-hidden and a
    // screen-reader user focusing the terminal hears an empty textarea. It
    // also relaxes _keyDown's blanket preventDefault on resolved keys and
    // makes xterm ignore every textarea insertText event — so dictation (which
    // fires no key events) reaches the PTY only through the dictation bridge
    // (lib/terminalDictation.js), which accounts for both.
    screenReaderMode: true,
    ...options,
  });

  term.loadAddon(new WebLinksAddon());
  term.open(container);

  // WCAG 2.1.2 (no keyboard trap): xterm's helper textarea is in the tab
  // order but its _keyDown preventDefaults Tab, Shift+Tab and Escape alike,
  // so a keyboard user who tabs in cannot leave without a mouse. The
  // documented escape is Shift+Tab — the conventional "leave this widget"
  // backtab: returning false makes _keyDown bail before it cancels the
  // event, so the browser performs the focus move to the previous tabbable
  // element and nothing reaches the PTY. Plain Tab must stay claimed — it is
  // shell completion. The gesture itself is the shared isFocusEscapeKey
  // predicate so the stand-down rule lives in one place.
  term.attachCustomKeyEventHandler((event) => !isFocusEscapeKey(event));

  return term;
};
