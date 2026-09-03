// @vitest-environment node

/**
 * Repo-wide guard: data-fetch polling in a view goes through `useAutoRefetch`.
 *
 * `hooks/useAutoRefetch.js` short-circuits its tick while
 * `document.visibilityState === 'hidden'` and re-fires once on the way back to
 * visible. A hand-rolled `useEffect` + `setInterval` does neither, so it keeps
 * hitting the server from a tab nobody is looking at — and PortOS is routinely
 * left open in a background tab on a second machine over the tailnet. Eleven
 * such polls had accumulated (#5697), several of which fanned out to `pm2
 * jlist` or Ollama on every tick.
 *
 * The rule is deliberately blunt: **no `setInterval` at all** under
 * `src/components/` or `src/pages/`, except for an allowlisted file carrying a
 * one-line reason. A rule that tried to tell "a poll that fetches" from "a
 * timer that ticks a clock" by looking at the callback body would have to
 * recognize every API-call spelling in the tree, and would miss the next one.
 * Banning the primitive outright and making the exceptions explicit is both
 * simpler and stricter: a genuine local timer costs one allowlist line, and
 * writing that line is the moment someone asks whether the hook fits.
 *
 * `src/hooks/` and `src/lib/` are out of scope — that is where a shared timer
 * primitive (`useTimeTick`, `useCooldownTick`, the metronome transports, and
 * `useAutoRefetch` itself) is supposed to live.
 *
 * ## What this guard CANNOT see
 *
 * It is a source grep, not an AST pass:
 *   - A poll built on `setTimeout` that re-arms itself is invisible.
 *   - A poll moved into a helper module outside the two scanned directories is
 *     invisible (that is also the sanctioned escape hatch, so this is by design).
 *   - `setInterval` written only inside a comment or a string counts.
 *   - It cannot tell an allowlisted file's *sanctioned* interval from a second,
 *     unsanctioned one added to the same file later. Allowlist entries are
 *     therefore meant to stay rare and small.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from './test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// View code only. A shared hook or lib module is where a timer primitive belongs.
const SCAN_DIRS = ['src/components/', 'src/pages/'];

/**
 * `\b` keeps `resetInterval(` / `setIntervalPreset(` out, and requiring the
 * open paren keeps a bare mention of the identifier out. `window.setInterval(`
 * is intentionally still a match — it is the same timer.
 */
