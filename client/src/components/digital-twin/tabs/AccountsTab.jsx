import { useState, useEffect } from 'react';
import {
  GitBranch,
  Camera,
  Users,
  Briefcase,
  Bird,
  Play,
  Music,
  MessageCircle,
  Cloud,
  Globe,
  AtSign,
  Link,
  Newspaper,
  PenTool,
  Plus,
  Trash2,
  ExternalLink,
  RefreshCw,
  Edit3,
  Check,
  X,
  Building2,
} from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import { FormField } from '../../ui/FormField';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import { useConfirmDelete } from '../../../hooks/useConfirmDelete';

// Platform icon mapping
const PLATFORM_ICONS = {
  github: GitBranch,
  instagram: Camera,
  facebook: Users,
  linkedin: Briefcase,
  x: Bird,
  youtube: Play,
  tiktok: Music,
  reddit: MessageCircle,
  bluesky: Cloud,
  mastodon: Globe,
  threads: AtSign,
  substack: Newspaper,
  medium: PenTool,
  other: Link
};

// Platform color mapping
const PLATFORM_COLORS = {
  github: 'text-gray-300 bg-gray-500/20 border-gray-500/30',
  instagram: 'text-pink-400 bg-pink-500/20 border-pink-500/30',
  facebook: 'text-blue-400 bg-blue-500/20 border-blue-500/30',
  linkedin: 'text-sky-400 bg-sky-500/20 border-sky-500/30',
  x: 'text-gray-300 bg-gray-500/20 border-gray-500/30',
  youtube: 'text-red-400 bg-red-500/20 border-red-500/30',
  tiktok: 'text-cyan-400 bg-cyan-500/20 border-cyan-500/30',
  reddit: 'text-orange-400 bg-orange-500/20 border-orange-500/30',
  bluesky: 'text-blue-300 bg-blue-400/20 border-blue-400/30',
  mastodon: 'text-purple-400 bg-purple-500/20 border-purple-500/30',
  threads: 'text-gray-300 bg-gray-500/20 border-gray-500/30',
  substack: 'text-orange-300 bg-orange-400/20 border-orange-400/30',
  medium: 'text-green-400 bg-green-500/20 border-green-500/30',
  other: 'text-gray-400 bg-gray-500/20 border-gray-500/30'
};

// Category labels
const CATEGORY_LABELS = {
  developer: 'Developer',
  social: 'Social',
  professional: 'Professional',
  writing: 'Writing',
  video: 'Video',
  community: 'Community',
  other: 'Other'
};

const CATEGORY_COLORS = {
  developer: 'text-green-400',
  social: 'text-pink-400',
  professional: 'text-sky-400',
  writing: 'text-orange-400',
  video: 'text-red-400',
  community: 'text-purple-400',
  other: 'text-gray-400'
};

// Empty form template
const EMPTY_FORM = {
  platform: '',
  username: '',
  displayName: '',
  url: '',
  bio: '',
  notes: '',
  ingestionEnabled: false
};

