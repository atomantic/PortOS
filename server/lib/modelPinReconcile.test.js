import { describe, it, expect } from 'vitest';
import {
  catalogOfferings,
  providerCatalogListsModel,
  reconcileModelPins,
} from './modelPinReconcile.js';
import { ANTIGRAVITY_CONFIGURED_DEFAULT } from './providerModels.js';

const AGY = {
  id: 'antigravity-cli',
  command: 'agy',
  models: ['gemini-3.6-flash-low', 'gemini-3.6-flash-high', 'claude-sonnet-4-6'],
};
const CODEX = { id: 'codex', command: 'codex', models: ['gpt-5-codex', 'gpt-5'] };

describe('providerCatalogListsModel', () => {
  it('reports a retired agy pin as unlisted, and a live one as listed', () => {
    // The incident this issue was filed about: a tier the vendor dropped.
    expect(providerCatalogListsModel(AGY, 'gemini-3.5-flash-low')).toBe(false);
    expect(providerCatalogListsModel(AGY, 'gemini-3.6-flash-low')).toBe(true);
  });

  it('compares the agy family on BASE ids, so an effort tier is not a retirement', () => {
    // `--effort` carries the tier, so `gemini-3.6-flash` and its suffixed
    // variants are the same `--model` value. A base-blind exact match would
    // report both of these as retired.
    expect(providerCatalogListsModel(AGY, 'gemini-3.6-flash')).toBe(true);
    expect(providerCatalogListsModel(AGY, 'gemini-3.6-flash-medium')).toBe(true);
  });

  it('matches non-agy providers exactly', () => {
    expect(providerCatalogListsModel(CODEX, 'gpt-5-codex')).toBe(true);
    expect(providerCatalogListsModel(CODEX, 'gpt-4o')).toBe(false);
  });

  it('tolerates OpenCode namespace addressing in either direction', () => {
    // A pin is stored BARE and namespaced at spawn (`prefixOpencodeModel`), so a
    // catalog holding the qualified form is the same model, not a retirement.
    const opencode = { id: 'opencode', command: 'opencode', models: ['ollama/qwen3:8b'] };
    expect(providerCatalogListsModel(opencode, 'qwen3:8b')).toBe(true);
    expect(providerCatalogListsModel(opencode, 'ollama/qwen3:8b')).toBe(true);
    expect(providerCatalogListsModel(opencode, 'qwen3:14b')).toBe(false);
  });

  it('confines the namespace tolerance to OpenCode providers', () => {
    // The bare-id reduction must not match a slash-bearing pin against another
    // vendor's bare catalog: the same rule now gates SPAWNS, not just this
    // audit, so an over-permissive answer hands a CLI a model it cannot serve.
    expect(providerCatalogListsModel(CODEX, 'openrouter/gpt-5')).toBe(false);
  });

  it('never reports a LOCAL-daemon pin as retired, even when the record omits it', () => {
    // A local-backed provider's `models` is a stale cached snapshot while the
    // daemon is the authority, so judging a pin against the record would report
    // a model that is installed and serving as retired — and this feature would
    // then offer a one-click button to delete it. Inherited from modelPinIsOffered.
    const ollama = {
      id: 'opencode-ollama',
      command: 'opencode',
      ollamaBacked: true,
      models: ['ollama/qwen3:8b'],
    };
    expect(providerCatalogListsModel(ollama, 'qwen3:32b')).toBe(true);
    // ...while a NON-local provider with the same shaped catalog still reports it.
    expect(providerCatalogListsModel({ ...ollama, ollamaBacked: false }, 'qwen3:32b')).toBe(false);
  });

  describe('every unknown answer reads as "still listed"', () => {
    // A false "your pin is gone" tells the user to change a setting that works,
    // which is strictly worse than missing one.
    // One row per distinct branch — a whitespace/null pin lands on the same
    // guard as a blank one, and an absent catalog on the same guard as an empty.
    it.each([
      ['a blank pin', AGY, ''],
      ['a configured-default sentinel', AGY, ANTIGRAVITY_CONFIGURED_DEFAULT],
      ['an empty catalog', { ...AGY, models: [] }, 'gemini-3.5-flash-low'],
      ['a sentinel-only catalog', { ...AGY, models: [ANTIGRAVITY_CONFIGURED_DEFAULT] }, 'gemini-3.5-flash-low'],
      ['no provider record', null, 'gemini-3.5-flash-low'],
    ])('%s', (_label, provider, model) => {
      expect(providerCatalogListsModel(provider, model)).toBe(true);
    });
  });
});

