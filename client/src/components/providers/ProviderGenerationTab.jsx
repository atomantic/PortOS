import { FormField } from '../ui/FormField';
import { effectiveModelContextWindow } from '../../utils/providers';
import {
  formatDurationMs,
  formatContextLength,
  formatCount,
  parseTimeoutMs,
  TIMEOUT_INPUT_MIN_MS,
  TIMEOUT_INPUT_MAX_MS,
  TIMEOUT_INPUT_STEP_MS,
} from '../../utils/formatters';
import { PROVIDER_FIELD_RANGES } from './providerFormData';
import ProviderRoutingSection from './ProviderRoutingSection';
import { isOpenRouterEndpoint } from './providerRoutingForm';
import ContextWindowPlanner from './ContextWindowPlanner';
import { isOllamaBackedProvider } from '../../utils/providerTypes';

export default function ProviderGenerationTab({ formData, setFormData, capabilityProvider, showsNumCtx, generationControls }) {
  // `capabilityProvider`, not `formData`: the per-model windows model refresh
  // recorded (`modelContextWindows`) live on the RECORD and are not form fields,
  // so reading formData alone reported the assumed 128K for a model whose real
  // window PortOS already knows.
  const plannedContextLabel = formatContextLength(
    effectiveModelContextWindow(capabilityProvider, formData.defaultModel)
  );

  return (
    <div className="space-y-4">
      <FormField label="Timeout (ms)">
        <input
          type="number"
          inputMode="numeric"
          min={TIMEOUT_INPUT_MIN_MS}
          max={TIMEOUT_INPUT_MAX_MS}
          step={TIMEOUT_INPUT_STEP_MS}
          value={formData.timeout}
          onChange={(e) => setFormData(prev => ({ ...prev, timeout: e.target.value }))}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
        />
        <p className="text-xs text-gray-500 mt-1">
          {(() => {
            // Same parser the submit path uses, so the displayed
            // duration always matches what would be saved. parseTimeoutMs
            // returns null for out-of-range/invalid → fall back to the
            // generic cap message.
            const ms = parseTimeoutMs(formData.timeout);
            return ms != null
              ? `≈ ${formatDurationMs(ms)} per run`
              : `Per-call cap. Server max: ${formatCount(TIMEOUT_INPUT_MAX_MS)} ms (${formatDurationMs(TIMEOUT_INPUT_MAX_MS)}).`;
          })()}
        </p>
      </FormField>

      <div className="border-t border-port-border pt-4 mt-4">
        <h4 className="text-sm font-medium text-gray-300 mb-3">Context Window</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormField label="Planning Window">
            <input
              type="number"
              inputMode="numeric"
              min={PROVIDER_FIELD_RANGES.contextWindow.min}
              max={PROVIDER_FIELD_RANGES.contextWindow.max}
              value={formData.contextWindow}
              onChange={(e) => setFormData(prev => ({ ...prev, contextWindow: e.target.value }))}
              placeholder="Auto from model"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
            <p className="text-xs text-gray-500 mt-1">
              {plannedContextLabel ? `Budgeter uses ${plannedContextLabel}` : 'Leave blank to use model/provider defaults'}
            </p>
          </FormField>

          {showsNumCtx && (
            <FormField label="Local num_ctx">
              <input
                type="number"
                inputMode="numeric"
                min={PROVIDER_FIELD_RANGES.numCtx.min}
                max={PROVIDER_FIELD_RANGES.numCtx.max}
                value={formData.numCtx}
                onChange={(e) => setFormData(prev => ({ ...prev, numCtx: e.target.value }))}
                placeholder="Ollama request size"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
              <p className="text-xs text-gray-500 mt-1">
                {formData.type === 'api'
                  ? 'Sent to compatible local backends; used for planning when no model window is known.'
                  : 'PortOS reloads the Ollama daemon at this window before the run — the CLI/TUI talks to Ollama directly, so nothing else can raise it. Leave blank to keep Ollama\'s VRAM-based auto-pick; make sure the model still fits at the larger size.'}
              </p>
            </FormField>
          )}

          {showsNumCtx && (
            <FormField label="Per-model num_ctx" className="sm:col-span-2">
              <textarea
                rows={3}
                value={formData.modelNumCtxText}
                onChange={(e) => setFormData(prev => ({ ...prev, modelNumCtxText: e.target.value }))}
                placeholder={'model-id = 1048576'}
                spellCheck={false}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-hidden"
              />
              <p className="text-xs text-gray-500 mt-1">
                One <code className="text-gray-400">model = tokens</code> per line. Replaces Local num_ctx for that model only, so a long-context model can run at its full window without raising it for every other model.
              </p>
              {isOllamaBackedProvider(capabilityProvider) && (
                <ContextWindowPlanner
                  modelNumCtxText={formData.modelNumCtxText}
                  onChange={(modelNumCtxText) => setFormData(prev => ({ ...prev, modelNumCtxText }))}
                />
              )}
            </FormField>
          )}
        </div>
      </div>

      {isOpenRouterEndpoint(formData.endpoint) && <ProviderRoutingSection formData={formData} setFormData={setFormData} />}

      {generationControls && (
        <div className="border-t border-port-border pt-4 mt-4">
          <h4 className="text-sm font-medium text-gray-300 mb-3">Generation Defaults</h4>
          <p className="text-xs text-gray-500 mb-3">
            Applied to every run this provider starts — HTTP, CLI, and TUI alike. OpenCode wrappers
            receive them as its <code className="text-gray-400">agent.build</code> options; a task can
            still override temperature and thinking for one run. Every field left blank is simply not
            sent, so the backend keeps its own default.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {generationControls.temperature && (
              <FormField label="Temperature">
                <input
                  type="number"
                  min={PROVIDER_FIELD_RANGES.temperature.min}
                  max={PROVIDER_FIELD_RANGES.temperature.max}
                  step="0.1"
                  value={formData.temperature}
                  onChange={(e) => setFormData(prev => ({ ...prev, temperature: e.target.value }))}
                  placeholder="Backend default"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
                <p className="text-xs text-gray-500 mt-1">Local Ollama agent runs fall back to 0.6 when this is blank.</p>
              </FormField>
            )}
            {generationControls.topP && (
              <FormField label="Top-P">
                <input
                  type="number"
                  min={PROVIDER_FIELD_RANGES.topP.min}
                  max={PROVIDER_FIELD_RANGES.topP.max}
                  step="0.05"
                  value={formData.topP}
                  onChange={(e) => setFormData(prev => ({ ...prev, topP: e.target.value }))}
                  placeholder="Backend default"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
                <p className="text-xs text-gray-500 mt-1">Nucleus sampling. Leave blank to send no top_p at all.</p>
              </FormField>
            )}
            {generationControls.thinking && (
              /* Tri-state rather than a checkbox: a checkbox cannot say
                 "leave the model's own reasoning mode alone", so it
                 forced a pin onto every provider the moment anyone
                 pressed Save. */
              <FormField label="Thinking mode">
                <select
                  value={formData.thinking}
                  onChange={(e) => setFormData(prev => ({ ...prev, thinking: e.target.value }))}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                >
                  <option value="">Model default</option>
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Ollama receives its native <code className="text-gray-400">think</code> flag; llama.cpp and
                  MTPLX get <code className="text-gray-400">enable_thinking</code> through the chat template;
                  a Claude harness on Ollama gets <code className="text-gray-400">MAX_THINKING_TOKENS</code>.
                  Models without a reasoning mode ignore it.
                </p>
              </FormField>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
