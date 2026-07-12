import { useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Sparkles, Pencil, ChevronDown, ChevronRight } from 'lucide-react';
import { generateImage } from '../services/api';
import { DEFAULT_NEGATIVE_PROMPT } from '../lib/imageGenDefaults';
import { RESOLUTIONS, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS } from '../lib/imageGenResolutions';
import ResolutionField from './media/ResolutionField';
import MediaJobThumb from './pipeline/MediaJobThumb';
import toast from './ui/Toast';

// Universal presets only (no `compatible` gate) so the quick widget can offer
// a resolution dropdown without knowing the active backend/model — these sizes
// render on every image-gen mode. The full Image Gen page keeps the
// backend-filtered list via ImageGenControls.
const QUICK_RESOLUTIONS = RESOLUTIONS.filter((r) => !r.compatible);

export default function QuickImagePrompt() {
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState(DEFAULT_NEGATIVE_PROMPT);
  const [showNegative, setShowNegative] = useState(false);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  // The current/last submission. `jobId` set → async backend (local/codex):
  // render the live MediaJobThumb so the user sees the diffusion spinner →
  // final image, exactly like the Universe asset slots. `filename` only →
  // sync external backend returned a completed render directly.
  const [job, setJob] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const navigate = useNavigate();

  const handleResolution = (w, h) => { setWidth(w); setHeight(h); };

  const handleGenerate = async (e) => {
    e?.preventDefault();
    const text = prompt.trim();
    if (!text || submittingRef.current) return;

    submittingRef.current = true;
    setIsSubmitting(true);

    // Omit `mode` so the server falls back to the user's saved
    // `settings.imageGen.mode` default. Async backends (local/codex) respond
    // with { jobId, status, position } — sync external responds with the
    // generation result ({ filename, path }). Send the negative prompt as-is
    // (empty string is an intentional clear; the server treats present-but-
    // empty as "no negative prompt"). Preserve the input on failure so the
    // user doesn't have to retype after a server error (the API helper toasts
    // on its own).
    const result = await generateImage({
      prompt: text,
      negativePrompt,
      width,
      height,
    }).catch(() => null);

    submittingRef.current = false;
    setIsSubmitting(false);
    if (result) {
      // Only clear if the textarea still holds the submitted text — the user
      // can keep typing while the request is in flight and we don't want to
      // wipe out new input on resolve.
      setPrompt((current) => (current === text ? '' : current));
      if (result.jobId) {
        setJob({ jobId: result.jobId, filename: null });
        toast.success('Image queued');
      } else if (result.filename) {
        setJob({ jobId: null, filename: result.filename });
        toast.success('Image generated');
      }
    }
  };

  const handleOpenInEditor = (e) => {
    e?.preventDefault();
    const text = prompt.trim();
    // ImageGen page's remix-param effect reads ?prompt=…&width=…&height=… on
    // mount and strips them from the URL, so the widget can hand off the
    // current prompt + size + negative prompt without coupling to the form's
    // internal state.
    const params = new URLSearchParams();
    if (text) params.set('prompt', text);
    if (negativePrompt) params.set('negativePrompt', negativePrompt);
    params.set('width', String(width));
    params.set('height', String(height));
    const qs = params.toString();
    navigate(`/media/image${qs ? `?${qs}` : ''}`);
  };

  const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent';

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 h-full flex flex-col min-h-0 overflow-y-auto">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h3 className="text-sm font-semibold text-white">Quick Image</h3>
        <Link to="/media/image" className="text-xs text-gray-500 hover:text-port-accent transition-colors">
          Image Gen &rarr;
        </Link>
      </div>
      <form onSubmit={handleGenerate} className="flex flex-col gap-2 flex-1 min-h-0">
        <label htmlFor="quick-image-prompt" className="sr-only">Image prompt</label>
        <textarea
          id="quick-image-prompt"
          placeholder="A neon-lit alley at dusk, cinematic, 50mm..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate(e);
          }}
          rows={3}
          className="flex-1 min-h-[60px] px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm resize-none"
        />

        {/* Shared preset dropdown + "Custom…" width/height inputs. Reuses the
            same control as the full Image Gen page so the quick widget offers
            custom sizes and (unlike the old inline <select>) never shows a
            blank dropdown for an off-preset/remix size — ResolutionField
            auto-opens the custom inputs and displays the W×H instead. The
            image route accepts any integer edge in [64, 3840] with total
            pixels ≤ 8.29M, so step=1 keeps hand-typed non-multiple-of-8 edges
            from tripping native form validation. */}
        <div className="shrink-0 flex flex-col gap-2">
          <ResolutionField
            presets={QUICK_RESOLUTIONS}
            width={width}
            height={height}
            onChange={handleResolution}
            min={64}
            max={MAX_IMAGE_EDGE}
            step={1}
            maxPixels={MAX_IMAGE_PIXELS}
            disabled={isSubmitting}
            inputClassName={`${inputCls} disabled:opacity-50`}
          />
        </div>

        <div className="shrink-0">
          <button
            type="button"
            onClick={() => setShowNegative((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-gray-400 hover:text-white transition-colors"
            aria-expanded={showNegative}
          >
            {showNegative ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Negative prompt
          </button>
          {showNegative && (
            <>
              <label htmlFor="quick-image-negative" className="sr-only">Negative prompt</label>
              <textarea
                id="quick-image-negative"
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder="Things to avoid…"
                rows={2}
                className="mt-1 w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm resize-none"
              />
            </>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="submit"
            disabled={!prompt.trim() || isSubmitting}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 min-h-[40px]"
            title="Generate with these settings"
          >
            <Sparkles size={14} />
            {isSubmitting ? 'Submitting…' : 'Generate'}
          </button>
          <button
            type="button"
            onClick={handleOpenInEditor}
            disabled={isSubmitting}
            className="flex items-center justify-center gap-2 px-3 py-2 border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 rounded-lg text-sm transition-colors disabled:opacity-50 min-h-[40px]"
            title="Open in editor with these settings"
          >
            <Pencil size={14} />
            Edit
          </button>
        </div>

        {job && (
          // Live render preview — async jobs stream the diffusion spinner /
          // step counter / latent frame and resolve to the final image;
          // sync results render the completed image directly (fallbackFilename
          // short-circuits the live subscription). Mirrors the Universe asset
          // slot via the shared MediaJobThumb.
          <div className="mt-1 shrink-0">
            <MediaJobThumb
              jobId={job.jobId || job.filename}
              fallbackFilename={job.jobId ? null : job.filename}
              size="fill"
              label="Quick image"
            />
          </div>
        )}
      </form>
    </div>
  );
}
