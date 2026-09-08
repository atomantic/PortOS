/**
 * Grok-box / CPU-only free Persistent Mind setup path.
 *
 * Shown when the host fits the local Ollama + Qwen2.5 7B Instruct default.
 * Install / start / pull reuse the existing local-LLM APIs; enable + mind pin
 * go through `/api/local-llm/persistent-mind-setup/apply`. Coding stays on
 * Cursor Agent / OpenCode Zen — this card never recommends 27B / vLLM presets.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Cpu,
  Download,
  Play,
  RefreshCw,
  Sparkles,
  Wand2,
} from 'lucide-react';
import Banner from '../ui/Banner';
import BrailleSpinner from '../BrailleSpinner';
import toast from '../ui/Toast';
import {
  applyLocalPersistentMindSetup,
  controlOllamaService,
  getLocalPersistentMindSetup,
  installLocalLlmBackend,
  installLocalLlmModel,
} from '../../services/api';

const STEP_ICON = {
  ready: CheckCircle2,
  todo: Cpu,
  blocked: AlertTriangle,
  skipped: CheckCircle2,
};

export default function LocalPersistentMindSetupCard({
  className = '',
  compact = false,
  onApplied,
}) {
  const [setup, setSetup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getLocalPersistentMindSetup({ silent: true });
      setSetup(next);
    } catch {
      setSetup(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await getLocalPersistentMindSetup({ silent: true });
        if (!cancelled) setSetup(next);
      } catch {
        if (!cancelled) setSetup(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const run = async (key, fn, successMessage) => {
    setBusy(key);
    try {
      const result = await fn();
      if (successMessage) toast.success(successMessage);
      await refresh();
      onApplied?.(result);
    } catch (error) {
      toast.error(error?.message || 'Setup step failed');
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className={`bg-port-card border border-port-border rounded-xl p-4 text-xs text-gray-500 ${className}`}>
        Checking whether this host should use a free local Persistent Mind…
      </div>
    );
  }

  if (!setup?.applicable || !setup.recommendation) return null;

  const { recommendation, steps = [], ready } = setup;
  const modelStep = steps.find((s) => s.id === 'model-present');
  const installStep = steps.find((s) => s.id === 'ollama-installed');
  const runningStep = steps.find((s) => s.id === 'ollama-running');

  return (
    <section
      className={`bg-port-accent/5 border border-port-accent/40 rounded-xl p-4 sm:p-5 space-y-3 ${className}`}
      aria-labelledby="local-persistent-mind-setup-title"
      data-testid="local-persistent-mind-setup"
    >
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-port-accent">
            <Sparkles size={16} />
            <h2 id="local-persistent-mind-setup-title" className="text-sm font-semibold">
              Free local Persistent Mind
            </h2>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Default for Grok Bot boxes and other CPU-only / no-GPU hosts: {recommendation.machine}
          </p>
        </div>
        <span className="text-[11px] px-2 py-1 rounded border border-port-accent/30 text-port-accent shrink-0">
          {recommendation.modelLabel}
        </span>
      </div>

      {!compact && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <div className="bg-port-bg/70 rounded-lg p-2.5 min-w-0">
            <span className="text-gray-500">Runtime</span>
            <p className="text-gray-200 mt-0.5 font-medium">{recommendation.runtime}</p>
          </div>
          <div className="bg-port-bg/70 rounded-lg p-2.5 min-w-0">
            <span className="text-gray-500">Mind</span>
            <p className="text-gray-200 mt-0.5 font-medium">{recommendation.mindRole}</p>
          </div>
          <div className="bg-port-bg/70 rounded-lg p-2.5 min-w-0">
            <span className="text-gray-500">Coding</span>
            <p className="text-gray-200 mt-0.5 font-medium">{recommendation.codingHarnesses}</p>
          </div>
        </div>
      )}

      <div className="text-xs text-gray-300 space-y-1.5 leading-relaxed">
        <p className="flex gap-2">
          <Bot size={14} className="text-port-success shrink-0 mt-0.5" />
          <span>
            <strong className="text-gray-200">Topology:</strong> {recommendation.topology}.{' '}
            {recommendation.note}
          </span>
        </p>
        <p className="text-gray-500">{recommendation.alternatives}</p>
      </div>

      {recommendation.warnings?.length > 0 && (
        <Banner tone="warning" size="sm" icon={AlertTriangle} title="CPU / RAM guardrails">
          <ul className="mt-1 space-y-1 list-disc pl-4">
            {recommendation.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Banner>
      )}

      <ul className="space-y-1.5 text-xs">
        {steps.filter((s) => s.id !== 'recommendation').map((s) => {
          const Icon = STEP_ICON[s.status] || Cpu;
          const tone = s.status === 'ready'
            ? 'text-port-success'
            : s.status === 'blocked'
              ? 'text-port-warning'
              : 'text-gray-400';
          return (
            <li key={s.id} className="flex items-start gap-2">
              <Icon size={14} className={`${tone} shrink-0 mt-0.5`} />
              <span className="text-gray-300 break-words">{s.detail}</span>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {installStep?.action?.kind === 'install-backend' && (
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => run('install', () => installLocalLlmBackend('ollama'), 'Ollama install started')}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 text-xs font-medium disabled:opacity-50"
          >
            {busy === 'install' ? <BrailleSpinner /> : <Download size={12} />}
            Install Ollama
          </button>
        )}
        {runningStep?.action?.kind === 'start-ollama' && (
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => run('start', () => controlOllamaService('start'), 'Ollama start requested')}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 text-xs font-medium disabled:opacity-50"
          >
            {busy === 'start' ? <BrailleSpinner /> : <Play size={12} />}
            Start Ollama
          </button>
        )}
        {modelStep?.action?.kind === 'pull-model' && (
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => run(
              'pull',
              () => installLocalLlmModel('ollama', modelStep.action.modelId, { silent: true }),
              `Pulling ${recommendation.modelLabel}`,
            )}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 text-xs font-medium disabled:opacity-50"
          >
            {busy === 'pull' ? <BrailleSpinner /> : <Download size={12} />}
            Pull {recommendation.modelLabel}
          </button>
        )}
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => run(
            'enable',
            () => applyLocalPersistentMindSetup({ setMindProfile: false }, { silent: true }),
            'Ollama provider enabled',
          )}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 text-xs font-medium disabled:opacity-50"
        >
          {busy === 'enable' ? <BrailleSpinner /> : <Wand2 size={12} />}
          Enable Ollama provider
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => run(
            'mind',
            () => applyLocalPersistentMindSetup({ setMindProfile: true }, { silent: true }),
            'Persistent Mind profile pinned to Ollama',
          )}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-port-accent text-white hover:bg-port-accent/80 text-xs font-medium disabled:opacity-50"
        >
          {busy === 'mind' ? <BrailleSpinner /> : <Bot size={12} />}
          Enable provider + set Mind profile
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => { setLoading(true); refresh(); }}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-port-border text-gray-400 hover:text-white text-xs disabled:opacity-50"
          aria-label="Refresh local Persistent Mind setup"
        >
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        {ready
          ? <span className="text-port-success inline-flex items-center gap-1"><CheckCircle2 size={12} /> Required setup steps are complete</span>
          : <span className="text-gray-500">Complete install / start / pull, then enable the provider.</span>}
        <Link to="/ai" className="text-port-accent hover:underline">AI Providers</Link>
        <Link to="/cos/mind" className="text-port-accent hover:underline">Persistent Mind</Link>
        <Link to="/models/llms" className="text-port-accent hover:underline">Models → LLMs</Link>
      </div>
    </section>
  );
}
