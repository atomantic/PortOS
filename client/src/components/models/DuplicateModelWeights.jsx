import { useRef, useState } from 'react';
import { rectifyModelDuplicates } from '../../services/apiSystem.js';
import { formatBytes } from '../../utils/formatters.js';
import toast from '../ui/Toast';

async function applyCloneBatches(pairs) {
  let reclaimedBytes = 0;
  let physicalReclaimedBytes = 0;
  let sawPhysical = false;
  for (let offset = 0; offset < pairs.length; offset += 200) {
    const batch = pairs.slice(offset, offset + 200);
    const outcome = await rectifyModelDuplicates({ pairs: batch, mode: 'clone' }, { silent: true })
      .then((value) => ({ value }), (error) => ({ error }));
    if (outcome.error) {
      return { reclaimedBytes, physicalReclaimedBytes: sawPhysical ? physicalReclaimedBytes : null, failure: outcome.error };
    }
    reclaimedBytes += outcome.value.reclaimedBytes || 0;
    if (typeof outcome.value.physicalReclaimedBytes === 'number') {
      physicalReclaimedBytes += outcome.value.physicalReclaimedBytes;
      sawPhysical = true;
    }
  }
  return { reclaimedBytes, physicalReclaimedBytes: sawPhysical ? physicalReclaimedBytes : null, failure: null };
}

function HubBlobClones({ hub, locked, onRefresh }) {
  const [pending, setPending] = useState(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const groups = hub?.groups || [];
  if (hub?.error) return <p role="status" className="text-sm text-port-warning">{hub.error}. Refresh to retry.</p>;
  if (!groups.length) return null;
  const eligible = groups.filter((group) => group.canClone && group.replacements?.length);
  const repos = [...new Set(eligible.flatMap((group) => group.repos))].sort();
  const reclaimableBytes = eligible.reduce((sum, group) => sum + group.reclaimableBytes, 0);
  const logicalBytes = groups.reduce((sum, group) => sum + (group.logicalDuplicateBytes || 0), 0);
  const open = () => {
    setArmed(false);
    setPending(eligible);
  };
  const clone = async () => {
    if (busyRef.current || !pending || !armed) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const pairs = pending.flatMap((group) => group.replacements.map((replacement) => ({
        sourcePath: group.sourcePath,
        targetPath: replacement.path,
      })));
      const outcome = await applyCloneBatches(pairs);
      setPending(null);
      setArmed(false);
      if (outcome.failure) toast.error(outcome.failure.message || 'Could not clone hub blobs');
      else if (typeof outcome.physicalReclaimedBytes === 'number') {
        toast.success(`Cloned hub blobs · ${formatBytes(outcome.physicalReclaimedBytes)} physical free space recovered`);
      } else toast.success(`Cloned hub blobs · ${formatBytes(outcome.reclaimedBytes)} logical`);
      await onRefresh();
    } catch (error) {
      toast.error(error?.message || 'Could not clone hub blobs or refresh the report');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="rounded-2xl border border-port-border bg-port-card p-4 space-y-3">
      <h3 className="font-semibold text-white">Shared Hugging Face blobs</h3>
      <p className="text-sm text-gray-400">
        {groups.length} shared blob {groups.length === 1 ? 'group' : 'groups'}
        {' · '}
        {formatBytes(reclaimableBytes)} reclaimable with copy-on-write clones
        {logicalBytes > reclaimableBytes ? ` · ${formatBytes(logicalBytes)} apparent duplicate bytes` : ''}
      </p>
      <p className="text-sm text-gray-400">{hub.apparentSizeNote}</p>
      {!hub.cloneSupported && (
        <p className="text-sm text-gray-400">
          Copy-on-write clones are unavailable on this disk, so these duplicates were left in place. Hardlinks are not used, because deleting one repo must not free or change another.
        </p>
      )}
      {eligible.length > 0 && (
        <button type="button" disabled={locked || busy} onClick={open}
          className="rounded-lg border border-port-border px-3 py-2 text-sm disabled:opacity-50">
          Clone duplicates
        </button>
      )}
      {groups.map((group) => (
        <div key={group.blobName} className="rounded-lg bg-port-bg/40 p-3 space-y-1">
          <p className="text-sm font-medium">{group.repos.join(', ')}</p>
          <p className="break-all text-xs text-gray-400">
            Blob {group.blobName} · {formatBytes(group.sizeBytes)} · {formatBytes(group.reclaimableBytes)} reclaimable
          </p>
        </div>
      ))}
      {pending && (
        <div role="alert" className="rounded-lg border border-port-border p-3 space-y-2">
          <label htmlFor="hub-clone-confirm" className="flex items-start gap-2 text-sm">
            <input id="hub-clone-confirm" type="checkbox" className="mt-1" checked={armed} onChange={(event) => setArmed(event.target.checked)} />
            <span>Replace duplicate blobs in {repos.join(', ')} and reclaim {formatBytes(reclaimableBytes)}. Both copies stay readable. A later write to one repo does not change the other.</span>
          </label>
          <button type="button" onClick={clone} disabled={busy || locked || !armed}
            className="rounded-lg bg-port-accent px-3 py-2 text-sm disabled:opacity-50">
            {busy ? 'Cloning…' : 'Clone and reclaim'}
          </button>
          <button type="button" onClick={() => setPending(null)} disabled={busy} className="px-3 py-2 text-sm">Cancel</button>
        </div>
      )}
    </section>
  );
}

export default function DuplicateModelWeights({ duplicates, locked, onRefresh }) {
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [completed, setCompleted] = useState(new Set());
  if (!duplicates) return null;
  if (duplicates.error) return <p role="status" className="text-sm text-port-warning">{duplicates.error}. Refresh to retry.</p>;
  const items = duplicates.items || [];
  const eligible = items.filter((item) => item.canLink && !completed.has(item.targetPath));
  const link = async () => {
    if (busyRef.current || !pending) return;
    busyRef.current = true;
    setBusy(true);
    try {
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
    } catch (error) {
      toast.error(error?.message || 'Could not link model weights or refresh the report');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      {items.length > 0 && (
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
      )}
      <HubBlobClones hub={duplicates.hub} locked={locked || busy} onRefresh={onRefresh} />
    </>
  );
}
