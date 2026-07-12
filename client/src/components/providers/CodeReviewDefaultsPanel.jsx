import { useEffect, useId, useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import { filterSelectableModels } from '../../utils/providers';
import ReviewerPicker from '../cos/ReviewerPicker';
import {
  DEFAULT_REVIEWERS,
  DEFAULT_REVIEW_STOP_MODE,
} from '../cos/constants';

// Global Code Review Defaults — the chain the Review Loop uses when a task or
// task-type config didn't pin its own reviewers. Lives at the top of the AI
// Providers page so adding a new provider and pointing reviews at it stay in
// the same flow. Per-backend model dropdowns are shown only when the
// corresponding reviewer is in the chain: the local-LLM (LM Studio / Ollama)
// lists come from `/api/local-llm/status` so they reflect what's actually
// installed, while the Codex tier list comes from the provider catalog
// (`/api/providers`) since Codex is a CLI reviewer, not a local backend.
export default function CodeReviewDefaultsPanel() {
  const lmStudioSelectId = useId();
  const ollamaSelectId = useId();
  const codexSelectId = useId();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reviewers, setReviewers] = useState(DEFAULT_REVIEWERS);
  const [usernames, setUsernames] = useState([]);
  const [stopMode, setStopMode] = useState(DEFAULT_REVIEW_STOP_MODE);
  const [reviewerApplies, setReviewerApplies] = useState(false);
  const [lmstudioModel, setLmstudioModel] = useState('');
  const [ollamaModel, setOllamaModel] = useState('');
  const [codexModel, setCodexModel] = useState('');
  const [localLlmStatus, setLocalLlmStatus] = useState(null);
  const [codexProvider, setCodexProvider] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getCodeReviewDefaults({ silent: true }).catch(() => null),
      api.getLocalLlmStatus({ silent: true }).catch(() => null),
      api.getProviders({ silent: true }).catch(() => null),
    ]).then(([defaults, status, providers]) => {
      if (cancelled) return;
      if (defaults) {
        setReviewers(Array.isArray(defaults.reviewers) && defaults.reviewers.length ? defaults.reviewers : DEFAULT_REVIEWERS);
        setUsernames(Array.isArray(defaults.usernames) ? defaults.usernames : []);
        setStopMode(defaults.stopMode || DEFAULT_REVIEW_STOP_MODE);
        setReviewerApplies(defaults.reviewerApplies === true);
        setLmstudioModel(defaults.lmstudioModel || '');
        setOllamaModel(defaults.ollamaModel || '');
        setCodexModel(defaults.codexModel || '');
      }
      setLocalLlmStatus(status || null);
      // Codex is a CLI reviewer, so its selectable model tiers come from the
      // provider catalog (not the local-LLM status probe the others use).
      setCodexProvider((providers?.providers || []).find((p) => p.id === 'codex') || null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const needsLmStudio = reviewers.includes('lmstudio');
  const needsOllama = reviewers.includes('ollama');
  const needsCodex = reviewers.includes('codex');

  const lmStudioModels = useMemo(
    () => localLlmStatus?.lmstudio?.models?.map((m) => m.id).filter(Boolean) || [],
    [localLlmStatus]
  );
  const ollamaModels = useMemo(
    () => localLlmStatus?.ollama?.models?.map((m) => m.id).filter(Boolean) || [],
    [localLlmStatus]
  );
  const codexModels = useMemo(
    () => codexProvider ? filterSelectableModels(codexProvider.models || [codexProvider.defaultModel]) : [],
    [codexProvider]
  );

  const handleSave = async () => {
    setSaving(true);
    // Empty-string model fields round-trip via the schema's `emptyToUndefined`
    // preprocess, so an unselected dropdown clears the persisted model rather
    // than writing the literal "" the <select> renders.
    const payload = {
      reviewers,
      usernames,
      stopMode,
      reviewerApplies,
      lmstudioModel: lmstudioModel || undefined,
      ollamaModel: ollamaModel || undefined,
      codexModel: codexModel || undefined,
    };
    const ok = await api.updateSettings({ codeReview: payload }, { silent: true })
      .then(() => true)
      .catch((err) => { toast.error(`Failed to save Code Review Defaults: ${err?.message || 'Save failed'}`); return false; });
    setSaving(false);
    if (ok) toast.success('Code Review Defaults saved');
  };

  // `emptyMessage` overrides the default local-LLM "install a model" hint so the
  // Codex picker (a CLI reviewer, not a local backend) shows relevant guidance.
  const renderModelPicker = (label, backend, value, setValue, options, selectId, emptyMessage = null) => {
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
            {emptyMessage || (unavailable
              ? `${label} backend isn't reachable — start it from Settings → Local LLMs to load models.`
              : `No ${label} models installed yet — add one in Settings → Local LLMs.`)}
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
        Default Review Loop reviewer chain — used by ad-hoc CoS tasks and task-type schedules that haven't pinned their own. Local-LLM reviewers route the diff through PortOS's local code-review endpoint; the Codex reviewer invokes the Codex CLI directly. Each runs the model selected below.
      </p>

      {loading ? (
        <div className="text-xs text-gray-500">Loading defaults…</div>
      ) : (
        <>
          <ReviewerPicker
            reviewers={reviewers}
            usernames={usernames}
            stopMode={stopMode}
            reviewerApplies={reviewerApplies}
            disabled={saving}
            onChange={({ reviewers: r, usernames: u, stopMode: s, reviewerApplies: a }) => {
              setReviewers(r);
              setUsernames(u);
              setStopMode(s);
              setReviewerApplies(a);
            }}
          />

          {needsLmStudio && renderModelPicker('LM Studio', 'lmstudio', lmstudioModel, setLmstudioModel, lmStudioModels, lmStudioSelectId)}
          {needsOllama && renderModelPicker('Ollama', 'ollama', ollamaModel, setOllamaModel, ollamaModels, ollamaSelectId)}
          {needsCodex && renderModelPicker('Codex', 'codex', codexModel, setCodexModel, codexModels, codexSelectId, 'No selectable Codex models — configure the Codex provider on the AI Providers page (or leave blank to use the Codex CLI default).')}

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

