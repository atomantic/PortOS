import { describe, it, expect } from 'vitest';
import {
  runTestsInputSchema,
  runMultiTestsInputSchema,
  createPersonaInputSchema,
  updatePersonaInputSchema,
  setActivePersonaInputSchema,
  personaTraitAdjustmentsSchema,
  personaSchema,
  digitalTwinSettingsSchema,
  testHistoryEntrySchema,
  valuesTestHistoryEntrySchema
} from './digitalTwinValidation.js';

// Regression guard: the client API wrappers default `testIds` to `null` for a
// "run all tests" request. A bare `.optional()` rejects null and would 400
// every UI-triggered run — the values-alignment panel always sends null.
describe('runTestsInputSchema testIds null-tolerance', () => {
  it('accepts testIds: null (run-all sentinel) and normalizes it away', () => {
    const parsed = runTestsInputSchema.parse({ providerId: 'p', model: 'm', testIds: null });
    expect(parsed.testIds).toBeUndefined();
  });

  it('accepts an explicit array of test ids', () => {
    const parsed = runTestsInputSchema.parse({ providerId: 'p', model: 'm', testIds: [1, 2] });
    expect(parsed.testIds).toEqual([1, 2]);
  });

  it('accepts an omitted testIds', () => {
    expect(runTestsInputSchema.parse({ providerId: 'p', model: 'm' }).testIds).toBeUndefined();
  });

  it('still rejects malformed test ids', () => {
    expect(runTestsInputSchema.safeParse({ providerId: 'p', model: 'm', testIds: ['x'] }).success).toBe(false);
  });

  it('tolerates null testIds on the multi-model schema too', () => {
    const parsed = runMultiTestsInputSchema.parse({
      providers: [{ providerId: 'p', model: 'm' }],
      testIds: null
    });
    expect(parsed.testIds).toBeUndefined();
  });
});

// Per-persona testing (M34 P7): a test run may embody a persona. The UI's
// "Base twin" choice sends '' (or omits it); a specific persona sends its uuid.
describe('runTestsInputSchema personaId (per-persona testing)', () => {
  const uuid = '22222222-2222-4222-8222-222222222222';

  it('treats empty-string personaId as base twin (normalized away)', () => {
    const parsed = runTestsInputSchema.parse({ providerId: 'p', model: 'm', personaId: '' });
    expect(parsed.personaId).toBeUndefined();
  });

  it('treats null/omitted personaId as base twin', () => {
    expect(runTestsInputSchema.parse({ providerId: 'p', model: 'm', personaId: null }).personaId).toBeUndefined();
    expect(runTestsInputSchema.parse({ providerId: 'p', model: 'm' }).personaId).toBeUndefined();
  });

  it('accepts a uuid persona id', () => {
    expect(runTestsInputSchema.parse({ providerId: 'p', model: 'm', personaId: uuid }).personaId).toBe(uuid);
  });

  it('rejects a malformed persona id', () => {
    expect(runTestsInputSchema.safeParse({ providerId: 'p', model: 'm', personaId: 'nope' }).success).toBe(false);
  });

  it('carries personaId on the multi-model schema too', () => {
    const parsed = runMultiTestsInputSchema.parse({
      providers: [{ providerId: 'p', model: 'm' }],
      personaId: uuid
    });
    expect(parsed.personaId).toBe(uuid);
  });
});

// Run-history entries persist which persona they embodied. Zod strips unknown
// keys, so the persona fields MUST survive a parse round-trip or loadMeta would
// silently drop them — while older (persona-free) entries still validate.
describe('history-entry schemas preserve persona attribution', () => {
  const uuid = '33333333-3333-4333-8333-333333333333';
  const baseBehavioral = {
    runId: '44444444-4444-4444-8444-444444444444',
    providerId: 'p', model: 'm', score: 0.8,
    passed: 4, failed: 1, partial: 0, total: 5,
    timestamp: '2026-06-03T00:00:00.000Z'
  };
  const baseValues = {
    runId: '55555555-5555-4555-8555-555555555555',
    providerId: 'p', model: 'm', score: 0.6,
    aligned: 3, partial: 1, misaligned: 1, total: 5,
    timestamp: '2026-06-03T00:00:00.000Z'
  };

  it('keeps personaId/personaName on a behavioral entry', () => {
    const parsed = testHistoryEntrySchema.parse({ ...baseBehavioral, personaId: uuid, personaName: 'Professional' });
    expect(parsed.personaId).toBe(uuid);
    expect(parsed.personaName).toBe('Professional');
  });

  it('keeps personaId/personaName on a values entry', () => {
    const parsed = valuesTestHistoryEntrySchema.parse({ ...baseValues, personaId: uuid, personaName: 'Casual' });
    expect(parsed.personaId).toBe(uuid);
    expect(parsed.personaName).toBe('Casual');
  });

  it('still validates persona-free (legacy) entries', () => {
    expect(testHistoryEntrySchema.parse(baseBehavioral).personaName).toBeUndefined();
    expect(valuesTestHistoryEntrySchema.parse(baseValues).personaName).toBeUndefined();
  });
});

