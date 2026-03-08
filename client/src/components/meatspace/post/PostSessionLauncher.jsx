import { useState, useEffect } from 'react';
import { Zap, History, Settings, Play, Brain, BookOpen, Dumbbell, Timer } from 'lucide-react';
import { getProviders } from '../../../services/api';
import { DOMAINS, DRILL_TO_DOMAIN } from './constants';

const DRILL_LABELS = {
  'doubling-chain': 'Doubling Chain',
  'serial-subtraction': 'Serial Subtraction',
  'multiplication': 'Multiplication',
  'powers': 'Powers',
  'estimation': 'Estimation',
  'word-association': 'Word Association',
  'story-recall': 'Story Recall',
  'verbal-fluency': 'Verbal Fluency',
  'wit-comeback': 'Wit & Comeback',
  'pun-wordplay': 'Pun & Wordplay',
  'memory-fill-blank': 'Memory Fill Blank',
  'memory-sequence': 'Memory Sequence',
  'memory-element-flash': 'Element Flash',
  'what-if': 'What If?',
  'alternative-uses': 'Alternative Uses',
  'story-prompt': 'Story Prompt',
  'invention-pitch': 'Invention Pitch',
  'reframe': 'Reframe',
};

export default function PostSessionLauncher({ config, recentSessions, onStart, onViewHistory, onViewConfig, onViewMemory }) {
  const [tags, setTags] = useState({ sleep: '', caffeine: '', stress: '' });
  const [mode, setMode] = useState('test'); // 'test' | 'train'
  const [providers, setProviders] = useState([]);

  useEffect(() => {
    getProviders().then(p => setProviders((p || []).filter(pr => pr.enabled && pr.type === 'api'))).catch(() => {});
  }, []);

  if (!config) {
    return <div className="text-gray-500">Loading configuration...</div>;
  }

  const today = new Date().toISOString().split('T')[0];
  const todaySession = recentSessions?.find(s => s.date === today);
  const lastThree = (recentSessions || []).slice(-3).reverse();

  const enabledMathDrills = Object.entries(config.mentalMath?.drillTypes || {})
    .filter(([, cfg]) => cfg.enabled);

  const enabledLlmDrills = config.llmDrills?.enabled !== false
    ? Object.entries(config.llmDrills?.drillTypes || {}).filter(([, cfg]) => cfg.enabled !== false)
    : [];

  const llmProviderId = config.llmDrills?.providerId || null;
  const llmModel = config.llmDrills?.model || null;

  function handleStart() {
    const mathConfigs = enabledMathDrills.map(([type, cfg]) => ({
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

    const llmConfigs = enabledLlmDrills.map(([type, cfg]) => ({
      type,
      config: { count: cfg.count || 5 },
      timeLimitSec: cfg.timeLimitSec || 120,
      providerId: cfg.providerId || llmProviderId,
      model: cfg.model || llmModel
    }));

    const drillConfigs = [...mathConfigs, ...llmConfigs];
    const cleanTags = {};
    for (const [k, v] of Object.entries(tags)) {
      if (v.trim()) cleanTags[k] = v.trim();
    }
    onStart(drillConfigs, cleanTags, mode === 'train');
  }

  // Build domain → enabled drills map for quick session
  const allEnabledDrills = [
    ...enabledMathDrills.map(([type, cfg]) => ({ type, cfg, source: 'math' })),
    ...enabledLlmDrills.map(([type, cfg]) => ({ type, cfg, source: 'llm' })),
  ];

  const enabledDomains = {};
  for (const { type, cfg, source } of allEnabledDrills) {
    const domain = DRILL_TO_DOMAIN[type];
    if (!domain) continue;
    if (!enabledDomains[domain]) enabledDomains[domain] = [];
    enabledDomains[domain].push({ type, cfg, source });
  }

  function handleQuickSession() {
    const drillConfigs = [];
    for (const [domainKey, drills] of Object.entries(enabledDomains)) {
      const domain = DOMAINS[domainKey];
      // Pick one random drill from this domain
      const pick = drills[Math.floor(Math.random() * drills.length)];
      const cfg = pick.cfg;

      const drillConfig = {
        type: pick.type,
        domain: domainKey,
        config: pick.source === 'math'
          ? {
              steps: cfg.steps,
              count: cfg.count ? Math.min(cfg.count, 5) : undefined,
              maxDigits: cfg.maxDigits,
              subtrahend: cfg.subtrahend,
              startRange: cfg.startRange,
              bases: cfg.bases,
              maxExponent: cfg.maxExponent,
              tolerancePct: cfg.tolerancePct,
            }
          : { count: Math.min(cfg.count || 5, 3) }, // Fewer prompts for quick session
        timeLimitSec: domain.timeBudgetSec,
      };

      if (pick.source === 'llm') {
        drillConfig.providerId = cfg.providerId || llmProviderId;
        drillConfig.model = cfg.model || llmModel;
      }

      drillConfigs.push(drillConfig);
    }

    const cleanTags = {};
    for (const [k, v] of Object.entries(tags)) {
      if (v.trim()) cleanTags[k] = v.trim();
    }
    onStart(drillConfigs, cleanTags, mode === 'train');
  }

  const hasAnyDrills = enabledMathDrills.length > 0 || enabledLlmDrills.length > 0;
  const domainCount = Object.keys(enabledDomains).length;

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
            onClick={onViewMemory}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white bg-port-card border border-port-border rounded-lg transition-colors"
          >
            <BookOpen size={14} />
            Memory
          </button>
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

      {/* Mental Math Drills */}
      {enabledMathDrills.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3">Mental Math</h3>
          <div className="space-y-2">
            {enabledMathDrills.map(([type, cfg]) => (
              <div key={type} className="flex items-center justify-between text-sm">
                <span className="text-white">{DRILL_LABELS[type] || type}</span>
                <span className="text-gray-500">
                  {cfg.steps ? `${cfg.steps} steps` : cfg.count ? `${cfg.count} questions` : ''}
                  {cfg.timeLimitSec ? ` · ${cfg.timeLimitSec}s` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LLM Drills */}
      {enabledLlmDrills.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Brain size={14} className="text-purple-400" />
            <h3 className="text-sm font-medium text-gray-400">Wit & Memory</h3>
            {(llmProviderId || providers.length > 0) && (
              <span className="text-xs text-gray-600 ml-auto">
                {llmProviderId || 'system default'}
              </span>
            )}
          </div>
          <div className="space-y-2">
            {enabledLlmDrills.map(([type, cfg]) => (
              <div key={type} className="flex items-center justify-between text-sm">
                <span className="text-white">{DRILL_LABELS[type] || type}</span>
                <span className="text-gray-500">
                  {cfg.count ? `${cfg.count} prompts` : ''}
                  {cfg.timeLimitSec ? ` · ${cfg.timeLimitSec}s` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!hasAnyDrills && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <p className="text-gray-500 text-sm">No drills enabled. Configure drills to get started.</p>
        </div>
      )}

      {/* Mode Toggle */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-3">Session Mode</h3>
        <div className="flex gap-2">
          <button
            onClick={() => setMode('test')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              mode === 'test'
                ? 'bg-port-accent text-white'
                : 'bg-port-bg border border-port-border text-gray-400 hover:text-white'
            }`}
          >
            <Zap size={14} />
            Test
          </button>
          <button
            onClick={() => setMode('train')}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              mode === 'train'
                ? 'bg-purple-600 text-white'
                : 'bg-port-bg border border-port-border text-gray-400 hover:text-white'
            }`}
          >
            <Dumbbell size={14} />
            Train
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          {mode === 'train'
            ? 'Training mode: immediate feedback, hints on wrong answers. Not scored.'
            : 'Test mode: timed drills with scoring. Saved to history.'}
        </p>
      </div>

      {/* Condition Tags */}
      {mode === 'test' && <div className="bg-port-card border border-port-border rounded-lg p-4">
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
      </div>}

      {/* Start Buttons */}
      <div className="flex gap-3">
        {domainCount >= 2 && (
          <button
            onClick={handleQuickSession}
            disabled={!hasAnyDrills}
            className={`flex-1 flex items-center justify-center gap-2 px-6 py-3 ${
              mode === 'train'
                ? 'bg-purple-600 hover:bg-purple-500'
                : 'bg-port-success hover:bg-port-success/80'
            } disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors`}
          >
            <Timer size={18} />
            Quick 5 Min ({domainCount} domains)
          </button>
        )}
        <button
          onClick={handleStart}
          disabled={!hasAnyDrills}
          className={`flex-1 flex items-center justify-center gap-2 px-6 py-3 ${
            mode === 'train'
              ? 'bg-purple-600/70 hover:bg-purple-500/70'
              : 'bg-port-accent hover:bg-port-accent/80'
          } disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors`}
        >
          {mode === 'train' ? <Dumbbell size={18} /> : <Play size={18} />}
          {mode === 'train' ? 'Full Training' : 'Full POST'}
        </button>
      </div>

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
