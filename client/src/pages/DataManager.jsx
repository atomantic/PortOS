import { useState, useEffect, useCallback } from 'react';
import { HardDrive, RefreshCw, Archive, Trash2, ChevronDown, ChevronRight, FolderOpen, File, AlertTriangle, Download, Package } from 'lucide-react';
import * as api from '../services/api';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function SizeBar({ size, maxSize }) {
  const pct = maxSize > 0 ? Math.max(1, (size / maxSize) * 100) : 0;
  const color = pct > 60 ? 'bg-port-warning' : pct > 30 ? 'bg-port-accent' : 'bg-port-success';
  return (
    <div className="w-full h-1.5 bg-port-border/50 rounded-full overflow-hidden">
      <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

function CategoryRow({ cat, maxSize, onExpand, expanded, detail, onArchive, onPurge, archiving, purging }) {
  return (
    <div className="border border-port-border rounded-lg overflow-hidden">
      <button
        onClick={() => onExpand(cat.key)}
        className="w-full flex items-center gap-3 p-3 hover:bg-port-card/50 transition-colors text-left"
      >
        {expanded ? <ChevronDown size={14} className="text-gray-500 shrink-0" /> : <ChevronRight size={14} className="text-gray-500 shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white">{cat.label}</span>
            <span className="text-xs text-gray-500">{cat.description}</span>
          </div>
          <div className="mt-1">
            <SizeBar size={cat.size} maxSize={maxSize} />
          </div>
        </div>
        <div className="text-right shrink-0 ml-2">
          <div className="text-sm font-mono text-white">{formatBytes(cat.size)}</div>
          <div className="text-xs text-gray-500">{cat.fileCount.toLocaleString()} files</div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-port-border bg-port-bg/50">
          {/* Actions */}
          <div className="flex items-center gap-2 p-3 border-b border-port-border/50">
            {cat.archivable && (
              <button
                onClick={() => onArchive(cat.key)}
                disabled={archiving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-port-accent/10 text-port-accent rounded hover:bg-port-accent/20 transition-colors disabled:opacity-50"
              >
                <Archive size={12} />
                {archiving ? 'Archiving...' : 'Archive'}
              </button>
            )}
            {cat.deletable && (
              <button
                onClick={() => onPurge(cat.key)}
                disabled={purging}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-port-error/10 text-port-error rounded hover:bg-port-error/20 transition-colors disabled:opacity-50"
              >
                <Trash2 size={12} />
                {purging ? 'Purging...' : 'Purge'}
              </button>
            )}
            {!cat.archivable && !cat.deletable && (
              <span className="text-xs text-gray-500">This category is protected and cannot be archived or deleted</span>
            )}
          </div>

          {/* Detail items */}
          {detail ? (
            <div className="max-h-64 overflow-auto">
              {detail.items.length === 0 ? (
                <div className="p-3 text-xs text-gray-500">Empty</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-port-border/30">
                      <th className="text-left p-2 pl-3 font-medium">Name</th>
                      <th className="text-right p-2 font-medium">Size</th>
                      <th className="text-right p-2 pr-3 font-medium">Files</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map(item => (
                      <tr key={item.name} className="border-b border-port-border/20 hover:bg-port-card/30">
                        <td className="p-2 pl-3 text-gray-300 flex items-center gap-1.5">
                          {item.type === 'directory' ? <FolderOpen size={11} className="text-port-accent shrink-0" /> : <File size={11} className="text-gray-500 shrink-0" />}
                          <span className="truncate">{item.name}</span>
                        </td>
                        <td className="p-2 text-right text-gray-400 font-mono">{formatBytes(item.size)}</td>
                        <td className="p-2 pr-3 text-right text-gray-500">{item.type === 'directory' ? item.fileCount?.toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : (
            <div className="p-3 flex items-center gap-2 text-xs text-gray-500">
              <RefreshCw size={11} className="animate-spin" /> Loading...
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BackupsSection({ backups, loading, onDelete, onRefresh }) {
  if (loading) return null;
  if (!backups.length) return null;

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-3">
        <Package size={16} className="text-port-accent" />
        <h2 className="text-sm font-semibold text-white">Backup Archives</h2>
        <span className="text-xs text-gray-500">{backups.length} archives</span>
      </div>
      <div className="border border-port-border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-port-border/30 bg-port-card/30">
              <th className="text-left p-2 pl-3 font-medium">Archive</th>
              <th className="text-right p-2 font-medium">Size</th>
              <th className="text-right p-2 font-medium">Created</th>
              <th className="text-right p-2 pr-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {backups.map(b => (
              <tr key={b.name} className="border-b border-port-border/20 hover:bg-port-card/30">
                <td className="p-2 pl-3 text-gray-300 flex items-center gap-1.5">
                  <Archive size={11} className="text-port-accent shrink-0" />
                  <span className="truncate">{b.name}</span>
                </td>
                <td className="p-2 text-right text-gray-400 font-mono">{formatBytes(b.size)}</td>
                <td className="p-2 text-right text-gray-500">{b.created ? new Date(b.created).toLocaleDateString() : '—'}</td>
                <td className="p-2 pr-3 text-right">
                  <button
                    onClick={() => onDelete(b.name)}
                    className="text-gray-500 hover:text-port-error transition-colors"
                    title="Delete backup"
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function DataManager() {
  const [overview, setOverview] = useState(null);
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedCat, setExpandedCat] = useState(null);
  const [detail, setDetail] = useState(null);
  const [archiving, setArchiving] = useState(null);
  const [purging, setPurging] = useState(null);
  const [confirmPurge, setConfirmPurge] = useState(null);

  const fetchOverview = useCallback(async () => {
    const [data, bk] = await Promise.all([
      api.getDataOverview().catch(() => null),
      api.getDataBackups().catch(() => [])
    ]);
    setOverview(data);
    setBackups(bk);
    setLoading(false);
  }, []);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);

  const handleExpand = async (key) => {
    if (expandedCat === key) {
      setExpandedCat(null);
      setDetail(null);
      return;
    }
    setExpandedCat(key);
    setDetail(null);
    const d = await api.getDataCategory(key).catch(() => null);
    setDetail(d);
  };

  const handleArchive = async (key) => {
    setArchiving(key);
    const result = await api.archiveDataCategory(key).catch(err => {
      console.error(`Archive failed: ${err.message}`);
      return null;
    });
    setArchiving(null);
    if (result) {
      fetchOverview();
      if (expandedCat === key) {
        const d = await api.getDataCategory(key).catch(() => null);
        setDetail(d);
      }
    }
  };

  const handlePurge = (key) => {
    if (confirmPurge === key) {
      executePurge(key);
    } else {
      setConfirmPurge(key);
      setTimeout(() => setConfirmPurge(null), 5000);
    }
  };

  const executePurge = async (key) => {
    setPurging(key);
    setConfirmPurge(null);
    await api.purgeDataCategory(key).catch(err => {
      console.error(`Purge failed: ${err.message}`);
    });
    setPurging(null);
    fetchOverview();
    if (expandedCat === key) {
      const d = await api.getDataCategory(key).catch(() => null);
      setDetail(d);
    }
  };

  const handleDeleteBackup = async (filename) => {
    await api.deleteDataBackup(filename).catch(() => null);
    setBackups(prev => prev.filter(b => b.name !== filename));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="w-8 h-8 text-port-accent animate-spin" />
      </div>
    );
  }

  const maxSize = overview?.categories?.[0]?.size || 1;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-port-border">
        <div className="flex items-center gap-3">
          <HardDrive className="w-8 h-8 text-port-accent" />
          <div>
            <h1 className="text-xl font-bold text-white">Data Manager</h1>
            <p className="text-sm text-gray-500">Storage visibility, archiving, and cleanup</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-lg font-mono font-bold text-white">{formatBytes(overview?.totalSize || 0)}</div>
            <div className="text-xs text-gray-500">total in <code className="text-gray-400">{overview?.dataDir}/</code></div>
          </div>
          <button
            onClick={() => { setLoading(true); fetchOverview(); }}
            className="p-2 text-gray-400 hover:text-white hover:bg-port-card rounded transition-colors"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="bg-port-card rounded-lg p-3 border border-port-border">
            <div className="text-xs text-gray-500 mb-1">Categories</div>
            <div className="text-lg font-bold text-white">{overview?.categories?.length || 0}</div>
          </div>
          <div className="bg-port-card rounded-lg p-3 border border-port-border">
            <div className="text-xs text-gray-500 mb-1">Total Size</div>
            <div className="text-lg font-bold text-white">{formatBytes(overview?.totalSize || 0)}</div>
          </div>
          <div className="bg-port-card rounded-lg p-3 border border-port-border">
            <div className="text-xs text-gray-500 mb-1">Largest</div>
            <div className="text-lg font-bold text-white">{overview?.categories?.[0]?.label || '—'}</div>
            <div className="text-xs text-gray-500">{formatBytes(overview?.categories?.[0]?.size || 0)}</div>
          </div>
          <div className="bg-port-card rounded-lg p-3 border border-port-border">
            <div className="text-xs text-gray-500 mb-1">Backups</div>
            <div className="text-lg font-bold text-white">{backups.length}</div>
          </div>
        </div>

        {/* Category list */}
        <div className="space-y-2">
          {overview?.categories?.map(cat => (
            <CategoryRow
              key={cat.key}
              cat={cat}
              maxSize={maxSize}
              expanded={expandedCat === cat.key}
              detail={expandedCat === cat.key ? detail : null}
              onExpand={handleExpand}
              onArchive={handleArchive}
              onPurge={confirmPurge === cat.key
                ? handlePurge
                : handlePurge}
              archiving={archiving === cat.key}
              purging={purging === cat.key}
            />
          ))}
        </div>

        {/* Confirm purge banner */}
        {confirmPurge && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-port-error/90 text-white px-4 py-2 rounded-lg flex items-center gap-3 text-sm shadow-lg z-50">
            <AlertTriangle size={16} />
            <span>Click Purge again to confirm deletion of <strong>{confirmPurge}</strong></span>
          </div>
        )}

        {/* Backups section */}
        <BackupsSection
          backups={backups}
          loading={loading}
          onDelete={handleDeleteBackup}
          onRefresh={fetchOverview}
        />
      </div>
    </div>
  );
}
