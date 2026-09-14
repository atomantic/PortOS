import { useState } from 'react';
import { ImagePlus, Loader2, Sparkles, X } from 'lucide-react';
import Modal from '../ui/Modal';
import toast from '../ui/Toast';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import VisionProviderPicker from '../universe/VisionProviderPicker';
import StyleDiffPreview from '../universeBuilder/StyleDiffPreview';
import { addDeckSample, analyzeDeckSample } from '../../services/api';

const TITLE_MAX = 120;

/**
 * "Add sample design" flow: choose or upload a gallery image (a poster, another
 * card, a painting), analyze it with a vision model into a proposed deck style
 * guide, review the diff, then persist the sample alone or adopt the proposal
 * with it. Mirrors the universe art-style reference modal.
 */
export default function DeckSampleModal({ deck, open, onClose, onSaved }) {
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [image, setImage] = useState(null);
  const [title, setTitle] = useState('');
  const [vision, setVision] = useState({ providerId: '', model: '' });
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [persisting, setPersisting] = useState(false);

  const reset = () => { setImage(null); setTitle(''); setAnalysis(null); };
  const close = () => {
    if (analyzing || persisting) return;
    onClose?.();
    reset();
  };

  const analyze = async () => {
    if (!image?.filename || !vision.model) return;
    setAnalyzing(true);
    const result = await analyzeDeckSample(deck.id, {
      image: image.filename,
      title: title.trim() || undefined,
      providerId: vision.providerId || undefined,
      model: vision.model,
    }, { silent: true }).catch((error) => {
      toast.error(`Sample analysis failed: ${error.message}`);
      return null;
    });
    setAnalyzing(false);
    if (!result) return;
    setAnalysis(result);
    setTitle(result.sample?.title || '');
  };

  const persist = async (adopt) => {
    if (!analysis || !title.trim()) return;
    setPersisting(true);
    const next = await addDeckSample(deck.id, {
      sample: { ...analysis.sample, title: title.trim() },
      adopt: adopt ? analysis.proposed : undefined,
    }, { silent: true }).catch((error) => {
      toast.error(`Failed to save sample: ${error.message}`);
      return null;
    });
    setPersisting(false);
    if (!next) return;
    toast.success(adopt ? 'Style guide adopted from sample' : 'Sample added');
    onSaved?.(next);
    onClose?.();
    reset();
  };

  const layoutDiff = analysis?.diff?.layoutPrompt;

  return (
    <>
      <Modal
        open={open}
        onClose={close}
        size="2xl"
        closeOnBackdrop={!analyzing && !persisting}
        usePortal
        panelClassName="bg-port-card border border-port-border rounded-xl"
        ariaLabel="Add a sample design"
      >
        <div className="p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-white">Add sample design</h2>
              <p className="text-xs text-gray-500">A poster, another card, a painting — anything whose visual language this deck should share.</p>
            </div>
            <button type="button" onClick={close} disabled={analyzing || persisting} className="p-1 text-gray-400 hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-4">
            <div>
              {image ? (
                <button type="button" onClick={() => { setImage(null); setAnalysis(null); }} className="block w-full" title="Choose another image">
                  <img src={image.preview || `/data/images/${encodeURIComponent(image.filename)}`} alt="Selected sample design" className="aspect-[2/3] w-full rounded-lg border border-port-border object-cover" />
                </button>
              ) : (
                <button type="button" onClick={() => setGalleryOpen(true)} className="flex aspect-[2/3] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-port-border text-xs text-gray-400 hover:border-port-accent hover:text-white">
                  <ImagePlus size={24} />
                  Upload or choose image
                </button>
              )}
            </div>
            <div className="space-y-3">
              <div>
                <label htmlFor="deck-sample-title" className="mb-1 block text-xs text-gray-400">Title (optional before analysis)</label>
                <input id="deck-sample-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TITLE_MAX} placeholder="Generated from the image when blank" className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none" />
              </div>
              <VisionProviderPicker label="Vision model for sample analysis" onChange={setVision} />
              {analysis?.sample?.prompt ? (
                <div>
                  <div className="text-xs text-gray-400 mb-1">Recreation prompt</div>
                  <p className="text-xs text-gray-300 max-h-32 overflow-y-auto rounded border border-port-border bg-port-bg/60 p-2">{analysis.sample.prompt}</p>
                </div>
              ) : null}
            </div>
          </div>

          <StyleDiffPreview analysis={analysis} description="Review before deciding whether the sample should update the deck's style guide." />
          {layoutDiff?.changed ? (
            <section className="rounded-lg border border-port-border bg-port-bg/60 p-3 space-y-1">
              <h3 className="text-sm font-medium text-white">Card layout</h3>
              <p className="text-xs text-gray-500 line-through">{layoutDiff.before || 'None'}</p>
              <p className="text-xs text-gray-200">{layoutDiff.after}</p>
            </section>
          ) : null}

          <div className="flex items-center justify-end gap-2 flex-wrap">
            <button type="button" onClick={close} disabled={analyzing || persisting} className="min-h-[38px] px-3 text-sm text-gray-400 hover:text-white disabled:opacity-50">Cancel</button>
            {!analysis ? (
              <button type="button" onClick={analyze} disabled={analyzing || !image?.filename || !vision.model} className="inline-flex min-h-[38px] items-center gap-2 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50">
                {analyzing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {analyzing ? 'Analyzing…' : 'Analyze sample'}
              </button>
            ) : (
              <>
                <button type="button" onClick={() => persist(false)} disabled={persisting || !title.trim()} className="min-h-[38px] rounded border border-port-border px-3 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-50">
                  Add sample only
                </button>
                <button type="button" onClick={() => persist(true)} disabled={persisting || !title.trim()} className="inline-flex min-h-[38px] items-center gap-2 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50">
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
    </>
  );
}
