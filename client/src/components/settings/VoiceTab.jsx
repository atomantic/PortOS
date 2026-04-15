import { useState, useEffect, useCallback } from 'react';
import { Save, Mic, Play, Zap } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import {
  getVoiceStatus, getVoiceConfig, updateVoiceConfig, listVoices, testTts,
} from '../../services/apiVoice';
import { playWav, webSpeechSupported } from '../../services/voiceClient';

const SERVICE_LABELS = {
  whisper: 'Whisper (STT)',
  'web-speech': 'Web Speech API (STT)',
  piper: 'Piper (TTS)',
  kokoro: 'Kokoro (TTS)',
  lmstudio: 'LM Studio (LLM)',
};

const STT_ENGINES = [
  { value: 'whisper', label: 'Whisper (local, accurate, works offline)' },
  { value: 'web-speech', label: 'Web Speech API (browser-native, zero latency)' },
];

const TTS_ENGINES = [
  { value: 'kokoro', label: 'Kokoro (in-process, high quality)' },
  { value: 'piper', label: 'Piper (CLI binary, lightweight)' },
];

const KOKORO_DTYPES = [
  { value: 'q8', label: 'q8 (recommended — ~80MB, fast)' },
  { value: 'q4', label: 'q4 (smallest)' },
  { value: 'fp16', label: 'fp16 (higher quality)' },
  { value: 'fp32', label: 'fp32 (best quality, slowest)' },
];

const ACCENT_LABELS = { 'en-US': 'American', 'en-GB': 'British' };

const formatVoiceLabel = (v, engine) => {
  if (engine !== 'kokoro') return v.name;
  const accent = ACCENT_LABELS[v.language] || v.language || '';
  const [, ...rest] = v.name.split('_');
  const raw = rest.join(' ') || v.name;
  const display = raw.charAt(0).toUpperCase() + raw.slice(1);
  const who = [accent, v.gender].filter(Boolean).join(' ');
  const traits = v.traits ? `${v.traits} ` : '';
  const grade = v.grade ? ` (${v.grade})` : '';
  return `${traits}${who ? `${who} — ${display}` : display}${grade}`;
};

const WHISPER_MODELS = [
  { value: 'tiny.en',   file: 'ggml-tiny.en.bin',   label: 'tiny.en — 75 MB, fastest' },
  { value: 'base.en',   file: 'ggml-base.en.bin',   label: 'base.en — 142 MB, balanced (default)' },
  { value: 'small.en',  file: 'ggml-small.en.bin',  label: 'small.en — 466 MB, more accurate' },
  { value: 'medium.en', file: 'ggml-medium.en.bin', label: 'medium.en — 1.5 GB, very accurate' },
  { value: 'large-v3',  file: 'ggml-large-v3.bin',  label: 'large-v3 — 3 GB, multilingual, best' },
];

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

const Field = ({ label, hint, children, className = '' }) => (
  <div className={`space-y-1 ${className}`}>
    <label className="block text-sm text-gray-400">{label}</label>
    {hint && <p className="text-xs text-gray-500">{hint}</p>}
    {children}
  </div>
);

const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent';

