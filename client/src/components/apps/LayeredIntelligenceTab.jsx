import { Plus, Trash2, Brain } from 'lucide-react';
import Banner from '../ui/Banner';
import ProviderModelSelector from '../ProviderModelSelector';
import { filterSelectableModels } from '../../utils/providers';
import { timeAgo } from '../../utils/formatters';
import { formatLiReason, liReasonTone } from '../../utils/layeredIntelligenceReasons';

// The self-improvement loop's per-app config surface. Field set mirrors the
// server schema (server/lib/validation.js `layeredIntelligenceConfigSchema`)
// and the effective-config accessor (server/services/layeredIntelligence.js).
// Off by default — the loop is a user-enabled scheduled automation.

// The Layer-1 telemetry toggles the loop can gather. Keep in sync with the
// server `sources` object (custom[] file sources are handled separately below).
export const LI_SOURCE_FIELDS = [
  { key: 'goals', label: 'Goals (GOALS.md)', hint: 'The app\'s inferred/authored product goals' },
  { key: 'cosMetrics', label: 'CoS metrics', hint: 'Recent autonomous-agent run stats for this app' },
  { key: 'healthReport', label: 'Health report', hint: 'Latest health / lint / test summary' },
  { key: 'planMd', label: 'PLAN.md', hint: 'The app\'s open work-plan items' },
  { key: 'openIssues', label: 'Open issues', hint: 'Currently open tracker issues' },
  { key: 'outcomes', label: 'Proposal outcomes', hint: 'Past LI proposals + how they fared (merge rate), fed back so the loop calibrates on its own results' }
];

// The proposal scopes the loop may file. loop-meta / portos-self extend the loop
// itself (which lives in the PortOS repo), so they only apply to the PortOS
// baseline app — mirrors PORTOS_ONLY_SCOPES on the server.
export const LI_SCOPES = [
  { id: 'app-improvement', label: 'App improvement', portosOnly: false, hint: 'Propose feature/quality improvements to this app' },
  { id: 'app-data-gap', label: 'App data gap', portosOnly: false, hint: 'Propose new telemetry/data the loop should gather' },
  { id: 'loop-meta', label: 'Loop meta', portosOnly: true, hint: 'Improve the intelligence loop itself (PortOS only)' },
  { id: 'portos-self', label: 'PortOS self', portosOnly: true, hint: 'Improve PortOS itself (PortOS only)' }
];

const INPUT_CLASS = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden';

// Common cadences for the interval select. Values are milliseconds; the schema
// floor is 60_000 (1 minute). A stored non-preset value renders as "Custom".
export const LI_INTERVAL_PRESETS = [
  { ms: 60 * 60 * 1000, label: 'Hourly' },
  { ms: 6 * 60 * 60 * 1000, label: 'Every 6 hours' },
  { ms: 12 * 60 * 60 * 1000, label: 'Every 12 hours' },
  { ms: 24 * 60 * 60 * 1000, label: 'Daily' },
  { ms: 7 * 24 * 60 * 60 * 1000, label: 'Weekly' }
];

// Compact prose for a stored last-run outcome, keyed by the handler's action +
// reason (persisted on the effective config as lastRunAction / lastRunReason).
// The loop files a tracker issue and spawns no visible agent, so this durable
// line — not the transient toast — is how a user (esp. on mobile) learns WHY a
// run produced nothing. The reason→prose gloss + tone come from the shared
// layeredIntelligenceReasons module so a filed run reads as success (with its
// ref) while every non-filed reason renders identically here and in the toast.
// Returns { tone, text, when } or null when it's never run.
export function describeLastRun(li) {
  if (!li?.lastRunAt) return null;
  const when = timeAgo(li.lastRunAt);
  const action = li.lastRunAction || null;
  const reason = li.lastRunReason || null;

  if (action === 'filed') {
    return { tone: 'success', text: `filed an improvement issue${li.lastRunRef ? ` (${li.lastRunRef})` : ''}`, when };
  }
  // Legacy record: installs that ran the loop before this change persisted only
  // `lastRunAt` (no action/reason). Do not fabricate an outcome — say the run
  // happened but its detail predates the richer bookkeeping, until a new run
  // records action + reason.
  if (!action) {
    return { tone: 'neutral', text: 'ran (outcome not recorded before this version)', when };
  }
  return { tone: liReasonTone(reason), text: formatLiReason({ action, reason }), when };
}

