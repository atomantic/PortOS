/**
 * Pipeline — Manuscript Editor.
 *
 * Full-bleed two-pane workspace (`/pipeline/series/:seriesId/manuscript`) that
 * makes the "Finish the draft" pass actionable:
 *   - Left  : the whole series manuscript, one editable section per issue in
 *             story order. The series "manuscript" is virtual — one chosen
 *             stage per issue (comicScript ▸ teleplay ▸ prose). Each section is
 *             a free-text editor that saves back to that issue's stage on blur.
 *   - Right : Word-style editorial comments from the completeness pass. Click a
 *             comment to jump to (and select) its anchor in the manuscript,
 *             generate an AI find/replace fix, edit it, and accept it into the
 *             manuscript — or dismiss it.
 *
 * Data: GET /pipeline/series/:id/manuscript (sections) + .../manuscript/review
 * (comments). Section saves reuse PATCH /pipeline/issues/:id; fixes go through
 * the manuscript-review fix/accept routes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Loader2, Sparkles, Check, X, CornerDownRight, FileText, ChevronDown, ChevronRight, Star, History, RotateCcw, ClipboardCheck,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { timeAgo } from '../utils/formatters';
import { filterSelectableModels } from '../utils/providers';
import {
  getPipelineSeries, updatePipelineSeries, getPipelineManuscript, getPipelineManuscriptReview,
  patchPipelineManuscriptComment, savePipelineManuscriptSection, restorePipelineStageVersion,
  generatePipelineManuscriptFix, acceptPipelineManuscriptFix,
  analyzePipelineManuscriptCompleteness, getProviders,
} from '../services/api';

const STAGE_LABEL = { comicScript: 'comic script', teleplay: 'teleplay', prose: 'prose', idea: 'outline' };
// Format switcher: the three manuscript formats the editor can span the full
// story in. Order mirrors the server's MANUSCRIPT_STAGES precedence.
const MANUSCRIPT_TYPES = [
  { id: 'comicScript', label: 'Comic' },
  { id: 'teleplay', label: 'Teleplay' },
  { id: 'prose', label: 'Prose' },
];

const SEVERITY_TONE = {
  high: 'bg-port-error/15 text-port-error border-port-error/40',
  medium: 'bg-port-warning/15 text-port-warning border-port-warning/40',
  low: 'bg-gray-600/20 text-gray-300 border-port-border',
};

const CATEGORY_LABEL = {
  'missing-content': 'Missing content',
  'arc-gap': 'Arc gap',
  'character-gap': 'Character gap',
  pacing: 'Pacing',
  continuity: 'Continuity',
  other: 'Note',
};

// Approximate the textarea height to its content so the manuscript reads as one
// continuous scroll (lets jump-to-anchor scroll the page, not an inner box).
const rowsFor = (text) => Math.min(400, Math.max(8, (text || '').split('\n').length + 1));

export default function PipelineManuscriptEditor() {
  const { seriesId } = useParams();
  const navigate = useNavigate();
  const [series, setSeries] = useState(null);
  const [sections, setSections] = useState([]);
  const [viewType, setViewType] = useState(null);          // format currently shown
  const [pinnedPrimary, setPinnedPrimary] = useState(null);   // explicit bible value (may be null)
  const [availableTypes, setAvailableTypes] = useState([]);   // formats with ≥1 drafted issue
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [pinning, setPinning] = useState(false);
  // AI provider override for Generate-fix + Editorial-review actions.
  // '' means "System default" (no override sent to server). Intentionally NOT
  // auto-selected — useProviderModels always picks the first provider, but here
  // "no selection" is the correct default so we manage this state directly.
  const [providers, setProviders] = useState([]);
  const [overrideProviderId, setOverrideProviderId] = useState('');
  const [overrideModel, setOverrideModel] = useState('');
  // Per-issue free-text save state: 'saving' | 'saved' | undefined.
  const [saveState, setSaveState] = useState({});
  // textarea elements keyed by issue number, for jump-to-anchor.
  const sectionRefs = useRef(new Map());
  // Last-saved content per `${issueId}:${stageId}`, so a blur with no change
  // doesn't create a spurious version.
  const baselineRef = useRef(new Map());
  const seedBaselines = (list) => {
    baselineRef.current = new Map((list || []).map((s) => [`${s.issueId}:${s.stageId}`, s.content]));
  };

  // Patch one section's fields (content/versions) in place after a save/revert.
  const patchSection = (issueId, fields) =>
    setSections((prev) => prev.map((s) => (s.issueId === issueId ? { ...s, ...fields } : s)));

  useEffect(() => {
    let canceled = false;
    Promise.all([
      getPipelineSeries(seriesId),
      getPipelineManuscript(seriesId),
      getPipelineManuscriptReview(seriesId).catch(() => ({ comments: [] })),
    ])
      .then(([s, manuscript, review]) => {
        if (canceled) return;
        setSeries(s);
        const initialSections = Array.isArray(manuscript?.sections) ? manuscript.sections : [];
        setSections(initialSections);
        seedBaselines(initialSections);
        setViewType(manuscript?.viewType || null);
        setPinnedPrimary(manuscript?.pinnedPrimary || null);
        setAvailableTypes(Array.isArray(manuscript?.availableTypes) ? manuscript.availableTypes : []);
        setComments(Array.isArray(review?.comments) ? review.comments : []);
      })
      .catch((err) => {
        if (canceled) return;
        toast.error(err.message || 'Failed to load manuscript');
        navigate(`/pipeline/series/${seriesId}`);
      })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [seriesId, navigate]);

  // Load the enabled provider list once for the override selector.
  useEffect(() => {
    let canceled = false;
    getProviders()
      .then((data) => { if (!canceled) setProviders((data?.providers || []).filter((p) => p.enabled)); })
      .catch(() => {});
    return () => { canceled = true; };
  }, []);

  const overrideProvider = providers.find((p) => p.id === overrideProviderId) || null;
  const overrideModels = filterSelectableModels(overrideProvider?.models || [overrideProvider?.defaultModel]);
  // undefined (not '') so the server treats it as "no override" → system default.
  const providerOverride = overrideProviderId || undefined;
  const modelOverride = overrideModel || undefined;

  const changeOverrideProvider = (id) => {
    setOverrideProviderId(id);
    const p = providers.find((pr) => pr.id === id);
    setOverrideModel(p?.defaultModel || '');
  };

  // Re-run the editorial completeness pass over the manuscript with the chosen
  // provider. The route persists findings as the review comment set, so we just
  // swap in the returned comments.
  const [runEditorialReview, reviewing] = useAsyncAction(
    async () => {
      const result = await analyzePipelineManuscriptCompleteness(seriesId, { providerOverride, modelOverride });
      const next = Array.isArray(result?.review?.comments) ? result.review.comments : [];
      setComments(next);
      toast.success(`Editorial review complete — ${next.filter((c) => c.status === 'open').length} open notes`);
    },
    { errorMessage: 'Failed to run editorial review' },
  );

  // Switch which format the editor spans. Refetches that format's full-story
  // sections (every issue, empty where undrafted).
  const changeView = async (type) => {
    if (type === viewType || switching) return;
    setSwitching(true);
    const manuscript = await getPipelineManuscript(seriesId, type).catch((err) => {
      toast.error(err.message || 'Failed to load that format');
      return null;
    });
    setSwitching(false);
    if (!manuscript) return;
    const nextSections = Array.isArray(manuscript.sections) ? manuscript.sections : [];
    setSections(nextSections);
    seedBaselines(nextSections);
    setViewType(manuscript.viewType || type);
    setAvailableTypes(Array.isArray(manuscript.availableTypes) ? manuscript.availableTypes : availableTypes);
    setSaveState({});
  };

  // Pin the format currently being viewed as the series' source of truth.
  const pinPrimary = async () => {
    if (!viewType || pinning) return;
    setPinning(true);
    const updated = await updatePipelineSeries(seriesId, { primaryManuscriptType: viewType }, { silent: true })
      .catch((err) => { toast.error(err.message || 'Failed to set primary format'); return null; });
    setPinning(false);
    if (!updated) return;
    setPinnedPrimary(updated.primaryManuscriptType || viewType);
    toast.success(`${STAGE_LABEL[viewType] || viewType} set as the primary manuscript`);
  };

  const setSectionContent = (issueId, content) => patchSection(issueId, { content });

  // Save a section's edited text back to its issue stage (versioned — snapshots
  // the prior text so the edit is revertible). Skips no-op blurs so we don't
  // mint a version for an unchanged section. Server serializes the write, so a
  // blur-save can't clobber a concurrent accept on the same stage.
  const saveSection = async (section) => {
    const key = `${section.issueId}:${section.stageId}`;
    if (baselineRef.current.get(key) === section.content) return; // unchanged — nothing to version
    setSaveState((prev) => ({ ...prev, [section.issueId]: 'saving' }));
    const result = await savePipelineManuscriptSection(
      seriesId,
      section.issueId,
      { stageId: section.stageId, output: section.content },
      { silent: true },
    ).catch((err) => {
      toast.error(err.message || 'Failed to save manuscript edit');
      return null;
    });
    if (result?.section) {
      baselineRef.current.set(key, result.section.content);
      patchSection(section.issueId, { versions: result.section.versions });
    }
    setSaveState((prev) => ({ ...prev, [section.issueId]: result ? 'saved' : undefined }));
  };

  // Revert a section to a prior version (runId from its history). The restore
  // route snapshots the now-displaced text first, so revert is itself
  // reversible. Updates content + versions in place.
  const revertSection = async (section, runId) => {
    const result = await restorePipelineStageVersion(section.issueId, section.stageId, runId, { silent: true })
      .catch((err) => { toast.error(err.message || 'Failed to revert'); return null; });
    if (!result?.stage) return null;
    const content = result.stage.output || '';
    const versions = (result.stage.runHistory || []).map((h) => ({ runId: h.runId, createdAt: h.createdAt }));
    baselineRef.current.set(`${section.issueId}:${section.stageId}`, content);
    patchSection(section.issueId, { content, versions });
    setSaveState((prev) => ({ ...prev, [section.issueId]: 'saved' }));
    toast.success('Reverted to the selected version');
    return result;
  };

  // Jump to a comment's anchor: focus the issue's textarea, select the verbatim
  // quote (native selection highlights it), and scroll it into view.
  const jumpToComment = (comment) => {
    const ta = comment.issueNumber != null ? sectionRefs.current.get(comment.issueNumber) : null;
    if (!ta) {
      toast('This comment is not anchored to a specific issue');
      return;
    }
    ta.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const quote = comment.anchorQuote || '';
    const idx = quote ? ta.value.indexOf(quote) : -1;
    ta.focus();
    if (idx !== -1) ta.setSelectionRange(idx, idx + quote.length);
    else ta.setSelectionRange(0, 0);
  };

  const updateCommentLocal = (next) =>
    setComments((prev) => prev.map((c) => (c.id === next.id ? next : c)));

  // After an accepted fix the server returns the rewritten section — reflect it
  // in the manuscript pane so the edit shows without a reload. A comment can
  // target a format other than the one on screen (the sidebar shows all
  // comments); only patch the visible textarea when the edited stage matches
  // the current view, or we'd paint (and later blur-save) the wrong format's
  // text into this section. The edit still persisted server-side — it shows on
  // switching to that format.
  const applyAccepted = ({ comment, section }) => {
    if (section?.issueId && section.stageId === viewType) {
      patchSection(section.issueId, { content: section.content, versions: section.versions });
      baselineRef.current.set(`${section.issueId}:${section.stageId}`, section.content);
      setSaveState((prev) => ({ ...prev, [section.issueId]: 'saved' }));
    }
    if (comment) updateCommentLocal(comment);
  };

  const grouped = useMemo(() => ({
    open: comments.filter((c) => c.status === 'open'),
    accepted: comments.filter((c) => c.status === 'accepted'),
    dismissed: comments.filter((c) => c.status === 'dismissed'),
  }), [comments]);

  if (loading) return <div className="p-6 text-gray-500 text-sm">Loading manuscript…</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex flex-col lg:grid min-h-0" style={{ gridTemplateColumns: 'minmax(0, 1fr) 380px' }}>
        {/* Manuscript pane */}
        <section className="flex flex-col min-h-0 lg:overflow-y-auto p-4 md:p-6 space-y-5">
          <header className="flex items-center gap-3 flex-wrap">
            <Link to={`/pipeline/series/${seriesId}`} className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
              <ArrowLeft size={14} /> Series
            </Link>
            <FileText className="w-5 h-5 text-port-accent ml-2" />
            <h1 className="text-xl font-bold text-white truncate">{series?.name || 'Manuscript'}</h1>

            <div className="ml-auto flex items-center gap-2 flex-wrap">
              {/* Format switcher — span the full story in any of the three formats. */}
              <div className="inline-flex rounded-lg border border-port-border overflow-hidden">
                {MANUSCRIPT_TYPES.map((t) => {
                  const active = t.id === viewType;
                  const has = availableTypes.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => changeView(t.id)}
                      disabled={switching}
                      title={has ? `View the ${t.label.toLowerCase()} manuscript` : `No ${t.label.toLowerCase()} drafted yet — open to start one`}
                      className={`px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                        active ? 'bg-port-accent text-white' : 'bg-port-bg text-gray-400 hover:text-white'
                      }`}
                    >
                      {t.label}
                      {t.id === pinnedPrimary ? <span className="ml-1 text-[10px]" title="Primary source format">★</span> : null}
                      {!has ? <span className="ml-1 text-[10px] opacity-60">·</span> : null}
                    </button>
                  );
                })}
              </div>
              {switching ? <Loader2 size={14} className="animate-spin text-gray-500" /> : null}
              {/* Pin the viewed format as the source of truth (stored in the bible). */}
              {viewType && viewType !== pinnedPrimary ? (
                <button
                  type="button"
                  onClick={pinPrimary}
                  disabled={pinning}
                  title="Mark this format as the series' primary manuscript — the source the other formats are generated from"
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium border bg-port-bg text-gray-300 border-port-border hover:border-port-accent/40 disabled:opacity-50"
                >
                  {pinning ? <Loader2 size={12} className="animate-spin" /> : <Star size={12} />}
                  Set as primary
                </button>
              ) : (
                <span className="text-[11px] uppercase tracking-wider text-gray-500 inline-flex items-center gap-1">
                  <Star size={11} className="text-port-warning" /> primary
                </span>
              )}
            </div>
          </header>

          {sections.length === 0 ? (
            <p className="text-sm text-gray-500 italic">
              No drafted manuscript yet — write a comic script, prose, or teleplay on at least one issue, then run “Finish the draft” from the series arc.
            </p>
          ) : (
            sections.map((section) => (
              <ManuscriptSection
                key={section.issueId}
                section={section}
                saveState={saveState[section.issueId]}
                onContentChange={(content) => setSectionContent(section.issueId, content)}
                onBlurSave={() => saveSection(section)}
                onRevert={(runId) => revertSection(section, runId)}
                registerRef={(el) => {
                  if (el) sectionRefs.current.set(section.number, el);
                  else sectionRefs.current.delete(section.number);
                }}
              />
            ))
          )}
        </section>

        {/* Comments sidebar */}
        <aside className="border-t lg:border-t-0 lg:border-l border-port-border bg-port-card/40 lg:overflow-y-auto p-3 space-y-3">
          {/* AI provider override + editorial-review trigger. The chosen provider
              feeds both the per-comment "Generate fix" and the review re-run. */}
          <div className="border border-port-border rounded-lg bg-port-bg/40 p-2.5 space-y-2">
            <label htmlFor="ms-provider-override" className="block text-[10px] uppercase tracking-wider text-gray-500">
              AI provider — Generate fix &amp; Editorial review
            </label>
            <div className="flex items-center gap-2">
              <select
                id="ms-provider-override"
                value={overrideProviderId}
                onChange={(e) => changeOverrideProvider(e.target.value)}
                className="flex-1 min-w-0 px-2 py-1.5 bg-port-bg border border-port-border rounded text-sm text-white"
              >
                <option value="">System default</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {overrideProviderId && overrideModels.length > 0 ? (
                <select
                  id="ms-model-override"
                  aria-label="Model"
                  value={overrideModel}
                  onChange={(e) => setOverrideModel(e.target.value)}
                  className="flex-1 min-w-0 px-2 py-1.5 bg-port-bg border border-port-border rounded text-sm text-white"
                >
                  {overrideModels.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : null}
            </div>
            <button
              type="button"
              onClick={runEditorialReview}
              disabled={reviewing || sections.length === 0}
              title={sections.length === 0
                ? 'Draft at least one issue before running an editorial review'
                : 'Re-run the editorial feedback pass over the manuscript with the selected provider'}
              className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded text-[12px] font-medium border bg-port-bg text-port-accent border-port-border hover:border-port-accent/40 disabled:opacity-40"
            >
              {reviewing ? <Loader2 size={12} className="animate-spin" /> : <ClipboardCheck size={12} />}
              {reviewing ? 'Running editorial review…' : 'Run editorial review'}
            </button>
          </div>

          <h2 className="text-xs uppercase tracking-wider text-gray-500 flex items-center justify-between">
            <span>Editorial comments</span>
            <span className="text-gray-600">{grouped.open.length} open</span>
          </h2>

          {comments.length === 0 ? (
            <p className="text-xs text-gray-500 italic">
              No comments yet. Run “Finish the draft” from the series arc to generate editorial feedback here.
            </p>
          ) : null}

          {grouped.open.map((comment) => (
            <CommentCard
              key={comment.id}
              comment={comment}
              seriesId={seriesId}
              providerOverride={providerOverride}
              modelOverride={modelOverride}
              onJump={jumpToComment}
              onCommentChange={updateCommentLocal}
              onAccepted={applyAccepted}
            />
          ))}

          <ResolvedGroup label="Accepted" icon={Check} items={grouped.accepted} onJump={jumpToComment} />
          <ResolvedGroup label="Dismissed" icon={X} items={grouped.dismissed} onJump={jumpToComment} />
        </aside>
      </div>
    </div>
  );
}

