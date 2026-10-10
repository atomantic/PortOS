import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { fetchMusicVideoPreviewAsset, getMusicVideoCompositionPreview, getMusicVideoLyricPlaythroughPreview } from '../../services/apiMusicVideo.js';

const buttonCls = 'flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';

// What the lyric playthrough page is built from: the song length, the word times,
// the sheet's sections and the shots' timing and text zones. A change rebuilds it.
const playthroughVersion = (project) => JSON.stringify([
  project.audioAnalysis?.durationSec ?? null,
  (project.lyricCues || []).map((cue) => [cue.text, cue.startSec, cue.endSec, (cue.words || []).map((w) => [w.startSec, w.endSec])]),
  (project.lyricMarkers || []).map((m) => [m.type, m.label, m.line]),
  (project.scenes || []).map((s) => [s.startSec, s.endSec, s.textZone, s.lyricRole]),
]);

/** The lyric line sung at song time `t`, from the project's timed cues. */
const lyricAt = (cues, t) => {
  const line = (cues || []).find((cue) => typeof cue.startSec === 'number' && typeof cue.endSec === 'number' && t >= cue.startSec && t < cue.endSec);
  return line?.text || '';
};

// A phone's collapsed mini-player has no picture to show, so it must not pull
// every scene take into memory up front — iOS Safari kills the tab and offers
// only "A problem repeatedly occurred". Without matchMedia, load eagerly.
const DESKTOP_QUERY = '(min-width: 1024px)';
const startsDeferred = (collapsed) => collapsed && window.matchMedia?.(DESKTOP_QUERY).matches === false;

// Fetched preview media kept for the iframe to ask for again (a scrub back, a
// rebuilt document). Least recently used blobs go first; the newest one stays
// even when it alone exceeds the budget. A phone tab's memory is the limit.
export const PREVIEW_BLOB_BUDGET_BYTES = 64 * 1024 * 1024;
const remember = (cache, url, blob) => {
  cache.set(url, blob);
  let total = 0;
  for (const kept of cache.values()) total += kept.size;
  for (const [key, kept] of cache) {
    if (total <= PREVIEW_BLOB_BUDGET_BYTES || cache.size === 1) break;
    cache.delete(key);
    total -= kept.size;
  }
};

/**
 * Live preview of the project's composition document: the sandboxed iframe,
 * the song, play/scrub and the lyric line being sung. The iframe runs in an
 * opaque-origin sandbox that cannot fetch, so this component posts it the
 * manifest of bridged media, fetches each scene take or document file only
 * when the document first asks for it (`portos-mv:request`), posts it in as a
 * Blob over the `portos-mv:*` message bridge, and drives the document with
 * seek messages. Only listed keys are ever fetched.
 *
 * `seekRequest` (`{ t, n }`) moves the player from outside — the board seeks it
 * to a scene's start; `n` changes on every request so seeking twice to the same
 * time still applies. `collapsed` hides the picture (mini-player) below `lg`
 * while the transport stays usable; the iframe stays mounted so the loaded
 * media and playhead survive.
 *
 * `lyrics` plays the lyric timing playthrough instead of the project's document:
 * the aligned words over a plain frame, for checking timing before any picture.
 */
