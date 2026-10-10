import { useCallback, useEffect, useRef, useState } from 'react';
import { Captions } from 'lucide-react';
import { formatDurationSec } from '../../utils/formatters.js';
import { getMusicVideoLyricOverlayPreview } from '../../services/apiMusicVideo.js';
import { playthroughVersion } from './CompositionPreviewPlayer.jsx';

const timedShots = (scenes) => scenes.filter((scene) => Number.isFinite(scene?.startSec)).sort((a, b) => a.startSec - b.startSec);

/** The shot on screen at song time `t`: the last one that has started. */
export function shotAt(scenes, t) {
  const timed = timedShots(scenes);
  let current = timed[0] || null;
  for (const scene of timed) {
    if (scene.startSec <= t) current = scene;
    else break;
  }
  return current;
}

// The overlay page needs the song's analysis and at least one timed line (else the server answers 409).
const hasTimedLyrics = (project) => Number(project.audioAnalysis?.durationSec) > 0
  && (project.lyricCues || []).some((cue) => Number.isFinite(cue?.startSec) && String(cue?.text || '').trim());

/**
 * The sung words over the animatic: the server's words-only page (the final
 * render's lyric type, in each shot's text zone, on a transparent frame) in a
 * sandboxed iframe laid over the picture. Like the composition preview it
 * answers the page's `portos-mv:*` bridge (it has no media to ask for) and
 * drives it with seek messages, one in flight at a time, every animation frame
 * while the song plays. Returns the overlay element, or null while there is
 * nothing to draw.
 */
