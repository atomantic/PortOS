import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Anchor, Check, Wand2 } from 'lucide-react';
import {
  BLEND_MAX_STRENGTH_TAKES, DESIGN_FEATURES, DESIGN_FRAMINGS, DEFAULT_DESIGN_FRAMING, DESIGN_MAX_BLEND_REFS, DESIGN_MAX_TAKES, designRoundId, designTakeIndex, featureLines, blendLines,
} from '../../../../server/lib/catalogDesign.js';
import { listMoodBoardNames } from '../../services/api';
import { getCatalogIngredientDetails, renderCatalogDesign, spreadCatalogDesign, updateCatalogIngredientMediaLibrary } from '../../services/apiCatalog';
import { useModelInputPreview } from '../../hooks/useModelInputPreview';
import useProviderModels from '../../hooks/useProviderModels';
import useMounted from '../../hooks/useMounted';
import { safeReadJsonSession, safeRemoveSession, safeWriteJsonSession } from '../../lib/safeStorage';
import { isDesignMedia } from '../../lib/creativeLibraries';
import ProviderModelSelector from '../ProviderModelSelector';
import ModelInputPreview from '../media/ModelInputPreview';
import SentPromptPanel from '../media/SentPromptPanel';
import MediaJobThumb from '../pipeline/MediaJobThumb';
import IngredientPicker from '../IngredientPicker';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import MoodBoardPinPicker from '../storyboards/MoodBoardPinPicker';
import TabPills from '../ui/TabPills';
import CatalogImagePreview from './CatalogImagePreview';
import MediaImage from '../MediaImage';

const fieldClass = 'min-h-11 w-full rounded border border-port-border bg-port-bg px-2 text-sm';
const buttonClass = 'min-h-11 rounded border border-port-accent px-3 py-2 text-sm text-port-accent hover:bg-port-accent/10 disabled:opacity-40';
const IMAGE_KINDS = new Set(['portrait', 'reference']);
const takeLine = (m) => m.library?.review?.feedback || '';
const formKey = (m) => m?.library?.variant?.formId || '';

