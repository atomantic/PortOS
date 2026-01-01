import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import StatusBadge from '../components/StatusBadge';
import * as api from '../services/api';

export default function Apps() {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingApp, setEditingApp] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(null);

  const fetchApps = async () => {
    const data = await api.getApps().catch(() => []);
    setApps(data);
    setLoading(false);
  };

  useEffect(() => {
    fetchApps();
  }, []);

  const handleDelete = async (app) => {
    await api.deleteApp(app.id);
    setConfirmingDelete(null);
    fetchApps();
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
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Name</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Path</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Ports</th>
                  <th className="text-left px-4 py-3 text-sm font-medium text-gray-400">Status</th>
                  <th className="text-right px-4 py-3 text-sm font-medium text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-port-border">
                {apps.map(app => (
                  <tr key={app.id} className="hover:bg-port-border/30">
                    <td className="px-4 py-3">
                      <div className="font-medium text-white">{app.name}</div>
                      <div className="text-xs text-gray-500">
                        {(app.pm2ProcessNames || []).join(', ')}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm text-gray-400 truncate max-w-xs" title={app.repoPath}>
                        {app.repoPath}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-400">
                      {app.uiPort && <span className="mr-2">UI: {app.uiPort}</span>}
                      {app.apiPort && <span>API: {app.apiPort}</span>}
                      {!app.uiPort && !app.apiPort && '-'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={app.overallStatus} size="sm" />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {confirmingDelete === app.id ? (
                        <div className="flex items-center justify-end gap-2">
                          <span className="text-xs text-gray-400">Remove from PortOS?</span>
                          <button
                            onClick={() => handleDelete(app)}
                            className="text-sm px-2 py-1 bg-port-error/20 text-port-error hover:bg-port-error/30 rounded"
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => setConfirmingDelete(null)}
                            className="text-sm px-2 py-1 text-gray-400 hover:text-white"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={() => setEditingApp(app)}
                            className="text-sm text-port-accent hover:text-port-accent/80 mr-3"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => setConfirmingDelete(app.id)}
                            className="text-sm text-port-error hover:text-port-error/80"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
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
