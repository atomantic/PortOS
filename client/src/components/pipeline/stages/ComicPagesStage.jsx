import { useRef, useState } from 'react';
import { Plus, Trash2, Sparkles, Loader2, Wand2, WandSparkles, ImagePlus, Layers } from 'lucide-react';
import toast from '../../ui/Toast';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import {
  generatePipelineVisualImage,
  generatePipelineComicPage,
  refinePipelineComicPanelPrompt,
  generatePipelineComicPanelImagePrompts,
  updatePipelineIssue,
  extractPipelineComicPages,
} from '../../../services/api';
import MediaJobThumb from '../MediaJobThumb';
import ImagePromptCandidates, { PromptCountInput } from '../ImagePromptCandidates';
import { genConfigToImageOptions, genConfigToRefineOptions, IMAGE_PROMPT_COUNT_DEFAULT } from './VisualGenSettings';

// NOTE: `ComicPagesStage` is currently unreachable in the running app —
// `PipelineIssue.jsx` redirects /comicPages URLs to /comicScript, where
// `ComicScriptStage` owns the merged page editor. The cover UI for this
// stage lives in ComicScriptStage. This component stays in the tree as a
// pure per-panel editor so a future view that lands directly here still
// works.

export default function ComicPagesStage({ issue, onStageUpdate, actionsGated = false }) {
  const stage = issue.stages?.comicPages || { status: 'empty', pages: [] };
  const [pages, setPages] = useState(stage.pages || []);
  const genConfig = stage.genConfig || null;
  const [savingIdx, setSavingIdx] = useState(null);
  const [refiningKey, setRefiningKey] = useState(null);
  // Non-destructive N-candidate image-prompt fan-out (issue #904), keyed by
  // `${pi}:${ni}` so each panel tracks its own in-flight + candidate state.
  const [promptingKey, setPromptingKey] = useState(null);
  const [panelCandidates, setPanelCandidates] = useState({});
  const [promptCount, setPromptCount] = useState(IMAGE_PROMPT_COUNT_DEFAULT);
  const [applyingCandidate, setApplyingCandidate] = useState(null);
  // Bumped whenever the page/panel tree reindexes (remove / extract). A
  // generate request captures it before its await and drops a late response
  // whose generation is stale, so an in-flight result can't repopulate
  // candidates under a `${pi}:${ni}` key now owned by a different panel.
  const candidateGenRef = useRef(0);
  // Per-page in-flight state. Codex can render multiple pages in parallel, so
  // tracking a single index would flip the spinner off the wrong button when
  // the first request finished while a second was still pending.
  const [renderingPages, setRenderingPages] = useState(() => new Set());
  const markRendering = (pi, on) => setRenderingPages((prev) => {
    const next = new Set(prev);
    if (on) next.add(pi); else next.delete(pi);
    return next;
  });
  const [extracting, setExtracting] = useState(false);

  const comicScriptReady = !!(issue.stages?.comicScript?.output || '').trim();

  const persist = async (nextPages) => {
    setPages(nextPages);
    const updated = await updatePipelineIssue(issue.id, {
      stages: { comicPages: { status: nextPages.length ? 'edited' : 'empty', pages: nextPages } },
    }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    if (updated) onStageUpdate?.('comicPages', updated.stages.comicPages, updated);
    return !!updated;
  };

  const addPage = () => persist([...pages, { panels: [{ description: '', imageJobId: null }] }]);
  const addPanel = (pi) => {
    const next = pages.map((p, i) => i === pi ? { ...p, panels: [...(p.panels || []), { description: '', imageJobId: null }] } : p);
    persist(next);
  };
  // Removing a page or panel reindexes the `${pi}:${ni}`-keyed candidates after
  // it, so any open candidate list would point at the wrong panel — drop them
  // and invalidate any in-flight generate so its late response can't reappear.
  const removePage = (pi) => {
    candidateGenRef.current += 1;
    setPanelCandidates({});
    persist(pages.filter((_, i) => i !== pi));
  };
  const removePanel = (pi, ni) => {
    candidateGenRef.current += 1;
    setPanelCandidates({});
    const next = pages.map((p, i) => i === pi
      ? { ...p, panels: (p.panels || []).filter((_, j) => j !== ni) }
      : p);
    persist(next);
  };
  // Ref tracks the latest pages array so onBlur's persist call doesn't read a
  // stale render-scope value — onChange schedules a setPages, then onBlur fires
  // synchronously in the same browser tick (before React re-renders), so without
  // this the persisted snapshot would miss the user's last keystroke.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const updatePanel = (pi, ni, patch) => {
    const next = pages.map((p, i) => i === pi
      ? { ...p, panels: (p.panels || []).map((q, j) => j === ni ? { ...q, ...patch } : q) }
      : p);
    pagesRef.current = next;
    setPages(next);
  };

  const runExtract = async () => {
    setExtracting(true);
    const result = await extractPipelineComicPages(issue.id, { force: true }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Page extraction failed');
      return null;
    });
    setExtracting(false);
    if (!result) return;
    setPages(result.stage?.pages || []);
    // Extraction replaces the whole page/panel tree — stale candidates would
    // now belong to different panels; invalidate in-flight generates too.
    candidateGenRef.current += 1;
    setPanelCandidates({});
    onStageUpdate?.('comicPages', result.stage, result.issue);
    toast.success(`Extracted ${result.pageCount} page${result.pageCount === 1 ? '' : 's'} / ${result.panelCount} panel${result.panelCount === 1 ? '' : 's'}`);
  };
  const [confirmingExtract, setConfirmingExtract] = useState(false);
  const onExtractClick = () => {
    // Nothing to clobber on a fresh stage — extract immediately. The inline
    // confirm only guards a destructive replace of existing pages.
    if (pages.length === 0) {
      runExtract();
      return;
    }
    setConfirmingExtract(true);
  };
  const confirmExtract = () => {
    setConfirmingExtract(false);
    runExtract();
  };

  const handleGeneratePage = async (pi) => {
    const page = pages[pi];
    const panelCount = page?.panels?.length || 0;
    if (panelCount === 0) {
      toast.error('Add at least one panel description first');
      return;
    }
    markRendering(pi, true);
    const result = await generatePipelineComicPage(issue.id, pi, genConfigToImageOptions(genConfig), { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to enqueue page render');
      return null;
    });
    markRendering(pi, false);
    if (!result) return;
    if (result.issue) {
      const next = result.issue.stages?.comicPages?.pages || [];
      setPages(next);
      onStageUpdate?.('comicPages', result.issue.stages.comicPages, result.issue);
    } else {
      const next = pages.map((p, i) => i === pi ? { ...p, imageJobId: result.jobId, prompt: result.prompt } : p);
      setPages(next);
    }
    toast.success(`Queued ${result.mode} page render (${result.jobId.slice(0, 8)})`);
  };

  // LLM-driven refinement of a single panel's description into a richer
  // image-gen prompt. Server replaces the persisted description with the
  // refined version and returns the updated issue.
  const handleRefinePanel = async (pi, ni) => {
    const panel = pages[pi]?.panels?.[ni];
    if (!panel?.description?.trim()) {
      toast.error('Add a description first');
      return;
    }
    const key = `${pi}:${ni}`;
    setRefiningKey(key);
    const result = await refinePipelineComicPanelPrompt(issue.id, pi, ni, genConfigToRefineOptions(genConfig), { silent: true })
      .catch((err) => {
        toast.error(err.message || 'Refine failed');
        return null;
      });
    setRefiningKey(null);
    if (!result) return;
    if (result.issue) {
      setPages(result.issue.stages?.comicPages?.pages || []);
      onStageUpdate?.('comicPages', result.issue.stages.comicPages, result.issue);
    }
    const summary = result.changes?.[0] ? ` — ${result.changes[0]}` : '';
    toast.success(`Refined panel ${pi + 1}.${ni + 1}${summary}`);
  };

  // Generate N non-destructive image-prompt candidates for a panel (issue
  // #904). Never overwrites the description — the user copies or applies one.
  const handleGenerateImagePrompts = async (pi, ni) => {
    const panel = pages[pi]?.panels?.[ni];
    if (!panel?.description?.trim()) {
      toast.error('Add a description first');
      return;
    }
    const key = `${pi}:${ni}`;
    setPromptingKey(key);
    // Flush any pending textarea edit before the server reads the panel
    // description (it builds the prompt from the persisted text). pagesRef
    // holds the latest keystroke that onBlur may not have committed yet.
    const gen = candidateGenRef.current;
    await persist(pagesRef.current);
    const result = await generatePipelineComicPanelImagePrompts(
      issue.id, pi, ni, { count: promptCount, ...genConfigToRefineOptions(genConfig) }, { silent: true },
    ).catch((err) => {
      toast.error(err.message || 'Prompt generation failed');
      return null;
    });
    setPromptingKey(null);
    if (!result) return;
    // Page/panel tree reindexed (remove / extract) while we were generating —
    // `${pi}:${ni}` no longer means the same panel, so discard the result.
    if (gen !== candidateGenRef.current) return;
    setPanelCandidates((prev) => ({ ...prev, [key]: result.candidates }));
    toast.success(`Generated ${result.candidates.length} prompt${result.candidates.length === 1 ? '' : 's'} for panel ${pi + 1}.${ni + 1}`);
  };

  const handleApplyCandidate = async (pi, ni, prompt, candidateIndex) => {
    const key = `${pi}:${ni}`;
    setApplyingCandidate(`${key}:${candidateIndex}`);
    const next = pages.map((p, i) => i === pi
      ? { ...p, panels: (p.panels || []).map((q, j) => j === ni ? { ...q, description: prompt } : q) }
      : p);
    const ok = await persist(next);
    setApplyingCandidate(null);
    // Keep the candidates list up on a save failure so the user can retry —
    // persist already toasted the error.
    if (!ok) return;
    setPanelCandidates((prev) => {
      const rest = { ...prev };
      delete rest[key];
      return rest;
    });
    toast.success(`Applied prompt to panel ${pi + 1}.${ni + 1}`);
  };

  const dismissCandidates = (pi, ni) => setPanelCandidates((prev) => {
    const rest = { ...prev };
    delete rest[`${pi}:${ni}`];
    return rest;
  });

  const handleGeneratePanel = async (pi, ni) => {
    const panel = pages[pi].panels[ni];
    if (!panel.description?.trim()) {
      toast.error('Add a description first');
      return;
    }
    setSavingIdx(`${pi}:${ni}`);
    const result = await generatePipelineVisualImage(issue.id, 'comicPages', {
      description: panel.description,
      ...genConfigToImageOptions(genConfig),
    }, { silent: true }).catch((err) => {
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
            Define pages and panels. <strong className="text-gray-400">Generate page</strong> renders the entire page as one image — the recommended path for Codex / cloud image models. Per-panel renders are a fallback (smaller local models, or fine-tuning a single frame).
            Image progress lives in the existing media-job queue.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={onExtractClick}
            disabled={!comicScriptReady || extracting}
            title={comicScriptReady ? 'Parse the comic script into pages and panels — descriptions go straight into image-gen prompts' : 'Generate the comic script first'}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {extracting ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            From comic script
          </button>
          <PromptCountInput id="comic-prompt-count" value={promptCount} onChange={setPromptCount} />
          <button
            type="button"
            onClick={addPage}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50"
          >
            <Plus size={14} /> Add page
          </button>
        </div>
      </div>

      {confirmingExtract && (
        <InlineConfirmRow
          tone="warning"
          question={`Replace ${pages.length} existing page${pages.length === 1 ? '' : 's'} with a fresh extract from the comic script?`}
          confirmText="Replace"
          onConfirm={confirmExtract}
          onCancel={() => setConfirmingExtract(false)}
        />
      )}

      {pages.length === 0 ? (
        <p className="text-xs text-gray-600 italic">No pages yet. Start with one and add panels.</p>
      ) : (
        <div className="space-y-4">
          {pages.map((page, pi) => (
            <div key={pi} className="p-3 bg-port-card border border-port-border rounded-lg">
              <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                <span className="text-xs uppercase tracking-wider text-gray-500">Page {pi + 1}</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleGeneratePage(pi)}
                    disabled={renderingPages.has(pi) || !(page.panels?.length > 0) || actionsGated}
                    title={actionsGated ? 'Saving settings…' : 'Render the entire page as one image — recommended for Codex / cloud image models. Local models will produce draft-quality results.'}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {renderingPages.has(pi)
                      ? <Loader2 size={12} className="animate-spin" />
                      : <ImagePlus size={12} />}
                    Generate page
                  </button>
                  {page.imageJobId ? (
                    <div className="flex items-center gap-2">
                      <MediaJobThumb jobId={page.imageJobId} label={`Page ${pi + 1}`} size="md" fallbackFilename={page.filename || null} />
                      <span className="text-[10px] text-gray-500 font-mono break-all" title="Last page render job">
                        {page.imageJobId.slice(0, 8)}
                      </span>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => removePage(pi)}
                    className="text-gray-500 hover:text-port-error p-1"
                    aria-label="Remove page"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <ul className="space-y-2">
                {(page.panels || []).map((panel, ni) => (
                  <li key={ni} className="space-y-2">
                    <div className="flex items-start gap-2">
                      <span className="text-xs text-gray-600 mt-2 w-8 shrink-0">P{ni + 1}</span>
                      <textarea
                        value={panel.description || ''}
                        onChange={(e) => updatePanel(pi, ni, { description: e.target.value })}
                        onBlur={() => persist(pagesRef.current)}
                        placeholder="Panel subject: wide shot, foundry crucible, dusk light, Lina silhouetted against the glow."
                        rows={2}
                        className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
                        maxLength={8000}
                      />
                      <div className="flex flex-col gap-1 items-stretch w-32">
                        <button
                          type="button"
                          onClick={() => handleRefinePanel(pi, ni)}
                          disabled={refiningKey !== null || actionsGated}
                          title={actionsGated ? 'Saving settings…' : 'Elaborate this panel description into a richer image-gen prompt (LLM call — replaces the current text)'}
                          className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-card border border-port-border text-white text-xs hover:border-port-accent/50 disabled:opacity-50"
                        >
                          {refiningKey === `${pi}:${ni}` ? <Loader2 size={12} className="animate-spin" /> : <WandSparkles size={12} />}
                          AI: refine
                        </button>
                        <button
                          type="button"
                          onClick={() => handleGenerateImagePrompts(pi, ni)}
                          disabled={promptingKey !== null || actionsGated}
                          title={actionsGated ? 'Saving settings…' : `Generate ${promptCount} alternative image-gen prompts without changing the description`}
                          className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-card border border-port-border text-white text-xs hover:border-port-accent/50 disabled:opacity-50"
                        >
                          {promptingKey === `${pi}:${ni}` ? <Loader2 size={12} className="animate-spin" /> : <Layers size={12} />}
                          AI: {promptCount} prompts
                        </button>
                        <button
                          type="button"
                          onClick={() => handleGeneratePanel(pi, ni)}
                          disabled={savingIdx === `${pi}:${ni}` || actionsGated}
                          title={actionsGated ? 'Saving settings…' : undefined}
                          className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-port-accent text-white text-xs disabled:opacity-50"
                        >
                          {savingIdx === `${pi}:${ni}` ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                          Image
                        </button>
                        {panel.imageJobId ? (
                          <>
                            <MediaJobThumb jobId={panel.imageJobId} label={`Panel ${ni + 1}`} size="sm" />
                            <span className="text-[10px] text-gray-500 font-mono break-all">job {panel.imageJobId.slice(0, 8)}</span>
                          </>
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
                    </div>
                    {panelCandidates[`${pi}:${ni}`] ? (
                      <ImagePromptCandidates
                        candidates={panelCandidates[`${pi}:${ni}`]}
                        applyingIndex={applyingCandidate?.startsWith(`${pi}:${ni}:`) ? Number(applyingCandidate.split(':')[2]) : null}
                        onApply={(prompt, ci) => handleApplyCandidate(pi, ni, prompt, ci)}
                        onDismiss={() => dismissCandidates(pi, ni)}
                      />
                    ) : null}
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
