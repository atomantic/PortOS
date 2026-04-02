import { useState, useEffect } from 'react';
import { ArrowLeft, Save, Brain } from 'lucide-react';
import { updatePostConfig, getProviders } from '../../../services/api';
import toast from '../../ui/Toast';

const DRILL_META = {
  'doubling-chain': {
    label: 'Doubling Chain',
    desc: 'Double a number repeatedly',
    fields: [
      { key: 'steps', label: 'Steps', type: 'number', min: 3, max: 20 },
      { key: 'timeLimitSec', label: 'Time Limit (sec)', type: 'number', min: 10, max: 300 }
    ]
  },
  'serial-subtraction': {
    label: 'Serial Subtraction',
    desc: 'Subtract a number repeatedly',
    fields: [
      { key: 'steps', label: 'Steps', type: 'number', min: 3, max: 30 },
      { key: 'subtrahend', label: 'Subtract By', type: 'number', min: 1, max: 100 },
      { key: 'timeLimitSec', label: 'Time Limit (sec)', type: 'number', min: 10, max: 300 }
    ]
  },
  'multiplication': {
    label: 'Multiplication',
    desc: 'Multiply random numbers',
    fields: [
      { key: 'count', label: 'Questions', type: 'number', min: 3, max: 30 },
      { key: 'maxDigits', label: 'Max Digits', type: 'number', min: 1, max: 4 },
      { key: 'timeLimitSec', label: 'Time Limit (sec)', type: 'number', min: 10, max: 600 }
    ]
  },
  'powers': {
    label: 'Powers',
    desc: 'Calculate base^exponent',
    fields: [
      { key: 'count', label: 'Questions', type: 'number', min: 3, max: 20 },
      { key: 'maxExponent', label: 'Max Exponent', type: 'number', min: 2, max: 20 },
      { key: 'timeLimitSec', label: 'Time Limit (sec)', type: 'number', min: 10, max: 300 }
    ]
  },
  'estimation': {
    label: 'Estimation',
    desc: 'Approximate arithmetic results',
    fields: [
      { key: 'count', label: 'Questions', type: 'number', min: 3, max: 20 },
      { key: 'tolerancePct', label: 'Tolerance %', type: 'number', min: 1, max: 50 },
      { key: 'timeLimitSec', label: 'Time Limit (sec)', type: 'number', min: 10, max: 600 }
    ]
  }
};

const LLM_DRILL_META = {
  'word-association': {
    label: 'Word Association',
    desc: 'Associate freely with given words — trains lateral thinking',
    fields: [
      { key: 'count', label: 'Prompts', type: 'number', min: 1, max: 10 },
      { key: 'timeLimitSec', label: 'Time Limit (sec)', type: 'number', min: 30, max: 300 }
    ]
  },
  'story-recall': {
    label: 'Story Recall',
    desc: 'Read a paragraph, then answer questions from memory',
    fields: [
      { key: 'count', label: 'Stories', type: 'number', min: 1, max: 5 },
      { key: 'timeLimitSec', label: 'Time Limit (sec)', type: 'number', min: 60, max: 600 }
    ]
  },
  'verbal-fluency': {
    label: 'Verbal Fluency',
    desc: 'Name as many items in a category as possible',
    fields: [
      { key: 'count', label: 'Categories', type: 'number', min: 1, max: 5 },
      { key: 'timeLimitSec', label: 'Time Limit (sec)', type: 'number', min: 30, max: 180 }
    ]
  },
  'wit-comeback': {
    label: 'Wit & Comeback',
    desc: 'Craft witty responses to scenarios — trains verbal agility',
    fields: [
      { key: 'count', label: 'Scenarios', type: 'number', min: 1, max: 10 },
      { key: 'timeLimitSec', label: 'Time Limit (sec)', type: 'number', min: 30, max: 300 }
    ]
  },
  'pun-wordplay': {
    label: 'Pun & Wordplay',
    desc: 'Create puns and wordplay on given topics',
    fields: [
      { key: 'count', label: 'Challenges', type: 'number', min: 1, max: 10 },
      { key: 'timeLimitSec', label: 'Time Limit (sec)', type: 'number', min: 30, max: 300 }
    ]
  }
};

