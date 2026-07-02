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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Sparkles, Wand2, Mic, Music, Upload, Trash2, ListMusic } from 'lucide-react';
import toast from '../../ui/Toast';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
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
  generatePipelineAudioCues,
  renderPipelineAudioCue,
  updatePipelineIssue,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGE_STATUS_LABEL as STATUS_LABEL,
  PIPELINE_STAGE_STATUS_COLOR as STATUS_COLOR,
} from '../../../services/api';

// The whole-episode audio strategy (#863). 'per-clip' keeps each stitched
// clip's own soundtrack (today's default); 'silent' strips it; 'generated'
// lays an arc-driven cues[] bed across the timeline; 'uploaded-track' loops a
// single attached/generated music pointer.
const AUDIO_MODES = [
  { id: 'per-clip', label: 'Per-clip audio', hint: "Keep each stitched clip's own soundtrack." },
  { id: 'silent', label: 'Silent', hint: 'Strip clip audio — voice-over plays over silence.' },
  { id: 'generated', label: 'Generated cues', hint: 'Arc-driven music cues laid across the episode timeline.' },
  { id: 'uploaded-track', label: 'Single track', hint: 'Loop one attached/uploaded music track under the whole episode.' },
];

export default function AudioStage({ issue, onStageUpdate }) {
  const stage = issue.stages?.audio || { status: 'empty', lines: [], music: null };
  const lines = Array.isArray(stage.lines) ? stage.lines : [];
  const music = stage.music || null;
  const audioMode = AUDIO_MODES.some((m) => m.id === stage.audioMode) ? stage.audioMode : 'per-clip';
  // Memoized so the `latestCuesRef` sync effect keys on the lifted array's
  // identity, not a fresh `[]` rebuilt every render.
  const cues = useMemo(() => (Array.isArray(stage.cues) ? stage.cues : []), [stage.cues]);
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

  // Inline confirm (no window.confirm, no two-click-arm) for the destructive
  // re-extract path — an explicit Replace/Cancel row renders near the button.
  const [confirmingExtract, setConfirmingExtract] = useState(false);

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
  // Sentinel discipline (CLAUDE.md "distinguish not-fetched from failed"):
  // generators === null is "not fetched yet"; generatorsError !== null means a
  // fetch failed, so the cue panel can offer a Retry instead of showing a
  // perpetual "Checking engine…" that never resolves.
  const [generatorsError, setGeneratorsError] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [genPrompt, setGenPrompt] = useState('');
  const [genDuration, setGenDuration] = useState(12);
  const [genModelId, setGenModelId] = useState('');
  const [genEngineId, setGenEngineId] = useState('');

  // The selected backend's descriptor (models + duration window + readiness).
  // Falls back to the legacy single-engine shape when the server predates the
  // `engines` array, so an older API still drives the picker.
  const genEngines = generators?.engines ?? (generators
    ? [{
        id: generators.defaultEngine || 'musicgen',
        name: 'MusicGen',
        models: generators.models || [],
        defaultModelId: generators.defaultModelId,
        defaultDurationSec: generators.defaultDurationSec,
        minDurationSec: generators.minDurationSec,
        maxDurationSec: generators.maxDurationSec,
        installEnv: 'INSTALL_MUSICGEN',
        ready: generators.ready,
      }]
    : []);
  const activeEngine = genEngines.find((e) => e.id === genEngineId) || genEngines[0] || null;

  // Per-line VO start-offset drafts (seconds into the stitched episode). Kept
  // separate from text drafts; committed on blur via the same patch queue.
  const [offsetDrafts, setOffsetDrafts] = useState({});

  // Whole-episode audio mode (#863). Persists via the existing PATCH /issues/:id
  // route. `audioModeSaving` gates the mode-dependent cue actions while the
  // PATCH is in flight (CLAUDE.md "in-flight saves must gate dependent actions").
  const [audioModeSaving, setAudioModeSaving] = useState(false);
  // Generated-cue state: deriving the list, rendering each / all cues, and
  // per-cue prompt drafts (committed on blur via the cue write queue below).
  const [derivingCues, setDerivingCues] = useState(false);
  const [renderingCues, setRenderingCues] = useState(() => new Set());
  const [renderingAllCues, setRenderingAllCues] = useState(false);
  const [cuePromptDrafts, setCuePromptDrafts] = useState({});
  // Inline confirm row (user-preferred over a two-click arm) for the
  // destructive re-derive that replaces an existing cues[].
  const [confirmRederive, setConfirmRederive] = useState(false);
  // Cue-prompt saves are serialized onto a single tail (not a per-index Map):
  // the whole cues[] array is one shared record, so two edits to different cues
  // both PATCH the same array and a Map keyed by index would still let the
  // second clobber the first. The tail awaits the prior save, then rebuilds the
  // patch from the FRESHEST cues (`latestCuesRef`, updated every render from the
  // lifted issue) so each edit merges against the latest persisted list.
  // Mirrors the server-side `issueWriteTail` "collapse to one tail per shared
  // file" rule. `savingCueIdxs` is reactive state (not a ref) so the per-row
  // Render gate updates live and recovers if a save fails.
  const cueSaveTailRef = useRef(Promise.resolve());
  const latestCuesRef = useRef(cues);
  // Sync the ref from props only when the lifted cues[] actually changes
  // identity — NOT on every render. A bare per-render assignment would clobber
  // the in-tail update a chained save just wrote (the `setSavingCueIdxs`
  // re-render fires before the lifted prop arrives).
  useEffect(() => { latestCuesRef.current = cues; }, [cues]);
  const [savingCueIdxs, setSavingCueIdxs] = useState(() => new Set());

  // When the stage loads (or switches) into 'generated' mode, eagerly fetch the
  // generators list so the cue Render affordances can gate on engine readiness
  // without first opening the music Generate panel. `loadGenerators` is a no-op
  // once the list has landed.
  useEffect(() => {
    if (audioMode === 'generated') void loadGenerators();
    // Drop a pending re-derive confirm when leaving generated mode so it can't
    // resurface unprompted on return.
    else setConfirmRederive(false);
  }, [audioMode]);

  // Fetch the generators list (once) without opening the music Generate panel —
  // the cue affordances and the panel both need it to gate on engine readiness.
  // `force` re-tries after a prior failure (the Retry affordance).
  const loadGenerators = async (force = false) => {
    if (generators !== null) return;
    if (generatorsError !== null && !force) return; // failed earlier; wait for explicit retry
    setGeneratorsError(null);
    // Owns its own error toast → silent so the helper doesn't double-toast.
    const result = await listPipelineMusicGenerators({ silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to load generators');
      setGeneratorsError(err.message || 'Failed to load generators');
      return null;
    });
    if (result) {
      setGenerators(result);
      // Default to the server's default engine, then that engine's default
      // model + duration. Falls back to the flattened legacy fields.
      const engines = result.engines ?? [];
      const defEngine = engines.find((e) => e.id === result.defaultEngine) || engines[0] || null;
      setGenEngineId((prev) => prev || defEngine?.id || result.defaultEngine || 'musicgen');
      setGenModelId((prev) => prev || defEngine?.defaultModelId || result.defaultModelId || result.models?.[0]?.id || '');
      const defDuration = defEngine?.defaultDurationSec ?? result.defaultDurationSec;
      if (Number.isFinite(defDuration)) setGenDuration(defDuration);
    }
  };

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
    const prompt = genPrompt.trim();
    if (!prompt) { toast.error('Describe the music you want first'); return; }
    setGenerating(true);
    // Owns its own error toast → silent so the helper doesn't double-toast.
    const result = await generatePipelineMusic(
      issue.id,
      { prompt, engine: genEngineId || undefined, durationSec: genDuration, modelId: genModelId || undefined },
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

  // ---- Whole-episode audio mode + generated cues (#863) ----

  // The readiness of the generator engines drives whether the cue Generate /
  // Render affordances are enabled. Reuse the same generators list the music
  // panel fetches; lazily load it the first time the user lands on 'generated'.
  const defaultEngineId = generators?.defaultEngine
    || generators?.engines?.[0]?.id
    || 'musicgen';
  const cueEngine = genEngines.find((e) => e.id === defaultEngineId) || genEngines[0] || null;
  const cueEngineReady = !!cueEngine?.ready;
  const enginesLoaded = generators !== null;
  // A cue renders on its OWN engine (cue.engine) when stamped, else the default
  // — so gate each cue's Render on the engine it will actually use. Returns the
  // engine descriptor (or the default) for a given cue.
  const engineForCue = (cue) => {
    const id = cue?.engine || defaultEngineId;
    return genEngines.find((e) => e.id === id) || cueEngine;
  };
  // Render-all is enabled when at least one cue has a renderable prompt (a typed
  // draft counts) AND its own engine is installed — matching what the handler
  // actually iterates, so the gate doesn't block valid non-default/draft cases.
  const hasRenderableCue = cues.some((c, i) => {
    const p = cuePromptDrafts[i] !== undefined ? cuePromptDrafts[i] : (c.prompt || '');
    return p.trim() && engineForCue(c)?.ready;
  });

  // Persist a new whole-episode audio mode via the existing issue PATCH route,
  // then lift the returned issue so the UI reflects the saved mode.
  const handleAudioModeChange = async (mode) => {
    if (mode === audioMode) return;
    setAudioModeSaving(true);
    // Custom error toast below → silent so the helper doesn't double-toast.
    const result = await updatePipelineIssue(
      issue.id,
      { stages: { audio: { audioMode: mode } } },
      { silent: true },
    ).catch((err) => {
      toast.error(err.message || 'Failed to set audio mode');
      return null;
    });
    setAudioModeSaving(false);
    if (!result) return;
    onStageUpdate?.('audio', result.stages?.audio, result);
    // The `audioMode` effect will land the generators list for 'generated';
    // no explicit fetch needed here.
  };

  const runGenerateCues = async (replacing) => {
    setConfirmRederive(false);
    setDerivingCues(true);
    const result = await generatePipelineAudioCues(
      issue.id,
      { engine: defaultEngineId, force: replacing },
      { silent: true },
    ).catch((err) => {
      toast.error(err.message || 'Cue derivation failed');
      return null;
    });
    setDerivingCues(false);
    if (!result) return;
    onStageUpdate?.('audio', result.stage, result.issue);
    setCuePromptDrafts({});
    toast.success(`Derived ${result.cueCount} cue${result.cueCount === 1 ? '' : 's'}`);
  };

  // First derive runs immediately; a re-derive (which replaces an existing
  // list) reveals an inline confirm row instead.
  const handleGenerateCues = () => {
    if (cues.length > 0) { setConfirmRederive(true); return; }
    void runGenerateCues(false);
  };

  // Refresh latestCuesRef from a server response's stage.cues. Both the prompt
  // save AND the render must call this so a chained write never PATCHes a stale
  // full array — e.g. a render stamps trackFilename/durationSec, and a later
  // prompt save would erase them if it rebuilt the patch from a pre-render ref.
  const adoptCues = (stage) => {
    if (Array.isArray(stage?.cues)) latestCuesRef.current = stage.cues;
  };

  // Per-cue prompt edit, serialized onto the shared tail. Resolves to a
  // discriminated result so callers (Render) can tell success/no-op from a
  // failed save: `{ ok: true }` (saved or no-op) | `{ ok: false }` (PATCH
  // failed — the caller must keep the draft and not render stale text).
  // The patch is built INSIDE the tail from `latestCuesRef` so a save chained
  // behind another sees the prior write's lifted result, not a stale snapshot.
  const saveCuePrompt = (cueIdx, prompt) => {
    setSavingCueIdxs((prev) => new Set(prev).add(cueIdx));
    const run = cueSaveTailRef.current.then(async () => {
      const base = latestCuesRef.current;
      if (!base[cueIdx] || base[cueIdx].prompt === prompt) return { ok: true, noop: true }; // gone/no-op
      const nextCues = base.map((c, i) => (i === cueIdx ? { ...c, prompt } : c));
      const updated = await updatePipelineIssue(
        issue.id,
        { stages: { audio: { cues: nextCues } } },
        { silent: true },
      ).catch((err) => { toast.error(err.message || 'Failed to save cue prompt'); return null; });
      if (!updated) return { ok: false };
      // Keep the ref fresh within the tail before the next write reads it —
      // React's lifted-state re-render is async.
      adoptCues(updated.stages?.audio);
      onStageUpdate?.('audio', updated.stages?.audio, updated);
      return { ok: true, noop: false };
    }).finally(() => {
      setSavingCueIdxs((prev) => { const next = new Set(prev); next.delete(cueIdx); return next; });
    });
    // The tail itself never rejects (errors are caught above) so a failed save
    // can't wedge the queue.
    cueSaveTailRef.current = run.then(() => undefined, () => undefined);
    return run;
  };

  const handleCuePromptBlur = async (cueIdx) => {
    const draft = cuePromptDrafts[cueIdx];
    if (draft === undefined) return;
    const dropDraft = () => setCuePromptDrafts((prev) => { const next = { ...prev }; delete next[cueIdx]; return next; });
    if (draft === (cues[cueIdx]?.prompt || '')) { dropDraft(); return; }
    const res = await saveCuePrompt(cueIdx, draft);
    // Only drop the draft once the save lands — a failed PATCH keeps the user's
    // text in the box so it isn't silently lost.
    if (res.ok) dropDraft();
  };

  // Render one cue. `promptOverride` (from Render-all) lets a not-yet-blurred
  // draft be rendered. Awaits the cue's prompt save so the server reads the
  // freshest persisted prompt, and resolves the engine the SAME way the backend
  // does — body override → the cue's own engine hint → the UI default — so a
  // cue stamped with a non-default engine (e.g. audioldm2) re-renders on it.
  const renderOneCue = async (cueIdx, promptOverride) => {
    const draft = promptOverride !== undefined ? promptOverride : cuePromptDrafts[cueIdx];
    if (draft !== undefined && draft !== (latestCuesRef.current[cueIdx]?.prompt || '')) {
      const res = await saveCuePrompt(cueIdx, draft);
      // Abort if the prompt save failed — rendering would synth stale text and
      // the draft must survive so the user can retry. The error toast already
      // fired inside saveCuePrompt.
      if (!res.ok) return false;
      setCuePromptDrafts((prev) => { const next = { ...prev }; delete next[cueIdx]; return next; });
    } else {
      // No new draft — still drain any in-flight save for this cue.
      await cueSaveTailRef.current;
    }
    const engine = latestCuesRef.current[cueIdx]?.engine || defaultEngineId;
    setRenderingCues((prev) => new Set(prev).add(cueIdx));
    const result = await renderPipelineAudioCue(
      issue.id,
      cueIdx,
      { engine },
      { silent: true },
    ).catch((err) => {
      toast.error(err.message || `Cue ${cueIdx + 1} render failed`);
      return null;
    });
    setRenderingCues((prev) => { const next = new Set(prev); next.delete(cueIdx); return next; });
    if (!result) return false;
    // Adopt the render's stamped cues (trackFilename/durationSec) so a later
    // prompt save doesn't PATCH them away from a pre-render snapshot.
    if (result.issue) {
      adoptCues(result.stage);
      onStageUpdate?.('audio', result.stage, result.issue);
    }
    return true;
  };

  const handleRenderCue = async (cueIdx) => {
    const ok = await renderOneCue(cueIdx);
    if (ok) toast.success(`Rendered cue ${cueIdx + 1}`);
  };

  // Render every cue that has a prompt (a typed-but-unsaved draft counts —
  // renderOneCue flushes it), sequentially (each is a GPU-heavy job;
  // serializing avoids thrashing the single sidecar).
  const handleRenderAllCues = async () => {
    setRenderingAllCues(true);
    let rendered = 0;
    for (let i = 0; i < cues.length; i += 1) {
      const effectivePrompt = cuePromptDrafts[i] !== undefined ? cuePromptDrafts[i] : (cues[i]?.prompt || '');
      if (!effectivePrompt.trim()) continue;
      // Skip cues whose engine isn't installed — the per-cue button would block
      // them, so render-all should too rather than firing a doomed request.
      if (!engineForCue(cues[i])?.ready) continue;
      const ok = await renderOneCue(i, cuePromptDrafts[i]);
      if (ok) rendered += 1;
    }
    setRenderingAllCues(false);
    if (rendered > 0) toast.success(`Rendered ${rendered} cue${rendered === 1 ? '' : 's'}`);
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

  const handleExtract = () => {
    if (!canExtract) {
      toast.error('Generate Storyboards first — audio lines come from the dialogue extracted there.');
      return;
    }
    if (lines.length > 0) {
      setConfirmingExtract(true);
      return;
    }
    void runExtract();
  };

  const runExtract = async () => {
    const needsConfirm = lines.length > 0;
    setConfirmingExtract(false);
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
            {lines.length > 0 ? 'Re-extract from storyboards' : 'Extract lines from storyboards'}
          </button>
        </div>
      </header>

      {confirmingExtract && (
        <InlineConfirmRow
          tone="warning"
          question={`Replace ${lines.length} existing line${lines.length === 1 ? '' : 's'} with a fresh extract? Rendered audio is preserved for unchanged lines.`}
          confirmText="Replace"
          onConfirm={() => void runExtract()}
          onCancel={() => setConfirmingExtract(false)}
        />
      )}

      {/* Whole-episode audio mode (#863) — drives the episode's non-dialogue
          audio at stitch time. */}
      <section className="p-3 bg-port-card border border-port-border rounded-lg">
        <div className="flex items-center gap-2 mb-2">
          <ListMusic className="w-4 h-4 text-port-accent" />
          <label htmlFor="audio-mode" className="text-sm font-medium text-white">Episode audio</label>
          {audioModeSaving ? <Loader2 size={12} className="animate-spin text-gray-500" /> : null}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            id="audio-mode"
            value={audioMode}
            disabled={audioModeSaving}
            onChange={(e) => void handleAudioModeChange(e.target.value)}
            className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-50"
          >
            {AUDIO_MODES.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 flex-1 min-w-[12rem]">
            {AUDIO_MODES.find((m) => m.id === audioMode)?.hint}
          </p>
        </div>
      </section>

      {audioMode === 'generated' ? (
        <section className="p-3 bg-port-card border border-port-border rounded-lg space-y-3">
          <div className="flex items-start justify-between flex-wrap gap-3">
            <div>
              <h3 className="text-base font-semibold text-white flex items-center gap-2">
                <Music className="w-4 h-4 text-port-accent" /> Music cues
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                One cue per arc beat, laid across the episode timeline. Derive the list from the
                episode's beats, then render each cue's music.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {confirmRederive ? (
                <span className="inline-flex items-center gap-2 text-xs text-gray-300">
                  <span className="italic">Replace {cues.length} cue{cues.length === 1 ? '' : 's'}? (rendered audio is kept by label)</span>
                  <button
                    type="button"
                    onClick={() => setConfirmRederive(false)}
                    className="px-2 py-1 rounded border border-port-border text-gray-300 hover:border-gray-500"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void runGenerateCues(true)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded bg-port-warning text-black font-medium"
                  >
                    <Wand2 size={14} /> Re-derive
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={handleGenerateCues}
                  disabled={derivingCues || renderingAllCues || audioModeSaving}
                  title="Derive the cue list from the episode's beats + storyboard scene order"
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-40"
                >
                  {derivingCues ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                  {cues.length > 0 ? 'Re-derive cues' : 'Generate cues'}
                </button>
              )}
              {cues.length > 0 ? (
                <button
                  type="button"
                  onClick={handleRenderAllCues}
                  disabled={renderingAllCues || derivingCues || audioModeSaving || !hasRenderableCue}
                  title={generatorsError
                    ? "Couldn't check the music engine — Retry above"
                    : !enginesLoaded
                      ? 'Checking generator engine…'
                      : (hasRenderableCue
                        ? 'Render every cue that has a prompt on an installed engine'
                        : "No cue has a prompt on an installed engine yet")}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm disabled:opacity-50"
                >
                  {renderingAllCues ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  Render all cues
                </button>
              ) : null}
            </div>
          </div>

          {generatorsError ? (
            <p className="text-xs text-port-error flex items-center gap-2">
              Couldn't check the music engine — render is unavailable until it loads.
              <button
                type="button"
                onClick={() => void loadGenerators(true)}
                className="px-2 py-0.5 rounded border border-port-border text-gray-300 hover:border-port-accent/50"
              >
                Retry
              </button>
            </p>
          ) : enginesLoaded && !cueEngineReady ? (
            <p className="text-xs text-port-warning">
              {cueEngine?.name || 'The music engine'} isn't installed yet — you can derive and edit cue
              prompts, but rendering is disabled until its runtime is bootstrapped.
            </p>
          ) : null}

          {cues.length === 0 ? (
            <p className="text-sm text-gray-400 italic">
              No cues yet. Click <strong>Generate cues</strong> to derive them from the episode's beats.
            </p>
          ) : (
            <ul className="space-y-2">
              {cues.map((cue, i) => {
                const isRendering = renderingCues.has(i);
                const promptValue = cuePromptDrafts[i] !== undefined ? cuePromptDrafts[i] : (cue.prompt || '');
                const cuePromptSaving = savingCueIdxs.has(i);
                const placed = Number.isFinite(cue.startSec) && Number.isFinite(cue.endSec);
                const thisCueEngine = engineForCue(cue);
                const thisCueEngineReady = !!thisCueEngine?.ready;
                return (
                  <li key={cue.id || i} className="p-3 bg-port-bg border border-port-border rounded-lg">
                    <div className="flex items-start gap-3">
                      <span className="text-[10px] text-gray-500 font-mono pt-1.5 w-8">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                          <span className="text-xs uppercase tracking-wider text-port-accent font-medium">
                            {cue.label || `Cue ${i + 1}`}
                          </span>
                          {placed ? (
                            <span className="text-[10px] text-gray-500 font-mono" title="Timeline placement (seconds)">
                              {cue.startSec.toFixed(1)}s–{cue.endSec.toFixed(1)}s
                            </span>
                          ) : (
                            <span className="text-[10px] text-gray-600 italic" title="Placed onto the timeline at stitch time">
                              placed at stitch
                            </span>
                          )}
                          {cue.engine ? (
                            <span className="text-[10px] text-gray-600 font-mono">{cue.engine}</span>
                          ) : null}
                        </div>
                        <label htmlFor={`cue-prompt-${i}`} className="sr-only">Music prompt for cue {i + 1}</label>
                        <textarea
                          id={`cue-prompt-${i}`}
                          value={promptValue}
                          onChange={(e) => setCuePromptDrafts((prev) => ({ ...prev, [i]: e.target.value }))}
                          onBlur={() => void handleCuePromptBlur(i)}
                          rows={2}
                          maxLength={2000}
                          placeholder="e.g. warm ambient pads, slow build"
                          className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
                        />
                        {cue.trackFilename ? (
                          <audio
                            controls
                            src={`/data/music/${encodeURIComponent(cue.trackFilename)}`}
                            className="mt-2 w-full max-w-md"
                          >
                            <track kind="captions" />
                          </audio>
                        ) : null}
                      </div>
                      <div className="w-28 flex flex-col gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleRenderCue(i)}
                          disabled={isRendering || renderingAllCues || derivingCues || cuePromptSaving || !thisCueEngineReady || !promptValue.trim()}
                          title={generatorsError
                            ? "Couldn't check the music engine — Retry above"
                            : !enginesLoaded
                              ? 'Checking generator engine…'
                              : (!thisCueEngineReady
                                ? `${thisCueEngine?.name || 'The music engine'} isn't installed — render is unavailable`
                                : (promptValue.trim() ? 'Render this cue as music' : 'Add a prompt first'))}
                          className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-accent text-white text-xs disabled:opacity-50"
                        >
                          {isRendering ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                          {cue.trackFilename ? 'Re-render' : 'Render'}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

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
              {genPanelOpen ? 'Close generator' : 'Generate music'}
            </button>
          </div>
        </div>

        {genPanelOpen ? (
          <div className="mb-3 p-3 bg-port-bg border border-port-border rounded-lg">
            {generators === null ? (
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
                      className="px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
                    >
                      {genEngines.map((eng) => (
                        <option key={eng.id} value={eng.id}>
                          {eng.name}{eng.ready ? '' : ' (not installed)'}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {!activeEngine?.ready ? (
                  <p className="text-xs text-gray-400">
                    {activeEngine?.name || 'This engine'} isn't installed yet. Run{' '}
                    <code className="text-gray-300">{activeEngine?.installEnv || `INSTALL_${(activeEngine?.id || 'musicgen').toUpperCase()}`}=1 bash scripts/setup-image-video.sh</code>{' '}
                    to bootstrap its runtime, then reopen this panel.
                  </p>
                ) : (
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
                          value={genModelId}
                          onChange={(e) => setGenModelId(e.target.value)}
                          className="px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
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
                        <input
                          id="musicgen-duration"
                          type="number"
                          min={activeEngine.minDurationSec ?? 1}
                          max={activeEngine.maxDurationSec ?? 30}
                          step="1"
                          value={genDuration}
                          onChange={(e) => {
                            // Clamp to the engine's accepted range so a blank/typed
                            // out-of-range value can't 400 on Generate. NaN → default.
                            const min = activeEngine.minDurationSec ?? 1;
                            const max = activeEngine.maxDurationSec ?? 30;
                            const n = Number(e.target.value);
                            setGenDuration(Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : (activeEngine.defaultDurationSec ?? 12));
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
                      Runs on-device — up to {activeEngine.maxDurationSec ?? 30}s. The track lands in your music library and is attached to this issue.
                    </p>
                  </>
                )}
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
