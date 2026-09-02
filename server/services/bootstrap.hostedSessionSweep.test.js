/**
 * Source contract for the FableLoom hosted-session sweeper's boot wiring (#5660).
 *
 * `startBackgroundServices` and `runBootSequence` have no unit harness — running
 * either would spin up every scheduler, hook and PTY the real boot arms — so the
 * wiring facts the sweeper depends on are asserted against the source instead.
 * Both are things a plausible edit silently breaks, and neither shows up until
 * the server actually boots:
 *
 *   1. `startBackgroundServices` must destructure `io`. It is a module-scope
 *      arrow, so a body that reads `io` without receiving it is a ReferenceError
 *      thrown mid-boot, not a lint-time typo (ESM is strict mode — there is no
 *      implicit global to fall back on).
 *   2. The shutdown handler must disarm the sweeper. A tick that fires mid
 *      -shutdown emits into a namespace the process is about to close.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { extractDeclaration, stripCommentsAndNormalize } from '../lib/mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'bootstrap.js'), 'utf-8').replace(/\r\n/g, '\n');

describe('hosted-session sweeper boot wiring (#5660)', () => {
  const startBody = stripCommentsAndNormalize(extractDeclaration(SRC, 'startBackgroundServices') || '');

  it('arms the sweeper from startBackgroundServices with an io it actually receives', () => {
    expect(startBody, 'startBackgroundServices not found in bootstrap.js').toBeTruthy();
    expect(startBody).toContain('startHostedSessionSweep({ io })');
    // The destructured parameter list, i.e. everything up to the arrow.
    const params = startBody.slice(0, startBody.indexOf('=>'));
    expect(params, 'startBackgroundServices reads `io` but never destructures it').toMatch(/\bio\b/);
  });

  it('passes io down from runBootSequence, which is where the Socket.IO server lives', () => {
    const bootBody = stripCommentsAndNormalize(extractDeclaration(SRC, 'runBootSequence') || '');
    expect(bootBody).toContain('startBackgroundServices({ spawnerReady, io })');
  });

  it('disarms the sweeper during graceful shutdown', () => {
    const shutdownBody = stripCommentsAndNormalize(extractDeclaration(SRC, 'shutdown') || '');
    expect(shutdownBody).toContain('stopHostedSessionSweep()');
  });
});
