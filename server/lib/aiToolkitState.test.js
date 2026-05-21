import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  setAIToolkitInstance,
  getAIToolkitInstance,
  requireToolkit,
} from './aiToolkitState.js';

describe('aiToolkitState', () => {
  beforeEach(() => {
    setAIToolkitInstance(null);
  });

  // The singleton lives at module scope, so any test file that imports a
  // service shim and doesn't mock it would observe whatever value the *last*
  // test in this file happened to leave behind. Reset to null so the worst
  // case for downstream files is a clean "not initialized" error rather than
  // a stale toolkit reference.
  afterAll(() => {
    setAIToolkitInstance(null);
  });

  it('requireToolkit throws AI_TOOLKIT_NOT_INITIALIZED when unset', () => {
    expect(() => requireToolkit()).toThrowError(
      expect.objectContaining({
        code: 'AI_TOOLKIT_NOT_INITIALIZED',
        status: 503,
      }),
    );
  });

  it('requireToolkit returns the instance after setAIToolkitInstance', () => {
    const toolkit = { services: { providers: {}, runner: {}, prompts: {} } };
    setAIToolkitInstance(toolkit);
    expect(requireToolkit()).toBe(toolkit);
  });

  it('getAIToolkitInstance returns null when unset (no throw)', () => {
    expect(getAIToolkitInstance()).toBeNull();
  });

  it('getAIToolkitInstance returns the same instance shared by all readers', () => {
    const toolkit = { id: 'shared' };
    setAIToolkitInstance(toolkit);
    expect(getAIToolkitInstance()).toBe(toolkit);
    expect(requireToolkit()).toBe(getAIToolkitInstance());
  });
});
