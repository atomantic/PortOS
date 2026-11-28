import { useId, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Check, Copy, Download, ExternalLink, Film, Image as ImageIcon,
  Pencil, Trash2, X,
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
  formatMakingOfPostCopy,
  normalizeMakingOfTags,
} from '../../../../server/lib/musicVideo/musicVideoMakingOfStoryShared.js';

const inputCls = 'block w-full min-w-0 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-port-text';
const btnCls = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2.5 py-1 text-xs text-port-text hover:bg-port-bg disabled:opacity-50 pointer-fine:sm:min-h-[30px]';

const STATUS_TONE = {
  idea: 'muted',
  draft: 'warning',
  staged: 'accent',
  posted: 'success',
};

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

export default function MakingOfPostCard({
  post, items, busy, defaultEditing = false, onUpdate, onDelete, onOpenPreview, onEditItem,
}) {
  const prefix = useId();
  const [editing, setEditing] = useState(defaultEditing);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [markPostedOpen, setMarkPostedOpen] = useState(false);
  const [postedUrlDraft, setPostedUrlDraft] = useState(post.publishedUrl || '');

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
    const next = (post.itemIds || []).filter((id) => id !== itemId);
    onUpdate(post.id, { itemIds: next });
  };

  const moveItem = (index, delta) => {
    const target = index + delta;
    const current = [...(post.itemIds || [])];
    if (target < 0 || target >= current.length) return;
    [current[index], current[target]] = [current[target], current[index]];
    onUpdate(post.id, { itemIds: current });
  };

  const submitMarkPosted = async (event) => {
    event.preventDefault();
    const ok = await onUpdate(post.id, {
      status: 'posted',
      publishedUrl: postedUrlDraft.trim(),
    });
    if (ok) setMarkPostedOpen(false);
  };

  const threadParts = (editing ? body : post.body || '')
    .split(/\n\s*---\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  const idFor = (name) => `${prefix}-${name}`;

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
              <label htmlFor={idFor('url')} className="block text-xs text-port-text-muted">Published URL (optional)</label>
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
                {threadParts.length > 1 ? ` · ${formatCount(threadParts.length)} parts` : ''}
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
                <Pill size="xs" tone="muted">
                  {MAKING_OF_POST_PLATFORM_LABELS[post.platform] || post.platform}
                </Pill>
                {(post.tags || []).map((tag) => (
                  <span key={tag} className="rounded bg-port-bg px-1.5 py-0.5 text-[11px] text-port-text-muted">#{tag}</span>
                ))}
              </div>
              {post.summary && <p className="text-xs text-port-text-muted break-words">{post.summary}</p>}
              {post.publishedUrl && (
                <p className="text-xs">
                  <a href={post.publishedUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-port-accent underline break-all">
                    <ExternalLink size={12} aria-hidden="true" />{post.publishedUrl}
                  </a>
                  {post.publishedAt && (
                    <span className="ml-2 text-[11px] text-port-text-muted">Posted {formatDateTime(post.publishedAt)}</span>
                  )}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={() => handleCopy(false)} className={btnCls}>
                <Copy size={12} aria-hidden="true" /> Copy text
              </button>
              {attachedItems.length > 0 && (
                <button type="button" onClick={() => handleCopy(true)} className={btnCls}>
                  <Copy size={12} aria-hidden="true" /> Copy + media list
                </button>
              )}
              {post.status !== 'posted' && (
                <button type="button" disabled={busy} onClick={() => { setPostedUrlDraft(post.publishedUrl || ''); setMarkPostedOpen((v) => !v); }}
                  className={btnCls}>
                  <Check size={12} aria-hidden="true" /> Mark posted
                </button>
              )}
              <button type="button" disabled={busy} onClick={startEdit} className={btnCls}>
                <Pencil size={12} aria-hidden="true" /> Edit
              </button>
              {!confirmDelete && (
                <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)}
                  aria-label={`Delete post ${post.title}`}
                  className={`${btnCls} min-h-[44px] min-w-[44px] justify-center text-port-error pointer-fine:sm:min-w-[30px]`}>
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {confirmDelete && (
            <ConfirmButtonPair
              prompt={`Remove "${post.title}"? Attached media stays in your Making-Of bank.`}
              confirmText="Delete post"
              busy={busy}
              onConfirm={() => { setConfirmDelete(false); onDelete(post.id); }}
              onCancel={() => setConfirmDelete(false)}
            />
          )}

          {markPostedOpen && (
            <form onSubmit={submitMarkPosted} className="flex flex-wrap items-end gap-2 rounded border border-port-border bg-port-bg p-2">
              <div className="min-w-0 flex-1 space-y-1">
                <label htmlFor={idFor('posted-url')} className="block text-xs text-port-text-muted">Published URL (optional)</label>
                <input id={idFor('posted-url')} type="url" value={postedUrlDraft}
                  onChange={(e) => setPostedUrlDraft(e.target.value)}
                  placeholder="https://x.com/…" className={inputCls} />
              </div>
              <button type="submit" disabled={busy}
                className="inline-flex min-h-[44px] items-center gap-1 rounded bg-port-accent px-3 py-1 text-xs font-medium text-white pointer-fine:sm:min-h-[34px]">
                <Check size={13} aria-hidden="true" /> Confirm posted
              </button>
              <button type="button" onClick={() => setMarkPostedOpen(false)} className={btnCls}>Cancel</button>
            </form>
          )}

          {threadParts.length > 0 && (
            <div className="space-y-2">
              {threadParts.map((part, idx) => (
                <div key={`${post.id}-part-${idx}`} className="rounded border border-port-border bg-port-bg p-2.5 text-xs whitespace-pre-wrap break-words space-y-1">
                  {threadParts.length > 1 && (
                    <div className="flex items-center justify-between text-[10px] font-medium text-port-text-muted">
                      <span>Part {idx + 1} of {threadParts.length}</span>
                      <span>{formatCount(part.length, { fallback: '0' })} chars</span>
                    </div>
                  )}
                  <p className="text-port-text">{part}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Attached media strip */}
      <div className="space-y-2 border-t border-port-border pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-port-text-muted">
            Staged media ({formatCount(attachedItems.length, { fallback: '0' })})
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
                      <p className="text-[11px] text-port-text-muted">
                        {MAKING_OF_ITEM_ROLE_LABELS[item.role] || item.role}
                      </p>
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
                        className="inline-flex min-h-[36px] items-center gap-1 rounded border border-port-border px-1.5 text-[11px] text-port-text-muted hover:text-port-text pointer-fine:sm:min-h-[24px]">
                        <Download size={11} aria-hidden="true" />
                      </a>
                    )}
                    <button type="button" onClick={() => onEditItem?.(item)}
                      className="inline-flex min-h-[36px] items-center gap-1 rounded border border-port-border px-1.5 text-[11px] text-port-text-muted hover:text-port-text pointer-fine:sm:min-h-[24px]">
                      <Pencil size={11} aria-hidden="true" /> Edit
                    </button>
                    <button type="button" disabled={busy} onClick={() => detachItem(item.id)}
                      aria-label={`Detach ${item.label || 'item'} from post`}
                      className="ml-auto inline-flex min-h-[36px] items-center gap-0.5 rounded border border-port-border px-1.5 text-[11px] text-port-text-muted hover:text-port-error pointer-fine:sm:min-h-[24px]">
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
