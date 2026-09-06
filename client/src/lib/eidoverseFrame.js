// Versioned, data-only bridge to the sole hosted renderer. Never accept a URL
// or a private record from the frame; navigation names an already-projected
// entity and exactly one known section route.
export const EIDOVERSE_FRAME_VERSION = 1;
export const EIDOVERSE_LABEL_PREFERENCES = ['nearby', 'all-nearby', 'off'];
export const EIDOVERSE_SOURCE_ROUTES = Object.freeze({
  apps: '/apps', agents: '/cos/agents', tasks: '/cos/tasks', features: '/settings/features',
  peers: '/instances', health: '/cos/health', productivity: '/cos/productivity',
  activity: '/cos/productivity', goals: '/goals/list', memory: '/brain/memory',
  storage: '/settings/database', jira: '/goals/list', operations: '/cos/health',
});
const ROUTES = new Set([...Object.values(EIDOVERSE_SOURCE_ROUTES), '/eidoverse']);

export function isEidoverseFrameMessage(event, { source, origin, nonce }) {
  const data = event.data;
  return Boolean(source && event.source === source && event.origin === origin
    && data && typeof data === 'object' && !Array.isArray(data)
    && data.version === EIDOVERSE_FRAME_VERSION && data.nonce === nonce);
}

export function eidoverseNavigationTarget(data, objects) {
  if (typeof data.entityId !== 'string' || !ROUTES.has(data.route)) return null;
  return objects.some((object) => object.id === data.entityId && object.route === data.route)
    ? data.route : null;
}