const TIMER_CALL = /\bsetInterval\s*\(/;

/**
 * Files allowed to schedule an interval directly, each with the reason it is
 * not a data-fetch poll. Adding a row is the point at which to ask whether
 * `useAutoRefetch` fits instead — a poll that talks to the server does not
 * belong here.
 */
const ALLOWED = {
  'src/components/BrailleSpinner.jsx': 'advances the spinner glyph; no I/O',
  'src/components/calendar/DayView.jsx': 'moves the "now" line down the day grid; no I/O',
  'src/components/cos/tabs/AgentCard.jsx': 'elapsed-time clock tick (the card polls stats via useAutoRefetch)',
  'src/components/meatspace/post/PostDrillRunner.jsx': 'drill countdown timer; no I/O',
  'src/components/meatspace/post/PostLlmDrillRunner.jsx': 'drill countdown timer; no I/O',
  'src/components/meatspace/post/WordplayDrillUI.jsx': 'elapsed-time clock tick; no I/O',
  'src/components/music/MusicGenPanel.jsx': 'elapsed-time clock for a running generation (the job itself polls via useAutoRefetch)',
  'src/components/sprites/LoopTrimmer.jsx': 'advances the sprite playback frame; no I/O',
  'src/components/sprites/WalkWorkflow.jsx': 'counts ticks to self-cancel a stale-queued attach after ~60s — useAutoRefetch does not model a bounded poll',
  'src/components/voice/VoiceWidget.jsx': 'samples the in-memory VAD RMS level every 100ms; no I/O',
  'src/components/writers-room/ExercisePanel.jsx': 'elapsed-time clock tick; no I/O',
  'src/components/writers-room/WorkEditor.jsx': 'elapsed-time clock for the analysis-run banner; no I/O',
  'src/pages/Ambient.jsx': 'wall clock; no I/O',
  'src/pages/ThreejsModelDetail.jsx': 'bounded in-flight poll pool with a per-tick AbortController — useAutoRefetch does not model either',
};

const scannedFiles = () => trackedSourceFiles(CLIENT_ROOT)
  .filter((file) => SCAN_DIRS.some((dir) => file.startsWith(dir)));

const schedulesInterval = (file) => TIMER_CALL.test(readFileSync(join(CLIENT_ROOT, file), 'utf8'));

describe('view polling goes through useAutoRefetch', () => {
  it('has no hand-rolled setInterval outside the allowlist', () => {
    const files = scannedFiles();
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise
    // make this guard pass by scanning nothing at all.
    expect(files.length).toBeGreaterThan(100);

    const violations = files.filter((file) => !(file in ALLOWED) && schedulesInterval(file));

    expect(
      violations,
      'These view files schedule a raw `setInterval`. If it fetches data, it keeps '
      + 'hitting the server from a hidden background tab — the exact load #5697 removed.\n'
      + 'Fix: `useAutoRefetch(fetchFn, intervalMs, { enabled, pollOnly: true })` from '
      + '`client/src/hooks/useAutoRefetch.js` — it pauses while the tab is hidden and '
      + 're-fires once on the way back. Keep the site\'s existing gate as `enabled` '
      + 'rather than an early return, and pass `immediate: false` when another effect '
      + 'already owns the first fetch.\n'
      + 'If it is genuinely a local timer (a clock tick, an animation frame advance, a '
      + 'bounded self-cancelling poll), add it to ALLOWED in this file with a one-line '
      + 'reason.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // Burn-down: an allowlist entry that no longer needs to be there must go, or
  // the list quietly becomes a list of files nobody has looked at in a year.
  it('has no stale allowlist entry', () => {
    const missing = Object.keys(ALLOWED).filter((file) => !existsSync(join(CLIENT_ROOT, file)));
    expect(missing, `Allowlisted files that no longer exist:\n  ${missing.join('\n  ')}`).toEqual([]);

    const noLongerNeeded = Object.keys(ALLOWED).filter((file) => !schedulesInterval(file));
    expect(
      noLongerNeeded,
      'These files are allowlisted but no longer call `setInterval`. Delete their rows '
      + `from ALLOWED.\n  ${noLongerNeeded.join('\n  ')}`,
    ).toEqual([]);
  });

  it('allowlists only files inside the scanned directories', () => {
    const outside = Object.keys(ALLOWED).filter((file) => !SCAN_DIRS.some((dir) => file.startsWith(dir)));
    expect(
      outside,
      `These rows can never be reached — the scan only covers ${SCAN_DIRS.join(' and ')}.\n  ${outside.join('\n  ')}`,
    ).toEqual([]);
  });

  // Guards the guard: a detector that stopped recognizing the banned call would
  // make the scan above vacuously green and let the bug class walk back in.
  it('recognizes a scheduled interval and nothing that merely looks like one', () => {
    expect(TIMER_CALL.test('const t = setInterval(refresh, 5000);')).toBe(true);
    expect(TIMER_CALL.test('const t = setInterval (refresh, 5000);')).toBe(true);
    expect(TIMER_CALL.test('const t = window.setInterval(refresh, 5000);')).toBe(true);

    expect(TIMER_CALL.test('clearInterval(timer);')).toBe(false);
    expect(TIMER_CALL.test('resetInterval(timer);')).toBe(false);
    // A useState setter named for the value it sets, not the timer API.
    expect(TIMER_CALL.test('setIntervalPreset(p.value);')).toBe(false);
    // The sanctioned replacement must not read as a violation.
    expect(TIMER_CALL.test("useAutoRefetch(load, 5000, { pollOnly: true });")).toBe(false);
  });
});
