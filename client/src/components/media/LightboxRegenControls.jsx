import { useCallback, useState } from 'react';
import { Wand2 } from 'lucide-react';
import FooterAction from './FooterAction.jsx';
import { runBusyAction } from './lightboxBusy.js';
import ModelInputPreview from './ModelInputPreview.jsx';
import { useModelInputPreview } from '../../hooks/useModelInputPreview.js';
import { previewRegenerate } from '../../services/apiImageVideo.js';

// SynthID-defeat regeneration. The toggle opens an inline panel (strength
// slider + optional prompt) so a pass can be tuned without leaving the
// lightbox. Slider bounds come from the server (`regenBounds`) so the floor
// stays in lock-step with route validation.
export default function LightboxRegenControls({ item, onClose, onRegenerate, regenAvailable, regenBounds }) {
  const { strengthMin: regenMin = 0.02, strengthMax: regenMax = 0.6, strengthDefault: regenDefault = 0.25 } = regenBounds || {};
  // CPU-only spatial fallback — always offered (sharp is server-side), so an
  // install without a FLUX runner can still attempt a (less reliable) pass.
  const regenLightAvailable = !!regenBounds?.lightAvailable;
  const [regenerating, setRegenerating] = useState(false);
  const [lightRegenerating, setLightRegenerating] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenStrength, setRegenStrength] = useState(regenDefault);
  // Track whether the user actually moved the slider. When untouched, the
  // request OMITS strength so the server picks its provider-aware default
  // (lighter for local-FLUX sources, conservative 0.25 for SynthID-bearing
  // ones). Always sending the slider's initialized value would pin 0.25 and
  // make that adaptive default unreachable from the UI.
  const [strengthTouched, setStrengthTouched] = useState(false);
  const [regenPrompt, setRegenPrompt] = useState('');
  const typedPrompt = regenPrompt.trim();
  // The server shows the typed prompt plus the source image's carried negative prompt before the send (#18642).
  const previewRegen = useCallback((body, options) => previewRegenerate(item.filename, body, options), [item.filename]);
  const modelInputPreview = useModelInputPreview(previewRegen, { prompt: typedPrompt }, {
    enabled: regenOpen && regenAvailable && !!item.filename && typedPrompt.length > 0,
  });
  const runLight = runBusyAction({ item, onClose, busy: lightRegenerating, setBusy: setLightRegenerating, action: (it) => onRegenerate(it, { method: 'light' }) });

  if (!onRegenerate) return null;

  // No FLUX runner installed, but the CPU spatial pass is always available
  // — offer it standalone so these installs aren't left with no SynthID
  // defeat path at all. Honestly labeled as less reliable.
  if (!regenAvailable) {
    if (!regenLightAvailable) return null;
    return (
      <FooterAction
        tone="accent80Busy"
        disabled={lightRegenerating}
        onClick={runLight}
        title="CPU-only spatial pass to disrupt SynthID watermarking (no GPU required). Less reliable than a FLUX round-trip; install a local FLUX runner for the stronger pass. Creates a new variant; the original is kept."
        aria-label="Light CPU regen to disrupt SynthID watermark"
      >
        <Wand2 className="w-3.5 h-3.5" /> {lightRegenerating ? 'Processing…' : 'Regen (light)'}
      </FooterAction>
    );
  }

  const runRegen = runBusyAction({
    item, onClose, busy: regenerating, setBusy: setRegenerating,
    action: (it) => onRegenerate(it, { strength: strengthTouched ? regenStrength : undefined, prompt: regenPrompt.trim() || undefined }),
  });

  return (
    <>
      <FooterAction
        active={regenOpen}
        onClick={() => setRegenOpen((o) => !o)}
        aria-expanded={regenOpen}
        title="Regenerate through a local FLUX model (img2img) to overwrite SynthID watermarking. Creates a new variant; the original is kept."
        aria-label="Regenerate image to defeat SynthID watermark"
      >
        <Wand2 className="w-3.5 h-3.5" /> Regenerate
      </FooterAction>
      {regenOpen && (
        <div className="w-full mt-1 p-2.5 rounded border border-port-border bg-port-bg/60 space-y-2">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="regen-strength" className="text-[11px] uppercase tracking-wide text-gray-400">Strength</label>
              <span className="text-xs text-gray-200 tabular-nums">{regenStrength.toFixed(2)}</span>
            </div>
            <input
              id="regen-strength"
              type="range"
              min={regenMin}
              max={regenMax}
              step={0.01}
              value={regenStrength}
              onChange={(e) => { setRegenStrength(Number(e.target.value)); setStrengthTouched(true); }}
              disabled={regenerating}
              className="w-full accent-port-accent"
            />
            <p className="mt-1 text-[10px] leading-snug text-gray-500">
              Lower = more faithful (a re-encode floor of ~8% change). The watermark is overwritten by the round-trip regardless; raise it only if a low value doesn’t clear your detector.
            </p>
          </div>
          <div>
            <label htmlFor="regen-prompt" className="block mb-1 text-[11px] uppercase tracking-wide text-gray-400">Prompt <span className="normal-case text-gray-500">(optional)</span></label>
            <input
              id="regen-prompt"
              type="text"
              value={regenPrompt}
              onChange={(e) => setRegenPrompt(e.target.value)}
              disabled={regenerating}
              placeholder="Leave empty for minimal change"
              className="w-full px-2 py-1 text-xs rounded bg-port-card border border-port-border text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-port-accent"
            />
            <ModelInputPreview preview={modelInputPreview} prompt={regenPrompt} />
          </div>
          <button
            type="button"
            disabled={regenerating || lightRegenerating}
            onClick={runRegen}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-accent text-white hover:opacity-90 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Wand2 className="w-3.5 h-3.5" /> {regenerating ? 'Queuing…' : strengthTouched ? `Regenerate at ${regenStrength.toFixed(2)}` : 'Regenerate'}
          </button>
          {regenLightAvailable && (
            <button
              type="button"
              disabled={regenerating || lightRegenerating}
              onClick={runLight}
              title="CPU-only spatial pass (no GPU). Faster, but less reliable than the FLUX round-trip."
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs bg-port-border hover:bg-port-border/70 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Wand2 className="w-3.5 h-3.5" /> {lightRegenerating ? 'Processing…' : 'Light (CPU, less reliable)'}
            </button>
          )}
        </div>
      )}
    </>
  );
}
