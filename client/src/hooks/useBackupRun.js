import { useAsyncAction } from './useAsyncAction';
import { triggerBackup } from '../services/api';
import toast from '../components/ui/Toast';
import { pluralize } from '../lib/textUtils';

// Both manual entry points report the completed run returned by the server.
// Completion callbacks update caller-owned state only when the run wasn't skipped.
export function useBackupRun(onComplete) {
  return useAsyncAction(async () => {
    const result = await triggerBackup({ silent: true });
    if (result?.skipped) {
      toast('Backup already running');
    } else {
      const filesChanged = result?.filesChanged ?? 0;
      if (result?.pgBackup?.status === 'failed') {
        // The socket error toast already announces the dump failure; acknowledge
        // the file portion without an extra error toast or unqualified success.
        toast(`Backup complete — ${pluralize(filesChanged, 'file')} changed; database dump failed`, { icon: '⚠️' });
      } else {
        toast.success(`Backup complete — ${pluralize(filesChanged, 'file')} changed`, { icon: '💾' });
      }
      await onComplete?.(result);
    }
    return result;
  }, { errorMessage: 'Backup failed' });
}
