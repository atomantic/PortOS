import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../../../services/api';
import {
  Link2,
  Send,
  RefreshCw,
  ExternalLink,
  Trash2,
  Edit2,
  Save,
  X,
  GitBranch,
  Download,
  Check,
  AlertCircle,
  FolderOpen,
  Tag,
  ShieldCheck,
  Search,
  ChevronDown,
  ChevronUp,
  FolderClosed,
  GripVertical
} from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import toast from '../../ui/Toast';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import { timeAgo } from '../../../utils/formatters';
import { useAutoRefetch } from '../../../hooks/useAutoRefetch';
import BucketBoard from '../links/BucketBoard';
import { LINK_DND_TYPE } from '../links/bucketColors';
import { reorderLinksInBucket } from '../links/bucketReorder';
import { normalizeUrl as normalizeUrlShared } from '../../../utils/urlNormalize';

/** Normalize a user-entered URL the way the quick-add form does. */
function normalizeUrl(raw) {
  return normalizeUrlShared(raw, { allowGit: true, requireDot: true });
}

const LINK_TYPE_COLORS = {
  github: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  article: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  documentation: 'bg-green-500/20 text-green-400 border-green-500/30',
  tool: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  reference: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  other: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
};

const CLONE_STATUS_STYLES = {
  none: '',
  pending: 'text-port-warning',
  cloning: 'text-port-accent animate-pulse',
  cloned: 'text-port-success',
  failed: 'text-port-error'
};

