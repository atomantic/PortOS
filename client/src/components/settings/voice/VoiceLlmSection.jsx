import { PROVIDERS_PAGE_BREADCRUMB } from '../../../../../server/lib/navManifest.js';
import { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import toast from '../../ui/Toast';
import BrailleSpinner from '../../BrailleSpinner';
import { getProviders, refreshProviderModels } from '../../../services/apiProviders';
import { withUnlistedOption } from '../../../lib/withUnlistedOption';
import ProviderModelSelector from '../../ProviderModelSelector';
import FormField from '../../ui/FormField';
import ListLoadError from '../../ui/ListLoadError';
import useMounted from '../../../hooks/useMounted';

const parseTraits = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

export default function VoiceLlmSection({ cfg, patch, inputCls, traitsSyncRef }) {
  const mountedRef = useMounted();
  // Raw text of the Traits input while it has uncommitted edits; null means "show
  // the saved list". Parsing per keystroke would drop typed commas and spaces.
  const [traitsText, setTraitsText] = useState(null);
  // API-type providers only — voice needs low-latency streaming chat, which
  // CLI/TUI providers can't deliver.
  const [apiProviders, setApiProviders] = useState([]);
  const [codeProviders, setCodeProviders] = useState([]);
  const [providersError, setProvidersError] = useState(null);
  const [refreshingModels, setRefreshingModels] = useState(false);

  // Load the provider registry. The conversational brain can only stream
  // through `api`-type providers (filtered here); the code-agent picker draws
  // from `cli`/`tui` providers (Claude Code, Codex, Antigravity) — those are the
  // ones that can actually edit code. Silent: the ListLoadError row is the
  // failure UI, so don't also pop a toast. A failure is kept distinct from an
  // empty registry so the pickers offer Retry rather than reading as "none".
  const loadProviders = useCallback(() => {
    setProvidersError(null);
    return getProviders({ silent: true })
      .then((data) => {
        if (!mountedRef.current) return;
        const all = data?.providers || [];
        setApiProviders(all.filter((p) => p.type === 'api'));
        setCodeProviders(all.filter((p) => p.type === 'cli' || p.type === 'tui'));
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        setApiProviders([]);
        setCodeProviders([]);
        setProvidersError(err instanceof Error ? err : new Error('Request failed'));
      });
  }, [mountedRef]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    if (!traitsSyncRef) return undefined;
    traitsSyncRef.current = {
      readPending: () => (traitsText === null ? null : parseTraits(traitsText)),
      clear: () => setTraitsText(null),
    };
    return () => { traitsSyncRef.current = null; };
  }, [traitsSyncRef, traitsText]);

  const commitTraits = () => {
    if (traitsText === null) return;
    patch('llm.personality.traits', parseTraits(traitsText));
    setTraitsText(null);
  };

  // Re-query the selected provider's /models endpoint and refresh the dropdown
  // (LM Studio / Ollama load models on demand, so the list goes stale).
  const handleRefreshModels = async (providerId) => {
    if (!providerId || refreshingModels) return;
    setRefreshingModels(true);
    try {
      // Silent: the route errors when the refresh fails (502 with the probe's
      // real message, or 400 when that CLI has no fetcher), so the catch below
      // owns the error toast (avoids a double toast).
      const updated = await refreshProviderModels(providerId, { silent: true });
      setApiProviders((prev) => prev.map((p) => (p.id === providerId ? { ...p, models: updated.models || [] } : p)));
      toast.success(`Refreshed models for ${updated.name || providerId} (${updated.models?.length || 0})`);
    } catch (err) {
      toast.error(`Failed to refresh models: ${err.message}`);
    } finally {
      setRefreshingModels(false);
    }
  };

  if (!cfg) return null;

  // LLM provider/model pickers. The saved provider/model are always shown even
  // when missing from the registry (e.g. provider deleted, or a model not in
  // the cached list) so the select never silently drops the user's choice.
  const llmProvider = cfg.llm.provider || 'lmstudio';
  const llmModel = cfg.llm.model || 'auto';
  const llmVisionModel = cfg.llm.visionModel || 'auto';
  const selectedProvider = apiProviders.find((p) => p.id === llmProvider);
  // Still used to gate the refresh buttons below, so kept alongside
  // providerOptions rather than folded away.
  const providerMissing = apiProviders.length > 0 && !selectedProvider;
  // An empty registry means "not loaded yet" (or the fetch failed), not
  // "confirmed not an API provider" — the synthetic option's own text makes
  // that distinction, since `withUnlistedOption` can't know why a value is
  // absent from an empty list.
  const providerOptions = withUnlistedOption(
    apiProviders,
    llmProvider,
    (id) => ({ id, name: apiProviders.length === 0 ? id : `${id} (not an API provider)` }),
  );
  const providerModels = selectedProvider?.models || [];
  // `providerModels` is a flat id-string list; wrap each as `{id}` so the
  // shared helper's default `key: 'id'` object contract applies uniformly to
  // real and synthetic entries alike.
  const modelChoices = providerModels.map((m) => ({ id: m }));
  // 'auto' is a sentinel rendered as its own hardcoded option below, never a
  // real catalog id — routing it through the helper would wrongly flag it as
  // an unlisted pin and duplicate the `value="auto"` option.
  const modelOptions = llmModel === 'auto'
    ? modelChoices
    : withUnlistedOption(modelChoices, llmModel, (id) => ({ id, current: true }));
  const visionModelOptions = llmVisionModel === 'auto'
    ? modelChoices
    : withUnlistedOption(modelChoices, llmVisionModel, (id) => ({ id, current: true }));

  // Code-agent delegation picker. Empty provider/model = "system default" (the
  // CoS spawner's activeProvider + selectModelForTask). The saved choice is
  // shown even when absent from the registry so the select never drops it.
  const codeAgentCfg = cfg.llm.codeAgent || {};
  const codeProvider = codeAgentCfg.provider || '';
  const codeModel = codeAgentCfg.model || '';
  const selectedCodeProvider = codeProviders.find((p) => p.id === codeProvider);
  // Only flag a missing agent AFTER the registry loads — otherwise a saved
  // agent is briefly mislabeled "(not a coding agent)" during the fetch (or if
  // it fails and codeProviders stays []). Mirrors providerOptions above,
  // but this picker suppresses the synthetic entirely while unloaded rather
  // than showing an unannotated fallback.
  const codeProviderOptions = codeProviders.length === 0
    ? codeProviders
    : withUnlistedOption(codeProviders, codeProvider, (id) => ({ id, name: `${id} (not a coding agent)` }));
  const codeProviderModels = selectedCodeProvider?.models || [];
  const codeModelChoices = codeProviderModels.map((m) => ({ id: m }));
  const codeModelOptions = withUnlistedOption(codeModelChoices, codeModel, (id) => ({ id, current: true }));

  return (
    <>
      {providersError && (
        <ListLoadError what="the provider registry (LLM and coding-agent pickers)" error={providersError} onRetry={loadProviders} className="md:col-span-2" />
      )}
      <FormField label="LLM provider" hint={`Voice streams tokens, so only API providers (LM Studio, Ollama, OpenAI-compatible) are listed. Configure providers under ${PROVIDERS_PAGE_BREADCRUMB}.`}>
        {/* Streaming needs a direct API route, so a composed combination is
            restricted to the `api` method. The model/vision selects below
            carry their own 'auto' sentinel, so this is the provider only. */}
        <ProviderModelSelector
          compact
          label="LLM provider"
          providers={providerOptions}
          selectedProviderId={llmProvider}
          composeMethods={['api']}
          onProviderChange={(id) => {
            // Switching provider invalidates the old model — reset to 'auto'
            // so we don't send a model the new provider doesn't have.
            patch('llm.provider', id);
            patch('llm.model', 'auto');
            patch('llm.visionModel', 'auto');
          }}
        />
      </FormField>

      {/* Not wrapped in <FormField>: the select sits beside a refresh button,
          so the id must land on the <select> (FormField injects it onto the
          first child, which would be the flex wrapper — orphaning the
          label). */}
      <div className="space-y-1">
        <label htmlFor="voice-llm-model" className="block text-sm text-gray-400">LLM model</label>
        <p className="text-xs text-gray-500">'auto' uses the provider's default model, or the fastest loaded model for LM Studio / Ollama.</p>
        <div className="flex items-center gap-2">
          <select
            id="voice-llm-model"
            value={llmModel}
            onChange={(e) => patch('llm.model', e.target.value)}
            className={`${inputCls} flex-1`}
          >
            <option value="auto">auto</option>
            {modelOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>{opt.id}{opt.current ? ' (current)' : ''}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => handleRefreshModels(llmProvider)}
            disabled={refreshingModels || providerMissing || apiProviders.length === 0}
            aria-label="Refresh model list from the provider"
            title="Refresh model list from the provider"
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 p-2 rounded-lg bg-port-border hover:bg-port-border/70 text-white disabled:opacity-50"
          >
            {refreshingModels ? <BrailleSpinner /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="voice-vision-model" className="block text-sm text-gray-400">Vision model</label>
        <p className="text-xs text-gray-500">'auto' uses the provider's vision-capable default for screen descriptions.</p>
        <div className="flex items-center gap-2">
          <select
            id="voice-vision-model"
            value={llmVisionModel}
            onChange={(e) => patch('llm.visionModel', e.target.value)}
            className={`${inputCls} flex-1`}
          >
            <option value="auto">auto</option>
            {visionModelOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>{opt.id}{opt.current ? ' (current)' : ''}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => handleRefreshModels(llmProvider)}
            disabled={refreshingModels || providerMissing || apiProviders.length === 0}
            aria-label="Refresh model list from the provider"
            title="Refresh model list from the provider"
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 p-2 rounded-lg bg-port-border hover:bg-port-border/70 text-white disabled:opacity-50"
          >
            {refreshingModels ? <BrailleSpinner /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>

      <label className="flex items-start gap-3 cursor-pointer md:col-span-2">
        <input
          type="checkbox"
          checked={cfg.llm.usePersonality !== false}
          onChange={(e) => patch('llm.usePersonality', e.target.checked)}
          className="w-4 h-4 mt-0.5 shrink-0"
        />
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline gap-x-3 gap-y-0.5 min-w-0 flex-1">
          <span className="text-sm text-white">Use Chief-of-Staff personality (recommended)</span>
          <span className="text-xs text-gray-500">
            Composes the system prompt from the fields below. Turn off to use the raw prompt.
          </span>
        </div>
      </label>

      {cfg.llm.usePersonality !== false ? (
        <>
          <FormField label="Name" hint="What the assistant calls itself.">
            <input
              type="text"
              value={cfg.llm.personality?.name ?? ''}
              onChange={(e) => patch('llm.personality.name', e.target.value)}
              className={inputCls}
            />
          </FormField>
          <FormField label="Role" hint="The role it plays for you.">
            <input
              type="text"
              value={cfg.llm.personality?.role ?? ''}
              onChange={(e) => patch('llm.personality.role', e.target.value)}
              className={inputCls}
            />
          </FormField>
          <FormField label="Speech style" hint="e.g. 'casual and brief', 'formal and precise'.">
            <input
              type="text"
              value={cfg.llm.personality?.speechStyle ?? ''}
              onChange={(e) => patch('llm.personality.speechStyle', e.target.value)}
              className={inputCls}
            />
          </FormField>
          <FormField label="Traits (comma-separated)" hint="e.g. 'concise, warm, proactive'.">
            <input
              type="text"
              value={traitsText ?? (cfg.llm.personality?.traits || []).join(', ')}
              onChange={(e) => setTraitsText(e.target.value)}
              onBlur={commitTraits}
              className={inputCls}
            />
          </FormField>
          <FormField label="Custom prompt (optional)" className="md:col-span-2" hint="Any extra context or instructions appended to the system prompt.">
            <textarea
              value={cfg.llm.personality?.customPrompt ?? ''}
              onChange={(e) => patch('llm.personality.customPrompt', e.target.value)}
              rows={2}
              className={`${inputCls} font-mono text-xs`}
            />
          </FormField>
        </>
      ) : (
        <FormField label="System prompt" className="md:col-span-2">
          <textarea
            value={cfg.llm.systemPrompt}
            onChange={(e) => patch('llm.systemPrompt', e.target.value)}
            rows={2}
            className={`${inputCls} font-mono text-xs`}
          />
        </FormField>
      )}

      <label className="flex items-start gap-3 cursor-pointer md:col-span-2">
        <input
          type="checkbox"
          checked={cfg.llm.tools?.enabled === true}
          onChange={(e) => patch('llm.tools.enabled', e.target.checked)}
          className="w-4 h-4 mt-0.5 shrink-0"
        />
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline gap-x-3 gap-y-0.5 min-w-0 flex-1">
          <span className="text-sm text-white">Enable tools (brain, goals, PM2, feeds, time, driving the page — click/fill/select/check…)</span>
          <span className="text-xs text-gray-500">
            Needs a tool-use-capable model (Qwen2.5, Hermes-3, etc.).
          </span>
        </div>
      </label>

      <label className="flex items-start gap-3 cursor-pointer md:col-span-2">
        <input
          type="checkbox"
          checked={cfg.llm.codeAgent?.enabled === true}
          onChange={(e) => patch('llm.codeAgent.enabled', e.target.checked)}
          className="w-4 h-4 mt-0.5 shrink-0"
        />
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline gap-x-3 gap-y-0.5 min-w-0 flex-1">
          <span className="text-sm text-white">Enable coding-agent delegation</span>
          <span className="text-xs text-gray-500">
            Lets you say "have the agent fix X" — dispatches a CLI coding agent in an isolated worktree that opens a PR. Needs tools enabled above.
          </span>
        </div>
      </label>

      {cfg.llm.codeAgent?.enabled === true && (
        <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3 pl-7">
          <FormField label="Coding agent" hint={`Which CLI/TUI agent runs the task. 'System default' uses your active AI provider (${PROVIDERS_PAGE_BREADCRUMB}).`}>
            <ProviderModelSelector
              compact
              label="Coding agent"
              providers={codeProviderOptions}
              selectedProviderId={codeProvider}
              emptyProviderOption="System default"
              composeMethods={['cli', 'tui']}
              onProviderChange={(id) => {
                // Switching agent invalidates the old model — reset to default.
                patch('llm.codeAgent.provider', id);
                patch('llm.codeAgent.model', '');
              }}
            />
          </FormField>
          <FormField label="Model" hint="'System default' lets the agent pick per task complexity.">
            <select
              value={codeModel}
              onChange={(e) => patch('llm.codeAgent.model', e.target.value)}
              className={inputCls}
            >
              <option value="">System default</option>
              {codeModelOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.id}{opt.current ? ' (current)' : ''}</option>
              ))}
            </select>
          </FormField>
          <label className="flex items-start gap-3 cursor-pointer sm:col-span-2">
            <input
              type="checkbox"
              checked={cfg.llm.codeAgent?.announceOnComplete !== false}
              onChange={(e) => patch('llm.codeAgent.announceOnComplete', e.target.checked)}
              className="w-4 h-4 mt-0.5 shrink-0"
            />
            <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline gap-x-3 gap-y-0.5 min-w-0 flex-1">
              <span className="text-sm text-white">Announce when a dispatched task finishes</span>
              <span className="text-xs text-gray-500">
                Speaks the result when the agent completes. Still honors quiet hours.
              </span>
            </div>
          </label>
        </div>
      )}

      <label className="flex items-start gap-3 cursor-pointer md:col-span-2">
        <input
          type="checkbox"
          checked={cfg.llm.proactive?.enabled === true}
          onChange={(e) => patch('llm.proactive.enabled', e.target.checked)}
          className="w-4 h-4 mt-0.5 shrink-0"
        />
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline gap-x-3 gap-y-0.5 min-w-0 flex-1">
          <span className="text-sm text-white">Allow proactive speech</span>
          <span className="text-xs text-gray-500">
            CoS can speak first for alerts and reminders. Disabled by default.
          </span>
        </div>
      </label>

      {cfg.llm.proactive?.enabled === true && (
        <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-3 pl-7">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={cfg.llm.proactive?.quietHours?.enabled === true}
              onChange={(e) => patch('llm.proactive.quietHours.enabled', e.target.checked)}
              className="w-4 h-4 shrink-0"
            />
            <span className="text-sm text-white">Quiet hours</span>
          </label>
          <FormField label="Start (HH:MM)" hint="Local time">
            <input
              type="time"
              value={cfg.llm.proactive?.quietHours?.start || '22:00'}
              onChange={(e) => patch('llm.proactive.quietHours.start', e.target.value)}
              disabled={!cfg.llm.proactive?.quietHours?.enabled}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-50"
            />
          </FormField>
          <FormField label="End (HH:MM)" hint="Local time">
            <input
              type="time"
              value={cfg.llm.proactive?.quietHours?.end || '07:00'}
              onChange={(e) => patch('llm.proactive.quietHours.end', e.target.value)}
              disabled={!cfg.llm.proactive?.quietHours?.enabled}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-50"
            />
          </FormField>
        </div>
      )}
    </>
  );
}
