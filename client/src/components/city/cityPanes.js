// Secondary-HUD disclosure surfaces, driven by the `cityPane` URL search param so
// the open surface is deep-linkable, reload-safe, and restored by browser
// back/forward — the same "URL is the source of truth for what's open" convention
// the rest of the app follows. A single param means only ONE surface can be open at
// a time (mutual exclusivity is structural, not enforced by hand). Clearing the
// param returns to the unobstructed 3D scene.
//
// `attention` / `timeline` / `activity` double as the desktop Intel pane's active
// tab, so the same param addresses the Intel tab on the cockpit and the disclosure
// sheet on phone/compact.
export const CITY_PANE_IDS = [
  'vitals',
  'attention',
  'timeline',
  'activity',
  'map',
  'filter',
  'legend',
];

// The subset that maps to the Intel pane's tabs (shared with the desktop cockpit).
export const CITY_INTEL_PANE_IDS = ['attention', 'timeline', 'activity'];

export const CITY_PANE_LABELS = {
  vitals: 'Vitals',
  attention: 'Attention',
  timeline: 'Timeline',
  activity: 'Activity',
  map: 'Map',
  filter: 'Filter',
  legend: 'Legend',
};
