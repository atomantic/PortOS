/**
 * Cross-package parity for the render-target alphabet (#3231).
 *
 * `server/lib/renderTargets.js` is the source of truth; the client's
 * `RENDER_TARGET_OPTIONS` (client/src/lib/imageGenBackends.js) is a
 * hand-maintained mirror feeding the Settings → Image Gen → Defaults tab. A
 * typo'd or renamed id in the client list would make the strict
 * `renderDefaultsSettingsSchema` 400 the ENTIRE settings PUT — and both
 * suites would stay green, because the client test mocks updateSettings
 * (the exact mocked-client-suite blind spot this repo has shipped before).
 * This suite imports both and fails on drift instead.
 *
 * Lives server-side because the server runner loads the pure client lib fine,
 * while the client (jsdom) runner can't load server modules.
 */

import { describe, it, expect } from 'vitest';
import { RENDER_TARGETS, RENDER_TARGET_BACKEND_AUTO } from './renderTargets.js';
import { EDIT_INCAPABLE_IMAGE_MODES } from '../services/imageGen/modes.js';
// Import the node-safe leaf, NOT imageGenBackends.js — that module imports
// lucide-react, which is not installed in the server CI job (this exact import
// broke main's CI when Phase 2 landed pointing at imageGenBackends).
import {
  RENDER_TARGET_OPTIONS as CLIENT_OPTIONS,
  RENDER_TARGET_BACKEND_AUTO as CLIENT_AUTO,
  I2I_CAPABLE_MODES as CLIENT_I2I_CAPABLE,
} from '../../client/src/lib/imageGenModes.js';

// Targets the Settings UI deliberately does NOT list — a pin nobody's
// resolver reads would be a control that silently does nothing. Empty since
// the Phase 4 video lane wired music-video (the last unlisted target).
const DELIBERATELY_UNLISTED = new Set([]);

describe('render-target client mirror parity (#3231)', () => {
  it('every client option id is a real server render target', () => {
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

  it('the auto sentinel matches across packages', () => {
    expect(CLIENT_AUTO).toBe(RENDER_TARGET_BACKEND_AUTO);
  });
});

/**
 * The client's `I2I_CAPABLE_MODES` is what the i2i-only pickers (the sprite fork
 * modal, #3331) filter their backend options through, and the server's
 * `EDIT_INCAPABLE_IMAGE_MODES` is what rejects such a mode at request time. If a
 * future edit-incapable backend were added server-side and not removed from the
 * client list, every i2i picker would go back to offering a backend the server
 * 400s — the exact bug #3331 fixed, re-introduced silently.
 *
 * Only one direction is asserted: the client list ALSO omits `external`, which is
 * edit-capable server-side but isn't queueable and has no i2i UI, so an equality
 * check would be wrong.
 */
describe('edit-capability client mirror parity (#3331)', () => {
  it('no server edit-incapable backend appears in the client i2i-capable list', () => {
    for (const mode of EDIT_INCAPABLE_IMAGE_MODES) {
      expect(CLIENT_I2I_CAPABLE.includes(mode),
        `"${mode}" is edit-incapable server-side but still listed in the client I2I_CAPABLE_MODES`).toBe(false);
    }
  });
});
