import { useId, useMemo, useState } from 'react';
import { useCatalogPreviewSequence } from './CatalogImagePreviewProvider';
import { Compass, Loader2, Star, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import CatalogMediaTile from './CatalogMediaTile';
import CatalogReferenceReview from './CatalogReferenceReview';
import MediaJobThumb from '../pipeline/MediaJobThumb';
import { REFERENCE_REVIEW_WRITE_STATUSES, isLeftOutOfLikeness, referenceReviewStatus, rejectedReferenceKeys } from '../../../../server/lib/catalogMediaLibrary.js';
import { formatCount } from '../../utils/formatters';
import { updateCatalogIngredientMediaLibrary, attachCatalogIngredientMediaFromMoodBoard } from '../../services/apiCatalog';

export const MAX_CAST_GUIDES = 4;
const RATINGS = [
  { status: 'good', label: 'Good', Icon: ThumbsUp, on: 'border-port-success bg-port-success/20 text-port-success', hover: 'hover:border-port-success hover:text-port-success' },
  { status: 'bad', label: 'Bad', Icon: ThumbsDown, on: 'border-port-error bg-port-error/20 text-port-error', hover: 'hover:border-port-error hover:text-port-error' },
];
// Clicking the active rating clears it back to unreviewed. A wrong reference
// is removed from the record rather than rated "rejected" (that state is for
// music video takes); a legacy 'rejected' reads as bad.
const rateReview = (m, status, next = referenceReviewStatus(m) === status ? 'unreviewed' : status) => {
  const review = m.library?.review || {};
  return { review: { status: next, ...(review.feedback ? { feedback: review.feedback } : {}) } };
};
// A visual attached as both primary and reference gets one control set, on
// its lead attachment: the one already guiding, else the reference (it holds
// the variant metadata), else the portrait.
const leadAttachment = (attachments) => attachments.find((m) => m.library?.guide === true)
  || attachments.find((m) => m.kind !== 'portrait') || attachments[0];

function RatingButtons({ media, busy, onRate, className = 'grid grid-cols-2 gap-1.5' }) {
  const current = referenceReviewStatus(media);
  return (
    <div role="group" aria-label={`Rating for ${media.mediaKey}`} className={className}>
      {RATINGS.map(({ status, label, Icon, on, hover }) => (
        <button key={status} type="button" disabled={busy} aria-pressed={current === status}
          title={current === status ? `Marked ${status} (click to clear)` : `Mark reference as ${status}`}
          onClick={() => onRate(status)}
          className={`flex min-h-11 items-center justify-center gap-1.5 rounded border px-2 text-xs font-medium transition-colors disabled:opacity-40 ${current === status ? on : `border-port-border text-gray-300 ${hover}`}`}>
          <Icon size={13} aria-hidden="true" /> {label}
        </button>
      ))}
    </div>
  );
}

// The reference's own controls inside the standard media viewer (its rating
// takes the viewer's good/bad slot): make it a render guide, make it the
// primary image, or remove it from this record (the image itself stays in
// Media History).
function PreviewActions({ media: m, isPortrait, busy, isGuide, guideFull, guideBlocked, onGuide, onSetPortrait, onDetach }) {
  const [arming, setArming] = useState(false);
  const btn = 'flex min-h-11 items-center justify-center gap-1.5 rounded border px-2 text-xs disabled:opacity-40';
  return (
    <div>
      <div className="grid grid-cols-3 gap-1.5">
        <button type="button" disabled={busy || guideBlocked || (!isGuide && guideFull)} aria-pressed={isGuide} onClick={onGuide}
          title={!isGuide && guideFull ? `At most ${MAX_CAST_GUIDES} render guides` : 'Use as a render guide'}
          className={`${btn} ${isGuide ? 'border-port-accent bg-port-accent/10 text-port-accent' : 'border-port-border text-gray-300 hover:border-port-accent'}`}>
          <Compass size={13} aria-hidden="true" /> {isGuide ? 'Guide' : 'Make guide'}
        </button>
        {isPortrait
          ? <span className={`${btn} border-port-warning/40 text-port-warning`}><Star size={13} aria-hidden="true" /> Primary</span>
          : <button type="button" disabled={busy || !onSetPortrait} onClick={() => onSetPortrait(m.mediaKey)} title="Make this the record's primary image"
            className={`${btn} border-port-border text-gray-300 hover:border-port-warning hover:text-port-warning`}>
            <Star size={13} aria-hidden="true" /> Set primary
          </button>}
        <button type="button" disabled={busy || !onDetach} onClick={() => { if (arming) { setArming(false); onDetach(); } else setArming(true); }}
          onBlur={() => setArming(false)} title="Remove from this record; the image stays in Media History"
          className={`${btn} ${arming ? 'border-port-error bg-port-error/20 text-port-error' : 'border-port-border text-gray-300 hover:border-port-error hover:text-port-error'}`}>
          <Trash2 size={13} aria-hidden="true" /> {arming ? 'Tap to remove' : 'Remove'}
        </button>
      </div>
    </div>
  );
}

const ERAS = ['child', 'teen', 'adult', 'elder'];
const LIBRARY_KINDS = new Set(['portrait', 'reference', 'video']);
const eraFor = (m) => m.library?.variant?.era
  || (Number.isInteger(m.library?.variant?.age) ? (m.library.variant.age < 13 ? 'child' : m.library.variant.age < 20 ? 'teen' : m.library.variant.age < 65 ? 'adult' : 'elder') : '');

export default function CatalogReferenceLibrary({
  ingredientId,
  media = [],
  forms = [],
  readOnly = false,
  onChanged,
  onMediaUpdated,
  referenceMedia = media,
  missingMedia = new Set(),
  onSetPortrait,
  onDetach,
  revision,
  blockedReason,
  pendingRenders = [],
  onPendingRenderComplete,
  onPendingRenderFailed,
}) {
  const id = useId();
  const [armedDetach, setArmedDetach] = useState(null);
  const [filter, setFilter] = useState({ form: '', age: '', era: '', tag: '', review: 'active', guides: false, allMedia: false });
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [boardId, setBoardId] = useState('');
  const [itemIds, setItemIds] = useState('');
  const previewRevision = useMemo(() => JSON.stringify({ revision, forms,
    media: media.map(m => [m.ingredientId, m.kind, m.mediaKey, m.deleted, m.updatedAt, m.library]) }), [revision, forms, media]);

  const rows = useMemo(() => media.filter((m) => !m.deleted && LIBRARY_KINDS.has(m.kind)), [media]);
  // Sheets and looks in other tabs still consume the character-wide guide limit.
  const rejected = rejectedReferenceKeys(media);
  const guideCount = media.filter((m) => !m.deleted && !rejected.has(m.mediaKey) && LIBRARY_KINDS.has(m.kind) && m.library?.guide === true).length;
  const ages = [...new Set(rows.map((m) => m.library?.variant?.age).filter(Number.isInteger))].sort((a, b) => a - b);
  const tags = [...new Set(rows.flatMap((m) => m.library?.tags || []))].sort();
  const formKey = (m) => m.library?.variant?.formId || 'canonical';
  const referenceKeys = new Set(referenceMedia.map((m) => `${m.kind}:${m.mediaKey}`));
  const visible = rows.filter((m) => (filter.allMedia || referenceKeys.has(`${m.kind}:${m.mediaKey}`))
    && (!filter.form || formKey(m) === filter.form)
    && (filter.age === '' || m.library?.variant?.age === Number(filter.age))
    && (!filter.era || eraFor(m) === filter.era)
    && (!filter.tag || (m.library?.tags || []).includes(filter.tag))
    && (!filter.review || (filter.review === 'active' ? referenceReviewStatus(m) !== 'bad' : referenceReviewStatus(m) === filter.review))
    && (!filter.guides || (m.library?.guide === true && !rejected.has(m.mediaKey))));

  const activePendingRenders = useMemo(() => {
    const existingKeys = new Set(media.map((m) => m.mediaKey));
    return (pendingRenders || []).filter(
      (p) => !existingKeys.has(`${p.jobId}.png`) && (!p.filename || !existingKeys.has(p.filename))
    );
  }, [pendingRenders, media]);
  const showPending = !filter.guides && (!filter.review || filter.review === 'active' || filter.review === 'unreviewed');
  const visiblePending = showPending ? activePendingRenders : [];

  // One visual can have both portrait and reference attachments with independent metadata.
  const groups = new Map();
  for (const m of visible) {
    const key = `${m.kind === 'video' ? 'video' : 'image'}:${m.mediaKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  // Enlarged previews step through the filtered images and rate in place.
  const tilesByKey = new Map();
  for (const [groupKey, attachments] of groups) {
    if (groupKey.startsWith('image:')) tilesByKey.set(attachments[0].mediaKey, leadAttachment(attachments));
  }
  const sequenceKeys = [...tilesByKey.keys()];
  const sequence = useMemo(() => ({
    keys: sequenceKeys,
    ingredientId,
    render: (key, { nextKey, prevKey, goTo }) => {
      const m = tilesByKey.get(key);
      if (!m || readOnly || m.readOnly) return null;
      const isGuide = m.library?.guide === true && !rejected.has(m.mediaKey);
      // The rated or removed image may leave the filtered list, so step on to a neighbor.
      const attachments = groups.get(`image:${key}`) || [m];
      return <PreviewActions key={key} media={m} isPortrait={attachments.some((a) => a.kind === 'portrait')} busy={!!busyKey} isGuide={isGuide} guideFull={guideCount >= MAX_CAST_GUIDES} guideBlocked={rejected.has(m.mediaKey)}
        onGuide={() => toggleGuide(attachments, m, isGuide)}
        onSetPortrait={onSetPortrait}
        onDetach={onDetach ? async () => {
          goTo(nextKey ?? prevKey);
          // A visual attached as both primary and reference leaves the record entirely.
          for (const a of attachments) await onDetach(a.mediaKey, a.kind);
        } : undefined} />;
    },
    rating: (key, { nextKey, prevKey, goTo }) => {
      const m = tilesByKey.get(key);
      if (!m || readOnly || m.readOnly) return null;
      const status = referenceReviewStatus(m);
      return {
        value: ['good', 'bad'].includes(status) ? status : null,
        busy: !!busyKey,
        title: { good: 'Good reference', bad: 'Bad: kept out of render guides' },
        // A rating can drop the image from the filtered list, so step on to a neighbor.
        onRate: async (next) => {
          if (await rateAll(groups.get(`image:${key}`) || [m], m, next || status || 'unreviewed')) goTo(nextKey ?? prevKey);
        },
      };
    },
  // Dependency list is intentionally partial.
  }), [sequenceKeys.join('|'), media, busyKey, readOnly, onSetPortrait, onDetach]);
  useCatalogPreviewSequence(sequence);

  const save = async (m, patch) => {
    setError('');
    setBusyKey(`${m.kind}:${m.mediaKey}`);
    try {
      const updated = await updateCatalogIngredientMediaLibrary(ingredientId, { mediaKey: m.mediaKey, kind: m.kind, ...patch }, { silent: true });
      if (onMediaUpdated) onMediaUpdated(updated);
      else onChanged?.();
      return updated;
    } catch (err) {
      setError(err?.message || 'Could not update reference');
    } finally {
      setBusyKey('');
    }
  };

  // One rating covers every attachment of the visual so they never disagree.
  const rateAll = async (attachments, lead, status) => {
    const next = referenceReviewStatus(lead) === status ? 'unreviewed' : status;
    let updated;
    for (const a of attachments) if (!(updated = await save(a, rateReview(a, status, next)))) return undefined;
    return updated;
  };
  // The guide lives on the lead only (each guided row takes a guide slot);
  // turning it off clears any other attachment still guiding.
  const toggleGuide = async (attachments, lead, isGuide) => {
    if (!isGuide) return save(lead, { guide: true });
    let updated;
    for (const a of attachments.filter((x) => x.library?.guide === true)) if (!(updated = await save(a, { guide: false }))) return undefined;
    return updated;
  };

  // The server applies likeness to every attachment of the file, so reload.
  const toggleLikeness = async (lead, leftOut) => {
    if (await save(lead, { likeness: leftOut })) onChanged?.();
  };

  const importBoard = async () => {
    const ids = itemIds.split(/[\s,]+/).filter(Boolean);
    if (!boardId.trim() || ids.length === 0) return;
    setError('');
    try {
      await attachCatalogIngredientMediaFromMoodBoard(ingredientId, { boardId: boardId.trim(), itemIds: ids, inferAge: true }, { silent: true });
      setItemIds('');
      onChanged?.();
    } catch (err) {
      setError(err?.message || 'Could not import from mood board');
    }
  };

  const fieldClass = 'min-h-11 min-w-0 w-full rounded border border-port-border bg-port-bg px-2 text-sm';

  return (
    <section aria-label="Reference library" className="min-w-0 space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <h3 className="font-semibold">Reference library</h3>
        <span data-testid="guide-count" className="text-gray-400">{formatCount(guideCount)}/{MAX_CAST_GUIDES} render guides (all media)</span>
      </header>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] items-end gap-2 text-xs">
        {referenceMedia !== media && (
          <label htmlFor={`${id}-scope`} className="min-w-0 space-y-1"><span>Media scope</span>
            <select id={`${id}-scope`} value={filter.allMedia ? 'all' : 'references'} onChange={(e) => setFilter({ ...filter, allMedia: e.target.value === 'all' })} className={fieldClass}>
              <option value="references">References</option>
              <option value="all">All character media</option>
            </select>
          </label>
        )}
        {forms.length > 0 && (
          <label htmlFor={`${id}-form`} className="min-w-0 space-y-1"><span>Age or look</span>
            <select id={`${id}-form`} aria-label="Filter by age or look" value={filter.form} onChange={(e) => setFilter({ ...filter, form: e.target.value })} className={fieldClass}>
              <option value="">All</option>
              <option value="canonical">Canonical</option>
              {forms.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
        )}
        <label htmlFor={`${id}-age`} className="min-w-0 space-y-1"><span>Age</span>
          <select id={`${id}-age`} aria-label="Filter by age" value={filter.age} onChange={(e) => setFilter({ ...filter, age: e.target.value })} className={fieldClass}>
            <option value="">All</option>
            {ages.map((age) => <option key={age} value={age}>{age}</option>)}
          </select>
        </label>
        <label htmlFor={`${id}-era`} className="min-w-0 space-y-1"><span>Era</span>
          <select id={`${id}-era`} aria-label="Filter by era" value={filter.era} onChange={(e) => setFilter({ ...filter, era: e.target.value })} className={fieldClass}>
            <option value="">All</option>
            {ERAS.map((era) => <option key={era} value={era}>{era}</option>)}
          </select>
        </label>
        {tags.length > 0 && (
          <label htmlFor={`${id}-tag`} className="min-w-0 space-y-1"><span>Tag</span>
            <select id={`${id}-tag`} aria-label="Filter by tag" value={filter.tag} onChange={(e) => setFilter({ ...filter, tag: e.target.value })} className={fieldClass}>
              <option value="">All</option>
              {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </select>
          </label>
        )}
        <label htmlFor={`${id}-guides`} className="flex min-h-11 items-center gap-2">
          <input id={`${id}-guides`} type="checkbox" checked={filter.guides} onChange={(e) => setFilter({ ...filter, guides: e.target.checked })} /> Guides only
        </label>
        <label htmlFor={`${id}-review`} className="min-w-0 space-y-1"><span>Rating</span>
          <select id={`${id}-review`} value={filter.review} onChange={event => setFilter({ ...filter, review: event.target.value })} className={fieldClass}>
            <option value="active">Good &amp; unreviewed</option>
            <option value="">All ratings</option>
            {REFERENCE_REVIEW_WRITE_STATUSES.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
      {visible.length === 0 && visiblePending.length === 0 ? <p className="text-sm text-gray-400">{rows.length ? 'No references match. Change the filters to see more.' : 'No references yet. Add an image or video to start your library.'}</p> : (
        <ul className="grid items-start grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-3">
          {visiblePending.map((pending) => (
            <li
              key={pending.jobId}
              data-testid="library-row-pending"
              className="min-w-0 rounded-lg border border-port-accent/40 bg-port-bg shadow-sm overflow-hidden flex flex-col"
            >
              <div className="relative aspect-square w-full bg-port-card/40 flex items-center justify-center overflow-hidden">
                <MediaJobThumb
                  jobId={pending.jobId}
                  label={pending.instruction ? `Edit: ${pending.instruction}` : 'Refined reference'}
                  size="fill"
                  onFilename={(filename) => {
                    onPendingRenderComplete?.(pending.jobId, filename);
                  }}
                  onStatus={(status, err) => {
                    if (status === 'failed' || status === 'canceled') {
                      onPendingRenderFailed?.(pending.jobId, status, err);
                    }
                  }}
                />
              </div>
              <div role="group" aria-label={`Pending reference ${pending.jobId}`} className="min-w-0 space-y-2 border-t border-port-border p-3 flex-1 flex flex-col justify-between">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-start gap-2">
                    <h4 className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">
                      {pending.instruction ? `Edit: ${pending.instruction}` : 'Edited reference'}
                    </h4>
                    <span className="shrink-0 text-[10px] uppercase font-semibold text-port-accent bg-port-accent/10 px-1.5 py-0.5 rounded animate-pulse">
                      Rendering
                    </span>
                  </div>
                  {pending.sourceFilename && (
                    <p className="mt-1 text-xs text-gray-400 truncate" title={`From ${pending.sourceFilename}`}>
                      From {pending.sourceFilename}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <Loader2 size={12} className="animate-spin text-port-accent" />
                  <span>Live updating…</span>
                </div>
              </div>
            </li>
          ))}
          {[...groups].map(([groupKey, attachments]) => {
            const tile = attachments.find((m) => m.kind === 'portrait') || attachments[0];
            const tileEditable = !readOnly && !tile.readOnly;
            const m = leadAttachment(attachments);
            const key = `${m.ingredientId || ingredientId}:${m.kind}:${m.mediaKey}`;
            const lib = m.library || {};
            const isGuide = lib.guide === true && !rejected.has(m.mediaKey);
            const leftOut = attachments.some(isLeftOutOfLikeness);
            const editable = !readOnly && !m.readOnly;
            const title = lib.variant?.label || attachments.find((a) => a.library?.variant?.label)?.library.variant.label || m.caption || m.mediaKey;
            const summary = [forms.find((f) => f.id === lib.variant?.formId)?.label || 'Canonical',
              Number.isInteger(lib.variant?.age) ? `Age ${lib.variant.age}` : '', eraFor(m), ...(lib.tags || [])].filter(Boolean).join(' · ');
            const currentStatus = referenceReviewStatus(m);
            return (
              <li key={groupKey} data-testid="library-row" className="min-w-0 rounded-lg border border-port-border bg-port-bg">
                <CatalogMediaTile m={tile} missing={missingMedia.has(tile.mediaKey)} contain
                  isPortrait={tile.kind === 'portrait'} onSetPortrait={tileEditable ? onSetPortrait : undefined}
                  onDetach={tileEditable ? onDetach : undefined} armedDetach={armedDetach} onArmDetach={setArmedDetach} />
                <div role="group" aria-label={`Details for ${m.mediaKey}`} className="min-w-0 space-y-2 border-t border-port-border p-3">
                  <div className="flex min-w-0 items-start gap-2">
                    {tile.kind === 'portrait' && <Star size={14} aria-label="Primary" className="mt-0.5 shrink-0 text-port-warning" />}
                    <h4 className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">{title}</h4>
                    <span className="shrink-0 text-xs text-gray-500">{attachments.map((a) => a.kind).join(' · ')}</span>
                  </div>
                  <p className="text-xs text-gray-400 [overflow-wrap:anywhere]">{summary}</p>
                  {m.kind !== 'video' && (editable ? (
                    <RatingButtons media={m} busy={!!busyKey} onRate={(status) => rateAll(attachments, m, status)} />
                  ) : currentStatus !== 'unreviewed' && (
                    <p className={`text-xs font-medium capitalize ${currentStatus === 'good' ? 'text-port-success' : 'text-port-error'}`}>Rating: {currentStatus}</p>
                  ))}
                  {m.kind !== 'video' && (editable ? (
                    <button type="button" disabled={!!busyKey || rejected.has(m.mediaKey) || (!isGuide && guideCount >= MAX_CAST_GUIDES)} aria-pressed={isGuide}
                      title={rejected.has(m.mediaKey) ? (leftOut ? 'Left out of likeness, so it cannot guide renders' : 'Rated bad, so it cannot guide renders')
                        : !isGuide && guideCount >= MAX_CAST_GUIDES ? `At most ${MAX_CAST_GUIDES} render guides` : 'Use as a render guide'}
                      onClick={() => toggleGuide(attachments, m, isGuide)}
                      className={`flex min-h-11 w-full items-center justify-center gap-2 rounded border px-3 text-sm disabled:opacity-40 ${isGuide ? 'border-port-accent bg-port-accent/10 text-port-accent' : 'border-port-border text-gray-300 hover:border-port-accent'}`}>
                      <Compass size={16} aria-hidden="true" /> {busyKey.endsWith(`:${m.mediaKey}`) ? 'Saving…' : isGuide ? 'Guide' : 'Make guide'}
                    </button>
                  ) : isGuide && <p className="text-xs text-port-accent">Render guide</p>)}
                  {m.kind !== 'video' && (editable ? (
                    <button type="button" disabled={!!busyKey} aria-pressed={!leftOut}
                      title="Leave a collage or mood board out of the images that guide likeness"
                      onClick={() => toggleLikeness(m, leftOut)}
                      className={`flex min-h-11 w-full items-center justify-center rounded border border-port-border px-3 text-sm hover:border-port-accent disabled:opacity-40 ${leftOut ? 'text-gray-400' : 'text-gray-300'}`}>
                      {leftOut ? 'Left out of likeness' : 'Used for likeness'}
                    </button>
                  ) : leftOut && <p className="text-xs text-gray-500">Left out of likeness</p>)}
                  {m.kind !== 'video' && <CatalogReferenceReview
                    ingredientId={ingredientId} media={m} readOnly={!editable} saving={!!busyKey}
                    onSave={patch => save(m, patch)} onChanged={onChanged} revision={previewRevision} blockedReason={blockedReason} />}
                  {editable && (
                    <details>
                      <summary className="flex min-h-11 cursor-pointer items-center text-xs text-port-accent">Edit reference details</summary>
                      <fieldset disabled={!!busyKey} className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,7rem),1fr))] gap-2 text-xs disabled:opacity-50">
                        <label htmlFor={`${id}-${key}-title`} className="col-span-full min-w-0 space-y-1"><span>Title</span>
                          <input key={lib.variant?.label ?? ''} id={`${id}-${key}-title`} aria-label={`Title for ${m.mediaKey}`} maxLength={120} defaultValue={lib.variant?.label ?? ''}
                            placeholder={m.caption || m.mediaKey} className={fieldClass}
                            onBlur={(e) => {
                              const label = e.target.value.trim() || undefined;
                              if (label !== lib.variant?.label) save(m, { variant: { ...(lib.variant || {}), label } });
                            }} />
                        </label>
                        {forms.length > 0 && (
                          <label htmlFor={`${id}-${key}-form`} className="min-w-0 space-y-1"><span>Age or look</span>
                            <select id={`${id}-${key}-form`} aria-label={`Age or look for ${m.mediaKey}`} value={lib.variant?.formId || ''} className={fieldClass}
                              onChange={(e) => {
                                const form = forms.find(f => f.id === e.target.value);
                                const age = /^\d+$/.test(String(form?.age).trim()) ? Number(form.age) : undefined;
                                save(m, { variant: { ...(lib.variant || {}), formId: e.target.value || undefined,
                                  ...(age !== undefined ? { age, era: undefined } : {}) } });
                              }}>
                              <option value="">Canonical</option>
                              {forms.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                            </select>
                          </label>
                        )}
                        <label htmlFor={`${id}-${key}-age`} className="min-w-0 space-y-1"><span>Age</span>
                          <input key={lib.variant?.age ?? ''} id={`${id}-${key}-age`} aria-label={`Age for ${m.mediaKey}`} type="number" min="0" max="150" defaultValue={lib.variant?.age ?? ''} className={fieldClass}
                            onBlur={(e) => {
                              if (!e.target.validity.valid) return;
                              const age = e.target.value === '' ? undefined : Number(e.target.value);
                              if (age !== lib.variant?.age) save(m, { variant: { ...(lib.variant || {}), age } });
                            }} />
                        </label>
                        <label htmlFor={`${id}-${key}-era`} className="min-w-0 space-y-1"><span>Era</span>
                          <select id={`${id}-${key}-era`} aria-label={`Era for ${m.mediaKey}`} value={lib.variant?.era || ''} className={fieldClass}
                            onChange={(e) => save(m, { variant: { ...(lib.variant || {}), era: e.target.value || undefined } })}>
                            <option value="">From age</option>
                            {ERAS.map((era) => <option key={era} value={era}>{era}</option>)}
                          </select>
                        </label>
                        <label htmlFor={`${id}-${key}-tags`} className="col-span-full min-w-0 space-y-1"><span>Tags (comma separated)</span>
                          <input key={(lib.tags || []).join(',')} id={`${id}-${key}-tags`} aria-label={`Tags for ${m.mediaKey}`} defaultValue={(lib.tags || []).join(', ')} placeholder="e.g. studio, winter" className={fieldClass}
                            onBlur={(e) => {
                              const next = e.target.value.split(',').map((tag) => tag.trim()).filter(Boolean);
                              if (next.join(',') !== (lib.tags || []).join(',')) save(m, { tags: next });
                            }} />
                        </label>
                      </fieldset>
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!readOnly && (
        <details className="rounded border border-port-border p-3 text-xs">
          <summary className="min-h-11 cursor-pointer content-center text-gray-400">Add from mood board</summary>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] items-end gap-2">
            <label htmlFor={`${id}-board`} className="min-w-0 space-y-1"><span>Mood board id</span>
              <input id={`${id}-board`} value={boardId} onChange={(e) => setBoardId(e.target.value)} className={fieldClass} />
            </label>
            <label htmlFor={`${id}-items`} className="min-w-0 space-y-1"><span>Mood board item ids</span>
              <input id={`${id}-items`} value={itemIds} onChange={(e) => setItemIds(e.target.value)} placeholder="Comma separated" className={fieldClass} />
            </label>
            <button type="button" onClick={importBoard} className="min-h-11 rounded border border-port-border px-3 text-port-accent">Add from mood board</button>
          </div>
        </details>
      )}
    </section>
  );
}
