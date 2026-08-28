/**
 * Mirror parity test for server/lib/postRotation.js ↔ client/src/lib/postRotation.js
 *
 * The whole module is mirrored: the server's recommendation tiers and the
 * client's Quick-session domain picks must rotate identically, or the two
 * surfaces disagree about which drill is "next" on the same day.
 *
 * Comments are stripped before diffing (see lib/mirrorParity.js), so the header
 * pointing at the twin file may differ; code logic may not.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compareDeclaration } from './mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, 'postRotation.js');
const CLIENT_PATH = resolve(__dirname, '../../client/src/lib/postRotation.js');

const MIRRORED_NAMES = ['dayOrdinal', 'dayRotationIndex', 'orderByRecencyRotation'];

describe('postRotation server↔client mirror parity', () => {
  const serverSrc = readFileSync(SERVER_PATH, 'utf8');
  const clientSrc = readFileSync(CLIENT_PATH, 'utf8');

  for (const name of MIRRORED_NAMES) {
    it(`${name} is present and identical on both sides (code only)`, () => {
      const { serverDecl, clientDecl, serverNorm, clientNorm } =
        compareDeclaration(serverSrc, clientSrc, name);

      expect(serverDecl, `server/lib/postRotation.js is missing declaration: ${name}`).not.toBeNull();
      expect(clientDecl, `client/src/lib/postRotation.js is missing declaration: ${name}`).not.toBeNull();
      expect(clientNorm, `"${name}" code diverged between server and client`).toBe(serverNorm);
    });
  }
});
