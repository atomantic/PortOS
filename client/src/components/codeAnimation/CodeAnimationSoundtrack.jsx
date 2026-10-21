import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Music2 } from 'lucide-react';
import toast from '../ui/Toast';
import ModelInputPreview from '../media/ModelInputPreview';
import ListLoadError from '../ui/ListLoadError';
import useListResource from '../../hooks/useListResource';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import { useModelInputPreview } from '../../hooks/useModelInputPreview';
import { generateCodeAnimationSoundtrack, listMusicEngines, previewMusicPrompt } from '../../services/api';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage';

// The last engine/model/instrumental choice, reused for every animation.
export const SOUNDTRACK_CHOICE_KEY = 'portos.codeAnimation.soundtrackChoice';
// Long-form engines first when nothing has been picked yet.
const PREFERRED_ENGINES = ['acestep15', 'acestep', 'minimax-music3-mlx', 'minimax-music3'];

const inputClass = 'w-full rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-port-accent focus:outline-none';
const labelClass = 'mb-1 block text-xs text-gray-400';
const buttonPrimary = 'inline-flex items-center gap-2 rounded-lg bg-port-accent px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40';

const readChoice = () => {
  const stored = safeReadJsonStorage(SOUNDTRACK_CHOICE_KEY, null);
  return stored && typeof stored === 'object' ? stored : {};
};

const fetchEngines = async () => (await listMusicEngines({ silent: true }))?.engines;

const fits = (engine, filmSec) => !Number.isFinite(engine.maxDurationSec) || engine.maxDurationSec >= filmSec;

function engineNote(engine, filmSec) {
  if (!engine.ready) return 'not installed';
  if (!fits(engine, filmSec)) return `max ${engine.maxDurationSec}s`;
  return null;
}

/**
 * Generate audio for a finished animation: pick a local music model, describe
 * the score, and render a track at the film's length. The animation is not
 * re-run; the track becomes its audio for the preview and the MP4 export.
 */
