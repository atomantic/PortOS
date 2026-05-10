/**
 * Storyboards stage — one storyboard image per TV-script scene.
 *
 * MVP: flat list of scenes. Each scene has its own description and a
 * "Generate storyboard image" button that hands off to image-gen via the
 * pipeline visual endpoint. Per-scene video rendering via Creative Director
 * is deferred — see PLAN.md "Pipeline — Deferred".
 */

import { useState } from 'react';
import { Plus, Trash2, Sparkles, Loader2 } from 'lucide-react';
import toast from '../../ui/Toast';
import { generatePipelineVisualImage, updatePipelineIssue } from '../../../services/api';

export default function StoryboardsStage({ issue, onStageUpdate }) {
  const stage = issue.stages?.storyboards || { status: 'empty', scenes: [] };
  const [scenes, setScenes] = useState(stage.scenes || []);
  const [savingIdx, setSavingIdx] = useState(null);

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

  const handleGenerate = async (i) => {
    const scene = scenes[i];
    if (!scene.description?.trim()) {
      toast.error('Add a description first');
      return;
    }
    setSavingIdx(i);
    const result = await generatePipelineVisualImage(issue.id, 'storyboards', {
      description: scene.description,
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-white">Storyboards</h2>
          <p className="text-xs text-gray-500 mt-1">
            One image per scene, fed by the TV script. Use sluglines to keep parity with the teleplay. Scene-video rendering through Creative Director is deferred.
          </p>
        </div>
        <button
          type="button"
          onClick={addScene}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50"
        >
          <Plus size={14} /> Add scene
        </button>
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
                    onClick={() => handleGenerate(i)}
                    disabled={savingIdx === i}
                    className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-accent text-white text-xs disabled:opacity-50"
                  >
                    {savingIdx === i ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    Storyboard
                  </button>
                  {scene.imageJobId ? (
                    <span className="text-[10px] text-gray-500 font-mono break-all">job {scene.imageJobId.slice(0, 8)}</span>
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
