import { useState } from 'react';
import { Loader2, Music, Sparkles, Trash2, Upload, Wand2 } from 'lucide-react';
import { musicEngineReadinessMessage } from '../../../../../server/lib/generationModes.js';
import {
  listPipelineMusicLibrary, uploadPipelineMusicTrack, attachPipelineMusicTrack,
  detachPipelineMusicTrack, deletePipelineMusicTrack, generatePipelineMusic,
} from '../../../services/apiPipeline.js';
import BrailleSpinner from '../../BrailleSpinner';
import DraftNumber from '../../ui/DraftNumber';
import FilePickerButton from '../../ui/FilePickerButton';
import ListLoadError from '../../ui/ListLoadError';
import toast from '../../ui/Toast';
import { generatorUnavailableReason } from './audioGeneratorReadiness.js';

export default function AudioMusicSection({ issueId, music, generatorStatus, onStageUpdate }) {
  const { generators, generatorsError, genEngines, loadGenerators } = generatorStatus;
  const [musicLibrary, setMusicLibrary] = useState(null);
  const [musicLibraryLoading, setMusicLibraryLoading] = useState(false);
  const [musicLibraryError, setMusicLibraryError] = useState(null);
  const [musicPickerOpen, setMusicPickerOpen] = useState(false);
  const [musicUploading, setMusicUploading] = useState(false);
  const [musicAttaching, setMusicAttaching] = useState(null);
  // Inline confirm-row pattern per the user's preference: clicking trash
  // reveals [Cancel] [Delete] for that row only. Stored as the filename so
  // only one row shows the confirm at a time.
  const [pendingLibraryDelete, setPendingLibraryDelete] = useState(null);

  // Local-OSS music generation (Phase 4c.2). The generators list is fetched
  // when the panel opens or the stage shows generated cues.
  const [genPanelOpen, setGenPanelOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genPrompt, setGenPrompt] = useState('');
  const [durationOverride, setGenDuration] = useState(null);
  const [genModelId, setGenModelId] = useState('');
  const [genEngineId, setGenEngineId] = useState('');

  const defaultEngine = genEngines.find((engine) => engine.id === generators?.defaultEngine) ?? genEngines[0];
  const activeEngine = genEngines.find((engine) => engine.id === genEngineId) ?? defaultEngine;
  const selectedModelId = genModelId || activeEngine?.defaultModelId
    || (!genEngineId && (generators?.defaultModelId || generators?.models?.[0]?.id))
    || activeEngine?.models?.[0]?.id;
  const activeEngineReason = generatorUnavailableReason(activeEngine, selectedModelId);
  const defaultDuration = defaultEngine?.defaultDurationSec ?? generators?.defaultDurationSec;
  const genDuration = durationOverride ?? (Number.isFinite(defaultDuration) ? defaultDuration : 12);

  const openGenPanel = async () => {
    setGenPanelOpen(true);
    await loadGenerators();
  };

  // Switching engine re-anchors the model + duration to the new backend's
  // defaults so a stale model id (valid only on the prior engine) can't be sent.
  const handleEngineChange = (engineId) => {
    setGenEngineId(engineId);
    const engine = genEngines.find((e) => e.id === engineId);
    if (engine) {
      setGenModelId(engine.defaultModelId || engine.models?.[0]?.id || '');
      if (Number.isFinite(engine.defaultDurationSec)) setGenDuration(engine.defaultDurationSec);
    }
  };

  const handleGenerateMusic = async () => {
    if (activeEngineReason) return;
    if (!genPrompt.trim()) { toast.error('Describe the music you want first'); return; }
    setGenerating(true);
    // Owns its own error toast → silent so the helper doesn't double-toast.
    const result = await generatePipelineMusic(
      issueId,
      { prompt: genPrompt, engine: activeEngine.id, durationSec: genDuration, modelId: selectedModelId },
      { silent: true },
    ).catch((err) => {
      toast.error(err.message || 'Music generation failed');
      return null;
    });
    setGenerating(false);
    if (!result) return;
    onStageUpdate?.('audio', result.stage, result.issue);
    setGenPanelOpen(false);
    toast.success(`Generated ${result.durationSec ?? genDuration}s track (${result.modelId})`);
  };

  const loadMusicLibrary = async () => {
    if (musicLibraryLoading) return;
    setMusicLibraryError(null);
    setMusicLibraryLoading(true);
    try {
      const response = await listPipelineMusicLibrary({ silent: true });
      if (!Array.isArray(response?.tracks)) throw new Error('Invalid music library response');
      setMusicLibrary(response.tracks);
    } catch (err) {
      setMusicLibraryError(err instanceof Error ? err : new Error('Music library request failed'));
    } finally {
      setMusicLibraryLoading(false);
    }
  };

  const openMusicPicker = async () => {
    setMusicPickerOpen(true);
    if (musicLibrary === null) await loadMusicLibrary();
  };

  const handleMusicUpload = async (file) => {
    if (!file) return;
    setMusicUploading(true);
    // Owns its own error UI (toast.error below) so suppress the helper's toast
    // — per AGENTS.md "custom catch ⇒ silent: true" convention.
    const result = await uploadPipelineMusicTrack(issueId, file, {}, { silent: true }).catch((err) => {
      toast.error(err.message || 'Upload failed');
      return null;
    });
    setMusicUploading(false);
    if (!result) return;
    onStageUpdate?.('audio', result.stage, result.issue);
    setMusicLibrary(null);
    setMusicPickerOpen(false);
    toast.success(`Uploaded ${file.name}`);
  };

  const handleAttach = async (track) => {
    setMusicAttaching(track.filename);
    const result = await attachPipelineMusicTrack(issueId, { trackFilename: track.filename, label: track.label }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Attach failed');
      return null;
    });
    setMusicAttaching(null);
    if (!result) return;
    onStageUpdate?.('audio', result.stage, result.issue);
    setMusicPickerOpen(false);
    toast.success(`Attached ${track.label || track.filename}`);
  };

  const handleDetach = async () => {
    const result = await detachPipelineMusicTrack(issueId, { silent: true }).catch((err) => {
      toast.error(err.message || 'Detach failed');
      return null;
    });
    if (!result) return;
    onStageUpdate?.('audio', result.stage, result.issue);
    toast.success('Removed music from this issue');
  };

  const handleLibraryDelete = async (filename) => {
    setPendingLibraryDelete(null);
    const result = await deletePipelineMusicTrack(filename, { silent: true }).catch((err) => {
      toast.error(err.message || 'Delete failed');
      return null;
    });
    if (!result) return;
    setMusicLibrary((prev) => (prev || []).filter((t) => t.filename !== filename));
    toast.success(`Removed ${filename} from library`);
  };

  return (
    <section className="pt-4 border-t border-port-border">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-3">
        <div className="flex items-center gap-3">
          <Music className="w-5 h-5 text-port-accent" />
          <div>
            <h3 className="text-base font-semibold text-white">Background Music</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Optional track played under the rendered episode — ducked beneath dialogue in the final cut.
              {' '}<span className="text-gray-600">Upload, pick from the library, or generate locally with MusicGen.</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <FilePickerButton
            accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/m4a,audio/ogg,audio/flac,.mp3,.wav,.m4a,.ogg,.flac"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleMusicUpload(file);
            }}
            disabled={musicUploading}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50"
          >
            {musicUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            Upload track
          </FilePickerButton>
          <button
            type="button"
            onClick={() => (musicPickerOpen ? setMusicPickerOpen(false) : openMusicPicker())}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50"
          >
            <Music size={14} />
            {musicPickerOpen ? 'Close library' : 'Pick from library'}
          </button>
          <button
            type="button"
            onClick={() => (genPanelOpen ? setGenPanelOpen(false) : openGenPanel())}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50"
          >
            <Wand2 size={14} />
            {genPanelOpen ? 'Close generator' : 'Generate music'}
          </button>
        </div>
      </div>

      {genPanelOpen ? (
        <div className="mb-3 p-3 bg-port-bg border border-port-border rounded-lg">
          {generatorsError ? (
            <p className="flex items-center gap-2 text-xs text-port-error">
              Couldn’t check the music engine.
              <button
                type="button"
                onClick={() => void loadGenerators(true)}
                className="rounded border border-port-border px-2 py-0.5 text-gray-300 hover:border-port-accent/50"
              >
                Retry
              </button>
            </p>
          ) : generators === null ? (
            <p className="text-xs text-gray-500">Loading generators…</p>
          ) : (
            <div className="space-y-3">
              {genEngines.length > 1 ? (
                <div>
                  <label htmlFor="music-engine" className="block text-xs text-gray-400 mb-1">Engine</label>
                  <select
                    id="music-engine"
                    value={activeEngine?.id || ''}
                    onChange={(e) => handleEngineChange(e.target.value)}
                    className="max-w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
                  >
                    {genEngines.map((eng) => (
                      <option key={eng.id} value={eng.id}>
                        {eng.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {activeEngineReason ? (
                <p className="text-xs text-port-warning">
                  {musicEngineReadinessMessage(activeEngine, activeEngineReason)}
                  {activeEngineReason === 'runtime-unavailable' && activeEngine.installEnv ? (
                    <> Run <code className="text-gray-300">{activeEngine.installEnv}=1 bash scripts/setup-image-video.sh</code> to install its runtime.</>
                  ) : null}
                </p>
              ) : null}
              {activeEngine ? (
                <>
                  <div>
                    <label htmlFor="musicgen-prompt" className="block text-xs text-gray-400 mb-1">Describe the music</label>
                    <textarea
                      id="musicgen-prompt"
                      value={genPrompt}
                      onChange={(e) => setGenPrompt(e.target.value)}
                      rows={2}
                      maxLength={800}
                      placeholder="e.g. tense cinematic synth pad, slow build, minor key"
                      className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
                    />
                  </div>
                  <div className="flex items-end gap-3 flex-wrap">
                    <div>
                      <label htmlFor="musicgen-model" className="block text-xs text-gray-400 mb-1">Model</label>
                      <select
                        id="musicgen-model"
                        value={selectedModelId || ''}
                        onChange={(e) => setGenModelId(e.target.value)}
                        className="max-w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
                      >
                        {(activeEngine.models || []).map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="musicgen-duration" className="block text-xs text-gray-400 mb-1">
                        Length (s)
                      </label>
                      <DraftNumber min={activeEngine.minDurationSec ?? 1} max={activeEngine.maxDurationSec ?? 30} value={genDuration} onCommit={setGenDuration}>
                        {(field) => <input type="number" id="musicgen-duration" step="1" className="w-24 px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm" {...field} />}
                      </DraftNumber>
                    </div>
                    <button
                      type="button"
                      onClick={handleGenerateMusic}
                      disabled={generating || !!activeEngineReason || !genPrompt.trim()}
                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm disabled:opacity-50"
                    >
                      {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                      {generating ? 'Generating…' : 'Generate'}
                    </button>
                  </div>
                  <p className="text-[11px] text-gray-600">
                    Runs on-device — up to {activeEngine.maxDurationSec ?? 30}s. The track lands in your music library and is attached to this issue.
                  </p>
                </>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {music ? (
        <div className="p-3 bg-port-card border border-port-border rounded-lg">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-white truncate">
                  {music.label || music.trackFilename}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-gray-500">
                  {music.source || 'unknown'}
                </span>
              </div>
              {music.trackFilename ? (
                <audio
                  controls
                  src={`/data/music/${encodeURIComponent(music.trackFilename)}`}
                  className="w-full max-w-md"
                >
                  <track kind="captions" />
                </audio>
              ) : null}
            </div>
            <button
              type="button"
              onClick={handleDetach}
              title="Remove music from this issue (track stays in the library)"
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-port-error border border-port-border hover:border-port-error/50"
            >
              <Trash2 size={12} /> Remove
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-400 italic">
          No background music attached. Upload a track or pick one from the library.
        </p>
      )}

      {musicPickerOpen ? (
        <div className="mt-3 p-3 bg-port-bg border border-port-border rounded-lg">
          <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">Library</div>
          {musicLibraryError ? (
            <ListLoadError what="music library" error={musicLibraryError} onRetry={loadMusicLibrary} />
          ) : musicLibrary === null || musicLibraryLoading ? (
            <p className="text-xs"><BrailleSpinner text="Loading…" /></p>
          ) : musicLibrary.length === 0 ? (
            <p className="text-xs text-gray-500 italic">
              Library is empty. Click <strong>Upload track</strong> above to add your first one.
            </p>
          ) : (
            <ul className="space-y-1.5 max-h-80 overflow-y-auto">
              {musicLibrary.map((track) => {
                const isCurrent = music?.trackFilename === track.filename;
                const isAttaching = musicAttaching === track.filename;
                const confirming = pendingLibraryDelete === track.filename;
                return (
                  <li key={track.filename} className="flex flex-wrap items-center gap-2 p-2 bg-port-card border border-port-border rounded">
                    <div className="min-w-0 flex-1 basis-40">
                      <div className="text-sm text-white truncate">{track.label || track.filename}</div>
                      <div className="text-[10px] text-gray-500 font-mono [overflow-wrap:anywhere]">{track.filename}</div>
                    </div>
                    {confirming ? (
                      <>
                        <span className="text-xs text-gray-400 italic">Delete from library?</span>
                        <button
                          type="button"
                          onClick={() => setPendingLibraryDelete(null)}
                          className="px-2 py-1 rounded border border-port-border text-gray-300 text-xs hover:border-gray-500"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => handleLibraryDelete(track.filename)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-port-error text-white text-xs"
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => handleAttach(track)}
                          disabled={isCurrent || isAttaching}
                          title={isCurrent ? 'Already attached to this issue' : 'Attach to this issue'}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-port-accent text-white text-xs disabled:opacity-50"
                        >
                          {isAttaching ? <Loader2 size={12} className="animate-spin" /> : null}
                          {isCurrent ? 'Attached' : 'Attach'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingLibraryDelete(track.filename)}
                          title="Delete from library (issues that point at this file will fail playback)" aria-label="Delete from library (issues that point at this file will fail playback)"
                          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-port-border text-gray-400 hover:text-port-error hover:border-port-error/50"
                        >
                          <Trash2 size={12} />
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
