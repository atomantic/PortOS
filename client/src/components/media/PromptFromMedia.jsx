import { useCallback, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { ScanEye, ChevronDown, ChevronUp, Image as ImageIcon, Film, X, Copy } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import useProviderModels from '../../hooks/useProviderModels';
import useVisionModelIds from '../../hooks/useVisionModelIds';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import GalleryVideoPicker from '../videoGen/GalleryVideoPicker';
import Modal from '../ui/Modal';
import { FormField } from '../ui/FormField';
import { promptFromMedia } from '../../services/apiMediaJobs';
import { isVisionCapableCliProvider, visionLocalModelFilter } from '../../utils/providers';
import { copyToClipboard } from '../../lib/clipboard';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';

const LS_KEY_PROVIDER = 'portos_prompt_from_media_provider';
const LS_KEY_MODEL = 'portos_prompt_from_media_model';
const LS_KEY_EFFORT = 'portos_prompt_from_media_effort';

const visionProviderFilter = (p) => p.enabled && (p.type === 'api' || isVisionCapableCliProvider(p));

function sourceFromItem(item) {
  if (!item) return null;
  if (item.kind === 'upload') {
    return { sourceKind: 'upload', filename: item.filename, previewUrl: item.previewUrl || null, label: item.label || item.filename };
  }
  if (item.kind === 'video') {
    return { sourceKind: 'video', videoId: item.id, filename: item.filename, previewUrl: item.previewUrl || null, label: item.prompt || item.filename };
  }
  return { sourceKind: 'image', filename: item.filename, previewUrl: item.previewUrl || `/data/images/${item.filename}`, label: item.prompt || item.filename };
}

function SourceThumb({ source }) {
  if (!source) return null;
  if (source.previewUrl) {
    return <img src={source.previewUrl} alt="" className="w-16 h-16 rounded object-cover bg-port-bg" />;
  }
  return (
    <div className="w-16 h-16 rounded bg-port-bg border border-port-border flex items-center justify-center text-gray-500">
      {source.sourceKind === 'image' ? <ImageIcon className="w-6 h-6" /> : <Film className="w-6 h-6" />}
    </div>
  );
}

/**
 * Pick a gallery still/clip (or upload one), choose a vision-capable
 * provider/model/effort, and reverse-engineer the image and/or video prompt
 * that would recreate something like it.
 *
 * `kindDefault` seeds the target checkboxes (`image` / `video` / `both`).
 * When `setPrompt` is passed (Image Gen / Video Gen), Apply fills the host
 * form. Otherwise the result offers "Open in Image Gen / Video Gen".
 * `onResult` (optional) fires with the full analysis payload after each
 * successful run, so a host (e.g. a mood-board item — #4188) can persist it.
 */
export default function PromptFromMedia({
  kindDefault = 'both',
  setPrompt,
  setNegativePrompt,
  applyKind,
  initialSource = null,
  disabled = false,
  alwaysOpen = false,
  onResult,
}) {
  const navigate = useNavigate();
  const idPrefix = useId();
  const [isOpen, setIsOpen] = useState(!!initialSource || alwaysOpen);
  const [source, setSource] = useState(() => sourceFromItem(initialSource));
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [videoPickerOpen, setVideoPickerOpen] = useState(false);
  const [wantImage, setWantImage] = useState(kindDefault !== 'video');
  const [wantVideo, setWantVideo] = useState(kindDefault !== 'image');
  const [effort, setEffort] = useState(() => {
    try { return localStorage.getItem(LS_KEY_EFFORT) || ''; } catch { return ''; }
  });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const { idsByProvider: visionIds } = useVisionModelIds(isOpen);
  const modelFilter = useCallback(
    (id, provider) => visionLocalModelFilter(id, provider, visionIds),
    [visionIds],
  );

  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading: providersLoading,
  } = useProviderModels({
    filter: visionProviderFilter,
    silent: true,
    withEffort: true,
    modelFilter,
  });

  useEffect(() => {
    if (providersLoading || !providers.length) return;
    try {
      const savedProvider = localStorage.getItem(LS_KEY_PROVIDER);
      const savedModel = localStorage.getItem(LS_KEY_MODEL);
      if (savedProvider && providers.some((p) => p.id === savedProvider)) {
        setSelectedProviderId(savedProvider);
        if (savedModel) setSelectedModel(savedModel);
      }
    } catch { /* ignore */ }
  }, [providers, providersLoading, setSelectedProviderId, setSelectedModel]);

  useEffect(() => {
    if (!initialSource) return;
    setSource(sourceFromItem(initialSource));
    setResult(null);
  }, [initialSource]);

  const persistProvider = (id) => {
    try {
      if (id) localStorage.setItem(LS_KEY_PROVIDER, id);
      else localStorage.removeItem(LS_KEY_PROVIDER);
      localStorage.removeItem(LS_KEY_MODEL);
      localStorage.removeItem(LS_KEY_EFFORT);
    } catch { /* ignore */ }
  };

  const handleProviderChange = (id) => {
    setSelectedProviderId(id);
    setEffort('');
    persistProvider(id);
  };

  const handleModelChange = (model) => {
    setSelectedModel(model);
    try {
      if (selectedProviderId) localStorage.setItem(LS_KEY_PROVIDER, selectedProviderId);
      if (model) localStorage.setItem(LS_KEY_MODEL, model);
      else localStorage.removeItem(LS_KEY_MODEL);
    } catch { /* ignore */ }
  };

  const handleEffortChange = (val) => {
    setEffort(val);
    try {
      if (val) localStorage.setItem(LS_KEY_EFFORT, val);
      else localStorage.removeItem(LS_KEY_EFFORT);
    } catch { /* ignore */ }
  };

  const targets = [
    ...(wantImage ? ['image'] : []),
    ...(wantVideo ? ['video'] : []),
  ];
  const canRun = !!source && targets.length > 0 && !!selectedProviderId && !running && !disabled;

  const handleGenerate = async () => {
    if (!canRun) {
      if (!source) toast.error('Pick an image or video first');
      else if (!targets.length) toast.error('Choose at least one of image or video prompt');
      else if (!selectedProviderId) toast.error('Select a vision-capable AI provider');
      return;
    }
    setRunning(true);
    setResult(null);
    const payload = {
      sourceKind: source.sourceKind,
      filename: source.filename,
      videoId: source.videoId,
      targets,
      providerId: selectedProviderId,
      model: selectedModel || undefined,
      effort: effort || undefined,
    };
    const data = await promptFromMedia(payload).catch(() => null);
    setRunning(false);
    if (!data) return;
    setResult(data);
    toast.success('Prompts ready');
    if (onResult) onResult(data);
  };

  const apply = (kind) => {
    if (!result) return;
    const prompt = kind === 'video' ? result.videoPrompt : result.imagePrompt;
    const negative = kind === 'video' ? result.videoNegativePrompt : result.imageNegativePrompt;
    if (!prompt) return;
    if (setPrompt && applyKind === kind) {
      setPrompt(prompt);
      if (setNegativePrompt && negative != null) setNegativePrompt(negative);
      toast.success(`${kind === 'video' ? 'Video' : 'Image'} prompt applied`);
      return;
    }
    const params = new URLSearchParams();
    params.set('prompt', prompt);
    if (negative) params.set('negativePrompt', negative);
    navigate(`/media/${kind}?${params.toString()}`);
  };

  const copyField = (text, label) => {
    if (text) copyToClipboard(text, `${label} copied`);
  };

  return (
    <div className="space-y-2 my-1">
      {!alwaysOpen && (
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setIsOpen((prev) => !prev)}
            disabled={disabled || running}
            className="inline-flex items-center gap-1.5 text-xs text-port-accent hover:text-port-accent/80 font-medium transition-colors disabled:opacity-50 min-h-[36px] px-1"
            aria-expanded={isOpen}
            aria-label="Toggle prompt from media"
          >
            <ScanEye className="w-3.5 h-3.5" />
            <span>Prompt from media</span>
            {isOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      )}

      {isOpen && (
        <div className={alwaysOpen ? 'space-y-3' : 'p-3 bg-port-bg/70 border border-port-border rounded-lg space-y-3'}>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setImagePickerOpen(true)}
              disabled={disabled || running}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-port-border text-xs text-gray-200 hover:border-port-accent hover:text-white disabled:opacity-50 min-h-[36px]"
            >
              <ImageIcon className="w-3.5 h-3.5" /> Pick image
            </button>
            <button
              type="button"
              onClick={() => setVideoPickerOpen(true)}
              disabled={disabled || running}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-port-border text-xs text-gray-200 hover:border-port-accent hover:text-white disabled:opacity-50 min-h-[36px]"
            >
              <Film className="w-3.5 h-3.5" /> Pick video
            </button>
          </div>

          {source && (
            <div className="flex items-center gap-3">
              <SourceThumb source={source} />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-gray-300 truncate">{source.label || source.filename || source.videoId}</div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500">
                  {source.sourceKind === 'video' ? 'Gallery video' : source.sourceKind === 'upload' ? 'Upload' : 'Gallery image'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => { setSource(null); setResult(null); }}
                className="p-1.5 text-gray-400 hover:text-white min-h-[36px] min-w-[36px] flex items-center justify-center"
                aria-label="Clear selected media"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="flex flex-wrap gap-4">
            <label htmlFor={`${idPrefix}-want-image`} className="inline-flex items-center gap-2 text-xs text-gray-300 min-h-[36px]">
              <input
                id={`${idPrefix}-want-image`}
                type="checkbox"
                checked={wantImage}
                onChange={(e) => setWantImage(e.target.checked)}
                disabled={disabled || running}
                className="accent-port-accent"
              />
              Image prompt
            </label>
            <label htmlFor={`${idPrefix}-want-video`} className="inline-flex items-center gap-2 text-xs text-gray-300 min-h-[36px]">
              <input
                id={`${idPrefix}-want-video`}
                type="checkbox"
                checked={wantVideo}
                onChange={(e) => setWantVideo(e.target.checked)}
                disabled={disabled || running}
                className="accent-port-accent"
              />
              Video prompt
            </label>
          </div>

          <ProviderModelSelector
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onProviderChange={handleProviderChange}
            onModelChange={handleModelChange}
            effort={effort}
            onEffortChange={handleEffortChange}
            disabled={disabled || running || providersLoading}
            layout="stacked"
          />

          {providers.length === 0 && !providersLoading && (
            <p className="text-xs text-port-warning">No vision-capable providers are enabled. Add an API VLM or a Claude/Codex CLI in Settings → Providers.</p>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!canRun}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80 transition-colors disabled:opacity-50 min-h-[36px]"
            >
              {running ? <><BrailleSpinner /><span>Reading media…</span></> : <><ScanEye className="w-3.5 h-3.5" /><span>Create prompt</span></>}
            </button>
          </div>

          {result && (
            <div className="space-y-3 pt-1">
              {result.rationale && (
                <p className="text-xs text-gray-300 bg-port-bg border border-port-border rounded-lg p-2">{result.rationale}</p>
              )}
              {result.imagePrompt != null && (
                <PromptResultField
                  label="Image prompt"
                  value={result.imagePrompt}
                  negative={result.imageNegativePrompt}
                  onCopy={() => copyField(result.imagePrompt, 'Image prompt')}
                  onApply={() => apply('image')}
                  applyLabel={setPrompt && applyKind === 'image' ? 'Use as prompt' : 'Open in Image Gen'}
                />
              )}
              {result.videoPrompt != null && (
                <PromptResultField
                  label="Video prompt"
                  value={result.videoPrompt}
                  negative={result.videoNegativePrompt}
                  onCopy={() => copyField(result.videoPrompt, 'Video prompt')}
                  onApply={() => apply('video')}
                  applyLabel={setPrompt && applyKind === 'video' ? 'Use as prompt' : 'Open in Video Gen'}
                />
              )}
            </div>
          )}
        </div>
      )}

      <GalleryImagePicker
        open={imagePickerOpen}
        onClose={() => setImagePickerOpen(false)}
        allowUpload
        onSelect={(item) => { setSource(sourceFromItem(item)); setResult(null); }}
      />
      <GalleryVideoPicker
        open={videoPickerOpen}
        onClose={() => setVideoPickerOpen(false)}
        allowUpload
        onSelect={(item) => { setSource(sourceFromItem(item)); setResult(null); }}
      />
    </div>
  );
}

function PromptResultField({ label, value, negative, onCopy, onApply, applyLabel }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-gray-500">{label}</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onCopy} className="p-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50" aria-label={`Copy ${label}`}>
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onApply}
            className="px-2 py-1 rounded text-[11px] bg-port-accent/80 text-white hover:opacity-90 min-h-[32px]"
          >
            {applyLabel}
          </button>
        </div>
      </div>
      <textarea
        readOnly
        value={value}
        rows={4}
        className="w-full bg-port-bg border border-port-border rounded-lg p-2 text-xs text-white resize-y"
      />
      {negative ? (
        <FormField label="Negative" labelClassName="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">
          <textarea readOnly value={negative} rows={2} className="w-full bg-port-bg border border-port-border rounded-lg p-2 text-xs text-gray-300 resize-y" />
        </FormField>
      ) : null}
    </div>
  );
}

// `kindDefault` / `onResult` pass through to PromptFromMedia; `children`
// render above the analyzer in the scroll area — a host can slot in the
// item's stored analysis (mood boards — #4188).
export function PromptFromMediaModal({ item, open, onClose, kindDefault = 'both', onResult, children }) {
  if (!open || !item) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      zIndexClassName="z-[70]"
      backdropClassName="bg-black/80"
      ariaLabelledBy="prompt-from-media-title"
      panelClassName="max-h-[90vh] overflow-hidden bg-port-card border border-port-border rounded-xl shadow-2xl flex flex-col"
    >
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-port-border">
        <div className="flex items-center gap-2 min-w-0">
          <ScanEye className="w-4 h-4 text-port-accent shrink-0" />
          <h2 id="prompt-from-media-title" className="text-sm font-semibold text-white">Prompt from this</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50 min-h-[44px] min-w-[44px] flex items-center justify-center"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {children}
        <PromptFromMedia
          kindDefault={kindDefault}
          initialSource={item}
          alwaysOpen
          onResult={onResult}
        />
      </div>
    </Modal>
  );
}