export default function AccountsTab() {
  const [accounts, setAccounts] = useState([]);
  const [platforms, setPlatforms] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  // Map socialAccountId → { orgId, orgName } for the "in org registry" badge (#2147).
  const [orgLinks, setOrgLinks] = useState({});
  const [linkingId, setLinkingId] = useState(null);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const [accountsData, platformsData, statsData, linksData] = await Promise.all([
      api.getSocialAccounts().catch(() => ({ accounts: [] })),
      api.getSocialAccountPlatforms().catch(() => ({ platforms: [] })),
      api.getSocialAccountStats().catch(() => null),
      // Degrades to no badges if Privacy Center isn't provisioned yet.
      api.getSocialAccountOrgLinks({ silent: true }).catch(() => [])
    ]);
    setAccounts(accountsData.accounts || []);
    setPlatforms(platformsData.platforms || []);
    setStats(statsData);
    setOrgLinks(Object.fromEntries((linksData || []).map(l => [l.socialAccountId, l])));
    setLoading(false);
  };

  // "Add to org registry": create a platform-category org linked to this account.
  const handleAddToOrgRegistry = async (account) => {
    setLinkingId(account.id);
    const created = await api.createPrivacyOrg({
      name: account.displayName || account.username,
      category: 'platform',
      website: account.url || '',
      socialAccountId: account.id,
      notes: `Linked from Digital Twin social account: ${account.platform}/${account.username}`
    }).catch(() => null);
    if (created) {
      // Reactive update — no full refetch.
      setOrgLinks(prev => ({ ...prev, [account.id]: { socialAccountId: account.id, orgId: created.id, orgName: created.name } }));
      toast.success(`Added ${created.name} to org registry`);
    }
    setLinkingId(null);
  };

  const handleSubmit = async () => {
    if (!form.platform || !form.username) {
      toast.error('Platform and username are required');
      return;
    }

    setSaving(true);

    if (editingId) {
      const updated = await api.updateSocialAccount(editingId, form).catch(() => null);
      if (updated) {
        toast.success(`Updated ${form.platform} account`);
        setEditingId(null);
      }
    } else {
      const created = await api.createSocialAccount(form).catch(() => null);
      if (created) {
        toast.success(`Added ${form.platform} account`);
      }
    }

    setSaving(false);
    setShowForm(false);
    setForm(EMPTY_FORM);
    loadData();
  };

  const handleEdit = (account) => {
    setForm({
      platform: account.platform,
      username: account.username,
      displayName: account.displayName || '',
      url: account.url || '',
      bio: account.bio || '',
      notes: account.notes || '',
      ingestionEnabled: account.ingestionEnabled || false
    });
    setEditingId(account.id);
    setShowForm(true);
  };

  const handleDelete = async (id) => {
    setDeleting(id);
    const success = await api.deleteSocialAccount(id).catch(() => false);
    if (success !== false) {
      toast.success('Account removed');
      loadData();
    }
    setDeleting(null);
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const selectedPlatformDef = platforms.find(p => p.id === form.platform);

  // Group accounts by category
  const groupedAccounts = {};
  for (const account of accounts) {
    const platformDef = platforms.find(p => p.id === account.platform);
    const category = platformDef?.category || 'other';
    if (!groupedAccounts[category]) groupedAccounts[category] = [];
    groupedAccounts[category].push(account);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Social Accounts</h2>
          <p className="text-sm text-gray-500">
            Your online presence for content learning and style reference
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadData}
            className="p-2 text-gray-400 hover:text-white border border-port-border rounded-lg hover:bg-port-card transition-colors min-h-[40px] min-w-[40px] flex items-center justify-center"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); }}
            className="flex items-center gap-2 px-3 py-2 bg-port-accent text-white rounded-lg hover:bg-port-accent/80 transition-colors min-h-[40px]"
          >
            <Plus className="w-4 h-4" />
            <span className="text-sm">Add Account</span>
          </button>
        </div>
      </div>

      {/* Stats Summary */}
      {stats && stats.total > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-port-card border border-port-border rounded-lg p-3">
            <div className="text-2xl font-bold text-white">{stats.total}</div>
            <div className="text-xs text-gray-500">Total Accounts</div>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-3">
            <div className="text-2xl font-bold text-port-accent">{stats.ingestionEnabled}</div>
            <div className="text-xs text-gray-500">Ingestion Enabled</div>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-3">
            <div className="text-2xl font-bold text-port-accent-2">{Object.keys(stats.byCategory || {}).length}</div>
            <div className="text-xs text-gray-500">Categories</div>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-3">
            <div className="text-2xl font-bold text-port-success">{Object.keys(stats.byPlatform || {}).length}</div>
            <div className="text-xs text-gray-500">Platforms</div>
          </div>
        </div>
      )}

      {/* Add/Edit Form */}
      {showForm && (
        <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-white">
              {editingId ? 'Edit Account' : 'Add Social Account'}
            </h3>
            <button
              onClick={handleCancel}
              aria-label="Close"
              className="p-1 text-gray-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Platform selector */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Platform</label>
            <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
              {platforms.filter(p => p.id !== 'other').map(platform => {
                const Icon = PLATFORM_ICONS[platform.id] || Link;
                const isSelected = form.platform === platform.id;
                return (
                  <button
                    key={platform.id}
                    onClick={() => setForm(prev => ({ ...prev, platform: platform.id }))}
                    className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors min-h-[40px] ${
                      isSelected
                        ? `${PLATFORM_COLORS[platform.id]} border-current`
                        : 'border-port-border text-gray-500 hover:text-gray-300 hover:border-gray-600'
                    }`}
                    title={platform.label}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="text-[10px] leading-tight">{platform.label}</span>
                  </button>
                );
              })}
              {/* Other option */}
              <button
                onClick={() => setForm(prev => ({ ...prev, platform: 'other' }))}
                className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors min-h-[40px] ${
                  form.platform === 'other'
                    ? 'border-gray-400 text-gray-300 bg-gray-500/20'
                    : 'border-port-border text-gray-500 hover:text-gray-300 hover:border-gray-600'
                }`}
                title="Other"
              >
                <Link className="w-4 h-4" />
                <span className="text-[10px] leading-tight">Other</span>
              </button>
            </div>
          </div>

          {/* Username and Display Name */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Username / Handle *" labelClassName="block text-xs text-gray-500 mb-1">
              <input
                type="text"
                value={form.username}
                onChange={e => setForm(prev => ({ ...prev, username: e.target.value }))}
                placeholder={selectedPlatformDef ? `Your ${selectedPlatformDef.label} username` : 'username'}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-hidden focus:border-port-accent min-h-[40px]"
              />
            </FormField>
            <FormField label="Display Name" labelClassName="block text-xs text-gray-500 mb-1">
              <input
                type="text"
                value={form.displayName}
                onChange={e => setForm(prev => ({ ...prev, displayName: e.target.value }))}
                placeholder="Optional display name"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-hidden focus:border-port-accent min-h-[40px]"
              />
            </FormField>
          </div>

          {/* URL */}
          <FormField label="Profile URL" labelClassName="block text-xs text-gray-500 mb-1">
            <input
              type="url"
              value={form.url}
              onChange={e => setForm(prev => ({ ...prev, url: e.target.value }))}
              placeholder={selectedPlatformDef?.urlTemplate?.replace('{username}', form.username || 'username') || 'https://...'}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-hidden focus:border-port-accent min-h-[40px]"
            />
          </FormField>

          {/* Bio */}
          <FormField label="Bio / Description" labelClassName="block text-xs text-gray-500 mb-1">
            <textarea
              value={form.bio}
              onChange={e => setForm(prev => ({ ...prev, bio: e.target.value }))}
              placeholder="What you use this account for, your profile bio, etc."
              rows={2}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-hidden focus:border-port-accent resize-y"
            />
          </FormField>

          {/* Notes */}
          <FormField label="Notes" labelClassName="block text-xs text-gray-500 mb-1">
            <textarea
              value={form.notes}
              onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Private notes about this account"
              rows={2}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-hidden focus:border-port-accent resize-y"
            />
          </FormField>

          {/* Ingestion toggle */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setForm(prev => ({ ...prev, ingestionEnabled: !prev.ingestionEnabled }))}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                form.ingestionEnabled ? 'bg-port-accent' : 'bg-gray-600'
              }`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                form.ingestionEnabled ? 'left-5' : 'left-0.5'
              }`} />
            </button>
            <span className="text-sm text-gray-400">
              Enable content ingestion (future: download and learn from content)
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2 border-t border-port-border">
            <button
              onClick={handleSubmit}
              disabled={saving || !form.platform || !form.username}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-accent text-white rounded-lg hover:bg-port-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <BrailleSpinner />
              ) : (
                <Check className="w-4 h-4" />
              )}
              <span className="text-sm">{editingId ? 'Update' : 'Add Account'}</span>
            </button>
            <button
              onClick={handleCancel}
              className="px-3 py-1.5 text-gray-400 hover:text-white border border-port-border rounded-lg hover:bg-port-card transition-colors text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {accounts.length === 0 && !showForm && (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <Globe className="w-12 h-12 text-gray-600 mx-auto mb-3" />
          <h3 className="text-white font-medium mb-1">No social accounts yet</h3>
          <p className="text-sm text-gray-500 mb-4">
            Add your social media accounts to build your digital identity profile.
            These will be used for content learning and style reference.
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-port-accent text-white rounded-lg hover:bg-port-accent/80 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Your First Account
          </button>
        </div>
      )}

      {/* Accounts grouped by category */}
      {Object.entries(groupedAccounts).sort(([a], [b]) => a.localeCompare(b)).map(([category, categoryAccounts]) => (
        <div key={category}>
          <h3 className={`text-sm font-medium mb-2 ${CATEGORY_COLORS[category] || 'text-gray-400'}`}>
            {CATEGORY_LABELS[category] || category}
          </h3>
          <div className="space-y-2">
            {categoryAccounts.map(account => {
              const Icon = PLATFORM_ICONS[account.platform] || Link;
              const colorClass = PLATFORM_COLORS[account.platform] || PLATFORM_COLORS.other;
              return (
                <div
                  key={account.id}
                  className="bg-port-card border border-port-border rounded-lg p-3 group hover:border-gray-600 transition-colors"
                >
                  <div className="flex items-start gap-3">
                  {/* Platform icon */}
                  <div className={`shrink-0 w-10 h-10 rounded-lg border flex items-center justify-center ${colorClass}`}>
                    <Icon className="w-5 h-5" />
                  </div>

                  {/* Account info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium text-sm truncate">
                        {account.displayName || account.username}
                      </span>
                      <span className="text-xs text-gray-500">
                        @{account.username}
                      </span>
                      {account.ingestionEnabled && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-port-accent/20 text-port-accent rounded">
                          ingestion
                        </span>
                      )}
                    </div>
                    {account.bio && (
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{account.bio}</p>
                    )}
                    {account.url && (
                      <a
                        href={account.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-port-accent hover:underline mt-0.5 inline-flex items-center gap-1"
                      >
                        {account.url.replace(/^https?:\/\//, '')}
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {/* Org-registry cross-link (#2147) */}
                    <div className="mt-1">
                      {orgLinks[account.id] ? (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-port-success/15 text-port-success rounded border border-port-success/30"
                          title={`In org registry as "${orgLinks[account.id].orgName}"`}
                        >
                          <Building2 className="w-3 h-3" />
                          In org registry
                        </span>
                      ) : (
                        <button
                          onClick={() => handleAddToOrgRegistry(account)}
                          disabled={linkingId === account.id}
                          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 text-gray-400 hover:text-white border border-port-border rounded hover:bg-port-bg transition-colors disabled:opacity-50"
                          title="Track this account in the Privacy Center org registry"
                        >
                          {linkingId === account.id ? <BrailleSpinner /> : <Building2 className="w-3 h-3" />}
                          Add to org registry
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleEdit(account)}
                      className="p-1.5 text-gray-400 hover:text-white rounded transition-colors min-h-[40px] min-w-[40px] flex items-center justify-center"
                      title="Edit"
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => requestDelete(account.id)}
                      disabled={deleting === account.id}
                      className="p-1.5 text-gray-400 hover:text-red-400 rounded transition-colors min-h-[40px] min-w-[40px] flex items-center justify-center"
                      title="Remove"
                    >
                      {deleting === account.id ? (
                        <BrailleSpinner />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                  </div>
                  {isConfirming(account.id) && (
                    <InlineConfirmRow
                      className="mt-2"
                      question="Disconnect this account? It will be removed from your digital identity profile. This cannot be undone."
                      confirmText="Disconnect"
                      confirmTitle="Confirm disconnect"
                      cancelTitle="Cancel"
                      onConfirm={() => confirmDelete(() => handleDelete(account.id))}
                      onCancel={cancelDelete}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
