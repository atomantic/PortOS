import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Target, TrendingUp, TrendingDown, Minus, Sparkles, SlidersHorizontal, Users } from 'lucide-react';
import {
  getGoalScorecard,
  computeGoalScorecard,
  refreshGoalScorecardNarrative,
  getGoalScorecardRules,
  saveGoalScorecardRules,
  getGoalScorecardSettings,
  updateGoalScorecardSettings,
  getProviders,
} from '../../services/api';
import { timeAgo } from '../../utils/formatters';

const fmtHours = (h) => `${Number(h ?? 0).toFixed(1)}h`;

function TrendIcon({ direction }) {
  if (direction === 'up') return <TrendingUp size={16} className="text-port-success" />;
  if (direction === 'down') return <TrendingDown size={16} className="text-port-error" />;
  return <Minus size={16} className="text-gray-500" />;
}

// A tiny aligned-share sparkline over the trend weeks.
function TrendSparkline({ trend }) {
  const weeks = Array.isArray(trend) ? trend : [];
  if (weeks.length === 0) return null;
  return (
    <div className="flex items-end gap-1 h-12" aria-hidden="true">
      {weeks.map((w) => {
        const pct = Math.round((w.alignedShare ?? 0) * 100);
        return (
          <div key={w.weekStart} className="flex flex-col items-center gap-1 flex-1">
            <div
              className="w-full bg-port-accent/70 rounded-t"
              style={{ height: `${Math.max(4, pct)}%` }}
              title={`${w.weekStart}: ${pct}% aligned`}
            />
          </div>
        );
      })}
    </div>
  );
}

function RulesEditor({ onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState({});

  useEffect(() => {
    getGoalScorecardRules().then((res) => {
      setData(res);
      const initial = {};
      for (const [id, ov] of Object.entries(res?.overrides ?? {})) {
        initial[id] = (ov.keywords ?? []).join(', ');
      }
      setDrafts(initial);
    }).finally(() => setLoading(false));
  }, []);

  const handleSave = () => {
    setSaving(true);
    const overrides = { ...(data?.overrides ?? {}) };
    for (const [id, csv] of Object.entries(drafts)) {
      const keywords = csv.split(',').map((k) => k.trim()).filter(Boolean);
      overrides[id] = { ...(overrides[id] ?? {}), keywords };
    }
    saveGoalScorecardRules(overrides)
      .then((res) => { setData(res); onClose?.(); })
      .finally(() => setSaving(false));
  };

  if (loading) return <div className="text-sm text-gray-500 p-4">Loading mapping rules…</div>;

  const rules = data?.rules ?? [];
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Goal → activity mapping</h3>
        <button onClick={onClose} className="text-xs text-gray-500 hover:text-white">Close</button>
      </div>
      <p className="text-xs text-gray-500">
        Activities map to a goal when a keyword appears in the event, a linked person participates, or a linked calendar matches.
        Add extra keywords (comma-separated) to catch more of a goal's activity.
      </p>
      <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
        {rules.length === 0 && <p className="text-xs text-gray-500">No active goals found.</p>}
        {rules.map((rule) => (
          <div key={rule.id} className="border-b border-port-border/60 pb-2 last:border-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm text-white">{rule.title}</span>
              {rule.category && <span className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded">{rule.category}</span>}
            </div>
            <div className="text-[11px] text-gray-500 mb-1">
              Auto keywords: {rule.keywords.length ? rule.keywords.join(', ') : '(none)'}
            </div>
            <input
              type="text"
              value={drafts[rule.id] ?? ''}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [rule.id]: e.target.value }))}
              placeholder="extra keywords, comma-separated"
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-gray-200 focus:border-port-accent/60 focus:outline-none"
            />
          </div>
        ))}
      </div>
      <button
        onClick={handleSave}
        disabled={saving}
        className="px-3 py-1.5 bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
      >
        {saving ? 'Saving…' : 'Save keywords'}
      </button>
    </div>
  );
}

