/**
 * Base "style probe" image for a universe.
 *
 * Generates a canonical image from the same style preset every other image
 * prompt in the universe layers on (influences embrace = positive, avoid =
 * negative) with NO character/subject, so the user can see the world's base
 * visual emphasis on its own. `styleNotes` is intentionally NOT mixed in here
 * — that field is prose for writers + creative directors and never reaches
 * the image model, so including it in the probe would misrepresent what
 * downstream renders will look like. Reuses the same render path as canon
 * renders (generateImage + EntryThumbSlot spinner/display) and persists the
 * resulting filename onto the universe's `styleImageRefs[]` so it survives
 * reload and shows in both the Universe Builder and the Story Builder
 * aesthetic step.
 */
import { useState, useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { generateImage, getSettings, updateUniverse } from '../../services/api';
import { universeStylePreset } from '../../lib/universeStylePreset';
import { pipelineImageCfgToRenderOpts, readPipelineImageSettings, PIPELINE_IMAGE_DEFAULTS } from '../../lib/pipelineImageDefaults';
import EntryThumbSlot from './EntryThumbSlot';
import toast from '../ui/Toast';

// Build the subject-less probe prompt from the universe's influences. Mirrors
// the same preset every other image prompt uses, so the probe is an accurate
// preview of what downstream canon/sheet/comic renders will look like.
export function buildStyleProbePrompt(universe) {
  const preset = (universe && universeStylePreset(universe)) || { prompt: '', negativePrompt: '' };
  return { prompt: preset.prompt || '', negativePrompt: preset.negativePrompt || '' };
}

// True when there's enough style to make a meaningful probe.
export function hasStyleForProbe(universe) {
  const { prompt } = buildStyleProbePrompt(universe);
  return Boolean(prompt.trim());
}

export default function StyleProbeImage({ universe, onUniverseChange, canRender = true, onPreview = null, onRenderComplete = null }) {
  const [imageCfg, setImageCfg] = useState(PIPELINE_IMAGE_DEFAULTS);
  const [jobId, setJobId] = useState(null);
  // MediaJobThumb's onFilename effect can fire more than once — process each
  // completed filename's persist exactly once.
  const processedRef = useRef(new Set());

  useEffect(() => {
    getSettings({ silent: true })
      .then((s) => setImageCfg(readPipelineImageSettings(s)))
      .catch(() => {});
  }, []);

  const styleReady = hasStyleForProbe(universe);

  const render = async () => {
    if (!styleReady) { toast.error('Add embrace influences before probing the base style'); return; }
    const baseOpts = pipelineImageCfgToRenderOpts(imageCfg);
    const probe = buildStyleProbePrompt(universe);
    const queued = await generateImage(
      { ...baseOpts, prompt: probe.prompt, negativePrompt: probe.negativePrompt || undefined },
      { silent: true },
    ).catch((err) => { toast.error(err?.message || 'Style render failed'); return null; });
    if (!queued?.jobId) return;
    setJobId(queued.jobId);
  };

  const onComplete = async (filename) => {
    setJobId(null);
    if (!filename || !universe?.id) return;
    if (processedRef.current.has(filename)) return; // multi-fire guard
    processedRef.current.add(filename);
    const existing = Array.isArray(universe.styleImageRefs) ? universe.styleImageRefs : [];
    if (existing.includes(filename)) return;
    const next = [...existing, filename];
    const updated = await updateUniverse(universe.id, { styleImageRefs: next }, { silent: true })
      .catch(() => null);
    // Only reflect the new ref when the save actually succeeded — otherwise the
    // draft would show an image the server never persisted.
    if (updated) {
      onUniverseChange?.(updated);
      // The render's sidecar exists now — let the parent refresh whatever
      // gallery-metadata map drives the lightbox so the preview opens with
      // the real prompt/settings instead of falling back to the row label.
      onRenderComplete?.(filename);
    }
  };

  const hasExistingImage = Array.isArray(universe?.styleImageRefs) && universe.styleImageRefs.length > 0;
  const regenerateEnabled = canRender && Boolean(universe?.id) && styleReady && !jobId;

  return (
    <div className="flex items-start gap-3">
      <EntryThumbSlot
        imageRefs={universe?.styleImageRefs}
        inFlightJobId={jobId}
        onRender={render}
        onComplete={onComplete}
        onPreview={onPreview}
        canRender={canRender && Boolean(universe?.id) && styleReady}
        alt="Base style"
        size="xl"
      />
      <div className="text-xs text-gray-500 max-w-sm">
        <div className="text-gray-300 font-medium mb-0.5">Base style image</div>
        Rendered from the positive/negative influences with no subject — a quick read on the world's base visual
        emphasis. Style notes are excluded so this matches what downstream image prompts will actually use.
        {!styleReady && <span className="text-port-warning"> Add embrace influences first.</span>}
        {hasExistingImage ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={render}
              disabled={!regenerateEnabled}
              title={regenerateEnabled ? 'Render a new base style image' : 'Add embrace influences or save the universe first'}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-port-border bg-port-bg/40 text-gray-300 hover:border-port-accent/50 hover:text-port-accent hover:bg-port-accent/5 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-port-border disabled:hover:text-gray-300 disabled:hover:bg-port-bg/40 transition-colors"
            >
              <Sparkles size={12} />
              Regenerate
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
