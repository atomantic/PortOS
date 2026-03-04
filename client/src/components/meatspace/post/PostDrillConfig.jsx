import { useState } from 'react';
import { ArrowLeft, Save } from 'lucide-react';
import { updatePostConfig } from '../../../services/api';
import toast from 'react-hot-toast';

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

export default function PostDrillConfig({ config, onSaved, onBack }) {
  const [drillTypes, setDrillTypes] = useState(
    () => config?.mentalMath?.drillTypes || {}
  );
  const [saving, setSaving] = useState(false);

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

  async function handleSave() {
    setSaving(true);
    const updated = await updatePostConfig({
      mentalMath: { drillTypes }
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
    </div>
  );
}
