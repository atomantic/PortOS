import { describe, expect, it } from 'vitest';
import { loadLateBoundService, registerLateBoundService } from './lateBoundServices.js';

describe('late-bound services', () => {
  it('rejects a name this process never registered instead of resolving to an empty module', async () => {
    await expect(loadLateBoundService('neverRegistered')).rejects.toThrow(/"neverRegistered" is not registered/);
  });

  it('loads through the last registration, on demand', async () => {
    let loads = 0;
    registerLateBoundService('example', async () => { loads += 1; return { value: 'first' }; });
    expect(loads).toBe(0);
    expect(await loadLateBoundService('example')).toEqual({ value: 'first' });
    registerLateBoundService('example', () => ({ value: 'second' }));
    expect(await loadLateBoundService('example')).toEqual({ value: 'second' });
    expect(loads).toBe(1);
  });

  it('surfaces a failed load and refuses a registration that is not a loader', async () => {
    registerLateBoundService('broken', () => Promise.reject(new Error('cannot load')));
    await expect(loadLateBoundService('broken')).rejects.toThrow('cannot load');
    expect(() => registerLateBoundService('module', { value: 1 })).toThrow(/loader function/);
  });
});
