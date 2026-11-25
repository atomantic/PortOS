// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolveInheritedLlmRoute } from './autopilotLlmRoute';

const providers = [
  { id: 'a', enabled: true, models: ['a-1', 'a-2'], defaultModel: 'a-1' },
  { id: 'b', enabled: true, models: ['b-1'], defaultModel: 'b-1' },
];

describe('resolveInheritedLlmRoute', () => {
  it('inherits provider and model from the base when nothing is overridden', () => {
    const r = resolveInheritedLlmRoute(providers, { baseProviderId: 'a', baseModel: 'a-2' });
    expect(r.providerId).toBe('a');
    expect(r.model).toBe('a-2');
    expect(r.provider).toBe(providers[0]);
  });

  it('keeps the base model when the override names the same provider', () => {
    const r = resolveInheritedLlmRoute(providers, {
      baseProviderId: 'a', baseModel: 'a-2', overrideProvider: 'a',
    });
    expect(r.model).toBe('a-2');
  });

  it('drops the base model when the override switches provider', () => {
    const r = resolveInheritedLlmRoute(providers, {
      baseProviderId: 'a', baseModel: 'a-2', overrideProvider: 'b',
    });
    expect(r.providerId).toBe('b');
    expect(r.model).toBe('');
    expect(r.provider).toBe(providers[1]);
  });

  it('prefers an explicit model override over inheritance', () => {
    const r = resolveInheritedLlmRoute(providers, {
      baseProviderId: 'a', baseModel: 'a-1', overrideProvider: 'b', overrideModel: 'b-1',
    });
    expect(r.model).toBe('b-1');
  });

  it('reports an unknown provider as undefined without throwing', () => {
    const r = resolveInheritedLlmRoute(providers, { baseProviderId: 'gone', baseModel: 'x' });
    expect(r.providerId).toBe('gone');
    expect(r.provider).toBeUndefined();
    expect(r.effort).toBeFalsy();
  });

  it('exposes the model options of the resolved provider', () => {
    const r = resolveInheritedLlmRoute(providers, { baseProviderId: 'a', overrideProvider: 'b' });
    expect(Array.isArray(r.models)).toBe(true);
  });
});
