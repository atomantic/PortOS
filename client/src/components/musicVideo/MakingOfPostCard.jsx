import { useId, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Check, Copy, Download, ExternalLink, Film, Image as ImageIcon,
  Link as LinkIcon, LogIn, Pencil, Send, Sparkles, Trash2, Undo2, X,
} from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import Pill from '../ui/Pill.jsx';
import toast from '../ui/Toast.jsx';
import { copyToClipboard } from '../../lib/clipboard.js';
import { formatCount, formatDateTime } from '../../utils/formatters.js';
import { videoPosterForJob } from '../../lib/creativeDirectorPreview.js';
import {
  MAKING_OF_ITEM_ROLE_LABELS,
  MAKING_OF_POST_PLATFORMS,
  MAKING_OF_POST_PLATFORM_LABELS,
  MAKING_OF_POST_STATUSES,
  MAKING_OF_POST_STATUS_LABELS,
  MAKING_OF_STORY_LIMITS,
  MAKING_OF_X_MAX_MEDIA_PER_POST,
  autoDistributeMakingOfPartItems,
  formatMakingOfPostCopy,
  isMakingOfMediaItem,
  normalizeMakingOfTags,
  resolveMakingOfPostParts,
} from '../../../../server/lib/musicVideo/musicVideoMakingOfStoryShared.js';

const inputCls = 'block w-full min-w-0 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-port-text';
const btnCls = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2.5 py-1 text-xs text-port-text hover:bg-port-bg disabled:opacity-50 pointer-fine:sm:min-h-[30px]';

const STATUS_TONE = {
  idea: 'muted',
  draft: 'warning',
  staged: 'accent',
  posted: 'success',
};

const X_CAPABLE_PLATFORMS = new Set(['x', 'multi']);

function itemMediaThumb(item) {
  if (!item?.assetId) return null;
  if (item.kind === 'video') return videoPosterForJob(item.assetId);
  return `/data/images/${encodeURIComponent(item.assetId)}`;
}

function itemMediaHref(item) {
  if (!item?.assetId) return null;
  if (item.kind === 'video') return `/api/video-gen/history/${encodeURIComponent(item.assetId)}/file`;
  return `/data/images/${encodeURIComponent(item.assetId)}`;
}

function summaryRows(summary) {
  return Object.entries(summary || {})
    .filter(([, value]) => value != null && value !== '' && (
      typeof value !== 'object'
      || (Array.isArray(value) && value.every((entry) => typeof entry === 'string' || typeof entry === 'number'))
    ))
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(' · ') : String(value)]);
}

function buildPartItemIds(parts, partIndex, updater) {
  const next = parts.map((part) => part.items.map((item) => item.id));
  while (next.length <= partIndex) next.push([]);
  next[partIndex] = updater([...next[partIndex]]);
  return next;
}

