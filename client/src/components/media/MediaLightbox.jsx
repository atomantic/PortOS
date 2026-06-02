import { useEffect, useRef, useState } from 'react';
import {
  X, Copy, Sparkles, Film, Image as ImageIcon, Download, Eraser,
  ChevronLeft, ChevronRight, Maximize2, Minimize2, Star,
} from 'lucide-react';
import PromptRefineModal from './PromptRefineModal';
import AddToCollectionMenu from './AddToCollectionMenu';
import MediaImage from '../MediaImage';
import { useScrollLock } from '../../hooks/useScrollLock';
import { useSwipeNav } from '../../hooks/useSwipeNav';
import { copyToClipboard } from '../../lib/clipboard';
import { IMAGE_GEN_MODE } from '../../lib/imageGenBackends';

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

const NOTE_MAX = 2000;
const NOTE_DEBOUNCE_MS = 500;
const SAVED_INDICATOR_MS = 1500;

// Window-level shortcuts (f, s, arrows) must skip editable targets — otherwise
// typing in the note textarea triggers fullscreen / favorite / nav instead of
// inserting text or moving the caret. Window listeners fire after the target,
// so preventDefault here still cancels the browser's default text behavior.
const isEditableTarget = (e) => {
  const t = e.target;
  return !!(t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable));
};

const CLEAN_TOOLTIP = 'Re-encode and denoise: removes the C2PA metadata chunk (when present) and reduces visible AI-generation artifacts. Does NOT defeat SynthID — gpt-image / Imagen / Gemini renders remain detectable by their vendor watermark checkers. Saves a new image alongside the original.';

// Three lineage cases:
//   - auto-cleaned (replaced in place): "Auto-cleaned (aggressive)"
//   - manually cleaned (sidecar copy):  "Cleaned (aggressive) from <orig>"
//   - neither: returns null and the meta row is dropped by the null-filter
function describeCleanedLineage(item) {
  if (item.autoCleaned) {
    return `Auto-cleaned (${item.cleanLevel || 'aggressive'})${item.c2paStripped ? ' · C2PA stripped' : ''}`;
  }
  if (item.cleanedFrom) {
    return `${item.cleanLevel ? `Cleaned (${item.cleanLevel}) ` : 'Cleaned '}from ${item.cleanedFrom}`;
  }
  return null;
}

