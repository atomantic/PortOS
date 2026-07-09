import { describe, it, expect } from 'vitest';
import { getTaskInputHook, getTaskOutputHook } from './taskTypeHooks.js';

describe('taskTypeHooks registry', () => {
  it('resolves both hooks for layered-intelligence to callables', async () => {
    const input = await getTaskInputHook('layered-intelligence');
    const output = await getTaskOutputHook('layered-intelligence');
    expect(typeof input).toBe('function');
    expect(typeof output).toBe('function');
  });

  it('returns null for a task type with no registered hooks', async () => {
    expect(await getTaskInputHook('security')).toBeNull();
    expect(await getTaskOutputHook('security')).toBeNull();
    expect(await getTaskInputHook('does-not-exist')).toBeNull();
    expect(await getTaskOutputHook('does-not-exist')).toBeNull();
  });
});
