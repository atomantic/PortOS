/**
 * Cross-package parity for the IC-LoRA remix-mode registry (issue #3100).
 *
 * `server/lib/icLoraWeights.js` is the source of truth; the `IC_LORA_MODES` list
 * in `client/src/lib/videoGenParams.js` is a hand-maintained mirror (the client
 * can't import the server module — it reaches into node:fs and the HF cache).
 *
 * This suite imports BOTH and asserts the fields the form relies on stay
 * identical, so a server-side change that isn't mirrored fails CI here instead
 * of silently letting the form accept a render the route rejects. The concrete
 * failure it prevents: a new weight ships with `referenceDownscaleFactor: 4`,
 * the client mirror keeps 2, and the resolution gate green-lights a request the
 * server 400s with IC_LORA_RESOLUTION_NOT_DIVISIBLE.
 *
 * It lives server-side because the server module can't load under the client
 * (jsdom) runner, but the pure client mirror loads fine here.
 */

import { describe, it, expect } from 'vitest';
import { listIcLoraWeights, icResolutionIssue as serverIcResolutionIssue } from './icLoraWeights.js';
import {
  IC_LORA_MODES as CLIENT_MODES,
  IC_LORA_MODE_VALUES as CLIENT_MODE_VALUES,
  icResolutionIssue as clientIcResolutionIssue,
} from '../../client/src/lib/videoGenParams.js';

// The fields the client mirror MUST match the server on — everything the panel
// renders or validates against. `repo` / `filename` / `sizeBytes` / `id` are
// server-only (the client never resolves a weight path) and intentionally not
// mirrored; `sizeBytes` reaches the client as `estimatedBytes` off /models/status.
const MIRRORED_FIELDS = [
  'label', 'description', 'uploadLabel',
  'referenceKind', 'referenceDownscaleFactor',
  'minReferences', 'maxReferences',
];

const SERVER_MODES = listIcLoraWeights();

describe('IC-LoRA registry — server↔client parity', () => {
  it('exposes the same mode ids in the same order', () => {
    expect(CLIENT_MODES.map((m) => m.mode)).toEqual(SERVER_MODES.map((m) => m.mode));
    expect(CLIENT_MODE_VALUES).toEqual(SERVER_MODES.map((m) => m.mode));
  });

  it('matches every mirrored field for each mode', () => {
    for (const s of SERVER_MODES) {
      const c = CLIENT_MODES.find((m) => m.mode === s.mode);
      expect(c, `client mirror missing mode ${s.mode}`).toBeTruthy();
      for (const f of MIRRORED_FIELDS) {
        expect(c[f], `${s.mode}.${f} drifted between server and client`).toEqual(s[f]);
      }
    }
  });

  it('icResolutionIssue agrees across server and client', () => {
    // Covers divisible, both-odd, one-odd, and the factor-1 (no-rule) case for
    // every registered mode — the client's warning text is also the server's
    // rejection message, so a wording drift fails here too.
    const dims = [[704, 448], [705, 448], [704, 449], [705, 449], [768, 512]];
    for (const spec of SERVER_MODES) {
      const client = CLIENT_MODES.find((m) => m.mode === spec.mode);
      for (const [w, h] of dims) {
        expect(clientIcResolutionIssue(client, w, h), `${spec.mode} ${w}x${h}`)
          .toBe(serverIcResolutionIssue(spec, w, h));
      }
    }
    expect(clientIcResolutionIssue({ referenceDownscaleFactor: 1 }, 705, 449)).toBeNull();
    expect(serverIcResolutionIssue({ referenceDownscaleFactor: 1 }, 705, 449)).toBeNull();
  });
});
