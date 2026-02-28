import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, GitBranch } from 'lucide-react';
import IconPicker from '../IconPicker';
import * as api from '../../services/api';

export default function EditAppModal({ app, onClose, onSave }) {
  const [formData, setFormData] = useState({
    name: app.name,
    icon: app.icon || 'package',
    repoPath: app.repoPath,
    uiPort: app.uiPort || '',
    apiPort: app.apiPort || '',
    startCommands: (app.startCommands || []).join('\n'),
    pm2ProcessNames: (app.pm2ProcessNames || []).join(', '),
    editorCommand: app.editorCommand || 'code .',
    defaultUseWorktree: app.defaultUseWorktree || false,
    jiraEnabled: app.jira?.enabled || false,
    jiraInstanceId: app.jira?.instanceId || '',
    jiraProjectKey: app.jira?.projectKey || '',
    jiraBoardId: app.jira?.boardId || '',
    jiraIssueType: app.jira?.issueType || 'Task',
    jiraLabels: (app.jira?.labels || []).join(', '),
    jiraAssignee: app.jira?.assignee || '',
    jiraEpicKey: app.jira?.epicKey || '',
    jiraCreatePR: app.jira?.createPR !== false
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [jiraExpanded, setJiraExpanded] = useState(app.jira?.enabled || false);
  const [jiraInstances, setJiraInstances] = useState([]);
  const [jiraProjects, setJiraProjects] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);

  useEffect(() => {
    api.getJiraInstances().then(data => {
      const instances = data?.instances ? Object.values(data.instances) : [];
      setJiraInstances(instances);
    }).catch(() => setJiraInstances([]));
  }, []);

  useEffect(() => {
    if (!formData.jiraInstanceId) {
      setJiraProjects([]);
      return;
    }
    setLoadingProjects(true);
    api.getJiraProjects(formData.jiraInstanceId).then(projects => {
      setJiraProjects(projects || []);
    }).catch(() => setJiraProjects([])).finally(() => setLoadingProjects(false));
  }, [formData.jiraInstanceId]);

  useEffect(() => {
    if (!formData.jiraInstanceId || formData.jiraAssignee) return;
    const inst = jiraInstances.find(i => i.id === formData.jiraInstanceId);
    if (inst?.email) {
      setFormData(prev => ({ ...prev, jiraAssignee: inst.email }));
    }
  }, [formData.jiraInstanceId, jiraInstances, formData.jiraAssignee]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSaving(true);

    const data = {
      name: formData.name,
      icon: formData.icon,
      repoPath: formData.repoPath,
      uiPort: formData.uiPort ? parseInt(formData.uiPort, 10) : null,
      apiPort: formData.apiPort ? parseInt(formData.apiPort, 10) : null,
      startCommands: formData.startCommands.split('\n').filter(Boolean),
      pm2ProcessNames: formData.pm2ProcessNames
        ? formData.pm2ProcessNames.split(',').map(s => s.trim()).filter(Boolean)
        : undefined,
      editorCommand: formData.editorCommand || undefined,
      defaultUseWorktree: formData.defaultUseWorktree,
      jira: formData.jiraEnabled ? {
        enabled: true,
        instanceId: formData.jiraInstanceId || undefined,
        projectKey: formData.jiraProjectKey || undefined,
        boardId: formData.jiraBoardId || undefined,
        issueType: formData.jiraIssueType || 'Task',
        labels: formData.jiraLabels ? formData.jiraLabels.split(',').map(s => s.trim()).filter(Boolean) : [],
        assignee: formData.jiraAssignee || undefined,
        epicKey: formData.jiraEpicKey || undefined,
        createPR: formData.jiraCreatePR
      } : { enabled: false }
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
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-app-title"
    >
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 w-full max-w-lg max-h-[90vh] overflow-auto">
        <h2 id="edit-app-title" className="text-xl font-bold text-white mb-4">Edit App</h2>

        {error && (
          <div className="mb-4 p-3 bg-port-error/20 border border-port-error rounded-lg text-port-error text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4">
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
            <div className="w-full sm:w-32">
              <IconPicker value={formData.icon} onChange={icon => setFormData({ ...formData, icon })} />
            </div>
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={formData.defaultUseWorktree}
              onChange={e => setFormData({ ...formData, defaultUseWorktree: e.target.checked })}
              className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
            />
            <GitBranch size={14} className="text-emerald-400" />
            <span className="text-sm text-white">Default to Branch + PR for new tasks</span>
          </label>

          {/* JIRA Integration Section */}
          <div className="border border-port-border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setJiraExpanded(prev => !prev)}
              className="w-full flex items-center justify-between px-4 py-3 bg-port-bg hover:bg-port-border/50 transition-colors"
            >
              <span className="text-sm font-medium text-gray-300">JIRA Integration</span>
              <div className="flex items-center gap-2">
                {formData.jiraEnabled && (
                  <span className="text-xs px-2 py-0.5 bg-port-accent/20 text-port-accent rounded">Enabled</span>
                )}
                {jiraExpanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
              </div>
            </button>

            {jiraExpanded && (
              <div className="p-4 space-y-3 border-t border-port-border">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.jiraEnabled}
                    onChange={e => setFormData({ ...formData, jiraEnabled: e.target.checked })}
                    className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                  />
                  <span className="text-sm text-white">Enable JIRA Integration</span>
                </label>

                {formData.jiraEnabled && (
                  <>
                    {jiraInstances.length === 0 ? (
                      <div className="p-3 bg-port-warning/10 border border-port-warning/30 rounded-lg text-sm text-port-warning">
                        No JIRA instances configured. <Link to="/devtools/jira" className="underline hover:text-white">Configure JIRA</Link> first.
                      </div>
                    ) : (
                      <>
                        <div>
                          <label className="block text-sm text-gray-400 mb-1">JIRA Instance</label>
                          <select
                            value={formData.jiraInstanceId}
                            onChange={e => setFormData({ ...formData, jiraInstanceId: e.target.value, jiraProjectKey: '' })}
                            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                          >
                            <option value="">Select instance...</option>
                            {jiraInstances.map(inst => (
                              <option key={inst.id} value={inst.id}>{inst.name} ({inst.baseUrl})</option>
                            ))}
                          </select>
                        </div>

                        <div className="relative">
                          <label className="block text-sm text-gray-400 mb-1">Project Key</label>
                          {loadingProjects ? (
                            <div className="text-xs text-gray-500">Loading projects...</div>
                          ) : jiraProjects.length > 0 ? (
                            <div>
                              <input
                                type="text"
                                value={projectDropdownOpen ? projectSearch : (
                                  formData.jiraProjectKey
                                    ? `${formData.jiraProjectKey} - ${jiraProjects.find(p => p.key === formData.jiraProjectKey)?.name || ''}`
                                    : ''
                                )}
                                onChange={e => {
                                  setProjectSearch(e.target.value);
                                  if (!projectDropdownOpen) setProjectDropdownOpen(true);
                                }}
                                onFocus={() => {
                                  setProjectDropdownOpen(true);
                                  setProjectSearch('');
                                }}
                                onBlur={() => setTimeout(() => setProjectDropdownOpen(false), 150)}
                                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                                placeholder="Search projects..."
                              />
                              {formData.jiraProjectKey && !projectDropdownOpen && (
                                <button
                                  type="button"
                                  onClick={() => setFormData({ ...formData, jiraProjectKey: '' })}
                                  className="absolute right-2 top-8 text-gray-500 hover:text-white text-sm"
                                >
                                  x
                                </button>
                              )}
                              {projectDropdownOpen && (
                                <div className="absolute z-50 w-full mt-1 bg-port-bg border border-port-border rounded-lg max-h-48 overflow-auto shadow-lg">
                                  {jiraProjects
                                    .filter(proj => {
                                      if (!projectSearch) return true;
                                      const q = projectSearch.toLowerCase();
                                      return proj.key.toLowerCase().includes(q) || proj.name.toLowerCase().includes(q);
                                    })
                                    .sort((a, b) => a.key.localeCompare(b.key))
                                    .slice(0, 100)
                                    .map(proj => (
                                      <button
                                        key={proj.key}
                                        type="button"
                                        onMouseDown={e => {
                                          e.preventDefault();
                                          setFormData({ ...formData, jiraProjectKey: proj.key });
                                          setProjectDropdownOpen(false);
                                          setProjectSearch('');
                                        }}
                                        className={`w-full text-left px-3 py-2 text-sm hover:bg-port-accent/20 ${
                                          formData.jiraProjectKey === proj.key ? 'bg-port-accent/10 text-port-accent' : 'text-white'
                                        }`}
                                      >
                                        <span className="font-mono">{proj.key}</span>
                                        <span className="text-gray-400 ml-2">{proj.name}</span>
                                      </button>
                                    ))
                                  }
                                  {jiraProjects.filter(proj => {
                                    if (!projectSearch) return true;
                                    const q = projectSearch.toLowerCase();
                                    return proj.key.toLowerCase().includes(q) || proj.name.toLowerCase().includes(q);
                                  }).length === 0 && (
                                    <div className="px-3 py-2 text-sm text-gray-500">No matching projects</div>
                                  )}
                                </div>
                              )}
                            </div>
                          ) : (
                            <input
                              type="text"
                              value={formData.jiraProjectKey}
                              onChange={e => setFormData({ ...formData, jiraProjectKey: e.target.value })}
                              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                              placeholder="e.g. CONTECH"
                            />
                          )}
                        </div>

                        <div>
                          <label className="block text-sm text-gray-400 mb-1">Board ID</label>
                          <input
                            type="text"
                            value={formData.jiraBoardId}
                            onChange={e => setFormData({ ...formData, jiraBoardId: e.target.value })}
                            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                            placeholder="e.g. 11810 (from JIRA board URL rapidView param)"
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-sm text-gray-400 mb-1">Issue Type</label>
                            <input
                              type="text"
                              value={formData.jiraIssueType}
                              onChange={e => setFormData({ ...formData, jiraIssueType: e.target.value })}
                              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                              placeholder="Task"
                            />
                          </div>
                          <div>
                            <label className="block text-sm text-gray-400 mb-1">Assignee</label>
                            <input
                              type="text"
                              value={formData.jiraAssignee}
                              onChange={e => setFormData({ ...formData, jiraAssignee: e.target.value })}
                              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                              placeholder="Optional"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-sm text-gray-400 mb-1">Labels (comma-separated)</label>
                          <input
                            type="text"
                            value={formData.jiraLabels}
                            onChange={e => setFormData({ ...formData, jiraLabels: e.target.value })}
                            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                            placeholder="e.g. cos-auto, feature"
                          />
                        </div>

                        <div>
                          <label className="block text-sm text-gray-400 mb-1">Epic Key</label>
                          <input
                            type="text"
                            value={formData.jiraEpicKey}
                            onChange={e => setFormData({ ...formData, jiraEpicKey: e.target.value })}
                            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
                            placeholder="e.g. CONTECH-100"
                          />
                        </div>

                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={formData.jiraCreatePR}
                            onChange={e => setFormData({ ...formData, jiraCreatePR: e.target.checked })}
                            className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                          />
                          <span className="text-sm text-white">Create Pull Request on completion</span>
                        </label>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
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
