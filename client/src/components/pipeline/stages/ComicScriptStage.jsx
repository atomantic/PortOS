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
import { Loader2, Sparkles, ImageIcon, Save, Trash2, ChevronDown, ChevronRight, Settings as SettingsIcon } from 'lucide-react';
import toast from '../../ui/Toast';
import {
  generatePipelineStage,
  extractPipelineComicPages,
  generatePipelineComicPage,
  generatePipelineComicCover,
  updatePipelineComicPage,
  updatePipelineIssue,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGE_STATUS_LABEL as STATUS_LABEL,
  PIPELINE_STAGE_STATUS_COLOR as STATUS_COLOR,
} from '../../../services/api';
import { getSettings, updateSettings } from '../../../services/apiSystem';
import { listImageModels } from '../../../services/apiImageVideo';
import MediaJobThumb from '../MediaJobThumb';
import MediaPreview from '../../media/MediaPreview';
import Drawer from '../../Drawer';
import ImageGenSettingsForm from '../../imageGen/ImageGenSettingsForm';
import { deriveAvailableBackends } from '../../../lib/imageGenBackends';
import {
  PIPELINE_IMAGE_DEFAULTS,
  readPipelineImageSettings,
  pipelineImageCfgToRenderOpts,
} from '../../../lib/pipelineImageDefaults';

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

