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
import { CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODES } from './generationModes.js';
import { EDIT_INCAPABLE_IMAGE_MODES } from '../services/imageGen/modes.js';
import { cloudPromptRequired, maxInputImages } from '../services/imageGen/cloudProviderConfig.js';
// Import the node-safe leaf, NOT imageGenBackends.js — that module imports
// lucide-react, which is not installed in the server CI job (this exact import
// broke main's CI when Phase 2 landed pointing at imageGenBackends).
import {
  RENDER_TARGET as CLIENT_RENDER_TARGET,
  RENDER_TARGET_OPTIONS as CLIENT_OPTIONS,
  RENDER_TARGET_BACKEND_AUTO as CLIENT_AUTO,
  I2I_CAPABLE_MODES as CLIENT_I2I_CAPABLE,
  MAX_INPUT_IMAGES as CLIENT_MAX_INPUT_IMAGES,
  cloudPromptRequired as clientCloudPromptRequired,
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

  // The client's named-id map is the subset of targets the CLIENT resolves
  // itself via `renderTargetPin`. A drifting id there is worse than a drifting
  // option label: the pin silently reads an absent `settings.renderDefaults`
  // key and every render falls through to the install default with no error.
  it('every client RENDER_TARGET id matches the server constant of the same name', () => {
    for (const [name, id] of Object.entries(CLIENT_RENDER_TARGET)) {
      expect(RENDER_TARGET[name], `client RENDER_TARGET.${name} has no server counterpart`).toBe(id);
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
 * Both directions are asserted: the two sets are exact complements over the mode
 * alphabet, so a backend that gains or loses input-image support server-side has
 * to be reflected in the client list.
 */
describe('edit-capability client mirror parity (#3331)', () => {
  it('the client i2i-capable list is the exact complement of the server incapable list', () => {
    const expected = IMAGE_GEN_MODES.filter((m) => !EDIT_INCAPABLE_IMAGE_MODES.includes(m));
    expect([...CLIENT_I2I_CAPABLE].sort()).toEqual([...expected].sort());
  });
});

/**
 * The per-provider input-image capabilities live on `CLOUD_PROVIDER_SPECS`
 * (server/services/imageGen/cloudProviderConfig.js) and are mirrored into the
 * client so the Image Gen form can offer exactly the reference slots the backend
 * accepts and gate the Generate button on the same prompt rule the server
 * enforces. Drift in either direction is invisible to both suites on its own:
 * the client tests assert the client's own literals, and the server never loads
 * the client mirror. A raised/lowered cap would make the form offer a slot the
 * server silently drops; a changed prompt rule would enable a button on a render
 * `prepareParams` then 400s.
 */
describe('cloud input-image capability client mirror parity', () => {
  it('every cloud CLI mirrors its server maxInputImages', () => {
    for (const mode of CLOUD_IMAGE_GEN_MODES) {
      // An absent client entry and a null server cap are the same fact ("this
      // tool declares no maximum"), so normalize before comparing — otherwise
      // the mirror could drop a real cap and still pass.
      expect(CLIENT_MAX_INPUT_IMAGES[mode] ?? null,
        `client MAX_INPUT_IMAGES["${mode}"] does not match the server spec's maxInputImages`)
        .toBe(maxInputImages(mode));
    }
  });

  it('the client prompt-required predicate agrees with the server for every mode', () => {
    for (const mode of IMAGE_GEN_MODES) {
      for (const hasInputImage of [false, true]) {
        expect(clientCloudPromptRequired(mode, hasInputImage),
          `client cloudPromptRequired("${mode}", ${hasInputImage}) disagrees with the server`)
          .toBe(cloudPromptRequired(mode, hasInputImage));
      }
    }
  });
});
