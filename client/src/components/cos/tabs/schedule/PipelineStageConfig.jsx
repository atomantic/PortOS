import { filterSelectableModels, effortLevelsForProvider } from '../../../../utils/providers';
import { FormField } from '../../../ui/FormField';

export default function PipelineStageConfig({ taskType, config, providers, onUpdate, updating, setUpdating }) {
  const stages = config.taskMetadata?.pipeline?.stages || [];

  const handleStageUpdate = async (stageIndex, field, value) => {
    setUpdating(true);
    const updatedStages = stages.map((stage, i) => {
      if (i !== stageIndex) return stage;
      const updated = { ...stage };
      if (value === '' || value === null) {
        delete updated[field];
      } else {
        updated[field] = value;
      }
      // When provider changes, clear model + effort (neither may be valid for the
      // new provider — effort levels differ between claude/codex and non-effort
      // providers have none).
      if (field === 'providerId') {
        delete updated.model;
        delete updated.effort;
      }
      return updated;
    });
    const updatedMeta = {
      ...config.taskMetadata,
      pipeline: { ...config.taskMetadata.pipeline, stages: updatedStages }
    };
    await onUpdate(taskType, { taskMetadata: updatedMeta }).catch(() => {});
    setUpdating(false);
  };

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-400 mb-3">Pipeline Stages</h4>
      <div className="space-y-3">
        {stages.map((stage, i) => {
          const stageProvider = providers?.find(p => p.id === stage.providerId);
          const stageModels = filterSelectableModels(stageProvider?.models);
          const stageEffortLevels = effortLevelsForProvider(stageProvider);
          return (
            <div key={i} className="bg-port-card border border-port-border rounded-lg p-3">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-medium text-port-accent-2">Stage {i + 1}</span>
                {stage.readOnly && (
                  <span className="text-[10px] px-1 py-0.5 bg-gray-600/30 text-gray-400 rounded">read-only</span>
                )}
                <span className="text-sm text-white font-medium">{stage.name}</span>
                {i < stages.length - 1 && (
                  <span className="text-gray-500 ml-auto text-xs">→ Stage {i + 2}</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Provider" labelClassName="text-xs text-gray-500 block mb-1">
                  <select
                    value={stage.providerId || ''}
                    onChange={(e) => handleStageUpdate(i, 'providerId', e.target.value || null)}
                    disabled={updating}
                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-xs"
                  >
                    <option value="">Default (task-level)</option>
                    {providers?.map(provider => (
                      <option key={provider.id} value={provider.id}>{provider.name}</option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Model" labelClassName="text-xs text-gray-500 block mb-1">
                  <select
                    value={stage.model || ''}
                    onChange={(e) => handleStageUpdate(i, 'model', e.target.value || null)}
                    disabled={updating}
                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-xs"
                  >
                    <option value="">Default (task-level)</option>
                    {stage.model && !stageModels.includes(stage.model) && (
                      <option value={stage.model}>{stage.model}</option>
                    )}
                    {stageModels.map(model => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                </FormField>
                {stageEffortLevels && (
                  <FormField label="Thinking Effort" labelClassName="text-xs text-gray-500 block mb-1">
                    <select
                      value={stage.effort || ''}
                      onChange={(e) => handleStageUpdate(i, 'effort', e.target.value || null)}
                      disabled={updating}
                      className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-xs"
                    >
                      <option value="">Default effort</option>
                      {stageEffortLevels.map(level => (
                        <option key={level} value={level}>{level}</option>
                      ))}
                    </select>
                  </FormField>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-500 mt-2">Each stage runs as a separate agent. Configure different providers per stage (e.g., Codex for review, Claude for implementation).</p>
    </div>
  );
}
