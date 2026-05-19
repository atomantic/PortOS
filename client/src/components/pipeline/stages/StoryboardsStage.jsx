/**
 * Storyboards stage — one storyboard image per teleplay scene, plus
 * single-scene video preview and AI-driven prompt refinement.
 *
 * Each scene row exposes four actions:
 *   - **AI: refine** — rewrites the description via the storyboard prompt
 *     template (see server/services/pipeline/visualStages.js#refineStoryboardScenePrompt).
 *   - **Storyboard** — enqueues an image-gen job for the scene; jobId
 *     lands on `scene.imageJobId`, surfaced via `<MediaJobThumb>`.
 *   - **Scene video** — enqueues a t2v video render; jobId lands on
 *     `scene.sceneVideoJobId`. Independent of the full episode-video
 *     stitch in `episodeVideo.js`.
 *   - **Trash** — removes the scene from the list.
 *
 * Auto-fill: "From teleplay" / "From prose" buttons run the scene
 * extractor against the corresponding text stage and replace the list.
 */

import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Sparkles, Loader2, Wand2, Film, WandSparkles } from 'lucide-react';
import toast from '../../ui/Toast';
import {
  generatePipelineVisualImage,
  generatePipelineSceneVideo,
  generatePipelineShotStartFrame,
  refinePipelineSceneImagePrompt,
  updatePipelineIssue,
  extractPipelineStoryboardScenes,
} from '../../../services/api';
import MediaJobThumb from '../MediaJobThumb';
import { genConfigToImageOptions, genConfigToRefineOptions } from './VisualGenSettings';