export function VoiceTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cfg, setCfg] = useState(null);
  const [status, setStatus] = useState(null);
  const [voiceList, setVoiceList] = useState({ engine: null, voices: [] });
  const [testing, setTesting] = useState(false);
  const [previewingVoice, setPreviewingVoice] = useState(null);

  const refreshStatus = useCallback(() => {
    return Promise.all([getVoiceStatus(), listVoices().catch(() => ({ engine: null, voices: [] }))])
      .then(([s, v]) => { setStatus(s); setVoiceList(v); })
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    Promise.all([getVoiceConfig(), getVoiceStatus(), listVoices().catch(() => ({ engine: null, voices: [] }))])
      .then(([config, s, v]) => { setCfg(config); setStatus(s); setVoiceList(v); })
      .catch(() => toast.error('Failed to load voice settings'))
      .finally(() => setLoading(false));
  }, []);

  const patch = (path, value) => {
    const next = JSON.parse(JSON.stringify(cfg));
    let cur = next;
    const keys = path.split('.');
    for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]] ??= {};
    cur[keys[keys.length - 1]] = value;
    setCfg(next);
  };

  const handleSave = async () => {
    setSaving(true);
    await updateVoiceConfig(cfg)
      .then((r) => {
        setCfg(r.config);
        const rec = r.reconciliation || {};
        if (rec.error) {
          toast.error(`Saved, but reconcile failed: ${rec.error}`, { duration: 12000 });
        } else if (rec.skipped) {
          toast.success('Voice settings saved (disabled)');
        } else if (rec.stopped) {
          toast.success('Voice settings saved — whisper stopped');
        } else if (rec.host) {
          toast.success(`Voice settings saved — whisper up on ${rec.host}:${rec.port}`);
        } else {
          toast.success('Voice settings saved');
        }
      })
      .catch((err) => toast.error(`Failed to save voice settings: ${err.message}`))
      .finally(() => setSaving(false));
    await refreshStatus();
  };

  const handleTest = async () => {
    setTesting(true);
    await testTts('Voice mode is online. I am ready to help.')
      .then((buf) => playWav(buf))
      .catch((err) => toast.error(`TTS test failed: ${err.message}`))
      .finally(() => setTesting(false));
    await refreshStatus();
  };

  const handlePreviewVoice = async (voiceName) => {
    if (!voiceName || previewingVoice) return;
    setPreviewingVoice(voiceName);
    await testTts("Hi, I'm your voice. This is how I sound.", voiceName)
      .then((buf) => playWav(buf))
      .catch((err) => toast.error(`Preview failed: ${err.message}`))
      .finally(() => setPreviewingVoice(null));
  };

  const handleWhisperModel = (value) => {
    const m = WHISPER_MODELS.find((x) => x.value === value);
    if (!m) return;
    patch('stt.model', m.value);
    patch('stt.modelPath', `~/.portos/voice/models/${m.file}`);
  };

  if (loading || !cfg) return <BrailleSpinner text="Loading voice settings" />;

  const engine = cfg.tts.engine || 'kokoro';
  const sttEngine = cfg.stt.engine || 'whisper';
  const activeVoice = engine === 'kokoro' ? cfg.tts.kokoro?.voice : cfg.tts.piper?.voice;
  const voices = voiceList.voices || [];

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6 space-y-6">
      <div className="flex items-center gap-2 text-white">
        <Mic size={18} />
        <h2 className="text-lg font-semibold">Local Voice Chief-of-Staff</h2>
      </div>
      <p className="text-xs text-gray-500 -mt-4">
        Hands-free or push-to-talk voice. Whisper (STT) + Kokoro/Piper (TTS) + LM Studio (LLM)
        with tool calling for real actions (brain inbox capture, more coming). Everything runs on
        this machine — no external API calls.
      </p>

      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={(e) => patch('enabled', e.target.checked)}
          className="w-4 h-4"
        />
        <span className="text-sm text-white">Enable voice mode</span>
        <span className="text-xs text-gray-500">
          (toggling on installs missing binaries + downloads selected models)
        </span>
      </label>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {status?.services && Object.entries(status.services).map(([k, probe]) => (
          <ServiceBadge key={k} label={SERVICE_LABELS[k] || k} probe={probe} />
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Hotkey" hint="Hold to talk (keyboard).">
          <input
            type="text"
            value={cfg.hotkey}
            onChange={(e) => patch('hotkey', e.target.value)}
            className={inputCls}
          />
        </Field>

        <Field label="TTS engine" hint="Kokoro is higher quality and runs in-process. Piper is a small CLI binary.">
          <select
            value={engine}
            onChange={(e) => patch('tts.engine', e.target.value)}
            className={inputCls}
          >
            {TTS_ENGINES.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </Field>

        <Field label={`${engine === 'kokoro' ? 'Kokoro' : 'Piper'} voice`} hint={
          engine === 'kokoro'
            ? 'Grade letter = Kokoro author\'s quality rating. ❤️ 🔥 🎧 mark the best-sounding voices. Click ▶ to preview without saving.'
            : 'ONNX voice file under ~/.portos/voice/voices/. Click ▶ to preview without saving.'
        }>
          <div className="flex items-center gap-2">
            <select
              value={activeVoice || ''}
              onChange={(e) => {
                if (engine === 'kokoro') patch('tts.kokoro.voice', e.target.value);
                else {
                  const v = voices.find((x) => x.name === e.target.value);
                  patch('tts.piper.voice', e.target.value);
                  if (v?.path) patch('tts.piper.voicePath', v.path);
                }
              }}
              className={`${inputCls} flex-1`}
            >
              {activeVoice && !voices.some((v) => v.name === activeVoice) && (
                <option value={activeVoice}>{activeVoice} (current)</option>
              )}
              {voices.map((v) => (
                <option key={v.name} value={v.name}>{formatVoiceLabel(v, engine)}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => handlePreviewVoice(activeVoice)}
              disabled={!activeVoice || !!previewingVoice}
              title="Preview this voice"
              className="shrink-0 p-2 rounded-lg bg-port-border hover:bg-port-border/70 text-white disabled:opacity-50"
            >
              {previewingVoice === activeVoice ? <BrailleSpinner /> : <Play size={14} />}
            </button>
          </div>
        </Field>

        {engine === 'kokoro' && (
          <Field label="Kokoro precision" hint="Lower precision = smaller download + faster, slight quality cost.">
            <select
              value={cfg.tts.kokoro?.dtype || 'q8'}
              onChange={(e) => patch('tts.kokoro.dtype', e.target.value)}
              className={inputCls}
            >
              {KOKORO_DTYPES.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Speech rate" hint="0.5 = slow, 1.0 = normal, 2.0 = fast">
          <input
            type="number" min="0.5" max="2" step="0.1"
            value={cfg.tts.rate ?? 1.0}
            onChange={(e) => patch('tts.rate', parseFloat(e.target.value) || 1.0)}
            className={inputCls}
          />
        </Field>

        <Field label="STT engine" hint={webSpeechSupported
          ? 'Web Speech = browser-native, zero-latency, but quality varies by browser and only works in Chrome/Edge. Whisper = local, consistent, offline.'
          : 'Web Speech unavailable in this browser (Chrome/Edge only). Whisper it is.'}>
          <select
            value={sttEngine}
            onChange={(e) => patch('stt.engine', e.target.value)}
            className={inputCls}
          >
            {STT_ENGINES.map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.value === 'web-speech' && !webSpeechSupported}>
                {opt.label}{opt.value === 'web-speech' && !webSpeechSupported ? ' — not supported here' : ''}
              </option>
            ))}
          </select>
        </Field>

        {sttEngine === 'whisper' && (
          <>
            <Field label="Whisper model" hint="Bigger = more accurate, slower, larger download.">
              <select
                value={cfg.stt.model || 'base.en'}
                onChange={(e) => handleWhisperModel(e.target.value)}
                className={inputCls}
              >
                {WHISPER_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </Field>

            <Field label="Whisper endpoint">
              <input
                type="text"
                value={cfg.stt.endpoint}
                onChange={(e) => patch('stt.endpoint', e.target.value)}
                className={inputCls}
              />
            </Field>
          </>
        )}

        <Field label="LLM model" hint="'auto' picks the first loaded LM Studio model">
          <input
            type="text"
            value={cfg.llm.model}
            onChange={(e) => patch('llm.model', e.target.value)}
            className={inputCls}
          />
        </Field>

        <label className="flex items-center gap-3 cursor-pointer md:col-span-2">
          <input
            type="checkbox"
            checked={cfg.llm.usePersonality !== false}
            onChange={(e) => patch('llm.usePersonality', e.target.checked)}
            className="w-4 h-4"
          />
          <span className="text-sm text-white">Use Chief-of-Staff personality (recommended)</span>
          <span className="text-xs text-gray-500">
            Composes the system prompt from the fields below. Turn off to use the raw prompt.
          </span>
        </label>

        {cfg.llm.usePersonality !== false ? (
          <>
            <Field label="Name" hint="What the assistant calls itself.">
              <input
                type="text"
                value={cfg.llm.personality?.name ?? ''}
                onChange={(e) => patch('llm.personality.name', e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Role" hint="The role it plays for you.">
              <input
                type="text"
                value={cfg.llm.personality?.role ?? ''}
                onChange={(e) => patch('llm.personality.role', e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Speech style" hint="e.g. 'casual and brief', 'formal and precise'.">
              <input
                type="text"
                value={cfg.llm.personality?.speechStyle ?? ''}
                onChange={(e) => patch('llm.personality.speechStyle', e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label="Traits (comma-separated)" hint="e.g. 'concise, warm, proactive'.">
              <input
                type="text"
                value={(cfg.llm.personality?.traits || []).join(', ')}
                onChange={(e) => patch('llm.personality.traits',
                  e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
                className={inputCls}
              />
            </Field>
            <Field label="Custom prompt (optional)" className="md:col-span-2" hint="Any extra context or instructions appended to the system prompt.">
              <textarea
                value={cfg.llm.personality?.customPrompt ?? ''}
                onChange={(e) => patch('llm.personality.customPrompt', e.target.value)}
                rows={2}
                className={`${inputCls} font-mono text-xs`}
              />
            </Field>
          </>
        ) : (
          <Field label="System prompt" className="md:col-span-2">
            <textarea
              value={cfg.llm.systemPrompt}
              onChange={(e) => patch('llm.systemPrompt', e.target.value)}
              rows={2}
              className={`${inputCls} font-mono text-xs`}
            />
          </Field>
        )}

        <label className="flex items-center gap-3 cursor-pointer md:col-span-2">
          <input
            type="checkbox"
            checked={cfg.llm.tools?.enabled !== false}
            onChange={(e) => patch('llm.tools.enabled', e.target.checked)}
            className="w-4 h-4"
          />
          <span className="text-sm text-white">Enable tools (brain inbox capture, more coming)</span>
          <span className="text-xs text-gray-500">
            Needs a tool-use-capable model (Qwen2.5, Hermes-3, etc.).
          </span>
        </label>

        {sttEngine === 'whisper' && (
          <label className="flex items-center gap-3 cursor-pointer md:col-span-2">
            <input
              type="checkbox"
              checked={!!cfg.stt.coreml}
              onChange={(e) => patch('stt.coreml', e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm text-white">Use CoreML encoder for Whisper (macOS only)</span>
            <span className="text-xs text-gray-500">2–3× faster STT on Apple Silicon.</span>
          </label>
        )}
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? <BrailleSpinner /> : <Save size={14} />}
          Save & Reconcile
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          className="flex items-center gap-2 px-4 py-2 bg-port-border hover:bg-port-border/70 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          title="Synthesize a test phrase with the active TTS engine"
        >
          {testing ? <BrailleSpinner /> : <Play size={14} />}
          Test voice
        </button>
        <button
          onClick={refreshStatus}
          className="flex items-center gap-2 px-4 py-2 bg-port-border hover:bg-port-border/70 text-white text-sm rounded-lg transition-colors"
        >
          <Zap size={14} />
          Refresh
        </button>
      </div>

      <details className="text-xs text-gray-500">
        <summary className="cursor-pointer">Binary + model paths</summary>
        <dl className="mt-2 space-y-1 font-mono">
          <div>whisper-server: {status?.binaries?.whisper || <em className="text-port-error">not found</em>}</div>
          {engine === 'piper' && (
            <div>piper: {status?.binaries?.piper || <em className="text-port-error">not found</em>}</div>
          )}
          <div>STT model: {status?.models?.sttModel || <em className="text-port-error">missing</em>}</div>
          {cfg.stt.coreml && (
            <div>CoreML encoder: {status?.models?.coreml || <em className="text-port-error">missing</em>}</div>
          )}
          <div>TTS voice: {status?.models?.ttsVoice || <em className="text-port-error">missing</em>}</div>
        </dl>
      </details>
    </div>
  );
}

export default VoiceTab;
