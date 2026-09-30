import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileArchive, FolderInput, LayoutTemplate, Pause, Play, Unlink } from 'lucide-react';
import toast from '../ui/Toast';
import { downloadBlob } from '../../lib/downloadBlob';
import { formatBytes, timeAgo } from '../../utils/formatters.js';
import { compositionDraft } from './compositionDraft.js';
import {
  detachMusicVideoCompositionDocument, fetchMusicVideoPreviewAsset, getMusicVideoCompositionDocument, getMusicVideoCompositionExport,
  getMusicVideoCompositionPreview, importMusicVideoCompositionDirectory, importMusicVideoCompositionZip,
  startMusicVideoCompositionTemplate,
} from '../../services/apiMusicVideo.js';

const buttonCls = 'flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';
const inputCls = 'bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs';
const SOURCE_LABELS = { template: 'template', zip: 'zip', directory: 'folder' };

const linesOf = (value) => String(value || '').split('\n').map((line) => line.trim()).filter(Boolean);
// "12.5 = 80" per line → [[12.5, 80], …]; unparseable lines are dropped.
const keyframesOf = (value) => linesOf(value)
  .map((line) => line.split(/[=:,\s]+/).map(Number))
  .filter(([t, v]) => Number.isFinite(t) && t >= 0 && Number.isFinite(v) && v >= 0 && v <= 100)
  .map(([t, v]) => [t, v]);

/**
 * HUD block the layered template draws (`composition.overlay`). Text fields
 * edit locally and persist on blur, replacing the whole manifest.
 */
