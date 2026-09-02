/**
 * Mirror parity test for the effort ladders and model sentinels shared by
 * server/lib/providerModels.js and client/src/utils/providers.js (the browser
 * cannot import server code, so the tables are duplicated on each side behind a
 * "keep in sync" comment).
 *
 * Until now that comment was the only pin: each side had its own hardcoded
 * expectations (`providerModels.test.js` / `providers.test.js`), so an effort
 * level or Codex Ultra model added to one copy alone left BOTH suites green.
 * The two ends then disagree about what the user may select — an effort the
 * picker offers and the server's ladder rejects is clamped to something else or
 * dropped, and an ultra-capable model the client hasn't heard of loses its
 * `ultra` rung entirely.
 *
 * Only the DATA is mirrored. `effortLevelsForProvider` / `resolveCliEffort` are
 * legitimately `function` server-side and arrow consts client-side (and the
 * client's ladder resolution falls back to the server-published
 * `effortLevels`/`effortLevelsByModel` fields, which have no server-side
 * counterpart), so they are not compared. Comparison strips comments, so
 * per-side commentary may diverge — logic can't.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compareDeclaration } from './mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER_PATH = resolve(__dirname, 'providerModels.js');
const CLIENT_PATH = resolve(__dirname, '../../client/src/utils/providers.js');

const MIRRORED_NAMES = [
  'CLAUDE_EFFORT_LEVELS',
  'CODEX_EFFORT_LEVELS',
  'CODEX_ULTRA_EFFORT_LEVELS',
  'ANTIGRAVITY_EFFORT_LEVELS',
  'OPENCODE_LOCAL_EFFORT_LEVELS',
  'CURSOR_EFFORT_LEVELS',
  // The ladder a Codex model gets is model-gated, so the gate's membership is
  // as load-bearing as the ladders themselves: a new Ultra model added
  // server-side only tops the client picker out at `max`.
  'CODEX_ULTRA_MODELS',
  // The clamp order. Divergence here is silent — every value stays "known", it
  // just resolves to a different rung than the run will actually use.
  'EFFORT_RANK',
  'CONFIGURED_DEFAULT_SENTINELS',
  // Derived FROM ANTIGRAVITY_EFFORT_LEVELS on both sides, and pinned anyway:
  // the suffix split is what turns `gemini-3.6-flash-high` into a base model
  // plus an effort, so a divergence strands a stored model id.
  'ANTIGRAVITY_EFFORT_SUFFIX_RE',
];

describe('providerModels↔client providers effort-ladder mirror parity', () => {
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

      expect(serverDecl, `server/lib/providerModels.js is missing: ${name}`).not.toBeNull();
      expect(clientDecl, `client/src/utils/providers.js is missing: ${name}`).not.toBeNull();
      expect(
        clientNorm,
        `"${name}" diverged — the server copy is authoritative; port the change verbatim`,
      ).toBe(serverNorm);
    });
  }
});
