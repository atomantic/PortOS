import { useEffect, useRef, useState } from 'react';
import CollapsibleListItem from '../../ui/CollapsibleListItem.jsx';
import { RefreshCw, Trash2 } from 'lucide-react';
import { cleanupMusicVideoRenders, getMusicVideoRenderCleanup } from '../../../services/apiMusicVideo.js';
import socket from '../../../services/socket';
import { formatBytes, formatCount, formatDateTime } from '../../../utils/formatters.js';

const ACTION = 'inline-flex min-h-[44px] items-center gap-2 rounded border border-port-border px-3 py-2 text-sm disabled:opacity-50';
const bytes = files => files.reduce((sum, file) => sum + file.bytes, 0);

export default function CleanupStage({ board }) {
  const { project } = board;
  const [inventory, setInventory] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [mutationError, setMutationError] = useState(null);
  const error = mutationError || loadError;
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const identityGeneration = useRef(0);
  const cleaning = useRef(false);
  const refresh = useRef(null);
  refresh.current = () => {
    const ticket = ++generation.current;
    getMusicVideoRenderCleanup(project.id, { silent: true }).then(next => {
      if (ticket === generation.current) { setInventory(next); setLoadError(null); }
    }).catch(err => { if (ticket === generation.current) setLoadError(err.message); });
  };
  useEffect(() => {
    identityGeneration.current += 1;
    setMutationError(null);
    return () => { identityGeneration.current += 1; };
  }, [project.id]);
  useEffect(() => {
    setInventory(null);
    setLoadError(null);
    refresh.current();
    const onChange = event => { if (event.projectId === project.id) refresh.current(); };
    const onShotSettled = event => { if (event.state !== 'rendering') onChange(event); };
    const onConnect = () => refresh.current();
    socket.on('music-video:render-cleanup', onChange);
    socket.on('music-video:shot-render', onShotSettled);
    socket.on('connect', onConnect);
    return () => {
      generation.current += 1;
      socket.off('music-video:render-cleanup', onChange);
      socket.off('music-video:shot-render', onShotSettled);
      socket.off('connect', onConnect);
    };
  }, [project.id, project.renderHistoryId, project.updatedAt]);

  const clean = unusedLooks => {
    if (cleaning.current) return;
    cleaning.current = true;
    setBusy(true);
    setMutationError(null);
    const identity = identityGeneration.current;
    const ticket = ++generation.current;
    cleanupMusicVideoRenders(project.id, { unusedLooks }, { silent: true }).then(next => {
      if (ticket === generation.current) { setInventory(next); setLoadError(null); }
    }).catch(err => { if (identity === identityGeneration.current) setMutationError(err.message); })
      .finally(() => { cleaning.current = false; setBusy(false); });
  };
  const finals = inventory?.finals || [];
  const eligible = finals.filter(file => !file.reason);
  const stale = inventory?.segments.stale || [];
  const looks = inventory?.segments.unusedLooks || [];
  return (
    <section className="space-y-4" aria-label="Production cleanup">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h3 className="font-semibold">Production cleanup</h3>
          <p className="text-sm text-port-text-muted">Successful rerenders replace superseded final videos and shot segments. Source takes, stills, and cutting-room content stay in Assets.</p>
          <p className="mt-2 text-sm text-port-text-muted">Cleanup permanently removes derived render files. The latest final, current shot renders, and referenced composites stay. Film-look comparisons stay until you remove unused looks below.</p>
        </div>
        <button type="button" className={ACTION} disabled={busy} onClick={() => refresh.current()}><RefreshCw size={16} />Refresh</button>
      </div>
      {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
      {!inventory && !error && <p role="status">Inspecting render files…</p>}
      {inventory && <>
        {inventory.segments.error && <p role="alert" className="text-sm text-port-warning">Shot cleanup unavailable: {inventory.segments.error.message}. Fix the shot plan to inspect its cache safely.</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <InventoryCard title="Superseded finals" files={eligible} noun="renders" />
          <InventoryCard title="Stale segments and previews" files={stale} />
          <InventoryCard title="Unused film-look versions" files={looks} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={ACTION} disabled={busy || !(eligible.length + stale.length)} onClick={() => clean(false)}><Trash2 size={16} />Remove superseded renders</button>
          <button type="button" className={ACTION} disabled={busy || !looks.length} onClick={() => clean(true)}><Trash2 size={16} />Remove superseded renders and unused looks</button>
        </div>
        {busy && <p role="status" className="text-sm">Cleaning render files…</p>}
        <CleanupFinalList key={project.id} files={finals} />
      </>}
    </section>
  );
}

function InventoryCard({ title, files, noun = 'files' }) {
  return <div className="min-w-0 rounded border border-port-border p-3">
    <h4 className="text-sm text-port-text-muted">{title}</h4>
    <p className="mt-1 font-semibold">{formatCount(files.length)} {noun} · {formatBytes(bytes(files))}</p>
  </div>;
}

function CleanupFinalList({ files }) {
  const [rows, setRows] = useState(() => files.map(file => ({ file, removing: false })));
  useEffect(() => {
    setRows(previous => {
      const latest = new Map(files.map(file => [file.id, file]));
      const known = new Set(previous.map(row => row.file.id));
      return [...previous.map(row => latest.has(row.file.id)
        ? { file: latest.get(row.file.id), removing: false } : { ...row, removing: true }),
      ...files.filter(file => !known.has(file.id)).map(file => ({ file, removing: false }))];
    });
  }, [files]);
  return <div role="list" aria-label="Older final renders" tabIndex={-1}>
    {rows.map(({ file, removing }) => <CollapsibleListItem key={file.id} removing={removing}
      onExited={() => setRows(previous => previous.filter(row => row.file.id !== file.id || !row.removing))}>
      <article role="listitem" className="break-words rounded border border-port-border p-3 text-sm">
        <p>{file.createdAt ? formatDateTime(file.createdAt) : 'Older final'} · {formatBytes(file.bytes)}</p>
        <p className="text-port-text-muted">{file.reason ? `Kept: ${file.reason}` : file.pending ? 'Cleanup incomplete — retry to remove remaining files' : 'Superseded — safe to remove'}</p>
      </article>
    </CollapsibleListItem>)}
  </div>;
}
