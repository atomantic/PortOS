import { useState } from 'react';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import toast from '../../ui/Toast';
import SentPromptPanel from '../../media/SentPromptPanel.jsx';
import useProviderModels from '../../../hooks/useProviderModels.js';
import { draftCatalogGreybox, saveCatalogGreybox } from '../../../services/apiCatalog.js';
import { applyPrevizGreybox, previzSetGreyboxDraftInstruction } from '../../../../../server/lib/musicVideoPreviz.js';
import { formatCount } from '../../../utils/formatters.js';

const buttonCls = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 py-1 text-xs disabled:opacity-50 pointer-fine:sm:min-h-0';
const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * Drafts greyboxes for all missing sets from the shots that play on each set:
 * queues each set, sends its shots/holder/action, presents a review step before each save
 * (or auto-applies if review is off), links cuts to their cameras in order, and re-seeds marks.
 */
export default function PrevizDraftMissingGreyboxes({ sets, project, places, locked, jobRunning, onSavePreviz, onPlaceUpdated }) {
  const llm = useProviderModels({ withEffort: true, silent: true });
  const [reviewEach, setReviewEach] = useState(true);
  const [busy, setBusy] = useState(null); // 'drafting' | 'saving' | null
  const [error, setError] = useState('');
  const [currentDraft, setCurrentDraft] = useState(null);

  const draftable = sets.filter(({ subject }) => subject?.ingredientId);
  if (!draftable.length) return null;

  const draftSet = async (queue, index, currentProject, currentPlaces, review) => {
    if (index >= queue.length) {
      setBusy(null);
      setCurrentDraft(null);
      toast.success(`Drafted and linked greyboxes for ${formatCount(queue.length)} ${queue.length === 1 ? 'set' : 'sets'}`);
      return;
    }
    const target = queue[index];
    setBusy('drafting');
    setError('');
    const instruction = previzSetGreyboxDraftInstruction(currentProject, target.subject.id);
    const result = await draftCatalogGreybox(target.subject.ingredientId, {
      instruction,
      providerId: llm.selectedProviderId,
      model: llm.selectedModel || undefined,
    }, { silent: true }).catch((err) => {
      setError(err?.message || `Failed to draft greybox for ${target.subject.name}`);
      return null;
    });

    if (!result) {
      setBusy(null);
      return;
    }

    if (review) {
      setBusy(null);
      setCurrentDraft({
        set: target,
        draft: result,
        instruction,
        queue,
        index,
        project: currentProject,
        places: currentPlaces,
      });
    } else {
      await saveAndAdvance(target, result.greybox, queue, index, currentProject, currentPlaces, false);
    }
  };

  const saveAndAdvance = async (target, greybox, queue, index, currentProject, currentPlaces, review) => {
    setBusy('saving');
    setError('');
    const saved = await saveCatalogGreybox(target.subject.ingredientId, greybox, { source: 'refine', silent: true }).catch((err) => {
      setError(err?.message || `Failed to save greybox for ${target.subject.name}`);
      return null;
    });
    if (!saved) {
      setBusy(null);
      return;
    }
    onPlaceUpdated?.(target.subject.ingredientId, greybox);

    const { previz: nextPreviz, loadedPlaces: nextPlaces } = applyPrevizGreybox(
      currentProject,
      target.subject.id,
      greybox,
      currentPlaces,
    );
    await onSavePreviz(nextPreviz);
    setCurrentDraft(null);

    await draftSet(queue, index + 1, { ...currentProject, previz: nextPreviz }, nextPlaces, review);
  };

  const handleStart = () => {
    setError('');
    draftSet(draftable, 0, project, places, reviewEach);
  };

  const handleReviewSave = (autoApplyRemaining) => {
    if (!currentDraft) return;
    if (autoApplyRemaining) setReviewEach(false);
    saveAndAdvance(
      currentDraft.set,
      currentDraft.draft.greybox,
      currentDraft.queue,
      currentDraft.index,
      currentDraft.project,
      currentDraft.places,
      autoApplyRemaining ? false : reviewEach,
    );
  };

  const handleReviewSkip = () => {
    if (!currentDraft) return;
    const { queue, index, project: curProj, places: curPlaces } = currentDraft;
    setCurrentDraft(null);
    draftSet(queue, index + 1, curProj, curPlaces, reviewEach);
  };

  const handleReviewCancel = () => {
    setCurrentDraft(null);
    setBusy(null);
  };

  return (
    <div className="min-w-0 space-y-2 pt-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonCls}
          disabled={locked || jobRunning || busy !== null || Boolean(currentDraft)}
          aria-busy={busy !== null}
          onClick={handleStart}
        >
          {busy === 'drafting' || busy === 'saving' ? (
            <Loader2 size={12} aria-hidden="true" className="animate-spin" />
          ) : (
            <Sparkles size={12} aria-hidden="true" />
          )}
          {busy === 'drafting'
            ? 'Drafting…'
            : busy === 'saving'
              ? 'Saving…'
              : 'Draft missing greyboxes from shots'}
        </button>
        <label className="inline-flex min-h-[44px] items-center gap-1 text-port-text-muted pointer-fine:sm:min-h-0">
          <input
            type="checkbox"
            checked={reviewEach}
            onChange={(e) => setReviewEach(e.target.checked)}
            disabled={busy !== null || Boolean(currentDraft)}
            aria-label="Review each draft before saving"
          />
          Review each draft before saving
        </label>
      </div>

      {error && <p role="alert" className="text-port-error">{error}</p>}

      {currentDraft && (
        <section
          role="region"
          aria-label={`Review greybox draft for ${currentDraft.set.subject.name}`}
          className="min-w-0 space-y-2 rounded border border-port-accent/50 bg-port-accent/5 p-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-1">
            <h4 className="font-medium text-port-text">
              Review draft for {currentDraft.set.subject.name} ({currentDraft.index + 1} of {currentDraft.queue.length})
            </h4>
            <span className="text-port-text-muted">
              {plural(currentDraft.draft.greybox.parts?.length || 0, 'part')} · {plural(currentDraft.draft.greybox.shots?.length || 0, 'camera')}
            </span>
          </div>
          {currentDraft.draft.greybox.shots?.length > 0 && (
            <p className="text-port-text-muted">
              Saved cameras: {currentDraft.draft.greybox.shots.map((s) => s.label || s.id).join(', ')}
            </p>
          )}
          <SentPromptPanel
            prompt={currentDraft.instruction}
            sentPrompt={currentDraft.draft.sentPrompt}
            additions={currentDraft.draft.promptAdditions}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={buttonCls}
              disabled={busy !== null}
              onClick={() => handleReviewSave(false)}
            >
              <Check size={12} aria-hidden="true" />
              {busy === 'saving'
                ? 'Saving…'
                : `Save & link cameras (${currentDraft.index + 1 === currentDraft.queue.length ? 'Finish' : 'Next set'})`}
            </button>
            {currentDraft.index + 1 < currentDraft.queue.length && (
              <button
                type="button"
                className={buttonCls}
                disabled={busy !== null}
                onClick={() => handleReviewSave(true)}
              >
                Save & auto-apply remaining
              </button>
            )}
            <button
              type="button"
              className={buttonCls}
              disabled={busy !== null}
              onClick={handleReviewSkip}
            >
              Skip set
            </button>
            <button
              type="button"
              className={buttonCls}
              disabled={busy !== null}
              onClick={handleReviewCancel}
            >
              <X size={12} aria-hidden="true" /> Cancel
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
