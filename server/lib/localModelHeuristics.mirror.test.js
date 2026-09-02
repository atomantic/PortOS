/**
 * Mirror parity test for the local-model capability regexes, which exist in
 * three copies by architecture:
 *   1. server/lib/localModelHeuristics.js — authoritative;
 *   2. client/src/utils/providers.js — the browser cannot import server code;
 *   3. server/lib/aiToolkit/providers.js — the vendored toolkit may not import
 *      out of its own directory (see aiToolkit/AGENTS.md), so TOOL_USE_RE is
 *      inlined there too.
 *
 * All three were pinned by a "keep all three in lockstep" comment and by
 * per-side hardcoded id lists (`providers.test.js`'s
 * `describe('isToolUseModel (mirror of server localModelHeuristics)')` never
 * reads the server file), so a family added to one copy alone left every suite
 * green. The consequence is user-visible in both directions: a model the server
 * accepts for tool use gets a "no known tool use" warning in the agent picker,
 * and an embedding model the client hasn't learned to recognise is offered in a
 * generation picker, where the daemon answers `400 … does not support chat`.
 *
 * The server spells VISION_RE / TOOL_USE_RE as a multi-line array of
 * alternatives so each one can carry its own comment; the client inlines the
 * same pattern as a single literal. Declaration TEXT therefore cannot be
 * compared — `compareRegexDeclaration` compares what the two patterns match
 * instead. Typesetting is irrelevant; the accepted id set is not. The toolkit
 * copy is the array form on both sides, so it is compared as text.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compareDeclaration, compareRegexDeclaration } from './mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER_PATH = resolve(__dirname, 'localModelHeuristics.js');
const CLIENT_PATH = resolve(__dirname, '../../client/src/utils/providers.js');
const TOOLKIT_PATH = resolve(__dirname, 'aiToolkit/providers.js');

// [server declaration, the client predicate that inlines it]
const MIRRORED_REGEXES = [
  ['EMBEDDING_RE', 'isEmbeddingModel'],
  ['VISION_RE', 'isVisionModel'],
  ['TOOL_USE_RE', 'isToolUseModel'],
];

describe('localModelHeuristics↔client providers capability-regex mirror parity', () => {
  const serverSrc = readFileSync(SERVER_PATH, 'utf8');
  const clientSrc = readFileSync(CLIENT_PATH, 'utf8');

  it('both files are non-empty', () => {
    expect(serverSrc.length).toBeGreaterThan(100);
    expect(clientSrc.length).toBeGreaterThan(100);
  });

  for (const [serverName, clientName] of MIRRORED_REGEXES) {
    it(`${serverName} accepts the same ids as the client's ${clientName}`, () => {
      const { serverDecl, clientDecl, serverSource, clientSource } =
        compareRegexDeclaration(serverSrc, clientSrc, serverName, clientName);

      expect(serverDecl, `server/lib/localModelHeuristics.js is missing: ${serverName}`).not.toBeNull();
      expect(clientDecl, `client/src/utils/providers.js is missing: ${clientName}`).not.toBeNull();
      expect(
        serverSource,
        `server/lib/localModelHeuristics.js#${serverName} is neither a /…/i literal nor the new RegExp([…].join('|'), 'i') form`,
      ).not.toBeNull();
      expect(
        clientSource,
        `client/src/utils/providers.js#${clientName} no longer inlines a /…/i literal`,
      ).not.toBeNull();
      expect(
        clientSource,
        `"${serverName}" diverged from the client's ${clientName} — the server copy is authoritative; port the alternatives verbatim`,
      ).toBe(serverSource);
    });
  }
});

describe('localModelHeuristics↔aiToolkit TOOL_USE_RE mirror parity', () => {
  const serverSrc = readFileSync(SERVER_PATH, 'utf8');
  const toolkitSrc = readFileSync(TOOLKIT_PATH, 'utf8');

  it('is present and identical in both server copies (code only)', () => {
    const { serverDecl, clientDecl, serverNorm, clientNorm } =
      compareDeclaration(serverSrc, toolkitSrc, 'TOOL_USE_RE');

    expect(serverDecl, 'server/lib/localModelHeuristics.js is missing: TOOL_USE_RE').not.toBeNull();
    expect(clientDecl, 'server/lib/aiToolkit/providers.js is missing: TOOL_USE_RE').not.toBeNull();
    expect(
      clientNorm,
      'TOOL_USE_RE diverged — the localModelHeuristics copy is authoritative; port the change verbatim',
    ).toBe(serverNorm);
  });
});
