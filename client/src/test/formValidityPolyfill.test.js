import { describe, it, expect } from 'vitest';

// setup.js has already run installFormValidityFix() against this environment, so
// these assert the resulting DOM behaviour rather than the installer. The
// regression they catch is silent: an input the environment wrongly calls
// step-mismatched makes its form's checkValidity() false, and implicit submission
// then drops the submit event with no error at all (#6144).
const input = (attrs) => {
  const el = document.createElement('input');
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
};

describe('form validity — step mismatch', () => {
  it('never step-mismatches a range, whose value the UA snaps for it', () => {
    // 0.35 % 0.05 is 0.049999999999999975 in IEEE-754, which a naive check reads
    // as out of step. This is the exact slider that blocked a retry form's submit.
    expect(input({ type: 'range', min: 0, max: 1, step: 0.05, value: '0.35' }).validity.stepMismatch)
      .toBe(false);
  });

  it('measures a number input from its step base, not from zero', () => {
    expect(input({ type: 'number', min: 1, step: 2, value: '7' }).validity.stepMismatch).toBe(false);
    expect(input({ type: 'number', step: 0.1, value: '0.3' }).validity.stepMismatch).toBe(false);
  });

  it('still reports a genuinely out-of-step value', () => {
    expect(input({ type: 'number', min: 1, step: 2, value: '8' }).validity.stepMismatch).toBe(true);
  });

  it('lets a form with a fractional-step slider submit', () => {
    const form = document.createElement('form');
    form.appendChild(input({ type: 'range', min: 0, max: 1, step: 0.05, value: '0.35' }));
    document.body.appendChild(form);
    expect(form.checkValidity()).toBe(true);
    form.remove();
  });
});
