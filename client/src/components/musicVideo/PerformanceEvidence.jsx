import { useEffect, useRef, useState } from 'react';
import { formatTimecode } from '../../utils/formatters.js';

/** One transport: muted output picture against the take's recorded source.
 * Word windows are clip-relative; temporal evidence is excerpt-relative.
 */
export default function PerformanceEvidence({ clipSrc, instruction, temporal = null, excerptStartSec = 0 }) {
  const video = useRef(null);
  const audio = useRef(null);
  const [sourceMuted, setSourceMuted] = useState(false);
  const [error, setError] = useState(null);
  const conditioning = instruction?.audio?.conditioning;
  const filename = conditioning?.filename;
  const source = filename ? `/data/music/${encodeURIComponent(filename)}` : null;
  const windowStart = instruction?.audioWindow?.startSec;
  const canSync = source && Number.isFinite(windowStart);
  const cues = Array.isArray(instruction?.cues) ? instruction.cues : [];

  useEffect(() => {
    const picture = video.current;
    const recording = audio.current;
    setError(null);
    return () => { picture?.pause(); recording?.pause(); };
  }, [clipSrc, source]);

  const sync = () => {
    if (!canSync || !audio.current || !video.current) return;
    const target = windowStart + video.current.currentTime;
    if (Math.abs(audio.current.currentTime - target) > 0.05) audio.current.currentTime = target;
  };
  const pause = () => audio.current?.pause();
  const play = () => {
    if (!canSync) { setError('Recorded source unavailable — playback cannot verify sync'); video.current?.pause(); return; }
    sync();
    // Media events are outside React's request lifecycle.
    audio.current.play().catch(() => { video.current?.pause(); setError('Source playback failed — check the recorded audio'); });
  };
  const seek = (seconds) => { if (video.current) video.current.currentTime = Math.max(0, seconds); sync(); };
  const spans = temporal?.spans || [];

  return (
    <div className="min-w-0 w-full space-y-2 text-xs" aria-label="Performance evidence">
      <video ref={video} src={clipSrc} controls muted playsInline preload="metadata"
        className="w-full max-w-md aspect-video rounded border border-port-border"
        onVolumeChange={() => { if (video.current) video.current.muted = true; }}
        onPlay={play} onPause={pause} onEnded={pause} onSeeking={sync} onTimeUpdate={sync}
        onLoadedMetadata={() => seek(instruction?.edit?.inSec || 0)} />
      {source && <audio ref={audio} src={source} muted={sourceMuted} preload="metadata" onLoadedMetadata={sync}
        onError={() => { video.current?.pause(); setError('Recorded source unavailable — check the audio file'); }} />}
      {canSync && <button type="button" aria-pressed={sourceMuted} onClick={() => setSourceMuted((value) => !value)}
        className="rounded border border-port-border px-2 py-1 min-h-[44px] sm:min-h-0">{sourceMuted ? 'Unmute source' : 'Mute source'}</button>}
      <p>Speaker: {instruction?.speaker || 'Unspecified'} · Conditioning: {conditioning?.source || 'Unknown'}</p>
      <p className="text-port-text-muted">Source and clip play together. Voice isolation is unverified; separation and equal durations do not prove correct lip-sync.</p>
      {!canSync && <p className="text-port-warning">Recorded source unavailable — review needed</p>}
      {error && <p role="status" className="text-port-warning">{error}</p>}
      <div className="flex flex-wrap gap-1" aria-label="Word windows">
        {cues.flatMap((cue, index) => (cue.words?.length ? cue.words : [cue]).map((word, i) => (
          <button type="button" key={`${index}-${i}`} onClick={() => seek(word.startSec)}
            className="rounded border border-port-border px-2 py-1 min-h-[44px] sm:min-h-0"
            title={`${formatTimecode(word.startSec)}–${formatTimecode(word.endSec)} (clip time)`}>
            {word.text} · {formatTimecode(word.startSec)}–{formatTimecode(word.endSec)}
          </button>
        )))}
      </div>
      <p className="text-port-text-muted">Temporal lip-sync: {temporal?.lipSync || 'unverified'}{temporal?.analyzer ? ` · ${temporal.analyzer.id} ${temporal.analyzer.version}` : ' · review needed'}</p>
      {temporal && <p className="text-port-text-muted">Measured evidence: {temporal.status}</p>}
      <ul className="space-y-1" aria-label="Temporal evidence spans">
        {spans.map((span, i) => (
          <li key={i}>
            <button type="button" onClick={() => seek(span.startSec + excerptStartSec - (windowStart || 0))}
              className="text-port-accent min-h-[44px] sm:min-h-0">
              {formatTimecode(span.startSec + excerptStartSec)}–{formatTimecode(span.endSec + excerptStartSec)}
            </button>
            {' · '}{span.status}
            {Number.isFinite(span.offsetSec) && ` · offset ${span.offsetSec.toFixed(3)}s`}
            {Number.isFinite(span.confidence) && ` · confidence ${span.confidence.toFixed(2)}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
