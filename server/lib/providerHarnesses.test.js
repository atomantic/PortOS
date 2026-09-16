/**
 * Cross-registry invariants for the harness table.
 *
 * `providerRouteRecipes.sampleParity.test.js` already pins each CREATABLE
 * harness against the argv PortOS ships for it. What was unpinned is everything
 * a NON-creatable row asserts, and the places where the same fact about one
 * program is written in two registries — the drift `PROVIDER_VENDORS` was
 * extracted to stop (#3618), reappearing one table over.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_HARNESSES, harnessById, harnessForProvider } from './providerHarnesses.js';
import { PROVIDER_VENDORS } from './providerVendors.js';
import { bindingBlocker } from './providerRouteRecipes.js';

/**
 * The legacy Gemini CLI row is a vendor with no harness on purpose: it exists
 * so an old stored config still resolves, and ships no binary of its own.
 */
const VENDOR_WITHOUT_HARNESS = 'gemini-legacy';

const spawnableVendors = PROVIDER_VENDORS.filter((vendor) => vendor.id !== VENDOR_WITHOUT_HARNESS);

describe('harness rows say why they carry no recipe', () => {
  // The refusal quotes this field. While `bindingBlocker` hardcoded one reason,
  // a row added for a different one told the user their harness "reaches only
  // its own vendor service" — wrong, and it points at the wrong remedy.
  it('sets noRecipe on exactly the rows with no recipe', () => {
    for (const harness of PROVIDER_HARNESSES) {
      expect(Boolean(harness.noRecipe), `${harness.id}: noRecipe must accompany a null recipe`)
        .toBe(harness.recipe === null);
    }
  });

  it('refuses each uncreatable harness with its own reason, not a shared guess', () => {
    const connection = { kind: 'ollama', transports: { openai: { baseUrl: 'http://localhost:11434/v1' } }, credentials: {} };
    const messages = PROVIDER_HARNESSES
      .filter((harness) => harness.recipe === null)
      .map((harness) => bindingBlocker({ harnessId: harness.id, modes: ['cli'], connection }).message);

    // Kilo and OpenChamber are `openai`-protocol rows that still cannot be
    // minted — the case that makes "reaches only its own vendor service" false.
    expect(messages).toContain(`${harnessById('kilo').label} ${harnessById('kilo').noRecipe}, so it cannot be pointed at a backend connection. Add it from the provider editor instead.`);
    expect(new Set(messages).size).toBeGreaterThan(1);
    for (const message of messages) expect(message).not.toMatch(/undefined|has no command recipe/);
  });
});

describe('a harness and its vendor agree about what can be driven', () => {
  // Two registries hold "OpenChamber has no TUI": the vendor row by omitting
  // `tuiArgs`, the harness row by declaring `modes: ['cli']`. Nothing joined
  // them, so an edit to either alone would have `applyCommandDefaults` build an
  // interactive argv for a mode the harness says does not exist — which for
  // OpenChamber means launching its SERVER in a PTY and calling it an agent.
  //
  // Deliberately ONE-DIRECTIONAL. The converse is false and must stay allowed:
  // `claude` declares a `tui` mode with no `tuiArgs`, because its interactive
  // posture flag ships on the seeded record rather than being injected. So
  // `tuiArgs` proves a TUI exists, while its absence proves nothing.
  it('never lets a vendor build interactive argv for a harness with no tui mode', () => {
    for (const vendor of spawnableVendors) {
      const harness = harnessById(vendor.id);
      expect(harness, `${vendor.id}: every spawnable vendor needs a harness row`).not.toBeNull();
      if (harness.modes.includes('tui')) continue;
      expect(vendor.tuiArgs, `${vendor.id}: harness declares no tui mode, so the vendor must build no interactive argv`)
        .toBeUndefined();
    }
  });

  // The third copy of the same fact is the shipped catalog. A `tui` record whose
  // harness has no `tui` mode is a row the spawner would happily put in a PTY.
  it('ships no tui provider for a harness that has no tui mode', () => {
    const seeded = Object.values(JSON.parse(readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../data.reference/providers.json'), 'utf8',
    )).providers);
    expect(seeded.length).toBeGreaterThan(20);
    for (const provider of seeded.filter((row) => row.type === 'tui')) {
      const harness = harnessForProvider(provider);
      if (!harness) continue;
      expect(harness.modes, `${provider.id}: seeded as tui, but ${harness.id} declares no tui mode`).toContain('tui');
    }
  });

  it('gives every spawnable vendor a harness that classifies its own binary', () => {
    for (const vendor of spawnableVendors) {
      const provider = { id: `${vendor.id}-cli`, type: 'cli', command: vendor.inferredCommand };
      expect(harnessById(vendor.id).matches(provider), `${vendor.id}: harness does not match its own command`).toBe(true);
    }
  });
});