export default function GoalScorecardTab() {
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [showRules, setShowRules] = useState(false);

  const load = useCallback(() => {
    Promise.allSettled([getGoalScorecard(), getGoalScorecardSettings(), getProviders({ silent: true })])
      .then(([sc, st, pr]) => {
        setData(sc.status === 'fulfilled' ? sc.value : null);
        setSettings(st.status === 'fulfilled' ? st.value : null);
        const p = pr.status === 'fulfilled' ? pr.value : null;
        setProviders(p?.providers || (Array.isArray(p) ? p : []));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Persist a scorecard settings change (enable toggle / provider pick) — the
  // narrative opt-in. Optimistic local update, reverts on failure.
  const saveSettings = (partial) => {
    setSavingSettings(true);
    setSettings((prev) => ({ ...prev, ...partial }));
    updateGoalScorecardSettings(partial)
      .then((res) => setSettings(res))
      .catch(() => load())
      .finally(() => setSavingSettings(false));
  };

  const handleCompute = () => {
    setComputing(true);
    computeGoalScorecard()
      .then((res) => setData(res))
      .finally(() => setComputing(false));
  };

  const handleNarrative = () => {
    setGenerating(true);
    refreshGoalScorecardNarrative()
      .then((res) => { if (res?.available) setData(res); })
      .finally(() => setGenerating(false));
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-5 bg-gray-800 rounded w-1/3 mb-4" />
        <div className="h-24 bg-gray-800 rounded w-full" />
        <div className="h-4 bg-gray-700 rounded w-full" />
        <div className="h-4 bg-gray-700 rounded w-5/6" />
      </div>
    );
  }

  if (!data?.available) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Target size={28} className="text-gray-600 mb-3" />
        <p className="text-gray-400 text-sm max-w-sm mb-2">No goal scorecard computed yet.</p>
        <p className="text-gray-500 text-xs max-w-sm mb-6">
          Compute a weekly scorecard correlating where your tracked time actually went — conversations, meetings, media —
          against your stated goals. Deterministic and fully local; no AI required.
        </p>
        <button
          onClick={handleCompute}
          disabled={computing}
          className="flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={16} className={computing ? 'animate-spin' : ''} />
          {computing ? 'Computing…' : 'Compute this week'}
        </button>
      </div>
    );
  }

  const { totals, goals = [], trend = [], trendDirection } = data;
  const alignedPct = Math.round((totals?.alignedShare ?? 0) * 100);
  // Enabling is the opt-in; a specific provider is optional (server falls back
  // to the active provider), matching the cross-domain narrative.
  const narrativeEnabled = Boolean(settings?.enabled);
  const topGoalHours = goals.find((g) => g.alignedSeconds > 0)?.alignedHours ?? 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="text-sm text-white font-semibold">Week of {data.weekStart}</span>
          {data.generatedAt && <span className="text-xs text-gray-500">computed {timeAgo(data.generatedAt)}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowRules((v) => !v)}
            className="flex items-center gap-2 px-3 py-1.5 bg-port-card border border-port-border rounded-lg text-sm text-gray-400 hover:text-white hover:border-port-accent/50 transition-colors"
          >
            <SlidersHorizontal size={14} />
            Mapping
          </button>
          <button
            onClick={handleCompute}
            disabled={computing}
            className="flex items-center gap-2 px-3 py-1.5 bg-port-card border border-port-border rounded-lg text-sm text-gray-400 hover:text-white hover:border-port-accent/50 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={14} className={computing ? 'animate-spin' : ''} />
            {computing ? 'Computing…' : 'Recompute'}
          </button>
        </div>
      </div>

      {showRules && <RulesEditor onClose={() => setShowRules(false)} />}

      {/* Totals cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">Goal-aligned time</div>
          <div className="text-2xl font-bold text-port-success">{fmtHours(totals?.alignedHours)}</div>
          <div className="text-xs text-gray-600 mt-1">{alignedPct}% of tracked time</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">Unaligned time</div>
          <div className="text-2xl font-bold text-port-warning">{fmtHours(totals?.unalignedHours)}</div>
          <div className="text-xs text-gray-600 mt-1">{totals?.eventCount ?? 0} events tracked</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500">Trend vs prior weeks</span>
            <TrendIcon direction={trendDirection} />
          </div>
          <TrendSparkline trend={trend} />
        </div>
      </div>

      {/* Aligned vs unaligned bar */}
      {totals?.totalSeconds > 0 && (
        <div className="w-full h-2 rounded-full overflow-hidden bg-port-warning/40 flex">
          <div className="h-full bg-port-success" style={{ width: `${alignedPct}%` }} title={`${alignedPct}% aligned`} />
        </div>
      )}

      {/* Per-goal breakdown */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-white mb-3">Time by goal</h3>
        {goals.filter((g) => g.alignedSeconds > 0).length === 0 ? (
          <p className="text-xs text-gray-500">No tracked activity mapped to a goal this week. Add keywords under “Mapping” to catch more.</p>
        ) : (
          <div className="space-y-3">
            {goals.filter((g) => g.alignedSeconds > 0).map((g) => (
              <div key={g.id}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-gray-200 truncate">{g.title}</span>
                    {g.category && <span className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded shrink-0">{g.category}</span>}
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-xs">
                    {g.contactCount > 0 && (
                      <span className="flex items-center gap-1 text-gray-500" title={`${g.contactCount} distinct contacts`}>
                        <Users size={12} />{g.contactCount}
                      </span>
                    )}
                    <span className="text-gray-300 tabular-nums">{fmtHours(g.alignedHours)}</span>
                  </div>
                </div>
                <div className="w-full h-1.5 rounded-full bg-port-bg overflow-hidden">
                  <div
                    className="h-full bg-port-accent"
                    style={{ width: `${topGoalHours > 0 ? Math.round((g.alignedHours / topGoalHours) * 100) : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Optional LLM narrative */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2"><Sparkles size={14} className="text-port-accent" /> Narrative</h3>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer" htmlFor="scorecard-narrative-enabled">
              <input
                id="scorecard-narrative-enabled"
                type="checkbox"
                checked={narrativeEnabled}
                disabled={savingSettings}
                onChange={(e) => saveSettings({ enabled: e.target.checked })}
                className="accent-port-accent"
              />
              AI narrative
            </label>
            {narrativeEnabled && (
              <select
                aria-label="Narrative provider"
                value={settings?.provider || ''}
                disabled={savingSettings}
                onChange={(e) => saveSettings({ provider: e.target.value || null })}
                className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-gray-200 focus:border-port-accent/60 focus:outline-none"
              >
                <option value="">Active provider</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name || p.id}</option>
                ))}
              </select>
            )}
            <button
              onClick={handleNarrative}
              disabled={generating || !narrativeEnabled || totals?.totalSeconds === 0}
              title={narrativeEnabled ? '' : 'Enable AI narrative to generate a summary'}
              className="flex items-center gap-2 px-3 py-1.5 bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={14} className={generating ? 'animate-spin' : ''} />
              {generating ? 'Generating…' : data.narrative ? 'Regenerate' : 'Generate'}
            </button>
          </div>
        </div>
        {data.narrative ? (
          <div className="prose prose-sm prose-invert max-w-none">
            {data.narrative.split('\n').filter(Boolean).map((p, i) => (
              <p key={i} className="text-gray-300 leading-relaxed mb-2 last:mb-0">{p}</p>
            ))}
            {data.narrativeGeneratedAt && (
              <p className="text-[11px] text-gray-600 mt-2">Generated {timeAgo(data.narrativeGeneratedAt)}{data.narrativeModel ? ` · ${data.narrativeModel}` : ''}</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            {narrativeEnabled
              ? 'Generate an optional plain-language summary of this week’s goal alignment. The numeric scorecard above is always AI-free.'
              : 'Optional AI narrative is off. Toggle “AI narrative” above to summarize the week in plain language. The numeric scorecard is always AI-free.'}
          </p>
        )}
      </div>
    </div>
  );
}
