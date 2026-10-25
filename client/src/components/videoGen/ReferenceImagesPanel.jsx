/**
 * Ordered references for a reference-to-video model (FastH3 Omni). The
 * first-frame input above is image 1; the image rows here follow it, so the
 * model's own ceiling is `maxImages - 1` rows. Images are gallery-only like
 * keyframes; clips are prior renders; voices are uploaded audio files. The
 * model reads them in that order: images, then clips, then voices.
 */
import { ListPlus, Upload, X } from 'lucide-react';
import GalleryPickButton from './GalleryPickButton';
import ImagePreview from './ImagePreview';

export default function ReferenceImagesPanel({
  maxImages, files = [], onAdd, onBrowse, onRemove,
  maxVideos = 0, videoIds = [], history = [], onAddVideo, onPickVideo, onRemoveVideo,
  maxAudios = 0, audioFiles = [], onAddAudio, onRemoveAudio,
}) {
  const maxExtra = Math.max(0, maxImages - 1);
  return (
    <section aria-label="Reference images" className="space-y-2 border border-port-border rounded p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-300">Reference images</h3>
        <span className="text-[10px] text-gray-500">{files.length + 1}/{maxImages} incl. input image</span>
      </div>
      {files.map((file, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="flex-1 space-y-1">
            <GalleryPickButton
              label={`Reference image ${i + 2}`}
              filled={!!file}
              onClick={() => onBrowse(i)}
            />
            {file && <ImagePreview src={`/data/images/${file}`} alt={`Reference image ${i + 2}`} label={file} />}
          </div>
          <button
            type="button"
            onClick={() => onRemove(i)}
            aria-label={`Remove reference image ${i + 2}`}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center mt-1 p-1 text-gray-400 hover:text-port-error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={onAdd}
        disabled={files.length >= maxExtra}
        className="flex items-center gap-1.5 text-[11px] text-port-accent hover:text-port-accent/80 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ListPlus className="w-3.5 h-3.5" /> Add reference image
      </button>
      <p className="text-[10px] text-gray-500 leading-snug">
        The input image is read first, then these in order. Pull from your gallery only.
      </p>
      {maxVideos > 0 && (
        <div className="space-y-1.5 border-t border-port-border/50 pt-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-gray-400">Reference clips</span>
            <span className="text-[10px] text-gray-500">{videoIds.length}/{maxVideos}</span>
          </div>
          {videoIds.map((id, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                value={id}
                onChange={(e) => onPickVideo(i, e.target.value)}
                aria-label={`Reference clip ${i + 1}`}
                className="flex-1 min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-port-accent"
              >
                <option value="">Pick a previous render…</option>
                {history.slice(0, 50).map((v) => (
                  <option key={v.id} value={v.id}>{(v.prompt || v.filename || v.id).slice(0, 80)}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => onRemoveVideo(i)}
                aria-label={`Remove reference clip ${i + 1}`}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-port-error"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={onAddVideo}
            disabled={videoIds.length >= maxVideos}
            className="flex items-center gap-1.5 text-[11px] text-port-accent hover:text-port-accent/80 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ListPlus className="w-3.5 h-3.5" /> Add reference clip
          </button>
        </div>
      )}
      {maxAudios > 0 && (
        <div className="space-y-1.5 border-t border-port-border/50 pt-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-gray-400">Voice references</span>
            <span className="text-[10px] text-gray-500">{audioFiles.length}/{maxAudios}</span>
          </div>
          {audioFiles.map((file, i) => (
            <div key={i} className="flex items-center gap-2 text-[11px] text-gray-300">
              <span className="flex-1 min-w-0 truncate" title={file.name}>{file.name}</span>
              <button
                type="button"
                onClick={() => onRemoveAudio(i)}
                aria-label={`Remove voice reference ${i + 1}`}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-port-error"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {audioFiles.length < maxAudios && (
            <>
              <label
                htmlFor="reference-audio-input"
                className="inline-flex items-center gap-1.5 text-[11px] text-port-accent hover:text-port-accent/80 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" /> Add voice reference
              </label>
              <input
                id="reference-audio-input"
                type="file"
                accept="audio/*"
                className="sr-only"
                onChange={(e) => {
                  const picked = e.target.files?.[0];
                  if (picked) onAddAudio(picked);
                  e.target.value = '';
                }}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
