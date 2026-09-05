import { useRef, useState } from 'react';
import { rectifyModelDuplicates } from '../../services/apiSystem.js';
import { formatBytes } from '../../utils/formatters.js';
import toast from '../ui/Toast';

export default function DuplicateModelWeights({ duplicates, locked, onRefresh }) {
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [completed, setCompleted] = useState(new Set());
  if (!duplicates) return null;
  if (duplicates.error) return <p role="status" className="text-sm text-port-warning">{duplicates.error}. Refresh to retry.</p>;
  const items = duplicates.items || [];
  if (!items.length) return null;
  const eligible = items.filter((item) => item.canLink && !completed.has(item.targetPath));
  const link = async () => {
    if (busyRef.current || !pending) return;
    busyRef.current = true;
    setBusy(true);
    const pairs = pending.map(({ sourcePath, targetPath }) => ({ sourcePath, targetPath }));
    let reclaimedBytes = 0;
    let failure = null;
    for (let offset = 0; offset < pairs.length; offset += 200) {
      const batch = pairs.slice(offset, offset + 200);
      const outcome = await rectifyModelDuplicates({ pairs: batch, mode: 'hardlink' }, { silent: true })
        .then((value) => ({ value }), (error) => ({ error }));
      if (outcome.error) {
        failure = outcome.error;
        break;
      }
      reclaimedBytes += outcome.value.reclaimedBytes;
      setCompleted((previous) => new Set([...previous, ...batch.map((pair) => pair.targetPath)]));
    }
    setPending(null);
    if (failure) toast.error(failure.message || 'Could not link model weights');
    else toast.success(`Linked model weights · ${formatBytes(reclaimedBytes)} reclaimed`);
    // Refresh even on failure: a batch may have completed earlier replacements.
    await onRefresh();
    busyRef.current = false;
    setBusy(false);
  };
  return (
    <section className="rounded-2xl border border-port-border bg-port-card p-4 space-y-3">
      <h3 className="font-semibold text-white">Duplicate Model Weights</h3>
      <p className="text-sm text-gray-400">
        {items.length} duplicate weight files found in Pinokio · {formatBytes(eligible.reduce((sum, item) => sum + item.reclaimableBytes, 0))} potentially reclaimable
      </p>
      <button type="button" disabled={locked || busy || !eligible.length} onClick={() => setPending(eligible)}
        className="rounded-lg border border-port-border px-3 py-2 text-sm disabled:opacity-50">Link All</button>
      {items.map((item) => (
        <div key={item.targetPath} className="rounded-lg bg-port-bg/40 p-3 space-y-1">
          <p className="text-sm font-medium">{item.model} · {formatBytes(item.sizeBytes)}</p>
          <p className="break-all text-xs text-gray-400">Keep: {item.sourcePath}</p>
          <p className="break-all text-xs text-gray-400">Link: {item.targetPath}</p>
          {item.alreadyLinked || completed.has(item.targetPath) ? <p className="text-xs text-gray-400">Already sharing storage</p> : (
            <button type="button" disabled={locked || busy || !item.canLink} onClick={() => setPending([item])}
              className="rounded-lg border border-port-border px-3 py-2 text-sm disabled:opacity-50">
              Link &amp; Reclaim {formatBytes(item.reclaimableBytes)}
            </button>
          )}
          {!item.alreadyLinked && !item.canLink && <p className="text-xs text-gray-400">Cannot reclaim with a single hardlink: different filesystem, file permissions, or additional file aliases.</p>}
        </div>
      ))}
      {pending && <div role="alert" className="rounded-lg border border-port-border p-3 space-y-2">
        <p className="text-sm">Link {pending.length} weight files? Both paths will share the same physical data. In-place edits affect both applications; use this only for finished, immutable weights. Both paths remain readable. Filesystem snapshots or clones may reduce actual space recovered.</p>
        <button type="button" onClick={link} disabled={busy || locked} className="rounded-lg bg-port-accent px-3 py-2 text-sm disabled:opacity-50">{busy ? 'Linking…' : 'Confirm linking'}</button>
        <button type="button" onClick={() => setPending(null)} disabled={busy} className="px-3 py-2 text-sm">Cancel</button>
      </div>}
    </section>
  );
}
