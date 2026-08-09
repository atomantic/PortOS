import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import { Save, Loader2 } from 'lucide-react';
import * as api from '../../services/api';
import toast from '../ui/Toast';
import Banner from '../ui/Banner';
import { INPUT_CLASS } from './constants';

// A JIRA issue key like PROJ-1553 — used to tell "user typed a key to validate"
// from "user is searching an epic by name" in the epic field.
const EPIC_KEY_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** Flatten the app record's stored `jira` object into flat form fields. */
const toForm = (jira) => ({
  enabled: jira?.enabled || false,
  instanceId: jira?.instanceId || '',
  projectKey: jira?.projectKey || '',
  boardId: jira?.boardId || '',
  issueType: jira?.issueType || 'Task',
  labels: (jira?.labels || []).join(', '),
  assignee: jira?.assignee || '',
  epicKey: jira?.epicKey || '',
  createPR: jira?.createPR !== false
});

/**
 * The app's JIRA integration config — instance/project/board pickers, issue
 * defaults, and the epic combobox.
 *
 * Lives on the app detail page's JIRA tab (alongside the sprint Kanban board)
 * rather than inside the Edit App drawer: JIRA config is only meaningful next to
 * the board it drives, and the pickers are wide enough that a 720px drawer made
 * them cramped. Saves ONLY the `jira` slice through `PUT /api/apps/:id` (a
 * shallow merge server-side), so it can't clobber fields the drawer owns.
 */
