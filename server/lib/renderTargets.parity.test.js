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
import { RENDER_TARGET, RENDER_TARGETS, RENDER_TARGET_BACKEND_AUTO } from './renderTargets.js';
import {
  RENDER_TARGET_OPTIONS as CLIENT_OPTIONS,
  RENDER_TARGET_BACKEND_AUTO as CLIENT_AUTO,
} from '../../client/src/lib/imageGenBackends.js';

// Targets the Settings UI deliberately does NOT list yet — a pin nobody's
// resolver reads would be a control that silently does nothing. Shrink this
// as phases land (music-video ships with the Phase 4 video lane).
const DELIBERATELY_UNLISTED = new Set([RENDER_TARGET.MUSIC_VIDEO]);

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
