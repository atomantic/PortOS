import { useMemo } from 'react';
import ProviderModelSelector from '../ProviderModelSelector';
import useProviderCatalog from '../../hooks/useProviderCatalog';
import { filterSelectableModels } from '../../utils/providers';

// Shared AI provider + model picker. The selection applies to EVERY Story
// Builder operation (idea expand, aesthetic, arc, reader map, character refine,
// and the importer's analyze) — see the session.llm fallback in the conductor.
// `value` is `{ provider, model }`; empty strings mean "use the stage default".
//
// The two selects are rendered by the shared `ProviderModelSelector` so the
// markup matches every other provider/model picker. The value is parent-
// controlled (session.llm / the import-panel state), so this stays controlled
// rather than using the self-owning `useProviderModels` hook — it reads the
// shared provider catalog via `useProviderCatalog` to feed the selector's options.
export default function ProviderModelPicker({ value, onChange }) {
  const { presets, loading } = useProviderCatalog(true);
  const providers = useMemo(() => (presets || []).filter((p) => p.enabled), [presets]);
  const availableModels = useMemo(() => {
    const p = providers.find((x) => x.id === value?.provider);
    return p ? filterSelectableModels(p.models || [p.defaultModel]) : [];
  }, [providers, value?.provider]);

  return (
    <ProviderModelSelector
      providers={providers}
      selectedProviderId={value?.provider || ''}
      selectedModel={value?.model || ''}
      availableModels={availableModels}
      loading={loading}
      onProviderChange={(provider) => onChange({ provider, model: '' })}
      onModelChange={(model) => onChange({ provider: value?.provider || '', model })}
      label="AI"
      compact
      emptyProviderOption="Default provider"
      emptyModelOption="Default model"
    />
  );
}
