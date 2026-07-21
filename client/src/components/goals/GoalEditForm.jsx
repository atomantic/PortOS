import {
  X, Target,
  Brain, HeartPulse, PenLine, Globe, Clapperboard, Users,
  BookOpen, Package, Share2, ListTree, BrainCircuit,
} from 'lucide-react';
import Pill from '../ui/Pill';
import { FormField } from '../ui/FormField';
import { CATEGORY_CONFIG, HORIZON_OPTIONS, GOAL_TYPE_OPTIONS, MAX_TAGS } from './goalConstants';
import { FEATURE_AREAS, FEATURE_AREA_IDS, GOAL_CATEGORY_FEATURE_MAP } from '../../lib/goalFeatureMap';

// Resolve a feature-area icon NAME (kept as a string in goalFeatureMap.js so
// that module stays React-free and server-mirrorable) to a lucide component.
// Mirrors the map in DailyDriverWidget — the two render the same area set.
const AREA_ICONS = {
  Brain, HeartPulse, PenLine, Globe, Clapperboard, Users,
  BookOpen, Package, Share2, ListTree, BrainCircuit, Target,
};

export default function GoalEditForm({
  form, setForm, tagInput, setTagInput, addTag, removeTag,
  toggleFeatureArea, parentOptions, saveEdit, onCancel
}) {
  const selectedAreas = form.featureAreas || [];
  // Gate the greyed category-default hint on whether any LOCALLY-KNOWN area is
  // selected — not on raw array length. A version-skewed goal can carry only
  // forward-unknown ids (from a newer peer); those render no visible button and
  // getGoalFeatureAreas filters them, so the Daily Driver still falls back to the
  // category default. Keying on length would hide the hint in that case and lie
  // about the actual behavior (issue #2679).
  const hasKnownSelection = selectedAreas.some(id => FEATURE_AREAS[id]);
  // Category default shown (greyed) when no known override is set, so the user
  // sees which areas the Daily Driver will deep-link to by default.
  const categoryDefaultLabels = (GOAL_CATEGORY_FEATURE_MAP[form.category] || [])
    .map(id => FEATURE_AREAS[id]?.label)
    .filter(Boolean);
  return (
    <div className="space-y-3">
      <input
        type="text"
        value={form.title}
        onChange={e => setForm({ ...form, title: e.target.value })}
        className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
      />
      <textarea
        value={form.description}
        onChange={e => setForm({ ...form, description: e.target.value })}
        rows={3}
        className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white resize-none"
      />
      <FormField label="Horizon" labelClassName="text-xs text-gray-500">
        <select
          value={form.horizon}
          onChange={e => setForm({ ...form, horizon: e.target.value })}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white mt-1"
        >
          {HORIZON_OPTIONS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}
        </select>
      </FormField>
      <FormField label="Category" labelClassName="text-xs text-gray-500">
        <select
          value={form.category}
          onChange={e => setForm({ ...form, category: e.target.value })}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white mt-1"
        >
          {Object.entries(CATEGORY_CONFIG).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
      </FormField>
      <FormField label="Goal Type" labelClassName="text-xs text-gray-500">
        <select
          value={form.goalType || 'standard'}
          onChange={e => setForm({ ...form, goalType: e.target.value })}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white mt-1"
        >
          {GOAL_TYPE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </FormField>
      <FormField label="Parent Goal" labelClassName="text-xs text-gray-500">
        <select
          value={form.parentId}
          onChange={e => setForm({ ...form, parentId: e.target.value })}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white mt-1"
        >
          <option value="">None (root)</option>
          {parentOptions.map(g => (
            <option key={g.id} value={g.id}>{g.title}</option>
          ))}
        </select>
      </FormField>
      <FormField label="Target Date" labelClassName="text-xs text-gray-500">
        <input
          type="date"
          value={form.targetDate || ''}
          onChange={e => setForm({ ...form, targetDate: e.target.value })}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white mt-1"
        />
      </FormField>
      <div>
        <label className="text-xs text-gray-500">Time Block Config</label>
        <div className="mt-1 space-y-2">
          <div>
            <span className="text-[10px] text-gray-600">Preferred days</span>
            <div className="flex flex-wrap gap-1 mt-0.5">
              {['mon','tue','wed','thu','fri','sat','sun'].map(d => {
                const days = form.timeBlockConfig?.preferredDays || [];
                const active = days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      const next = active ? days.filter(x => x !== d) : [...days, d];
                      setForm({ ...form, timeBlockConfig: { ...(form.timeBlockConfig || { timeSlot: 'morning', sessionDurationMinutes: 60 }), preferredDays: next } });
                    }}
                    className={`px-1.5 py-0.5 text-[10px] rounded ${active ? 'bg-port-accent text-white' : 'bg-port-bg border border-port-border text-gray-400'}`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <span className="text-[10px] text-gray-600">Time slot</span>
              <select
                value={form.timeBlockConfig?.timeSlot || 'morning'}
                onChange={e => setForm({ ...form, timeBlockConfig: { ...(form.timeBlockConfig || { preferredDays: ['mon','wed','fri'], sessionDurationMinutes: 60 }), timeSlot: e.target.value } })}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white mt-0.5"
              >
                <option value="morning">Morning</option>
                <option value="afternoon">Afternoon</option>
                <option value="evening">Evening</option>
              </select>
            </div>
            <div className="w-20">
              <span className="text-[10px] text-gray-600">Duration</span>
              <input
                type="number"
                min="15"
                max="480"
                value={form.timeBlockConfig?.sessionDurationMinutes || 60}
                onChange={e => setForm({ ...form, timeBlockConfig: { ...(form.timeBlockConfig || { preferredDays: ['mon','wed','fri'], timeSlot: 'morning' }), sessionDurationMinutes: parseInt(e.target.value, 10) || 60 } })}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white mt-0.5"
              />
              <span className="text-[10px] text-gray-600">min</span>
            </div>
          </div>
          {form.timeBlockConfig?.preferredDays?.length > 0 && (
            <button
              type="button"
              onClick={() => setForm({ ...form, timeBlockConfig: null })}
              className="text-[10px] text-red-400 hover:text-red-300"
            >
              Clear config
            </button>
          )}
        </div>
      </div>
      <div>
        <label className="text-xs text-gray-500">Tags</label>
        <div className="flex flex-wrap gap-1 mt-1 mb-2">
          {form.tags.map(tag => (
            <Pill key={tag} tone="bare" bordered={false} className="bg-port-accent/20 text-port-accent">
              {tag}
              <button onClick={() => removeTag(tag)} aria-label={`Remove tag ${tag}`} className="hover:text-white">
                <X className="w-3 h-3" />
              </button>
            </Pill>
          ))}
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addTag())}
            placeholder="Add tag..."
            className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
          />
          <button
            onClick={addTag}
            disabled={form.tags.length >= MAX_TAGS}
            className="px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
      <div>
        <label id="feature-areas-label" className="text-xs text-gray-500">Daily Driver Feature Areas</label>
        <p className="text-[10px] text-gray-600 mt-0.5">
          Pin which PortOS areas the Daily Driver deep-links to for this goal. Leave empty to use the category default.
        </p>
        <div role="group" aria-labelledby="feature-areas-label" className="flex flex-wrap gap-1 mt-1">
          {FEATURE_AREA_IDS.map(id => {
            const area = FEATURE_AREAS[id];
            const Icon = AREA_ICONS[area.icon] || Target;
            const active = selectedAreas.includes(id);
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                onClick={() => toggleFeatureArea(id)}
                className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded ${active ? 'bg-port-accent text-white' : 'bg-port-bg border border-port-border text-gray-400'}`}
              >
                <Icon className="w-3 h-3" />
                {area.label}
              </button>
            );
          })}
        </div>
        {!hasKnownSelection && (
          <p className="text-[10px] text-gray-600 mt-1">
            Default ({CATEGORY_CONFIG[form.category]?.label || form.category}):{' '}
            {categoryDefaultLabels.length > 0 ? categoryDefaultLabels.join(', ') : 'none for this category'}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <button onClick={saveEdit} className="px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80">
          Save
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 text-sm rounded bg-port-border text-gray-300">
          Cancel
        </button>
      </div>
    </div>
  );
}