export default function CompositionPreviewPlayer({ project, audioUrl, seekRequest = null, collapsed = false, draft = false, lyrics = false, scrubId: givenScrubId = null }) {
  const doc = lyrics ? { playthrough: true } : (draft ? project.composition?.documentDraft : project.composition?.document) || null;
  const scrubId = givenScrubId || (lyrics ? 'mv-lyrics-scrub' : draft ? 'mv-doc-draft-scrub' : 'mv-doc-scrub');
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [status, setStatus] = useState('');
  const [wanted, setWanted] = useState(() => !startsDeferred(collapsed));
  useEffect(() => {
    if (!collapsed) { setWanted(true); return undefined; }
    const desktop = window.matchMedia?.(DESKTOP_QUERY);
    // The desktop dock is always visible and has no expand button. A preview
    // deferred on a phone must therefore load when its viewport becomes wide.
    const reveal = () => { if (!desktop || desktop.matches) setWanted(true); };
    reveal();
    desktop?.addEventListener?.('change', reveal);
    return () => desktop?.removeEventListener?.('change', reveal);
  }, [collapsed]);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const iframeRef = useRef(null);
  const audioRef = useRef(null);
  const blobCache = useRef(new Map());
  const seekState = useRef({ inFlight: false, pending: null, ready: false });
  const appliedSeek = useRef(null);

  // The document's own version (its folder + save time), not the project's
  // `updatedAt`: an unrelated save must not reload a playing preview.
  const refresh = lyrics ? playthroughVersion(project) : doc ? `${doc.directory}|${doc.updatedAt || ''}` : null;
  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewError('');
    setStatus('');
    seekState.current = { inFlight: false, pending: null, ready: false };
    if (!refresh || !wanted) return () => { active = false; };
    (lyrics ? getMusicVideoLyricPlaythroughPreview(project.id, { silent: true }) : getMusicVideoCompositionPreview(project.id, { silent: true, draft }))
      .then((next) => { if (active) setPreview(next); })
      .catch((err) => { if (active) setPreviewError(err?.message || 'Could not build the preview'); });
    return () => { active = false; };
  }, [project.id, refresh, draft, lyrics, wanted]);

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
    let missing = false;
    let firstFrame = true;
    const inFlight = new Map();
    const byKey = new Map((preview.assets || []).map((asset) => [String(asset.key).replace(/^\.\//, ''), asset]));
    // Only the first frame announces loading: a status line appearing on every later fetch would shift the layout mid-playback.
    const showStatus = () => {
      if (active) setStatus(missing ? 'Some preview media could not be loaded' : firstFrame ? 'Loading preview media…' : '');
    };
    const mediaFor = async (url) => {
      const cache = blobCache.current;
      if (cache.has(url)) {
        const blob = cache.get(url);
        cache.delete(url);
        cache.set(url, blob);
        return blob;
      }
      if (!inFlight.has(url)) {
        inFlight.set(url, fetchMusicVideoPreviewAsset(url)
          .then((blob) => { remember(cache, url, blob); return blob; }, () => null)
          .finally(() => inFlight.delete(url)));
      }
      return inFlight.get(url);
    };
    const onMessage = async (event) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = event.data || {};
      const state = seekState.current;
      if (message.type === 'portos-mv:loaded') {
        // The manifest only: each file is fetched when the document first asks for it, so the first
        // frame waits on the media near the playhead rather than on every take in the project.
        event.source.postMessage({ type: 'portos-mv:manifest', keys: [...byKey.keys()] }, '*');
        showStatus();
        state.ready = true;
        postSeek(t);
      } else if (message.type === 'portos-mv:request') {
        const key = String(message.key);
        const asset = byKey.get(key);
        const blob = asset ? await mediaFor(asset.url) : null;
        if (!blob) { missing = true; showStatus(); }
        if (active) event.source.postMessage({ type: 'portos-mv:asset', key, blob }, '*');
      } else if (message.type === 'portos-mv:seeked') {
        if (firstFrame) { firstFrame = false; showStatus(); }
        state.inFlight = false;
        if (state.pending != null) { const next = state.pending; state.pending = null; postSeek(next); }
      } else if (message.type === 'portos-mv:error') {
        firstFrame = false;
        showStatus();
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
    seek(seekRequest.t);
    // A storyboard row asks to play from the shot (`play`); a scene card only cues it.
    if (seekRequest.play && audioRef.current) { audioRef.current.play?.()?.catch?.(() => {}); setPlaying(true); }
    else { audioRef.current?.pause?.(); setPlaying(false); }
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
    <div className="space-y-2" aria-label={lyrics ? 'Lyric timing playthrough' : 'Composition preview'}>
      {previewError && <p className="text-xs text-port-error" role="alert">{previewError}</p>}
      {status && <p className="text-xs text-port-text-muted">{status}</p>}
      <div className={`overflow-hidden rounded border border-port-border bg-black mx-auto ${collapsed ? 'max-xl:hidden' : ''}`}
        style={{ aspectRatio: aspect, maxHeight: '70vh', maxWidth: '100%' }}>
        {preview?.html ? (
          <iframe ref={iframeRef} title={lyrics ? 'Lyric timing playthrough' : draft ? 'Composition candidate preview' : 'Composition document preview'} sandbox="allow-scripts" srcDoc={preview.html} className="h-full w-full" />
        ) : (
          <p className="p-3 text-xs text-port-text-muted">{previewError ? '' : 'Building the preview…'}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonCls} onClick={togglePlay} disabled={!preview || !audioUrl || (!!previewError && !playing)}>
          {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}
        </button>
        <label htmlFor={scrubId} className="sr-only">{lyrics ? 'Scrub the lyric playthrough' : draft ? 'Scrub the composition candidate' : 'Scrub the composition preview'}</label>
        <input disabled={!preview || !!previewError} id={scrubId} type="range" min={0} max={duration || 0} step={1 / fps} value={Math.min(t, duration || 0)}
          onChange={(e) => { audioRef.current?.pause(); setPlaying(false); seek(Number(e.target.value)); }}
          className="min-w-0 flex-1" />
        <span className="text-xs text-port-text-muted tabular-nums">{previewError ? 'Preview unavailable' : preview ? `${t.toFixed(2)}s / ${duration.toFixed(1)}s` : !wanted ? 'Expand to load preview' : 'Loading preview…'}</span>
      </div>
      {lyric && !lyrics && <p className="text-xs italic break-words" aria-live="off" data-testid="preview-lyric">♪ {lyric}</p>}
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="none" className="hidden" onEnded={() => setPlaying(false)} />}
    </div>
  );
}
