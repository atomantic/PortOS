import { AlertTriangle } from 'lucide-react';
import Banner from './Banner';

// Server-side getStatus() reports stateError when the sync-state file is unreadable; the
// sync is then refused (never rewound), so the cursor reads as null and the view would
// otherwise look like a sync that never ran.
export default function UnreadableSyncStateNotice({ status }) {
  if (status?.stateError !== 'UNREADABLE_STORE') return null;
  return (
    <Banner tone="warning" size="md" icon={AlertTriangle}>
      Sync is stopped: its saved position could not be read. Restore or remove the sync-state file, then sync again. Removing it re-reads history from the start.
    </Banner>
  );
}
