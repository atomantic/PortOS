import { describe, it, expect } from 'vitest';
import { getTaskInputHook, getTaskOutputHook, isProgrammaticIoTaskType } from './taskTypeHooks.js';

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

describe('isProgrammaticIoTaskType (#2700)', () => {
  it('recognizes a registered programmatic-I/O task type', () => {
    expect(isProgrammaticIoTaskType('layered-intelligence')).toBe(true);
  });

  it('rejects unregistered types, non-strings, and inherited Object keys', () => {
    expect(isProgrammaticIoTaskType('ui')).toBe(false);
    expect(isProgrammaticIoTaskType('')).toBe(false);
    expect(isProgrammaticIoTaskType(undefined)).toBe(false);
    expect(isProgrammaticIoTaskType(null)).toBe(false);
    // A truthiness check on the registry object would let these through.
    expect(isProgrammaticIoTaskType('constructor')).toBe(false);
    expect(isProgrammaticIoTaskType('toString')).toBe(false);
  });
});
