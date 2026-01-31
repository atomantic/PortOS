import { useState, useEffect } from 'react';
import { FileText, Variable, RefreshCw, Save, Plus, Trash2, Eye } from 'lucide-react';

export default function PromptManager() {
  const [tab, setTab] = useState('stages');
  const [stages, setStages] = useState({});
  const [variables, setVariables] = useState({});
  const [loading, setLoading] = useState(true);

  // System stages that are protected
  const systemStages = [
    'cos-agent-briefing', 'cos-evaluate', 'cos-report-summary', 'cos-self-improvement',
    'cos-task-enhance', 'brain-classifier', 'brain-daily-digest', 'brain-weekly-review',
    'memory-evaluate', 'app-detection'
  ];

  // Stage editing
  const [selectedStage, setSelectedStage] = useState(null);
  const [stageTemplate, setStageTemplate] = useState('');
  const [stageConfig, setStageConfig] = useState({});
  const [preview, setPreview] = useState('');
  const [testData, setTestData] = useState('{}');

  // Variable editing
  const [selectedVar, setSelectedVar] = useState(null);
  const [varForm, setVarForm] = useState({ key: '', name: '', category: '', content: '' });

  // Stage creation
  const [creatingStage, setCreatingStage] = useState(false);
  const [newStageForm, setNewStageForm] = useState({
    stageName: '',
    name: '',
    description: '',
    model: 'default',
    returnsJson: false,
    variables: [],
    template: ''
  });

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [stagesRes, varsRes] = await Promise.all([
      fetch('/api/prompts').then(r => r.json()),
      fetch('/api/prompts/variables').then(r => r.json())
    ]);
    setStages(stagesRes.stages || {});
    setVariables(varsRes.variables || {});
    setLoading(false);
  };

  const loadStage = async (name) => {
    setSelectedStage(name);
    const res = await fetch(`/api/prompts/${name}`).then(r => r.json());
    setStageTemplate(res.template || '');
    setStageConfig({ name: res.name, description: res.description, model: res.model, variables: res.variables || [] });
    setPreview('');
  };

  const saveStage = async () => {
    setSaving(true);
    await fetch(`/api/prompts/${selectedStage}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: stageTemplate, ...stageConfig })
    });
    setSaving(false);
    await loadData();
  };

  const previewStage = async () => {
    const data = JSON.parse(testData || '{}');
    const res = await fetch(`/api/prompts/${selectedStage}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testData: data })
    }).then(r => r.json());
    setPreview(res.preview);
  };

  const loadVariable = (key) => {
    setSelectedVar(key);
    const v = variables[key];
    setVarForm({ key, name: v.name || '', category: v.category || '', content: v.content || '' });
  };

  const saveVariable = async () => {
    setSaving(true);
    if (selectedVar) {
      await fetch(`/api/prompts/variables/${selectedVar}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(varForm)
      });
    } else {
      await fetch('/api/prompts/variables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(varForm)
      });
    }
    setSaving(false);
    setSelectedVar(null);
    setVarForm({ key: '', name: '', category: '', content: '' });
    await loadData();
  };

  const deleteVariable = async (key) => {
    await fetch(`/api/prompts/variables/${key}`, { method: 'DELETE' });
    await loadData();
  };

  const newVariable = () => {
    setSelectedVar(null);
    setVarForm({ key: '', name: '', category: '', content: '' });
  };

  const createStage = async () => {
    setSaving(true);
    await fetch('/api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newStageForm)
    });
    setSaving(false);
    setCreatingStage(false);
    setNewStageForm({
      stageName: '',
      name: '',
      description: '',
      model: 'default',
      returnsJson: false,
      variables: [],
      template: ''
    });
    await loadData();
  };

  const deleteStage = async (stageName) => {
    // Check if stage is in use
    const usageRes = await fetch(`/api/prompts/${stageName}/usage`).then(r => r.json());

    let confirmMessage = `Delete stage "${stageName}"?`;

    if (usageRes.isSystemStage) {
      confirmMessage = `⚠️ WARNING: "${stageName}" is a SYSTEM stage!\n\n` +
        `Used by: ${usageRes.usedBy.join(', ')}\n\n` +
        `Deleting this will break PortOS functionality.\n\n` +
        `Are you SURE you want to delete it?`;
    } else {
      confirmMessage += `\n\nThis cannot be undone.`;
    }

    if (!confirm(confirmMessage)) return;

    try {
      // System stages require force flag
      const url = usageRes.isSystemStage
        ? `/api/prompts/${stageName}?force=true`
        : `/api/prompts/${stageName}`;

      const res = await fetch(url, { method: 'DELETE' });

      if (!res.ok) {
        const error = await res.json();
        alert(`Failed to delete: ${error.error || 'Unknown error'}`);
        return;
      }

      if (selectedStage === stageName) {
        setSelectedStage(null);
      }
      await loadData();
    } catch (err) {
      alert(`Failed to delete: ${err.message}`);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-gray-500">Loading...</div>;
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Prompt Manager</h1>
          <p className="text-gray-500 text-sm sm:text-base">Customize AI prompts for backend operations</p>
        </div>
        <button
          onClick={loadData}
          className="p-2 text-gray-400 hover:text-white self-end sm:self-auto"
          title="Reload"
        >
          <RefreshCw size={20} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        <button
          onClick={() => setTab('stages')}
          className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg transition-colors text-sm sm:text-base ${
            tab === 'stages' ? 'bg-port-accent text-white' : 'bg-port-card text-gray-400 hover:text-white'
          }`}
        >
          <FileText size={16} /> Stages
        </button>
        <button
          onClick={() => setTab('variables')}
          className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg transition-colors text-sm sm:text-base ${
            tab === 'variables' ? 'bg-port-accent text-white' : 'bg-port-card text-gray-400 hover:text-white'
          }`}
        >
          <Variable size={16} /> Variables
        </button>
      </div>

      {/* Stages Tab */}
      {tab === 'stages' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Stage List */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-400">Prompt Stages</h3>
              <button
                onClick={() => setCreatingStage(true)}
                className="p-1 text-port-accent hover:text-port-accent/80"
                title="New Stage"
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="space-y-1">
              {Object.entries(stages).sort(([a], [b]) => a.localeCompare(b)).map(([name, config]) => (
                <div
                  key={name}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                    selectedStage === name
                      ? 'bg-port-accent/20 text-port-accent'
                      : 'text-gray-300 hover:bg-port-border'
                  }`}
                >
                  <button
                    onClick={() => loadStage(name)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className="flex items-center gap-1">
                      <span className="font-medium truncate">{config.name || name}</span>
                      {systemStages.includes(name) && (
                        <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 bg-port-accent/20 text-port-accent rounded uppercase font-semibold">
                          System
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 truncate">{config.description}</div>
                  </button>
                  <button
                    onClick={() => deleteStage(name)}
                    className="flex-shrink-0 p-1 text-gray-500 hover:text-port-error"
                    title="Delete stage"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Stage Editor */}
          <div className="lg:col-span-2 space-y-4">
            {selectedStage ? (
              <>
                <div className="bg-port-card border border-port-border rounded-xl p-4">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-medium text-white">{stageConfig.name}</h3>
                    <div className="flex gap-2">
                      <button
                        onClick={previewStage}
                        className="flex items-center gap-1 px-3 py-1 text-sm bg-port-border hover:bg-port-border/80 text-white rounded"
                      >
                        <Eye size={14} /> Preview
                      </button>
                      <button
                        onClick={saveStage}
                        disabled={saving}
                        className="flex items-center gap-1 px-3 py-1 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50"
                      >
                        <Save size={14} /> Save
                      </button>
                    </div>
                  </div>

                  <div className="mb-4">
                    <label className="block text-sm text-gray-400 mb-1">Template</label>
                    <textarea
                      value={stageTemplate}
                      onChange={(e) => setStageTemplate(e.target.value)}
                      className="w-full h-64 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-none"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Use {'{{variable}}'} for substitution, {'{{#array}}...{{/array}}'} for iteration
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">Model</label>
                      <select
                        value={stageConfig.model || 'default'}
                        onChange={(e) => setStageConfig({ ...stageConfig, model: e.target.value })}
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                      >
                        <option value="default">Default</option>
                        <option value="quick">Quick</option>
                        <option value="coding">Coding</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm text-gray-400 mb-1">Variables Used</label>
                      <div className="text-sm text-gray-300">
                        {(stageConfig.variables || []).join(', ') || 'None'}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Preview Panel */}
                {preview && (
                  <div className="bg-port-card border border-port-border rounded-xl p-4">
                    <h4 className="text-sm font-medium text-gray-400 mb-2">Preview</h4>
                    <pre className="text-sm text-gray-300 whitespace-pre-wrap bg-port-bg p-3 rounded max-h-64 overflow-auto">
                      {preview}
                    </pre>
                  </div>
                )}

                {/* Test Data */}
                <div className="bg-port-card border border-port-border rounded-xl p-4">
                  <h4 className="text-sm font-medium text-gray-400 mb-2">Test Data (JSON)</h4>
                  <textarea
                    value={testData}
                    onChange={(e) => setTestData(e.target.value)}
                    className="w-full h-24 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-none"
                    placeholder='{"dirName": "my-app", "fileList": "package.json, src/"}'
                  />
                </div>
              </>
            ) : (
              <div className="bg-port-card border border-port-border rounded-xl p-12 text-center text-gray-500">
                Select a stage to edit
              </div>
            )}
          </div>
        </div>
      )}

      {/* Variables Tab */}
      {tab === 'variables' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Variable List */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-400">Variables</h3>
              <button
                onClick={newVariable}
                className="p-1 text-port-accent hover:text-port-accent/80"
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="space-y-1">
              {Object.entries(variables).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => (
                <div
                  key={key}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${
                    selectedVar === key
                      ? 'bg-port-accent/20 text-port-accent'
                      : 'text-gray-300 hover:bg-port-border'
                  }`}
                >
                  <button
                    onClick={() => loadVariable(key)}
                    className="flex-1 text-left"
                  >
                    <div className="font-medium">{v.name || key}</div>
                    <div className="text-xs text-gray-500">{v.category || 'uncategorized'}</div>
                  </button>
                  <button
                    onClick={() => deleteVariable(key)}
                    className="p-1 text-gray-500 hover:text-port-error"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Variable Editor */}
          <div className="lg:col-span-2">
            <div className="bg-port-card border border-port-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-white">
                  {selectedVar ? `Edit: ${selectedVar}` : 'New Variable'}
                </h3>
                <button
                  onClick={saveVariable}
                  disabled={saving || !varForm.key || !varForm.content}
                  className="flex items-center gap-1 px-3 py-1 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50"
                >
                  <Save size={14} /> Save
                </button>
              </div>

              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Key *</label>
                    <input
                      type="text"
                      value={varForm.key}
                      onChange={(e) => setVarForm({ ...varForm, key: e.target.value })}
                      disabled={!!selectedVar}
                      placeholder="variableKey"
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Name</label>
                    <input
                      type="text"
                      value={varForm.name}
                      onChange={(e) => setVarForm({ ...varForm, name: e.target.value })}
                      placeholder="Human Readable Name"
                      className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-gray-400 mb-1">Category</label>
                  <select
                    value={varForm.category}
                    onChange={(e) => setVarForm({ ...varForm, category: e.target.value })}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                  >
                    <option value="">Select category</option>
                    <option value="response">Response Format</option>
                    <option value="schema">Schema</option>
                    <option value="rules">Rules</option>
                    <option value="system">System</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm text-gray-400 mb-1">Content *</label>
                  <textarea
                    value={varForm.content}
                    onChange={(e) => setVarForm({ ...varForm, content: e.target.value })}
                    className="w-full h-48 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-none"
                    placeholder="Variable content..."
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create Stage Modal */}
      {creatingStage && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-port-card border border-port-border rounded-xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-white">Create New Stage</h3>
              <button
                onClick={() => setCreatingStage(false)}
                className="text-gray-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Stage Key *</label>
                  <input
                    type="text"
                    value={newStageForm.stageName}
                    onChange={(e) => setNewStageForm({ ...newStageForm, stageName: e.target.value })}
                    placeholder="my-stage"
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                  />
                  <p className="text-xs text-gray-500 mt-1">Lowercase, hyphens only</p>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Display Name *</label>
                  <input
                    type="text"
                    value={newStageForm.name}
                    onChange={(e) => setNewStageForm({ ...newStageForm, name: e.target.value })}
                    placeholder="My Stage"
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Description</label>
                <input
                  type="text"
                  value={newStageForm.description}
                  onChange={(e) => setNewStageForm({ ...newStageForm, description: e.target.value })}
                  placeholder="What this stage does"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Model</label>
                  <select
                    value={newStageForm.model}
                    onChange={(e) => setNewStageForm({ ...newStageForm, model: e.target.value })}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                  >
                    <option value="default">Default</option>
                    <option value="quick">Quick</option>
                    <option value="coding">Coding</option>
                    <option value="heavy">Heavy</option>
                  </select>
                </div>
                <div>
                  <label className="flex items-center gap-2 text-sm text-gray-400 mt-7">
                    <input
                      type="checkbox"
                      checked={newStageForm.returnsJson}
                      onChange={(e) => setNewStageForm({ ...newStageForm, returnsJson: e.target.checked })}
                      className="rounded"
                    />
                    Returns JSON
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Template</label>
                <textarea
                  value={newStageForm.template}
                  onChange={(e) => setNewStageForm({ ...newStageForm, template: e.target.value })}
                  className="w-full h-64 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-none"
                  placeholder="Enter your prompt template here..."
                />
              </div>

              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setCreatingStage(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={createStage}
                  disabled={saving || !newStageForm.stageName || !newStageForm.name}
                  className="flex items-center gap-1 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50"
                >
                  <Save size={14} /> Create Stage
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
