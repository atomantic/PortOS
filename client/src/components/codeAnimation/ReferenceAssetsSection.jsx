import { useState } from 'react';
import { Film, ImagePlus, LoaderCircle, Music2, X } from 'lucide-react';
import GalleryVideoPicker from '../videoGen/GalleryVideoPicker';
import { UPLOAD_IMAGE_ACCEPT } from '../../utils/fileUpload';
import { inputClass, labelClass, fileInputClass, buttonSecondary } from './codeAnimationFields';

export default function ReferenceAssetsSection({ draft, limits, update, assets, onPickTrack }) {
  const {
    maxRefs, handleImages, uploading, updateReference, videoRoom, audioAccept, handleAudio,
  } = assets;
  const [videoPickerOpen, setVideoPickerOpen] = useState(false);

  return (
    <section className="space-y-3 rounded-xl border border-port-border bg-port-card p-4" aria-labelledby="ca-refs-heading">
      <h2 id="ca-refs-heading" className="flex items-center gap-2 text-sm font-semibold text-white"><ImagePlus className="h-4 w-4 text-port-accent" /> References &amp; audio</h2>
      <div>
        <label htmlFor="ca-images" className={labelClass}>Reference images ({draft.referenceImages.length}/{maxRefs})</label>
        <input id="ca-images" type="file" multiple accept={UPLOAD_IMAGE_ACCEPT} onChange={handleImages} disabled={uploading} className={fileInputClass} />
        {draft.referenceImages.length > 0 && (
          <ul className="mt-2 space-y-2">
            {draft.referenceImages.map((ref) => (
              <li key={ref.filename} className="flex items-center gap-2">
                <img src={ref.url} alt={ref.label} className="h-12 w-12 shrink-0 rounded object-cover" />
                <input aria-label={`Note for ${ref.label}`} value={ref.note} maxLength={limits?.referenceNoteMax} onChange={(event) => updateReference(ref.filename, { note: event.target.value })} placeholder="What to take from it (palette, silhouette…)" className={`${inputClass} min-w-0`} />
                <button type="button" aria-label={`Remove ${ref.label}`} onClick={() => update({ referenceImages: draft.referenceImages.filter((item) => item.filename !== ref.filename) })} className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 text-gray-500 hover:text-port-error"><X className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <span className={labelClass}>Reference video <span className="text-gray-600">(optional; the quality bar — its pacing, camera and finish, never its content)</span></span>
        {draft.referenceVideo ? (
          <div className="flex items-center gap-2">
            {draft.referenceVideo.previewUrl
              ? <img src={draft.referenceVideo.previewUrl} alt="" className="h-12 w-20 shrink-0 rounded object-cover" />
              : <Film className="h-5 w-5 shrink-0 text-gray-500" aria-hidden="true" />}
            <input aria-label={`Note for ${draft.referenceVideo.label}`} value={draft.referenceVideo.note} maxLength={limits?.referenceNoteMax} onChange={(event) => update({ referenceVideo: { ...draft.referenceVideo, note: event.target.value } })} placeholder={`${draft.referenceVideo.label}: what to match (cut rhythm, depth of field, grade…)`} className={`${inputClass} min-w-0`} />
            <button type="button" aria-label="Remove reference video" onClick={() => update({ referenceVideo: null })} className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 text-gray-500 hover:text-port-error"><X className="h-4 w-4" /></button>
          </div>
        ) : (
          <button type="button" onClick={() => setVideoPickerOpen(true)} disabled={!videoRoom} title={videoRoom ? undefined : `A reference video needs ${limits?.referenceVideoImageSlots ?? 3} free reference slots`} className="inline-flex items-center gap-1.5 rounded border border-port-border px-2.5 py-1.5 text-xs text-gray-200 hover:border-port-accent disabled:opacity-50">
            <Film className="h-3.5 w-3.5" aria-hidden="true" /> Pick or upload a video…
          </button>
        )}
        <GalleryVideoPicker open={videoPickerOpen} onClose={() => setVideoPickerOpen(false)} allowUpload uploadToGallery
          onSelect={(item) => update({ referenceVideo: { filename: item.filename, label: item.prompt && item.prompt !== '(no prompt)' ? item.prompt.slice(0, 120) : item.filename, note: '', previewUrl: item.previewUrl } })} />
      </div>
      <div>
        <label htmlFor="ca-audio" className={`${labelClass} flex items-center gap-1`}><Music2 className="h-3 w-3" /> Audio track <span className="text-gray-600">(optional; the animation syncs to it)</span></label>
        {draft.audio ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-gray-200">
              <span className="min-w-0 truncate">{draft.audio.label}</span>
              {draft.audio.durationSeconds ? <span className="text-xs text-gray-500">{draft.audio.durationSeconds.toFixed(1)}s</span> : null}
              <span className="rounded bg-port-card-hover px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-gray-400">
                {draft.audio.source === 'track' ? 'Library track' : 'Upload'}
              </span>
              <button type="button" aria-label="Remove audio track" onClick={() => update({ audio: null })} className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 ml-auto text-gray-500 hover:text-port-error"><X className="h-4 w-4" /></button>
            </div>
            <textarea aria-label="Audio notes" rows={2} value={draft.audio.notes} maxLength={limits?.audioNotesMax} onChange={(event) => update({ audio: { ...draft.audio, notes: event.target.value } })} placeholder="120 BPM; soft intro, drop at 0:16, fade at 0:40" className={`${inputClass} resize-y`} />
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <input id="ca-audio" type="file" accept={audioAccept} onChange={handleAudio} disabled={uploading} className={`${fileInputClass} flex-1 min-w-[200px]`} />
              <button
                type="button"
                onClick={onPickTrack}
                className={buttonSecondary}
              >
                <Music2 className="h-3.5 w-3.5" /> Pick from music library
              </button>
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-300">
              <input type="checkbox" checked={draft.soundtrack === 'procedural'} onChange={(event) => update({ soundtrack: event.target.checked ? 'procedural' : 'none' })} />
              No track? Have the code compose a procedural soundtrack
            </label>
            <p className="text-xs text-gray-500">Or generate one with a music model once the preview is ready, under Soundtrack below it.</p>
          </div>
        )}
      </div>
      {uploading && <p className="flex items-center gap-2 text-xs text-gray-400"><LoaderCircle className="h-3 w-3 animate-spin" /> Uploading…</p>}
    </section>
  );
}
