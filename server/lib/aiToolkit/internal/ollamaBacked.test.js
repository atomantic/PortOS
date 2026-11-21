import { describe, expect, it } from 'vitest';
import { withModelNumCtx } from './ollamaBacked.js';
import { knownContextWindow } from '../providerStatus.js';

const provider = { id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1', numCtx: 131072, modelNumCtx: { 'long-model:26b': 1048576 } };

describe('withModelNumCtx', () => {
  it('replaces numCtx for the overridden model only', () => {
    expect(withModelNumCtx(provider, 'long-model:26b').numCtx).toBe(1048576);
    expect(withModelNumCtx(provider, 'other:27b')).toBe(provider);
    expect(withModelNumCtx(provider, null)).toBe(provider);
    expect(provider.numCtx).toBe(131072);
  });
  it('ignores invalid overrides and missing providers', () => {
    expect(withModelNumCtx({ ...provider, modelNumCtx: { x: 0 } }, 'x').numCtx).toBe(131072);
    expect(withModelNumCtx(null, 'x')).toBeNull();
  });
  it('lifts the planning window clamp for the overridden model', () => {
    const withCatalog = { ...provider, modelContextWindows: { 'long-model:26b': 1048576, 'other:27b': 262144 } };
    expect(knownContextWindow(withCatalog, 'long-model:26b')).toBe(1048576);
    expect(knownContextWindow(withCatalog, 'other:27b')).toBe(131072);
  });
});
