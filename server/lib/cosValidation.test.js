import { describe, it, expect } from 'vitest';
import {
  createCosTaskSchema,
  updateCosTaskSchema,
  createCosJobSchema,
  updateCosJobSchema,
  sanitizeTaskMetadata,
  taskTemplateSettingsSchema,
} from './cosValidation.js';
import { EFFORT_LEVELS } from './providerModels.js';

describe('cosValidation effort field', () => {
  it('accepts every EFFORT_LEVELS value on create and rejects unknown values', () => {
    for (const effort of EFFORT_LEVELS) {
      expect(createCosTaskSchema.safeParse({ description: 'x', effort }).success).toBe(true);
    }
    expect(createCosTaskSchema.safeParse({ description: 'x', effort: 'bogus' }).success).toBe(false);
  });

  it("create: '' (the form's Default option) parses to absent, not a stored empty pin", () => {
    const parsed = createCosTaskSchema.parse({ description: 'x', effort: '' });
    expect('effort' in parsed && parsed.effort !== undefined).toBe(false);
  });

  it("update: ''/null survive as null so the API can CLEAR a set effort pin", () => {
    // absent-vs-cleared (AGENTS.md): the route gates on `!== undefined`, and the
    // store's legacy-field normalizer deletes a null pin — so the clear signal
    // must reach the route as null, not be preprocessed away to undefined.
    expect(updateCosTaskSchema.parse({ effort: '' }).effort).toBeNull();
    expect(updateCosTaskSchema.parse({ effort: null }).effort).toBeNull();
    expect(updateCosTaskSchema.parse({ effort: 'high' }).effort).toBe('high');
    expect(updateCosTaskSchema.parse({}).effort).toBeUndefined();
    expect(updateCosTaskSchema.safeParse({ effort: 'bogus' }).success).toBe(false);
  });
});

describe('cosValidation OpenCode Ollama generation overrides', () => {
  it('accepts bounded temperature and explicit thinking, including false', () => {
    expect(createCosTaskSchema.parse({ description: 'x', temperature: 0.25, thinking: false }))
      .toMatchObject({ temperature: 0.25, thinking: false });
    expect(createCosTaskSchema.safeParse({ description: 'x', temperature: 2.1 }).success).toBe(false);
    expect(updateCosTaskSchema.parse({ thinking: null, temperature: null }))
      .toMatchObject({ thinking: null, temperature: null });
  });
});

describe('branch-reconcile batch metadata', () => {
  it('keeps integer batch sizes from 1 through 6', () => {
    expect(sanitizeTaskMetadata({ branchesPerAgent: 1 })).toEqual({ branchesPerAgent: 1 });
    expect(sanitizeTaskMetadata({ branchesPerAgent: 6 })).toEqual({ branchesPerAgent: 6 });
  });

  it('drops zero, fractional, string, and unbounded batch sizes', () => {
    for (const branchesPerAgent of [0, 7, 1.5, '3', null]) {
      expect(sanitizeTaskMetadata({ branchesPerAgent })).toBeNull();
    }
  });
});

describe('cosValidation pipeline stage metadata', () => {
  const validStage = {
    name: 'Eligibility Gate',
    promptKey: 'pr-reviewer-eligibility',
    role: 'eligibility',
    executionProfile: 'public-review-gate',
    providerId: 'local-claude-wrapper',
    model: 'safe-local-model',
    effort: 'high',
    readOnly: true,
    managed: true,
    useWorktree: true,
    openPR: false,
    simplify: false,
    reviewLoop: false,
    discardWorktree: true,
    noCodeOutput: true,
    precondition: { fileExists: 'screened-input.json' },
  };

  it('keeps the validated stage contract and drops unknown fields', () => {
    expect(sanitizeTaskMetadata({
      pipeline: {
        stages: [{ ...validStage, unknown: 'must not persist' }],
      },
    })).toEqual({ pipeline: { stages: [validStage] } });
  });

  it('rejects malformed role, profile, effort, posture, and precondition values', () => {
    const invalidCases = [
      ['role', 'review'],
      ['executionProfile', 'unrestricted'],
      ['effort', 'bogus'],
      ['discardWorktree', 'yes'],
      ['noCodeOutput', 1],
      ['precondition', { fileExists: '../outside-worktree' }],
      ['precondition', { fileExists: 'a', fileNotExists: 'b' }],
    ];
    for (const [field, value] of invalidCases) {
      expect(sanitizeTaskMetadata({ pipeline: { stages: [{ ...validStage, [field]: value }] } }), field)
        .toBeNull();
    }
  });

  it('allows explicit clear values for provider and model pins', () => {
    const expectedStage = { ...validStage };
    delete expectedStage.providerId;
    delete expectedStage.model;
    delete expectedStage.effort;
    expect(sanitizeTaskMetadata({
      pipeline: { stages: [{ ...validStage, providerId: null, model: null, effort: null }] },
    })).toEqual({
      pipeline: { stages: [expectedStage] },
    });
  });
});

