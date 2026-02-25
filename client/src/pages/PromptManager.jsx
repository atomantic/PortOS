import { useState, useEffect } from 'react';
import { FileText, Variable, RefreshCw, Save, Plus, Trash2, Eye, Briefcase } from 'lucide-react';
import BrailleSpinner from '../components/BrailleSpinner';
import ProviderModelSelector from '../components/ProviderModelSelector';

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

  // Job skills
  const [jobSkills, setJobSkills] = useState([]);
  const [selectedJobSkill, setSelectedJobSkill] = useState(null);
  const [jobSkillContent, setJobSkillContent] = useState('');
  const [jobSkillMeta, setJobSkillMeta] = useState({});
  const [jobSkillPreview, setJobSkillPreview] = useState('');

  const [providers, setProviders] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [stagesRes, varsRes, jobSkillsRes, providersRes] = await Promise.all([
      fetch('/api/prompts').then(r => r.json()),
      fetch('/api/prompts/variables').then(r => r.json()),
      fetch('/api/prompts/skills/jobs').then(r => r.json()).catch(() => ({ skills: [] })),
      fetch('/api/providers').then(r => r.json()).catch(() => ({ providers: [] }))
    ]);
    setStages(stagesRes.stages || {});
    setVariables(varsRes.variables || {});
    setJobSkills(jobSkillsRes.skills || []);
    setProviders((providersRes.providers || []).filter(p => p.enabled));
    setLoading(false);
  };

  const loadStage = async (name) => {
    setSelectedStage(name);
    const res = await fetch(`/api/prompts/${name}`).then(r => r.json());
    setStageTemplate(res.template || '');
    setStageConfig({ name: res.name, description: res.description, model: res.model, provider: res.provider || null, variables: res.variables || [] });
    setPreview('');
  };

  const saveStage = async () => {
    setSaving(true);
    const payload = { template: stageTemplate, ...stageConfig };
    // Explicitly null provider when in tier mode so server clears any previous value
    if (!payload.provider) payload.provider = null;
    await fetch(`/api/prompts/${selectedStage}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
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
    const payload = { ...newStageForm };
    // Strip provider field when in tier mode
    if (!payload.provider) delete payload.provider;
    const res = await fetch('/api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      let message = 'Failed to create stage';
      const errorBody = await res.json().catch(() => null);
      if (errorBody?.error || errorBody?.message) {
        message = errorBody.error || errorBody.message;
      }
      setSaving(false);
      alert(message);
      return;
    }

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
    let usageRes;
    const usageResponse = await fetch(`/api/prompts/${stageName}/usage`).catch(() => null);
    if (!usageResponse || !usageResponse.ok) {
      usageRes = { isSystemStage: false, usedBy: [] };
    } else {
      usageRes = await usageResponse.json().catch(() => ({ isSystemStage: false, usedBy: [] }));
    }

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

  // Job skill functions
  const loadJobSkill = async (name) => {
    setSelectedJobSkill(name);
    setJobSkillPreview('');
    const res = await fetch(`/api/prompts/skills/jobs/${name}`).then(r => r.json());
    setJobSkillContent(res.content || '');
    setJobSkillMeta({ jobName: res.jobName, jobId: res.jobId, category: res.category, interval: res.interval });
  };

  const saveJobSkill = async () => {
    setSaving(true);
    await fetch(`/api/prompts/skills/jobs/${selectedJobSkill}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: jobSkillContent })
    });
    setSaving(false);
  };

  const previewJobSkill = async () => {
    const res = await fetch(`/api/prompts/skills/jobs/${selectedJobSkill}/preview`).then(r => r.json());
    setJobSkillPreview(res.preview || '');
  };

  const getModelsForProvider = (providerId) => {
    const p = providers.find(pr => pr.id === providerId);
    return p ? (p.models || [p.defaultModel]).filter(Boolean) : [];
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><BrailleSpinner text="Loading prompts" /></div>;
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
        <button
          onClick={() => setTab('job-skills')}
          className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg transition-colors text-sm sm:text-base ${
            tab === 'job-skills' ? 'bg-port-accent text-white' : 'bg-port-card text-gray-400 hover:text-white'
          }`}
        >
          <Briefcase size={16} /> Job Skills
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

                  <div className="space-y-4">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <label className="text-sm text-gray-400">Model</label>
                        <div className="flex gap-1">
                          <button
                            onClick={() => setStageConfig({ ...stageConfig, provider: null, model: 'default' })}
                            className={`px-2 py-1 text-xs rounded transition-colors ${!stageConfig.provider ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'}`}
                          >
                            Tier
                          </button>
                          <button
                            onClick={() => {
                              if (stageConfig.provider) return;
                              const first = providers[0];
                              setStageConfig({ ...stageConfig, provider: first?.id || '', model: first?.defaultModel || '' });
                            }}
                            disabled={providers.length === 0}
                            className={`px-2 py-1 text-xs rounded transition-colors ${stageConfig.provider ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'} disabled:opacity-50`}
                          >
                            Specific
                          </button>
                        </div>
                      </div>
                      {!stageConfig.provider ? (
                        <select
                          value={stageConfig.model || 'default'}
                          onChange={(e) => setStageConfig({ ...stageConfig, model: e.target.value })}
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                        >
                          <option value="default">Default</option>
                          <option value="quick">Quick</option>
                          <option value="coding">Coding</option>
                          <option value="heavy">Heavy</option>
                        </select>
                      ) : (
                        <ProviderModelSelector
                          providers={providers}
                          selectedProviderId={stageConfig.provider}
                          selectedModel={stageConfig.model}
                          availableModels={getModelsForProvider(stageConfig.provider)}
                          onProviderChange={(id) => {
                            const p = providers.find(pr => pr.id === id);
                            setStageConfig({ ...stageConfig, provider: id, model: p?.defaultModel || '' });
                          }}
                          onModelChange={(model) => setStageConfig({ ...stageConfig, model })}
                        />
                      )}
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

      {/* Job Skills Tab */}
      {tab === 'job-skills' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Job Skill List */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <div className="mb-3">
              <h3 className="text-sm font-medium text-gray-400">Autonomous Job Skills</h3>
              <p className="text-xs text-gray-500 mt-1">Versioned prompt templates for recurring jobs</p>
            </div>
            <div className="space-y-1">
              {jobSkills.map((skill) => (
                <button
                  key={skill.name}
                  onClick={() => loadJobSkill(skill.name)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
                    selectedJobSkill === skill.name
                      ? 'bg-port-accent/20 text-port-accent'
                      : 'text-gray-300 hover:bg-port-border'
                  }`}
                >
                  <div className="flex items-center gap-1">
                    <span className="font-medium">{skill.name}</span>
                    {skill.hasTemplate && (
                      <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 bg-port-success/20 text-port-success rounded uppercase font-semibold">
                        Active
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">{skill.jobId}</div>
                </button>
              ))}
              {jobSkills.length === 0 && (
                <div className="text-sm text-gray-500 px-3 py-2">No job skill templates found</div>
              )}
            </div>
          </div>

          {/* Job Skill Editor */}
          <div className="lg:col-span-2 space-y-4">
            {selectedJobSkill ? (
              <>
                <div className="bg-port-card border border-port-border rounded-xl p-4">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-lg font-medium text-white">{jobSkillMeta.jobName || selectedJobSkill}</h3>
                      <div className="flex gap-3 text-xs text-gray-500 mt-1">
                        {jobSkillMeta.category && <span>Category: {jobSkillMeta.category}</span>}
                        {jobSkillMeta.interval && <span>Interval: {jobSkillMeta.interval}</span>}
                        {jobSkillMeta.jobId && <span>ID: {jobSkillMeta.jobId}</span>}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={previewJobSkill}
                        className="flex items-center gap-1 px-3 py-1 text-sm bg-port-border hover:bg-port-border/80 text-white rounded"
                      >
                        <Eye size={14} /> Preview
                      </button>
                      <button
                        onClick={saveJobSkill}
                        disabled={saving}
                        className="flex items-center gap-1 px-3 py-1 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50"
                      >
                        <Save size={14} /> Save
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Skill Template (Markdown)</label>
                    <textarea
                      value={jobSkillContent}
                      onChange={(e) => setJobSkillContent(e.target.value)}
                      className="w-full h-96 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-none"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Sections: ## Prompt Template, ## Steps, ## Expected Outputs, ## Success Criteria
                    </p>
                  </div>
                </div>

                {/* Preview Panel */}
                {jobSkillPreview && (
                  <div className="bg-port-card border border-port-border rounded-xl p-4">
                    <h4 className="text-sm font-medium text-gray-400 mb-2">Effective Prompt Preview</h4>
                    <pre className="text-sm text-gray-300 whitespace-pre-wrap bg-port-bg p-3 rounded max-h-64 overflow-auto">
                      {jobSkillPreview}
                    </pre>
                  </div>
                )}
              </>
            ) : (
              <div className="bg-port-card border border-port-border rounded-xl p-12 text-center text-gray-500">
                <p>Select a job skill to edit its prompt template</p>
                <p className="text-xs mt-2">These templates define how recurring autonomous jobs execute</p>
              </div>
            )}
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

              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <label className="text-sm text-gray-400">Model</label>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setNewStageForm({ ...newStageForm, provider: undefined, model: 'default' })}
                        className={`px-2 py-1 text-xs rounded transition-colors ${!newStageForm.provider ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'}`}
                      >
                        Tier
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (newStageForm.provider) return;
                          const first = providers[0];
                          setNewStageForm({ ...newStageForm, provider: first?.id || '', model: first?.defaultModel || '' });
                        }}
                        disabled={providers.length === 0}
                        className={`px-2 py-1 text-xs rounded transition-colors ${newStageForm.provider ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'} disabled:opacity-50`}
                      >
                        Specific
                      </button>
                    </div>
                  </div>
                  {!newStageForm.provider ? (
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
                  ) : (
                    <ProviderModelSelector
                      providers={providers}
                      selectedProviderId={newStageForm.provider}
                      selectedModel={newStageForm.model}
                      availableModels={getModelsForProvider(newStageForm.provider)}
                      onProviderChange={(id) => {
                        const p = providers.find(pr => pr.id === id);
                        setNewStageForm({ ...newStageForm, provider: id, model: p?.defaultModel || '' });
                      }}
                      onModelChange={(model) => setNewStageForm({ ...newStageForm, model })}
                    />
                  )}
                </div>
                <div>
                  <label className="flex items-center gap-2 text-sm text-gray-400">
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
