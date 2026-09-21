/**
 * Observation context for React's "not wrapped in act(...)" warnings (#7785).
 *
 * The warning fires when the setState lands, which for a leaked mount-effect
 * promise is *after* its own test has ended. `afterEach` therefore throws it
 * while some later, innocent test is the one vitest names — so a message that
 * reports only the component sends the next reader bisecting the wrong file.
 *
 * Record the test running when the warning fires. This identifies when the
 * update was observed, not which test started the asynchronous work.
 * Pure and separate from `setup.js` so it is testable without re-running that
 * file's global installs (console patch, storage and form-validity polyfills).
 */

/** One warning: the component React named and the test active when observed. */
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
  const observations = [...new Set(warnings.map(({ component, test }) => (
    test ? `${component} (warning observed during: ${test})` : component
  )))].join(', ');

  return `React state updated outside act(...) in: ${observations}. `
    + `Detected while finishing "${detectedIn}". The asynchronous work may have started in an earlier test. `
    + 'Settle pending mount/interaction promises inside the test — e.g. '
    + '`await act(async () => {})` after render — see src/test/setup.js for the idiom.';
}