// Personas (M34 P7) — validate the create/active input contracts and that the
// settings schema accepts the activePersonaId pointer (including null = clear).
describe('persona input schemas', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';

  it('requires name and instructions to create a persona', () => {
    expect(createPersonaInputSchema.safeParse({ name: 'A', instructions: 'go' }).success).toBe(true);
    expect(createPersonaInputSchema.safeParse({ name: '', instructions: 'go' }).success).toBe(false);
    expect(createPersonaInputSchema.safeParse({ name: 'A' }).success).toBe(false);
  });

  it('accepts a uuid or null for the active persona pointer', () => {
    expect(setActivePersonaInputSchema.safeParse({ personaId: uuid }).success).toBe(true);
    expect(setActivePersonaInputSchema.safeParse({ personaId: null }).success).toBe(true);
    expect(setActivePersonaInputSchema.safeParse({ personaId: 'not-a-uuid' }).success).toBe(false);
  });

  it('lets settings carry activePersonaId (uuid or null)', () => {
    expect(digitalTwinSettingsSchema.safeParse({ activePersonaId: uuid }).success).toBe(true);
    expect(digitalTwinSettingsSchema.safeParse({ activePersonaId: null }).success).toBe(true);
    expect(digitalTwinSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('defaults includePrivacyContext to false and accepts an explicit boolean (#2147)', () => {
    expect(digitalTwinSettingsSchema.parse({}).includePrivacyContext).toBe(false);
    expect(digitalTwinSettingsSchema.safeParse({ includePrivacyContext: true }).success).toBe(true);
    expect(digitalTwinSettingsSchema.safeParse({ includePrivacyContext: 'yes' }).success).toBe(false);
  });
});

// Trait-blending (M34 P7) — personas may carry structured `traitAdjustments`.
// The schema must survive a meta round-trip (Zod strips unknown keys, so a
// missing field would silently drop the adjustments on load), bound the deltas,
// and let an update clear them with an explicit null.
describe('persona trait-blending schema', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';

  it('accepts a full set of in-range adjustments', () => {
    const parsed = personaTraitAdjustmentsSchema.safeParse({
      formality: 5, verbosity: -3, emojiUsage: 'frequent', tone: 'warm', bigFive: { A: 0.4, E: -0.2 }
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty adjustments object (instructions-only persona)', () => {
    expect(personaTraitAdjustmentsSchema.safeParse({}).success).toBe(true);
  });

  it('rejects out-of-range communication deltas', () => {
    expect(personaTraitAdjustmentsSchema.safeParse({ formality: 10 }).success).toBe(false);
    expect(personaTraitAdjustmentsSchema.safeParse({ verbosity: -10 }).success).toBe(false);
    expect(personaTraitAdjustmentsSchema.safeParse({ formality: 2.5 }).success).toBe(false);
  });

  it('rejects out-of-range big-five deltas and bad emoji enums', () => {
    expect(personaTraitAdjustmentsSchema.safeParse({ bigFive: { O: 1.5 } }).success).toBe(false);
    expect(personaTraitAdjustmentsSchema.safeParse({ emojiUsage: 'sometimes' }).success).toBe(false);
  });

  it('round-trips traitAdjustments on a full persona record', () => {
    const persona = {
      id: uuid, name: 'Pro', instructions: 'be sharp',
      traitAdjustments: { formality: 4, bigFive: { C: 0.3 } },
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z'
    };
    const parsed = personaSchema.parse(persona);
    expect(parsed.traitAdjustments).toEqual({ formality: 4, bigFive: { C: 0.3 } });
  });

  it('still validates a persona with no traitAdjustments (legacy)', () => {
    const parsed = personaSchema.parse({
      id: uuid, name: 'Pro', instructions: 'be sharp',
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z'
    });
    expect(parsed.traitAdjustments).toBeUndefined();
  });

  it('lets create accept traitAdjustments and update clear them with null', () => {
    expect(createPersonaInputSchema.safeParse({ name: 'A', instructions: 'go', traitAdjustments: { formality: 2 } }).success).toBe(true);
    expect(updatePersonaInputSchema.safeParse({ traitAdjustments: null }).success).toBe(true);
    expect(updatePersonaInputSchema.safeParse({ traitAdjustments: { verbosity: 3 } }).success).toBe(true);
  });
});
