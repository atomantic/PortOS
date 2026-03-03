import { useState } from 'react';
import { Zap, History, Settings, Play } from 'lucide-react';

const DRILL_LABELS = {
  'doubling-chain': 'Doubling Chain',
  'serial-subtraction': 'Serial Subtraction',
  'multiplication': 'Multiplication',
  'powers': 'Powers',
  'estimation': 'Estimation'
};

export default function PostSessionLauncher({ config, recentSessions, onStart, onViewHistory, onViewConfig }) {
  const [tags, setTags] = useState({ sleep: '', caffeine: '', stress: '' });

  if (!config) {
    return <div className="text-gray-500">Loading configuration...</div>;
  }

  const today = new Date().toISOString().split('T')[0];
  const todaySession = recentSessions?.find(s => s.date === today);
  const lastThree = (recentSessions || []).slice(-3).reverse();

  const enabledDrills = Object.entries(config.mentalMath?.drillTypes || {})
    .filter(([, cfg]) => cfg.enabled);

  function handleStart() {
    const drillConfigs = enabledDrills.map(([type, cfg]) => ({
      type,
      config: {
        steps: cfg.steps,
        count: cfg.count,
        maxDigits: cfg.maxDigits,
        subtrahend: cfg.subtrahend,
        startRange: cfg.startRange,
        bases: cfg.bases,
        maxExponent: cfg.maxExponent,
        tolerancePct: cfg.tolerancePct
      },
      timeLimitSec: cfg.timeLimitSec || 120
    }));
    // Filter out empty tag values
    const cleanTags = {};
    for (const [k, v] of Object.entries(tags)) {
      if (v.trim()) cleanTags[k] = v.trim();
    }
    onStart(drillConfigs, cleanTags);
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Zap size={24} className="text-port-accent" />
          <h2 className="text-xl font-bold text-white">Power On Self Test</h2>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onViewHistory}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white bg-port-card border border-port-border rounded-lg transition-colors"
          >
            <History size={14} />
            History
          </button>
          <button
            onClick={onViewConfig}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white bg-port-card border border-port-border rounded-lg transition-colors"
          >
            <Settings size={14} />
            Config
          </button>
        </div>
      </div>

      {/* Today's Status */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex items-center justify-between">
          <span className="text-gray-400 text-sm">Today's Status</span>
          {todaySession ? (
            <span className="text-port-success text-sm font-medium">
              Completed — Score: {todaySession.score}
            </span>
          ) : (
            <span className="text-port-warning text-sm font-medium">Not yet completed</span>
          )}
        </div>
      </div>

      {/* Enabled Drills */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-3">Enabled Drills</h3>
        <div className="space-y-2">
          {enabledDrills.map(([type, cfg]) => (
            <div key={type} className="flex items-center justify-between text-sm">
              <span className="text-white">{DRILL_LABELS[type] || type}</span>
              <span className="text-gray-500">
                {cfg.steps ? `${cfg.steps} steps` : cfg.count ? `${cfg.count} questions` : ''}
                {cfg.timeLimitSec ? ` · ${cfg.timeLimitSec}s` : ''}
              </span>
            </div>
          ))}
          {enabledDrills.length === 0 && (
            <p className="text-gray-500 text-sm">No drills enabled. Configure drills to get started.</p>
          )}
        </div>
      </div>

      {/* Condition Tags */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-3">Conditions (optional)</h3>
        <div className="grid grid-cols-3 gap-3">
          {Object.entries(tags).map(([key, value]) => (
            <div key={key}>
              <label className="text-xs text-gray-500 mb-1 block capitalize">{key}</label>
              <input
                type="text"
                value={value}
                onChange={e => setTags(prev => ({ ...prev, [key]: e.target.value }))}
                placeholder={key === 'sleep' ? 'good/poor' : key === 'caffeine' ? '1 cup' : 'low/high'}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white placeholder-gray-600 focus:border-port-accent focus:outline-none"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Start Button */}
      <button
        onClick={handleStart}
        disabled={enabledDrills.length === 0}
        className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
      >
        <Play size={18} />
        Start POST
      </button>

      {/* Recent Scores */}
      {lastThree.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3">Recent Sessions</h3>
          <div className="space-y-2">
            {lastThree.map(s => (
              <div key={s.id} className="flex items-center justify-between text-sm">
                <span className="text-gray-400">{s.date}</span>
                <span className={`font-mono font-medium ${
                  s.score >= 80 ? 'text-port-success' :
                  s.score >= 50 ? 'text-port-warning' :
                  'text-port-error'
                }`}>
                  {s.score}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
