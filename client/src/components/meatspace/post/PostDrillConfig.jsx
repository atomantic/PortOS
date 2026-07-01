import { useState, useEffect } from 'react';
import { ArrowLeft, Save, Brain } from 'lucide-react';
import { updatePostConfig, getProviders } from '../../../services/api';
import toast from '../../ui/Toast';
import { filterSelectableModels, enabledApiProviderFilter } from '../../../utils/providers';

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

// LLM drill config meta for all 14 generatable types.
// `defaults.count` mirrors the server (`server/services/meatspacePostLlm.js`,
// `config.count || N`); `defaults.timeLimitSec` follows the DEFAULT_CONFIG
// pattern in `server/services/meatspacePost.js`.
// `defaults.enabled` is `true` only for the 5 drills the server's DEFAULT_CONFIG
// already ships enabled — the 9 newly-exposed drills default to `false` so they
// are opt-in (enabling one and saving is what pulls it into POST sessions),
// matching the pre-existing session behavior rather than silently activating 9
// extra LLM drills on first save.
const llmFields = () => [
  { key: 'count', label: 'Prompts', type: 'number', min: 1, max: 10 },
  { key: 'timeLimitSec', label: 'Time Limit (sec)', type: 'number', min: 30, max: 300 }
];

const LLM_DRILL_META = {
  // --- Wordplay ---
  'pun-wordplay': { label: 'Pun & Wordplay', desc: 'Create puns and wordplay on given topics', fields: llmFields(), defaults: { enabled: true, count: 5, timeLimitSec: 120 } },
  'word-association': { label: 'Word Association', desc: 'Associate freely with given words — trains lateral thinking', fields: llmFields(), defaults: { enabled: true, count: 5, timeLimitSec: 120 } },
  'compound-chain': { label: 'Compound Chain', desc: 'Chain compound words/phrases from a seed word', fields: llmFields(), defaults: { enabled: false, count: 5, timeLimitSec: 120 } },
  'bridge-word': { label: 'Bridge Word', desc: 'Find a word that links two others', fields: llmFields(), defaults: { enabled: false, count: 5, timeLimitSec: 120 } },
  'double-meaning': { label: 'Double Meaning', desc: 'Exploit words with two meanings', fields: llmFields(), defaults: { enabled: false, count: 5, timeLimitSec: 120 } },
  'idiom-twist': { label: 'Idiom Twist', desc: 'Twist familiar idioms into new phrases', fields: llmFields(), defaults: { enabled: false, count: 5, timeLimitSec: 120 } },
  // --- Verbal Agility ---
  'story-recall': { label: 'Story Recall', desc: 'Read a paragraph, then answer questions from memory', fields: llmFields(), defaults: { enabled: true, count: 3, timeLimitSec: 180 } },
  'verbal-fluency': { label: 'Verbal Fluency', desc: 'Name as many items in a category as possible', fields: llmFields(), defaults: { enabled: true, count: 3, timeLimitSec: 60 } },
  'wit-comeback': { label: 'Wit & Comeback', desc: 'Craft witty responses to scenarios — trains verbal agility', fields: llmFields(), defaults: { enabled: true, count: 5, timeLimitSec: 120 } },
  // --- Imagination ---
  'what-if': { label: 'What If?', desc: 'Explore creative hypothetical scenarios', fields: llmFields(), defaults: { enabled: false, count: 3, timeLimitSec: 180 } },
  'alternative-uses': { label: 'Alternative Uses', desc: 'List unconventional uses for everyday objects', fields: llmFields(), defaults: { enabled: false, count: 3, timeLimitSec: 180 } },
  'story-prompt': { label: 'Story Prompt', desc: 'Spin a short story from a creative prompt', fields: llmFields(), defaults: { enabled: false, count: 3, timeLimitSec: 180 } },
  'invention-pitch': { label: 'Invention Pitch', desc: 'Pitch inventions that solve quirky problems', fields: llmFields(), defaults: { enabled: false, count: 3, timeLimitSec: 180 } },
  'reframe': { label: 'Reframe', desc: 'Reframe a frustrating situation positively or humorously', fields: llmFields(), defaults: { enabled: false, count: 3, timeLimitSec: 180 } }
};

// Seed state for every LLM drill type so a card's toggle reflects real,
// persistable state. Without this, a type absent from the saved config renders
// as enabled (via the `enabled !== false` convention) but never enters
// `llmDrillTypes`, so Save would omit it and the launcher — which only
// enumerates persisted keys — would never surface it in a session. Each type
// starts from its `defaults` and is overlaid with any saved config value.
function seedLlmDrillTypes(saved) {
  const out = {};
  for (const [type, meta] of Object.entries(LLM_DRILL_META)) {
    out[type] = { ...meta.defaults, ...(saved?.[type] || {}) };
  }
  return out;
}

