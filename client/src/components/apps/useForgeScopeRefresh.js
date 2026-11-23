/**
 * Hook for a managed app's forge-token scope refresh: `start(scopes)` runs `gh auth refresh` for the
 * app's forge host via an SSE job slot.
 *
 * One forge-token scope-refresh slot for a managed app (`useSseJobSlot` over `POST
 * /api/apps/:id/forge-auth/refresh`): `start(scopes)` runs `gh auth refresh` for the app's own forge
 * host (server-derived, enterprise hosts included), `device` is the `{ code, url }` the user approves
 * in a browser (null until gh prints it), `onRefreshed()` fires on confirmation. Returns `{ active,
 * pending, device, start, cancel }`. Use when: Any surface that hits a `FORGE_TOKEN_SCOPE_MISSING`
 * error — pair with `<ForgeScopeFix>`.
 */

import { startAppForgeRefresh, appForgeRefreshEventsUrl, cancelAppForgeRefresh } from '../../services/apiApps.js';
import useSseJobSlot from '../../hooks/useSseJobSlot.js';

/**
 * One forge-scope refresh slot for a managed app: `start(scopes)` asks the server
 * to run `gh auth refresh` for the app's forge host, `device` is the one-time
 * code + URL the user must approve in a browser (null until `gh` prints it), and
 * `onRefreshed()` fires once GitHub confirms. Thin wrapper over `useSseJobSlot`,
 * so a dropped stream or a server-side failure always releases the slot — the UI
 * is never stuck "refreshing".
 */
export default function useForgeScopeRefresh({ appId, onRefreshed } = {}) {
  const { active, pending, latest, start, cancel } = useSseJobSlot({
    startRequest: (scopes) => startAppForgeRefresh(appId, scopes, { silent: true }),
    eventsUrl: (jobId) => appForgeRefreshEventsUrl(appId, jobId),
    cancelRequest: (jobId, options) => cancelAppForgeRefresh(appId, jobId, options),
    onComplete: () => onRefreshed?.(),
    successToast: (frame) => `Token for ${frame.host} now has ${frame.scopes.join(', ')}`,
    errorFallback: 'Token refresh failed',
    canceledMessage: 'Token refresh cancelled',
    lostConnectionMessage: 'Lost connection to the token refresh — start it again',
    startErrorFallback: 'Failed to start the token refresh',
  });
  const device = latest?.type === 'device-code' ? { code: latest.code, url: latest.url } : null;
  return { active, pending, device, start, cancel };
}
