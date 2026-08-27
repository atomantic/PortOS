import { describe, expect, it } from 'vitest';
import {
  createDefaultPersistentMindCapabilities,
  mergePersistentMindCapabilities,
  normalizePersistentMindCapabilities,
  PERSISTENT_MIND_TOOL_CATALOG,
  persistentMindCapabilitiesSchema,
  persistentMindTaskRequestSchema,
} from './persistentMindCapabilities.js';

describe('persistent mind capabilities', () => {
  it('describes every persistent-mind grant from the capability contract', () => {
    expect(PERSISTENT_MIND_TOOL_CATALOG).toEqual([
      expect.objectContaining({ id: 'cos.create-task', capability: 'createTasks', defaultEnabled: false }),
      expect.objectContaining({ id: 'portos.read', capability: 'readPortos', defaultEnabled: false }),
      expect.objectContaining({ id: 'portos.write', capability: 'writePortos', defaultEnabled: false }),
    ]);
  });

  it('keeps task creation opt-in across fresh and legacy config', () => {
    expect(createDefaultPersistentMindCapabilities()).toMatchObject({ createTasks: false, readPortos: false, writePortos: false });
    expect(normalizePersistentMindCapabilities(null)).toMatchObject({ createTasks: false, readPortos: false, writePortos: false });
    expect(normalizePersistentMindCapabilities({ createTasks: 'true', readPortos: 'true' })).toMatchObject({ createTasks: false, readPortos: false });
  });

  it('validates and merges the explicit task-creation grant', () => {
    expect(persistentMindCapabilitiesSchema.safeParse({ createTasks: true, readPortos: true, writePortos: false }).success).toBe(true);
    expect(persistentMindCapabilitiesSchema.safeParse({ createTasks: true, shell: true }).success).toBe(false);
    expect(mergePersistentMindCapabilities({ createTasks: false }, { createTasks: true }))
      .toMatchObject({ createTasks: true, readPortos: false, writePortos: false });
  });

  it('accepts only bounded typed task requests and known PR dispositions', () => {
    const task = {
      description: 'Audit the local configuration contract',
      prompt: 'Inspect the repository and implement the bounded fix.',
      priority: 'HIGH',
      appId: 'portos',
      providerId: 'codex',
      model: 'gpt-5',
      effort: 'high',
      prCompletion: 'review-then-merge',
    };
    expect(persistentMindTaskRequestSchema.safeParse(task).success).toBe(true);
    expect(persistentMindTaskRequestSchema.safeParse({ ...task, requiredValidation: ['dependencies', 'reviewers'] }).success).toBe(true);
    expect(persistentMindTaskRequestSchema.safeParse({ ...task, requiredValidation: ['shell'] }).success).toBe(false);
    expect(persistentMindTaskRequestSchema.safeParse({ ...task, prCompletion: 'merge-now' }).success).toBe(false);
    expect(persistentMindTaskRequestSchema.safeParse({ ...task, priority: 'URGENT' }).success).toBe(false);
  });

  it('allows plan-and-file requests without a PR disposition', () => {
    const task = {
      description: 'File an issue for the missing export contract',
      prompt: 'Inspect the repository and file one actionable issue without editing code.',
      appId: 'portos',
      providerId: 'codex',
      model: '',
      effort: '',
      planOnly: true,
    };
    expect(persistentMindTaskRequestSchema.safeParse(task).success).toBe(true);
    expect(persistentMindTaskRequestSchema.safeParse({ ...task, planOnly: false }).success).toBe(false);
  });
});
