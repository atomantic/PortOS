import { useEffect } from 'react';
import { X, Copy, Sparkles, Film, Image as ImageIcon, Download } from 'lucide-react';
import toast from '../ui/Toast';

// Full-screen preview for a normalized media item (image or video). Shows the
// media on the left, all generation settings on the right with copy buttons
// for the prompts, plus contextual actions (Remix, Send to Video, Continue
// from last frame). Esc + backdrop click close. Caller wires action handlers.
export default function MediaLightbox({ item, onClose, onRemix, onSendToVideo, onContinue }) {
  useEffect(() => {
    if (!item) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [item, onClose]);

  if (!item) return null;
  const isVideo = item.kind === 'video';

  const copy = (text, label = 'Prompt') => {
    if (!text) return;
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
      <div
        className="relative bg-port-card border border-port-border rounded-xl overflow-hidden max-w-6xl w-full max-h-[92vh] flex flex-col md:flex-row"
        onClick={(e) => e.stopPropagation()}
        role="presentation"
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
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded"
              >
                <Sparkles className="w-3.5 h-3.5" /> Remix
              </button>
            )}
            {!isVideo && onSendToVideo && (
              <button
                type="button"
                onClick={() => { onSendToVideo(item); onClose(); }}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-success/20 hover:bg-port-success/40 text-port-success rounded"
              >
                <Film className="w-3.5 h-3.5" /> Send to Video
              </button>
            )}
            {isVideo && onContinue && (
              <button
                type="button"
                onClick={() => { onContinue(item); onClose(); }}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-accent/20 hover:bg-port-accent/40 text-port-accent rounded"
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
