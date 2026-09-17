import { describe, it, expect } from 'vitest';
import { createTerminalModeTracker, stripTerminalQueries } from './terminalReplay.js';

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

// Captured from a real `opencode` PTY at startup: it takes the alternate screen,
// asks for every X11 mouse tracking level plus SGR encoding, and turns on
// bracketed paste. All of it in the first few hundred bytes, never repeated.
const OPENCODE_STARTUP = '\x1b[?2031h\x1b[?25l\x1b[?1049h\x1b[?2027h\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';

describe('createTerminalModeTracker', () => {
  it('re-announces the modes a TUI set before the ring buffer evicted them', () => {
    const tracker = createTerminalModeTracker();
    tracker.observe(OPENCODE_STARTUP);
    // Whatever else streams past, the announcement is not repeated.
    tracker.observe('rendered output');
    expect(tracker.preamble()).toBe(
      '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h'
    );
  });

  it('puts the alternate screen first, so replayed frames paint where they were drawn', () => {
    const tracker = createTerminalModeTracker();
    tracker.observe('\x1b[?1006h\x1b[?2004h\x1b[?1049h');
    expect(tracker.preamble().indexOf('\x1b[?1049h')).toBe(0);
  });

  it('splits a multi-parameter set into its individual modes', () => {
    const tracker = createTerminalModeTracker();
    tracker.observe('\x1b[?1000;1002;1003;1006h');
    expect(tracker.preamble()).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h');
  });

  it('follows a mode that was turned back off', () => {
    const tracker = createTerminalModeTracker();
    tracker.observe(OPENCODE_STARTUP);
    // The TUI exited: alternate screen released, mouse and paste handed back.
    tracker.observe('\x1b[?1000;1002;1003l\x1b[?2004l\x1b[?1049l\x1b[?25h');
    expect(tracker.preamble()).toBe('\x1b[?1006h');
  });

  it('says nothing about a terminal that is still at its defaults', () => {
    const tracker = createTerminalModeTracker();
    tracker.observe('$ ls\r\nfile-a  file-b\r\n\x1b[32m$\x1b[0m ');
    expect(tracker.preamble()).toBe('');
  });

  it('matches a sequence split across two PTY chunks', () => {
    // node-pty hands over whatever the read returned; a 9-byte escape sequence
    // straddling that boundary is ordinary, not pathological.
    const seq = '\x1b[?1049h';
    for (let split = 1; split < seq.length; split++) {
      const tracker = createTerminalModeTracker();
      tracker.observe(`tail${seq.slice(0, split)}`);
      tracker.observe(`${seq.slice(split)}head`);
      expect(tracker.preamble(), `split at ${split}`).toBe(seq);
    }
  });

  it('does not carry a partial across unrelated bytes that end the fragment', () => {
    const tracker = createTerminalModeTracker();
    tracker.observe('\x1b[?1049');
    tracker.observe('  not a terminator');
    expect(tracker.preamble()).toBe('');
  });

  it('ignores transient and untracked private modes', () => {
    const tracker = createTerminalModeTracker();
    // ?2026 is a synchronized-update BEGIN; re-announcing a dangling one would
    // freeze the attaching terminal's rendering. ?2031/?2027 are negotiation.
    tracker.observe('\x1b[?2026h\x1b[?2031h\x1b[?2027h\x1b[?7h');
    expect(tracker.preamble()).toBe('');
  });

  it('carries only a fragment that could still become a private-mode set', () => {
    // A truecolor SGR run split at the same place looks like an incomplete CSI,
    // but it can never become `ESC[?…h` — carrying it would be pure overhead on
    // the busiest kind of output there is.
    const tracker = createTerminalModeTracker();
    tracker.observe('\x1b[38;5');
    tracker.observe(';120mstill colored');
    expect(tracker.preamble()).toBe('');
  });
});
