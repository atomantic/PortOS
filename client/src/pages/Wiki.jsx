import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../services/api';
import { BookOpen, Search, Network, FileText, BarChart3, RefreshCw, Activity } from 'lucide-react';

import WikiOverviewTab from '../components/wiki/tabs/OverviewTab';
import WikiBrowseTab from '../components/wiki/tabs/BrowseTab';
import WikiSearchTab from '../components/wiki/tabs/SearchTab';
import WikiGraphTab from '../components/wiki/tabs/GraphTab';
import WikiLogTab from '../components/wiki/tabs/LogTab';

const TABS = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'browse', label: 'Browse', icon: FileText },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'graph', label: 'Graph', icon: Network },
  { id: 'log', label: 'Log', icon: Activity }
];

export default function Wiki() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'overview';

  const [vaults, setVaults] = useState([]);
  const [selectedVaultId, setSelectedVaultId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState([]);

  const loadVaults = useCallback(async () => {
    const data = await api.getNotesVaults().catch(() => []);
    setVaults(data);
    if (data.length > 0) {
      setSelectedVaultId(prev => prev || data[0].id);
    }
    setLoading(false);
  }, []);

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
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="w-8 h-8 text-port-accent animate-spin" />
      </div>
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
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-port-border">
        <div className="flex items-center gap-3">
          <BookOpen className="w-8 h-8 text-port-accent" />
          <div>
            <h1 className="text-xl font-bold text-white">Wiki</h1>
            <p className="text-sm text-gray-500">LLM-maintained knowledge base</p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-sm">
          <span className="text-gray-500">{stats.total} wiki pages</span>
          <span className="text-gray-500">{stats.rawSources} sources</span>
          {vaults.length > 1 && (
            <select
              value={selectedVaultId || ''}
              onChange={e => setSelectedVaultId(e.target.value)}
              className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
            >
              {vaults.map(v => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Tab navigation */}
      <div className="flex border-b border-port-border">
        {TABS.map((tabItem) => {
          const Icon = tabItem.icon;
          const isActive = activeTab === tabItem.id;
          return (
            <button
              key={tabItem.id}
              onClick={() => navigate(`/wiki/${tabItem.id}`)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                isActive
                  ? 'text-port-accent border-b-2 border-port-accent bg-port-accent/5'
                  : 'text-gray-400 hover:text-white hover:bg-port-card'
              }`}
              role="tab"
              aria-selected={isActive}
            >
              <Icon size={16} aria-hidden="true" />
              {tabItem.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-4">
        {renderTabContent()}
      </div>
    </div>
  );
}
