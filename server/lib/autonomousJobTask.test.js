import { describe, it, expect } from 'vitest';
import { generatedJobTaskFields, isExpectedUnpersistedMiss } from './autonomousJobTask.js';

const scheduled = { id: 'job-refresh-x-lz9abc', metadata: { autonomousJob: true, jobId: 'job-refresh-x' } };

describe('isExpectedUnpersistedMiss', () => {
  it('treats a missing scheduler-fired job task as expected', () => {
    expect(isExpectedUnpersistedMiss(scheduled, 'Task not found')).toBe(true);
  });
  it('still surfaces a persisted (addTask-minted) job task that vanished', () => {
    const persisted = { id: 'task-123', metadata: { autonomousJob: true, jobId: 'job-refresh-x' } };
    expect(isExpectedUnpersistedMiss(persisted, 'Task not found')).toBe(false);
  });
  it('still surfaces other errors and non-job tasks', () => {
    expect(isExpectedUnpersistedMiss(scheduled, 'Other failure')).toBe(false);
    expect(isExpectedUnpersistedMiss({ id: 'app-improve-1', metadata: {} }, 'Task not found')).toBe(false);
  });
});

describe('generatedJobTaskFields', () => {
  it('forwards executionOptions and omits the key when absent', () => {
    expect(generatedJobTaskFields({ metadata: { executionOptions: { serviceTier: 'fast' } } }).executionOptions).toEqual({ serviceTier: 'fast' });
    expect(generatedJobTaskFields({ metadata: {} })).not.toHaveProperty('executionOptions');
  });
});
