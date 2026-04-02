import { useState, useEffect, useMemo } from 'react';
import toast from '../components/ui/Toast';
import {
  getGitHubRepos,
  syncGitHubRepos,
  updateGitHubRepo,
  getGitHubSecrets,
  setGitHubSecret,
  syncGitHubSecret,
  archiveGitHubRepo,
  unarchiveGitHubRepo
} from '../services/api';
import { timeAgo } from '../utils/formatters';

const FILTERS = ['all', 'npm', 'secrets', 'archived'];

export default function GitHub() {
  const [repos, setRepos] = useState({});
  const [secrets, setSecrets] = useState({});
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('recent'); // 'recent' | 'alpha'
  const [syncingSecret, setSyncingSecret] = useState(null);

  // Add secret form
  const [newSecretName, setNewSecretName] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');
  const [savingSecret, setSavingSecret] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(null); // { fullName, action: 'archive'|'unarchive' }
  const [archiving, setArchiving] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [reposData, secretsData] = await Promise.all([
      getGitHubRepos().catch(() => ({})),
      getGitHubSecrets().catch(() => ({}))
    ]);
    setRepos(reposData || {});
    setSecrets(secretsData || {});
    setLoading(false);
  };

  const handleSync = async () => {
    setSyncing(true);
    const result = await syncGitHubRepos().catch((err) => {
      toast.error(`Sync failed: ${err.message}`);
      return null;
    });
    if (result) {
      setRepos(result.repos || {});
      setLastSync(result.lastRepoSync);
      toast.success(`Synced ${Object.keys(result.repos || {}).length} repos`);
    }
    setSyncing(false);
  };

  const handleToggleNpm = async (fullName, currentValue) => {
    const updated = await updateGitHubRepo(fullName, {
      flags: { npmProject: !currentValue }
    }).catch((err) => {
      toast.error(`Update failed: ${err.message}`);
      return null;
    });
    if (updated) {
      setRepos(prev => ({ ...prev, [fullName]: updated }));
    }
  };

  const handleSaveSecret = async () => {
    if (!newSecretName.trim() || !newSecretValue) return;
    setSavingSecret(true);
    const result = await setGitHubSecret(newSecretName.trim(), newSecretValue).catch((err) => {
      toast.error(`Failed to save secret: ${err.message}`);
      return null;
    });
    if (result) {
      toast.success(`Secret ${newSecretName} saved. Synced to ${result.synced} repos${result.failed ? `, ${result.failed} failed` : ''}`);
      setNewSecretName('');
      setNewSecretValue('');
      // Reload secrets metadata
      const secretsData = await getGitHubSecrets().catch(() => ({}));
      setSecrets(secretsData || {});
    }
    setSavingSecret(false);
  };

  const handleSyncSecret = async (name) => {
    setSyncingSecret(name);
    const result = await syncGitHubSecret(name).catch((err) => {
      toast.error(`Sync failed: ${err.message}`);
      return null;
    });
    if (result) {
      toast.success(`${name} synced to ${result.synced} repos${result.failed ? `, ${result.failed} failed` : ''}`);
    }
    setSyncingSecret(null);
  };

  const handleArchiveClick = (fullName, isArchived) => {
    setArchiveConfirm({ fullName, action: isArchived ? 'unarchive' : 'archive' });
  };

  const handleArchiveConfirm = async () => {
    const { fullName, action } = archiveConfirm;
    setArchiveConfirm(null);
    setArchiving(fullName);
    const fn = action === 'archive' ? archiveGitHubRepo : unarchiveGitHubRepo;
    const updated = await fn(fullName).catch((err) => {
      toast.error(`Failed to ${action}: ${err.message}`);
      return null;
    });
    if (updated) {
      setRepos(prev => ({ ...prev, [fullName]: updated }));
      toast.success(`${action === 'archive' ? 'Archived' : 'Unarchived'} ${fullName}`);
    }
    setArchiving(null);
  };

  const repoList = useMemo(() => {
    let list = Object.values(repos);

    // Apply search
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.description?.toLowerCase().includes(q)
      );
    }

    // Apply filter
    if (filter === 'npm') {
      list = list.filter(r => r.flags?.npmProject);
    } else if (filter === 'secrets') {
      list = list.filter(r => r.managedSecrets?.length > 0);
    } else if (filter === 'archived') {
      list = list.filter(r => r.isArchived);
    }

    // Sort: active first, then by selected sort
    list.sort((a, b) => {
      if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1;
      if (sort === 'alpha') return a.name.localeCompare(b.name);
      return new Date(b.pushedAt || 0) - new Date(a.pushedAt || 0);
    });

    return list;
  }, [repos, search, filter, sort]);

  const secretEntries = Object.entries(secrets);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <div className="text-gray-400">Loading GitHub data...</div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <h1 className="text-xl sm:text-2xl font-bold text-white mb-6">GitHub Repos</h1>

      {/* Archive Confirmation Modal */}
      {archiveConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-4 sm:p-6 max-w-md w-full">
            <h3 className="text-lg font-bold text-white mb-4">
              {archiveConfirm.action === 'archive' ? 'Archive' : 'Unarchive'} Repository?
            </h3>
            <p className="text-gray-300 mb-6 text-sm break-words">
              {archiveConfirm.action === 'archive'
                ? `Archiving "${archiveConfirm.fullName}" will make it read-only on GitHub.`
                : `Unarchiving "${archiveConfirm.fullName}" will restore it to active status on GitHub.`
              }
            </p>
            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
              <button
                onClick={() => setArchiveConfirm(null)}
                className="w-full sm:w-auto px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleArchiveConfirm}
                className={`w-full sm:w-auto px-4 py-2 text-white rounded ${
                  archiveConfirm.action === 'archive'
                    ? 'bg-port-warning hover:bg-port-warning/80'
                    : 'bg-port-success hover:bg-port-success/80'
                }`}
              >
                {archiveConfirm.action === 'archive' ? 'Archive' : 'Unarchive'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Secrets Management */}
      <div className="bg-port-card rounded-lg border border-port-border p-4 sm:p-6 mb-6">
        <h2 className="text-lg font-bold text-white mb-4">Secrets Management</h2>

        {secretEntries.length > 0 && (
          <div className="space-y-2 mb-4">
            {secretEntries.map(([name, meta]) => (
              <div key={name} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 bg-port-bg rounded border border-port-border">
                <div>
                  <span className="text-white font-mono text-sm">{name}</span>
                  <span className={`ml-2 text-xs ${meta.hasValue ? 'text-port-success' : 'text-port-warning'}`}>
                    {meta.hasValue ? 'configured' : 'no value'}
                  </span>
                  {meta.updatedAt && (
                    <span className="ml-2 text-xs text-gray-500">
                      updated {timeAgo(meta.updatedAt)}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => handleSyncSecret(name)}
                  disabled={syncingSecret === name || !meta.hasValue}
                  className="px-3 py-1 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded disabled:opacity-50"
                >
                  {syncingSecret === name ? 'Syncing...' : 'Sync to Repos'}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={newSecretName}
            onChange={(e) => setNewSecretName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
            placeholder="SECRET_NAME"
            className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded text-white font-mono text-sm"
          />
          <input
            type="password"
            value={newSecretValue}
            onChange={(e) => setNewSecretValue(e.target.value)}
            placeholder="Secret value"
            className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          />
          <button
            onClick={handleSaveSecret}
            disabled={savingSecret || !newSecretName.trim() || !newSecretValue}
            className="px-4 py-2 bg-port-success hover:bg-port-success/80 text-white rounded text-sm disabled:opacity-50"
          >
            {savingSecret ? 'Saving...' : 'Save Secret'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Secrets are stored locally and pushed to repos via <code>gh secret set</code>. Stored values are never returned from the server.
        </p>
      </div>

      {/* Repo List */}
      <div className="bg-port-card rounded-lg border border-port-border p-4 sm:p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-white">Repositories</h2>
            {lastSync && (
              <span className="text-xs text-gray-500">Last sync: {timeAgo(lastSync)}</span>
            )}
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded text-sm disabled:opacity-50"
          >
            {syncing ? 'Syncing...' : 'Sync Repos'}
          </button>
        </div>

        {/* Search + Filter */}
        <div className="flex flex-col sm:flex-row gap-2 mb-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repos..."
            className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          />
          <div className="flex gap-1">
            {FILTERS.map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-2 text-sm rounded capitalize ${
                  filter === f
                    ? 'bg-port-accent text-white'
                    : 'bg-port-bg text-gray-400 hover:text-white border border-port-border'
                }`}
              >
                {f === 'npm' ? 'NPM Projects' : f === 'secrets' ? 'Has Secrets' : f === 'archived' ? 'Archived' : 'All'}
              </button>
            ))}
            <button
              onClick={() => setSort(s => s === 'recent' ? 'alpha' : 'recent')}
              className="px-3 py-2 text-sm rounded bg-port-bg text-gray-400 hover:text-white border border-port-border"
              title={`Sort by ${sort === 'recent' ? 'name' : 'recent activity'}`}
            >
              {sort === 'recent' ? 'A-Z' : 'Recent'}
            </button>
          </div>
        </div>

        {/* Repo count */}
        <p className="text-xs text-gray-500 mb-3">
          {repoList.length} repo{repoList.length !== 1 ? 's' : ''}
          {filter !== 'all' ? ` (filtered)` : ''}
        </p>

        {Object.keys(repos).length === 0 ? (
          <div className="text-center py-8">
            <p className="text-gray-400">No repos loaded yet.</p>
            <p className="text-gray-500 text-sm mt-1">Click "Sync Repos" to fetch from GitHub.</p>
          </div>
        ) : repoList.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-gray-400">No repos match your filter.</p>
          </div>
        ) : (
          <div className="space-y-1">
            {repoList.map(repo => (
              <div
                key={repo.fullName}
                className={`flex flex-col sm:flex-row sm:items-center gap-2 p-3 rounded border border-port-border ${
                  repo.isArchived ? 'opacity-50 bg-port-bg/50' : 'bg-port-bg'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <a
                      href={`https://github.com/${repo.fullName}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-white text-sm font-medium hover:text-port-accent truncate"
                    >
                      {repo.name}
                    </a>
                    {repo.isPrivate && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-purple-900/50 text-purple-400 border border-purple-800">private</span>
                    )}
                    {repo.isFork && (
                      <a
                        href={`https://github.com/${repo.forkSource}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs px-1.5 py-0.5 rounded bg-cyan-900/50 text-cyan-400 border border-cyan-800 hover:bg-cyan-900/70"
                        title={`Forked from ${repo.forkSource}`}
                      >
                        fork: {repo.forkSource}
                      </a>
                    )}
                    {repo.isArchived && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">archived</span>
                    )}
                    {repo.flags?.npmProject && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-red-900/50 text-red-400 border border-red-800">npm</span>
                    )}
                    {repo.managedSecrets?.map(s => (
                      <span key={s} className="text-xs px-1.5 py-0.5 rounded bg-port-accent/10 text-port-accent border border-port-accent/30">
                        {s}
                      </span>
                    ))}
                  </div>
                  {repo.description && (
                    <p className="text-xs text-gray-500 mt-0.5 truncate">{repo.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-gray-500">{timeAgo(repo.pushedAt)}</span>
                  {!repo.isArchived && (
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!repo.flags?.npmProject}
                        onChange={() => handleToggleNpm(repo.fullName, repo.flags?.npmProject)}
                        className="w-4 h-4 rounded border-gray-600 bg-port-bg text-port-accent focus:ring-port-accent"
                      />
                      <span className="text-xs text-gray-400">NPM</span>
                    </label>
                  )}
                  <button
                    onClick={() => handleArchiveClick(repo.fullName, repo.isArchived)}
                    disabled={archiving === repo.fullName}
                    className={`px-2 py-1 text-xs rounded ${
                      repo.isArchived
                        ? 'bg-port-success/20 text-port-success hover:bg-port-success/30 border border-port-success/30'
                        : 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30 border border-port-warning/30'
                    } disabled:opacity-50`}
                  >
                    {archiving === repo.fullName ? '...' : repo.isArchived ? 'Unarchive' : 'Archive'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="bg-port-card rounded-lg border border-port-border p-4 sm:p-6">
        <h2 className="text-base font-bold text-white mb-3">How it works</h2>
        <div className="space-y-2 text-xs sm:text-sm text-gray-300">
          <p>1. Click "Sync Repos" to fetch your GitHub repos via <code>gh repo list</code></p>
          <p>2. Toggle "NPM" on repos that publish to npm &mdash; this auto-adds NPM_TOKEN to their managed secrets</p>
          <p>3. Add secrets (like NPM_TOKEN) with their values &mdash; values are stored locally, never in the browser</p>
          <p>4. Click "Sync to Repos" to push secrets to all flagged repos via <code>gh secret set</code></p>
          <p className="text-gray-500 mt-2">
            Requires <code>gh</code> CLI authenticated with repo and admin:org scope.
          </p>
        </div>
      </div>
    </div>
  );
}
