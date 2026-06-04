/**
 * Byte-for-byte parity for the persona trait-blend helper.
 *
 * `server/lib/personaTraitBlend.js` is the source of truth; `client/src/lib/
 * personaTraitBlend.js` is a mirror the Personas UI imports for its live voice
 * preview. The module's docstring promises the two stay byte-identical (so the
 * preview wording matches the directive the embodied twin actually sees) — this
 * suite enforces that promise: an edit to one copy that isn't mirrored fails CI
 * here instead of letting the UI silently diverge from the server directive.
 *
 * It lives server-side because the parity check only needs filesystem reads,
 * which the server (node) runner has.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_COPY = join(here, 'personaTraitBlend.js');
const CLIENT_COPY = join(here, '../../client/src/lib/personaTraitBlend.js');

describe('personaTraitBlend — server↔client byte parity', () => {
  it('keeps the client mirror byte-for-byte identical to the server source', () => {
    const server = readFileSync(SERVER_COPY, 'utf-8');
    const client = readFileSync(CLIENT_COPY, 'utf-8');
    expect(client).toBe(server);
  });
});