export default function MakingOfPostCard({
  post,
  items,
  busy,
  defaultEditing = false,
  xDraft = null,
  xDraftBusy = null,
  xDraftProgress = null,
  xDraftError = null,
  onPrepareXDraft,
  onDiscardXDraft,
  onUpdate,
  onDelete,
  onOpenPreview,
  onEditItem,
}) {
  const prefix = useId();
  const [editing, setEditing] = useState(defaultEditing);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDiscardDraft, setConfirmDiscardDraft] = useState(false);
  const [confirmPostAgain, setConfirmPostAgain] = useState(false);
  const [confirmUndoPosted, setConfirmUndoPosted] = useState(false);
  const [recordUrlDraft, setRecordUrlDraft] = useState('');

  const [title, setTitle] = useState(post.title);
  const [status, setStatus] = useState(post.status);
  const [platform, setPlatform] = useState(post.platform);
  const [tagsText, setTagsText] = useState((post.tags || []).join(', '));
  const [summary, setSummary] = useState(post.summary || '');
  const [body, setBody] = useState(post.body || '');
  const [publishedUrl, setPublishedUrl] = useState(post.publishedUrl || '');

  const itemsById = new Map(items.map((entry) => [entry.id, entry]));
  const attachedItems = (post.itemIds || []).map((id) => itemsById.get(id)).filter(Boolean);
  const availableItems = items.filter((entry) => !(post.itemIds || []).includes(entry.id));
  const allMediaItems = items.filter(isMakingOfMediaItem);
  const stagedMediaItems = attachedItems.filter(isMakingOfMediaItem);
  const otherMediaItems = allMediaItems.filter((entry) => !(post.itemIds || []).includes(entry.id));

  const resolvedParts = resolveMakingOfPostParts(post, items);
  const hasExplicitPartMedia = (post.partItemIds || []).some((bucket) => Array.isArray(bucket) && bucket.length > 0);
  const canFillX = X_CAPABLE_PLATFORMS.has(post.platform) && typeof onPrepareXDraft === 'function';
  const totalPartMedia = resolvedParts.reduce((sum, part) => sum + part.items.length, 0);

  // Map each itemId → 1-based part numbers where it is attached so the bank strip shows assignments.
  const partBadgesByItemId = new Map();
  for (const part of resolvedParts) {
    for (const item of part.items) {
      if (!partBadgesByItemId.has(item.id)) partBadgesByItemId.set(item.id, []);
      partBadgesByItemId.get(item.id).push(part.index + 1);
    }
  }

  const editThreadParts = body
    .split(/\n\s*---\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  const startEdit = () => {
    setTitle(post.title);
    setStatus(post.status);
    setPlatform(post.platform);
    setTagsText((post.tags || []).join(', '));
    setSummary(post.summary || '');
    setBody(post.body || '');
    setPublishedUrl(post.publishedUrl || '');
    setEditing(true);
  };

  const saveEdit = async (event) => {
    event.preventDefault();
    if (!title.trim()) return;
    const ok = await onUpdate(post.id, {
      title: title.trim(),
      status,
      platform,
      tags: normalizeMakingOfTags(tagsText.split(',')),
      summary,
      body,
      publishedUrl: publishedUrl.trim(),
    });
    if (ok) setEditing(false);
  };

  const handleCopy = async (includeMedia) => {
    const text = formatMakingOfPostCopy(post, items, { includeMedia });
    const ok = await copyToClipboard(text);
    if (ok) toast.success(includeMedia ? 'Copied post with media list' : 'Copied post text');
    else toast.error('Could not copy to clipboard');
  };

  const attachItem = (itemId) => {
    if (!itemId) return;
    const next = [...(post.itemIds || []), itemId];
    onUpdate(post.id, { itemIds: next });
  };

  const detachItem = (itemId) => {
    const nextItemIds = (post.itemIds || []).filter((id) => id !== itemId);
    const nextPartItemIds = (post.partItemIds || []).map((bucket) => bucket.filter((id) => id !== itemId));
    onUpdate(post.id, { itemIds: nextItemIds, partItemIds: nextPartItemIds });
  };

  const moveItem = (index, delta) => {
    const target = index + delta;
    const current = [...(post.itemIds || [])];
    if (target < 0 || target >= current.length) return;
    [current[index], current[target]] = [current[target], current[index]];
    onUpdate(post.id, { itemIds: current });
  };

  const addItemToPart = (partIndex, itemId) => {
    if (!itemId) return;
    const nextPartItemIds = buildPartItemIds(resolvedParts, partIndex, (bucket) => {
      if (bucket.includes(itemId) || bucket.length >= MAKING_OF_X_MAX_MEDIA_PER_POST) return bucket;
      return [...bucket, itemId];
    });
    const nextItemIds = (post.itemIds || []).includes(itemId)
      ? post.itemIds
      : [...(post.itemIds || []), itemId];
    onUpdate(post.id, { itemIds: nextItemIds, partItemIds: nextPartItemIds });
  };

  const removeItemFromPart = (partIndex, itemId) => {
    const nextPartItemIds = buildPartItemIds(resolvedParts, partIndex, (bucket) => bucket.filter((id) => id !== itemId));
    onUpdate(post.id, { partItemIds: nextPartItemIds });
  };

  const moveItemInPart = (partIndex, mediaIndex, delta) => {
    const nextPartItemIds = buildPartItemIds(resolvedParts, partIndex, (bucket) => {
      const target = mediaIndex + delta;
      if (target < 0 || target >= bucket.length) return bucket;
      [bucket[mediaIndex], bucket[target]] = [bucket[target], bucket[mediaIndex]];
      return bucket;
    });
    onUpdate(post.id, { partItemIds: nextPartItemIds });
  };

  const handleAutoAssignMedia = () => {
    const distributed = autoDistributeMakingOfPartItems(post, items);
    onUpdate(post.id, { partItemIds: distributed });
  };

  const validRecordUrl = /^https?:\/\/\S+$/.test(recordUrlDraft.trim());
  const handleRecordLink = async (event) => {
    event.preventDefault();
    if (!validRecordUrl) return;
    const ok = await onUpdate(post.id, {
      status: 'posted',
      publishedUrl: recordUrlDraft.trim(),
    });
    if (ok) setRecordUrlDraft('');
  };

  const handleMarkDone = () => onUpdate(post.id, { status: 'posted' });

  const handleUndoPosted = () => onUpdate(post.id, {
    status: 'staged',
    publishedUrl: '',
    publishedAt: null,
  });

  const idFor = (name) => `${prefix}-${name}`;
  const isPosted = post.status === 'posted';
  const fillDisabled = busy || !!xDraftBusy || resolvedParts.length === 0;

  return (
    <article className="min-w-0 rounded-lg border border-port-border bg-port-card p-3 space-y-3">
      {editing ? (
        <form onSubmit={saveEdit} className="space-y-2.5">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-1">
              <label htmlFor={idFor('title')} className="block text-xs text-port-text-muted">Post title</label>
              <input id={idFor('title')} required value={title} maxLength={MAKING_OF_STORY_LIMITS.titleMaxLength}
                onChange={(e) => setTitle(e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1">
              <label htmlFor={idFor('status')} className="block text-xs text-port-text-muted">Status</label>
              <select id={idFor('status')} value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
                {MAKING_OF_POST_STATUSES.map((entry) => (
                  <option key={entry} value={entry}>{MAKING_OF_POST_STATUS_LABELS[entry]}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor={idFor('platform')} className="block text-xs text-port-text-muted">Platform</label>
              <select id={idFor('platform')} value={platform} onChange={(e) => setPlatform(e.target.value)} className={inputCls}>
                {MAKING_OF_POST_PLATFORMS.map((entry) => (
                  <option key={entry} value={entry}>{MAKING_OF_POST_PLATFORM_LABELS[entry]}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor={idFor('tags')} className="block text-xs text-port-text-muted">Tags (comma-separated)</label>
              <input id={idFor('tags')} value={tagsText} onChange={(e) => setTagsText(e.target.value)}
                placeholder="continuity, lighting, bloopers, breakdown" className={inputCls} />
            </div>
            <div className="space-y-1">
              <label htmlFor={idFor('url')} className="block text-xs text-port-text-muted">Top-level post URL (optional)</label>
              <input id={idFor('url')} type="url" value={publishedUrl} maxLength={MAKING_OF_STORY_LIMITS.urlMaxLength}
                onChange={(e) => setPublishedUrl(e.target.value)} placeholder="https://x.com/…" className={inputCls} />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor={idFor('summary')} className="block text-xs text-port-text-muted">Hook / angle summary</label>
            <input id={idFor('summary')} value={summary} maxLength={MAKING_OF_STORY_LIMITS.summaryMaxLength}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="One-line takeaway or opening hook" className={inputCls} />
          </div>

          <div className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor={idFor('body')} className="block text-xs text-port-text-muted">
                Draft post / thread copy (use <code className="rounded bg-port-bg px-1">---</code> between thread posts)
              </label>
              <span className="text-[11px] text-port-text-muted">
                {formatCount(body.length, { fallback: '0' })} chars
                {editThreadParts.length > 1 ? ` · ${formatCount(editThreadParts.length)} parts` : ''}
              </span>
            </div>
            <textarea id={idFor('body')} rows={6} value={body} maxLength={MAKING_OF_STORY_LIMITS.bodyMaxLength}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your Making-Of post or multi-part thread here…" className={inputCls} />
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} disabled={busy} className={btnCls}>Cancel</button>
            <button type="submit" disabled={busy || !title.trim()}
              className="inline-flex min-h-[44px] items-center gap-1 rounded bg-port-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-50 pointer-fine:sm:min-h-[30px]">
              <Check size={13} aria-hidden="true" /> Save post
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <h4 className="text-sm font-semibold break-words">{post.title}</h4>
                <Pill size="xs" tone={STATUS_TONE[post.status] || 'muted'}>
                  {MAKING_OF_POST_STATUS_LABELS[post.status] || post.status}
                </Pill>
                {xDraft && !isPosted && (
                  <Pill size="xs" tone="warning">
                    {xDraft.state === 'closed' ? 'Tab closed' : 'Draft open'}
                  </Pill>
                )}
                <Pill size="xs" tone="muted">
                  {MAKING_OF_POST_PLATFORM_LABELS[post.platform] || post.platform}
                </Pill>
                {(post.tags || []).map((tag) => (
                  <span key={tag} className="rounded bg-port-bg px-1.5 py-0.5 text-[11px] text-port-text-muted">#{tag}</span>
                ))}
              </div>
              {post.summary && <p className="text-xs text-port-text-muted break-words">{post.summary}</p>}
              {isPosted && post.publishedUrl && (
                <p className="text-xs">
                  <a href={post.publishedUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-port-accent underline break-all">
                    <ExternalLink size={12} aria-hidden="true" />
                    Posted{post.publishedAt ? ` ${formatDateTime(post.publishedAt)}` : ''}: {post.publishedUrl}
                  </a>
                </p>
              )}
              {isPosted && !post.publishedUrl && (
                <p className="text-xs text-port-text-muted inline-flex items-center gap-1">
                  <Check size={12} aria-hidden="true" />
                  Marked done{post.publishedAt ? ` ${formatDateTime(post.publishedAt)}` : ''}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {canFillX && (
                isPosted && !xDraft ? (
                  !confirmPostAgain && (
                    <button type="button" disabled={fillDisabled} onClick={() => setConfirmPostAgain(true)} className={btnCls}>
                      <Send size={12} aria-hidden="true" /> {xDraftBusy === 'prepare' ? 'Filling…' : 'Post again…'}
                    </button>
                  )
                ) : (
                  <button type="button" disabled={fillDisabled}
                    onClick={() => onPrepareXDraft(post.id, isPosted ? { again: true } : {})}
                    className="inline-flex min-h-[44px] items-center gap-1 rounded border border-port-accent/40 bg-port-accent/20 px-2.5 py-1 text-xs font-medium text-port-accent hover:bg-port-accent/25 disabled:opacity-50 pointer-fine:sm:min-h-[30px]">
                    <Send size={12} aria-hidden="true" />
                    {xDraftBusy === 'prepare' ? 'Filling…' : (xDraft ? 'Fill again' : 'Fill X draft')}
                  </button>
                )
              )}
              <button type="button" onClick={() => handleCopy(false)} className={btnCls}>
                <Copy size={12} aria-hidden="true" /> Copy text
              </button>
              {attachedItems.length > 0 && (
                <button type="button" onClick={() => handleCopy(true)} className={btnCls}>
                  <Copy size={12} aria-hidden="true" /> Copy + media list
                </button>
              )}
              <button type="button" disabled={busy} onClick={startEdit} className={btnCls}>
                <Pencil size={12} aria-hidden="true" /> Edit
              </button>
              {isPosted && !confirmUndoPosted && (
                <button type="button" disabled={busy} onClick={() => setConfirmUndoPosted(true)} className={btnCls}>
                  <Undo2 size={12} aria-hidden="true" /> Not done…
                </button>
              )}
              {!confirmDelete && (
                <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)}
                  aria-label={`Delete post ${post.title}`}
                  className={`${btnCls} min-h-[44px] min-w-[44px] justify-center text-port-error pointer-fine:sm:min-w-[30px]`}>
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {confirmPostAgain && (
            <ConfirmButtonPair
              prompt={`Already posted "${post.title}". Fill another X draft?`}
              confirmText="Post again"
              ariaLabel={`Confirm filling X draft again for ${post.title}`}
              confirmAriaLabel={`Confirm filling X draft again for ${post.title}`}
              largeTouchTargets
              busy={!!xDraftBusy}
              onConfirm={() => { setConfirmPostAgain(false); onPrepareXDraft(post.id, { again: true }); }}
              onCancel={() => setConfirmPostAgain(false)}
            />
          )}

          {confirmUndoPosted && (
            <ConfirmButtonPair
              prompt={`Remove PortOS's posted record and link for "${post.title}"? The post on X stays up.`}
              confirmText="Not done"
              ariaLabel={`Confirm marking ${post.title} not done`}
              confirmAriaLabel={`Confirm marking ${post.title} not done`}
              largeTouchTargets
              busy={busy}
              onConfirm={() => { setConfirmUndoPosted(false); handleUndoPosted(); }}
              onCancel={() => setConfirmUndoPosted(false)}
            />
          )}

          {confirmDelete && (
            <ConfirmButtonPair
              prompt={`Remove "${post.title}"? Attached media stays in your Making-Of bank.`}
              confirmText="Delete post"
              busy={busy}
              onConfirm={() => { setConfirmDelete(false); onDelete(post.id); }}
              onCancel={() => setConfirmDelete(false)}
            />
          )}

          {/* Live X draft fill progress, error, and review screenshot */}
          {xDraftBusy === 'prepare' && (
            <p role="status" className="text-xs text-port-text-muted">
              {xDraftProgress || 'Filling X thread in the PortOS Browser…'}
            </p>
          )}

          {xDraftError && (
            <div role="alert" className="rounded border border-port-error/40 bg-port-error/10 p-2 text-xs text-port-error space-y-0.5">
              <div className="flex items-center gap-1.5">
                {xDraftError.code === 'PUBLISH_LOGIN_REQUIRED' && <LogIn size={12} aria-hidden="true" />}
                <span>{xDraftError.message}</span>
              </div>
              {xDraftError.url && <div className="text-[11px] text-port-text-muted break-all">Sign-in page: {xDraftError.url}</div>}
            </div>
          )}

          {xDraft && (
            <div className="rounded border border-port-accent/40 bg-port-bg p-2.5 space-y-2">
              {xDraft.state === 'closed' ? (
                <p role="status" className="text-xs text-port-warning">Tab closed — click Fill again to stage a fresh X draft.</p>
              ) : (
                <>
                  <p className="text-xs text-port-text-muted">
                    X draft staged in the PortOS Browser. Review and press <strong>Post all</strong> there, then paste the top-level post link below and click <strong>Record</strong>.
                  </p>
                  {xDraft.screenshot && (
                    <img src={xDraft.screenshot} alt={`X draft as filled for ${post.title}`} className="w-full rounded border border-port-border" />
                  )}
                  <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
                    {summaryRows(xDraft.summary).map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="text-port-text-muted">{key}</dt>
                        <dd className="min-w-0 break-words whitespace-pre-wrap">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
              {confirmDiscardDraft ? (
                <ConfirmButtonPair
                  prompt="Discard this X draft and close its browser tab?"
                  confirmText="Discard"
                  ariaLabel={`Confirm discard X draft for ${post.title}`}
                  confirmAriaLabel={`Confirm discard X draft for ${post.title}`}
                  largeTouchTargets
                  busy={!!xDraftBusy}
                  onConfirm={() => { setConfirmDiscardDraft(false); onDiscardXDraft?.(post.id); }}
                  onCancel={() => setConfirmDiscardDraft(false)}
                />
              ) : (
                <button type="button" disabled={!!xDraftBusy} onClick={() => setConfirmDiscardDraft(true)} className={btnCls}>
                  <X size={12} aria-hidden="true" /> Discard draft
                </button>
              )}
            </div>
          )}

          {/* Inline Record link / Mark done bar (mirrors PublishPostingPanel ManualLink) */}
          {(!isPosted || !post.publishedUrl) && (
            <form onSubmit={handleRecordLink} className="flex flex-wrap items-center gap-2 rounded border border-port-border bg-port-bg/60 p-2">
              <label htmlFor={idFor('record-url')} className="sr-only">Link to the top-level {post.title} post</label>
              <input id={idFor('record-url')} type="url" value={recordUrlDraft}
                onChange={(e) => setRecordUrlDraft(e.target.value)}
                placeholder="Posted it? Paste the link to the top-level post (https://x.com/…)"
                className={`${inputCls} basis-full sm:basis-auto sm:flex-1`} />
              <button type="submit" disabled={busy || !validRecordUrl} className={btnCls}>
                <LinkIcon size={12} aria-hidden="true" /> Record
              </button>
              {!isPosted && (
                <button type="button" disabled={busy} aria-label={`Mark ${post.title} done`} onClick={handleMarkDone} className={btnCls}>
                  <Check size={12} aria-hidden="true" /> Mark done
                </button>
              )}
            </form>
          )}

          {/* Thread parts with per-part image & video picker */}
          {resolvedParts.length > 0 && (
            <div className="space-y-2">
              {resolvedParts.length > 1 && (
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-port-text-muted">
                  <span>
                    {formatCount(resolvedParts.length)} thread parts · {formatCount(totalPartMedia, { fallback: '0' })} attached across parts (up to {MAKING_OF_X_MAX_MEDIA_PER_POST} images/videos per post)
                  </span>
                  {!hasExplicitPartMedia && stagedMediaItems.length > 0 && (
                    <button type="button" disabled={busy} onClick={handleAutoAssignMedia}
                      className="inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 py-0.5 text-[11px] text-port-text hover:bg-port-bg disabled:opacity-50 pointer-fine:sm:min-h-[26px]">
                      <Sparkles size={11} aria-hidden="true" /> Auto-assign staged media
                    </button>
                  )}
                </div>
              )}

              {resolvedParts.map((part) => {
                const partIds = new Set(part.items.map((entry) => entry.id));
                const stagedChoices = stagedMediaItems.filter((entry) => !partIds.has(entry.id));
                const bankChoices = otherMediaItems.filter((entry) => !partIds.has(entry.id));
                const canAddMore = part.items.length < MAKING_OF_X_MAX_MEDIA_PER_POST && (stagedChoices.length > 0 || bankChoices.length > 0);
                return (
                  <div key={`${post.id}-part-${part.index}`} className="rounded border border-port-border bg-port-bg p-2.5 text-xs space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-medium text-port-text-muted">
                      <span>
                        {resolvedParts.length > 1 ? `Part ${part.index + 1} of ${resolvedParts.length}` : 'Post body'}
                      </span>
                      <span>
                        {formatCount(part.text.length, { fallback: '0' })} chars · {formatCount(part.items.length, { fallback: '0' })}/{MAKING_OF_X_MAX_MEDIA_PER_POST} media
                      </span>
                    </div>
                    <p className="text-port-text whitespace-pre-wrap break-words">{part.text}</p>

                    {/* Per-part media attachments */}
                    <div className="space-y-1.5 border-t border-port-border/60 pt-2">
                      {part.items.length > 0 && (
                        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                          {part.items.map((item, mediaIdx) => {
                            const thumb = itemMediaThumb(item);
                            const previewKey = item.assetId ? `${item.kind === 'video' ? 'video' : 'image'}:${item.assetId}` : null;
                            return (
                              <li key={item.id} className="flex items-center gap-2 rounded border border-port-border bg-port-card p-1.5 min-w-0">
                                {thumb ? (
                                  <button type="button" onClick={() => previewKey && onOpenPreview?.(previewKey)}
                                    aria-label={`Preview ${item.label || item.assetId}`}
                                    className="relative h-11 w-16 shrink-0 overflow-hidden rounded border border-port-border bg-black">
                                    <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
                                    {item.kind === 'video' && (
                                      <span className="port-media-overlay-strong absolute top-0.5 right-0.5 rounded p-0.5" aria-hidden="true">
                                        <Film size={9} />
                                      </span>
                                    )}
                                  </button>
                                ) : (
                                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded border border-port-border bg-port-bg text-port-text-muted">
                                    <ImageIcon size={14} aria-hidden="true" />
                                  </div>
                                )}
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-[11px] font-medium text-port-text">{item.label || item.assetId}</p>
                                  <p className="text-[10px] text-port-text-muted">
                                    {item.kind === 'video' ? 'Video' : 'Image'} · {MAKING_OF_ITEM_ROLE_LABELS[item.role] || item.role}
                                  </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-0.5">
                                  <button type="button" disabled={busy || mediaIdx === 0}
                                    onClick={() => moveItemInPart(part.index, mediaIdx, -1)}
                                    aria-label={`Move ${item.label || 'media'} earlier in part ${part.index + 1}`}
                                    className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border disabled:opacity-40 pointer-fine:sm:min-h-[24px] pointer-fine:sm:min-w-[24px]">
                                    <ArrowLeft size={10} aria-hidden="true" />
                                  </button>
                                  <button type="button" disabled={busy || mediaIdx === part.items.length - 1}
                                    onClick={() => moveItemInPart(part.index, mediaIdx, 1)}
                                    aria-label={`Move ${item.label || 'media'} later in part ${part.index + 1}`}
                                    className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border disabled:opacity-40 pointer-fine:sm:min-h-[24px] pointer-fine:sm:min-w-[24px]">
                                    <ArrowRight size={10} aria-hidden="true" />
                                  </button>
                                  <button type="button" disabled={busy}
                                    onClick={() => removeItemFromPart(part.index, item.id)}
                                    aria-label={`Remove ${item.label || 'media'} from part ${part.index + 1}`}
                                    className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-port-text-muted hover:text-port-error pointer-fine:sm:min-h-[24px] pointer-fine:sm:min-w-[24px]">
                                    <X size={10} aria-hidden="true" />
                                  </button>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {canAddMore && (
                        <div className="flex items-center gap-1.5 min-w-0">
                          <label htmlFor={idFor(`part-media-${part.index}`)} className="sr-only">
                            Add image or video to part {part.index + 1} of {post.title}
                          </label>
                          <select id={idFor(`part-media-${part.index}`)} value="" disabled={busy}
                            onChange={(e) => addItemToPart(part.index, e.target.value)}
                            className="max-w-full rounded border border-port-border bg-port-card px-2 py-1 text-[11px] min-h-[44px] pointer-fine:sm:min-h-[26px]">
                            <option value="">+ Add image/video to Part {part.index + 1} ({part.items.length}/{MAKING_OF_X_MAX_MEDIA_PER_POST})…</option>
                            {stagedChoices.length > 0 && (
                              <optgroup label="Staged for this post">
                                {stagedChoices.map((entry) => (
                                  <option key={entry.id} value={entry.id}>
                                    [{entry.kind === 'video' ? 'Video' : 'Image'}] {entry.label || entry.assetId}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            {bankChoices.length > 0 && (
                              <optgroup label="Making-Of bank">
                                {bankChoices.map((entry) => (
                                  <option key={entry.id} value={entry.id}>
                                    [{entry.kind === 'video' ? 'Video' : 'Image'}] {entry.label || entry.assetId}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                          </select>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Staged media pool strip */}
      <div className="space-y-2 border-t border-port-border pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-port-text-muted">
            Staged media pool ({formatCount(attachedItems.length, { fallback: '0' })})
          </span>
          {availableItems.length > 0 && (
            <div className="flex items-center gap-1.5 min-w-0">
              <label htmlFor={idFor('attach')} className="sr-only">Attach captured item to {post.title}</label>
              <select id={idFor('attach')} value="" disabled={busy}
                onChange={(e) => { attachItem(e.target.value); }}
                className="max-w-full rounded border border-port-border bg-port-bg px-2 py-1 text-xs min-h-[44px] pointer-fine:sm:min-h-[28px]">
                <option value="">+ Attach from bank…</option>
                {availableItems.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    [{MAKING_OF_ITEM_ROLE_LABELS[entry.role] || entry.role}] {entry.label || entry.assetId || 'Note'}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {attachedItems.length > 0 ? (
          <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {attachedItems.map((item, idx) => {
              const thumb = itemMediaThumb(item);
              const href = itemMediaHref(item);
              const previewKey = item.assetId ? `${item.kind === 'video' ? 'video' : 'image'}:${item.assetId}` : null;
              const partNums = partBadgesByItemId.get(item.id) || [];
              return (
                <li key={item.id} className="min-w-0 rounded border border-port-border bg-port-bg p-2 space-y-1.5">
                  <div className="flex items-start gap-2 min-w-0">
                    {thumb ? (
                      <button type="button" onClick={() => previewKey && onOpenPreview?.(previewKey)}
                        aria-label={`Preview ${item.label || item.assetId}`}
                        className="relative h-14 w-24 shrink-0 overflow-hidden rounded border border-port-border bg-black">
                        <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
                        <span className="port-media-overlay-strong absolute bottom-0.5 left-0.5 rounded px-1 text-[10px]">
                          {idx + 1}
                        </span>
                        {item.kind === 'video' && (
                          <span className="port-media-overlay-strong absolute top-0.5 right-0.5 rounded p-0.5" aria-hidden="true">
                            <Film size={10} />
                          </span>
                        )}
                      </button>
                    ) : (
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded border border-port-border bg-port-card text-port-text-muted">
                        <ImageIcon size={16} aria-hidden="true" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-xs font-medium break-words">{item.label || item.assetId || 'Note'}</p>
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-[11px] text-port-text-muted">
                          {MAKING_OF_ITEM_ROLE_LABELS[item.role] || item.role}
                        </span>
                        {partNums.map((num) => (
                          <span key={num} className="rounded bg-port-accent/15 px-1 text-[10px] font-medium text-port-accent">
                            Part {num}
                          </span>
                        ))}
                      </div>
                      {item.note && <p className="line-clamp-2 text-[11px] text-port-text-muted break-words">{item.note}</p>}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <button type="button" disabled={busy || idx === 0} onClick={() => moveItem(idx, -1)}
                      aria-label={`Move ${item.label || 'item'} earlier`}
                      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-xs disabled:opacity-40 pointer-fine:sm:min-h-[24px] pointer-fine:sm:min-w-[24px]">
                      <ArrowLeft size={11} aria-hidden="true" />
                    </button>
                    <button type="button" disabled={busy || idx === attachedItems.length - 1} onClick={() => moveItem(idx, 1)}
                      aria-label={`Move ${item.label || 'item'} later`}
                      className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-xs disabled:opacity-40 pointer-fine:sm:min-h-[24px] pointer-fine:sm:min-w-[24px]">
                      <ArrowRight size={11} aria-hidden="true" />
                    </button>
                    {href && (
                      <a href={href} download={item.assetId || undefined}
                        aria-label={`Download ${item.label || item.assetId}`}
                        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-port-text-muted hover:text-port-text pointer-fine:sm:min-h-[24px] pointer-fine:sm:min-w-[24px]">
                        <Download size={11} aria-hidden="true" />
                      </a>
                    )}
                    <button type="button" onClick={() => onEditItem?.(item)}
                      className="inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-1.5 text-[11px] text-port-text-muted hover:text-port-text pointer-fine:sm:min-h-[24px]">
                      <Pencil size={11} aria-hidden="true" /> Edit
                    </button>
                    <button type="button" disabled={busy} onClick={() => detachItem(item.id)}
                      aria-label={`Detach ${item.label || 'item'} from post`}
                      className="ml-auto inline-flex min-h-[44px] items-center gap-0.5 rounded border border-port-border px-1.5 text-[11px] text-port-text-muted hover:text-port-error pointer-fine:sm:min-h-[24px]">
                      <X size={11} aria-hidden="true" /> Detach
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-xs text-port-text-muted">No media attached yet. Attach stills, clips, or references from your bank below.</p>
        )}
      </div>
    </article>
  );
}
