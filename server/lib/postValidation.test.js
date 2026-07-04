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

describe('trainingEntrySchema wordplay drill types (issue #2097)', () => {
  // Regression: the standalone Wordplay tab (WordplayTrainer.jsx) never
  // persisted practice — fixed by submitting these four LLM drill types
  // through trainingEntrySchema, same as the in-session runner already does.
  // They flow in via DRILL_TYPES (LLM_DRILL_TYPES ⊂ DRILL_TYPES), not the
  // Morse-only union member, so this locks that acceptance in place.
  it('accepts every wordplay drill type on the training-log entry schema', () => {
    for (const drillType of ['compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist']) {
      const parsed = trainingEntrySchema.parse({
        module: 'llm-drills', drillType, questionCount: 5, correctCount: 4, totalMs: 60000
      });
      expect(parsed.drillType).toBe(drillType);
    }
  });

  it('still rejects an unknown drill type', () => {
    expect(() => trainingEntrySchema.parse({
      module: 'llm-drills', drillType: 'not-a-real-drill', questionCount: 5, correctCount: 4, totalMs: 60000
    })).toThrow();
  });
});

describe('questionResultSchema chunkId/element (issue #2016)', () => {
  // Regression: memory-sequence/memory-element-flash answers must carry
  // chunkId/element through postSessionSubmitSchema so submitPostSession can
  // merge chunk/element mastery (mergeMasteryFromSession) — Zod's default
  // strip mode would otherwise silently drop these fields.
  it('accepts and preserves chunkId on a memory-sequence question', () => {
    const parsed = postSessionSubmitSchema.parse({
      modules: ['memory'],
      tasks: [{
        module: 'memory',
        type: 'memory-sequence',
        memoryItemId: 'song-1',
        questions: [{ prompt: 'line one', expected: 'line two', answered: 'line two', correct: true, responseMs: 500, chunkId: 'verse-1' }],
        totalMs: 500
      }]
    });
    expect(parsed.tasks[0].questions[0].chunkId).toBe('verse-1');
  });

  it('accepts and preserves element on a memory-element-flash question', () => {
    const parsed = postSessionSubmitSchema.parse({
      modules: ['memory'],
      tasks: [{
        module: 'memory',
        type: 'memory-element-flash',
        memoryItemId: 'elements-song',
        questions: [{ prompt: 'H', expected: 'Hydrogen', answered: 'Hydrogen', correct: true, responseMs: 300, element: 'H' }],
        totalMs: 300
      }]
    });
    expect(parsed.tasks[0].questions[0].element).toBe('H');
  });

  it('accepts a question with neither chunkId nor element (math/LLM/cognitive drills)', () => {
    const parsed = postSessionSubmitSchema.parse({
      modules: ['mental-math'],
      tasks: [{
        module: 'mental-math',
        type: 'doubling-chain',
        questions: [{ prompt: '2 x 2', expected: 4, answered: 4, responseMs: 200 }],
        totalMs: 200
      }]
    });
    expect(parsed.tasks[0].questions[0].chunkId).toBeUndefined();
    expect(parsed.tasks[0].questions[0].element).toBeUndefined();
  });

  it('accepts a null chunkId (question with no matching chunk)', () => {
    const parsed = postSessionSubmitSchema.parse({
      modules: ['memory'],
      tasks: [{
        module: 'memory',
        type: 'memory-sequence',
        memoryItemId: 'song-1',
        questions: [{ prompt: 'line one', expected: 'line two', answered: null, correct: false, responseMs: 500, chunkId: null }],
        totalMs: 500
      }]
    });
    expect(parsed.tasks[0].questions[0].chunkId).toBeNull();
  });
});

describe('postSessionSubmitSchema client-generated id (issue #2098)', () => {
  const baseBody = () => ({
    modules: ['mental-math'],
    tasks: [{
      module: 'mental-math',
      type: 'doubling-chain',
      questions: [{ prompt: '2 x 2', expected: 4, answered: 4, responseMs: 200 }],
      totalMs: 200
    }]
  });

  it('accepts and preserves a valid uuid id (keys the idempotent upsert)', () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const parsed = postSessionSubmitSchema.parse({ ...baseBody(), id });
    expect(parsed.id).toBe(id);
  });

  it('accepts a body with no id (server assigns one — back-compat)', () => {
    const parsed = postSessionSubmitSchema.parse(baseBody());
    expect(parsed.id).toBeUndefined();
  });

  it('rejects a non-uuid id', () => {
    expect(() => postSessionSubmitSchema.parse({ ...baseBody(), id: 'not-a-uuid' })).toThrow();
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
