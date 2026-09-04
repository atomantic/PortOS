/**
 * IC-LoRA remix panel (issue #3100) — dgrauet/ltx2 runtime only. The user
 * supplies the reference(s) the fused IC-LoRA conditions on, then dials how
 * strongly they apply.
 *
 * Two input surfaces, chosen by the registry's `spec.referenceKind`:
 *  - `video` (Control, Colorize) — ONE reference clip: a fresh upload or a
 *    prior render picked by history id, mutually exclusive server-side.
 *  - `image` (Ingredients, #3112) — a 2-8 ROW gallery list, modeled on
 *    KeyframePanel. Gallery-only, matching the route (references resolve under
 *    PATHS.images, so there's no upload shape to reconcile).
 *
 * Presentational — the reference upload File, the picked history id, the gallery
 * reference rows, the strength dials, the weight's download status, and the "no
 * compatible model installed" condition are all owned by the VideoGen page.
 * `onPickHistory('')` clears the history selection.
 *
 * The IC-LoRA weight is a separate several-hundred-MB HF pull, so the panel
 * hosts its own ModelDownloadBadge: without it a first render silently stalls
 * on an un-progressed download inside the Python child.
 */
import { Upload, Film, X, ListPlus } from 'lucide-react';
import { formatBytes } from '../../utils/formatters';
import { icResolutionIssue } from '../../lib/videoGenParams';
import FilePickerButton from '../ui/FilePickerButton';
import ModelDownloadBadge from '../media/ModelDownloadBadge';
import GalleryPickButton from './GalleryPickButton';
import ImagePreview from './ImagePreview';
import Ltx2RuntimeMissingNotice from './Ltx2RuntimeMissingNotice';