describe('cosValidation autonomous-job effort field', () => {
  it('accepts every EFFORT_LEVELS value on create and rejects unknown values', () => {
    for (const effort of EFFORT_LEVELS) {
      expect(createCosJobSchema.safeParse({ name: 'j', effort }).success).toBe(true);
    }
    expect(createCosJobSchema.safeParse({ name: 'j', effort: 'bogus' }).success).toBe(false);
  });

  it("mirrors providerId's clearable-null semantics: ''/null → null, absent → undefined", () => {
    // A job effort pin is clearable through a PUT the same way providerId is —
    // '' from the UI picker and an explicit null both persist as null so
    // updateJob (which skips only `undefined`) resets the pin to the provider
    // default; an omitted key stays undefined and preserves the existing value.
    expect(createCosJobSchema.parse({ name: 'j', effort: '' }).effort).toBeNull();
    expect(updateCosJobSchema.parse({ effort: '' }).effort).toBeNull();
    expect(updateCosJobSchema.parse({ effort: null }).effort).toBeNull();
    expect(updateCosJobSchema.parse({ effort: 'max' }).effort).toBe('max');
    expect(updateCosJobSchema.parse({}).effort).toBeUndefined();
    expect(updateCosJobSchema.safeParse({ effort: 'bogus' }).success).toBe(false);
  });
});

describe('cosValidation autonomous-job data inputs', () => {
  it('accepts registered ids, de-duplicates them, and preserves an explicit clear', () => {
    expect(createCosJobSchema.parse({
      name: 'j',
      dataInputs: ['project-goals', 'open-issues', 'project-goals'],
    }).dataInputs).toEqual(['project-goals', 'open-issues']);
    expect(updateCosJobSchema.parse({ dataInputs: [] }).dataInputs).toEqual([]);
    expect(updateCosJobSchema.parse({}).dataInputs).toBeUndefined();
  });

  it('rejects unknown input ids', () => {
    expect(createCosJobSchema.safeParse({ name: 'j', dataInputs: ['unknown-source'] }).success).toBe(false);
  });
});

describe('cosValidation job taskMetadata.worktreeChangesExpected (#3102)', () => {
  it('accepts the flag and preserves an explicit false (schema parity with the sanitizer)', () => {
    // Zod strips undeclared keys, so an unlisted flag would be silently dropped
    // from a job's taskMetadata — the opt-out has to be declared here too.
    const parsed = createCosJobSchema.parse({
      name: 'j',
      taskMetadata: { useWorktree: true, worktreeChangesExpected: false },
    });
    expect(parsed.taskMetadata).toEqual({ useWorktree: true, worktreeChangesExpected: false });
    expect(createCosJobSchema.safeParse({ name: 'j', taskMetadata: { worktreeChangesExpected: 'nope' } }).success)
      .toBe(false);
  });
});

describe('cosValidation job taskMetadata.noChangeSuccess (#5074)', () => {
  it('accepts the verified no-change marker and rejects non-boolean values', () => {
    const parsed = createCosJobSchema.parse({
      name: 'catalog audit',
      taskMetadata: { useWorktree: true, noChangeSuccess: true },
    });
    expect(parsed.taskMetadata).toEqual({ useWorktree: true, noChangeSuccess: true });
    expect(createCosJobSchema.safeParse({ name: 'catalog audit', taskMetadata: { noChangeSuccess: 'yes' } }).success)
      .toBe(false);
  });

  it('keeps the marker available to app task-type override sanitization', () => {
    expect(sanitizeTaskMetadata({ noChangeSuccess: true })).toEqual({ noChangeSuccess: true });
    expect(sanitizeTaskMetadata({ noChangeSuccess: false })).toEqual({ noChangeSuccess: false });
    expect(sanitizeTaskMetadata({ noChangeSuccess: 'true' })).toBeNull();
  });
});

describe('cosValidation task metadata claimFlow marker', () => {
  it('sanitizes the claim lifecycle marker as a boolean', () => {
    expect(sanitizeTaskMetadata({ claimFlow: true })).toEqual({ claimFlow: true });
    expect(sanitizeTaskMetadata({ claimFlow: false })).toEqual({ claimFlow: false });
    expect(sanitizeTaskMetadata({ claimFlow: 'true' })).toBeNull();
  });
});

