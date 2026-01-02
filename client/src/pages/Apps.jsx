import { useState, useEffect, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Play, Square, RotateCcw, FolderOpen, Terminal, Code } from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import * as api from '../services/api';

export default function Apps() {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingApp, setEditingApp] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [actionLoading, setActionLoading] = useState({});

  const fetchApps = async () => {
    const data = await api.getApps().catch(() => []);
    setApps(data);
    setLoading(false);
  };

  useEffect(() => {
    fetchApps();
    const interval = setInterval(fetchApps, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleDelete = async (app) => {
    await api.deleteApp(app.id);
    setConfirmingDelete(null);
    fetchApps();
  };

  const handleStart = async (app) => {
    setActionLoading(prev => ({ ...prev, [app.id]: 'start' }));
    await api.startApp(app.id).catch(() => null);
    setTimeout(() => {
      setActionLoading(prev => ({ ...prev, [app.id]: null }));
      fetchApps();
    }, 1500);
  };

  const handleStop = async (app) => {
    setActionLoading(prev => ({ ...prev, [app.id]: 'stop' }));
    await api.stopApp(app.id).catch(() => null);
    setTimeout(() => {
      setActionLoading(prev => ({ ...prev, [app.id]: null }));
      fetchApps();
    }, 1500);
  };

  const handleRestart = async (app) => {
    setActionLoading(prev => ({ ...prev, [app.id]: 'restart' }));
    await api.restartApp(app.id).catch(() => null);
    setTimeout(() => {
      setActionLoading(prev => ({ ...prev, [app.id]: null }));
      fetchApps();
    }, 2000);
  };

  const toggleExpand = (id) => {
    setExpandedId(prev => prev === id ? null : id);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Apps</h2>
          <p className="text-gray-500">Manage registered applications</p>
        </div>
        <Link
          to="/create"
          className="px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
        >
          + Add App
        </Link>
      </div>

      {/* Table */}
      {apps.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-xl p-12 text-center">
          <div className="text-4xl mb-4">📦</div>
          <h3 className="text-xl font-semibold text-white mb-2">No apps registered</h3>
          <p className="text-gray-500 mb-6">Add your first app to get started</p>
          <Link
            to="/create"
            className="inline-block px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
          >
            Add App
          </Link>
        </div>
      ) : (
        <div className="bg-port-card border border-port-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-port-border/50">
                <tr>
                  <th className="w-8 px-4 py-3"></th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Name</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Ports</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Status</th>
                  <th className="text-center px-4 py-3 text-sm font-medium text-gray-400">Controls</th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-port-border">
                {apps.map(app => (
                  <Fragment key={app.id}>
                    <tr className="hover:bg-port-border/30">
                      <td className="px-4 py-3">
                        <button
                          onClick={() => toggleExpand(app.id)}
                          className="text-gray-400 hover:text-white transition-transform"
                        >
                          <span className={`inline-block transition-transform ${expandedId === app.id ? 'rotate-90' : ''}`}>▶</span>
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{app.name}</div>
                        <div className="text-xs text-gray-500">
                          {(app.pm2ProcessNames || []).join(', ')}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <div className="flex items-center gap-3">
                          {app.uiPort && (
                            <button
                              onClick={() => window.open(`${window.location.protocol}//${window.location.hostname}:${app.uiPort}`, '_blank')}
                              className="text-cyan-400 hover:text-cyan-300 font-mono flex items-center gap-1"
                              title={`Open UI at ${window.location.hostname}:${app.uiPort}`}
                            >
                              :{app.uiPort} <ExternalLink size={12} />
                            </button>
                          )}
                          {app.apiPort && (
                            <span className="text-gray-400 font-mono">API:{app.apiPort}</span>
                          )}
                          {!app.uiPort && !app.apiPort && <span className="text-gray-500">-</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={app.overallStatus} size="sm" />
                      </td>
                      <td className="px-4 py-3">
                        {/* Start/Stop/Restart Button Group */}
                        <div className="flex justify-center">
                          <div className="inline-flex rounded-lg overflow-hidden border border-port-border">
                            {app.overallStatus === 'online' ? (
                              <>
                                <button
                                  onClick={() => handleStop(app)}
                                  disabled={actionLoading[app.id]}
                                  className="px-3 py-1.5 bg-port-error/20 text-port-error hover:bg-port-error/30 transition-colors disabled:opacity-50 flex items-center gap-1"
                                  title="Stop"
                                >
                                  <Square size={14} />
                                  <span className="text-xs">Stop</span>
                                </button>
                                <button
                                  onClick={() => handleRestart(app)}
                                  disabled={actionLoading[app.id]}
                                  className="px-3 py-1.5 bg-port-warning/20 text-port-warning hover:bg-port-warning/30 transition-colors disabled:opacity-50 border-l border-port-border flex items-center gap-1"
                                  title="Restart"
                                >
                                  <RotateCcw size={14} className={actionLoading[app.id] === 'restart' ? 'animate-spin' : ''} />
                                  <span className="text-xs">Restart</span>
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => handleStart(app)}
                                disabled={actionLoading[app.id]}
                                className="px-3 py-1.5 bg-port-success/20 text-port-success hover:bg-port-success/30 transition-colors disabled:opacity-50 flex items-center gap-1"
                                title="Start"
                              >
                                <Play size={14} />
                                <span className="text-xs">{actionLoading[app.id] === 'start' ? 'Starting...' : 'Start'}</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {confirmingDelete === app.id ? (
                          <div className="flex items-center justify-end gap-2">
                            <span className="text-xs text-gray-400">Remove?</span>
                            <div className="inline-flex rounded-lg overflow-hidden border border-port-border">
                              <button
                                onClick={() => handleDelete(app)}
                                className="px-2 py-1 bg-port-error/20 text-port-error hover:bg-port-error/30 text-xs"
                              >
                                Yes
                              </button>
                              <button
                                onClick={() => setConfirmingDelete(null)}
                                className="px-2 py-1 bg-port-border/50 text-gray-400 hover:text-white text-xs border-l border-port-border"
                              >
                                No
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="inline-flex rounded-lg overflow-hidden border border-port-border">
                            <button
                              onClick={() => setEditingApp(app)}
                              className="px-3 py-1.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors text-xs"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => setConfirmingDelete(app.id)}
                              className="px-3 py-1.5 bg-port-error/10 text-port-error hover:bg-port-error/20 transition-colors text-xs border-l border-port-border"
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>

                    {/* Expanded Details Row */}
                    {expandedId === app.id && (
                      <tr>
                        <td colSpan={6} className="p-0">
                          <div className="bg-port-bg border-t border-port-border">
                            <div className="px-6 py-4 space-y-4">
                              {/* Details Grid */}
                              <div className="grid grid-cols-2 gap-6">
                                <div>
                                  <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Repository Path</div>
                                  <div className="flex items-center gap-2">
                                    <FolderOpen size={16} className="text-yellow-400" />
                                    <code className="text-sm text-gray-300 font-mono">{app.repoPath}</code>
                                  </div>
                                </div>
                                <div>
                                  <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Editor Command</div>
                                  <div className="flex items-center gap-2">
                                    <Code size={16} className="text-blue-400" />
                                    <code className="text-sm text-gray-300 font-mono">{app.editorCommand || 'code .'}</code>
                                  </div>
                                </div>
                              </div>

                              {/* Start Commands */}
                              {app.startCommands?.length > 0 && (
                                <div>
                                  <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Start Commands</div>
                                  <div className="bg-port-card border border-port-border rounded-lg p-3">
                                    {app.startCommands.map((cmd, i) => (
                                      <div key={i} className="flex items-center gap-2 py-1">
                                        <Terminal size={14} className="text-green-400" />
                                        <code className="text-sm text-cyan-300 font-mono">{cmd}</code>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* PM2 Processes Status */}
                              {app.pm2Status && Object.keys(app.pm2Status).length > 0 && (
                                <div>
                                  <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">PM2 Processes</div>
                                  <div className="flex flex-wrap gap-2">
                                    {Object.values(app.pm2Status).map((proc, i) => (
                                      <div
                                        key={i}
                                        className="flex items-center gap-2 px-3 py-1.5 bg-port-card border border-port-border rounded-lg"
                                      >
                                        <span className={`w-2 h-2 rounded-full ${
                                          proc.status === 'online' ? 'bg-port-success' :
                                          proc.status === 'stopped' ? 'bg-gray-500' : 'bg-port-error'
                                        }`} />
                                        <span className="text-sm text-white font-mono">{proc.name}</span>
                                        <span className="text-xs text-gray-500">{proc.status}</span>
                                        {proc.cpu !== undefined && (
                                          <span className="text-xs text-green-400">{proc.cpu}%</span>
                                        )}
                                        {proc.memory !== undefined && (
                                          <span className="text-xs text-blue-400">{(proc.memory / 1024 / 1024).toFixed(0)}MB</span>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Quick Actions */}
                              <div className="flex gap-2 pt-2">
                                <button
                                  onClick={() => api.openAppInEditor(app.id).catch(() => null)}
                                  className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
                                >
                                  <Code size={14} /> Open in Editor
                                </button>
                                <button
                                  onClick={() => api.openAppFolder(app.id).catch(() => null)}
                                  className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
                                >
                                  <FolderOpen size={14} /> Open Folder
                                </button>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingApp && (
        <EditAppModal
          app={editingApp}
          onClose={() => setEditingApp(null)}
          onSave={() => { setEditingApp(null); fetchApps(); }}
        />
      )}
    </div>
  );
}

function EditAppModal({ app, onClose, onSave }) {
  const [formData, setFormData] = useState({
    name: app.name,
    repoPath: app.repoPath,
    uiPort: app.uiPort || '',
    apiPort: app.apiPort || '',
    startCommands: (app.startCommands || []).join('\n'),
    pm2ProcessNames: (app.pm2ProcessNames || []).join(', '),
    editorCommand: app.editorCommand || 'code .'
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSaving(true);

    const data = {
      name: formData.name,
      repoPath: formData.repoPath,
      uiPort: formData.uiPort ? parseInt(formData.uiPort) : null,
      apiPort: formData.apiPort ? parseInt(formData.apiPort) : null,
      startCommands: formData.startCommands.split('\n').filter(Boolean),
      pm2ProcessNames: formData.pm2ProcessNames
        ? formData.pm2ProcessNames.split(',').map(s => s.trim()).filter(Boolean)
        : undefined,
      editorCommand: formData.editorCommand || undefined
    };

    await api.updateApp(app.id, data).catch(err => {
      setError(err.message);
      setSaving(false);
      throw err;
    });

    setSaving(false);
    onSave();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-port-card border border-port-border rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-auto">
        <h2 className="text-xl font-bold text-white mb-4">Edit App</h2>

        {error && (
          <div className="mb-4 p-3 bg-port-error/20 border border-port-error rounded-lg text-port-error text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={e => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
              required
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Repository Path</label>
            <input
              type="text"
              value={formData.repoPath}
              onChange={e => setFormData({ ...formData, repoPath: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">UI Port</label>
              <input
                type="number"
                value={formData.uiPort}
                onChange={e => setFormData({ ...formData, uiPort: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                placeholder="3000"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">API Port</label>
              <input
                type="number"
                value={formData.apiPort}
                onChange={e => setFormData({ ...formData, apiPort: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                placeholder="3001"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Start Commands (one per line)</label>
            <textarea
              value={formData.startCommands}
              onChange={e => setFormData({ ...formData, startCommands: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none font-mono text-sm"
              rows={2}
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">PM2 Process Names (comma-separated)</label>
            <input
              type="text"
              value={formData.pm2ProcessNames}
              onChange={e => setFormData({ ...formData, pm2ProcessNames: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Editor Command</label>
            <input
              type="text"
              value={formData.editorCommand}
              onChange={e => setFormData({ ...formData, editorCommand: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
