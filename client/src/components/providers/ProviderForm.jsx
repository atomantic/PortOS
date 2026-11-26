import { hardwareUnavailableReason } from '../../utils/systemCapabilities';
import { useState } from 'react';
import { AlertTriangle, Braces, Cpu, Plug, SlidersHorizontal } from 'lucide-react';
import toast from '../ui/Toast';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { deriveProviderPreset, updateProvider, createProvider } from '../../services/apiProviders.js';
import { mergeModelLists, mergeObservedContextWindows, withRuntimeContextWindow, isOllamaBackedProvider, generationControlsFor } from '../../utils/providers';
import Banner from '../ui/Banner';
import Drawer from '../Drawer';
import useDrawerTab from '../../hooks/useDrawerTab';
import { buildProviderPayload, findProviderFormError, initialProviderFormData, liveHardwareFor, liveModelsFor } from './providerFormData';
import ProviderConnectionTab from './ProviderConnectionTab';
import ProviderModelsTab from './ProviderModelsTab';
import ProviderGenerationTab from './ProviderGenerationTab';
import ProviderEnvironmentTab from './ProviderEnvironmentTab';
import { getHarnessContextTarget, harnessContextError, harnessContextPayload, parseHarnessContext } from './harnessContextForm.js';
import { CLAUDE_CONTEXT_ENV_KEY } from '../../../../server/lib/provider/splashHarnessContext.js';

// The provider editor's Drawer tabs. `connection` is the default, so a bare
// /ai/edit/:providerId deep link opens on the identity/transport fields; the
// others are reachable as /ai/edit/:providerId?providerTab=<id>.
const PROVIDER_FORM_TABS = [
  { id: 'connection', label: 'Connection', icon: Plug },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'generation', label: 'Generation', icon: SlidersHorizontal },
  { id: 'environment', label: 'Environment', icon: Braces },
];
const PROVIDER_FORM_TAB_IDS = PROVIDER_FORM_TABS.map(t => t.id);

