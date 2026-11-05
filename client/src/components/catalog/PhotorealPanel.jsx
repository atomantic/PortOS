import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Aperture, Box, Check, Download, Film, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import socket from '../../services/socket';
import MediaImage from '../MediaImage';
import PhotorealLookSection from './PhotorealLookSection';
import ProductionContainment from '../codeAnimation/ProductionContainment';
import { getCatalogPhotoreal, openCatalogPhotorealBlend, saveCatalogGreybox, startCatalogPhotorealRender } from '../../services/apiCatalog';
import { withShot } from '../../lib/greybox';
import { PHOTOREAL_ROLE_PREFIX } from '../../lib/creativeLibraries';
import { formatDurationSec } from '../../utils/formatters';
import { useTimeTick } from '../../hooks/useTimeTick';
import { useVisibilityEvent } from '../../hooks/useVisibilityEvent';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage';
import { copyToClipboard } from '../../lib/clipboard';

const clampInt = (value, min, max) => Math.min(max, Math.max(min, Math.round(Number(value) || min)));

// Raw text while a number field is focused so partial input ("1" on the way to
// "15") isn't clamped; the clamped value is committed on blur and used by render.
function useDraftNumber({ committed, min, max, onCommit }) {
  const [draft, setDraft] = useState(null);
  const effective = draft === null ? committed : clampInt(draft, min, max);
  return {
    effective,
    inputProps: {
      value: draft ?? committed,
      onChange: (event) => setDraft(event.target.value),
      onBlur: () => {
        if (draft === null) return;
        setDraft(null);
        onCommit(effective);
      },
    },
  };
}

