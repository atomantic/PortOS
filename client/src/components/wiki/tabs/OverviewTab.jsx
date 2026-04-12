import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../../../services/api';
import { FolderOpen, RefreshCw, AlertTriangle } from 'lucide-react';
import { timeAgo } from '../../../utils/formatters';
import { WIKI_CATEGORIES, PageTypeIcon } from '../constants.jsx';

export default function OverviewTab({ vaultId, stats, notes, allNotes, onRefresh }) {
  const navigate = useNavigate();
  const [lintReport, setLintReport] = useState(null);
  const [loadingLint, setLoadingLint] = useState(false);

  const lintExists = allNotes?.some(n => n.path === 'wiki/lint-report.md');

  useEffect(() => {
    if (lintExists) loadLintReport();
    else setLintReport(null);
  }, [vaultId, lintExists]);

  const loadLintReport = async () => {
    setLoadingLint(true);
    const data = await api.getNote(vaultId, 'wiki/lint-report.md').catch(() => null);
    setLintReport(data?.error ? null : data);
    setLoadingLint(false);
  };

  const recentPages = useMemo(() =>
    [...notes].sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt)).slice(0, 10),
    [notes]
  );

  return (
    <div className="space-y-6">
      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <div className="bg-port-card border border-port-border rounded-lg p-4 text-center">
          <FolderOpen className="w-5 h-5 text-gray-400 mx-auto mb-1" />
          <div className="text-2xl font-bold text-white">{stats.rawSources}</div>
          <div className="text-xs text-gray-500">Raw Sources</div>
        </div>
        {WIKI_CATEGORIES.map(cat => (
          <div key={cat.key} className="bg-port-card border border-port-border rounded-lg p-4 text-center">
            <cat.icon className={`w-5 h-5 text-${cat.color} mx-auto mb-1`} />
            <div className="text-2xl font-bold text-white">{stats[cat.key]}</div>
            <div className="text-xs text-gray-500">{cat.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent activity */}
        <div className="bg-port-card border border-port-border rounded-lg">
          <div className="px-4 py-3 border-b border-port-border flex items-center justify-between">
            <h3 className="text-sm font-medium text-white">Recent Activity</h3>
            <button onClick={onRefresh} className="text-gray-500 hover:text-white">
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="divide-y divide-port-border/50">
            {recentPages.length === 0 ? (
              <div className="p-4 text-center text-gray-500 text-sm">No wiki pages yet</div>
            ) : recentPages.map(note => (
              <button
                key={note.path}
                onClick={() => navigate('/wiki/browse', { state: { openNote: note.path } })}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-port-bg/50 transition-colors"
              >
                <PageTypeIcon folder={note.folder} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{note.name}</div>
                  <div className="text-xs text-gray-500">{note.folder}</div>
                </div>
                <span className="text-xs text-gray-500 shrink-0">{timeAgo(note.modifiedAt)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Lint report / health */}
        <div className="bg-port-card border border-port-border rounded-lg">
          <div className="px-4 py-3 border-b border-port-border flex items-center justify-between">
            <h3 className="text-sm font-medium text-white">Health Report</h3>
            {lintReport && (
              <span className="text-xs text-gray-500">Updated {timeAgo(lintReport.modifiedAt)}</span>
            )}
          </div>
          <div className="p-4">
            {loadingLint ? (
              <div className="flex items-center justify-center h-20">
                <RefreshCw size={16} className="animate-spin text-port-accent" />
              </div>
            ) : lintReport ? (
              <div className="text-sm text-gray-300 whitespace-pre-wrap max-h-64 overflow-auto font-mono text-xs leading-relaxed">
                {lintReport.body?.slice(0, 2000) || 'Report empty'}
              </div>
            ) : (
              <div className="text-center py-6">
                <AlertTriangle size={24} className="text-gray-600 mx-auto mb-2" />
                <p className="text-sm text-gray-500">No lint report yet</p>
                <p className="text-xs text-gray-600 mt-1">The weekly wiki maintenance job will generate one, or ask the LLM to lint the wiki</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-white mb-3">How to Use</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-gray-400">
          <div>
            <span className="text-port-accent font-medium">Ingest:</span> Drop markdown files into <code className="text-gray-300">raw/</code> in Obsidian, then ask Claude to ingest them
          </div>
          <div>
            <span className="text-port-accent font-medium">Query:</span> Ask questions about the wiki content — answers can be filed back as wiki pages
          </div>
          <div>
            <span className="text-port-accent font-medium">Lint:</span> Ask Claude to health-check the wiki, or let the scheduled job handle it
          </div>
        </div>
      </div>
    </div>
  );
}