export default function ProviderForm({ provider, daemonReadiness = null, onClose, onSave, onEditProvider, allProviders = [], localModels = { ollama: [], lmstudio: [], ctxById: {}, hardwareCompatibilityByBackend: {} }, runnerAllowedCommands = null }) {
  const [initialForm] = useState(() => initialProviderFormData(provider));
  const [modelsText, setModelsText] = useState(() => initialForm.models.join(', '));
  const [formData, setFormData] = useState(initialForm);
  const [harnessContextDraft, setHarnessContextDraft] = useState(null);

  const [activeTab, setActiveTab] = useDrawerTab('providerTab', 'connection', PROVIDER_FORM_TAB_IDS);
  // Preset structure (#7565). A DERIVED preset takes its program, endpoint,
  // credential, environment and catalog from the service it names on every
  // save; the server refuses a direct edit to one of those with a pointer at
  // the service, so the banner says so up front. A legacy record the server
  // reports convertible gets the one-click conversion here.
  const isDerived = provider?.presetKind === 'derived';
  const [converting, setConverting] = useState(false);
  const convertToDerived = async () => {
    setConverting(true);
    const derived = await deriveProviderPreset(provider.id).catch(() => null);
    setConverting(false);
    if (!derived) return;
    toast.success(`Now derived from service "${derived.serviceId}"`);
    onSave();
  };

  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [newEnvSecret, setNewEnvSecret] = useState(false);

  // A CLI create may declare that the same harness ALSO runs as a TUI, which
  // mints both records at once (`modes` on POST /api/providers). Neither field
  // is ever part of a provider record, so both stay out of `formData` — a
  // scratch value that rode the `...formData` spread would have to be deleted
  // back out of every payload.
  //
  // Editing never offers it: pairing describes two records being created
  // together, which a save against one existing record cannot mean. An existing
  // CLI record gains its TUI sibling from the card's "Add interactive mode"
  // instead (`POST /api/providers/:id/modes/tui`), which mints it from what is
  // already stored rather than from a re-submitted form.
  const canPairModes = !provider && formData.type === 'cli';
  const [alsoTui, setAlsoTui] = useState(false);
  const [tuiArgs, setTuiArgs] = useState('');

  // The CLI record stays the one this form edits; the TUI sibling is minted
  // from it, so `formData.type` remains a real type and every type-derived
  // control behaves exactly as it does for a plain CLI provider.
  const createsModePair = canPairModes && alsoTui;

  // Generation pickers (default + light/medium/heavy tiers) drop embedding-only
  // models (and internal sentinels) so an embedding can't be chosen as a model
  // that runs prompts, consistent with the fallback picker.
  const mergedModels = mergeModelLists(formData.models, liveModelsFor(localModels, formData));
  // The server publishes compatibility for both the provider runtime and any
  // explicitly annotated model. Unknown probe results stay in the list; only a
  // definitive mismatch is hidden.
  // The live windows a local daemon is SERVING (off the readiness poll) fold in
  // here rather than onto `provider`, because this object is derived and shown,
  // never saved — `modelContextWindows` is not a form field, so an observation
  // can reach "Budgeter uses …" and the model-option labels without any risk of
  // a Save writing a running process's window into the record (#7441).
  // The daemon's LAUNCH ceiling folds in the same way and for the same reason
  // (#7472): it is resolved server-side from the ambient `OLLAMA_CONTEXT_LENGTH`
  // the browser cannot read, and a typed-but-unsaved `numCtx` still outranks it
  // — the clamp reads the record's own rung first.
  // The markers that identify a backed provider (`ollamaBacked`, `llamaBacked`,
  // `gatewayBacked`) are NOT form fields, so a shape built from `formData`
  // alone loses them — which hid the effort ladder on the OpenCode-Ollama
  // providers, whose ladder is keyed on `ollamaBacked`. Merging the live edits
  // over the stored record means edits to command/endpoint/envVars count
  // immediately while the markers survive.
  const capabilityProvider = withRuntimeContextWindow(mergeObservedContextWindows({
    ...provider,
    ...formData,
    id: provider?.id,
    models: mergedModels,
    modelHardwareCompatibility: {
      ...provider?.modelHardwareCompatibility,
      ...liveHardwareFor(localModels, formData),
    },
  }, daemonReadiness?.contextWindows), daemonReadiness?.runtimeContextWindow);
  // `num_ctx` is meaningful for any provider whose tokens come from Ollama, not
  // just `api` ones: an `api` provider sends it on every request, while an
  // Ollama-backed CLI/TUI (claude-ollama, opencode-ollama) talks to the daemon
  // itself, so PortOS applies it by reloading Ollama at that window before the
  // run (server/services/ollamaAgentContext.js). Gating the field to `api` left
  // those providers stuck on Ollama's VRAM-based 32K auto-pick, which an agent
  // harness overruns mid-task. Reads `capabilityProvider` because the
  // `ollamaBacked` marker that identifies opencode-ollama (whose envVars carry
  // no ANTHROPIC_BASE_URL) is not a form field.
  const showsNumCtx = formData.type === 'api' || isOllamaBackedProvider(capabilityProvider);
  // Default sampling/reasoning controls, offered only for the backends PortOS
  // actually forwards them to (see `generationControlsFor`). Reads
  // `capabilityProvider` for the same reason `showsNumCtx` does: `llamaBacked`
  // and friends are record markers, not form fields.
  const generationControls = generationControlsFor(capabilityProvider);
  const harnessTarget = getHarnessContextTarget(capabilityProvider);
  const editingHarnessContext = harnessTarget && harnessContextDraft?.key === harnessTarget.key;
  const harnessContext = editingHarnessContext ? harnessContextDraft.value : harnessTarget?.value;
  const servedHarnessContext = daemonReadiness?.contextWindows?.[harnessTarget?.model]
    ?? daemonReadiness?.contextWindows?.[harnessTarget?.id] ?? null;

  const [save, saving] = useAsyncAction(async (data) => {
    try {
      await (provider ? updateProvider(provider.id, data) : createProvider(data));
    } catch {
      return; // The request helper toasted it; the form stays open with the edits.
    }
    onSave();
  });

  const isDirty = JSON.stringify(formData) !== JSON.stringify(initialForm)
    || modelsText !== initialForm.models.join(', ')
    || Boolean(harnessContextDraft || newEnvKey || newEnvValue || newEnvSecret || alsoTui || tuiArgs);

  const handleSubmit = (e) => {
    e.preventDefault();

    const invalid = findProviderFormError({ formData, createsModePair, showsNumCtx, generationControls });
    if (invalid) {
      setActiveTab(invalid.tab);
      toast.error(invalid.message);
      return;
    }

    if (editingHarnessContext) {
      const error = harnessContextError(harnessTarget, harnessContext);
      if (error) {
        setActiveTab('generation');
        toast.error(error);
        return;
      }
    }
    const data = buildProviderPayload({ provider, formData, modelsText, showsNumCtx, generationControls, createsModePair, tuiArgs });
    if (editingHarnessContext) data.harnessContext = harnessContextPayload(harnessTarget, harnessContext);
    save(data);
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={provider ? 'Edit Provider' : 'Add Provider'}
      subtitle={provider ? provider.name : undefined}
      size="lg"
      tabs={PROVIDER_FORM_TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      closeOnEsc={!isDirty && !saving && !converting}
      closeOnBackdrop={false}
    >
        {/* The Drawer body remounts per active tab (key={currentTab}), so this
            whole form subtree is torn down and rebuilt on every tab switch. All
            mutable state (formData and the new-env-var row) therefore lives in
            this component, above the Drawer — never inside the tab panels. */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {provider?.hardwareCompatibility?.state === 'unavailable' && (
            <Banner tone="warning" icon={AlertTriangle}>
              <p>
                {hardwareUnavailableReason('This provider', provider.hardwareCompatibility)}.
                Its models are hidden from selection until the host matches those requirements.
              </p>
            </Banner>
          )}
          {activeTab === 'connection' && (
            <ProviderConnectionTab
              provider={provider}
              formData={formData}
              setFormData={setFormData}
              capabilityProvider={capabilityProvider}
              allProviders={allProviders}
              onEditProvider={onEditProvider}
              runnerAllowedCommands={runnerAllowedCommands}
              isDerived={isDerived}
              converting={converting}
              onConvertToDerived={convertToDerived}
              canPairModes={canPairModes}
              alsoTui={alsoTui}
              setAlsoTui={setAlsoTui}
              createsModePair={createsModePair}
              tuiArgs={tuiArgs}
              setTuiArgs={setTuiArgs}
            />
          )}

          {activeTab === 'models' && (
            <ProviderModelsTab
              provider={provider}
              formData={formData}
              setFormData={setFormData}
              modelsText={modelsText}
              setModelsText={setModelsText}
              mergedModels={mergedModels}
              capabilityProvider={capabilityProvider}
              generationControls={generationControls}
              localModels={localModels}
              allProviders={allProviders}
            />
          )}

          {activeTab === 'generation' && (
            <ProviderGenerationTab
              formData={formData}
              setFormData={setFormData}
              capabilityProvider={capabilityProvider}
              harnessTarget={harnessTarget}
              harnessContext={harnessContext}
              setHarnessContext={(value) => setHarnessContextDraft({ key: harnessTarget.key, value })}
              servedHarnessContext={servedHarnessContext}
              showsNumCtx={showsNumCtx}
              generationControls={generationControls}
            />
          )}

          {activeTab === 'environment' && (
            <ProviderEnvironmentTab
              formData={formData}
              setFormData={setFormData}
              onEditHarnessContext={harnessTarget ? () => setActiveTab('generation') : null}
              managedContext={harnessTarget?.splashManaged && harnessTarget.kind === 'claude' ? {
                key: CLAUDE_CONTEXT_ENV_KEY,
                tokens: parseHarnessContext(harnessContext) ?? servedHarnessContext ?? harnessTarget.fallback,
                followsRuntime: harnessContext === '',
              } : null}
              newEnvKey={newEnvKey}
              setNewEnvKey={setNewEnvKey}
              newEnvValue={newEnvValue}
              setNewEnvValue={setNewEnvValue}
              newEnvSecret={newEnvSecret}
              setNewEnvSecret={setNewEnvSecret}
            />
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {provider ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
    </Drawer>
  );
}
