import { describe, it, expect } from 'vitest';
import {
  GENERATION_KEY_DEFS, ABILITY_GENERATION_SPEC,
  CREATIVE_COMMISSION_IMAGE_MODES, CREATIVE_COMMISSION_VIDEO_MODES,
  COMMISSION_RENDER_BACKEND_AUTO,
} from './creativeCommissionSpec.js';
import { getAbilityAdapter } from '../services/creativeCommissions/abilityAdapters.js';

// Server ↔ client parity for the Creative Commission generation spec (#6816).
//
// Before this leaf existed, `commissionForm.js` hand-mirrored every generation
// key's bounds/defaults/options and no test ever compared the two: durationMode's
// default (#4494), the video backend enum (fal/reactor, #6213/#6214), and the
// image backend enum (agy, #4901) all drifted client-side, silently, for months.
// This suite imports the CLIENT module the way `server/lib/reviewerConfig.test.js`
// imports `client/src/lib/reviewerPins.js` — the dependency-free leaf, NOT a
// component or `imageGenBackends.js`, which pulls `lucide-react` (absent from the
// server workspace) and would fail this import with ERR_MODULE_NOT_FOUND.
describe('creativeCommissionSpec parity — client mirror of the generation spec', () => {
  it('every ability field renders with matching bounds/options, and every default matches', async () => {
    const client = await import('../../client/src/components/creative-commission/commissionForm.js');
    for (const [ability, spec] of Object.entries(ABILITY_GENERATION_SPEC)) {
      const fields = client.GENERATION_FIELDS_BY_ABILITY[ability];
      expect(fields, `no client fields for ability '${ability}'`).toBeTruthy();

      // Every non-id key renders its OWN field (an 'id' key — imageModelId /
      // videoModelId — is absorbed into its backend field's `modelKey` and never
      // gets a field of its own), and no client field names a key the server
      // ability doesn't carry.
      const renderableKeys = spec.keys.filter((k) => GENERATION_KEY_DEFS[k].type !== 'id');
      expect([...fields.map((f) => f.key)].sort()).toEqual([...renderableKeys].sort());

      for (const key of renderableKeys) {
        const def = GENERATION_KEY_DEFS[key];
        const field = fields.find((f) => f.key === key);
        if (def.type === 'int') {
          expect(field.min, `${ability}.${key} min drifted`).toBe(def.min);
          expect(field.max, `${ability}.${key} max drifted`).toBe(def.max);
        } else {
          // enum: the field's option VALUES (not labels) must be exactly the
          // server's allowed values — this is what catches a mode added to
          // generationModes.js with no matching client option.
          expect([...field.options.map(([v]) => v)].sort(), `${ability}.${key} options drifted`)
            .toEqual([...def.values].sort());
        }
      }

      // Every default matches — including the id-typed keys, which still seed a
      // fresh commission's imageModelId/videoModelId even though they render no
      // field of their own.
      for (const key of spec.keys) {
        expect(client.GENERATION_DEFAULTS_BY_ABILITY[ability][key], `${ability}.${key} default drifted`)
          .toBe(GENERATION_KEY_DEFS[key].default);
      }
    }
  });

  it('every commission render-backend mode has a real client label (not a raw-value echo)', async () => {
    const client = await import('../../client/src/components/creative-commission/commissionForm.js');
    const labelFor = (options, mode) => (options.find(([v]) => v === mode) || [])[1];
    for (const mode of CREATIVE_COMMISSION_IMAGE_MODES) {
      if (mode === COMMISSION_RENDER_BACKEND_AUTO) continue;
      const label = labelFor(client.IMAGE_BACKEND_OPTIONS, mode);
      expect(label, `image backend '${mode}' has no client option at all`).toBeTruthy();
      expect(label, `image backend '${mode}' fell back to an unlabeled raw value`).not.toBe(mode);
    }
    for (const mode of CREATIVE_COMMISSION_VIDEO_MODES) {
      if (mode === COMMISSION_RENDER_BACKEND_AUTO) continue;
      const label = labelFor(client.VIDEO_BACKEND_OPTIONS, mode);
      expect(label, `video backend '${mode}' has no client option at all`).toBeTruthy();
      expect(label, `video backend '${mode}' fell back to an unlabeled raw value`).not.toBe(mode);
    }
    // Named explicitly per the issue that split this leaf out (#6816): both were
    // previously missing from the hand-copied client enum.
    expect(CREATIVE_COMMISSION_IMAGE_MODES).toContain('agy');
    expect(CREATIVE_COMMISSION_VIDEO_MODES).toContain('fal');
    expect(CREATIVE_COMMISSION_VIDEO_MODES).toContain('reactor');
  });

  it('resolves an absent durationMode identically on the server adapter and the client form', async () => {
    const client = await import('../../client/src/components/creative-commission/commissionForm.js');
    const { legacyAbsent, default: freshDefault } = GENERATION_KEY_DEFS.durationMode;
    expect(legacyAbsent).toBe('manual');
    expect(freshDefault).toBe('auto');

    // Server: an ability's sanitizer resolves a generation object with no
    // durationMode key to the LEGACY reading (a pre-#4494 record's implicit
    // meaning), never the fresh-commission default.
    expect(getAbilityAdapter('video').sanitizeGeneration({}).durationMode).toBe(legacyAbsent);
    expect(getAbilityAdapter('music-video').sanitizeGeneration({}).durationMode).toBe(legacyAbsent);

    // Client: projecting a REAL (if sparse) record resolves identically.
    expect(client.generationToForm('video', {}).durationMode).toBe(legacyAbsent);
    expect(client.generationToForm('music-video', {}).durationMode).toBe(legacyAbsent);
    expect(client.toForm({ targetAbility: 'video', generation: {} }).generation.durationMode).toBe(legacyAbsent);

    // A brand-new/blank commission (no record at all) seeds the fresh default
    // instead — the one case the two readings are meant to disagree.
    expect(client.toForm({}).generation.durationMode).toBe(freshDefault);
    expect(client.blankForm().generation.durationMode).toBe(freshDefault);
    expect(client.GENERATION_DEFAULTS_BY_ABILITY.video.durationMode).toBe(freshDefault);
  });
});
