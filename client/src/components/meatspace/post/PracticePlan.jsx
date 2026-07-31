import { useState, useEffect } from 'react';
import { ArrowLeft, Save, ChevronRight, ChevronDown, ListChecks, Loader } from 'lucide-react';
import { updatePostConfig, getMemoryItems } from '../../../services/api';
import toast from '../../ui/Toast';
import {
  POST_TOPICS,
  TOPIC_UI,
  DRILL_LABELS,
  MODULE_CONFIG_KEY,
  MODULE_LABELS,
  isTopicEnabled,
  isMemoryItemEnabled,
  composedSessionDrillTypes,
} from './constants';

// The one place the user answers "what am I actually studying?" (issue #3252).
// Practice Plan owns the WHAT (which topics, drill types, and memorized texts
// participate); Drill Config still owns the HOW HARD (per-drill knobs).

// Group order for the topic rows: every coarse module (named by the shared
// MODULE_LABELS so Config and Practice Plan can't disagree), then the null-module
// bucket for topics that never post a scored POST task (Morse).
const MODULE_GROUPS = [
  ...['mental-math', 'llm-drills', 'cognitive', 'memory'].map(module => ({ module, label: MODULE_LABELS[module] })),
  { module: null, label: 'Other Practice' },
];

const drillLabel = (type) => DRILL_LABELS[type] || type;

// A single on/off row. Kept local (rather than reaching for a shared control)
// so the parent/child indentation and the disabled-parent cascade read in one
// place. `id` pairs the label with its input per the client label convention.
function ToggleRow({ id, label, hint, checked, disabled, onChange, indent = false }) {
  // The hint sits OUTSIDE the <label> and is wired with aria-describedby: inside
  // it, it would become part of the control's accessible name ("Morse Practiced
  // from its own tab") instead of supplementary description.
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={`flex items-start justify-between gap-3 py-1.5 ${indent ? 'pl-7' : ''}`}>
      <div className="min-w-0">
        <label htmlFor={id} className={`text-sm ${disabled ? 'text-gray-600' : 'text-gray-300'} cursor-pointer`}>
          {label}
        </label>
        {hint && <p id={hintId} className="text-xs text-gray-500">{hint}</p>}
      </div>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 shrink-0 accent-port-accent disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
      />
    </div>
  );
}

