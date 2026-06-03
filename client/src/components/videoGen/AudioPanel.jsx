/**
 * Audio-to-video (a2v) upload panel — dgrauet/ltx2 runtime only. The uploaded
 * WAV/MP3/M4A drives the video's motion + audio track.
 *
 * Presentational — the selected File, frame/fps (for the length hint), and the
 * "no compatible model installed" condition are owned by the VideoGen page.
 */
import { Upload, Music } from 'lucide-react';

export default function AudioPanel({ audioFile, numFrames, fps, hasCompatibleModel, onPick, onClear }) {
  return (
    <div className="border border-port-border/50 rounded-lg p-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-gray-400">Audio (drives motion + sync)</span>
        {audioFile && (
          <button type="button" onClick={onClear} className="text-[11px] text-port-error hover:underline">Clear</button>
        )}
      </div>
      {audioFile ? (
        <div className="flex items-center gap-2 text-[11px] text-gray-300">
          <Music className="w-3.5 h-3.5 text-port-accent" />
          <span className="truncate" title={audioFile.name}>{audioFile.name}</span>
          <span className="text-gray-500">{(audioFile.size / 1024 / 1024).toFixed(2)} MB</span>
        </div>
      ) : (
        <label className="flex items-center gap-2 text-[11px] text-gray-400 cursor-pointer hover:text-white">
          <Upload className="w-3.5 h-3.5" />
          <span className="truncate">Upload audio (WAV / MP3 / M4A)</span>
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => onPick(e.target.files?.[0] || null)}
            className="hidden"
          />
        </label>
      )}
      <p className="text-[10px] text-gray-500 leading-snug">
        Audio length should match {`${(numFrames / fps).toFixed(1)}s`} (frames ÷ fps). Longer clips are trimmed to fit; shorter clips fail.
      </p>
      {!hasCompatibleModel && (
        <p className="text-[11px] text-port-warning">
          a2v requires an ltx2-runtime model, but none are installed. Add a dgrauet entry to{' '}
          <code>data/media-models.json</code> (or restore <code>ltx23_dgrauet_q4</code> / <code>_q8</code>{' '}
          from the built-in defaults), then provision the runtime via{' '}
          <code>INSTALL_LTX2=1 bash scripts/setup-image-video.sh</code>.
        </p>
      )}
    </div>
  );
}
