import { useState, useEffect } from 'react';
import { ArrowLeft, Save, Brain, Bell, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { updatePostConfig, getProviders, getPostAdaptivePreview, getPostMultiplicationProgress, getPostCognitiveProgress } from '../../../services/api';
import toast from '../../ui/Toast';
import { FormField } from '../../ui/FormField';
import { filterSelectableModels, enabledApiProviderFilter } from '../../../utils/providers';

// Human labels for the adaptive difficulty knob each math drill tunes.
const ADAPTIVE_FIELD_LABELS = {
  steps: 'steps', count: 'questions', maxDigits: 'max digits',
  maxExponent: 'max exponent', tolerancePct: 'tolerance %',
};

// Turn a server adaptive-preview result into a short, transparent status line
// so the effective difficulty is never a black box.
function describeAdaptive(info) {
  if (!info) return null;
  const field = ADAPTIVE_FIELD_LABELS[info.field] || info.field;
  const pct = info.score != null ? ` · ${info.score}% recent` : '';
  if (info.applied) {
    const harder = info.reason === 'harder';
    return { text: `Adaptive: ${field} ${info.from} → ${info.to} (${harder ? 'harder' : 'easier'})${pct}`, tone: harder ? 'up' : 'down' };
  }
  if (info.reason === 'insufficient-samples') {
    return { text: `Adaptive: warming up — needs more scored sessions`, tone: 'hold' };
  }
  // Use difficulty-relative wording ("hardest"/"easiest"), not "max"/"min": for
  // estimation the hardest value is the MINIMUM tolerance, so "at max" would read
  // backwards. `from` is the effective (clamped) value at the boundary.
  if (info.reason === 'at-hardest') return { text: `Adaptive: hardest ${field} ${info.from}${pct}`, tone: 'up' };
  if (info.reason === 'at-easiest') return { text: `Adaptive: easiest ${field} ${info.from}${pct}`, tone: 'down' };
  return { text: `Adaptive: holding ${field} ${info.from}${pct}`, tone: 'hold' };
}

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

const MATH_TYPES = Object.keys(DRILL_META);

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

const LLM_TYPES = Object.keys(LLM_DRILL_META);

// Seed state for every LLM drill type so a card's toggle reflects real,
// persistable state. Without this, a type absent from the saved config renders
// as enabled (via the `enabled !== false` convention) but never enters
// `llmDrillTypes`, so Save would omit it and the launcher — which only
// enumerates persisted keys — would never surface it in a session.
//
// A type PRESENT in the saved config keeps the launcher's enabled-by-presence
// convention: an entry with no `enabled` field is active (`enabled !== false`),
// so we must NOT let the opt-in default silently flip it off on the next save —
// we overlay the count/timeLimit defaults only to fill empty inputs and resolve
// `enabled` to the same boolean the launcher would compute. A type ABSENT from
// the saved config uses its `defaults.enabled` (the 9 newly-exposed drills are
// opt-in / disabled; the 5 legacy drills, always present via the server's
// DEFAULT_CONFIG, are enabled).
function seedLlmDrillTypes(saved) {
  const out = {};
  for (const [type, meta] of Object.entries(LLM_DRILL_META)) {
    const savedEntry = saved?.[type];
    out[type] = savedEntry
      ? { ...meta.defaults, ...savedEntry, enabled: savedEntry.enabled !== false }
      : { ...meta.defaults };
  }
  return out;
}

// Deterministic cognitive drills (no LLM). Field ranges mirror the server
// clamps in server/services/meatspacePostCognitive.js and the Zod bounds in
// server/lib/postValidation.js. `defaults` mirror the server DEFAULT_CONFIG so
// the launcher and generators agree.
//
// No Time Limit field here (unlike the math/LLM drill meta above) — cognitive
// drills are self-paced/stimulus-driven and never enforce a countdown (see
// PostCognitiveDrillRunner.jsx). A `timeLimitSec` knob was previously
// surfaced/validated for these drills without ever being consumed, which
// promised behavior that didn't happen (issue #2008).
const COGNITIVE_DRILL_META = {
  'n-back': {
    label: 'N-Back',
    desc: 'Signal when a letter matches the one N steps back — working memory',
    // `progressive: true` marks a laddered drill (ProgressiveBadge + toggle
    // render). `ladderFields` are the knobs the ladder actually drives per rung
    // (server/lib/postProgression.js COGNITIVE_LADDERS) — ONLY these are hidden
    // while progressive is on. Fields NOT in `ladderFields` (n-back `length`,
    // digit-span `showMs`) aren't ladder-managed, so they stay visible + editable
    // even under progressive and are honestly forwarded to the drill.
    progressive: true,
    ladderFields: ['n', 'stimulusMs'],
    fields: [
      { key: 'n', label: 'N (steps back)', type: 'number', min: 1, max: 3 },
      { key: 'length', label: 'Sequence Length', type: 'number', min: 6, max: 60 },
      { key: 'stimulusMs', label: 'Stimulus (ms)', type: 'number', min: 1000, max: 5000 },
    ],
    defaults: { enabled: true, progressive: true, n: 2, length: 20, stimulusMs: 2500 },
  },
  'digit-span': {
    label: 'Digit Span',
    desc: 'Recall a shown digit sequence forward or backward',
    progressive: true,
    ladderFields: ['direction', 'startLength', 'maxLength'],
    fields: [
      { key: 'direction', label: 'Direction', type: 'select', options: [
        { value: 'forward', label: 'Forward' },
        { value: 'backward', label: 'Backward' },
      ] },
      { key: 'startLength', label: 'Start Length', type: 'number', min: 3, max: 9 },
      { key: 'maxLength', label: 'Max Length', type: 'number', min: 3, max: 12 },
      { key: 'showMs', label: 'Show Time (ms)', type: 'number', min: 400, max: 4000 },
    ],
    defaults: { enabled: true, progressive: true, direction: 'forward', startLength: 3, maxLength: 8, showMs: 1000 },
  },
  'stroop': {
    label: 'Stroop',
    desc: 'Name the ink color of a color-word — attention & inhibition',
    progressive: true,
    ladderFields: ['count'],
    fields: [
      { key: 'count', label: 'Trials', type: 'number', min: 5, max: 40 },
    ],
    defaults: { enabled: true, progressive: true, count: 15 },
  },
  'schulte-table': {
    label: 'Schulte Table',
    desc: 'Scan a shuffled grid and tap 1, 2, 3... in order — visual attention & speed',
    progressive: true,
    ladderFields: ['size'],
    fields: [
      { key: 'size', label: 'Grid Size (NxN)', type: 'number', min: 3, max: 7 },
    ],
    defaults: { enabled: true, progressive: true, size: 5 },
  },
  'mental-rotation': {
    label: 'Mental Rotation',
    desc: 'Pick the shape that’s the same, just rotated — spatial reasoning',
    progressive: true,
    ladderFields: ['count'],
    fields: [
      { key: 'count', label: 'Trials', type: 'number', min: 4, max: 20 },
    ],
    defaults: { enabled: true, progressive: true, count: 8 },
  },
  'reaction-time': {
    label: 'Reaction Time',
    desc: 'React the instant a stimulus appears — processing speed baseline',
    fields: [
      { key: 'mode', label: 'Mode', type: 'select', options: [
        { value: 'simple', label: 'Simple' },
        { value: 'choice', label: 'Choice' },
      ] },
      { key: 'count', label: 'Trials', type: 'number', min: 5, max: 40 },
      { key: 'minDelayMs', label: 'Min Delay (ms)', type: 'number', min: 300, max: 5000 },
      { key: 'maxDelayMs', label: 'Max Delay (ms)', type: 'number', min: 300, max: 8000 },
      // Only meaningful in Choice mode (the generator ignores it for Simple),
      // but shown unconditionally — DrillCard has no per-field conditional
      // visibility and this mirrors how other fields already behave.
      { key: 'choices', label: 'Choices (Choice mode)', type: 'number', min: 2, max: 4 },
    ],
    defaults: { enabled: true, mode: 'simple', count: 15, minDelayMs: 1000, maxDelayMs: 3000, choices: 3 },
  },
};

const COGNITIVE_TYPES = Object.keys(COGNITIVE_DRILL_META);

// String-valued cognitive config keys must NOT be coerced to Number on edit.
const COGNITIVE_STRING_FIELDS = new Set(['direction', 'mode']);

// Seed every cognitive drill type so a card's toggle reflects real, persistable
// state — same enabled-by-presence convention as seedLlmDrillTypes.
function seedCognitiveDrillTypes(saved) {
  const out = {};
  for (const [type, meta] of Object.entries(COGNITIVE_DRILL_META)) {
    const savedEntry = saved?.[type];
    out[type] = savedEntry
      ? { ...meta.defaults, ...savedEntry, enabled: savedEntry.enabled !== false }
      : { ...meta.defaults };
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

// Batch-set `enabled` across a domain's drill-type map, preserving every other
// per-type field (count, timeLimitSec, etc). Used by both presets and the
// per-group "Enable all / Disable all" buttons.
function setEnabledMap(current, allTypes, enabledTypes) {
  const out = { ...current };
  for (const type of allTypes) {
    out[type] = { ...out[type], enabled: enabledTypes.has(type) };
  }
  return out;
}

// Config presets — batch-set the enabled flags across domains so a first
// session doesn't require clicking through ~25 individual cards. None of
// these presets touch LLM drills (the "Everything" preset is explicitly
// local-only) — enabling LLM drills in bulk is handled separately by the
// LLM group's "Enable all" button, which is gated on a provider being chosen.
const PRESETS = [
  {
    id: 'balanced',
    label: 'Balanced daily',
    apply: ({ setDrillTypes, setCognitiveDrillTypes, setCognitiveEnabled, setLlmEnabled }) => {
      setDrillTypes(prev => setEnabledMap(prev, MATH_TYPES, new Set(['multiplication', 'estimation'])));
      setCognitiveDrillTypes(prev => setEnabledMap(prev, COGNITIVE_TYPES, new Set(['n-back', 'stroop'])));
      setCognitiveEnabled(true);
      setLlmEnabled(false);
    },
  },
  {
    id: 'math-focus',
    label: 'Math focus',
    apply: ({ setDrillTypes, setCognitiveEnabled, setLlmEnabled }) => {
      setDrillTypes(prev => setEnabledMap(prev, MATH_TYPES, new Set(MATH_TYPES)));
      setCognitiveEnabled(false);
      setLlmEnabled(false);
    },
  },
  {
    id: 'cognitive-focus',
    label: 'Cognitive focus',
    apply: ({ setDrillTypes, setCognitiveDrillTypes, setCognitiveEnabled, setLlmEnabled }) => {
      setDrillTypes(prev => setEnabledMap(prev, MATH_TYPES, new Set()));
      setCognitiveDrillTypes(prev => setEnabledMap(prev, COGNITIVE_TYPES, new Set(COGNITIVE_TYPES)));
      setCognitiveEnabled(true);
      setLlmEnabled(false);
    },
  },
  {
    id: 'everything',
    label: 'Everything (local-only)',
    apply: ({ setDrillTypes, setCognitiveDrillTypes, setCognitiveEnabled, setLlmEnabled }) => {
      setDrillTypes(prev => setEnabledMap(prev, MATH_TYPES, new Set(MATH_TYPES)));
      setCognitiveDrillTypes(prev => setEnabledMap(prev, COGNITIVE_TYPES, new Set(COGNITIVE_TYPES)));
      setCognitiveEnabled(true);
      setLlmEnabled(false);
    },
  },
];

function AdaptiveBadge({ info }) {
  const status = describeAdaptive(info);
  if (!status) return null;
  const Icon = status.tone === 'up' ? TrendingUp : status.tone === 'down' ? TrendingDown : Minus;
  const color = status.tone === 'up' ? 'text-port-success' : status.tone === 'down' ? 'text-port-warning' : 'text-gray-500';
  return (
    <div className={`mt-3 flex items-center gap-1.5 text-xs ${color}`}>
      <Icon size={12} className="shrink-0" />
      <span>{status.text}</span>
    </div>
  );
}

// Compact ladder status for a progressive drill: current rung, mastery dots for
// every rung, and the accuracy (+ optional speed) gate that unlocks the next
// one. Shared by multiplication (speed-gated) and the cognitive ladders
// (accuracy-only); `managedLabel` names the manual knob(s) the ladder overrides.
function ProgressiveBadge({ info, speedGated = false, managedLabel = 'Manual knobs' }) {
  if (!info || !Array.isArray(info.levels)) return null;
  const pct = Math.round((info.thresholds?.targetAccuracy ?? 0.9) * 100);
  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs text-port-accent">
        <TrendingUp size={12} className="shrink-0" />
        <span>
          Level {info.level + 1} of {info.levels.length} · {info.label}
          {info.atHardest && info.currentMastered ? ' (mastered)' : ''}
        </span>
      </div>
      <div className="flex items-center gap-1" aria-hidden="true">
        {info.levels.map(l => (
          <span
            key={l.level}
            title={`${l.label}${l.mastered ? ' — mastered' : l.level === info.level ? ' — current' : ''}`}
            className={`h-1.5 flex-1 rounded-full ${
              l.mastered ? 'bg-port-success' : l.level === info.level ? 'bg-port-accent' : 'bg-port-border'
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-gray-500">
        Advances to the next rung after {speedGated ? `≥${pct}% accuracy and fast responses` : `sustained ≥${pct}% accuracy`} at this one. {managedLabel} {managedLabel.endsWith('s') ? 'are' : 'is'} ignored while progressive is on.
      </p>
    </div>
  );
}

// Per-group "Enable all / Disable all" — a lighter-weight bulk action than the
// top-level presets, scoped to one domain's own card grid.
function GroupBulkToggle({ groupLabel, onEnableAll, onDisableAll }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        type="button"
        onClick={onEnableAll}
        className="text-port-accent hover:underline"
        aria-label={`Enable all ${groupLabel}`}
      >
        Enable all
      </button>
      <span className="text-gray-600">/</span>
      <button
        type="button"
        onClick={onDisableAll}
        className="text-gray-400 hover:underline"
        aria-label={`Disable all ${groupLabel}`}
      >
        Disable all
      </button>
    </div>
  );
}

function DrillCard({ meta, drillConfig, enabled, accent, onToggle, onUpdateField, adaptiveInfo, progressive, onToggleProgressive, progressInfo, managedFieldKeys = [], speedGated = false, managedLabel = 'Manual knobs' }) {
  const supportsProgressive = typeof progressive === 'boolean';
  // Fields the ladder drives (hidden while progressive is on; shown in manual
  // mode). Multiplication hides only Max Digits; a cognitive drill hides every
  // difficulty knob (incl. the newly-exposed stimulusMs/showMs).
  const managed = new Set(managedFieldKeys);
  const hideManaged = supportsProgressive && progressive;
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

      {enabled && supportsProgressive && (
        <div className="flex items-center justify-between mb-3 py-2 px-3 bg-port-bg/50 rounded">
          <div>
            <span className="text-sm text-white">Progressive difficulty</span>
            <p className="text-xs text-gray-500">Ramp up from 1×1-digit as you master speed.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={progressive}
            aria-label={`Progressive difficulty — ${meta.label}`}
            onClick={onToggleProgressive}
            className={`shrink-0 w-10 h-5 rounded-full transition-colors relative ${
              progressive ? toggleBg : 'bg-port-border'
            }`}
          >
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              progressive ? 'translate-x-5' : 'translate-x-0.5'
            }`} />
          </button>
        </div>
      )}

      {enabled && (
        <div className="grid grid-cols-2 gap-3">
          {meta.fields.filter(field => !(hideManaged && managed.has(field.key))).map(field => (
            <FormField key={field.key} label={field.label} labelClassName="text-xs text-gray-500 mb-1 block">
              {field.type === 'select' ? (
                <select
                  value={drillConfig[field.key] ?? field.options?.[0]?.value ?? ''}
                  onChange={e => onUpdateField(field.key, e.target.value)}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
                >
                  {(field.options || []).map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  value={drillConfig[field.key] ?? ''}
                  onChange={e => onUpdateField(field.key, e.target.value)}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
                />
              )}
            </FormField>
          ))}
        </div>
      )}

      {enabled && supportsProgressive && progressive && <ProgressiveBadge info={progressInfo} speedGated={speedGated} managedLabel={managedLabel} />}
      {enabled && !(supportsProgressive && progressive) && <AdaptiveBadge info={adaptiveInfo} />}
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
  const [cognitiveDrillTypes, setCognitiveDrillTypes] = useState(
    () => seedCognitiveDrillTypes(config?.cognitive?.drillTypes)
  );
  const [cognitiveEnabled, setCognitiveEnabled] = useState(
    () => config?.cognitive?.enabled !== false
  );
  const [adaptiveEnabled, setAdaptiveEnabled] = useState(
    () => config?.adaptive?.enabled === true
  );
  const [adaptivePreview, setAdaptivePreview] = useState(null);
  const [multiplicationProgress, setMultiplicationProgress] = useState(null);
  const [cognitiveProgress, setCognitiveProgress] = useState(null);
  // Opt-in daily reminder — off by default; see server/services/meatspacePostReminder.js.
  const [reminderEnabled, setReminderEnabled] = useState(
    () => config?.reminder?.enabled === true
  );
  const [reminderTime, setReminderTime] = useState(
    () => config?.reminder?.time || '09:00'
  );
  const [providers, setProviders] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getProviders().then(p => setProviders((p?.providers || []).filter(enabledApiProviderFilter))).catch(err => console.warn('⚠️ Failed to load providers: ' + err.message));
  }, []);

  // Load the effective-difficulty preview when Adaptive is on, so each math card
  // can show what a session would actually use. Reflects saved config + recent
  // performance from the server (not the unsaved form values), so it may lag an
  // edit until Save — the badge is a transparency aid, not a live simulator.
  useEffect(() => {
    if (!adaptiveEnabled) { setAdaptivePreview(null); return; }
    let cancelled = false;
    getPostAdaptivePreview()
      .then(p => { if (!cancelled) setAdaptivePreview(p?.drills || null); })
      .catch(err => console.warn('⚠️ Failed to load adaptive preview: ' + err.message));
    return () => { cancelled = true; };
  }, [adaptiveEnabled]);

  // Progressive multiplication ladder status — mirrors the drill runner's badge
  // so the config page shows the current rung + mastery before a session.
  // Progressive defaults ON (undefined → true), matching the server default.
  const multiplicationProgressive = drillTypes.multiplication?.progressive !== false;
  useEffect(() => {
    if (!multiplicationProgressive) { setMultiplicationProgress(null); return; }
    let cancelled = false;
    getPostMultiplicationProgress()
      .then(p => { if (!cancelled) setMultiplicationProgress(p); })
      .catch(err => console.warn('⚠️ Failed to load multiplication progress: ' + err.message));
    return () => { cancelled = true; };
  }, [multiplicationProgressive]);

  // Progressive cognitive-ladder status (per drill type), same pattern as the
  // multiplication badge. Fetched whenever the cognitive section is on and any
  // cognitive drill is progressive — the badge is a transparency aid, so the
  // saved server state (not the unsaved form) drives it.
  const anyCognitiveProgressive = cognitiveEnabled && COGNITIVE_TYPES.some(
    type => COGNITIVE_DRILL_META[type].progressive && cognitiveDrillTypes[type]?.progressive !== false
  );
  useEffect(() => {
    if (!anyCognitiveProgressive) { setCognitiveProgress(null); return; }
    let cancelled = false;
    getPostCognitiveProgress()
      .then(p => { if (!cancelled) setCognitiveProgress(p); })
      .catch(err => console.warn('⚠️ Failed to load cognitive progress: ' + err.message));
    return () => { cancelled = true; };
  }, [anyCognitiveProgressive]);

  function toggleDrill(type) {
    setDrillTypes(prev => ({
      ...prev,
      [type]: { ...prev[type], enabled: !(prev[type]?.enabled !== false) }
    }));
  }

  function toggleProgressive() {
    setDrillTypes(prev => ({
      ...prev,
      multiplication: { ...prev.multiplication, progressive: !(prev.multiplication?.progressive !== false) }
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

  function toggleCognitiveDrill(type) {
    setCognitiveDrillTypes(prev => ({
      ...prev,
      [type]: { ...prev[type], enabled: !(prev[type]?.enabled !== false) }
    }));
  }

  function toggleCognitiveProgressive(type) {
    setCognitiveDrillTypes(prev => ({
      ...prev,
      [type]: { ...prev[type], progressive: !(prev[type]?.progressive !== false) }
    }));
  }

  function updateCognitiveField(type, key, value) {
    let coerced;
    if (COGNITIVE_STRING_FIELDS.has(key)) {
      coerced = value || undefined;
    } else {
      coerced = value === '' || value === null || value === undefined ? undefined : Number(value);
    }
    setCognitiveDrillTypes(prev => ({
      ...prev,
      [type]: { ...prev[type], [key]: coerced }
    }));
  }

  function applyPreset(id) {
    const preset = PRESETS.find(p => p.id === id);
    if (!preset) return;
    preset.apply({ setDrillTypes, setCognitiveDrillTypes, setCognitiveEnabled, setLlmEnabled });
    toast.success(`Preset "${preset.label}" applied — click Save to persist`);
  }

  function setAllMathEnabled(enabled) {
    setDrillTypes(prev => setEnabledMap(prev, MATH_TYPES, enabled ? new Set(MATH_TYPES) : new Set()));
  }

  function setAllCognitiveEnabled(enabled) {
    setCognitiveDrillTypes(prev => setEnabledMap(prev, COGNITIVE_TYPES, enabled ? new Set(COGNITIVE_TYPES) : new Set()));
    // Bulk-enabling drills in a domain whose section toggle is off (e.g.
    // right after the "Math focus" preset) must also turn the domain on —
    // otherwise the flags flip invisibly and Save persists
    // cognitive.enabled=false, so the launcher still ignores every drill the
    // user just enabled. Disabling all leaves the domain toggle alone (an
    // empty-but-on section is a valid state).
    if (enabled) setCognitiveEnabled(true);
  }

  // Never bulk-enable LLM drills without a chosen provider — respects the
  // AI-provider consent posture (no silent expansion into a provider the
  // user hasn't picked; issue #2101 explicitly requires a non-empty provider
  // selection here, so the "System Default" sentinel does not satisfy the
  // gate). Disabling never calls a provider, so it's unguarded.
  function setAllLlmEnabled(enabled) {
    if (enabled && !llmProviderId) {
      // Reveal the section (without enabling any drills) so the AI Provider
      // picker the toast points at is actually on screen — it renders inside
      // the {llmEnabled && …} block and every preset turns llmEnabled off.
      setLlmEnabled(true);
      toast.error('Pick an AI provider above before enabling all LLM drills');
      return;
    }
    setLlmDrillTypes(prev => setEnabledMap(prev, LLM_TYPES, enabled ? new Set(LLM_TYPES) : new Set()));
    // Same domain-on rule as cognitive: enabling all LLM drills while the
    // LLM section toggle is off would otherwise persist
    // llmDrills.enabled=false and the launcher would never run them.
    if (enabled) setLlmEnabled(true);
  }

  const selectedProvider = providers.find(p => p.id === llmProviderId);
  const availableModels = filterSelectableModels(selectedProvider?.models);

  async function handleSave() {
    setSaving(true);
    const updated = await updatePostConfig({
      mentalMath: { drillTypes },
      adaptive: { enabled: adaptiveEnabled },
      reminder: { enabled: reminderEnabled, time: reminderTime },
      cognitive: {
        enabled: cognitiveEnabled,
        drillTypes: cognitiveDrillTypes
      },
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

      {/* Presets — batch-set flags across domains; a subsequent Save persists them */}
      <div className="flex flex-wrap items-center gap-2 p-3 bg-port-card border border-port-border rounded-lg">
        <span className="text-xs text-gray-500 uppercase tracking-wider mr-1">Presets</span>
        {PRESETS.map(preset => (
          <button
            key={preset.id}
            type="button"
            onClick={() => applyPreset(preset.id)}
            className="px-3 py-1.5 text-xs font-medium text-white bg-port-bg border border-port-border rounded-full hover:border-port-accent transition-colors"
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Daily Reminder Section — opt-in, off by default; no LLM calls */}
      <div className="p-4 bg-port-card border border-port-border rounded-lg space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bell size={16} className="text-port-accent" />
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Daily Reminder</h3>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={reminderEnabled}
            aria-label="Daily reminder"
            onClick={() => setReminderEnabled(v => !v)}
            className={`shrink-0 w-10 h-5 rounded-full transition-colors relative ${
              reminderEnabled ? 'bg-port-accent' : 'bg-port-border'
            }`}
          >
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              reminderEnabled ? 'translate-x-5' : 'translate-x-0.5'
            }`} />
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Off by default. When enabled, you'll get an in-app nudge at the chosen time if today's POST is still incomplete — nothing fires once you've done a session, and no AI calls are involved.
        </p>
        {reminderEnabled && (
          <div>
            <label htmlFor="postReminderTime" className="block text-xs text-gray-400 mb-1">
              Remind me at
            </label>
            <input
              id="postReminderTime"
              type="time"
              value={reminderTime}
              onChange={e => setReminderTime(e.target.value)}
              className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
            />
          </div>
        )}
      </div>

      {/* Mental Math Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Mental Math</h3>
            <GroupBulkToggle
              groupLabel="Mental Math drills"
              onEnableAll={() => setAllMathEnabled(true)}
              onDisableAll={() => setAllMathEnabled(false)}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">Adaptive difficulty</span>
            <button
              type="button"
              role="switch"
              aria-checked={adaptiveEnabled}
              aria-label="Adaptive difficulty"
              onClick={() => setAdaptiveEnabled(v => !v)}
              className={`shrink-0 w-10 h-5 rounded-full transition-colors relative ${
                adaptiveEnabled ? 'bg-port-accent' : 'bg-port-border'
              }`}
            >
              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                adaptiveEnabled ? 'translate-x-5' : 'translate-x-0.5'
              }`} />
            </button>
          </div>
        </div>
        {adaptiveEnabled && (
          <p className="text-xs text-gray-500">
            Math drills auto-adjust from your recent scores — high accuracy raises difficulty, repeated misses ease it, within safe bounds. Manual values below are the starting point.
          </p>
        )}
        <div className={CARD_GRID}>
          {Object.entries(DRILL_META).map(([type, meta]) => {
            const drillConfig = drillTypes[type] || {};
            const isMultiplication = type === 'multiplication';
            return (
              <DrillCard
                key={type}
                meta={meta}
                drillConfig={drillConfig}
                enabled={drillConfig.enabled !== false}
                accent="accent"
                onToggle={() => toggleDrill(type)}
                onUpdateField={(key, value) => updateField(type, key, value)}
                adaptiveInfo={adaptiveEnabled ? adaptivePreview?.[type] : null}
                progressive={isMultiplication ? multiplicationProgressive : undefined}
                onToggleProgressive={isMultiplication ? toggleProgressive : undefined}
                progressInfo={isMultiplication ? multiplicationProgress : null}
                managedFieldKeys={isMultiplication ? ['maxDigits'] : []}
                speedGated={isMultiplication}
                managedLabel="Max Digits"
              />
            );
          })}
        </div>
      </div>

      {/* Cognitive Drills Section (deterministic — no provider) */}
      <div className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Brain size={16} className="text-rose-400" />
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Cognitive (deterministic)</h3>
          </div>
          <GroupBulkToggle
            groupLabel="Cognitive drills"
            onEnableAll={() => setAllCognitiveEnabled(true)}
            onDisableAll={() => setAllCognitiveEnabled(false)}
          />
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={cognitiveEnabled}
          aria-label="Cognitive drills"
          onClick={() => setCognitiveEnabled(!cognitiveEnabled)}
          className={`shrink-0 w-10 h-5 rounded-full transition-colors relative ${
            cognitiveEnabled ? 'bg-rose-400' : 'bg-port-border'
          }`}
        >
          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            cognitiveEnabled ? 'translate-x-5' : 'translate-x-0.5'
          }`} />
        </button>
      </div>

      {cognitiveEnabled && (
        <div className={CARD_GRID}>
          {Object.entries(COGNITIVE_DRILL_META).map(([type, meta]) => {
            const drillConfig = cognitiveDrillTypes[type] || {};
            // Laddered cognitive drills expose a Progressive toggle + rung badge
            // (reaction-time has no ladder). When on, every difficulty knob is
            // ladder-managed and hidden (issue #2095).
            const supportsProgressive = meta.progressive === true;
            const progressive = supportsProgressive ? drillConfig.progressive !== false : undefined;
            return (
              <DrillCard
                key={type}
                meta={meta}
                drillConfig={drillConfig}
                enabled={drillConfig.enabled !== false}
                accent="accent"
                onToggle={() => toggleCognitiveDrill(type)}
                onUpdateField={(key, value) => updateCognitiveField(type, key, value)}
                progressive={progressive}
                onToggleProgressive={supportsProgressive ? () => toggleCognitiveProgressive(type) : undefined}
                progressInfo={supportsProgressive ? cognitiveProgress?.[type] : null}
                managedFieldKeys={supportsProgressive ? (meta.ladderFields || []) : []}
                speedGated={false}
                managedLabel="The difficulty knobs"
              />
            );
          })}
        </div>
      )}

      {/* LLM Drills Section */}
      <div className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Brain size={16} className="text-port-accent-2" />
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Wit &amp; Memory (LLM)</h3>
          </div>
          <GroupBulkToggle
            groupLabel="LLM drills"
            onEnableAll={() => setAllLlmEnabled(true)}
            onDisableAll={() => setAllLlmEnabled(false)}
          />
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
              <FormField label="Provider" labelClassName="text-xs text-gray-500 mb-1 block">
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
              </FormField>
              <FormField label="Model" labelClassName="text-xs text-gray-500 mb-1 block">
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
              </FormField>
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
