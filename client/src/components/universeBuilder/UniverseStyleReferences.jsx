import { useState } from 'react';
import { ImagePlus, Loader2, Sparkles, Trash2, X } from 'lucide-react';
import {
  analyzeUniverseStyleReference,
  WORLD_STYLE_REFERENCES_MAX,
} from '../../services/api';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import Modal from '../ui/Modal';
import toast from '../ui/Toast';
import VisionProviderPicker from '../universe/VisionProviderPicker';

const TITLE_MAX = 120;
const PROMPT_MAX = 4000;

function TokenDiff({ label, diff, tone }) {
  if (!diff?.changed) return null;
  const addedClass = tone === 'positive' ? 'text-port-success' : 'text-port-error';
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">{label}</div>
      <div className="flex flex-wrap gap-1">
        {diff.removed.map((token) => (
          <span key={`removed-${token}`} className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-gray-500 line-through">
            {token}
          </span>
        ))}
        {diff.added.map((token) => (
          <span key={`added-${token}`} className={`rounded bg-white/5 px-1.5 py-0.5 text-[11px] ${addedClass}`}>
            + {token}
          </span>
        ))}
      </div>
    </div>
  );
}

function StyleDiff({ analysis }) {
  const diff = analysis?.diff;
  if (!diff) return null;
  return (
    <section className="rounded-lg border border-port-border bg-port-bg/60 p-3 space-y-3">
      <div>
        <h3 className="text-sm font-medium text-white">Style guide preview</h3>
        <p className="text-xs text-gray-500">
          Review this diff before deciding whether the reference should update the universe.
        </p>
      </div>
      {!diff.hasChanges ? (
        <p className="text-xs text-gray-400">The current guidance already matches this reference.</p>
      ) : null}
      {diff.styleNotes?.changed ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Current style notes</div>
            <p className="rounded border border-port-border p-2 text-xs text-gray-400 whitespace-pre-wrap">
              {diff.styleNotes.before || 'None'}
            </p>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-port-accent mb-1">Proposed style notes</div>
            <p className="rounded border border-port-accent/30 p-2 text-xs text-gray-200 whitespace-pre-wrap">
              {diff.styleNotes.after || 'Clear style notes'}
            </p>
          </div>
        </div>
      ) : null}
      <TokenDiff label="Positive guidance changes" diff={diff.influences?.embrace} tone="positive" />
      <TokenDiff label="Negative guidance changes" diff={diff.influences?.avoid} tone="negative" />
      {analysis.rationale ? <p className="text-xs text-gray-400">{analysis.rationale}</p> : null}
    </section>
  );
}

