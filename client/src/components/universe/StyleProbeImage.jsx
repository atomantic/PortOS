/**
 * Base "style probe" image for a universe.
 *
 * Generates a canonical image from the RAW style guide — `styleNotes` + the
 * influences embrace list (positive) and avoid list (negative) — with NO
 * character/subject, so the user can see the world's base visual emphasis on
 * its own. Reuses the same render path as canon renders (generateImage +
 * EntryThumbSlot spinner/display) and persists the resulting filename onto the
 * universe's `styleImageRefs[]` so it survives reload and shows in both the
 * Universe Builder and the Story Builder aesthetic step.
 */
import { useState, useEffect } from 'react';
import { generateImage, getSettings, updateUniverse } from '../../services/api';
import { universeStylePreset } from '../../lib/universeStylePreset';
import { pipelineImageCfgToRenderOpts, readPipelineImageSettings, PIPELINE_IMAGE_DEFAULTS } from '../../lib/pipelineImageDefaults';
import EntryThumbSlot from './EntryThumbSlot';
import toast from '../ui/Toast';

// Build the subject-less probe prompt from the universe's raw style guide.
// Positive = styleNotes prose + embrace tokens; negative = avoid tokens.
export function buildStyleProbePrompt(universe) {
  const preset = (universe && universeStylePreset(universe)) || { prompt: '', negativePrompt: '' };
  const positive = [universe?.styleNotes?.trim(), preset.prompt].filter(Boolean).join('. ');
  return { prompt: positive, negativePrompt: preset.negativePrompt || '' };
}

// True when there's enough style to make a meaningful probe.
export function hasStyleForProbe(universe) {
  const { prompt } = buildStyleProbePrompt(universe);
  return Boolean(prompt.trim());
}

export default function StyleProbeImage({ universe, onUniverseChange, canRender = true }) {
  const [imageCfg, setImageCfg] = useState(PIPELINE_IMAGE_DEFAULTS);
  const [jobId, setJobId] = useState(null);

  useEffect(() => {
    getSettings({ silent: true })
      .then((s) => setImageCfg(readPipelineImageSettings(s)))
      .catch(() => {});
  }, []);

  const styleReady = hasStyleForProbe(universe);

  const render = async () => {
    if (!styleReady) { toast.error('Add style notes or influences before probing the base style'); return; }
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
    const next = [...(Array.isArray(universe.styleImageRefs) ? universe.styleImageRefs : []), filename];
    const updated = await updateUniverse(universe.id, { styleImageRefs: next }, { silent: true })
      .catch(() => null);
    onUniverseChange?.(updated || { ...universe, styleImageRefs: next });
  };

  return (
    <div className="flex items-start gap-3">
      <EntryThumbSlot
        imageRefs={universe?.styleImageRefs}
        inFlightJobId={jobId}
        onRender={render}
        onComplete={onComplete}
        canRender={canRender && Boolean(universe?.id) && styleReady}
        alt="Base style"
        size="lg"
      />
      <div className="text-xs text-gray-500 max-w-sm">
        <div className="text-gray-300 font-medium mb-0.5">Base style image</div>
        Rendered from the raw style guide + positive/negative influences with no subject — a quick read on the
        world's base visual emphasis. {!styleReady && <span className="text-port-warning">Add style notes or influences first.</span>}
      </div>
    </div>
  );
}
