import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { isCatalogMediaReferenceId, musicVideoCastGuideReferences, musicVideoCatalogPickPlans, musicVideoConditioningReferences, musicVideoLinkedCastReferences, musicVideoMissingFrameLinkedPicks, musicVideoOfferedReferences, musicVideoPanelArtReferences, musicVideoReferenceChoices, musicVideoResearchReferences, musicVideoSceneCastIds, MUSIC_VIDEO_MAX_REFERENCE_CHOICES } from '../../../../server/lib/musicVideoConditioning.js';
import { musicVideoGreyboxReferences } from '../../../../server/lib/musicVideoGreybox.js';
import { MUSIC_VIDEO_OTHER_REFERENCES_NOTE } from '../../../../server/lib/musicVideoShotPrompt.js';
import { musicVideoCameoReferences } from '../../../../server/lib/musicVideoCameos.js';
import MediaImage from '../MediaImage';
import SceneReferencePicker from './SceneReferencePicker.jsx';
import InfoTooltip from '../ui/InfoTooltip';
import CastGuidesRetry from './CastGuidesRetry.jsx';

// No iOS image callout or text selection, so a long-press opens the preview instead.
const CHIP = 'inline-flex min-h-[44px] max-w-full select-none items-center gap-1 rounded border border-port-border bg-port-bg p-0.5 text-xs [-webkit-touch-callout:none] pointer-fine:sm:min-h-[32px]';
const LONG_PRESS_MS = 450;
const thumb = (ref) => <MediaImage thumbnail src={`/data/images/${encodeURIComponent(ref.imageId)}`} fallbackSrc={`/data/image-refs/${encodeURIComponent(ref.imageId)}`} alt="" className="h-8 w-8 shrink-0 rounded bg-black object-cover" />;
const nameOf = (ref) => ref.label || ref.role || 'Reference';
const BACK_TO_AUTO_HINT = 'Drops your hand-picked list and goes back to the automatic one (the main character, the section\'s set and anyone the prompt names). Nothing renders and no images are deleted; you can pick again any time.';
const PICKER_HINT = 'Each render sends the shot\'s references in order, up to its renderer\'s limit (Codex 5).';

/**
 * The character and set references sent with this shot's frame renders (start,
 * end and both refines), shown as chips. Until the director changes them it is
 * the automatic set (the main character, the section's set and anyone the
 * prompt names); a change is kept on the shot (`frameReferenceIds`), and Auto
 * puts the automatic set back. Add offers the approved assets (sheets per age
 * or look, portraits, guides) of every character linked from the catalog. An
 * older shot that saved a Casting cast member (`characterVariant`, #12763) still
 * leads with that member's guides, from `castMedia`; no picker sets it any more.
 */
