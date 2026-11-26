import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';
import PromptRefineModal from './PromptRefineModal';
import ImageVerificationDetails from './ImageVerificationDetails.jsx';
import { PromptFromMediaModal } from './PromptFromMedia';
import FilmLookPane, { useFilmLookDraft } from './FilmLookPane.jsx';
import FilmLookPreview from './FilmLookPreview.jsx';
import MediaImage from '../MediaImage';
import { useScrollLock } from '../../hooks/useScrollLock';
import { useSwipeNav } from './useSwipeNav';
import { isEditableTarget, onActivateKeyDown } from '../../lib/a11yKeyboard';
import useFocusTrap from '../../hooks/useFocusTrap.js';
import { copyToClipboard } from '../../lib/clipboard';
import SentPromptPanel from './SentPromptPanel';
import ContinuationDetails from '../videoGen/ContinuationDetails';
import HostedCopyRow from './HostedCopyRow';
import { mediaAnnotationKey } from './mediaDetail';
import { useMediaUsages } from '../../hooks/useMediaUsages';
import { buildLightboxMeta } from './lightboxMeta.js';
import LightboxNoteEditor from './LightboxNoteEditor.jsx';
import LightboxPromptSection from './LightboxPromptSection.jsx';
import LightboxFooter from './LightboxFooter.jsx';
import LightboxPaneHeader from './LightboxPaneHeader.jsx';
import { PeerNotes, UsedIn, NegativePrompt, VariantSwitch, MetaList } from './LightboxDetails.jsx';

// Intentionally NOT migrated to <ui/Modal> or <components/Drawer>. The
// prev/next buttons sit as viewport-edge siblings of the card (not children
// of a constrained panel box), and the Esc cascade refineOpen → fullScreen
// → close is layered into the window keydown handler below.
//   - Modal wraps children in a panel container (which the viewport-edge
//     chevrons can't live inside) and owns Esc via a stack-aware global
//     handler that stopImmediatePropagation's the keystroke — the lightbox's
//     own window keydown listener never sees Esc and the cascade dies. Could
//     be threaded through Modal's onEsc prop, but at the cost of bypassing
//     the stack model for this one caller.
//   - Drawer is a right-side slide-in over a normal page; SettingsPane below
//     is an inline layout sibling of the image, not a slide-in. Its flat Esc
//     listener also calls onClose directly, racing the lightbox's own window
//     keydown listener.
// (A mobile tap-to-open bottom-sheet drawer existed pre-ed0e4859 and was
// removed because it covered the image area in fullscreen.)
// Opting out means owning the dialog semantics Modal would have supplied:
// the overlay carries role="dialog"/aria-modal, runs useFocusTrap itself, and
// portals to <body> in place of Modal's `usePortal` (see the render below);
// `client/src/test/guards/a11y/overlays.test.js` allowlists it on that basis.


// The side pane stacks under the media on phones and sits beside it from md up.
// Film look gets a wider pane (two slider columns) and more of a phone screen.
const ASIDE_CLASSES = 'shrink-0 flex flex-col border-t md:border-t-0 md:border-l border-port-border min-h-0 max-h-dvh-cap md:[--dvh-cap:92vh] md:[--dvh-cap-dynamic:92dvh] [--dvh-inset:2rem]';
const DETAILS_ASIDE_SIZE = 'md:w-80 lg:w-96 [--dvh-cap:40vh] [--dvh-cap-dynamic:40dvh]';
// The live-look image is a plain <img> inside a wrapper, so it cannot shrink
// to the flex row the way MediaImage does; cap it to what the pane leaves.
const FILM_LOOK_IMG_MAX = 'max-w-full max-h-[calc(42dvh-2rem)] md:max-h-[calc(92dvh-2rem)]';
const FILM_LOOK_ASIDE_SIZE = 'md:w-96 lg:w-[28rem] xl:w-[32rem] [--dvh-cap:50vh] [--dvh-cap-dynamic:50dvh]';

