import { useState, useRef } from 'react';
import { X, CheckCircle, AlertCircle, RotateCcw, Image, Loader2 } from 'lucide-react';
import { processScreenshotUploads } from '../../../utils/fileUpload';
import toast from '../../ui/Toast';

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
    provider: agent.metadata?.providerId || agent.metadata?.provider || '',
    model: agent.metadata?.model || '',
    app: agent.metadata?.taskApp || agent.metadata?.app || ''
  });
  const [screenshots, setScreenshots] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef(null);

  const handleFileSelect = async (e) => {
    await processScreenshotUploads(e.target.files, {
      onSuccess: (fileInfo) => setScreenshots(prev => [...prev, fileInfo]),
      onError: (msg) => toast.error(msg)
    });
    e.target.value = '';
  };

  const removeScreenshot = (id) => {
    setScreenshots(prev => prev.filter(s => s.id !== id));
  };

  const selectedProvider = providers?.find(p => p.id === formData.provider);
  const availableModels = selectedProvider?.models || [];

  const submittingRef = useRef(false);
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);

    const fullContext = formData.refinedInstructions.trim()
      ? `## Additional Instructions\n${formData.refinedInstructions}\n\n${initialContext}`
      : initialContext;

    await onSubmit({
      description: `[Resume] ${taskDescription}`,
      context: fullContext,
      model: formData.model,
      provider: formData.provider,
      app: formData.app,
      type: taskType,
      screenshots: screenshots.length > 0 ? screenshots.map(s => s.path) : undefined
    }).catch(err => {
      toast.error(err?.message || 'Failed to resume agent');
    }).finally(() => {
      submittingRef.current = false;
      setIsSubmitting(false);
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
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden resize-none"
              autoFocus
            />
          </div>

          {/* Screenshot Upload */}
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 hover:text-white text-sm transition-colors"
              >
                <Image size={16} aria-hidden="true" />
                Add Screenshot
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileSelect}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
              />
              {screenshots.length > 0 && (
                <span className="text-xs text-gray-500">{screenshots.length} screenshot{screenshots.length > 1 ? 's' : ''}</span>
              )}
            </div>
            {screenshots.length > 0 && (
              <div className="flex gap-2 flex-wrap mt-2">
                {screenshots.map(s => (
                  <div key={s.id} className="relative group">
                    <img
                      src={s.preview}
                      alt={s.filename}
                      className="w-20 h-20 object-cover rounded-lg border border-port-border"
                    />
                    <button
                      type="button"
                      onClick={() => removeScreenshot(s.id)}
                      className="absolute -top-2 -right-2 w-5 h-5 bg-port-error rounded-full flex items-center justify-center md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                      aria-label={`Remove screenshot ${s.filename}`}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* App Selection */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Target App</label>
            <select
              value={formData.app}
              onChange={e => setFormData({ ...formData, app: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
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
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
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
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
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
              disabled={isSubmitting}
              className="flex items-center gap-2 px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
              {isSubmitting ? 'Queuing...' : 'Queue Resume Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
