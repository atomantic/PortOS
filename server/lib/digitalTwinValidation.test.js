import { describe, it, expect } from 'vitest';
import {
  runTestsInputSchema,
  runMultiTestsInputSchema,
  createPersonaInputSchema,
  setActivePersonaInputSchema,
  digitalTwinSettingsSchema
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
});
