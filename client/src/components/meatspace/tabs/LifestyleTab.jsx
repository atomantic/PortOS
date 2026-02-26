import { useState, useEffect, useCallback } from 'react';
import { ClipboardList, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';

const SMOKING_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: 'former', label: 'Former' },
  { value: 'current', label: 'Current' }
];

const DIET_OPTIONS = [
  { value: 'excellent', label: 'Excellent' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
  { value: 'poor', label: 'Poor' }
];

const STRESS_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'high', label: 'High' }
];

export default function LifestyleTab() {
  const [config, setConfig] = useState(null);
  const [lifestyle, setLifestyle] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const data = await api.getMeatspaceConfig().catch(() => null);
    setConfig(data);
    setLifestyle(data?.lifestyle || {
      smokingStatus: 'never',
      exerciseMinutesPerWeek: 150,
      sleepHoursPerNight: 7.5,
      dietQuality: 'good',
      stressLevel: 'moderate',
      bmi: null,
      chronicConditions: []
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSave = async () => {
    setSaving(true);
    const result = await api.updateMeatspaceLifestyle(lifestyle).catch(() => null);
    setSaving(false);
    if (result) {
      setConfig(result);
      toast.success('Lifestyle updated — death clock recalculated');
    }
  };

  const updateField = (field, value) => {
    setLifestyle(prev => ({ ...prev, [field]: value }));
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <BrailleSpinner text="Loading lifestyle data" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Sex */}
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <ClipboardList size={18} className="text-port-accent" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Profile</h3>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-500 uppercase mb-1">Biological Sex</label>
            <p className="text-lg font-mono text-gray-300 capitalize">
              {config?.sex || 'Unknown'}
              {config?.sexSource && (
                <span className="text-xs text-gray-600 ml-2">({config.sexSource})</span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Lifestyle Questionnaire */}
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Lifestyle Questionnaire</h3>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-port-accent text-white rounded-lg hover:bg-port-accent/80 disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>

        <div className="space-y-5">
          {/* Smoking */}
          <FieldGroup label="Smoking Status">
            <div className="flex gap-2">
              {SMOKING_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => updateField('smokingStatus', opt.value)}
                  className={`px-3 py-1.5 text-sm rounded-lg border ${
                    lifestyle?.smokingStatus === opt.value
                      ? 'border-port-accent bg-port-accent/20 text-port-accent'
                      : 'border-port-border text-gray-400 hover:border-gray-500'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </FieldGroup>

          {/* Exercise */}
          <FieldGroup label="Exercise (minutes/week)">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="0"
                max="600"
                step="15"
                value={lifestyle?.exerciseMinutesPerWeek ?? 150}
                onChange={e => updateField('exerciseMinutesPerWeek', parseInt(e.target.value, 10))}
                className="flex-1 accent-port-accent"
              />
              <span className="text-lg font-mono text-gray-300 w-16 text-right">
                {lifestyle?.exerciseMinutesPerWeek ?? 150}
              </span>
            </div>
            <p className="text-xs text-gray-600 mt-1">
              WHO recommends 150+ min/week moderate or 75+ min/week vigorous activity
            </p>
          </FieldGroup>

          {/* Sleep */}
          <FieldGroup label="Sleep (hours/night)">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="3"
                max="12"
                step="0.5"
                value={lifestyle?.sleepHoursPerNight ?? 7.5}
                onChange={e => updateField('sleepHoursPerNight', parseFloat(e.target.value))}
                className="flex-1 accent-port-accent"
              />
              <span className="text-lg font-mono text-gray-300 w-12 text-right">
                {lifestyle?.sleepHoursPerNight ?? 7.5}
              </span>
            </div>
            <p className="text-xs text-gray-600 mt-1">
              Optimal range: 7-9 hours for longevity
            </p>
          </FieldGroup>

          {/* Diet Quality */}
          <FieldGroup label="Diet Quality">
            <div className="flex gap-2">
              {DIET_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => updateField('dietQuality', opt.value)}
                  className={`px-3 py-1.5 text-sm rounded-lg border ${
                    lifestyle?.dietQuality === opt.value
                      ? 'border-port-accent bg-port-accent/20 text-port-accent'
                      : 'border-port-border text-gray-400 hover:border-gray-500'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </FieldGroup>

          {/* Stress Level */}
          <FieldGroup label="Stress Level">
            <div className="flex gap-2">
              {STRESS_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => updateField('stressLevel', opt.value)}
                  className={`px-3 py-1.5 text-sm rounded-lg border ${
                    lifestyle?.stressLevel === opt.value
                      ? 'border-port-accent bg-port-accent/20 text-port-accent'
                      : 'border-port-border text-gray-400 hover:border-gray-500'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </FieldGroup>

          {/* BMI */}
          <FieldGroup label="BMI (auto-calculated from body data when available)">
            <div className="flex items-center gap-3">
              <input
                type="number"
                min="10"
                max="80"
                step="0.1"
                value={lifestyle?.bmi ?? ''}
                onChange={e => updateField('bmi', e.target.value ? parseFloat(e.target.value) : null)}
                placeholder="e.g. 22.5"
                className="w-32 px-3 py-1.5 text-sm font-mono bg-port-bg border border-port-border rounded-lg text-gray-300 placeholder:text-gray-600"
              />
              {lifestyle?.bmi != null && (
                <span className={`text-sm font-medium ${
                  lifestyle.bmi >= 18.5 && lifestyle.bmi < 25 ? 'text-port-success' :
                  lifestyle.bmi >= 25 && lifestyle.bmi < 30 ? 'text-port-warning' :
                  'text-port-error'
                }`}>
                  {lifestyle.bmi < 18.5 ? 'Underweight' :
                   lifestyle.bmi < 25 ? 'Normal' :
                   lifestyle.bmi < 30 ? 'Overweight' : 'Obese'}
                </span>
              )}
            </div>
          </FieldGroup>
        </div>
      </div>

      {/* Impact Preview */}
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">Impact on Life Expectancy</h3>
        <p className="text-xs text-gray-600 mb-3">
          Changes to lifestyle factors are immediately reflected in your death clock calculation when you save.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <ImpactItem
            label="Smoking"
            value={lifestyle?.smokingStatus}
            impact={lifestyle?.smokingStatus === 'never' ? '+0' :
                    lifestyle?.smokingStatus === 'former' ? '-2' : '-10'}
          />
          <ImpactItem
            label="Exercise"
            value={`${lifestyle?.exerciseMinutesPerWeek ?? 150} min`}
            impact={(lifestyle?.exerciseMinutesPerWeek ?? 150) > 150 ? '+2' :
                    (lifestyle?.exerciseMinutesPerWeek ?? 150) >= 75 ? '+0.5' : '-2'}
          />
          <ImpactItem
            label="Sleep"
            value={`${lifestyle?.sleepHoursPerNight ?? 7.5}h`}
            impact={(lifestyle?.sleepHoursPerNight ?? 7.5) >= 7 && (lifestyle?.sleepHoursPerNight ?? 7.5) <= 9 ? '+1' :
                    (lifestyle?.sleepHoursPerNight ?? 7.5) >= 6 ? '+0' : '-1.5'}
          />
          <ImpactItem
            label="Diet"
            value={lifestyle?.dietQuality}
            impact={lifestyle?.dietQuality === 'excellent' ? '+2' :
                    lifestyle?.dietQuality === 'good' ? '+0.5' :
                    lifestyle?.dietQuality === 'fair' ? '+0' : '-3'}
          />
        </div>
      </div>
    </div>
  );
}

function FieldGroup({ label, children }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 uppercase mb-2">{label}</label>
      {children}
    </div>
  );
}

function ImpactItem({ label, value, impact }) {
  const isPositive = impact.startsWith('+') && impact !== '+0';
  const isNegative = impact.startsWith('-');
  return (
    <div className="bg-port-bg/50 rounded-lg px-3 py-2">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-gray-400 capitalize">{value}</p>
      <p className={`font-mono font-medium ${
        isPositive ? 'text-port-success' : isNegative ? 'text-port-error' : 'text-gray-500'
      }`}>
        {impact} yrs
      </p>
    </div>
  );
}