const LAST_RUN_TONE_CLASS = {
  success: 'text-port-success',
  error: 'text-port-error',
  warn: 'text-port-warning',
  neutral: 'text-gray-400'
};

// Deep-equal two allowedScopes arrays regardless of order.
function sameScopes(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every(s => sb.has(s));
}

// The per-row primary value field, keyed by source type. Mirrors the server's
// discriminated union (server/lib/validation.js `layeredIntelligenceConfigSchema`).
export const LI_CUSTOM_TYPES = [
  { type: 'file', valueKey: 'ref', label: 'File', placeholder: 'repo-relative path, e.g. docs/metrics.md' },
  { type: 'http', valueKey: 'url', label: 'URL', placeholder: 'https://example.com/status.json' },
  { type: 'cmd', valueKey: 'cmd', label: 'Command', placeholder: 'git log --oneline -20' }
];

const CUSTOM_TYPE_BY_KEY = Object.fromEntries(LI_CUSTOM_TYPES.map(t => [t.type, t]));

// The value field name for a source type ('ref' | 'url' | 'cmd'), defaulting to
// the file `ref` for an unknown/legacy type.
function customValueKey(type) {
  return (CUSTOM_TYPE_BY_KEY[type] || CUSTOM_TYPE_BY_KEY.file).valueKey;
}

// Sanitize a custom-source list to what actually gets persisted: a `type`, its
// trimmed, non-blank primary value, and an optional trimmed label. Used both to
// compare against the baseline and to build the emitted value, so a half-typed/
// blank row that sanitizes away doesn't register as a change (over-persist).
function sanitizeCustom(list) {
  return (Array.isArray(list) ? list : [])
    .map(s => {
      const type = CUSTOM_TYPE_BY_KEY[s?.type] ? s.type : 'file';
      const valueKey = customValueKey(type);
      const value = String(s?.[valueKey] || '').trim();
      const label = String(s?.label || '').trim();
      const out = { type, [valueKey]: value };
      if (label) out.label = label;
      return out;
    })
    .filter(s => s[customValueKey(s.type)]);
}

function sameCustom(a, b) {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const vk = customValueKey(s.type);
    return s.type === b[i].type && s[vk] === b[i][vk] && (s.label || '') === (b[i].label || '');
  });
}

/**
 * Build the minimal Layered Intelligence BEHAVIOR PATCH: only the top-level
 * behavior keys (rules / sources / allowedScopes / handoff) whose value differs
 * from the effective baseline the drawer loaded. Sending the full effective config
 * would persist every default to disk and freeze this install against future
 * default changes — the server's merge-over-stored contract
 * (updateAppLayeredIntelligence) depends on untouched fields staying absent.
 * Returns null when nothing changed (caller then omits `layeredIntelligence`).
 *
 * SCHEDULING fields (enabled / intervalMs / providerId / model) are NOT included
 * here — they live in the per-app task override now (#2322) and are diffed by
 * `buildLayeredIntelligenceScheduleUpdate` below.
 */