export default function PostDrillConfig({ config, onSaved, onBack }) {
  const [drillTypes, setDrillTypes] = useState(
    () => config?.mentalMath?.drillTypes || {}
  );
  const [llmDrillTypes, setLlmDrillTypes] = useState(
    () => config?.llmDrills?.drillTypes || {}
  );
  const [llmEnabled, setLlmEnabled] = useState(
    () => config?.llmDrills?.enabled !== false
  );
  const [llmProviderId, setLlmProviderId] = useState(
    () => config?.llmDrills?.providerId || ''
  );
  const [llmModel, setLlmModel] = useState(
    () => config?.llmDrills?.model || ''
  );
  const [providers, setProviders] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getProviders().then(p => setProviders((p || []).filter(pr => pr.enabled && pr.type === 'api'))).catch(() => {});
  }, []);

  function toggleDrill(type) {
    setDrillTypes(prev => ({
      ...prev,
      [type]: { ...prev[type], enabled: !prev[type]?.enabled }
    }));
  }

  function updateField(type, key, value) {
    const coerced = value === '' || value === null || value === undefined
      ? undefined
      : Number(value);
    setDrillTypes(prev => ({
      ...prev,
      [type]: { ...prev[type], [key]: coerced }
    }));
  }

  function toggleLlmDrill(type) {
    setLlmDrillTypes(prev => ({
      ...prev,
      [type]: { ...prev[type], enabled: !(prev[type]?.enabled !== false) }
    }));
  }

  function updateLlmField(type, key, value) {
    const coerced = value === '' || value === null || value === undefined
      ? undefined
      : Number(value);
    setLlmDrillTypes(prev => ({
      ...prev,
      [type]: { ...prev[type], [key]: coerced }
    }));
  }

  const selectedProvider = providers.find(p => p.id === llmProviderId);
  const availableModels = selectedProvider?.models || [];

  async function handleSave() {
    setSaving(true);
    const updated = await updatePostConfig({
      mentalMath: { drillTypes },
      llmDrills: {
        enabled: llmEnabled,
        providerId: llmProviderId || null,
        model: llmModel || null,
        drillTypes: llmDrillTypes
      }
    }).catch(() => {
      setSaving(false);
      return null;
    });
    if (!updated) return;
    toast.success('POST config saved');
    setSaving(false);
    onSaved(updated);
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h2 className="text-xl font-bold text-white">Drill Configuration</h2>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Save size={14} />
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      {/* Drill Cards */}
      {/* Mental Math Section */}
      <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Mental Math</h3>
      {Object.entries(DRILL_META).map(([type, meta]) => {
        const drillConfig = drillTypes[type] || {};
        const enabled = drillConfig.enabled !== false;

        return (
          <div key={type} className={`bg-port-card border rounded-lg p-4 transition-colors ${
            enabled ? 'border-port-border' : 'border-port-border/50 opacity-60'
          }`}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-white font-medium">{meta.label}</h3>
                <p className="text-gray-500 text-xs">{meta.desc}</p>
              </div>
              <button
                onClick={() => toggleDrill(type)}
                className={`w-10 h-5 rounded-full transition-colors relative ${
                  enabled ? 'bg-port-accent' : 'bg-port-border'
                }`}
              >
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  enabled ? 'translate-x-5' : 'translate-x-0.5'
                }`} />
              </button>
            </div>

            {enabled && (
              <div className="grid grid-cols-3 gap-3">
                {meta.fields.map(field => (
                  <div key={field.key}>
                    <label className="text-xs text-gray-500 mb-1 block">{field.label}</label>
                    <input
                      type="number"
                      min={field.min}
                      max={field.max}
                      value={drillConfig[field.key] ?? ''}
                      onChange={e => updateField(type, field.key, e.target.value)}
                      className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* LLM Drills Section */}
      <div className="flex items-center justify-between mt-6">
        <div className="flex items-center gap-2">
          <Brain size={16} className="text-purple-400" />
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Wit & Memory (LLM)</h3>
        </div>
        <button
          onClick={() => setLlmEnabled(!llmEnabled)}
          className={`w-10 h-5 rounded-full transition-colors relative ${
            llmEnabled ? 'bg-purple-500' : 'bg-port-border'
          }`}
        >
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            llmEnabled ? 'translate-x-5' : 'translate-x-0.5'
          }`} />
        </button>
      </div>

      {llmEnabled && (
        <>
          {/* Provider & Model Selection */}
          <div className="bg-port-card border border-purple-500/30 rounded-lg p-4">
            <h4 className="text-sm font-medium text-gray-400 mb-3">AI Provider</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Provider</label>
                <select
                  value={llmProviderId}
                  onChange={e => { setLlmProviderId(e.target.value); setLlmModel(''); }}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
                >
                  <option value="">System Default</option>
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Model</label>
                <select
                  value={llmModel}
                  onChange={e => setLlmModel(e.target.value)}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
                >
                  <option value="">Provider Default</option>
                  {availableModels.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* LLM Drill Cards */}
          {Object.entries(LLM_DRILL_META).map(([type, meta]) => {
            const drillConfig = llmDrillTypes[type] || {};
            const enabled = drillConfig.enabled !== false;

            return (
              <div key={type} className={`bg-port-card border rounded-lg p-4 transition-colors ${
                enabled ? 'border-purple-500/30' : 'border-port-border/50 opacity-60'
              }`}>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="text-white font-medium">{meta.label}</h3>
                    <p className="text-gray-500 text-xs">{meta.desc}</p>
                  </div>
                  <button
                    onClick={() => toggleLlmDrill(type)}
                    className={`w-10 h-5 rounded-full transition-colors relative ${
                      enabled ? 'bg-purple-500' : 'bg-port-border'
                    }`}
                  >
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      enabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`} />
                  </button>
                </div>

                {enabled && (
                  <div className="grid grid-cols-2 gap-3">
                    {meta.fields.map(field => (
                      <div key={field.key}>
                        <label className="text-xs text-gray-500 mb-1 block">{field.label}</label>
                        <input
                          type="number"
                          min={field.min}
                          max={field.max}
                          value={drillConfig[field.key] ?? ''}
                          onChange={e => updateLlmField(type, field.key, e.target.value)}
                          className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
