import { useState, useEffect, useCallback, useRef } from 'react';
import { Play } from 'lucide-react';
import toast from '../../ui/Toast';
import BrailleSpinner from '../../BrailleSpinner';
import { listVoices, listVoiceEngines, testTts, fetchPiperVoice } from '../../../services/apiVoice';
import { playWav, webSpeechSupported } from '../../../services/voiceClient';
import { formatVoiceLabel } from '../../../lib/voiceLabel';
import { withUnlistedOption } from '../../../lib/withUnlistedOption';
import FormField from '../../ui/FormField';
import ListLoadError from '../../ui/ListLoadError';
import useMounted from '../../../hooks/useMounted';
import useListResource from '../../../hooks/useListResource';
import DraftNumber from '../../ui/DraftNumber';

const STT_ENGINES = [
  { value: 'whisper', label: 'Whisper (local, accurate, works offline)' },
  { value: 'web-speech', label: 'Web Speech API (browser-native, zero latency)' },
];

const WHISPER_MODELS = [
  { value: 'tiny.en',   file: 'ggml-tiny.en.bin',   label: 'tiny.en — 75 MB, fastest' },
  { value: 'base.en',   file: 'ggml-base.en.bin',   label: 'base.en — 142 MB, balanced (default)' },
  { value: 'small.en',  file: 'ggml-small.en.bin',  label: 'small.en — 466 MB, more accurate' },
  { value: 'medium.en', file: 'ggml-medium.en.bin', label: 'medium.en — 1.5 GB, very accurate' },
  { value: 'large-v3',  file: 'ggml-large-v3.bin',  label: 'large-v3 — 3 GB, multilingual, best' },
];

