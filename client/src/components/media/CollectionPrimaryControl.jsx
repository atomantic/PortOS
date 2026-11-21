import { useEffect, useId, useRef, useState } from 'react';
import { getMediaCollectionPrimary, setMediaCollectionPrimary } from '../../services/apiImageVideo.js';
import socket from '../../services/socket';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { formatCount } from '../../utils/formatters';

// One-time scopes that are not collections (server: services/mediaCollectionPrimary.js).
export const SHARED_MEDIA_ID = 'shared-media';
const ONE_SHOT_COPY = {
  unsorted: {
    name: 'Unsorted',
    label: 'Primary machine',
    description: 'A one-time operation for the Unsorted gallery on this machine, including items outside the current page or filters. Future items are not affected.',
  },
  [SHARED_MEDIA_ID]: {
    name: 'shared media',
    label: 'Host shared media on',
    description: 'A one-time operation for every image and video more than one machine holds, filed or not. Media only one machine holds is not moved, and future items are not affected. Every machine keeps the history and metadata and streams the file from the primary.',
  },
};

export default function CollectionPrimaryControl({ collectionId, oneShot = false }) {
  const copy = oneShot ? ONE_SHOT_COPY[collectionId] ?? ONE_SHOT_COPY.unsorted : null;
  const id = useId();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(false);
  const [selection, setSelection] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const reloadRef = useRef(null);

  useEffect(() => {
    let active = true;
    let generation = 0;
    const reload = () => {
      const request = ++generation;
      return getMediaCollectionPrimary(collectionId, { silent: true }).then((result) => {
        if (active && request === generation) {
          setStatus(result);
          setError(false);
        }
      }).catch(() => {
        if (active && request === generation) setError(true);
      });
    };
    const onChange = (event) => { if (event.id === collectionId) reload(); };
    reloadRef.current = reload;
    reload();
    socket.on('media:collection-primary:changed', onChange);
    socket.on('connect', reload);
    return () => {
      active = false;
      reloadRef.current = null;
      socket.off('media:collection-primary:changed', onChange);
      socket.off('connect', reload);
    };
  }, [collectionId]);

  const chosen = selection ?? status?.instanceId ?? '';
  const [save, saving] = useAsyncAction(async () => {
    await setMediaCollectionPrimary(collectionId, chosen, { silent: true });
    setSelection(null);
    setConfirming(false);
    await reloadRef.current?.();
  }, { errorMessage: copy ? `Could not consolidate ${copy.name}` : 'Could not set the primary machine' });
  const busy = saving || status?.run?.running;
  const destination = status?.machines.find((machine) => machine.instanceId === chosen);
  const run = status?.run;

  return (
    <section className="rounded-lg border border-port-border bg-port-card p-3 space-y-2" aria-label="Collection storage">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm font-medium">{copy?.label ?? 'Primary machine'}</label>
        <select
          id={id}
          value={chosen}
          onChange={(event) => { setSelection(event.target.value); setConfirming(false); }}
          disabled={!status || busy}
          className="min-w-0 max-w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
        >
          <option value="" disabled>{status ? 'Choose a machine' : 'Loading machines…'}</option>
          {chosen && !destination && <option value={chosen} disabled>Assigned machine unavailable</option>}
          {status?.machines.map((machine) => <option key={machine.instanceId} value={machine.instanceId}>{machine.name}</option>)}
        </select>
        <button
          type="button"
          onClick={copy ? () => setConfirming(true) : save}
          disabled={!destination || busy || error}
          className="rounded border border-port-accent/40 px-2.5 py-1.5 text-sm text-port-accent hover:bg-port-accent/20 disabled:opacity-40"
        >
          {busy ? 'Consolidating…' : copy ? `Consolidate ${copy.name}` : chosen && chosen === status?.instanceId ? 'Consolidate again' : 'Set primary and consolidate'}
        </button>
      </div>
      <p className="text-xs text-gray-400">
        {copy
          ? copy.description
          : 'Copy any missing collection media to the selected machine, then move matching copies on other hosts to Trash. Collection items stay available from the primary.'}
      </p>
      {copy && confirming && destination && (
        <div className="space-y-2 rounded border border-port-border p-2">
          <p className="text-xs text-gray-300">
            Consolidate {copy.name} on {destination.name}? Missing files will be copied there. Matching copies elsewhere move to Trash only after the file is verified on the selected machine.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || error} onClick={save}
              className="rounded border border-port-accent/40 px-2.5 py-1.5 text-xs text-port-accent hover:bg-port-accent/20 disabled:opacity-40">
              Confirm consolidation
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}
              className="rounded border border-port-border px-2.5 py-1.5 text-xs hover:bg-port-border disabled:opacity-40">
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-port-warning" role="status">
        Could not load primary machine status.{' '}
        <button type="button" className="rounded border border-port-border px-2 py-1 hover:bg-port-border" onClick={() => reloadRef.current?.()}>Retry</button>
      </p>}
      {run && <p className="text-xs text-gray-300" role="status">
        {run.running
          ? `Consolidating ${formatCount(run.total)} media files…`
          : `${formatCount(run.completed)} of ${formatCount(run.total)} files verified on the primary · ${formatCount(run.released)} copies released`}
        {!run.running && run.pending > 0 && ` · ${formatCount(run.pending)} releases queued at finish`}
        {!run.running && run.kept > 0 && ` · ${formatCount(run.kept)} copies kept`}
        {!run.running && run.failed > 0 && ` · ${formatCount(run.failed)} files need attention`}
      </p>}
      {!run?.running && run?.details.length > 0 && (
        <details className="text-xs text-gray-400">
          <summary>Files that need attention</summary>
          <ul className="mt-1 space-y-1 break-words">
            {run.details.map(({ filename, message }) => <li key={`${filename}:${message}`}>{filename} · {message}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
