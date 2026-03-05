import { useState, useEffect, useCallback } from 'react';
import { Save } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../services/api';

function ArrayInput({ label, value, onChange, placeholder }) {
  const [text, setText] = useState((value || []).join('\n'));

  useEffect(() => {
    setText((value || []).join('\n'));
  }, [value]);

  const handleBlur = () => {
    const items = text.split('\n').map(s => s.trim()).filter(Boolean);
    onChange(items);
  };

  return (
    <div>
      <label className="block text-sm text-gray-400 mb-1">{label}</label>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={handleBlur}
        placeholder={placeholder}
        rows={3}
        className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent resize-y"
      />
      <p className="text-xs text-gray-600 mt-0.5">One per line</p>
    </div>
  );
}

export default function ConfigTab({ agent, isCreate, apps, onSave }) {
  const [form, setForm] = useState({
    name: '',
    description: '',
    persona: '',
    appId: '',
    schedule: { mode: 'continuous',  intervalMs: 3600000, pauseBetweenRunsMs: 60000 },
    goals: [],
    constraints: [],
    providerId: '',
    model: '',
    autonomyLevel: 'assistant',
    priority: 'MEDIUM'
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (agent && !isCreate) {
      setForm({
        name: agent.name || '',
        description: agent.description || '',
        persona: agent.persona || '',
        appId: agent.appId || '',
        schedule: agent.schedule || { mode: 'continuous',  intervalMs: 3600000, pauseBetweenRunsMs: 60000 },
        goals: agent.goals || [],
        constraints: agent.constraints || [],
        providerId: agent.providerId || '',
        model: agent.model || '',
        autonomyLevel: agent.autonomyLevel || 'assistant',
        priority: agent.priority || 'MEDIUM'
      });
    }
  }, [agent, isCreate]);

  const set = useCallback((path, value) => {
    setForm(prev => {
      const parts = path.split('.');
      if (parts.length === 1) return { ...prev, [path]: value };
      const [parent, child] = parts;
      return { ...prev, [parent]: { ...prev[parent], [child]: value } };
    });
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);

    const payload = {
      ...form,
      providerId: form.providerId || null,
      model: form.model || null
    };

    if (isCreate) {
      const created = await api.createFeatureAgent(payload).catch(() => null);
      setSaving(false);
      if (created) {
        toast.success('Feature agent created');
        onSave?.(created);
      }
    } else {
      const updated = await api.updateFeatureAgent(agent.id, payload).catch(() => null);
      setSaving(false);
      if (updated) {
        toast.success('Config saved');
        onSave?.(updated);
      }
    }
  };

  const inputCls = 'w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent';
  const selectCls = 'bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white focus:outline-hidden focus:border-port-accent';

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-3xl">
      {/* Basic Info */}
      <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Basic Info</h3>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Name</label>
          <input value={form.name} onChange={e => set('name', e.target.value)} className={inputCls} placeholder="Audio Generator Guardian" required />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Description</label>
          <textarea value={form.description} onChange={e => set('description', e.target.value)} className={`${inputCls} resize-y`} rows={2} placeholder="What this agent owns and iterates on" required />
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Persona (system prompt)</label>
          <textarea value={form.persona} onChange={e => set('persona', e.target.value)} className={`${inputCls} resize-y`} rows={4} placeholder="You are a meticulous developer who..." />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">App</label>
            <select value={form.appId} onChange={e => set('appId', e.target.value)} className={selectCls} required>
              <option value="">Select app...</option>
              {(apps || []).map(app => (
                <option key={app.id} value={app.id}>{app.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Priority</label>
            <select value={form.priority} onChange={e => set('priority', e.target.value)} className={selectCls}>
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
              <option value="CRITICAL">Critical</option>
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm text-gray-400 mb-1">Autonomy Level</label>
          <select value={form.autonomyLevel} onChange={e => set('autonomyLevel', e.target.value)} className={selectCls}>
            <option value="standby">Standby - Only when triggered</option>
            <option value="assistant">Assistant - Follows instructions closely</option>
            <option value="manager">Manager - Makes independent decisions</option>
            <option value="yolo">YOLO - Full autonomy</option>
          </select>
        </div>
      </div>

      {/* Schedule */}
      <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Schedule</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Mode</label>
            <select value={form.schedule.mode} onChange={e => set('schedule', { ...form.schedule, mode: e.target.value })} className={selectCls}>
              <option value="continuous">Continuous</option>
              <option value="interval">Interval</option>
            </select>
          </div>
          {form.schedule.mode === 'interval' && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Interval (minutes)</label>
              <input type="number" value={Math.round((form.schedule.intervalMs || 3600000) / 60000)} onChange={e => { const v = parseInt(e.target.value); if (!Number.isNaN(v) && v > 0) set('schedule', { ...form.schedule, intervalMs: v * 60000 }); }} className={inputCls} min={1} />
            </div>
          )}
          {form.schedule.mode === 'continuous' && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Pause Between Runs (seconds)</label>
              <input type="number" value={Math.round((form.schedule.pauseBetweenRunsMs || 60000) / 1000)} onChange={e => { const v = parseInt(e.target.value); if (!Number.isNaN(v) && v >= 0) set('schedule', { ...form.schedule, pauseBetweenRunsMs: v * 1000 }); }} className={inputCls} min={0} />
            </div>
          )}
        </div>
      </div>

      {/* Goals & Constraints */}
      <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Goals & Constraints</h3>
        <ArrayInput label="Goals (success criteria)" value={form.goals} onChange={v => setForm(prev => ({ ...prev, goals: v }))} placeholder="All audio tests pass&#10;Generate at least 3 sample formats" />
        <ArrayInput label="Constraints (things NOT to do)" value={form.constraints} onChange={v => setForm(prev => ({ ...prev, constraints: v }))} placeholder="Don't modify the API contract&#10;Don't add new dependencies without approval" />
      </div>

      {/* AI Provider Override */}
      <div className="bg-port-card border border-port-border rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">AI Provider (optional override)</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Provider ID</label>
            <input value={form.providerId || ''} onChange={e => set('providerId', e.target.value)} className={inputCls} placeholder="Leave empty for default" />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Model</label>
            <input value={form.model || ''} onChange={e => set('model', e.target.value)} className={inputCls} placeholder="Leave empty for default" />
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 transition-colors disabled:opacity-50"
        >
          <Save size={16} />
          {saving ? 'Saving...' : isCreate ? 'Create Agent' : 'Save Config'}
        </button>
      </div>
    </form>
  );
}