export default function PracticePlan({ config, onSaved, onBack }) {
  // Draft state seeded once from the loaded config — mirrors PostDrillConfig,
  // which is why PostTab only mounts this after the config resolves.
  const [topics, setTopics] = useState(() => {
    const seeded = { ...(config?.topics || {}) };
    // Memory and Morse each have a module-level `enabled` flag AND a topic entry
    // on the server, and this surface exposes ONE control that writes both. Seed
    // the topic entry from the module flag when THAT is the one switched off, or
    // a config carrying `morse: { enabled: false }` with no `topics.morse` would
    // render as ON and the next Save — even one that only touched Wordplay —
    // would silently switch Morse back on.
    for (const id of ['memory', 'morse']) {
      if (config?.[id]?.enabled === false) seeded[id] = { ...seeded[id], enabled: false };
    }
    return seeded;
  });
  // Seeded with an entry for EVERY drill type the module owns, because the
  // config schema's enum-keyed drill-type records are exhaustive (zod 4) — a
  // partial map would 400 on save. A type absent from the saved config is
  // seeded `enabled: false`, which is exactly how the launcher already treats
  // it (it enumerates persisted keys only), so seeding changes nothing about
  // which drills actually run.
  const [modules, setModules] = useState(() => Object.fromEntries(
    Object.entries(MODULE_CONFIG_KEY).map(([module, key]) => {
      const saved = config?.[key]?.drillTypes || {};
      const owned = POST_TOPICS.filter(t => t.module === module).flatMap(t => t.drillTypes);
      return [key, {
        enabled: config?.[key]?.enabled !== false,
        drillTypes: Object.fromEntries(owned.map(type => [type, saved[type] || { enabled: false }])),
      }];
    })
  ));
  const [memoryItemFlags, setMemoryItemFlags] = useState(() => ({ ...(config?.memory?.items || {}) }));
  const [memoryItems, setMemoryItems] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Silent: the plan still renders (and saves) without the item list; only the
    // per-item rows are missing, and an error toast here would be noise.
    getMemoryItems({ silent: true }).then(setMemoryItems).catch(() => setMemoryItems([]));
  }, []);

  // Memory and Morse each have a module-level `enabled` flag on the server AND a
  // topic entry. The user gets ONE control — the topic toggle — and save writes
  // both, so the server's two gates can never disagree.
  const memoryOn = isTopicEnabled({ topics }, 'memory');
  const morseOn = isTopicEnabled({ topics }, 'morse');

  // The draft config the preview reads, so the "will include" summary reflects
  // unsaved edits — the whole point of the surface is seeing the effect BEFORE
  // running a session.
  const draftConfig = {
    ...config,
    ...Object.fromEntries(Object.entries(modules).map(([key, v]) => [key, { ...config?.[key], ...v }])),
    topics,
    morse: { enabled: morseOn },
    memory: { ...config?.memory, ...modules.memory, enabled: memoryOn, items: memoryItemFlags },
  };

  // Until the item list resolves, fail closed for Memory just like the launcher.
  // This also keeps incompatible/unsupported memory drills out of the summary.
  const preview = composedSessionDrillTypes(draftConfig, memoryItems || []);
  const previewTopicIds = Object.keys(preview);

  // Standalone topics still shape the daily rotation (they drive "Up next"
  // recommendations) even though they never compose into a session.
  const standaloneOn = POST_TOPICS
    .filter(t => t.surface === 'standalone' && isTopicEnabled(draftConfig, t.id));

  const enabledMemoryItems = (memoryItems || [])
    .filter(item => isMemoryItemEnabled(draftConfig, item.id));

  function setTopicEnabled(topicId, enabled) {
    setTopics(prev => ({ ...prev, [topicId]: { ...prev[topicId], enabled } }));
  }

  function setDrillEnabled(module, type, enabled) {
    const key = MODULE_CONFIG_KEY[module];
    if (!key) return;
    setModules(prev => ({
      ...prev,
      [key]: { ...prev[key], drillTypes: { ...prev[key].drillTypes, [type]: { ...prev[key].drillTypes[type], enabled } } },
    }));
  }

  function setMemoryItemEnabled(itemId, enabled) {
    setMemoryItemFlags(prev => ({ ...prev, [itemId]: { ...prev[itemId], enabled } }));
  }

  async function handleSave() {
    setSaving(true);
    // Only the slices this surface owns are sent — Drill Config's knobs live in
    // the same `drillTypes` objects and are carried through untouched because
    // the draft was seeded from the saved config and the server deep-merges.
    const updated = await updatePostConfig({
      topics,
      mentalMath: { drillTypes: modules.mentalMath.drillTypes },
      llmDrills: { drillTypes: modules.llmDrills.drillTypes },
      cognitive: { drillTypes: modules.cognitive.drillTypes },
      memory: { enabled: memoryOn, drillTypes: modules.memory.drillTypes, items: memoryItemFlags },
      morse: { enabled: morseOn },
    }, { silent: true }).catch(() => null);
    setSaving(false);
    if (!updated) {
      toast.error('Could not save your practice plan');
      return;
    }
    toast.success('Practice plan saved');
    onSaved?.(updated);
  }

  function renderTopic(topic) {
    const on = isTopicEnabled({ topics }, topic.id);
    const isOpen = !!expanded[topic.id];
    const ui = TOPIC_UI[topic.id] || {};
    const configKey = MODULE_CONFIG_KEY[topic.module];
    const isMemory = topic.id === 'memory';
    const isMorse = topic.id === 'morse';
    // Morse's trainer owns its own settings, so the topic toggle is the whole
    // control — there are no per-drill-type rows to expand into.
    const hasChildren = !isMorse;

    return (
      <div key={topic.id} className="p-3 bg-port-card border border-port-border rounded-lg">
        <div className="flex items-center gap-2">
          {hasChildren ? (
            <button
              type="button"
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${topic.label}`}
              aria-expanded={isOpen}
              onClick={() => setExpanded(prev => ({ ...prev, [topic.id]: !prev[topic.id] }))}
              className="text-gray-500 hover:text-white transition-colors"
            >
              {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          ) : (
            <span className="w-4" />
          )}
          <div className="flex-1">
            <ToggleRow
              id={`topic-${topic.id}`}
              label={<span className={`font-medium ${on ? ui.color || 'text-white' : 'text-gray-500'}`}>{topic.label}</span>}
              hint={topic.surface === 'standalone' ? 'Practiced from its own tab' : null}
              checked={on}
              onChange={(v) => setTopicEnabled(topic.id, v)}
            />
          </div>
        </div>

        {isOpen && (
          <div className="mt-1 border-t border-port-border/60 pt-2">
            {isMorse ? null : topic.drillTypes.map(type => (
              <ToggleRow
                key={type}
                indent
                id={`drill-${type}`}
                label={drillLabel(type)}
                checked={on && (modules[configKey]?.drillTypes?.[type]?.enabled !== false)}
                // A disabled parent disables everything under it — shown as
                // greyed-out rather than hidden, so the state stays legible.
                disabled={!on}
                onChange={(v) => setDrillEnabled(topic.module, type, v)}
              />
            ))}

            {isMemory && (
              <div className="mt-2 border-t border-port-border/60 pt-2">
                <p className="pl-7 text-xs uppercase tracking-wider text-gray-500 mb-1">Memorized texts</p>
                {memoryItems === null && (
                  <p className="pl-7 text-xs text-gray-500 flex items-center gap-1.5">
                    <Loader size={12} className="animate-spin" /> Loading your items…
                  </p>
                )}
                {memoryItems?.length === 0 && (
                  <p className="pl-7 text-xs text-gray-500">No memory items yet — add one from the Memory tab.</p>
                )}
                {(memoryItems || []).map(item => (
                  <ToggleRow
                    key={item.id}
                    indent
                    id={`memory-item-${item.id}`}
                    label={item.title || item.id}
                    hint="Switching off keeps its history and its own practice page"
                    checked={on && (memoryItemFlags[item.id]?.enabled !== false)}
                    disabled={!on}
                    onChange={(v) => setMemoryItemEnabled(item.id, v)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button aria-label="Back" onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ArrowLeft size={20} />
          </button>
          <div>
            <h2 className="text-xl font-bold text-white">Practice Plan</h2>
            <p className="text-xs text-gray-500">What you're studying. Difficulty knobs live in Config.</p>
          </div>
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

      {/* Live summary — reflects UNSAVED edits so the effect of a toggle is
          visible before running a session. */}
      <div data-testid="plan-summary" className="p-4 bg-port-card border border-port-border rounded-lg">
        <div className="flex items-center gap-2 mb-2">
          <ListChecks size={16} className="text-port-accent" />
          <h3 className="text-sm font-semibold text-white">Your daily POST will include</h3>
        </div>
        {previewTopicIds.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing right now — every session topic is switched off, or excluded by Session Composition in Config.
          </p>
        ) : (
          <ul className="space-y-1">
            {previewTopicIds.map(id => (
              <li key={id} className="text-sm">
                <span className={`font-medium ${TOPIC_UI[id]?.color || 'text-white'}`}>
                  {POST_TOPICS.find(t => t.id === id)?.label}
                </span>
                <span className="text-gray-400"> — {preview[id].map(drillLabel).join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
        {standaloneOn.length > 0 && (
          <p className="mt-3 pt-3 border-t border-port-border/60 text-xs text-gray-400">
            Also in your rotation (practiced from their own tabs):{' '}
            <span className="text-gray-300">{standaloneOn.map(t => t.label).join(', ')}</span>
          </p>
        )}
        {memoryOn && memoryItems?.length > 0 && (
          <p className="mt-2 text-xs text-gray-500">
            Memory rotation: {enabledMemoryItems.length} of {memoryItems.length} memorized text{memoryItems.length === 1 ? '' : 's'}
          </p>
        )}
      </div>

      {MODULE_GROUPS.map(group => {
        const groupTopics = POST_TOPICS.filter(t => t.module === group.module);
        if (!groupTopics.length) return null;
        return (
          <div key={group.label} className="space-y-2">
            <h3 className="text-xs uppercase tracking-wider text-gray-500">{group.label}</h3>
            {groupTopics.map(renderTopic)}
          </div>
        );
      })}
    </div>
  );
}
