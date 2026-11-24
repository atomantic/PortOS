import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router';
import { Save, Mic, Play, Zap, Globe } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { getVoiceStatus, getVoiceConfig, updateVoiceConfig, testTts } from '../../services/apiVoice';
import { playWav } from '../../services/voiceClient';
import { readVoiceHidden, writeVoiceHidden } from '../../services/voiceVisibility';
import ListLoadError from '../ui/ListLoadError';
import useMounted from '../../hooks/useMounted';
import { useInstanceFeatures } from '../../hooks/useInstanceFeatures';
import VoiceFaceTimeSection from './voice/VoiceFaceTimeSection';
import VoiceSpeechSection from './voice/VoiceSpeechSection';
import VoiceLlmSection from './voice/VoiceLlmSection';
import VoiceFastPathSection from './voice/VoiceFastPathSection';

const SERVICE_LABELS = {
  whisper: 'Whisper (STT)',
  'web-speech': 'Web Speech API (STT)',
  piper: 'Piper (TTS)',
  llm: 'LLM provider',
  facetime: 'FaceTime Audio',
};

const ServiceBadge = ({ label, probe }) => {
  if (!probe) return null;
  const ok = probe.ok;
  return (
    <div className={`flex items-center gap-2 text-sm ${ok ? 'text-port-success' : 'text-port-error'}`}>
      <span className={`w-2 h-2 rounded-full ${ok ? 'bg-port-success' : 'bg-port-error'}`} />
      <span className="font-medium">{label}</span>
      <span className="text-xs text-gray-500">
        {ok ? `${probe.latencyMs ?? probe.state ?? '—'}` : probe.state || probe.error || 'down'}
        {ok && typeof probe.latencyMs === 'number' ? 'ms' : ''}
      </span>
    </div>
  );
};

const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent';

