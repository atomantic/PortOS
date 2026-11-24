import { useState } from 'react';
import {
  Sparkles, Film, Image as ImageIcon, Download, Eraser, Wand2, Box, ScanEye, Aperture, Pencil, Trash2, Eye, EyeOff, ShieldCheck,
} from 'lucide-react';
import VideoTrimControl from './VideoTrimControl';
import QuickImageEdit from './QuickImageEdit';
import AddToCollectionMenu from './AddToCollectionMenu';
import SharingDownloadButton from './SharingDownloadButton';
import PinToMoodBoardMenu from './PinToMoodBoardMenu';
import MediaDeleteConfirm from './MediaDeleteConfirm';
import FooterAction from './FooterAction.jsx';
import LightboxRegenControls from './LightboxRegenControls.jsx';
import { mediaRecordRef } from './mediaDetail';
import { runBusyAction } from './lightboxBusy.js';

const CLEAN_TOOLTIP = 'Resize-squeeze (CPU, no GPU): a downscale→upscale round-trip that removes the C2PA metadata chunk (via re-encode) and perturbs SynthID’s resolution-dependent carriers. Best-effort SynthID disruption — in testing it made OpenAI’s SynthID detector fail to return a positive, but it is detector-dependent and never a guaranteed removal. Saves a new image alongside the original.';

const ICON_BUTTON = 'min-h-[44px] min-w-[44px] flex items-center justify-center px-2 py-1.5 text-xs rounded';

// Video poster controls (Use this frame / Reset poster).
function PosterControls({ item, onPosterChange, getPlayhead }) {
  const [posterSaving, setPosterSaving] = useState(false);
  const [posterError, setPosterError] = useState(null);
  const savePoster = async (atSec) => {
    if (posterSaving) return;
    setPosterSaving(true);
    setPosterError(null);
    await onPosterChange(item, atSec).catch((error) => setPosterError(error.message)).finally(() => setPosterSaving(false));
  };
  return (
    <div className="w-full flex flex-wrap gap-2">
      <button type="button" disabled={posterSaving} onClick={() => savePoster(getPlayhead())}
        className="min-h-[44px] px-2 rounded bg-port-border text-white disabled:opacity-50">Use this frame as poster</button>
      <button type="button" disabled={posterSaving} onClick={() => savePoster(null)}
        className="min-h-[44px] px-2 rounded bg-port-border text-white disabled:opacity-50">Reset poster</button>
      {posterError && <p role="alert" className="text-port-error">{posterError}</p>}
    </div>
  );
}

