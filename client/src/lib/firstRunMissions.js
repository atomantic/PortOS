// First-run missions (issue #5640).
//
// Pure data + visibility helpers for the dashboard first-run card. One mission
// per top-level PortOS slice that has a natural entry point. A mission writes
// ONLY the matching Settings → Features toggles (via the existing features
// PUT) and nothing else — no AI provider, no credential, no LLM call.
//
// Auto-detected integrations (datadog, jira, eidoverse, facetime) are omitted
// on purpose: enabling them without the integration they front is noise, and
// eidoverse's PUT 409s until Worlds is installed. POST is its own section.

export const FIRST_RUN_QUERY_PARAM = 'firstRun';
export const FIRST_RUN_HIDE_SETTING = 'hideFirstRunCard';
export const FIRST_RUN_SESSION_KEY = 'portos-first-run-dismissed';
export const FIRST_RUN_PATH = '/';

export const FIRST_RUN_MISSIONS = Object.freeze([
  Object.freeze({
    id: 'creative-studio',
    label: 'Creative studio',
    description: 'Start a story, universe, or production pipeline.',
    to: '/start-story',
    icon: 'Clapperboard',
    features: Object.freeze([]),
  }),
  Object.freeze({
    id: 'personal-knowledge',
    label: 'Personal knowledge',
    description: 'Capture thoughts into your inbox and notes.',
    to: '/brain/inbox',
    icon: 'Brain',
    features: Object.freeze(['health']),
  }),
  Object.freeze({
    id: 'run-my-machines',
    label: 'Run my machines',
    description: 'Launch and manage the apps on this install.',
    to: '/apps',
    icon: 'Monitor',
    features: Object.freeze(['gsd']),
  }),
  Object.freeze({
    id: 'delegate-work',
    label: 'Delegate work',
    description: 'Hand a task to the Chief of Staff agent queue.',
    to: '/cos/tasks',
    icon: 'ListChecks',
    features: Object.freeze(['openclaw']),
  }),
]);

const QUERY_ON = new Set(['1', 'true', 'on', 'yes']);
const QUERY_OFF = new Set(['0', 'false', 'off', 'no']);

// `?firstRun=1` / `on` / `true` forces the card on; `0` / `off` / `false`
// forces it off. Anything else (including a missing param) is no override —
// the URL is demonstration-only and is never persisted.
export function parseFirstRunQueryParam(raw) {
  if (raw == null || raw === '') return null;
  const value = String(raw).trim().toLowerCase();
  if (QUERY_ON.has(value)) return true;
  if (QUERY_OFF.has(value)) return false;
  return null;
}

export function featuresToEnable(mission, instanceFeatures) {
  const list = Array.isArray(instanceFeatures) ? instanceFeatures : [];
  return (mission?.features || []).filter((id) => {
    const feature = list.find((item) => item?.id === id);
    return !feature || feature.enabled !== true;
  });
}

export function shouldShowFirstRunCard({
  pathname,
  queryForce = null,
  settingsLoaded = false,
  hideSetting = false,
  sessionDismissed = false,
} = {}) {
  if (pathname !== FIRST_RUN_PATH) return false;
  if (queryForce === true) return true;
  if (queryForce === false) return false;
  if (!settingsLoaded) return false;
  if (hideSetting) return false;
  if (sessionDismissed) return false;
  return true;
}
