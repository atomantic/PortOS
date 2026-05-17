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
import { Loader2, Sparkles, ImageIcon, Save, Trash2, ChevronDown, ChevronRight, Settings as SettingsIcon, FileDown, Layers } from 'lucide-react';
import toast from '../../ui/Toast';
import {
  generatePipelineStage,
  extractPipelineComicPages,
  generatePipelineComicPage,
  generatePipelineComicCover,
  generatePipelineComicBackCover,
  updatePipelineComicPage,
  updatePipelineIssue,
  updateIssueStageVisualStyle,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGE_STATUS_LABEL as STATUS_LABEL,
  PIPELINE_STAGE_STATUS_COLOR as STATUS_COLOR,
} from '../../../services/api';
import { getSettings, updateSettings } from '../../../services/apiSystem';
import { listImageModels } from '../../../services/apiImageVideo';
import MediaJobThumb from '../MediaJobThumb';
import MediaPreview from '../../media/MediaPreview';
import VisualStylePicker from '../VisualStylePicker';
import Drawer from '../../Drawer';
import ImageGenSettingsForm from '../../imageGen/ImageGenSettingsForm';
import { deriveAvailableBackends } from '../../../lib/imageGenBackends';
import {
  PIPELINE_IMAGE_DEFAULTS,
  readPipelineImageSettings,
  pipelineImageCfgToRenderOpts,
} from '../../../lib/pipelineImageDefaults';

// Legacy records (pre-proof/final split) carry `imageJobId`/`filename` at
// the record root; surface those as the proof slot so the UI keeps showing
// the old render until the user re-renders into the new shape.
const getProofSlot = (rec) => {
  if (!rec) return null;
  if (rec.proofImage?.jobId || rec.proofImage?.filename) return rec.proofImage;
  if (rec.imageJobId || rec.filename) {
    return { jobId: rec.imageJobId || null, filename: rec.filename || null };
  }
  return null;
};

const getFinalSlot = (rec) => (rec?.finalImage?.jobId || rec?.finalImage?.filename ? rec.finalImage : null);

// Whichever slot the user should see as "rendered" for PDF-readiness math
// and the lightbox preview — final wins over proof when both exist.
const getPreferredSlot = (rec) => getFinalSlot(rec) || getProofSlot(rec);

