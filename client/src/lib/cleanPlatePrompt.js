/**
 * Clean-plate prompt builder for setting canon entries (Cluster A — A4).
 *
 * A "clean plate" is the production-art term for an empty-location reference
 * shot — no people, no foreground props — used as a background plate for
 * downstream composite work. For PortOS it's a specialized variant of the
 * existing setting reference render: same model + size + style, but a
 * prompt prefix that strips character / action references and a negative
 * prompt that explicitly excludes people.
 *
 * Output mirrors `composeStyledPrompt`: `{ prompt, negativePrompt }`.
 *
 * Descriptor body delegates to `richCanonDescriptorFragments('place', …)` so
 * `era` / `weather` flow through alongside `description` / `palette` /
 * `recurringDetails` — visual prompts benefit from period/atmosphere cues.
 */

import { mapCanonDescriptorFragments, richCanonDescriptorFragments } from './canonPrompt.js';

const CLEAN_PLATE_PREFIX = 'Empty location, no characters, no people, edge-to-edge composition';
const CLEAN_PLATE_NEGATIVE = 'people, characters, faces, hands, figures, person';

export function composeCleanPlatePrompt(setting, userNegative = '') {
  if (!setting || typeof setting !== 'object') {
    return { prompt: CLEAN_PLATE_PREFIX, negativePrompt: CLEAN_PLATE_NEGATIVE };
  }
  // INT/EXT + time-of-day stamp the lighting/composition cues the diffusion
  // model actually weights; redundant with description sometimes but cheap.
  const intExt = setting.intExt === 'INT' ? 'interior' : setting.intExt === 'EXT' ? 'exterior' : '';
  const tod = typeof setting.timeOfDay === 'string' && setting.timeOfDay ? setting.timeOfDay : '';
  const meta = [intExt, tod].filter(Boolean).join(', ');
  const descParts = mapCanonDescriptorFragments(
    richCanonDescriptorFragments('place', setting),
    { trailingPeriod: true },
  );
  const promptSegs = [
    CLEAN_PLATE_PREFIX,
    meta ? `(${meta})` : '',
    descParts.join(' '),
  ].filter(Boolean);
  const negative = [userNegative.trim(), CLEAN_PLATE_NEGATIVE].filter(Boolean).join(', ');
  return {
    prompt: promptSegs.join('. '),
    negativePrompt: negative,
  };
}

export { CLEAN_PLATE_PREFIX, CLEAN_PLATE_NEGATIVE };
