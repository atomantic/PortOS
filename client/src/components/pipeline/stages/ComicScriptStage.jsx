/**
 * Merged Comic Script + Comic Pages editor. The full markdown still lives on
 * `stages.comicScript.output` and the parsed page records still live on
 * `stages.comicPages.pages[]` — this component just folds them into one
 * page-by-page view: each page is an editable markdown slice on the left and
 * a full-page render on the right. Panels are still parsed internally so the
 * render prompt stays high-quality, but they're never shown.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, Sparkles, ImageIcon, Save, Trash2, ChevronDown, ChevronRight, Settings as SettingsIcon, FileDown, Layers, Wand2 } from 'lucide-react';
import toast from '../../ui/Toast';
import {
  generatePipelineStage,
  extractPipelineComicPages,
  generatePipelineComicPage,
  generatePipelineComicCover,
  generatePipelineComicBackCover,
  generatePipelineComicCoverConcepts,
  updatePipelineComicPage,
  refinePipelineComicPageRender,
  updatePipelineIssue,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGE_STATUS_LABEL as STATUS_LABEL,
  PIPELINE_STAGE_STATUS_COLOR as STATUS_COLOR,
} from '../../../services/api';
import { getSettings, patchSettingsSlice } from '../../../services/apiSystem';
import { listImageModels } from '../../../services/apiImageVideo';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import { useConfirmDelete } from '../../../hooks/useConfirmDelete';
import useSlotInFlight from '../../../hooks/useSlotInFlight';
import MediaJobThumb from '../MediaJobThumb';
import MediaPreview from '../../media/MediaPreview';
import usePreviewRoute from '../../../hooks/usePreviewRoute';
import Drawer from '../../Drawer';
import ImageGenSettingsForm from '../../imageGen/ImageGenSettingsForm';
import ExtractCanonButton from './ExtractCanonButton';
import { deriveAvailableBackends, IMAGE_GEN_MODE } from '../../../lib/imageGenBackends';
import {
  PIPELINE_IMAGE_DEFAULTS,
  readPipelineImageSettings,
  pipelineImageCfgToRenderOpts,
} from '../../../lib/pipelineImageDefaults';
import { analyzeComicLettering } from '../../../lib/letteringDensity';

// Severity → Tailwind text color for the inline lettering warnings. Mirrors the
// editorial check's overflow-scaled severity.
const LETTERING_TONE = { high: 'text-port-error', medium: 'text-port-warning', low: 'text-gray-400' };

// A short, page-row-scoped label for a lettering violation (the same accounting
// the server `comic.lettering-density` check surfaces in the manuscript editor —
// here it's shown inline as the author edits, using the default thresholds).
function letteringWarningLabel(v) {
  switch (v.kind) {
    case 'balloon-words':
      return `Panel ${v.panelNumber}: a balloon runs ${v.count} words (over ~${v.threshold})`;
    case 'caption-words':
      return `Panel ${v.panelNumber}: a caption box runs ${v.count} words (over ~${v.threshold})`;
    case 'panel-words':
      return `Panel ${v.panelNumber}: ${v.count} words of lettering (over ~${v.threshold})`;
    case 'panel-balloons':
      return `Panel ${v.panelNumber}: ${v.count} balloons (over ~${v.threshold})`;
    case 'page-words':
    default:
      return `Page total ${v.count} words of lettering (over ~${v.threshold}) — would overwhelm the art`;
  }
}

// Legacy records (pre-proof/final split) carry `imageJobId`/`filename` at
// the record root; surface those as the proof slot so the UI keeps showing
// the old render until the user re-renders into the new shape. Carry
// `rec.prompt` onto the synthesized slot so the lightbox prompt (and any
// downstream slot.prompt readers) still see the original generation prompt
// before the server migrates the record into the new shape on the next
// render — `comicPagesFilenameHook` propagates `record.prompt` /
// `page.prompt` into the new slot via `legacySlotRecord` for the persisted
// migration; this mirror keeps the unmigrated client view consistent.
const getProofSlot = (rec) => {
  if (!rec) return null;
  if (rec.proofImage?.jobId || rec.proofImage?.filename) return rec.proofImage;
  if (rec.imageJobId || rec.filename) {
    return {
      jobId: rec.imageJobId || null,
      filename: rec.filename || null,
      prompt: rec.prompt || null,
    };
  }
  return null;
};

const getFinalSlot = (rec) => (rec?.finalImage?.jobId || rec?.finalImage?.filename ? rec.finalImage : null);

// Whichever slot the user should see as "rendered" for PDF-readiness math
// and the lightbox preview — final wins over proof when both exist.
const getPreferredSlot = (rec) => getFinalSlot(rec) || getProofSlot(rec);

// Tooltip text for the "Render final" button — picks the first applicable
// reason from a precedence chain so the user always sees the most specific
// blocker. `dirtyMsg` is page-only; the cover row passes null.
function finalButtonTooltip({ gated, inFlight, needsProof, dirty, dirtyMsg, defaultMsg }) {
  if (gated) return 'Saving settings…';
  if (dirty) return dirtyMsg;
  if (inFlight) return 'Final render in progress…';
  if (needsProof) return 'Render the proof first — "from proof" needs a completed proof image to use as the i2i base.';
  return defaultMsg;
}

// Shared proof/final thumb cell — used by both the cover row and the per-
// page row. Header shows the variant label + WxH; body shows the
// MediaJobThumb (or an empty-state hint when the slot is unpopulated).
function RenderSlotThumb({
  slot, label, emptyHint, thumbLabel, size = 'md',
  onStatus, onFilename, onPreview, fillFromProofLabel = false,
}) {
  return (
    <div className="flex flex-col bg-port-bg border border-port-border rounded p-1.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wider text-gray-500">
          {label}{fillFromProofLabel && slot?.fromProof ? ' (from proof)' : ''}
        </span>
        {slot?.width && slot?.height ? (
          <span className="text-[10px] text-gray-600">{slot.width}×{slot.height}</span>
        ) : null}
      </div>
      <div className="flex-1 flex items-center justify-center overflow-hidden">
        {slot?.jobId ? (
          <MediaJobThumb
            jobId={slot.jobId}
            label={thumbLabel}
            size={size}
            onStatus={onStatus}
            onFilename={onFilename}
            onPreview={onPreview}
            fallbackFilename={slot.filename || null}
          />
        ) : (
          <span className="text-[10px] text-gray-500 italic">{emptyHint}</span>
        )}
      </div>
    </div>
  );
}

// Reconstructs a page's markdown from its parsed `panels[]`. Used as a
// fallback for pages persisted BEFORE the parser started preserving rawText —
// without it those pages would render as empty textareas, and a Save click
// would PATCH an empty rawText and silently wipe the panels.
function panelsToMarkdown(panels, pageNumber) {
  const lines = [`## Page ${pageNumber}`, ''];
  (panels || []).forEach((p, i) => {
    lines.push(`### Panel ${i + 1}`);
    if (p.description) lines.push(`**Description:** ${p.description}`);
    if (p.caption) lines.push(`**Caption:** ${p.caption}`);
    if (Array.isArray(p.dialogue) && p.dialogue.length) {
      lines.push('**Dialogue:**');
      for (const d of p.dialogue) {
        const line = (d.line || '').trim();
        if (line) lines.push(`- ${(d.character || 'CHAR').trim() || 'CHAR'}: "${line}"`);
      }
    }
    if (p.sfx) lines.push(`**SFX:** ${p.sfx}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

export default function ComicScriptStage({ issue, series, onStageUpdate, actionsGated = false }) {
  const script = issue.stages?.comicScript || { status: 'empty', output: '' };
  const comicPages = issue.stages?.comicPages || { status: 'empty', pages: [] };
  const pages = Array.isArray(comicPages.pages) ? comicPages.pages : [];
  const hasScript = !!(script.output || '').trim();
  // Page-delete confirmation is owned here, not per-PageRow: pages are keyed
  // and deleted by array index, so a single shared "armed page" guarantees
  // only one delete is armed at a time — without it, arming two pages then
  // confirming one shifts the indices and the still-armed confirm would point
  // at (and delete) the wrong page.
  const { isConfirming: isPageConfirmingDelete, requestDelete: requestPageDelete, cancelDelete: cancelPageDelete, confirmDelete: confirmPageDelete } = useConfirmDelete();

  const [localGenerating, setLocalGenerating] = useState(false);
  const [serverGenerating, setServerGenerating] = useState(script.status === 'generating');
  // Sync with auto-run status pushed in from outside this component.
  useEffect(() => { setServerGenerating(script.status === 'generating'); }, [script.status]);
  const generating = localGenerating || serverGenerating;
  const [extracting, setExtracting] = useState(false);
  const [showSource, setShowSource] = useState(false);

  // Per-render image-gen config. Defaults pick Codex if it's enabled
  // system-wide; the user can override via the right-side Drawer and we
  // persist their choice to settings.pipeline.imageGen so it sticks across
  // page reloads.
  const [imageCfg, setImageCfg] = useState(PIPELINE_IMAGE_DEFAULTS);
  const [imageModels, setImageModels] = useState([]);
  const [sysSettings, setSysSettings] = useState(null);
  // Shared lightbox state. PageRow reports its rendered filename up via
  // `onFilenameKnown` so the parent can build a navigable items list keyed by
  // page order — preview prev/next walks rendered pages in page order. URL-
  // driven via `usePreviewRoute(previewItems)` below so the modal deep-links.
  const [filenameByJobId, setFilenameByJobId] = useState({});
  const onFilenameKnown = useCallback((jobId, filename) => {
    if (!jobId || !filename) return;
    setFilenameByJobId((prev) => prev[jobId] === filename ? prev : { ...prev, [jobId]: filename });
  }, []);
  // Prompt lives on the render slot (proofImage/finalImage), not at the page
  // root — the server stamps the prompt it sent to the image-gen backend on
  // each slot as it's enqueued. Read from there so the lightbox surfaces the
  // actual generation prompt (and "Refine Prompt" has something to refine).
  const buildPageItem = useCallback((pageIndex, slot, filename) => ({
    key: `comic-page:${filename}`,
    kind: 'image',
    filename,
    previewUrl: `/data/images/${filename}`,
    downloadUrl: `/data/images/${filename}`,
    prompt: slot?.prompt || `Page ${pageIndex + 1}`,
  }), []);
  const previewItems = useMemo(() => {
    const pageList = Array.isArray(comicPages.pages) ? comicPages.pages : [];
    const out = [];
    // Include BOTH proof + final slots when both exist so URL-driven
    // resolution by filename picks the slot whose prompt produced *this*
    // image. Filenames are unique per render so the two entries never
    // collide. Final is listed first so a deep-link to a page that has
    // both shows the hi-res variant.
    pageList.forEach((p, idx) => {
      for (const slot of [getFinalSlot(p), getProofSlot(p)]) {
        if (!slot?.jobId) continue;
        const filename = slot.filename || filenameByJobId[slot.jobId];
        if (!filename) continue;
        // De-dupe in case a legacy record stores the same filename in both
        // slots (older pre-proof renders).
        if (out.some((i) => i.filename === filename)) continue;
        out.push(buildPageItem(idx, slot, filename));
      }
    });
    return out;
  }, [comicPages.pages, filenameByJobId, buildPageItem]);
  const [preview, setPreview] = usePreviewRoute(previewItems);
  const openPreview = useCallback((pageIndex, filename) => {
    if (!filename) return;
    const match = previewItems.find((i) => i.filename === filename);
    if (match) setPreview(match);
  }, [previewItems, setPreview]);
  const availableBackends = useMemo(
    () => deriveAvailableBackends(sysSettings, { excludeExternal: true }),
    [sysSettings],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getSettings().catch(() => ({})),
      listImageModels().catch(() => []),
    ]).then(([s, modelList]) => {
      if (cancelled) return;
      setSysSettings(s);
      setImageCfg(readPipelineImageSettings(s));
      setImageModels(Array.isArray(modelList) ? modelList : []);
    });
    return () => { cancelled = true; };
  }, []);

  const persistImageCfg = useCallback(async (next) => {
    setImageCfg(next);
    await patchSettingsSlice('pipeline', { imageGen: next }, { silent: true })
      .catch((err) => toast.error(`Settings save failed: ${err.message}`));
  }, []);

  // URL-driven drawer state — mirrors StoryboardPanel so the settings panel
  // is deep-linkable per project convention.
  const [searchParams, setSearchParams] = useSearchParams();
  const settingsOpen = searchParams.get('settings') === 'comic-image';
  const openImageSettings = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('settings', 'comic-image');
      return next;
    });
  }, [setSearchParams]);
  const closeImageSettings = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('settings');
      return next;
    });
  }, [setSearchParams]);

  const renderOpts = useMemo(() => pipelineImageCfgToRenderOpts(imageCfg), [imageCfg]);

  // Front + back cover live on stages.comicPages.cover / .backCover; both
  // persist alongside the page renders. Each owns a draft string separate
  // from the persisted value so keystrokes don't round-trip until blur.
  const cover = comicPages.cover || { script: '', proofImage: null, finalImage: null };
  const coverProof = getProofSlot(cover);
  const coverFinal = getFinalSlot(cover);
  const [draftCoverScript, setDraftCoverScript] = useState(cover.script || '');
  useEffect(() => { setDraftCoverScript(cover.script || ''); }, [cover.script]);
  const { inFlight: coverProofInFlight, setStatus: setCoverProofStatus } = useSlotInFlight(coverProof);
  const { inFlight: coverFinalInFlight, setStatus: setCoverFinalStatus } = useSlotInFlight(coverFinal);

  const backCover = comicPages.backCover || { script: '', proofImage: null, finalImage: null };
  const backProof = getProofSlot(backCover);
  const backFinal = getFinalSlot(backCover);
  const [draftBackCoverScript, setDraftBackCoverScript] = useState(backCover.script || '');
  useEffect(() => { setDraftBackCoverScript(backCover.script || ''); }, [backCover.script]);
  const { inFlight: backProofInFlight, setStatus: setBackProofStatus } = useSlotInFlight(backProof);
  const { inFlight: backFinalInFlight, setStatus: setBackFinalStatus } = useSlotInFlight(backFinal);

  // One indexed busy map for all four cover×variant render buttons —
  // collapses what would otherwise be four useState booleans and the
  // nested ternaries needed to pick the right setter inside the shared
  // render handler.
  const [busy, setBusy] = useState({ coverProof: false, coverFinal: false, backProof: false, backFinal: false });
  const setBusyFor = (target, variant, value) => {
    const key = `${target === 'backCover' ? 'back' : 'cover'}${variant === 'final' ? 'Final' : 'Proof'}`;
    setBusy((b) => ({ ...b, [key]: value }));
  };

  // i2i "from proof" toggles are independent per cover field — Codex
  // backend can't honor i2i regardless, so the toggle is disabled there.
  const [useProofForCoverFinal, setUseProofForCoverFinal] = useState(true);
  const [useProofForBackFinal, setUseProofForBackFinal] = useState(true);

  const [generatingConcept, setGeneratingConcept] = useState({ cover: false, backCover: false });

  const handleGenerateConcept = async (target) => {
    const label = target === 'backCover' ? 'Back cover' : 'Cover';
    setGeneratingConcept((g) => ({ ...g, [target]: true }));
    const result = await generatePipelineComicCoverConcepts(issue.id, {
      target,
      commit: true,
      providerOverride: series?.llm?.provider || undefined,
      modelOverride: series?.llm?.model || undefined,
    }, { silent: true }).catch((err) => {
      toast.error(err.message || `Failed to generate ${label.toLowerCase()} concept`);
      return null;
    });
    setGeneratingConcept((g) => ({ ...g, [target]: false }));
    if (!result) return;
    if (result.stage) onStageUpdate?.('comicPages', result.stage, result.issue);
    const seededThis = target === 'backCover' ? result.seeded?.backCover : result.seeded?.cover;
    toast.success(seededThis
      ? `${label} concept seeded`
      : `${label} concept generated (existing edit preserved)`);
  };

  const renderConceptButton = (target, script) => {
    const generating = generatingConcept[target];
    const filled = !!(script || '').trim();
    const disabled = generating || filled;
    const noun = target === 'backCover' ? 'back-cover' : 'cover';
    const tooltip = filled
      ? `Clear the ${noun} concept first — the LLM only seeds blank concepts to avoid clobbering your edits.`
      : `Have the LLM propose a ${noun} concept for this issue`;
    const hintId = `concept-hint-${issue.id}-${target}`;
    // Use `aria-disabled` (not the DOM `disabled` attribute) so the
    // button stays in the keyboard tab order and the `title` tooltip is
    // discoverable on focus as well as hover. `disabled` removes the
    // element from tab order entirely and most browsers suppress hover
    // events on it, hiding the "clear first" guidance from keyboard +
    // screen-reader users. Click handler is gated on the same flag.
    //
    // `aria-describedby` (not `aria-label`) preserves the visible label
    // ("Generate concept (LLM)") as the accessible name — WCAG 2.5.3
    // "Label in Name" — and adds the tooltip as supplementary context.
    return (
      <>
        <button
          type="button"
          onClick={disabled ? undefined : () => handleGenerateConcept(target)}
          aria-disabled={disabled || undefined}
          aria-describedby={hintId}
          title={tooltip}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-port-accent hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40 ${
            disabled ? 'opacity-40 cursor-not-allowed' : ''
          }`}
        >
          {generating ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
          Generate concept (LLM)
        </button>
        <span id={hintId} className="sr-only">{tooltip}</span>
      </>
    );
  };

  // Shared script-persist (cover / backCover) — server-side updatePipelineIssue
  // does a deep merge under stages.comicPages.<field>. Only the script text
  // is sent; render slots are written exclusively by the render route to
  // avoid blur-vs-render race conditions.
  const persistCoverFieldScript = async (field, nextScript) => {
    const updated = await updatePipelineIssue(issue.id, {
      stages: { comicPages: { [field]: { script: nextScript } } },
    }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    if (updated) onStageUpdate?.('comicPages', updated.stages.comicPages, updated);
  };

  const handleRenderCoverField = async (field, variant) => {
    const isBack = field === 'backCover';
    const useProofToggle = isBack ? useProofForBackFinal : useProofForCoverFinal;
    setBusyFor(field, variant, true);
    const useProofAsBase = variant === 'final' && useProofToggle;
    const draftText = isBack ? draftBackCoverScript : draftCoverScript;
    const apiCall = isBack ? generatePipelineComicBackCover : generatePipelineComicCover;
    const bodyScriptKey = isBack ? 'backCoverScript' : 'coverScript';
    const label = isBack ? 'back cover' : 'cover';
    const result = await apiCall(issue.id, {
      [bodyScriptKey]: draftText || '',
      ...renderOpts,
      target: variant,
      useProofAsBase,
    }, { silent: true }).catch((err) => {
      toast.error(err.message || `Failed to render ${variant} ${label}`);
      return null;
    });
    setBusyFor(field, variant, false);
    if (!result) return;
    if (result.issue) {
      onStageUpdate?.('comicPages', result.issue.stages.comicPages, result.issue);
    }
    const suffix = useProofAsBase ? ' (from proof)' : '';
    toast.success(`Queued ${result.mode} ${variant} ${label} render${suffix} (${result.jobId.slice(0, 8)})`);
  };

  const overrides = {
    providerId: series?.llm?.provider || undefined,
    model: series?.llm?.model || undefined,
  };

  // Re-generate the comic script from prose and immediately split it into
  // pages. Auto-extract follows generate so the user never sees the raw
  // concatenated markdown unless they expand the source-details panel.
  const handleGenerate = async () => {
    setLocalGenerating(true);
    const result = await generatePipelineStage(issue.id, 'comicScript', overrides)
      .catch((err) => { toast.error(err.message || 'Generation failed'); return null; });
    if (!result) { setLocalGenerating(false); return; }
    onStageUpdate?.('comicScript', result.stage);
    const extracted = await extractPipelineComicPages(issue.id, { force: true })
      .catch((err) => { toast.error(`Page split failed: ${err.message}`); return null; });
    setLocalGenerating(false);
    if (extracted) {
      onStageUpdate?.('comicPages', extracted.stage);
      toast.success(`Generated and split into ${extracted.pageCount} page${extracted.pageCount === 1 ? '' : 's'}`);
    }
  };

  const handleExtract = async () => {
    setExtracting(true);
    const extracted = await extractPipelineComicPages(issue.id, { force: pages.length > 0 })
      .catch((err) => { toast.error(err.message || 'Page split failed'); return null; });
    setExtracting(false);
    if (extracted) {
      onStageUpdate?.('comicPages', extracted.stage);
      toast.success(`Split into ${extracted.pageCount} page${extracted.pageCount === 1 ? '' : 's'}`);
    }
  };

  // Count any page/cover that has a final OR proof slot with a filename — the
  // PDF assembly's fallback chain prefers final, then proof, then legacy.
  const isRendered = (rec) => !!getPreferredSlot(rec)?.filename;
  const pdfRenderedCount = pages.filter(isRendered).length
    + (isRendered(comicPages.cover) ? 1 : 0)
    + (isRendered(comicPages.backCover) ? 1 : 0);
  const pdfTotal = pages.length
    + (comicPages.cover ? 1 : 0)
    + (comicPages.backCover ? 1 : 0);
  const pdfReady = pdfRenderedCount > 0;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white">{PIPELINE_STAGE_LABELS.comicScript}</h2>
          <span className={`text-[10px] uppercase tracking-wider ${STATUS_COLOR[script.status] || 'text-gray-500'}`}>
            {STATUS_LABEL[script.status] || script.status}
          </span>
          {pages.length > 0 ? (
            <span className="text-xs text-gray-500">{pages.length} page{pages.length === 1 ? '' : 's'}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openImageSettings}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-port-card border border-port-border text-gray-300 text-xs hover:border-port-accent/50 hover:text-white"
            title={`Image gen settings — backend: ${imageCfg.mode}`}
          >
            <SettingsIcon size={12} /> Image gen
          </button>
          <ExtractCanonButton
            issue={issue}
            series={series}
            stageId="comicScript"
            gated={actionsGated}
          />
          {hasScript && pages.length === 0 ? (
            <button
              type="button"
              onClick={handleExtract}
              disabled={extracting}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-white text-sm hover:border-port-accent/50 disabled:opacity-40"
            >
              {extracting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Split into pages
            </button>
          ) : null}
          <a
            href={pdfReady ? `/api/pipeline/issues/${encodeURIComponent(issue.id)}/comic.pdf` : undefined}
            aria-disabled={!pdfReady}
            onClick={(e) => { if (!pdfReady) e.preventDefault(); }}
            title={pdfReady
              ? `Download a print-ready PDF (${pdfRenderedCount}/${pdfTotal} rendered)`
              : 'Render at least one page or the cover first'}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm ${
              pdfReady
                ? 'bg-port-card border-port-border text-white hover:border-port-accent/50'
                : 'bg-port-card border-port-border text-gray-500 cursor-not-allowed'
            }`}
          >
            <FileDown size={14} />
            PDF
          </a>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || extracting || actionsGated}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
            title={actionsGated ? 'Saving settings…' : 'Re-adapt the prose into a fresh comic script and split it into pages'}
          >
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {hasScript ? 'Re-generate pages' : 'Generate pages'}
          </button>
        </div>
      </header>

      {pages.length === 0 && !hasScript ? (
        <p className="text-sm text-gray-400 italic">
          Generate the prose stage first, then click <em>Generate pages</em>. The LLM adapts the prose into a Marvel/DC-format script and we split it into editable pages.
        </p>
      ) : null}

      {pages.length === 0 && hasScript ? (
        <p className="text-sm text-gray-400 italic">
          Script generated but no pages parsed. Click <em>Split into pages</em> above.
        </p>
      ) : null}

      <div className="p-3 bg-port-card border border-port-border rounded-lg space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-wider text-gray-500">Cover</span>
          <div className="flex items-center gap-2 flex-wrap">
            {renderConceptButton('cover', cover.script)}
            <button
              type="button"
              onClick={() => handleRenderCoverField('cover', 'proof')}
              disabled={busy.coverProof || coverProofInFlight || actionsGated}
              title={actionsGated
                ? 'Saving settings…'
                : coverProofInFlight
                  ? 'Proof render in progress…'
                  : 'Render a fast proof cover at the configured size — series masthead + issue number tag + your cover concept.'}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {(busy.coverProof || coverProofInFlight) ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}
              Render proof
            </button>
            <label
              className="flex items-center gap-1 text-[11px] text-gray-400 cursor-pointer"
              title="Use the proof image as the base for the final render — preserves composition."
            >
              <input
                type="checkbox"
                checked={useProofForCoverFinal}
                onChange={(e) => setUseProofForCoverFinal(e.target.checked)}
                className="rounded"
              />
              from proof
            </label>
            <button
              type="button"
              onClick={() => handleRenderCoverField('cover', 'final')}
              disabled={
                busy.coverFinal || coverFinalInFlight || actionsGated
                || (useProofForCoverFinal && !coverProof?.filename)
              }
              title={finalButtonTooltip({
                gated: actionsGated,
                inFlight: coverFinalInFlight,
                needsProof: useProofForCoverFinal && !coverProof?.filename,
                defaultMsg: 'Render the hi-res final cover at the configured size. Tick "from proof" to upscale the proof rather than redraw it.',
              })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {(busy.coverFinal || coverFinalInFlight) ? <Loader2 size={12} className="animate-spin" /> : <Layers size={12} />}
              Render final
            </button>
          </div>
        </div>
        <textarea
          value={draftCoverScript}
          onChange={(e) => setDraftCoverScript(e.target.value)}
          onBlur={() => {
            if ((cover.script || '') !== draftCoverScript) persistCoverFieldScript('cover', draftCoverScript);
          }}
          placeholder="Cover concept — describe the hero image, mood, lighting, framing. Series masthead and issue-number tag included in the prompt automatically."
          rows={3}
          className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
          maxLength={8000}
        />
        {(coverProof || coverFinal) ? (
          <div className="grid grid-cols-2 gap-2">
            <RenderSlotThumb
              slot={coverProof}
              label="Proof"
              thumbLabel="Proof"
              emptyHint="No proof yet."
              onStatus={setCoverProofStatus}
            />
            <RenderSlotThumb
              slot={coverFinal}
              label="Final"
              thumbLabel="Final"
              emptyHint="No final yet."
              onStatus={setCoverFinalStatus}
              fillFromProofLabel
            />
          </div>
        ) : null}
      </div>

      <div className="p-3 bg-port-card border border-port-border rounded-lg space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-wider text-gray-500">Back cover</span>
          <div className="flex items-center gap-2 flex-wrap">
            {renderConceptButton('backCover', backCover.script)}
            <button
              type="button"
              onClick={() => handleRenderCoverField('backCover', 'proof')}
              disabled={busy.backProof || backProofInFlight || actionsGated}
              title={actionsGated
                ? 'Saving settings…'
                : backProofInFlight
                  ? 'Proof render in progress…'
                  : 'Render a fast proof back-cover at the configured size — illustration only, no text, no masthead.'}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {(busy.backProof || backProofInFlight) ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}
              Render proof
            </button>
            <label
              className="flex items-center gap-1 text-[11px] text-gray-400 cursor-pointer"
              title="Use the proof image as the base for the final render — preserves composition."
            >
              <input
                type="checkbox"
                checked={useProofForBackFinal}
                onChange={(e) => setUseProofForBackFinal(e.target.checked)}
                className="rounded"
              />
              from proof
            </label>
            <button
              type="button"
              onClick={() => handleRenderCoverField('backCover', 'final')}
              disabled={
                busy.backFinal || backFinalInFlight || actionsGated
                || (useProofForBackFinal && !backProof?.filename)
              }
              title={finalButtonTooltip({
                gated: actionsGated,
                inFlight: backFinalInFlight,
                needsProof: useProofForBackFinal && !backProof?.filename,
                defaultMsg: 'Render the hi-res final back-cover at the configured size. Tick "from proof" to upscale the proof rather than redraw it.',
              })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {(busy.backFinal || backFinalInFlight) ? <Loader2 size={12} className="animate-spin" /> : <Layers size={12} />}
              Render final
            </button>
          </div>
        </div>
        <textarea
          value={draftBackCoverScript}
          onChange={(e) => setDraftBackCoverScript(e.target.value)}
          onBlur={() => {
            if ((backCover.script || '') !== draftBackCoverScript) persistCoverFieldScript('backCover', draftBackCoverScript);
          }}
          placeholder="Back cover concept — illustration only. No text, no masthead. A quiet companion image: a single object, an aftermath beat, a distant silhouette."
          rows={3}
          className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
          maxLength={8000}
        />
        {(backProof || backFinal) ? (
          <div className="grid grid-cols-2 gap-2">
            <RenderSlotThumb
              slot={backProof}
              label="Proof"
              thumbLabel="Proof"
              emptyHint="No proof yet."
              onStatus={setBackProofStatus}
            />
            <RenderSlotThumb
              slot={backFinal}
              label="Final"
              thumbLabel="Final"
              emptyHint="No final yet."
              onStatus={setBackFinalStatus}
              fillFromProofLabel
            />
          </div>
        ) : null}
      </div>

      <ul className="space-y-4">
        {pages.map((page, pi) => (
          <PageRow
            key={pi}
            issue={issue}
            pageIndex={pi}
            page={page}
            pageCount={pages.length}
            renderOpts={renderOpts}
            onStageUpdate={onStageUpdate}
            onPreview={openPreview}
            onFilenameKnown={onFilenameKnown}
            confirmingDelete={isPageConfirmingDelete(pi)}
            onArmDelete={() => requestPageDelete(pi)}
            onCancelDelete={cancelPageDelete}
            onConfirmDelete={confirmPageDelete}
          />
        ))}
      </ul>

      <MediaPreview preview={preview} setPreview={setPreview} items={previewItems} />

      {hasScript ? (
        <details
          className="rounded border border-port-border bg-port-card/40"
          open={showSource}
          onToggle={(e) => setShowSource(e.currentTarget.open)}
        >
          <summary className="px-3 py-2 text-xs uppercase tracking-wider text-gray-500 cursor-pointer flex items-center gap-2 hover:text-white">
            {showSource ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Full comic script (markdown source)
          </summary>
          <pre className="px-3 py-2 text-xs text-gray-300 whitespace-pre-wrap font-mono border-t border-port-border">
            {script.output}
          </pre>
        </details>
      ) : null}

      <Drawer open={settingsOpen} onClose={closeImageSettings} title="Comic page image gen" size="md">
        <ImageGenSettingsForm
          value={imageCfg}
          onChange={persistImageCfg}
          models={imageModels}
          availableBackends={availableBackends}
          grouped
        />
      </Drawer>
    </div>
  );
}

function PageRow({
  issue, pageIndex, page, pageCount = 0, renderOpts = {},
  onStageUpdate, onPreview, onFilenameKnown,
  confirmingDelete, onArmDelete, onCancelDelete, onConfirmDelete,
}) {
  const rawText = useMemo(
    () => page.rawText || panelsToMarkdown(page.panels, pageIndex + 1),
    [page.rawText, page.panels, pageIndex],
  );
  // Inline lettering-density warnings (#1313): the same pure accounting the
  // server `comic.lettering-density` editorial check runs, computed here from the
  // parsed panels so over-stuffed panels surface in the comic-script stage itself,
  // not only after an editorial-checks run. Uses the default thresholds.
  const letteringWarnings = useMemo(
    () => analyzeComicLettering([{ panels: page.panels }]),
    [page.panels],
  );
  const [draft, setDraft] = useState(rawText);
  const [saving, setSaving] = useState(false);
  const [renderingProof, setRenderingProof] = useState(false);
  const [renderingFinal, setRenderingFinal] = useState(false);
  const [useProofForFinal, setUseProofForFinal] = useState(true);
  // Per-page "Refine" (#1534): a free-text small correction that adjusts the
  // page's stored render prompt and re-renders image-to-image from the existing
  // page image. `refineChanges` surfaces the AI's "what changed" bullets inline.
  const [refineText, setRefineText] = useState('');
  const [refining, setRefining] = useState(false);
  const [refineChanges, setRefineChanges] = useState([]);
  // Consistency reference: re-render this page using an adjacent page's image as
  // a reference so a continuing scene keeps incidental/un-described characters +
  // environment consistent. '' = none, 'prior' = previous page, 'next' = next.
  const [refPage, setRefPage] = useState('');
  const hasPrior = pageIndex > 0;
  const hasNext = pageIndex < pageCount - 1;
  // Sync local edits with parent updates (re-extract / re-render persist).
  useEffect(() => { setDraft(rawText); }, [rawText]);
  const dirty = draft !== rawText;

  const proofSlot = getProofSlot(page);
  const finalSlot = getFinalSlot(page);
  const { inFlight: proofInFlight, setStatus: setProofStatus } = useSlotInFlight(proofSlot);
  const { inFlight: finalInFlight, setStatus: setFinalStatus } = useSlotInFlight(finalSlot);

  const onProofFilename = useCallback((filename) => {
    if (proofSlot?.jobId) onFilenameKnown?.(proofSlot.jobId, filename);
  }, [proofSlot?.jobId, onFilenameKnown]);
  const onFinalFilename = useCallback((filename) => {
    if (finalSlot?.jobId) onFilenameKnown?.(finalSlot.jobId, filename);
  }, [finalSlot?.jobId, onFilenameKnown]);

  const handleSave = async () => {
    setSaving(true);
    const res = await updatePipelineComicPage(issue.id, pageIndex, { rawText: draft })
      .catch((err) => { toast.error(err.message || 'Save failed'); return null; });
    setSaving(false);
    if (res) {
      onStageUpdate?.('comicPages', res.stage);
      toast.success(`Page ${pageIndex + 1} saved (${res.page?.panels?.length || 0} panel${res.page?.panels?.length === 1 ? '' : 's'} parsed)`);
    }
  };

  const handleRender = async (target) => {
    const setFlight = target === 'final' ? setRenderingFinal : setRenderingProof;
    setFlight(true);
    // Only an EXPLICIT adjacent reference ('prior'/'next') takes precedence over
    // proof-as-base (the server resolves it first). 'auto' and 'none' leave
    // proof-as-base intact: 'none' just forbids an auto reference, and an auto
    // reference is itself lower precedence than proof-as-base server-side.
    const explicitRef = refPage === 'prior' || refPage === 'next';
    const useProofAsBase = target === 'final' && useProofForFinal && !explicitRef;
    const res = await generatePipelineComicPage(issue.id, pageIndex, {
      ...renderOpts,
      target,
      useProofAsBase,
      ...(refPage ? { referencePage: refPage } : {}),
    }).catch((err) => { toast.error(err.message || 'Render failed'); return null; });
    setFlight(false);
    if (res) {
      onStageUpdate?.('comicPages', res.stage);
      // Prefer the server's resolved outcome — auto may or may not have found a
      // same-scene prior page with a render, so trust res over the local intent.
      const suffix = res.fromProof
        ? ' (from proof)'
        : res.fromReference
          ? ` (${res.autoReference ? 'auto-ref' : 'ref'} page ${res.referencePageIndex + 1})`
          : '';
      toast.success(`Page ${pageIndex + 1} ${target}${suffix} render queued (${res.mode || renderOpts.mode || IMAGE_GEN_MODE.LOCAL})`);
    }
  };

  const handleDelete = async () => {
    const next = (issue.stages?.comicPages?.pages || []).filter((_, i) => i !== pageIndex);
    const patched = await updatePipelineIssue(issue.id, {
      stages: { comicPages: { status: next.length ? 'edited' : 'empty', pages: next } },
    }, { silent: true }).catch((err) => { toast.error(err.message || 'Delete failed'); return null; });
    if (patched) {
      onStageUpdate?.('comicPages', patched.stages.comicPages, patched);
      toast.success(`Page ${pageIndex + 1} deleted`);
    }
  };

  const handleRefine = async () => {
    const instruction = refineText.trim();
    if (!instruction) return;
    setRefining(true);
    // Refine reads the stored render prompt + existing image server-side, so it
    // is independent of unsaved script edits — but gate on in-flight renders so
    // the i2i base isn't a half-written slot.
    const res = await refinePipelineComicPageRender(issue.id, pageIndex, {
      ...renderOpts,
      instruction,
    }).catch((err) => { toast.error(err.message || 'Refine failed'); return null; });
    setRefining(false);
    if (res) {
      onStageUpdate?.('comicPages', res.stage);
      setRefineChanges(res.changes || []);
      setRefineText('');
      toast.success(`Page ${pageIndex + 1} ${res.variant} refine queued (${res.mode || renderOpts.mode || IMAGE_GEN_MODE.LOCAL})`);
    }
  };

  // An EXPLICIT adjacent reference render uses that page (not this page's proof)
  // as its base, so it doesn't need a proof to exist — only proof-as-base does.
  // 'auto'/'none' still go through proof-as-base, so they keep the proof gate.
  const finalNeedsProof = useProofForFinal && !(refPage === 'prior' || refPage === 'next') && !proofSlot?.filename;
  // The Refine control only makes sense once the page has a render to correct
  // (final preferred, else proof). Gate on jobId OR filename — not filename
  // alone: refining a proof-only page replaces its slot with an in-flight
  // record whose filename is briefly null, and gating on filename alone would
  // make the Refine box vanish mid-refine and not return until reload. The
  // button's own in-flight gate (below) still blocks i2i off a mid-write slot.
  const hasRender = !!(finalSlot?.jobId || finalSlot?.filename || proofSlot?.jobId || proofSlot?.filename);
  const refineDisabled = refining || proofInFlight || finalInFlight || !refineText.trim();

  return (
    <li className="rounded-lg border border-port-border bg-port-card/40">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-port-border flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-wider text-gray-500">Page {pageIndex + 1}</span>
          {(Number.isInteger(page.sceneNumber) || page.sceneHeading) ? (
            <span
              className="text-[10px] text-port-accent/80 border border-port-accent/30 rounded px-1"
              title="The scene this page belongs to. Renders auto-chain off the prior page within the same scene and start fresh across a scene boundary."
            >
              {Number.isInteger(page.sceneNumber) ? `Scene ${page.sceneNumber}` : 'Scene'}{page.sceneHeading ? `: ${page.sceneHeading}` : ''}
            </span>
          ) : null}
          <span className="text-[10px] text-gray-600">{page.panels?.length || 0} panel{page.panels?.length === 1 ? '' : 's'}</span>
          {dirty ? <span className="text-[10px] text-port-warning">unsaved</span> : null}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-bg border border-port-border text-white hover:border-port-accent/50 disabled:opacity-40"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            Save
          </button>
          <label
            className="flex items-center gap-1 text-[11px] text-gray-400"
            title="Consistency reference for this page's render. 'auto' chains off the prior page when it's in the same scene (keeps incidental characters + environment consistent) and renders fresh across a scene boundary. 'none' forces a fresh render even mid-scene. 'prev/next page' force that specific page as the reference."
          >
            <span className="text-gray-500">ref</span>
            <select
              value={refPage}
              onChange={(e) => setRefPage(e.target.value)}
              className="bg-port-bg border border-port-border rounded text-[11px] text-white px-1 py-0.5"
              aria-label={`Consistency reference page for page ${pageIndex + 1}`}
            >
              <option value="">auto (same scene)</option>
              <option value="none">none (fresh)</option>
              {hasPrior ? <option value="prior">prev page</option> : null}
              {hasNext ? <option value="next">next page</option> : null}
            </select>
          </label>
          <button
            type="button"
            onClick={() => handleRender('proof')}
            disabled={renderingProof || dirty || proofInFlight}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-accent text-white font-medium disabled:opacity-40"
            title={dirty
              ? 'Save changes before rendering'
              : proofInFlight
                ? 'Proof render in progress…'
                : refPage
                  ? `Queue a proof render using the ${refPage} page as a consistency reference`
                  : 'Queue a fast proof render at the configured size'}
          >
            {(renderingProof || proofInFlight) ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}
            Proof
          </button>
          <label
            className="flex items-center gap-1 text-[11px] text-gray-400 px-1 cursor-pointer"
            title="Use the proof image as the base for the final render — preserves panel layout."
          >
            <input
              type="checkbox"
              checked={useProofForFinal}
              onChange={(e) => setUseProofForFinal(e.target.checked)}
              className="rounded"
            />
            from proof
          </label>
          <button
            type="button"
            onClick={() => handleRender('final')}
            disabled={renderingFinal || dirty || finalInFlight || finalNeedsProof}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-accent text-white font-medium disabled:opacity-40"
            title={finalButtonTooltip({
              gated: false,
              inFlight: finalInFlight,
              needsProof: finalNeedsProof,
              dirty,
              dirtyMsg: 'Save changes before rendering',
              defaultMsg: 'Queue a hi-res final render. Tick "from proof" to upscale the proof rather than redraw it.',
            })}
          >
            {(renderingFinal || finalInFlight) ? <Loader2 size={12} className="animate-spin" /> : <Layers size={12} />}
            Final
          </button>
          {confirmingDelete ? (
            <ConfirmButtonPair
              prompt="Delete page?"
              onConfirm={() => onConfirmDelete(handleDelete)}
              onCancel={onCancelDelete}
              ariaLabel={`Confirm delete page ${pageIndex + 1}`}
            />
          ) : (
            <button
              type="button"
              onClick={onArmDelete}
              className="p-1 text-gray-500 hover:text-port-error"
              aria-label={`Delete page ${pageIndex + 1}`}
              title="Delete page"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>
      {letteringWarnings.length > 0 ? (
        <div className="px-3 pt-2">
          <ul className="rounded border border-port-warning/30 bg-port-warning/5 px-2.5 py-1.5 space-y-0.5">
            {letteringWarnings.map((v, i) => (
              <li key={i} className={`text-[11px] ${LETTERING_TONE[v.severity] || 'text-gray-400'}`}>
                ⚠ Lettering — {letteringWarningLabel(v)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {hasRender ? (
        <div className="px-3 pt-2">
          <div className="flex items-center gap-2">
            <Wand2 size={12} className="text-port-accent shrink-0" />
            <input
              type="text"
              value={refineText}
              onChange={(e) => setRefineText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !refineDisabled) { e.preventDefault(); handleRefine(); }
              }}
              placeholder="Small fix to the rendered page — e.g. 'warm the lighting', 'remove the extra signage text'"
              aria-label={`Refine instruction for page ${pageIndex + 1}`}
              className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
              maxLength={2000}
            />
            <button
              type="button"
              onClick={handleRefine}
              disabled={refineDisabled}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-card border border-port-border text-port-accent hover:text-white hover:border-port-accent/50 disabled:opacity-40 disabled:cursor-not-allowed"
              title={(proofInFlight || finalInFlight)
                ? 'Wait for the in-flight render to finish'
                : 'Adjust the render prompt and re-render image-to-image from the existing page image — applies only the requested change, preserving the rest of the page'}
            >
              {refining ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              Refine
            </button>
          </div>
          {refineChanges.length ? (
            <ul className="mt-1 pl-6 space-y-0.5 list-disc">
              {refineChanges.map((c, i) => (
                <li key={i} className="text-[11px] text-gray-400">{c}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="grid md:grid-cols-2 gap-3 p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={18}
          spellCheck={false}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-xs font-mono leading-relaxed"
          placeholder={`## Page ${pageIndex + 1}\n\n### Panel 1\n**Description:** ...`}
        />
        <div className="grid grid-cols-2 gap-2 min-h-[200px]">
          <RenderSlotThumb
            slot={proofSlot}
            label="Proof"
            thumbLabel={`Page ${pageIndex + 1} (proof)`}
            emptyHint="No proof yet"
            size="fill"
            onStatus={setProofStatus}
            onFilename={onProofFilename}
            onPreview={(filename) => onPreview?.(pageIndex, filename, page)}
          />
          <RenderSlotThumb
            slot={finalSlot}
            label="Final"
            thumbLabel={`Page ${pageIndex + 1} (final)`}
            emptyHint="No final yet"
            size="fill"
            onStatus={setFinalStatus}
            onFilename={onFinalFilename}
            onPreview={(filename) => onPreview?.(pageIndex, filename, page)}
            fillFromProofLabel
          />
        </div>
      </div>
    </li>
  );
}
