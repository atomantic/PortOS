/**
 * Audio-to-video (a2v) upload panel — dgrauet/ltx2 runtime only. The uploaded
 * WAV/MP3/M4A drives the video's motion + audio track.
 *
 * Presentational — the selected File, frame/fps (for the length hint), and the
 * "no compatible model installed" condition are owned by the VideoGen page.
 */
import { Upload, Music } from 'lucide-react';
import { formatBytes } from '../../utils/formatters';
import FilePickerButton from '../ui/FilePickerButton';
import Ltx2RuntimeMissingNotice from './Ltx2RuntimeMissingNotice';

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
          <span className="text-gray-500">{formatBytes(audioFile.size, 2)}</span>
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
        Audio length should match {`${(numFrames / fps).toFixed(1)}s`} (frames ÷ fps). Longer clips are trimmed to fit; shorter clips fail.
      </p>
      {!hasCompatibleModel && <Ltx2RuntimeMissingNotice subject="a2v" />}
    </div>
  );
}
