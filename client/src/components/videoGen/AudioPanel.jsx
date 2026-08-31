/**
 * Audio-to-video (a2v) upload panel. The uploaded
 * WAV/MP3/M4A drives the video's motion + audio track and is previewable before
 * the render is submitted.
 *
 * Presentational — the selected File, frame/fps (for the length hint), and the
 * "no compatible model installed" condition are owned by the VideoGen page.
 */
import { useEffect, useState } from 'react';
import { Upload, Music } from 'lucide-react';
import { formatBytes, formatDurationSec } from '../../utils/formatters';
import FilePickerButton from '../ui/FilePickerButton';

export default function AudioPanel({
  audioFile,
  numFrames,
  fps,
  hasCompatibleModel,
  audioDurationDriven = false,
  arbitraryLengthAudio = false,
  maxReferenceAudioSeconds = 15,
  maxDurationSeconds = null,
  durationError = null,
  onDurationChange = null,
  onPick,
  onClear,
}) {
  const [audioDuration, setAudioDuration] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');

  useEffect(() => {
    setAudioDuration(null);
    onDurationChange?.(null);
    if (!audioFile) {
      setPreviewUrl('');
      return undefined;
    }
    const nextPreviewUrl = URL.createObjectURL(audioFile);
    setPreviewUrl(nextPreviewUrl);
    return () => URL.revokeObjectURL(nextPreviewUrl);
  }, [audioFile, onDurationChange]);

  return (
    <div className="border border-port-border/50 rounded-lg p-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-gray-400">Audio (drives motion + sync)</span>
        {audioFile && (
          <button type="button" onClick={onClear} className="text-[11px] text-port-error hover:underline">Clear</button>
        )}
      </div>
      {audioFile ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[11px] text-gray-300">
            <Music className="w-3.5 h-3.5 text-port-accent shrink-0" />
            <span className="truncate" title={audioFile.name}>{audioFile.name}</span>
            <span className="text-gray-500 shrink-0">{formatBytes(audioFile.size, 2)}</span>
            <span className="text-gray-500 shrink-0">
              {audioDuration == null ? 'Reading duration…' : formatDurationSec(audioDuration)}
            </span>
          </div>
          <audio
            aria-label="Preview selected audio"
            className="h-8 w-full"
            controls
            preload="metadata"
            src={previewUrl}
            onLoadedMetadata={(event) => {
              const duration = event.currentTarget.duration;
              const resolved = Number.isFinite(duration) ? duration : null;
              setAudioDuration(resolved);
              onDurationChange?.(resolved);
            }}
          >
            Your browser does not support audio playback.
          </audio>
        </div>
      ) : (
        <FilePickerButton
          accept="audio/*"
          onChange={(e) => onPick(e.target.files?.[0] || null)}
          className="flex items-center gap-2 text-[11px] text-gray-400 hover:text-white"
        >
          <Upload className="w-3.5 h-3.5" />
          <span className="truncate">Upload audio (WAV / MP3 / M4A)</span>
        </FilePickerButton>
      )}
      <p className="text-[10px] text-gray-500 leading-snug">
        {audioDurationDriven
          ? (arbitraryLengthAudio
            ? `Video duration follows the audio. PortOS renders continuity-linked windows of up to ${maxReferenceAudioSeconds}s, then preserves the full source audio on the final video.`
            : (durationError
              ? `Video duration follows the selected audio and snaps to the model's temporal grid${maxDurationSeconds != null ? `, with up to ${maxDurationSeconds.toFixed(1)}s supported per render` : ''}.`
              : `Video duration follows the selected audio and snaps up to ${numFrames} frames on the model's temporal grid${maxDurationSeconds != null ? ` (up to ${maxDurationSeconds.toFixed(1)}s)` : ''}.`))
          : `Audio length should match ${(numFrames / fps).toFixed(1)}s (frames ÷ fps). Longer clips are trimmed to fit; shorter clips fail.`}
      </p>
      {durationError && <p className="text-[11px] text-port-error leading-snug">{durationError}</p>}
      {!hasCompatibleModel && (
        <p className="text-[11px] text-port-warning">No audio-to-video model is available on this instance.</p>
      )}
    </div>
  );
}
