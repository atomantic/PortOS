import { useEffect, useRef, useState } from 'react';
import {
  X, Copy, Sparkles, Film, Image as ImageIcon, Download, Eraser,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import toast from '../ui/Toast';

// Mirror of CLEAN_LEVELS in server/routes/imageClean.js. If the server adds a
// new level, drop a label here and the pill renders automatically.
const CLEAN_LEVEL_LABELS = { light: 'Light', aggressive: 'Aggressive' };

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
        cb.onClose();
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
  }, [item, hasPrevious, hasNext]);

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

  const meta = [
    ['Model', item.modelId],
    ['Resolution', item.width && item.height ? `${item.width}×${item.height}` : null],
    ['Steps', item.steps],
    ['Guidance', item.guidance],
    ['CFG', item.raw?.cfgScale ?? item.raw?.cfg_scale],
    ['Quantize', item.quantize],
    ['Seed', item.seed],
    ['Frames', item.numFrames],
    ['FPS', item.fps],
    ['Created', item.createdAt && new Date(item.createdAt).toLocaleString()],
  ].filter(([, v]) => v != null && v !== '');

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      {hasPrevious && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onPrevious?.(); }}
          className="absolute left-3 md:left-5 top-1/2 -translate-y-1/2 z-10 p-2.5 rounded-full bg-black/55 text-white border border-white/15 hover:bg-black/75 focus:outline-none focus:ring-2 focus:ring-port-accent"
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
          className="absolute right-3 md:right-5 top-1/2 -translate-y-1/2 z-10 p-2.5 rounded-full bg-black/55 text-white border border-white/15 hover:bg-black/75 focus:outline-none focus:ring-2 focus:ring-port-accent"
          aria-label="Next media"
          title="Next"
        >
          <ChevronRight className="w-6 h-6" />
        </button>
      )}
      <div
        className="relative bg-port-card border border-port-border rounded-xl overflow-hidden max-w-6xl w-full max-h-[92vh] flex flex-col md:flex-row"
        onClick={(e) => e.stopPropagation()}
        role="presentation"
        // Pin card/border alpha to 1 inside this focused modal so glass-style themes
        // (Lumen Glass Day, Pastel Dawn, etc.) render an opaque panel against the
        // bg-black/90 overlay — the translucent default makes button text illegible.
        style={{ '--port-card-alpha': 1, '--port-border-alpha': 1 }}
      >
        <div className="flex-1 bg-black flex items-center justify-center min-h-0">
          {isVideo ? (
            <video src={item.downloadUrl} controls autoPlay loop className="max-w-full max-h-[92vh]" />
          ) : (
            <img src={item.previewUrl} alt={item.prompt} className="max-w-full max-h-[92vh] object-contain" />
          )}
        </div>

        <aside className="md:w-80 lg:w-96 shrink-0 flex flex-col border-t md:border-t-0 md:border-l border-port-border max-h-[40vh] md:max-h-[92vh]">
          <header className="flex items-center justify-between p-3 border-b border-port-border">
            <span className="text-xs uppercase tracking-wide text-gray-400">{isVideo ? 'Video' : 'Image'} settings</span>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
              aria-label="Close"
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
                {meta.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-gray-500">{k}</dt>
                    <dd className="text-gray-200 break-all">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>

          <footer className="flex flex-wrap gap-1.5 p-3 border-t border-port-border">
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
            <a
              href={item.downloadUrl}
              download
              className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-border hover:bg-port-border/70 text-white rounded"
            >
              <Download className="w-3.5 h-3.5" />
            </a>
          </footer>
        </aside>
      </div>
    </div>
  );
}
