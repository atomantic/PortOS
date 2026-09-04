import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import toast from '../ui/Toast';
import Banner from '../ui/Banner';
import * as api from '../../services/api';
import ReviewerPicker from '../cos/ReviewerPicker';
import GoalFidelityControls from './GoalFidelityControls';
import useReviewerModelOptions from '../../hooks/useReviewerModelOptions';
import { reviewerModelsFromDefaults, reviewerModelsToDefaults, reviewerEffortsFromDefaults, reviewerEffortsToDefaults } from '../../lib/reviewerModels';
import {
  DEFAULT_REVIEWERS,
  DEFAULT_REVIEW_STOP_MODE,
  MODEL_CAPABLE_CLI_REVIEWERS,
  reviewerLabel,
} from '../cos/constants';

// The CLI reviewers named in the help text below, derived from the roster the
// schema and `pickCodeReviewDefaults` generate from rather than spelled out — the
// literal sentence drifted twice as reviewers shipped (#3839). Adding a reviewer
// to MODEL_CAPABLE_CLI_REVIEWERS now updates this copy with no edit here.
const CLI_REVIEWER_LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })
  .format(MODEL_CAPABLE_CLI_REVIEWERS.map(reviewerLabel));

// Global Code Review Defaults — the chain the Review Loop uses when a task or
// task-type config didn't pin its own reviewers. Owns the Settings › Code
// Reviewers tab (it used to sit at the top of the AI Providers page, where it
// buried the provider list under a table most visits didn't need). Every
// per-reviewer control (model, `~opt`, `~max`) lives in the shared
// ReviewerPicker table (#3133), so this tab owns only the fetch of the model
// option lists (via useReviewerModelOptions) and the save.
export default function CodeReviewersTab() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reviewers, setReviewers] = useState(DEFAULT_REVIEWERS);
  const [usernames, setUsernames] = useState([]);
  const [optionalReviewers, setOptionalReviewers] = useState([]);
  const [reviewerMaxRounds, setReviewerMaxRounds] = useState({});
  const [reviewerModels, setReviewerModels] = useState({});
  const [reviewerEfforts, setReviewerEfforts] = useState({});
  const [stopMode, setStopMode] = useState(DEFAULT_REVIEW_STOP_MODE);
  const [reviewerApplies, setReviewerApplies] = useState(false);
  const [goalFidelity, setGoalFidelity] = useState({ enabled: true, backend: null, model: null, effort: null });
  const [installed, setInstalled] = useState({});
  const modelOptions = useReviewerModelOptions();

  const loadDefaults = useCallback(() => {
    setLoading(true);
    setLoadError(false);
    let cancelled = false;
    api.getCodeReviewDefaults({ silent: true })
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
          setReviewerEfforts(reviewerEffortsFromDefaults(defaults));
          setStopMode(defaults.stopMode || DEFAULT_REVIEW_STOP_MODE);
          setReviewerApplies(defaults.reviewerApplies === true);
          // `enabled` defaults ON, so an absent block must read as on — not as a
          // stored `false` the next save would then persist.
          setGoalFidelity({
            enabled: defaults.goalFidelity?.enabled !== false,
            backend: defaults.goalFidelity?.backend || null,
            model: defaults.goalFidelity?.model || null,
            effort: defaults.goalFidelity?.effort || null,
          });
          setInstalled(defaults.installed && typeof defaults.installed === 'object' && !Array.isArray(defaults.installed) ? defaults.installed : {});
        } else {
          setLoadError(true);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return loadDefaults();
  }, [loadDefaults]);

  const handleSave = async () => {
    if (saving || loadError) return;
    setSaving(true);
    const payload = {
      reviewers,
      usernames,
      optionalReviewers,
      reviewerMaxRounds,
      stopMode,
      reviewerApplies,
      ...reviewerModelsToDefaults(reviewerModels),
      ...reviewerEffortsToDefaults(reviewerEfforts),
      // Absent keys are dropped rather than sent as null: the schema treats an
      // absent scalar as "inherit", and persisting an explicit null would be a
      // pin the resolver can't tell from a deliberate one.
      goalFidelity: {
        enabled: goalFidelity.enabled,
        ...(goalFidelity.backend ? { backend: goalFidelity.backend } : {}),
        ...(goalFidelity.model ? { model: goalFidelity.model } : {}),
        ...(goalFidelity.effort ? { effort: goalFidelity.effort } : {}),
      },
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
        Default Review Loop reviewer chain — used by ad-hoc CoS tasks and task-type schedules that haven't pinned their own. Leave it empty and reviews follow your default AI provider, at its own model and reasoning effort. Local-LLM reviewers route the diff through PortOS's local code-review endpoint; the {CLI_REVIEWER_LIST} reviewers invoke their CLI directly. Each runs the model picked on its row — choose <span className="font-mono">Custom…</span> to type an id its catalog doesn't list, such as an installed Ollama model for an Ollama-backed Claude.
      </p>

      {loadError && (
        <Banner
          tone="error"
          size="sm"
          align="center"
          actions={
            <button
              type="button"
              onClick={loadDefaults}
              className="px-2.5 py-1 text-xs font-medium bg-port-error/20 hover:bg-port-error/30 text-port-error rounded transition-colors"
            >
              Retry
            </button>
          }
        >
          Failed to load code review defaults.
        </Banner>
      )}

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
            reviewerEfforts={reviewerEfforts}
            modelOptions={modelOptions}
            installed={installed}
            stopMode={stopMode}
            reviewerApplies={reviewerApplies}
            disabled={saving || loadError}
            onChange={({ reviewers: r, usernames: u, optionalReviewers: o, reviewerMaxRounds: m, reviewerModels: dm, reviewerEfforts: de, stopMode: s, reviewerApplies: a }) => {
              setReviewers(r);
              setUsernames(u);
              setOptionalReviewers(o);
              setReviewerMaxRounds(m);
              setReviewerModels(dm);
              setReviewerEfforts(de);
              setStopMode(s);
              setReviewerApplies(a);
            }}
          />

          <GoalFidelityControls
            value={goalFidelity}
            modelOptions={modelOptions}
            disabled={saving || loadError}
            onChange={setGoalFidelity}
          />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loadError}
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

