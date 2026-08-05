import { waitFor } from '@testing-library/react';
import { expect } from 'vitest';

// `user.type` dispatches one event per keystroke and `user.clear` empties the
// field in its own event. Anything that reads state derived from the input right
// after them — a submit click whose payload is asserted, a dirty-state check —
// can observe a partial value (`2` instead of `20`, or the post-clear empty
// string, which `Number('')` turns into 0). A `waitFor` on the payload cannot
// rescue that: the call already happened with the wrong argument, and re-waiting
// never produces a second one.
//
// Pinning the settled input value in between turns a load-dependent flake into
// either a pass or an honest, immediately-legible failure.

// The timeout `waitFor` uses here comes from the suite-wide
// `configure({ asyncUtilTimeout: 3000 })` in setup.js — testing-library's 1000ms
// default is too tight for these under parallel-worker CPU contention.
const settled = (input, value) => waitFor(() => expect(input).toHaveValue(value));

// A `type="number"` input reads its value back coerced, and empty as `null`.
const readBack = (input, text) => (input.type === 'number' ? Number(text) : text);
const emptyValue = (input) => (input.type === 'number' ? null : '');

// Type into an empty field, then pin the result before whatever depends on it.
// Pass `value` explicitly when `text` carries key descriptors (`'a{Enter}'`) and
// so does not equal what the field ends up holding.
export async function typeSettled(user, input, text, value = readBack(input, text)) {
  await user.type(input, text);
  await settled(input, value);
}

// Empty a prefilled field and pin it — the post-clear empty string is its own
// wrong-payload window, separate from the keystrokes that follow.
export async function clearSettled(user, input) {
  await user.clear(input);
  await settled(input, emptyValue(input));
}

// Replace a prefilled field's contents, pinning both halves.
export async function retypeSettled(user, input, text, value) {
  await clearSettled(user, input);
  await typeSettled(user, input, text, value);
}
