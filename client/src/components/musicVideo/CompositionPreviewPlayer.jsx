import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { fetchMusicVideoPreviewAsset, getMusicVideoCompositionPreview } from '../../services/apiMusicVideo.js';

const buttonCls = 'flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';

/** The lyric line sung at song time `t`, from the project's timed cues. */
const lyricAt = (cues, t) => {
  const line = (cues || []).find((cue) => typeof cue.startSec === 'number' && typeof cue.endSec === 'number' && t >= cue.startSec && t < cue.endSec);
  return line?.text || '';
};

/**
 * Live preview of the project's composition document: the sandboxed iframe,
 * the song, play/scrub and the lyric line being sung. The iframe runs in an
 * opaque-origin sandbox that cannot fetch, so this component fetches the scene
 * takes and document media and posts them in as Blobs over the
 * `portos-mv:*` message bridge, then drives the document with seek messages.
 *
 * `seekRequest` (`{ t, n }`) moves the player from outside — the board seeks it
 * to a scene's start; `n` changes on every request so seeking twice to the same
 * time still applies. `collapsed` hides the picture (mini-player) below `lg`
 * while the transport stays usable; the iframe stays mounted so the loaded
 * media and playhead survive.
 */
export default function CompositionPreviewPlayer({ project, audioUrl, seekRequest = null, collapsed = false, draft = false }) {
  const doc = (draft ? project.composition?.documentDraft : project.composition?.document) || null;
  const scrubId = draft ? 'mv-doc-draft-scrub' : 'mv-doc-scrub';
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [status, setStatus] = useState('');
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const iframeRef = useRef(null);
  const audioRef = useRef(null);
  const blobCache = useRef(new Map());
  const seekState = useRef({ inFlight: false, pending: null, ready: false });
  const appliedSeek = useRef(null);

  const refresh = doc ? `${doc.directory}|${project.updatedAt}` : null;
  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewError('');
    seekState.current = { inFlight: false, pending: null, ready: false };
    if (!refresh) return () => { active = false; };
    getMusicVideoCompositionPreview(project.id, { silent: true, draft })
      .then((next) => { if (active) setPreview(next); })
      .catch((err) => { if (active) setPreviewError(err?.message || 'Could not build the preview'); });
    return () => { active = false; };
  }, [project.id, refresh, draft]);

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

  // An outside seek (a scene card) waits for the preview to know its duration,
  // then applies exactly once per request.
  useEffect(() => {
    if (!seekRequest || duration <= 0 || appliedSeek.current === seekRequest.n) return;
    appliedSeek.current = seekRequest.n;
    audioRef.current?.pause?.();
    setPlaying(false);
    seek(seekRequest.t);
  }, [seekRequest, duration, seek]);

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

  if (!doc) return null;
  const aspect = preview?.width && preview?.height ? `${preview.width} / ${preview.height}` : '16 / 9';
  const lyric = lyricAt(project.lyricCues, t);
  return (
    <div className="space-y-2" aria-label="Composition preview">
      {previewError && <p className="text-xs text-port-error" role="alert">{previewError}</p>}
      {status && <p className="text-xs text-port-text-muted">{status}</p>}
      <div className={`overflow-hidden rounded border border-port-border bg-black mx-auto ${collapsed ? 'max-lg:hidden' : ''}`}
        style={{ aspectRatio: aspect, maxHeight: '70vh', maxWidth: '100%' }}>
        {preview?.html ? (
          <iframe ref={iframeRef} title={draft ? 'Composition candidate preview' : 'Composition document preview'} sandbox="allow-scripts" srcDoc={preview.html} className="h-full w-full" />
        ) : (
          <p className="p-3 text-xs text-port-text-muted">{previewError ? '' : 'Building the preview…'}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonCls} onClick={togglePlay} disabled={!preview || !audioUrl}>
          {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}
        </button>
        <label htmlFor={scrubId} className="sr-only">{draft ? 'Scrub the composition candidate' : 'Scrub the composition preview'}</label>
        <input id={scrubId} type="range" min={0} max={duration || 0} step={1 / fps} value={Math.min(t, duration || 0)}
          onChange={(e) => { audioRef.current?.pause(); setPlaying(false); seek(Number(e.target.value)); }}
          className="min-w-0 flex-1" />
        <span className="text-xs text-port-text-muted tabular-nums">{t.toFixed(2)}s / {duration.toFixed(1)}s</span>
      </div>
      {lyric && <p className="text-xs italic break-words" aria-live="off" data-testid="preview-lyric">♪ {lyric}</p>}
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="none" className="hidden" onEnded={() => setPlaying(false)} />}
    </div>
  );
}
