import { useState, useEffect } from 'react';
import { Plus, Trash2, RefreshCw, Globe, Calendar, Eye, EyeOff, ChevronDown, ChevronRight, Search, Key, ExternalLink, Wand2, Monitor } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../services/api';

const TYPE_ICONS = { 'outlook-calendar': Globe, 'google-calendar': Calendar };
const TYPE_LABELS = { 'outlook-calendar': 'Outlook Calendar (API)', 'google-calendar': 'Google Calendar' };

export default function ConfigTab({ accounts, setAccounts }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'outlook-calendar', email: '' });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [expandedAccounts, setExpandedAccounts] = useState({});
  const [savingSubcals, setSavingSubcals] = useState(null);
  const [discovering, setDiscovering] = useState(null);
  const [googleAuth, setGoogleAuth] = useState(null);
  const [oauthForm, setOauthForm] = useState({ clientId: '', clientSecret: '' });
  const [savingOAuth, setSavingOAuth] = useState(false);
  const [autoConfigStep, setAutoConfigStep] = useState(null); // null | 'launching' | 'login' | 'project' | 'api' | 'consent' | 'credentials' | 'capturing' | 'done'

  const fetchGoogleAuth = async () => {
    const status = await api.getGoogleAuthStatus().catch(() => null);
    setGoogleAuth(status);
  };

  useEffect(() => { fetchGoogleAuth(); }, []);

  const handleSaveOAuthCredentials = async () => {
    if (!oauthForm.clientId || !oauthForm.clientSecret) return toast.error('Both Client ID and Client Secret are required');
    setSavingOAuth(true);
    const result = await api.saveGoogleAuthCredentials(oauthForm).catch(() => null);
    setSavingOAuth(false);
    if (!result) return toast.error('Failed to save credentials');
    toast.success('OAuth credentials saved');
    fetchGoogleAuth();
    const authResult = await api.getGoogleAuthUrl().catch(() => null);
    if (authResult?.url) {
      window.open(authResult.url, '_blank');
      toast.success('Complete authorization in the opened browser tab');
    }
  };

  const handleStartOAuth = async () => {
    const result = await api.getGoogleAuthUrl().catch(() => null);
    if (result?.url) {
      window.open(result.url, '_blank');
      toast.success('Complete authorization in the opened browser tab');
    } else {
      toast.error(result?.error || 'Failed to get auth URL');
    }
  };

  const handleClearGoogleAuth = async () => {
    await api.clearGoogleAuth().catch(() => null);
    toast.success('Google auth cleared');
    fetchGoogleAuth();
  };

  const handleSyncMethodChange = async (account, method) => {
    const result = await api.updateCalendarAccount(account.id, { syncMethod: method }).catch(() => null);
    if (!result) return toast.error('Failed to update sync method');
    setAccounts(prev => prev.map(a => a.id === account.id ? { ...a, syncMethod: method } : a));
    toast.success(`Sync method set to ${method === 'google-api' ? 'Google API' : 'Claude MCP'}`);
  };

  const handleAutoConfigStart = async () => {
    const result = await api.startGoogleAutoConfig().catch(() => null);
    if (!result || result.error) {
      return toast.error(result?.error || 'Failed to open browser');
    }
    setAutoConfigStep('login');
    toast.success('Google Cloud Console opened in PortOS browser');
  };

  const handleAutoConfigContinue = async () => {
    setAutoConfigStep('running');
    // Find the google account's email to pass as test user
    const googleAccount = accounts.find(a => a.type === 'google-calendar');
    const email = googleAccount?.email || '';
    const result = await api.runGoogleAutoConfig(email).catch(() => null);
    if (!result || result.error) {
      setAutoConfigStep('login');
      return toast.error(result?.error || 'Automated setup failed. Try manual setup instead.');
    }
    if (result.status === 'partial') {
      toast('Setup partially completed. Some steps may need manual attention.', { icon: '⚠️' });
    } else {
      toast.success('Google OAuth setup complete!');
    }
    setAutoConfigStep('done');
    fetchGoogleAuth();
    if (result.authUrl) {
      window.open(result.authUrl, '_blank');
      toast.success('Complete Google authorization in the opened tab');
    }
  };

  const handleCreate = async () => {
    if (!form.name) return toast.error('Name is required');
    setSaving(true);
    const result = await api.createCalendarAccount(form).catch(() => null);
    setSaving(false);
    if (!result) return toast.error('Failed to create account');
    setShowForm(false);
    setForm({ name: '', type: 'outlook-calendar', email: '' });
    toast.success('Account created');
    setAccounts(prev => [...prev, result]);
    // Auto-expand google-calendar accounts so user can discover calendars
    if (form.type === 'google-calendar') {
      setExpandedAccounts(prev => ({ ...prev, [result.id]: true }));
    }
  };

  const handleDelete = async (id) => {
    setDeleting(id);
    const ok = await api.deleteCalendarAccount(id).then(() => true).catch(() => false);
    setDeleting(null);
    if (!ok) return;
    toast.success('Account deleted');
    setAccounts(prev => prev.filter(a => a.id !== id));
  };

  const handleToggle = async (account) => {
    const result = await api.updateCalendarAccount(account.id, { enabled: !account.enabled }).catch(() => null);
    if (!result) return toast.error('Failed to update account');
    toast.success(account.enabled ? 'Account disabled' : 'Account enabled');
    setAccounts(prev => prev.map(a => a.id === account.id ? { ...a, enabled: !a.enabled } : a));
  };

  const toggleExpand = (id) => {
    setExpandedAccounts(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSubcalendarToggle = async (account, calendarId, field, value) => {
    const subcalendars = (account.subcalendars || []).map(sc =>
      sc.calendarId === calendarId ? { ...sc, [field]: value } : sc
    );
    // Update local state immediately for visual feedback
    setAccounts(prev => prev.map(a => a.id === account.id ? { ...a, subcalendars } : a));
    setSavingSubcals(account.id);
    const result = await api.updateSubcalendars(account.id, { subcalendars }).catch(() => null);
    setSavingSubcals(null);
    if (!result) return toast.error('Failed to update subcalendars');
  };

  const handleDiscoverCalendars = async (account) => {
    setDiscovering(account.id);
    const useApi = account.syncMethod === 'google-api' && googleAuth?.hasTokens;
    const result = useApi
      ? await api.apiDiscoverCalendars(account.id).catch(() => null)
      : await api.mcpDiscoverCalendars(account.id).catch(() => null);
    setDiscovering(null);
    if (!result || result.error) {
      if (result?.error?.includes('spawn Claude')) {
        return toast.error('Claude CLI not found. Ensure Claude Code is installed and in your PATH.');
      }
      if (result?.error?.includes('OAuth')) {
        return toast.error('Google OAuth not configured. Set up credentials below.');
      }
      return;
    }
    toast.success(`Discovered ${result.calendars?.length || 0} calendars`);
    setAccounts(prev => prev.map(a => a.id === account.id ? { ...a, subcalendars: result.calendars } : a));
  };

  const handleEnableAll = async (account) => {
    const subcalendars = (account.subcalendars || []).map(sc => ({ ...sc, enabled: true, dormant: false }));
    setSavingSubcals(account.id);
    const result = await api.updateSubcalendars(account.id, { subcalendars }).catch(() => null);
    setSavingSubcals(null);
    if (!result) return toast.error('Failed to update');
    setAccounts(prev => prev.map(a => a.id === account.id ? { ...a, subcalendars } : a));
    toast.success('All calendars enabled');
  };

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-white">Calendar Accounts</h2>
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 px-3 py-2 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 transition-colors"
          >
            <Plus size={16} />
            Add Account
          </button>
        </div>

        {showForm && (
          <div className="p-4 bg-port-card rounded-lg border border-port-border space-y-3 mb-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Work Calendar"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Type</label>
              <select
                value={form.type}
                onChange={(e) => setForm(f => ({ ...f, type: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white focus:outline-none focus:border-port-accent"
              >
                <option value="outlook-calendar">Outlook Calendar (API)</option>
                <option value="google-calendar">Google Calendar (MCP Push)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Email{form.type === 'google-calendar' ? ' (used as OAuth test user)' : ''}</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="user@example.com"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={saving}
                className="px-4 py-2 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 transition-colors disabled:opacity-50"
              >
                {saving ? 'Creating...' : 'Create'}
              </button>
              <button
                onClick={() => setShowForm(false)}
                className="px-4 py-2 bg-port-border text-gray-300 rounded-lg text-sm hover:bg-port-border/80 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {accounts.length === 0 && !showForm && (
          <div className="text-center py-12 text-gray-500">
            <Globe size={48} className="mx-auto mb-4 opacity-50" />
            <p>No calendar accounts configured</p>
            <p className="text-sm mt-1">Add an Outlook or Google Calendar account to get started</p>
          </div>
        )}

        <div className="space-y-2">
          {accounts.map((account) => {
            const Icon = TYPE_ICONS[account.type] || Globe;
            const isExpanded = expandedAccounts[account.id];
            const isGoogle = account.type === 'google-calendar';
            const subcals = account.subcalendars || [];
            const enabledCount = subcals.filter(s => s.enabled && !s.dormant).length;
            return (
              <div key={account.id} className="bg-port-card rounded-lg border border-port-border">
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    {isGoogle && (
                      <button onClick={() => toggleExpand(account.id)} className="p-0.5 text-gray-500 hover:text-white">
                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                    )}
                    <Icon size={20} className={account.enabled ? 'text-port-accent' : 'text-gray-600'} />
                    <div>
                      <div className="text-sm font-medium text-white">{account.name}</div>
                      <div className="text-xs text-gray-500">
                        {TYPE_LABELS[account.type]} {account.email ? `· ${account.email}` : ''}
                        {isGoogle && subcals.length > 0 && ` · ${enabledCount}/${subcals.length} active`}
                        {isGoogle && subcals.length === 0 && ' · No calendars discovered'}
                      </div>
                      {account.lastSyncAt && (
                        <div className="text-xs text-gray-600">
                          Last sync: {new Date(account.lastSyncAt).toLocaleString()} ({account.lastSyncStatus})
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleToggle(account)}
                      className={`px-2 py-1 rounded text-xs transition-colors ${
                        account.enabled
                          ? 'bg-port-success/20 text-port-success'
                          : 'bg-gray-700 text-gray-400'
                      }`}
                    >
                      {account.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                    <button
                      onClick={() => handleDelete(account.id)}
                      disabled={deleting === account.id}
                      className="p-1 text-gray-500 hover:text-port-error transition-colors"
                      title="Delete account"
                    >
                      {deleting === account.id ? (
                        <RefreshCw size={16} className="animate-spin" />
                      ) : (
                        <Trash2 size={16} />
                      )}
                    </button>
                  </div>
                </div>

                {/* Google Calendar expanded settings */}
                {isGoogle && isExpanded && (
                  <div className="border-t border-port-border px-4 py-3 space-y-3">
                    {/* Sync Method & OAuth Setup — first so user configures before discovering */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500 font-medium">Sync Method</span>
                        <select
                          value={account.syncMethod || 'claude-mcp'}
                          onChange={(e) => handleSyncMethodChange(account, e.target.value)}
                          className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
                        >
                          <option value="claude-mcp">Claude MCP (zero config)</option>
                          <option value="google-api">Google API (direct, faster)</option>
                        </select>
                      </div>

                      {(account.syncMethod || 'claude-mcp') === 'claude-mcp' && (
                        <div className="text-xs text-gray-600 px-2 py-1.5 bg-port-bg/50 rounded">
                          Uses your Claude Code CLI with Google Calendar MCP integration.
                          Requires <span className="text-gray-400">claude</span> CLI installed and Google Calendar connected in Claude &gt; Settings &gt; Integrations.
                        </div>
                      )}

                      {account.syncMethod === 'google-api' && (
                        <div className="space-y-2">
                          {googleAuth?.hasCredentials && googleAuth?.hasTokens ? (
                            <div className="flex items-center justify-between px-2 py-1.5 bg-port-success/5 rounded">
                              <div className="flex items-center gap-1.5 text-xs text-port-success">
                                <Key size={12} />
                                <span>Google API authenticated</span>
                                {googleAuth.expiryDate && (
                                  <span className="text-gray-600">
                                    (expires {new Date(googleAuth.expiryDate).toLocaleDateString()})
                                  </span>
                                )}
                              </div>
                              <button
                                onClick={handleClearGoogleAuth}
                                className="px-2 py-0.5 text-xs rounded text-gray-600 hover:text-port-error hover:bg-gray-800"
                              >
                                Clear
                              </button>
                            </div>
                          ) : googleAuth?.hasCredentials ? (
                            <div className="space-y-2 px-2 py-1.5 bg-port-warning/5 rounded">
                              <div className="text-xs text-port-warning">Credentials saved but not authorized yet.</div>
                              <button
                                onClick={handleStartOAuth}
                                className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30"
                              >
                                <ExternalLink size={12} /> Authorize with Google
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              <div className="text-xs text-gray-500">
                                Connect directly to Google Calendar API for fast, reliable syncing without Claude.
                              </div>

                              {/* Auto-Configure with Browser */}
                              {!autoConfigStep ? (
                                <button
                                  onClick={handleAutoConfigStart}
                                  className="flex items-center gap-1.5 w-full px-3 py-2 text-xs rounded bg-port-accent/10 text-port-accent hover:bg-port-accent/20 border border-port-accent/20"
                                >
                                  <Monitor size={14} />
                                  Setup with PortOS Browser (automated)
                                </button>
                              ) : autoConfigStep === 'running' ? (
                                <div className="flex items-center gap-2 p-3 bg-port-bg/80 rounded border border-port-border">
                                  <RefreshCw size={14} className="text-port-accent animate-spin shrink-0" />
                                  <div className="text-xs text-gray-400">
                                    Automating Google Cloud setup... enabling Calendar API, configuring OAuth consent, creating credentials.
                                    This may take up to a minute.
                                  </div>
                                </div>
                              ) : autoConfigStep === 'login' ? (
                                <div className="space-y-2 p-2.5 bg-port-bg/80 rounded border border-port-border">
                                  <div className="flex items-center gap-1.5 text-xs font-medium text-port-accent">
                                    <Monitor size={12} />
                                    Google Cloud Console is open in the PortOS browser
                                  </div>
                                  <div className="text-xs text-gray-400 space-y-1">
                                    <p>1. Log in to your Google account (if not already logged in)</p>
                                    <p>2. Select or create a Google Cloud project</p>
                                    <p>Then click Continue — PortOS will automate the rest (enable API, configure OAuth, create credentials).</p>
                                  </div>
                                  <div className="flex gap-2 pt-1">
                                    <button
                                      onClick={handleAutoConfigContinue}
                                      disabled={autoConfigStep === 'running'}
                                      className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50"
                                    >
                                      <Wand2 size={12} /> Continue
                                    </button>
                                    <button
                                      onClick={() => setAutoConfigStep(null)}
                                      className="px-3 py-1.5 text-xs rounded bg-port-border text-gray-400 hover:text-white"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : autoConfigStep === 'done' ? (
                                <div className="flex items-center gap-1.5 text-xs text-port-success p-2">
                                  <Key size={12} />
                                  Setup complete — credentials captured. Authorize below if prompted.
                                </div>
                              ) : null}

                              {/* Manual setup (always available as fallback) */}
                              <details className="text-xs text-gray-600">
                                <summary className="cursor-pointer text-gray-400 hover:text-white font-medium">Manual setup (paste credentials)</summary>
                                <div className="mt-2 space-y-1.5">
                                  <input
                                    type="text"
                                    value={oauthForm.clientId}
                                    onChange={e => setOauthForm(f => ({ ...f, clientId: e.target.value }))}
                                    placeholder="Client ID (e.g. 123456789-abc.apps.googleusercontent.com)"
                                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white placeholder-gray-600"
                                  />
                                  <input
                                    type="password"
                                    value={oauthForm.clientSecret}
                                    onChange={e => setOauthForm(f => ({ ...f, clientSecret: e.target.value }))}
                                    placeholder="Client Secret (e.g. GOCSPX-...)"
                                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white placeholder-gray-600"
                                  />
                                  <button
                                    onClick={handleSaveOAuthCredentials}
                                    disabled={savingOAuth || !oauthForm.clientId || !oauthForm.clientSecret}
                                    className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50"
                                  >
                                    {savingOAuth ? 'Saving...' : 'Save & Authorize'}
                                  </button>
                                </div>
                              </details>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Sub-calendars */}
                    <div className="border-t border-port-border pt-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-gray-500 font-medium">
                          Sub-calendars {subcals.length > 0 && `(${subcals.length})`}
                        </div>
                        <div className="flex items-center gap-2">
                          {subcals.length > 0 && (
                            <button
                              onClick={() => handleEnableAll(account)}
                              disabled={savingSubcals === account.id}
                              className="px-2 py-0.5 text-xs rounded text-gray-500 hover:text-white hover:bg-gray-800"
                            >
                              Enable All
                            </button>
                          )}
                          <button
                            onClick={() => handleDiscoverCalendars(account)}
                            disabled={discovering === account.id}
                            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 disabled:opacity-50"
                          >
                            {discovering === account.id ? (
                              <RefreshCw size={12} className="animate-spin" />
                            ) : (
                              <Search size={12} />
                            )}
                            {discovering === account.id ? 'Discovering...' : subcals.length > 0 ? 'Refresh' : 'Discover Calendars'}
                          </button>
                        </div>
                      </div>

                      {subcals.length === 0 && discovering !== account.id && (
                        <div className="text-xs text-gray-600 py-2">
                          Click "Discover Calendars" to fetch your Google Calendar list.
                        </div>
                      )}

                      {subcals.map(sc => (
                        <div
                          key={sc.calendarId}
                          className={`flex items-center justify-between py-1.5 px-2 rounded ${
                            sc.dormant ? 'opacity-50' : ''
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <label className="relative w-4 h-4 shrink-0 cursor-pointer" title="Change color">
                              <div className="w-4 h-4 rounded-full border border-port-border" style={{ backgroundColor: sc.color || '#3b82f6' }} />
                              <input
                                type="color"
                                value={sc.color || '#3b82f6'}
                                onChange={(e) => handleSubcalendarToggle(account, sc.calendarId, 'color', e.target.value)}
                                className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                              />
                            </label>
                            <div className="min-w-0">
                              <div className={`text-xs font-medium truncate ${sc.dormant ? 'text-gray-500' : 'text-gray-300'}`}>
                                {sc.name}
                              </div>
                              <div className="text-xs text-gray-600 truncate">{sc.calendarId}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {sc.dormant ? (
                              <button
                                onClick={() => handleSubcalendarToggle(account, sc.calendarId, 'dormant', false)}
                                disabled={savingSubcals === account.id}
                                className="px-2 py-0.5 text-xs rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30"
                              >
                                Activate
                              </button>
                            ) : (
                              <>
                                <button
                                  onClick={() => handleSubcalendarToggle(account, sc.calendarId, 'enabled', !sc.enabled)}
                                  disabled={savingSubcals === account.id}
                                  className="p-0.5"
                                  title={sc.enabled ? 'Disable' : 'Enable'}
                                >
                                  {sc.enabled ? (
                                    <Eye size={14} className="text-port-success" />
                                  ) : (
                                    <EyeOff size={14} className="text-gray-600" />
                                  )}
                                </button>
                                <button
                                  onClick={() => handleSubcalendarToggle(account, sc.calendarId, 'dormant', true)}
                                  disabled={savingSubcals === account.id}
                                  className="px-1.5 py-0.5 text-xs rounded text-gray-600 hover:text-gray-400 hover:bg-gray-800"
                                  title="Mark dormant"
                                >
                                  Dormant
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
