/**
 * Mirror parity test for server/lib/postTopics.js ↔ the client's POST topic
 * mirror in client/src/components/meatspace/post/constants.js (issue #3252).
 *
 * The registry is server-owned; the client mirrors the plain data so the
 * launcher, Practice Plan, and config UI can gate without a round-trip. If the
 * two drift, a topic the server filters on would be invisible to the UI (or
 * vice versa) — hence a hard parity assert rather than a convention.
 *
 * Mirrored: the POST_TOPICS literal and the two enablement predicates that the
 * client re-implements verbatim. NOT mirrored: `resolveTopicForDrillType`, which
 * the server backs with a prebuilt lookup map (built once at module load) while
 * the client does a linear find over a 7-entry list — same contract, different
 * implementation, so it's asserted behaviorally in postTopics.test.js instead.
 *
 * Comparison strips comments and normalizes whitespace (see lib/mirrorParity.js),
 * so JSDoc divergence is allowed and only code differences fail.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compareDeclaration } from './mirrorParity.js';
import { POST_TOPICS } from './postTopics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER_PATH = resolve(__dirname, 'postTopics.js');
const CLIENT_PATH = resolve(__dirname, '../../client/src/components/meatspace/post/constants.js');

const MIRRORED_NAMES = ['POST_TOPICS', 'isTopicEnabled', 'isMemoryPracticeEnabled', 'isMemoryItemEnabled'];

describe('postTopics server↔client mirror parity', () => {
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

      expect(serverDecl, `server/lib/postTopics.js is missing declaration: ${name}`).not.toBeNull();
      expect(clientDecl, `client post constants.js is missing declaration: ${name}`).not.toBeNull();
      expect(clientNorm, `"${name}" code diverged between server and client`).toBe(serverNorm);
    });
  }

  it('the client declares presentation for every topic', () => {
    // TOPIC_UI is client-only (icons/colors have no server meaning), but a
    // topic added server-side with no UI row would render unstyled and,
    // for a domain, lose its per-domain time budget.
    for (const topic of POST_TOPICS) {
      expect(clientSrc, `TOPIC_UI is missing a row for topic "${topic.id}"`)
        .toMatch(new RegExp(`^\\s*${topic.id}:\\s*\\{\\s*icon:`, 'm'));
    }
  });
});
