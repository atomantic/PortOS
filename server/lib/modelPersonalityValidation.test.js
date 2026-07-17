import { describe, it, expect } from 'vitest';
import {
  PERSONALITY_TRAIT_KEYS,
  PERSONALITY_TAXONOMY_VERSION,
  personalityProfileResponseSchema,
  personalityAlignmentResponseSchema,
  runPersonalityTestInputSchema,
  personalityHistoryQuerySchema,
  personalitySettingsUpdateSchema
} from './modelPersonalityValidation.js';

const fullTraits = Object.fromEntries(
  PERSONALITY_TRAIT_KEYS.map((k) => [k, { score: 0.5, rationale: `about ${k}` }])
);

describe('modelPersonalityValidation', () => {
  it('exposes taxonomy v1 with 10 unique trait keys', () => {
    expect(PERSONALITY_TAXONOMY_VERSION).toBe(1);
    expect(PERSONALITY_TRAIT_KEYS).toHaveLength(10);
    expect(new Set(PERSONALITY_TRAIT_KEYS).size).toBe(PERSONALITY_TRAIT_KEYS.length);
  });

  describe('personalityProfileResponseSchema', () => {
    it('round-trips a full profile', () => {
      const parsed = personalityProfileResponseSchema.parse({ traits: fullTraits, summary: 'posture' });
      expect(Object.keys(parsed.traits)).toEqual(expect.arrayContaining(PERSONALITY_TRAIT_KEYS));
      expect(parsed.summary).toBe('posture');
    });

    it('defaults a missing rationale and summary to empty strings', () => {
      const traits = Object.fromEntries(PERSONALITY_TRAIT_KEYS.map((k) => [k, { score: 1 }]));
      const parsed = personalityProfileResponseSchema.parse({ traits });
      expect(parsed.traits.humor.rationale).toBe('');
      expect(parsed.summary).toBe('');
    });

    it('rejects a profile missing a taxonomy key', () => {
      const { humor, ...partial } = fullTraits;
      expect(personalityProfileResponseSchema.safeParse({ traits: partial }).success).toBe(false);
    });

    it('rejects out-of-range scores', () => {
      const bad = { ...fullTraits, humor: { score: 1.5 } };
      expect(personalityProfileResponseSchema.safeParse({ traits: bad }).success).toBe(false);
    });
  });

  describe('personalityAlignmentResponseSchema', () => {
    it('round-trips an alignment verdict with free-form dimension keys', () => {
      const parsed = personalityAlignmentResponseSchema.parse({
        alignmentScore: 0.72,
        dimensions: { agreeableness: { score: 0.8, note: 'matches' }, verbosity: { score: 0.4 } }
      });
      expect(parsed.alignmentScore).toBe(0.72);
      expect(parsed.dimensions.verbosity.note).toBe('');
    });

    it('defaults dimensions to an empty object', () => {
      expect(personalityAlignmentResponseSchema.parse({ alignmentScore: 0 }).dimensions).toEqual({});
    });

    it('rejects a missing alignmentScore', () => {
      expect(personalityAlignmentResponseSchema.safeParse({ dimensions: {} }).success).toBe(false);
    });
  });

  describe('runPersonalityTestInputSchema', () => {
    it('requires providerId', () => {
      expect(runPersonalityTestInputSchema.safeParse({ model: 'm' }).success).toBe(false);
      expect(runPersonalityTestInputSchema.safeParse({ providerId: 'p' }).success).toBe(true);
    });

    it('accepts the optional fields', () => {
      const parsed = runPersonalityTestInputSchema.parse({
        providerId: 'p', model: 'm', includeAlignment: false, personaId: null
      });
      expect(parsed).toEqual({ providerId: 'p', model: 'm', includeAlignment: false, personaId: null });
    });
  });

  describe('personalityHistoryQuerySchema', () => {
    it('coerces the limit query string', () => {
      expect(personalityHistoryQuerySchema.parse({ limit: '25' }).limit).toBe(25);
      expect(personalityHistoryQuerySchema.parse({}).limit).toBeUndefined();
    });

    it('rejects a non-positive limit', () => {
      expect(personalityHistoryQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    });
  });

  describe('personalitySettingsUpdateSchema', () => {
    it('normalizes empty-string scorer sentinels to null', () => {
      const parsed = personalitySettingsUpdateSchema.parse({ scorerProviderId: '', scorerModel: '' });
      expect(parsed.scorerProviderId).toBeNull();
      expect(parsed.scorerModel).toBeNull();
    });

    it('is partial — an omitted key stays absent', () => {
      const parsed = personalitySettingsUpdateSchema.parse({ historyCap: 50 });
      expect(parsed).toEqual({ historyCap: 50 });
    });

    it('bounds historyCap', () => {
      expect(personalitySettingsUpdateSchema.safeParse({ historyCap: 0 }).success).toBe(false);
      expect(personalitySettingsUpdateSchema.safeParse({ historyCap: 1001 }).success).toBe(false);
    });
  });
});