export default function UniverseStyleReferences({
  universe,
  saved,
  onPersist,
  onRemove,
}) {
  const references = Array.isArray(universe?.styleReferences) ? universe.styleReferences : [];
  const [open, setOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [image, setImage] = useState(null);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [vision, setVision] = useState({ providerId: '', model: '' });
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [persisting, setPersisting] = useState(false);

  const reset = () => {
    setImage(null);
    setTitle('');
    setPrompt('');
    setAnalysis(null);
    setVision({ providerId: '', model: '' });
  };
  const close = () => {
    if (analyzing || persisting) return;
    setOpen(false);
    reset();
  };

  const analyze = async () => {
    if (!image?.filename || !vision.model) return;
    setAnalyzing(true);
    const result = await analyzeUniverseStyleReference({
      image: image.filename,
      title: title.trim() || undefined,
      prompt: prompt.trim() || undefined,
      styleNotes: universe.styleNotes || '',
      influences: universe.influences || {},
      locked: universe.locked || {},
      providerId: vision.providerId || undefined,
      model: vision.model,
    }, { silent: true }).catch((error) => {
      toast.error(`Style analysis failed: ${error.message}`);
      return null;
    });
    setAnalyzing(false);
    if (!result) return;
    setAnalysis(result);
    setTitle(result.reference?.title || '');
    setPrompt(result.reference?.prompt || '');
  };

  const persist = async (adopt) => {
    if (!analysis || !title.trim() || !prompt.trim()) return;
    setPersisting(true);
    const ok = await onPersist?.({
      ...analysis,
      reference: { ...analysis.reference, title: title.trim(), prompt: prompt.trim() },
      adopt,
    });
    setPersisting(false);
    if (ok) {
      setOpen(false);
      reset();
    }
  };

  return (
    <section className="mt-4 pt-4 border-t border-port-border space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-medium text-white">Art style references</h3>
          <p className="text-xs text-gray-500">
            Uploaded visual references with vision-authored recreation prompts.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={!saved || references.length >= WORLD_STYLE_REFERENCES_MAX}
          title={!saved
            ? 'Save the universe before adding references'
            : references.length >= WORLD_STYLE_REFERENCES_MAX
              ? `A universe can hold up to ${WORLD_STYLE_REFERENCES_MAX} art references`
              : 'Upload or choose an art style reference'}
          className="inline-flex min-h-[38px] items-center gap-1.5 rounded border border-port-accent/40 px-2.5 py-1.5 text-xs text-port-accent hover:bg-port-accent/10 disabled:opacity-50"
        >
          <ImagePlus size={14} />
          Add art reference
        </button>
      </div>

      {references.length ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {references.map((reference) => {
            const filename = reference.imageRefs?.[0];
            return (
              <article key={reference.id} className="flex gap-3 rounded-lg border border-port-border bg-port-bg/40 p-2">
                <img
                  src={`/data/images/${encodeURIComponent(filename || '')}`}
                  alt={reference.title}
                  className="h-24 w-24 shrink-0 rounded object-cover bg-port-bg"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="text-sm font-medium text-white">{reference.title}</h4>
                    <button
                      type="button"
                      onClick={() => onRemove?.(reference.id)}
                      className="shrink-0 rounded p-1 text-gray-500 hover:bg-white/5 hover:text-port-error"
                      aria-label={`Remove ${reference.title}`}
                      title="Remove art reference"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <p className="mt-1 line-clamp-3 text-xs text-gray-400">{reference.prompt}</p>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-gray-600">No art style references yet.</p>
      )}

      <Modal
        open={open}
        onClose={close}
        size="2xl"
        closeOnBackdrop={!analyzing && !persisting}
        usePortal
        panelClassName="bg-port-card border border-port-border rounded-xl max-h-[90vh] overflow-y-auto"
        ariaLabel="Add universe art style reference"
      >
        <div className="p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-white">Add art style reference</h2>
              <p className="text-xs text-gray-500">Choose an image, analyze it, then preview whether to adopt its style.</p>
            </div>
            <button type="button" onClick={close} disabled={analyzing || persisting} className="p-1 text-gray-400 hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-4">
            <div>
              {image ? (
                <button type="button" onClick={() => { setImage(null); setAnalysis(null); }} className="block w-full" title="Choose another image">
                  <img src={image.preview || `/data/images/${encodeURIComponent(image.filename)}`} alt="Selected art reference" className="aspect-square w-full rounded-lg border border-port-border object-cover" />
                </button>
              ) : (
                <button type="button" onClick={() => setGalleryOpen(true)} className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-port-border text-xs text-gray-400 hover:border-port-accent hover:text-white">
                  <ImagePlus size={24} />
                  Upload or choose image
                </button>
              )}
            </div>
            <div className="space-y-3">
              <div>
                <label htmlFor="style-reference-title" className="mb-1 block text-xs text-gray-400">Title (optional before analysis)</label>
                <input id="style-reference-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={TITLE_MAX} placeholder="Generated from the image when blank" className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none" />
              </div>
              <div>
                <label htmlFor="style-reference-prompt" className="mb-1 block text-xs text-gray-400">Recreation prompt (optional before analysis)</label>
                <textarea id="style-reference-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={PROMPT_MAX} rows={5} placeholder="Generated from the image when blank" className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none" />
              </div>
              <VisionProviderPicker label="Vision model for style analysis" onChange={setVision} />
            </div>
          </div>

          <StyleDiff analysis={analysis} />

          <div className="flex items-center justify-end gap-2 flex-wrap">
            <button type="button" onClick={close} disabled={analyzing || persisting} className="min-h-[38px] px-3 text-sm text-gray-400 hover:text-white disabled:opacity-50">Cancel</button>
            {!analysis ? (
              <button type="button" onClick={analyze} disabled={analyzing || !image?.filename || !vision.model} className="inline-flex min-h-[38px] items-center gap-2 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50">
                {analyzing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {analyzing ? 'Analyzing…' : 'Analyze image'}
              </button>
            ) : (
              <>
                <button type="button" onClick={() => persist(false)} disabled={persisting || !title.trim() || !prompt.trim()} className="min-h-[38px] rounded border border-port-border px-3 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-50">
                  Add reference only
                </button>
                <button type="button" onClick={() => persist(true)} disabled={persisting || !title.trim() || !prompt.trim()} className="inline-flex min-h-[38px] items-center gap-2 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50">
                  {persisting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  Adopt style + add
                </button>
              </>
            )}
          </div>
        </div>
      </Modal>
      <GalleryImagePicker
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        allowUpload
        onSelect={(item) => {
          if (!item?.filename) return;
          setImage({ filename: item.filename, preview: item.previewUrl });
          setAnalysis(null);
        }}
      />
    </section>
  );
}
