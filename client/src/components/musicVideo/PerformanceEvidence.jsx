import { useEffect, useRef, useState } from 'react';
import { formatTimecode, formatUsd } from '../../utils/formatters.js';
import { clipAudioOffsetSec } from '../../lib/musicVideoShotTiming.js';

const CONDITIONING_LABELS = { 'vocal-stem': 'vocal stem', master: 'full mix' };
const formatSeconds = (sec) => (Number.isFinite(sec) ? `${sec} s` : 'a few seconds');

/** One transport: muted output picture against the take's recorded source.
 * Word windows are clip-relative; temporal evidence is excerpt-relative.
 */

export default function PerformanceEvidence({ clipSrc, instruction, temporal = null, excerptStartSec = 0, repair = null, onRepair, repairBusy = false }) {
  const video = useRef(null);
  const audio = useRef(null);
  const [sourceMuted, setSourceMuted] = useState(false);
  const [error, setError] = useState(null);
  const conditioning = instruction?.audio?.conditioning;
  const filename = conditioning?.filename;
  const source = filename ? `/data/music/${encodeURIComponent(filename)}` : null;
  const windowStart = instruction?.audioWindow?.startSec;
  // Word windows and the source are window time; an aligned clip's window starts this far in.
  const offset = clipAudioOffsetSec(instruction);
  const canSync = source && Number.isFinite(windowStart);
  const cues = Array.isArray(instruction?.cues) ? instruction.cues : [];
  // The provider needs a minimum length of audio (MiniMax H3: 5 s), so a short shot's
  // take holds song on either side of it; the edit points are the shot inside the clip.
  const inSec = Number.isFinite(instruction?.edit?.inSec) ? instruction.edit.inSec : 0;
  const outSec = Number.isFinite(instruction?.edit?.outSec) ? instruction.edit.outSec : null;
  // A "Whole sung line" take (#11364) is meant to be reviewed whole, so its words and playback
  // cover the line; any other take covers just the shot.
  const wholeLine = instruction?.audioWindow?.wholeLine;
  const lineFrom = wholeLine && Number.isFinite(windowStart) ? wholeLine.startSec - windowStart + offset : null;
  const lineTo = lineFrom != null ? wholeLine.endSec - windowStart + offset : null;
  const spanFrom = lineFrom ?? inSec;
  const spanTo = lineFrom != null ? lineTo : outSec;
  const inShot = (startSec, endSec) => endSec + offset > spanFrom + 1e-3 && (spanTo == null || startSec + offset < spanTo - 1e-3);
  // Only the shot's own words, by name; takes made before the text was carried have none to show.
  const words = cues.flatMap((cue) => (cue.words?.length ? cue.words : [cue]))
    .filter((word) => Number.isFinite(word.startSec) && Number.isFinite(word.endSec) && inShot(word.startSec, word.endSec))
    .map((word) => ({ ...word, label: (word.text || word.w || '').trim() }))
    .filter((word) => word.label);
  // A measured verdict only exists when the optional local analyzer ran; without one
  // there is nothing for the user to act on, so the panel stays quiet about it.
  const measured = !!temporal?.analyzer;
  const playFrom = useRef(null);
  const windowSec = instruction?.audioWindow?.durationSec;
  const padded = lineFrom == null && outSec != null && Number.isFinite(windowSec) && outSec - inSec < windowSec - 0.05;

  useEffect(() => {
    const picture = video.current;
    const recording = audio.current;
    setError(null);
    return () => { picture?.pause(); recording?.pause(); };
  }, [clipSrc, source]);

  const sync = () => {
    if (!canSync || !audio.current || !video.current) return;
    const target = windowStart + video.current.currentTime - offset;
    if (Math.abs(audio.current.currentTime - target) > 0.05) audio.current.currentTime = target;
  };
  const pause = () => audio.current?.pause();
  // Playing from inside the shot stops at its out point, so the review hears only this shot.
  const stopAtOut = () => {
    sync();
    const picture = video.current;
    if (picture && lineFrom == null && outSec != null && playFrom.current != null && playFrom.current < outSec - 0.05 && picture.currentTime >= outSec) {
      playFrom.current = null;
      picture.pause();
    }
  };
  const play = () => {
    playFrom.current = video.current?.currentTime ?? null;
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
        onPlay={play} onPause={pause} onEnded={pause} onSeeking={sync} onTimeUpdate={stopAtOut}
        onLoadedMetadata={() => seek(instruction?.edit?.inSec || 0)} />
      {source && <audio ref={audio} src={source} muted={sourceMuted} preload="metadata" onLoadedMetadata={sync}
        onError={() => { video.current?.pause(); setError('Recorded source unavailable — check the audio file'); }} />}
      {canSync && <button type="button" aria-pressed={sourceMuted} onClick={() => setSourceMuted((value) => !value)}
        className="rounded border border-port-border px-2 py-1 min-h-[44px] sm:min-h-0">{sourceMuted ? 'Unmute source' : 'Mute source'}</button>}
      <p>Speaker: {instruction?.speaker || 'Unspecified'} · Audio: {CONDITIONING_LABELS[conditioning?.source] || conditioning?.source || 'Unknown'}</p>
      {lineFrom != null && outSec != null && <p className="text-port-text-muted">This take holds the whole sung line ({formatTimecode(wholeLine.startSec)}–{formatTimecode(wholeLine.endSec)} of the song). The final render uses {formatTimecode(inSec)}–{formatTimecode(outSec)} of it.</p>}
      {padded && <p className="text-port-text-muted">The model needs at least {formatSeconds(instruction?.capability?.minAudioSec)} of song, so this take runs longer than the shot. The final render uses {formatTimecode(inSec)}–{formatTimecode(outSec)} of it, and play stops there.</p>}
      {!canSync && <p className="text-port-warning">Recorded source unavailable — review needed</p>}
      {error && <p role="status" className="text-port-warning">{error}</p>}
      {words.length > 0 && <div className="flex flex-wrap items-center gap-1" aria-label="Jump to a word">
        <span className="text-port-text-muted">Jump to</span>
        {words.map((word, i) => (
          <button type="button" key={i} onClick={() => seek(word.startSec + offset)}
            className="rounded border border-port-border px-2 py-1 min-h-[44px] sm:min-h-0"
            title={`${formatTimecode(word.startSec + offset)}–${formatTimecode(word.endSec + offset)} in the clip`}>
            {word.label}
          </button>
        ))}
      </div>}
      {measured && <p className="text-port-text-muted">Measured lip-sync: {temporal.lipSync || temporal.status} · {temporal.analyzer.id} {temporal.analyzer.version}</p>}
      {repair && (repair.ok || measured) && <div className="rounded border border-port-border p-2 space-y-1" aria-label="Suffix repair">
        {repair.ok && onRepair ? <>
          <p>Keep accepted prefix through {formatTimecode(repair.boundarySec)}. Continue only {formatTimecode(repair.boundarySec)}–{formatTimecode(repair.endSec)} (song time).</p>
          <p>Next spend: {formatUsd(repair.costUsd)} · one generation · accepted boundary frame</p>
          <button type="button" disabled={repairBusy} onClick={onRepair}
            className="rounded border border-port-border px-2 py-1 min-h-[44px] sm:min-h-0 disabled:opacity-50">{repairBusy ? 'Repairing…' : 'Repair from here'}</button>
        </> : <p className="text-port-warning">{repair.ok ? 'Review needed: update the authored composition edit points before continuing' : repair.message}</p>}
      </div>}
      {measured && <ul className="space-y-1" aria-label="Temporal evidence spans">
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
      </ul>}
    </div>
  );
}
