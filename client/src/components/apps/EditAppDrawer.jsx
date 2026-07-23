import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { GitBranch, GitPullRequest, Lock, Copy } from 'lucide-react';
import IconPicker from '../IconPicker';
import * as api from '../../services/api';
import { PORTOS_APP_ID } from '../../services/apiCore';
import toast from '../ui/Toast';
import Drawer from '../Drawer';
import Banner from '../ui/Banner';
import useDrawerTab from '../../hooks/useDrawerTab';
import { copyToClipboard } from '../../lib/clipboard';
import LayeredIntelligenceTab, { buildLayeredIntelligenceUpdate, buildLayeredIntelligenceScheduleUpdate } from './LayeredIntelligenceTab';
import { PROVIDER_TYPES } from '../../utils/providers';

const WORK_TRACKER_OPTIONS = [
  { value: 'auto', label: 'Auto (detect from git origin)' },
  { value: 'plan', label: 'PLAN.md' },
  { value: 'github', label: 'GitHub Issues' },
  { value: 'gitlab', label: 'GitLab Issues' },
  { value: 'jira', label: 'JIRA' }
];

const WORK_TRACKER_LABELS = Object.fromEntries(
  WORK_TRACKER_OPTIONS.map(o => [o.value, o.label])
);

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'ports', label: 'Ports & TLS' },
  { id: 'commands', label: 'Commands' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'jira', label: 'JIRA' },
  { id: 'datadog', label: 'DataDog' }
];
const TAB_IDS = TABS.map(t => t.id);

// Port fields that must be validated on save even when their tab is unmounted.
const PORT_FIELDS = [
  ['uiPort', 'UI Port'],
  ['devUiPort', 'Dev UI Port'],
  ['apiPort', 'API Port'],
  ['tlsPort', 'TLS Port']
];