// Casting > Design: rounds of face takes. The picked take lives in the URL
// (`?take=<file>`); pending renders survive a reload in session storage until
// their image lands on the record. The current canon (portrait, else the
// canonical-age anchor) heads the tab so a redesign can start from it.
export default function CatalogDesignPanel({ ingredientId, name, forms = [], media, blockedReason, onChanged, onSetPortrait }) {
  const mounted = useMounted();
  const inFlight = useRef(false);
  const [params, setParams] = useSearchParams();
  const pickedKey = params.get('take');
  const pendingKey = `catalog_design_pending_${ingredientId}`;
  const [pending, setPending] = useState(() => safeReadJsonSession(pendingKey, []) || []);
  useEffect(() => {
    if (pending.length) safeWriteJsonSession(pendingKey, pending); else safeRemoveSession(pendingKey);
  }, [pendingKey, pending]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const takes = useMemo(() => media.filter((m) => isDesignMedia(m) && IMAGE_KINDS.has(m.kind) && !m.deleted), [media]);
  const landed = useMemo(() => new Set(takes.map((m) => m.mediaKey.replace(/\.[^.]+$/, ''))), [takes]);
  const waiting = pending.filter((p) => !landed.has(p.jobId));
  const rounds = useMemo(() => {
    const byRound = new Map();
    for (const m of takes) {
      const round = designRoundId(m.role);
      if (!byRound.has(round)) byRound.set(round, { id: round, takes: [], at: 0, from: m.library?.derivedFrom?.mediaKey || null });
      const entry = byRound.get(round);
      entry.takes.push(m);
      entry.at = Math.max(entry.at, Date.parse(m.createdAt || 0) || 0);
    }
    for (const p of waiting) {
      if (!byRound.has(p.roundId)) byRound.set(p.roundId, { id: p.roundId, takes: [], at: p.startedAt });
    }
    return [...byRound.values()].sort((a, b) => b.at - a.at)
      .map((r) => ({ ...r, takes: r.takes.sort((a, b) => designTakeIndex(a.role) - designTakeIndex(b.role)) }));
  }, [takes, waiting]);
  const images = media.filter((m) => IMAGE_KINDS.has(m.kind) && !m.deleted);
  const picked = images.find((m) => m.mediaKey === pickedKey) || null;
  const canon = images.find((m) => m.kind === 'portrait') || images.find((m) => m.library?.guide === true && !formKey(m)) || null;
  const pickedIsCanon = !!picked && picked.mediaKey === canon?.mediaKey;
  const pick = (key) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (key && key !== pickedKey) next.set('take', key); else next.delete('take');
    return next;
  }, { replace: true });

  const recordPending = (roundId, jobs) => {
    if (!mounted.current) return;
    setPending((prev) => [...prev, ...jobs.map((job) => ({ jobId: job.jobId, roundId, line: job.line, startedAt: Date.now() }))]);
  };

  const queue = async (body) => {
    if (inFlight.current || blockedReason) return false;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const result = await renderCatalogDesign(ingredientId, body, { silent: true });
      if (!result?.jobs?.length) throw new Error('The round queued no renders');
      recordPending(result.roundId, result.jobs);
      return true;
    } catch (err) {
      // A partly admitted round keeps its landed takes running: show them.
      if (Array.isArray(err.context?.jobs) && err.context.jobs.length) recordPending(err.context.roundId, err.context.jobs);
      if (mounted.current) setError(err.message || 'Could not start the round');
      return false;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const dropPending = useCallback((jobId) => setPending((prev) => prev.filter((p) => p.jobId !== jobId)), []);

  // Surface why the take died on the panel alert before its thumb unmounts.
  const failPending = useCallback((jobId, status, reason) => {
    setError(reason || (status === 'canceled'
      ? 'This take was canceled. Render it again if you still want it.'
      : 'This take failed. Render it again if you still want it.'));
    dropPending(jobId);
  }, [dropPending]);

  // The anchor becomes the one guide for its age; the old face stops guiding.
  const makeAnchor = async (take) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const age = formKey(take);
      for (const other of images.filter((m) => m.library?.guide === true && formKey(m) === age && m.mediaKey !== take.mediaKey)) {
        await updateCatalogIngredientMediaLibrary(ingredientId, { mediaKey: other.mediaKey, kind: other.kind, guide: false }, { silent: true });
      }
      await updateCatalogIngredientMediaLibrary(ingredientId, { mediaKey: take.mediaKey, kind: take.kind, likeness: true, guide: true }, { silent: true });
      if (!age) await onSetPortrait?.(take.mediaKey);
      onChanged?.();
    } catch (err) {
      if (mounted.current) setError(err.message || 'Could not make this the anchor');
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <section aria-label="Design this cast member" className="space-y-4 min-w-0">
    {blockedReason && <p role="status" className="text-sm text-port-warning">{blockedReason}</p>}
    {canon && !pickedIsCanon && <div className="flex items-center gap-3 rounded border border-port-border p-3">
      <MediaImage thumbnail src={`/data/images/${encodeURIComponent(canon.mediaKey)}`} alt={`${name} current canon`} className="h-24 w-24 shrink-0 rounded object-cover" />
      <div className="min-w-0 space-y-2">
        <p className="text-sm font-semibold">Current canon</p>
        <button type="button" onClick={() => pick(canon.mediaKey)} disabled={!!blockedReason} className={`${buttonClass} inline-flex items-center gap-1`}>
          <Wand2 size={14} aria-hidden="true" /> Redesign from canon</button>
      </div>
    </div>}
    <OpenRound ingredientId={ingredientId} forms={forms} disabled={busy || !!blockedReason} onRender={queue} />
    {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
    {picked && <PickedActions key={picked.mediaKey} ingredientId={ingredientId} take={picked} isCanon={pickedIsCanon} forms={forms} images={images}
      disabled={busy || !!blockedReason} onRender={queue} onAnchor={() => makeAnchor(picked)} onClose={() => pick(null)} />}
    {rounds.length === 0 && <p className="text-sm text-gray-400">No takes yet. Describe an idea above to cast the first faces.</p>}
    {rounds.map((round) => <div key={round.id} className="space-y-2">
      <div className="flex items-center gap-2">
        {round.from && <MediaImage thumbnail src={`/data/images/${encodeURIComponent(round.from)}`} alt="Round made from this take" className="h-8 w-8 rounded object-cover" />}
        <h3 className="text-xs uppercase tracking-wider text-gray-500">{round.from ? 'From this take' : 'New faces'}</h3>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {round.takes.map((m) => {
          const isPicked = m.mediaKey === pickedKey;
          const anchor = m.library?.guide === true;
          return <figure key={m.mediaKey} className={`min-w-0 rounded border ${isPicked ? 'border-port-accent' : 'border-port-border'} bg-port-bg overflow-hidden`}>
            <CatalogImagePreview src={`/data/images/${encodeURIComponent(m.mediaKey)}`} alt={takeLine(m) || `${name} take`} className="w-full aspect-square object-cover" />
            <figcaption className="space-y-1 p-2">
              {takeLine(m) && <p className="text-[11px] text-gray-300 line-clamp-3 whitespace-pre-wrap">{takeLine(m)}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" aria-pressed={isPicked} onClick={() => pick(m.mediaKey)}
                  className="min-h-11 inline-flex items-center gap-1 rounded border border-port-border px-2 text-xs text-port-accent aria-pressed:bg-port-accent/20">
                  {isPicked && <Check size={12} aria-hidden="true" />} {isPicked ? 'Picked' : 'Pick'}
                </button>
                {anchor && <span className="inline-flex items-center gap-1 text-xs text-port-warning"><Anchor size={12} aria-hidden="true" /> Anchor</span>}
              </div>
            </figcaption>
          </figure>;
        })}
        {waiting.filter((p) => p.roundId === round.id).map((p) => <div key={p.jobId} className="min-w-0 space-y-1">
          <MediaJobThumb jobId={p.jobId} label="Take" size="sm" onFilename={() => onChanged?.()}
            onStatus={(status, reason) => { if (status === 'failed' || status === 'canceled') failPending(p.jobId, status, reason); }} />
          {p.line && <p className="text-[11px] text-gray-400 line-clamp-2">{p.line}</p>}
        </div>)}
      </div>
    </div>)}
  </section>;
}

function AgeSelect({ id, forms, value, onChange, disabled, label = 'Age', includeCanonical = true }) {
  return <label htmlFor={id} className="min-w-0 space-y-1 text-xs"><span>{label}</span>
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={fieldClass}>
      {includeCanonical && <option value="">Canonical</option>}
      {forms.map((f) => <option key={f.id} value={f.id}>{f.label || `Age ${f.age}`}</option>)}
    </select>
  </label>;
}

function OpenRound({ ingredientId, forms, disabled, onRender }) {
  const id = useId();
  const mounted = useMounted();
  const selection = useProviderModels({ withEffort: true });
  const [effort, setEffort] = useState('');
  const [idea, setIdea] = useState('');
  const [formId, setFormId] = useState('');
  const [framing, setFraming] = useState(DEFAULT_DESIGN_FRAMING);
  const [count, setCount] = useState(4);
  const [lines, setLines] = useState(null);
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState(null);
  const [error, setError] = useState('');
  const asWritten = Array.from({ length: count }, () => '');
  const body = { mode: 'open', ...(idea.trim() ? { note: idea.trim() } : {}), lines: lines || asWritten, framing, ...(formId ? { formId } : {}) };
  const fetchPreview = useCallback((input, options) => renderCatalogDesign(ingredientId, input, { ...options, preview: true }), [ingredientId]);
  const preview = useModelInputPreview(fetchPreview, body, { enabled: !!idea.trim() || !!lines?.every((l) => l.trim()) });
  const write = async () => {
    if (writing || !idea.trim() || !selection.selectedProviderId) return;
    setWriting(true); setError('');
    const result = await spreadCatalogDesign(ingredientId, { idea: idea.trim(), count, providerId: selection.selectedProviderId,
      ...(selection.selectedModel ? { model: selection.selectedModel } : {}), ...(effort ? { effort } : {}), ...(formId ? { formId } : {}) }, { silent: true })
      .catch((err) => { if (mounted.current) setError(err.message || 'Could not write face designs'); return null; });
    if (!mounted.current) return;
    setWriting(false);
    if (result) { setLines(result.lines); setWritten({ sentPrompt: result.sentPrompt, additions: result.promptAdditions || [], prompt: idea }); }
  };
  const render = async () => { if (await onRender(body)) { setLines(null); setWritten(null); } };
  return <div className="rounded border border-port-border p-3 space-y-3">
    <p className="text-sm font-semibold">New faces from an idea</p>
    <label htmlFor={`${id}-idea`} className="block text-xs">Idea</label>
    <textarea id={`${id}-idea`} value={idea} maxLength={2000} rows={3} disabled={disabled || writing} onChange={(e) => setIdea(e.target.value)}
      placeholder="Who is she? How should the face read?" className="w-full rounded border border-port-border bg-port-bg p-2 text-sm" />
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <AgeSelect id={`${id}-age`} forms={forms} value={formId} onChange={setFormId} disabled={disabled} />
      <label htmlFor={`${id}-framing`} className="min-w-0 space-y-1 text-xs"><span>Framing</span>
        <select id={`${id}-framing`} value={framing} disabled={disabled} onChange={(e) => setFraming(e.target.value)} className={fieldClass}>
          {Object.entries(DESIGN_FRAMINGS).map(([key, f]) => <option key={key} value={key}>{f.label}</option>)}
        </select>
      </label>
      <label htmlFor={`${id}-count`} className="min-w-0 space-y-1 text-xs"><span>Faces</span>
        <select id={`${id}-count`} value={count} disabled={disabled || !!lines} onChange={(e) => setCount(Number(e.target.value))} className={fieldClass}>
          {Array.from({ length: DESIGN_MAX_TAKES - 1 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </div>
    {!lines && <div className="space-y-2">
      <ProviderModelSelector providers={selection.providers} selectedProviderId={selection.selectedProviderId}
        selectedModel={selection.selectedModel} availableModels={selection.availableModels}
        onProviderChange={selection.setSelectedProviderId} onModelChange={selection.setSelectedModel}
        effort={effort} onEffortChange={setEffort} loading={selection.loading} disabled={writing} />
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={write} disabled={disabled || writing || !idea.trim() || !selection.selectedProviderId} className={buttonClass}>
          {writing ? 'Writing…' : `Write ${count} different faces`}</button>
        <button type="button" onClick={render} disabled={disabled || writing || !idea.trim() || !preview.preview} className={buttonClass}>
          Render {count} takes of my idea as written</button>
      </div>
    </div>}
    {written && <SentPromptPanel {...written} />}
    {lines && <div className="space-y-2">
      {lines.map((line, i) => <div key={i}>
        <label htmlFor={`${id}-line-${i}`} className="block text-xs text-gray-400">Face {i + 1}</label>
        <textarea id={`${id}-line-${i}`} value={line} maxLength={1000} rows={2} disabled={disabled}
          onChange={(e) => setLines((prev) => prev.map((l, j) => (j === i ? e.target.value : l)))}
          className="w-full rounded border border-port-border bg-port-bg p-2 text-sm" />
      </div>)}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={render} disabled={disabled || !preview.preview || lines.some((l) => !l.trim())} className={buttonClass}>Render {lines.length} faces</button>
        <button type="button" onClick={() => { setLines(null); setWritten(null); }} disabled={disabled} className="min-h-11 px-3 text-sm text-gray-400">Discard</button>
      </div>
    </div>}
    {(idea.trim() || lines) && <ModelInputPreview preview={preview} prompt={idea} />}
    {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
  </div>;
}

const ACTIONS = [['refine', 'Refine'], ['feature', 'Vary a feature'], ['blend', 'Blend toward'], ['age', 'Carry to an age']];
const BLEND_STRENGTHS = [25, 50, 75];

function PickedActions({ ingredientId, take, isCanon, forms, images, disabled, onRender, onAnchor, onClose }) {
  const id = useId();
  const [action, setAction] = useState(isCanon ? 'blend' : 'refine');
  const [note, setNote] = useState('');
  const [count, setCount] = useState(4);
  const [feature, setFeature] = useState('noseSize');
  const [blendFiles, setBlendFiles] = useState([]);
  const [blendFeatures, setBlendFeatures] = useState([]);
  const [strength, setStrength] = useState('');
  const [strengthCount, setStrengthCount] = useState(2);
  const [extraPicks, setExtraPicks] = useState([]);
  const [pickingGallery, setPickingGallery] = useState(false);
  const [boards, setBoards] = useState(null);
  const [boardError, setBoardError] = useState('');
  const [castError, setCastError] = useState('');
  const [boardId, setBoardId] = useState('');
  const [ageFormId, setAgeFormId] = useState(forms[0]?.id || '');
  const [otherCast, setOtherCast] = useState(null);
  const [pickingCast, setPickingCast] = useState(false);
  const base = { baseImageFile: take.mediaKey, ...(note.trim() ? { note: note.trim() } : {}) };
  const body = action === 'refine' ? { mode: 'refine', ...base, count, ...(formKey(take) ? { formId: formKey(take) } : {}) }
    : action === 'feature' ? { mode: 'feature', ...base, feature, ...(formKey(take) ? { formId: formKey(take) } : {}) }
    : action === 'blend' ? { mode: 'blend', ...base, blendImageFiles: blendFiles, features: blendFeatures,
      ...(strength ? { strength: Number(strength), count: strengthCount } : {}), ...(formKey(take) ? { formId: formKey(take) } : {}) }
    : { mode: 'age', ...base, count, formId: ageFormId };
  const ready = action === 'refine' ? !!note.trim() : action === 'blend' ? blendFiles.length > 0 : action === 'age' ? !!ageFormId : true;
  const fetchPreview = useCallback((input, options) => renderCatalogDesign(ingredientId, input, { ...options, preview: true }), [ingredientId]);
  const preview = useModelInputPreview(fetchPreview, body, { enabled: ready });
  const lines = action === 'feature' ? featureLines(feature) : action === 'blend'
    ? blendLines(blendFeatures, { refCount: Math.max(blendFiles.length, 1), strength: strength ? Number(strength) : undefined, count: strengthCount }) : [];
  const toggleBlend = (key) => setBlendFiles((prev) => (prev.includes(key) ? prev.filter((k) => k !== key)
    : prev.length < DESIGN_MAX_BLEND_REFS ? [...prev, key] : prev));
  // A face from the gallery or a mood board joins the choices already picked.
  const addPick = (filename) => {
    if (!filename) return;
    setExtraPicks((prev) => (prev.some((m) => m.mediaKey === filename) ? prev : [{ mediaKey: filename }, ...prev]));
    setBlendFiles((prev) => (prev.includes(filename) || prev.length >= DESIGN_MAX_BLEND_REFS ? prev : [...prev, filename]));
  };
  const loadBoards = async () => {
    setBoardError('');
    const rows = await listMoodBoardNames({ silent: true }).catch((err) => { setBoardError(err.message || 'Could not load mood boards'); return null; });
    if (rows) setBoards(Array.isArray(rows) ? rows : []);
  };
  const loadCast = async (ingredient) => {
    setPickingCast(false);
    setCastError('');
    // A failed read is not a cast member with no images: say so and keep the current choices.
    const details = await getCatalogIngredientDetails(ingredient.id, { view: 'media', silent: true })
      .catch((err) => { setCastError(err.message || `Could not load ${ingredient.name}'s images`); return null; });
    if (!details) return;
    setOtherCast({ name: ingredient.name, images: (details.media || []).filter((m) => IMAGE_KINDS.has(m.kind) && !m.deleted) });
  };
  const blendChoices = [...extraPicks, ...images.filter((m) => m.mediaKey !== take.mediaKey), ...(otherCast?.images || [])]
    .filter((m, i, all) => all.findIndex((x) => x.mediaKey === m.mediaKey) === i);
  return <div className="rounded border border-port-accent/50 p-3 space-y-3">
    <div className="flex items-start gap-3">
      <MediaImage thumbnail src={`/data/images/${encodeURIComponent(take.mediaKey)}`} alt="Picked take" className="h-20 w-20 shrink-0 rounded object-cover" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-semibold">{isCanon ? 'Current canon' : 'Picked take'}</p>
        <div className="flex flex-wrap gap-2">
          {!isCanon && <button type="button" onClick={onAnchor} disabled={disabled} className="min-h-11 inline-flex items-center gap-1 rounded bg-port-accent px-3 text-sm text-white disabled:opacity-40">
            <Anchor size={14} aria-hidden="true" /> {formKey(take) ? 'Make anchor for this age' : 'Make canon'}</button>}
          <button type="button" onClick={onClose} className="min-h-11 px-3 text-sm text-gray-400">Unpick</button>
        </div>
      </div>
    </div>
    <TabPills variant="pills" size="sm" ariaLabel="Next round from this take" activeTab={action} onChange={setAction}
      tabs={ACTIONS.filter(([key]) => key !== 'age' || forms.length).map(([key, label]) => ({ id: key, label }))} />
    {action === 'feature' && <label htmlFor={`${id}-feature`} className="block space-y-1 text-xs"><span>Feature</span>
      <select id={`${id}-feature`} value={feature} disabled={disabled} onChange={(e) => setFeature(e.target.value)} className={fieldClass}>
        {Object.entries(DESIGN_FEATURES).map(([key, f]) => <option key={key} value={key}>{f.label}</option>)}
      </select>
    </label>}
    {action === 'blend' && <div className="space-y-2">
      <p className="text-xs text-gray-400">Faces to blend toward (up to {DESIGN_MAX_BLEND_REFS}){blendFiles.length ? `: ${blendFiles.length} picked` : ''}</p>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {blendChoices.map((m) => <button key={m.mediaKey} type="button" aria-label="Blend face option" aria-pressed={blendFiles.includes(m.mediaKey)} onClick={() => toggleBlend(m.mediaKey)}
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 rounded border-2 border-transparent aria-pressed:border-port-accent">
          <MediaImage thumbnail src={`/data/images/${encodeURIComponent(m.mediaKey)}`} alt="Blend face option" loading="lazy" className="h-16 w-16 rounded object-cover" />
        </button>)}
      </div>
      <div className="flex flex-wrap gap-x-4">
        <button type="button" onClick={() => setPickingCast(true)} className="min-h-11 text-sm text-port-accent underline">
          {otherCast ? `Showing ${otherCast.name}'s images. Pick another cast member` : 'Use another cast member’s image'}</button>
        <button type="button" onClick={() => setPickingGallery(true)} className="min-h-11 text-sm text-port-accent underline">Pick from gallery</button>
        {!boards && <button type="button" onClick={loadBoards} className="min-h-11 text-sm text-port-accent underline">Pick from mood board</button>}
      </div>
      {castError && <p role="alert" className="text-xs text-port-error">{castError}</p>}
      {boardError && <p role="alert" className="text-xs text-port-error">{boardError}</p>}
      {boards && (boards.length ? <label htmlFor={`${id}-board`} className="block space-y-1 text-xs"><span>Mood board</span>
        <select id={`${id}-board`} value={boardId} onChange={(e) => setBoardId(e.target.value)} className={fieldClass}>
          <option value="">Choose a mood board</option>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label> : <p className="text-xs text-gray-400">No mood boards yet.</p>)}
      <div className="grid grid-cols-2 gap-2">
        <label htmlFor={`${id}-strength`} className="min-w-0 space-y-1 text-xs"><span>How far toward them</span>
          <select id={`${id}-strength`} value={strength} disabled={disabled} onChange={(e) => setStrength(e.target.value)} className={fieldClass}>
            <option value="">4 takes, a fifth to four fifths</option>
            {BLEND_STRENGTHS.map((n) => <option key={n} value={n}>{n}%</option>)}
          </select>
        </label>
        {strength && <label htmlFor={`${id}-strength-count`} className="min-w-0 space-y-1 text-xs"><span>Takes</span>
          <select id={`${id}-strength-count`} value={strengthCount} disabled={disabled} onChange={(e) => setStrengthCount(Number(e.target.value))} className={fieldClass}>
            {Array.from({ length: BLEND_MAX_STRENGTH_TAKES }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>}
      </div>
      <fieldset className="space-y-1"><legend className="text-xs text-gray-400">Only these features (none = the whole face)</legend>
        <div className="flex flex-wrap gap-2">
          {Object.entries(DESIGN_FEATURES).filter(([key]) => !['noseShape', 'eyeShape'].includes(key)).map(([key, f]) => <label key={key} htmlFor={`${id}-bf-${key}`} className="min-h-11 inline-flex items-center gap-1 text-xs">
            <input id={`${id}-bf-${key}`} type="checkbox" checked={blendFeatures.includes(key)}
              onChange={(e) => setBlendFeatures((prev) => (e.target.checked ? [...prev, key] : prev.filter((k) => k !== key)))} /> {f.label}
          </label>)}
        </div>
      </fieldset>
      <IngredientPicker open={pickingCast} onClose={() => setPickingCast(false)} onSelect={loadCast} type="character" />
      <GalleryImagePicker open={pickingGallery} allowUpload onClose={() => setPickingGallery(false)} onSelect={(item) => addPick(item?.filename)} />
      <MoodBoardPinPicker open={!!boardId} moodBoardId={boardId} onClose={() => setBoardId('')} onSelect={(pin) => addPick(pin.filename)} />
    </div>}
    {action === 'age' && <AgeSelect id={`${id}-age`} forms={forms} value={ageFormId} onChange={setAgeFormId} disabled={disabled} label="Age to carry to" includeCanonical={false} />}
    {(action === 'refine' || action === 'age') && <label htmlFor={`${id}-count`} className="block space-y-1 text-xs"><span>Takes</span>
      <select id={`${id}-count`} value={count} disabled={disabled} onChange={(e) => setCount(Number(e.target.value))} className={fieldClass}>
        {Array.from({ length: DESIGN_MAX_TAKES }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>}
    <label htmlFor={`${id}-note`} className="block text-xs">{action === 'refine' ? 'What to change' : 'Note (optional)'}</label>
    <textarea id={`${id}-note`} value={note} maxLength={2000} rows={2} disabled={disabled} onChange={(e) => setNote(e.target.value)}
      placeholder={action === 'refine' ? 'Less hooded eyes, keep the nose' : action === 'blend' ? 'Keep the hair, change the face structure' : ''} className="w-full rounded border border-port-border bg-port-bg p-2 text-sm" />
    {lines.length > 0 && <p className="text-xs text-gray-400">{lines.length} {lines.length === 1 ? 'take' : 'takes'}: {new Set(lines).size === 1 ? lines[0] : `${lines[0]} … ${lines[lines.length - 1]}`}</p>}
    <button type="button" onClick={async () => { if (await onRender(body)) setNote(''); }} disabled={disabled || !ready || !preview.preview}
      className={buttonClass}>Render {lines.length || count} takes</button>
    {ready && <ModelInputPreview preview={preview} prompt={note} />}
  </div>;
}
