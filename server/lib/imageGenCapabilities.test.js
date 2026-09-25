import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  AGY_IMAGEGEN_DEFAULT_MODEL,
  CODEX_IMAGEGEN_DEFAULT_MODEL,
  LOCAL_IMAGEGEN_DEFAULT_MODEL,
} from './imageGenCapabilities.js';
import { pickAntigravityRelayModel } from './providerModels.js';

// The cheap-tier pins here are code-level defaults: no migration carries them,
// so nothing forces them to move when a vendor retires a model id, and they
// went out of sync exactly that way — see AGY_IMAGEGEN_DEFAULT_MODEL for the
// incident this guard exists to make impossible to ship again.
//
// Provider pins are checked against data.reference/providers.json, while the
// local image pin is checked against data.reference/media-models.json. Those
// seeds are what fresh installs start with and must contain every code default.
//
// Read as JSON instead of importing the toolkit's own catalog module — that
// module pulls the whole provider subtree, and this is a two-value check (see
// the server suite import budget in `importScoping.test.js`).
describe('shipped image-gen defaults stay in the seeded catalogs', () => {
  const SEED_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../data.reference/providers.json');
  const MEDIA_SEED_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../data.reference/media-models.json');
  const seeded = JSON.parse(readFileSync(SEED_PATH, 'utf8')).providers || {};
  const modelsFor = (id) => (Array.isArray(seeded[id]?.models) ? seeded[id].models : []);

  it.each([
    ['antigravity-cli', AGY_IMAGEGEN_DEFAULT_MODEL],
    ['codex', CODEX_IMAGEGEN_DEFAULT_MODEL],
  ])('%s still serves the pin %s', (providerId, pin) => {
    const models = modelsFor(providerId);
    // Guards the lookup itself: a renamed provider id would otherwise make
    // every assertion below pass against an empty list.
    expect(models.length, `no seeded models for ${providerId}`).toBeGreaterThan(0);
    expect(
      models,
      `${pin} is no longer in the shipped ${providerId} catalog — re-point the pin in imageGenCapabilities.js to a tier the vendor still serves.`,
    ).toContain(pin);
  });

  // Stronger than "the pin exists": the agy pin is the id the render-time heal
  // would choose anyway, so the constant is a cached answer to the rule rather
  // than a second, hand-maintained opinion that can quietly disagree with it.
  it('agy pin is the relay tier the runtime heal would pick from the same catalog', () => {
    expect(pickAntigravityRelayModel(modelsFor('antigravity-cli'))).toBe(AGY_IMAGEGEN_DEFAULT_MODEL);
  });

  it('local image default remains in the seeded media catalog', () => {
    const media = JSON.parse(readFileSync(MEDIA_SEED_PATH, 'utf8'));
    expect(media.image.some((model) => model.id === LOCAL_IMAGEGEN_DEFAULT_MODEL)).toBe(true);
    expect(LOCAL_IMAGEGEN_DEFAULT_MODEL).toBe('qwen-image-2.1');
  });
});
