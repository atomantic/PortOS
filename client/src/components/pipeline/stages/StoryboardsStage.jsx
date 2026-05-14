/**
 * Storyboards stage — one storyboard image per TV-script scene, plus
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
 * Auto-fill: "From TV script" / "From prose" buttons run the scene
 * extractor against the corresponding text stage and replace the list.
 */

import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Sparkles, Loader2, Wand2, Film, WandSparkles } from 'lucide-react';
import toast from '../../ui/Toast';
import {
  generatePipelineVisualImage,
  generatePipelineSceneVideo,
  refinePipelineSceneImagePrompt,
  updatePipelineIssue,
  extractPipelineStoryboardScenes,
} from '../../../services/api';
import MediaJobThumb from '../MediaJobThumb';
import { genConfigToImageOptions, genConfigToRefineOptions } from './VisualGenSettings';

export default function StoryboardsStage({ issue, onStageUpdate }) {
  const stage = issue.stages?.storyboards || { status: 'empty', scenes: [] };
  const [scenes, setScenes] = useState(stage.scenes || []);
  // Per-stage gen config — edited from the page-level settings modal.
  const genConfig = stage.genConfig || null;
  const [savingIdx, setSavingIdx] = useState(null);
  const [renderingVideoIdx, setRenderingVideoIdx] = useState(null);
  const [refiningIdx, setRefiningIdx] = useState(null);
  const [extractingFrom, setExtractingFrom] = useState(null);
  // Holds the active arm-timer id so an unmount or a fresh arm clears the
  // pending disarm — otherwise the 5s callback fires setExtractingFrom on
  // an unmounted component (React warning + small leak).
  const armTimerRef = useRef(null);
  useEffect(() => () => {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
  }, []);

  const tvScriptReady = !!(issue.stages?.tvScript?.output || '').trim();
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
    const result = await extractPipelineStoryboardScenes(issue.id, { from, force: true }).catch((err) => {
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
            One image per scene, fed by the TV script. Use sluglines to keep parity with the teleplay. Stitch the final episode in the Episode Video stage once the storyboards are ready.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => onExtractClick('tvScript')}
            disabled={!tvScriptReady || extractInFlight}
            title={tvScriptReady ? 'Parse the teleplay sluglines into structured scenes' : 'Generate the TV script first'}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {extractingFrom === 'tvScript'
              ? <Loader2 size={14} className="animate-spin" />
              : <Wand2 size={14} />}
            {extractingFrom === 'arm:tvScript' ? 'Click again to replace' : 'From TV script'}
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
                    disabled={refiningIdx !== null}
                    title="Elaborate this description into a richer image-gen prompt (LLM call — replaces the current text)"
                    className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-card border border-port-border text-white text-xs hover:border-port-accent/50 disabled:opacity-50"
                  >
                    {refiningIdx === i ? <Loader2 size={12} className="animate-spin" /> : <WandSparkles size={12} />}
                    AI: refine
                  </button>
                  <button
                    type="button"
                    onClick={() => handleGenerate(i)}
                    disabled={savingIdx === i}
                    className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-accent text-white text-xs disabled:opacity-50"
                  >
                    {savingIdx === i ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    Storyboard
                  </button>
                  <button
                    type="button"
                    onClick={() => handleGenerateVideo(i)}
                    disabled={renderingVideoIdx !== null}
                    title="Render this scene as a video clip (independent of the full episode-video stitch)"
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