// onClean(item) — optional. Returning a rejected promise keeps the lightbox
// open (e.g. on error) so the user can retry.
//
// Film look (lib/filmLook.js) is offered on every gallery image: the side pane
// swaps to the look's controls while the image shows the look live, and the
// pane bakes a filtered copy reported through `onFilmLookComplete(variant)`
// (the host splices it in like a clean). `filmLookProject` — optional
// `{ look, onSave, name }` — lets the pane read and write the hosting music
// video project's finishing look.
//
// Good/bad rating sits beside the star. By default it is the media item's own
// rating (synced like stars and notes); a page that rates items in its own
// store (a catalog reference) passes `ratingControl` — `{ value, onRate(next),
// busy, title }` with `next` 'good' | 'bad' | null — and that replaces it.
//
// pageActions — optional node with the hosting page's own controls for this
// item (a catalog reference's rating, guide and remove buttons). It sits at the
// top of the details pane so page-specific actions stay in place beside the
// standard ones.
//
// onDelete(item, { force }) / onToggleHidden(item) — optional; the host's own
// gallery delete and hide (the same handlers its cards use). The lightbox
// offers small Hide and Delete buttons beside Download, Delete with the shared
// inline confirm; MediaPreview moves to the neighboring item once the host
// drops the item from its list.
//
// variantGroup — optional `{ active, group: [{ label, item }, ...] }` shape
// from `computeImageVariantGroup` (in `./variants.js`). When present, the
// SettingsPane renders a segmented control to swap between the original
// image and its cleaned copies without closing the modal. `onSelectVariant`
// is the click handler — typically wired to the host page's `setPreview`.
export default function MediaLightbox({
  item,
  onClose,
  onRemix,
  onSendToImage,
  onSendToVideo,
  onSendTo3d,
  onContinue,
  onClean,
  onRegenerate,
  onRemoveWatermark,
  regenAvailable = false,
  regenBounds = null,
  onPrevious,
  onNext,
  hasPrevious = false,
  hasNext = false,
  annotation = null,
  onAnnotationChange,
  onPromptChange,
  onPromptAnalysis,
  onPosterChange,
  onTrimClip,
  onDelete,
  onToggleHidden,
  variantGroup = null,
  onSelectVariant,
  onFilmLookComplete,
  filmLookProject = null,
  onVerificationChange = null,
  pageActions = null,
  ratingControl = null,
  quickEditParams = null,
  onQuickEditQueued = null,
  quickEditReferenceChoices = null,
}) {
  const [fullScreen, setFullScreen] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [promptFromOpen, setPromptFromOpen] = useState(false);
  const [filmLookOpen, setFilmLookOpen] = useState(false);
  const [verificationOverride, setVerificationOverride] = useState(null);
  useEffect(() => {
    setVerificationOverride(null);
  }, [item?.key]);

  const currentItem = verificationOverride
    ? { ...item, verification: verificationOverride }
    : item;
  // Videos never take the live look: an SVG filter over playing video drops
  // phones below 1 fps (see FilmLookFrame). The pane stays open across
  // prev/next and simply hides on a video.
  const filmLookAvailable = !!item && item.kind !== 'video' && !!item.filename && !item.compact;
  const filmLookShown = filmLookOpen && filmLookAvailable;
  const filmLook = useFilmLookDraft(item, filmLookShown, filmLookProject);
  useScrollLock(!!item);
  // Read callbacks + frequently-changing values from refs so the keydown
  // listener and the note-save debounce don't tear down on every parent
  // render. Callers pass inline arrows for onAnnotationChange, and the
  // parent re-renders constantly while media-gen events stream in.
  const starred = !!annotation?.starred;
  const refs = useRef({ onClose, onPrevious, onNext, onAnnotationChange, starred });
  useEffect(() => { refs.current = { onClose, onPrevious, onNext, onAnnotationChange, starred }; });
  const videoRef = useRef(null);
  // The overlay opts out of <ui/Modal> (see the note at the top of the file),
  // so it has to bring its own dialog semantics: without the trap, Tab walks
  // straight out of the lightbox into the page underneath it, and focus never
  // returns to the thumbnail that opened it (WCAG 2.4.3 / 2.1.2). Esc is
  // already handled by the window-level cascade below.
  const overlayRef = useRef(null);
  useFocusTrap(!!item, overlayRef);
  // Play videos with SOUND on open. The declarative `muted autoPlay` baseline
  // (on the <video> below) is what lets the clip start at all on mobile —
  // iOS/Android block *unmuted* autoplay that isn't tied to a user gesture. But
  // the lightbox is opened by a tap (history thumbnail / grid item), so the
  // tap's transient user activation is usually still live when this effect runs.
  // So we unmute and re-play here to upgrade the muted baseline to audible.
  // If the browser rejects the unmuted play (activation expired / low
  // media-engagement index), we fall back to muted playback so the clip still
  // runs and the on-screen controls can unmute it manually.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || item?.kind !== 'video') return;
    // Promise.resolve() normalizes both a real play() promise and the
    // undefined some environments return, so the .catch chain is uniform.
    v.muted = false;
    Promise.resolve(v.play()).catch(() => {
      v.muted = true;
      Promise.resolve(v.play()).catch(() => {});
    });
  }, [item?.key, item?.kind]);
  useEffect(() => {
    if (!item) return;
    const onKey = (e) => {
      const cb = refs.current;
      if (e.key === 'Escape') {
        if (refineOpen) { setRefineOpen(false); return; }
        if (promptFromOpen) { setPromptFromOpen(false); return; }
        if (filmLookShown) { setFilmLookOpen(false); return; }
        if (fullScreen) { setFullScreen(false); return; }
        cb.onClose();
        return;
      }
      const inEditable = isEditableTarget(e.target);
      if (e.key === 'f' || e.key === 'F') {
        if (inEditable) return;
        setFullScreen((v) => !v);
        return;
      }
      if ((e.key === 's' || e.key === 'S') && cb.onAnnotationChange) {
        if (inEditable) return;
        e.preventDefault();
        cb.onAnnotationChange({ starred: !cb.starred });
        return;
      }
      if (e.key === 'ArrowLeft' && hasPrevious && cb.onPrevious) {
        if (inEditable) return;
        e.preventDefault();
        cb.onPrevious();
      }
      if (e.key === 'ArrowRight' && hasNext && cb.onNext) {
        if (inEditable) return;
        e.preventDefault();
        cb.onNext();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, hasPrevious, hasNext, fullScreen, refineOpen, promptFromOpen, filmLookShown]);

  // Reset refine modal when the previewed item changes.
  useEffect(() => { setRefineOpen(false); setPromptFromOpen(false); }, [item?.key]);

  const { onTouchStart, onTouchEnd, onTouchCancel } = useSwipeNav({ onPrevious, onNext, hasPrevious, hasNext });

  if (!item) return null;
  const isVideo = item.kind === 'video';

  const copy = (text, label = 'Prompt') => {
    copyToClipboard(text, `${label} copied`);
  };

  const meta = buildLightboxMeta(item, isVideo);

  const cardClasses = fullScreen
    ? 'relative w-full h-full bg-black flex'
    : `relative bg-port-card border border-port-border rounded-xl overflow-hidden ${filmLookShown ? 'max-w-6xl md:max-w-[min(90rem,calc(100vw-8rem))]' : 'max-w-6xl'} w-full max-h-dvh-cap [--dvh-cap:92vh] [--dvh-cap-dynamic:92dvh] [--dvh-inset:2rem] flex flex-col md:flex-row`;
  const overlayPad = fullScreen ? 'p-0' : 'p-4';
  const imgMax = fullScreen ? 'max-w-[100vw] max-h-dvh-cap' : 'max-w-full max-h-dvh-cap [--dvh-cap:92vh] [--dvh-cap-dynamic:92dvh] [--dvh-inset:2rem]';
  // Anchor low in fullscreen so the chevrons land in the letterbox bar of a
  // landscape image instead of covering it. On phones, render arrows inside
  // the media surface; the settings pane is stacked below it and must never
  // share their hit area. Wider layouts keep viewport-edge navigation.
  const chevronPositionClass = fullScreen ? 'bottom-4' : 'top-1/2 -translate-y-1/2';
  const renderNavigationButton = (direction, placement) => {
    const previous = direction === 'previous';
    const handler = previous ? onPrevious : onNext;
    const label = previous ? 'Previous media' : 'Next media';
    const position = previous ? 'left-3 md:left-5' : 'right-3 md:right-5';
    return (
      <button
        key={`${direction}-${placement}`}
        type="button"
        onClick={(e) => { e.stopPropagation(); handler?.(); }}
        className={`absolute ${position} ${placement === 'mobile' ? 'top-1/2 -translate-y-1/2 md:hidden' : placement === 'wide' ? `hidden md:block ${chevronPositionClass}` : 'bottom-4'} z-30 p-2.5 text-white/80 hover:text-white bg-black/40 hover:bg-black/60 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-port-accent rounded-full`}
        aria-label={label}
        title={previous ? 'Previous' : 'Next'}
      >
        {previous ? <ChevronLeft className="w-6 h-6" /> : <ChevronRight className="w-6 h-6" />}
      </button>
    );
  };

  // Portal to <body>. The overlay is a hand-rolled `fixed inset-0` (this file
  // opts out of <ui/Modal> and its `usePortal`, see the note at the top), and
  // the lightbox is opened from inside themed gallery cards. On "glass" themes
  // (`--port-backdrop-filter` non-none) `index.css` gives every bordered/rounded
  // `.bg-port-card` a backdrop-filter, which makes it the containing block for
  // position:fixed descendants — an inline overlay would be sized to the card
  // instead of the viewport. Same fix as GalleryImagePicker / FolderPicker,
  // reached through createPortal directly because Modal isn't in play here.
  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={item.label || `Media viewer — ${item.filename || item.key || 'item'}`}
      className={`fixed inset-0 z-50 always-dark bg-black/90 flex items-center justify-center ${overlayPad}`}
      onClick={onClose}
      // The backdrop itself carries no tabIndex (it isn't a tab stop) and its
      // real keyboard equivalent — Escape — is already handled by the
      // window-level listener above, which also respects the refine/prompt-
      // from/fullscreen precedence. `onActivateKeyDown`'s currentTarget guard
      // makes this a no-op for a bubbled keydown from a focused descendant
      // (button, input) and only fires if this div itself were ever focused.
      onKeyDown={onActivateKeyDown(onClose)}
    >
      {!fullScreen && <>
        {hasPrevious && renderNavigationButton('previous', 'wide')}
        {hasNext && renderNavigationButton('next', 'wide')}
      </>}
      {fullScreen && <>
        {hasPrevious && renderNavigationButton('previous', 'fullscreen')}
        {hasNext && renderNavigationButton('next', 'fullscreen')}
      </>}
      <div
        className={cardClasses}
        onClick={(e) => e.stopPropagation()}
        role="presentation"
        // Pin card/border alpha to 1 inside this focused modal so glass-style themes
        // (Lumen Glass Day, Pastel Dawn, etc.) render an opaque panel against the
        // bg-black/90 overlay — the translucent default makes button text illegible.
        style={{ '--port-card-alpha': 1, '--port-border-alpha': 1 }}
      >
        <div
          className="flex-1 bg-black flex items-center justify-center min-h-0 relative"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchCancel}
          // Keep native pinch/pan available for inspecting an image. The
          // swipe hook explicitly opts out once a second finger or a zoomed
          // visual viewport appears, so native zoom cannot turn into gallery
          // navigation while the browser is handling the gesture.
          style={{ touchAction: 'manipulation' }}
        >
          {!fullScreen && hasPrevious && renderNavigationButton('previous', 'mobile')}
          {!fullScreen && hasNext && renderNavigationButton('next', 'mobile')}
          {/* Fail-safe close — the SettingsPane's X is hidden in fullscreen
              and unreachable if iOS Safari mis-lays out the page. Keep it
              before the media so native video controls sit inside the trap's
              counted boundaries without intercepting their shadow-DOM tabs. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="absolute top-2 left-2 z-30 min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-full bg-white text-black hover:bg-white/85 shadow-lg focus:outline-none focus:ring-2 focus:ring-port-accent"
            aria-label="Close"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
          {isVideo ? (
            /* Mobile playback contract:
               - playsInline keeps iOS Safari from auto-promoting autoplay video
                 to a native fullscreen player — exiting that leaves the modal
                 laid out as a tiny strip with no reachable close button.
               - muted is the autoplay BASELINE under the mobile media-engagement
                 policy: iOS/Android block unmuted autoplay that isn't fired from
                 a direct user gesture, so without it the clip never starts and the
                 area just shows black ("not loading"). The effect above upgrades
                 this to audible playback when the opening tap's user activation
                 allows it; otherwise the controls let the user unmute manually.
               - poster paints the thumbnail immediately so there's no blank box
                 while the clip buffers (and a visible frame even if playback is
                 deferred). previewUrl is the video's thumbnail; omit when absent. */
            <video
              ref={videoRef}
              src={item.downloadUrl}
              poster={item.previewUrl || undefined}
              controls
              autoPlay
              loop
              muted
              playsInline
              preload="metadata"
              className={imgMax}
            />
          ) : filmLookShown ? (
            filmLook.waiting
              ? <p className="p-4 text-sm text-gray-400" role={filmLook.sourceError ? 'alert' : 'status'}>{filmLook.sourceError || 'Loading ungraded source…'}</p>
              : <FilmLookPreview src={filmLook.src} alt={item.prompt} look={filmLook.look} className="flex min-h-0 items-center justify-center" imgClassName={fullScreen ? imgMax : FILM_LOOK_IMG_MAX} />
          ) : (
            <MediaImage src={item.previewUrl} fallbackSrc={item.fallbackUrl} alt={item.label || item.prompt} className={`${imgMax} object-contain`} placeholderClassName="w-full h-full" />
          )}
          {/* Touch video already has native fullscreen. Keep the lightbox
              toggle for images and mouse users, including narrow desktops. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setFullScreen((v) => !v); }}
            className={`absolute top-2 right-2 z-30 min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-full bg-white text-black hover:bg-white/85 shadow-lg focus:outline-none focus:ring-2 focus:ring-port-accent ${isVideo && !fullScreen ? 'pointer-coarse:hidden' : ''}`}
            aria-label={fullScreen ? 'Exit full screen' : 'Full screen'}
            title={fullScreen ? 'Exit full screen (Esc, F)' : 'Full screen (F)'}
          >
            {fullScreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          {fullScreen && (hasPrevious || hasNext) && (
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-wide text-white/50 select-none pointer-events-none">
              swipe to navigate
            </div>
          )}
        </div>

        {!fullScreen && filmLookShown && (
          <aside className={`${ASIDE_CLASSES} ${FILM_LOOK_ASIDE_SIZE}`} onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation(); }}>
            <FilmLookPane item={item} draft={filmLook} onBack={() => setFilmLookOpen(false)} onComplete={onFilmLookComplete} projectLook={filmLookProject} />
          </aside>
        )}
        {!fullScreen && !filmLookShown && (
          <SettingsPane
            item={currentItem}
            meta={meta}
            isVideo={isVideo}
            onVerificationChange={(updated) => {
              setVerificationOverride(updated);
              onVerificationChange?.(item, updated);
            }}
            onClose={onClose}
            onRemix={onRemix}
            onSendToImage={onSendToImage}
            onSendToVideo={onSendToVideo}
            onSendTo3d={onSendTo3d}
            onContinue={onContinue}
            onClean={onClean}
            onRegenerate={onRegenerate}
            onRemoveWatermark={onRemoveWatermark}
            regenAvailable={regenAvailable}
            regenBounds={regenBounds}
            copy={copy}
            // A compact list item holds a prompt PREVIEW until its record is
            // hydrated (#8292) — refining or editing it would treat the
            // truncation as the saved prompt.
            onRefine={item.compact ? undefined : () => setRefineOpen(true)}
            onPromptFrom={item.filename || item.id ? () => setPromptFromOpen(true) : undefined}
            pageActions={pageActions}
            rating={ratingControl || (onAnnotationChange ? { value: annotation?.rating ?? null, onRate: (next) => onAnnotationChange({ rating: next }) } : null)}
            annotation={annotation}
            onAnnotationChange={onAnnotationChange}
            onPromptChange={item.compact ? undefined : onPromptChange}
            onPosterChange={onPosterChange}
            getPlayhead={() => videoRef.current?.currentTime ?? 0}
            onTrimClip={onTrimClip}
            onDelete={onDelete}
            onToggleHidden={onToggleHidden}
            videoRef={videoRef}
            variantGroup={variantGroup}
            onSelectVariant={onSelectVariant}
            onFilmLook={filmLookAvailable ? () => setFilmLookOpen(true) : undefined}
            quickEditParams={quickEditParams}
            onQuickEditQueued={onQuickEditQueued}
            quickEditReferenceChoices={quickEditReferenceChoices}
          />
        )}
      </div>
      <PromptRefineModal item={item} open={refineOpen} onClose={() => setRefineOpen(false)} />
      <PromptFromMediaModal item={item} open={promptFromOpen} onClose={() => setPromptFromOpen(false)} onResult={onPromptAnalysis} />
    </div>,
    document.body
  );
}

function SettingsPane({
  item, meta, isVideo,
  onClose, onRemix, onSendToImage, onSendToVideo, onSendTo3d, onContinue, onClean, onRegenerate, onRemoveWatermark, regenAvailable, regenBounds,
  copy, onRefine, onPromptFrom,
  annotation, onAnnotationChange, onPromptChange, onPosterChange, getPlayhead, onTrimClip, onDelete, onToggleHidden, videoRef,
  variantGroup, onSelectVariant, onFilmLook, pageActions, rating,
  quickEditParams, onQuickEditQueued, quickEditReferenceChoices, onVerificationChange,
}) {
  // One subscription for the pane: feeds both the "Used in" list and the
  // delete confirm.
  const usages = useMediaUsages()[mediaAnnotationKey(item)] ?? null;
  const verificationRef = useRef(null);
  const scrollToVerification = () => {
    verificationRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  return (
    <aside
      className={`${ASIDE_CLASSES} ${DETAILS_ASIDE_SIZE}`}
      onClick={(e) => e.stopPropagation()}
      // Same containment, minus Escape: a keystroke from a focused control in
      // this sidebar (an annotation field, a toggle) must not bubble to the
      // overlay's onClick={onClose}, but Escape still needs to reach the
      // window-level listener that owns close-precedence.
      onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation(); }}
    >
      {item.raw?.appId && <a className="block p-3 text-port-accent" href={`/apps/${encodeURIComponent(item.raw.appId)}/overview`}>Open source app</a>}
      <LightboxPaneHeader item={item} isVideo={isVideo} rating={rating} starred={!!annotation?.starred}
        onAnnotationChange={onAnnotationChange} onClose={onClose} />

      {/* Compact panes scroll actions with the fields so a wrapping footer cannot
          consume the entire editing area. Roomy viewports keep actions fixed. */}
      <div className="min-h-0 flex-1 overflow-y-auto roomy-viewport:overflow-hidden roomy-viewport:flex roomy-viewport:flex-col">
      <div className="p-3 space-y-3 text-xs roomy-viewport:min-h-0 roomy-viewport:flex-1 roomy-viewport:overflow-y-auto">
        {pageActions && <div data-testid="page-actions">{pageActions}</div>}
        <UsedIn usages={usages} onClose={onClose} />
        <LightboxPromptSection item={item} onPromptChange={onPromptChange} copy={copy} />

        {!item.compact && (
          <SentPromptPanel
            prompt={item.prompt === '(no prompt)' ? '' : item.prompt}
            sentPrompt={item.sentPrompt}
            sentNegativePrompt={item.sentNegativePrompt}
            additions={item.promptAdditions}
          />
        )}

        {onAnnotationChange && (
          <LightboxNoteEditor itemKey={item?.key} annotation={annotation} onAnnotationChange={onAnnotationChange} />
        )}

        <PeerNotes others={annotation?.others} />
        <NegativePrompt item={item} copy={copy} />
        <VariantSwitch item={item} variantGroup={variantGroup} onSelectVariant={onSelectVariant} />

        {isVideo && <ContinuationDetails continuation={item.raw?.continuation || item.continuation} />}

        <MetaList item={item} meta={meta} copy={copy} />

        {!isVideo && item.filename && (
          <div ref={verificationRef} className="pt-2 border-t border-port-border/60">
            <ImageVerificationDetails
              item={item}
              onVerificationChange={onVerificationChange}
            />
          </div>
        )}

        <HostedCopyRow key={item.key} item={item} />
      </div>

      <LightboxFooter
        item={item} isVideo={isVideo} usages={usages} onClose={onClose} onScrollToVerification={scrollToVerification}
        onRefine={onRefine} onPromptFrom={onPromptFrom} onRemix={onRemix} onSendToImage={onSendToImage}
        onSendToVideo={onSendToVideo} onSendTo3d={onSendTo3d} onContinue={onContinue} onFilmLook={onFilmLook}
        onClean={onClean} onRemoveWatermark={onRemoveWatermark} onRegenerate={onRegenerate}
        regenAvailable={regenAvailable} regenBounds={regenBounds}
        onPosterChange={onPosterChange} getPlayhead={getPlayhead} onTrimClip={onTrimClip} videoRef={videoRef}
        onDelete={onDelete} onToggleHidden={onToggleHidden}
        quickEditParams={quickEditParams} onQuickEditQueued={onQuickEditQueued} quickEditReferenceChoices={quickEditReferenceChoices}
      />
      </div>
    </aside>
  );
}
