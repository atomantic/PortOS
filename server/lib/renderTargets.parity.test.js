/**
 * Cross-package parity for the render-target Settings rows (#3231).
 *
 * Nothing else needs binding any more. The backend, render-target, and
 * execution-lane ALPHABETS re-export from the dependency-free server leaves
 * (`lib/generationModes.js`, `lib/renderTargets.js`), and #6590 moved the
 * per-backend CAPABILITY literals — the input-image caps, the prompt rule, the
 * i2i-capable complement of `EDIT_INCAPABLE_IMAGE_MODES`, the shipped default
 * models — into `lib/imageGenCapabilities.js`, which the client re-exports too.
 * Facts that are imported cannot drift, so asserting them here would only
 * restate an `export`.
 *
 * What remains is the one thing the client genuinely owns: which render targets
 * get a Defaults row in Settings. That is a presentation decision with no
 * server counterpart to import, so it is the only place drift is still possible
 * — and it is invisible to either suite alone, because the client tests assert
 * the client's own list and the server never loads it.
 *
 * Lives server-side because the server runner loads the pure client lib fine,
 * while the client (happy-dom) runner can't load service modules.
 */

import { describe, it, expect } from 'vitest';
import { RENDER_TARGET, RENDER_TARGETS } from './renderTargets.js';
// Import the node-safe leaf, NOT imageGenBackends.js — that module imports
// lucide-react, which is not installed in the server CI job (this exact import
// broke main's CI when Phase 2 landed pointing at imageGenBackends).
import { RENDER_TARGET_OPTIONS as CLIENT_OPTIONS } from '../../client/src/lib/imageGenModes.js';

// Targets the Settings UI deliberately does NOT list — a pin nobody's
// resolver reads would be a control that silently does nothing. FableLoom
// production exposes per-run controls instead of a persistent Settings pin;
// its server-only target exists so the service still goes through the shared
// resolver guard.
const DELIBERATELY_UNLISTED = new Set([RENDER_TARGET.FABLELOOM_PRODUCTION]);

describe('render-target Settings rows (#3231)', () => {
  // The rows key their ids off the server's RENDER_TARGET map, so a mistyped
  // member name surfaces here as an `undefined` id rather than as a 400 on
  // the whole settings PUT.
  it('every Settings row names a real server render target', () => {
    const server = new Set(RENDER_TARGETS);
    for (const { id } of CLIENT_OPTIONS) {
      expect(server.has(id), `client RENDER_TARGET_OPTIONS id "${id}" is not in server RENDER_TARGETS`).toBe(true);
    }
  });

  it('every server target is either listed client-side or deliberately unlisted', () => {
    const client = new Set(CLIENT_OPTIONS.map((o) => o.id));
    for (const id of RENDER_TARGETS) {
      expect(client.has(id) || DELIBERATELY_UNLISTED.has(id),
        `server render target "${id}" is neither in client RENDER_TARGET_OPTIONS nor allowlisted as deliberately unlisted`).toBe(true);
    }
  });
});
