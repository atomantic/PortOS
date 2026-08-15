import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { compareDeclaration } from './mirrorParity.js';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_COPY = join(here, 'shotGrammar.js');
const CLIENT_COPY = join(here, '../../client/src/lib/shotGrammar.js');

describe('shotGrammar — server/client vocabulary parity', () => {
  const server = readFileSync(SERVER_COPY, 'utf8');
  const client = readFileSync(CLIENT_COPY, 'utf8');

  for (const name of ['SHOT_TYPES', 'SCREEN_DIRECTIONS']) {
    it(`keeps ${name} identical`, () => {
      const { clientDecl, serverNorm, clientNorm } = compareDeclaration(server, client, name);
      expect(clientDecl, `client/src/lib/shotGrammar.js is missing ${name}`).not.toBeNull();
      expect(clientNorm).toBe(serverNorm);
    });
  }
});
