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
import { useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { updateUniverse } from '../../services/api';
import { universeStylePreset } from '../../lib/universeStylePreset';
import useImageRenderSettings from '../../hooks/useImageRenderSettings';
import useSingleImageRender from '../../hooks/useSingleImageRender';
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

// Stable key for the influences a probe was actually built from. The render job
// is async — between queuing it and its completion the user can edit *and save*
// influences, which re-points the saved record. Capturing this key when the
// probe is queued lets the completion handler skip persisting if the live style
// has since drifted, so a stale image can't be pinned to a record built from
// different influences.
export const probeStyleKey = (universe) => JSON.stringify(buildStyleProbePrompt(universe));

// Decide whether a completed probe may be persisted onto the saved record. The
// render-time gate ensures a probe only STARTS while the style is clean, but the
// job is async — so the completion handler must re-confirm two things hold:
//   1. the draft still equals the saved record (`!styleDirty`) — otherwise the
//      image would pin to a record whose influences differ from the draft (e.g.
//      the user saved a different style, or reverted the draft without saving);
//   2. the live style still matches what the probe was queued against — so a
//      save-to-a-different-style mid-render can't pin a stale image either.
// Conservative by design: it would rather drop a still-valid image (asking for a
// harmless re-run) than ever pin one built from different influences.
export const shouldPersistProbe = ({ styleDirty, capturedKey, currentKey }) =>
  !styleDirty && capturedKey !== null && currentKey === capturedKey;

export default function StyleProbeImage({ universe, onUniverseChange, canRender = true, styleDirty = false, onPreview = null, onRenderComplete = null }) {
  const { imageCfg } = useImageRenderSettings();
  // The style key the in-flight probe was queued against, captured at render
  // time so the async completion can detect mid-render style drift.
  const probeStyleKeyRef = useRef(null);

  const styleReady = hasStyleForProbe(universe);
  // The probe prompt is built from the in-memory `influences`, but `onComplete`
  // persists only the resulting `styleImageRefs` to the SERVER's saved record.
  // When the draft's influences have unsaved edits, that record's influences are
  // still the prior values — so persisting the probe would pin it to style the
  // record never had (and it would survive even after the user discards the
  // draft). Block rendering until the style is saved.
  const canProbe = canRender && !styleDirty;

  const onComplete = async (filename) => {
    if (!universe?.id) return;
    // The probe job is async; only persist when the draft still equals the saved
    // record AND the live style matches what the probe was queued against — else
    // the image would pin to a record built from different influences (the very
    // mismatch the render-time gate exists to prevent).
    if (!shouldPersistProbe({ styleDirty, capturedKey: probeStyleKeyRef.current, currentKey: probeStyleKey(universe) })) {
      toast.error('Style changed while the base style rendered — re-run the probe');
      return;
    }
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

  const { jobId, render: queueRender, handleComplete } = useSingleImageRender({
    buildPrompt: () => buildStyleProbePrompt(universe),
    onComplete,
    onError: (err) => toast.error(err?.message || 'Style render failed'),
  });

  const render = async () => {
    if (styleDirty) { toast.error('Save your style changes before probing the base style'); return; }
    if (!styleReady) { toast.error('Add embrace influences before probing the base style'); return; }
    // Capture the style key the moment the job is queued so the async completion
    // can detect mid-render style drift.
    const probe = buildStyleProbePrompt(universe);
    const queuedJobId = await queueRender(imageCfg);
    if (queuedJobId) probeStyleKeyRef.current = JSON.stringify(probe);
  };

  const hasExistingImage = Array.isArray(universe?.styleImageRefs) && universe.styleImageRefs.length > 0;
  const regenerateEnabled = canProbe && Boolean(universe?.id) && styleReady && !jobId;

  return (
    <div className="flex items-start gap-3">
      <EntryThumbSlot
        imageRefs={universe?.styleImageRefs}
        inFlightJobId={jobId}
        onRender={render}
        onComplete={handleComplete}
        onPreview={onPreview}
        canRender={canProbe && Boolean(universe?.id) && styleReady}
        alt="Base style"
        size="xl"
      />
      <div className="text-xs text-gray-500 max-w-sm">
        <div className="text-gray-300 font-medium mb-0.5">Base style image</div>
        Rendered from the positive/negative influences with no subject — a quick read on the world's base visual
        emphasis. Style notes are excluded so this matches what downstream image prompts will actually use.
        {!styleReady && <span className="text-port-warning"> Add embrace influences first.</span>}
        {styleReady && styleDirty && (
          <span className="text-port-warning"> Save your style changes first — the probe renders from your current influences but pins to the saved universe.</span>
        )}
        {hasExistingImage ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={render}
              disabled={!regenerateEnabled}
              title={regenerateEnabled ? 'Render a new base style image' : (styleDirty ? 'Save your style changes first' : 'Add embrace influences or save the universe first')}
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
