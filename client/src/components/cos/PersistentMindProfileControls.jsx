import { useEffect, useId, useRef, useState } from 'react';
import useProviderModels from '../../hooks/useProviderModels';
import * as api from '../../services/api';
import ProviderModelSelector from '../ProviderModelSelector';
import toast from '../ui/Toast';

const DEFAULT_PROFILE = {
  schemaVersion: 1,
  enabled: false,
  providerId: '',
  model: '',
  effort: '',
  thinkingInterface: 'text',
};

const normalizeProfile = (profile) => ({
  ...DEFAULT_PROFILE,
  ...(profile || {}),
  providerId: profile?.providerId || '',
  model: profile?.model || '',
  effort: profile?.effort || '',
});

export default function PersistentMindProfileControls({
  profile,
  disabled = false,
  onSaved,
  onSavingChange,
}) {
  const enabledId = useId();
  const {
    providers,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
  } = useProviderModels({ allowDefault: true, withEffort: true, silent: true });
  const [draft, setDraft] = useState(() => normalizeProfile(profile));
  const [saving, setSaving] = useState(false);
  const draftRef = useRef(draft);
  const publishedProfileRef = useRef(draft);
  const pendingSavesRef = useRef(0);
  const selectedProvider = providers.find((provider) => provider.id === draft.providerId) || null;
  const harness = selectedProvider?.type === 'api'
    ? { label: 'Direct API · recommended', tone: 'border-port-success/30 bg-port-success/10 text-port-success', detail: 'Best reliability for an always-on mind: structured HTTP, clean cancellation, and no terminal state. Ollama, llama.cpp, LM Studio, vLLM, and compatible cloud endpoints use this lane.' }
    : selectedProvider?.type === 'cli'
      ? { label: 'Headless CLI · supported', tone: 'border-port-accent/30 bg-port-accent/10 text-port-accent', detail: 'A good option when the vendor CLI owns authentication or model access, with more startup overhead than a direct API.' }
      : selectedProvider?.type === 'tui'
        ? { label: 'Interactive TUI · not recommended', tone: 'border-port-warning/30 bg-port-warning/10 text-port-warning', detail: 'Compatibility lane only. Startup prompts, terminal redraws, and screen scraping are fragile for unattended persistent work.' }
        : null;

  // The provider hook memoizes its setters in production, but simple host-page
  // test mocks may return fresh functions every render. This effect describes
  // persisted profile changes only; depending on setter identity would turn
  // its setDraft call into an unconditional render loop in those hosts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    // A socket/manual history refresh can return the pre-PUT profile while an
    // optimistic save is still in flight. Keep the draft authoritative until
    // the request settles; onSaved publishes the successful snapshot, while
    // the catch path restores the last known saved value.
    if (pendingSavesRef.current > 0) return;
    const next = normalizeProfile(profile);
    draftRef.current = next;
    publishedProfileRef.current = next;
    setDraft(next);
    setSelectedProviderId(next.providerId);
    setSelectedModel(next.model);
  }, [
    profile?.schemaVersion,
    profile?.enabled,
    profile?.providerId,
    profile?.model,
    profile?.effort,
    profile?.thinkingInterface,
  ]);

  const save = async (patch) => {
    const current = draftRef.current;
    const providerChanged = patch.providerId !== undefined && patch.providerId !== current.providerId;
    const next = {
      ...current,
      ...patch,
      ...(providerChanged && patch.model === undefined ? { model: '' } : {}),
      ...(providerChanged && patch.effort === undefined ? { effort: '' } : {}),
    };
    const previous = current;
    draftRef.current = next;
    setDraft(next);
    pendingSavesRef.current += 1;
    if (pendingSavesRef.current === 1) {
      setSaving(true);
      onSavingChange?.(true);
    }
    try {
      await api.updateCosConfig({ persistentMindProfile: next }, { silent: true });
      toast.success('Persistent mind profile updated');
      // A model change can synchronously clear an incompatible effort, creating
      // two saves from one selection. Only publish the newest saved snapshot so
      // the first response cannot reset the second optimistic update.
      if (draftRef.current === next) {
        publishedProfileRef.current = next;
        onSaved?.(next);
      }
    } catch (error) {
      if (draftRef.current === next) {
        draftRef.current = previous;
        setDraft(previous);
        setSelectedProviderId(previous.providerId);
        setSelectedModel(previous.model);
        if (publishedProfileRef.current !== previous) {
          publishedProfileRef.current = previous;
          onSaved?.(previous);
        }
      }
      toast.error(error.message);
    } finally {
      pendingSavesRef.current -= 1;
      if (pendingSavesRef.current === 0) {
        setSaving(false);
        onSavingChange?.(false);
      }
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <label htmlFor={enabledId} className="text-sm text-port-text">Enable persistent mind profile</label>
          <p className="mt-0.5 text-xs text-port-text-muted">
            Pins text reasoning to one AI provider and model. Saving this profile never starts a turn or downloads a model.
          </p>
        </div>
        <input
          id={enabledId}
          type="checkbox"
          checked={draft.enabled}
          disabled={disabled || saving}
          onChange={(event) => save({ enabled: event.target.checked })}
          className="mt-1 h-4 w-4 accent-port-accent disabled:opacity-50"
        />
      </div>
      <ProviderModelSelector
        providers={providers}
        selectedProviderId={draft.providerId}
        selectedModel={draft.model}
        availableModels={availableModels}
        effort={draft.effort}
        disabled={disabled || saving || !draft.enabled}
        emptyProviderOption="Select an AI provider"
        emptyModelOption="Select a model"
        alwaysShowModel
        layout="stacked"
        label="AI provider"
        onProviderChange={(providerId) => {
          setSelectedProviderId(providerId);
          setSelectedModel('');
          save({ providerId });
        }}
        onModelChange={(model) => {
          setSelectedModel(model);
          save({ model });
        }}
        onEffortChange={(effort) => save({ effort })}
      />
      {harness && (
        <div className={`rounded border px-3 py-2 text-xs ${harness.tone}`}>
          <p className="font-semibold">{harness.label}</p>
          <p className="mt-0.5">{harness.detail}</p>
        </div>
      )}
      <p className="text-xs text-port-text-muted">
        Thinking effort appears when the selected provider and model support it. An unavailable or invalid pin pauses the mind instead of falling back; agent-task authority is granted separately below.
      </p>
    </div>
  );
}
