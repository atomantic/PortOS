import { useCallback } from 'react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';

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
  const handleUpdateOverride = useCallback(async (appId, taskType, { enabled, interval, taskMetadata }) => {
    const result = await api.updateAppTaskTypeOverride(appId, taskType, { enabled, interval, taskMetadata }, { silent: true }).catch(err => {
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
    const result = await api.bulkUpdateAppTaskTypeOverride(taskType, { enabled }, { silent: true }).catch(err => {
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