export function buildLayeredIntelligenceUpdate(baseline, current) {
  if (!baseline || !current) return null;
  const update = {};
  if ((current.rules || '') !== (baseline.rules || '')) update.rules = current.rules || '';

  const curSources = current.sources || {};
  const baseSources = baseline.sources || {};
  const curCustom = sanitizeCustom(curSources.custom);
  const toggleChanged = LI_SOURCE_FIELDS.some(f => !!curSources[f.key] !== !!baseSources[f.key]);
  const customChanged = !sameCustom(curCustom, sanitizeCustom(baseSources.custom));
  if (toggleChanged || customChanged) {
    update.sources = {
      ...Object.fromEntries(LI_SOURCE_FIELDS.map(f => [f.key, !!curSources[f.key]])),
      custom: curCustom
    };
  }

  if (!sameScopes(current.allowedScopes, baseline.allowedScopes)) {
    update.allowedScopes = Array.isArray(current.allowedScopes) ? current.allowedScopes : [];
  }

  if (!!current.handoff?.enabled !== !!baseline.handoff?.enabled) {
    update.handoff = { enabled: !!current.handoff?.enabled };
  }

  return Object.keys(update).length > 0 ? update : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Map a chosen intervalMs to the per-app override's { interval, intervalMs } pair
// the scheduler understands: 'daily'/'weekly' for the standard cadences, else
// 'custom' (the scheduler's CUSTOM branch reads the numeric intervalMs). Mirrors
// the server migration's intervalFieldsFromMs.
export function intervalFieldsFromMs(intervalMs) {
  const ms = typeof intervalMs === 'number' && intervalMs > 0 ? intervalMs : DAY_MS;
  if (ms === DAY_MS) return { interval: 'daily', intervalMs: ms };
  if (ms === WEEK_MS) return { interval: 'weekly', intervalMs: ms };
  return { interval: 'custom', intervalMs: ms };
}

/**
 * Build the minimal per-app SCHEDULING override PATCH for the layered-intelligence
 * task type (enabled / interval+intervalMs / providerId / model) — only the fields
 * the user changed vs the baseline. Returns null when nothing changed (caller then
 * skips the task-override PUT). providerId/model normalize '' → null (the "use
 * default" sentinel). When the interval changes, both `interval` and `intervalMs`
 * are sent so the scheduler resolves the cadence correctly.
 */
export function buildLayeredIntelligenceScheduleUpdate(baseline, current) {
  if (!baseline || !current) return null;
  const update = {};
  if (!!current.enabled !== !!baseline.enabled) update.enabled = !!current.enabled;
  if (current.intervalMs !== baseline.intervalMs) {
    const { interval, intervalMs } = intervalFieldsFromMs(current.intervalMs);
    update.interval = interval;
    update.intervalMs = intervalMs;
  }
  const curProvider = current.providerId || null;
  if (curProvider !== (baseline.providerId || null)) update.providerId = curProvider;
  const curModel = current.model || null;
  if (curModel !== (baseline.model || null)) update.model = curModel;
  return Object.keys(update).length > 0 ? update : null;
}

/**
 * Presentational Layered Intelligence config tab. All mutable state lives in the
 * parent EditAppDrawer's `formData` (the Drawer body remounts per tab), so this
 * component is fully controlled: it reads the `li` slice and calls `onChange`
 * with a partial update. `sources` updates merge one level deep here so a single
 * toggle doesn't wipe the others.
 */
export default function LayeredIntelligenceTab({ li, onChange, providers, isPortos, loaded, error = false, onRetry }) {
  if (!loaded) {
    return <div className="text-sm text-gray-500">Loading Layered Intelligence config…</div>;
  }
  if (error || !li || Object.keys(li).length === 0) {
    return (
      <div className="space-y-3">
        <Banner tone="error" size="md">Couldn&apos;t load the Layered Intelligence config for this app.</Banner>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="text-xs px-3 py-1.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  const sources = li.sources || {};
  const custom = Array.isArray(sources.custom) ? sources.custom : [];
  const allowedScopes = Array.isArray(li.allowedScopes) ? li.allowedScopes : [];
  const isPreset = LI_INTERVAL_PRESETS.some(p => p.ms === li.intervalMs);

  const setSources = (patch) => onChange({ sources: { ...sources, ...patch } });
  const setCustom = (next) => setSources({ custom: next });

  const currentProvider = providers.find(p => p.id === li.providerId);
  const availableModels = currentProvider
    ? filterSelectableModels(currentProvider.models || [currentProvider.defaultModel])
    : [];

  const toggleScope = (id, on) => {
    const next = on ? [...new Set([...allowedScopes, id])] : allowedScopes.filter(s => s !== id);
    onChange({ allowedScopes: next });
  };

  const visibleScopes = LI_SCOPES.filter(s => !s.portosOnly || isPortos);
  const lastRun = describeLastRun(li);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <Brain size={16} className="text-port-accent mt-0.5 shrink-0" />
        <p className="text-xs text-gray-500">
          The Layered Intelligence Loop perpetually reviews this app&apos;s telemetry and files improvement proposals via CoS. Off by default — it runs on the schedule below only when enabled. It files a tracker issue rather than spawning a visible agent, so a run that produces nothing reports why here.
        </p>
      </div>

      {lastRun && (
        <div className="text-xs bg-port-bg border border-port-border rounded-lg px-3 py-2">
          <span className="text-gray-500">Last run {lastRun.when}: </span>
          <span className={LAST_RUN_TONE_CLASS[lastRun.tone] || 'text-gray-400'}>{lastRun.text}.</span>
        </div>
      )}

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={!!li.enabled}
          onChange={e => onChange({ enabled: e.target.checked })}
          className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
        />
        <span className="text-sm text-white">Enable the self-improvement loop for this app</span>
      </label>

      <div>
        <label htmlFor="li-interval" className="block text-sm text-gray-400 mb-1">Run interval</label>
        <select
          id="li-interval"
          value={isPreset ? String(li.intervalMs) : 'custom'}
          onChange={e => {
            if (e.target.value === 'custom') return;
            onChange({ intervalMs: Number(e.target.value) });
          }}
          className={INPUT_CLASS}
        >
          {LI_INTERVAL_PRESETS.map(p => (
            <option key={p.ms} value={String(p.ms)}>{p.label}</option>
          ))}
          {!isPreset && <option value="custom">Custom ({Math.round(li.intervalMs / 60000)} min)</option>}
        </select>
      </div>

      <div>
        <span className="block text-sm text-gray-400 mb-1">AI provider</span>
        <ProviderModelSelector
          providers={providers}
          selectedProviderId={li.providerId || ''}
          selectedModel={li.model || ''}
          availableModels={availableModels}
          onProviderChange={id => onChange({ providerId: id || null, model: '' })}
          onModelChange={model => onChange({ model: model || null })}
          label="Provider"
          emptyProviderOption="Use default provider"
          emptyModelOption="Default model"
          alwaysShowModel
        />
        <p className="text-xs text-gray-500 mt-1">Leave on &quot;Use default provider&quot; to run the loop with the active CoS provider.</p>
      </div>

      <div>
        <span className="block text-sm text-gray-400 mb-2">Telemetry sources</span>
        <div className="space-y-2">
          {LI_SOURCE_FIELDS.map(f => (
            <label key={f.key} className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!sources[f.key]}
                onChange={e => setSources({ [f.key]: e.target.checked })}
                className="mt-1 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
              />
              <span className="text-sm text-white">{f.label}<span className="block text-xs text-gray-500">{f.hint}</span></span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-400">Custom sources</span>
          <button
            type="button"
            onClick={() => setCustom([...custom, { type: 'file', ref: '' }])}
            className="flex items-center gap-1 text-xs px-2 py-1 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded"
          >
            <Plus size={12} /> Add source
          </button>
        </div>
        {custom.length === 0 ? (
          <p className="text-xs text-gray-500">No custom sources. Add a repo-relative file (e.g. <code className="text-gray-400">docs/metrics.md</code>), an <code className="text-gray-400">http</code> URL, or a shell command to feed its output into the loop&apos;s prompt.</p>
        ) : (
          <div className="space-y-3">
            {custom.map((src, i) => {
              const type = CUSTOM_TYPE_BY_KEY[src.type] ? src.type : 'file';
              const meta = CUSTOM_TYPE_BY_KEY[type];
              const valueKey = meta.valueKey;
              const setRow = (patch) => setCustom(custom.map((s, j) => j === i ? { ...s, ...patch } : s));
              return (
                <div key={i} className="flex items-start gap-2">
                  <div className="flex-1 space-y-1.5">
                    <div className="flex gap-2">
                      <select
                        value={type}
                        onChange={e => {
                          // Switch type: keep only the label; the old value field no longer applies.
                          const next = e.target.value;
                          setCustom(custom.map((s, j) => j === i
                            ? { type: next, [CUSTOM_TYPE_BY_KEY[next].valueKey]: '', ...(s.label ? { label: s.label } : {}) }
                            : s));
                        }}
                        className={`${INPUT_CLASS} w-28 shrink-0`}
                        aria-label={`Custom source ${i + 1} type`}
                      >
                        {LI_CUSTOM_TYPES.map(t => <option key={t.type} value={t.type}>{t.label}</option>)}
                      </select>
                      <input
                        type="text"
                        value={src[valueKey] || ''}
                        onChange={e => setRow({ [valueKey]: e.target.value })}
                        className={INPUT_CLASS}
                        placeholder={meta.placeholder}
                        aria-label={`Custom source ${i + 1} ${meta.label.toLowerCase()}`}
                      />
                    </div>
                    <input
                      type="text"
                      value={src.label || ''}
                      onChange={e => setRow({ label: e.target.value })}
                      className={`${INPUT_CLASS} text-xs`}
                      placeholder="Optional label"
                      maxLength={120}
                      aria-label={`Custom source ${i + 1} label`}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setCustom(custom.filter((_, j) => j !== i))}
                    className="p-2 text-gray-500 hover:text-port-error shrink-0"
                    aria-label={`Remove custom source ${i + 1}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
            <p className="text-xs text-gray-500">File paths must be repo-relative — no leading <code>/</code> and no <code>..</code> segments. URLs must be http(s). Commands run in the app&apos;s repo directory.</p>
          </div>
        )}
      </div>

      <div>
        <label htmlFor="li-rules" className="block text-sm text-gray-400 mb-1">Guidance rules</label>
        <textarea
          id="li-rules"
          value={li.rules || ''}
          onChange={e => onChange({ rules: e.target.value })}
          className={`${INPUT_CLASS} font-mono text-sm`}
          rows={4}
          placeholder="Free-text guidance for the loop (e.g. 'Prioritize accessibility fixes; never propose new dependencies.')"
          maxLength={8000}
        />
      </div>

      <div>
        <span className="block text-sm text-gray-400 mb-2">Allowed proposal scopes</span>
        <div className="space-y-2">
          {visibleScopes.map(s => (
            <label key={s.id} className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowedScopes.includes(s.id)}
                onChange={e => toggleScope(s.id, e.target.checked)}
                className="mt-1 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
              />
              <span className="text-sm text-white">{s.label}<span className="block text-xs text-gray-500">{s.hint}</span></span>
            </label>
          ))}
        </div>
        {!isPortos && (
          <Banner tone="info" size="sm" className="mt-2">
            Loop-meta and PortOS-self scopes are only available on the PortOS baseline app.
          </Banner>
        )}
      </div>

      <div>
        <span className="block text-sm text-gray-400 mb-2">Auto hand-off</span>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!li.handoff?.enabled}
            onChange={e => onChange({ handoff: { ...(li.handoff || {}), enabled: e.target.checked } })}
            className="mt-1 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
          />
          <span className="text-sm text-white">
            Hand trivial, safe fixes to a coding agent
            <span className="block text-xs text-gray-500">
              When the loop marks a proposal both trivial and safe, also queue an approval-gated CoS coding-agent task to implement it — instead of only filing the issue for later.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}
