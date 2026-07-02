import { describe, it, expect } from 'vitest';
import { postLlmScoreRequestSchema, postConfigUpdateSchema, postSessionSubmitSchema, postDrillRequestSchema, trainingEntrySchema, LLM_DRILL_TYPES } from './postValidation.js';

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

  it('accepts the opt-in daily reminder block with a well-formed HH:MM time', () => {
    const parsed = postConfigUpdateSchema.parse({ reminder: { enabled: true, time: '09:30' } });
    expect(parsed.reminder).toEqual({ enabled: true, time: '09:30' });
    // Additive + optional — a config with no reminder key stays valid.
    expect(postConfigUpdateSchema.parse({}).reminder).toBeUndefined();
  });

  it('rejects a malformed reminder time', () => {
    expect(() => postConfigUpdateSchema.parse({ reminder: { enabled: true, time: '9:30' } })).toThrow();
    expect(() => postConfigUpdateSchema.parse({ reminder: { enabled: true, time: '25:00' } })).toThrow();
    expect(() => postConfigUpdateSchema.parse({ reminder: { enabled: true, time: 'nine am' } })).toThrow();
  });

  // Regression: the native <input type="time"> can be cleared to '' by the
  // user (backspace/keyboard). Without this, an empty time rejected the WHOLE
  // config PUT — including unrelated mentalMath/adaptive/cognitive/llmDrills
  // edits sent in the same request — instead of just leaving the reminder
  // time unchanged.
  it('treats an empty reminder time as absent rather than rejecting the whole request', () => {
    const parsed = postConfigUpdateSchema.parse({
      adaptive: { enabled: true },
      reminder: { enabled: true, time: '' }
    });
    expect(parsed.reminder).toEqual({ enabled: true });
    expect(parsed.adaptive).toEqual({ enabled: true });
  });
});

describe('Morse drill types stay scoped to the training log', () => {
  // Regression: MORSE_DRILL_TYPES must never be spliced into the shared
  // DRILL_TYPES array — that array also backs the *scored* session submit
  // schema (postSessionSubmitSchema.tasks[].type) and server-side drill
  // generation (postDrillRequestSchema.type). meatspacePost.js's scoring
  // dispatch only special-cases LLM/MEMORY/COGNITIVE types and falls through
  // everything else to the math-expression scorer — a Morse type would pass
  // validation there but silently mis-score as a failed math drill instead of
  // being rejected. Morse only ever posts through trainingEntrySchema.
  it('rejects a Morse type on the scored-session task schema', () => {
    expect(() => postSessionSubmitSchema.parse({
      modules: ['morse'],
      tasks: [{ module: 'morse', type: 'morse-copy', totalMs: 1000 }]
    })).toThrow();
  });

  it('rejects a Morse type on the server-side drill-generation request schema', () => {
    expect(() => postDrillRequestSchema.parse({ type: 'morse-copy' })).toThrow();
  });

  it('accepts every Morse drill type on the training-log entry schema', () => {
    for (const drillType of ['morse-copy', 'morse-head-copy', 'morse-send']) {
      const parsed = trainingEntrySchema.parse({
        module: 'morse', drillType, questionCount: 10, correctCount: 8, totalMs: 5000
      });
      expect(parsed.drillType).toBe(drillType);
    }
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
