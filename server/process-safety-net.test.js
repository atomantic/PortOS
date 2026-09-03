import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { setupProcessErrorHandlers } from './lib/errorHandler.js';
import { blankLiterals } from './lib/sourceScan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Read CODE, not prose: `blankLiterals` blanks comment/string/regex content to
// spaces (preserving line structure), so a rule *described* in a comment can
// neither satisfy nor defeat the scan. Without it the cos-runner arm below was
// green on the explanatory comment above the real call, and deleting the call
// changed nothing (#5685).
const toCode = (src) => blankLiterals(src.replace(/\r\n/g, '\n'));
const read = (rel) => toCode(readFileSync(join(__dirname, rel), 'utf8'));

// A top-level call statement — the only shape that actually arms the net in an
// entry file that boots on import.
const TOP_LEVEL_CALL = /^[ \t]*setupProcessErrorHandlers\s*\(/m;

const WIRING_GUARDS = [
  // The main server wires the net from its boot sequence (services/bootstrap.js,
  // extracted from index.js in #2839) as a NAMED STEP handed to
  // runPostListenSequence, so the call is nested in the step table rather than at
  // statement level. That indirection is pinned behaviourally by
  // bootstrapSequence.test.js ("runs the post-listen steps in order"), so an
  // identifier-level match is enough here.
  { rel: 'services/bootstrap.js', pattern: /setupProcessErrorHandlers\s*\(/, shape: 'call' },
  // The CoS runner arms the net itself, at module top level. Nothing else pins
  // it, so this guard is the only thing standing between a deleted line and an
  // unguarded rejection killing the process that supervises every agent run —
  // require the exact shape that arms it.
  { rel: 'cos-runner/index.js', pattern: TOP_LEVEL_CALL, shape: 'top-level call statement' },
];

// Defense-in-depth process-level net (issue #1878). Both long-lived processes —
// the main server and the standalone CoS runner — must wire the SHARED
// setupProcessErrorHandlers helper so the NEXT unguarded async handler surfaces as
// a logged warning instead of Node's default crash. We assert via a source scan
// rather than by importing the entry files (both boot on import — they call
// server.listen) and rather than by importing the helper and mutating the live
// test process's listener set.
describe('process-level safety net (#1878)', () => {
  for (const { rel, pattern, shape } of WIRING_GUARDS) {
    it(`${rel} wires up setupProcessErrorHandlers (${shape})`, () => {
      expect(read(rel)).toMatch(pattern);
    });
  }

  // The guards above are only as strong as the comment stripping — a source scan
  // that reads prose is satisfied by a description of the rule it enforces. Run
  // the same predicates through the SAME `toCode` the guards use, over a fixture
  // whose only occurrences are commented out, and assert they see nothing; then
  // over the same fixture plus a real call, so the probe cannot pass by being
  // blind to everything. Dropping the stripper from `toCode` fails this too.
  it('a commented-out call does not satisfy the wiring guards (bypass probe)', () => {
    // The block-comment arm deliberately puts the call at the START of its own
    // line: a line-leading `//` would be rejected by TOP_LEVEL_CALL's own shape
    // even with the stripping gone, so only this fixture makes the probe prove
    // the stripping rather than the anchor.
    const commentedOnly = [
      '// setupProcessErrorHandlers(io); the main server passes io; the runner does not',
      '/*',
      'setupProcessErrorHandlers();',
      '*/',
      'startRunner();',
    ].join('\n');
    for (const { pattern } of WIRING_GUARDS) {
      expect(toCode(commentedOnly)).not.toMatch(pattern);
      expect(toCode(`${commentedOnly}\nsetupProcessErrorHandlers();`)).toMatch(pattern);
    }
  });

  // ...and index.js must actually run that boot sequence, or the wiring above
  // would be dead code the server never reaches.
  it('index.js runs the bootstrap boot sequence', () => {
    expect(read('index.js')).toMatch(/^[ \t]*runBootSequence\s*\(/m);
  });

  // The net must never throw while handling a failure — a non-Error throw value
  // (`throw null`) has no `.stack`, and a deref there would mask the original and
  // skip the clean exit/flush. Invoke the actual registered uncaughtException
  // listener with `null`, with the exit timer stubbed so the test process survives.
  it('handlers tolerate a non-Error throw / rejection reason (e.g. null)', () => {
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
      expect(addedRej).toHaveLength(1);
      expect(() => addedExc[0](null)).not.toThrow();
      expect(() => addedRej[0](null, Promise.resolve())).not.toThrow();
    } finally {
      addedExc.forEach((l) => process.removeListener('uncaughtException', l));
      addedRej.forEach((l) => process.removeListener('unhandledRejection', l));
      setTimeoutSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
