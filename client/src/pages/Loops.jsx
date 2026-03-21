import { useState, useEffect, useRef, useCallback } from 'react';
import {
  RefreshCw, Play, Square, Trash2, Plus, Clock, Zap, ChevronDown, ChevronRight,
  Bot, AlertCircle, CheckCircle, Loader2
} from 'lucide-react';
import * as api from '../services/api';
import socket from '../services/socket';
import toast from 'react-hot-toast';
import { timeAgo } from '../components/feature-agents/constants';
import { formatInterval } from '../components/cos/constants';

const INTERVAL_PRESETS = [
  { label: '30s', value: '30s' },
  { label: '1m', value: '1m' },
  { label: '5m', value: '5m' },
  { label: '10m', value: '10m' },
  { label: '30m', value: '30m' },
  { label: '1h', value: '1h' },
];

function StatusBadge({ loop }) {
  if (loop.isExecuting) return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-blue-500/20 text-blue-400">
      <Loader2 size={12} className="animate-spin" /> Running
    </span>
  );
  if (loop.isRunning) return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-green-500/20 text-green-400">
      <Clock size={12} /> Active
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-gray-500/20 text-gray-400">
      <Square size={12} /> Stopped
    </span>
  );
}

function CreateLoopForm({ providers, onCreated }) {
  const [prompt, setPrompt] = useState('');
  const [interval, setInterval] = useState('10m');
  const [customInterval, setCustomInterval] = useState('');
  const [name, setName] = useState('');
  const [providerId, setProviderId] = useState('');
  const [cwd, setCwd] = useState('');
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setCreating(true);
    const data = {
      prompt: prompt.trim(),
      interval: customInterval || interval,
      name: name.trim() || undefined,
      cwd: cwd.trim() || undefined,
      providerId: providerId || undefined,
    };
    api.createLoop(data)
      .then(() => {
        setPrompt('');
        setName('');
        setCwd('');
        setCustomInterval('');
        onCreated();
      })
      .catch(() => {})
      .finally(() => setCreating(false));
  };

  return (
    <form onSubmit={handleSubmit} className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2 mb-2">
        <Plus size={16} className="text-port-accent" />
        <h3 className="text-sm font-medium text-gray-200">New Loop</h3>
      </div>

      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        placeholder="What should this loop do? e.g., check if the deployment finished and report status"
        className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-500 resize-y min-h-[60px]"
        rows={2}
      />

      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Interval</label>
          <div className="flex gap-1">
            {INTERVAL_PRESETS.map(p => (
              <button
                key={p.value}
                type="button"
                onClick={() => { setInterval(p.value); setCustomInterval(''); }}
                className={`px-2 py-1 text-xs rounded border ${
                  interval === p.value && !customInterval
                    ? 'border-port-accent bg-port-accent/20 text-port-accent'
                    : 'border-port-border text-gray-400 hover:border-gray-500'
                }`}
              >
                {p.label}
              </button>
            ))}
            <input
              type="text"
              value={customInterval}
              onChange={e => setCustomInterval(e.target.value)}
              placeholder="custom"
              className="w-16 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600"
            />
          </div>
        </div>

        <div className="flex-1 min-w-[150px]">
          <label className="block text-xs text-gray-400 mb-1">AI Provider</label>
          <select
            value={providerId}
            onChange={e => setProviderId(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-gray-200"
          >
            <option value="">Active provider (default)</option>
            {providers.map(p => (
              <option key={p.id} value={p.id}>
                {p.name} {p.isActive ? '(active)' : ''} — {p.defaultModel || p.type}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-gray-400 hover:text-gray-300 flex items-center gap-1"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Advanced
        </button>
      </div>

      {expanded && (
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-400 mb-1">Name (optional)</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Loop name for display"
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600"
            />
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-400 mb-1">Working Directory (optional)</label>
            <input
              type="text"
              value={cwd}
              onChange={e => setCwd(e.target.value)}
              placeholder="/path/to/project"
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600"
            />
          </div>
        </div>
      )}

      <button
        type="submit"
        disabled={!prompt.trim() || creating}
        className="px-4 py-1.5 bg-port-accent text-white rounded text-sm font-medium hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
      >
        {creating ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        Start Loop
      </button>
    </form>
  );
}

function LoopCard({ loop, onAction, expandedId, onToggle }) {
  const outputRef = useRef(null);
  const [liveOutput, setLiveOutput] = useState([]);
  const expanded = expandedId === loop.id;

  useEffect(() => {
    const appendOutput = (entry) => {
      setLiveOutput(prev => {
        const next = [...prev, entry];
        return next.length > 200 ? next.slice(-200) : next;
      });
    };

    const handleOutput = (data) => {
      if (data.id !== loop.id) return;
      appendOutput({ line: data.line, timestamp: data.timestamp });
    };
    const handleComplete = (data) => {
      if (data.id !== loop.id) return;
      appendOutput({ line: `--- Iteration ${data.iteration} complete (exit ${data.exitCode}) ---`, timestamp: data.timestamp, system: true });
    };
    const handleStart = (data) => {
      if (data.id !== loop.id) return;
      appendOutput({ line: `--- Iteration ${data.iteration} starting ---`, timestamp: data.timestamp, system: true });
    };
    const handleError = (data) => {
      if (data.id !== loop.id) return;
      appendOutput({ line: `--- Error: ${data.error} ---`, timestamp: data.timestamp, system: true, error: true });
    };

    socket.on('loop:output', handleOutput);
    socket.on('loop:iteration:complete', handleComplete);
    socket.on('loop:iteration:start', handleStart);
    socket.on('loop:iteration:error', handleError);
    return () => {
      socket.off('loop:output', handleOutput);
      socket.off('loop:iteration:complete', handleComplete);
      socket.off('loop:iteration:start', handleStart);
      socket.off('loop:iteration:error', handleError);
    };
  }, [loop.id]);

  useEffect(() => {
    if (outputRef.current && expanded) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [liveOutput, expanded]);

  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-port-bg/50"
        onClick={() => onToggle(loop.id)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-200 truncate">{loop.name}</span>
            <StatusBadge loop={loop} />
            <span className="text-xs text-gray-500">every {formatInterval(loop.intervalMs)}</span>
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-500">
            <span>#{loop.currentIteration || 0} iterations</span>
            <span>last: {loop.lastRun ? timeAgo(new Date(loop.lastRun).toISOString()) : 'never'}</span>
            {loop.providerId && <span className="flex items-center gap-1"><Bot size={10} /> {loop.providerId}</span>}
          </div>
        </div>

        <div className="flex items-center gap-1">
          {loop.isRunning ? (
            <>
              <button onClick={e => { e.stopPropagation(); onAction('trigger', loop.id); }} className="p-1.5 rounded hover:bg-port-border text-gray-400 hover:text-port-accent" title="Run now">
                <Zap size={14} />
              </button>
              <button onClick={e => { e.stopPropagation(); onAction('stop', loop.id); }} className="p-1.5 rounded hover:bg-port-border text-gray-400 hover:text-port-warning" title="Stop">
                <Square size={14} />
              </button>
            </>
          ) : (
            <button onClick={e => { e.stopPropagation(); onAction('resume', loop.id); }} className="p-1.5 rounded hover:bg-port-border text-gray-400 hover:text-port-success" title="Resume">
              <Play size={14} />
            </button>
          )}
          <button onClick={e => { e.stopPropagation(); onAction('delete', loop.id); }} className="p-1.5 rounded hover:bg-port-border text-gray-400 hover:text-port-error" title="Delete">
            <Trash2 size={14} />
          </button>
          {expanded ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-port-border">
          <div className="px-4 py-2 bg-port-bg/30">
            <div className="text-xs text-gray-500 mb-1">Prompt</div>
            <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono">{loop.prompt}</pre>
          </div>

          {loop.history?.length > 0 && (
            <div className="px-4 py-2 border-t border-port-border/50">
              <div className="text-xs text-gray-500 mb-1">Recent Iterations</div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {loop.history.slice(-5).reverse().map((h, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    {h.success ? <CheckCircle size={10} className="text-port-success" /> : <AlertCircle size={10} className="text-port-error" />}
                    <span className="text-gray-400">#{h.iteration}</span>
                    <span className="text-gray-500">{h.duration ? `${(h.duration / 1000).toFixed(1)}s` : ''}</span>
                    <span className="text-gray-500">{h.provider}</span>
                    <span className="text-gray-600 truncate flex-1">{h.summary?.slice(0, 80)}</span>
                    <span className="text-gray-600">{timeAgo(new Date(h.timestamp).toISOString())}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-port-border/50">
            <div className="px-4 py-1 text-xs text-gray-500 flex items-center gap-2">
              Live Output
              {loop.isExecuting && <Loader2 size={10} className="animate-spin text-blue-400" />}
              {liveOutput.length > 0 && (
                <button onClick={() => setLiveOutput([])} className="ml-auto text-gray-600 hover:text-gray-400 text-xs">clear</button>
              )}
            </div>
            <div
              ref={outputRef}
              className="px-4 py-2 max-h-64 overflow-y-auto bg-port-bg/50 font-mono text-xs leading-relaxed"
            >
              {liveOutput.length === 0 ? (
                <div className="text-gray-600 italic">Waiting for output...</div>
              ) : (
                liveOutput.map((entry, i) => (
                  <div
                    key={i}
                    className={
                      entry.system
                        ? entry.error ? 'text-port-error' : 'text-gray-500 italic'
                        : 'text-gray-300'
                    }
                  >
                    {entry.line}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const ACTION_MAP = {
  stop: { fn: api.stopLoop, msg: 'Loop stopped' },
  resume: { fn: api.resumeLoop, msg: 'Loop resumed' },
  trigger: { fn: api.triggerLoop, msg: 'Iteration triggered' },
  delete: { fn: api.deleteLoop, msg: 'Loop deleted' },
};

export default function Loops() {
  const [loops, setLoops] = useState([]);
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);

  const fetchLoops = useCallback(async () => {
    const data = await api.getLoops().catch(() => []);
    setLoops(data);
    setLoading(false);
  }, []);

  const fetchProviders = useCallback(async () => {
    const data = await api.getLoopProviders().catch(() => ({ providers: [] }));
    setProviders(data.providers || []);
  }, []);

  useEffect(() => {
    fetchLoops();
    fetchProviders();

    // Subscribe to loop events
    socket.emit('loops:subscribe');

    const refreshEvents = ['loop:created', 'loop:stopped', 'loop:resumed', 'loop:deleted', 'loop:updated'];
    const handleRefresh = () => fetchLoops();
    refreshEvents.forEach(e => socket.on(e, handleRefresh));

    // Fallback poll for iteration count updates (socket events cover state changes)
    const poll = setInterval(fetchLoops, 60000);

    return () => {
      socket.emit('loops:unsubscribe');
      refreshEvents.forEach(e => socket.off(e, handleRefresh));
      clearInterval(poll);
    };
  }, [fetchLoops, fetchProviders]);

  const handleAction = async (action, id) => {
    const entry = ACTION_MAP[action];
    if (!entry) return;
    await entry.fn(id).catch(() => {});
    toast.success(entry.msg);
  };

  const runningCount = loops.filter(l => l.isRunning).length;

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-100 flex items-center gap-2">
            <RefreshCw size={20} className="text-port-accent" /> Loops
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Recurring AI tasks — like Claude Code's /loop, for any AI provider
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-400">
          {runningCount > 0 && <span className="text-port-success">{runningCount} active</span>}
          <span>{loops.length} total</span>
          <button onClick={fetchLoops} className="p-1 rounded hover:bg-port-border" title="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <CreateLoopForm providers={providers} onCreated={fetchLoops} />

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 size={20} className="animate-spin mr-2" /> Loading loops...
        </div>
      ) : loops.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <RefreshCw size={32} className="mx-auto mb-2 opacity-30" />
          <p className="text-sm">No loops yet. Create one above to get started.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {loops.map(loop => (
            <LoopCard
              key={loop.id}
              loop={loop}
              onAction={handleAction}
              expandedId={expandedId}
              onToggle={id => setExpandedId(prev => prev === id ? null : id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
