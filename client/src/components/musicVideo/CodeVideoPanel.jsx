import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Film, RotateCcw } from 'lucide-react';
import toast from '../ui/Toast';
import useProviderModels from '../../hooks/useProviderModels.js';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import { shouldIgnoreGlobalKey } from '../../lib/a11yKeyboard.js';
import { prepareAnimationHtml } from '../codeAnimation/CodeAnimationPreview.jsx';
import { generateMusicVideoCode, getMusicVideoCodeDocument, regenerateMusicVideoCodeSection } from '../../services/apiMusicVideo.js';

const buttonCls = 'flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';

/**
 * Preview and generation for a code-rendered music video (#9076).
 * The selected section is `?section=`. Generation runs only from a click,
 * after the provider and model are shown.
 */
export default function CodeVideoPanel({ project, audioUrl, onProject }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [looping, setLooping] = useState(false);
  const iframeRef = useRef(null);
  const audioRef = useRef(null);
  const tRef = useRef(0);
  const {
    providers, selectedProviderId, selectedModel, availableModels, selectedProvider,
    setSelectedProviderId, setSelectedModel,
  } = useProviderModels({ allowDefault: true, silent: true });

  useEffect(() => {
    let active = true;
    setError('');
    getMusicVideoCodeDocument(project.id, { silent: true })
      .then((next) => { if (active) setDoc(next); })
      .catch((err) => { if (active) setError(err?.message || 'Could not build the code preview'); });
    return () => { active = false; };
  }, [project.id, project.updatedAt, project.composition?.codeVideo?.generatedAt]);

  const sections = doc?.song?.sections || doc?.timeline?.sections || [];
  const fps = doc?.fps || 24;
  const duration = doc?.durationSec || 0;
  const requested = searchParams.get('section');
  const section = sections.find((item) => item.id === requested) || sections[0] || null;

  useEffect(() => {
    if (!section || requested === section.id) return undefined;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('section', section.id);
      return next;
    }, { replace: true });
    return undefined;
  }, [section, requested, setSearchParams]);

  const srcDoc = useMemo(() => (doc?.html ? prepareAnimationHtml(doc.html, 'MV_CODE_AUDIO', null) : null), [doc]);

  const seek = (time) => {
    const next = Math.min(Math.max(0, time), duration || time);
    tRef.current = next;
    setT(next);
    iframeRef.current?.contentWindow?.postMessage({ type: 'mv-code:seek', t: next }, '*');
    if (audioRef.current && Math.abs((audioRef.current.currentTime || 0) - next) > 0.05) {
      audioRef.current.currentTime = next;
    }
  };

  useEffect(() => {
    const step = (dir) => seek(tRef.current + dir / fps);
    const jump = (dir) => {
      if (!sections.length) return;
      const index = Math.max(0, sections.findIndex((item) => item.id === (section?.id)));
      const next = sections[(index + dir + sections.length) % sections.length];
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        params.set('section', next.id);
        return params;
      }, { replace: true });
      seek(next.startSec || 0);
    };
    const onKey = (event) => {
      if (shouldIgnoreGlobalKey(event)) return;
      if (event.key === ',' || event.key === '.') {
        event.preventDefault();
        if (audioRef.current) audioRef.current.pause();
        setPlaying(false);
        step(event.key === '.' ? 1 : -1);
      } else if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        jump(event.key === ']' ? 1 : -1);
      } else if (event.key === 'l' || event.key === 'L') {
        event.preventDefault();
        setLooping((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (!audio) return;
      let time = audio.currentTime || 0;
      if (looping && section && time >= section.endSec) {
        time = section.startSec || 0;
        audio.currentTime = time;
      }
      tRef.current = time;
      setT(time);
      iframeRef.current?.contentWindow?.postMessage({ type: 'mv-code:seek', t: time }, '*');
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, looping, section]);

  const providerLabel = selectedProvider?.name || selectedProviderId || 'the active provider';
  const modelLabel = selectedModel ? ` / ${selectedModel}` : '';

  const run = async (sectionId) => {
    setBusy(sectionId || 'all');
    const body = { providerId: selectedProviderId || undefined, model: selectedModel || undefined };
    const task = sectionId
      ? regenerateMusicVideoCodeSection(project.id, sectionId, body, { silent: true })
      : generateMusicVideoCode(project.id, body, { silent: true });
    const result = await Promise.resolve(task).catch((err) => {
      toast.error(err?.message || 'Code video generation failed');
      return null;
    });
    setBusy(null);
    if (result?.project) onProject(result.project);
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) { setPlaying((value) => !value); return; }
    if (playing) { audio.pause(); setPlaying(false); return; }
    audio.play?.()?.catch?.(() => {});
    setPlaying(true);
  };

  return (
    <section className="mt-3 space-y-2 rounded-lg border border-port-border bg-port-bg p-2" aria-label="Code-rendered preview">
      <div className="flex flex-wrap items-end gap-2">
        {providers.length > 0 && (
          <ProviderModelSelector
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onProviderChange={setSelectedProviderId}
            onModelChange={setSelectedModel}
            label="Code video provider"
            disabled={!!busy}
            modelDisabled={availableModels.length === 0}
            compact
            alwaysShowModel
            emptyProviderOption="Active provider (default)"
            emptyModelOption="Default model"
          />
        )}
        <p className="text-xs text-port-text-muted">
          Generate code video uses {providerLabel}{modelLabel}. Nothing is sent until you click.
        </p>
        <button type="button" className={`${buttonCls} bg-port-accent text-white`} disabled={!!busy || !doc}
          onClick={() => run(null)}>
          <Film size={14} /> {busy === 'all' ? 'Generating…' : 'Generate code video'}
        </button>
        <button type="button" className={buttonCls} disabled={!!busy || !section}
          onClick={() => run(section.id)}>
          <RotateCcw size={14} /> {busy && busy !== 'all' ? 'Regenerating…' : 'Regenerate section'}
        </button>
      </div>
      {error && <p className="text-xs text-port-error" role="alert">{error}</p>}
      <div className="overflow-hidden rounded border border-port-border bg-black" style={{ aspectRatio: doc?.width && doc?.height ? `${doc.width} / ${doc.height}` : '16 / 9', maxHeight: '70vh' }}>
        {srcDoc ? (
          <iframe ref={iframeRef} title="Code-rendered preview" sandbox="allow-scripts" srcDoc={srcDoc} className="h-full w-full" />
        ) : (
          <p className="p-3 text-xs text-port-text-muted">{error ? '' : 'Building the preview…'}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonCls} onClick={togglePlay} disabled={!doc}>{playing ? 'Pause' : 'Play'}</button>
        <button type="button" className={buttonCls} aria-pressed={looping} onClick={() => setLooping((value) => !value)}>
          {looping ? 'Looping section' : 'Loop section'}
        </button>
        <label htmlFor="mv-code-scrub" className="sr-only">Scrub preview</label>
        <input id="mv-code-scrub" type="range" min={0} max={duration || 0} step={1 / fps} value={Math.min(t, duration || 0)}
          onChange={(e) => { if (audioRef.current) audioRef.current.pause(); setPlaying(false); seek(Number(e.target.value)); }}
          className="min-w-0 flex-1" />
        <span className="text-xs text-port-text-muted">{section ? section.label || section.id : 'No section'} · {t.toFixed(2)}s</span>
      </div>
      <p className="text-[11px] text-port-text-muted">, and . step one frame. [ and ] change section. l loops the section.</p>
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="none" className="hidden" />}
    </section>
  );
}
