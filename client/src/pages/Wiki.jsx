import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import * as api from '../services/api';
import { BookOpen, Search, Network, FileText, BarChart3, Activity } from 'lucide-react';
import PageSkeleton from '../components/ui/PageSkeleton';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';

import WikiOverviewTab from '../components/wiki/tabs/OverviewTab';
import WikiBrowseTab from '../components/wiki/tabs/BrowseTab';
import WikiSearchTab from '../components/wiki/tabs/SearchTab';
import WikiGraphTab from '../components/wiki/tabs/GraphTab';
import WikiLogTab from '../components/wiki/tabs/LogTab';

// Exported for the nav-manifest tab-coverage guard (server/lib/navManifest.test.js).
export const TABS = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'browse', label: 'Browse', icon: FileText },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'graph', label: 'Graph', icon: Network },
  { id: 'log', label: 'Log', icon: Activity }
];

export default function Wiki() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = tab || 'overview';
  // The selected vault lives in the URL (?vault=<id>) so reload/share/⌘K/voice restore it.
  const vaultParam = searchParams.get('vault');

  const [vaults, setVaults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState([]);

  const loadVaults = useCallback(async () => {
    const data = await api.getNotesVaults().catch(() => []);
    setVaults(data);
    setLoading(false);
  }, []);

  // Selection is derived FROM the URL: an explicit ?vault= wins, otherwise fall
  // back to the first vault. A param that matches no vault is a stale/deleted id.
  const selectedVault = useMemo(
    () => (vaultParam ? vaults.find(v => v.id === vaultParam) : vaults[0]) || null,
    [vaultParam, vaults]
  );
  const selectedVaultId = selectedVault?.id || null;
  const vaultNotFound = !loading && vaults.length > 0 && !!vaultParam && !selectedVault;

  // Selection handler writes the id to the URL; the tab route param is untouched.
  const selectVault = useCallback((id) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('vault', id);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const clearVaultParam = useCallback(() => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete('vault');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const loadNotes = useCallback(async () => {
    if (!selectedVaultId) return;
    const data = await api.scanNotesVault(selectedVaultId, { limit: 1000 }).catch(() => null);
    if (data) {
      setNotes(data.notes);
    }
  }, [selectedVaultId]);

  useEffect(() => {
    loadVaults();
  }, [loadVaults]);

  useEffect(() => {
    if (selectedVaultId) loadNotes();
  }, [selectedVaultId, loadNotes]);

  const wikiNotes = useMemo(() => notes.filter(n => n.folder?.startsWith('wiki')), [notes]);
  const rawNotes = useMemo(() => notes.filter(n => n.folder?.startsWith('raw') || n.path?.startsWith('raw/')), [notes]);

  const stats = useMemo(() => {
    const byFolder = {};
    for (const note of wikiNotes) {
      const parts = note.folder?.split('/') || [];
      const category = parts[1] || 'root';
      byFolder[category] = (byFolder[category] || 0) + 1;
    }
    return {
      total: wikiNotes.length,
      sources: byFolder.sources || 0,
      entities: byFolder.entities || 0,
      concepts: byFolder.concepts || 0,
      comparisons: byFolder.comparisons || 0,
      synthesis: byFolder.synthesis || 0,
      queries: byFolder.queries || 0,
      rawSources: rawNotes.length
    };
  }, [wikiNotes, rawNotes]);

  const handleRefresh = useCallback(() => {
    loadNotes();
  }, [loadNotes]);

  if (loading) {
    return (
      <PageSkeleton
        header="bar"
        label="Loading wiki"
        fullHeight
        // Browse owns its own list/detail scroll and takes no body padding.
        padded={activeTab !== 'browse'}
        bodyClassName="p-4"
        titleWidthClass="w-24"
        showSubtitle
        tabs={TABS.length}
        cards={3}
        sidebar={false}
      />
    );
  }

  if (vaults.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <BookOpen size={48} className="mb-3 opacity-30" />
        <p className="text-sm">No Obsidian vaults connected</p>
        <p className="text-xs mt-1">Go to Brain &gt; Notes to connect a vault first</p>
      </div>
    );
  }

  if (vaultNotFound) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <BookOpen size={48} className="mb-3 opacity-30" />
        <p className="text-sm">Vault not found</p>
        <p className="text-xs mt-1">The selected vault is no longer available.</p>
        <button
          type="button"
          onClick={clearVaultParam}
          className="mt-3 text-xs text-port-accent hover:underline"
        >
          Show default vault
        </button>
      </div>
    );
  }

  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return <WikiOverviewTab vaultId={selectedVaultId} stats={stats} notes={wikiNotes} allNotes={notes} onRefresh={handleRefresh} />;
      case 'browse':
        return <WikiBrowseTab vaultId={selectedVaultId} notes={wikiNotes} rawNotes={rawNotes} allNotes={notes} onRefresh={handleRefresh} />;
      case 'search':
        return <WikiSearchTab vaultId={selectedVaultId} onRefresh={handleRefresh} />;
      case 'graph':
        return <WikiGraphTab vaultId={selectedVaultId} />;
      case 'log':
        return <WikiLogTab vaultId={selectedVaultId} allNotes={notes} />;
      default:
        return <WikiOverviewTab vaultId={selectedVaultId} stats={stats} notes={wikiNotes} allNotes={notes} onRefresh={handleRefresh} />;
    }
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        icon={BookOpen}
        title="Wiki"
        subtitle="LLM-maintained knowledge base"
        actions={
          <>
            <span className="text-sm text-gray-500">{stats.total} wiki pages</span>
            <span className="text-sm text-gray-500">{stats.rawSources} sources</span>
            {vaults.length > 1 && (
              <select
                value={selectedVaultId || ''}
                onChange={e => selectVault(e.target.value)}
                className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
              >
                {vaults.map(v => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            )}
          </>
        }
      />

      <TabPills tabs={TABS} activeTab={activeTab} onChange={(id) => navigate({ pathname: `/wiki/${id}`, search: searchParams.toString() })} ariaLabel="Wiki sections" />

      {/* Tab content — Browse manages its own list/detail scroll, so it gets a
          bare flex-fill parent (no padding/scroll) instead of the padded scroller. */}
      <div className={activeTab === 'browse' ? 'flex-1 min-h-0 flex' : 'flex-1 overflow-auto p-4'}>
        {renderTabContent()}
      </div>
    </div>
  );
}
