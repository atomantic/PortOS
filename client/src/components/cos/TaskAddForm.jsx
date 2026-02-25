import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Plus, Image, X, ChevronDown, ChevronRight, Sparkles, Loader2, Paperclip, FileText, Zap, Bookmark, Ticket, GitBranch } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../services/api';
import { processScreenshotUploads, processAttachmentUploads, formatFileSize } from '../../utils/fileUpload';

export default function TaskAddForm({ providers, apps, onTaskAdded, compact = false }) {
  const [newTask, setNewTask] = useState({ description: '', context: '', model: '', provider: '', app: '' });
  const [addToTop, setAddToTop] = useState(false);
  const [enhancePrompt, setEnhancePrompt] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [createJiraTicket, setCreateJiraTicket] = useState(false);
  const [screenshots, setScreenshots] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [templateNameInput, setTemplateNameInput] = useState('');
  const [showTemplateSave, setShowTemplateSave] = useState(false);
  const fileInputRef = useRef(null);
  const attachmentInputRef = useRef(null);

  // Fetch templates
  useEffect(() => {
    api.getCosPopularTemplates(8)
      .then(data => setTemplates(data.templates || []))
      .catch(() => setTemplates([]));
  }, []);

  // Memoize enabled providers for dropdown
  const enabledProviders = useMemo(() =>
    providers?.filter(p => p.enabled) || [],
    [providers]
  );

  // Check if selected app has JIRA configured
  const selectedApp = useMemo(() =>
    apps?.find(a => a.id === newTask.app),
    [apps, newTask.app]
  );
  const appHasJira = selectedApp?.jira?.enabled;

  // Auto-toggle JIRA and worktree checkboxes when app selection changes
  useEffect(() => {
    const app = apps?.find(a => a.id === newTask.app);
    setCreateJiraTicket(!!app?.jira?.enabled);
    setUseWorktree(!!app?.defaultUseWorktree);
  }, [newTask.app, apps]);

  // Get models for selected provider
  const selectedProvider = providers?.find(p => p.id === newTask.provider);
  const availableModels = selectedProvider?.models || [];

  // Apply template to form
  const applyTemplate = useCallback(async (template) => {
    setNewTask({
      description: template.description,
      context: template.context || '',
      model: template.model || '',
      provider: template.provider || '',
      app: template.app || ''
    });
    await api.useCosTaskTemplate(template.id).catch(() => {});
    toast.success(`Template applied: ${template.name}`);
  }, []);

  // Save current form as template (inline input instead of window.prompt)
  const saveAsTemplate = useCallback(async () => {
    if (!newTask.description.trim()) {
      toast.error('Enter a task description first');
      return;
    }

    if (!showTemplateSave) {
      setTemplateNameInput(newTask.description.substring(0, 40));
      setShowTemplateSave(true);
      return;
    }

    if (!templateNameInput.trim()) {
      toast.error('Template name is required');
      return;
    }

    const result = await api.createCosTaskTemplate({
      name: templateNameInput.trim(),
      description: newTask.description,
      context: newTask.context,
      provider: newTask.provider,
      model: newTask.model,
      app: newTask.app
    }).catch(err => {
      toast.error(err.message);
      return null;
    });

    if (result?.success) {
      toast.success('Template saved');
      setShowTemplateSave(false);
      setTemplateNameInput('');
      api.getCosPopularTemplates(8)
        .then(data => setTemplates(data.templates || []))
        .catch(() => {});
    }
  }, [newTask, templateNameInput, showTemplateSave]);

  // Delete a user template
  const deleteTemplate = useCallback(async (templateId, e) => {
    e.stopPropagation();
    const result = await api.deleteCosTaskTemplate(templateId).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success('Template deleted');
      setTemplates(prev => prev.filter(t => t.id !== templateId));
    }
  }, []);

  // Screenshot handling
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

  // Attachment handling
  const handleAttachmentSelect = async (e) => {
    await processAttachmentUploads(e.target.files, {
      onSuccess: (fileInfo) => setAttachments(prev => [...prev, fileInfo]),
      onError: (msg) => toast.error(msg)
    });
    e.target.value = '';
  };

  const removeAttachment = (id) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const handleAddTask = async () => {
    if (!newTask.description.trim()) {
      toast.error('Description is required');
      return;
    }

    let finalDescription = newTask.description;

    if (enhancePrompt) {
      setIsEnhancing(true);
      const enhanceResult = await api.enhanceCosTaskPrompt({
        description: newTask.description,
        context: newTask.context
      }).catch(err => {
        toast('Enhancement failed, using original description', { icon: '\u26a0\ufe0f' });
        console.warn('Task enhancement failed:', err.message);
        return null;
      });

      if (enhanceResult?.enhancedDescription?.trim()) {
        finalDescription = enhanceResult.enhancedDescription;
        toast.success('Prompt enhanced');
      } else if (enhanceResult) {
        toast('Enhancement returned empty result, using original', { icon: '\u26a0\ufe0f' });
      }

      setIsEnhancing(false);
    }

    await api.addCosTask({
      description: finalDescription,
      context: newTask.context,
      model: newTask.model || undefined,
      provider: newTask.provider || undefined,
      app: newTask.app || undefined,
      createJiraTicket: createJiraTicket || undefined,
      useWorktree: useWorktree || undefined,
      screenshots: screenshots.length > 0 ? screenshots.map(s => s.path) : undefined,
      attachments: attachments.length > 0 ? attachments.map(a => ({
        filename: a.filename,
        originalName: a.originalName,
        path: a.path,
        size: a.size,
        mimeType: a.mimeType
      })) : undefined,
      position: addToTop ? 'top' : 'bottom'
    }).catch(err => {
      toast.error(err.message);
      return;
    });

    toast.success('Task added');
    setNewTask({ description: '', context: '', model: '', provider: '', app: '' });
    setScreenshots([]);
    setAttachments([]);
    setAddToTop(false);
    setEnhancePrompt(false);
    setCreateJiraTicket(false);
    setUseWorktree(false);
    setExpanded(false);
    onTaskAdded?.();
  };

  // Compact mode: single row with description + app + add, expandable
  if (compact) {
    return (
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <label htmlFor="compact-task-desc" className="sr-only">Task description (required)</label>
          <input
            id="compact-task-desc"
            type="text"
            placeholder="Task description *"
            value={newTask.description}
            onChange={e => setNewTask(t => ({ ...t, description: e.target.value }))}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleAddTask()}
            className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
            aria-required="true"
          />
          <div className="flex gap-2">
            <label htmlFor="compact-task-app" className="sr-only">Target application</label>
            <select
              id="compact-task-app"
              value={newTask.app}
              onChange={e => setNewTask(t => ({ ...t, app: e.target.value }))}
              className="flex-1 sm:w-32 sm:flex-none px-2 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]"
            >
              <option value="">PortOS</option>
              {apps?.map(app => (
                <option key={app.id} value={app.id}>{app.name}</option>
              ))}
            </select>
            <button
              onClick={handleAddTask}
              disabled={isEnhancing}
              className="flex items-center gap-1 px-3 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 min-h-[44px]"
            >
              {isEnhancing ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Add
            </button>
          </div>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          More options
        </button>
        {expanded && (
          <div className="space-y-3 pt-1">
            {renderFullFormFields()}
          </div>
        )}
      </div>
    );
  }

  // Full mode: identical to original TasksTab form
  return (
    <div className="bg-port-card border border-port-accent/50 rounded-lg p-4 mb-4" role="form" aria-label="Add new task">
      {/* Quick Templates */}
      {templates.length > 0 && (
        <div className="mb-4">
          <button
            onClick={() => setShowTemplates(!showTemplates)}
            className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors mb-2"
            aria-expanded={showTemplates}
          >
            {showTemplates ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Zap size={14} className="text-yellow-500" />
            Quick Templates
            <span className="text-xs text-gray-600">({templates.length})</span>
          </button>
          {showTemplates && (
            <div className="flex flex-wrap gap-2">
              {templates.map(template => (
                <div
                  key={template.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => applyTemplate(template)}
                  onKeyDown={(e) => e.key === 'Enter' && applyTemplate(template)}
                  className="group relative flex items-center gap-1.5 px-3 py-1.5 bg-port-card border border-port-border rounded-lg text-sm text-gray-300 hover:text-white hover:border-port-accent/50 transition-colors cursor-pointer"
                  title={template.description}
                >
                  <span>{template.icon || '\ud83d\udcdd'}</span>
                  <span className="max-w-[120px] truncate">{template.name}</span>
                  {template.useCount > 0 && (
                    <span className="text-xs text-gray-600">({template.useCount})</span>
                  )}
                  {!template.isBuiltin && (
                    <button
                      onClick={(e) => deleteTemplate(template.id, e)}
                      className="hidden group-hover:flex absolute -top-1 -right-1 w-4 h-4 bg-port-error rounded-full items-center justify-center"
                      title="Delete template"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <label htmlFor="task-description" className="sr-only">Task description (required)</label>
          <input
            id="task-description"
            type="text"
            placeholder="Task description *"
            value={newTask.description}
            onChange={e => setNewTask(t => ({ ...t, description: e.target.value }))}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            aria-required="true"
          />
        </div>
        {renderFullFormFields()}
      </div>
    </div>
  );

  function renderFullFormFields() {
    return (
      <>
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-3">
            <label htmlFor="add-position" className="text-sm text-gray-400">Queue Position:</label>
            <button
              id="add-position"
              type="button"
              onClick={() => setAddToTop(!addToTop)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                addToTop
                  ? 'bg-port-accent/20 text-port-accent border border-port-accent/50'
                  : 'bg-port-bg text-gray-400 border border-port-border'
              }`}
              aria-pressed={addToTop}
            >
              {addToTop ? 'Top of Queue' : 'Bottom of Queue'}
            </button>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={enhancePrompt}
              onChange={(e) => setEnhancePrompt(e.target.checked)}
              className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
            />
            <span className="flex items-center gap-1.5 text-sm text-gray-400">
              <Sparkles size={14} className="text-yellow-500" />
              Enhance with AI
            </span>
          </label>
        </div>
        <div>
          <label htmlFor="task-context" className="sr-only">Context</label>
          <input
            id="task-context"
            type="text"
            placeholder="Context (optional)"
            value={newTask.context}
            onChange={e => setNewTask(t => ({ ...t, context: e.target.value }))}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
          />
        </div>
        <div className="flex gap-3 items-center">
          {!compact && (
            <div className="flex-1">
              <label htmlFor="task-app" className="sr-only">Target application</label>
              <select
                id="task-app"
                value={newTask.app}
                onChange={e => setNewTask(t => ({ ...t, app: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value="">PortOS (default)</option>
                {apps?.map(app => (
                  <option key={app.id} value={app.id}>{app.name}</option>
                ))}
              </select>
            </div>
          )}
          <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
              className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
            />
            <span className="flex items-center gap-1.5 text-sm text-gray-400">
              <GitBranch size={14} className="text-emerald-400" />
              Branch + PR
            </span>
          </label>
          {appHasJira && (
            <label className="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap">
              <input
                type="checkbox"
                checked={createJiraTicket}
                onChange={(e) => setCreateJiraTicket(e.target.checked)}
                className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent focus:ring-offset-0"
              />
              <span className="flex items-center gap-1.5 text-sm text-gray-400">
                <Ticket size={14} className="text-blue-400" />
                Create JIRA ticket
              </span>
            </label>
          )}
        </div>
        <div className="flex gap-3">
          <div>
            <label htmlFor="task-provider" className="sr-only">AI provider</label>
            <select
              id="task-provider"
              value={newTask.provider}
              onChange={e => setNewTask(t => ({ ...t, provider: e.target.value, model: '' }))}
              className="w-40 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            >
              <option value="">Auto (default)</option>
              {enabledProviders.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          {availableModels.length > 0 && (
            <div className="flex-1">
              <label htmlFor="task-model" className="sr-only">AI model</label>
              <select
                id="task-model"
                value={newTask.model}
                onChange={e => setNewTask(t => ({ ...t, model: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value="">Select model...</option>
                {availableModels.map(m => (
                  <option key={m} value={m}>{m.replace('claude-', '').replace(/-\d+$/, '')}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        {/* Screenshot and Attachment Upload */}
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
            className="hidden"
            aria-label="Upload screenshot files"
          />
          <button
            type="button"
            onClick={() => attachmentInputRef.current?.click()}
            className="flex items-center gap-2 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-gray-400 hover:text-white text-sm transition-colors"
          >
            <Paperclip size={16} aria-hidden="true" />
            Attach File
          </button>
          <input
            ref={attachmentInputRef}
            type="file"
            accept=".txt,.md,.json,.csv,.xml,.yaml,.yml,.png,.jpg,.jpeg,.gif,.webp,.svg,.pdf,.js,.ts,.jsx,.tsx,.py,.sh,.sql,.html,.css,.zip,.tar,.gz"
            multiple
            onChange={handleAttachmentSelect}
            className="hidden"
            aria-label="Upload attachment files"
          />
          {screenshots.length > 0 && (
            <span className="text-xs text-gray-500">{screenshots.length} screenshot{screenshots.length > 1 ? 's' : ''}</span>
          )}
          {attachments.length > 0 && (
            <span className="text-xs text-gray-500">{attachments.length} file{attachments.length > 1 ? 's' : ''}</span>
          )}
        </div>
        {/* Screenshot Previews */}
        {screenshots.length > 0 && (
          <div className="flex gap-2 flex-wrap">
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
                  className="absolute -top-2 -right-2 w-5 h-5 bg-port-error rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={`Remove screenshot ${s.filename}`}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Attachment Previews */}
        {attachments.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {attachments.map(a => (
              <div key={a.id} className="relative group flex items-center gap-2 px-3 py-2 bg-port-bg border border-port-border rounded-lg">
                {a.isImage && a.preview ? (
                  <img
                    src={a.preview}
                    alt={a.originalName}
                    className="w-8 h-8 object-cover rounded"
                  />
                ) : (
                  <FileText size={20} className="text-gray-400" aria-hidden="true" />
                )}
                <div className="flex flex-col">
                  <span className="text-xs text-white truncate max-w-[120px]" title={a.originalName}>
                    {a.originalName}
                  </span>
                  <span className="text-xs text-gray-500">{formatFileSize(a.size)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  className="ml-1 p-0.5 text-gray-500 hover:text-port-error transition-colors"
                  aria-label={`Remove attachment ${a.originalName}`}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Template Save Inline Input */}
        {showTemplateSave && (
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={templateNameInput}
              onChange={e => setTemplateNameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveAsTemplate()}
              placeholder="Template name..."
              className="flex-1 px-3 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              autoFocus
            />
            <button
              onClick={saveAsTemplate}
              className="px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => { setShowTemplateSave(false); setTemplateNameInput(''); }}
              className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-gray-400 rounded-lg text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
        {!compact && (
          <div className="flex justify-end gap-2">
            <button
              onClick={saveAsTemplate}
              type="button"
              className="flex items-center gap-1 px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-gray-400 hover:text-white rounded-lg text-sm transition-colors min-h-[40px]"
              title="Save current form as a reusable template"
            >
              <Bookmark size={14} aria-hidden="true" />
              <span className="hidden sm:inline">Save Template</span>
            </button>
            <button
              onClick={handleAddTask}
              disabled={isEnhancing}
              className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[40px]"
            >
              {isEnhancing ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  Enhancing...
                </>
              ) : (
                <>
                  <Plus size={14} aria-hidden="true" />
                  {enhancePrompt ? 'Enhance & Add' : 'Add'}
                </>
              )}
            </button>
          </div>
        )}
      </>
    );
  }
}
