/**
 * Attribution for React's "not wrapped in act(...)" warnings (#7785).
 *
 * The warning fires when the setState lands, which for a leaked mount-effect
 * promise is *after* its own test has ended. `afterEach` therefore throws it
 * while some later, innocent test is the one vitest names — so a message that
 * reports only the component sends the next reader bisecting the wrong file.
 *
 * Recording the test that was running at push time is what makes the class
 * self-diagnosing: the error can then say "leaked from A, detected during B".
 * Pure and separate from `setup.js` so it is testable without re-running that
 * file's global installs (console patch, storage and form-validity polyfills).
 */

/** One captured warning: the component React named, and the test it escaped. */
export const actWarningEntry = (component, test) => ({
  component: String(component ?? 'unknown component'),
  test: test ?? null,
});

/**
 * The error message for a batch of warnings caught in one `afterEach`.
 *
 * @param {Array<{component: string, test: string|null}>} warnings
 * @param {string|null} caughtBy - the test whose afterEach is throwing
 * @returns {string}
 */
export function formatActWarningError(warnings, caughtBy) {
  const detectedIn = caughtBy ?? 'an unnamed test';
  const origins = [...new Set(warnings.map(({ component, test }) => (
    test && test !== detectedIn ? `${component} (leaked from: ${test})` : component
  )))].join(', ');
  // Only claim misattribution when a warning really did escape another test —
  // saying it on a same-test leak would send the reader looking elsewhere for a
  // bug that is right where they are.
  const misattributed = warnings.some(({ test }) => test && test !== detectedIn);

  return `React state updated outside act(...) in: ${origins}. `
    + (misattributed
      ? `Detected while running "${detectedIn}", but the update escaped the test named above — fix it there, not here. `
      : '')
    + 'Settle pending mount/interaction promises inside the test — e.g. '
    + '`await act(async () => {})` after render — see src/test/setup.js for the idiom.';
}
