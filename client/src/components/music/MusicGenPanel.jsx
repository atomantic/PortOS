/**
 * MusicGenPanel — on-device music generation for the Track editor.
 *
 * Lets the user pick a generation engine (MusicGen / AudioLDM2 / ACE-Step),
 * pick or install a model, and Generate audio from the track's prompt (+ lyrics
 * for lyric-aware engines like ACE-Step). On success the parent receives the
 * updated track (the server attaches the audio + gen metadata).
 *
 * Engines that aren't provisioned (their opt-in venv is missing) are shown with
 * an in-app install action and the Generate button is gated — mirroring the FLUX.2
 * venv gate in image gen. Additional HuggingFace checkpoints can be installed
 * inline (streamed download), then selected immediately.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Wand2, Download, X } from 'lucide-react';
import toast from '../ui/Toast';
import {
  listMusicEngines, generateMusic, installAudioModel, removeAudioModel,
} from '../../services/api';
import RuntimeInstallModal from '../install/RuntimeInstallModal';

export default function MusicGenPanel({ track, prompt, lyrics, onGenerated, remix }) {
  const [engines, setEngines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [engineId, setEngineId] = useState('');
  const [modelId, setModelId] = useState('');
  const [durationSec, setDurationSec] = useState(null);
  const [generating, setGenerating] = useState(false);
  // Inline HF model install.
  const [installRepo, setInstallRepo] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState(null);
  const [runtimeInstallEngine, setRuntimeInstallEngine] = useState(null);
  const [userSelectedEngine, setUserSelectedEngine] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const loadEngines = async () => {
    const data = await listMusicEngines({ silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    const list = Array.isArray(data?.engines) ? data.engines : [];
    setEngines(list);
    setLoading(false);
    // Default to the first READY engine, else the server default, else the first.
    if (!engineId && list.length) {
      const ready = list.find((e) => e.ready);
      const pick = ready || list.find((e) => e.id === data.defaultEngine) || list[0];
      setEngineId(pick.id);
    }
  };

  useEffect(() => { loadEngines(); }, []);

  const engine = useMemo(() => engines.find((e) => e.id === engineId) || null, [engines, engineId]);

  // Remix: seed the engine / model / duration from a past render. Keyed on
  // `remix.nonce` (bumped per Remix click) so re-clicking the SAME render
  // re-applies even when its values are unchanged. An uploaded render carries no
  // engineId — skip the engine swap then and just keep the user's current
  // selection (the parent still prefills the prompt/lyrics form fields). Setting
  // engineId + modelId together lets the engine-validity effect below keep the
  // seeded model (it's in the engine's list because the engine produced it).
  useEffect(() => {
    if (!remix) return;
    if (remix.engineId) setEngineId(remix.engineId);
    if (remix.modelId) setModelId(remix.modelId);
    if (remix.durationSec != null) setDurationSec(remix.durationSec);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remix?.nonce]);

  // Keep the model selection valid for the current engine: reset to the engine
  // default ONLY when the selected model isn't in this engine's list. Keying on
  // engine.id (not the object) + this guard means a list refresh after installing
  // a model (which replaces the engines array but keeps the same engine id) does
  // NOT clobber a freshly-selected model — it stays selected because it's now in
  // the list. Switching to a different engine still resets (the old model isn't
  // in the new engine's list). Duration seeds once.
  useEffect(() => {
    if (!engine) return;
    const ids = (engine.models || []).map((m) => m.id);
    if (!ids.includes(modelId)) setModelId(engine.defaultModelId || ids[0] || '');
    setDurationSec((d) => (d == null ? engine.defaultDurationSec : d));
  }, [engine?.id, engine?.models]);

  const canGenerate = !!engine?.ready && !!prompt?.trim() && !generating && !!track?.id;

  const handleGenerate = async () => {
    if (!engine) return;
    if (!track?.id) { toast.error('Save the track first, then generate'); return; }
    if (!prompt?.trim()) { toast.error('Add a generation prompt first'); return; }
    setGenerating(true);
    const body = {
      prompt: prompt.trim(),
      lyrics: engine.lyrics ? (lyrics || '') : '',
      engine: engine.id,
      modelId,
      trackId: track.id,
    };
    if (Number.isFinite(durationSec)) body.durationSec = durationSec;
    const res = await generateMusic(body, { silent: true }).catch((err) => { toast.error(err.message || 'Generation failed'); return null; });
    if (!mountedRef.current) return;
    setGenerating(false);
    if (res?.track) {
      onGenerated?.(res.track);
      toast.success('Track generated');
    }
  };

  const handleInstall = async () => {
    const repo = installRepo.trim();
    if (!repo || !engine) return;
    setInstalling(true);
    setInstallProgress({ message: `Starting ${repo}…` });
    // Track failure across the stream: an `error` frame OR a thrown request
    // (e.g. a 400 invalid-repo) means the install did NOT succeed, so we must
    // not then clear the field / select the repo / report "Installed".
    let failed = false;
    await installAudioModel({ engine: engine.id, repo }, (ev) => {
      if (!mountedRef.current) return;
      if (ev.type === 'progress') setInstallProgress({ message: `${ev.file || 'downloading'} — ${Math.round((ev.progress || 0) * 100)}%`, progress: ev.progress });
      else if (ev.type === 'stage') setInstallProgress({ message: ev.stage });
      else if (ev.type === 'error') { failed = true; toast.error(ev.message || 'Download failed'); }
    }).catch((err) => { failed = true; if (mountedRef.current) toast.error(err.message || 'Install failed'); });
    if (!mountedRef.current) return;
    setInstalling(false);
    setInstallProgress(null);
    if (failed) return; // leave the repo field intact so the user can retry/fix
    setInstallRepo('');
    await loadEngines(); // refresh model list (the new repo is now registered)
    setModelId(repo);
    toast.success(`Installed ${repo}`);
  };

  const handleRemoveModel = async (id) => {
    if (!engine) return;
    await removeAudioModel(engine.id, id, { silent: true }).catch((err) => { toast.error(err.message || 'Remove failed'); return null; });
    await loadEngines();
    if (modelId === id) setModelId(engine.defaultModelId || '');
  };

  if (loading) return <div className="text-xs text-gray-500">Loading generators…</div>;
  if (engines.length === 0) return <div className="text-xs text-gray-500">No music generators available.</div>;

  const selectedUserModel = engine?.models?.find((m) => m.id === modelId && m.userAdded);
  const showRuntimeInstallHint = !!engine && !engine.ready && (!!prompt?.trim() || userSelectedEngine);

  return (
    <div className="space-y-2 border border-port-border rounded-lg p-3 bg-port-bg/40">
      <div className="flex items-center gap-2 text-sm text-gray-300">
        <Wand2 size={14} className="text-port-accent" /> Generate audio on-device
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Engine</span>
          <select
            value={engineId}
            onChange={(e) => {
              setUserSelectedEngine(true);
              setEngineId(e.target.value);
            }}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
          >
            {engines.map((e) => (
              <option key={e.id} value={e.id}>{e.name}{e.ready ? '' : ' (not installed)'}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Model</span>
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
          >
            {(engine?.models || []).map((m) => (
              <option key={m.id} value={m.id}>{m.name}{m.userAdded ? ' (installed)' : ''}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">
          Duration (s){engine ? ` — ${engine.minDurationSec}–${engine.maxDurationSec}` : ''}
        </span>
        <input
          type="number"
          value={durationSec ?? ''}
          min={engine?.minDurationSec}
          max={engine?.maxDurationSec}
          onChange={(e) => setDurationSec(e.target.value === '' ? null : Number(e.target.value))}
          className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
        />
      </label>

      {showRuntimeInstallHint ? (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-port-warning/30 bg-port-warning/10 px-3 py-2">
          <p className="text-[11px] text-port-warning">
            {engine.name} is not installed yet. Install the runtime to enable generation.
          </p>
          <button
            type="button"
            onClick={() => setRuntimeInstallEngine(engine)}
            className="inline-flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-warning/50 text-port-warning text-xs font-medium hover:border-port-warning disabled:opacity-50"
          >
            <Download size={13} />
            Install runtime
          </button>
        </div>
      ) : null}
      {engine?.lyrics ? (
        <p className="text-[11px] text-gray-500">This engine uses the track’s lyrics as conditioning.</p>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!canGenerate}
          title={!track?.id ? 'Save the track first' : !prompt?.trim() ? 'Add a generation prompt' : !engine?.ready ? 'Engine not installed' : 'Generate audio'}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
          {generating ? 'Generating…' : 'Generate'}
        </button>
        {selectedUserModel ? (
          <button
            type="button"
            onClick={() => handleRemoveModel(selectedUserModel.id)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-gray-400 hover:text-port-error text-xs"
            title="Remove this installed model"
          >
            <X size={12} /> Remove model
          </button>
        ) : null}
      </div>

      {/* Install an additional model from HuggingFace — only for engines that
          can render an arbitrary checkpoint (musicgen/audioldm2). ACE-Step uses
          a fixed foundation checkpoint, so the install affordance is hidden. */}
      {engine?.customModels ? (
      <div className="pt-2 border-t border-port-border/60">
        <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Install a model from HuggingFace</span>
        <div className="flex items-center gap-2">
          <input
            value={installRepo}
            onChange={(e) => setInstallRepo(e.target.value)}
            placeholder="org/model-repo"
            disabled={installing}
            className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleInstall}
            disabled={installing || !installRepo.trim()}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50"
          >
            {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Install
          </button>
        </div>
        {installProgress ? <p className="text-[11px] text-gray-500 mt-1 truncate">{installProgress.message}</p> : null}
      </div>
      ) : null}
      <RuntimeInstallModal
        open={!!runtimeInstallEngine}
        runtime={runtimeInstallEngine?.id}
        label={runtimeInstallEngine?.name}
        installUrlBase="/api/music/setup/runtime-install"
        description="Installing the music runtime and python packages. Large downloads may take several minutes."
        onClose={() => setRuntimeInstallEngine(null)}
        onComplete={() => loadEngines()}
      />
    </div>
  );
}