// Hide / Delete icon buttons plus the inline delete confirm.
function DeleteControls({ item, usages, onDelete, onToggleHidden, onClose }) {
  // Keyed to the item so the confirm never carries over to the next one on
  // prev/next (the pane stays mounted across navigation).
  const [confirmDeleteKey, setConfirmDeleteKey] = useState(null);
  const hasRecord = Boolean(item.filename || item.id);
  const canDelete = Boolean(onDelete) && !item.pendingDelete && hasRecord;
  const confirmingDelete = canDelete && confirmDeleteKey === item.key;
  return (
    <>
      {onToggleHidden && !confirmingDelete && hasRecord && (
        <button
          type="button"
          onClick={() => onToggleHidden(item)}
          aria-label={item.hidden ? 'Unhide' : 'Hide'}
          title={item.hidden ? 'Unhide (move out of hidden section)' : 'Hide (move to hidden section)'}
          className={`${ICON_BUTTON} bg-port-border hover:bg-port-border/70 text-white`}
        >
          {item.hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      )}
      {canDelete && !confirmingDelete && (
        <button
          type="button"
          onClick={() => setConfirmDeleteKey(item.key)}
          aria-label="Delete"
          title="Delete"
          className={`${ICON_BUTTON} bg-port-error/20 hover:bg-port-error/40 text-port-error`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
      {confirmingDelete && (
        <div className="w-full">
          <MediaDeleteConfirm item={item} usages={usages} onDelete={onDelete}
            onCancel={() => setConfirmDeleteKey(null)} onNavigate={onClose} />
        </div>
      )}
    </>
  );
}

// Clean / Remove-watermark: in-place async actions that close on success.
function CleanActions({ item, onClose, onClean, onRemoveWatermark }) {
  const [cleaning, setCleaning] = useState(false);
  const [removingWatermark, setRemovingWatermark] = useState(false);
  return (
    <>
      {onClean && (
        <FooterAction
          tone="warning"
          disabled={cleaning}
          onClick={runBusyAction({ item, onClose, busy: cleaning, setBusy: setCleaning, action: onClean })}
          title={CLEAN_TOOLTIP}
          aria-label="Clean image"
        >
          <Eraser className="w-3.5 h-3.5" /> {cleaning ? 'Cleaning…' : 'Clean'}
        </FooterAction>
      )}
      {onRemoveWatermark && (
        <FooterAction
          tone="warning"
          disabled={removingWatermark}
          onClick={runBusyAction({ item, onClose, busy: removingWatermark, setBusy: setRemovingWatermark, action: onRemoveWatermark })}
          title="Erase the visible Gemini / Nano-Banana ✦ sparkle from the bottom-right corner. Reconstructs just that corner from its surroundings — the rest of the image is untouched. Creates a new variant; the original is kept."
          aria-label="Remove Gemini watermark sparkle"
        >
          <Sparkles className="w-3.5 h-3.5" /> {removingWatermark ? 'Removing…' : 'Remove ✦'}
        </FooterAction>
      )}
    </>
  );
}

// Edit button + its inline drawer.
function QuickEditAction({ item, onClose, quickEditParams, onQuickEditQueued, quickEditReferenceChoices }) {
  const [quickEditOpen, setQuickEditOpen] = useState(false);
  return (
    <>
      <FooterAction
        active={quickEditOpen}
        onClick={() => setQuickEditOpen((o) => !o)}
        aria-expanded={quickEditOpen}
        title="Describe a change and re-render this image with it, keeping everything else"
      >
        <Pencil className="w-3.5 h-3.5" /> Edit
      </FooterAction>
      {quickEditOpen && (
        <QuickImageEdit
          item={item}
          generateParams={quickEditParams}
          referenceChoices={quickEditReferenceChoices || []}
          onDone={(result, editInfo) => {
            setQuickEditOpen(false);
            onClose?.();
            if (result) {
              onQuickEditQueued?.(result, { item, instruction: editInfo?.instruction });
            }
          }}
        />
      )}
    </>
  );
}

export default function LightboxFooter({
  item, isVideo, usages, onClose, onScrollToVerification,
  onRefine, onPromptFrom, onRemix, onSendToImage, onSendToVideo, onSendTo3d, onContinue, onFilmLook,
  onClean, onRemoveWatermark, onRegenerate, regenAvailable, regenBounds,
  onPosterChange, getPlayhead, onTrimClip, videoRef, onDelete, onToggleHidden,
  quickEditParams, onQuickEditQueued, quickEditReferenceChoices,
}) {
  const closeThenRun = (handler) => {
    onClose?.();
    handler?.(item);
  };
  const isImage = !isVideo;
  const hasPrompt = Boolean(item.prompt) && item.prompt !== '(no prompt)';
  return (
    <footer className="shrink-0 flex flex-wrap gap-1.5 p-3 border-t border-port-border">
      {isImage && item.filename && (
        <FooterAction
          onClick={onScrollToVerification}
          title="Inspect or run verification checks (anatomy, digits, composition, text)"
        >
          <ShieldCheck className="w-3.5 h-3.5" /> Verify
        </FooterAction>
      )}
      {onRefine && hasPrompt && (
        <FooterAction onClick={onRefine}>
          <Sparkles className="w-3.5 h-3.5" /> Refine Prompt
        </FooterAction>
      )}
      {isImage && item.filename && (
        <QuickEditAction item={item} onClose={onClose} quickEditParams={quickEditParams}
          onQuickEditQueued={onQuickEditQueued} quickEditReferenceChoices={quickEditReferenceChoices} />
      )}
      {onPromptFrom && (
        <FooterAction
          onClick={onPromptFrom}
          title="Ask a vision model to write the image and/or video prompt that would recreate this"
        >
          <ScanEye className="w-3.5 h-3.5" /> {hasPrompt ? 'Prompt from this' : 'Analyze prompt'}
        </FooterAction>
      )}
      {onRemix && (
        <FooterAction tone="accent" onClick={() => closeThenRun(onRemix)}>
          <Sparkles className="w-3.5 h-3.5" /> Remix
        </FooterAction>
      )}
      {isImage && onSendToImage && (
        <FooterAction onClick={() => closeThenRun(onSendToImage)} title="Open this image in Image Gen as the image-to-image source">
          <Wand2 className="w-3.5 h-3.5" /> Send to i2i
        </FooterAction>
      )}
      {isImage && onSendToVideo && (
        <FooterAction tone="success" onClick={() => closeThenRun(onSendToVideo)}>
          <Film className="w-3.5 h-3.5" /> Send to Video
        </FooterAction>
      )}
      {isImage && onSendTo3d && (
        <FooterAction tone="accent2" onClick={() => closeThenRun(onSendTo3d)}>
          <Box className="w-3.5 h-3.5" /> Send to 3D
        </FooterAction>
      )}
      {onFilmLook && (
        <FooterAction
          onClick={onFilmLook}
          title="Tune an analog film look on this image — soft focus, halation, grain, fade, vignette, light leaks — and save the result as a new copy. The original is kept."
          aria-label="Film look"
        >
          <Aperture className="w-3.5 h-3.5" /> Film look
        </FooterAction>
      )}
      {isImage && (onClean || onRemoveWatermark) && (
        <CleanActions item={item} onClose={onClose} onClean={onClean} onRemoveWatermark={onRemoveWatermark} />
      )}
      {isImage && (
        <LightboxRegenControls item={item} onClose={onClose} onRegenerate={onRegenerate}
          regenAvailable={regenAvailable} regenBounds={regenBounds} />
      )}
      {isVideo && onContinue && (
        <FooterAction tone="accent" onClick={() => closeThenRun(onContinue)}>
          <ImageIcon className="w-3.5 h-3.5" /> Continue
        </FooterAction>
      )}
      {isVideo && onPosterChange && (
        <PosterControls item={item} onPosterChange={onPosterChange} getPlayhead={getPlayhead} />
      )}
      {isVideo && onTrimClip && item.id && (
        <VideoTrimControl videoRef={videoRef} fps={item.fps} sourceKey={item.key}
          onTrim={(range) => onTrimClip(item, range)} />
      )}
      {isVideo && item.id && item.previewUrl && (
        <SharingDownloadButton itemId={item.id} />
      )}
      {/* A collection holds gallery records; an item with no record (a Blender film still) has nothing to add. */}
      {mediaRecordRef(item) && <AddToCollectionMenu item={item} size="md" />}
      <PinToMoodBoardMenu item={item} size="md" />
      <a
        href={item.downloadUrl}
        download
        aria-label="Download"
        className={`${ICON_BUTTON} gap-1.5 bg-port-border hover:bg-port-border/70 text-white`}
      >
        <Download className="w-3.5 h-3.5" />
      </a>
      <DeleteControls item={item} usages={usages} onDelete={onDelete} onToggleHidden={onToggleHidden} onClose={onClose} />
    </footer>
  );
}
