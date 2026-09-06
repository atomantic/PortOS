/**
 * Guard: nothing under `server/` imports from `client/`.
 *
 * The dependency between the two runtimes is one-way — the client imports pure
 * `server/lib` leaves (see `client/src/lib/README.md`). The reverse edge is a
 * trap in both directions: the server process loads client source at boot, and
 * a client-only dependency added to a file the server imports breaks the server
 * CI job, which is exactly what PR #3614 hit when a server test reached for
 * `client/src/components/cos/constants.js`.
 *
 * PRODUCTION server code has no such edge and must never gain one. A handful of
 * TESTS still import a client copy — each pins a pair that is not a shared pure
 * `server/lib` leaf (component constants, service tables), so retiring it means
 * moving the module, not deleting an assertion. They are frozen in
 * `LEGACY_TEST_CROSS_IMPORTS` below: the list may shrink, never grow.
 *
 * This scans the tracked tree, so no import edge reaches it — it rides
 * `ALWAYS_RUN_TESTS`.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** True when `source` imports (not merely mentions) a module under `client/`. */
export const importsClientSource = (source) => (
  // The `from` keyword is what separates an import specifier from a path a test
  // merely READS (`readFileSync(join(here, '../../client/…'))`) — the remaining
  // parity tests do plenty of the latter, and only the former is the hazard.
  // Unanchored so a multi-line named-import list counts too.
  /\bfrom\s*['"](?:\.\.\/)+client\/[^'"]+['"]/.test(source)
  || /(?:^|\n)\s*import\s*['"](?:\.\.\/)+client\/[^'"]+['"]/.test(source)
);

/**
 * Tests that still import a client module. Every entry pins a copy-pair whose
 * client side is NOT a re-export of a pure `server/lib` leaf. Shrink this list
 * by moving the shared module into `server/lib` and re-exporting it from the
 * client — never by adding a row.
 */
const LEGACY_TEST_CROSS_IMPORTS = new Set([
  'server/cos-runner/allowedCommands.parity.test.js',
  'server/lib/eidoverseWorldReset.parity.test.js',
  'server/lib/goalFeatureMap.test.js',
  'server/lib/icLoraWeights.parity.test.js',
  'server/lib/postPowersLadder.test.js',
  'server/lib/privacyValidation.mirror.test.js',
  'server/lib/renderTargets.parity.test.js',
  'server/lib/spriteAnimationTracks.test.js',
  'server/lib/universeMarkdown.test.js',
  'server/lib/videoContinuity.parity.test.js',
  'server/lib/videoSpeedProfiles.parity.test.js',
  'server/lib/videoTextEncoders.parity.test.js',
  'server/services/imageTo3d/renderOptions.parity.test.js',
  'server/services/imageTo3d/unavailableReasons.parity.test.js',
  'server/services/meatspaceHealth.test.js',
  'server/services/rigging/unavailableReasons.parity.test.js',
  'server/services/rounds.test.js',
]);

const trackedServerSources = execFileSync(
  'git',
  ['ls-files', 'server/*.js', 'server/**/*.js'],
  { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
).split('\n').filter(Boolean);

const crossImporters = trackedServerSources.filter(
  (rel) => importsClientSource(readFileSync(join(REPO_ROOT, rel), 'utf8')),
);

describe('server/ never imports client/ (#6364)', () => {
  it('finds server sources to scan', () => {
    // Fails loudly if the glob stops matching, rather than passing vacuously.
    expect(trackedServerSources.length).toBeGreaterThan(100);
  });

  it('detects the shape it guards, and leaves prose and same-root imports alone (bypass probe)', () => {
    expect(importsClientSource("import { x } from '../../client/src/lib/x.js';")).toBe(true);
    expect(importsClientSource("import { x } from '../client/src/lib/x.js';")).toBe(true);
    expect(importsClientSource("export { x } from '../../client/src/lib/x.js';")).toBe(true);
    expect(importsClientSource("import '../../client/src/lib/x.js';")).toBe(true);
    expect(importsClientSource("import { x } from './x.js';")).toBe(false);
    // A comment naming a client path is not an import.
    expect(importsClientSource('// mirrored to client/src/lib/x.js')).toBe(false);
    expect(importsClientSource("readFileSync(join(here, '../../client/src/lib/x.js'), 'utf8');")).toBe(false);
  });

  it('has no production server module importing client source', () => {
    const production = crossImporters.filter((rel) => !rel.endsWith('.test.js'));
    expect(
      production,
      'A server module must not load client source: it puts the client build on the server\'s '
      + 'boot path and lets a client-only dependency break the server CI job. Move the shared '
      + 'module into server/lib and re-export it from client/src/lib instead: '
      + `${production.join(', ')}`,
    ).toEqual([]);
  });

  it('adds no test cross-import beyond the frozen legacy list', () => {
    const unlisted = crossImporters.filter(
      (rel) => rel.endsWith('.test.js') && !LEGACY_TEST_CROSS_IMPORTS.has(rel),
    );
    expect(
      unlisted,
      'New tests must not import client source — pin the shared logic by moving it into '
      + `server/lib and re-exporting it from the client: ${unlisted.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps the legacy list free of entries that no longer cross-import', () => {
    const stale = [...LEGACY_TEST_CROSS_IMPORTS].filter((rel) => !crossImporters.includes(rel));
    expect(
      stale,
      `These no longer import client source — drop the entry so the list keeps shrinking: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
