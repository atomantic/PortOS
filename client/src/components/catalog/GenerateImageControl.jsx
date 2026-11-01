import { useCallback, useId, useRef, useState } from 'react';
import { Loader2, SlidersHorizontal, Sparkles } from 'lucide-react';
import { generateImage } from '../../services/apiSystem';
import { getUniverse } from '../../services/apiUniverseBuilder';
import { getCatalogFamilyContext } from '../../services/apiCatalog';
import { previewImagePrompt } from '../../services/apiImageVideo';
import { composeStyledPrompt, stylePromptAdditions } from '../../lib/composeStyledPrompt';
import { universeStylePreset, withUniverseLabel } from '../../lib/universeStylePreset';
import { useModelInputPreview } from '../../hooks/useModelInputPreview';
import useMounted from '../../hooks/useMounted';
import Modal from '../ui/Modal';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';
import toast from '../ui/Toast';
import ModelInputPreview from '../media/ModelInputPreview';
import MediaJobThumb from '../pipeline/MediaJobThumb';

// A character's family (picked on its record) rides along as labeled blocks
// after the user's words, plus the relatives' images when they are included.
function buildRequest(prompt, negativePrompt, universe, family, includeFamilyImages) {
  const preset = universe ? withUniverseLabel(universeStylePreset(universe)) : null;
  const composed = composeStyledPrompt(prompt, negativePrompt, preset);
  const images = includeFamilyImages ? family?.images || [] : [];
  const familyAdditions = [...(family?.additions || []), ...(images.length && family?.imagesAddition ? [family.imagesAddition] : [])];
  const additions = [...stylePromptAdditions(preset), ...familyAdditions];
  return { prompt: [composed.prompt, ...familyAdditions.map((a) => a.text)].join('\n\n'), negativePrompt: composed.negativePrompt || undefined,
    ...(universe?.id ? { universeRun: { universeId: universe.id, universeName: universe.name || universe.id } } : {}),
    ...(images.length ? { referenceImageFiles: images.map((image) => image.filename) } : {}),
    ...(additions.length ? { promptAdditions: additions } : {}) };
}

