import { describe, expect, it } from 'vitest';
import { buildProviderPayload, findProviderFormError, initialProviderFormData, modelNumCtxToText, parseModelNumCtxText } from './providerFormData';

describe('per-model num_ctx form field', () => {
  it('round-trips the stored map through the text editor', () => {
    const map = { 'long-model:26b': 1048576, 'org/model=v2:q4': 65536 };
    expect(parseModelNumCtxText(modelNumCtxToText(map))).toEqual({ map });
    expect(parseModelNumCtxText('  \n')).toEqual({ map: {} });
  });

  it('names the first bad line', () => {
    expect(parseModelNumCtxText('long-model = 100').error).toContain('long-model = 100');
    expect(parseModelNumCtxText('no-equals').error).toBeTruthy();
    expect(parseModelNumCtxText('= 4096').error).toBeTruthy();
  });

  it('validates and saves the parsed map only for num_ctx providers', () => {
    const provider = { id: 'ollama', type: 'api', name: 'Ollama', endpoint: 'http://localhost:11434/v1', numCtx: 131072, modelNumCtx: { 'long-model:26b': 1048576 } };
    const formData = initialProviderFormData(provider);
    expect(formData.modelNumCtxText).toBe('long-model:26b = 1048576');
    expect(findProviderFormError({ formData: { ...formData, modelNumCtxText: 'bad' }, showsNumCtx: true })?.tab).toBe('generation');
    const payload = buildProviderPayload({ provider, formData, modelsText: '', showsNumCtx: true });
    expect(payload.modelNumCtx).toEqual({ 'long-model:26b': 1048576 });
    expect(payload).not.toHaveProperty('modelNumCtxText');
    expect(buildProviderPayload({ provider, formData: { ...formData, modelNumCtxText: '' }, modelsText: '', showsNumCtx: true }).modelNumCtx).toEqual({});
  });
});