export default function VoiceSpeechSection({ cfg, patch, inputCls, onRegisterRetryVoices }) {
  const mountedRef = useMounted();
  const [ttsEngines, setTtsEngines] = useState([]);
  const [ttsEngineError, setTtsEngineError] = useState(null);
  const [previewingVoice, setPreviewingVoice] = useState(null);
  const [downloadingVoice, setDownloadingVoice] = useState(null);

  const configuredEngine = cfg?.tts?.engine || 'piper';
  const engineMeta = ttsEngines.find((item) => (
    item.id === configuredEngine || item.aliases?.includes(configuredEngine)
  ));
  // Display registry aliases without turning a saved engine into a form edit.
  const engine = engineMeta?.id || configuredEngine;
  const currentEngine = cfg?.tts?.engine ? engine : undefined;
  // Piper download callbacks resolve long after the click; they must see the
  // engine/mount state at resolve time, not the closure from the click.
  const currentEngineRef = useRef(currentEngine);
  currentEngineRef.current = currentEngine;

  // The selected engine's voice catalog. A failed read renders an error row with
  // Retry rather than an empty picker that offers only the saved voice.
  const fetchVoices = useCallback(
    () => listVoices(currentEngine, { silent: true }).then((v) => (Array.isArray(v?.voices) ? v.voices : [])),
    [currentEngine],
  );
  const { items: voices, state: voicesState, error: voicesError, retry: retryVoices, setItems: setVoices } = useListResource(fetchVoices, { enabled: Boolean(currentEngine) });

  useEffect(() => {
    onRegisterRetryVoices?.(retryVoices);
    return () => onRegisterRetryVoices?.(null);
  }, [onRegisterRetryVoices, retryVoices]);

  useEffect(() => {
    let active = true;
    listVoiceEngines({ silent: true })
      .then((data) => {
        if (!active) return;
        const engines = Array.isArray(data?.engines) ? data.engines : [];
        setTtsEngines(engines);
        setTtsEngineError(engines.length > 0 ? null : 'No TTS engines were returned by this server.');
      })
      .catch(() => {
        if (!active) return;
        setTtsEngines([]);
        setTtsEngineError('Could not load the TTS engine registry. The saved engine remains selected.');
      });
    return () => { active = false; };
  }, []);

  const handlePreviewVoice = async (voiceName) => {
    if (!voiceName || previewingVoice) return;
    setPreviewingVoice(voiceName);
    try {
      const buf = await testTts("Hi, I'm your voice. This is how I sound.", voiceName, currentEngine);
      playWav(buf);
    } catch (err) {
      toast.error(`Preview failed: ${err.message}`);
    } finally {
      setPreviewingVoice(null);
    }
  };

  const handleWhisperModel = (value) => {
    const m = WHISPER_MODELS.find((x) => x.value === value);
    if (!m) return;
    patch('stt.model', m.value);
    patch('stt.modelPath', `~/.portos/voice/models/${m.file}`);
  };

  const sttEngine = cfg?.stt?.engine || 'whisper';
  const engineConfigKey = typeof engineMeta?.configKey === 'string' ? engineMeta.configKey : null;
  const fallbackConfigKey = [configuredEngine, configuredEngine.replace(/-tts$/, '')]
    .find((key) => cfg?.tts?.[key] && typeof cfg.tts[key] === 'object');
  const activeVoice = cfg?.tts?.[engineConfigKey || fallbackConfigKey]?.voice;
  const selectedEngineMetadataMissing = Boolean(engineMeta && !engineConfigKey);
  // A configured engine/voice the live registry no longer lists (retired
  // engine, deleted voice) must still render as its own option — otherwise
  // the select paints blank and a save would silently switch away from it.
  const ttsEngineOptions = withUnlistedOption(ttsEngines, engine, (id) => ({ id, label: `${id} (current)` }));
  // Voices are keyed by `name`, not `id`. `unlisted` flags the synthetic
  // entry so the render below can show the same "(current)" text the old
  // hand-rolled option used, instead of running a bare `{ name }` stand-in
  // through formatVoiceLabel's engine-specific formatters.
  const voiceOptions = withUnlistedOption(
    voices,
    activeVoice,
    (name) => ({ name, unlisted: true }),
    { key: 'name' },
  );

  if (!cfg) return null;

  return (
    <>
      <FormField label="Hotkey" hint="Hold to talk (keyboard).">
        <input
          type="text"
          value={cfg.hotkey}
          onChange={(e) => patch('hotkey', e.target.value)}
          className={inputCls}
        />
      </FormField>

      <FormField label="TTS engine" hint={ttsEngineError
        || (selectedEngineMetadataMissing
          ? 'This server returned legacy engine metadata. Voice selection stays read-only until the server is updated.'
          : engineMeta?.description || 'Choose a locally available speech engine.')}>
        <select
          value={engine}
          onChange={(e) => patch('tts.engine', e.target.value)}
          className={inputCls}
        >
          {ttsEngineOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label || opt.id}{opt.description ? ` (${opt.description})` : ''}
            </option>
          ))}
        </select>
      </FormField>

      <FormField label={`${engineMeta?.label || engine} voice`} hint={engineConfigKey
        ? engineMeta?.voiceHint
        : 'Voice selection is read-only until engine configuration metadata is available.'}>
        <div className="flex items-center gap-2">
          <select
            value={activeVoice || ''}
            aria-label="Voice"
            disabled={!engineConfigKey}
            onChange={(e) => {
              const val = e.target.value;
              if (!engineConfigKey) return;
              patch(`tts.${engineConfigKey}.voice`, val);
              if (engine !== 'piper') return;
              const v = voices.find((x) => x.name === val);
              if (v?.path) patch('tts.piper.voicePath', v.path);
              patch('tts.piper.speakerId', null);
              // Fetch voice on select so ▶ preview works without a save.
              // Safe to kick off fire-and-forget — the UI disables the
              // preview button while a download is in flight.
              if (v && v.downloaded === false) {
                setDownloadingVoice(val);
                fetchPiperVoice(val, { silent: true })
                  .then(() => listVoices('piper', { silent: true }))
                  .then((fresh) => {
                    if (mountedRef.current && currentEngineRef.current === 'piper') {
                      setVoices(Array.isArray(fresh?.voices) ? fresh.voices : []);
                    }
                  })
                  .catch((err) => {
                    if (mountedRef.current) toast.error(`Voice download failed: ${err.message}`);
                  })
                  .finally(() => {
                    if (mountedRef.current) setDownloadingVoice((prev) => (prev === val ? null : prev));
                  });
              }
            }}
            className={`${inputCls} flex-1`}
          >
            {voiceOptions.map((v) => (
              <option key={v.name} value={v.name}>{v.unlisted ? `${v.name} (current)` : formatVoiceLabel(v, engine)}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => handlePreviewVoice(activeVoice)}
            disabled={!activeVoice || !!previewingVoice || !!downloadingVoice}
            title={downloadingVoice ? `Downloading ${downloadingVoice}…` : 'Preview this voice'} aria-label={downloadingVoice ? `Downloading ${downloadingVoice}…` : 'Preview this voice'}
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 p-2 rounded-lg bg-port-border hover:bg-port-border/70 text-white disabled:opacity-50"
          >
            {previewingVoice === activeVoice || downloadingVoice === activeVoice
              ? <BrailleSpinner />
              : <Play size={14} />}
          </button>
        </div>
        {voicesState === 'error' && (
          <ListLoadError what="voices" error={voicesError} onRetry={retryVoices} className="mt-2" />
        )}
      </FormField>

      {cfg.tts.retiredEngine === 'kokoro' && (
        <p role="status" className="text-sm text-port-warning">
          Kokoro has been retired. Your voice settings now use Piper. Choose a voice, then use Save &amp; Reconcile to install Piper and its voice model. Existing Kokoro character profiles must be replaced with a Piper preset.
        </p>
      )}

      <DraftNumber min={0.5} max={2} value={cfg.tts.rate ?? 1.0} onCommit={(rate) => patch('tts.rate', rate)}>
        {(field) => (
          <FormField label="Speech rate" hint="0.5 = slow, 1.0 = normal, 2.0 = fast">
            <input type="number" step="0.1" className={inputCls} {...field} />
          </FormField>
        )}
      </DraftNumber>

      <FormField label="STT engine" hint={webSpeechSupported
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
      </FormField>

      {sttEngine === 'whisper' && (
        <>
          <FormField label="Whisper model" hint="Bigger = more accurate, slower, larger download.">
            <select
              value={cfg.stt.model || 'base.en'}
              onChange={(e) => handleWhisperModel(e.target.value)}
              className={inputCls}
            >
              {WHISPER_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </FormField>

          <FormField label="Whisper endpoint">
            <input
              type="text"
              value={cfg.stt.endpoint}
              onChange={(e) => patch('stt.endpoint', e.target.value)}
              className={inputCls}
            />
          </FormField>

          <label className="flex items-start gap-3 cursor-pointer md:col-span-2">
            <input
              type="checkbox"
              checked={!!cfg.stt.coreml}
              onChange={(e) => patch('stt.coreml', e.target.checked)}
              className="w-4 h-4 mt-0.5 shrink-0"
            />
            <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-baseline gap-x-3 gap-y-0.5 min-w-0 flex-1">
              <span className="text-sm text-white">Use CoreML encoder for Whisper (macOS only)</span>
              <span className="text-xs text-gray-500">2–3× faster STT on Apple Silicon.</span>
            </div>
          </label>
        </>
      )}
    </>
  );
}