describe('catalogOfferings', () => {
  it('drops sentinels and non-strings from what it offers', () => {
    const provider = { ...CODEX, models: ['gpt-5', ANTIGRAVITY_CONFIGURED_DEFAULT, null, { id: 'x' }] };
    expect(catalogOfferings(provider)).toEqual(['gpt-5']);
  });

  it('offers agy base ids, since the effort tier is not a separate choice', () => {
    expect(catalogOfferings(AGY)).toEqual(['gemini-3.6-flash', 'claude-sonnet-4-6']);
    expect(catalogOfferings(CODEX)).toEqual(['gpt-5-codex', 'gpt-5']);
  });
});

describe('reconcileModelPins', () => {
  const providers = { 'antigravity-cli': AGY, codex: CODEX };

  it('returns only the pins whose provider no longer lists them, in input order', () => {
    const pins = [
      { id: 'a', providerId: 'antigravity-cli', model: 'gemini-3.5-flash-low' },
      { id: 'b', providerId: 'codex', model: 'gpt-5-codex' },
      { id: 'c', providerId: 'codex', model: 'gpt-4o' },
    ];
    expect(reconcileModelPins(pins, providers).map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('carries every descriptor field through to the warning, and trims the model', () => {
    const pin = {
      id: 'a', providerId: 'codex', model: '  gpt-4o  ', label: 'L', location: 'Loc', href: '/x',
    };
    // `providerIds` is normalized ON — the panel unions the catalogs it names,
    // so a single-provider source must answer in the same shape as a reviewer.
    expect(reconcileModelPins([pin], providers))
      .toEqual([{ ...pin, model: 'gpt-4o', providerIds: ['codex'] }]);
  });

  it('leaves a pin alone when its provider is not in the map', () => {
    // The provider record is gone — a different problem, and nothing to compare
    // the pin against.
    const pins = [{ id: 'a', providerId: 'deleted-provider', model: 'gpt-4o' }];
    expect(reconcileModelPins(pins, providers)).toEqual([]);
  });

  describe('a pin judged against SEVERAL providers (#7339)', () => {
    // A reviewer slug names a BINARY, and PortOS ships more than one record per
    // binary. The rule is "stale only when EVERY named record fails to list it".
    it('stays silent while any one of them still lists the model', () => {
      const pin = { id: 'r', providerIds: ['antigravity-cli', 'codex'], model: 'gpt-5-codex' };
      expect(reconcileModelPins([pin], providers)).toEqual([]);
    });

    it('reports it once no named record lists it, keeping the full judged list', () => {
      const pin = { id: 'r', providerIds: ['antigravity-cli', 'codex'], model: 'gpt-4o' };
      expect(reconcileModelPins([pin], providers)).toEqual([
        { ...pin, providerIds: ['antigravity-cli', 'codex'] },
      ]);
    });

    it('answers "still served" when one of the named records is unresolvable', () => {
      // An unknown record could be the one that lists it — warning here would be
      // a false retirement on a pin that works.
      const pin = { id: 'r', providerIds: ['codex', 'deleted-provider'], model: 'gpt-4o' };
      expect(reconcileModelPins([pin], providers)).toEqual([]);
    });

    it('leaves a pin with an EMPTY provider list alone rather than reporting all of them', () => {
      // `[].some()` is false, so without the explicit empty-list arm every
      // unjudgeable pin would surface as retired.
      const pin = { id: 'r', providerIds: [], model: 'gpt-4o' };
      expect(reconcileModelPins([pin], providers)).toEqual([]);
    });
  });

  it('tolerates absent/garbage inputs rather than throwing on a page load', () => {
    expect(reconcileModelPins(null, providers)).toEqual([]);
    expect(reconcileModelPins([null, { id: 'a' }, { id: 'b', model: '  ' }], providers)).toEqual([]);
    expect(reconcileModelPins([{ id: 'a', providerId: 'codex', model: 'gpt-4o' }], null)).toEqual([]);
  });
});