// One issue's manuscript section: an auto-sized free-text editor plus a
// collapsible version history with one-click revert.
function ManuscriptSection({ section, saveState, onContentChange, onBlurSave, onRevert, registerRef }) {
  const [showVersions, setShowVersions] = useState(false);
  const [revertingId, setRevertingId] = useState(null);
  const versions = section.versions || [];

  const revert = async (runId) => {
    setRevertingId(runId);
    await onRevert(runId);
    setRevertingId(null);
  };

  return (
    <article className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 sticky top-0 bg-port-bg/95 backdrop-blur py-1 z-10">
        <h2 className="text-sm font-semibold text-gray-200">
          Issue {section.number}{section.title ? ` — ${section.title}` : ''}
          <span className="ml-2 text-[10px] uppercase tracking-wider text-gray-500">{STAGE_LABEL[section.stageId] || section.stageId}</span>
        </h2>
        <div className="flex items-center gap-2">
          <SaveBadge state={saveState} />
          {versions.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowVersions((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-white"
              title="Show prior saved versions"
            >
              <History size={12} /> {versions.length}
            </button>
          ) : null}
        </div>
      </div>

      {showVersions && versions.length > 0 ? (
        <div className="border border-port-border rounded bg-port-bg/40 p-2 space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-gray-500">Version history (newest first)</p>
          {versions.map((v) => (
            <div key={v.runId} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-gray-400">{v.createdAt ? timeAgo(v.createdAt) : v.runId}</span>
              <button
                type="button"
                onClick={() => revert(v.runId)}
                disabled={revertingId === v.runId}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-gray-300 hover:text-white border border-port-border hover:border-port-accent/40 disabled:opacity-40"
                title="Revert this section to that version (reversible)"
              >
                {revertingId === v.runId ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                Revert
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <textarea
        ref={registerRef}
        value={section.content}
        onChange={(e) => onContentChange(e.target.value)}
        onBlur={onBlurSave}
        rows={rowsFor(section.content)}
        spellCheck
        className="w-full px-3 py-2 bg-port-card border border-port-border rounded text-sm text-gray-100 font-mono leading-relaxed resize-y focus:border-port-accent/50 focus:outline-none"
      />
    </article>
  );
}

function SaveBadge({ state }) {
  if (state === 'saving') return <span className="text-[10px] text-gray-500 inline-flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> saving</span>;
  if (state === 'saved') return <span className="text-[10px] text-port-success">saved</span>;
  return null;
}

function Badge({ comment }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${SEVERITY_TONE[comment.severity] || SEVERITY_TONE.low}`}>
        {comment.severity}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-gray-500">{CATEGORY_LABEL[comment.category] || comment.category}</span>
    </span>
  );
}

function CommentCard({ comment, seriesId, providerOverride, modelOverride, onJump, onCommentChange, onAccepted }) {
  const [replaceText, setReplaceText] = useState(comment.fix?.replace || '');
  const hasFix = !!comment.fix;

  const [runGenerate, generating] = useAsyncAction(
    () => generatePipelineManuscriptFix(seriesId, comment.id, { providerOverride, modelOverride }),
    { errorMessage: 'Failed to generate fix' },
  );
  const [runAccept, accepting] = useAsyncAction(
    () => acceptPipelineManuscriptFix(seriesId, comment.id, { find: comment.fix.find, replace: replaceText }),
    { errorMessage: 'Failed to apply fix' },
  );

  const generate = async () => {
    const result = await runGenerate();
    if (!result) return;
    setReplaceText(result.fix?.replace || '');
    if (result.comment) onCommentChange(result.comment);
    if (result.fix?.fuzzy) toast('The suggested anchor was not found verbatim — edit the manuscript directly, or adjust the replacement.');
  };

  const accept = async () => {
    if (!comment.fix) return;
    const result = await runAccept();
    if (!result) return;
    onAccepted(result);
    toast.success('Fix applied to the manuscript');
  };

  const dismiss = async () => {
    const result = await patchPipelineManuscriptComment(seriesId, comment.id, { status: 'dismissed' }, { silent: true })
      .catch((err) => { toast.error(err.message || 'Failed to dismiss'); return null; });
    if (result?.comment) onCommentChange(result.comment);
  };

  const fuzzy = comment.fix?.fuzzy;

  return (
    <div className="border border-port-border rounded-lg bg-port-bg/40 p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Badge comment={comment} />
        <button
          type="button"
          onClick={() => onJump(comment)}
          className="text-[11px] text-port-accent hover:underline inline-flex items-center gap-1"
          title="Jump to this spot in the manuscript"
        >
          <CornerDownRight size={11} />
          {comment.issueNumber != null ? `Issue ${comment.issueNumber}` : 'Jump'}
        </button>
      </div>

      <p className="text-xs text-gray-200">{comment.problem}</p>
      {comment.suggestion ? <p className="text-[11px] text-gray-400"><span className="text-gray-500">Fix: </span>{comment.suggestion}</p> : null}
      {comment.anchorQuote ? <p className="text-[11px] text-gray-500 italic line-clamp-2">“{comment.anchorQuote}”</p> : null}

      {hasFix ? (
        <div className="space-y-1.5">
          {comment.fix.find ? (
            <details className="text-[11px]">
              <summary className="text-gray-500 cursor-pointer">Replacing…</summary>
              <pre className="mt-1 whitespace-pre-wrap text-gray-500 bg-port-card border border-port-border rounded p-1.5 max-h-24 overflow-y-auto">{comment.fix.find}</pre>
            </details>
          ) : null}
          <label htmlFor={`fix-replace-${comment.id}`} className="block text-[10px] uppercase tracking-wider text-gray-500">Suggested replacement (editable)</label>
          <textarea
            id={`fix-replace-${comment.id}`}
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            rows={Math.min(16, Math.max(3, replaceText.split('\n').length + 1))}
            className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-[12px] text-gray-100 font-mono resize-y focus:border-port-accent/50 focus:outline-none"
          />
          {fuzzy ? (
            <p className="text-[10px] text-port-warning">Anchor not found verbatim — accepting may fail; edit the manuscript directly if so.</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-0.5">
        {!hasFix ? (
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-medium border bg-port-bg text-port-accent border-port-border hover:border-port-accent/40 disabled:opacity-40"
          >
            {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            Generate fix
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={accept}
              disabled={accepting || !replaceText.trim()}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-medium bg-port-success/20 text-port-success border border-port-success/40 hover:bg-port-success/30 disabled:opacity-40"
            >
              {accepting ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Accept
            </button>
            <button
              type="button"
              onClick={generate}
              disabled={generating || accepting}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[12px] text-gray-400 hover:text-white disabled:opacity-40"
              title="Regenerate the suggested fix"
            >
              {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={dismiss}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-[12px] text-gray-500 hover:text-white"
        >
          <X size={12} /> Dismiss
        </button>
      </div>
    </div>
  );
}

function ResolvedGroup({ label, icon: Icon, items, onJump }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="pt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-gray-500 hover:text-gray-300"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Icon size={12} /> {label} ({items.length})
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1.5">
          {items.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onJump(c)}
              className="block w-full text-left border border-port-border rounded p-2 bg-port-bg/30 hover:border-port-accent/30"
            >
              <span className="text-[11px] text-gray-400 line-clamp-2">{c.problem}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
