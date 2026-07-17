/**
 * Mirror parity test for server/lib/extensionErrors.js ↔ client/src/lib/extensionErrors.js
 *
 * Both ends filter extension errors (each protects its own 1/sec throttle from
 * being spent on an un-actionable error), so the two copies must agree on what
 * counts as one. A drifted client would send noise the server drops — or worse,
 * silently drop a real error the server would have kept.
 *
 * Comparison strips comments, so the intentionally divergent header commentary
 * does not fail the test — only logic does.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compareDeclaration } from './mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER_PATH = resolve(__dirname, 'extensionErrors.js');
const CLIENT_PATH = resolve(__dirname, '../../client/src/lib/extensionErrors.js');

const MIRRORED_NAMES = ['EXTENSION_SCHEME_RE', 'EXTENSION_MESSAGE_RE', 'isExtensionError'];

describe('extensionErrors server↔client mirror parity', () => {
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

      expect(serverDecl, `server/lib/extensionErrors.js is missing: ${name}`).not.toBeNull();
      expect(clientDecl, `client/src/lib/extensionErrors.js is missing: ${name}`).not.toBeNull();
      expect(
        clientNorm,
        `"${name}" diverged — the server copy is authoritative; port the change verbatim`,
      ).toBe(serverNorm);
    });
  }
});
