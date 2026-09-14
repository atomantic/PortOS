import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { AGY_IMAGEGEN_DEFAULT_MODEL, CODEX_IMAGEGEN_DEFAULT_MODEL } from './imageGenCapabilities.js';
import { pickAntigravityRelayModel } from './providerModels.js';

// The cheap-tier pins here are code-level defaults: no migration carries them,
// so nothing forces them to move when a vendor retires a model id, and they
// went out of sync exactly that way — see AGY_IMAGEGEN_DEFAULT_MODEL for the
// incident this guard exists to make impossible to ship again.
//
// Derived from `data.reference/providers.json` rather than a hand-transcribed
// list: that seed is what a fresh install starts with, and every catalog
// migration is written to keep it in lockstep, so it is the one place that
// already knows which ids a vendor still serves.
//
// Read as JSON instead of importing the toolkit's own catalog module — that
// module pulls the whole provider subtree, and this is a two-value check (see
// the server suite import budget in `importScoping.test.js`).
describe('shipped image-gen model pins stay in the seeded provider catalog', () => {
  const SEED_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../data.reference/providers.json');
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
});