function OverlayEditor({ project, onSave }) {
  const composition = compositionDraft(project);
  const overlay = composition.overlay || null;
  const [draft, setDraft] = useState(() => ({
    titleLines: (overlay?.titleLines || []).join('\n'),
    ticker: (overlay?.ticker || []).join('\n'),
    meterLabel: overlay?.meter?.label || '',
    keyframes: (overlay?.meter?.keyframes || []).map(([t, v]) => `${t} = ${v}`).join('\n'),
  }));
  const save = (patch = {}) => {
    const next = {
      enabled: overlay?.enabled ?? true,
      timecode: overlay?.timecode ?? true,
      timecodeStartSec: overlay?.timecodeStartSec ?? 0,
      titleLines: linesOf(draft.titleLines).slice(0, 4),
      ticker: linesOf(draft.ticker).slice(0, 40),
      meter: draft.meterLabel || draft.keyframes ? { label: draft.meterLabel.trim().slice(0, 40), keyframes: keyframesOf(draft.keyframes) } : null,
      ...patch,
    };
    onSave({ composition: { ...composition, overlay: next } });
  };
  const field = (key) => ({ value: draft[key], onChange: (e) => setDraft((d) => ({ ...d, [key]: e.target.value })), onBlur: () => save() });
  return (
    <details className="rounded border border-port-border p-2 text-xs">
      <summary className="cursor-pointer select-none text-port-text-muted">HUD overlay — {overlay?.enabled === false || !overlay ? 'off' : 'on'} (drawn by the layered template)</summary>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label htmlFor="mv-doc-hud-on" className="flex items-center gap-1">
          <input id="mv-doc-hud-on" type="checkbox" checked={Boolean(overlay) && overlay.enabled !== false} onChange={(e) => save({ enabled: e.target.checked })} /> Show HUD
        </label>
        <label htmlFor="mv-doc-hud-tc" className="flex items-center gap-1">
          <input id="mv-doc-hud-tc" type="checkbox" checked={overlay?.timecode ?? true} onChange={(e) => save({ timecode: e.target.checked })} /> Timecode
        </label>
        <label htmlFor="mv-doc-hud-tc-start" className="flex items-center gap-1">
          Timecode starts at (s)
          <input id="mv-doc-hud-tc-start" type="number" min={0} step={1} className={`${inputCls} w-24`} defaultValue={overlay?.timecodeStartSec ?? 0}
            onBlur={(e) => save({ timecodeStartSec: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
        <div>
          <label htmlFor="mv-doc-hud-title" className="block text-port-text-muted mb-0.5">Title lines (up to 4)</label>
          <textarea id="mv-doc-hud-title" rows={3} className={`${inputCls} w-full`} {...field('titleLines')} />
        </div>
        <div>
          <label htmlFor="mv-doc-hud-ticker" className="block text-port-text-muted mb-0.5">Ticker (one item per line)</label>
          <textarea id="mv-doc-hud-ticker" rows={3} className={`${inputCls} w-full`} {...field('ticker')} />
        </div>
        <div>
          <label htmlFor="mv-doc-hud-meter" className="block text-port-text-muted mb-0.5">Meter label</label>
          <input id="mv-doc-hud-meter" type="text" maxLength={40} className={`${inputCls} w-full`} {...field('meterLabel')} />
        </div>
        <div>
          <label htmlFor="mv-doc-hud-keys" className="block text-port-text-muted mb-0.5">Meter keyframes (seconds = percent, one per line)</label>
          <textarea id="mv-doc-hud-keys" rows={3} placeholder={'0 = 100\n60 = 40'} className={`${inputCls} w-full`} {...field('keyframes')} />
        </div>
      </div>
    </details>
  );
}

/** The document's files, read when opened (the manifest route). */
function DocumentFiles({ projectId, directory }) {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState('');
  const load = (open) => {
    if (!open || manifest) return;
    getMusicVideoCompositionDocument(projectId, { silent: true })
      .then(setManifest)
      .catch((err) => setError(err?.message || 'Could not list the document files'));
  };
  return (
    <details key={directory} className="rounded border border-port-border p-2 text-xs" onToggle={(e) => load(e.currentTarget.open)}>
      <summary className="cursor-pointer select-none text-port-text-muted">Files</summary>
      {error && <p className="mt-1 text-port-error">{error}</p>}
      {manifest && !manifest.available && <p className="mt-1 text-port-warning">The document folder is missing on this machine — import it again.</p>}
      {manifest?.available && (
        <ul className="mt-1 max-h-48 overflow-y-auto font-mono">
          {manifest.files.map((file) => <li key={file.path} className="flex justify-between gap-2"><span className="min-w-0 break-all">{file.path}</span><span className="shrink-0 text-port-text-muted">{formatBytes(file.bytes)}</span></li>)}
        </ul>
      )}
    </details>
  );
}

/**
 * The project's composition document (render style `document`): what is
 * attached, import (template / zip / data folder), export, and a live preview.
 * The preview runs in an opaque-origin sandbox that cannot fetch; this panel
 * fetches the scene takes and document media and posts them in as Blobs.
 */
export default function DocumentCompositionPanel({ project, audioUrl, onProject, onSave }) {
  const doc = project.composition?.document || null;
  const [busy, setBusy] = useState(null);
  // Replacing or detaching drops the current version folder once nothing
  // points at it, so both ask for a second click (no window.confirm).
  const [confirming, setConfirming] = useState(null);
  const [folder, setFolder] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [status, setStatus] = useState('');
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const iframeRef = useRef(null);
  const audioRef = useRef(null);
  const fileRef = useRef(null);
  const blobCache = useRef(new Map());
  const seekState = useRef({ inFlight: false, pending: null, ready: false });

  const refresh = doc ? `${doc.directory}|${project.updatedAt}` : null;
  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewError('');
    seekState.current = { inFlight: false, pending: null, ready: false };
    if (!refresh) return () => { active = false; };
    getMusicVideoCompositionPreview(project.id, { silent: true })
      .then((next) => { if (active) setPreview(next); })
      .catch((err) => { if (active) setPreviewError(err?.message || 'Could not build the preview'); });
    return () => { active = false; };
  }, [project.id, refresh]);

  const postSeek = useCallback((time) => {
    const frame = iframeRef.current?.contentWindow;
    const state = seekState.current;
    if (!frame || !state.ready) return;
    if (state.inFlight) { state.pending = time; return; }
    state.inFlight = true;
    frame.postMessage({ type: 'portos-mv:seek', t: time }, '*');
  }, []);

  useEffect(() => {
    if (!preview) return undefined;
    let active = true;
    const onMessage = async (event) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = event.data || {};
      const state = seekState.current;
      if (message.type === 'portos-mv:loaded') {
        const files = {};
        let loaded = 0;
        for (const asset of preview.assets || []) {
          if (!active) return;
          setStatus(`Loading preview media ${loaded + 1}/${preview.assets.length}…`);
          const blob = blobCache.current.get(asset.url) || await fetchMusicVideoPreviewAsset(asset.url).catch(() => null);
          if (blob) { blobCache.current.set(asset.url, blob); files[asset.key] = blob; }
          loaded += 1;
        }
        if (!active) return;
        setStatus(loaded === (preview.assets || []).length ? '' : 'Some preview media could not be loaded');
        iframeRef.current?.contentWindow?.postMessage({ type: 'portos-mv:assets', files }, '*');
        state.ready = true;
        postSeek(t);
      } else if (message.type === 'portos-mv:seeked') {
        state.inFlight = false;
        if (state.pending != null) { const next = state.pending; state.pending = null; postSeek(next); }
      } else if (message.type === 'portos-mv:error') {
        state.inFlight = false;
        setPreviewError(String(message.message || 'The composition document failed in the preview'));
      }
    };
    window.addEventListener('message', onMessage);
    return () => { active = false; window.removeEventListener('message', onMessage); };
    // `t` is read once when the page loads; later seeks go through postSeek.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, postSeek]);

  const duration = preview?.durationSec || 0;
  const fps = preview?.fps || 24;
  const seek = useCallback((time) => {
    const next = Math.min(Math.max(0, time), Math.max(0, duration - 1 / fps));
    setT(next);
    postSeek(next);
    if (audioRef.current && Math.abs((audioRef.current.currentTime || 0) - next) > 0.05) audioRef.current.currentTime = next;
  }, [duration, fps, postSeek]);

  useEffect(() => {
    if (!playing) return undefined;
    let handle = 0;
    let posted = -1;
    const tick = () => {
      const time = audioRef.current?.currentTime || 0;
      const frameIndex = Math.floor(time * fps + 1e-9);
      if (frameIndex !== posted) { posted = frameIndex; setT(time); postSeek(time); }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, fps, postSeek]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); return; }
    audio.play?.()?.catch?.(() => {});
    setPlaying(true);
  };

  const run = async (label, task, success) => {
    setBusy(label);
    const result = await Promise.resolve().then(task).catch((err) => { toast.error(err?.message || 'Composition document action failed'); return null; });
    setBusy(null);
    if (result?.project) onProject(result.project);
    if (result && success) toast.success(success);
    return result;
  };
  const confirmFirst = (key, action) => () => {
    if (doc && confirming !== key) { setConfirming(key); return; }
    setConfirming(null);
    action();
  };
  const startTemplate = confirmFirst('template', () => run('template', () => startMusicVideoCompositionTemplate(project.id, 'layered', { silent: true }), 'Layered template copied into this project'));
  const importZip = (file) => file && run('zip', () => importMusicVideoCompositionZip(project.id, file, { silent: true }), 'Composition document imported');
  const importFolder = () => folder.trim() && run('folder', () => importMusicVideoCompositionDirectory(project.id, folder.trim(), { silent: true }), 'Composition document imported');
  const exportZip = () => run('export', async () => {
    const buffer = await getMusicVideoCompositionExport(project.id, { silent: true });
    downloadBlob(buffer, `${(project.name || 'music-video').replace(/[^\w.-]+/g, '-')}-composition.zip`, 'application/zip');
    return {};
  });
  const detach = confirmFirst('detach', () => run('detach', () => detachMusicVideoCompositionDocument(project.id, { silent: true }), 'Composition document detached'));

  const aspect = preview?.width && preview?.height ? `${preview.width} / ${preview.height}` : '16 / 9';
  return (
    <section className="mt-3 space-y-2 rounded-lg border border-port-border bg-port-bg p-2" aria-label="Composition document">
      <div className="flex flex-wrap items-center gap-2 text-xs text-port-text-muted">
        <span className="text-sm text-port-text">Composition document</span>
        {doc ? (
          <span>
            {SOURCE_LABELS[doc.source?.kind] || 'imported'}{doc.source?.name ? ` · ${doc.source.name}` : ''}
            {doc.files != null ? ` · ${doc.files} files` : ''}{doc.bytes != null ? ` · ${formatBytes(doc.bytes)}` : ''}
            {doc.updatedAt ? ` · updated ${timeAgo(doc.updatedAt)}` : ''}
          </span>
        ) : <span>None yet — start from the layered template or import your own.</span>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <button type="button" className={buttonCls} disabled={!!busy} onClick={startTemplate}
          title="Copy PortOS's layered template (scene media, camera moves, grain, HUD, kinetic lyrics) into this project">
          <LayoutTemplate size={14} /> {busy === 'template' ? 'Copying…' : confirming === 'template' ? 'Click again to replace' : doc ? 'Replace with template' : 'Start from template'}
        </button>
        <button type="button" className={buttonCls} disabled={!!busy} onClick={() => fileRef.current?.click()}
          title="A .zip whose root (or single top folder) holds index.html">
          <FileArchive size={14} /> {busy === 'zip' ? 'Importing…' : 'Import zip'}
        </button>
        <input ref={fileRef} type="file" accept=".zip,application/zip" className="hidden" aria-label="Composition document zip"
          onChange={(e) => { importZip(e.target.files?.[0]); e.target.value = ''; }} />
        <div className="flex items-end gap-1">
          <div>
            <label htmlFor="mv-doc-folder" className="block text-xs text-port-text-muted mb-0.5">Folder inside data/</label>
            <input id="mv-doc-folder" type="text" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="compositions/my-video"
              className={`${inputCls} w-48`} />
          </div>
          <button type="button" className={buttonCls} disabled={!!busy || !folder.trim()} onClick={importFolder}>
            <FolderInput size={14} /> {busy === 'folder' ? 'Importing…' : 'Import folder'}
          </button>
        </div>
        <button type="button" className={buttonCls} disabled={!!busy || !doc} onClick={exportZip}>
          <Download size={14} /> Export zip
        </button>
        <button type="button" className={buttonCls} disabled={!!busy || !doc} onClick={detach} title="Stop using this document (the render refuses until another is attached)">
          <Unlink size={14} /> {confirming === 'detach' ? 'Click again to detach' : 'Detach'}
        </button>
      </div>
      <OverlayEditor key={`${project.id}-${project.composition?.overlay ? 'hud' : 'none'}`} project={project} onSave={onSave} />
      {doc && (
        <>
          <DocumentFiles key={doc.directory} projectId={project.id} directory={doc.directory} />
          {previewError && <p className="text-xs text-port-error" role="alert">{previewError}</p>}
          {status && <p className="text-xs text-port-text-muted">{status}</p>}
          <div className="overflow-hidden rounded border border-port-border bg-black mx-auto" style={{ aspectRatio: aspect, maxHeight: '70vh', maxWidth: '100%' }}>
            {preview?.html ? (
              <iframe ref={iframeRef} title="Composition document preview" sandbox="allow-scripts" srcDoc={preview.html} className="h-full w-full" />
            ) : (
              <p className="p-3 text-xs text-port-text-muted">{previewError ? '' : 'Building the preview…'}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={buttonCls} onClick={togglePlay} disabled={!preview || !audioUrl}>
              {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}
            </button>
            <label htmlFor="mv-doc-scrub" className="sr-only">Scrub the composition preview</label>
            <input id="mv-doc-scrub" type="range" min={0} max={duration || 0} step={1 / fps} value={Math.min(t, duration || 0)}
              onChange={(e) => { audioRef.current?.pause(); setPlaying(false); seek(Number(e.target.value)); }}
              className="min-w-0 flex-1" />
            <span className="text-xs text-port-text-muted tabular-nums">{t.toFixed(2)}s / {duration.toFixed(1)}s</span>
          </div>
          <p className="text-[11px] text-port-text-muted">
            Renders, draft excerpts, proofs and auto-review all seek this document on song time with the song as the only audio (plus the sound bed, when set).
            It reads <code>window.PORTOS_MV</code> from <code>portos-mv.js</code>; each scene&apos;s selected take is copied into <code>media/</code>.
          </p>
          {audioUrl && <audio ref={audioRef} src={audioUrl} preload="none" className="hidden" onEnded={() => setPlaying(false)} />}
        </>
      )}
    </section>
  );
}
