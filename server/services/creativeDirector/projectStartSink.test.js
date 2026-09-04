import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerCreativeDirectorProjectStarter,
  hasCreativeDirectorProjectStarter,
  requestCreativeDirectorProjectStart,
  __resetCreativeDirectorProjectStarter,
} from './projectStartSink.js';

// The sink is the seam that keeps `pipeline/*` and `creativeDirector/*` out of a
// shared static import cycle (#5920). Its whole contract is "the CD side wires a
// starter, the pipeline side calls it, and an UNWIRED sink is loud" — a silent
// no-op there would strand a pipeline episode's CD project in `pending` with
// nothing in the logs.
describe('creativeDirector/projectStartSink (#5920)', () => {
  beforeEach(() => __resetCreativeDirectorProjectStarter());

  it('rejects a start request before a starter is registered', async () => {
    expect(hasCreativeDirectorProjectStarter()).toBe(false);
    await expect(requestCreativeDirectorProjectStart('proj-1')).rejects.toThrow(/proj-1/);
  });

  it('delegates to the registered starter and returns its result', async () => {
    const starter = vi.fn(async (id) => `started:${id}`);
    registerCreativeDirectorProjectStarter(starter);

    expect(hasCreativeDirectorProjectStarter()).toBe(true);
    await expect(requestCreativeDirectorProjectStart('proj-2')).resolves.toBe('started:proj-2');
    expect(starter).toHaveBeenCalledWith('proj-2');
  });

  it('is idempotent for the same starter but rejects a second, different one', () => {
    const starter = vi.fn();
    registerCreativeDirectorProjectStarter(starter);
    expect(() => registerCreativeDirectorProjectStarter(starter)).not.toThrow();
    expect(() => registerCreativeDirectorProjectStarter(vi.fn())).toThrow(/already registered/);
  });

  it('refuses a non-function registrant', () => {
    expect(() => registerCreativeDirectorProjectStarter(null)).toThrow(/must be a function/);
    expect(() => registerCreativeDirectorProjectStarter('nope')).toThrow(/must be a function/);
  });
});
