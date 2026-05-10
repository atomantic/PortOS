/**
 * Comic Pages stage — assemble the visual side of the comic-book issue.
 *
 * MVP: structured list of pages, each with a list of panels. Each panel has
 * its own prompt + an "Enqueue image" button that hands off to the existing
 * image-gen pipeline (via /api/pipeline/issues/:id/stages/comicPages/visual).
 * Progress for each panel's image lands via the standard media-job SSE — for
 * the skeleton we just persist the jobId and show "queued"; deep progress
 * integration is deferred (see PLAN.md "Pipeline — Deferred").
 */

import { useState } from 'react';
import { Plus, Trash2, Sparkles, Loader2 } from 'lucide-react';
import toast from '../../ui/Toast';
import { generatePipelineVisualImage, updatePipelineIssue } from '../../../services/api';

export default function ComicPagesStage({ issue, onStageUpdate }) {
  const stage = issue.stages?.comicPages || { status: 'empty', pages: [] };
  const [pages, setPages] = useState(stage.pages || []);
  const [savingIdx, setSavingIdx] = useState(null);

  const persist = async (nextPages) => {
    setPages(nextPages);
    const updated = await updatePipelineIssue(issue.id, {
      stages: { comicPages: { status: nextPages.length ? 'edited' : 'empty', pages: nextPages } },
    }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    if (updated) onStageUpdate?.('comicPages', updated.stages.comicPages, updated);
  };

  const addPage = () => persist([...pages, { panels: [{ description: '', imageJobId: null }] }]);
  const addPanel = (pi) => {
    const next = pages.map((p, i) => i === pi ? { ...p, panels: [...(p.panels || []), { description: '', imageJobId: null }] } : p);
    persist(next);
  };
  const removePage = (pi) => persist(pages.filter((_, i) => i !== pi));
  const removePanel = (pi, ni) => {
    const next = pages.map((p, i) => i === pi
      ? { ...p, panels: (p.panels || []).filter((_, j) => j !== ni) }
      : p);
    persist(next);
  };
  const updatePanel = (pi, ni, patch) => {
    const next = pages.map((p, i) => i === pi
      ? { ...p, panels: (p.panels || []).map((q, j) => j === ni ? { ...q, ...patch } : q) }
      : p);
    setPages(next); // local-first; persist on blur via a dedicated save
  };

  const handleGeneratePanel = async (pi, ni) => {
    const panel = pages[pi].panels[ni];
    if (!panel.description?.trim()) {
      toast.error('Add a description first');
      return;
    }
    setSavingIdx(`${pi}:${ni}`);
    const result = await generatePipelineVisualImage(issue.id, 'comicPages', {
      description: panel.description,
    }).catch((err) => {
      toast.error(err.message || 'Failed to enqueue image');
      return null;
    });
    setSavingIdx(null);
    if (!result) return;
    const next = pages.map((p, i) => i === pi
      ? { ...p, panels: p.panels.map((q, j) => j === ni ? { ...q, imageJobId: result.jobId, prompt: result.prompt } : q) }
      : p);
    persist(next);
    toast.success(`Queued ${result.mode} image (${result.jobId.slice(0, 8)})`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-white">Comic Pages</h2>
          <p className="text-xs text-gray-500 mt-1">
            Define pages and panels. Each panel's description becomes an image-gen prompt prefixed by the series style.
            Image progress lives in the existing media-job queue. Episode video / multi-panel composition stitching is deferred.
          </p>
        </div>
        <button
          type="button"
          onClick={addPage}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50"
        >
          <Plus size={14} /> Add page
        </button>
      </div>

      {pages.length === 0 ? (
        <p className="text-xs text-gray-600 italic">No pages yet. Start with one and add panels.</p>
      ) : (
        <div className="space-y-4">
          {pages.map((page, pi) => (
            <div key={pi} className="p-3 bg-port-card border border-port-border rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs uppercase tracking-wider text-gray-500">Page {pi + 1}</span>
                <button
                  type="button"
                  onClick={() => removePage(pi)}
                  className="text-gray-500 hover:text-port-error p-1"
                  aria-label="Remove page"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <ul className="space-y-2">
                {(page.panels || []).map((panel, ni) => (
                  <li key={ni} className="flex items-start gap-2">
                    <span className="text-xs text-gray-600 mt-2 w-8 shrink-0">P{ni + 1}</span>
                    <textarea
                      value={panel.description || ''}
                      onChange={(e) => updatePanel(pi, ni, { description: e.target.value })}
                      onBlur={() => persist(pages)}
                      placeholder="Panel subject: wide shot, foundry crucible, dusk light, Lina silhouetted against the glow."
                      rows={2}
                      className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
                      maxLength={8000}
                    />
                    <div className="flex flex-col gap-1 items-stretch w-32">
                      <button
                        type="button"
                        onClick={() => handleGeneratePanel(pi, ni)}
                        disabled={savingIdx === `${pi}:${ni}`}
                        className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-accent text-white text-xs disabled:opacity-50"
                      >
                        {savingIdx === `${pi}:${ni}` ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                        Image
                      </button>
                      {panel.imageJobId ? (
                        <span className="text-[10px] text-gray-500 font-mono break-all">job {panel.imageJobId.slice(0, 8)}</span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => removePanel(pi, ni)}
                      className="text-gray-500 hover:text-port-error p-2"
                      aria-label="Remove panel"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => addPanel(pi)}
                className="mt-2 inline-flex items-center gap-1 text-xs text-port-accent hover:underline"
              >
                <Plus size={12} /> Add panel
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
