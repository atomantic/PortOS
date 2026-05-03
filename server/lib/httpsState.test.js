import { describe, it, expect, beforeEach } from 'vitest';
import { setHttpsEnabledAtBoot, getHttpsEnabledAtBoot } from './httpsState.js';

describe('httpsState', () => {
  // Module state is shared — reset to a known starting point for each case.
  beforeEach(() => {
    setHttpsEnabledAtBoot(false);
  });

  it('reports the current value after being set true', () => {
    setHttpsEnabledAtBoot(true);
    const state = getHttpsEnabledAtBoot();
    expect(state.value).toBe(true);
    expect(state.initialized).toBe(true);
  });

  it('reports the current value after being set false', () => {
    setHttpsEnabledAtBoot(false);
    const state = getHttpsEnabledAtBoot();
    expect(state.value).toBe(false);
    expect(state.initialized).toBe(true);
  });

  it('coerces truthy non-boolean inputs to true', () => {
    setHttpsEnabledAtBoot('yes');
    expect(getHttpsEnabledAtBoot().value).toBe(true);

    setHttpsEnabledAtBoot(1);
    expect(getHttpsEnabledAtBoot().value).toBe(true);
  });

  it('coerces falsy non-boolean inputs to false', () => {
    setHttpsEnabledAtBoot(true); // start true so we can verify the flip
    setHttpsEnabledAtBoot(0);
    expect(getHttpsEnabledAtBoot().value).toBe(false);

    setHttpsEnabledAtBoot(true);
    setHttpsEnabledAtBoot(null);
    expect(getHttpsEnabledAtBoot().value).toBe(false);
  });

  it('marks initialized as true after any setHttpsEnabledAtBoot call', () => {
    // Note: by the time this test runs, beforeEach has already called the
    // setter at least once, so `initialized` is observably true here.
    setHttpsEnabledAtBoot(false);
    expect(getHttpsEnabledAtBoot().initialized).toBe(true);
  });
});
