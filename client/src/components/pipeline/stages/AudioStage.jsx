/**
 * Audio stage — voice-over rendering for an issue's dialogue lines.
 *
 * Source of truth: stages.audio.lines[] (server-extracted from
 * storyboards.scenes[].dialogue). Each line carries a character binding,
 * the line text, an optional per-line voice override, and the rendered
 * audio filename (under /data/audio/...).
 *
 * Voice resolution priority (server-side per render): line.voiceIdOverride
 * > character.voiceId > project default. Local OSS (Kokoro/Piper) is always
 * available; 3rd-party engines extend through the same namespace.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, Wand2, Mic, Music, Upload, Trash2 } from 'lucide-react';
import toast from '../../ui/Toast';
import VoicePicker from '../../voice/VoicePicker';
import {
  extractPipelineAudioLines,
  renderPipelineAudioLine,
  patchPipelineAudioLine,
  listPipelineMusicLibrary,
  uploadPipelineMusicTrack,
  attachPipelineMusicTrack,
  detachPipelineMusicTrack,
  deletePipelineMusicTrack,
  listPipelineMusicGenerators,
  generatePipelineMusic,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGE_STATUS_LABEL as STATUS_LABEL,
  PIPELINE_STAGE_STATUS_COLOR as STATUS_COLOR,
} from '../../../services/api';

export default function AudioStage({ issue, onStageUpdate }) {
  const stage = issue.stages?.audio || { status: 'empty', lines: [], music: null };
  const lines = Array.isArray(stage.lines) ? stage.lines : [];
  const music = stage.music || null;
  const [extracting, setExtracting] = useState(false);
  // Per-line render busy state keyed by line index — multiple lines can
  // render concurrently with independent spinners.
  const [renderingLines, setRenderingLines] = useState(() => new Set());
  // Per-line edit drafts so the textarea reflects in-flight keystrokes
  // even though we PATCH only on blur (or before render).
  const [drafts, setDrafts] = useState({});
  // Pending PATCH promises by line index so handleRender can await every
  // outstanding save before kicking off the synth (CLAUDE.md "In-flight
  // saves must gate dependent actions"). Refs not state — we never
  // re-render because of this and we want the latest value inside async
  // handlers. Stored as `Map<lineIdx, Set<Promise>>` because a single
  // line can have BOTH a text-blur save AND a voice-override save in
  // flight simultaneously (textarea blur, then pick a voice, then click
  // Render — both PATCHes overlap). The set drops each promise on
  // settle; handleRender Promise.all's the snapshot of whatever's
  // outstanding at the moment of call.
  const pendingSavesRef = useRef(new Map());

  // Two-click arm pattern (no window.confirm) for the destructive
  // re-extract path. First click flips the label; second click within 5s
  // commits the replace.
  const [extractArmed, setExtractArmed] = useState(false);
  const armTimerRef = useRef(null);
  useEffect(() => () => {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
  }, []);

  const [musicLibrary, setMusicLibrary] = useState(null);
  const [musicLibraryLoading, setMusicLibraryLoading] = useState(false);
  const [musicPickerOpen, setMusicPickerOpen] = useState(false);
  const [musicUploading, setMusicUploading] = useState(false);
  const [musicAttaching, setMusicAttaching] = useState(null);
  // Inline confirm-row pattern per the user's preference: clicking trash
  // reveals [Cancel] [Delete] for that row only. Stored as the filename so
  // only one row shows the confirm at a time.
  const [pendingLibraryDelete, setPendingLibraryDelete] = useState(null);
  const fileInputRef = useRef(null);

  // Local-OSS music generation (Phase 4c.2). The generators list is fetched
  // lazily when the user opens the Generate panel; `ready` gates the prompt box
  // behind an install hint so a 503 never surprises them mid-prompt.
  const [genPanelOpen, setGenPanelOpen] = useState(false);
  const [generators, setGenerators] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [genPrompt, setGenPrompt] = useState('');
  const [genDuration, setGenDuration] = useState(12);
  const [genModelId, setGenModelId] = useState('');

  // Per-line VO start-offset drafts (seconds into the stitched episode). Kept
  // separate from text drafts; committed on blur via the same patch queue.
  const [offsetDrafts, setOffsetDrafts] = useState({});

  const openGenPanel = async () => {
    setGenPanelOpen(true);
    if (generators === null) {
      // Owns its own error toast → silent so the helper doesn't double-toast.
      const result = await listPipelineMusicGenerators({ silent: true }).catch((err) => {
        toast.error(err.message || 'Failed to load generators');
        return null;
      });
      if (result) {
        setGenerators(result);
        setGenModelId((prev) => prev || result.defaultModelId || result.models?.[0]?.id || '');
        if (Number.isFinite(result.defaultDurationSec)) setGenDuration(result.defaultDurationSec);
      }
    }
  };

  const handleGenerateMusic = async () => {
    const prompt = genPrompt.trim();
    if (!prompt) { toast.error('Describe the music you want first'); return; }
    setGenerating(true);
    // Owns its own error toast → silent so the helper doesn't double-toast.
    const result = await generatePipelineMusic(
      issue.id,
      { prompt, durationSec: genDuration, modelId: genModelId || undefined },
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
    setMusicLibraryLoading(true);
    const result = await listPipelineMusicLibrary().catch((err) => {
      toast.error(err.message || 'Failed to load music library');
      return null;
    });
    setMusicLibraryLoading(false);
    if (result) setMusicLibrary(result.tracks || []);
  };

  const openMusicPicker = async () => {
    setMusicPickerOpen(true);
    if (musicLibrary === null) await loadMusicLibrary();
  };

  const handleMusicUpload = async (file) => {
    if (!file) return;
    setMusicUploading(true);
    // Owns its own error UI (toast.error below) so suppress the helper's toast
    // — per CLAUDE.md "custom catch ⇒ silent: true" convention.
    const result = await uploadPipelineMusicTrack(issue.id, file, {}, { silent: true }).catch((err) => {
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
    const result = await attachPipelineMusicTrack(issue.id, { trackFilename: track.filename, label: track.label }).catch((err) => {
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
    const result = await detachPipelineMusicTrack(issue.id).catch((err) => {
      toast.error(err.message || 'Detach failed');
      return null;
    });
    if (!result) return;
    onStageUpdate?.('audio', result.stage, result.issue);
    toast.success('Removed music from this issue');
  };

  const handleLibraryDelete = async (filename) => {
    setPendingLibraryDelete(null);
    const result = await deletePipelineMusicTrack(filename).catch((err) => {
      toast.error(err.message || 'Delete failed');
      return null;
    });
    if (!result) return;
    setMusicLibrary((prev) => (prev || []).filter((t) => t.filename !== filename));
    toast.success(`Removed ${filename} from library`);
  };

  const storyboardSceneCount = (issue.stages?.storyboards?.scenes || []).length;
  const canExtract = storyboardSceneCount > 0;

  const handleExtract = async () => {
    if (!canExtract) {
      toast.error('Generate Storyboards first — audio lines come from the dialogue extracted there.');
      return;
    }
    const needsConfirm = lines.length > 0;
    if (needsConfirm && !extractArmed) {
      setExtractArmed(true);
      toast.warning(`This will replace ${lines.length} existing line${lines.length === 1 ? '' : 's'} (rendered audio is preserved for unchanged lines). Click again to confirm.`);
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      armTimerRef.current = setTimeout(() => {
        armTimerRef.current = null;
        setExtractArmed(false);
      }, 5000);
      return;
    }
    if (armTimerRef.current) { clearTimeout(armTimerRef.current); armTimerRef.current = null; }
    setExtractArmed(false);
    setExtracting(true);
    const result = await extractPipelineAudioLines(issue.id, { force: needsConfirm }).catch((err) => {
      toast.error(err.message || 'Extract failed');
      return null;
    });
    setExtracting(false);
    if (!result) return;
    onStageUpdate?.('audio', result.stage, result.issue);
    setDrafts({});
    setOffsetDrafts({});
    const preserved = result.preservedCount || 0;
    if (preserved > 0) {
      toast.success(`Extracted ${result.lineCount} line${result.lineCount === 1 ? '' : 's'} · preserved ${preserved} rendered`);
    } else {
      toast.success(`Extracted ${result.lineCount} line${result.lineCount === 1 ? '' : 's'}`);
    }
  };

  // Per-line patch (text edit OR voice override). Registers the in-flight
  // Promise in `pendingSavesRef` so handleRender can await it before firing
  // the synth request — the server resolves character.voiceId /
  // line.voiceIdOverride at render time, so a render fired before any
  // outstanding PATCH settles could synth against stale state.
  const saveLinePatch = (lineIdx, patch) => {
    const set = pendingSavesRef.current.get(lineIdx) || new Set();
    if (!pendingSavesRef.current.has(lineIdx)) pendingSavesRef.current.set(lineIdx, set);
    const promise = patchPipelineAudioLine(issue.id, lineIdx, patch)
      .then((updated) => {
        if (updated) onStageUpdate?.('audio', updated.stage, updated.issue);
        return updated;
      })
      .catch((err) => { toast.error(err.message || 'Save failed'); return null; })
      .finally(() => {
        set.delete(promise);
        if (set.size === 0) pendingSavesRef.current.delete(lineIdx);
      });
    set.add(promise);
    return promise;
  };

  const handleBlur = (lineIdx) => {
    const draft = drafts[lineIdx];
    if (draft === undefined) return;
    if (draft === (lines[lineIdx]?.text || '')) {
      // No actual change — drop the draft so the textarea reflects server state.
      setDrafts((prev) => { const next = { ...prev }; delete next[lineIdx]; return next; });
      return;
    }
    void saveLinePatch(lineIdx, { text: draft });
    setDrafts((prev) => { const next = { ...prev }; delete next[lineIdx]; return next; });
  };

  // Voice override change. `voiceId: null` clears the override so the line
  // falls back to the canon character voice (or project default).
  const handleVoiceOverride = (lineIdx, voiceId) => {
    void saveLinePatch(lineIdx, { voiceIdOverride: voiceId });
  };

  // Commit a per-line start-offset edit. Empty input clears the placement
  // (null → muxer skips the line); a valid non-negative number positions it.
  // Invalid input is dropped silently so the field reverts to server state.
  const handleOffsetBlur = (lineIdx) => {
    const draft = offsetDrafts[lineIdx];
    if (draft === undefined) return;
    const dropDraft = () => setOffsetDrafts((prev) => { const next = { ...prev }; delete next[lineIdx]; return next; });
    const current = Number.isFinite(lines[lineIdx]?.offsetSec) ? lines[lineIdx].offsetSec : null;
    const trimmed = String(draft).trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) { dropDraft(); return; }
    if (parsed === current) { dropDraft(); return; }
    void saveLinePatch(lineIdx, { offsetSec: parsed });
    dropDraft();
  };

  const handleRender = async (lineIdx) => {
    // Snapshot + await every outstanding PATCH for this line — both text
    // and voice-override saves can be in flight at once (e.g. textarea
    // blur fires, then the user picks a voice, then clicks Render). The
    // synth resolves text + voice at render time on the server, so a
    // missed save would synth against stale state.
    const pendingSet = pendingSavesRef.current.get(lineIdx);
    if (pendingSet && pendingSet.size > 0) await Promise.all([...pendingSet]);
    // If the textarea still has an unflushed draft (user clicked Render
    // without losing focus), flush it now and await.
    const draftBeforeRender = drafts[lineIdx];
    if (draftBeforeRender !== undefined && draftBeforeRender !== (lines[lineIdx]?.text || '')) {
      await saveLinePatch(lineIdx, { text: draftBeforeRender });
      setDrafts((prev) => { const next = { ...prev }; delete next[lineIdx]; return next; });
    }

    setRenderingLines((prev) => new Set(prev).add(lineIdx));
    const result = await renderPipelineAudioLine(issue.id, lineIdx).catch((err) => {
      toast.error(err.message || 'Render failed');
      return null;
    });
    setRenderingLines((prev) => {
      const next = new Set(prev);
      next.delete(lineIdx);
      return next;
    });
    if (!result) return;
    if (result.issue) onStageUpdate?.('audio', result.issue.stages.audio, result.issue);
    toast.success(`Rendered line ${lineIdx + 1} (${result.engine})`);
  };

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Mic className="w-5 h-5 text-port-accent" />
          <div>
            <h2 className="text-lg font-semibold text-white">{PIPELINE_STAGE_LABELS.audio}</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Voice-over per dialogue line. Picks each character's bound voice; falls back to project default.
              {' '}<span className="text-gray-600">Local OSS (Kokoro / Piper) always available.</span>
            </p>
          </div>
          <span className={`text-[10px] uppercase tracking-wider ${STATUS_COLOR[stage.status] || 'text-gray-500'}`}>
            {STATUS_LABEL[stage.status] || stage.status}
          </span>
          {lines.length > 0 ? (
            <span className="text-xs text-gray-500">{lines.length} line{lines.length === 1 ? '' : 's'}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExtract}
            disabled={extracting || !canExtract}
            title={canExtract
              ? (lines.length > 0
                ? 'Replace lines with a fresh extraction from storyboards (rendered audio carried forward for unchanged lines)'
                : 'Walk storyboards dialogue and create one VO line per spoken line')
              : 'Generate Storyboards first — audio lines come from the dialogue extracted there'}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-40"
          >
            {extracting ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            {extractArmed
              ? 'Click again to replace'
              : (lines.length > 0 ? 'Re-extract from storyboards' : 'Extract lines from storyboards')}
          </button>
        </div>
      </header>

      {lines.length === 0 ? (
        <p className="text-sm text-gray-400 italic">
          {canExtract
            ? 'No lines yet. Click Extract above to pull dialogue from the storyboards stage.'
            : 'Generate the Storyboards stage first — the dialogue lines there populate this table.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {lines.map((line, i) => {
            const isRendering = renderingLines.has(i);
            const draft = drafts[i];
            const textValue = draft !== undefined ? draft : (line.text || '');
            return (
              <li key={line.id || i} className="p-3 bg-port-card border border-port-border rounded-lg">
                <div className="flex items-start gap-3">
                  <span className="text-[10px] text-gray-500 font-mono pt-1.5 w-8">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs uppercase tracking-wider text-port-accent font-medium">
                        {line.characterName || '(unattributed)'}
                      </span>
                      {line.characterId ? null : (
                        <span
                          className="text-[10px] text-gray-500 italic"
                          title="No matching character in the series bible — will use project default voice"
                        >
                          unbound
                        </span>
                      )}
                    </div>
                    <textarea
                      value={textValue}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [i]: e.target.value }))}
                      onBlur={() => handleBlur(i)}
                      rows={2}
                      className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
                      maxLength={4000}
                    />
                    <div className="mt-2 max-w-md">
                      <VoicePicker
                        compact
                        hideWhenEmpty
                        value={line.voiceIdOverride || null}
                        onChange={(v) => handleVoiceOverride(i, v)}
                        placeholder={line.characterId
                          ? `Inherit (${line.characterName} default)`
                          : 'Inherit (project default)'}
                        previewText={textValue?.trim() ? textValue.slice(0, 200) : undefined}
                      />
                    </div>
                    {line.audioFilename ? (
                      <audio
                        controls
                        src={`/data/audio/${encodeURIComponent(line.audioFilename)}`}
                        className="mt-2 w-full max-w-md"
                      >
                        <track kind="captions" />
                      </audio>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-1.5 w-28">
                    <button
                      type="button"
                      onClick={() => handleRender(i)}
                      disabled={isRendering || !textValue.trim()}
                      title={textValue.trim() ? 'Render this line as audio' : 'Add line text first'}
                      className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-accent text-white text-xs disabled:opacity-50"
                    >
                      {isRendering ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                      {line.audioFilename ? 'Re-render' : 'Render'}
                    </button>
                    {/* Per-line start offset (seconds into the episode). Drives
                        VO muxing in the final cut; blank = not placed yet. */}
                    <label htmlFor={`vo-offset-${i}`} className="text-[10px] text-gray-500 mt-0.5">Start (s)</label>
                    <input
                      id={`vo-offset-${i}`}
                      type="number"
                      min="0"
                      step="0.1"
                      inputMode="decimal"
                      value={offsetDrafts[i] !== undefined
                        ? offsetDrafts[i]
                        : (Number.isFinite(line.offsetSec) ? line.offsetSec : '')}
                      onChange={(e) => setOffsetDrafts((prev) => ({ ...prev, [i]: e.target.value }))}
                      onBlur={() => handleOffsetBlur(i)}
                      placeholder="—"
                      title="When this line plays in the stitched episode (seconds). Blank = not placed."
                      className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

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
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/m4a,audio/ogg,audio/flac,.mp3,.wav,.m4a,.ogg,.flac"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void handleMusicUpload(file);
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={musicUploading}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-40"
            >
              {musicUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              Upload track
            </button>
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
              {genPanelOpen ? 'Close generator' : 'Generate (MusicGen)'}
            </button>
          </div>
        </div>

        {genPanelOpen ? (
          <div className="mb-3 p-3 bg-port-bg border border-port-border rounded-lg">
            {generators === null ? (
              <p className="text-xs text-gray-500">Loading generators…</p>
            ) : !generators.ready ? (
              <p className="text-xs text-gray-400">
                Local music generation isn't installed yet. Run{' '}
                <code className="text-gray-300">INSTALL_MUSICGEN=1 bash scripts/setup-image-video.sh</code>{' '}
                to bootstrap the MusicGen (MLX) runtime, then reopen this panel.
              </p>
            ) : (
              <div className="space-y-3">
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
                      value={genModelId}
                      onChange={(e) => setGenModelId(e.target.value)}
                      className="px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
                    >
                      {(generators.models || []).map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="musicgen-duration" className="block text-xs text-gray-400 mb-1">
                      Length (s)
                    </label>
                    <input
                      id="musicgen-duration"
                      type="number"
                      min={generators.minDurationSec ?? 1}
                      max={generators.maxDurationSec ?? 30}
                      step="1"
                      value={genDuration}
                      onChange={(e) => {
                        // Clamp to the server's accepted range so a blank/typed
                        // out-of-range value can't 400 on Generate. NaN → default.
                        const min = generators.minDurationSec ?? 1;
                        const max = generators.maxDurationSec ?? 30;
                        const n = Number(e.target.value);
                        setGenDuration(Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : (generators.defaultDurationSec ?? 12));
                      }}
                      className="w-24 px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleGenerateMusic}
                    disabled={generating || !genPrompt.trim()}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm disabled:opacity-50"
                  >
                    {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                    {generating ? 'Generating…' : 'Generate'}
                  </button>
                </div>
                <p className="text-[11px] text-gray-600">
                  Runs on-device via MLX — a {generators.maxDurationSec ?? 30}s clip takes ~tens of seconds. The track lands in your music library and is attached to this issue.
                </p>
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
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs uppercase tracking-wider text-gray-500">Library</span>
              {musicLibraryLoading ? (
                <Loader2 size={12} className="animate-spin text-gray-500" />
              ) : null}
            </div>
            {musicLibrary === null || musicLibraryLoading ? (
              <p className="text-xs text-gray-500">Loading…</p>
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
                    <li key={track.filename} className="flex items-center gap-2 p-2 bg-port-card border border-port-border rounded">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate">{track.label || track.filename}</div>
                        <div className="text-[10px] text-gray-500 font-mono">{track.filename}</div>
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
                            title="Delete from library (issues that point at this file will fail playback)"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs border border-port-border text-gray-400 hover:text-port-error hover:border-port-error/50"
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
    </div>
  );
}
