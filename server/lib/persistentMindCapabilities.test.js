import { describe, expect, it } from 'vitest';
import {
  createDefaultPersistentMindCapabilities,
  mergePersistentMindCapabilities,
  normalizePersistentMindCapabilities,
  persistentMindCapabilitiesSchema,
  persistentMindTaskRequestSchema,
} from './persistentMindCapabilities.js';

describe('persistent mind capabilities', () => {
  it('keeps task creation opt-in across fresh and legacy config', () => {
    expect(createDefaultPersistentMindCapabilities()).toMatchObject({ createTasks: false });
    expect(normalizePersistentMindCapabilities(null)).toMatchObject({ createTasks: false });
    expect(normalizePersistentMindCapabilities({ createTasks: 'true' })).toMatchObject({ createTasks: false });
  });

  it('validates and merges the explicit task-creation grant', () => {
    expect(persistentMindCapabilitiesSchema.safeParse({ createTasks: true }).success).toBe(true);
    expect(persistentMindCapabilitiesSchema.safeParse({ createTasks: true, shell: true }).success).toBe(false);
    expect(mergePersistentMindCapabilities({ createTasks: false }, { createTasks: true }))
      .toMatchObject({ createTasks: true });
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
    expect(persistentMindTaskRequestSchema.safeParse({ ...task, prCompletion: 'merge-now' }).success).toBe(false);
    expect(persistentMindTaskRequestSchema.safeParse({ ...task, priority: 'URGENT' }).success).toBe(false);
  });
});
