import { useState } from 'react';
import { Lightbulb, RefreshCw, X } from 'lucide-react';
import * as api from '../../services/api';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import RepoStudyFields from './RepoStudyFields';
import { useAsyncAction, useRepoStudyConfig } from '../../hooks';

/**
 * The Links tab's on-demand "Update & study" form for an already-cloned repo:
 * refresh the checkout, then queue a fresh `repo-study` run with a brief the
 * user writes right now ("look at how it does X", "compare its onboarding to
 * ours") instead of the one they may have written weeks ago at capture time.
 *
 * The knobs and their payload come from the SAME `useRepoStudyConfig` /
 * `RepoStudyFields` pair the capture boxes use, so the two dispatch paths can't
 * drift apart. The brief the last run was given seeds the field.
 *
 * @param {object} props
 * @param {object} props.link the cloned repo link
 * @param {() => void} props.onClose
 * @param {(link: object) => void} props.onQueued receives the updated link record
 */
export default function RepoRestudyPanel({ link, onClose, onQueued }) {
  const study = useRepoStudyConfig({
    resetKey: link.id,
    initialStudyContext: link.repoStudy?.studyContext || '',
  });
  const [pull, setPull] = useState(true);

  const [handleSubmit, submitting] = useAsyncAction(async () => {
    const result = await api.studyBrainLink(link.id, { pull, ...study.studyPayload() }, { silent: true });

    // A pull failure does not stop the study — say so, or the user has no way to
    // know the agent is reading a checkout that never got refreshed.
    const pullFailed = result.pulled?.ok === false;
    toast[pullFailed ? 'warning' : 'success'](pullFailed
      ? 'Study queued — the pull failed, so it reads the existing checkout'
      : 'Study queued — track it in Chief of Staff');
    onQueued?.(result.link);
    onClose?.();
  }, { errorMessage: 'Failed to queue study' });

  return (
    <div className="mt-2 w-full rounded-lg border border-port-border bg-port-bg/60 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Lightbulb size={14} className="text-port-accent shrink-0" />
        <h4 className="text-sm font-medium text-gray-200">Update &amp; study this repo</h4>
        <button
          onClick={onClose}
          className="ml-auto flex min-h-[44px] min-w-[44px] items-center justify-center text-gray-400 hover:text-white transition-colors"
          title="Close" aria-label="Close study form"
        >
          <X size={14} />
        </button>
      </div>

      <label htmlFor={`restudy-pull-${link.id}`} className="flex items-center gap-2 text-xs text-gray-400">
        <input
          id={`restudy-pull-${link.id}`}
          type="checkbox"
          checked={pull}
          onChange={e => setPull(e.target.checked)}
          className="accent-port-accent"
        />
        Pull the latest commits before studying
      </label>

      <RepoStudyFields
        idPrefix={`restudy-${link.id}`}
        {...study}
        contextLabel="What should this study look for?"
        contextPlaceholder="e.g. how it handles offline sync, and whether our Brain could adopt the same conflict model"
      />

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-port-accent/20 text-port-accent border border-port-accent/30 hover:bg-port-accent/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting ? <BrailleSpinner /> : <RefreshCw size={12} />}
        {pull ? 'Update & study' : 'Study now'}
      </button>
    </div>
  );
}