export default function ComicScriptStage({ issue, series, onStageUpdate }) {
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
        if (!p.imageJobId) return null;
        const filename = filenameByJobId[p.imageJobId];
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

  // Front cover lives on stages.comicPages.cover so it persists alongside the
  // page renders. The textarea owns a draft string separate from the persisted
  // value so keystrokes don't round-trip until blur.
  const cover = comicPages.cover || { script: '', imageJobId: null, prompt: null };
  const [draftCoverScript, setDraftCoverScript] = useState(cover.script || '');
  useEffect(() => { setDraftCoverScript(cover.script || ''); }, [cover.script]);
  const [renderingCover, setRenderingCover] = useState(false);
  // Mirror PageRow's job-status pattern: start 'unknown' so we treat any
  // existing jobId as in-flight until MediaJobThumb reports back.
  const [coverJobStatus, setCoverJobStatus] = useState('unknown');
  // `unknown` means the GET /media-jobs/:id is still in-flight OR the job
  // archive has expired (404). After a short grace period, stop treating an
  // unresolved `unknown` as in-flight so a stale imageJobId (job archived,
  // page reloaded) doesn't permanently disable "Render cover". The 5-second
  // window comfortably outlasts any LAN round-trip while being short enough
  // that an actual expired-archive case doesn't frustrate the user.
  const [coverUnknownExpired, setCoverUnknownExpired] = useState(false);
  // Reset both whenever the jobId changes so a freshly-queued job gets a
  // clean slate and is immediately treated as in-flight.
  useEffect(() => {
    setCoverJobStatus('unknown');
    setCoverUnknownExpired(false);
    if (!cover.imageJobId) return undefined;
    const t = setTimeout(() => setCoverUnknownExpired(true), 5000);
    return () => clearTimeout(t);
  }, [cover.imageJobId]);
  const coverJobInFlight = !!cover.imageJobId
    && coverJobStatus !== 'completed'
    && coverJobStatus !== 'failed'
    && coverJobStatus !== 'canceled'
    && !(coverJobStatus === 'unknown' && coverUnknownExpired);

  const persistCoverScript = async (nextScript) => {
    // Only send the script text. Never clear imageJobId/prompt from the blur
    // handler — doing so races with the render route's PATCH (which persists the
    // new jobId) and whoever lands last wins. The render button is already
    // disabled while a job is in-flight, so stale renders can only linger after
    // a completed/failed job; the user re-renders explicitly to replace them.
    const updated = await updatePipelineIssue(issue.id, {
      stages: { comicPages: { cover: { script: nextScript } } },
    }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    if (updated) onStageUpdate?.('comicPages', updated.stages.comicPages, updated);
  };

  const handleRenderCover = async () => {
    setRenderingCover(true);
    const result = await generatePipelineComicCover(issue.id, {
      coverScript: draftCoverScript || '',
      ...renderOpts,
    }).catch((err) => {
      toast.error(err.message || 'Failed to render cover');
      return null;
    });
    setRenderingCover(false);
    if (!result) return;
    if (result.issue) {
      onStageUpdate?.('comicPages', result.issue.stages.comicPages, result.issue);
    }
    toast.success(`Queued ${result.mode} cover render (${result.jobId.slice(0, 8)})`);
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
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || extracting}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
            title="Re-adapt the prose into a fresh comic script and split it into pages"
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

      <div className="p-3 bg-port-card border border-port-border rounded-lg">
        <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-wider text-gray-500">Cover</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRenderCover}
              disabled={renderingCover || coverJobInFlight}
              title={coverJobInFlight
                ? 'Cover render in progress…'
                : 'Render the issue\'s front cover — series masthead + issue number tag + your cover concept.'}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {(renderingCover || coverJobInFlight) ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}
              Render cover
            </button>
            {cover.imageJobId ? (
              <div className="flex items-center gap-2">
                <MediaJobThumb jobId={cover.imageJobId} label="Cover" size="md" onStatus={setCoverJobStatus} />
                <span className="text-[10px] text-gray-500 font-mono break-all" title="Last cover render job">
                  {cover.imageJobId.slice(0, 8)}
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <textarea
          value={draftCoverScript}
          onChange={(e) => setDraftCoverScript(e.target.value)}
          onBlur={() => {
            if ((cover.script || '') !== draftCoverScript) persistCoverScript(draftCoverScript);
          }}
          placeholder="Cover concept — describe the hero image, mood, lighting, framing. Series masthead and issue-number tag included in the prompt automatically."
          rows={3}
          className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
          maxLength={8000}
        />
      </div>

      <ul className="space-y-4">
        {pages.map((page, pi) => (
          <PageRow
            key={pi}
            issue={issue}
            pageIndex={pi}
            page={page}
            renderOpts={renderOpts}
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

function PageRow({ issue, pageIndex, page, renderOpts = {}, onStageUpdate, onPreview, onFilenameKnown }) {
  const rawText = useMemo(
    () => page.rawText || panelsToMarkdown(page.panels, pageIndex + 1),
    [page.rawText, page.panels, pageIndex],
  );
  const [draft, setDraft] = useState(rawText);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  // Sync local edits with parent updates (re-extract / re-render persist).
  useEffect(() => { setDraft(rawText); }, [rawText]);
  const dirty = draft !== rawText;

  // Job status comes from MediaJobThumb via callback so we don't double-
  // subscribe to the same socket events. Treat 'unknown' (pre-hydration)
  // as in-flight when a jobId exists — avoids a brief re-enable flash
  // after page reload while the GET /media-jobs/:id catches up.
  const [jobStatus, setJobStatus] = useState('unknown');
  const jobInFlight = !!page.imageJobId
    && jobStatus !== 'completed'
    && jobStatus !== 'failed'
    && jobStatus !== 'canceled';
  const onJobFilename = useCallback((filename) => {
    if (page.imageJobId) onFilenameKnown?.(page.imageJobId, filename);
  }, [page.imageJobId, onFilenameKnown]);

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

  const handleRender = async () => {
    setRendering(true);
    const res = await generatePipelineComicPage(issue.id, pageIndex, renderOpts)
      .catch((err) => { toast.error(err.message || 'Render failed'); return null; });
    setRendering(false);
    if (res) {
      onStageUpdate?.('comicPages', res.stage);
      toast.success(`Page ${pageIndex + 1} render queued (${res.mode || renderOpts.mode || 'local'})`);
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

  return (
    <li className="rounded-lg border border-port-border bg-port-card/40">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-port-border">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-gray-500">Page {pageIndex + 1}</span>
          <span className="text-[10px] text-gray-600">{page.panels?.length || 0} panel{page.panels?.length === 1 ? '' : 's'}</span>
          {dirty ? <span className="text-[10px] text-port-warning">unsaved</span> : null}
        </div>
        <div className="flex items-center gap-1">
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
            onClick={handleRender}
            disabled={rendering || dirty || jobInFlight}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-accent text-white font-medium disabled:opacity-40"
            title={dirty
              ? 'Save changes before rendering'
              : jobInFlight
                ? 'Render in progress…'
                : 'Queue a full-page render for this page'}
          >
            {(rendering || jobInFlight) ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}
            Render
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
        <div className="flex items-center justify-center bg-port-bg border border-port-border rounded min-h-[200px] overflow-hidden">
          {page.imageJobId ? (
            <MediaJobThumb
              jobId={page.imageJobId}
              label={`Page ${pageIndex + 1}`}
              size="fill"
              onPreview={(filename) => onPreview?.(pageIndex, filename, page)}
              onStatus={setJobStatus}
              onFilename={onJobFilename}
            />
          ) : (
            <span className="text-xs text-gray-500 italic">No render yet — click <em>Render</em>.</span>
          )}
        </div>
      </div>
    </li>
  );
}
