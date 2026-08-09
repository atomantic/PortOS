import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router';
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
import { DEFAULT_PR_COMPLETION, PR_COMPLETION_OPTIONS, prCompletionOption } from '../cos/constants';
import { WORK_TRACKER_OPTIONS, WORK_TRACKER_LABELS } from './constants';

// JIRA is deliberately absent: its config moved to the app detail page's JIRA
// tab (/apps/:id/jira), where it sits next to the sprint board it drives and has
// the width the instance/project/board pickers need. This drawer therefore never
// sends a `jira` key — the PUT shallow-merges server-side, so the stored config
// is preserved untouched.
const TABS = [
  { id: 'general', label: 'General' },
  { id: 'ports', label: 'Ports & TLS' },
  { id: 'commands', label: 'Commands' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'intelligence', label: 'Intelligence' },
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
    nativeLaunchEnabled: !!app.nativeLaunch,
    nativeLaunchLabel: app.nativeLaunch?.label || 'Desktop',
    nativeLaunchCommand: app.nativeLaunch?.command || '',
    nativeLaunchProcessName: app.nativeLaunch?.processName || '',
    editorCommand: app.editorCommand || 'code .',
    workTracker: app.workTracker || 'auto',
    defaultOpenPR: app.defaultOpenPR || false,
    defaultPrCompletion: app.defaultPrCompletion || DEFAULT_PR_COMPLETION,
    defaultUseWorktree: app.defaultUseWorktree || app.defaultOpenPR || false,
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
  const [datadogInstances, setDatadogInstances] = useState([]);

  useEffect(() => {
    api.getDatadogInstances()
      .then(data => setDatadogInstances(data?.instances ? Object.values(data.instances) : []))
      .catch(() => setDatadogInstances([]));
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

    if (formData.nativeLaunchEnabled) {
      const nativeFields = [
        ['nativeLaunchLabel', 'Native button label'],
        ['nativeLaunchProcessName', 'Native PM2 process name'],
        ['nativeLaunchCommand', 'Native launch command']
      ];
      const missing = nativeFields.find(([key]) => !formData[key]?.trim());
      if (missing) {
        setActiveTab('commands');
        setError(`${missing[1]} is required.`);
        return;
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(formData.nativeLaunchProcessName.trim())) {
        setActiveTab('commands');
        setError('Native PM2 process name may contain only letters, numbers, dots, underscores, and hyphens.');
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
      nativeLaunch: formData.nativeLaunchEnabled ? {
        label: formData.nativeLaunchLabel.trim(),
        command: formData.nativeLaunchCommand.trim(),
        processName: formData.nativeLaunchProcessName.trim()
      } : null,
      editorCommand: formData.editorCommand || undefined,
      workTracker: formData.workTracker || 'auto',
      defaultUseWorktree: formData.defaultUseWorktree || formData.defaultOpenPR,
      defaultOpenPR: formData.defaultOpenPR,
      defaultPrCompletion: formData.defaultPrCompletion,
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
      // The form is long-lived and spans several tabs, so an accidental Esc /
      // backdrop click mid-edit would discard work across all of them. Preserve
      // the modal's no-accidental-dismiss behavior.
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
            switch. All mutable form state (formData, error, saving, the layered
            intelligence working copy) therefore MUST live above the Drawer body
            in this component — never in an uncontrolled input or subcomponent
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
                        <pre className="always-dark bg-black/40 text-gray-200 p-2 rounded overflow-x-auto font-mono text-[11px] leading-tight">{tlsResult.snippet}</pre>
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

              <div className="bg-port-bg/50 border border-port-border rounded-lg p-3 space-y-3">
                <label htmlFor="edit-app-native-enabled" className="flex items-center gap-2 cursor-pointer">
                  <input
                    id="edit-app-native-enabled"
                    type="checkbox"
                    checked={formData.nativeLaunchEnabled}
                    onChange={e => setFormData(prev => ({ ...prev, nativeLaunchEnabled: e.target.checked }))}
                    className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                  />
                  <span className="text-sm text-white">Separate native launch action</span>
                </label>
                <p className="text-xs text-gray-500">
                  Adds a button beside the standard web Launch. The native process runs once and stays stopped when its window closes.
                </p>
                {formData.nativeLaunchEnabled && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="edit-app-native-label" className="block text-sm text-gray-400 mb-1">Button Label</label>
                      <input
                        id="edit-app-native-label"
                        type="text"
                        value={formData.nativeLaunchLabel}
                        onChange={e => setFormData(prev => ({ ...prev, nativeLaunchLabel: e.target.value }))}
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                        placeholder="Godot"
                        required
                      />
                    </div>
                    <div>
                      <label htmlFor="edit-app-native-process" className="block text-sm text-gray-400 mb-1">PM2 Process Name</label>
                      <input
                        id="edit-app-native-process"
                        type="text"
                        value={formData.nativeLaunchProcessName}
                        onChange={e => setFormData(prev => ({ ...prev, nativeLaunchProcessName: e.target.value }))}
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                        placeholder="my-app-game"
                        required
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label htmlFor="edit-app-native-command" className="block text-sm text-gray-400 mb-1">Native Launch Command</label>
                      <input
                        id="edit-app-native-command"
                        type="text"
                        value={formData.nativeLaunchCommand}
                        onChange={e => setFormData(prev => ({ ...prev, nativeLaunchCommand: e.target.value }))}
                        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden font-mono text-sm"
                        placeholder="./scripts/game run"
                        required
                      />
                    </div>
                  </div>
                )}
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
                <span className={`text-sm ${formData.defaultUseWorktree ? 'text-white' : 'text-gray-600'}`} title="When checked, agents open a PR to the default branch. Choose below whether new PRs are reviewed and merged, merged on green CI, or left open. When unchecked with worktree enabled, agents merge the branch directly on completion.">Default to Open PR for new tasks</span>
              </label>
              <div className="ml-6 mt-2 max-w-sm">
                <label htmlFor="edit-app-default-pr-completion" className={`block text-sm mb-1 ${formData.defaultOpenPR ? 'text-gray-400' : 'text-gray-600'}`}>Default PR completion</label>
                <select
                  id="edit-app-default-pr-completion"
                  value={formData.defaultPrCompletion}
                  disabled={!formData.defaultOpenPR}
                  onChange={e => setFormData(prev => ({ ...prev, defaultPrCompletion: e.target.value }))}
                  className="w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-hidden disabled:opacity-40"
                >
                  {PR_COMPLETION_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  {prCompletionOption(formData.defaultPrCompletion)?.description}
                </p>
              </div>
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