export default function CodeAnimationSoundtrack({ jobId, soundtrack, audioUrl, durationSeconds, onReady }) {
  const filmSec = Math.ceil(Number(durationSeconds) || 0);
  const engineList = useListResource(fetchEngines);
  const engines = engineList.state === 'ready' ? engineList.items : null;
  const [choice, setChoice] = useState(readChoice);
  const [prompt, setPrompt] = useState(soundtrack?.prompt || '');
  const [starting, setStarting] = useState(false);
  const [mediaJobId, setMediaJobId] = useState(soundtrack?.mediaJobId || null);

  useEffect(() => {
    setPrompt(soundtrack?.prompt || '');
    setMediaJobId(soundtrack?.mediaJobId || null);
  }, [jobId, soundtrack?.mediaJobId]);

  const usable = useMemo(() => (engines || []).filter((engine) => engine.ready && fits(engine, filmSec)), [engines, filmSec]);
  const engine = useMemo(() => {
    const list = engines || [];
    return list.find((item) => item.id === choice.engine)
      || PREFERRED_ENGINES.map((id) => usable.find((item) => item.id === id)).find(Boolean)
      || usable[0]
      || list[0]
      || null;
  }, [engines, usable, choice.engine]);
  const models = engine?.models || [];
  const modelId = models.some((model) => model.id === choice.modelId) ? choice.modelId : (engine?.defaultModelId || models[0]?.id || '');
  const instrumentalOnly = choice.instrumentalOnly !== false;
  const engineBlocked = engine ? engineNote(engine, filmSec) : null;

  const updateChoice = (patch) => setChoice((current) => {
    const next = { ...current, ...patch };
    safeWriteJsonStorage(SOUNDTRACK_CHOICE_KEY, next);
    return next;
  });

  const captionPreview = useModelInputPreview(previewMusicPrompt, {
    prompt, engine: engine?.id, instrumentalOnly, durationSec: filmSec || undefined,
  }, { enabled: !!engine && !!prompt.trim() });

  const progress = useMediaJobProgress(mediaJobId, { kind: 'audio' });
  const live = progress.status === 'queued' || progress.status === 'running' || (mediaJobId && progress.status === 'unknown');
  // Refetch the animation once the take lands so the preview and export use it.
  const settledRef = useRef(null);
  useEffect(() => {
    if (!mediaJobId || progress.status !== 'completed' || settledRef.current === mediaJobId) return;
    settledRef.current = mediaJobId;
    onReady?.();
  }, [mediaJobId, progress.status, onReady]);

  const canGenerate = !!engine && !engineBlocked && !!prompt.trim() && !starting && !live && filmSec > 0;

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setStarting(true);
    const started = await generateCodeAnimationSoundtrack(jobId, {
      prompt,
      engine: engine.id,
      ...(modelId ? { modelId } : {}),
      instrumentalOnly,
    }, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to start the soundtrack');
      return null;
    });
    setStarting(false);
    if (started?.mediaJobId) setMediaJobId(started.mediaJobId);
  };

  const percent = Math.round((progress.progress || 0) * 100);
  const hasTake = !!soundtrack?.trackId && !!audioUrl;

  return (
    <section className="space-y-3 rounded-lg border border-port-border bg-port-card p-3" aria-labelledby="ca-soundtrack-heading">
      <h3 id="ca-soundtrack-heading" className="flex items-center gap-2 text-sm font-semibold text-white">
        <Music2 className="h-4 w-4 text-port-accent" /> Soundtrack
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="ca-soundtrack-engine" className={labelClass}>Music model</label>
          <select id="ca-soundtrack-engine" value={engine?.id || ''} disabled={!engines?.length || live}
            onChange={(event) => updateChoice({ engine: event.target.value, modelId: '' })} className={inputClass}>
            {engines === null && <option value="">{engineList.state === 'error' ? 'Models unavailable' : 'Loading models…'}</option>}
            {engines?.length === 0 && <option value="">No music models</option>}
            {(engines || []).map((item) => {
              const note = engineNote(item, filmSec);
              return <option key={item.id} value={item.id}>{item.name}{note ? ` (${note})` : ''}</option>;
            })}
          </select>
        </div>
        {models.length > 1 && (
          <div>
            <label htmlFor="ca-soundtrack-model" className={labelClass}>Checkpoint</label>
            <select id="ca-soundtrack-model" value={modelId} disabled={live}
              onChange={(event) => updateChoice({ modelId: event.target.value })} className={inputClass}>
              {models.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
            </select>
          </div>
        )}
      </div>
      {engineList.state === 'error' && <ListLoadError what="music models" error={engineList.error} onRetry={engineList.retry} />}
      {engine && engineBlocked === 'not installed' && (
        <p className="text-xs text-port-warning">{engine.name} is not installed. Install it in Music › Generate, or pick another model.</p>
      )}
      {engine && engineBlocked && engineBlocked !== 'not installed' && (
        <p className="text-xs text-port-warning">The film is {filmSec}s; {engine.name} renders at most {engine.maxDurationSec}s. Pick a model marked for longer audio.</p>
      )}
      <div>
        <label htmlFor="ca-soundtrack-prompt" className={labelClass}>Describe the music</label>
        <textarea id="ca-soundtrack-prompt" rows={3} value={prompt} maxLength={8000} disabled={live}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Warm analog synths, slow build, soft drums from 0:20, gentle fade at the end"
          className={`${inputClass} resize-y`} />
      </div>
      <ModelInputPreview preview={captionPreview} prompt={prompt} />
      <label className="flex items-center gap-2 text-xs text-gray-300">
        <input type="checkbox" checked={instrumentalOnly} disabled={live} onChange={(event) => updateChoice({ instrumentalOnly: event.target.checked })} />
        Instrumental only
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={handleGenerate} disabled={!canGenerate} className={buttonPrimary}>
          {starting || live ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Music2 className="h-4 w-4" />}
          {live ? `Generating audio ${percent}%` : hasTake ? 'Regenerate audio' : 'Generate audio'}
        </button>
        <span className="text-xs text-gray-500">{filmSec ? `${filmSec}s, the film's length` : ''}</span>
      </div>
      {live && (
        <div className="space-y-1" role="status" aria-label="Soundtrack progress">
          <div className="h-1.5 overflow-hidden rounded bg-port-border">
            <div className="h-full bg-port-accent transition-all" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-gray-500">{progress.statusMsg || (progress.status === 'running' ? 'Rendering…' : 'Waiting in the audio queue…')}</p>
        </div>
      )}
      {progress.status === 'failed' && (
        <p role="alert" className="text-xs text-port-error">Audio failed: {progress.error || 'unknown error'}. Try again, or pick another model.</p>
      )}
      {progress.status === 'canceled' && <p className="text-xs text-gray-500">The audio render was canceled.</p>}
      {hasTake && !live && (
        <div className="space-y-1">
          <audio src={audioUrl} controls preload="metadata" className="w-full" aria-label="Generated soundtrack" />
          <p className="text-xs text-gray-500">This is the animation&apos;s audio now. Export MP4 includes it.</p>
        </div>
      )}
    </section>
  );
}
