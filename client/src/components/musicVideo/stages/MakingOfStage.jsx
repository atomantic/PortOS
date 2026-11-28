import { useId, useMemo, useState } from 'react';
import {
  Bookmark, Download, Film, Image as ImageIcon, ImagePlus, Pencil, Plus, Search, StickyNote, Trash2, Upload,
} from 'lucide-react';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair.jsx';
import FilePickerButton from '../../ui/FilePickerButton.jsx';
import Pill from '../../ui/Pill.jsx';
import toast from '../../ui/Toast.jsx';
import GalleryImagePicker from '../../imageGen/GalleryImagePicker.jsx';
import MakingOfExportPanel from '../MakingOfExportPanel.jsx';
import MakingOfPostCard from '../MakingOfPostCard.jsx';
import { shotNumbers as numberShots } from '../ShotStepper.jsx';
import { videoPosterForJob } from '../../../lib/creativeDirectorPreview.js';
import { IMAGE_ACCEPT, readFileAsBase64, validateImageFile } from '../../../utils/fileUpload.js';
import { formatCount, formatDateTime } from '../../../utils/formatters.js';
import { uploadGalleryImage } from '../../../services/apiSystem.js';
import {
  createMusicVideoMakingOfPost,
  deleteMusicVideoMakingOfItem,
  deleteMusicVideoMakingOfPost,
  updateMusicVideoMakingOfPost,
} from '../../../services/apiMusicVideo.js';
import {
  MAKING_OF_ITEM_KINDS,
  MAKING_OF_ITEM_ROLES,
  MAKING_OF_ITEM_ROLE_LABELS,
  MAKING_OF_POST_STATUSES,
  MAKING_OF_POST_STATUS_LABELS,
  emptyMakingOfStory,
} from '../../../../../server/lib/musicVideo/musicVideoMakingOfStoryShared.js';

const actionBtnCls = 'inline-flex min-h-[44px] items-center gap-1.5 rounded border border-port-border bg-port-card px-3 py-1.5 text-xs font-medium text-port-text hover:bg-port-bg disabled:opacity-50 pointer-fine:sm:min-h-[32px]';
const chipCls = 'inline-flex min-h-[44px] items-center gap-1 rounded border px-2.5 text-xs pointer-fine:sm:min-h-[28px]';

const KIND_LABELS = {
  all: 'All',
  image: 'Images',
  video: 'Videos',
  reference: 'References',
  note: 'Notes',
};

const ROLE_TONE = {
  fail: 'error',
  before: 'warning',
  after: 'success',
  process: 'muted',
  reference: 'accent',
  final: 'success',
  lesson: 'accent',
};

function itemThumbUrl(item) {
  if (!item?.assetId) return null;
  if (item.kind === 'video') return videoPosterForJob(item.assetId);
  return `/data/images/${encodeURIComponent(item.assetId)}`;
}

function itemDownloadUrl(item) {
  if (!item?.assetId) return null;
  if (item.kind === 'video') return `/api/video-gen/history/${encodeURIComponent(item.assetId)}/file`;
  return `/data/images/${encodeURIComponent(item.assetId)}`;
}

/**
 * Post-publish Making-Of management workspace for a Music Video project.
 * Stage multi-part posts and threads, organize captured stills/clips/references
 * tagged throughout production, upload extra screenshots or comparisons, and
 * export portable planning ZIPs.
 */
