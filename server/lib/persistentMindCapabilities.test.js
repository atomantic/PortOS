import { describe, expect, it } from 'vitest';
import {
  createDefaultPersistentMindCapabilities,
  isPersistentMindTaskModelAllowed,
  mergePersistentMindCapabilities,
  normalizePersistentMindCapabilities,
  PERSISTENT_MIND_TOOL_CATALOG,
  persistentMindCapabilitiesSchema,
  persistentMindCleanupRequestSchema,
  persistentMindTaskRequestSchema,
} from './persistentMindCapabilities.js';

describe('persistent mind capabilities', () => {
  it('describes every persistent-mind grant from the capability contract', () => {
    expect(PERSISTENT_MIND_TOOL_CATALOG).toEqual([
      expect.objectContaining({ id: 'cos.create-task', capability: 'createTasks', defaultEnabled: false }),
      expect.objectContaining({ id: 'portos.read', capability: 'readPortos', defaultEnabled: false }),
      expect.objectContaining({ id: 'portos.write', capability: 'writePortos', defaultEnabled: false }),
      expect.objectContaining({ id: 'mind.cleanup', capability: 'manageMind', defaultEnabled: false }),
    ]);
  });

  it('keeps task creation opt-in across fresh and legacy config', () => {
    expect(createDefaultPersistentMindCapabilities()).toMatchObject({ createTasks: false, manageMind: false, readPortos: false, writePortos: false });
    expect(normalizePersistentMindCapabilities(null)).toMatchObject({ createTasks: false, manageMind: false, readPortos: false, writePortos: false });
    expect(normalizePersistentMindCapabilities({ createTasks: 'true', readPortos: 'true' })).toMatchObject({ createTasks: false, readPortos: false });
  });

  it('validates and merges the explicit task-creation grant', () => {
    expect(persistentMindCapabilitiesSchema.safeParse({ createTasks: true, manageMind: true, readPortos: true, writePortos: false }).success).toBe(true);
    expect(persistentMindCapabilitiesSchema.safeParse({ schemaVersion: 2, createTasks: true }).success).toBe(true);
    expect(persistentMindCapabilitiesSchema.safeParse({ taskModelAllowlist: [{ providerId: 'ollama', model: 'example-local' }] }).success).toBe(true);
    expect(normalizePersistentMindCapabilities({ schemaVersion: 2, createTasks: true }))
      .toMatchObject({ schemaVersion: 3, createTasks: true, manageMind: false });
    expect(persistentMindCapabilitiesSchema.safeParse({ allowedAppIds: ['example-app', 'second-app'] }).success).toBe(true);
    expect(persistentMindCapabilitiesSchema.safeParse({ allowedAppIds: Array.from({ length: 51 }, (_, index) => `app-${index}`) }).success).toBe(false);
    expect(persistentMindCapabilitiesSchema.safeParse({ createTasks: true, shell: true }).success).toBe(false);
    expect(mergePersistentMindCapabilities({ createTasks: false }, { createTasks: true }))
      .toMatchObject({ createTasks: true, manageMind: false, readPortos: false, writePortos: false });
  });

  it('accepts only unique bounded mindspace cleanup scopes', () => {
    expect(persistentMindCleanupRequestSchema.safeParse({ scopes: ['context', 'history', 'memories'], reason: 'Old failures are no longer useful' }).success).toBe(true);
    expect(persistentMindCleanupRequestSchema.safeParse({ scopes: [] }).success).toBe(false);
    expect(persistentMindCleanupRequestSchema.safeParse({ scopes: ['history', 'history'] }).success).toBe(false);
    expect(persistentMindCleanupRequestSchema.safeParse({ scopes: ['everything'] }).success).toBe(false);
  });

  it('restricts task choices only when exact provider/model pairs are configured', () => {
    const restricted = normalizePersistentMindCapabilities({
      createTasks: true,
      taskModelAllowlist: [{ providerId: 'ollama', model: 'example-local' }],
    });
    expect(isPersistentMindTaskModelAllowed(restricted, 'ollama', 'example-local')).toBe(true);
    expect(isPersistentMindTaskModelAllowed(restricted, 'ollama', 'example-cloud')).toBe(false);
    expect(isPersistentMindTaskModelAllowed(restricted, 'codex', 'example-local')).toBe(false);
    expect(isPersistentMindTaskModelAllowed({}, 'codex', 'example-cloud')).toBe(true);
  });

  it('fails closed when a persisted task model policy is malformed', () => {
    const malformed = normalizePersistentMindCapabilities({
      taskModelAllowlist: [{ providerId: 'ollama', model: '' }],
    });
    expect(malformed.taskModelAllowlistInvalid).toBe(true);
    expect(isPersistentMindTaskModelAllowed(malformed, 'ollama', 'example-local')).toBe(false);
    expect(mergePersistentMindCapabilities(malformed, { readPortos: true }).taskModelAllowlistInvalid).toBe(true);
  });

  it('preserves legacy all-app access while normalizing an explicit app allowlist', () => {
    expect(normalizePersistentMindCapabilities({ createTasks: true })).not.toHaveProperty('allowedAppIds');
    expect(normalizePersistentMindCapabilities({ allowedAppIds: [' example-app ', 'example-app', '', 'second-app'] }))
      .toMatchObject({ allowedAppIds: ['example-app', 'second-app'] });
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
