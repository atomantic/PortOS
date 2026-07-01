import { describe, it, expect } from 'vitest';
import { postLlmScoreRequestSchema, postConfigUpdateSchema, LLM_DRILL_TYPES } from './postValidation.js';

describe('postConfigUpdateSchema llmDrills', () => {
  // Regression: the config UI (PostDrillConfig.jsx) exposed only 5 of the 14
  // LLM drill types. All 14 are generatable server-side and must be persistable
  // via PUT /post/config, so the schema must accept a per-type config for each.
  it('accepts a config entry for every LLM drill type', () => {
    const drillTypes = Object.fromEntries(
      LLM_DRILL_TYPES.map(type => [type, { enabled: true, count: 3, timeLimitSec: 120 }])
    );
    const parsed = postConfigUpdateSchema.parse({
      llmDrills: { enabled: true, providerId: null, model: null, drillTypes }
    });
    expect(Object.keys(parsed.llmDrills.drillTypes)).toHaveLength(14);
    expect(Object.keys(parsed.llmDrills.drillTypes).sort()).toEqual([...LLM_DRILL_TYPES].sort());
  });

  it('rejects an unknown LLM drill type key', () => {
    expect(() => postConfigUpdateSchema.parse({
      llmDrills: { drillTypes: { 'not-a-drill': { enabled: true } } }
    })).toThrow();
  });

  it('accepts the opt-in adaptive difficulty toggle', () => {
    expect(postConfigUpdateSchema.parse({ adaptive: { enabled: true } }).adaptive).toEqual({ enabled: true });
    expect(postConfigUpdateSchema.parse({ adaptive: { enabled: false } }).adaptive).toEqual({ enabled: false });
    // Additive + optional — a config with no adaptive key stays valid.
    expect(postConfigUpdateSchema.parse({}).adaptive).toBeUndefined();
  });
});

describe('postLlmScoreRequestSchema', () => {
  // Regression: Zod's default strip mode dropped `questionIndex` from each
  // response, so the server scorer fell back to the response-array index
  // (always 0 for single-response submits) and every answer was scored against
  // the FIRST prompt of the drill. Affected bridge-word, idiom-twist,
  // double-meaning, etc.
  it('preserves questionIndex on each response', () => {
    const parsed = postLlmScoreRequestSchema.parse({
      type: 'bridge-word',
      drillData: { puzzles: [{ answer: 'a' }, { answer: 'b' }] },
      responses: [{ questionIndex: 1, response: 'b', responseMs: 1000 }],
      timeLimitMs: 120000
    });
    expect(parsed.responses[0].questionIndex).toBe(1);
  });

  it('accepts responses without questionIndex (back-compat)', () => {
    const parsed = postLlmScoreRequestSchema.parse({
      type: 'idiom-twist',
      drillData: { challenges: [{ idiom: 'x' }] },
      responses: [{ response: 'twist', responseMs: 1000 }],
      timeLimitMs: 60000
    });
    expect(parsed.responses[0].questionIndex).toBeUndefined();
  });

  it('rejects negative questionIndex', () => {
    expect(() => postLlmScoreRequestSchema.parse({
      type: 'bridge-word',
      drillData: {},
      responses: [{ questionIndex: -1, responseMs: 0 }],
      timeLimitMs: 60000
    })).toThrow();
  });
});