// Both shortcuts use the same composition and durable catalog completion hook.
// The editor portals out of card stacking/overflow contexts.
export default function GenerateImageControl({ ingredientId, name, description, universeId, onComplete,
  loadSource, quick = false, disabled = false }) {
  const mounted = useMounted();
  const fieldId = useId();
  const inFlight = useRef(false);
  const promptEdited = useRef(false);
  const [jobId, setJobId] = useState(null);
  const [starting, setStarting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [prefilling, setPrefilling] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [universe, setUniverse] = useState(null);
  const [family, setFamily] = useState(null);
  const [includeFamilyImages, setIncludeFamilyImages] = useState(true);
  const [sourceError, setSourceError] = useState(null);

  const prepare = async () => {
    const source = loadSource ? await loadSource() : { name, description, universeId };
    const [world, kin] = await Promise.all([
      source.universeId ? getUniverse(source.universeId, { silent: true }) : null,
      ingredientId ? getCatalogFamilyContext(ingredientId, { silent: true }) : null,
    ]);
    if (source.universeId && !world) throw new Error('Unable to load the universe style. Retry before generating.');
    if (ingredientId && !kin) throw new Error('Unable to load this character’s family. Retry before generating.');
    return { seed: source.description ? `${source.name || 'Subject'}: ${source.description}` : source.name || 'Subject', world, kin };
  };

  const submit = async (request) => {
    const queued = await generateImage({ ...request, ...(ingredientId ? { catalogIngredientId: ingredientId } : {}) }, { silent: true });
    if (!mounted.current) return;
    if (queued?.jobId) {
      setJobId(queued.jobId);
      toast.success('Generating image…');
    } else if (queued?.filename) {
      await onComplete?.(queued.filename);
    } else throw new Error('Image generation returned no result');
    setEditing(false);
  };

  const run = async (direct) => {
    if (disabled || inFlight.current || jobId) return;
    inFlight.current = true;
    setSourceError(null);
    if (direct) setStarting(true);
    else { setEditing(true); setPrefilling(true); }
    await prepare().then(async ({ seed, world, kin }) => {
      if (!mounted.current) return;
      setUniverse(world);
      setFamily(kin);
      if (direct) await submit(buildRequest(seed, '', world, kin, includeFamilyImages));
      else if (!promptEdited.current) setPrompt(seed);
    }).catch(error => {
      if (mounted.current) { setSourceError(error.message); toast.error(error.message || 'Could not prepare image generation'); }
    }).finally(() => {
      inFlight.current = false;
      if (mounted.current) { setStarting(false); setPrefilling(false); }
    });
  };

  const previewBody = buildRequest(prompt, negativePrompt, universe, family, includeFamilyImages);
  const familyImages = family?.images || [];
  const modelInputPreview = useModelInputPreview(previewImagePrompt, previewBody, {
    enabled: editing && !prefilling && !sourceError && prompt.trim().length > 0,
  });
  const handleRender = async () => {
    if (disabled || inFlight.current || sourceError || !prompt.trim()) return;
    inFlight.current = true;
    setStarting(true);
    await submit(previewBody).catch(error => { if (mounted.current) toast.error(error.message || 'Image generation failed'); })
      .finally(() => { inFlight.current = false; if (mounted.current) setStarting(false); });
  };
  const handleFilename = useCallback(filename => {
    if (!filename) return;
    setJobId(null);
    onComplete?.(filename);
  }, [onComplete]);
  const handleStatus = useCallback(status => {
    if (status === 'failed' || status === 'canceled') {
      setJobId(null);
      if (status === 'failed') toast.error('Image generation failed');
    }
  }, []);
  const busy = starting || prefilling || !!jobId;
  const close = () => { if (!starting && !prefilling) setEditing(false); };

  return <div className="flex flex-wrap items-center gap-2 min-w-0">
    {jobId && <MediaJobThumb jobId={jobId} label="Generated image" size="xs" onFilename={handleFilename} onStatus={handleStatus} />}
    <button type="button" onClick={() => run(quick)} disabled={disabled || busy}
      aria-label={quick ? `Generate image for ${name}` : undefined}
      title={quick ? 'Generate with the universe style and full record description' : 'Compose a prompt and generate an image for this item'}
      className="inline-flex items-center justify-center gap-1 text-xs px-2 py-2 rounded border border-port-border text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-50 disabled:cursor-not-allowed">
      {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Sparkles size={12} aria-hidden="true" />}
      {busy ? 'Generating…' : quick ? 'Generate image' : 'Generate'}
    </button>
    {quick && <button type="button" onClick={() => run(false)} disabled={disabled || busy} aria-label={`Edit image prompt for ${name}`}
      title="Edit prompt and preview universe additions"
      className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex items-center justify-center p-2 rounded border border-port-border text-gray-400 hover:text-port-accent disabled:opacity-50">
      <SlidersHorizontal size={14} aria-hidden="true" />
    </button>}
    <Modal open={editing} onClose={close} usePortal ariaLabel={`Generate image for ${name}`} size="md"
      panelClassName="rounded-lg border border-port-border bg-port-card p-4 shadow-xl space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">Generate image</h2>
        {prefilling && <Loader2 size={14} className="animate-spin text-gray-400" aria-label="Loading universe style" />}
      </div>
      {sourceError && <p role="alert" className="text-xs text-port-error">{sourceError} <button type="button" onClick={() => run(false)} className="underline">Retry</button></p>}
      <label htmlFor={`${fieldId}-prompt`} className="block text-xs text-gray-400">Prompt</label>
      <AutoSizeTextarea id={`${fieldId}-prompt`} value={prompt} onChange={event => { promptEdited.current = true; setPrompt(event.target.value); }} rows={3}
        placeholder="Describe the image to render…" className="w-full text-xs bg-port-bg border border-port-border rounded px-2 py-1 text-gray-200 min-h-[60px]" />
      <label htmlFor={`${fieldId}-negative`} className="block text-xs text-gray-400">Negative prompt (optional)</label>
      <AutoSizeTextarea id={`${fieldId}-negative`} value={negativePrompt} onChange={event => setNegativePrompt(event.target.value)} rows={2}
        className="w-full text-xs bg-port-bg border border-port-border rounded px-2 py-1 text-gray-200 min-h-[44px]" />
      {familyImages.length > 0 && <label htmlFor={`${fieldId}-family`} className="flex items-start gap-2 min-h-[40px] text-xs text-gray-300">
        <input id={`${fieldId}-family`} type="checkbox" checked={includeFamilyImages} onChange={(event) => setIncludeFamilyImages(event.target.checked)} className="mt-0.5" />
        <span>Send family images ({familyImages.map((image) => image.source).join(', ')}). Needs a backend that takes reference images.</span>
      </label>}
      <ModelInputPreview preview={modelInputPreview} prompt={prompt} />
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={close} disabled={starting || prefilling} className="text-xs px-3 py-2 rounded border border-port-border text-gray-400 hover:text-white disabled:opacity-50">Cancel</button>
        <button type="button" onClick={handleRender} disabled={disabled || starting || prefilling || !!sourceError || !prompt.trim()}
          className="inline-flex items-center gap-1 text-xs px-3 py-2 rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed">
          {starting ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Sparkles size={12} aria-hidden="true" />} Render
        </button>
      </div>
    </Modal>
  </div>;
}
