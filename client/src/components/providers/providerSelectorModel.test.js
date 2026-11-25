// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  deriveProviderSelectorModel,
  formatUnavailableSuffix,
  modelOption,
  modelOptionState,
  providerOptionState,
  upsertSavedPreset,
} from './providerSelectorModel.js';

const catalog = { loading: false, error: null };
const base = (over = {}) => ({
  providerList: [{ id: 'p1', name: 'P1', enabled: true, models: ['m1', 'm2'], defaultModel: 'm1' }],
  selectedProviderId: 'p1',
  selectedProvider: { id: 'p1', name: 'P1', enabled: true, defaultModel: 'm1' },
  providerFromCatalog: false,
  selectedModel: '',
  effectiveModel: 'm1',
  availableModels: ['m1', 'm2'],
  includeDefaultModel: false,
  selectionPolicy: undefined,
  compose: true,
  loading: false,
  catalog,
  ...over,
});

describe('formatUnavailableSuffix', () => {
  it('ranks hardware over policy over reason', () => {
    expect(formatUnavailableSuffix({ hardwareUnavailable: true, policyDisallowed: true, reason: 'x' })).toBe(' (unavailable on this machine)');
    expect(formatUnavailableSuffix({ policyDisallowed: true, reason: 'x' })).toBe(' (not permitted here)');
    expect(formatUnavailableSuffix({ reason: 'offline' })).toBe(' (offline)');
    expect(formatUnavailableSuffix({})).toBe('');
  });
});

describe('upsertSavedPreset', () => {
  it('replaces by id and appends new ids without mutating', () => {
    const list = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
    expect(upsertSavedPreset(list, { id: 'a', v: 2 })).toEqual([{ id: 'b', v: 1 }, { id: 'a', v: 2 }]);
    expect(upsertSavedPreset(list, { id: 'c' })).toHaveLength(3);
    expect(list).toHaveLength(2);
  });
});

describe('option state', () => {
  it('modelOption normalizes strings, objects and nullish', () => {
    expect(modelOption('x')).toEqual({ value: 'x', label: 'x' });
    expect(modelOption({ id: 'x', name: 'X' })).toEqual({ value: 'x', label: 'X' });
    expect(modelOption(null)).toBeNull();
  });
  it('providerOptionState disables on policy or reason', () => {
    expect(providerOptionState({ id: 'a', name: 'A' }, () => false)).toEqual({ unavailable: true, suffix: ' (not permitted here)' });
    expect(providerOptionState({ id: 'a', name: 'A', unavailableReason: 'off' }, undefined)).toEqual({ unavailable: true, suffix: ' (off)' });
    expect(providerOptionState({ id: 'a', name: 'A' }, undefined)).toEqual({ unavailable: false, suffix: '' });
  });
  it('modelOptionState applies the model policy', () => {
    expect(modelOptionState({ id: 'a' }, 'm', 'm', () => false)).toEqual({ unavailable: true, suffix: ' (not permitted here)' });
  });
});

describe('deriveProviderSelectorModel', () => {
  it('shows the model select only with onModelChange and options', () => {
    expect(deriveProviderSelectorModel(base()).showModel).toBe(false);
    expect(deriveProviderSelectorModel(base({ onModelChange: () => {} })).showModel).toBe(true);
    expect(deriveProviderSelectorModel(base({ onModelChange: () => {}, availableModels: [] })).showModel).toBe(false);
    expect(deriveProviderSelectorModel(base({ onModelChange: () => {}, availableModels: [], alwaysShowModel: true })).showModel).toBe(true);
  });
  it('keeps a policy-disallowed selected model visible', () => {
    const out = deriveProviderSelectorModel(base({
      selectedModel: 'm2',
      selectionPolicy: { model: (m) => modelOption(m).value !== 'm2' },
    }));
    expect(out.modelOptions.map((m) => modelOption(m).value)).toContain('m2');
  });
  it('fails compose closed under a provider policy without modes', () => {
    const provider = () => true;
    expect(deriveProviderSelectorModel(base({ selectionPolicy: { provider } })).composeEnabled).toBe(false);
    expect(deriveProviderSelectorModel(base({ selectionPolicy: { provider, modes: ['tui'] } })).composeEnabled).toBe(true);
    expect(deriveProviderSelectorModel(base({ selectionPolicy: { modes: [] } })).composeEnabled).toBe(false);
    expect(deriveProviderSelectorModel(base({ compose: false })).composeEnabled).toBe(false);
    expect(deriveProviderSelectorModel(base({ loading: true })).composeEnabled).toBe(false);
  });
  it('keeps an unresolvable composite on screen with a reason', () => {
    const id = 'claude.cli@anthropic';
    const out = deriveProviderSelectorModel(base({ selectedProviderId: id, selectedProvider: undefined, providerList: [] }));
    expect(out.selectedComposite).toEqual({ id, name: id, unavailableReason: 'not available on this install' });
    const loading = deriveProviderSelectorModel(base({ selectedProviderId: id, selectedProvider: undefined, providerList: [], catalog: { loading: true } }));
    expect(loading.selectedComposite.unavailableReason).toBeNull();
  });
});
