// Canonical per-kind colors for reader-map emotional beats. The beat kinds
// themselves are defined server-side (READER_MAP_BEAT_KINDS in
// server/lib/storyArc.js); this maps each to a display color so every
// beat-visualization (the Story Builder beat timeline today, any future
// reader-map widget) stays consistent. Values match the Tailwind design tokens
// where one applies. `getBeatKindColor` falls back to neutral gray for an
// unknown kind so a future server-side kind never renders invisibly.
export const BEAT_KIND_COLORS = Object.freeze({
  hook: '#3b82f6',        // port-accent — a question planted
  reveal: '#a855f7',      // purple — new information
  payoff: '#22c55e',      // port-success — a question answered
  emotional: '#f59e0b',   // port-warning — a felt beat
  cliffhanger: '#ef4444', // port-error — an issue-boundary hook
});

export function getBeatKindColor(kind) {
  return BEAT_KIND_COLORS[kind] || '#9ca3af';
}
