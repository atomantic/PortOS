import { describe, it, expect } from 'vitest';
import { stripTerminalQueries } from './terminalReplay.js';

// The exact replies @xterm/xterm sends for each query, captured from a real
// terminal. These are what used to reach the PTY — and land on the shell prompt.
describe('stripTerminalQueries', () => {
  it('removes the cursor-position query a TUI emits on every render', () => {
    expect(stripTerminalQueries('before\x1b[6nafter')).toBe('beforeafter');
  });

  it('removes every query xterm answers', () => {
    const queries = [
      '\x1b[6n',            // DSR cursor position  → ESC[row;colR
      '\x1b[5n',            // DSR operating status → ESC[0n
      '\x1b[?6n',           // DECXCPR
      '\x1b[c',             // DA1 → ESC[?1;2c
      '\x1b[0c',            // DA1 with explicit param
      '\x1b[>c',            // DA2 → ESC[>0;276;0c
      '\x1b[?2004$p',       // DECRQM → ESC[?2004;1$y
      '\x1bP$qm\x1b\\',     // DECRQSS → ESCP1$r0m ST
      '\x1b]11;?\x07',      // OSC 11 bg colour, BEL-terminated
      '\x1b]10;?\x1b\\',    // OSC 10 fg colour, ST-terminated
      '\x1b]4;1;?\x07',     // OSC 4 palette entry
    ];
    for (const q of queries) {
      expect(stripTerminalQueries(`a${q}b`), `should strip ${JSON.stringify(q)}`).toBe('ab');
    }
  });

  it('strips a whole burst, which is how the flood actually arrives', () => {
    const burst = '\x1b[6n'.repeat(200);
    expect(stripTerminalQueries(`prompt${burst}`)).toBe('prompt');
  });

  // The replay buffer's whole job is to repaint the screen and re-establish the
  // modes the session is actually using. Eating any of that would be a worse bug
  // than the one being fixed.
  it('preserves rendering and stateful sequences', () => {
    const keep = [
      '\x1b[0m', '\x1b[1;32m', '\x1b[38;5;254m',  // SGR
      '\x1b[2J', '\x1b[K', '\x1b[114D', '\x1b[10A', // erase / cursor motion
      '\x1b[?1049h', '\x1b[?1049l',                 // alternate screen
      '\x1b[?2004h', '\x1b[?2004l',                 // bracketed paste
      '\x1b[?1000h', '\x1b[?1006h',                 // mouse tracking
      '\x1b]133;A\x07', '\x1b]133;B\x07',           // shell integration marks
      '\x1b]0;window title\x07',                    // window title
      '\x1b=', '\x1b[?1h',                          // keypad / cursor key modes
    ];
    for (const seq of keep) {
      expect(stripTerminalQueries(`a${seq}b`), `should keep ${JSON.stringify(seq)}`).toBe(`a${seq}b`);
    }
  });

  it('leaves plain text and empty input alone', () => {
    expect(stripTerminalQueries('no escapes here')).toBe('no escapes here');
    expect(stripTerminalQueries('')).toBe('');
    expect(stripTerminalQueries(null)).toBe('');
    expect(stripTerminalQueries(undefined)).toBe('');
  });

  it('does not let an unterminated DECRQSS swallow the rest of the buffer', () => {
    // No ST, so the pattern must not match and eat everything after it.
    const text = 'head\x1bP$qm tail that must survive';
    expect(stripTerminalQueries(text)).toBe(text);
  });
});
