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
  Tag
} from 'lucide-react';
import toast from 'react-hot-toast';
import { formatRelativeTime } from '../constants';

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
  pending: 'text-yellow-400',
  cloning: 'text-blue-400 animate-pulse',
  cloned: 'text-green-400',
  failed: 'text-red-400'
};

export default function LinksTab({ onRefresh }) {
  const [inputUrl, setInputUrl] = useState('');
  const [sending, setSending] = useState(false);
  const [links, setLinks] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // all, github, other
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const inputRef = useRef(null);

  const fetchLinks = useCallback(async () => {
    const options = {};
    if (filter === 'github') {
      options.isGitHubRepo = true;
    } else if (filter === 'other') {
      options.isGitHubRepo = false;
    }

    const data = await api.getBrainLinks(options).catch(() => ({ links: [], total: 0 }));
    setLinks(data.links || []);
    setTotal(data.total || 0);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    fetchLinks();
  }, [fetchLinks]);

  // Poll for clone status updates
  useEffect(() => {
    const cloningLinks = links.filter(l => l.cloneStatus === 'cloning' || l.cloneStatus === 'pending');
    if (cloningLinks.length === 0) return;

    const interval = setInterval(fetchLinks, 3000);
    return () => clearInterval(interval);
  }, [links, fetchLinks]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!inputUrl.trim() || sending) return;

    // Basic URL validation
    let url = inputUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('git@')) {
      // Try adding https://
      if (url.includes('github.com') || url.includes('.')) {
        url = 'https://' + url;
      } else {
        toast.error('Please enter a valid URL');
        return;
      }
    }

    setSending(true);
    const result = await api.createBrainLink({ url }).catch(err => {
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
      fetchLinks();
      onRefresh?.();
    }
  };

  const handleEdit = (link) => {
    setEditingId(link.id);
    setEditForm({
      title: link.title,
      description: link.description || '',
      linkType: link.linkType,
      tags: link.tags?.join(', ') || ''
    });
  };

  const handleSaveEdit = async (linkId) => {
    const updates = {
      title: editForm.title,
      description: editForm.description,
      linkType: editForm.linkType,
      tags: editForm.tags ? editForm.tags.split(',').map(t => t.trim()).filter(Boolean) : []
    };

    const result = await api.updateBrainLink(linkId, updates).catch(err => {
      toast.error(err.message || 'Failed to update');
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
    await api.deleteBrainLink(linkId).catch(err => {
      toast.error(err.message || 'Failed to delete');
      return null;
    });

    toast.success('Link deleted');
    setConfirmingDeleteId(null);
    fetchLinks();
    onRefresh?.();
  };

  const handleClone = async (linkId) => {
    const result = await api.cloneBrainLink(linkId).catch(err => {
      toast.error(err.message || 'Failed to start clone');
      return null;
    });

    if (result) {
      toast.success('Clone started');
      fetchLinks();
    }
  };

  const handlePull = async (linkId) => {
    const result = await api.pullBrainLink(linkId).catch(err => {
      toast.error(err.message || 'Failed to pull');
      return null;
    });

    if (result) {
      toast.success('Pulled latest changes');
    }
  };

  const handleOpenFolder = async (linkId) => {
    await api.openBrainLinkFolder(linkId).catch(err => {
      toast.error(err.message || 'Failed to open folder');
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full max-w-4xl mx-auto">
      {/* Quick-add input */}
      <form onSubmit={handleSubmit} className="mb-6">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="Paste a URL (GitHub repos auto-clone)..."
            className="flex-1 px-4 py-3 bg-port-card border border-port-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
            disabled={sending}
          />
          <button
            type="submit"
            disabled={sending || !inputUrl.trim()}
            className="px-4 py-3 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 min-h-[48px]"
            title={sending ? 'Saving...' : 'Save link'}
          >
            {sending ? (
              <RefreshCw className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Paste any URL. GitHub repos will be automatically cloned for local reference.
        </p>
      </form>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-4">
        {[
          { id: 'all', label: 'All', count: total },
          { id: 'github', label: 'GitHub Repos', icon: GitBranch },
          { id: 'other', label: 'Other Links', icon: Link2 }
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

      {/* Links list */}
      <div className="space-y-3">
        {links.map(link => (
          <div
            key={link.id}
            className="p-4 bg-port-card border border-port-border rounded-lg"
          >
            {/* Header row */}
            <div className="flex items-start justify-between gap-3 mb-2">
              {editingId === link.id ? (
                <div className="flex-1 space-y-2">
                  <input
                    type="text"
                    value={editForm.title}
                    onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                    className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
                    placeholder="Title"
                    autoFocus
                  />
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
                        <GitBranch size={16} className="text-purple-400 flex-shrink-0" />
                      ) : (
                        <Link2 size={16} className="text-gray-400 flex-shrink-0" />
                      )}
                      <h3 className="font-medium text-white truncate">{link.title}</h3>
                    </div>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-gray-400 hover:text-port-accent truncate block"
                    >
                      {link.url}
                    </a>
                    {link.description && (
                      <p className="text-sm text-gray-500 mt-1">{link.description}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
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
                      className="p-1.5 text-gray-400 hover:text-port-accent transition-colors"
                      title="Open in new tab"
                    >
                      <ExternalLink size={14} />
                    </a>
                  </div>
                </>
              )}

              <span className="text-xs text-gray-500 whitespace-nowrap">
                {formatRelativeTime(link.createdAt)}
              </span>
            </div>

            {/* Delete confirmation */}
            {confirmingDeleteId === link.id && (
              <div className="flex items-center gap-2 p-2 bg-port-error/10 border border-port-error/30 rounded mb-2">
                <span className="text-xs text-white flex-1">Delete this link? This cannot be undone.</span>
                <button
                  onClick={() => handleDelete(link.id)}
                  className="px-2 py-1 text-xs bg-port-error text-white rounded hover:bg-port-error/80 transition-colors"
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmingDeleteId(null)}
                  className="px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Footer row */}
            {editingId !== link.id && (
              <div className="flex items-center gap-2 flex-wrap mt-2">
                {/* Link type badge */}
                <span className={`px-2 py-1 text-xs rounded border ${LINK_TYPE_COLORS[link.linkType] || LINK_TYPE_COLORS.other}`}>
                  {link.linkType}
                </span>

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
                      {link.cloneStatus === 'cloning' && <RefreshCw size={12} className="animate-spin" />}
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
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        ))}

        {links.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <Link2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No links saved yet.</p>
            <p className="text-sm mt-1">Paste a URL above to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}
