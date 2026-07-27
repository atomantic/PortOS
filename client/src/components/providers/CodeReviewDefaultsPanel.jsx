import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import ReviewerPicker from '../cos/ReviewerPicker';
import useReviewerModelOptions from '../../hooks/useReviewerModelOptions';
import { reviewerModelsFromDefaults, reviewerModelsToDefaults } from '../../lib/reviewerModels';
import {
  DEFAULT_REVIEWERS,
  DEFAULT_REVIEW_STOP_MODE,
} from '../cos/constants';

// Global Code Review Defaults — the chain the Review Loop uses when a task or
// task-type config didn't pin its own reviewers. Lives at the top of the AI
// Providers page so adding a new provider and pointing reviews at it stay in
// the same flow. Every per-reviewer control (model, `~opt`, `~max`) now lives in
// the shared ReviewerPicker table (#3133), so this panel owns only the fetch of
// the model option lists (via useReviewerModelOptions) and the save.
export default function CodeReviewDefaultsPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reviewers, setReviewers] = useState(DEFAULT_REVIEWERS);
  const [usernames, setUsernames] = useState([]);
  const [optionalReviewers, setOptionalReviewers] = useState([]);
  const [reviewerMaxRounds, setReviewerMaxRounds] = useState({});
  const [reviewerModels, setReviewerModels] = useState({});
  const [stopMode, setStopMode] = useState(DEFAULT_REVIEW_STOP_MODE);
  const [reviewerApplies, setReviewerApplies] = useState(false);
  const modelOptions = useReviewerModelOptions();

  useEffect(() => {
    let cancelled = false;
    api.getCodeReviewDefaults({ silent: true })
      .catch(() => null)
      .then((defaults) => {
        if (cancelled) return;
        if (defaults) {
          setReviewers(Array.isArray(defaults.reviewers) && defaults.reviewers.length ? defaults.reviewers : DEFAULT_REVIEWERS);
          setUsernames(Array.isArray(defaults.usernames) ? defaults.usernames : []);
          setOptionalReviewers(Array.isArray(defaults.optionalReviewers) ? defaults.optionalReviewers : []);
          setReviewerMaxRounds(defaults.reviewerMaxRounds && typeof defaults.reviewerMaxRounds === 'object' && !Array.isArray(defaults.reviewerMaxRounds)
            ? defaults.reviewerMaxRounds
            : {});
          setReviewerModels(reviewerModelsFromDefaults(defaults));
          setStopMode(defaults.stopMode || DEFAULT_REVIEW_STOP_MODE);
          setReviewerApplies(defaults.reviewerApplies === true);
        }
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const payload = {
      reviewers,
      usernames,
      optionalReviewers,
      reviewerMaxRounds,
      stopMode,
      reviewerApplies,
      ...reviewerModelsToDefaults(reviewerModels),
    };
    const ok = await api.updateSettings({ codeReview: payload }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(`Failed to save Code Review Defaults: ${err?.message || 'Save failed'}`); return false; });
    setSaving(false);
    if (ok) toast.success('Code Review Defaults saved');
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} className="text-port-accent" />
        <h2 className="text-base font-semibold text-white">Code Review Defaults</h2>
      </div>
      <p className="text-xs text-gray-500">
        Default Review Loop reviewer chain — used by ad-hoc CoS tasks and task-type schedules that haven't pinned their own. Local-LLM reviewers route the diff through PortOS's local code-review endpoint; the Codex and Claude reviewers invoke their CLI directly. Each runs the model pinned on its row (Claude also supports an Ollama-backed CLI for local-only setups — type one of your installed Ollama models).
      </p>

      {loading ? (
        <div className="text-xs text-gray-500">Loading defaults…</div>
      ) : (
        <>
          <ReviewerPicker
            reviewers={reviewers}
            usernames={usernames}
            optionalReviewers={optionalReviewers}
            reviewerMaxRounds={reviewerMaxRounds}
            reviewerModels={reviewerModels}
            modelOptions={modelOptions}
            stopMode={stopMode}
            reviewerApplies={reviewerApplies}
            disabled={saving}
            onChange={({ reviewers: r, usernames: u, optionalReviewers: o, reviewerMaxRounds: m, reviewerModels: dm, stopMode: s, reviewerApplies: a }) => {
              setReviewers(r);
              setUsernames(u);
              setOptionalReviewers(o);
              setReviewerMaxRounds(m);
              setReviewerModels(dm);
              setStopMode(s);
              setReviewerApplies(a);
            }}
          />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded transition-colors"
            >
              {saving ? 'Saving…' : 'Save defaults'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
