import { useState } from 'react';
import CatalogLockButton from './CatalogLockButton';

/** Resolve the persisted lock without saving an editor's surrounding draft. */
export default function CatalogUnlockNotice({ record, disabled = false, onUnlocked, onPendingChange }) {
  const [unlocked, setUnlocked] = useState(false);
  const locked = record.payload?.locked === true;
  if (!locked && !unlocked) return null;
  return <div className="rounded-lg border border-port-border bg-port-card p-3 space-y-2">
    <p role="status" className="text-sm text-port-warning">
      {locked ? `${record.name} is locked. Unlock it to render a reference sheet or look. Unlocking also allows AI edits to this record.`
        : 'Unlocked. Choose Generate when you are ready; unsaved profile edits still need saving.'}
    </p>
    {locked && <CatalogLockButton record={record} disabled={disabled} label="Unlock for rendering" onPendingChange={onPendingChange}
      onChanged={updated => { onUnlocked(updated); setUnlocked(true); }} />}
  </div>;
}