const ENGINES = [
  { id: 'eevee', label: 'EEVEE preview', defaultSamples: 32, note: 'Seconds per camera on a GPU.' },
  { id: 'cycles', label: 'Cycles final', defaultSamples: 128, note: 'Path traced; minutes per camera.' },
];
const MAX_SAMPLES = 1024;
const FLY_FPS = 24;
const FLY_SECONDS = { min: 2, max: 60, default: 8 };
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
  const [selected, setSelected] = useState(null);
  const [engine, setEngine] = useState(() => readPrefs()?.engine || 'eevee');
  const [samples, setSamples] = useState(() => readPrefs()?.samples ?? null);
  const [flySeconds, setFlySeconds] = useState(() => readPrefs()?.flySeconds ?? FLY_SECONDS.default);
  const [starting, setStarting] = useState(false);
  const [platingShot, setPlatingShot] = useState('');
  const [opening, setOpening] = useState(false);
  const [blenderExecution, setBlenderExecution] = useState(null);
  const [blenderRefresh, setBlenderRefresh] = useState(0);
  const [blenderRefreshing, setBlenderRefreshing] = useState(false);
  const [blenderOpenRequest, setBlenderOpenRequest] = useState(0);
  const [blenderNotice, setBlenderNotice] = useState('');
  const [missingFfmpeg, setMissingFfmpeg] = useState(false);
  // Finish frames already acted on; the server sends one per transition.
  const finished = useRef(new Set());
  const job = status?.job || null;
  const running = job?.state === 'running';
  const blenderReady = blenderExecution?.lanes?.blender?.ready === true;
  const checkedEngine = blenderExecution?.tools?.blender?.engine;
  const requestedEngine = engine === 'eevee' ? 'BLENDER_EEVEE_NEXT' : 'CYCLES';
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

  // Default to every camera until the user picks; always in list order, which is
  // also the order a fly-through visits them.
  const chosen = shots.filter((s) => selected === null || selected.has(s.id)).map((s) => s.id);
  const toggleShot = (id) => setSelected((cur) => {
    const base = cur === null ? new Set(shots.map((s) => s.id)) : new Set(cur);
    if (base.has(id)) base.delete(id); else base.add(id);
    return base;
  });
  const pickEngine = (id) => {
    setEngine(id);
    setSamples(null);
    writePrefs({ engine: id, samples: null, flySeconds });
  };
  const samplesField = useDraftNumber({
    committed: sampleValue, min: 1, max: MAX_SAMPLES,
    onCommit: (next) => { setSamples(next); writePrefs({ engine, samples: next, flySeconds }); },
  });
  const secondsField = useDraftNumber({
    committed: flySeconds, min: FLY_SECONDS.min, max: FLY_SECONDS.max,
    onCommit: (next) => { setFlySeconds(next); writePrefs({ engine, samples, flySeconds: next }); },
  });

  const handleBlenderError = (err, fallback) => {
    if (err?.code === 'CODE_ANIMATION_BLENDER_NOT_READY') {
      setBlenderNotice(`Blender setup changed before this action started. Check the setup, then try again.${err.message ? ` ${err.message}` : ''}`);
      setBlenderExecution(null);
      setBlenderRefreshing(true);
      setBlenderRefresh((value) => value + 1);
    } else toast.error(err?.message || fallback);
  };

  const render = async ({ flythrough = false } = {}) => {
    if (chosen.length < (flythrough ? 2 : 1) || running || starting || !blenderReady) return;
    setBlenderNotice('');
    setStarting(true);
    const body = { shotIds: chosen, engine, samples: samplesField.effective, ...(flythrough ? { flythroughSeconds: secondsField.effective } : {}) };
    const started = await startCatalogPhotorealRender(record.id, body, { silent: true })
      .catch((err) => {
        if (flythrough && err?.code === 'FFMPEG_MISSING') setMissingFfmpeg(true);
        else handleBlenderError(err, 'Could not start the Blender render');
        return null;
      });
    setStarting(false);
    if (started && flythrough) setMissingFfmpeg(false);
    if (started?.state === 'running') seenRunning.current.add(started.id);
    // Keep a finish frame for this job that beat the response here.
    if (started) setStatus((cur) => (cur?.job?.id === started.id && cur.job.state !== 'running' ? cur : { ...(cur || {}), job: started }));
  };

  const openInBlender = async () => {
    if (opening || !blenderReady) return;
    setBlenderNotice('');
    setOpening(true);
    const opened = await openCatalogPhotorealBlend(record.id, { silent: true })
      .catch((err) => { handleBlenderError(err, 'Could not open Blender'); return null; });
    setOpening(false);
    if (opened) toast.success('Opened in Blender. The next render replaces this scene, so use File › Save As to keep your changes.');
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
          <p className="text-xs text-gray-400">Builds this greybox in Blender, dresses it with the Look, and renders its saved cameras. Renders land here and can become a camera&apos;s photo plate.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!readOnly && (
            <button type="button" onClick={openInBlender} disabled={!status?.blendUrl || opening || !blenderReady} className={actionButton}>
              {opening ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Box size={16} aria-hidden="true" />} Open in Blender
            </button>
          )}
          {status?.blendUrl && (
            <a href={status.blendUrl} download className={actionButton}>
              <Download size={16} aria-hidden="true" /> Download .blend
            </a>
          )}
        </div>
      </div>
      {status && !status.blendUrl && <p className="text-xs text-gray-400">The first render builds the Blender scene; Open in Blender works after that.</p>}
      {status?.files && (
        <dl className="space-y-1 text-xs" aria-label="Files">
          {[['Blender scene', status.files.blend], ['Renders', status.files.renders]].map(([label, path]) => (
            <div key={label} className="flex flex-wrap items-center gap-x-2">
              <dt className="text-gray-400">{label}</dt>
              <dd className="min-w-0 flex-1 break-all font-mono text-gray-300">{path}</dd>
              <dd><button type="button" className="min-h-[32px] px-2 text-port-accent" onClick={() => copyToClipboard(path, 'Path copied')}>Copy</button></dd>
            </div>
          ))}
        </dl>
      )}

      <ProductionContainment inline rendererKind="blender" onExecutionChange={next => { setBlenderExecution(next); if (next) setBlenderRefreshing(false); }} refreshKey={blenderRefresh}
        openRequest={blenderOpenRequest} locked={starting || opening || blenderRefreshing} />
      {blenderNotice && <p role="alert" className="rounded border border-port-warning p-3 text-sm text-port-warning">{blenderNotice}</p>}

      <PhotorealLookSection record={record} scene={scene} readOnly={readOnly} disabled={disabled || running}
        onBusyChange={onBusyChange} onSaved={onSaved} />

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
                <input id="photoreal-samples" type="number" min={1} max={MAX_SAMPLES} disabled={running} {...samplesField.inputProps}
                  className="w-20 min-h-[40px] rounded-lg bg-port-bg border border-port-border px-2 text-sm text-white" />
              </label>
            </div>
            <p className="text-[11px] text-gray-500">{engineInfo.note}</p>
            {blenderReady && checkedEngine && checkedEngine !== requestedEngine && <div className="space-y-2 rounded border border-port-warning p-3 text-sm">
              <p>Blender was checked with {checkedEngine === 'CYCLES' ? 'Cycles CPU' : 'EEVEE GPU'}; {engine === 'eevee' ? 'EEVEE GPU' : 'Cycles CPU'} has not been checked. To verify it, select that engine in Blender setup, save, and check it. This changes the Blender check for all PortOS uses.</p>
              <button type="button" className={actionButton} onClick={() => setBlenderOpenRequest(value => value + 1)}>Open Blender setup</button>
            </div>}
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
              <button type="button" onClick={() => render()} disabled={!chosen.length || running || starting || !blenderReady}
                className="min-h-[40px] inline-flex items-center gap-1.5 rounded-lg bg-port-accent px-4 text-sm font-medium text-white disabled:opacity-40">
                {running || starting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Aperture size={16} aria-hidden="true" />}
                {running ? 'Rendering…' : `Render ${chosen.length} camera${chosen.length === 1 ? '' : 's'}`}
              </button>
              {running && job?.startedAt && (
                <span className="text-xs text-gray-400" role="status">
                  {job.engine === 'cycles' ? 'Cycles' : 'EEVEE'} · {job.flythroughSeconds
                    ? `fly-through, ${job.flythroughSeconds}s (${job.flythroughSeconds * FLY_FPS} frames)`
                    : `${job.shotIds.length} camera${job.shotIds.length === 1 ? '' : 's'}`} · <Elapsed since={job.startedAt} />
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

          {!readOnly && shots.length > 1 && (
            <div className="rounded-lg border border-port-border bg-port-card p-3 space-y-2">
              <h3 className="text-sm font-medium text-white">Fly-through</h3>
              <p className="text-xs text-gray-400">
                One camera glides through the chosen cameras in the order listed, with the same engine and samples. The MP4 is saved to Media History, where you can pick it as a video reference.
              </p>
              {missingFfmpeg && <div role="alert" className="space-y-2 rounded border border-port-warning p-3 text-sm">
                <p>Fly-throughs need FFmpeg on the computer running PortOS. Install it, then try the fly-through again.</p>
                {blenderExecution?.platform === 'darwin' && <div className="flex flex-wrap items-center gap-2">
                  <code>brew install ffmpeg</code>
                  <button type="button" className={actionButton} onClick={() => copyToClipboard('brew install ffmpeg', 'Install command copied')}>Copy install command</button>
                </div>}
                <a href="https://ffmpeg.org/download.html" target="_blank" rel="noopener noreferrer" className={actionButton}>FFmpeg install options</a>
              </div>}
              <div className="flex flex-wrap items-center gap-3">
                <label htmlFor="photoreal-fly-seconds" className="inline-flex items-center gap-1.5 text-xs text-gray-400">
                  Seconds
                  <input id="photoreal-fly-seconds" type="number" min={FLY_SECONDS.min} max={FLY_SECONDS.max} disabled={running} {...secondsField.inputProps}
                    className="w-20 min-h-[40px] rounded-lg bg-port-bg border border-port-border px-2 text-sm text-white" />
                </label>
                <button type="button" onClick={() => render({ flythrough: true })} disabled={chosen.length < 2 || running || starting || !blenderReady} className={actionButton}>
                  <Film size={16} aria-hidden="true" /> Render fly-through ({secondsField.effective * FLY_FPS} frames)
                </button>
                {chosen.length < 2 && <span className="text-xs text-gray-500">Choose at least two cameras.</span>}
              </div>
              {job?.state === 'done' && job.video && (
                <div className="space-y-1.5">
                  {/* a silent camera move has no caption track */}
                  <video src={`/data/videos/${encodeURIComponent(job.video.filename)}`} controls muted playsInline loop
                    className="w-full rounded bg-black" aria-label="Fly-through" />
                  <Link to={`/media/history?preview=${encodeURIComponent(`video:${job.video.id}`)}`} className="text-xs text-port-accent hover:underline">
                    Open in Media History
                  </Link>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
