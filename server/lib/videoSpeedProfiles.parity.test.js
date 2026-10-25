/**
 * Cross-package parity for the speed-profile sentinel and mode gate (#4875).
 *
 * Like the prompt-conditioner sentinel next door, the OPTIONS themselves are
 * not mirrored — the server attaches each entry's own `speedProfiles`
 * (`applyVideoSpeedProfiles`) and the client reads them straight off the model,
 * so the picker offers whatever this install's registry declares. Two things
 * ARE duplicated, and each carries weight in both directions:
 *
 *   1. The "unchanged" sentinel. The client's submit builder DROPS the field
 *      when it holds this value and the server treats an absent field and this
 *      id identically (`isDefaultSpeedProfile`). Diverged, the client would
 *      post `speedProfileId: 'quality'` to a server that reads it as a real
 *      profile id, log a decline on every default render, and — worse —
 *      persist it into history, splitting the ETA estimator's default bucket
 *      in two so neither half accumulates enough samples to estimate from.
 *
 *   2. The mode gate. The panel hides a profile the current mode isn't in;
 *      the server declines one for the same reason. Diverged, the picker would
 *      offer a fast profile on an fflf render that silently renders at the
 *      model's own sampler — exactly the dead speed affordance this feature
 *      exists to avoid.
 *
 * Lives server-side because the server module can't load under the client
 * (jsdom) runner, while the pure client mirror loads fine here.
 */

import { describe, it, expect } from 'vitest';
import {
  SPEED_PROFILE_DEFAULT_ID, isDefaultSpeedProfile, applyVideoSpeedProfiles,
  speedProfileDeclineReason, VIDEO_SPEED_PROFILES, resolveVideoSpeedProfileForModes,
} from './videoSpeedProfiles.js';
import {
  DEFAULT_SPEED_PROFILE_ID as CLIENT_DEFAULT_SPEED_PROFILE_ID,
  normalizeSpeedProfileForModel,
  speedProfileIdFromRecord,
  speedProfilesForMode,
  speedProfilesForModel,
  isDefaultSpeedProfileId,
  videoChainChunkModes,
} from '../../client/src/lib/videoGenParams.js';
import { resolveContextFrames, resolveContinuityStrategy } from './videoContinuity.js';

// Every shipped entry, decorated exactly as the registry decorates it.
const decoratedEntries = Object.entries(VIDEO_SPEED_PROFILES).map(([id, spec]) => (
  applyVideoSpeedProfiles([{ id, repo: spec.shippedRepo, revision: spec.shippedRevision, ...spec.profiles[0]?.model }])[0]
));

// Every mode PortOS can submit, so a profile that ever widens its `modes`
// can't drift the two sides apart.
const ALL_MODES = ['text', 'image', 'fflf', 'extend', 'a2v', 'ic-control', 'ic-colorize'];

