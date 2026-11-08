import { useEffect, useRef, useState } from 'react';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import useProviderModels from '../../hooks/useProviderModels.js';
import { supportsToolFreeOneShot } from '../../utils/providerSelection.js';
import { updateMusicVideoProject } from '../../services/apiMusicVideo.js';

/**
 * The vision model a frame take's Check uses (`project.plateReviewer`). Blank is
 * the default: Codex when it is ready, else an API provider. Saves on change.
 */
export default function PlateReviewerSetting({ project, onProjectUpdated }) {
  const saved = project.plateReviewer || null;
  const {
    providers, selectedProviderId, selectedModel, availableModels, setSelectedProviderId, setSelectedModel, loading,
  } = useProviderModels({ allowDefault: true, silent: true, filter: supportsToolFreeOneShot });
  const [saving, setSaving] = useState(false);
  // Show the stored pick; a save's answer re-renders through the project, not a second write.
  const shown = useRef(null);
  useEffect(() => {
    const key = `${saved?.providerId || ''}|${saved?.model || ''}`;
    if (shown.current === key) return;
    shown.current = key;
    setSelectedProviderId(saved?.providerId || '');
    setSelectedModel(saved?.model || '');
  }, [saved?.providerId, saved?.model, setSelectedProviderId, setSelectedModel]);

  const save = (plateReviewer) => {
    setSaving(true);
    return updateMusicVideoProject(project.id, { plateReviewer }, { silent: false })
      .then((next) => onProjectUpdated?.(next))
      .catch(() => {}) // request() already toasted
      .finally(() => setSaving(false));
  };
  // A new provider starts on its own default model.
  const pickProvider = (providerId) => {
    setSelectedProviderId(providerId);
    save(providerId ? { providerId, model: null } : null);
  };
  const pickModel = (model) => {
    setSelectedModel(model);
    if (selectedProviderId) save({ providerId: selectedProviderId, model: model || null });
  };

  return (
    <ProviderModelSelector
      id="mv-setup-plate-reviewer"
      providers={providers}
      selectedProviderId={selectedProviderId}
      selectedModel={selectedModel}
      availableModels={availableModels}
      onProviderChange={pickProvider}
      onModelChange={pickModel}
      label="Frame check"
      emptyProviderOption="Default (Codex)"
      emptyModelOption="Default model"
      disabled={saving}
      loading={loading}
      modelDisabled={!selectedProviderId}
      compact
    />
  );
}