describe('cosValidation quick-template deliverable posture (#3651)', () => {
  it('taskTemplateSettingsSchema accepts worktreeChangesExpected (the block is .strict())', () => {
    // taskTemplates.js copies the slashdo catalog posture onto each built-in
    // template verbatim; a user saving such a template back would 400 if the
    // strict settings block didn't declare the key.
    const parsed = taskTemplateSettingsSchema.parse({ useWorktree: false, openPR: false, simplify: false, worktreeChangesExpected: false });
    expect(parsed).toEqual({ useWorktree: false, openPR: false, simplify: false, worktreeChangesExpected: false });
    expect(taskTemplateSettingsSchema.safeParse({ worktreeChangesExpected: true }).success).toBe(true);
    expect(taskTemplateSettingsSchema.safeParse({ worktreeChangesExpected: 'nope' }).success).toBe(false);
    expect(taskTemplateSettingsSchema.safeParse({ bogus: true }).success).toBe(false);
  });

  it('create-task accepts the boolean and the form-encoded string forms', () => {
    expect(createCosTaskSchema.parse({ description: 'x', worktreeChangesExpected: false }).worktreeChangesExpected).toBe(false);
    expect(createCosTaskSchema.parse({ description: 'x', worktreeChangesExpected: true }).worktreeChangesExpected).toBe(true);
    expect(createCosTaskSchema.parse({ description: 'x', worktreeChangesExpected: 'false' }).worktreeChangesExpected).toBe(false);
    expect(createCosTaskSchema.parse({ description: 'x', worktreeChangesExpected: 'true' }).worktreeChangesExpected).toBe(true);
    // Absent must stay absent — cosTaskStore only stamps metadata on a strict
    // boolean, so "no opinion" has to survive as undefined.
    expect(createCosTaskSchema.parse({ description: 'x' }).worktreeChangesExpected).toBeUndefined();
    expect(createCosTaskSchema.safeParse({ description: 'x', worktreeChangesExpected: 'nope' }).success).toBe(false);
  });
});

describe('cosValidation plan-only task mode', () => {
  it('accepts boolean and form-encoded planOnly values while preserving absence', () => {
    expect(createCosTaskSchema.parse({ description: 'x', planOnly: true }).planOnly).toBe(true);
    expect(createCosTaskSchema.parse({ description: 'x', planOnly: 'false' }).planOnly).toBe(false);
    expect(createCosTaskSchema.parse({ description: 'x' }).planOnly).toBeUndefined();
    expect(createCosTaskSchema.safeParse({ description: 'x', planOnly: 'maybe' }).success).toBe(false);
  });

});

describe('cosValidation non-worktree completion choice', () => {
  it('accepts the supported completion choices and preserves them through metadata sanitization', () => {
    expect(createCosTaskSchema.parse({ description: 'x', whenDone: 'commit-push' }).whenDone).toBe('commit-push');
    expect(createCosTaskSchema.parse({ description: 'x', whenDone: 'leave-uncommitted' }).whenDone).toBe('leave-uncommitted');
    expect(createCosTaskSchema.safeParse({ description: 'x', whenDone: 'later' }).success).toBe(false);
    expect(sanitizeTaskMetadata({ whenDone: 'commit-push' })).toEqual({ whenDone: 'commit-push' });
    expect(sanitizeTaskMetadata({ whenDone: 'later' })).toBeNull();
  });
});

// The reviewer vocabulary moved to reviewerConfig.js (#5702); cosValidation.js
// re-exports it flat and validation.js re-exports cosValidation.js. Dropping
// either hop fails no reviewer test (those import the new module directly) — it
// surfaces as `undefined is not a function` inside prompt assembly for a
// scheduled review-loop task, so pin both hops as SAME-object re-exports.
describe('reviewerConfig transitional re-export shim (#5702)', () => {
  it('re-exports every reviewerConfig symbol through cosValidation.js and validation.js', async () => {
    const reviewerConfig = await import('./reviewerConfig.js');
    const cos = await import('./cosValidation.js');
    const validation = await import('./validation.js');
    const keys = Object.keys(reviewerConfig);
    expect(keys).toContain('buildReviewWithArgs');
    expect(keys).toContain('REVIEWER_VALUES');
    for (const key of keys) {
      expect(cos[key], `cosValidation.js re-export of '${key}'`).toBe(reviewerConfig[key]);
      expect(validation[key], `validation.js re-export of '${key}'`).toBe(reviewerConfig[key]);
    }
  });
});

describe('createCosTaskSchema isInvestigation (#6043)', () => {
  it('survives validation instead of being stripped, in both the boolean and form-string shapes', () => {
    expect(createCosTaskSchema.parse({ description: 'x', isInvestigation: true }).isInvestigation).toBe(true);
    expect(createCosTaskSchema.parse({ description: 'x', isInvestigation: 'true' }).isInvestigation).toBe(true);
    expect(createCosTaskSchema.parse({ description: 'x', isInvestigation: false }).isInvestigation).toBe(false);
    expect(createCosTaskSchema.parse({ description: 'x', isInvestigation: 'false' }).isInvestigation).toBe(false);
  });

  it('is absent by default, so an ordinary task stays outside the investigation machinery', () => {
    expect(createCosTaskSchema.parse({ description: 'x' }).isInvestigation).toBeUndefined();
  });

  it('rejects a non-boolean rather than coercing a truthy string into the marker', () => {
    expect(createCosTaskSchema.safeParse({ description: 'x', isInvestigation: 'yes' }).success).toBe(false);
  });

  it('never accepts a client-supplied fingerprint — the server derives it', () => {
    const parsed = createCosTaskSchema.parse({
      description: 'x',
      isInvestigation: true,
      investigationFingerprint: 'auth-error:provider-failure:Example CLI',
    });
    expect(parsed).not.toHaveProperty('investigationFingerprint');
  });
});
