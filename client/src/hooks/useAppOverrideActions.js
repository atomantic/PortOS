/**
 * Per-app scheduled-task override mutations (`{ handleUpdateOverride, handleBulkToggleOverride }`)
 * with shared toast copy + silent flag.
 *
 * Pass the tab's `refetch`. Use when: Any surface hosting `PerAppOverrideList` (Schedule tab,
 * Timeline tab) — don't re-copy the write-plus-toast-plus-refetch handlers.
 */

import { useCallback } from 'react';
import toast from '../components/ui/Toast';
import { updateAppTaskTypeOverride, bulkUpdateAppTaskTypeOverride } from '../services/apiApps.js';

/**
 * Per-app scheduled-task override mutations, shared by the Schedule tab and the
 * Timeline tab so the toast copy, silent-request flag, app-name resolution, and
 * success gating stay in one place. Pass the tab's own `refetch` (e.g.
 * `fetchSchedule` or `fetchGraph`) — it runs after a successful write so the
 * enabled-app counts and inherited defaults stay in sync.
 *
 * Returns `{ handleUpdateOverride, handleBulkToggleOverride }`, wired directly
 * to `PerAppOverrideList`'s `onUpdateOverride` / `onBulkToggleOverride` props.
 */
export function useAppOverrideActions(apps, refetch) {
  // The patch is forwarded whole rather than re-listed field by field: the hook
  // is a toast + refetch wrapper, not a field filter, and re-listing silently
  // dropped every field it hadn't been taught about (intervalMs, providerId,
  // model) — the route then 400s on the resulting empty body.
  const handleUpdateOverride = useCallback(async (appId, taskType, patch) => {
    const result = await updateAppTaskTypeOverride(appId, taskType, patch, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      const appName = apps?.find(a => a.id === appId)?.name || appId;
      toast.success(`Updated ${taskType} override for ${appName}`);
      refetch();
    }
  }, [apps, refetch]);

  const handleBulkToggleOverride = useCallback(async (taskType, enabled) => {
    const result = await bulkUpdateAppTaskTypeOverride(taskType, { enabled }, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success(`${enabled ? 'Enabled' : 'Disabled'} ${taskType} for all apps`);
      refetch();
    }
  }, [refetch]);

  return { handleUpdateOverride, handleBulkToggleOverride };
}
