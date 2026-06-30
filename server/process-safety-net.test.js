import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { setupProcessErrorHandlers } from './lib/errorHandler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(__dirname, rel), 'utf8');

// Defense-in-depth process-level net (issue #1878). Both long-lived processes —
// the main server and the standalone CoS runner — must wire the SHARED
// setupProcessErrorHandlers helper so the NEXT unguarded async handler surfaces as
// a logged warning instead of Node's default crash. We assert via a source scan
// rather than by importing the entry files (both boot on import — they call
// server.listen) and rather than by importing the helper and mutating the live
// test process's listener set.
describe('process-level safety net (#1878)', () => {
  it('shared helper registers both unhandledRejection and uncaughtException', () => {
    const src = read('lib/errorHandler.js');
    expect(src).toMatch(/export function setupProcessErrorHandlers/);
    expect(src).toMatch(/process\.on\(\s*['"]unhandledRejection['"]/);
    expect(src).toMatch(/process\.on\(\s*['"]uncaughtException['"]/);
  });

  it('shared helper normalizes arbitrary (non-Error) rejection reasons', () => {
    // Guards against the raw `reason.stack.split()` footgun — non-Error throw
    // values must not make the safety-net handler itself throw.
    const src = read('lib/errorHandler.js');
    expect(src).toMatch(/normalizeError/);
  });

  for (const rel of ['index.js', 'cos-runner/index.js']) {
    it(`${rel} wires up setupProcessErrorHandlers`, () => {
      expect(read(rel)).toMatch(/setupProcessErrorHandlers\s*\(/);
    });
  }

  // The net must never throw while handling a failure — a non-Error throw value
  // (`throw null`) has no `.stack`, and a deref there would mask the original and
  // skip the clean exit/flush. Invoke the actual registered uncaughtException
  // listener with `null`, with the exit timer stubbed so the test process survives.
  it('uncaughtException handler tolerates a non-Error throw value (e.g. null)', () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const newListeners = (event, before) =>
      process.listeners(event).filter((l) => !before.includes(l));
    const beforeExc = process.listeners('uncaughtException');
    const beforeRej = process.listeners('unhandledRejection');
    setupProcessErrorHandlers(); // no io — skips the UI emit
    const addedExc = newListeners('uncaughtException', beforeExc);
    const addedRej = newListeners('unhandledRejection', beforeRej);
    try {
      expect(addedExc).toHaveLength(1);
      expect(() => addedExc[0](null)).not.toThrow();
    } finally {
      addedExc.forEach((l) => process.removeListener('uncaughtException', l));
      addedRej.forEach((l) => process.removeListener('unhandledRejection', l));
      setTimeoutSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
