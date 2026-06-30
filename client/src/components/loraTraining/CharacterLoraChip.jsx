/**
 * "Trained LoRA" chip + dataset entry point for a universe/catalog
 * character. Resolves lazily via /api/loras/by-character ({ silent: true }
 * — no link is a normal state, not an error) and offers a Dataset button
 * that find-or-creates the character's dataset and navigates to it.
 */

import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Sparkles, GraduationCap, Loader2 } from 'lucide-react';
import { getCharacterLoras, createLoraDataset, listLoraDatasets } from '../../services/api';

export default function CharacterLoraChip({ entryId, ingredientId, universeId, showDatasetButton = true }) {
  const navigate = useNavigate();
  const [loras, setLoras] = useState(null);
  // Existing dataset (looked up by ingredientId) — the link target on
  // surfaces like the catalog detail page that don't know the universe
  // entryId and therefore can't find-or-create.
  const [existingDataset, setExistingDataset] = useState(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!entryId && !ingredientId) return;
    getCharacterLoras({ entryId, ingredientId }, { silent: true })
      .then((list) => setLoras(Array.isArray(list) ? list : []))
      .catch(err => { console.warn('⚠️ Failed to load character LoRAs: ' + err.message); setLoras([]); });
  }, [entryId, ingredientId]);

  const canCreate = !!(universeId && entryId);
  useEffect(() => {
    if (canCreate || (!entryId && !ingredientId)) return;
    listLoraDatasets(entryId ? { entryKind: 'characters', entryId } : { entryKind: 'characters', ingredientId })
      .then((list) => setExistingDataset(list?.[0] || null))
      .catch(err => console.warn('⚠️ Failed to load LoRA datasets: ' + err.message));
  }, [canCreate, entryId, ingredientId]);

  const openDataset = async () => {
    setOpening(true);
    try {
      const dataset = await createLoraDataset({ universeId, entryId });
      navigate(`/media/training/${dataset.id}`);
    } finally {
      setOpening(false);
    }
  };

  const lora = loras?.[0] || null;

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      {lora && (
        <Link
          to="/media/loras"
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-port-success/15 text-port-success border border-port-success/30 hover:bg-port-success/25"
          title={`Trained LoRA: ${lora.filename}${lora.triggerWords?.[0] ? ` · trigger: ${lora.triggerWords[0]}` : ''}`}
        >
          <Sparkles className="w-3 h-3" />
          LoRA{lora.triggerWords?.[0] ? ` · ${lora.triggerWords[0]}` : ''}
        </Link>
      )}
      {showDatasetButton && canCreate && (
        <button
          type="button"
          onClick={openDataset}
          disabled={opening}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-port-card border border-port-border text-gray-400 hover:text-white disabled:opacity-50"
          title="Open the character's LoRA training dataset"
        >
          {opening ? <Loader2 className="w-3 h-3 animate-spin" /> : <GraduationCap className="w-3 h-3" />}
          {lora ? 'Dataset' : 'Train LoRA'}
        </button>
      )}
      {showDatasetButton && !canCreate && existingDataset && (
        <Link
          to={`/media/training/${existingDataset.id}`}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-port-card border border-port-border text-gray-400 hover:text-white"
          title="Open the character's LoRA training dataset"
        >
          <GraduationCap className="w-3 h-3" /> Dataset
        </Link>
      )}
    </div>
  );
}
