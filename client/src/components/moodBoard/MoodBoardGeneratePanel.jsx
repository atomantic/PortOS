import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { supportsToolFreeOneShot, toolFreeOneShotSelectionPolicy } from '../../utils/providerSelection';
import ProviderModelSelector from '../ProviderModelSelector';
import ResolutionField from '../media/ResolutionField';
import MediaJobThumb from '../pipeline/MediaJobThumb';
import SentPromptPanel from '../media/SentPromptPanel';
import FormField from '../ui/FormField';
import useProviderModels from '../../hooks/useProviderModels';
import useImageRenderSettings from '../../hooks/useImageRenderSettings';
import useMounted from '../../hooks/useMounted';
import { RESOLUTIONS, MAX_IMAGE_PIXELS } from '../../lib/imageGenResolutions';
import { uuidv4 } from '../../lib/uuid';
import { formatCount } from '../../utils/formatters';
import { generateMoodBoardImages, getMoodBoardGeneration } from '../../services/api';
import socket from '../../services/socket';

const presets = RESOLUTIONS.filter((r) => !r.compatible);
const fieldClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-2 text-sm text-white';

/** The parent keys this panel by board id, keeping pending requests scoped. */
export default function MoodBoardGeneratePanel({ board, disabled = false, embedded = false }) {
  const mounted = useMounted();
  const [expanded, setOpen] = useState(false);
  // Embedded in the board tool rail, the tool tab already names it.
  const open = embedded || expanded;
  const [direction, setDirection] = useState('');
  const [count, setCount] = useState(1);
  const [size, setSize] = useState({ width: 1024, height: 576 });
  const [mode, setMode] = useState('');
  const [effort, setEffort] = useState('');
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const pending = useRef(false);
  const request = useRef(null);
  const providers = useProviderModels({ filter: supportsToolFreeOneShot, silent: true, withEffort: true });
  const { backends, imageCfg } = useImageRenderSettings();
  const busy = submitting || job?.status === 'running';

  const apply = useCallback((next) => {
    if (!next || next.boardId !== board.id || !mounted.current) return;
    setJob((prev) => prev?.epoch === next.epoch && prev?.revision > next.revision ? prev : next);
  }, [board.id, mounted]);

  useEffect(() => {
    let active = true;
    let revision = 0;
    const restore = () => {
      const started = revision;
      getMoodBoardGeneration(board.id, { silent: true }).then((current) => {
        if (!active || started !== revision) return;
        if (current) apply(current);
        else {
          setJob(null);
          request.current = null;
        }
        setError(null);
      }).catch((err) => { if (active) setError(err.message || 'Could not restore generation status'); })
        .finally(() => { if (active) setLoading(false); });
    };
    const onProgress = (next) => {
      if (next?.boardId !== board.id) return;
      revision += 1;
      apply(next);
    };
    socket.on('mood-board:generate', onProgress);
    socket.on('connect', restore);
    restore();
    return () => {
      active = false;
      socket.off('mood-board:generate', onProgress);
      socket.off('connect', restore);
    };
  }, [board.id, apply]);

  const generate = async (retry = false) => {
    if (pending.current || busy || disabled) return;
    pending.current = true;
    setSubmitting(true);
    setError(null);
    // Retain the exact payload on uncertain network failure; re-submission joins
    // the original server run even if it has already finished enqueueing.
    const payload = request.current || {
      requestId: retry ? job.requestId : uuidv4(),
      providerId: providers.selectedProviderId,
      model: providers.selectedModel || undefined,
      effort: effort || undefined,
      direction, count, render: { ...size, ...(mode ? { mode } : {}) }, retry,
    };
    request.current = payload;
    const next = await generateMoodBoardImages(board.id, payload, { silent: true }).catch((err) => {
      if (err.status >= 400 && err.status < 500) request.current = null;
      if (mounted.current) setError(err.message || 'Could not start generation. Retry to check the same request.');
      return null;
    });
    pending.current = false;
    if (!mounted.current) return;
    setSubmitting(false);
    if (next) {
      request.current = null;
      apply(next);
    }
  };

  const invalidSize = size.width < 64 || size.height < 64 || size.width * size.height > MAX_IMAGE_PIXELS;
  const ready = !disabled && !loading && !busy && !providers.loading && providers.selectedProviderId && backends.length > 0 && !invalidSize;
  const queued = job?.items.filter((it) => it.jobId).length || 0;

  return (
    <section className="min-w-0 bg-port-card border border-port-border rounded-md p-3 space-y-3">
      {!embedded && <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex w-full min-h-[44px] items-center gap-2 text-left text-sm font-medium text-white">
        <Sparkles className="w-4 h-4 shrink-0 text-port-accent" aria-hidden="true" />
        Generate more
      </button>}
      {open && <div className="min-w-0 space-y-3">
        <p className="text-xs text-gray-400">Create new images from this board’s saved analyses, prompts, captions and notes. The prompt writer receives text, not image pixels. Use Analyze in the Style tool for references that need visual descriptions. Existing references stay in place.</p>
        <div>
          <p className="text-xs text-gray-400 mb-1">Prompt-writing LLM</p>
          <ProviderModelSelector providers={providers.providers}
            selectedProviderId={providers.selectedProviderId} selectedModel={providers.selectedModel}
            availableModels={providers.availableModels} onProviderChange={providers.setSelectedProviderId}
            onModelChange={providers.setSelectedModel} effort={effort} onEffortChange={setEffort}
            selectionPolicy={toolFreeOneShotSelectionPolicy} disabled={busy || providers.loading} layout="row" />
          {!providers.loading && !providers.providers.length && <p className="text-xs text-port-warning">Enable an API or supported one-shot provider in Settings → Providers.</p>}
        </div>
        <FormField label="Direction (optional)">
          <textarea className={fieldClass} rows={2} maxLength={2000} value={direction} disabled={busy}
            placeholder="Explore new scenes with the same palette and atmosphere…" onChange={(e) => setDirection(e.target.value)} />
        </FormField>
        <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),20rem))]">
          <FormField label="Image renderer">
            <select className={fieldClass} value={mode} disabled={busy} onChange={(e) => setMode(e.target.value)}>
              <option value="">Configured default ({imageCfg?.mode || 'loading'})</option>
              {backends.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </FormField>
          <FormField label="Images">
            <select className={fieldClass} value={count} disabled={busy} onChange={(e) => setCount(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{formatCount(n)}</option>)}
            </select>
          </FormField>
          <ResolutionField presets={presets} {...size} maxPixels={MAX_IMAGE_PIXELS} disabled={busy}
            onChange={(width, height) => setSize({ width, height })} />
        </div>
        <p className="text-xs text-gray-500">Uses the renderer’s configured image model and settings. Only backends supported by the media queue are offered. Prompt writing survives navigation; if the server restarts, saved prompts remain on the board.</p>
        {disabled && <p className="text-xs text-port-warning">Save the board prompt before generating.</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => generate()} disabled={!ready}
            className="min-h-[44px] px-3 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-50">
            {submitting ? 'Starting…' : request.current ? 'Retry request' : 'Generate images'}
          </button>
          {job?.status === 'failed' && <button type="button" onClick={() => generate(true)} disabled={!ready}
            className="min-h-[44px] px-3 py-2 rounded border border-port-border text-white text-sm disabled:opacity-50">Retry unfinished batch</button>}
        </div>
      </div>}
      {(error || job?.error) && <p role="alert" className="text-sm text-port-error break-words">{error || job.error}</p>}
      {job && <div className="space-y-2">
        <p role="status" className="text-xs text-gray-400">
          {job.status === 'running' && job.phase === 'writing' ? 'Writing image prompts…' : `${formatCount(queued)} of ${formatCount(job.total)} images queued.`}
          {job.status === 'queued' ? ' Images will appear on the board when ready. If a render fails, use Render on its saved prompt to retry.' : ''}
          {job.status === 'failed' ? ' Retry unfinished batch keeps the original choices and skips images already queued.' : ''}
        </p>
        {queued > 0 && <div className="flex flex-wrap gap-3">
          {job.items.filter((it) => it.jobId).map((it) => <MediaJobThumb key={it.jobId} jobId={it.jobId} label="Generated image" size="md" />)}
        </div>}
        {job.sentInput && <div className="text-xs">
          <span className="block mb-1 text-gray-500">Sent to the prompt-writing AI</span>
          <SentPromptPanel sentPrompt={job.sentInput.sentPrompt} additions={job.sentInput.promptAdditions || []} />
        </div>}
      </div>}
    </section>
  );
}
