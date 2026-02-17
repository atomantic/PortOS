import { useState } from 'react';
import { X, CheckCircle, AlertCircle, RotateCcw } from 'lucide-react';

export default function ResumeAgentModal({ agent, taskType = 'user', providers, apps, onSubmit, onClose }) {
  const taskDescription = agent.metadata?.taskDescription || agent.taskId || 'Resume previous task';
  const outputSummary = agent.output?.length > 0
    ? agent.output.slice(-20).map(o => o.line).join('\n')
    : '';
  const resultInfo = agent.result
    ? (agent.result.success ? 'Previous run: Completed successfully' : `Previous run: Failed - ${agent.result.error || 'Unknown error'}`)
    : '';

  const initialContext = [
    '## Previous Agent Context',
    `Agent ID: ${agent.id}`,
    `Original Task: ${taskDescription}`,
    resultInfo,
    outputSummary ? `\n## Last Output:\n\`\`\`\n${outputSummary}\n\`\`\`` : ''
  ].filter(Boolean).join('\n');

  const [formData, setFormData] = useState({
    refinedInstructions: '',
    provider: agent.metadata?.provider || '',
    model: agent.metadata?.model || '',
    app: agent.metadata?.app || ''
  });

  const selectedProvider = providers?.find(p => p.id === formData.provider);
  const availableModels = selectedProvider?.models || [];

  const handleSubmit = (e) => {
    e.preventDefault();
    const fullContext = formData.refinedInstructions.trim()
      ? `## Additional Instructions\n${formData.refinedInstructions}\n\n${initialContext}`
      : initialContext;

    onSubmit({
      description: `[Resume] ${taskDescription}`,
      context: fullContext,
      model: formData.model,
      provider: formData.provider,
      app: formData.app,
      type: taskType
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-port-card border border-port-border rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white">
            Resume {taskType === 'internal' ? 'System ' : ''}Agent Task
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Previous Task Info */}
        <div className="mb-4 p-3 bg-port-bg border border-port-border rounded-lg">
          <div className="text-sm text-gray-400 mb-1">Original Task</div>
          <div className="text-white">{taskDescription}</div>
          {agent.result && (
            <div className={`text-sm mt-2 flex items-center gap-2 ${agent.result.success ? 'text-port-success' : 'text-port-error'}`}>
              {agent.result.success ? (
                <><CheckCircle size={14} /> Completed successfully</>
              ) : (
                <><AlertCircle size={14} /> {agent.result.error || 'Failed'}</>
              )}
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Refined Instructions */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Additional Instructions (optional)
            </label>
            <textarea
              value={formData.refinedInstructions}
              onChange={e => setFormData({ ...formData, refinedInstructions: e.target.value })}
              placeholder="Provide refined or additional instructions for the resumed task..."
              rows={4}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none resize-none"
              autoFocus
            />
          </div>

          {/* App Selection */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Target App</label>
            <select
              value={formData.app}
              onChange={e => setFormData({ ...formData, app: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
            >
              <option value="">PortOS (default)</option>
              {apps?.map(app => (
                <option key={app.id} value={app.id}>{app.name}</option>
              ))}
            </select>
          </div>

          {/* Provider and Model */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-sm text-gray-400 mb-1">Provider</label>
              <select
                value={formData.provider}
                onChange={e => setFormData({ ...formData, provider: e.target.value, model: '' })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
              >
                <option value="">Auto (default)</option>
                {providers?.filter(p => p.enabled).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-sm text-gray-400 mb-1">Model</label>
              <select
                value={formData.model}
                onChange={e => setFormData({ ...formData, model: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
                disabled={!formData.provider}
              >
                <option value="">{formData.provider ? 'Select model...' : 'Select provider first'}</option>
                {availableModels.map(m => (
                  <option key={m} value={m}>{m.replace('claude-', '').replace(/-\d+$/, '')}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Context Preview (collapsed) */}
          <details className="text-sm">
            <summary className="text-gray-400 cursor-pointer hover:text-white transition-colors">
              View context to be included
            </summary>
            <pre className="mt-2 p-3 bg-port-bg border border-port-border rounded-lg text-gray-400 text-xs overflow-auto max-h-48 whitespace-pre-wrap">
              {initialContext}
            </pre>
          </details>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex items-center gap-2 px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors"
            >
              <RotateCcw size={14} />
              Queue Resume Task
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
