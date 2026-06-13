/**
 * LoRA Training — dataset list (/media/training).
 *
 * One dataset per universe character. Cards show the character, a thumb
 * strip, image/caption counts, and training status; "New dataset" walks
 * universe → character and lands on the dataset workbench.
 */

import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { GraduationCap, Plus, Loader2, Sparkles, Images } from 'lucide-react';
import toast from '../components/ui/Toast';
import Modal from '../components/ui/Modal';
import ConfirmButtonPair from '../components/ui/ConfirmButtonPair';
import UniverseCharacterPicker from '../components/loraTraining/UniverseCharacterPicker';
import {
  listLoraDatasets,
  createLoraDataset,
  deleteLoraDataset,
} from '../services/api';

const STATUS_CHIP = {
  draft: 'bg-port-border/40 text-gray-300',
  training: 'bg-port-warning/20 text-port-warning',
  trained: 'bg-port-success/20 text-port-success',
};

function NewDatasetDialog({ onClose, onCreated }) {
  const [universeId, setUniverseId] = useState('');
  const [entryId, setEntryId] = useState('');
  const [creating, setCreating] = useState(false);

  const create = async () => {
    setCreating(true);
    try {
      const dataset = await createLoraDataset({ universeId, entryId });
      onCreated(dataset);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      ariaLabelledBy="lt-new-dataset-title"
      panelClassName="bg-port-card border border-port-border rounded-lg p-5"
    >
      <div className="space-y-4">
        <h2 id="lt-new-dataset-title" className="text-base font-semibold text-white">New training dataset</h2>
        <UniverseCharacterPicker
          idPrefix="lt-new"
          universeId={universeId}
          entryId={entryId}
          onUniverseChange={(id) => { setUniverseId(id); setEntryId(''); }}
          onEntryChange={setEntryId}
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
          <button
            type="button"
            onClick={create}
            disabled={!universeId || !entryId || creating}
            className="px-3 py-2 text-sm rounded bg-port-accent text-white disabled:opacity-50 flex items-center gap-2"
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Open dataset
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function LoraTraining() {
  const navigate = useNavigate();
  const [datasets, setDatasets] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [confirmingId, setConfirmingId] = useState(null);

  const refresh = useCallback(() => {
    listLoraDatasets().then(setDatasets).catch(() => setDatasets([]));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const onDelete = async (id) => {
    setDeletingId(id);
    try {
      await deleteLoraDataset(id);
      setDatasets((prev) => (prev || []).filter((d) => d.id !== id));
      toast.success('Dataset deleted');
    } finally {
      setDeletingId(null);
      setConfirmingId(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <GraduationCap className="w-5 h-5 text-port-accent" />
          <h2 className="text-lg font-semibold text-white">Character LoRA Training</h2>
        </div>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className="px-3 py-2 text-sm rounded bg-port-accent text-white flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> New dataset
        </button>
      </div>

      {datasets === null && (
        <div className="text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading datasets…</div>
      )}

      {datasets?.length === 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center text-gray-400">
          <Sparkles className="w-8 h-8 mx-auto mb-3 text-port-accent" />
          <p className="mb-1 text-white">Train a LoRA for consistent character renders.</p>
          <p className="text-sm">Pick a universe character, build reference material (generated renders, uploads, reference-sheet crops), caption it, and train a FLUX.1 or FLUX.2 adapter.</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {(datasets || []).map((d) => (
          <div key={d.id} className="bg-port-card border border-port-border rounded-lg p-4 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2">
              <Link to={`/media/training/${d.id}`} className="min-w-0">
                <div className="text-white font-medium truncate">{d.character?.name || 'Unnamed'}</div>
                <div className="text-xs text-gray-500 font-mono truncate">{d.triggerWord}</div>
              </Link>
              <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${STATUS_CHIP[d.status] || STATUS_CHIP.draft}`}>
                {d.status}
              </span>
            </div>
            {d.thumbnails?.length > 0 && (
              <Link to={`/media/training/${d.id}`} className="flex gap-1 overflow-hidden">
                {d.thumbnails.map((file) => (
                  <img
                    key={file}
                    src={`/data/lora-datasets/${d.id}/images/${file}`}
                    alt=""
                    className="w-16 h-16 object-cover rounded border border-port-border"
                    loading="lazy"
                  />
                ))}
              </Link>
            )}
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span className="flex items-center gap-1">
                <Images className="w-3.5 h-3.5" />
                {d.readiness?.ready ?? 0} images · {d.readiness?.captioned ?? 0} captioned
                {d.readiness?.rendering ? ` · ${d.readiness.rendering} rendering` : ''}
              </span>
              {confirmingId === d.id ? (
                <ConfirmButtonPair
                  prompt="Delete?"
                  busy={deletingId === d.id}
                  onConfirm={() => onDelete(d.id)}
                  onCancel={() => setConfirmingId(null)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingId(d.id)}
                  className="text-gray-500 hover:text-port-error"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {showNew && (
        <NewDatasetDialog
          onClose={() => setShowNew(false)}
          onCreated={(dataset) => navigate(`/media/training/${dataset.id}`)}
        />
      )}
    </div>
  );
}
