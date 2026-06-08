/**
 * Pipeline — Manuscript Editor.
 *
 * Full-bleed two-pane workspace (`/pipeline/series/:seriesId/manuscript`) that
 * makes the "Finish the draft" pass actionable, with editorial feedback shown
 * IN CONTEXT inside the manuscript instead of read out of a disconnected list:
 *   - Left  : the whole series manuscript, one section per issue in story order.
 *             The series "manuscript" is virtual — one chosen stage per issue
 *             (comicScript ▸ teleplay ▸ prose). Two viewing modes (toggle in the
 *             header, persisted): "Live" keeps each section editable with
 *             Grammarly-style underlines under anchored notes (click → popover);
 *             "Review" shows read-only annotated prose with click-to-expand
 *             cards and an Edit toggle per section.
 *   - Right : a navigable/filterable INDEX of editorial comments — click a row
 *             to reveal + open that note in the manuscript.
 *   An "Impact preview" button shows a before/after side-by-side diff of how the
 *   selected fixes change the whole manuscript.
 *
 * Data: GET /pipeline/series/:id/manuscript (sections) + .../manuscript/review
 * (comments). Section saves reuse PATCH /pipeline/issues/:id; fixes go through
 * the manuscript-review fix/accept routes. See the design record at
 * docs/plans/2026-06-06-manuscript-editor-inline-feedback.md.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Loader2, Sparkles, FileText, Star, ClipboardCheck, Layers, PencilLine, BookOpen, GitCompare,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { filterGenerationModels, mergeModelLists, localBackendForProvider, modelOptionLabel } from '../utils/providers';
import useLocalModels from '../hooks/useLocalModels';
import { locateAnchors } from '../lib/manuscriptAnchors';
import ManuscriptLiveSection from '../components/pipeline/manuscript/ManuscriptLiveSection';
import AnnotatedManuscriptSection from '../components/pipeline/manuscript/AnnotatedManuscriptSection';
import ManuscriptCommentIndex from '../components/pipeline/manuscript/ManuscriptCommentIndex';
import ManuscriptIssueTabs from '../components/pipeline/manuscript/ManuscriptIssueTabs';
import ManuscriptImpactPreview from '../components/pipeline/manuscript/ManuscriptImpactPreview';
import { MANUSCRIPT_TYPES, STAGE_LABEL } from '../components/pipeline/manuscript/constants';
import {
  getPipelineSeries, updatePipelineSeries, getPipelineManuscript, getPipelineManuscriptReview,
  savePipelineManuscriptSection, restorePipelineStageVersion,
  analyzePipelineManuscriptCompleteness, getProviders,
} from '../services/api';

// Stable empty array so sections that gain no comments/spans don't get a fresh
// `[]` identity every render.
const EMPTY = [];

const VIEW_MODE_KEY = 'portos.manuscript.viewMode';
const initialViewMode = () => {
  if (typeof window === 'undefined') return 'live';
  return window.localStorage.getItem(VIEW_MODE_KEY) === 'review' ? 'review' : 'live';
};

export default function PipelineManuscriptEditor() {
  const params = useParams();
  const { seriesId } = params;
  const navigate = useNavigate();
  // The issue (by number) the editor is focused on — one issue per view,
  // deep-linkable at /pipeline/series/:id/manuscript/:issueNumber. Read from the
  // route splat (a single splat route, not two :param routes, so issue→issue
  // navigation reuses this component instead of remounting). null on the bare
  // /manuscript URL; a reconcile effect canonicalizes it to the first issue.
  const issueParam = params['*'];
  const activeNumber = issueParam ? Number(issueParam) : null;
  const [series, setSeries] = useState(null);
  const [sections, setSections] = useState([]);
  const [viewType, setViewType] = useState(null);          // format currently shown
  const [pinnedPrimary, setPinnedPrimary] = useState(null);
  const [availableTypes, setAvailableTypes] = useState([]);
  const [comments, setComments] = useState([]);
  const [reviewMeta, setReviewMeta] = useState(null);
  const [freshReview, setFreshReview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [providers, setProviders] = useState([]);
  const [overrideProviderId, setOverrideProviderId] = useState('');
  const [overrideModel, setOverrideModel] = useState('');
  const [saveState, setSaveState] = useState({});
  // 'live' (Grammarly editable + underlines) | 'review' (annotated read-then-edit).
  const [viewMode, setViewMode] = useState(initialViewMode);
  // The comment whose card is open in-context (popover in Live, inline in Review).
  const [openCommentId, setOpenCommentId] = useState(null);
  // Which section (issueId) is in textarea edit mode in Review.
  const [editingIssueId, setEditingIssueId] = useState(null);
  const [showImpact, setShowImpact] = useState(false);
  // Per-comment fix-edit drafts, keyed by comment id and shared across every
  // place the card renders (sidebar reveal, in-context card, impact preview).
  const [fixDrafts, setFixDrafts] = useState({});
  const setCommentDraft = (commentId, entry) =>
    setFixDrafts((prev) => ({ ...prev, [commentId]: entry }));
  // textarea elements keyed by issue number, for reveal-to-section scroll/focus.
  const sectionRefs = useRef(new Map());
  const baselineRef = useRef(new Map());
  const seedBaselines = (list) => {
    baselineRef.current = new Map((list || []).map((s) => [`${s.issueId}:${s.stageId}`, s.content]));
  };

  const patchSection = (issueId, fields) =>
    setSections((prev) => prev.map((s) => (s.issueId === issueId ? { ...s, ...fields } : s)));

  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

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
    // Keyed on seriesId only — `navigate`'s identity changes when the issue-tab
    // URL changes, and including it would re-run this initial load (clobbering a
    // format switch with a stale default-format refetch).
  }, [seriesId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let canceled = false;
    getProviders()
      .then((data) => { if (!canceled) setProviders((data?.providers || []).filter((p) => p.enabled)); })
      .catch(() => {});
    return () => { canceled = true; };
  }, []);

  const overrideProvider = providers.find((p) => p.id === overrideProviderId) || null;
  const localModels = useLocalModels();
  const overrideBackend = localBackendForProvider(overrideProvider);
  const overrideModels = useMemo(
    () => filterGenerationModels(
      mergeModelLists(
        overrideProvider?.models || [overrideProvider?.defaultModel],
        overrideBackend ? localModels[overrideBackend] : [],
      ),
    ),
    [overrideProvider, overrideBackend, localModels],
  );
  const editorialPick = overrideBackend ? localModels.recommendations?.[overrideBackend] : null;
  const showEditorialPick = Boolean(
    editorialPick?.id && overrideModels.includes(editorialPick.id) && overrideModel !== editorialPick.id,
  );

  useEffect(() => {
    if (!overrideProviderId || overrideModels.length === 0) return;
    if (overrideModel && overrideModels.includes(overrideModel)) return;
    const pick = (editorialPick?.id && overrideModels.includes(editorialPick.id))
      ? editorialPick.id
      : overrideModels[0];
    setOverrideModel(pick);
  }, [overrideProviderId, overrideModels, editorialPick, overrideModel]);

  const providerOverride = overrideProviderId || undefined;
  const modelOverride = overrideModel || undefined;

  const changeOverrideProvider = (id) => {
    setOverrideProviderId(id);
    const p = providers.find((pr) => pr.id === id);
    setOverrideModel(p?.defaultModel || '');
  };

  const [runEditorialReview, reviewing] = useAsyncAction(
    async (mode = 'merge') => {
      const result = await analyzePipelineManuscriptCompleteness(seriesId, { providerOverride, modelOverride, mode });
      const next = Array.isArray(result?.review?.comments) ? result.review.comments : [];
      setComments(next);
      setReviewMeta({ chunked: !!result?.chunked, chunkCount: result?.chunkCount || 1 });
      const openCount = next.filter((c) => c.status === 'open').length;
      toast.success(result?.chunked
        ? `Editorial review complete — ${openCount} open notes (reviewed in ${result.chunkCount} chunks)`
        : `Editorial review complete — ${openCount} open notes`);
    },
    { errorMessage: 'Failed to run editorial review' },
  );

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
    setOpenCommentId(null);
    setEditingIssueId(null);
  };

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

  const saveSection = async (section) => {
    const key = `${section.issueId}:${section.stageId}`;
    if (baselineRef.current.get(key) === section.content) return;
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

  // Reveal a comment in context: drop into Review mode (where the note expands
  // as an in-context card) and open it, switching to its issue tab if needed.
  // The section's card-scroll effect brings the card into view — on arrival for
  // a cross-issue jump, or immediately when it's the active issue. A story-level
  // note with no issueNumber has no tab, so it expands inline in the sidebar.
  const revealComment = (comment) => {
    setOpenCommentId(comment.id);
    setViewMode('review');     // surface the in-context review card…
    setEditingIssueId(null);   // …and make sure it's the card showing, not the editor
    if (comment.issueNumber == null) return; // unanchored — expands in the sidebar
    if (comment.issueNumber !== activeNumber) {
      navigate(`/pipeline/series/${seriesId}/manuscript/${comment.issueNumber}`);
    }
    if (comment.stageId && viewType && comment.stageId !== viewType) {
      toast(`This note is on the ${STAGE_LABEL[comment.stageId] || comment.stageId} — switch formats to edit it in context`);
    }
  };

  const updateCommentLocal = (next) =>
    setComments((prev) => prev.map((c) => (c.id === next.id ? next : c)));

  const applyAccepted = ({ comment, section, sections: changedSections }) => {
    const list = Array.isArray(changedSections) && changedSections.length ? changedSections : [section].filter(Boolean);
    list.forEach((changed) => {
      if (changed?.issueId && changed.stageId === viewType) {
        patchSection(changed.issueId, { content: changed.content, versions: changed.versions });
        baselineRef.current.set(`${changed.issueId}:${changed.stageId}`, changed.content);
        setSaveState((prev) => ({ ...prev, [changed.issueId]: 'saved' }));
      }
    });
    if (comment) updateCommentLocal(comment);
  };

  // Open editorial comments anchorable to the on-screen format, grouped by issue
  // number. Comments targeting a different stage stay index-only (no highlight).
  const openCommentsByNumber = useMemo(() => {
    const map = new Map();
    comments.forEach((c) => {
      if (c.status !== 'open') return;
      if (c.stageId && viewType && c.stageId !== viewType) return;
      if (c.issueNumber == null) return;
      if (!map.has(c.issueNumber)) map.set(c.issueNumber, []);
      map.get(c.issueNumber).push(c);
    });
    return map;
  }, [comments, viewType]);

  // Locate every open comment's anchor span per section once, here — the
  // sections render from these rather than recomputing locateAnchors each.
  const sectionSpans = useMemo(() => {
    const map = new Map();
    sections.forEach((s) => {
      map.set(s.issueId, locateAnchors(s.content || '', openCommentsByNumber.get(s.number) || []));
    });
    return map;
  }, [sections, openCommentsByNumber]);

  // Which comments actually located their anchor in the current draft.
  const locatedCommentIds = useMemo(() => {
    const set = new Set();
    sectionSpans.forEach((spans) => spans.forEach((span) => set.add(span.commentId)));
    return set;
  }, [sectionSpans]);

  // Open-note count per issue, for the tab badges.
  const openCountByNumber = useMemo(() => {
    const map = new Map();
    openCommentsByNumber.forEach((list, number) => map.set(number, list.length));
    return map;
  }, [openCommentsByNumber]);

  // The one issue the editor is focused on. On the bare /manuscript URL (or an
  // unknown issue) fall back to the first issue so there's no blank frame, and
  // canonicalize the URL to it so the tab highlights and deep links/back work.
  const matchedSection = sections.find((s) => s.number === activeNumber) || null;
  const activeSection = matchedSection || sections[0] || null;
  useEffect(() => {
    if (!activeSection) return;
    if (activeNumber === activeSection.number) return;
    navigate(`/pipeline/series/${seriesId}/manuscript/${activeSection.number}`, { replace: true });
  }, [activeSection, activeNumber, seriesId, navigate]);

  // Plain object (not memoized): its handlers close over viewType/sections, so a
  // stale memo would apply accepts against the wrong format. Children read
  // individual fields rather than the object identity, so there's nothing to gain.
  const commentCardProps = {
    seriesId,
    providerOverride,
    modelOverride,
    onCommentChange: updateCommentLocal,
    onAccepted: applyAccepted,
    fixDrafts,
    setCommentDraft,
  };

  const registerSectionRef = (number) => (el) => {
    if (el) sectionRefs.current.set(number, el);
    else sectionRefs.current.delete(number);
  };

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
              {/* View-mode toggle: Live (Grammarly) vs Review (annotated). */}
              <div className="inline-flex rounded-lg border border-port-border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setViewMode('live')}
                  title="Live editing with inline underlines (Grammarly-style)"
                  className={`px-2.5 py-1.5 text-sm font-medium inline-flex items-center gap-1 ${viewMode === 'live' ? 'bg-port-accent text-white' : 'bg-port-bg text-gray-400 hover:text-white'}`}
                >
                  <PencilLine size={13} /> Live
                </button>
                <button
                  type="button"
                  onClick={() => { setViewMode('review'); setEditingIssueId(null); }}
                  title="Annotated read-through with click-to-expand notes"
                  className={`px-2.5 py-1.5 text-sm font-medium inline-flex items-center gap-1 ${viewMode === 'review' ? 'bg-port-accent text-white' : 'bg-port-bg text-gray-400 hover:text-white'}`}
                >
                  <BookOpen size={13} /> Review
                </button>
              </div>

              <button
                type="button"
                onClick={() => setShowImpact(true)}
                title="Preview how the selected fixes change the whole manuscript"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium border bg-port-bg text-gray-300 border-port-border hover:border-port-accent/40"
              >
                <GitCompare size={13} /> Impact preview
              </button>

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
            <>
              <ManuscriptIssueTabs
                seriesId={seriesId}
                sections={sections}
                activeNumber={activeNumber}
                openCountByNumber={openCountByNumber}
              />
              {activeSection ? (() => {
                const section = activeSection;
                const common = {
                  section,
                  comments: openCommentsByNumber.get(section.number) || EMPTY,
                  spans: sectionSpans.get(section.issueId) || EMPTY,
                  saveState: saveState[section.issueId],
                  openCommentId,
                  onOpenComment: setOpenCommentId,
                  onCloseComment: () => setOpenCommentId(null),
                  onContentChange: (content) => setSectionContent(section.issueId, content),
                  onBlurSave: () => saveSection(section),
                  onRevert: (runId) => revertSection(section, runId),
                  registerRef: registerSectionRef(section.number),
                  commentCardProps,
                };
                // Key on issueId so switching issues mounts a fresh section —
                // the card-scroll-into-view effect then fires on arrival.
                return viewMode === 'live' ? (
                  <ManuscriptLiveSection key={section.issueId} {...common} />
                ) : (
                  <AnnotatedManuscriptSection
                    key={section.issueId}
                    {...common}
                    editing={editingIssueId === section.issueId}
                    onToggleEdit={() => setEditingIssueId((cur) => (cur === section.issueId ? null : section.issueId))}
                  />
                );
              })() : null}
            </>
          )}
        </section>

        {/* Comments sidebar — provider override, review trigger, and the index. */}
        <aside className="border-t lg:border-t-0 lg:border-l border-port-border bg-port-card/40 lg:overflow-y-auto p-3 space-y-3">
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
                  {overrideModels.map((m) => <option key={m} value={m}>{modelOptionLabel(m, localModels.ctxById)}</option>)}
                </select>
              ) : null}
            </div>
            {showEditorialPick ? (
              <button
                type="button"
                onClick={() => setOverrideModel(editorialPick.id)}
                title={editorialPick.reason}
                className="inline-flex items-center gap-1 text-[11px] text-port-accent hover:underline"
              >
                <Sparkles size={11} /> Recommended for editing: {editorialPick.id}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => runEditorialReview(freshReview ? 'fresh' : 'merge')}
              disabled={reviewing || sections.length === 0}
              title={sections.length === 0
                ? 'Draft at least one issue before running an editorial review'
                : 'Re-run the editorial feedback pass over the manuscript with the selected provider'}
              className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded text-[12px] font-medium border bg-port-bg text-port-accent border-port-border hover:border-port-accent/40 disabled:opacity-40"
            >
              {reviewing ? <Loader2 size={12} className="animate-spin" /> : <ClipboardCheck size={12} />}
              {reviewing ? 'Running editorial review…' : 'Run editorial review'}
            </button>
            <label htmlFor="ms-fresh-review" className="flex items-start gap-1.5 text-[11px] text-gray-400 cursor-pointer">
              <input
                id="ms-fresh-review"
                type="checkbox"
                checked={freshReview}
                onChange={(e) => setFreshReview(e.target.checked)}
                disabled={reviewing}
                className="mt-0.5 accent-port-accent"
              />
              <span>
                Start fresh
                <span className="text-gray-600">
                  {' '}— auto-dismiss open notes this pass no longer finds; still-valid,
                  accepted &amp; dismissed notes are kept.
                </span>
              </span>
            </label>
          </div>

          {reviewMeta?.chunked ? (
            <p
              className="flex items-center gap-1.5 text-[11px] text-port-warning"
              title="The manuscript exceeded this model's context window, so it was reviewed in chunks. A larger-context model reviews the whole manuscript in one pass for better cross-chapter continuity."
            >
              <Layers size={11} />
              Reviewed in {reviewMeta.chunkCount} chunks
            </p>
          ) : null}

          <ManuscriptCommentIndex
            comments={comments}
            locatedCommentIds={locatedCommentIds}
            openCommentId={openCommentId}
            onReveal={revealComment}
            commentCardProps={commentCardProps}
          />
        </aside>
      </div>

      <ManuscriptImpactPreview
        open={showImpact}
        onClose={() => setShowImpact(false)}
        sections={sections}
        comments={comments.filter((c) => c.status === 'open' && c.fix)}
        fixDrafts={fixDrafts}
      />
    </div>
  );
}
