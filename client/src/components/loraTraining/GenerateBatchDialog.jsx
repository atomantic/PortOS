/**
 * Generate-batch dialog — count + optional variation-axis overrides
 * (views/expressions/outfits prefilled from the subject's canon when the
 * caller passes them). Submits to POST /api/lora-datasets/:id/generate.
 */

import { useState } from 'react';
import { Loader2, Wand2 } from 'lucide-react';
import toast from '../ui/Toast';
import Modal from '../ui/Modal';
import { generateLoraDatasetImages } from '../../services/api';

// Advisory dataset-quality targets, mirrored from server/lib/loraDataset.js
// (RECOMMENDED_TRAINING_IMAGES / TRAINING_IMAGE_SWEET_SPOT_MAX). Kept local
// so the batch default + sweet-spot copy share one source of truth with the
// readiness coaching on LoraDatasetDetail. MAX_BATCH_IMAGES is this dialog's
// own slider cap (matches server buildVariationMatrix's 40-tuple clamp).
const RECOMMENDED_TRAINING_IMAGES = 20;
const TRAINING_IMAGE_SWEET_SPOT_MAX = 30;
const MAX_BATCH_IMAGES = 40;
const subjectKind = (dataset) => dataset?.character?.entryKind || 'characters';

const ChipToggleList = ({ idPrefix, label, options, selected, onToggle }) => (
  <div>
    <span className="block text-sm text-gray-400 mb-1">{label}</span>
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt, i) => {
        const on = selected.includes(opt);
        return (
          <button
            key={`${idPrefix}-${i}`}
            type="button"
            onClick={() => onToggle(opt)}
            className={`text-xs px-2 py-1 rounded-full border ${on
              ? 'bg-port-accent/20 border-port-accent/40 text-port-accent'
              : 'bg-port-bg border-port-border text-gray-400 hover:text-white'}`}
          >
            {opt}
          </button>
        );
      })}
    </div>
  </div>
);

export default function GenerateBatchDialog({ dataset, expressionOptions = [], outfitOptions = [], onClose, onStarted }) {
  // Default to the recommended quality target rather than the bare minimum so
  // a one-click batch lands a strong dataset. See the tips block in
  // LoraDatasetDetail for the rationale (variety > volume; sweet spot range).
  const [count, setCount] = useState(RECOMMENDED_TRAINING_IMAGES);
  const [expressions, setExpressions] = useState(expressionOptions);
  const [outfits, setOutfits] = useState(outfitOptions);
  const [submitting, setSubmitting] = useState(false);
  const isCharacter = subjectKind(dataset) === 'characters';

  const toggle = (setter) => (value) =>
    setter((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));

  const submit = async () => {
    setSubmitting(true);
    try {
      const result = await generateLoraDatasetImages(dataset.id, {
        count,
        ...(expressions.length ? { expressions } : {}),
        ...(outfits.length ? { outfits } : {}),
      });
      toast.success(`Queued ${result.images.length} reference render${result.images.length === 1 ? '' : 's'} (${result.mode})`);
      onStarted(result);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      ariaLabelledBy="lt-generate-title"
      panelClassName="bg-port-card border border-port-border rounded-lg p-5"
    >
      <div className="space-y-4">
        <h2 id="lt-generate-title" className="text-base font-semibold text-white">
          Generate reference images — {dataset.character?.name}
        </h2>
        <p className="text-sm text-gray-400">
          Renders single-subject training images from the universe bible, varying view, composition,
          lighting, and context. Renders queue on the image lane; results stream into the dataset.
        </p>
        <div>
          <label htmlFor="lt-gen-count" className="block text-sm text-gray-400 mb-1">Images ({count})</label>
          <input
            id="lt-gen-count"
            type="range"
            min={1}
            max={MAX_BATCH_IMAGES}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="w-full"
          />
          <p className="text-xs text-gray-500 mt-1">
            Sweet spot ~{RECOMMENDED_TRAINING_IMAGES}–{TRAINING_IMAGE_SWEET_SPOT_MAX}. Fewer than 10 won&apos;t train;
            past ~{MAX_BATCH_IMAGES} mostly adds time and overfitting risk.
          </p>
        </div>
        {expressionOptions.length > 0 && (
          <ChipToggleList
            idPrefix="lt-exp"
            label={isCharacter ? 'Expressions' : 'Lighting'}
            options={expressionOptions}
            selected={expressions}
            onToggle={toggle(setExpressions)}
          />
        )}
        {outfitOptions.length > 0 && (
          <ChipToggleList
            idPrefix="lt-outfit"
            label={isCharacter ? 'Outfits' : 'Settings'}
            options={outfitOptions}
            selected={outfits}
            onToggle={toggle(setOutfits)}
          />
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="px-3 py-2 text-sm rounded bg-port-accent text-white disabled:opacity-50 flex items-center gap-2"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
            Generate {count}
          </button>
        </div>
      </div>
    </Modal>
  );
}
