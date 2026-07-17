/**
 * Mirror parity test for server/lib/canonPrompt.js ↔ client/src/lib/canonPrompt.js
 *
 * The mirrored portion includes:
 *   - SHORT_SPEC, PREVIEW_SPEC, RICH_SPEC constant bodies
 *   - normalizeKind, fragmentsFromSequence, sequenceHasAnyField function bodies
 *   - shortCanonDescriptorFragments, richCanonDescriptorFragments,
 *     mapCanonDescriptorFragments, flattenCanonDescriptorFragments,
 *     descriptorForCanonEntry, previewCanonFragments, hasCanonDescriptorContent
 *     function bodies
 *
 * The server-only section (flattenStats, flattenPalette, flattenWardrobes,
 * flattenProps, flattenNamedList, etc.) is NOT checked — those are explicitly
 * excluded from the mirror contract by the "Server-only" comment.
 *
 * Comparison strategy: strip single-line and multi-line comments, then
 * normalize whitespace before diffing (see lib/mirrorParity.js). This means
 * JSDoc divergence between the two sides does NOT fail the test — only code
 * logic differences do.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compareDeclaration, extractDeclaration } from './mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER_PATH = resolve(__dirname, 'canonPrompt.js');
const CLIENT_PATH = resolve(__dirname, '../../client/src/lib/canonPrompt.js');

// Declarations that must be textually identical (code-only, comments stripped)
const MIRRORED_NAMES = [
  'SHORT_SPEC',
  'PREVIEW_SPEC',
  'RICH_SPEC',
  'normalizeKind',
  'fragmentsFromSequence',
  'sequenceHasAnyField',
  'shortCanonDescriptorFragments',
  'richCanonDescriptorFragments',
  'mapCanonDescriptorFragments',
  'flattenCanonDescriptorFragments',
  'descriptorForCanonEntry',
  'previewCanonFragments',
  'hasCanonDescriptorContent',
];

describe('canonPrompt server↔client mirror parity', () => {
  const serverSrc = readFileSync(SERVER_PATH, 'utf8');
  const clientSrc = readFileSync(CLIENT_PATH, 'utf8');

  // Sanity-check that both files were read
  it('both files are non-empty', () => {
    expect(serverSrc.length).toBeGreaterThan(100);
    expect(clientSrc.length).toBeGreaterThan(100);
  });

  // The server file should contain the "Server-only" boundary marker
  it('server file has the Server-only boundary comment', () => {
    expect(serverSrc).toMatch(/Server-only/);
  });

  for (const name of MIRRORED_NAMES) {
    it(`${name} is present and identical on both sides (code only)`, () => {
      const { serverDecl, clientDecl, serverNorm, clientNorm } =
        compareDeclaration(serverSrc, clientSrc, name);

      expect(serverDecl, `server/lib/canonPrompt.js is missing declaration: ${name}`).not.toBeNull();
      expect(clientDecl, `client/src/lib/canonPrompt.js is missing declaration: ${name}`).not.toBeNull();
      expect(clientNorm, `"${name}" code diverged between server and client`).toBe(serverNorm);
    });
  }

  // Ensure server-only exports are NOT present in the client file
  const SERVER_ONLY_NAMES = ['flattenStats', 'flattenPalette', 'flattenWardrobes', 'flattenProps', 'flattenNamedList'];
  for (const name of SERVER_ONLY_NAMES) {
    it(`${name} is server-only (absent from client bundle)`, () => {
      const clientDecl = extractDeclaration(clientSrc, name);
      expect(clientDecl, `${name} should be server-only but was found in client/src/lib/canonPrompt.js`).toBeNull();
    });
  }
});
