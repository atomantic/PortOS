import { screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

// `findBy*`/`getBy*` match a DISABLED control too — they only assert it is on
// screen, never that it is safe to interact with. A page that renders a
// control the instant it mounts and enables it only once some async gate
// resolves (a fetch, a capability scan, a `draftReady` flag) leaves a naive
// `fireEvent.click(await screen.findByRole(...))` free to land on the
// still-disabled control under CPU contention: the click silently no-ops, and
// whatever the test asserts next burns its own async budget waiting on
// something that will never happen (#7448, #7592, #6266).
//
// Wait for ENABLED, not just present, before interacting. Kept one-sided —
// this only ever asserts the eventual enabled state, never that the control
// started out disabled — on purpose: a two-sided form is racy, because the
// gate can legitimately have cleared before the first poll. That is exactly
// how the analogous `waitForElementToBeRemoved` barrier failed during #7592
// (see `pageLoadBarrier.js`, which stayed two-sided for a different reason).

// Pass a getter (`() => screen.getByRole(...)`) when the control may not
// exist yet or may be replaced across renders — `waitFor` re-invokes it on
// every poll. Pass a plain element when it is already known to be mounted.
export const awaitEnabled = (elementOrGetter) => waitFor(() => {
  const el = typeof elementOrGetter === 'function' ? elementOrGetter() : elementOrGetter;
  expect(el).toBeEnabled();
  return el;
});

export const findEnabledByLabelText = (label) => awaitEnabled(() => screen.getByLabelText(label));

export const findEnabledByRole = (role, options) => awaitEnabled(() => screen.getByRole(role, options));