export default function MakingOfStage({ board }) {
  const { project, onEditShot, openPreview, onCaptureMakingOf, onMakingOfStorySaved } = board;
  const projectId = project.id;
  const story = project.makingOfStory || emptyMakingOfStory();
  const items = story.items || [];
  const posts = story.posts || [];
  const shotNumbers = useMemo(() => numberShots(project.scenes), [project.scenes]);

  const idPrefix = useId();
  const [busy, setBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('');
  const [query, setQuery] = useState('');
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [confirmItemId, setConfirmItemId] = useState(null);
  const [newPostOpen, setNewPostOpen] = useState(false);
  const [newPostTitle, setNewPostTitle] = useState('');
  const [newPostSummary, setNewPostSummary] = useState('');
  const [recentlyCreatedPostId, setRecentlyCreatedPostId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const allTags = useMemo(() => {
    const counts = new Map();
    for (const item of items) {
      for (const tag of item.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    for (const post of posts) {
      for (const tag of post.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [items, posts]);

  const postTitlesByItemId = useMemo(() => {
    const map = new Map();
    for (const post of posts) {
      for (const itemId of post.itemIds || []) {
        if (!map.has(itemId)) map.set(itemId, []);
        map.get(itemId).push(post);
      }
    }
    return map;
  }, [posts]);

  const applyStory = (nextStory) => {
    if (nextStory) onMakingOfStorySaved?.(nextStory);
  };

  const handleCreatePost = async (event) => {
    event.preventDefault();
    if (busy || !newPostTitle.trim()) return;
    setBusy(true);
    try {
      const res = await createMusicVideoMakingOfPost(projectId, {
        title: newPostTitle.trim(),
        summary: newPostSummary.trim(),
        status: 'draft',
        platform: 'x',
        tags: tagFilter ? [tagFilter] : [],
      }, { silent: true });
      applyStory(res.story);
      setRecentlyCreatedPostId(res.post?.id || null);
      setNewPostTitle('');
      setNewPostSummary('');
      setNewPostOpen(false);
      toast.success('Created Making-Of post');
    } catch (err) {
      toast.error(err?.message || 'Could not create post');
    } finally {
      setBusy(false);
    }
  };

  const handleUpdatePost = async (postId, patch) => {
    setBusy(true);
    try {
      const res = await updateMusicVideoMakingOfPost(projectId, postId, patch, { silent: true });
      applyStory(res.story);
      toast.success('Saved post');
      return true;
    } catch (err) {
      toast.error(err?.message || 'Could not update post');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleDeletePost = async (postId) => {
    setBusy(true);
    try {
      const res = await deleteMusicVideoMakingOfPost(projectId, postId, { silent: true });
      applyStory(res.story);
      toast.success('Removed post');
    } catch (err) {
      toast.error(err?.message || 'Could not remove post');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteItem = async (itemId) => {
    setBusy(true);
    try {
      const res = await deleteMusicVideoMakingOfItem(projectId, itemId, { silent: true });
      applyStory(res.story);
      setConfirmItemId(null);
      toast.success('Removed from Making Of');
    } catch (err) {
      toast.error(err?.message || 'Could not remove item');
    } finally {
      setBusy(false);
    }
  };

  const handleAttachItemToPost = async (itemId, postId) => {
    if (!postId) return;
    const post = posts.find((entry) => entry.id === postId);
    if (!post || post.itemIds.includes(itemId)) return;
    await handleUpdatePost(postId, { itemIds: [...post.itemIds, itemId] });
  };

  const handleUploadImage = async (files) => {
    const file = files?.[0];
    if (!file || uploading) return;
    const errMsg = !IMAGE_ACCEPT.split(',').includes(file.type)
      ? 'Use PNG, JPEG or WebP images'
      : validateImageFile(file);
    if (errMsg) { toast.error(errMsg); return; }
    setUploading(true);
    try {
      const encoded = await readFileAsBase64(file);
      const { filename } = await uploadGalleryImage(encoded, { silent: true });
      onCaptureMakingOf?.({
        kind: 'image',
        assetId: filename,
        label: file.name.replace(/\.[^.]+$/, ''),
        role: 'process',
        tags: tagFilter ? [tagFilter] : [],
      });
    } catch (err) {
      toast.error(err?.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filteredPosts = posts.filter((post) => {
    if (statusFilter !== 'all' && post.status !== statusFilter) return false;
    if (tagFilter && !(post.tags || []).includes(tagFilter)) return false;
    if (normalizedQuery) {
      const hay = `${post.title} ${post.summary} ${post.body} ${(post.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(normalizedQuery)) return false;
    }
    return true;
  });

  const filteredItems = items.filter((item) => {
    if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
    if (roleFilter !== 'all' && item.role !== roleFilter) return false;
    if (tagFilter && !(item.tags || []).includes(tagFilter)) return false;
    if (normalizedQuery) {
      const hay = `${item.label} ${item.note} ${item.assetId || ''} ${(item.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(normalizedQuery)) return false;
    }
    return true;
  });

  const postedCount = posts.filter((post) => post.status === 'posted').length;
  const stagedCount = posts.filter((post) => post.status === 'staged').length;

  const idFor = (suffix) => `${idPrefix}-${suffix}`;

  return (
    <div className="min-w-0 space-y-5">
      {/* Header summary & quick actions */}
      <section aria-label="Making-of overview" className="min-w-0 rounded-lg border border-port-border bg-port-card p-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-port-text-muted">
              Tag stills, video clips, bloopers, and reference sheets as you build, then stage and manage your post-publish Making-Of threads here.
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Pill size="xs" tone="muted">{formatCount(items.length, { fallback: '0' })} captured</Pill>
              <Pill size="xs" tone="accent">{formatCount(posts.length, { fallback: '0' })} posts ({formatCount(stagedCount, { fallback: '0' })} staged · {formatCount(postedCount, { fallback: '0' })} posted)</Pill>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setNewPostOpen((v) => !v)} disabled={busy}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded bg-port-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 pointer-fine:sm:min-h-[32px]">
              <Plus size={14} aria-hidden="true" /> New post
            </button>
            <button type="button" onClick={() => setGalleryOpen(true)} disabled={busy} className={actionBtnCls}>
              <ImagePlus size={14} aria-hidden="true" /> Pick gallery image
            </button>
            <FilePickerButton accept={IMAGE_ACCEPT} disabled={busy || uploading} className={actionBtnCls}
              onChange={(e) => handleUploadImage(Array.from(e.target.files || []))}>
              <Upload size={14} aria-hidden="true" /> {uploading ? 'Uploading…' : 'Upload screenshot'}
            </FilePickerButton>
            <button type="button" onClick={() => onCaptureMakingOf?.({ kind: 'note', role: 'lesson', tags: tagFilter ? [tagFilter] : [] })}
              disabled={busy} className={actionBtnCls}>
              <StickyNote size={14} aria-hidden="true" /> Add note
            </button>
          </div>
        </div>

        {newPostOpen && (
          <form onSubmit={handleCreatePost} className="space-y-2 rounded border border-port-border bg-port-bg p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor={idFor('new-title')} className="block text-xs text-port-text-muted">Post title</label>
                <input id={idFor('new-title')} required value={newPostTitle}
                  onChange={(e) => setNewPostTitle(e.target.value)}
                  placeholder="e.g. Solving prop continuity across cuts"
                  className="block w-full min-w-0 rounded border border-port-border bg-port-card px-2 py-1.5 text-sm" />
              </div>
              <div className="space-y-1">
                <label htmlFor={idFor('new-summary')} className="block text-xs text-port-text-muted">Hook / angle (optional)</label>
                <input id={idFor('new-summary')} value={newPostSummary}
                  onChange={(e) => setNewPostSummary(e.target.value)}
                  placeholder="What broke, what we tried, and the final fix"
                  className="block w-full min-w-0 rounded border border-port-border bg-port-card px-2 py-1.5 text-sm" />
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setNewPostOpen(false)} className={actionBtnCls}>Cancel</button>
              <button type="submit" disabled={busy || !newPostTitle.trim()}
                className="inline-flex min-h-[44px] items-center gap-1 rounded bg-port-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 pointer-fine:sm:min-h-[32px]">
                <Plus size={13} aria-hidden="true" /> Create post
              </button>
            </div>
          </form>
        )}

        {/* Search + Tag filter bar */}
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={idFor('search')} className="flex min-w-[14rem] flex-1 items-center gap-2 rounded border border-port-border bg-port-bg px-2">
            <Search size={14} aria-hidden="true" className="shrink-0 text-port-text-muted" />
            <span className="sr-only">Search Making-Of posts and captured media</span>
            <input id={idFor('search')} type="search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles, notes, tags, or filenames…"
              className="min-h-[44px] min-w-0 flex-1 bg-transparent text-sm outline-none pointer-fine:sm:min-h-[32px]" />
          </label>
          {tagFilter && (
            <button type="button" onClick={() => setTagFilter('')}
              className={`${chipCls} border-port-accent bg-port-accent/15 text-port-accent`}>
              #{tagFilter} ×
            </button>
          )}
        </div>
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by tag">
            {allTags.map(([tag, count]) => {
              const active = tagFilter === tag;
              return (
                <button key={tag} type="button" aria-pressed={active}
                  onClick={() => setTagFilter(active ? '' : tag)}
                  className={`${chipCls} ${active ? 'border-port-accent bg-port-accent/15 text-port-accent' : 'border-port-border text-port-text-muted hover:text-port-text'}`}>
                  #{tag} <span className="opacity-70">{formatCount(count)}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Section 1: Staged Posts */}
      <section aria-label="Staged Making-Of posts" className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Staged Making-Of posts</h3>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Post status filter">
            {['all', ...MAKING_OF_POST_STATUSES].map((entry) => {
              const count = entry === 'all' ? posts.length : posts.filter((p) => p.status === entry).length;
              return (
                <button key={entry} type="button" aria-pressed={statusFilter === entry}
                  onClick={() => setStatusFilter(entry)}
                  className={`${chipCls} ${statusFilter === entry ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}>
                  {entry === 'all' ? 'All' : MAKING_OF_POST_STATUS_LABELS[entry]} {formatCount(count, { fallback: '0' })}
                </button>
              );
            })}
          </div>
        </div>

        {filteredPosts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-port-border p-4 text-xs text-port-text-muted">
            {posts.length === 0
              ? 'No Making-Of posts staged yet. Click "New post" above or save any clip/reference with "Making of" to start one.'
              : 'No posts match the current filter.'}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredPosts.map((post) => (
              <MakingOfPostCard
                key={post.id}
                post={post}
                items={items}
                busy={busy}
                defaultEditing={post.id === recentlyCreatedPostId}
                onUpdate={handleUpdatePost}
                onDelete={handleDeletePost}
                onOpenPreview={openPreview}
                onEditItem={(item) => onCaptureMakingOf?.({ existingItem: item })}
              />
            ))}
          </div>
        )}
      </section>

      {/* Section 2: Captured Media & References Bank */}
      <section aria-label="Captured Making-Of bank" className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Captured media &amp; references ({formatCount(filteredItems.length, { fallback: '0' })})</h3>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Media kind filter">
              {['all', ...MAKING_OF_ITEM_KINDS].map((kind) => (
                <button key={kind} type="button" aria-pressed={kindFilter === kind}
                  onClick={() => setKindFilter(kind)}
                  className={`${chipCls} ${kindFilter === kind ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}>
                  {KIND_LABELS[kind]}
                </button>
              ))}
            </div>
            <label htmlFor={idFor('role-filter')} className="sr-only">Filter by role</label>
            <select id={idFor('role-filter')} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
              className="rounded border border-port-border bg-port-bg px-2 py-1 text-xs min-h-[44px] pointer-fine:sm:min-h-[28px]">
              <option value="all">All roles</option>
              {MAKING_OF_ITEM_ROLES.map((role) => (
                <option key={role} value={role}>{MAKING_OF_ITEM_ROLE_LABELS[role]}</option>
              ))}
            </select>
          </div>
        </div>

        {filteredItems.length === 0 ? (
          <div className="rounded-lg border border-dashed border-port-border p-4 text-xs text-port-text-muted">
            {items.length === 0
              ? 'Nothing captured yet. Click the Making-Of bookmark button on any shot take, Asset, Look reference, or full-size preview to collect items as you go.'
              : 'No captured items match the current filter.'}
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredItems.map((item) => {
              const thumb = itemThumbUrl(item);
              const href = itemDownloadUrl(item);
              const previewKey = item.assetId ? `${item.kind === 'video' ? 'video' : 'image'}:${item.assetId}` : null;
              const shotNum = item.sceneId ? shotNumbers.get(item.sceneId) : null;
              const linkedPosts = postTitlesByItemId.get(item.id) || [];
              const unlinkedPosts = posts.filter((post) => !post.itemIds.includes(item.id));
              return (
                <li key={item.id} className="min-w-0 rounded-lg border border-port-border bg-port-card p-2.5 flex flex-col justify-between gap-2">
                  <div className="space-y-2 min-w-0">
                    {thumb ? (
                      <button type="button" onClick={() => previewKey && openPreview?.(previewKey)}
                        aria-label={`Preview ${item.label || item.assetId}`}
                        className="relative block w-full overflow-hidden rounded border border-port-border bg-black aspect-video">
                        <img src={thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
                        <span className="port-media-overlay-strong absolute top-1 left-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]">
                          {item.kind === 'video' ? <Film size={11} aria-hidden="true" /> : <ImageIcon size={11} aria-hidden="true" />}
                          {item.kind === 'reference' ? 'Reference' : item.kind}
                        </span>
                      </button>
                    ) : (
                      <div className="flex items-center gap-1.5 rounded border border-port-border bg-port-bg px-2.5 py-2 text-xs text-port-text-muted">
                        <StickyNote size={14} aria-hidden="true" /> Text note
                      </div>
                    )}

                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Pill size="xs" tone={ROLE_TONE[item.role] || 'muted'}>
                          {MAKING_OF_ITEM_ROLE_LABELS[item.role] || item.role}
                        </Pill>
                        {shotNum && onEditShot && (
                          <button type="button" onClick={() => onEditShot(item.sceneId)}
                            className="pointer-coarse:min-h-11 rounded border border-port-border px-1.5 py-0.5 text-[10px] text-port-accent hover:bg-port-bg">
                            Shot {shotNum}
                          </button>
                        )}
                      </div>
                      <h4 className="text-sm font-medium break-words">{item.label || item.assetId || 'Untitled note'}</h4>
                      {item.note && <p className="text-xs text-port-text-muted whitespace-pre-wrap break-words">{item.note}</p>}
                      {item.tags?.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {item.tags.map((tag) => (
                            <button key={tag} type="button" onClick={() => setTagFilter(tag)}
                              className="rounded bg-port-bg px-1.5 py-0.5 text-[11px] text-port-text-muted hover:text-port-accent">
                              #{tag}
                            </button>
                          ))}
                        </div>
                      )}
                      {linkedPosts.length > 0 && (
                        <p className="text-[11px] text-port-text-muted">
                          In: {linkedPosts.map((p) => p.title).join(', ')}
                        </p>
                      )}
                      {item.capturedAt && (
                        <p className="text-[10px] text-port-text-muted">Saved {formatDateTime(item.capturedAt)}</p>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2 border-t border-port-border pt-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button type="button" onClick={() => onCaptureMakingOf?.({ existingItem: item })}
                        className="inline-flex min-h-[36px] items-center gap-1 rounded border border-port-border px-2 py-0.5 text-xs hover:bg-port-bg pointer-fine:sm:min-h-[26px]">
                        <Pencil size={11} aria-hidden="true" /> Edit
                      </button>
                      {href && (
                        <a href={href} download={item.assetId || undefined}
                          className="inline-flex min-h-[36px] items-center gap-1 rounded border border-port-border px-2 py-0.5 text-xs hover:bg-port-bg pointer-fine:sm:min-h-[26px]">
                          <Download size={11} aria-hidden="true" /> Download
                        </a>
                      )}
                      {unlinkedPosts.length > 0 && (
                        <div className="min-w-0 flex-1">
                          <label htmlFor={idFor(`add-post-${item.id}`)} className="sr-only">Add {item.label || 'item'} to post</label>
                          <select id={idFor(`add-post-${item.id}`)} value="" disabled={busy}
                            onChange={(e) => handleAttachItemToPost(item.id, e.target.value)}
                            className="w-full min-w-0 rounded border border-port-border bg-port-bg px-1.5 py-0.5 text-xs min-h-[36px] pointer-fine:sm:min-h-[26px]">
                            <option value="">+ Add to post…</option>
                            {unlinkedPosts.map((post) => (
                              <option key={post.id} value={post.id}>{post.title}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      {confirmItemId !== item.id && (
                        <button type="button" disabled={busy} onClick={() => setConfirmItemId(item.id)}
                          aria-label={`Remove ${item.label || item.assetId || 'item'}`}
                          className="ml-auto inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-xs text-port-error hover:bg-port-bg pointer-fine:sm:min-h-[26px] pointer-fine:sm:min-w-[26px]">
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    {confirmItemId === item.id && (
                      <ConfirmButtonPair
                        prompt="Remove from Making Of? The underlying media file stays in PortOS."
                        confirmText="Remove"
                        busy={busy}
                        onConfirm={() => handleDeleteItem(item.id)}
                        onCancel={() => setConfirmItemId(null)}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Collapsible planning ZIP export (keeps existing export workflow accessible here too) */}
      <details open={exportOpen} onToggle={(e) => setExportOpen(e.currentTarget.open)}
        className="rounded-lg border border-port-border bg-port-card p-3">
        <summary className="cursor-pointer text-sm font-medium inline-flex items-center gap-1.5">
          <Bookmark size={14} aria-hidden="true" /> Portable Making-Of ZIP export (planning, sheets &amp; manifest)
        </summary>
        {exportOpen && (
          <div className="mt-3">
            <MakingOfExportPanel project={project} />
          </div>
        )}
      </details>

      {galleryOpen && (
        <GalleryImagePicker
          open
          allowUpload
          onClose={() => setGalleryOpen(false)}
          onSelect={(picked) => {
            setGalleryOpen(false);
            if (!picked?.filename) return;
            onCaptureMakingOf?.({
              kind: 'image',
              assetId: picked.filename,
              label: (picked.prompt || '').slice(0, 80) || picked.filename,
              role: 'process',
              tags: tagFilter ? [tagFilter] : [],
            });
          }}
        />
      )}
    </div>
  );
}
