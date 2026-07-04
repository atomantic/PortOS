import { useState, useEffect, useCallback } from 'react';
import { TrendingUp, Grid3x3, RefreshCw } from 'lucide-react';
import { getMorseProgress } from '../../../services/api';

// Windows offered by the days selector. `0` = all-time (the route treats
// days<=0 as "no cutoff").
const WINDOWS = [
  { id: 7, label: '7d' },
  { id: 30, label: '30d' },
  { id: 90, label: '90d' },
  { id: 0, label: 'All' },
];

const MODE_LABELS = { copy: 'Copy', 'head-copy': 'Head Copy', send: 'Send' };

// Accuracy → color band (mirrors the CopyDrill results coloring: ≥90 success,
// ≥70 warning, else error).
function accuracyColor(pct) {
  if (pct >= 90) return 'text-port-success';
  if (pct >= 70) return 'text-port-warning';
  return 'text-port-error';
}

function accuracyBarColor(pct) {
  if (pct >= 90) return 'bg-port-success';
  if (pct >= 70) return 'bg-port-warning';
  return 'bg-port-error';
}

// Tiny inline SVG sparkline for a numeric series (accuracy 0–100). No chart lib —
// a handful of points rendered as a polyline. Returns null for <2 points.
function Sparkline({ values, max = 100, className = 'stroke-port-accent' }) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const w = 120;
  const h = 28;
  const step = w / (values.length - 1);
  const points = values
    .map((v, i) => {
      const y = h - (Math.max(0, Math.min(v, max)) / max) * h;
      return `${(i * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} className="overflow-visible" role="img" aria-label="trend">
      <polyline points={points} fill="none" strokeWidth="1.5" className={className} />
    </svg>
  );
}

function ModeTrend({ mode, points }) {
  if (!points || points.length === 0) return null;
  const accuracies = points.map((p) => p.accuracy);
  const wpms = points.map((p) => p.effectiveWpm).filter((v) => typeof v === 'number');
  const latestAcc = accuracies[accuracies.length - 1];
  const latestWpm = wpms.length > 0 ? wpms[wpms.length - 1] : null;
  const avgAcc = Math.round(accuracies.reduce((a, b) => a + b, 0) / accuracies.length);

  return (
    <div className="bg-port-bg border border-port-border rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-300">{MODE_LABELS[mode] || mode}</span>
        <span className="text-[10px] text-gray-500">{points.length} round{points.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className={`text-lg font-mono font-bold ${accuracyColor(latestAcc)}`}>{latestAcc}%</div>
          <div className="text-[10px] text-gray-500">latest · {avgAcc}% avg</div>
          {latestWpm != null && (
            <div className="text-[10px] text-gray-500 mt-0.5">{latestWpm} wpm</div>
          )}
        </div>
        <Sparkline values={accuracies} />
      </div>
    </div>
  );
}

function ConfusionList({ pairs }) {
  if (!pairs || pairs.length === 0) {
    return <p className="text-[11px] text-gray-600">No mismatches in this window — clean copy.</p>;
  }
  const top = pairs.slice(0, 12);
  const maxCount = top[0]?.count || 1;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
      {top.map((p) => {
        const intensity = Math.max(0.2, p.count / maxCount);
        return (
          <div
            key={`${p.sent}->${p.guessed}`}
            className="flex items-center justify-between gap-2 px-2 py-1.5 rounded border border-port-error/40 bg-port-error/5"
            style={{ opacity: 0.55 + intensity * 0.45 }}
            title={`Sent ${p.sent}, keyed ${p.guessed === '∅' ? 'nothing' : p.guessed} — ${p.count}×`}
          >
            <span className="font-mono text-sm">
              <span className="text-white">{p.sent}</span>
              <span className="text-gray-600">→</span>
              <span className="text-port-error">{p.guessed === '∅' ? '—' : p.guessed}</span>
            </span>
            <span className="text-[10px] font-mono text-gray-400">{p.count}×</span>
          </div>
        );
      })}
    </div>
  );
}

function CharMastery({ chars }) {
  if (!chars || chars.length === 0) return null;
  // Worst-first (already sorted server-side); show the weakest handful as the
  // "drill these next" list.
  const worst = chars.slice(0, 10);
  return (
    <div className="space-y-1.5">
      {worst.map((c) => (
        <div key={c.char} className="flex items-center gap-2">
          <span className="font-mono text-sm text-white w-5 text-center">{c.char}</span>
          <div className="flex-1 h-2 bg-port-bg rounded-full overflow-hidden">
            <div
              className={`h-full ${accuracyBarColor(c.accuracy)}`}
              style={{ width: `${c.accuracy}%` }}
            />
          </div>
          <span className={`text-[11px] font-mono w-9 text-right ${accuracyColor(c.accuracy)}`}>{c.accuracy}%</span>
          <span className="text-[10px] text-gray-600 w-8 text-right">{c.attempts}×</span>
        </div>
      ))}
    </div>
  );
}

// Progress dashboard for the Morse trainer: accuracy/WPM trends per mode, a
// per-character confusion heatmap (worst pairs), and per-character mastery bars
// (worst-first — "which character to drill next"). Reads server-persisted
// rounds; `refreshKey` bumps trigger a refetch after a new round is submitted.
export default function MorseProgressPanel({ refreshKey = 0 }) {
  const [days, setDays] = useState(30);
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback((d) => {
    setLoading(true);
    getMorseProgress(d, { silent: true })
      .then((p) => setProgress(p || null))
      .catch(() => setProgress(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(days); }, [days, refreshKey, load]);

  const hasData = progress && progress.totalRounds > 0;
  const modesWithData = progress
    ? Object.entries(progress.series || {}).filter(([, pts]) => pts && pts.length > 0)
    : [];

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <TrendingUp size={16} className="text-port-accent" />
          <h3 className="text-sm font-semibold text-white">Morse Progress</h3>
        </div>
        <div className="flex items-center gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              onClick={() => setDays(w.id)}
              className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
                days === w.id ? 'bg-port-accent text-white' : 'text-gray-400 hover:text-white bg-port-bg border border-port-border'
              }`}
            >
              {w.label}
            </button>
          ))}
          <button
            onClick={() => load(days)}
            className="p-1 text-gray-500 hover:text-port-accent transition-colors"
            aria-label="Refresh progress"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {!hasData ? (
        <p className="text-xs text-gray-500">
          {loading ? 'Loading your Morse history…' : 'Complete a round to see accuracy trends, WPM, and your per-character confusion matrix. Your Koch level now syncs across devices.'}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {modesWithData.map(([mode, pts]) => (
              <ModeTrend key={mode} mode={mode} points={pts} />
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-1">
            <div>
              <div className="flex items-center gap-1.5 mb-2 text-[11px] uppercase tracking-wide text-gray-500">
                <Grid3x3 size={12} /> Most-confused pairs
              </div>
              <ConfusionList pairs={progress.confusionPairs} />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-2">
                Drill these next (weakest first)
              </div>
              <CharMastery chars={progress.charAccuracy} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