// 5s grace window for stale-jobId staleness: if MediaJobThumb never reports
// a real status (job archive expired before this session), stop treating the
// unresolved 'unknown' as in-flight so the render button isn't permanently
// disabled.
function useSlotInFlight(slot) {
  const [status, setStatus] = useState('unknown');
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setStatus('unknown');
    setExpired(false);
    if (!slot?.jobId) return undefined;
    const t = setTimeout(() => setExpired(true), 5000);
    return () => clearTimeout(t);
  }, [slot?.jobId]);
  const inFlight = !!slot?.jobId
    && status !== 'completed' && status !== 'failed' && status !== 'canceled'
    && !(status === 'unknown' && expired);
  return { inFlight, setStatus };
}

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
  // page order — preview prev/next walks rendered pages in page order.
  const [preview, setPreview] = useState(null);
  const [filenameByJobId, setFilenameByJobId] = useState({});
  const onFilenameKnown = useCallback((jobId, filename) => {
    if (!jobId || !filename) return;
    setFilenameByJobId((prev) => prev[jobId] === filename ? prev : { ...prev, [jobId]: filename });
  }, []);
  const buildPageItem = useCallback((pageIndex, page, filename) => ({
    key: `comic-page:${filename}`,
    kind: 'image',
    filename,
    previewUrl: `/data/images/${filename}`,
    downloadUrl: `/data/images/${filename}`,
    prompt: page?.prompt || `Page ${pageIndex + 1}`,
  }), []);
  const previewItems = useMemo(() => {
    const pageList = Array.isArray(comicPages.pages) ? comicPages.pages : [];
    return pageList
      .map((p, idx) => {
        // Prefer the hi-res final when present; fall back to proof (or legacy)
        // so users still see something while the final renders or before they
        // upgrade a page to a final render.
        const slot = getPreferredSlot(p);
        if (!slot?.jobId) return null;
        const filename = slot.filename || filenameByJobId[slot.jobId];
        if (!filename) return null;
        return buildPageItem(idx, p, filename);
      })
      .filter(Boolean);
  }, [comicPages.pages, filenameByJobId, buildPageItem]);
  const openPreview = useCallback((pageIndex, filename, page) => {
    if (!filename) return;
    setPreview(buildPageItem(pageIndex, page, filename));
  }, [buildPageItem]);
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
    const current = await getSettings().catch(() => ({}));
    await updateSettings({
      ...current,
      pipeline: { ...(current.pipeline || {}), imageGen: next },
    }).catch((err) => toast.error(`Settings save failed: ${err.message}`));
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

  const i2iSupported = imageCfg.mode !== 'codex';
  const i2iDisabledReason = i2iSupported
    ? null
    : 'Codex (gpt-image-2) does not support image-to-image. Switch backend in the image-gen settings to use the proof as a base.';

  // Shared script-persist (cover / backCover) — server-side updatePipelineIssue
  // does a deep merge under stages.comicPages.<field>. Only the script text
  // is sent; render slots are written exclusively by the render route to
  // avoid blur-vs-render race conditions.
  const persistCoverFieldScript = async (field, nextScript) => {
    const updated = await updatePipelineIssue(issue.id, {
      stages: { comicPages: { [field]: { script: nextScript } } },
    }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    if (updated) onStageUpdate?.('comicPages', updated.stages.comicPages, updated);
  };

  const handleRenderCoverField = async (field, variant) => {
    const isBack = field === 'backCover';
    const useProofToggle = isBack ? useProofForBackFinal : useProofForCoverFinal;
    setBusyFor(field, variant, true);
    const useProofAsBase = variant === 'final' && useProofToggle && i2iSupported;
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
          <VisualStylePicker
            compact
            value={comicPages.visualStyleOverride || null}
            inheritedLabel={series?.visualStyleDefault?.id ? 'Series default' : 'Pick style'}
            onChange={async (next) => {
              const updated = await updateIssueStageVisualStyle(issue.id, 'comicPages', next)
                .catch((err) => { toast.error(err.message || 'Save failed'); return null; });
              if (updated) onStageUpdate?.('comicPages', updated.stages.comicPages, updated);
            }}
          />
          <button
            type="button"
            onClick={openImageSettings}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-port-card border border-port-border text-gray-300 text-xs hover:border-port-accent/50 hover:text-white"
            title={`Image gen settings — backend: ${imageCfg.mode}`}
          >
            <SettingsIcon size={12} /> Image gen
          </button>
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
              className={`flex items-center gap-1 text-[11px] text-gray-400 ${i2iSupported ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
              title={i2iDisabledReason || 'Use the proof image as the base for the final render — preserves composition.'}
            >
              <input
                type="checkbox"
                checked={i2iSupported && useProofForCoverFinal}
                onChange={(e) => setUseProofForCoverFinal(e.target.checked)}
                disabled={!i2iSupported}
                className="rounded"
              />
              from proof
            </label>
            <button
              type="button"
              onClick={() => handleRenderCoverField('cover', 'final')}
              disabled={
                busy.coverFinal || coverFinalInFlight || actionsGated
                || (i2iSupported && useProofForCoverFinal && !coverProof?.filename)
              }
              title={finalButtonTooltip({
                gated: actionsGated,
                inFlight: coverFinalInFlight,
                needsProof: i2iSupported && useProofForCoverFinal && !coverProof?.filename,
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
              className={`flex items-center gap-1 text-[11px] text-gray-400 ${i2iSupported ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
              title={i2iDisabledReason || 'Use the proof image as the base for the final render — preserves composition.'}
            >
              <input
                type="checkbox"
                checked={i2iSupported && useProofForBackFinal}
                onChange={(e) => setUseProofForBackFinal(e.target.checked)}
                disabled={!i2iSupported}
                className="rounded"
              />
              from proof
            </label>
            <button
              type="button"
              onClick={() => handleRenderCoverField('backCover', 'final')}
              disabled={
                busy.backFinal || backFinalInFlight || actionsGated
                || (i2iSupported && useProofForBackFinal && !backProof?.filename)
              }
              title={finalButtonTooltip({
                gated: actionsGated,
                inFlight: backFinalInFlight,
                needsProof: i2iSupported && useProofForBackFinal && !backProof?.filename,
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
            renderOpts={renderOpts}
            i2iSupported={i2iSupported}
            i2iDisabledReason={i2iDisabledReason}
            onStageUpdate={onStageUpdate}
            onPreview={openPreview}
            onFilenameKnown={onFilenameKnown}
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

      <Drawer open={settingsOpen} onClose={closeImageSettings} title="Comic page image gen">
        <ImageGenSettingsForm
          value={imageCfg}
          onChange={persistImageCfg}
          models={imageModels}
          availableBackends={availableBackends}
        />
      </Drawer>
    </div>
  );
}

function PageRow({
  issue, pageIndex, page, renderOpts = {},
  i2iSupported = true, i2iDisabledReason = null,
  onStageUpdate, onPreview, onFilenameKnown,
}) {
  const rawText = useMemo(
    () => page.rawText || panelsToMarkdown(page.panels, pageIndex + 1),
    [page.rawText, page.panels, pageIndex],
  );
  const [draft, setDraft] = useState(rawText);
  const [saving, setSaving] = useState(false);
  const [renderingProof, setRenderingProof] = useState(false);
  const [renderingFinal, setRenderingFinal] = useState(false);
  const [useProofForFinal, setUseProofForFinal] = useState(true);
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
    const useProofAsBase = target === 'final' && useProofForFinal && i2iSupported;
    const res = await generatePipelineComicPage(issue.id, pageIndex, {
      ...renderOpts,
      target,
      useProofAsBase,
    }).catch((err) => { toast.error(err.message || 'Render failed'); return null; });
    setFlight(false);
    if (res) {
      onStageUpdate?.('comicPages', res.stage);
      const suffix = useProofAsBase ? ' (from proof)' : '';
      toast.success(`Page ${pageIndex + 1} ${target}${suffix} render queued (${res.mode || renderOpts.mode || 'local'})`);
    }
  };

  const handleDelete = async () => {
    const next = (issue.stages?.comicPages?.pages || []).filter((_, i) => i !== pageIndex);
    const patched = await updatePipelineIssue(issue.id, {
      stages: { comicPages: { status: next.length ? 'edited' : 'empty', pages: next } },
    }).catch((err) => { toast.error(err.message || 'Delete failed'); return null; });
    if (patched) {
      onStageUpdate?.('comicPages', patched.stages.comicPages, patched);
      toast.success(`Page ${pageIndex + 1} deleted`);
    }
  };

  const finalNeedsProof = i2iSupported && useProofForFinal && !proofSlot?.filename;

  return (
    <li className="rounded-lg border border-port-border bg-port-card/40">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-port-border flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-gray-500">Page {pageIndex + 1}</span>
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
          <button
            type="button"
            onClick={() => handleRender('proof')}
            disabled={renderingProof || dirty || proofInFlight}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-accent text-white font-medium disabled:opacity-40"
            title={dirty
              ? 'Save changes before rendering'
              : proofInFlight
                ? 'Proof render in progress…'
                : 'Queue a fast proof render at the configured size'}
          >
            {(renderingProof || proofInFlight) ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}
            Proof
          </button>
          <label
            className={`flex items-center gap-1 text-[11px] text-gray-400 px-1 ${i2iSupported ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
            title={i2iDisabledReason || 'Use the proof image as the base for the final render — preserves panel layout.'}
          >
            <input
              type="checkbox"
              checked={i2iSupported && useProofForFinal}
              onChange={(e) => setUseProofForFinal(e.target.checked)}
              disabled={!i2iSupported}
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
          <button
            type="button"
            onClick={handleDelete}
            className="p-1 text-gray-500 hover:text-port-error"
            aria-label={`Delete page ${pageIndex + 1}`}
            title="Delete page"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
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
