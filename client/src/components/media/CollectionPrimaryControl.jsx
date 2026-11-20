import { useEffect, useId, useRef, useState } from 'react';
import { getMediaCollectionPrimary, setMediaCollectionPrimary } from '../../services/api';
import socket from '../../services/socket';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { formatCount } from '../../utils/formatters';

export default function CollectionPrimaryControl({ collectionId }) {
  const id = useId();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(false);
  const [selection, setSelection] = useState(null);
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
    await reloadRef.current?.();
  }, { errorMessage: 'Could not set the primary machine' });
  const busy = saving || status?.run?.running;
  const selectable = status?.machines.some((machine) => machine.instanceId === chosen);
  const run = status?.run;

  return (
    <section className="rounded-lg border border-port-border bg-port-card p-3 space-y-2" aria-label="Collection storage">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-sm font-medium">Primary machine</label>
        <select
          id={id}
          value={chosen}
          onChange={(event) => setSelection(event.target.value)}
          disabled={!status || busy}
          className="min-w-0 max-w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
        >
          <option value="" disabled>{status ? 'Choose a machine' : 'Loading machines…'}</option>
          {chosen && !selectable && <option value={chosen} disabled>Assigned machine unavailable</option>}
          {status?.machines.map((machine) => <option key={machine.instanceId} value={machine.instanceId}>{machine.name}</option>)}
        </select>
        <button
          type="button"
          onClick={save}
          disabled={!selectable || busy || error}
          className="rounded border border-port-accent/40 px-2.5 py-1.5 text-sm text-port-accent hover:bg-port-accent/20 disabled:opacity-40"
        >
          {busy ? 'Consolidating…' : chosen && chosen === status?.instanceId ? 'Consolidate again' : 'Set primary and consolidate'}
        </button>
      </div>
      <p className="text-xs text-gray-400">
        Copy any missing collection media to the selected machine, then move matching copies on other hosts to Trash. Collection items stay available from the primary.
      </p>
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
