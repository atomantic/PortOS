import { describe, it, expect } from 'vitest';
import {
  postLlmScoreRequestSchema,
  postConfigUpdateSchema,
  postSessionSubmitSchema,
  postDrillRequestSchema,
  trainingEntrySchema,
  memoryItemCreateSchema,
  memoryScheduleSchema,
  memoryPracticeSchema,
  LLM_DRILL_TYPES,
} from './postValidation.js';

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

describe('trainingEntrySchema per-question breakdown (issue #2114)', () => {
  // Follow-up to #2097: the training log previously kept only round-level
  // aggregates. `questions` is optional/additive so legacy entries with no
  // breakdown stay valid.
  it('accepts a training entry with no questions field (back-compat)', () => {
    const parsed = trainingEntrySchema.parse({
      module: 'llm-drills', drillType: 'compound-chain', questionCount: 5, correctCount: 4, totalMs: 60000
    });
    expect(parsed.questions).toBeUndefined();
  });

  it('accepts and preserves a per-question breakdown for a wordplay entry', () => {
    const parsed = trainingEntrySchema.parse({
      module: 'llm-drills',
      drillType: 'bridge-word',
      questionCount: 2,
      correctCount: 1,
      totalMs: 45000,
      questions: [
        { prompt: 'news___', response: 'paper', responseMs: 4200, score: 85, feedback: 'Nice.', correct: true },
        { items: ['firehouse', 'firewall'], responseMs: 5100, score: 40, feedback: 'Partial credit.', correct: false },
      ],
    });
    expect(parsed.questions).toHaveLength(2);
    expect(parsed.questions[0]).toMatchObject({ prompt: 'news___', response: 'paper', score: 85, correct: true });
    expect(parsed.questions[1]).toMatchObject({ items: ['firehouse', 'firewall'], score: 40, correct: false });
  });

  it('rejects a question entry with an out-of-range score', () => {
    expect(() => trainingEntrySchema.parse({
      module: 'llm-drills', drillType: 'bridge-word', questionCount: 1, correctCount: 0, totalMs: 1000,
      questions: [{ prompt: 'x', score: 150 }],
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

// =============================================================================
// drillTypeConfigSchema numeric bounds (via postDrillRequestSchema.config)
// (issue #2102 notes)
// =============================================================================

describe('drillTypeConfigSchema numeric bounds', () => {
  it('accepts math-drill knobs within their documented bounds', () => {
    const parsed = postDrillRequestSchema.parse({
      type: 'serial-subtraction',
      config: { steps: 50, subtrahend: 100, maxDigits: 4, tolerancePct: 50 },
    });
    expect(parsed.config).toMatchObject({ steps: 50, subtrahend: 100, maxDigits: 4, tolerancePct: 50 });
  });

  it('rejects steps above the max (50) and below the min (1)', () => {
    expect(() => postDrillRequestSchema.parse({ type: 'serial-subtraction', config: { steps: 51 } })).toThrow();
    expect(() => postDrillRequestSchema.parse({ type: 'serial-subtraction', config: { steps: 0 } })).toThrow();
  });

  it('rejects maxDigits outside 1-4', () => {
    expect(() => postDrillRequestSchema.parse({ type: 'multiplication', config: { maxDigits: 5 } })).toThrow();
    expect(() => postDrillRequestSchema.parse({ type: 'multiplication', config: { maxDigits: 0 } })).toThrow();
  });

  it('rejects tolerancePct outside 1-50', () => {
    expect(() => postDrillRequestSchema.parse({ type: 'estimation', config: { tolerancePct: 0 } })).toThrow();
    expect(() => postDrillRequestSchema.parse({ type: 'estimation', config: { tolerancePct: 51 } })).toThrow();
  });

  it('accepts cognitive-drill knobs within bounds (n, length, size, choices)', () => {
    const parsed = postDrillRequestSchema.parse({
      type: 'n-back',
      config: { n: 3, length: 60, size: 7, choices: 4 },
    });
    expect(parsed.config).toMatchObject({ n: 3, length: 60, size: 7, choices: 4 });
  });

  it('rejects an out-of-range n-back n (must be 1-3)', () => {
    expect(() => postDrillRequestSchema.parse({ type: 'n-back', config: { n: 4 } })).toThrow();
    expect(() => postDrillRequestSchema.parse({ type: 'n-back', config: { n: 0 } })).toThrow();
  });

  it('rejects an out-of-range schulte-table size (must be 3-7)', () => {
    expect(() => postDrillRequestSchema.parse({ type: 'schulte-table', config: { size: 8 } })).toThrow();
    expect(() => postDrillRequestSchema.parse({ type: 'schulte-table', config: { size: 2 } })).toThrow();
  });
});

// =============================================================================
// memoryScheduleSchema / memoryItemCreateSchema ease bounds (issue #2102 notes)
// =============================================================================

describe('memoryScheduleSchema ease bounds', () => {
  it('accepts ease within the SM-2 bounds [1.3, 5]', () => {
    expect(memoryScheduleSchema.parse({ ease: 1.3, intervalDays: 0, nextReview: '2026-07-01T00:00:00.000Z' }).ease).toBe(1.3);
    expect(memoryScheduleSchema.parse({ ease: 5, intervalDays: 10, nextReview: '2026-07-01T00:00:00.000Z' }).ease).toBe(5);
  });

  it('rejects ease below 1.3 or above 5', () => {
    expect(() => memoryScheduleSchema.parse({ ease: 1.2, intervalDays: 0, nextReview: '2026-07-01T00:00:00.000Z' })).toThrow();
    expect(() => memoryScheduleSchema.parse({ ease: 5.1, intervalDays: 0, nextReview: '2026-07-01T00:00:00.000Z' })).toThrow();
  });

  it('rejects a negative intervalDays', () => {
    expect(() => memoryScheduleSchema.parse({ ease: 2.5, intervalDays: -1, nextReview: '2026-07-01T00:00:00.000Z' })).toThrow();
  });
});

describe('memoryItemCreateSchema', () => {
  it('accepts a well-formed create request with an embedded schedule', () => {
    const parsed = memoryItemCreateSchema.parse({
      title: 'My Poem',
      type: 'poem',
      lines: ['line one', 'line two'],
      schedule: { ease: 2.5, intervalDays: 1, nextReview: '2026-07-01T00:00:00.000Z' },
    });
    expect(parsed.schedule.ease).toBe(2.5);
    expect(parsed.type).toBe('poem');
  });

  it('rejects an out-of-bounds embedded schedule ease (schema parity with memoryScheduleSchema)', () => {
    expect(() => memoryItemCreateSchema.parse({
      title: 'My Poem',
      lines: ['line one'],
      schedule: { ease: 10, intervalDays: 1, nextReview: '2026-07-01T00:00:00.000Z' },
    })).toThrow();
  });

  it('rejects an empty lines array', () => {
    expect(() => memoryItemCreateSchema.parse({ title: 'Empty', lines: [] })).toThrow();
  });

  it('rejects an unknown item type', () => {
    expect(() => memoryItemCreateSchema.parse({ title: 'X', type: 'novel', lines: ['a'] })).toThrow();
  });

  it('defaults type to "text" when omitted', () => {
    expect(memoryItemCreateSchema.parse({ title: 'X', lines: ['a'] }).type).toBe('text');
  });
});

// =============================================================================
// memoryPracticeSchema mode enums (issue #2102 notes)
// =============================================================================

describe('memoryPracticeSchema mode enums', () => {
  it('accepts every documented practice mode', () => {
    for (const mode of ['fill-blank', 'sequence', 'element-flash', 'learn', 'speed-run']) {
      const parsed = memoryPracticeSchema.parse({ mode, results: [{ correct: true }] });
      expect(parsed.mode).toBe(mode);
    }
  });

  it('rejects an unknown practice mode', () => {
    expect(() => memoryPracticeSchema.parse({ mode: 'not-a-mode', results: [{ correct: true }] })).toThrow();
  });

  it('rejects an empty results array', () => {
    expect(() => memoryPracticeSchema.parse({ mode: 'fill-blank', results: [] })).toThrow();
  });

  it('accepts a nullable chunkId and optional totalMs', () => {
    const parsed = memoryPracticeSchema.parse({
      mode: 'sequence', chunkId: null, results: [{ correct: false, expected: 'x', answered: 'y' }], totalMs: 4000,
    });
    expect(parsed.chunkId).toBeNull();
    expect(parsed.totalMs).toBe(4000);
  });
});
