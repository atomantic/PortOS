/**
 * Mirror parity test for the `KNOWN_MODEL_CONTEXT_WINDOWS` table, which lives
 * in both server/lib/stageRunner.js and client/src/utils/providers.js (the
 * client can't import server modules, so the table is duplicated behind a
 * "Keep in sync" comment on each side).
 *
 * Until now the mirror was pinned by that comment alone: each side had its own
 * hardcoded expectations (`stageRunner.test.js` / `providers.test.js`), so a
 * model bump that added a row to only one copy left BOTH suites green. The two
 * ends would then disagree about whether a given manuscript fits in one call —
 * the server chunking against the real window while the client's "context used"
 * meter falls through to the conservative DEFAULT_LARGE_CONTEXT_WINDOW, or vice
 * versa. Silent, and ~8x off.
 *
 * Only the table is mirrored: `knownModelContextWindow` is legitimately a
 * `function` server-side and an arrow const client-side, so it is not compared.
 * Comparison strips comments, so per-side commentary may diverge — logic can't.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compareDeclaration } from './mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER_PATH = resolve(__dirname, 'stageRunner.js');
const CLIENT_PATH = resolve(__dirname, '../../client/src/utils/providers.js');

const MIRRORED_NAMES = ['KNOWN_MODEL_CONTEXT_WINDOWS'];

describe('stageRunner↔client providers context-window mirror parity', () => {
  const serverSrc = readFileSync(SERVER_PATH, 'utf8');
  const clientSrc = readFileSync(CLIENT_PATH, 'utf8');

  it('both files are non-empty', () => {
    expect(serverSrc.length).toBeGreaterThan(100);
    expect(clientSrc.length).toBeGreaterThan(100);
  });

  for (const name of MIRRORED_NAMES) {
    it(`${name} is present and identical on both sides (code only)`, () => {
      const { serverDecl, clientDecl, serverNorm, clientNorm } =
        compareDeclaration(serverSrc, clientSrc, name);

      expect(serverDecl, `server/lib/stageRunner.js is missing: ${name}`).not.toBeNull();
      expect(clientDecl, `client/src/utils/providers.js is missing: ${name}`).not.toBeNull();
      expect(
        clientNorm,
        `"${name}" diverged — the server copy is authoritative; port the change verbatim`,
      ).toBe(serverNorm);
    });
  }
});