function useLyricOverlay({ project, enabled, audioRef, time }) {
  const [preview, setPreview] = useState(null);
  const [failed, setFailed] = useState(false);
  const iframeRef = useRef(null);
  const seekState = useRef({ inFlight: false, pending: null, ready: false });
  const version = enabled ? playthroughVersion(project) : null;

  useEffect(() => {
    let active = true;
    setPreview(null);
    setFailed(false);
    seekState.current = { inFlight: false, pending: null, ready: false };
    if (!version) return () => { active = false; };
    getMusicVideoLyricOverlayPreview(project.id, { silent: true })
      .then((next) => { if (active) setPreview(next); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [project.id, version]);

  const postSeek = useCallback((t) => {
    const frame = iframeRef.current?.contentWindow;
    const state = seekState.current;
    if (!frame || !state.ready) return;
    if (state.inFlight) { state.pending = t; return; }
    state.inFlight = true;
    frame.postMessage({ type: 'portos-mv:seek', t }, '*');
  }, []);

  useEffect(() => {
    if (!preview) return undefined;
    const onMessage = (event) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = event.data || {};
      const state = seekState.current;
      if (message.type === 'portos-mv:loaded') {
        event.source.postMessage({ type: 'portos-mv:manifest', keys: [] }, '*');
        state.ready = true;
        postSeek(audioRef.current?.currentTime || 0);
      } else if (message.type === 'portos-mv:request') {
        event.source.postMessage({ type: 'portos-mv:asset', key: String(message.key), blob: null }, '*');
      } else if (message.type === 'portos-mv:seeked') {
        state.inFlight = false;
        if (state.pending != null) { const next = state.pending; state.pending = null; postSeek(next); }
      } else if (message.type === 'portos-mv:error') {
        setFailed(true);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [preview, postSeek, audioRef]);

  // A scrub, a seek or a pause lands through `time`; playback runs on animation frames,
  // since the audio's timeupdate is far too coarse for words landing on their onsets.
  useEffect(() => { postSeek(time); }, [time, postSeek]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!preview || !audio) return undefined;
    let handle = 0;
    const tick = () => {
      postSeek(audio.currentTime || 0);
      handle = requestAnimationFrame(tick);
    };
    const start = () => { cancelAnimationFrame(handle); handle = requestAnimationFrame(tick); };
    const stop = () => cancelAnimationFrame(handle);
    audio.addEventListener('play', start);
    audio.addEventListener('pause', stop);
    audio.addEventListener('ended', stop);
    if (!audio.paused) start();
    return () => {
      stop();
      audio.removeEventListener('play', start);
      audio.removeEventListener('pause', stop);
      audio.removeEventListener('ended', stop);
    };
  }, [preview, postSeek, audioRef]);

  if (!preview?.html || failed) return { overlay: null, failed };
  return {
    failed,
    overlay: (
      <iframe
        ref={iframeRef}
        title="Lyrics over the storyboard animatic"
        sandbox="allow-scripts"
        srcDoc={preview.html}
        // `color-scheme: normal` keeps the frame transparent under a dark parent page.
        style={{ colorScheme: 'normal' }}
        className="pointer-events-none absolute inset-0 h-full w-full border-0 bg-transparent"
        data-testid="animatic-lyrics"
      />
    ),
  };
}

/**
 * Something to watch before anything is rendered: the master song under the
 * storyboard, showing each shot's selected frame (or, without one, its label,
 * time and intent) as the song reaches it, with the aligned lyrics drawn over
 * it once the words are timed (a toggle hides them). `seekRequest`
 * (`{ t, n }`) is the scene-card seek the other preview sources honour too.
 */
export default function StoryboardAnimatic({ project, audioUrl, seekRequest, collapsed }) {
  const audioRef = useRef(null);
  const applied = useRef(null);
  const [time, setTime] = useState(0);
  const [lyricsOn, setLyricsOn] = useState(true);
  const scenes = project.scenes || [];
  const lyricsAvailable = hasTimedLyrics(project);
  const { overlay, failed } = useLyricOverlay({ project, enabled: lyricsAvailable && lyricsOn, audioRef, time });
  useEffect(() => {
    if (!seekRequest || applied.current === seekRequest.n || !audioRef.current) return;
    applied.current = seekRequest.n;
    audioRef.current.currentTime = seekRequest.t;
    setTime(seekRequest.t);
    if (seekRequest.play) audioRef.current.play?.()?.catch?.(() => {});
  }, [seekRequest]);
  const shot = shotAt(scenes, time);
  const timed = timedShots(scenes);
  const index = shot ? timed.indexOf(shot) : -1;
  const label = shot ? shot.label || `Shot ${index + 1}` : 'No shots yet';
  // With the lyrics drawn over the picture, a shot without a frame keeps its label and
  // intent under the picture instead, so no stand-in text sits under the sung words.
  const cardInFrame = !overlay;
  return (
    <div className={`space-y-2 ${collapsed ? 'max-xl:hidden' : ''}`}>
      <figure aria-label="Storyboard animatic" className="relative aspect-video w-full overflow-hidden rounded border border-port-border bg-black">
        {shot?.referenceImageId ? (
          <img src={`/data/images/${shot.referenceImageId}`} alt="" className="h-full w-full object-contain" />
        ) : cardInFrame ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-4 text-center">
            <span className="text-sm font-medium text-port-text">{label}</span>
            {shot?.visualIntent && <span className="line-clamp-3 text-xs text-port-text-muted">{shot.visualIntent}</span>}
          </div>
        ) : null}
        {overlay}
      </figure>
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1 text-[11px] text-port-text-muted">
          {shot && <p>Shot {index + 1} of {timed.length} · {formatDurationSec(shot.startSec)}</p>}
          {!cardInFrame && shot && !shot.referenceImageId && (
            <p className="line-clamp-2 break-words">
              <span className="font-medium text-port-text">{label}</span>{shot.visualIntent ? ` · ${shot.visualIntent}` : ''}
            </p>
          )}
          {lyricsOn && failed && <p className="text-port-error">The lyrics could not be drawn over the animatic.</p>}
        </div>
        {lyricsAvailable && (
          <button
            type="button"
            onClick={() => setLyricsOn((on) => !on)}
            aria-pressed={lyricsOn}
            className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded border px-2 text-xs sm:min-h-0 sm:py-1 ${lyricsOn ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}
          >
            <Captions size={14} aria-hidden="true" /> Lyrics
          </button>
        )}
      </div>
      <audio
        ref={audioRef}
        src={audioUrl}
        controls
        preload="metadata"
        aria-label="Song for the storyboard animatic"
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onSeeked={(e) => setTime(e.currentTarget.currentTime)}
        className="w-full"
      />
    </div>
  );
}
