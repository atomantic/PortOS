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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Sparkles, Loader2, Wand2, Film, WandSparkles, Shirt, Layers, Pencil } from 'lucide-react';
import socket from '../../../services/socket';
import toast from '../../ui/Toast';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import { SHOT_TYPES, SCREEN_DIRECTIONS, SHOT_TYPE_LABELS, SCREEN_DIRECTION_LABELS } from '../../../lib/shotGrammar';
import { sceneShotWarnings } from '../../../lib/shotContinuity';
import {
  generatePipelineVisualImage,
  generatePipelineSceneVideo,
  generatePipelineShotStartFrame,
  refinePipelineSceneImagePrompt,
  generatePipelineSceneImagePrompts,
  updatePipelineIssue,
  extractPipelineStoryboardScenes,
  createBlankSketch,
} from '../../../services/api';
import useUniverse from '../../../hooks/useUniverse';
import { matchCharactersInText } from '../../../lib/scenePrompt';
import MediaJobThumb from '../MediaJobThumb';
import ImagePromptCandidates, { PromptCountInput } from '../ImagePromptCandidates';
import { genConfigToImageOptions, genConfigToRefineOptions, IMAGE_PROMPT_COUNT_DEFAULT } from './VisualGenSettings';

export default function StoryboardsStage({ issue, series, onStageUpdate, actionsGated = false }) {
  const navigate = useNavigate();
  const stage = issue.stages?.storyboards || { status: 'empty', scenes: [] };
  const [scenes, setScenes] = useState(stage.scenes || []);
  // Scene index currently minting a blank sketch (so its button shows a spinner
  // and can't be double-clicked while the POST is in flight).
  const [sketchingIdx, setSketchingIdx] = useState(null);
  // Cache-bust token per sketch key so the inline `/png` thumbnail refreshes
  // after an edit. Seeded once at mount (so a return from the annotate page
  // re-fetches) and bumped live when the server broadcasts `media:sketch:updated`.
  const [sketchNonces, setSketchNonces] = useState({});
  const mountNonceRef = useRef(0);
  if (mountNonceRef.current === 0) mountNonceRef.current = Date.now();

  useEffect(() => {
    const onSketchUpdated = ({ key }) => {
      if (!key) return;
      setSketchNonces((prev) => ({ ...prev, [key]: (prev[key] || mountNonceRef.current) + 1 }));
    };
    socket.on('media:sketch:updated', onSketchUpdated);
    return () => socket.off('media:sketch:updated', onSketchUpdated);
  }, []);
  const sketchSrc = (key) =>
    `/api/media/sketches/${encodeURIComponent(key)}/png?v=${sketchNonces[key] || mountNonceRef.current}`;
  // Per-stage gen config — edited from the page-level settings modal.
  const genConfig = stage.genConfig || null;
  const [savingIdx, setSavingIdx] = useState(null);
  const [renderingVideoIdx, setRenderingVideoIdx] = useState(null);
  const [refiningIdx, setRefiningIdx] = useState(null);
  // Non-destructive N-candidate image-prompt fan-out (issue #904). Tracks the
  // scene currently generating, the candidates keyed by scene index, the
  // user-chosen count, and which candidate is being applied.
  const [promptingIdx, setPromptingIdx] = useState(null);
  const [sceneCandidates, setSceneCandidates] = useState({});
  const [promptCount, setPromptCount] = useState(IMAGE_PROMPT_COUNT_DEFAULT);
  const [applyingCandidate, setApplyingCandidate] = useState(null);
  // Bumped whenever the scene list reindexes (remove / extract). A generate
  // request captures it before its await and drops a late response whose
  // generation is stale — otherwise an in-flight result could repopulate
  // candidates under an index now owned by a different scene.
  const candidateGenRef = useRef(0);
  // Active per-shot renders keyed by `${sceneIdx}:${shotIdx}` so multiple
  // shots can render concurrently with independent spinners. A single ref
  // would race when the user starts a second render before the first settles.
  const [renderingShots, setRenderingShots] = useState(() => new Set());
  const [extractingFrom, setExtractingFrom] = useState(null);
  // Which source ('teleplay' | 'prose') has a pending replace-confirm showing.
  // Separate from `extractingFrom` (which is purely the in-flight source) so the
  // inline confirm never gets conflated with an in-progress extract.
  const [confirmingFrom, setConfirmingFrom] = useState(null);

  // Canon characters (with wardrobes) live on the linked universe — load it
  // and derive the pickable set so each scene can offer a per-character
  // wardrobe picker. Only characters that own at least one wardrobe are pickable.
  const [universe] = useUniverse(series?.universeId);
  const wardrobeChars = useMemo(() => {
    const chars = Array.isArray(universe?.characters) ? universe.characters : [];
    return chars.filter((c) => Array.isArray(c?.wardrobes) && c.wardrobes.length > 0);
  }, [universe]);

  const teleplayReady = !!(issue.stages?.teleplay?.output || '').trim();
  const proseReady = !!(issue.stages?.prose?.output || '').trim();
  // A non-null value means an extract POST is in flight — both buttons must lock
  // out concurrent submits so racing requests can't overwrite each other's
  // results (last-write-wins).
  const extractInFlight = !!extractingFrom;

  const persist = async (nextScenes) => {
    setScenes(nextScenes);
    // Keep the ref coherent for every write path (not just the ones that set it
    // explicitly), so a discrete pick fired between a persist and the next
    // render — e.g. a wardrobe/shot select right after a removeScene reindex —
    // reads the freshly-persisted array instead of a stale render-scope snapshot.
    scenesRef.current = nextScenes;
    const updated = await updatePipelineIssue(issue.id, {
      stages: { storyboards: { status: nextScenes.length ? 'edited' : 'empty', scenes: nextScenes } },
    }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    if (updated) onStageUpdate?.('storyboards', updated.stages.storyboards, updated);
    return !!updated;
  };

  const addScene = () => persist([...scenes, { slugline: '', description: '', imageJobId: null }]);
  const removeScene = (i) => {
    // Removing a scene reindexes everything after it, so any index-keyed
    // candidate state would now point at the wrong scene — drop it all and
    // invalidate any in-flight generate so its late response can't reappear.
    candidateGenRef.current += 1;
    setSceneCandidates({});
    persist(scenes.filter((_, j) => j !== i));
  };
  // Ref mirrors the latest scenes so an async flush (e.g. the image-prompt
  // generate) reads the most recent keystroke rather than the render-scope
  // snapshot captured when the handler started. Mirrors ComicPagesStage's
  // pagesRef pattern.
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const updateScene = (i, patch) => {
    const next = scenes.map((s, j) => j === i ? { ...s, ...patch } : s);
    scenesRef.current = next;
    setScenes(next);
  };

  // Wardrobe picks are discrete selections (no blur), so persist immediately.
  // Takes a transform over the scene's CURRENT appearances applied against
  // scenesRef.current — not a pre-built array — so two back-to-back picks on
  // different characters in the same scene accumulate instead of clobbering.
  // (A pre-built payload would have been derived from the stale render-scope
  // scene, dropping the prior pick under last-write-wins server persistence.)
  // Mirrors updateShots' ref discipline.
  const setSceneAppearances = (i, transform) => {
    const next = scenesRef.current.map((s, j) => {
      if (j !== i) return s;
      const prev = Array.isArray(s.characterAppearances) ? s.characterAppearances : [];
      return { ...s, characterAppearances: transform(prev) };
    });
    scenesRef.current = next;
    return persist(next);
  };

  // Shot id stable enough for React keys + filename-hook correlation. Local
  // generation (vs server-assigned) is fine — every later persist round-trips
  // through the server which keeps whatever id the client wrote.
  const mintShotId = () => `shot-${Math.random().toString(36).slice(2, 10)}`;

  // Reads + writes scenesRef (not the render-scope `scenes`) so two discrete
  // picks fired back-to-back — e.g. setting shotType then screenDirection on the
  // same shot before a re-render — each build on the prior pick's result. Without
  // this, the second persist would ship a snapshot missing the first field and,
  // since the server serializes scenes writes (last-write-wins on the whole
  // array), silently clobber it. Mirrors updateScene's ref discipline.
  const updateShots = (sceneIdx, transform) => {
    const next = scenesRef.current.map((s, j) => {
      if (j !== sceneIdx) return s;
      const shots = Array.isArray(s.shots) ? s.shots : [];
      return { ...s, shots: transform(shots) };
    });
    scenesRef.current = next;
    setScenes(next);
    return next;
  };

  const addShot = (sceneIdx) => persist(updateShots(sceneIdx, (shots) =>
    [...shots, { id: mintShotId(), description: '', durationSeconds: 4 }]));
  const removeShot = (sceneIdx, shotIdx) => persist(updateShots(sceneIdx, (shots) =>
    shots.filter((_, j) => j !== shotIdx)));
  const updateShot = (sceneIdx, shotIdx, patch) => {
    // Local edit only — caller flushes via onBlur → persist(scenes).
    // When the description is hand-edited, the extractor-derived shotType /
    // screenDirection (#1315) were inferred from the OLD text and are now stale —
    // clear them to null ("not captured") so the deterministic visual.shot-continuity
    // check skips this shot rather than reporting an axis reversal that contradicts
    // the new description. The user can re-set them explicitly via the shot-grammar
    // selects below (setShotGrammar), which bypass this reset.
    const grammarReset = 'description' in patch ? { shotType: null, screenDirection: null } : {};
    updateShots(sceneIdx, (shots) => shots.map((sh, j) => j === shotIdx ? { ...sh, ...patch, ...grammarReset } : sh));
  };

  // Shot-grammar selects (#1468) are discrete picks (no blur), so persist
  // immediately — mirrors the wardrobe picker. Explicit user intent, so this
  // path NEVER applies updateShot's description-driven grammar reset. An empty
  // select value clears the field to null ("not captured"), which the
  // visual.shot-continuity check reads as ABSENT (skips the shot).
  const setShotGrammar = (sceneIdx, shotIdx, patch) =>
    persist(updateShots(sceneIdx, (shots) =>
      shots.map((sh, j) => j === shotIdx ? { ...sh, ...patch } : sh)));

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

  // Replacing existing scenes shows an inline confirm near the buttons (no
  // window.confirm per CLAUDE.md, no two-click-arm — the user disliked it). A
  // fresh stage (no scenes yet) extracts immediately.
  const onExtractClick = (from) => {
    if (scenes.length > 0) {
      setConfirmingFrom(from);
      return;
    }
    runExtract(from);
  };

  const runExtract = async (from) => {
    setConfirmingFrom(null);
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
    // Extraction replaces the whole scene list — stale index-keyed candidates
    // would now belong to different scenes; invalidate in-flight generates too.
    candidateGenRef.current += 1;
    setSceneCandidates({});
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
      // The generic visual route has no scene index, so the scene's wardrobe
      // picks ride along in the request body (video/shot paths read them
      // server-side from the persisted scene).
      characterAppearances: scene.characterAppearances,
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

  // Generate N non-destructive image-prompt candidates for the scene (issue
  // #904). Unlike "AI: refine", this never overwrites the description — the
  // user copies one or clicks "Use" to apply it explicitly.
  const handleGenerateImagePrompts = async (i) => {
    const scene = scenes[i];
    if (!scene.description?.trim()) {
      toast.error('Add a description first');
      return;
    }
    setPromptingIdx(i);
    // Flush any pending textarea edit before the server reads scene.description
    // (the server builds the prompt from the persisted text). Same guard the
    // shot-render path uses against the blur-save race.
    const gen = candidateGenRef.current;
    await persist(scenesRef.current);
    const result = await generatePipelineSceneImagePrompts(
      issue.id, i, { count: promptCount, ...genConfigToRefineOptions(genConfig) },
    ).catch((err) => {
      toast.error(err.message || 'Prompt generation failed');
      return null;
    });
    setPromptingIdx(null);
    if (!result) return;
    // Scene list reindexed (remove / extract) while we were generating — index
    // `i` no longer means the same scene, so discard the now-orphaned result.
    if (gen !== candidateGenRef.current) return;
    setSceneCandidates((prev) => ({ ...prev, [i]: result.candidates }));
    toast.success(`Generated ${result.candidates.length} prompt${result.candidates.length === 1 ? '' : 's'} for scene ${i + 1}`);
  };

  // Apply one candidate prompt to the scene description (the only mutating
  // path — copy stays clipboard-only). Persists via the shared write queue.
  const handleApplyCandidate = async (i, prompt, candidateIndex) => {
    setApplyingCandidate(`${i}:${candidateIndex}`);
    const ok = await persist(scenes.map((s, j) => j === i ? { ...s, description: prompt } : s));
    setApplyingCandidate(null);
    // Leave the candidates list up on a save failure so the user can retry —
    // persist already toasted the error.
    if (!ok) return;
    setSceneCandidates((prev) => {
      const next = { ...prev };
      delete next[i];
      return next;
    });
    toast.success(`Applied prompt to scene ${i + 1}`);
  };

  const dismissCandidates = (i) => setSceneCandidates((prev) => {
    const next = { ...prev };
    delete next[i];
    return next;
  });

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

  // Attach a blank-canvas storyboard sketch to this scene (issue #2036 phase 3).
  // The scene stores a `sketchKey` ("sketch:<uuid>") — a namespace the media
  // sketch service owns, minted server-side (crypto.randomUUID is unavailable on
  // PortOS's plain-HTTP origin). An existing key just reopens the same canvas.
  // The sketch page returns here (?returnTo=) at the same stage.
  const openSceneSketch = async (i) => {
    const scene = scenes[i];
    let key = scene.sketchKey;
    if (!key) {
      setSketchingIdx(i);
      const res = await createBlankSketch({ silent: true }).catch((err) => {
        toast.error(err.message || 'Failed to create sketch');
        return null;
      });
      setSketchingIdx(null);
      if (!res?.key) return;
      key = res.key;
      // Persist the key on the scene BEFORE navigating so a reload/return lands
      // on the same canvas. persist() resolves once the PATCH settles.
      const ok = await persist(scenes.map((s, j) => j === i ? { ...s, sketchKey: key } : s));
      if (!ok) return;
    }
    const returnTo = `/pipeline/issues/${issue.id}/storyboards`;
    navigate(`/media/annotate/${encodeURIComponent(key)}?returnTo=${encodeURIComponent(returnTo)}`);
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
            From Teleplay
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
            From prose
          </button>
          <PromptCountInput id="storyboard-prompt-count" value={promptCount} onChange={setPromptCount} />
          <button
            type="button"
            onClick={addScene}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50"
          >
            <Plus size={14} /> Add scene
          </button>
        </div>
      </div>

      {confirmingFrom && (
        <InlineConfirmRow
          tone="warning"
          question={`Replace ${scenes.length} existing scene${scenes.length === 1 ? '' : 's'} with a fresh extract from the ${confirmingFrom === 'teleplay' ? 'Teleplay' : 'prose'}?`}
          confirmText="Replace"
          onConfirm={() => runExtract(confirmingFrom)}
          onCancel={() => setConfirmingFrom(null)}
        />
      )}

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
                    onClick={() => handleGenerateImagePrompts(i)}
                    disabled={promptingIdx !== null || actionsGated}
                    title={actionsGated ? 'Saving settings…' : `Generate ${promptCount} alternative image-gen prompts without changing the description`}
                    className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-card border border-port-border text-white text-xs hover:border-port-accent/50 disabled:opacity-50"
                  >
                    {promptingIdx === i ? <Loader2 size={12} className="animate-spin" /> : <Layers size={12} />}
                    AI: {promptCount} prompts
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
                  <button
                    type="button"
                    onClick={() => openSceneSketch(i)}
                    disabled={sketchingIdx !== null}
                    title={scene.sketchKey ? 'Open this scene’s storyboard sketch' : 'Draw a blank-canvas storyboard sketch for this scene'}
                    className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-card border border-port-border text-white text-xs hover:border-port-accent/50 disabled:opacity-50"
                  >
                    {sketchingIdx === i ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />}
                    {scene.sketchKey ? 'Edit sketch' : 'Sketch'}
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
                  {scene.sketchKey ? (
                    <button
                      type="button"
                      onClick={() => openSceneSketch(i)}
                      title="Open this scene’s storyboard sketch"
                      className="block rounded border border-port-border overflow-hidden hover:border-port-accent/50"
                    >
                      {/* The flattened PNG sidecar is served at /png; the ?v
                          nonce (seeded at mount, bumped on media:sketch:updated)
                          busts the browser cache after each save. */}
                      <img
                        src={sketchSrc(scene.sketchKey)}
                        alt={`Scene ${i + 1} sketch`}
                        className="w-full h-auto"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                      />
                    </button>
                  ) : null}
                </div>
              </div>
              {sceneCandidates[i] ? (
                <ImagePromptCandidates
                  candidates={sceneCandidates[i]}
                  applyingIndex={applyingCandidate?.startsWith(`${i}:`) ? Number(applyingCandidate.split(':')[1]) : null}
                  onApply={(prompt, ci) => handleApplyCandidate(i, prompt, ci)}
                  onDismiss={() => dismissCandidates(i)}
                />
              ) : null}
              {wardrobeChars.length > 0 ? (
                <WardrobePicker
                  characters={wardrobeChars}
                  scene={scene}
                  onChange={(transform) => setSceneAppearances(i, transform)}
                />
              ) : null}
              <ShotList
                sceneIdx={i}
                shots={Array.isArray(scene.shots) ? scene.shots : []}
                renderingShots={renderingShots}
                actionsGated={actionsGated}
                onAddShot={() => addShot(i)}
                onRemoveShot={(j) => removeShot(i, j)}
                onUpdateShot={(j, patch) => updateShot(i, j, patch)}
                onSetShotGrammar={(j, patch) => setShotGrammar(i, j, patch)}
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
  onAddShot, onRemoveShot, onUpdateShot, onSetShotGrammar, onBlurShot, onRenderShot,
}) {
  const hasShots = shots.length > 0;
  // Inline pre-render continuity warnings (#1468): the same hazards the server
  // `visual.shot-continuity` editorial check surfaces, computed here from the
  // shots' shotType / screenDirection / continuityFromShotId so the user sees a
  // 180°-axis jump or shot-type monotony BEFORE spending render time — without a
  // round-trip through an editorial-checks run. Mirrors the inline lettering
  // warning pattern (#1313) in ComicScriptStage.
  const continuityWarnings = useMemo(() => sceneShotWarnings({ shots }), [shots]);
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
      {continuityWarnings.length > 0 ? (
        <ul className="mb-2 rounded border border-port-warning/30 bg-port-warning/5 px-2.5 py-1.5 space-y-0.5">
          {continuityWarnings.map((w, i) => (
            <li key={i} className="text-[11px] text-port-warning">
              ⚠ Continuity — {w.message}
            </li>
          ))}
        </ul>
      ) : null}
      {hasShots ? (
        <ul className="space-y-2">
          {shots.map((shot, j) => {
            const isRendering = renderingShots.has(`${sceneIdx}:${j}`);
            return (
              <li key={shot.id || j} className="flex items-start gap-2 p-2 bg-port-bg/40 border border-port-border/60 rounded">
                <span className="text-[10px] text-gray-500 font-mono pt-1.5 w-6">{j + 1}</span>
                <div className="flex-1 flex flex-col gap-1">
                  <textarea
                    value={shot.description || ''}
                    onChange={(e) => onUpdateShot(j, { description: e.target.value })}
                    onBlur={onBlurShot}
                    placeholder="One camera setup. Subject + framing + motion + mood."
                    rows={2}
                    className="px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
                    maxLength={4000}
                  />
                  {/* Shot-grammar editor (#1468): set/correct the film-grammar
                      fields the visual.shot-continuity check reads. Discrete
                      picks persist immediately and skip the description-driven
                      reset. '' = clear to "not captured" (skipped by the check). */}
                  <div className="flex gap-1">
                    <select
                      value={shot.shotType || ''}
                      onChange={(e) => onSetShotGrammar(j, { shotType: e.target.value || null })}
                      disabled={actionsGated}
                      aria-label={`Shot ${j + 1} framing`}
                      title="Camera framing — feeds the shot-type variety check"
                      className="flex-1 min-w-0 px-1.5 py-1 bg-port-bg border border-port-border rounded text-gray-300 text-[10px] disabled:opacity-50"
                    >
                      <option value="">— framing —</option>
                      {SHOT_TYPES.map((t) => (
                        <option key={t} value={t}>{SHOT_TYPE_LABELS[t] || t}</option>
                      ))}
                    </select>
                    <select
                      value={shot.screenDirection || ''}
                      onChange={(e) => onSetShotGrammar(j, { screenDirection: e.target.value || null })}
                      disabled={actionsGated}
                      aria-label={`Shot ${j + 1} screen direction`}
                      title="Which way the subject faces / moves — feeds the 180°-rule axis check"
                      className="flex-1 min-w-0 px-1.5 py-1 bg-port-bg border border-port-border rounded text-gray-300 text-[10px] disabled:opacity-50"
                    >
                      <option value="">— direction —</option>
                      {SCREEN_DIRECTIONS.map((d) => (
                        <option key={d} value={d}>{SCREEN_DIRECTION_LABELS[d] || d}</option>
                      ))}
                    </select>
                  </div>
                </div>
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

// Per-scene wardrobe picker. Mirrors the server's character matching — a
// wardrobe only takes effect for characters whose name/alias appears in the
// scene description (+slugline), which is exactly the set the prompt builder
// features — so we only offer a dropdown for those. The user picks each
// outfit explicitly (no extractor guess); selecting "default" clears the pick.
function WardrobePicker({ characters, scene, onChange }) {
  const [open, setOpen] = useState(false);
  const matched = matchCharactersInText(
    `${scene.description || ''} ${scene.slugline || ''}`,
    characters,
  );
  const appearances = Array.isArray(scene.characterAppearances) ? scene.characterAppearances : [];
  const wardrobeFor = (charId) =>
    appearances.find((a) => a && a.characterId === charId)?.wardrobeId || '';
  const pickCount = matched.filter((c) => wardrobeFor(c.id)).length;

  // Pass a transform (not a pre-built array) so the parent applies it against
  // the freshest persisted appearances — `appearances` here is the render-scope
  // prop and may lag a back-to-back pick on another character in this scene.
  const setWardrobe = (charId, wardrobeId) => {
    onChange((prev) => {
      const rest = (Array.isArray(prev) ? prev : []).filter((a) => a && a.characterId !== charId);
      return wardrobeId ? [...rest, { characterId: charId, wardrobeId }] : rest;
    });
  };

  if (matched.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-port-border/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-gray-500 hover:text-gray-300"
      >
        <Shirt size={12} />
        Wardrobe{pickCount > 0 ? ` (${pickCount})` : ''}
        <span className="text-gray-600">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <ul className="mt-2 space-y-1.5">
          {matched.map((char) => (
            <li key={char.id} className="flex items-center gap-2">
              <span className="text-xs text-gray-300 w-28 shrink-0 truncate" title={char.name}>{char.name}</span>
              <select
                value={wardrobeFor(char.id)}
                onChange={(e) => setWardrobe(char.id, e.target.value)}
                aria-label={`Wardrobe for ${char.name}`}
                className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
              >
                <option value="">— default outfit —</option>
                {char.wardrobes.map((w) => (
                  <option key={w.id} value={w.id}>{w.name || 'Unnamed outfit'}</option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
