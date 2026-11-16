import { useState } from 'react';
import { Link } from 'react-router';
import { Image as ImageIcon, Loader2, Mic, Plus, Square, Upload } from 'lucide-react';
import toast from '../../ui/Toast';
import FilePickerButton from '../../ui/FilePickerButton';
import useMemoRecorder from '../../../hooks/useMemoRecorder';
import GalleryImagePicker from '../../imageGen/GalleryImagePicker';
import MediaJobThumb from '../../pipeline/MediaJobThumb';
import GenerateImageControl from '../GenerateImageControl';
import CatalogMediaTile from '../CatalogMediaTile';
import CatalogImagePreview from '../CatalogImagePreview';
import CatalogReferenceLibrary from '../CatalogReferenceLibrary.jsx';
import CanonReferenceRemoval from '../CanonReferenceRemoval';

// "Media" panel — typed image/audio/video/document attachments. Each row
// stores a `media_key` REFERENCE into the media library (never the bytes), so
// the panel scopes its picker to the existing gallery/history. The portrait
// (one per ingredient) renders large at the head; other attachments tile below.
// Drag-and-drop accepts an in-app gallery filename dragged as text (the
// dashboard/gallery tiles set `dataTransfer.setData('text/plain', filename)`) OR
// a real file dropped from the OS. "Upload file" (image/audio/video) and "Record
// memo" (MediaRecorder → WAV → Whisper transcript) persist through the catalog
// media-upload/voice routes into the federating library dirs, then attach via
// the same media-refs seam gallery picks use.
export default function MediaPanel({ generateProfilePath = null, hideGenerate = false, canonRemoval = null, readOnly = false, referenceLibrary = null, media, canonImageRefs = [], primaryImageRef, missingMedia, onAttach, onSetPortrait, onDetach, onUploadFile, onRecordVoice, genIngredientId, genName, genDescription, genUniverseId, onGenerated, pendingRenders = [], onPendingRenderComplete, onPendingRenderFailed }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false); // upload or transcription in flight
  const { recording, starting, start: startMemo, stop: stopMemo } = useMemoRecorder();
  const [armedDetach, setArmedDetach] = useState(null);
  const list = Array.isArray(media) ? media : [];
  const portrait = list.find((m) => m.kind === 'portrait');
  const seenImageKeys = new Set(portrait ? [portrait.mediaKey] : []);
  const others = list.filter((m) => {
    if (m.kind === 'portrait') return false;
    if (m.kind !== 'reference') return true;
    if (seenImageKeys.has(m.mediaKey)) return false;
    seenImageKeys.add(m.mediaKey);
    return true;
  });
  const tileMedia = referenceLibrary ? others.filter((m) => !['reference', 'video'].includes(m.kind)) : others;
  const canonImages = [...new Set(canonImageRefs.filter((ref) => typeof ref === 'string' && ref.trim()))];

  const doUpload = async (file) => {
    if (!file || busy || readOnly) return;
    setBusy(true);
    try {
      await onUploadFile(file);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    if (readOnly) return;
    setDragOver(false);
    // In-app gallery DnD: the dragged tile carries its filename as text.
    const key = (e.dataTransfer.getData('text/plain') || '').trim();
    if (key) { onAttach(key, 'reference'); return; }
    const file = e.dataTransfer.files?.[0];
    if (file) { doUpload(file); return; }
    toast.error('Drop a gallery image, a file, or use “Pick from gallery”.');
  };

  const onFilePicked = (e) => {
    const file = e.target.files?.[0];
    if (file) doUpload(file);
  };

  const startRecording = async () => {
    await startMemo().catch((err) => {
      toast.error(err?.message || 'Microphone unavailable');
    });
  };

  const stopRecording = async () => {
    const pendingClip = stopMemo();
    if (!pendingClip) return;
    const clip = await pendingClip.catch((err) => { toast.error(err?.message || 'Recording failed'); return null; });
    if (!clip?.audioBase64) return;
    if (clip.peak !== undefined && clip.peak < 0.01) {
      toast.error('That memo was silent — check your microphone and try again.');
      return;
    }
    setBusy(true);
    await onRecordVoice(clip);
    setBusy(false);
  };

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
          <ImageIcon size={14} aria-hidden="true" /> Media
        </h2>
        {!readOnly && <div className="flex items-center gap-2 flex-wrap">
          {generateProfilePath && <Link to={generateProfilePath} className="text-xs text-port-accent hover:underline">Generate image in Profile</Link>}
          {!hideGenerate && <GenerateImageControl key={genIngredientId} ingredientId={genIngredientId} name={genName} description={genDescription} universeId={genUniverseId} onComplete={onGenerated} />}
          <button type="button" onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent">
            <Plus size={12} aria-hidden="true" /> Pick from gallery
          </button>
          <FilePickerButton accept="image/*,audio/*,video/*" onChange={onFilePicked} disabled={busy || recording}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent">
            <Upload size={12} aria-hidden="true" /> Upload file
          </FilePickerButton>
          {!recording ? (
            <button type="button" onClick={startRecording} disabled={busy || starting}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-40">
              <Mic size={12} aria-hidden="true" /> Record memo
            </button>
          ) : (
            <button type="button" onClick={stopRecording}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-port-error text-port-error hover:bg-port-error/10 animate-pulse">
              <Square size={12} aria-hidden="true" /> Stop &amp; transcribe
            </button>
          )}
        </div>}
      </div>

      {!readOnly && <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`mb-3 rounded-lg border border-dashed p-3 text-center text-xs transition-colors ${dragOver ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-500'}`}
      >
        {busy
          ? (<span className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" aria-hidden="true" /> Working…</span>)
          : 'Drag a gallery image or a file here to attach it (image, audio, or video).'}
      </div>}

      {referenceLibrary && <CatalogReferenceLibrary {...referenceLibrary} referenceMedia={list} readOnly={readOnly}
        missingMedia={missingMedia} onSetPortrait={onSetPortrait} onDetach={onDetach} />}

      {!referenceLibrary && portrait && (
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Portrait</div>
          <CatalogMediaTile m={portrait} missing={missingMedia.has(portrait.mediaKey)} isPortrait
            onSetPortrait={onSetPortrait} onDetach={onDetach} armedDetach={armedDetach}
            onArmDetach={setArmedDetach} />
        </div>
      )}

      {!referenceLibrary && (tileMedia.length > 0 || pendingRenders.length > 0) && (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
          {pendingRenders.map((pending) => (
            <div key={pending.jobId} data-testid="pending-media-tile" className="rounded-lg border border-port-accent/40 bg-port-bg shadow-sm overflow-hidden flex flex-col">
              <div className="relative aspect-square w-full bg-port-card/40 flex items-center justify-center overflow-hidden">
                <MediaJobThumb
                  jobId={pending.jobId}
                  label={pending.instruction || 'Refined reference'}
                  size="fill"
                  onFilename={(filename) => onPendingRenderComplete?.(pending.jobId, filename)}
                  onStatus={(status, err) => {
                    if (status === 'failed' || status === 'canceled') onPendingRenderFailed?.(pending.jobId, status, err);
                  }}
                />
              </div>
              <div className="p-2 border-t border-port-border text-xs flex items-center justify-between">
                <span className="truncate text-gray-300 font-medium">{pending.instruction || 'Edited reference'}</span>
                <span className="text-[10px] text-port-accent uppercase animate-pulse">Rendering</span>
              </div>
            </div>
          ))}
          {tileMedia.map((m) => (
            <CatalogMediaTile key={`${m.mediaKey}:${m.kind}`} m={m} missing={missingMedia.has(m.mediaKey)}
              onSetPortrait={onSetPortrait} onDetach={onDetach} armedDetach={armedDetach}
              onArmDetach={setArmedDetach} />
          ))}
        </div>
      )}

      {canonImages.length > 0 && (
        <div className="mt-3 space-y-2">
          <h3 className="text-xs font-semibold text-gray-300">Canon images</h3>
          <p className="text-xs text-gray-500">Existing canon references. Removing a reference keeps its image asset.</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
            {canonImages.map((filename) => (
              <figure key={filename} className="min-w-0 rounded border border-port-border overflow-hidden bg-port-bg">
                <CatalogImagePreview src={`/data/images/${encodeURIComponent(filename)}`} alt={`${genName} canon reference`}
                  fallbackSrc={`/data/image-refs/${encodeURIComponent(filename)}`}
                  className="w-full aspect-square object-contain" />
                <figcaption className="text-xs text-gray-400 p-2 break-words">
                  {filename === primaryImageRef ? 'Primary canon reference' : 'Canon reference'}
                  {!readOnly && onSetPortrait && <button type="button" onClick={() => onSetPortrait(filename)} className="block min-h-11 text-port-accent">Set as canonical image</button>}
                  {canonRemoval && <CanonReferenceRemoval key={filename} {...canonRemoval} filename={filename} />}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}

      {!referenceLibrary && list.length === 0 && canonImages.length === 0 && (
        <p className="text-xs text-gray-500">No media yet. Attach a generated portrait, a mood/reference image, an uploaded file, or a recorded voice memo.</p>
      )}

      <GalleryImagePicker open={pickerOpen} allowUpload onClose={() => setPickerOpen(false)}
        onSelect={(item) => { if (item?.filename) onAttach(item.filename, 'reference'); }} />
    </section>
  );
}
