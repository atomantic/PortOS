/**
 * Board → universe style synthesis (#4188 Phase 4).
 *
 * "Synthesize style" on the universe's mood-board tool: runs the linked
 * board's collected content (notes, captions, per-item analyses) through a
 * user-picked API LLM, previews the proposed style guide as the shared
 * StyleDiffPreview against the CURRENT draft values, and "Adopt" hands the
 * proposal to the caller (`onAdopt` — the draft hook's queued-write adopt,
 * which also advances the saved-style bookkeeping). Never a client wholesale
 * `influences` PATCH. Locks are honored at proposal time and re-checked
 * server-side on adopt.
 */

import { useEffect, useState } from 'react';
import { Loader2, Sparkles, Wand2, X } from 'lucide-react';
import { synthesizeMoodBoardStyle } from '../../services/api';
import useMounted from '../../hooks/useMounted';
import useProviderModels from '../../hooks/useProviderModels';
import ProviderModelSelector from '../ProviderModelSelector';
import Modal from '../ui/Modal';
import toast from '../ui/Toast';
import StyleDiffPreview from './StyleDiffPreview';

const apiProviderFilter = (p) => p.enabled && p.type === 'api';

// Inner body so the provider fetch (useProviderModels mounts it) is deferred
// until the modal actually opens. The parent keys this by universe+board, so
// switching targets remounts it and a stale proposal can never be adopted
// into a different universe.
function SynthesisBody({ boardId, styleNotes, influences, locked, onAdopt, onBusyChange, onClose }) {
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const mountedRef = useMounted();
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

  // The parent gates modal dismissal (backdrop/Escape/close button) on this,
  // so a run can't be silently orphaned mid-flight. Cleared on unmount.
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

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
      if (mountedRef.current) toast.error(`Style synthesis failed: ${error.message}`);
      return null;
    });
    if (!mountedRef.current) return;
    setRunning(false);
    if (data) setResult(data);
  };

  const adopt = async () => {
    if (!result?.proposed || busy) return;
    setAdopting(true);
    const ok = await onAdopt?.({
      styleNotes: result.proposed.styleNotes || '',
      influences: result.proposed.influences || {},
    });
    if (!mountedRef.current) return;
    setAdopting(false);
    // Force-close: the parent's busy gate reads its own state, which hasn't
    // re-rendered from the setAdopting(false) above yet — a plain close()
    // would still see busy and refuse.
    if (ok) onClose(true);
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
  onAdopt,
}) {
  const [open, setOpen] = useState(false);
  const [bodyBusy, setBodyBusy] = useState(false);
  if (!boardId) return null;
  // Guarded close: backdrop, Escape (Modal routes both here), and the body's
  // Cancel/X are ignored mid-run so a request can't be silently orphaned.
  // The body passes `force === true` after a successful adopt, where its own
  // busy flag has just cleared but this component hasn't re-rendered yet.
  const close = (force) => {
    if (bodyBusy && force !== true) return;
    setOpen(false);
  };
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
        onClose={close}
        size="2xl"
        closeOnBackdrop={!bodyBusy}
        usePortal
        panelClassName="bg-port-card border border-port-border rounded-xl"
        ariaLabel="Synthesize universe style from mood board"
      >
        {open ? (
          <SynthesisBody
            key={`${universeId || ''}:${boardId}`}
            boardId={boardId}
            styleNotes={styleNotes}
            influences={influences}
            locked={locked}
            onAdopt={onAdopt}
            onBusyChange={setBodyBusy}
            onClose={close}
          />
        ) : null}
      </Modal>
    </div>
  );
}
