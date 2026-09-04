// Constraint-validation fix for the test environment (#6144).
//
// happy-dom decides `stepMismatch` with a raw float modulo of the value against
// the `step` attribute — it ignores the step base and IEEE-754 rounding — so
// `<input type="range" min="0" max="1" step="0.05" value="0.35">` reports
// invalid, because `0.35 % 0.05` is 0.049999999999999975 rather than 0. A single
// invalid control makes the whole form's `checkValidity()` false, and happy-dom's
// implicit submission then drops the submit event *silently*: clicking a
// `type="submit"` button runs no handler and raises nothing, so the test just
// sees zero calls (this is what hid MediaJobsQueue's video retry form).
//
// No browser behaves that way. Per HTML, a range input is snapped by its value
// sanitization algorithm and can never suffer a step mismatch, and every other
// numeric input measures the step from the step base (`min`), not from zero.
// Restoring both keeps a form in a test submitting exactly where it would in a
// browser, and leaves a genuinely out-of-step value still reported as such.

// Floating-point steps (0.05, 0.1) never divide cleanly, so compare the multiple
// against the nearest integer rather than demanding an exact zero remainder.
const STEP_EPSILON = 1e-9;

export const installFormValidityFix = () => {
  const probe = globalThis.document?.createElement?.('input');
  const prototype = probe?.validity ? Object.getPrototypeOf(probe.validity) : null;
  const original = prototype && Object.getOwnPropertyDescriptor(prototype, 'stepMismatch');
  if (!original?.get) return;

  Object.defineProperty(prototype, 'stepMismatch', {
    ...original,
    get() {
      const element = this.element;
      // `element` is happy-dom's own back-reference; without it (any other
      // environment) leave the host implementation alone.
      if (!element) return original.get.call(this);
      if (element.type === 'range') return false;
      if (element.value === '') return false;
      const step = Number(element.getAttribute?.('step'));
      const value = Number(element.value);
      if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(value)) {
        return original.get.call(this);
      }
      const base = Number(element.getAttribute?.('min'));
      const multiple = (value - (Number.isFinite(base) ? base : 0)) / step;
      return Math.abs(multiple - Math.round(multiple)) > STEP_EPSILON;
    },
  });
};
