import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Aperture, Check, Download, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import socket from '../../services/socket';
import MediaImage from '../MediaImage';
import { getCatalogPhotoreal, saveCatalogGreybox, startCatalogPhotorealRender } from '../../services/apiCatalog';
import { withShot } from '../../lib/greybox';
import { PHOTOREAL_ROLE_PREFIX } from '../../lib/creativeLibraries';
import { formatDurationSec } from '../../utils/formatters';
import { useTimeTick } from '../../hooks/useTimeTick';
import { useVisibilityEvent } from '../../hooks/useVisibilityEvent';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage';

const ENGINES = [
  { id: 'eevee', label: 'EEVEE preview', defaultSamples: 32, note: 'Seconds per camera on a GPU.' },
  { id: 'cycles', label: 'Cycles final', defaultSamples: 128, note: 'Path traced; minutes per camera.' },
];
const MAX_SAMPLES = 1024;
const PREFS_KEY = 'portos.photoreal.render';
const actionButton = 'min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';

const readPrefs = () => {
  const stored = safeReadJsonStorage(PREFS_KEY);
  return stored && ENGINES.some((e) => e.id === stored.engine) ? stored : null;
};
const writePrefs = (prefs) => safeWriteJsonStorage(PREFS_KEY, prefs);

// The newest render per camera, plus older ones still kept (a plate in use).
const rendersByShot = (media) => {
  const map = new Map();
  for (const m of media || []) {
    if (m.deleted || m.kind !== 'reference' || !m.role?.startsWith(PHOTOREAL_ROLE_PREFIX)) continue;
    const shotId = m.role.slice(PHOTOREAL_ROLE_PREFIX.length);
    map.set(shotId, [...(map.get(shotId) || []), m].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
  }
  return map;
};

function Elapsed({ since }) {
  const now = useTimeTick(1000);
  return <span>{formatDurationSec(Math.max(0, Math.round((now - Date.parse(since)) / 1000)))}</span>;
}

/**
 * The Photoreal tab of an Environment: build the saved greybox in Blender and
 * render chosen cameras with EEVEE (preview) or Cycles (final). Renders attach as
 * reference images tagged `photoreal:<shotId>`; one can become the camera's photo
 * plate. Progress arrives as `catalog:photoreal` socket frames, never by polling.
 */
export default function PhotorealPanel({ record, media, readOnly = false, disabled = false, onBusyChange, onSaved, onRendered }) {
  const scene = record.payload?.greybox ?? null;
  const shots = useMemo(() => scene?.shots || [], [scene]);
  const [status, setStatus] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [engine, setEngine] = useState(() => readPrefs()?.engine || 'eevee');
  const [samples, setSamples] = useState(() => readPrefs()?.samples ?? null);
  const [starting, setStarting] = useState(false);
  const [platingShot, setPlatingShot] = useState('');
  // Finish frames already acted on; the server sends one per transition.
  const finished = useRef(new Set());
  const job = status?.job || null;
  const running = job?.state === 'running';
  const engineInfo = ENGINES.find((e) => e.id === engine);
  const sampleValue = samples ?? engineInfo.defaultSamples;

  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  // Ids seen running here, so a reconnect read can tell a finish it missed.
  const seenRunning = useRef(new Set());
  const reconcileRef = useRef(null);

  useEffect(() => {
    let live = true;
    const refreshStatus = () => getCatalogPhotoreal(record.id, { silent: true })
      .then((fresh) => { if (live) setStatus((cur) => ({ ...fresh, job: cur?.job || fresh.job })); })
      .catch(() => {});
    // The server emits a frame only when a job starts, finishes or fails, so a
    // finish seen while the tab is open is news: act on it once, whatever order
    // the start response, status read or a reconnect read land in.
    const settle = (next) => {
      if (next.state === 'running') { seenRunning.current.add(next.id); return; }
      if (finished.current.has(next.id)) return;
      finished.current.add(next.id);
      if (next.state === 'done') {
        onRenderedRef.current?.();
        refreshStatus();
      } else if (next.state === 'failed') {
        toast.error(`Blender render failed: ${next.error || 'unknown error'}`);
      }
    };
    getCatalogPhotoreal(record.id, { silent: true })
      .then((next) => {
        if (!live) return;
        if (next?.job?.state === 'running') seenRunning.current.add(next.job.id);
        setStatus((cur) => (cur?.job ? { ...next, job: cur.job } : next));
      })
      .catch(() => { if (live) setStatus({ job: null, blendUrl: null, blenderVersion: null }); });
    const onFrame = (frame) => {
      if (frame?.ingredientId !== record.id || !frame.job) return;
      setStatus((cur) => ({ ...(cur || {}), job: frame.job }));
      settle(frame.job);
    };
    // A sleeping laptop or dropped socket can miss the one finish frame: re-read
    // the server's job and settle a render this tab saw running.
    reconcileRef.current = () => getCatalogPhotoreal(record.id, { silent: true })
      .then((fresh) => {
        if (!live) return;
        setStatus(fresh);
        if (fresh?.job && seenRunning.current.has(fresh.job.id)) settle(fresh.job);
      })
      .catch(() => {});
    const onConnect = () => reconcileRef.current?.();
    socket.on('catalog:photoreal', onFrame);
    socket.on('connect', onConnect);
    return () => {
      live = false;
      reconcileRef.current = null;
      socket.off('catalog:photoreal', onFrame);
      socket.off('connect', onConnect);
    };
  }, [record.id]);
  useVisibilityEvent((state) => { if (state === 'visible') reconcileRef.current?.(); });

  // Default to every camera until the user picks.
  const chosen = selected.size ? [...selected].filter((id) => shots.some((s) => s.id === id)) : shots.map((s) => s.id);
  const toggleShot = (id) => setSelected((cur) => {
    const base = cur.size ? new Set(cur) : new Set(shots.map((s) => s.id));
    if (base.has(id)) base.delete(id); else base.add(id);
    return base;
  });
  const pickEngine = (id) => {
    setEngine(id);
    setSamples(null);
    writePrefs({ engine: id, samples: null });
  };
  const changeSamples = (value) => {
    const next = Math.min(MAX_SAMPLES, Math.max(1, Math.round(Number(value) || 1)));
    setSamples(next);
    writePrefs({ engine, samples: next });
  };

  const render = async () => {
    if (!chosen.length || running || starting) return;
    setStarting(true);
    const started = await startCatalogPhotorealRender(record.id, { shotIds: chosen, engine, samples: sampleValue }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not start the Blender render'); return null; });
    setStarting(false);
    if (started?.state === 'running') seenRunning.current.add(started.id);
    // Keep a finish frame for this job that beat the response here.
    if (started) setStatus((cur) => (cur?.job?.id === started.id && cur.job.state !== 'running' ? cur : { ...(cur || {}), job: started }));
  };

  const setPlate = async (shot, mediaKey) => {
    if (!scene || platingShot || disabled) return;
    setPlatingShot(shot.id);
    onBusyChange?.(true);
    const { plate: _previous, ...rest } = shot;
    const updated = await saveCatalogGreybox(record.id, withShot(scene, mediaKey ? { ...rest, plate: mediaKey } : rest), { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to set the photo plate'); return null; });
    setPlatingShot('');
    onBusyChange?.(false);
    if (updated) onSaved?.(updated);
  };

  const renders = rendersByShot(media);

  if (!scene) {
    return (
      <section className="space-y-2" aria-label="Photoreal">
        <h2 className="text-base font-semibold text-white">Photoreal</h2>
        <p className="text-sm text-gray-400">Save a greybox layout on the Greybox tab first; Blender builds the photoreal scene from it.</p>
      </section>
    );
  }
  if (scene.source === 'glb') {
    return (
      <section className="space-y-2" aria-label="Photoreal">
        <h2 className="text-base font-semibold text-white">Photoreal</h2>
        <p className="text-sm text-gray-400">This greybox shows an attached .glb model. Switch its layout source to the saved parts on the Greybox tab to build it in Blender.</p>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-label="Photoreal">
      <div className="flex flex-wrap items-start gap-2 justify-between">
        <div>
          <h2 className="text-base font-semibold text-white">Photoreal</h2>
          <p className="text-xs text-gray-400">Builds this greybox in Blender and renders its saved cameras. Renders land here and can become a camera&apos;s photo plate.</p>
        </div>
        {status?.blendUrl && (
          <a href={status.blendUrl} download className={actionButton}>
            <Download size={16} aria-hidden="true" /> Download .blend
          </a>
        )}
      </div>

      <p className="text-xs text-gray-400">
        {status?.blenderVersion ? `Blender ${status.blenderVersion} checked. ` : 'Blender not checked yet. '}
        Set up and check Blender under <Link to="/code-animation/production" className="text-port-accent hover:underline">Code Animation › Production › Blender execution</Link>.
      </p>

      {shots.length === 0 ? (
        <p className="text-sm text-gray-400">Save a camera on the Greybox tab to render it here.</p>
      ) : (
        <div className="space-y-3">
          <fieldset className="space-y-1.5">
            <legend className="text-xs text-gray-400">Engine</legend>
            <div className="flex flex-wrap gap-1.5">
              {ENGINES.map((e) => (
                <button key={e.id} type="button" aria-pressed={engine === e.id} onClick={() => pickEngine(e.id)} disabled={running}
                  className={`min-h-[40px] px-3 rounded-lg border text-sm ${engine === e.id ? 'border-port-accent text-white bg-port-accent/10' : 'border-port-border text-gray-300'}`}>
                  {e.label}
                </button>
              ))}
              <label htmlFor="photoreal-samples" className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                Samples
                <input id="photoreal-samples" type="number" min={1} max={MAX_SAMPLES} value={sampleValue} disabled={running}
                  onChange={(event) => changeSamples(event.target.value)}
                  className="w-20 min-h-[40px] rounded-lg bg-port-bg border border-port-border px-2 text-sm text-white" />
              </label>
            </div>
            <p className="text-[11px] text-gray-500">{engineInfo.note}</p>
          </fieldset>

          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3" aria-label="Cameras">
            {shots.map((shot) => {
              const latest = renders.get(shot.id)?.[0] || null;
              const isPlate = latest && shot.plate === latest.mediaKey;
              const checked = chosen.includes(shot.id);
              return (
                <li key={shot.id} className="rounded-lg border border-port-border bg-port-card p-2 space-y-2">
                  <label htmlFor={`photoreal-shot-${shot.id}`} className="flex items-center gap-2 text-sm text-gray-200 min-h-[32px]">
                    <input id={`photoreal-shot-${shot.id}`} type="checkbox" checked={checked} disabled={running} onChange={() => toggleShot(shot.id)} />
                    <span className="truncate">{shot.label}</span>
                    <span className="text-[11px] text-gray-500">{shot.aspect || '16:9'} · {shot.focalLengthMm || 35}mm</span>
                  </label>
                  {latest ? (
                    <>
                      <MediaImage src={`/data/images/${encodeURIComponent(latest.mediaKey)}`} loading="lazy" decoding="async" alt={latest.caption || shot.label}
                        className="w-full rounded bg-black object-contain" />
                      <p className="text-[11px] text-gray-500 line-clamp-2">{latest.caption}</p>
                      {!readOnly && (
                        <button type="button" className={actionButton} disabled={!!platingShot || disabled}
                          aria-pressed={!!isPlate} onClick={() => setPlate(shot, isPlate ? null : latest.mediaKey)}>
                          {platingShot === shot.id ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
                          {isPlate ? 'Photo plate (tap to clear)' : 'Use as photo plate'}
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-gray-500">Not rendered yet.</p>
                  )}
                </li>
              );
            })}
          </ul>

          {!readOnly && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={render} disabled={!chosen.length || running || starting}
                className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg bg-port-accent px-4 text-sm font-medium text-white disabled:opacity-40">
                {running || starting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Aperture size={16} aria-hidden="true" />}
                {running ? 'Rendering…' : `Render ${chosen.length} camera${chosen.length === 1 ? '' : 's'}`}
              </button>
              {running && job?.startedAt && (
                <span className="text-xs text-gray-400" role="status">
                  {job.engine === 'cycles' ? 'Cycles' : 'EEVEE'} · {job.shotIds.length} camera{job.shotIds.length === 1 ? '' : 's'} · <Elapsed since={job.startedAt} />
                </span>
              )}
              {job?.state === 'done' && job.report && (
                <span className="text-xs text-gray-400" role="status">
                  Last render: Blender {job.report.version} on {job.report.device === 'GPU' ? `GPU (${job.report.backend})` : 'CPU'}
                </span>
              )}
              {job?.state === 'failed' && <span className="text-xs text-red-400" role="alert">{job.error}</span>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
