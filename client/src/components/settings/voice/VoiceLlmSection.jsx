import { PROVIDERS_PAGE_BREADCRUMB } from '../../../../../server/lib/navManifest.js';
import { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import { withUnlistedOption } from '../../../lib/withUnlistedOption';
import ProviderModelSelector from '../../ProviderModelSelector';
import FormField from '../../ui/FormField';
import ListLoadError from '../../ui/ListLoadError';
import useVoiceLlmProviders from '../../../hooks/useVoiceLlmProviders';
import VoiceLlmFields from '../../voice/VoiceLlmFields';

const parseTraits = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

export default function VoiceLlmSection({ cfg, patch, inputCls, traitsSyncRef }) {
  // Raw text of the Traits input while it has uncommitted edits; null means "show
  // the saved list". Parsing per keystroke would drop typed commas and spaces.
  const [traitsText, setTraitsText] = useState(null);
  // The conversational brain streams through `api` providers; the code-agent
  // picker draws from CLI/TUI agents. Silent load: ListLoadError is the failure UI.
  const {
    apiProviders, codeProviders, error: providersError, reload: loadProviders,
    refreshing: refreshingModels, refreshModels: handleRefreshModels,
  } = useVoiceLlmProviders();

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

  if (!cfg) return null;

  // The saved provider/model always render even when the registry no longer
  // lists them (VoiceLlmFields), so the select never drops the user's choice.
  const llmProvider = cfg.llm.provider || 'lmstudio';
  const llmModel = cfg.llm.model || 'auto';
  const llmVisionModel = cfg.llm.visionModel || 'auto';
  const selectedProvider = apiProviders.find((p) => p.id === llmProvider);
  const providerMissing = apiProviders.length > 0 && !selectedProvider;
  const modelChoices = (selectedProvider?.models || []).map((m) => ({ id: m }));
  const visionModelOptions = llmVisionModel === 'auto'
    ? modelChoices
    : withUnlistedOption(modelChoices, llmVisionModel, (id) => ({ id, current: true }));
  const setBrain = ({ provider: nextProvider, model: nextModel }) => {
    if (nextProvider !== llmProvider) {
      patch('llm.provider', nextProvider);
      // A new provider may not have the old vision model either.
      patch('llm.visionModel', 'auto');
    }
    patch('llm.model', nextModel);
  };

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
      <div className="md:col-span-2 space-y-1">
        <p className="text-xs text-gray-500">Voice streams tokens, so only API providers (LM Studio, Ollama, llama.cpp, OpenAI-compatible) are listed. Configure providers under {PROVIDERS_PAGE_BREADCRUMB}. 'auto' uses the provider's default model. These are the defaults; each Voice Call channel can tune its own voice, LLM and persona.</p>
        <VoiceLlmFields
          provider={llmProvider}
          model={llmModel}
          apiProviders={apiProviders}
          refreshing={refreshingModels}
          onRefreshModels={handleRefreshModels}
          onChange={setBrain}
          onSetupComplete={({ provider: nextProvider, model: nextModel }) => setBrain({ provider: nextProvider, model: nextModel })}
          providerLabel="LLM provider"
          modelLabel="LLM model"
        />
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

      {cfg.llm.tools?.enabled === true && (
        <label className="flex items-start gap-3 cursor-pointer md:col-span-2">
          <input
            type="checkbox"
            checked={cfg.llm.tools?.trimByIntent === true}
            onChange={(e) => patch('llm.tools.trimByIntent', e.target.checked)}
            className="w-4 h-4 mt-0.5 shrink-0"
          />
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline gap-x-3 gap-y-0.5 min-w-0 flex-1">
            <span className="text-sm text-white">Send only the tools each request needs</span>
            <span className="text-xs text-gray-500">
              For small models that get confused by the full tool list. Slower replies on larger models, because a changing tool list makes the model re-read the whole conversation every turn.
            </span>
          </div>
        </label>
      )}

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
