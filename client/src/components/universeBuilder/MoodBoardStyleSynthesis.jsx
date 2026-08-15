/**
 * Board → universe style synthesis (#4188 Phase 4).
 *
 * "Synthesize style" on the universe's mood-board tool: runs the linked
 * board's collected content (notes, captions, per-item analyses) through a
 * user-picked API LLM, previews the proposed style guide as the shared
 * StyleDiffPreview against the CURRENT draft values, and "Adopt" persists it
 * via the universe's server-side queued write (never a client wholesale
 * `influences` PATCH). Locks are honored at proposal time and re-checked
 * server-side on adopt.
 */

import { useState } from 'react';
import { Loader2, Sparkles, Wand2, X } from 'lucide-react';
import { synthesizeMoodBoardStyle, adoptUniverseStyleGuide } from '../../services/api';
import useProviderModels from '../../hooks/useProviderModels';
import ProviderModelSelector from '../ProviderModelSelector';
import Modal from '../ui/Modal';
import toast from '../ui/Toast';
import StyleDiffPreview from './StyleDiffPreview';

const apiProviderFilter = (p) => p.enabled && p.type === 'api';

// Inner body so the provider fetch (useProviderModels mounts it) is deferred
// until the modal actually opens.
function SynthesisBody({ boardId, universeId, styleNotes, influences, locked, onAdopted, onClose }) {
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading: providersLoading,
  } = useProviderModels({ filter: apiProviderFilter, silent: true });

  const busy = running || adopting;

  const synthesize = async () => {
    if (!selectedProviderId || busy) return;
    setRunning(true);
    const data = await synthesizeMoodBoardStyle(boardId, {
      styleNotes: styleNotes || '',
      influences: influences || {},
      locked: locked || {},
      providerId: selectedProviderId,
      model: selectedModel || undefined,
    }, { silent: true }).catch((error) => {
      toast.error(`Style synthesis failed: ${error.message}`);
      return null;
    });
    setRunning(false);
    if (data) setResult(data);
  };

  const adopt = async () => {
    if (!result?.proposed || busy) return;
    setAdopting(true);
    const updated = await adoptUniverseStyleGuide(universeId, {
      styleNotes: result.proposed.styleNotes || '',
      influences: result.proposed.influences || {},
    }, { silent: true }).catch((error) => {
      toast.error(`Adopting the style guide failed: ${error.message}`);
      return null;
    });
    setAdopting(false);
    if (!updated) return;
    onAdopted?.(updated);
    toast.success('Style guide adopted');
    onClose();
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-white">Synthesize style from mood board</h2>
          <p className="text-xs text-gray-500">
            Distills the board's notes, captions, and item analyses into a proposed style guide. Review the diff, then adopt.
          </p>
        </div>
        <button type="button" onClick={onClose} disabled={busy} className="p-1 text-gray-400 hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center" aria-label="Close">
          <X size={18} />
        </button>
      </div>

      <ProviderModelSelector
        providers={providers}
        selectedProviderId={selectedProviderId}
        selectedModel={selectedModel}
        availableModels={availableModels}
        onProviderChange={setSelectedProviderId}
        onModelChange={setSelectedModel}
        disabled={busy || providersLoading}
        label="LLM for synthesis"
        layout="stacked"
      />
      {providers.length === 0 && !providersLoading ? (
        <p className="text-xs text-port-warning">No API providers are enabled. Add one in Settings → Providers.</p>
      ) : null}

      {result ? (
        <StyleDiffPreview
          analysis={result}
          description="Review this diff before deciding whether the board's synthesized style should update the universe."
        />
      ) : null}
      {result?.context?.droppedItems ? (
        <p className="text-[11px] text-gray-500">
          {result.context.droppedItems} item{result.context.droppedItems === 1 ? '' : 's'} beyond the context limit were not considered.
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2 flex-wrap">
        <button type="button" onClick={onClose} disabled={busy} className="min-h-[38px] px-3 text-sm text-gray-400 hover:text-white disabled:opacity-50">
          Cancel
        </button>
        <button
          type="button"
          onClick={synthesize}
          disabled={busy || !selectedProviderId}
          className={`inline-flex min-h-[38px] items-center gap-2 rounded px-3 py-2 text-sm disabled:opacity-50 ${
            result ? 'border border-port-border text-gray-200 hover:bg-white/5' : 'bg-port-accent text-white'
          }`}
        >
          {running ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
          {running ? 'Synthesizing…' : result ? 'Synthesize again' : 'Synthesize'}
        </button>
        {result ? (
          <button
            type="button"
            onClick={adopt}
            disabled={busy || !result.diff?.hasChanges}
            title={result.diff?.hasChanges ? 'Apply the proposed style guide to the universe' : 'The current guidance already matches the proposal'}
            className="inline-flex min-h-[38px] items-center gap-2 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            {adopting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            Adopt style
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function MoodBoardStyleSynthesis({
  boardId,
  universeId,
  styleNotes,
  influences,
  locked,
  saved = false,
  onAdopted,
}) {
  const [open, setOpen] = useState(false);
  if (!boardId) return null;
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!saved}
        title={saved
          ? 'Distill the linked mood board into the universe style guide'
          : 'Save the universe before synthesizing its style'}
        className="inline-flex min-h-[38px] items-center gap-1.5 rounded border border-port-accent/40 px-2.5 py-1.5 text-xs text-port-accent hover:bg-port-accent/10 disabled:opacity-50"
      >
        <Sparkles size={14} />
        Synthesize style
      </button>
      <span className="text-[11px] text-gray-500">Board notes + analyses → style prompt, negative prompt, style notes.</span>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="2xl"
        usePortal
        panelClassName="bg-port-card border border-port-border rounded-xl max-h-[90vh] overflow-y-auto"
        ariaLabel="Synthesize universe style from mood board"
      >
        {open ? (
          <SynthesisBody
            boardId={boardId}
            universeId={universeId}
            styleNotes={styleNotes}
            influences={influences}
            locked={locked}
            onAdopted={onAdopted}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </Modal>
    </div>
  );
}