export default function SceneFrameReferences({ project, scene, castMedia = null, onReloadCastMedia = null, greybox = null, onEditLocal, onSave, disabled = false }) {
  const [adding, setAdding] = useState(false);
  // The reference shown large: hovering a chip with a mouse, or long-pressing it on a phone.
  const [preview, setPreview] = useState(null);
  const pressTimer = useRef(null);
  const longPressed = useRef(false);
  useEffect(() => () => clearTimeout(pressTimer.current), []);
  const choices = [...musicVideoGreyboxReferences(greybox), ...musicVideoResearchReferences(scene), ...musicVideoCameoReferences(project, scene), ...musicVideoCastGuideReferences(project, scene, castMedia), ...musicVideoPanelArtReferences(scene), ...musicVideoReferenceChoices(project), ...musicVideoLinkedCastReferences(project, castMedia)];
  const failedCastIds = castMedia ? musicVideoSceneCastIds(project, scene).filter((id) => castMedia[id] === null) : [];
  if (!choices.length && !failedCastIds.length) return null;
  // The selected greybox is added separately and is not one of the saved picks.
  const chosen = musicVideoConditioningReferences(project, scene, castMedia, greybox, { limit: MUSIC_VIDEO_MAX_REFERENCE_CHOICES + musicVideoGreyboxReferences(greybox).length });
  const chosenIds = chosen.map((ref) => ref.id);
  const ids = chosen.filter((ref) => !ref.greybox).map((ref) => ref.id);
  const others = musicVideoOfferedReferences(choices).filter((ref) => !chosenIds.includes(ref.id));
  const auto = !Array.isArray(scene.frameReferenceIds);
  // Unresolved saved guides still occupy slots and must survive an edit.
  const unresolvedGuides = (scene.frameReferenceIds || []).filter((refId) => isCatalogMediaReferenceId(refId) && !ids.includes(refId));
  const full = ids.length + unresolvedGuides.length >= MUSIC_VIDEO_MAX_REFERENCE_CHOICES;
  const notOffered = auto ? [] : musicVideoCatalogPickPlans(project, [scene])[0]?.unmappedFrame || [];
  const previewProps = (ref) => ({
    title: nameOf(ref),
    onPointerEnter: (e) => { if (e.pointerType === 'mouse') setPreview(ref); },
    onPointerLeave: (e) => {
      clearTimeout(pressTimer.current);
      if (e.pointerType === 'mouse') setPreview((shown) => (shown?.id === ref.id ? null : shown));
    },
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse') return;
      longPressed.current = false;
      clearTimeout(pressTimer.current);
      pressTimer.current = setTimeout(() => { longPressed.current = true; setPreview(ref); }, LONG_PRESS_MS);
    },
    onPointerUp: () => clearTimeout(pressTimer.current),
    onPointerCancel: () => clearTimeout(pressTimer.current),
    onContextMenu: (e) => e.preventDefault(),
  });
  // A long-press only previews: the tap it ends with does not add or remove.
  const unlessLongPress = (action) => () => {
    if (longPressed.current) { longPressed.current = false; return; }
    action();
  };
  // Until the cast member's guides load, an edit would save the row without them.
  const locked = disabled || Boolean(castMedia && musicVideoSceneCastIds(project, scene).some((id) => castMedia[id] === undefined));
  const set = (picked) => {
    const next = picked && [...picked, ...unresolvedGuides].slice(0, MUSIC_VIDEO_MAX_REFERENCE_CHOICES);
    onEditLocal(scene.sceneId, { frameReferenceIds: next });
    onSave(scene.sceneId, { frameReferenceIds: next });
  };

  const previewFigure = preview && (
        <figure aria-label={`Preview of ${nameOf(preview)}`} className="relative space-y-1 rounded border border-port-border bg-port-bg p-1">
          <img src={`/data/images/${encodeURIComponent(preview.imageId)}`} alt="" className="max-h-[60vh] w-full rounded bg-black object-contain" />
          <figcaption className="pr-10 text-xs text-port-text">
            {nameOf(preview)}
            {preview.note && <span className="block text-port-text-muted">{preview.note}</span>}
          </figcaption>
          <button type="button" onClick={() => setPreview(null)} aria-label="Close preview"
            className="absolute bottom-1 right-1 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded hover:bg-port-border pointer-fine:sm:min-h-[32px] pointer-fine:sm:min-w-[32px]">
            <X size={14} aria-hidden="true" />
          </button>
        </figure>
  );

  return (
    <div role="group" aria-label="References selected for the frames" className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-port-text-muted">
        <span className="font-medium text-port-text">References</span>
        <InfoTooltip label="How references are sent" placement="below" align="start" width={300}>
          In this order, each render attaches as many references as its image renderer takes (Codex 5, Qwen Image 2.1 and FLUX.3 10, FLUX.2 4). A refine or end frame counts its frame first; automatic storyboard art keeps a spare slot. Codex attachments do not confirm that its image tool received them.
        </InfoTooltip>
        {auto ? <span>Auto: from the prompt</span> : (
          <span className="inline-flex items-center">
            <button type="button" onClick={() => set(null)} disabled={locked} title={BACK_TO_AUTO_HINT} className="min-h-[44px] underline pointer-fine:sm:min-h-0">Back to auto</button>
            <InfoTooltip label="What Back to auto does" placement="below" align="start" width={260}>{BACK_TO_AUTO_HINT}</InfoTooltip>
          </span>
        )}
      </div>
      <ul className="flex flex-wrap gap-1">
        {chosen.map((ref) => (
          <li key={ref.id} className={CHIP} {...previewProps(ref)}>
            {thumb(ref)}
            <span className="min-w-0 max-w-[10rem] truncate">{nameOf(ref)}</span>
            {!ref.greybox && <button type="button" onClick={unlessLongPress(() => { set(ids.filter((id) => id !== ref.id)); setPreview((shown) => (shown?.id === ref.id ? null : shown)); })} disabled={locked} aria-label={`Don't send ${nameOf(ref)}`}
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex min-h-[40px] min-w-[32px] items-center justify-center rounded hover:bg-port-border disabled:opacity-50 sm:min-h-[28px] sm:min-w-[24px]">
              <X size={12} aria-hidden="true" />
            </button>}
          </li>
        ))}
        {others.length > 0 && (
          <li>
            <button type="button" onClick={() => setAdding((open) => !open)} disabled={locked || full} aria-expanded={adding}
              title={full ? `Up to ${MUSIC_VIDEO_MAX_REFERENCE_CHOICES} references` : 'Send another character or set'}
              className={`${CHIP} px-2 disabled:opacity-50`}>
              <Plus size={12} aria-hidden="true" /> Add
            </button>
          </li>
        )}
      </ul>
      {failedCastIds.length > 0 && onReloadCastMedia && (
        <CastGuidesRetry onRetry={onReloadCastMedia} consequence="frames" />
      )}
      {!locked && musicVideoMissingFrameLinkedPicks(project, scene, castMedia).length > 0 && <p className="text-[11px] text-port-warning">A picked cast reference is unavailable, so frames will not render. Reload to try again, or use Back to auto.</p>}
      {notOffered.length > 0 && <p className="text-[11px] text-port-warning">Left out of new renders because the catalog check-in does not offer {notOffered.map(nameOf).join(', ')}. Offer {notOffered.length === 1 ? 'it' : 'them'} on the catalog record, add a replacement here, or use Back to auto.</p>}
      {chosen.length === 0 && <p className="text-[11px] text-port-text-muted">No shot references selected. Mood-board images may fill available slots.</p>}
      <SceneReferencePicker open={adding && !full} references={others} label="References to add" hint={PICKER_HINT} onClose={() => setAdding(false)}
        tileProps={(ref) => ({ disabled: locked, onClick: unlessLongPress(() => { set([...ids, ref.id]); setAdding(false); setPreview(null); }), ...previewProps(ref) })}>
        {adding && previewFigure}
      </SceneReferencePicker>
      {!adding && previewFigure}
      {chosen.length > 0 && (
        <details className="text-[11px] text-port-text-muted">
          <summary className="cursor-pointer">Note sent with refines and end frames</summary>
          <p className="mt-1">{MUSIC_VIDEO_OTHER_REFERENCES_NOTE}</p>
        </details>
      )}
    </div>
  );
}
