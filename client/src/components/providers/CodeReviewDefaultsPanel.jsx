import { useEffect, useId, useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import ReviewerPicker from '../cos/ReviewerPicker';
import {
  DEFAULT_REVIEWERS,
  DEFAULT_REVIEW_STOP_MODE,
} from '../cos/constants';

// Global Code Review Defaults — the chain the Review Loop uses when a task or
// task-type config didn't pin its own reviewers. Lives at the top of the AI
// Providers page so adding a new provider and pointing reviews at it stay in
// the same flow. Per-backend model dropdowns are shown only when the
// corresponding local-LLM reviewer is in the chain; the model list comes from
// `/api/local-llm/status` so it always reflects what's actually installed.
export default function CodeReviewDefaultsPanel() {
  const lmStudioSelectId = useId();
  const ollamaSelectId = useId();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reviewers, setReviewers] = useState(DEFAULT_REVIEWERS);
  const [stopMode, setStopMode] = useState(DEFAULT_REVIEW_STOP_MODE);
  const [reviewerApplies, setReviewerApplies] = useState(false);
  const [lmstudioModel, setLmstudioModel] = useState('');
  const [ollamaModel, setOllamaModel] = useState('');
  const [localLlmStatus, setLocalLlmStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getCodeReviewDefaults({ silent: true }).catch(() => null),
      api.getLocalLlmStatus({ silent: true }).catch(() => null),
    ]).then(([defaults, status]) => {
      if (cancelled) return;
      if (defaults) {
        setReviewers(Array.isArray(defaults.reviewers) && defaults.reviewers.length ? defaults.reviewers : DEFAULT_REVIEWERS);
        setStopMode(defaults.stopMode || DEFAULT_REVIEW_STOP_MODE);
        setReviewerApplies(defaults.reviewerApplies === true);
        setLmstudioModel(defaults.lmstudioModel || '');
        setOllamaModel(defaults.ollamaModel || '');
      }
      setLocalLlmStatus(status || null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const needsLmStudio = reviewers.includes('lmstudio');
  const needsOllama = reviewers.includes('ollama');

  const lmStudioModels = useMemo(
    () => localLlmStatus?.lmstudio?.models?.map((m) => m.id).filter(Boolean) || [],
    [localLlmStatus]
  );
  const ollamaModels = useMemo(
    () => localLlmStatus?.ollama?.models?.map((m) => m.id).filter(Boolean) || [],
    [localLlmStatus]
  );

  const handleSave = async () => {
    setSaving(true);
    // Empty-string model fields round-trip via the schema's `emptyToUndefined`
    // preprocess, so an unselected dropdown clears the persisted model rather
    // than writing the literal "" the <select> renders.
    const payload = {
      reviewers,
      stopMode,
      reviewerApplies,
      lmstudioModel: lmstudioModel || undefined,
      ollamaModel: ollamaModel || undefined,
    };
    const ok = await api.updateSettings({ codeReview: payload }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(`Failed to save Code Review Defaults: ${err?.message || 'Save failed'}`); return false; });
    setSaving(false);
    if (ok) toast.success('Code Review Defaults saved');
  };

  const renderModelPicker = (label, backend, value, setValue, options, selectId) => {
    const status = localLlmStatus?.[backend];
    const unavailable = status && status.available === false;
    return (
      <div className="flex flex-col gap-1 mt-2">
        <label htmlFor={selectId} className="text-xs text-gray-500">{label} model:</label>
        {options.length > 0 ? (
          <select
            id={selectId}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-gray-300 min-h-[28px] max-w-md"
          >
            <option value="">— pick a model —</option>
            {options.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        ) : (
          <div className="text-xs text-amber-400/80">
            {unavailable
              ? `${label} backend isn't reachable — start it from Settings → Local LLMs to load models.`
              : `No ${label} models installed yet — add one in Settings → Local LLMs.`}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} className="text-port-accent" />
        <h2 className="text-base font-semibold text-white">Code Review Defaults</h2>
      </div>
      <p className="text-xs text-gray-500">
        Default Review Loop reviewer chain — used by ad-hoc CoS tasks and task-type schedules that haven't pinned their own. Local-LLM reviewers route the diff through PortOS's local code-review endpoint and run the model selected below.
      </p>

      {loading ? (
        <div className="text-xs text-gray-500">Loading defaults…</div>
      ) : (
        <>
          <ReviewerPicker
            reviewers={reviewers}
            stopMode={stopMode}
            reviewerApplies={reviewerApplies}
            disabled={saving}
            onChange={({ reviewers: r, stopMode: s, reviewerApplies: a }) => {
              setReviewers(r);
              setStopMode(s);
              setReviewerApplies(a);
            }}
          />

          {needsLmStudio && renderModelPicker('LM Studio', 'lmstudio', lmstudioModel, setLmstudioModel, lmStudioModels, lmStudioSelectId)}
          {needsOllama && renderModelPicker('Ollama', 'ollama', ollamaModel, setOllamaModel, ollamaModels, ollamaSelectId)}

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

