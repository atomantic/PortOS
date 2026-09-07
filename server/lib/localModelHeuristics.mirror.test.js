/**
 * Mirror parity test for the tool-use capability regex, which exists in two
 * copies by architecture:
 *   1. server/lib/localModelHeuristics.js — authoritative;
 *   2. server/lib/aiToolkit/providers.js — the vendored toolkit may not import
 *      out of its own directory (see aiToolkit/AGENTS.md), so TOOL_USE_RE is
 *      inlined there too.
 *
 * A family added to one copy alone would leave every suite green while a model
 * the server accepts for tool use gets a "no known tool use" warning in the
 * agent picker. Both copies are the array form, so they are compared as text
 * (comments stripped, whitespace normalized). The browser re-exports the server
 * predicates, so it needs no pin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compareDeclaration } from './mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, 'localModelHeuristics.js');
const TOOLKIT_PATH = resolve(__dirname, 'aiToolkit/providers.js');

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