export default function StoryboardsStage({ issue, series, onStageUpdate, actionsGated = false }) {
  const stage = issue.stages?.storyboards || { status: 'empty', scenes: [] };
  const [scenes, setScenes] = useState(stage.scenes || []);
  // Per-stage gen config — edited from the page-level settings modal.
  const genConfig = stage.genConfig || null;
  const [savingIdx, setSavingIdx] = useState(null);
  const [renderingVideoIdx, setRenderingVideoIdx] = useState(null);
  const [refiningIdx, setRefiningIdx] = useState(null);
  // Active per-shot renders keyed by `${sceneIdx}:${shotIdx}` so multiple
  // shots can render concurrently with independent spinners. A single ref
  // would race when the user starts a second render before the first settles.
  const [renderingShots, setRenderingShots] = useState(() => new Set());
  const [extractingFrom, setExtractingFrom] = useState(null);
  // Holds the active arm-timer id so an unmount or a fresh arm clears the
  // pending disarm — otherwise the 5s callback fires setExtractingFrom on
  // an unmounted component (React warning + small leak).
  const armTimerRef = useRef(null);
  useEffect(() => () => {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
  }, []);

  const teleplayReady = !!(issue.stages?.teleplay?.output || '').trim();
  const proseReady = !!(issue.stages?.prose?.output || '').trim();
  // Any non-null, non-arm value means an extract POST is in flight — both
  // buttons must lock out concurrent submits so racing requests can't
  // overwrite each other's results (last-write-wins).
  const extractInFlight = !!extractingFrom && !extractingFrom.startsWith('arm:');

  const persist = async (nextScenes) => {
    setScenes(nextScenes);
    const updated = await updatePipelineIssue(issue.id, {
      stages: { storyboards: { status: nextScenes.length ? 'edited' : 'empty', scenes: nextScenes } },
    }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    if (updated) onStageUpdate?.('storyboards', updated.stages.storyboards, updated);
  };

  const addScene = () => persist([...scenes, { slugline: '', description: '', imageJobId: null }]);
  const removeScene = (i) => persist(scenes.filter((_, j) => j !== i));
  const updateScene = (i, patch) => {
    const next = scenes.map((s, j) => j === i ? { ...s, ...patch } : s);
    setScenes(next);
  };

  // Shot id stable enough for React keys + filename-hook correlation. Local
  // generation (vs server-assigned) is fine — every later persist round-trips
  // through the server which keeps whatever id the client wrote.
  const mintShotId = () => `shot-${Math.random().toString(36).slice(2, 10)}`;

  const updateShots = (sceneIdx, transform) => {
    const next = scenes.map((s, j) => {
      if (j !== sceneIdx) return s;
      const shots = Array.isArray(s.shots) ? s.shots : [];
      return { ...s, shots: transform(shots) };
    });
    setScenes(next);
    return next;
  };

  const addShot = (sceneIdx) => persist(updateShots(sceneIdx, (shots) =>
    [...shots, { id: mintShotId(), description: '', durationSeconds: 4 }]));
  const removeShot = (sceneIdx, shotIdx) => persist(updateShots(sceneIdx, (shots) =>
    shots.filter((_, j) => j !== shotIdx)));
  const updateShot = (sceneIdx, shotIdx, patch) => {
    // Local edit only — caller flushes via onBlur → persist(scenes).
    updateShots(sceneIdx, (shots) => shots.map((sh, j) => j === shotIdx ? { ...sh, ...patch } : sh));
  };

  const handleRenderShot = async (sceneIdx, shotIdx) => {
    const shot = scenes[sceneIdx].shots[shotIdx];
    const fallbackDesc = (scenes[sceneIdx].description || '').trim();
    if (!(shot?.description || '').trim() && !fallbackDesc) {
      toast.error('Add a shot or scene description first');
      return;
    }
    // Flush any pending local edits to the server before rendering — otherwise
    // the server reads the pre-edit shot.description (CLAUDE.md "In-flight
    // saves must gate dependent actions"). persist() returns when the PATCH
    // has settled, so the next read by the enqueue route sees the latest text.
    await persist(scenes);
    const key = `${sceneIdx}:${shotIdx}`;
    setRenderingShots((prev) => new Set(prev).add(key));
    const result = await generatePipelineShotStartFrame(issue.id, sceneIdx, shotIdx, {
      ...genConfigToImageOptions(genConfig),
    }).catch((err) => {
      toast.error(err.message || 'Shot render failed');
      return null;
    });
    setRenderingShots((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (!result) return;
    if (result.issue) {
      setScenes(result.issue.stages.storyboards.scenes || []);
      onStageUpdate?.('storyboards', result.issue.stages.storyboards, result.issue);
    }
    toast.success(`Queued shot ${shotIdx + 1} render (${result.jobId.slice(0, 8)})`);
  };

  // Replace-existing confirm uses a two-click arm pattern (no window.confirm
  // per CLAUDE.md, no shared confirm-modal primitive in the pipeline yet).
  // First click on a button when scenes is non-empty arms it (label flips to
  // "Click again to replace"). Second click within 5s fires the extract.
  const onExtractClick = async (from) => {
    const armKey = `arm:${from}`;
    const needsConfirm = scenes.length > 0;

    if (needsConfirm && extractingFrom !== armKey) {
      setExtractingFrom(armKey);
      toast.warning(`This will replace ${scenes.length} existing scene${scenes.length === 1 ? '' : 's'}. Click again to confirm.`);
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      armTimerRef.current = setTimeout(() => {
        armTimerRef.current = null;
        setExtractingFrom((cur) => (cur === armKey ? null : cur));
      }, 5000);
      return;
    }
    // Second click landed within the arm window — cancel the pending disarm
    // so the post-await `setExtractingFrom(null)` is the only state flip.
    if (armTimerRef.current) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }

    setExtractingFrom(from);
    const result = await extractPipelineStoryboardScenes(issue.id, {
      from,
      force: true,
      providerOverride: series?.llm?.provider || undefined,
      modelOverride: series?.llm?.model || undefined,
    }).catch((err) => {
      toast.error(err.message || 'Scene extraction failed');
      return null;
    });
    setExtractingFrom(null);
    if (!result) return;
    const next = result.stage?.scenes || [];
    setScenes(next);
    onStageUpdate?.('storyboards', result.stage, result.issue);
    toast.success(`Extracted ${result.sceneCount} scene${result.sceneCount === 1 ? '' : 's'}`);
  };

  const handleGenerate = async (i) => {
    const scene = scenes[i];
    if (!scene.description?.trim()) {
      toast.error('Add a description first');
      return;
    }
    setSavingIdx(i);
    const result = await generatePipelineVisualImage(issue.id, 'storyboards', {
      description: scene.description,
      slugline: scene.slugline || '',
      ...genConfigToImageOptions(genConfig),
    }).catch((err) => {
      toast.error(err.message || 'Failed to enqueue image');
      return null;
    });
    setSavingIdx(null);
    if (!result) return;
    const next = scenes.map((s, j) => j === i ? { ...s, imageJobId: result.jobId, prompt: result.prompt } : s);
    persist(next);
    toast.success(`Queued ${result.mode} image (${result.jobId.slice(0, 8)})`);
  };

  // LLM-driven refinement of the scene description into a richer image
  // prompt. Server replaces the persisted description with the refined
  // version and returns the updated issue.
  const handleRefinePrompt = async (i) => {
    const scene = scenes[i];
    if (!scene.description?.trim()) {
      toast.error('Add a description first');
      return;
    }
    setRefiningIdx(i);
    const result = await refinePipelineSceneImagePrompt(issue.id, i, genConfigToRefineOptions(genConfig))
      .catch((err) => {
        toast.error(err.message || 'Refine failed');
        return null;
      });
    setRefiningIdx(null);
    if (!result) return;
    if (result.issue) {
      setScenes(result.issue.stages?.storyboards?.scenes || []);
      onStageUpdate?.('storyboards', result.issue.stages.storyboards, result.issue);
    }
    const summary = result.changes?.[0] ? ` — ${result.changes[0]}` : '';
    toast.success(`Refined scene ${i + 1}${summary}`);
  };

  // Render this one scene as a video clip — independent of the full
  // episode-video stitch. Server persists sceneVideoJobId on the scene.
  const handleGenerateVideo = async (i) => {
    const scene = scenes[i];
    if (!scene.description?.trim()) {
      toast.error('Add a description first');
      return;
    }
    setRenderingVideoIdx(i);
    const result = await generatePipelineSceneVideo(issue.id, i, {})
      .catch((err) => {
        toast.error(err.message || 'Failed to enqueue scene video');
        return null;
      });
    setRenderingVideoIdx(null);
    if (!result) return;
    // Server returned the updated issue — adopt its scenes list rather than
    // patching locally so any sanitizer drift stays a server-side concern.
    if (result.issue) {
      setScenes(result.issue.stages?.storyboards?.scenes || []);
      onStageUpdate?.('storyboards', result.issue.stages.storyboards, result.issue);
    } else {
      const next = scenes.map((s, j) => j === i ? { ...s, sceneVideoJobId: result.jobId } : s);
      setScenes(next);
    }
    toast.success(`Queued scene video (${result.jobId.slice(0, 8)})`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-white">Storyboards</h2>
          <p className="text-xs text-gray-500 mt-1">
            One image per scene, fed by the Teleplay. Use sluglines to keep parity with the Teleplay. Stitch the final episode in the Episode Video stage once the storyboards are ready.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => onExtractClick('teleplay')}
            disabled={!teleplayReady || extractInFlight}
            title={teleplayReady ? 'Parse the Teleplay sluglines into structured scenes' : 'Generate the Teleplay first'}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {extractingFrom === 'teleplay'
              ? <Loader2 size={14} className="animate-spin" />
              : <Wand2 size={14} />}
            {extractingFrom === 'arm:teleplay' ? 'Click again to replace' : 'From Teleplay'}
          </button>
          <button
            type="button"
            onClick={() => onExtractClick('prose')}
            disabled={!proseReady || extractInFlight}
            title={proseReady ? 'Break the prose into paragraph-grain scenes' : 'Generate the prose first'}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {extractingFrom === 'prose'
              ? <Loader2 size={14} className="animate-spin" />
              : <Wand2 size={14} />}
            {extractingFrom === 'arm:prose' ? 'Click again to replace' : 'From prose'}
          </button>
          <button
            type="button"
            onClick={addScene}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50"
          >
            <Plus size={14} /> Add scene
          </button>
        </div>
      </div>

      {scenes.length === 0 ? (
        <p className="text-xs text-gray-600 italic">No scenes yet.</p>
      ) : (
        <ul className="space-y-3">
          {scenes.map((scene, i) => (
            <li key={i} className="p-3 bg-port-card border border-port-border rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <input
                  value={scene.slugline || ''}
                  onChange={(e) => updateScene(i, { slugline: e.target.value })}
                  onBlur={() => persist(scenes)}
                  placeholder="INT. FOUNDRY — NIGHT"
                  className="flex-1 mr-2 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs uppercase tracking-wider font-mono"
                  maxLength={200}
                />
                <button
                  type="button"
                  onClick={() => removeScene(i)}
                  className="text-gray-500 hover:text-port-error p-1"
                  aria-label="Remove scene"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="flex items-start gap-2">
                <textarea
                  value={scene.description || ''}
                  onChange={(e) => updateScene(i, { description: e.target.value })}
                  onBlur={() => persist(scenes)}
                  placeholder="Subject + framing + mood. The series style notes are prepended automatically."
                  rows={3}
                  className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
                  maxLength={8000}
                />
                <div className="flex flex-col gap-1 w-32">
                  <button
                    type="button"
                    onClick={() => handleRefinePrompt(i)}
                    disabled={refiningIdx !== null || actionsGated}
                    title={actionsGated ? 'Saving settings…' : 'Elaborate this description into a richer image-gen prompt (LLM call — replaces the current text)'}
                    className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-card border border-port-border text-white text-xs hover:border-port-accent/50 disabled:opacity-50"
                  >
                    {refiningIdx === i ? <Loader2 size={12} className="animate-spin" /> : <WandSparkles size={12} />}
                    AI: refine
                  </button>
                  <button
                    type="button"
                    onClick={() => handleGenerate(i)}
                    disabled={savingIdx === i || actionsGated}
                    title={actionsGated ? 'Saving settings…' : undefined}
                    className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-accent text-white text-xs disabled:opacity-50"
                  >
                    {savingIdx === i ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    Storyboard
                  </button>
                  <button
                    type="button"
                    onClick={() => handleGenerateVideo(i)}
                    disabled={renderingVideoIdx !== null || actionsGated}
                    title={actionsGated ? 'Saving settings…' : 'Render this scene as a video clip (independent of the full episode-video stitch)'}
                    className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-card border border-port-border text-white text-xs hover:border-port-accent/50 disabled:opacity-50"
                  >
                    {renderingVideoIdx === i ? <Loader2 size={12} className="animate-spin" /> : <Film size={12} />}
                    Scene video
                  </button>
                  {scene.imageJobId ? (
                    <>
                      <MediaJobThumb jobId={scene.imageJobId} label={`Scene ${i + 1}`} size="md" />
                      <span className="text-[10px] text-gray-500 font-mono break-all">img {scene.imageJobId.slice(0, 8)}</span>
                    </>
                  ) : null}
                  {scene.sceneVideoJobId ? (
                    <>
                      <MediaJobThumb jobId={scene.sceneVideoJobId} label={`Scene ${i + 1} video`} size="md" kind="video" />
                      <span className="text-[10px] text-gray-500 font-mono break-all">vid {scene.sceneVideoJobId.slice(0, 8)}</span>
                    </>
                  ) : null}
                </div>
              </div>
              <ShotList
                sceneIdx={i}
                shots={Array.isArray(scene.shots) ? scene.shots : []}
                renderingShots={renderingShots}
                actionsGated={actionsGated}
                onAddShot={() => addShot(i)}
                onRemoveShot={(j) => removeShot(i, j)}
                onUpdateShot={(j, patch) => updateShot(i, j, patch)}
                onBlurShot={() => persist(scenes)}
                onRenderShot={(j) => handleRenderShot(i, j)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ShotList({
  sceneIdx, shots, renderingShots, actionsGated,
  onAddShot, onRemoveShot, onUpdateShot, onBlurShot, onRenderShot,
}) {
  const hasShots = shots.length > 0;
  return (
    <div className="mt-3 pt-3 border-t border-port-border/60">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider text-gray-500">
          Shots {hasShots ? `(${shots.length})` : '— optional breakdown'}
        </span>
        <button
          type="button"
          onClick={onAddShot}
          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-port-card border border-port-border text-gray-300 text-[11px] hover:border-port-accent/50 hover:text-white"
        >
          <Plus size={11} /> Add shot
        </button>
      </div>
      {hasShots ? (
        <ul className="space-y-2">
          {shots.map((shot, j) => {
            const isRendering = renderingShots.has(`${sceneIdx}:${j}`);
            return (
              <li key={shot.id || j} className="flex items-start gap-2 p-2 bg-port-bg/40 border border-port-border/60 rounded">
                <span className="text-[10px] text-gray-500 font-mono pt-1.5 w-6">{j + 1}</span>
                <textarea
                  value={shot.description || ''}
                  onChange={(e) => onUpdateShot(j, { description: e.target.value })}
                  onBlur={onBlurShot}
                  placeholder="One camera setup. Subject + framing + motion + mood."
                  rows={2}
                  className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
                  maxLength={4000}
                />
                <div className="flex flex-col gap-1 w-24">
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={shot.durationSeconds ?? 4}
                    onChange={(e) => onUpdateShot(j, { durationSeconds: Number(e.target.value) || 4 })}
                    onBlur={onBlurShot}
                    title="Duration in seconds"
                    className="px-1 py-1 bg-port-bg border border-port-border rounded text-white text-[10px] text-center"
                  />
                  <button
                    type="button"
                    onClick={() => onRenderShot(j)}
                    disabled={isRendering || actionsGated}
                    title={actionsGated ? 'Saving settings…' : 'Render this shot as a start-frame image'}
                    className="inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-port-card border border-port-border text-white text-[11px] hover:border-port-accent/50 disabled:opacity-50"
                  >
                    {isRendering ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                    Render
                  </button>
                  {shot.startFrameJobId ? (
                    <MediaJobThumb jobId={shot.startFrameJobId} label={`Shot ${j + 1}`} size="sm" />
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveShot(j)}
                  className="text-gray-500 hover:text-port-error p-1 mt-0.5"
                  aria-label="Remove shot"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
