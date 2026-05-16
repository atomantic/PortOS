import { useEffect, useRef, useState } from 'react';
import {
  X, Copy, Sparkles, Film, Image as ImageIcon, Download, Eraser,
  ChevronLeft, ChevronRight, Maximize2, Minimize2, Star,
} from 'lucide-react';
import toast from '../ui/Toast';
import PromptRefineModal from './PromptRefineModal';
import AddToCollectionMenu from './AddToCollectionMenu';
import { useScrollLock } from '../../hooks/useScrollLock';

// Intentionally NOT migrated to <ui/Modal>. The prev/next buttons sit as
// viewport-edge siblings of the card (not children of a constrained panel
// box), and the Esc cascade refineOpen → fullScreen → close is layered
// into the window keydown handler below. Modal would wrap children in a
// panel container and add its own Esc listener — both fight this
// lightbox's existing UX.

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

// Mirror of CLEAN_LEVELS in server/routes/imageClean.js. If the server adds a
// new level, drop a label here and the pill renders automatically.
const CLEAN_LEVEL_LABELS = { light: 'Light', aggressive: 'Aggressive' };

// Touch thresholds. dx > dy×1.2 keeps a diagonal scroll from being read as a
// nav swipe but stays forgiving for a real thumb swipe.
const SWIPE_MIN_PX = 50;

// onClean(item, level) — optional. Returning a rejected promise keeps the
// lightbox open (e.g. on error) so the user can retry.
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
}) {
  const [fullScreen, setFullScreen] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const touchStart = useRef({ x: null, y: null });
  useScrollLock(!!item);
  // Read callbacks + frequently-changing values from refs so the keydown
  // listener and the note-save debounce don't tear down on every parent
  // render. Callers pass inline arrows for onAnnotationChange, and the
  // parent re-renders constantly while media-gen events stream in.
  const starred = !!annotation?.starred;
  const refs = useRef({ onClose, onPrevious, onNext, onAnnotationChange, starred });
  useEffect(() => { refs.current = { onClose, onPrevious, onNext, onAnnotationChange, starred }; });
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

  if (!item) return null;
  const isVideo = item.kind === 'video';

  const copy = (text, label = 'Prompt') => {
    if (!text) return;
    if (!navigator.clipboard?.writeText) { toast.error('Clipboard unavailable on insecure context'); return; }
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error('Copy failed')
    );
  };

  const isCodex = item.mode === 'codex';
  const meta = [
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
    ['Frames', item.numFrames],
    ['FPS', item.fps],
    ['Created', item.createdAt && new Date(item.createdAt).toLocaleString()],
  ].filter(([, v]) => v != null && v !== '');

  // Ignore touches that originate on inline buttons (max/min toggle) so a
  // button tap isn't also read as a swipe-start on the image.
  const isButtonTouch = (e) => !!e.target.closest('button');
  const onTouchStart = (e) => {
    if (isButtonTouch(e)) { touchStart.current = { x: null, y: null }; return; }
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e) => {
    const start = touchStart.current;
    if (start.x == null) return;
    if (isButtonTouch(e)) { touchStart.current = { x: null, y: null }; return; }
    const end = e.changedTouches[0];
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    touchStart.current = { x: null, y: null };
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx > 0 && hasPrevious) onPrevious?.();
      else if (dx < 0 && hasNext) onNext?.();
    }
  };

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
            <video src={item.downloadUrl} controls autoPlay loop className={imgMax} />
          ) : (
            <img src={item.previewUrl} alt={item.prompt} className={`${imgMax} object-contain`} />
          )}
          {/* Solid white pill keeps it readable against black letterbox bars. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setFullScreen((v) => !v); }}
            className="absolute top-2 right-2 z-30 p-2 rounded-full bg-white text-black hover:bg-white/85 shadow-lg"
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
          />
        )}
      </div>
      <PromptRefineModal item={item} open={refineOpen} onClose={() => setRefineOpen(false)} />
    </div>
  );
}

function SettingsPane({
  item, meta, isVideo,
  onClose, onRemix, onSendToVideo, onContinue, onClean,
  copy, onRefine,
  annotation, onAnnotationChange,
}) {
  const asideClasses = 'md:w-80 lg:w-96 shrink-0 flex flex-col border-t md:border-t-0 md:border-l border-port-border max-h-[40vh] md:max-h-[92vh]';
  const [cleaning, setCleaning] = useState(null);
  const starred = !!annotation?.starred;
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
              <span className="text-gray-500 uppercase tracking-wide">Notes</span>
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
        {!isVideo && onRemix && (
          <button
            type="button"
            onClick={() => { onRemix(item); onClose(); }}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-accent text-white hover:opacity-90 rounded"
          >
            <Sparkles className="w-3.5 h-3.5" /> Remix
          </button>
        )}
        {!isVideo && onSendToVideo && (
          <button
            type="button"
            onClick={() => { onSendToVideo(item); onClose(); }}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-success text-white hover:opacity-90 rounded"
          >
            <Film className="w-3.5 h-3.5" /> Send to Video
          </button>
        )}
        {!isVideo && onClean && (
          <div
            className="flex items-stretch rounded overflow-hidden border border-port-border"
            role="group"
            aria-label="Clean image"
          >
            <span className="flex items-center gap-1 px-2 py-1.5 text-xs bg-port-border/40 text-gray-300">
              <Eraser className="w-3.5 h-3.5" /> Clean
            </span>
            {Object.entries(CLEAN_LEVEL_LABELS).map(([level, label]) => (
              <button
                key={level}
                type="button"
                disabled={cleaning != null}
                onClick={async () => {
                  if (cleaning) return;
                  setCleaning(level);
                  let ok = false;
                  try {
                    await onClean(item, level);
                    ok = true;
                  } catch {
                    // Caller toasts its own error; stay open so the user can retry.
                  } finally {
                    setCleaning(null);
                  }
                  if (ok) onClose();
                }}
                className={`px-2 py-1.5 text-xs border-l border-port-border text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed ${level === 'aggressive' ? 'bg-port-warning/80' : 'bg-port-border/70'}`}
              >
                {cleaning === level ? '…' : label}
              </button>
            ))}
          </div>
        )}
        {isVideo && onContinue && (
          <button
            type="button"
            onClick={() => { onContinue(item); onClose(); }}
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