describe('video speed-profile client/server parity', () => {
  it('mirrors the default sentinel exactly', () => {
    expect(CLIENT_DEFAULT_SPEED_PROFILE_ID).toBe(SPEED_PROFILE_DEFAULT_ID);
  });

  // The client emits this value in three places (initial state, the
  // model-change reconcile, the record restore). Every one must land on
  // something the server reads as "no override".
  it('normalizes to a value the server treats as unchanged, for every shipped model', () => {
    for (const model of decoratedEntries) {
      expect(isDefaultSpeedProfile(normalizeSpeedProfileForModel('not-a-profile', model))).toBe(true);
      expect(isDefaultSpeedProfile(normalizeSpeedProfileForModel(undefined, model))).toBe(true);
      expect(isDefaultSpeedProfile(speedProfileIdFromRecord(undefined))).toBe(true);
      expect(isDefaultSpeedProfile(speedProfileIdFromRecord(''))).toBe(true);
    }
  });

  it('agrees that a model with no profiles has none, and one with them keeps them', () => {
    expect(speedProfilesForModel({})).toEqual([]);
    for (const model of decoratedEntries) {
      expect(speedProfilesForModel(model).map((p) => p.id))
        .toEqual(model.speedProfiles.map((p) => p.id));
      // A real id survives normalization; only then is the picker "active".
      const id = model.speedProfiles[0].id;
      expect(normalizeSpeedProfileForModel(id, model)).toBe(id);
      expect(isDefaultSpeedProfileId(id)).toBe(isDefaultSpeedProfile(id));
      expect(isDefaultSpeedProfileId(SPEED_PROFILE_DEFAULT_ID)).toBe(true);
    }
  });

  // The gate the panel applies (`p.modes.includes(mode)`) must accept exactly
  // the modes the server does not decline — checked across every mode PortOS
  // can submit, so a profile that ever widens its `modes` can't drift the two.
  // Every SHIPPED profile declares `modes`, so the two sides' fallback for a
  // profile that DOESN'T would never be exercised by the loop below — and could
  // silently drift back apart. Both must read a missing field as the two-stage
  // set, not as "unrestricted": a permissive client would offer a profile on
  // fflf that the server then declines.
  it('agrees on the fallback for a profile that declares no modes', () => {
    const model = { id: 'x', speedProfiles: [{ id: 'bare', steps: 8, guidance: 1.0 }] };
    for (const mode of ALL_MODES) {
      const clientOffers = speedProfilesForMode(model, mode).some((p) => p.id === 'bare');
      const serverAccepts = speedProfileDeclineReason({ model, profileId: 'bare', mode }) === null;
      expect({ mode, offers: clientOffers }).toEqual({ mode, offers: serverAccepts });
    }
    // And that shared fallback IS the two-stage set.
    expect(speedProfilesForMode(model, 'text')).toHaveLength(1);
    expect(speedProfilesForMode(model, 'fflf')).toHaveLength(0);
  });

  // A chained render is one clip whose chunks run in different modes; the
  // server applies a profile only when EVERY chunk accepts it
  // (resolveVideoSpeedProfileForModes), and the picker gates on the same list.
  it('agrees on a multi-mode (chained) request', () => {
    for (const model of decoratedEntries) {
      for (const profile of model.speedProfiles) {
        for (const modes of [['text', 'image'], ['text', 'extend'], ['image', 'extend'], ['text']]) {
          const clientOffers = speedProfilesForMode(model, modes).some((p) => p.id === profile.id);
          const serverAccepts = resolveVideoSpeedProfileForModes({ model, profileId: profile.id, modes }) !== null;
          expect({ modes, offers: clientOffers }).toEqual({ modes, offers: serverAccepts });
        }
      }
    }
  });

  // The chain gate turns on resolveContinuityStrategy, whose input is
  // resolveContextFrames' output — and THAT reads absent/''/non-finite as the
  // 22-frame default rather than zero. A client that read an omitted value as
  // "no window" would offer Fast for a chain the server declines wholesale.
  it('derives the same continuation strategy for every contextFrames spelling', () => {
    const model = decoratedEntries[0];
    for (const requested of [undefined, null, '', Number.NaN, 0, '0', 22, 73]) {
      const serverStrategy = resolveContinuityStrategy({
        model, contextFrames: resolveContextFrames(requested),
      });
      const clientModes = videoChainChunkModes({
        model, mode: 'text', chaining: true, contextFrames: requested,
      });
      const clientStrategy = clientModes[1] === 'extend' ? 'window' : 'frame';
      expect({ requested: String(requested), strategy: clientStrategy })
        .toEqual({ requested: String(requested), strategy: serverStrategy });
    }
  });

  it('gates every shipped profile on the same modes the server accepts', () => {
    for (const model of decoratedEntries) {
      for (const profile of model.speedProfiles) {
        for (const mode of ALL_MODES) {
          const clientOffers = speedProfilesForMode(model, mode).some((p) => p.id === profile.id);
          const serverAccepts = speedProfileDeclineReason({ model, profileId: profile.id, mode }) === null;
          expect({ mode, offers: clientOffers }).toEqual({ mode, offers: serverAccepts });
        }
      }
    }
  });
});