export default function IcLoraPanel({
  spec,                 // { mode, label, desc, referenceDownscaleFactor, min/maxReferences, referenceKind }
  referenceFile,        // File | null — fresh upload (video-kind only)
  referenceVideoId,     // string — picked prior render (mutually exclusive with the upload)
  inFlightReferenceNames = [], // display-only basenames of a resumed in-flight render
  visibleHistory,
  // Image-kind (Ingredients) reference rows: gallery basenames, min/max enforced
  // by the registry spec. The page owns the array and the three mutators.
  referenceImageFiles = [],
  onAddReferenceImage,
  onBrowseReferenceImage,
  onRemoveReferenceImage,
  icStrength,
  icSkipStage2,
  width,
  height,
  weightStatus,         // ModelDownloadBadge status for the IC-LoRA weight
  hasCompatibleModel,
  onPickFile,
  onClearFile,
  onPickHistory,
  onStrengthChange,
  onSkipStage2Change,
  onDownloadWeight,
  onCancelWeightDownload,
}) {
  // Same helper the page's submit gate uses, so the warning and the disabled
  // button can't disagree (and both match the server's rejection message).
  const resolutionIssue = icResolutionIssue(spec, width, height);
  const strengthId = `ic-strength-${spec.mode}`;
  const skipId = `ic-skip-stage2-${spec.mode}`;
  const imageKind = spec.referenceKind === 'image';
  // Row count is a WEIGHT CONTRACT, not a UI preference — read the bounds off the
  // spec so a future weight with different limits needs no component change (and
  // can't disagree with what the route enforces).
  const { minReferences: minRefs, maxReferences: maxRefs } = spec;

  return (
    <div className="border border-port-border/50 rounded-lg p-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-gray-400">
          {spec.label} reference{imageKind ? 's' : ''}
          {imageKind && (
            <span className="block text-[10px] text-gray-500 font-normal">
              Pick {minRefs}–{maxRefs} gallery stills to recompose from
            </span>
          )}
        </span>
        {!imageKind && (referenceFile || referenceVideoId) && (
          <button
            type="button"
            onClick={() => { onClearFile(); onPickHistory(''); }}
            className="text-[11px] text-port-error hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      {imageKind ? (
        <div className="space-y-2">
          {referenceImageFiles.map((file, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1 space-y-1">
                <GalleryPickButton
                  label={`${spec.label} reference ${i + 1}`}
                  filled={!!file}
                  onClick={() => onBrowseReferenceImage(i)}
                />
                {file && (
                  <ImagePreview src={`/data/images/${file}`} alt={`${spec.label} reference ${i + 1}`} label={file} />
                )}
              </div>
              <button
                type="button"
                onClick={() => onRemoveReferenceImage(i)}
                disabled={referenceImageFiles.length <= minRefs}
                aria-label={`Remove reference ${i + 1}`}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center mt-1 p-1 text-gray-400 hover:text-port-error disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={onAddReferenceImage}
              disabled={referenceImageFiles.length >= maxRefs}
              className="flex items-center gap-1.5 text-[11px] text-port-accent hover:text-port-accent/80 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ListPlus className="w-3.5 h-3.5" /> Add reference
            </button>
            <span className="text-[10px] text-gray-500">{referenceImageFiles.length}/{maxRefs}</span>
          </div>
          <p className="text-[10px] text-gray-500 leading-snug">
            References pull from your gallery only. Each still is prepared at the render resolution before conditioning.
          </p>
        </div>
      ) : referenceFile ? (
        <div className="flex items-center gap-2 text-[11px] text-gray-300">
          <Film className="w-3.5 h-3.5 text-port-accent" />
          <span className="truncate" title={referenceFile.name}>{referenceFile.name}</span>
          <span className="text-gray-500">{formatBytes(referenceFile.size, 2)}</span>
        </div>
      ) : (
        <>
          <FilePickerButton
            accept={`${spec.referenceKind}/*`}
            onChange={(e) => onPickFile(e.target.files?.[0] || null)}
            className="flex items-center gap-2 text-[11px] text-gray-400 hover:text-white"
          >
            <Upload className="w-3.5 h-3.5" />
            <span className="truncate">{spec.uploadLabel}</span>
          </FilePickerButton>
          <select
            value={referenceVideoId}
            onChange={(e) => onPickHistory(e.target.value)}
            aria-label={`Pick a previous render as the ${spec.label} reference`}
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-port-accent"
          >
            <option value="">…or pick a previous render</option>
            {visibleHistory.slice(0, 50).map((v) => (
              <option key={v.id} value={v.id}>
                {(v.prompt || v.filename || v.id).slice(0, 80)}
              </option>
            ))}
          </select>
        </>
      )}

      {!imageKind && !referenceFile && !referenceVideoId && inFlightReferenceNames.length > 0 && (
        <p className="text-[10px] text-gray-500">
          In-flight render is conditioned on {inFlightReferenceNames.join(', ')} — re-pick a reference to run a new one.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label htmlFor={strengthId} className="block text-[10px] text-gray-500 mb-1">
            Reference strength {Number(icStrength).toFixed(2)}
          </label>
          <input
            id={strengthId}
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={icStrength}
            onChange={(e) => onStrengthChange(Number(e.target.value))}
            className="w-full accent-port-accent"
          />
        </div>
        <label htmlFor={skipId} className="flex items-center gap-2 text-[11px] text-gray-400 sm:mt-4">
          <input
            id={skipId}
            type="checkbox"
            checked={icSkipStage2}
            onChange={(e) => onSkipStage2Change(e.target.checked)}
            className="accent-port-accent"
          />
          <span>Half-res preview (skip refine)</span>
        </label>
      </div>

      <p className="text-[10px] text-gray-500 leading-snug">
        {spec.description}.
        {imageKind ? '' : ' The reference is trimmed to fit the frame count.'}
      </p>

      {weightStatus?.gated && !weightStatus.cached && (
        <p className="text-[10px] text-gray-500 leading-snug">
          The official weight repo is gated. Download tries it first (accept its license and add an
          HF token in Image Gen settings for that path) and falls back to the un-gated mirror
          automatically, so no token is required.
        </p>
      )}

      {resolutionIssue && (
        <p className="text-[11px] text-port-warning">
          {resolutionIssue} Adjust the resolution first.
        </p>
      )}

      {hasCompatibleModel && weightStatus && (
        <ModelDownloadBadge
          status={weightStatus}
          onDownload={onDownloadWeight}
          onCancel={onCancelWeightDownload}
          estimateLabel={weightStatus.estimatedBytes ? `~${formatBytes(weightStatus.estimatedBytes, 0)}` : undefined}
        />
      )}

      {!hasCompatibleModel && <Ltx2RuntimeMissingNotice subject={spec.label} />}
    </div>
  );
}
