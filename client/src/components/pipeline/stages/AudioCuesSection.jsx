import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Music, Sparkles, Wand2 } from 'lucide-react';
import { musicEngineReadinessMessage } from '../../../../../server/lib/generationModes.js';
import { generatePipelineAudioCues, renderPipelineAudioCue, updatePipelineIssue } from '../../../services/apiPipeline.js';
import toast from '../../ui/Toast';
import { generatorUnavailableReason } from './audioGeneratorReadiness.js';

export default function AudioCuesSection({ issueId, cues: stageCues, audioMode, audioModeSaving, generatorStatus, onStageUpdate }) {
  const { generators, generatorsError, genEngines, loadGenerators } = generatorStatus;
  const cues = useMemo(() => (Array.isArray(stageCues) ? stageCues : []), [stageCues]);
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
  // Mirrors the server-side `queueSeriesIssuesWrite` "collapse to one tail per shared
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

  useEffect(() => {
    if (audioMode !== 'generated') setConfirmRederive(false);
  }, [audioMode]);

  // The readiness of the generator engines drives whether the cue Generate /
  // Render affordances are enabled. Reuse the same generators list the music
  // panel fetches; lazily load it the first time the user lands on 'generated'.
  const defaultEngineId = generators?.defaultEngine
    || generators?.engines?.[0]?.id
    || 'musicgen';
  const cueEngine = genEngines.find((e) => e.id === defaultEngineId) || genEngines[0] || null;
  const cueEngineReason = generatorUnavailableReason(cueEngine);
  const enginesLoaded = generators !== null;
  // The render route uses the engine's default checkpoint when no model ID
  // is sent. A stamped engine must be present in the route's allowed set.
  const engineForCue = (cue) => cue?.engine
    ? genEngines.find((engine) => engine.id === cue.engine)
    : cueEngine;
  const hasRenderableCue = cues.some((cue, i) => {
    const prompt = cuePromptDrafts[i] ?? cue.prompt ?? '';
    return prompt.trim() && !generatorUnavailableReason(engineForCue(cue));
  });

  const runGenerateCues = async (replacing) => {
    setConfirmRederive(false);
    setDerivingCues(true);
    const result = await generatePipelineAudioCues(
      issueId,
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
        issueId,
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
    const engine = engineForCue(latestCuesRef.current[cueIdx]);
    if (generatorUnavailableReason(engine)) return false;
    setRenderingCues((prev) => new Set(prev).add(cueIdx));
    const result = await renderPipelineAudioCue(
      issueId,
      cueIdx,
      { engine: engine.id },
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
    try {
      let rendered = 0;
      for (let i = 0; i < cues.length; i += 1) {
        const effectivePrompt = cuePromptDrafts[i] !== undefined ? cuePromptDrafts[i] : (cues[i]?.prompt || '');
        if (!effectivePrompt.trim()) continue;
        if (generatorUnavailableReason(engineForCue(cues[i]))) continue;
        const ok = await renderOneCue(i, cuePromptDrafts[i]);
        if (ok) rendered += 1;
      }
      if (rendered > 0) toast.success(`Rendered ${rendered} cue${rendered === 1 ? '' : 's'}`);
    } catch (err) {
      console.error(`❌ Render all cues follow-up failed: ${err?.message || 'Unknown error'}`);
      toast.error('Could not finish updating audio cues — reload to see the result');
    } finally {
      setRenderingAllCues(false);
    }
  };

  if (audioMode !== 'generated') return null;
  return (
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
            <span className="inline-flex flex-wrap items-center gap-2 text-xs text-gray-300">
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
                    ? 'Render every cue with a prompt and a ready engine'
                    : 'No cue has both a prompt and a ready engine')}
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
      ) : enginesLoaded && cueEngineReason ? (
        <p className="text-xs text-port-warning">
          {musicEngineReadinessMessage(cueEngine, cueEngineReason)} You can still derive and edit cue prompts.
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
            const thisCueEngineReason = generatorUnavailableReason(thisCueEngine);
            const cueReadinessMessage = enginesLoaded && musicEngineReadinessMessage(thisCueEngine, thisCueEngineReason);
            return (
              <li key={cue.id || i} className="p-3 bg-port-bg border border-port-border rounded-lg">
                <div className="flex flex-col gap-3 @min-[32rem]/audio-stage:flex-row @min-[32rem]/audio-stage:items-start">
                  <span className="text-[10px] text-gray-500 font-mono pt-1.5 @min-[32rem]/audio-stage:w-8 @min-[32rem]/audio-stage:shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      <span className="text-xs uppercase tracking-wider text-port-accent font-medium [overflow-wrap:anywhere]">
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
                    {cueReadinessMessage && thisCueEngine !== cueEngine ? (
                      <p className="mt-1 text-xs text-port-warning">{cueReadinessMessage}</p>
                    ) : null}
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
                  <div className="w-full flex flex-col gap-1.5 @min-[32rem]/audio-stage:w-28 @min-[32rem]/audio-stage:shrink-0">
                    <button
                      type="button"
                      onClick={() => handleRenderCue(i)}
                      disabled={isRendering || renderingAllCues || derivingCues || cuePromptSaving || !!thisCueEngineReason || !promptValue.trim()}
                      title={generatorsError
                        ? "Couldn't check the music engine — Retry above"
                        : !enginesLoaded
                          ? 'Checking generator engine…'
                          : (cueReadinessMessage || (promptValue.trim() ? 'Render this cue as music' : 'Add a prompt first'))}
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
  );
}