export default function LinksTab({ onRefresh }) {
  const [inputUrl, setInputUrl] = useState('');
  const [inputTitle, setInputTitle] = useState('');
  const [inputTags, setInputTags] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [sending, setSending] = useState(false);
  const [links, setLinks] = useState([]);
  const [buckets, setBuckets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // all, github, other, ungrouped
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const [scanningId, setScanningId] = useState(null);
  const inputRef = useRef(null);

  // Fetch the full link set; filtering, search, and bucket membership are all
  // computed client-side, so we need every link in one round-trip — the prior
  // `limit: 100` silently truncated power-user collections (>100 links lost
  // from list views, search, and bucket boards). The server schema caps at
  // 5000, which is ample headroom for a single-user bookmark collection.
  const fetchLinks = useCallback(async () => {
    const data = await api.getBrainLinks({ limit: 5000, silent: true }).catch(() => ({ links: [] }));
    setLinks(data.links || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchLinks();
    api.getBrainBuckets({ silent: true })
      .then(data => setBuckets(data.buckets || []))
      .catch(() => setBuckets([]));
  }, [fetchLinks]);

  // Poll for clone status updates while at least one link is in flight.
  const hasInFlightClone = links.some(l => l.cloneStatus === 'cloning' || l.cloneStatus === 'pending');
  useAutoRefetch(fetchLinks, 3000, { enabled: hasInFlightClone, pollOnly: true });

  // Client-side filter (type / bucket membership) then keyword search.
  const matchesFilter = (link) => {
    if (filter === 'github') return link.isGitHubRepo;
    if (filter === 'other') return !link.isGitHubRepo;
    if (filter === 'ungrouped') return !link.bucketId;
    return true;
  };
  const filteredLinks = links.filter(matchesFilter);

  const query = search.trim().toLowerCase();
  const visibleLinks = query
    ? filteredLinks.filter(link => {
        const haystack = [
          link.title,
          link.url,
          link.description,
          ...(link.tags || [])
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(query);
      })
    : filteredLinks;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!inputUrl.trim() || sending) return;

    const url = normalizeUrl(inputUrl);
    if (!url) {
      toast.error('Please enter a valid URL');
      return;
    }

    const payload = { url };
    const title = inputTitle.trim();
    if (title) payload.title = title;
    const tags = inputTags.split(',').map(t => t.trim()).filter(Boolean);
    if (tags.length) payload.tags = tags;

    setSending(true);
    const result = await api.createBrainLink(payload).catch(err => {
      if (err.message?.includes('already exists')) {
        toast.error('This URL is already saved');
      } else {
        toast.error(err.message || 'Failed to save link');
      }
      return null;
    });
    setSending(false);

    if (result) {
      const isGitHub = result.isGitHubRepo;
      toast.success(isGitHub ? 'GitHub repo added - cloning in background' : 'Link saved');
      setInputUrl('');
      setInputTitle('');
      setInputTags('');
      setShowDetails(false);
      fetchLinks();
      onRefresh?.();
    }
  };

  // Next bucketOrder for a target bucket (append to the end).
  const nextBucketOrder = (bucketId) => links
    .filter(l => l.bucketId === bucketId)
    .reduce((max, l) => Math.max(max, l.bucketOrder ?? 0), -1) + 1;

  // Assign (or, with bucketId === null, unassign) a link to a bucket.
  const handleAssignLink = async (link, bucketId) => {
    const patch = bucketId
      ? { bucketId, bucketOrder: nextBucketOrder(bucketId) }
      : { bucketId: null };
    // Optimistic update so chips move instantly.
    setLinks(prev => prev.map(l => (l.id === link.id ? { ...l, ...patch } : l)));
    const updated = await api.updateBrainLink(link.id, patch, { silent: true }).catch(err => {
      toast.error(err.message || 'Failed to update link');
      return null;
    });
    if (updated) {
      setLinks(prev => prev.map(l => (l.id === updated.id ? updated : l)));
    } else {
      fetchLinks(); // revert optimistic change on failure
    }
  };

  // Reposition a chip within (or into) a bucket at a specific index — the
  // intra-bucket reorder the bucket board's "append on assign" path can't do.
  // Renumbers the destination bucket densely and persists the whole batch in
  // one atomic call: N concurrent single-link PUTs would race the shared links
  // store and silently lose-update some chips' bucketOrder.
  const handleMoveLinkToIndex = async (link, bucketId, targetIndex) => {
    const { renumbered, changed } = reorderLinksInBucket(links, link, bucketId, targetIndex);
    if (changed.length === 0) return;
    // Optimistic reorder so the chips settle instantly.
    const byId = new Map(renumbered.map(r => [r.id, r]));
    setLinks(prev => prev.map(l => {
      const r = byId.get(l.id);
      return r ? { ...l, bucketId: r.bucketId, bucketOrder: r.bucketOrder } : l;
    }));
    const ok = await api.reorderBrainLinks(changed, { silent: true }).catch(() => null);
    if (!ok) {
      toast.error('Failed to reorder links');
      fetchLinks(); // revert optimistic change on failure
    }
  };

  // Quick-add a URL directly into a bucket. Returns true on success.
  const handleAddLinkToBucket = async (rawUrl, bucketId) => {
    const url = normalizeUrl(rawUrl);
    if (!url) {
      toast.error('Please enter a valid URL');
      return false;
    }
    const result = await api.createBrainLink({ url, bucketId, bucketOrder: nextBucketOrder(bucketId) }).catch(err => {
      if (err.message?.includes('already exists')) {
        toast.error('This URL is already saved');
      } else {
        toast.error(err.message || 'Failed to add link');
      }
      return null;
    });
    if (result) {
      setLinks(prev => [result, ...prev]);
      onRefresh?.();
      return true;
    }
    return false;
  };

  const handleEdit = (link) => {
    setEditingId(link.id);
    setEditForm({
      url: link.url,
      title: link.title,
      description: link.description || '',
      linkType: link.linkType,
      tags: link.tags?.join(', ') || ''
    });
  };

  const handleSaveEdit = async (linkId) => {
    const url = editForm.url?.trim();
    if (!url) {
      toast.error('URL cannot be empty');
      return;
    }

    const updates = {
      url,
      title: editForm.title,
      description: editForm.description,
      linkType: editForm.linkType,
      tags: editForm.tags ? editForm.tags.split(',').map(t => t.trim()).filter(Boolean) : []
    };

    const result = await api.updateBrainLink(linkId, updates).catch(err => {
      if (err.message?.includes('already exists')) {
        toast.error('Another link already uses this URL');
      } else {
        toast.error(err.message || 'Failed to update');
      }
      return null;
    });

    if (result) {
      toast.success('Link updated');
      setEditingId(null);
      setEditForm({});
      fetchLinks();
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditForm({});
  };

  const handleDelete = async (linkId) => {
    const result = await api.deleteBrainLink(linkId, { silent: true }).catch(err => {
      toast.error(err.message || 'Failed to delete');
      return null;
    });
    if (!result) return;

    toast.success('Link deleted');
    setConfirmingDeleteId(null);
    fetchLinks();
    onRefresh?.();
  };

  const handleClone = async (linkId) => {
    const result = await api.cloneBrainLink(linkId, { silent: true }).catch(err => {
      toast.error(err.message || 'Failed to start clone');
      return null;
    });

    if (result) {
      toast.success('Clone started');
      fetchLinks();
    }
  };

  const handlePull = async (linkId) => {
    const result = await api.pullBrainLink(linkId, { silent: true }).catch(err => {
      toast.error(err.message || 'Failed to pull');
      return null;
    });

    if (result) {
      toast.success('Pulled latest changes');
    }
  };

  const handleOpenFolder = async (linkId) => {
    await api.openBrainLinkFolder(linkId, { silent: true }).catch(err => {
      toast.error(err.message || 'Failed to open folder');
    });
  };

  const handleScan = async (linkId) => {
    setScanningId(linkId);
    const result = await api.scanBrainLink(linkId, { silent: true }).catch(err => {
      toast.error(err.message || 'Failed to start scan');
      return null;
    });
    setScanningId(null);

    if (result) {
      toast.success('Malware scan queued — track progress in CoS Tasks');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(340px,440px)] gap-6 items-start">
        {/* Left column: entry form, filters, and the full link list */}
        <div className="min-w-0 flex flex-col">
          <div className="flex items-center gap-2 mb-3">
            <Link2 size={16} className="text-gray-400 shrink-0" />
            <h2 className="text-sm font-semibold text-gray-300">All Links</h2>
          </div>

      {/* Quick-add input */}
      <form onSubmit={handleSubmit} className="mb-6">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="Paste a URL (GitHub repos auto-clone)..."
            className="flex-1 px-4 py-3 bg-port-card border border-port-border rounded-lg text-white placeholder-gray-500 focus:outline-hidden focus:border-port-accent"
            disabled={sending}
          />
          <button
            type="submit"
            disabled={sending || !inputUrl.trim()}
            className="px-4 py-3 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 min-h-[48px]"
            title={sending ? 'Saving...' : 'Save link'}
          >
            {sending ? (
              <BrailleSpinner />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setShowDetails(v => !v)}
          className="mt-2 flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors"
        >
          {showDetails ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          {showDetails ? 'Hide title & tags' : 'Add title & tags (optional)'}
        </button>

        {showDetails && (
          <div className="mt-2 space-y-2">
            <div>
              <label htmlFor="link-title" className="sr-only">Title</label>
              <input
                id="link-title"
                type="text"
                value={inputTitle}
                onChange={(e) => setInputTitle(e.target.value)}
                placeholder="Title (defaults to repo name or URL)"
                className="w-full px-3 py-2 bg-port-card border border-port-border rounded-lg text-white text-sm placeholder-gray-500 focus:outline-hidden focus:border-port-accent"
                disabled={sending}
              />
            </div>
            <div>
              <label htmlFor="link-tags" className="sr-only">Tags</label>
              <input
                id="link-tags"
                type="text"
                value={inputTags}
                onChange={(e) => setInputTags(e.target.value)}
                placeholder="Tags (comma-separated)"
                className="w-full px-3 py-2 bg-port-card border border-port-border rounded-lg text-white text-sm placeholder-gray-500 focus:outline-hidden focus:border-port-accent"
                disabled={sending}
              />
            </div>
          </div>
        )}

        <p className="mt-2 text-xs text-gray-500">
          Paste any URL. GitHub repos will be automatically cloned for local reference.
        </p>
      </form>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {[
          { id: 'all', label: 'All', count: links.length },
          { id: 'github', label: 'GitHub Repos', icon: GitBranch, count: links.filter(l => l.isGitHubRepo).length },
          { id: 'other', label: 'Other Links', icon: Link2, count: links.filter(l => !l.isGitHubRepo).length },
          { id: 'ungrouped', label: 'Ungrouped', icon: FolderClosed, count: links.filter(l => !l.bucketId).length }
        ].map(tab => {
          const Icon = tab.icon;
          const isActive = filter === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id)}
              className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors min-h-[40px] ${
                isActive
                  ? 'bg-port-accent/20 text-port-accent border border-port-accent/30'
                  : 'bg-port-card text-gray-400 hover:text-white border border-port-border'
              }`}
            >
              {Icon && <Icon size={14} />}
              {tab.label}
              {tab.count !== undefined && (
                <span className="text-xs opacity-60">({tab.count})</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search links by title, URL, description, or tag..."
          className="w-full pl-9 pr-9 py-2 bg-port-card border border-port-border rounded-lg text-white text-sm placeholder-gray-500 focus:outline-hidden focus:border-port-accent"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-white transition-colors"
            title="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Links list */}
      <div className="space-y-3">
        {visibleLinks.map(link => {
          const isEditing = editingId === link.id;
          return (
          <div
            key={link.id}
            draggable={!isEditing}
            onDragStart={!isEditing ? (e) => {
              e.dataTransfer.setData(LINK_DND_TYPE, link.id);
              e.dataTransfer.effectAllowed = 'move';
            } : undefined}
            className={`p-4 bg-port-card border border-port-border rounded-lg ${isEditing ? '' : 'cursor-grab'}`}
          >
            {/* Header row */}
            <div className="flex items-start justify-between gap-3 mb-2">
              {!isEditing && (
                <GripVertical size={16} className="shrink-0 mt-0.5 text-gray-600" title="Drag to a bucket" />
              )}
              {editingId === link.id ? (
                <div className="flex-1 space-y-2">
                  <div>
                    <label htmlFor={`link-url-${link.id}`} className="block text-xs text-gray-400 mb-1">URL</label>
                    <input
                      id={`link-url-${link.id}`}
                      type="url"
                      value={editForm.url}
                      onChange={(e) => setEditForm({ ...editForm, url: e.target.value })}
                      className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
                      placeholder="https://example.com"
                    />
                  </div>
                  <div>
                    <label htmlFor={`link-title-${link.id}`} className="block text-xs text-gray-400 mb-1">Title</label>
                    <input
                      id={`link-title-${link.id}`}
                      type="text"
                      value={editForm.title}
                      onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                      className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
                      placeholder="Title"
                      autoFocus
                    />
                  </div>
                  <textarea
                    value={editForm.description}
                    onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                    className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm resize-none"
                    placeholder="Description (optional)"
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <select
                      value={editForm.linkType}
                      onChange={(e) => setEditForm({ ...editForm, linkType: e.target.value })}
                      className="px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
                    >
                      <option value="github">GitHub</option>
                      <option value="article">Article</option>
                      <option value="documentation">Documentation</option>
                      <option value="tool">Tool</option>
                      <option value="reference">Reference</option>
                      <option value="other">Other</option>
                    </select>
                    <input
                      type="text"
                      value={editForm.tags}
                      onChange={(e) => setEditForm({ ...editForm, tags: e.target.value })}
                      className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
                      placeholder="Tags (comma-separated)"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSaveEdit(link.id)}
                      className="flex items-center gap-1 px-2 py-1 text-xs bg-port-success/20 text-port-success rounded hover:bg-port-success/30 transition-colors"
                    >
                      <Save size={12} />
                      Save
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors"
                    >
                      <X size={12} />
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {link.isGitHubRepo ? (
                        <GitBranch size={16} className="text-purple-400 shrink-0" />
                      ) : (
                        <Link2 size={16} className="text-gray-400 shrink-0" />
                      )}
                      <h3 className="font-medium text-white truncate">{link.title}</h3>
                    </div>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      draggable={false}
                      className="text-sm text-gray-400 hover:text-port-accent truncate block"
                    >
                      {link.url}
                    </a>
                    {link.description && (
                      <p className="text-sm text-gray-500 mt-1">{link.description}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleEdit(link)}
                      className="p-1.5 text-gray-400 hover:text-white transition-colors"
                      title="Edit"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={() => setConfirmingDeleteId(link.id)}
                      className="p-1.5 text-gray-400 hover:text-port-error transition-colors"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      draggable={false}
                      className="p-1.5 text-gray-400 hover:text-port-accent transition-colors"
                      title="Open in new tab"
                    >
                      <ExternalLink size={14} />
                    </a>
                  </div>
                </>
              )}

              <span className="text-xs text-gray-500 whitespace-nowrap">
                {timeAgo(link.createdAt)}
              </span>
            </div>

            {/* Delete confirmation */}
            {confirmingDeleteId === link.id && (
              <InlineConfirmRow
                question="Delete this link? This cannot be undone."
                className="mb-2"
                onConfirm={() => handleDelete(link.id)}
                onCancel={() => setConfirmingDeleteId(null)}
              />
            )}

            {/* Footer row */}
            {editingId !== link.id && (
              <div className="flex items-center gap-2 flex-wrap mt-2">
                {/* Link type badge */}
                <span className={`px-2 py-1 text-xs rounded border ${LINK_TYPE_COLORS[link.linkType] || LINK_TYPE_COLORS.other}`}>
                  {link.linkType}
                </span>

                {/* Bucket assignment */}
                <label htmlFor={`link-bucket-${link.id}`} className="sr-only">Assign to bucket</label>
                <select
                  id={`link-bucket-${link.id}`}
                  value={link.bucketId || ''}
                  onChange={(e) => handleAssignLink(link, e.target.value || null)}
                  className="px-1.5 py-1 text-xs rounded border border-port-border bg-port-bg text-gray-300 focus:outline-hidden focus:border-port-accent"
                  title="Assign to a bucket"
                >
                  <option value="">＋ Bucket…</option>
                  {buckets.map(b => (
                    <option key={b.id} value={b.id}>{b.icon ? `${b.icon} ` : ''}{b.name}</option>
                  ))}
                </select>

                {/* Tags */}
                {link.tags?.length > 0 && (
                  <div className="flex items-center gap-1">
                    <Tag size={12} className="text-gray-500" />
                    {link.tags.map((tag, i) => (
                      <span key={i} className="px-1.5 py-0.5 text-xs bg-port-border/50 text-gray-400 rounded">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* GitHub-specific controls */}
                {link.isGitHubRepo && (
                  <>
                    {/* Clone status */}
                    <span className={`flex items-center gap-1 text-xs ${CLONE_STATUS_STYLES[link.cloneStatus]}`}>
                      {link.cloneStatus === 'cloned' && <Check size={12} />}
                      {link.cloneStatus === 'cloning' && <BrailleSpinner />}
                      {link.cloneStatus === 'pending' && <Download size={12} />}
                      {link.cloneStatus === 'failed' && <AlertCircle size={12} />}
                      {link.cloneStatus === 'cloned' && 'Cloned'}
                      {link.cloneStatus === 'cloning' && 'Cloning...'}
                      {link.cloneStatus === 'pending' && 'Pending clone'}
                      {link.cloneStatus === 'failed' && 'Clone failed'}
                    </span>

                    {/* Clone error */}
                    {link.cloneError && (
                      <span className="text-xs text-port-error truncate max-w-[200px]" title={link.cloneError}>
                        {link.cloneError}
                      </span>
                    )}

                    {/* Local path */}
                    {link.localPath && (
                      <span className="flex items-center gap-1 text-xs text-gray-500 truncate max-w-[200px]" title={link.localPath}>
                        <FolderOpen size={12} />
                        {link.localPath.split('/').slice(-2).join('/')}
                      </span>
                    )}

                    {/* Action buttons */}
                    {link.cloneStatus === 'none' && (
                      <button
                        onClick={() => handleClone(link.id)}
                        className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border text-gray-400 hover:text-white transition-colors"
                        title="Clone repository"
                      >
                        <Download size={12} />
                        Clone
                      </button>
                    )}

                    {link.cloneStatus === 'failed' && (
                      <button
                        onClick={() => handleClone(link.id)}
                        className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border text-gray-400 hover:text-white transition-colors"
                        title="Retry clone"
                      >
                        <RefreshCw size={12} />
                        Retry
                      </button>
                    )}

                    {link.cloneStatus === 'cloned' && (
                      <>
                        <button
                          onClick={() => handleOpenFolder(link.id)}
                          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border text-gray-400 hover:text-white transition-colors"
                          title="Open folder in file manager"
                        >
                          <FolderOpen size={12} />
                          Open
                        </button>
                        <button
                          onClick={() => handlePull(link.id)}
                          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border text-gray-400 hover:text-white transition-colors"
                          title="Pull latest changes"
                        >
                          <RefreshCw size={12} />
                          Pull
                        </button>
                        <button
                          onClick={() => handleScan(link.id)}
                          disabled={scanningId === link.id}
                          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border text-gray-400 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Read-only malware/risk scan via /do:scan (writes report to ~/.claude/scans/)"
                        >
                          {scanningId === link.id ? (
                            <BrailleSpinner />
                          ) : (
                            <ShieldCheck size={12} />
                          )}
                          Scan
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          );
        })}

        {visibleLinks.length === 0 && query && (
          <div className="text-center py-12 text-gray-500">
            <Search className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No links match "{search.trim()}".</p>
            <button
              onClick={() => setSearch('')}
              className="text-sm mt-1 text-port-accent hover:underline"
            >
              Clear search
            </button>
          </div>
        )}

        {links.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <Link2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No links saved yet.</p>
            <p className="text-sm mt-1">Paste a URL above to get started.</p>
          </div>
        )}

        {links.length > 0 && visibleLinks.length === 0 && !query && (
          <div className="text-center py-12 text-gray-500">
            <FolderClosed className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No links in this view.</p>
            <button
              onClick={() => setFilter('all')}
              className="text-sm mt-1 text-port-accent hover:underline"
            >
              Show all links
            </button>
          </div>
        )}
          </div>
        </div>

        {/* Right column: bucket boards as a vertical grid */}
        <aside className="min-w-0">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <FolderClosed size={16} className="text-port-accent shrink-0" />
            <h2 className="text-sm font-semibold text-gray-300">Buckets</h2>
            <span className="text-xs text-gray-500">Group links — drag chips between buckets.</span>
          </div>
          <BucketBoard
            links={links}
            buckets={buckets}
            setBuckets={setBuckets}
            onAssignLink={handleAssignLink}
            onAddLinkToBucket={handleAddLinkToBucket}
            onMoveLinkToIndex={handleMoveLinkToIndex}
            onBucketDeleted={(bucketId) => setLinks(prev => prev.map(l => (l.bucketId === bucketId ? { ...l, bucketId: null } : l)))}
          />
        </aside>
      </div>
    </div>
  );
}