// A JIRA issue key like CONTECH-1553 — used to tell "user typed a key to validate"
// from "user is searching an epic by name" in the epic field.
const EPIC_KEY_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export default function EditAppDrawer({ app, onClose, onSave }) {
  const [activeTab, setActiveTab] = useDrawerTab('appTab', 'general', TAB_IDS);
  const [formData, setFormData] = useState({
    name: app.name,
    icon: app.icon || 'package',
    repoPath: app.repoPath,
    uiPort: app.uiPort || '',
    devUiPort: app.devUiPort || '',
    apiPort: app.apiPort || '',
    tlsPort: app.tlsPort || '',
    buildCommand: app.buildCommand || '',
    startCommands: (app.startCommands || []).join('\n'),
    pm2ProcessNames: (app.pm2ProcessNames || []).join(', '),
    editorCommand: app.editorCommand || 'code .',
    workTracker: app.workTracker || 'auto',
    defaultOpenPR: app.defaultOpenPR || false,
    defaultUseWorktree: app.defaultUseWorktree || app.defaultOpenPR || false,
    jiraEnabled: app.jira?.enabled || false,
    jiraInstanceId: app.jira?.instanceId || '',
    jiraProjectKey: app.jira?.projectKey || '',
    jiraBoardId: app.jira?.boardId || '',
    jiraIssueType: app.jira?.issueType || 'Task',
    jiraLabels: (app.jira?.labels || []).join(', '),
    jiraAssignee: app.jira?.assignee || '',
    jiraEpicKey: app.jira?.epicKey || '',
    jiraCreatePR: app.jira?.createPR !== false,
    datadogEnabled: app.datadog?.enabled || false,
    datadogInstanceId: app.datadog?.instanceId || '',
    datadogServiceName: app.datadog?.serviceName || '',
    datadogEnvironment: app.datadog?.environment || ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // Layered Intelligence (self-improvement loop) config lives in its own slice —
  // it's saved through a dedicated server merge helper (updateAppLayeredIntelligence)
  // that patches over the STORED config, not the effective one, so we diff the
  // edited config against the loaded effective baseline and PATCH only what changed
  // (see buildLayeredIntelligenceUpdate). `liBaseline` is the effective config the
  // drawer loaded; `liConfig` is the working copy the tab edits.
  const [liConfig, setLiConfig] = useState(null);
  const [liBaseline, setLiBaseline] = useState(null);
  const [liProviders, setLiProviders] = useState([]);
  const [liIsPortos, setLiIsPortos] = useState(app.id === PORTOS_APP_ID);
  const [liLoaded, setLiLoaded] = useState(false);
  const [liError, setLiError] = useState(false);
  const [tlsUpgrading, setTlsUpgrading] = useState(false);
  const [tlsResult, setTlsResult] = useState(null);
  const [tlsError, setTlsError] = useState(null);
  const tlsNeedsForce = tlsError?.code === 'ALREADY_EXISTS';

  const handleUpgradeTls = async (force = false) => {
    const port = formData.tlsPort ? parseInt(formData.tlsPort, 10)
      : (formData.uiPort ? parseInt(formData.uiPort, 10) + 1000 : null);
    if (!port) {
      toast.error('Set a TLS Port first (or a UI Port to derive one)');
      return;
    }
    setTlsUpgrading(true);
    setTlsError(null);
    try {
      const result = await api.upgradeAppTls(app.id, { tlsPort: port, force });
      setTlsResult(result);
      setFormData(prev => ({ ...prev, tlsPort: String(port) }));
      toast.success(result.overwrote
        ? `Overwrote lib/tailscale-https.js in ${app.name}`
        : `Copied lib/tailscale-https.js into ${app.name}`);
    } catch (err) {
      setTlsError(err);
      if (err?.code === 'ALREADY_EXISTS') {
        toast.error('lib/tailscale-https.js already exists — use "Overwrite existing" to replace');
      } else {
        toast.error(err?.message || 'Upgrade failed');
      }
    } finally {
      setTlsUpgrading(false);
    }
  };
  const [workTrackerInfo, setWorkTrackerInfo] = useState(null);
  const [jiraInstances, setJiraInstances] = useState([]);
  const [datadogInstances, setDatadogInstances] = useState([]);
  const [jiraProjects, setJiraProjects] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const [jiraBoards, setJiraBoards] = useState([]);
  const [loadingBoards, setLoadingBoards] = useState(false);
  const [boardSprints, setBoardSprints] = useState([]);
  const [epicResults, setEpicResults] = useState([]);
  const [epicDropdownOpen, setEpicDropdownOpen] = useState(false);
  const [epicValidation, setEpicValidation] = useState({ state: 'idle' });

  useEffect(() => {
    const toInstances = (data) => data?.instances ? Object.values(data.instances) : [];
    Promise.all([
      api.getJiraInstances().then(toInstances).catch(() => []),
      api.getDatadogInstances().then(toInstances).catch(() => [])
    ]).then(([jira, datadog]) => {
      setJiraInstances(jira);
      setDatadogInstances(datadog);
    });
  }, []);

  useEffect(() => {
    api.getAppWorkTracker(app.id)
      .then(setWorkTrackerInfo)
      .catch(() => setWorkTrackerInfo(null));
  }, [app.id]);

  // Load the app's effective Layered Intelligence config + the CLI provider list
  // (the loop runs an agentic CLI, same as other CoS work). The tab edits a
  // working copy; on save we diff it against the baseline. On failure we set
  // liError so the tab can show a retry instead of hanging on "Loading…" — the
  // config fetch is {silent:true}, so there's no toast to surface the failure.
  const loadLayeredIntelligence = useCallback(() => {
    let cancelled = false;
    setLiLoaded(false);
    setLiError(false);
    Promise.all([
      api.getAppLayeredIntelligence(app.id),
      api.getProviders({ silent: true }).catch(() => ({ providers: [] })),
      // Scheduling (enabled/interval/provider/model) lives in the per-app task
      // override now (#2322); behavior (sources/scopes/rules/handoff) stays in the
      // layeredIntelligence config. Merge the override on top so the tab shows the
      // scheduling source of truth.
      api.getAppTaskTypes(app.id).catch(() => ({ taskTypeOverrides: {} }))
    ]).then(([li, provData, taskTypes]) => {
      if (cancelled) return;
      const behavior = li?.config || null;
      const ov = taskTypes?.taskTypeOverrides?.['layered-intelligence'] || {};
      const cfg = behavior
        ? {
          ...behavior,
          enabled: ov.enabled === true,
          intervalMs: (typeof ov.intervalMs === 'number' && ov.intervalMs > 0) ? ov.intervalMs : behavior.intervalMs,
          providerId: ov.providerId ?? null,
          model: ov.model ?? null
        }
        : null;
      setLiConfig(cfg);
      setLiBaseline(cfg);
      setLiIsPortos(!!li?.isPortos);
      // The loop reasons through runPromptThroughProvider, which dispatches on
      // provider.type — so any enabled provider of a known type is selectable
      // (Claude Code, Codex, OpenCode, Ollama/LM Studio API, TUI variants…).
      const runnableTypes = Object.values(PROVIDER_TYPES);
      setLiProviders((provData?.providers || []).filter(p => runnableTypes.includes(p.type) && p.enabled !== false));
      setLiError(!cfg);
      setLiLoaded(true);
    }).catch(() => {
      if (cancelled) return;
      setLiError(true);
      setLiLoaded(true);
    });
    return () => { cancelled = true; };
  }, [app.id]);

  useEffect(() => loadLayeredIntelligence(), [loadLayeredIntelligence]);

  const updateLiConfig = (patch) => setLiConfig(prev => ({ ...(prev || {}), ...patch }));

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

  // Detect the project's agile boards so the boardId is picked from live data
  // instead of hand-typed (which is how a boardId goes stale across a migration).
  useEffect(() => {
    if (!formData.jiraInstanceId || !formData.jiraProjectKey) {
      setJiraBoards([]);
      return;
    }
    let cancelled = false;
    setLoadingBoards(true);
    api.getJiraBoards(formData.jiraInstanceId, formData.jiraProjectKey, { silent: true })
      .then(boards => { if (!cancelled) setJiraBoards(boards || []); })
      .catch(() => { if (!cancelled) setJiraBoards([]); })
      .finally(() => { if (!cancelled) setLoadingBoards(false); });
    return () => { cancelled = true; };
  }, [formData.jiraInstanceId, formData.jiraProjectKey]);

  // Show the selected board's active sprint as confirmation it's the right board.
  useEffect(() => {
    if (!formData.jiraInstanceId || !formData.jiraBoardId) {
      setBoardSprints([]);
      return;
    }
    let cancelled = false;
    api.getJiraBoardSprints(formData.jiraInstanceId, formData.jiraBoardId, { silent: true })
      .then(sprints => { if (!cancelled) setBoardSprints(sprints || []); })
      .catch(() => { if (!cancelled) setBoardSprints([]); });
    return () => { cancelled = true; };
  }, [formData.jiraInstanceId, formData.jiraBoardId]);

  // Validate the configured epic key still resolves as an Epic on this instance.
  useEffect(() => {
    const key = formData.jiraEpicKey.trim();
    if (!formData.jiraInstanceId || !EPIC_KEY_RE.test(key)) {
      setEpicValidation({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setEpicValidation({ state: 'checking' });
    const t = setTimeout(() => {
      api.getJiraIssue(formData.jiraInstanceId, key, { silent: true })
        .then(issue => {
          if (cancelled) return;
          const isEpic = (issue.issueType || '').toLowerCase() === 'epic';
          setEpicValidation({ state: isEpic ? 'ok' : 'wrongtype', issue });
        })
        .catch(() => { if (!cancelled) setEpicValidation({ state: 'stale' }); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [formData.jiraInstanceId, formData.jiraEpicKey]);

  // When the epic field holds free text (not a key), search epics by name to pick one.
  useEffect(() => {
    const q = formData.jiraEpicKey.trim();
    if (!formData.jiraInstanceId || !formData.jiraProjectKey || q.length < 2 || EPIC_KEY_RE.test(q)) {
      setEpicResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.searchJiraEpics(formData.jiraInstanceId, formData.jiraProjectKey, q, { silent: true })
        .then(results => { if (!cancelled) setEpicResults(results || []); })
        .catch(() => { if (!cancelled) setEpicResults([]); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [formData.jiraInstanceId, formData.jiraProjectKey, formData.jiraEpicKey]);

  // Project-key combobox options: filter by the search box, sort by key, cap at
  // 100. Derived once per render so the predicate isn't duplicated between the
  // option list and the "no matching projects" empty-state check below.
  const filteredJiraProjects = jiraProjects
    .filter(proj => {
      if (!projectSearch) return true;
      const q = projectSearch.toLowerCase();
      return proj.key.toLowerCase().includes(q) || proj.name.toLowerCase().includes(q);
    })
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, 100);

  // A saved boardId that isn't among the project's detected boards is stale
  // (e.g. carried over from a Server instance after a Cloud migration).
  const boardIsStale = !!formData.jiraBoardId && jiraBoards.length > 0
    && !jiraBoards.some(b => String(b.id) === String(formData.jiraBoardId));
  const activeSprint = boardSprints[0] || null;

  // Changing the instance or project invalidates the selected board, so clear it
  // in one place — every discrete instance/project change goes through these so no
  // call site forgets the reset. Deliberately interaction-driven, NOT a projectKey
  // effect: an effect would fire on mount with the saved projectKey and wipe the
  // saved boardId before the boards fetch resolves, defeating stale-board detection.
  const changeInstance = (jiraInstanceId) =>
    setFormData(prev => ({ ...prev, jiraInstanceId, jiraProjectKey: '', jiraBoardId: '' }));
  const selectProject = (jiraProjectKey) =>
    setFormData(prev => ({ ...prev, jiraProjectKey, jiraBoardId: '' }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    // The required Name/Repository Path inputs live on the General tab and are
    // unmounted while any other tab is active, so the browser's `required`
    // constraint validation can't block a Save triggered from another tab.
    // Validate explicitly and surface the General tab so the empty field shows.
    if (!formData.name?.trim() || !formData.repoPath?.trim()) {
      setActiveTab('general');
      setError('Name and Repository Path are required.');
      return;
    }

    // The port inputs (type="number") live on the Ports & TLS tab and are also
    // unmounted while another tab is active, so a bad value like `1e`/`1.5`
    // would slip past browser validation and get silently truncated by
    // parseInt below. Validate each provided port as a whole 1–65535 number.
    for (const [key, label] of PORT_FIELDS) {
      const raw = String(formData[key] ?? '').trim();
      if (!raw) continue;
      const port = Number(raw);
      if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
        setActiveTab('ports');
        setError(`${label} must be a whole number between 1 and 65535.`);
        return;
      }
    }

    setSaving(true);

    const data = {
      name: formData.name,
      icon: formData.icon,
      repoPath: formData.repoPath,
      uiPort: formData.uiPort ? parseInt(formData.uiPort, 10) : null,
      devUiPort: formData.devUiPort ? parseInt(formData.devUiPort, 10) : null,
      apiPort: formData.apiPort ? parseInt(formData.apiPort, 10) : null,
      tlsPort: formData.tlsPort ? parseInt(formData.tlsPort, 10) : null,
      buildCommand: formData.buildCommand || undefined,
      startCommands: formData.startCommands.split('\n').filter(Boolean),
      pm2ProcessNames: formData.pm2ProcessNames
        ? formData.pm2ProcessNames.split(',').map(s => s.trim()).filter(Boolean)
        : undefined,
      editorCommand: formData.editorCommand || undefined,
      workTracker: formData.workTracker || 'auto',
      defaultUseWorktree: formData.defaultUseWorktree || formData.defaultOpenPR,
      defaultOpenPR: formData.defaultOpenPR,
      jira: formData.jiraEnabled ? {
        enabled: true,
        instanceId: formData.jiraInstanceId || undefined,
        projectKey: formData.jiraProjectKey || undefined,
        boardId: formData.jiraBoardId || undefined,
        issueType: formData.jiraIssueType || 'Task',
        labels: formData.jiraLabels ? formData.jiraLabels.split(',').map(s => s.trim()).filter(Boolean) : [],
        assignee: formData.jiraAssignee || undefined,
        epicKey: formData.jiraEpicKey.trim() || undefined,
        createPR: formData.jiraCreatePR
      } : { enabled: false },
      datadog: formData.datadogEnabled ? {
        enabled: true,
        instanceId: formData.datadogInstanceId || undefined,
        serviceName: formData.datadogServiceName || undefined,
        environment: formData.datadogEnvironment || undefined
      } : { enabled: false }
    };

    // Only send layeredIntelligence when the user actually changed a BEHAVIOR
    // field (sources/scopes/rules/handoff) — the server merges the PATCH over the
    // STORED config, so an unchanged config must stay absent (persisting the full
    // effective config would freeze this install against future default changes).
    const liUpdate = buildLayeredIntelligenceUpdate(liBaseline, liConfig);
    if (liUpdate) data.layeredIntelligence = liUpdate;

    await api.updateApp(app.id, data).catch(err => {
      setError(err.message);
      setSaving(false);
      throw err;
    });

    // Scheduling (enabled/interval/provider/model) is stored on the per-app task
    // override (#2322), NOT app.layeredIntelligence — PUT it separately when the
    // user changed a scheduling field.
    const schedUpdate = buildLayeredIntelligenceScheduleUpdate(liBaseline, liConfig);
    if (schedUpdate) {
      await api.updateAppTaskTypeOverride(app.id, 'layered-intelligence', schedUpdate, { silent: true }).catch(err => {
        setError(err.message);
        setSaving(false);
        throw err;
      });
    }

    setSaving(false);
    onSave();
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title="Edit App"
      size="lg"
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      // The form is long-lived and an accidental Esc / backdrop click while
      // editing nested JIRA pickers would lose state. Preserve the modal's
      // no-accidental-dismiss behavior.
      closeOnEsc={false}
      closeOnBackdrop={false}
    >
        {error && (
          <div className="mb-4 p-3 bg-port-error/20 border border-port-error rounded-lg text-port-error text-sm">
            {error}
          </div>
        )}

        {/* The Drawer body remounts per active tab (key={currentTab}), so this
            entire form/footer subtree is torn down and rebuilt on every tab
            switch. All mutable form state (formData, error, saving, the JIRA
            project-picker state) therefore MUST live above the Drawer body in
            this component — never in an uncontrolled input or subcomponent
            inside the form, or it would silently reset on tab switch. */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {activeTab === 'general' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-4">
                <div>
                  <label htmlFor="edit-app-name" className="block text-sm text-gray-400 mb-1">Name</label>
                  <input
                    id="edit-app-name"
                    type="text"
                    value={formData.name}
                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    required
                  />
                </div>
                <div className="w-full sm:w-32">
                  <IconPicker value={formData.icon} onChange={icon => setFormData({ ...formData, icon })} />
                </div>
              </div>

              <div>
                <label htmlFor="edit-app-repo-path" className="block text-sm text-gray-400 mb-1">Repository Path</label>
                <input
                  id="edit-app-repo-path"
                  type="text"
                  value={formData.repoPath}
                  onChange={e => setFormData({ ...formData, repoPath: e.target.value })}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                  required
                />
              </div>
            </div>
          )}

          {activeTab === 'ports' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="edit-app-ui-port" className="block text-sm text-gray-400 mb-1">UI Port</label>
                  <input
                    id="edit-app-ui-port"
                    type="number"
                    value={formData.uiPort}
                    onChange={e => setFormData({ ...formData, uiPort: e.target.value })}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    placeholder="3000"
                  />
                </div>
                <div>
                  <label htmlFor="edit-app-dev-ui-port" className="block text-sm text-gray-400 mb-1">Dev UI Port</label>
                  <input
                    id="edit-app-dev-ui-port"
                    type="number"
                    value={formData.devUiPort}
                    onChange={e => setFormData({ ...formData, devUiPort: e.target.value })}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    placeholder="3001"
                  />
                </div>
                <div>
                  <label htmlFor="edit-app-api-port" className="block text-sm text-gray-400 mb-1">API Port</label>
                  <input
                    id="edit-app-api-port"
                    type="number"
                    value={formData.apiPort}
                    onChange={e => setFormData({ ...formData, apiPort: e.target.value })}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                    placeholder="3002"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500">
                Saving a changed port rewrites the matching value in this app's <code className="text-gray-400">ecosystem.config.cjs</code> (the source of truth PM2 reads). Restart the app for the new port to take effect.
              </p>

              {app.id !== PORTOS_APP_ID && (
                <div className="bg-port-bg/50 border border-port-border rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Lock size={14} className="text-port-accent" />
                    <label htmlFor="edit-app-tls-port" className="text-sm text-gray-300">TLS Port (HTTPS)</label>
                    <button
                      type="button"
                      onClick={() => handleUpgradeTls(false)}
                      disabled={tlsUpgrading}
                      className="ml-auto text-xs px-2 py-1 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded disabled:opacity-50"
                    >
                      {tlsUpgrading ? 'Copying helper…' : 'Upgrade to TLS'}
                    </button>
                    {tlsNeedsForce && (
                      <button
                        type="button"
                        onClick={() => handleUpgradeTls(true)}
                        disabled={tlsUpgrading}
                        className="text-xs px-2 py-1 bg-port-warning/20 text-port-warning hover:bg-port-warning/30 rounded disabled:opacity-50"
                      >
                        Overwrite existing
                      </button>
                    )}
                  </div>
                  <div className="flex gap-2 items-center">
                    <input
                      id="edit-app-tls-port"
                      type="number"
                      value={formData.tlsPort}
                      onChange={e => {
                        setFormData({ ...formData, tlsPort: e.target.value });
                        setTlsResult(null);  // snippet bakes port at upgrade time; stale once user edits
                      }}
                      className="w-32 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                      placeholder={formData.uiPort ? String(parseInt(formData.uiPort, 10) + 1000) : '4001'}
                    />
                    <span className="text-xs text-gray-500">
                      Defaults to uiPort + 1000. Leave blank to disable HTTPS launch.
                    </span>
                  </div>
                  {tlsResult && (
                    <div className="bg-port-bg border border-port-border rounded p-2 text-xs">
                      <div className="text-gray-400 mb-1">
                        Copied helper to <code className="text-port-accent">{tlsResult.helperPath}</code>.
                        Wire it up in your server entry:
                      </div>
                      <div className="relative">
                        <pre className="bg-black/40 text-gray-200 p-2 rounded overflow-x-auto font-mono text-[11px] leading-tight">{tlsResult.snippet}</pre>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(tlsResult.snippet, 'Snippet copied')}
                          className="absolute top-1 right-1 p-1 bg-port-border/60 hover:bg-port-border rounded"
                          aria-label="Copy snippet"
                        >
                          <Copy size={12} />
                        </button>
                      </div>
                      <div className="text-gray-500 mt-2">
                        Point <code>CERT_DIR</code> at <code>{tlsResult.certDirHint}</code> (or symlink it) to share the Tailscale cert across apps.
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'commands' && (
            <div className="space-y-4">
              <div>
                <label htmlFor="edit-app-start-commands" className="block text-sm text-gray-400 mb-1">Start Commands (one per line)</label>
                <textarea
                  id="edit-app-start-commands"
                  value={formData.startCommands}
                  onChange={e => setFormData({ ...formData, startCommands: e.target.value })}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden font-mono text-sm"
                  rows={2}
                />
              </div>

              <div>
                <label htmlFor="edit-app-build-command" className="block text-sm text-gray-400 mb-1">Build Command</label>
                <input
                  id="edit-app-build-command"
                  type="text"
                  value={formData.buildCommand}
                  onChange={e => setFormData({ ...formData, buildCommand: e.target.value })}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden font-mono text-sm"
                  placeholder="npm run build"
                />
              </div>

              <div>
                <label htmlFor="edit-app-pm2-names" className="block text-sm text-gray-400 mb-1">PM2 Process Names (comma-separated)</label>
                <input
                  id="edit-app-pm2-names"
                  type="text"
                  value={formData.pm2ProcessNames}
                  onChange={e => setFormData({ ...formData, pm2ProcessNames: e.target.value })}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
              </div>

              <div>
                <label htmlFor="edit-app-editor-command" className="block text-sm text-gray-400 mb-1">Editor Command</label>
                <input
                  id="edit-app-editor-command"
                  type="text"
                  value={formData.editorCommand}
                  onChange={e => setFormData({ ...formData, editorCommand: e.target.value })}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
              </div>
            </div>
          )}

          {activeTab === 'workflow' && (
            <div className="space-y-4">
              <div>
                <label htmlFor="edit-app-work-tracker" className="block text-sm text-gray-400 mb-1">Work Tracker</label>
                <select
                  id="edit-app-work-tracker"
                  value={formData.workTracker}
                  onChange={e => setFormData(prev => ({ ...prev, workTracker: e.target.value }))}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                >
                  {WORK_TRACKER_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                {workTrackerInfo && (() => {
                  const isAuto = formData.workTracker === 'auto';
                  const tracker = isAuto ? workTrackerInfo.resolved : formData.workTracker;
                  const label = WORK_TRACKER_LABELS[tracker] || tracker;
                  const host = workTrackerInfo.host;
                  return (
                    <p className="text-xs text-gray-500 mt-1">
                      {isAuto ? 'Auto → ' : 'Resolved: '}{label}{host ? ` (origin: ${host})` : ''}
                    </p>
                  );
                })()}
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.defaultUseWorktree}
                  onChange={e => {
                    const updates = { defaultUseWorktree: e.target.checked };
                    if (!e.target.checked) updates.defaultOpenPR = false;
                    setFormData(prev => ({ ...prev, ...updates }));
                  }}
                  className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                />
                <GitBranch size={14} className="text-emerald-400" />
                <span className="text-sm text-white" title="When checked, new tasks default to working in an isolated git worktree on a feature branch. When unchecked, agents commit directly to the default branch.">Default to Worktree for new tasks</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer ml-6">
                <input
                  type="checkbox"
                  checked={formData.defaultOpenPR}
                  disabled={!formData.defaultUseWorktree}
                  onChange={e => setFormData(prev => ({ ...prev, defaultOpenPR: e.target.checked }))}
                  className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent disabled:opacity-40"
                />
                <GitPullRequest size={14} className="text-blue-400" />
                <span className={`text-sm ${formData.defaultUseWorktree ? 'text-white' : 'text-gray-600'}`} title="When checked, agents open a PR to the default branch. When unchecked with worktree enabled, agents auto-merge to the default branch on completion.">Default to Open PR for new tasks</span>
              </label>
            </div>
          )}

          {activeTab === 'intelligence' && (
            <LayeredIntelligenceTab
              appId={app.id}
              li={liConfig || {}}
              onChange={updateLiConfig}
              providers={liProviders}
              isPortos={liIsPortos}
              loaded={liLoaded}
              error={liError}
              onRetry={loadLayeredIntelligence}
            />
          )}

          {activeTab === 'jira' && (
            <div className="space-y-3">
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
                    <Banner tone="warning" size="md">
                      No JIRA instances configured. <Link to="/devtools/jira" className="underline hover:text-white">Configure JIRA</Link> first.
                    </Banner>
                  ) : (
                    <>
                      <div>
                        <label htmlFor="edit-app-jira-instance" className="block text-sm text-gray-400 mb-1">JIRA Instance</label>
                        <select
                          id="edit-app-jira-instance"
                          value={formData.jiraInstanceId}
                          onChange={e => changeInstance(e.target.value)}
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                        >
                          <option value="">Select instance...</option>
                          {jiraInstances.map(inst => (
                            <option key={inst.id} value={inst.id}>{inst.name} ({inst.baseUrl})</option>
                          ))}
                        </select>
                      </div>

                      <div className="relative">
                        <label htmlFor="edit-app-jira-project" className="block text-sm text-gray-400 mb-1">Project Key</label>
                        {loadingProjects ? (
                          <div className="text-xs text-gray-500">Loading projects...</div>
                        ) : jiraProjects.length > 0 ? (
                          <div>
                            <input
                              id="edit-app-jira-project"
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
                              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                              placeholder="Search projects..."
                            />
                            {formData.jiraProjectKey && !projectDropdownOpen && (
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
                                {filteredJiraProjects
                                  .map(proj => (
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
                                        formData.jiraProjectKey === proj.key ? 'bg-port-accent/10 text-port-accent' : 'text-white'
                                      }`}
                                    >
                                      <span className="font-mono">{proj.key}</span>
                                      <span className="text-gray-400 ml-2">{proj.name}</span>
                                    </button>
                                  ))
                                }
                                {filteredJiraProjects.length === 0 && (
                                  <div className="px-3 py-2 text-sm text-gray-500">No matching projects</div>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <input
                            id="edit-app-jira-project"
                            type="text"
                            value={formData.jiraProjectKey}
                            onChange={e => setFormData({ ...formData, jiraProjectKey: e.target.value })}
                            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                            placeholder="e.g. CONTECH"
                          />
                        )}
                      </div>

                      <div>
                        <label htmlFor="edit-app-jira-board" className="block text-sm text-gray-400 mb-1">Board</label>
                        {!formData.jiraProjectKey ? (
                          <div className="text-xs text-gray-500">Select a project to detect its boards.</div>
                        ) : loadingBoards ? (
                          <div className="text-xs text-gray-500">Detecting boards…</div>
                        ) : jiraBoards.length > 0 ? (
                          <>
                            <select
                              id="edit-app-jira-board"
                              value={formData.jiraBoardId}
                              onChange={e => setFormData({ ...formData, jiraBoardId: e.target.value })}
                              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                            >
                              <option value="">Select board...</option>
                              {jiraBoards.map(b => (
                                <option key={b.id} value={String(b.id)}>{b.id} — {b.name} ({b.type})</option>
                              ))}
                              {boardIsStale && (
                                <option value={formData.jiraBoardId}>{formData.jiraBoardId} — (not in this project)</option>
                              )}
                            </select>
                            {boardIsStale ? (
                              <p className="text-xs text-port-warning mt-1">⚠ Saved board {formData.jiraBoardId} isn&apos;t among this project&apos;s boards — pick a current one.</p>
                            ) : formData.jiraBoardId && (
                              <p className="text-xs text-gray-500 mt-1">
                                {activeSprint ? `Active sprint: ${activeSprint.name}` : 'No active sprint on this board.'}
                              </p>
                            )}
                          </>
                        ) : (
                          <>
                            <input
                              id="edit-app-jira-board"
                              type="text"
                              value={formData.jiraBoardId}
                              onChange={e => setFormData({ ...formData, jiraBoardId: e.target.value })}
                              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                              placeholder="e.g. 1294 (from JIRA board URL rapidView param)"
                            />
                            <p className="text-xs text-gray-500 mt-1">Couldn&apos;t auto-detect boards — enter the id manually (board URL <span className="font-mono">rapidView</span> param).</p>
                          </>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label htmlFor="edit-app-jira-issue-type" className="block text-sm text-gray-400 mb-1">Issue Type</label>
                          <input
                            id="edit-app-jira-issue-type"
                            type="text"
                            value={formData.jiraIssueType}
                            onChange={e => setFormData({ ...formData, jiraIssueType: e.target.value })}
                            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                            placeholder="Task"
                          />
                        </div>
                        <div>
                          <label htmlFor="edit-app-jira-assignee" className="block text-sm text-gray-400 mb-1">Assignee</label>
                          <input
                            id="edit-app-jira-assignee"
                            type="text"
                            value={formData.jiraAssignee}
                            onChange={e => setFormData({ ...formData, jiraAssignee: e.target.value })}
                            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                            placeholder="Optional"
                          />
                        </div>
                      </div>

                      <div>
                        <label htmlFor="edit-app-jira-labels" className="block text-sm text-gray-400 mb-1">Labels (comma-separated)</label>
                        <input
                          id="edit-app-jira-labels"
                          type="text"
                          value={formData.jiraLabels}
                          onChange={e => setFormData({ ...formData, jiraLabels: e.target.value })}
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                          placeholder="e.g. cos-auto, feature"
                        />
                      </div>

                      <div className="relative">
                        <label htmlFor="edit-app-jira-epic" className="block text-sm text-gray-400 mb-1">Epic Key</label>
                        <input
                          id="edit-app-jira-epic"
                          type="text"
                          value={formData.jiraEpicKey}
                          onChange={e => setFormData({ ...formData, jiraEpicKey: e.target.value })}
                          onFocus={() => setEpicDropdownOpen(true)}
                          onBlur={() => setTimeout(() => setEpicDropdownOpen(false), 150)}
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                          placeholder="e.g. CONTECH-100, or type a name to search"
                        />
                        {epicDropdownOpen && epicResults.length > 0 && (
                          <div className="absolute z-50 w-full mt-1 bg-port-bg border border-port-border rounded-lg max-h-48 overflow-auto shadow-lg">
                            {epicResults.map(ep => (
                              <button
                                key={ep.key}
                                type="button"
                                onMouseDown={e => {
                                  e.preventDefault();
                                  setFormData({ ...formData, jiraEpicKey: ep.key });
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
                            {epicValidation.state === 'stale' && `⚠ ${formData.jiraEpicKey} doesn't resolve on this instance`}
                          </p>
                        )}
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

          {activeTab === 'datadog' && (
            <div className="space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.datadogEnabled}
                  onChange={e => setFormData({ ...formData, datadogEnabled: e.target.checked })}
                  className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                />
                <span className="text-sm text-white">Enable DataDog Monitoring</span>
              </label>

              {formData.datadogEnabled && (
                <>
                  {datadogInstances.length === 0 ? (
                    <Banner tone="warning" size="md">
                      No DataDog instances configured. <Link to="/devtools/datadog" className="underline hover:text-white">Configure DataDog</Link> first.
                    </Banner>
                  ) : (
                    <>
                      <div>
                        <label htmlFor="edit-app-datadog-instance" className="block text-sm text-gray-400 mb-1">DataDog Instance</label>
                        <select
                          id="edit-app-datadog-instance"
                          value={formData.datadogInstanceId}
                          onChange={e => setFormData({ ...formData, datadogInstanceId: e.target.value })}
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                        >
                          <option value="">Select instance...</option>
                          {datadogInstances.map(inst => (
                            <option key={inst.id} value={inst.id}>{inst.name} ({inst.site})</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label htmlFor="edit-app-datadog-service" className="block text-sm text-gray-400 mb-1">Service Name</label>
                        <input
                          id="edit-app-datadog-service"
                          type="text"
                          value={formData.datadogServiceName}
                          onChange={e => setFormData({ ...formData, datadogServiceName: e.target.value })}
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                          placeholder="e.g., my-app-service"
                        />
                        <p className="text-xs text-gray-500 mt-1">The &quot;service&quot; tag your app reports to DataDog RUM/APM (not the Application ID)</p>
                      </div>

                      <div>
                        <label htmlFor="edit-app-datadog-env" className="block text-sm text-gray-400 mb-1">Environment</label>
                        <input
                          id="edit-app-datadog-env"
                          type="text"
                          value={formData.datadogEnvironment}
                          onChange={e => setFormData({ ...formData, datadogEnvironment: e.target.value })}
                          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                          placeholder="e.g., production"
                        />
                        <p className="text-xs text-gray-500 mt-1">The &quot;env&quot; tag (e.g., production, qa, staging)</p>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

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
    </Drawer>
  );
}
