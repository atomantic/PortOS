// Goal → PortOS feature-area map (issue #2666).
//
// Deterministic, LLM-free registry that turns a goal's `category` (or its
// optional per-goal `featureAreas` override) into the concrete PortOS feature
// that actually moves it forward, each carrying a label, an icon name, and a
// deep-link. Every `to` path MUST be an existing route registered in
// `server/lib/navManifest.js` (`NAV_COMMANDS`) so deep-links can't drift — this
// is enforced by `server/lib/goalFeatureMap.test.js`.
//
// MIRROR: this file is kept byte-for-byte in sync with
// `server/lib/goalFeatureMap.js` (the server uses it to validate the per-goal
// `featureAreas` override and to build the same rows server-side if needed).
// `icon` is a lucide-react icon NAME (string) so this module stays React-free
// and importable from server-side tests; the widget resolves the name to a
// component at render time.

// Feature areas, keyed by a stable area id. Each `to` is a live NAV_COMMANDS path.
export const FEATURE_AREAS = {
  post:          { label: 'Daily POST',      to: '/post/launcher',              icon: 'Brain' },
  bodyHealth:    { label: 'Body Health',     to: '/meatspace/health',           icon: 'HeartPulse' },
  writersRoom:   { label: 'Writers Room',    to: '/writers-room',               icon: 'PenLine' },
  universes:     { label: 'Universes',       to: '/universes',                  icon: 'Globe' },
  pipeline:      { label: 'Series Pipeline', to: '/pipeline',                   icon: 'Clapperboard' },
  tribe:         { label: 'Tribe',           to: '/tribe',                      icon: 'Users' },
  autobiography: { label: 'Autobiography',   to: '/digital-twin/autobiography', icon: 'BookOpen' },
  legacyBundle:  { label: 'Legacy Bundle',   to: '/digital-twin/legacy',        icon: 'Package' },
  sharing:       { label: 'Sharing',         to: '/sharing',                    icon: 'Share2' },
  planMilestones:{ label: 'Plan Milestones', to: '/goals/tree',                 icon: 'ListTree' },
  memory:        { label: 'Memory',          to: '/brain/memory',               icon: 'BrainCircuit' },
};

// Every valid area id — the source of truth for the per-goal override enum.
export const FEATURE_AREA_IDS = Object.keys(FEATURE_AREAS);

// Curated category → ordered feature-area ids. A goal with no override falls
// back to its category's default; an unknown category resolves to an empty list.
export const GOAL_CATEGORY_FEATURE_MAP = {
  creative:  ['writersRoom', 'universes', 'pipeline'],
  family:    ['tribe'],
  health:    ['post', 'bodyHealth'],
  financial: ['planMilestones'],
  legacy:    ['autobiography', 'legacyBundle', 'sharing'],
  mastery:   ['post', 'memory'],
};

// Resolve the feature-area rows for a goal. Honors the optional per-goal
// `featureAreas` override (an ordered array of area ids) when present and
// non-empty — filtering out any unknown ids — otherwise falls back to the
// category default. Returns an array of { area, label, to, icon }.
export function getGoalFeatureAreas(goal) {
  const override = Array.isArray(goal?.featureAreas)
    ? goal.featureAreas.filter((id) => FEATURE_AREAS[id])
    : [];
  const areaIds = override.length > 0
    ? override
    : (GOAL_CATEGORY_FEATURE_MAP[goal?.category] || []);
  return areaIds.map((area) => ({ area, ...FEATURE_AREAS[area] }));
}