export default function JiraConfigPanel({ app, onSaved }) {
  const [form, setForm] = useState(() => toForm(app.jira));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [instances, setInstances] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const [boards, setBoards] = useState([]);
  const [loadingBoards, setLoadingBoards] = useState(false);
  const [boardSprints, setBoardSprints] = useState([]);
  const [epicResults, setEpicResults] = useState([]);
  const [epicDropdownOpen, setEpicDropdownOpen] = useState(false);
  const [epicValidation, setEpicValidation] = useState({ state: 'idle' });

  useEffect(() => {
    api.getJiraInstances()
      .then(data => setInstances(data?.instances ? Object.values(data.instances) : []))
      .catch(() => setInstances([]));
  }, []);

  useEffect(() => {
    if (!form.instanceId) {
      setProjects([]);
      return;
    }
    let cancelled = false;
    setLoadingProjects(true);
    api.getJiraProjects(form.instanceId)
      .then(list => { if (!cancelled) setProjects(list || []); })
      .catch(() => { if (!cancelled) setProjects([]); })
      .finally(() => { if (!cancelled) setLoadingProjects(false); });
    return () => { cancelled = true; };
  }, [form.instanceId]);

  // Default the assignee to the instance's own account so the common case needs
  // no typing — only when the field is still empty, never overwriting a choice.
  useEffect(() => {
    if (!form.instanceId || form.assignee) return;
    const inst = instances.find(i => i.id === form.instanceId);
    if (inst?.email) setForm(prev => ({ ...prev, assignee: inst.email }));
  }, [form.instanceId, form.assignee, instances]);

  // Detect the project's agile boards so the boardId is picked from live data
  // instead of hand-typed (which is how a boardId goes stale across a migration).
  useEffect(() => {
    if (!form.instanceId || !form.projectKey) {
      setBoards([]);
      return;
    }
    let cancelled = false;
    setLoadingBoards(true);
    api.getJiraBoards(form.instanceId, form.projectKey, { silent: true })
      .then(list => { if (!cancelled) setBoards(list || []); })
      .catch(() => { if (!cancelled) setBoards([]); })
      .finally(() => { if (!cancelled) setLoadingBoards(false); });
    return () => { cancelled = true; };
  }, [form.instanceId, form.projectKey]);

  // Show the selected board's active sprint as confirmation it's the right board.
  useEffect(() => {
    if (!form.instanceId || !form.boardId) {
      setBoardSprints([]);
      return;
    }
    let cancelled = false;
    api.getJiraBoardSprints(form.instanceId, form.boardId, { silent: true })
      .then(sprints => { if (!cancelled) setBoardSprints(sprints || []); })
      .catch(() => { if (!cancelled) setBoardSprints([]); });
    return () => { cancelled = true; };
  }, [form.instanceId, form.boardId]);

  // Validate the configured epic key still resolves as an Epic on this instance.
  useEffect(() => {
    const key = form.epicKey.trim();
    if (!form.instanceId || !EPIC_KEY_RE.test(key)) {
      setEpicValidation({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setEpicValidation({ state: 'checking' });
    const t = setTimeout(() => {
      api.getJiraIssue(form.instanceId, key, { silent: true })
        .then(issue => {
          if (cancelled) return;
          const isEpic = (issue.issueType || '').toLowerCase() === 'epic';
          setEpicValidation({ state: isEpic ? 'ok' : 'wrongtype', issue });
        })
        .catch(() => { if (!cancelled) setEpicValidation({ state: 'stale' }); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [form.instanceId, form.epicKey]);

  // When the epic field holds free text (not a key), search epics by name to pick one.
  useEffect(() => {
    const q = form.epicKey.trim();
    if (!form.instanceId || !form.projectKey || q.length < 2 || EPIC_KEY_RE.test(q)) {
      setEpicResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.searchJiraEpics(form.instanceId, form.projectKey, q, { silent: true })
        .then(results => { if (!cancelled) setEpicResults(results || []); })
        .catch(() => { if (!cancelled) setEpicResults([]); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [form.instanceId, form.projectKey, form.epicKey]);

  // Project-key combobox options: filter by the search box, sort by key, cap at
  // 100. Derived once so the predicate isn't duplicated between the option list
  // and the "no matching projects" empty-state check below. Memoized on its real
  // inputs: a JIRA instance with hundreds of projects otherwise re-ran an
  // Intl-backed `localeCompare` sort on every keystroke in the Labels, Assignee,
  // Issue Type, and Epic fields, which all share this component's form state.
  const filteredProjects = useMemo(() => projects
    .filter(proj => {
      if (!projectSearch) return true;
      const q = projectSearch.toLowerCase();
      return proj.key.toLowerCase().includes(q) || proj.name.toLowerCase().includes(q);
    })
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, 100), [projects, projectSearch]);

  const selectedProjectName = useMemo(
    () => projects.find(p => p.key === form.projectKey)?.name || '',
    [projects, form.projectKey]
  );

  // A saved boardId that isn't among the project's detected boards is stale
  // (e.g. carried over from a Server instance after a Cloud migration).
  const boardIsStale = !!form.boardId && boards.length > 0
    && !boards.some(b => String(b.id) === String(form.boardId));
  const activeSprint = boardSprints[0] || null;

  // Changing the instance or project invalidates the selected board, so clear it
  // in one place — every discrete instance/project change goes through these so no
  // call site forgets the reset. Deliberately interaction-driven, NOT a projectKey
  // effect: an effect would fire on mount with the saved projectKey and wipe the
  // saved boardId before the boards fetch resolves, defeating stale-board detection.
  const changeInstance = (instanceId) =>
    setForm(prev => ({ ...prev, instanceId, projectKey: '', boardId: '' }));
  const selectProject = (projectKey) =>
    setForm(prev => ({ ...prev, projectKey, boardId: '' }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const jira = form.enabled ? {
      enabled: true,
      instanceId: form.instanceId || undefined,
      projectKey: form.projectKey || undefined,
      boardId: form.boardId || undefined,
      issueType: form.issueType || 'Task',
      labels: form.labels ? form.labels.split(',').map(s => s.trim()).filter(Boolean) : [],
      assignee: form.assignee || undefined,
      epicKey: form.epicKey.trim() || undefined,
      createPR: form.createPR
    } : { enabled: false };
    // Custom error UI below, so silence the helper's toast (one layer wins).
    const updated = await api.updateApp(app.id, { jira }, { silent: true }).catch(err => {
      setError(err.message);
      return null;
    });
    setSaving(false);
    if (!updated) return;
    toast.success('JIRA configuration saved');
    onSaved?.(updated);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 max-w-3xl">
      {error && (
        <div className="p-3 bg-port-error/20 border border-port-error rounded-lg text-port-error text-sm">
          {error}
        </div>
      )}

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={e => setForm({ ...form, enabled: e.target.checked })}
          className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
        />
        <span className="text-sm text-white">Enable JIRA Integration</span>
      </label>

      {form.enabled && (
        instances.length === 0 ? (
          <Banner tone="warning" size="md">
            No JIRA instances configured. <Link to="/devtools/jira" className="underline hover:text-white">Configure JIRA</Link> first.
          </Banner>
        ) : (
          <>
            <div>
              <label htmlFor="app-jira-instance" className="block text-sm text-gray-400 mb-1">JIRA Instance</label>
              <select
                id="app-jira-instance"
                value={form.instanceId}
                onChange={e => changeInstance(e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Select instance...</option>
                {instances.map(inst => (
                  <option key={inst.id} value={inst.id}>{inst.name} ({inst.baseUrl})</option>
                ))}
              </select>
            </div>

            <div className="relative">
              <label htmlFor="app-jira-project" className="block text-sm text-gray-400 mb-1">Project Key</label>
              {loadingProjects ? (
                <div className="text-xs text-gray-500">Loading projects...</div>
              ) : projects.length > 0 ? (
                <div>
                  <input
                    id="app-jira-project"
                    type="text"
                    value={projectDropdownOpen ? projectSearch : (
                      form.projectKey ? `${form.projectKey} - ${selectedProjectName}` : ''
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
                    className={INPUT_CLASS}
                    placeholder="Search projects..."
                  />
                  {form.projectKey && !projectDropdownOpen && (
                    <button
                      type="button"
                      onClick={() => selectProject('')}
                      aria-label="Clear JIRA project"
                      className="absolute right-2 top-8 text-gray-500 hover:text-white text-sm"
                    >
                      x
                    </button>
                  )}
                  {projectDropdownOpen && (
                    <div className="absolute z-50 w-full mt-1 bg-port-bg border border-port-border rounded-lg max-h-48 overflow-auto shadow-lg">
                      {filteredProjects.map(proj => (
                        <button
                          key={proj.key}
                          type="button"
                          onMouseDown={e => {
                            e.preventDefault();
                            selectProject(proj.key);
                            setProjectDropdownOpen(false);
                            setProjectSearch('');
                          }}
                          className={`w-full text-left px-3 py-2 text-sm hover:bg-port-accent/20 ${
                            form.projectKey === proj.key ? 'bg-port-accent/10 text-port-accent' : 'text-white'
                          }`}
                        >
                          <span className="font-mono">{proj.key}</span>
                          <span className="text-gray-400 ml-2">{proj.name}</span>
                        </button>
                      ))}
                      {filteredProjects.length === 0 && (
                        <div className="px-3 py-2 text-sm text-gray-500">No matching projects</div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <input
                  id="app-jira-project"
                  type="text"
                  value={form.projectKey}
                  onChange={e => setForm({ ...form, projectKey: e.target.value })}
                  className={INPUT_CLASS}
                  placeholder="e.g. PROJ"
                />
              )}
            </div>

            <div>
              <label htmlFor="app-jira-board" className="block text-sm text-gray-400 mb-1">Board</label>
              {!form.projectKey ? (
                <div className="text-xs text-gray-500">Select a project to detect its boards.</div>
              ) : loadingBoards ? (
                <div className="text-xs text-gray-500">Detecting boards…</div>
              ) : boards.length > 0 ? (
                <>
                  <select
                    id="app-jira-board"
                    value={form.boardId}
                    onChange={e => setForm({ ...form, boardId: e.target.value })}
                    className={INPUT_CLASS}
                  >
                    <option value="">Select board...</option>
                    {boards.map(b => (
                      <option key={b.id} value={String(b.id)}>{b.id} — {b.name} ({b.type})</option>
                    ))}
                    {boardIsStale && (
                      <option value={form.boardId}>{form.boardId} — (not in this project)</option>
                    )}
                  </select>
                  {boardIsStale ? (
                    <p className="text-xs text-port-warning mt-1">⚠ Saved board {form.boardId} isn&apos;t among this project&apos;s boards — pick a current one.</p>
                  ) : form.boardId && (
                    <p className="text-xs text-gray-500 mt-1">
                      {activeSprint ? `Active sprint: ${activeSprint.name}` : 'No active sprint on this board.'}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <input
                    id="app-jira-board"
                    type="text"
                    value={form.boardId}
                    onChange={e => setForm({ ...form, boardId: e.target.value })}
                    className={INPUT_CLASS}
                    placeholder="e.g. 1294 (from JIRA board URL rapidView param)"
                  />
                  <p className="text-xs text-gray-500 mt-1">Couldn&apos;t auto-detect boards — enter the id manually (board URL <span className="font-mono">rapidView</span> param).</p>
                </>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="app-jira-issue-type" className="block text-sm text-gray-400 mb-1">Issue Type</label>
                <input
                  id="app-jira-issue-type"
                  type="text"
                  value={form.issueType}
                  onChange={e => setForm({ ...form, issueType: e.target.value })}
                  className={INPUT_CLASS}
                  placeholder="Task"
                />
              </div>
              <div>
                <label htmlFor="app-jira-assignee" className="block text-sm text-gray-400 mb-1">Assignee</label>
                <input
                  id="app-jira-assignee"
                  type="text"
                  value={form.assignee}
                  onChange={e => setForm({ ...form, assignee: e.target.value })}
                  className={INPUT_CLASS}
                  placeholder="Optional"
                />
              </div>
            </div>

            <div>
              <label htmlFor="app-jira-labels" className="block text-sm text-gray-400 mb-1">Labels (comma-separated)</label>
              <input
                id="app-jira-labels"
                type="text"
                value={form.labels}
                onChange={e => setForm({ ...form, labels: e.target.value })}
                className={INPUT_CLASS}
                placeholder="e.g. cos-auto, feature"
              />
            </div>

            <div className="relative">
              <label htmlFor="app-jira-epic" className="block text-sm text-gray-400 mb-1">Epic Key</label>
              <input
                id="app-jira-epic"
                type="text"
                value={form.epicKey}
                onChange={e => setForm({ ...form, epicKey: e.target.value })}
                onFocus={() => setEpicDropdownOpen(true)}
                onBlur={() => setTimeout(() => setEpicDropdownOpen(false), 150)}
                className={INPUT_CLASS}
                placeholder="e.g. PROJ-100, or type a name to search"
              />
              {epicDropdownOpen && epicResults.length > 0 && (
                <div className="absolute z-50 w-full mt-1 bg-port-bg border border-port-border rounded-lg max-h-48 overflow-auto shadow-lg">
                  {epicResults.map(ep => (
                    <button
                      key={ep.key}
                      type="button"
                      onMouseDown={e => {
                        e.preventDefault();
                        setForm({ ...form, epicKey: ep.key });
                        setEpicDropdownOpen(false);
                      }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-port-accent/20 text-white"
                    >
                      <span className="font-mono">{ep.key}</span>
                      <span className="text-gray-400 ml-2">{ep.summary}</span>
                    </button>
                  ))}
                </div>
              )}
              {epicValidation.state !== 'idle' && (
                <p className={`text-xs mt-1 ${
                  epicValidation.state === 'ok' ? 'text-port-success'
                    : epicValidation.state === 'checking' ? 'text-gray-500'
                      : 'text-port-warning'
                }`}>
                  {epicValidation.state === 'checking' && 'Checking epic…'}
                  {epicValidation.state === 'ok' && `✓ ${epicValidation.issue.key} · ${epicValidation.issue.summary}`}
                  {epicValidation.state === 'wrongtype' && `⚠ ${epicValidation.issue.key} is a ${epicValidation.issue.issueType}, not an Epic`}
                  {epicValidation.state === 'stale' && `⚠ ${form.epicKey} doesn't resolve on this instance`}
                </p>
              )}
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.createPR}
                onChange={e => setForm({ ...form, createPR: e.target.checked })}
                className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
              />
              <span className="text-sm text-white">Create Pull Request on completion</span>
            </label>
          </>
        )
      )}

      <button
        type="submit"
        disabled={saving}
        className="px-4 py-2 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 border border-port-border rounded-lg text-sm flex items-center gap-2 disabled:opacity-50 transition-colors"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        {saving ? 'Saving…' : 'Save JIRA Settings'}
      </button>
    </form>
  );
}
