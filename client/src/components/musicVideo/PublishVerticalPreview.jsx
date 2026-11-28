import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import {
  VERTICAL_FOOTER_HEIGHT,
  VERTICAL_FOOTER_Y,
  VERTICAL_FRAME_HEIGHT,
  VERTICAL_FRAME_THEMES,
  VERTICAL_FRAME_THEME_IDS,
  VERTICAL_FRAME_WIDTH,
  masterBurnsOverlayLyrics,
  projectTimedLyricLines,
  resolveVerticalFrameTheme,
  verticalFrameDynamicSvg,
  verticalFrameStaticSvg,
  verticalSafeZonesSvg,
} from '../../../../server/lib/musicVideo/musicVideoVerticalFrame.js';

const toSvgDataUri = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const pct = (value, total) => `${(value / total) * 100}%`;
const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Live 9:16 vertical phone preview for the framed 16:9 layout (header + footer inside TikTok's
 * safe-render window). Renders the exact same shared SVG chrome and synced footer that the
 * server encoder composites onto the final 1080x1920 MP4.
 */
export default function PublishVerticalPreview({
  project,
  span,
  frame,
  onSpanChange,
  onFrameChange,
  disabled = false,
}) {
  const id = useId();
  const videoRef = useRef(null);
  const backdropRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [durationSec, setDurationSec] = useState(() => Number(project?.audioAnalysis?.durationSec) || 0);
  const [timeSec, setTimeSec] = useState(0);
  const [showSafeZones, setShowSafeZones] = useState(true);
  const [mediaError, setMediaError] = useState(null);

  const theme = resolveVerticalFrameTheme(frame.theme);
  const lyrics = useMemo(() => projectTimedLyricLines(project), [project]);
  const beats = useMemo(() => (Array.isArray(project?.audioAnalysis?.beats) ? project.audioAnalysis.beats : []), [project?.audioAnalysis?.beats]);
  const masterHasLyrics = masterBurnsOverlayLyrics(project);
  const totalSec = Math.max(1, durationSec || Number(project?.audioAnalysis?.durationSec) || 1);

  const staticUri = useMemo(
    () => toSvgDataUri(verticalFrameStaticSvg({ theme: theme.id, title: frame.title, subtitle: frame.subtitle })),
    [theme.id, frame.title, frame.subtitle],
  );
  const safeZonesUri = useMemo(() => toSvgDataUri(verticalSafeZonesSvg()), []);
  // Quantize footer SVG updates to ~10 Hz so playback stays smooth without re-encoding on every vblank.
  const quantizedTime = Math.floor(timeSec * 10) / 10;
  const dynamicUri = useMemo(
    () => toSvgDataUri(verticalFrameDynamicSvg({
      theme: theme.id,
      timeSec: quantizedTime,
      startSec: 0,
      endSec: totalSec,
      lyrics,
      beats,
      showLyrics: Boolean(frame.showLyrics) && lyrics.length > 0,
      showWaveform: frame.showWaveform !== false,
      footerNote: frame.footerNote,
    })),
    [theme.id, quantizedTime, totalSec, lyrics, beats, frame.showLyrics, frame.showWaveform, frame.footerNote],
  );

  // Paint a soft ambient cover backdrop from the single foreground video onto a tiny canvas.
  const paintBackdrop = () => {
    const video = videoRef.current;
    const canvas = backdropRef.current;
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.max(cw / video.videoWidth, ch / video.videoHeight);
    const dw = video.videoWidth * scale;
    const dh = video.videoHeight * scale;
    ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  };

  useEffect(() => {
    if (!playing) return undefined;
    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video) {
        setTimeSec(video.currentTime || 0);
        paintBackdrop();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    const next = !muted;
    setMuted(next);
    if (video) video.muted = next;
  };

  const scrub = (event) => {
    const next = Number(event.target.value);
    setTimeSec(next);
    const video = videoRef.current;
    if (video) video.currentTime = next;
  };

  const videoSrc = project?.id && project?.renderHistoryId
    ? `/api/music-video/${encodeURIComponent(project.id)}/publish-kit/video?render=${encodeURIComponent(project.renderHistoryId)}`
    : null;
  const { x, y, width, height, radius } = theme.videoRect;

  return (
    <div className="rounded border border-port-border bg-port-bg/40 p-3 text-xs space-y-3" data-testid="publish-vertical-preview">
      <div className="grid gap-4 md:grid-cols-[240px_minmax(0,1fr)] items-start">
        <div className="mx-auto w-full max-w-[240px] space-y-2">
          <div className="relative aspect-[9/16] w-full overflow-hidden rounded-lg border border-port-border bg-black">
            <canvas ref={backdropRef} width={135} height={240}
              className="pointer-events-none absolute inset-0 h-full w-full"
              style={{ filter: `blur(${Math.round(theme.backdropBlurPx * 0.45)}px) brightness(${(1 - theme.backdropDim * 0.55).toFixed(2)}) saturate(1.12)`, transform: 'scale(1.12)' }} />
            <div className="absolute overflow-hidden bg-black"
              style={{
                left: pct(x, VERTICAL_FRAME_WIDTH),
                top: pct(y, VERTICAL_FRAME_HEIGHT),
                width: pct(width, VERTICAL_FRAME_WIDTH),
                height: pct(height, VERTICAL_FRAME_HEIGHT),
                borderRadius: radius ? `${Math.round(radius * 0.25)}px` : undefined,
              }}>
              {videoSrc && (
                <video
                  ref={videoRef}
                  src={videoSrc}
                  muted={muted}
                  playsInline
                  preload="metadata"
                  aria-label="Framed vertical preview"
                  className="block h-full w-full object-contain"
                  onLoadedMetadata={(event) => {
                    const sec = event.currentTarget.duration;
                    if (Number.isFinite(sec) && sec > 0) setDurationSec(sec);
                    setMediaError(null);
                  }}
                  onLoadedData={paintBackdrop}
                  onSeeked={() => {
                    if (videoRef.current) setTimeSec(videoRef.current.currentTime || 0);
                    paintBackdrop();
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                  onError={() => setMediaError('Could not load the final render video for preview.')}
                />
              )}
            </div>
            <img src={staticUri} alt="" aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />
            <img src={dynamicUri} alt="" aria-hidden="true" className="pointer-events-none absolute left-0 w-full"
              style={{ top: pct(VERTICAL_FOOTER_Y, VERTICAL_FRAME_HEIGHT), height: pct(VERTICAL_FOOTER_HEIGHT, VERTICAL_FRAME_HEIGHT) }} />
            {showSafeZones && (
              <img src={safeZonesUri} alt="" aria-hidden="true" data-testid="tiktok-safe-zones"
                className="pointer-events-none absolute inset-0 h-full w-full" />
            )}
          </div>
          {mediaError && <p role="status" className="text-port-error">{mediaError}</p>}
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={togglePlay} aria-label={playing ? 'Pause vertical preview' : 'Play vertical preview'}
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded border border-port-border bg-port-bg text-port-text hover:border-port-accent pointer-fine:sm:min-h-[28px] pointer-fine:sm:min-w-[28px]">
              {playing ? <Pause size={13} /> : <Play size={13} />}
            </button>
            <button type="button" onClick={toggleMute} aria-label={muted ? 'Unmute vertical preview' : 'Mute vertical preview'}
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded border border-port-border bg-port-bg text-port-text hover:border-port-accent pointer-fine:sm:min-h-[28px] pointer-fine:sm:min-w-[28px]">
              {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>
            <label htmlFor={`${id}-scrub`} className="sr-only">Vertical preview time</label>
            <input id={`${id}-scrub`} type="range" min={0} max={totalSec} step={0.1} value={Math.min(timeSec, totalSec)}
              onChange={scrub} className="min-w-0 flex-1 accent-port-accent min-h-[44px] pointer-fine:sm:min-h-0" />
            <span className="shrink-0 tabular-nums text-port-text-muted">{fmtTime(timeSec)} / {fmtTime(totalSec)}</span>
          </div>
        </div>

        <div className="min-w-0 space-y-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <label htmlFor={`${id}-span`} className="text-port-text-muted">Vertical length</label>
              <select id={`${id}-span`} value={span} disabled={disabled}
                onChange={(event) => onSpanChange(event.target.value)}
                className="rounded border border-port-border bg-port-bg px-2 py-1 min-h-11 pointer-fine:sm:min-h-0 disabled:opacity-50">
                <option value="full">Full video (TikTok)</option>
                <option value="hook">Hook slice</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label htmlFor={`${id}-theme`} className="text-port-text-muted">Frame theme</label>
              <select id={`${id}-theme`} value={theme.id} disabled={disabled}
                onChange={(event) => onFrameChange({ theme: event.target.value })}
                className="rounded border border-port-border bg-port-bg px-2 py-1 min-h-11 pointer-fine:sm:min-h-0 disabled:opacity-50">
                {VERTICAL_FRAME_THEME_IDS.map((themeId) => (
                  <option key={themeId} value={themeId}>{VERTICAL_FRAME_THEMES[themeId].label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor={`${id}-title`} className="block text-port-text-muted">Header title</label>
              <input id={`${id}-title`} type="text" maxLength={120} value={frame.title || ''} disabled={disabled}
                onChange={(event) => onFrameChange({ title: event.target.value })}
                placeholder="Song title"
                className="w-full rounded border border-port-border bg-port-bg px-2 py-1 min-h-11 pointer-fine:sm:min-h-0 disabled:opacity-50" />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${id}-subtitle`} className="block text-port-text-muted">Header subtitle</label>
              <input id={`${id}-subtitle`} type="text" maxLength={160} value={frame.subtitle || ''} disabled={disabled}
                onChange={(event) => onFrameChange({ subtitle: event.target.value })}
                placeholder="Artist · Official Music Video"
                className="w-full rounded border border-port-border bg-port-bg px-2 py-1 min-h-11 pointer-fine:sm:min-h-0 disabled:opacity-50" />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor={`${id}-footer`} className="block text-port-text-muted">Footer note (optional)</label>
            <input id={`${id}-footer`} type="text" maxLength={120} value={frame.footerNote || ''} disabled={disabled}
              onChange={(event) => onFrameChange({ footerNote: event.target.value })}
              placeholder="e.g. Headphones on · Full story"
              className="w-full rounded border border-port-border bg-port-bg px-2 py-1 min-h-11 pointer-fine:sm:min-h-0 disabled:opacity-50" />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5">
            <label htmlFor={`${id}-lyrics`} className="inline-flex items-center gap-1.5 min-h-11 pointer-fine:sm:min-h-0">
              <input id={`${id}-lyrics`} type="checkbox" checked={Boolean(frame.showLyrics) && lyrics.length > 0}
                disabled={disabled || lyrics.length === 0}
                onChange={(event) => onFrameChange({ showLyrics: event.target.checked })} />
              Footer synced lyrics
            </label>
            <label htmlFor={`${id}-waveform`} className="inline-flex items-center gap-1.5 min-h-11 pointer-fine:sm:min-h-0">
              <input id={`${id}-waveform`} type="checkbox" checked={frame.showWaveform !== false} disabled={disabled}
                onChange={(event) => onFrameChange({ showWaveform: event.target.checked })} />
              Beat waveform &amp; progress
            </label>
            <label htmlFor={`${id}-safe`} className="inline-flex items-center gap-1.5 min-h-11 pointer-fine:sm:min-h-0">
              <input id={`${id}-safe`} type="checkbox" checked={showSafeZones}
                onChange={(event) => setShowSafeZones(event.target.checked)} />
              Show TikTok safe zones
            </label>
          </div>

          {lyrics.length === 0 ? (
            <p className="text-port-text-muted">No timed lyric cues on this project — footer lyrics stay off.</p>
          ) : masterHasLyrics ? (
            <p className="text-port-text-muted">
              The 16:9 master already draws overlay lyrics; leave footer lyrics off to avoid doubling them, or disable overlay lyrics on the project before re-rendering if you want them only in the footer.
            </p>
          ) : (
            <p className="text-port-text-muted">
              Keeps the full 16:9 frame clear of TikTok&apos;s top tabs, right action buttons and bottom caption area.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