// onClean(item) — optional. Returning a rejected promise keeps the lightbox
// open (e.g. on error) so the user can retry.
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
  onSendToVideo,
  onContinue,
  onClean,
  onPrevious,
  onNext,
  hasPrevious = false,
  hasNext = false,
  annotation = null,
  onAnnotationChange,
  variantGroup = null,
  onSelectVariant,
}) {
  const [fullScreen, setFullScreen] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  useScrollLock(!!item);
  // Read callbacks + frequently-changing values from refs so the keydown
  // listener and the note-save debounce don't tear down on every parent
  // render. Callers pass inline arrows for onAnnotationChange, and the
  // parent re-renders constantly while media-gen events stream in.
  const starred = !!annotation?.starred;
  const refs = useRef({ onClose, onPrevious, onNext, onAnnotationChange, starred });
  useEffect(() => { refs.current = { onClose, onPrevious, onNext, onAnnotationChange, starred }; });
  const videoRef = useRef(null);
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
        if (fullScreen) { setFullScreen(false); return; }
        cb.onClose();
        return;
      }
      const inEditable = isEditableTarget(e);
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
  }, [item, hasPrevious, hasNext, fullScreen, refineOpen]);

  // Reset refine modal when the previewed item changes.
  useEffect(() => { setRefineOpen(false); }, [item?.key]);

  const { onTouchStart, onTouchEnd } = useSwipeNav({ onPrevious, onNext, hasPrevious, hasNext });

  if (!item) return null;
  const isVideo = item.kind === 'video';

  const copy = (text, label = 'Prompt') => {
    copyToClipboard(text, `${label} copied`);
  };

  const isCodex = item.mode === IMAGE_GEN_MODE.CODEX;
  // Map raw `entryKind` tokens to user-facing labels — the sidecar stores
  // 'canon' / 'variation' / 'sheet' (ENTRY_REF_KIND values) for parity with
  // the server contract; users shouldn't see the wire tokens.
  const entryKindLabel = ({ canon: 'Canon entry', variation: 'Category variation', sheet: 'Composite sheet' })[item.entryKind] || item.entryKind;
  const cleanedLabel = describeCleanedLineage(item);

  const meta = [
    // Universe Builder context — placed first so "this is Ash from MyVerse"
    // reads before the technical render params. Sidecars without a universe
    // tag fall through the existing null-filter at the end.
    ['Universe', item.universeName],
    ['Entity', item.entryName],
    ['Kind', entryKindLabel],
    ['Category', item.entryCategory],
    ['Model', item.modelId],
    ['Resolution', item.width && item.height ? `${item.width}×${item.height}` : null],
    ['Steps', item.steps],
    ['Guidance', item.guidance],
    ['CFG', item.raw?.cfgScale ?? item.raw?.cfg_scale],
    ['Quantize', item.quantize],
    // Codex doesn't expose a seed; show "n/a" rather than hiding the row so
    // it's clear why — and surface the codex session-id below as the closest
    // unique-run identifier.
    ['Seed', item.seed ?? (isCodex ? 'n/a (gpt-image-2)' : null)],
    ['Codex session', item.codexSessionId],
    ['Cleaned', cleanedLabel],
    ['Frames', item.numFrames],
    ['FPS', item.fps],
    ['Created', item.createdAt && new Date(item.createdAt).toLocaleString()],
  ].filter(([, v]) => v != null && v !== '');

  const cardClasses = fullScreen
    ? 'relative w-full h-full bg-black flex'
    : 'relative bg-port-card border border-port-border rounded-xl overflow-hidden max-w-6xl w-full max-h-[92vh] flex flex-col md:flex-row';
  const overlayPad = fullScreen ? 'p-0' : 'p-4';
  const imgMax = fullScreen ? 'max-w-[100vw] max-h-[100vh]' : 'max-w-full max-h-[92vh]';
  // Anchor low in fullscreen so the chevrons land in the letterbox bar of a
  // landscape image instead of covering it. Non-fullscreen keeps them centered
  // — bottom-anchoring would bury them in the SettingsPane underneath.
  const chevronPositionClass = fullScreen ? 'bottom-4' : 'top-1/2 -translate-y-1/2';

  return (
    <div
      role="presentation"
      className={`fixed inset-0 z-50 bg-black/90 flex items-center justify-center ${overlayPad}`}
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      {hasPrevious && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onPrevious?.(); }}
          className={`absolute left-3 md:left-5 ${chevronPositionClass} z-30 p-2.5 text-white/80 hover:text-white bg-black/40 hover:bg-black/60 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-port-accent rounded-full`}
          aria-label="Previous media"
          title="Previous"
        >
          <ChevronLeft className="w-6 h-6" />
        </button>
      )}
      {hasNext && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onNext?.(); }}
          className={`absolute right-3 md:right-5 ${chevronPositionClass} z-30 p-2.5 text-white/80 hover:text-white bg-black/40 hover:bg-black/60 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-port-accent rounded-full`}
          aria-label="Next media"
          title="Next"
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      )}
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
        >
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
          ) : (
            <MediaImage src={item.previewUrl} alt={item.prompt} className={`${imgMax} object-contain`} placeholderClassName="w-full h-full" />
          )}
          {/* Fail-safe close — the SettingsPane's X is hidden in fullscreen
              and unreachable if iOS Safari mis-lays out the page. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="absolute top-2 left-2 z-30 p-2 rounded-full bg-white text-black hover:bg-white/85 shadow-lg focus:outline-none focus:ring-2 focus:ring-port-accent"
            aria-label="Close"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
          {/* Solid white pill keeps it readable against black letterbox bars. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setFullScreen((v) => !v); }}
            className="absolute top-2 right-2 z-30 p-2 rounded-full bg-white text-black hover:bg-white/85 shadow-lg focus:outline-none focus:ring-2 focus:ring-port-accent"
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

        {!fullScreen && (
          <SettingsPane
            item={item}
            meta={meta}
            isVideo={isVideo}
            onClose={onClose}
            onRemix={onRemix}
            onSendToVideo={onSendToVideo}
            onContinue={onContinue}
            onClean={onClean}
            copy={copy}
            onRefine={() => setRefineOpen(true)}
            annotation={annotation}
            onAnnotationChange={onAnnotationChange}
            variantGroup={variantGroup}
            onSelectVariant={onSelectVariant}
          />
        )}
      </div>
      <PromptRefineModal item={item} open={refineOpen} onClose={() => setRefineOpen(false)} />
    </div>
  );
}

function PeerNotes({ others }) {
  if (!Array.isArray(others) || others.length === 0) return null;
  return (
    <div>
      <div className="mb-1">
        <span className="text-gray-500 uppercase tracking-wide text-xs">Notes from others</span>
      </div>
      <ul className="space-y-2">
        {others.map((o) => (
          <li key={o.instanceId} className="rounded border border-port-border bg-port-bg/50 p-2">
            <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
              <span className="flex items-center gap-1.5 text-gray-300">
                {o.starred && <Star className="w-3 h-3 fill-current text-port-warning" />}
                <span>{o.authorName || 'Unknown'}</span>
              </span>
              <span>{o.updatedAt ? new Date(o.updatedAt).toLocaleDateString() : ''}</span>
            </div>
            {o.note && <p className="text-gray-200 whitespace-pre-wrap text-xs">{o.note}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SettingsPane({
  item, meta, isVideo,
  onClose, onRemix, onSendToVideo, onContinue, onClean,
  copy, onRefine,
  annotation, onAnnotationChange,
  variantGroup, onSelectVariant,
}) {
  const asideClasses = 'md:w-80 lg:w-96 shrink-0 flex flex-col border-t md:border-t-0 md:border-l border-port-border max-h-[40vh] md:max-h-[92vh]';
  const [cleaning, setCleaning] = useState(false);
  const starred = !!annotation?.starred;
  const closeThenRun = (handler) => {
    onClose?.();
    handler?.(item);
  };
  // Local draft state debounces saves so each keystroke doesn't PATCH.
  // onSaveRef keeps the debounce effect off the parent's render churn —
  // page components pass inline-arrow onAnnotationChange callbacks, which
  // would otherwise restart the timer every time a media-gen event arrived.
  const [noteDraft, setNoteDraft] = useState(annotation?.note ?? '');
  const [saveStatus, setSaveStatus] = useState('idle');
  const onSaveRef = useRef(onAnnotationChange);
  const pendingNoteRef = useRef(null);
  useEffect(() => { onSaveRef.current = onAnnotationChange; });
  // Sync noteDraft to whatever the server says (server push, save echo,
  // initial load). Kept separate from the item-swap effect so a successful
  // save's prop update doesn't also reset saveStatus and hide "Saved".
  useEffect(() => {
    setNoteDraft(annotation?.note ?? '');
  }, [item?.key, annotation?.note]);
  // On item swap (or full unmount): flush any pending note to the *old* item's
  // save callback before resetting local state. onSaveRef still holds the old
  // closure at cleanup time because React runs effect cleanups before the new
  // render's ref-update effect body fires. Without this, prev/next silently
  // drops a mid-debounce edit.
  useEffect(() => {
    setSaveStatus('idle');
    return () => {
      if (pendingNoteRef.current !== null && onSaveRef.current) {
        onSaveRef.current({ note: pendingNoteRef.current });
        pendingNoteRef.current = null;
      }
    };
  }, [item?.key]);
  useEffect(() => {
    if (!onSaveRef.current) return undefined;
    if (noteDraft === (annotation?.note ?? '')) {
      pendingNoteRef.current = null;
      return undefined;
    }
    pendingNoteRef.current = noteDraft;
    setSaveStatus('pending');
    const handle = setTimeout(() => {
      onSaveRef.current?.({ note: noteDraft });
      pendingNoteRef.current = null;
      setSaveStatus('saved');
    }, NOTE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [noteDraft, annotation?.note]);
  useEffect(() => {
    if (saveStatus !== 'saved') return undefined;
    const handle = setTimeout(() => setSaveStatus('idle'), SAVED_INDICATOR_MS);
    return () => clearTimeout(handle);
  }, [saveStatus]);
  return (
    <aside className={asideClasses} onClick={(e) => e.stopPropagation()}>
      <header className="flex items-center justify-between p-3 border-b border-port-border">
        <span className="text-xs uppercase tracking-wide text-gray-400">{isVideo ? 'Video' : 'Image'} settings</span>
        <div className="flex items-center gap-1">
          {onAnnotationChange && (
            <button
              type="button"
              onClick={() => onAnnotationChange({ starred: !starred })}
              className={`p-1.5 rounded ${starred ? 'bg-port-warning/90 text-black' : 'text-gray-400 hover:text-white hover:bg-port-border/50'}`}
              aria-label={starred ? 'Unfavorite' : 'Favorite'}
              title={starred ? 'Unfavorite (s)' : 'Favorite (s)'}
            >
              <Star className={`w-4 h-4 ${starred ? 'fill-current' : ''}`} />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
        {item.prompt && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-gray-500 uppercase tracking-wide">Prompt</span>
              <button
                type="button"
                onClick={() => copy(item.prompt, 'Prompt')}
                className="p-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
                title="Copy prompt"
              >
                <Copy className="w-3 h-3" />
              </button>
            </div>
            <p className="text-gray-200 whitespace-pre-wrap">{item.prompt}</p>
          </div>
        )}

        {onAnnotationChange && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-gray-500 uppercase tracking-wide">My note</span>
              <div className="flex items-center gap-2 text-[10px] text-gray-500">
                {saveStatus === 'pending' && <span>Saving…</span>}
                {saveStatus === 'saved' && <span className="text-port-success">Saved</span>}
                {saveStatus === 'idle' && <span>Saves automatically</span>}
                <span>{noteDraft.length}/{NOTE_MAX}</span>
              </div>
            </div>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value.slice(0, NOTE_MAX))}
              placeholder="Add a note — use this for cover, reshoot at 24fps, etc."
              rows={3}
              maxLength={NOTE_MAX}
              className="w-full bg-port-bg border border-port-border rounded p-2 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-port-accent resize-y"
            />
          </div>
        )}

        <PeerNotes others={annotation?.others} />

        {item.negativePrompt && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-gray-500 uppercase tracking-wide">Negative</span>
              <button
                type="button"
                onClick={() => copy(item.negativePrompt, 'Negative prompt')}
                className="p-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
                title="Copy negative prompt"
              >
                <Copy className="w-3 h-3" />
              </button>
            </div>
            <p className="text-gray-300 whitespace-pre-wrap">{item.negativePrompt}</p>
          </div>
        )}

        {variantGroup && onSelectVariant && (
          <div>
            <div className="text-gray-500 uppercase tracking-wide text-xs mb-1">View</div>
            <div className="flex items-stretch rounded overflow-hidden border border-port-border">
              {variantGroup.group.map((entry) => {
                const isActive = entry.item.filename === item.filename;
                return (
                  <button
                    key={entry.item.filename}
                    type="button"
                    onClick={() => { if (!isActive) onSelectVariant(entry.item); }}
                    aria-pressed={isActive}
                    className={`flex-1 px-2 py-1.5 text-xs border-r border-port-border last:border-r-0 transition-colors ${
                      isActive
                        ? 'bg-port-accent text-white cursor-default'
                        : 'bg-port-bg text-gray-300 hover:text-white hover:bg-port-border/50'
                    }`}
                  >
                    {entry.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {meta.length > 0 && (
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
            {meta.map(([k, v]) => {
              const copyable = (k === 'Seed' && item.seed != null) || k === 'Codex session';
              return (
                <div key={k} className="contents">
                  <dt className="text-gray-500">{k}</dt>
                  <dd className="text-gray-200 break-all flex items-center gap-1.5">
                    <span>{String(v)}</span>
                    {copyable && (
                      <button
                        type="button"
                        onClick={() => copy(String(v), k)}
                        className="p-0.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
                        title={`Copy ${k.toLowerCase()}`}
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </div>

      <footer className="flex flex-wrap gap-1.5 p-3 border-t border-port-border">
        {onRefine && item.prompt && item.prompt !== '(no prompt)' && (
          <button
            type="button"
            onClick={onRefine}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-accent/80 text-white hover:opacity-90 rounded"
          >
            <Sparkles className="w-3.5 h-3.5" /> Refine Prompt
          </button>
        )}
        {onRemix && (
          <button
            type="button"
            onClick={() => closeThenRun(onRemix)}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-accent text-white hover:opacity-90 rounded"
          >
            <Sparkles className="w-3.5 h-3.5" /> Remix
          </button>
        )}
        {!isVideo && onSendToVideo && (
          <button
            type="button"
            onClick={() => closeThenRun(onSendToVideo)}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-success text-white hover:opacity-90 rounded"
          >
            <Film className="w-3.5 h-3.5" /> Send to Video
          </button>
        )}
        {!isVideo && onClean && (
          <button
            type="button"
            disabled={cleaning}
            onClick={async () => {
              if (cleaning) return;
              setCleaning(true);
              let ok = false;
              try {
                await onClean(item);
                ok = true;
              } catch {
                // Caller toasts its own error; stay open so the user can retry.
              } finally {
                setCleaning(false);
              }
              if (ok) onClose();
            }}
            title={CLEAN_TOOLTIP}
            aria-label="Clean image"
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-warning/80 text-white hover:opacity-90 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Eraser className="w-3.5 h-3.5" /> {cleaning ? 'Cleaning…' : 'Clean'}
          </button>
        )}
        {isVideo && onContinue && (
          <button
            type="button"
            onClick={() => closeThenRun(onContinue)}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-accent text-white hover:opacity-90 rounded"
          >
            <ImageIcon className="w-3.5 h-3.5" /> Continue
          </button>
        )}
        <AddToCollectionMenu item={item} size="md" />
        <a
          href={item.downloadUrl}
          download
          className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-border hover:bg-port-border/70 text-white rounded"
        >
          <Download className="w-3.5 h-3.5" />
        </a>
      </footer>
    </aside>
  );
}
