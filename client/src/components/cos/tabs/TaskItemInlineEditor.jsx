import { Save, X } from 'lucide-react';
import ExecutionOptionsSelect from '../../providers/ExecutionOptionsSelect.jsx';
import AutoSizeTextarea from '../../ui/AutoSizeTextarea';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import { effectiveModelFor, effortAwareModelOptions, effortSurvivingModel } from '../../../utils/providers';
import { shortClaudeModelName } from '../../../utils/formatters';
import InstancePicker from '../InstancePicker';
import EffortSelect from '../EffortSelect';

export default function TaskItemInlineEditor({ task, idScope, editData, setEditData, hasPromptField, canPinInstance, knownInstances, providers, isConfirmingDiscard, handleConfirmDiscard, cancelDiscardConfirm, handleSave, handleCancelEdit }) {
  // Get models for selected provider in edit mode
  const editProvider = providers?.find(p => p.id === editData.provider);
  const editModels = effortAwareModelOptions(editProvider, editData.model);

  return (
    <div className="space-y-2" onPointerDown={e => e.stopPropagation()}>
      <AutoSizeTextarea
        value={editData.description}
        aria-label="Task description"
        onChange={e => setEditData(d => ({ ...d, description: e.target.value }))}
        className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm min-h-[34px]"
      />
      {/* A textarea, not an input: for orchestrator tasks this holds the
          task's entire multi-line prompt, which is unreadable and
          unnavigable in a single-line field. Bounded rows + its own
          scroll so editing a long prompt doesn't stretch the card. */}
      {hasPromptField && (
        <textarea
          rows={4}
          placeholder="Prompt"
          aria-label="Task prompt"
          value={editData.prompt}
          onChange={e => setEditData(d => ({ ...d, prompt: e.target.value }))}
          className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm font-mono resize-y overflow-auto"
        />
      )}
      <textarea
        rows={4}
        placeholder="Context"
        aria-label="Task context"
        value={editData.context}
        onChange={e => setEditData(d => ({ ...d, context: e.target.value }))}
        className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm font-mono resize-y overflow-auto"
      />
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          aria-label="Provider"
          value={editData.provider}
          onChange={e => setEditData(d => ({ ...d, provider: e.target.value, model: '', effort: '' }))}
          className="w-full sm:w-36 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
        >
          <option value="">Auto</option>
          {providers?.filter(p => p.enabled !== false || p.id === editData.provider).map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {editModels.length > 0 && (
          <select
            aria-label="Model"
            value={editData.model}
            onChange={e => setEditData(d => ({
              ...d,
              model: e.target.value,
              effort: effortSurvivingModel(editProvider, e.target.value, d.effort)
            }))}
            className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
          >
            <option value="">Auto</option>
            {editModels.map(m => (
              <option key={m} value={m}>{shortClaudeModelName(m)}</option>
            ))}
          </select>
        )}
        <EffortSelect
          provider={editProvider}
          model={effectiveModelFor(editProvider, editData.model)}
          value={editData.effort}
          onChange={effort => setEditData(d => ({ ...d, effort }))}
          className="w-full sm:w-36 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
        />
        <ExecutionOptionsSelect provider={editProvider} model={effectiveModelFor(editProvider, editData.model)}
          value={editData.executionOptions} onChange={executionOptions => setEditData(d => ({ ...d, executionOptions }))}
          className="w-full sm:w-36 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm" />
      </div>
      {canPinInstance && (
        <InstancePicker
          id={`task-target-instance-${idScope}-${task.id}`}
          value={editData.targetInstanceId}
          onChange={(next) => setEditData(d => ({ ...d, targetInstanceId: next }))}
          instances={knownInstances}
        />
      )}
      {isConfirmingDiscard(task.id) ? (
        <ConfirmButtonPair
          prompt="Discard unsaved changes?"
          confirmText="Discard"
          ariaLabel="Confirm discard task edits"
          tone="warning"
          onConfirm={handleConfirmDiscard}
          onCancel={cancelDiscardConfirm}
        />
      ) : (
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            className="flex items-center gap-1 text-sm px-3 py-2 min-h-[40px] text-port-success hover:text-port-success/80 bg-port-success/10 hover:bg-port-success/20 rounded transition-colors"
          >
            <Save size={14} aria-hidden="true" /> Save
          </button>
          <button
            onClick={handleCancelEdit}
            className="flex items-center gap-1 text-sm px-3 py-2 min-h-[40px] text-gray-400 hover:text-white bg-port-bg hover:bg-port-border rounded transition-colors"
          >
            <X size={14} aria-hidden="true" /> Cancel
          </button>
        </div>
      )}
    </div>
  );
}
