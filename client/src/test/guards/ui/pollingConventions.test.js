/**
 * Rule: No `setInterval` under `src/components/` or `src/pages/` unless allowlisted; use `useAutoRefetch` (`hooks/useAutoRefetch.js`) for data-fetch polling.
 * Fix: Replace `useEffect` + `setInterval` with `useAutoRefetch`, or move genuine timer primitives to `src/hooks/` / `src/lib/`.
 * What this guard cannot see:
 *   - Self-rearming `setTimeout` polls or polls moved into helper modules outside the two scanned directories.
 *   - `setInterval` inside a comment or string still counts.
 *   - Cannot distinguish an allowlisted file's sanctioned interval from a second unsanctioned one added later.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { trackedSourceFiles } from '../../trackedFiles.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');

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
 * not a data-fetch poll. Adding a row is the point at which to ask whether a
 * socket event fits instead — a poll that talks to the server does not belong
 * here, and polling is an anti-pattern even through `useAutoRefetch` (see
 * "Realtime updates, not polling" in docs/UX_DESIGN_GUIDE.md).
 */
const ALLOWED = {
  'src/components/BrailleSpinner.jsx': 'advances the spinner glyph; no I/O',
  'src/components/calendar/DayView.jsx': 'moves the "now" line down the day grid; no I/O',
  'src/components/meatspace/post/PostDrillRunner.jsx': 'drill countdown timer; no I/O',
  'src/components/meatspace/post/PostLlmDrillRunner.jsx': 'drill countdown timer; no I/O',
  'src/components/meatspace/post/WordplayDrillUI.jsx': 'elapsed-time clock tick; no I/O',
  'src/components/music/MusicGenPanel.jsx': 'elapsed-time clock for a running generation (job state arrives through socket events)',
  'src/components/music/strudelFrame.js': 'source text for the sandboxed player frame: its recording-progress tick runs inside the iframe, not in PortOS; no I/O',
  'src/components/sprites/LoopTrimmer.jsx': 'advances the sprite playback frame; no I/O',
  'src/components/universeBuilder/graph/GraphTimeline.jsx': 'advances the universe-graph playback position one issue per tick; no I/O',
  'src/components/voice/VoiceWidget.jsx': 'samples the in-memory VAD RMS level every 100ms; no I/O',
  'src/components/writers-room/ExercisePanel.jsx': 'elapsed-time clock tick; no I/O',
  'src/components/writers-room/WorkEditor.jsx': 'elapsed-time clock for the analysis-run banner; no I/O',
  'src/pages/Ambient.jsx': 'wall clock; no I/O',
};

const scannedFiles = () => trackedSourceFiles(CLIENT_ROOT)
  .filter((file) => SCAN_DIRS.some((dir) => file.startsWith(dir)));

const schedulesInterval = (file) => TIMER_CALL.test(readText(join(CLIENT_ROOT, file)));

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
