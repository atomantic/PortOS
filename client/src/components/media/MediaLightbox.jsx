import { useEffect, useRef, useState } from 'react';
import {
  X, Copy, Sparkles, Film, Image as ImageIcon, Download, Eraser,
  ChevronLeft, ChevronRight, Maximize2, Minimize2,
} from 'lucide-react';
import toast from '../ui/Toast';
import PromptRefineModal from './PromptRefineModal';

// Mirror of CLEAN_LEVELS in server/routes/imageClean.js. If the server adds a
// new level, drop a label here and the pill renders automatically.
const CLEAN_LEVEL_LABELS = { light: 'Light', aggressive: 'Aggressive' };

// Touch swipe thresholds. The horizontal-dominant guard (dx > dy×1.5) keeps a
// diagonal scroll on the iOS gallery from being read as a nav swipe.
const SWIPE_MIN_PX = 60;
const TAP_MAX_PX = 10;

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
}) {
  const [cleaning, setCleaning] = useState(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const touchStart = useRef({ x: null, y: null });
  // Read callbacks from refs so the keydown listener doesn't re-subscribe on
  // every parent render (callers pass inline arrows; the lightbox parent re-
  // renders constantly while media-gen events stream in).
  const callbacksRef = useRef({ onClose, onPrevious, onNext });
  useEffect(() => { callbacksRef.current = { onClose, onPrevious, onNext }; });
  useEffect(() => {
    if (!item) return;
    const onKey = (e) => {
      const cb = callbacksRef.current;
      if (e.key === 'Escape') {
        if (refineOpen) { setRefineOpen(false); return; }
        if (fullScreen && drawerOpen) { setDrawerOpen(false); return; }
        if (fullScreen) { setFullScreen(false); return; }
        cb.onClose();
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        setFullScreen((v) => !v);
        return;
      }
      if (e.key === 'ArrowLeft' && hasPrevious && cb.onPrevious) {
        e.preventDefault();
        cb.onPrevious();
      }
      if (e.key === 'ArrowRight' && hasNext && cb.onNext) {
        e.preventDefault();
        cb.onNext();
      }
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [item, hasPrevious, hasNext, fullScreen, drawerOpen, refineOpen]);

  // Reset drawer when item changes (swipe forwards w/ settings open shouldn't
  // carry the open state to the next image — feels jumpy).
  useEffect(() => { setDrawerOpen(false); setRefineOpen(false); }, [item?.key]);

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

  const onTouchStart = (e) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e) => {
    const start = touchStart.current;
    if (start.x == null) return;
    const end = e.changedTouches[0];
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    touchStart.current = { x: null, y: null };
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx > 0 && hasPrevious) onPrevious?.();
      else if (dx < 0 && hasNext) onNext?.();
      return;
    }
    if (fullScreen && Math.abs(dx) < TAP_MAX_PX && Math.abs(dy) < TAP_MAX_PX) {
      setDrawerOpen((o) => !o);
    }
  };

  const cardClasses = fullScreen
    ? 'relative w-full h-full bg-black flex'
    : 'relative bg-port-card border border-port-border rounded-xl overflow-hidden max-w-6xl w-full max-h-[92vh] flex flex-col md:flex-row';
  const overlayPad = fullScreen ? 'p-0' : 'p-4';
  const imgMax = fullScreen ? 'max-w-[100vw] max-h-[100vh]' : 'max-w-full max-h-[92vh]';

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
          className="absolute left-3 md:left-5 top-1/2 -translate-y-1/2 z-10 p-2.5 text-white/40 hover:text-white focus:outline-none focus:ring-2 focus:ring-port-accent rounded-full"
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
          className="absolute right-3 md:right-5 top-1/2 -translate-y-1/2 z-10 p-2.5 text-white/40 hover:text-white focus:outline-none focus:ring-2 focus:ring-port-accent rounded-full"
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
          {/* z-30 so this stays clickable when the settings drawer (z-20)
              slides in over the image area. Solid white pill keeps it
              readable against black letterbox bars. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setFullScreen((v) => !v); }}
            className="absolute top-2 right-2 z-30 p-2 rounded-full bg-white text-black hover:bg-white/85 shadow-lg"
            aria-label={fullScreen ? 'Exit full screen' : 'Full screen'}
            title={fullScreen ? 'Exit full screen (Esc, F)' : 'Full screen (F)'}
          >
            {fullScreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          {fullScreen && !drawerOpen && (
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-wide text-white/40 select-none pointer-events-none">
              tap for settings
            </div>
          )}
        </div>

        {(!fullScreen || drawerOpen) && (
          <SettingsPane
            item={item}
            meta={meta}
            isVideo={isVideo}
            fullScreen={fullScreen}
            onClose={fullScreen ? () => setDrawerOpen(false) : onClose}
            onPrimaryClose={onClose}
            onRemix={onRemix}
            onSendToVideo={onSendToVideo}
            onContinue={onContinue}
            onClean={onClean}
            cleaning={cleaning}
            setCleaning={setCleaning}
            copy={copy}
            onRefine={() => setRefineOpen(true)}
          />
        )}
      </div>
      <PromptRefineModal item={item} open={refineOpen} onClose={() => setRefineOpen(false)} />
    </div>
  );
}

function SettingsPane({
  item, meta, isVideo, fullScreen,
  onClose, onPrimaryClose, onRemix, onSendToVideo, onContinue, onClean,
  cleaning, setCleaning, copy, onRefine,
}) {
  const asideClasses = fullScreen
    ? 'absolute top-0 right-0 bottom-0 w-full sm:w-96 z-20 bg-port-card border-l border-port-border flex flex-col shadow-2xl'
    : 'md:w-80 lg:w-96 shrink-0 flex flex-col border-t md:border-t-0 md:border-l border-port-border max-h-[40vh] md:max-h-[92vh]';
  return (
    <aside className={asideClasses} onClick={(e) => e.stopPropagation()}>
      <header className="flex items-center justify-between p-3 border-b border-port-border">
        <span className="text-xs uppercase tracking-wide text-gray-400">{isVideo ? 'Video' : 'Image'} settings</span>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
          aria-label={fullScreen ? 'Hide settings' : 'Close'}
        >
          <X className="w-4 h-4" />
        </button>
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
            onClick={() => { onRemix(item); onPrimaryClose(); }}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-accent text-white hover:opacity-90 rounded"
          >
            <Sparkles className="w-3.5 h-3.5" /> Remix
          </button>
        )}
        {!isVideo && onSendToVideo && (
          <button
            type="button"
            onClick={() => { onSendToVideo(item); onPrimaryClose(); }}
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
                  if (ok) onPrimaryClose();
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
            onClick={() => { onContinue(item); onPrimaryClose(); }}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-accent text-white hover:opacity-90 rounded"
          >
            <ImageIcon className="w-3.5 h-3.5" /> Continue
          </button>
        )}
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
