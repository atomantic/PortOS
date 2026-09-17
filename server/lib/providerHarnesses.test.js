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
import {
  CREATABLE_HARNESS_IDS,
  PROVIDER_HARNESSES,
  compatibleBindings,
  harnessById,
  harnessForProvider,
  isCompatible,
} from './providerHarnesses.js';
import { CODEX_OSS_LOCAL_PROVIDERS } from './providerModels.js';
import { PROVIDER_VENDORS } from './providerVendors.js';
import { bindingBlocker } from './providerRouteRecipes.js';
import { SERVICE_DEFINITIONS, resolveServiceInstance } from './serviceDefinitions.js';

/**
 * The legacy Gemini CLI row is a vendor with no harness on purpose: it exists
 * so an old stored config still resolves, and ships no binary of its own.
 */
const VENDOR_WITHOUT_HARNESS = 'gemini-legacy';

const spawnableVendors = PROVIDER_VENDORS.filter((vendor) => vendor.id !== VENDOR_WITHOUT_HARNESS);

describe('harness rows say why they cannot be minted from a connection', () => {
  // The refusal quotes this field. While `bindingBlocker` hardcoded one reason,
  // a row added for a different one told the user their harness "reaches only
  // its own vendor service" — wrong, and it points at the wrong remedy.
  it('gives every non-creatable program a reason, and every creatable one none', () => {
    for (const harness of PROVIDER_HARNESSES.filter((row) => row.id !== 'direct')) {
      expect(Boolean(harness.connectionBlocker), `${harness.id}`).toBe(!CREATABLE_HARNESS_IDS.includes(harness.id));
    }
    expect(CREATABLE_HARNESS_IDS).toEqual(['claude', 'opencode', 'codex']);
  });

  // Since #7562 a row with no bindings is exactly a row nothing can be
  // composed onto — it has no recipe either. `direct` has no recipe (it is not
  // a program) yet binds, so it carries no reason. A subscription program (or
  // Pi) HAS a recipe — `<harness>.cli@<service>` materializes — while still
  // refusing an arbitrary connection.
  it('leaves a row with no bindings recipe-less, and every program with bindings a recipe', () => {
    for (const harness of PROVIDER_HARNESSES.filter((row) => row.id !== 'direct')) {
      expect(harness.recipe === null, `${harness.id}`).toBe(harness.bindings.length === 0);
    }
    expect(harnessById('direct').recipe).toBeNull();
    expect(harnessById('direct').bindings).toHaveLength(1);
  });

  it('refuses each uncreatable harness with its own reason, not a shared guess', () => {
    const connection = { kind: 'ollama', transports: { openai: { baseUrl: 'http://localhost:11434/v1' } }, credentials: {} };
    const messages = PROVIDER_HARNESSES
      .filter((harness) => harness.id !== 'direct' && !CREATABLE_HARNESS_IDS.includes(harness.id))
      .map((harness) => bindingBlocker({ harnessId: harness.id, modes: ['cli'], connection }).message);

    // Kilo and OpenChamber are `openai`-protocol rows that still cannot be
    // minted — the case that makes "reaches only its own vendor service" false.
    expect(messages).toContain(`${harnessById('kilo').label} ${harnessById('kilo').connectionBlocker}, so it cannot be pointed at a backend connection. Add it from the provider editor instead.`);
    expect(messages).toContain(`${harnessById('pi').label} ${harnessById('pi').connectionBlocker}, so it cannot be pointed at a backend connection. Add it from the provider editor instead.`);
    expect(new Set(messages).size).toBeGreaterThan(2);
    for (const message of messages) expect(message).not.toMatch(/undefined|has no command recipe/);
  });

  // The graph names a direct binding `null`; the registry names it `direct`.
  // Either spelling must be the same request to the create endpoint.
  it('treats a "direct" harnessId exactly like the graph\'s null', () => {
    const connection = { kind: 'ollama', transports: { openai: { baseUrl: 'http://localhost:11434/v1' } }, credentials: {} };
    expect(bindingBlocker({ harnessId: 'direct', modes: ['api'], connection }))
      .toEqual(bindingBlocker({ harnessId: null, modes: ['api'], connection }));
    expect(bindingBlocker({ harnessId: 'direct', modes: ['cli'], connection })?.code).toBe('PROVIDER_HARNESS_MODE_UNSUPPORTED');
  });
});

describe('capability bindings (#7562)', () => {
  it('has eleven rows, and direct is the harness of an api record', () => {
    expect(PROVIDER_HARNESSES).toHaveLength(11);
    expect(harnessForProvider({ type: 'api', endpoint: 'https://api.example.com/v1' })?.id).toBe('direct');
    expect(harnessForProvider({ type: 'cli', command: 'not-a-harness' })).toBeNull();
    expect(harnessById('direct').modes).toEqual(['api']);
  });

  // Codex emits `--oss --local-provider <x>` from the runtime marker at spawn;
  // the binding must name exactly the runtimes that emitter serves.
  it('binds Codex to exactly the local runtimes buildCodexOssArgs can name', () => {
    const binding = harnessById('codex').bindings.find((row) => row.localRuntime);
    expect([...binding.localRuntime].sort()).toEqual(Object.keys(CODEX_OSS_LOCAL_PROVIDERS).sort());
  });

  it('names a service every subscription/service binding can resolve', () => {
    const ids = new Set(SERVICE_DEFINITIONS.map((row) => row.id));
    for (const harness of PROVIDER_HARNESSES) {
      for (const binding of harness.bindings.filter((row) => row.service)) {
        expect(ids.has(binding.service), `${harness.id} → ${binding.service}`).toBe(true);
      }
    }
  });

  // The compatibility table from the issue, verbatim — each row is a product
  // decision, not a derivation (Claude on NIM is wrong because NIM speaks no
  // Anthropic wire; Pi on NIM is right because Pi ships a `nvidia` provider).
  const local = (id, transports) => resolveServiceInstance({ definitionId: id, transports });
  const OLLAMA = local('ollama', { anthropic: { baseUrl: 'http://127.0.0.1:11434' }, openai: { baseUrl: 'http://127.0.0.1:11434/v1' } });
  it.each([
    ['claude', OLLAMA, true],
    ['claude', 'nvidia-nim', false],
    ['pi', 'nvidia-nim', true],
    ['codex', OLLAMA, true],
    ['codex', 'nvidia-nim', true],
    ['opencode', 'openrouter', true],
    ['direct', 'anthropic', false],
    ['antigravity', 'nvidia-nim', false],
    ['antigravity', OLLAMA, false],
    ['antigravity', 'openai', false],
    ['antigravity', 'antigravity', true],
    ['kilo', OLLAMA, false],
    // `harnessOnly`: Kimi's service is reachable through Kimi Code alone.
    ['direct', 'kimi', false],
    ['kimi', 'kimi', true],
  ])('%s × %s → %s', (harnessId, service, expected) => {
    const instance = typeof service === 'string' ? resolveServiceInstance(service) : service;
    expect(isCompatible(harnessId, instance)).toBe(expected);
  });

  it('prefers the local-runtime binding to the generic OpenAI one for a local daemon', () => {
    expect(compatibleBindings('codex', OLLAMA)[0].localRuntime).toContain('ollama');
    expect(compatibleBindings('codex', resolveServiceInstance('nvidia-nim'))[0].baseUrl).toEqual({ via: 'env', name: 'OPENAI_BASE_URL' });
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