// LLM drills grouped by their DOMAINS key for section-headered rendering.
const LLM_DRILL_GROUPS = [
  { key: 'wordplay', label: 'Wordplay', types: ['pun-wordplay', 'word-association', 'compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist'] },
  { key: 'verbal', label: 'Verbal Agility', types: ['story-recall', 'verbal-fluency', 'wit-comeback'] },
  { key: 'imagination', label: 'Imagination', types: ['what-if', 'alternative-uses', 'story-prompt', 'invention-pitch', 'reframe'] }
];

const CARD_GRID = 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4';

function DrillCard({ meta, drillConfig, enabled, accent, onToggle, onUpdateField }) {
  const activeBorder = accent === 'accent-2' ? 'border-port-accent-2/30' : 'border-port-border';
  const toggleBg = accent === 'accent-2' ? 'bg-port-accent-2' : 'bg-port-accent';
  return (
    <div className={`bg-port-card border rounded-lg p-4 transition-colors ${
      enabled ? activeBorder : 'border-port-border/50 opacity-60'
    }`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-white font-medium">{meta.label}</h3>
          <p className="text-gray-500 text-xs">{meta.desc}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={meta.label}
          onClick={onToggle}
          className={`shrink-0 w-10 h-5 rounded-full transition-colors relative ${
            enabled ? toggleBg : 'bg-port-border'
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
                onChange={e => onUpdateField(field.key, e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PostDrillConfig({ config, onSaved, onBack }) {
  const [drillTypes, setDrillTypes] = useState(
    () => config?.mentalMath?.drillTypes || {}
  );
  const [llmDrillTypes, setLlmDrillTypes] = useState(
    () => seedLlmDrillTypes(config?.llmDrills?.drillTypes)
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
    getProviders().then(p => setProviders((p?.providers || []).filter(enabledApiProviderFilter))).catch(err => console.warn('⚠️ Failed to load providers: ' + err.message));
  }, []);

  function toggleDrill(type) {
    setDrillTypes(prev => ({
      ...prev,
      [type]: { ...prev[type], enabled: !(prev[type]?.enabled !== false) }
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
  const availableModels = filterSelectableModels(selectedProvider?.models);

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
    <div className="space-y-6">
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

      {/* Mental Math Section */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Mental Math</h3>
        <div className={CARD_GRID}>
          {Object.entries(DRILL_META).map(([type, meta]) => {
            const drillConfig = drillTypes[type] || {};
            return (
              <DrillCard
                key={type}
                meta={meta}
                drillConfig={drillConfig}
                enabled={drillConfig.enabled !== false}
                accent="accent"
                onToggle={() => toggleDrill(type)}
                onUpdateField={(key, value) => updateField(type, key, value)}
              />
            );
          })}
        </div>
      </div>

      {/* LLM Drills Section */}
      <div className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-2">
          <Brain size={16} className="text-port-accent-2" />
          <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Wit &amp; Memory (LLM)</h3>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={llmEnabled}
          aria-label="Wit & Memory (LLM) drills"
          onClick={() => setLlmEnabled(!llmEnabled)}
          className={`shrink-0 w-10 h-5 rounded-full transition-colors relative ${
            llmEnabled ? 'bg-port-accent-2' : 'bg-port-border'
          }`}
        >
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            llmEnabled ? 'translate-x-5' : 'translate-x-0.5'
          }`} />
        </button>
      </div>

      {llmEnabled && (
        <div className="space-y-6">
          {/* Provider & Model Selection */}
          <div className="bg-port-card border border-port-accent-2/30 rounded-lg p-4">
            <h4 className="text-sm font-medium text-gray-400 mb-3">AI Provider</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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

          {/* LLM Drill Cards grouped by domain */}
          {LLM_DRILL_GROUPS.map(group => (
            <div key={group.key} className="space-y-3">
              <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wider">{group.label}</h4>
              <div className={CARD_GRID}>
                {group.types.map(type => {
                  const meta = LLM_DRILL_META[type];
                  const drillConfig = llmDrillTypes[type] || {};
                  return (
                    <DrillCard
                      key={type}
                      meta={meta}
                      drillConfig={drillConfig}
                      enabled={drillConfig.enabled !== false}
                      accent="accent-2"
                      onToggle={() => toggleLlmDrill(type)}
                      onUpdateField={(key, value) => updateLlmField(type, key, value)}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
