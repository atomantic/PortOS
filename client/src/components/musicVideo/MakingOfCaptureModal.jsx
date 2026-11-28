import { useEffect, useId, useMemo, useState } from 'react';
import { Bookmark, Check, Plus, X } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import toast from '../ui/Toast.jsx';
import {
  MAKING_OF_ITEM_ROLES,
  MAKING_OF_ITEM_ROLE_LABELS,
  MAKING_OF_STORY_LIMITS,
  normalizeMakingOfTags,
} from '../../../../server/lib/musicVideo/musicVideoMakingOfStoryShared.js';
import { captureMusicVideoMakingOfItem, updateMusicVideoMakingOfItem } from '../../services/apiMusicVideo.js';
import { videoPosterForJob } from '../../lib/creativeDirectorPreview.js';

const inputCls = 'block w-full min-w-0 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-port-text';

function mediaPreviewUrl(kind, assetId) {
  if (!assetId) return null;
  if (kind === 'video') return videoPosterForJob(assetId);
  return `/data/images/${encodeURIComponent(assetId)}`;
}

/**
 * Modal for capturing or editing a Making-Of item (still, video clip, reference
 * sheet, or text note): label, role, tags, story note, and optional attachment
 * to an existing or brand-new staged Making-Of post.
 */
export default function MakingOfCaptureModal({ open, projectId, draft, story, onClose, onSaved }) {
  const titleId = useId();
  const fieldPrefix = useId();
  const existing = draft?.existingItem || null;
  const isEditing = Boolean(existing?.id);
  const kind = existing?.kind || draft?.kind || 'image';
  const assetId = existing?.assetId ?? draft?.assetId ?? null;
  const sceneId = existing?.sceneId ?? draft?.sceneId ?? null;
  const refId = existing?.refId ?? draft?.refId ?? null;

  const [label, setLabel] = useState('');
  const [role, setRole] = useState('process');
  const [tagsText, setTagsText] = useState('');
  const [note, setNote] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [postId, setPostId] = useState('');
  const [newPostTitle, setNewPostTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !draft) return;
    const src = draft.existingItem || draft;
    setLabel(src.label || '');
    setRole(src.role || (src.kind === 'reference' ? 'reference' : 'process'));
    setTagsText(Array.isArray(src.tags) ? src.tags.join(', ') : '');
    setNote(src.note || '');
    setSourceUrl(src.sourceUrl || '');
    setPostId(draft.postId || '');
    setNewPostTitle('');
    setError('');
  }, [open, draft]);

  const existingTags = useMemo(() => {
    const set = new Set();
    for (const item of story?.items || []) {
      for (const tag of item.tags || []) set.add(tag);
    }
    for (const post of story?.posts || []) {
      for (const tag of post.tags || []) set.add(tag);
    }
    return [...set].sort();
  }, [story]);

  const parsedTags = useMemo(() => normalizeMakingOfTags(tagsText.split(',')), [tagsText]);
  const toggleTagChip = (tag) => {
    const next = parsedTags.includes(tag)
      ? parsedTags.filter((entry) => entry !== tag)
      : [...parsedTags, tag];
    setTagsText(next.join(', '));
  };

  const posts = story?.posts || [];
  const attachedPostIds = useMemo(() => {
    if (!existing?.id) return new Set();
    return new Set(posts.filter((post) => post.itemIds?.includes(existing.id)).map((post) => post.id));
  }, [existing?.id, posts]);

  const previewSrc = mediaPreviewUrl(kind, assetId);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saving || !projectId) return;
    setSaving(true);
    setError('');
    try {
      const tags = normalizeMakingOfTags(tagsText.split(','));
      let result;
      if (isEditing && !postId && !newPostTitle.trim()) {
        result = await updateMusicVideoMakingOfItem(projectId, existing.id, {
          label: label.trim(),
          role,
          tags,
          note,
          sourceUrl: sourceUrl.trim(),
          sceneId,
          refId,
        }, { silent: true });
      } else {
        result = await captureMusicVideoMakingOfItem(projectId, {
          ...(existing?.id ? { id: existing.id } : {}),
          kind,
          assetId,
          sceneId,
          refId,
          label: label.trim(),
          role,
          tags,
          note,
          sourceUrl: sourceUrl.trim(),
          ...(postId && postId !== '__new__' ? { postId } : {}),
          ...(postId === '__new__' && newPostTitle.trim() ? { newPostTitle: newPostTitle.trim() } : {}),
        }, { silent: true });
      }
      if (result?.story) onSaved?.(result.story, result.item);
      toast.success(isEditing ? 'Updated Making-Of item' : 'Saved to Making Of');
      onClose?.();
    } catch (err) {
      setError(err?.message || 'Could not save to Making Of');
    } finally {
      setSaving(false);
    }
  };

  const idFor = (name) => `${fieldPrefix}-${name}`;
  return (
    <Modal open={open} onClose={onClose} size="lg" labelledBy={titleId} closeOnBackdrop={false}
      panelClassName="rounded-lg border border-port-border bg-port-card p-4 shadow-xl">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Bookmark size={16} className="shrink-0 text-port-accent" aria-hidden="true" />
            <h2 id={titleId} className="text-base font-semibold truncate">
              {isEditing ? 'Edit Making-Of item' : 'Save to Making Of'}
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-port-text-muted hover:text-port-text pointer-fine:sm:min-h-[32px] pointer-fine:sm:min-w-[32px]">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {previewSrc && (
          <div className="flex flex-wrap items-center gap-3 rounded border border-port-border bg-port-bg p-2">
            <img src={previewSrc} alt="" className="h-20 w-32 shrink-0 rounded bg-black object-cover" />
            <div className="min-w-0 flex-1 text-xs text-port-text-muted space-y-0.5">
              <p className="font-medium text-port-text capitalize">{kind === 'reference' ? 'Look reference' : kind}</p>
              <p className="break-all font-mono text-[11px]">{assetId}</p>
              {attachedPostIds.size > 0 && (
                <p className="text-port-accent">
                  In {attachedPostIds.size} post{attachedPostIds.size === 1 ? '' : 's'}
                </p>
              )}
            </div>
          </div>
        )}

        {error && <p role="alert" className="text-xs text-port-error">{error}</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={idFor('label')} className="block text-xs text-port-text-muted">Label</label>
            <input id={idFor('label')} value={label} maxLength={MAKING_OF_STORY_LIMITS.labelMaxLength}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Early scale test — subject too tall"
              className={inputCls} />
          </div>
          <div className="space-y-1">
            <label htmlFor={idFor('role')} className="block text-xs text-port-text-muted">Role in story</label>
            <select id={idFor('role')} value={role} onChange={(e) => setRole(e.target.value)} className={inputCls}>
              {MAKING_OF_ITEM_ROLES.map((value) => (
                <option key={value} value={value}>{MAKING_OF_ITEM_ROLE_LABELS[value]}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-1">
          <label htmlFor={idFor('tags')} className="block text-xs text-port-text-muted">Tags (comma-separated)</label>
          <input id={idFor('tags')} value={tagsText} onChange={(e) => setTagsText(e.target.value)}
            placeholder="continuity, scale, lighting, blooper"
            className={inputCls} />
          {existingTags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1" role="group" aria-label="Existing tags">
              {existingTags.slice(0, 16).map((tag) => {
                const active = parsedTags.includes(tag);
                return (
                  <button key={tag} type="button" aria-pressed={active} onClick={() => toggleTagChip(tag)}
                    className={`inline-flex min-h-[32px] items-center gap-1 rounded border px-2 py-0.5 text-[11px] pointer-fine:sm:min-h-[24px] ${active ? 'border-port-accent bg-port-accent/15 text-port-accent' : 'border-port-border text-port-text-muted hover:text-port-text'}`}>
                    {active && <Check size={10} aria-hidden="true" />}#{tag}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor={idFor('note')} className="block text-xs text-port-text-muted">Story note / caption context</label>
          <textarea id={idFor('note')} rows={3} value={note} maxLength={MAKING_OF_STORY_LIMITS.noteMaxLength}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What went wrong, what fixed it, or why this clip belongs in the Making Of…"
            className={inputCls} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={idFor('post')} className="block text-xs text-port-text-muted">Add to Making-Of post</label>
            <select id={idFor('post')} value={postId} onChange={(e) => setPostId(e.target.value)} className={inputCls}>
              <option value="">Keep in bank only</option>
              {posts.map((post) => (
                <option key={post.id} value={post.id}>
                  {post.title}{attachedPostIds.has(post.id) ? ' (already attached)' : ''}
                </option>
              ))}
              <option value="__new__">+ Create a new post…</option>
            </select>
          </div>
          {postId === '__new__' ? (
            <div className="space-y-1">
              <label htmlFor={idFor('new-post')} className="block text-xs text-port-text-muted">New post title</label>
              <input id={idFor('new-post')} value={newPostTitle} maxLength={MAKING_OF_STORY_LIMITS.titleMaxLength}
                onChange={(e) => setNewPostTitle(e.target.value)}
                placeholder="e.g. Solving prop continuity"
                className={inputCls} />
            </div>
          ) : (
            <div className="space-y-1">
              <label htmlFor={idFor('source-url')} className="block text-xs text-port-text-muted">Public link (optional)</label>
              <input id={idFor('source-url')} type="url" value={sourceUrl} maxLength={MAKING_OF_STORY_LIMITS.urlMaxLength}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://x.com/…"
                className={inputCls} />
            </div>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-port-border">
          <button type="button" onClick={onClose} disabled={saving}
            className="min-h-[44px] rounded border border-port-border px-3 py-1.5 text-sm pointer-fine:sm:min-h-[34px]">
            Cancel
          </button>
          <button type="submit" disabled={saving || (postId === '__new__' && !newPostTitle.trim())}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded bg-port-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 pointer-fine:sm:min-h-[34px]">
            {isEditing ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
            {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Save to Making Of'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
