import { describe, it, expect } from 'vitest';
import { canRunTaskOutputHookWithoutPayload, getTaskInputHook, getTaskOutputHook, isProgrammaticIoTaskType, resolveTaskHookType } from './taskTypeHooks.js';

describe('taskTypeHooks registry', () => {
  it('resolves both hooks for layered-intelligence to callables', async () => {
    const input = await getTaskInputHook('layered-intelligence');
    const output = await getTaskOutputHook('layered-intelligence');
    expect(typeof input).toBe('function');
    expect(typeof output).toBe('function');
  });

  it('resolves both hooks for issue-watcher to callables', async () => {
    expect(typeof await getTaskInputHook('issue-watcher')).toBe('function');
    expect(typeof await getTaskOutputHook('issue-watcher')).toBe('function');
  });

  it('returns null for a task type with no registered hooks', async () => {
    expect(await getTaskInputHook('security')).toBeNull();
    expect(await getTaskOutputHook('security')).toBeNull();
    expect(await getTaskInputHook('does-not-exist')).toBeNull();
    expect(await getTaskOutputHook('does-not-exist')).toBeNull();
  });

  it('declares only payload-independent hooks safe for sentinel-less recovery', () => {
    // No registered type is payload-independent today (quota-burn was, until it
    // stopped being a scheduled task type entirely — see quotaBurnRunner.js).
    // The predicate must still fail CLOSED for everything else.
    expect(canRunTaskOutputHookWithoutPayload('layered-intelligence')).toBe(false);
    expect(canRunTaskOutputHookWithoutPayload('issue-watcher')).toBe(false);
    expect(canRunTaskOutputHookWithoutPayload('does-not-exist')).toBe(false);
  });
});

describe('isProgrammaticIoTaskType (#2700)', () => {
  it('recognizes a registered programmatic-I/O task type', () => {
    expect(isProgrammaticIoTaskType('layered-intelligence')).toBe(true);
    expect(isProgrammaticIoTaskType('issue-watcher')).toBe(true);
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

describe('resolveTaskHookType', () => {
  it('prefers the live scheduled type and supports archived task projections', () => {
    expect(resolveTaskHookType({ taskType: 'internal', metadata: { analysisType: 'issue-watcher', taskAnalysisType: 'layered-intelligence' } }))
      .toBe('issue-watcher');
    expect(resolveTaskHookType({ taskType: 'internal', metadata: { taskAnalysisType: 'issue-watcher' } }))
      .toBe('issue-watcher');
    expect(resolveTaskHookType({ taskType: 'layered-intelligence', metadata: {} })).toBe('layered-intelligence');
  });
});