export function VoiceTab() {
  const { isFeatureEnabled } = useInstanceFeatures();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cfg, setCfg] = useState(null);
  const [configError, setConfigError] = useState(null);
  const mountedRef = useMounted();
  const [status, setStatus] = useState(null);
  const [testing, setTesting] = useState(false);
  const [widgetHidden, setWidgetHidden] = useState(readVoiceHidden);
  // Persisted identity the server's /facetime/* routes actually use; form inputs may be ahead of it.
  const [savedFacetime, setSavedFacetime] = useState(null);
  const retryVoicesRef = useRef(null);
  const traitsSyncRef = useRef(null);

  const toggleWidgetHidden = (next) => {
    writeVoiceHidden(next);
    setWidgetHidden(next);
  };

  const registerRetryVoices = useCallback((fn) => {
    retryVoicesRef.current = fn;
  }, []);

  const refreshStatus = useCallback(() => {
    retryVoicesRef.current?.();
    return getVoiceStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  // Config and status load independently: a failed status probe only degrades
  // the status badges, and a failed config shows a retryable error row instead
  // of an endless spinner. Silent: ListLoadError is the failure UI.
  const loadConfig = useCallback(() => {
    setLoading(true);
    setConfigError(null);
    getVoiceStatus({ silent: true })
      .then((s) => { if (mountedRef.current) setStatus(s); })
      .catch(() => { if (mountedRef.current) setStatus(null); });
    return getVoiceConfig({ silent: true })
      .then((config) => { if (mountedRef.current) { setCfg(config); setSavedFacetime(config?.facetime || {}); } })
      .catch((err) => { if (mountedRef.current) setConfigError(err instanceof Error ? err : new Error('Request failed')); })
      .finally(() => { if (mountedRef.current) setLoading(false); });
  }, [mountedRef]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Functional setState form so sequential patch() calls in one event handler
  // compose correctly — each one sees the prior's result instead of cloning
  // the pre-event `cfg` and silently overwriting earlier changes.
  const patch = useCallback((path, value) => {
    setCfg((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      let cur = next;
      const keys = path.split('.');
      for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]] ??= {};
      cur[keys[keys.length - 1]] = value;
      return next;
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const pendingTraits = traitsSyncRef.current?.readPending();
      const payload = pendingTraits === null || pendingTraits === undefined ? cfg : {
        ...cfg,
        llm: { ...cfg.llm, personality: { ...cfg.llm.personality, traits: pendingTraits } },
      };
      const r = await updateVoiceConfig(payload, { silent: true });
      setCfg(r.config);
      setSavedFacetime(r.config?.facetime || {});
      traitsSyncRef.current?.clear();
      const rec = r.reconciliation || {};
      if (rec.error) {
        toast.error(`Saved, but reconcile failed: ${rec.error}`, { duration: 12000 });
      } else if (rec.skipped === 'web-speech') {
        toast.success('Voice settings saved — using Web Speech API for STT');
      } else if (rec.skipped === true) {
        toast.success('Voice settings saved (disabled)');
      } else if (rec.stopped) {
        toast.success('Voice settings saved — whisper stopped');
      } else if (rec.host) {
        toast.success(`Voice settings saved — whisper up on ${rec.host}:${rec.port}`);
      } else {
        toast.success('Voice settings saved');
      }
    } catch (err) {
      toast.error(`Failed to save voice settings: ${err.message}`);
    } finally {
      setSaving(false);
    }
    await refreshStatus();
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const buf = await testTts('Voice mode is online. I am ready to help.', undefined, cfg?.tts?.engine);
      playWav(buf);
    } catch (err) {
      toast.error(`TTS test failed: ${err.message}`);
    } finally {
      setTesting(false);
    }
    await refreshStatus();
  };

  if (!loading && !cfg) return <ListLoadError what="voice settings" error={configError} onRetry={loadConfig} />;

  const ready = !loading && Boolean(cfg);
  const sttEngine = cfg?.stt?.engine || 'whisper';
  const ttsEngine = cfg?.tts?.engine || 'piper';

  return (
    <>
      {!ready && <BrailleSpinner text="Loading voice settings" />}
      {/* Mount background-fetching sections on initial mount in the same tree position
          so listVoiceEngines, getProviders, and nanoAvailability run in parallel with
          getVoiceConfig without remounting once cfg arrives. */}
      <div className={ready ? 'bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-6' : undefined}>
        {ready && (
          <>
            <div className="flex items-center gap-2 text-white">
              <Mic size={18} />
              <h2 className="text-lg font-semibold">Local Voice Chief-of-Staff</h2>
            </div>
            <p className="text-xs text-gray-500 -mt-4">
              Hands-free or push-to-talk voice. Whisper (STT) + local TTS + your chosen LLM
              provider with tool calling for real actions (brain capture, goal updates, PM2 control, feed
              digests, time, and more). Pick a local provider (LM Studio, Ollama) to keep everything on
              this machine, or any OpenAI-compatible API.
            </p>

            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={cfg.enabled} onChange={(e) => patch('enabled', e.target.checked)} className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline gap-x-3 gap-y-0.5 min-w-0 flex-1">
                <span className="text-sm text-white">Enable voice mode</span>
                <span className="text-xs text-gray-500">(toggling on installs missing binaries + downloads selected models)</span>
              </div>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={!widgetHidden} onChange={(e) => toggleWidgetHidden(!e.target.checked)} className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline gap-x-3 gap-y-0.5 min-w-0 flex-1">
                <span className="text-sm text-white">Show floating voice widget</span>
                <span className="text-xs text-gray-500">(per-browser preference — Safari on iPhone does not support the mic APIs this widget uses)</span>
              </div>
            </label>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {status?.services && Object.entries(status.services).map(([k, probe]) => (
                <ServiceBadge key={k} label={SERVICE_LABELS[k] || k} probe={probe} />
              ))}
            </div>

            {isFeatureEnabled('facetime') && (
              <VoiceFaceTimeSection facetime={cfg.facetime || {}} savedFacetime={savedFacetime} saving={saving} patch={patch} inputCls={inputCls} />
            )}

            <div className="flex items-start gap-3 bg-port-bg border border-port-border rounded-lg p-3">
              <Globe size={16} className="text-port-accent mt-0.5 shrink-0" />
              <div className="text-xs text-gray-400 min-w-0">
                <span className="text-white">Serve TTS as an API.</span>{' '}
                Expose <code className="text-port-accent">POST /api/voice/public/synthesize</code> so other
                machines on your tailnet can request audio (any engine/voice). Configure exposure and
                passwordless/auth gating under{' '}
                <Link to="/settings/api-access" className="text-port-accent hover:underline">Settings → API Access</Link>.
              </div>
            </div>
          </>
        )}

        <div className={ready ? 'grid grid-cols-1 md:grid-cols-2 gap-4' : undefined}>
          <VoiceSpeechSection cfg={ready ? cfg : null} patch={patch} inputCls={inputCls} onRegisterRetryVoices={registerRetryVoices} />
          <VoiceLlmSection cfg={ready ? cfg : null} patch={patch} inputCls={inputCls} traitsSyncRef={traitsSyncRef} />
          <VoiceFastPathSection fastPathCfg={ready ? (cfg.llm.fastPath || {}) : null} sttEngine={sttEngine} patch={patch} inputCls={inputCls} />
        </div>

        {ready && (
          <>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 pt-2">
              <button onClick={handleSave} disabled={saving} className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm rounded-lg transition-colors disabled:opacity-50">
                {saving ? <BrailleSpinner /> : <Save size={14} />}
                Save & Reconcile
              </button>
              <button onClick={handleTest} disabled={testing} className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-border hover:bg-port-border/70 text-white text-sm rounded-lg transition-colors disabled:opacity-50" title="Synthesize a test phrase with the active TTS engine">
                {testing ? <BrailleSpinner /> : <Play size={14} />}
                Test voice
              </button>
              <button onClick={refreshStatus} className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-border hover:bg-port-border/70 text-white text-sm rounded-lg transition-colors">
                <Zap size={14} />
                Refresh
              </button>
            </div>

            <details className="text-xs text-gray-500">
              <summary className="cursor-pointer">Binary + model paths</summary>
              <dl className="mt-2 space-y-1 font-mono">
                {sttEngine === 'whisper' ? (
                  <>
                    <div>whisper-server: {status?.binaries?.whisper || <em className="text-port-error">not found</em>}</div>
                    <div>STT model: {status?.models?.sttModel || <em className="text-port-error">missing</em>}</div>
                    {cfg.stt.coreml && (
                      <div>CoreML encoder: {status?.models?.coreml || <em className="text-port-error">missing</em>}</div>
                    )}
                  </>
                ) : (
                  <div>STT: <em>Web Speech API (browser-native — no server binaries required)</em></div>
                )}
                {ttsEngine === 'piper' && (
                  <div>piper: {status?.binaries?.piper || <em className="text-port-error">not found</em>}</div>
                )}
                <div>TTS voice: {status?.models?.ttsVoice || <em className="text-port-error">missing</em>}</div>
              </dl>
            </details>
          </>
        )}
      </div>
    </>
  );
}

export default VoiceTab;
