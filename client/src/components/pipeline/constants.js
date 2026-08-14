/**
 * Shared display constants for the Pipeline component subtree. Pure data —
 * co-located with the pipeline components that render it.
 */

// Severity → Tailwind classes for a finding/issue card (text + border + fill).
// One palette for every pipeline surface that lists severity-tagged findings:
// the series review panel, the autopilot panel, and the arc-canvas verification
// and manuscript-completeness panels. It used to be three byte-identical inline
// copies (#4109); keep it here so a tweak can't land on one panel only.
//
// The class names are complete literal strings on purpose — Tailwind's build
// scans source text, so a name assembled by interpolation is silently absent
// from the bundle.
export const SEVERITY_COLORS = {
  high: 'text-port-error border-port-error/40 bg-port-error/10',
  medium: 'text-port-warning border-port-warning/40 bg-port-warning/10',
  low: 'text-gray-400 border-gray-500/30 bg-gray-700/20',
};

// Resolve a finding's severity to its card classes, defaulting to `medium` for
// an absent or unrecognized value. Use this rather than a bare
// `SEVERITY_COLORS[severity] || SEVERITY_COLORS.medium`: findings arrive from
// LLM output and older peers, so a severity of `constructor` / `__proto__` /
// `toString` would otherwise resolve to an inherited Object.prototype member —
// truthy, so the `||` fallback wouldn't catch it, and it lands in a className.
export const severityColor = (severity) =>
  (Object.hasOwn(SEVERITY_COLORS, severity) && typeof SEVERITY_COLORS[severity] === 'string'
    ? SEVERITY_COLORS[severity]
    : SEVERITY_COLORS.medium);
