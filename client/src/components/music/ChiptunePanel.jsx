/**
 * ChiptunePanel (#2911) — prompt-based looping 8-bit score generation for the
 * Track editor. The user picks any configured AI provider/model, describes the
 * music, and gets a structured chiptune score persisted on the track. The
 * score previews as a seamless in-browser loop (chiptunePlayback.js), renders
 * into the track's history as an OGG loop, and publishes into a managed app's
 * repo (default `game/assets/music/`) as game-ready assets.
 *
 * Sibling of MusicGenPanel (the diffusion engines) — TracksManager toggles
 * between the two. Provider/model + publish prefs persist in
 * `settings.music.chiptune` so the next session starts where this one left off.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Wand2, Play, Square, Disc3, Gamepad2 } from 'lucide-react';
import toast from '../ui/Toast';
import useProviderModels from '../../hooks/useProviderModels';
import ProviderModelSelector from '../ProviderModelSelector';
import { buildChiptuneSchedule, createChiptunePlayer } from '../../lib/chiptunePlayback.js';
import {
  generateTrackChiptune, renderTrackChiptune, publishTrackChiptune,
  getApps, getSettings, updateSettings,
} from '../../services/api';

const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const DEFAULT_SUBDIR = 'game/assets/music';

export default function ChiptunePanel({ track, onTrackUpdate, remix }) {
  const [prompt, setPrompt] = useState(track?.chiptunePrompt || '');
  const [fresh, setFresh] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [apps, setApps] = useState([]);
  const [publishAppId, setPublishAppId] = useState('');
  const [publishSubdir, setPublishSubdir] = useState(DEFAULT_SUBDIR);
  const [publishSlug, setPublishSlug] = useState('');
  const [publishedFiles, setPublishedFiles] = useState(null);
  // Saved provider/model pin, held until the provider list has loaded — the
  // hook auto-selects a default when its list arrives, so applying the pin
  // immediately would race that load and be nondeterministically overwritten.
  const [savedPin, setSavedPin] = useState(null);
  const musicSettingsRef = useRef({});
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading: providersLoading,
  } = useProviderModels({ silent: true });

  const score = track?.chiptuneScore || null;
  // The player re-reads this ref on every play, so a regeneration is heard
  // without rebuilding the player instance.
  const scoreRef = useRef(score);
  scoreRef.current = score;
  const playerRef = useRef(null);
  if (!playerRef.current) {
    playerRef.current = createChiptunePlayer(() => scoreRef.current);
  }

  // Stop playback when the selected track changes or the panel unmounts.
  useEffect(() => () => { playerRef.current?.stop(); setPlaying(false); }, [track?.id]);

  // Reseed the prompt + publish slug from the newly-selected track.
  useEffect(() => {
    setPrompt(track?.chiptunePrompt || '');
    setFresh(false);
    setPublishedFiles(null);
    setPublishSlug(slugify(track?.title));
  }, [track?.id]);

  // Remix from a chiptune take: seed the panel prompt with the take's prompt.
  // Keyed on the nonce so re-remixing the same take re-applies.
  useEffect(() => {
    if (remix?.prompt) setPrompt(remix.prompt);
  }, [remix?.nonce, remix?.prompt]);

  // Load saved prefs once. Publish prefs apply immediately; the provider pin
  // is parked in `savedPin` and applied by the effect below only after the
  // provider list has loaded.
  useEffect(() => {
    getSettings({ silent: true }).then((settings) => {
      if (!mountedRef.current) return;
      const music = settings?.music || {};
      musicSettingsRef.current = music;
      const saved = music.chiptune || {};
      if (saved.providerId) setSavedPin({ providerId: saved.providerId, model: saved.model || '' });
      if (saved.publishAppId) setPublishAppId(saved.publishAppId);
      if (saved.publishSubdir) setPublishSubdir(saved.publishSubdir);
    }).catch(() => {});
  }, []);

  // Apply the saved provider pin once providers are loaded (a stale saved id
  // that no longer exists degrades to the hook's own default selection).
  useEffect(() => {
    if (!savedPin || providersLoading || !providers.length) return;
    if (providers.some((p) => p.id === savedPin.providerId)) {
      setSelectedProviderId(savedPin.providerId);
      if (savedPin.model) setSelectedModel(savedPin.model);
    }
    setSavedPin(null); // apply once
  }, [savedPin, providersLoading, providers, setSelectedProviderId, setSelectedModel]);

  const summary = useMemo(() => {
    if (!score) return null;
    const { totalSec } = buildChiptuneSchedule(score);
    return {
      title: score.title || 'Untitled loop',
      bpm: score.bpm,
      patterns: Object.keys(score.patterns || {}).length,
      order: (score.order || []).join(' '),
      seconds: Math.round(totalSec * 10) / 10,
    };
  }, [score]);

  const persistChiptunePrefs = (patch) => {
    const music = musicSettingsRef.current;
    const next = { ...music, chiptune: { ...(music.chiptune || {}), ...patch } };
    musicSettingsRef.current = next;
    updateSettings({ music: next }, { silent: true }).catch(() => {});
  };

  const handleGenerate = async () => {
    if (!track?.id) { toast.error('Save the track first, then generate'); return; }
    if (!prompt.trim()) { toast.error('Describe the music first'); return; }
    if (!selectedProviderId) { toast.error('Pick an AI provider first'); return; }
    setGenerating(true);
    const res = await generateTrackChiptune(track.id, {
      prompt: prompt.trim(),
      providerId: selectedProviderId,
      model: selectedModel || undefined,
      ...(fresh ? { fresh: true } : {}),
    }, { silent: true }).catch((err) => { toast.error(err.message || 'Generation failed'); return null; });
    if (!mountedRef.current) return;
    setGenerating(false);
    if (res?.track) {
      onTrackUpdate?.(res.track);
      setFresh(false);
      persistChiptunePrefs({ providerId: selectedProviderId, model: selectedModel || '' });
      toast.success(score ? 'Score revised' : 'Score composed');
    }
  };

  const togglePlay = async () => {
    if (playerRef.current.isPlaying()) {
      playerRef.current.stop();
      setPlaying(false);
      return;
    }
    setPlaying(true);
    await playerRef.current.play();
    if (mountedRef.current && !playerRef.current.isPlaying()) setPlaying(false);
  };

  const handleRender = async () => {
    if (playerRef.current.isPlaying()) { playerRef.current.stop(); setPlaying(false); }
    setRendering(true);
    const res = await renderTrackChiptune(track.id, { silent: true })
      .catch((err) => { toast.error(err.message || 'Render failed'); return null; });
    if (!mountedRef.current) return;
    setRendering(false);
    if (res?.track) {
      onTrackUpdate?.(res.track);
      toast.success(`Loop rendered (${res.durationSec}s)`);
    }
  };

  const openPublish = async () => {
    setPublishedFiles(null);
    if (!publishOpen && apps.length === 0) {
      const list = await getApps({ silent: true }).catch(() => []);
      if (!mountedRef.current) return;
      // Publishable targets are managed apps with a repo on disk — PortOS
      // itself is excluded (its repo is not a game asset destination).
      setApps((Array.isArray(list) ? list : []).filter((a) => a.repoPath && a.id !== 'portos-default' && !a.archived));
    }
    setPublishOpen((o) => !o);
  };

  const handlePublish = async () => {
    if (!publishAppId) { toast.error('Pick a target app first'); return; }
    setPublishing(true);
    const res = await publishTrackChiptune(track.id, {
      appId: publishAppId,
      subdir: publishSubdir.trim() || undefined,
      slug: publishSlug.trim() || undefined,
    }, { silent: true }).catch((err) => { toast.error(err.message || 'Publish failed'); return null; });
    if (!mountedRef.current) return;
    setPublishing(false);
    if (res) {
      setPublishedFiles(res);
      persistChiptunePrefs({ publishAppId, publishSubdir: publishSubdir.trim() || DEFAULT_SUBDIR });
      toast.success(`Published to ${res.appName}`);
    }
  };

  const canGenerate = !!track?.id && !!prompt.trim() && !!selectedProviderId && !generating;

  return (
    <div className="space-y-2 border border-port-border rounded-lg p-3 bg-port-bg/40">
      <div className="flex items-center gap-2 text-sm text-gray-300">
        <Gamepad2 size={14} className="text-port-accent" /> Chiptune score — looping 8-bit background music
      </div>

      <label className="block">
        <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Describe the music</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          maxLength={8000}
          placeholder="Upbeat farm-chores theme — bouncy melody, walking bass, light hats, loops every 20s."
          className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
        />
      </label>

      <ProviderModelSelector
        providers={providers}
        selectedProviderId={selectedProviderId}
        selectedModel={selectedModel}
        availableModels={availableModels}
        onProviderChange={setSelectedProviderId}
        onModelChange={setSelectedModel}
        label="AI provider"
        layout="row"
      />

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!canGenerate}
          title={!track?.id ? 'Save the track first' : !prompt.trim() ? 'Describe the music first' : score && !fresh ? 'Revise the current score' : 'Compose a new score'}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
          {generating ? 'Composing…' : score && !fresh ? 'Revise score' : 'Compose score'}
        </button>
        {score ? (
          <label className="inline-flex items-center gap-1.5 text-xs text-gray-400">
            <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />
            Start fresh (ignore current score)
          </label>
        ) : null}
      </div>

      {summary ? (
        <div className="space-y-2 pt-2 border-t border-port-border/60">
          <div className="text-xs text-gray-400">
            <span className="text-white">{summary.title}</span>
            {' — '}{summary.bpm} BPM · {summary.patterns} pattern{summary.patterns === 1 ? '' : 's'} · order {summary.order} · ~{summary.seconds}s loop
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={togglePlay}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent"
            >
              {playing ? <Square size={14} /> : <Play size={14} />}
              {playing ? 'Stop' : 'Preview loop'}
            </button>
            <button
              type="button"
              onClick={handleRender}
              disabled={rendering}
              title="Render the loop to audio and add it to this track's renders"
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent disabled:opacity-50"
            >
              {rendering ? <Loader2 size={14} className="animate-spin" /> : <Disc3 size={14} />}
              {rendering ? 'Rendering…' : 'Render take'}
            </button>
            <button
              type="button"
              onClick={openPublish}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-bg border border-port-border text-white text-sm hover:border-port-accent"
            >
              <Gamepad2 size={14} /> Publish to app…
            </button>
          </div>

          {publishOpen ? (
            <div className="space-y-2 border border-port-border rounded-lg p-2 bg-port-bg">
              {apps.length === 0 ? (
                <p className="text-xs text-gray-500">No managed apps with a repo path — add the game app under Apps first.</p>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label className="block">
                      <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Target app</span>
                      <select
                        value={publishAppId}
                        onChange={(e) => setPublishAppId(e.target.value)}
                        className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
                      >
                        <option value="">— pick an app —</option>
                        {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Filename slug</span>
                      <input
                        value={publishSlug}
                        onChange={(e) => setPublishSlug(e.target.value)}
                        placeholder={slugify(track?.title) || 'track'}
                        className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
                      />
                    </label>
                  </div>
                  <label className="block">
                    <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Folder inside the app repo</span>
                    <input
                      value={publishSubdir}
                      onChange={(e) => setPublishSubdir(e.target.value)}
                      placeholder={DEFAULT_SUBDIR}
                      className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handlePublish}
                    disabled={publishing || !publishAppId}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
                  >
                    {publishing ? <Loader2 size={14} className="animate-spin" /> : <Gamepad2 size={14} />}
                    {publishing ? 'Publishing…' : 'Publish loop'}
                  </button>
                </>
              )}
              {publishedFiles ? (
                <div className="text-[11px] text-gray-400 space-y-0.5">
                  <p className="text-port-success">Published to {publishedFiles.appName}:</p>
                  {publishedFiles.files.map((f) => <p key={f} className="font-mono truncate">{f}</p>)}
                  <p>{publishedFiles.note}</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-[11px] text-gray-500">
          No score yet — describe the vibe and compose. The score previews as a seamless loop, renders to audio, and publishes straight into a managed game app.
        </p>
      )}
    </div>
  );
}
