import { describe, expect, it } from 'vitest';
import {
  MOA_AGGREGATOR_INSTRUCTION,
  assembleAggregatorPrompt,
  buildAdvisorPrompt,
  moaMemberRefusal,
  moaProviderRecord,
  presetIdFromMoaProviderId,
  scrubAdvisorText,
} from './moaConfig.js';
import { moaPresetCreateSchema } from './moaValidation.js';

const api = { id: 'api-one', type: 'api', enabled: true, defaultModel: 'model-a' };
const ref = (providerId, extra = {}) => ({ providerId, ...extra });

describe('moaConfig', () => {
  it('keeps the caller prompt as the byte-identical prefix and puts the advisory block at the tail', () => {
    const prompt = 'System context that a provider caches.\n\nQuestion: what is 2+2?';
    const assembled = assembleAggregatorPrompt(prompt, [
      { label: 'One / a', ok: true, text: 'It is 4.' },
      { label: 'Two / b', ok: false, error: 'timeout' },
      { label: 'Three / c', ok: true, text: 'Four.' },
    ]);
    expect(assembled.startsWith(prompt)).toBe(true);
    const tail = assembled.slice(prompt.length);
    expect(tail).toContain('<moa-advisory responded="2" of="3">');
    expect(tail).toContain('### Advisor 1 (One / a)\nIt is 4.');
    expect(tail).toContain('### Advisor 2 (Three / c)\nFour.');
    expect(tail).not.toContain('timeout');
    expect(assembled.endsWith(MOA_AGGREGATOR_INSTRUCTION)).toBe(true);
    expect(buildAdvisorPrompt(prompt).startsWith(prompt)).toBe(true);
  });

  it('sends the prompt unchanged when no advisor answered', () => {
    expect(assembleAggregatorPrompt('Q', [{ label: 'x', ok: false }, { label: 'y', ok: true, text: '   ' }])).toBe('Q');
  });

  it('scrubs advisor text before injection only under the full privacy filter', () => {
    const leaky = [{ label: 'x', ok: true, text: 'key sk-abcdefghijklmnopqrstuvwx mail someone@example.com' }];
    const full = assembleAggregatorPrompt('Q', leaky, { privacyFilter: 'full' });
    expect(full).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(full).not.toContain('someone@example.com');
    expect(full).toContain('[REDACTED]');
    expect(full).toContain('<email>');
    for (const filter of ['off', 'display']) {
      expect(assembleAggregatorPrompt('Q', leaky, { privacyFilter: filter })).toContain('someone@example.com');
    }
    expect(scrubAdvisorText('host 192.0.2.10')).toBe('host <ip>');
  });

  it('refuses members that are MoA presets, missing, disabled, non-API or modelless', () => {
    expect(moaMemberRefusal(ref('api-one'), api)).toBeNull();
    expect(moaMemberRefusal(ref('moa:other'), null)).toMatch(/MoA preset/);
    expect(moaMemberRefusal(ref('virtual'), { id: 'virtual', type: 'moa' })).toMatch(/MoA preset/);
    expect(moaMemberRefusal(ref('gone'), null)).toMatch(/not found/);
    expect(moaMemberRefusal(ref('api-one'), { ...api, enabled: false })).toMatch(/disabled/);
    expect(moaMemberRefusal(ref('cli'), { id: 'cli', type: 'cli', enabled: true, defaultModel: 'm' })).toMatch(/not an API provider/);
    expect(moaMemberRefusal(ref('api-one'), { ...api, defaultModel: null })).toMatch(/no default model/);
    expect(moaMemberRefusal(ref('api-one', { model: 'explicit' }), { ...api, defaultModel: null })).toBeNull();
  });

  it('addresses a preset as moa:<id> and reports the aggregator model', () => {
    const record = moaProviderRecord({ id: 'council', name: 'Council', aggregator: { providerId: 'api-one', model: 'big' } });
    expect(record).toMatchObject({ id: 'moa:council', type: 'moa', defaultModel: 'big', moaPresetId: 'council' });
    expect(presetIdFromMoaProviderId(record.id)).toBe('council');
    expect(presetIdFromMoaProviderId('api-one')).toBeNull();
  });

  it('validates the preset shape: 1–5 reference models, no MoA members', () => {
    const base = { name: 'Council', referenceModels: [ref('a')], aggregator: ref('b') };
    expect(moaPresetCreateSchema.parse(base)).toMatchObject({ privacyFilter: 'off', enabled: true, advisorMaxTokens: 1024 });
    expect(moaPresetCreateSchema.safeParse({ ...base, referenceModels: [] }).success).toBe(false);
    expect(moaPresetCreateSchema.safeParse({ ...base, referenceModels: Array.from({ length: 6 }, (_, i) => ref(`p${i}`)) }).success).toBe(false);
    expect(moaPresetCreateSchema.safeParse({ ...base, aggregator: ref('moa:self') }).success).toBe(false);
    expect(moaPresetCreateSchema.safeParse({ ...base, referenceModels: [ref('moa:self')] }).success).toBe(false);
    expect(moaPresetCreateSchema.safeParse({ ...base, aggregator: { providerId: 'b', temperature: 1 } }).success).toBe(false);
  });
});
