import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, RefreshCw, Mail, Globe, MessageSquare, Save, ExternalLink, User } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import ProviderModelSelector from '../ProviderModelSelector';
import useProviderModels from '../../hooks/useProviderModels';

const TYPE_ICONS = { gmail: Mail, outlook: Globe, teams: MessageSquare };
const TYPE_LABELS = { gmail: 'Gmail (API)', outlook: 'Outlook (Playwright)', teams: 'Teams (Playwright)' };

const DEFAULT_REPLY_TEMPLATE = `You are a professional email assistant. Draft a reply to the following email.

From: {{from}}
Subject: {{subject}}
Body:
{{body}}

{{#instructions}}
Additional instructions: {{instructions}}
{{/instructions}}

Write a professional, concise reply. Match the tone of the original message.`;

const DEFAULT_FORWARD_TEMPLATE = `You are a professional email assistant. Draft a forwarding message for the following email.

Original From: {{from}}
Subject: {{subject}}
Body:
{{body}}

{{#instructions}}
Additional instructions: {{instructions}}
{{/instructions}}

Write a brief forwarding note to introduce the email to the recipient.`;

export default function ConfigTab({ accounts, setAccounts }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'gmail', email: '' });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [clearingCache, setClearingCache] = useState(null);
  const [confirmClear, setConfirmClear] = useState(null);

  // Google OAuth status for Gmail accounts
  const [googleAuth, setGoogleAuth] = useState(null);
  const [reauthorizing, setReauthorizing] = useState(false);

  // AI config
  const [config, setConfig] = useState(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configDirty, setConfigDirty] = useState(false);

  // Separate provider/model selectors for triage and reply
  const triage = useProviderModels();
  const reply = useProviderModels();
  const {
    selectedProviderId: triageSelectedProviderId,
    selectedModel: triageSelectedModel,
    setSelectedProviderId: setTriageSelectedProviderId,
    setSelectedModel: setTriageSelectedModel
  } = triage;
  const {
    selectedProviderId: replySelectedProviderId,
    selectedModel: replySelectedModel,
    setSelectedProviderId: setReplySelectedProviderId,
    setSelectedModel: setReplySelectedModel
  } = reply;

  const loadConfig = useCallback(async () => {
    const settings = await api.getSettings().catch(() => ({}));
    const msgConfig = settings?.messages || {};
    const triageConfig = msgConfig.triage || {};
    const replyConfig = msgConfig.reply || {};
    setConfig({
      replyTemplate: msgConfig.replyTemplate || DEFAULT_REPLY_TEMPLATE,
      forwardTemplate: msgConfig.forwardTemplate || DEFAULT_FORWARD_TEMPLATE,
      voiceMode: msgConfig.voiceMode ?? false
    });
    // Restore saved provider/model - per-action configs with legacy fallback
    const triageProviderId = triageConfig.providerId || msgConfig.providerId;
    const triageModel = triageConfig.model || msgConfig.model;
    const replyProviderId = replyConfig.providerId || msgConfig.providerId;
    const replyModel = replyConfig.model || msgConfig.model;
    if (triageProviderId) setTriageSelectedProviderId(triageProviderId);
    if (triageModel) setTriageSelectedModel(triageModel);
    if (replyProviderId) setReplySelectedProviderId(replyProviderId);
    if (replyModel) setReplySelectedModel(replyModel);
    setConfigLoading(false);
  }, [setReplySelectedModel, setReplySelectedProviderId, setTriageSelectedModel, setTriageSelectedProviderId]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // Check Google OAuth status when Gmail accounts exist
  const hasGmailAccount = accounts.some(a => a.type === 'gmail');
  useEffect(() => {
    if (hasGmailAccount) {
      api.getGoogleAuthStatus().then(setGoogleAuth).catch(() => {});
    }
  }, [hasGmailAccount]);

  const handleReauthorize = () => {
    setReauthorizing(true);
    api.getGoogleAuthUrl()
      .then(({ url }) => { window.open(url, '_blank'); })
      .catch(() => toast.error('Failed to get auth URL'))
      .finally(() => setReauthorizing(false));
  };

  const handleEnableGmailApi = () => {
    api.enableGmailApi()
      .then(r => toast.success(r.message))
      .catch(() => toast.error('Failed to open Gmail API page'));
  };

  const handleSaveConfig = async () => {
    const patch = {
      messages: {
        triage: {
          providerId: triageSelectedProviderId,
          model: triageSelectedModel
        },
        reply: {
          providerId: replySelectedProviderId,
          model: replySelectedModel
        },
        replyTemplate: config.replyTemplate,
        forwardTemplate: config.forwardTemplate,
        voiceMode: config.voiceMode
      }
    };
    const result = await api.updateSettings(patch).catch(() => null);
    if (!result) return toast.error('Failed to save config');
    toast.success('Message config saved');
    setConfigDirty(false);
  };

  const updateTemplate = (key, value) => {
    setConfig(prev => ({ ...prev, [key]: value }));
    setConfigDirty(true);
  };

  // Account CRUD
  const handleCreate = async () => {
    if (!form.name) return toast.error('Name is required');
    setSaving(true);
    const result = await api.createMessageAccount(form).catch(() => null);
    setSaving(false);
    if (!result) return toast.error('Failed to create account');
    setShowForm(false);
    setForm({ name: '', type: 'gmail', email: '' });
    toast.success('Account created');
    setAccounts(prev => [...prev, result]);
  };

  const handleDelete = async (id) => {
    setDeleting(id);
    const ok = await api.deleteMessageAccount(id).then(() => true).catch(() => false);
    setDeleting(null);
    if (!ok) return;
    toast.success('Account deleted');
    setAccounts(prev => prev.filter(a => a.id !== id));
  };

  const handleToggle = async (account) => {
    const result = await api.updateMessageAccount(account.id, { enabled: !account.enabled }).catch(() => null);
    if (!result) return toast.error('Failed to update account');
    toast.success(account.enabled ? 'Account disabled' : 'Account enabled');
    setAccounts(prev => prev.map(a => a.id === account.id ? { ...a, enabled: !a.enabled } : a));
  };

  const handleClearCache = async (accountId) => {
    if (confirmClear !== accountId) {
      setConfirmClear(accountId);
      return;
    }
    setConfirmClear(null);
    setClearingCache(accountId);
    const result = await api.clearMessageCache(accountId).catch(() => null);
    setClearingCache(null);
    if (!result) return;
    toast.success('Cache cleared');
  };

  const renderProviderSection = (label, description, hook) => (
    <div className="p-4 bg-port-card rounded-lg border border-port-border">
      <h3 className="text-sm font-medium text-white mb-1">{label}</h3>
      <p className="text-xs text-gray-500 mb-3">{description}</p>
      {hook.loading ? (
        <RefreshCw size={16} className="text-port-accent animate-spin" />
      ) : hook.providers.length === 0 ? (
        <p className="text-sm text-gray-500">No AI providers configured. Add one in AI Providers.</p>
      ) : (
        <ProviderModelSelector
          providers={hook.providers}
          selectedProviderId={hook.selectedProviderId}
          selectedModel={hook.selectedModel}
          availableModels={hook.availableModels}
          onProviderChange={(id) => { hook.setSelectedProviderId(id); setConfigDirty(true); }}
          onModelChange={(m) => { hook.setSelectedModel(m); setConfigDirty(true); }}
        />
      )}
    </div>
  );

  return (
    <div className="space-y-8">
      {/* Accounts */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-white">Email Accounts</h2>
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 px-3 py-2 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 transition-colors"
          >
            <Plus size={16} />
            Add Account
          </button>
        </div>

        {hasGmailAccount && (
          <div className="p-4 mb-4 bg-port-card border border-port-border rounded-lg space-y-3">
            <h3 className="text-sm font-medium text-white">Gmail Setup</h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <span className={`w-2 h-2 rounded-full ${googleAuth?.hasTokens ? 'bg-port-success' : 'bg-port-error'}`} />
                  <span className="text-gray-300">Google OAuth</span>
                </div>
                {googleAuth?.hasTokens ? (
                  <button
                    onClick={handleReauthorize}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                    title="Re-authorize to update permissions"
                  >
                    <RefreshCw size={12} />
                    Re-authorize
                  </button>
                ) : (
                  <button
                    onClick={handleReauthorize}
                    disabled={reauthorizing}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-port-warning/20 text-port-warning text-xs rounded-lg hover:bg-port-warning/30 transition-colors disabled:opacity-50"
                  >
                    <ExternalLink size={14} />
                    Authorize
                  </button>
                )}
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <span className="w-2 h-2 rounded-full bg-gray-500" />
                  <span className="text-gray-300">Gmail API enabled</span>
                </div>
                <button
                  onClick={handleEnableGmailApi}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                  title="Open Google Cloud Console to enable Gmail API"
                >
                  <ExternalLink size={12} />
                  Enable in Console
                </button>
              </div>
            </div>
            <p className="text-xs text-gray-500">
              Gmail requires: 1) Gmail API enabled in Google Cloud Console, 2) Google OAuth authorized with Gmail scopes.
              If sync fails with "API not enabled", click "Enable in Console" above.
            </p>
          </div>
        )}

        {showForm && (
          <div className="p-4 bg-port-card rounded-lg border border-port-border space-y-3 mb-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Work Gmail"
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
                <option value="gmail">Gmail (API)</option>
                <option value="outlook">Outlook (Playwright)</option>
                <option value="teams">Teams (Playwright)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Email</label>
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
            <Mail size={48} className="mx-auto mb-4 opacity-50" />
            <p>No accounts configured</p>
            <p className="text-sm mt-1">Add a Gmail, Outlook, or Teams account to get started</p>
          </div>
        )}

        <div className="space-y-2">
          {accounts.map((account) => {
            const Icon = TYPE_ICONS[account.type] || Mail;
            return (
              <div
                key={account.id}
                className="flex items-center justify-between p-4 bg-port-card rounded-lg border border-port-border"
              >
                <div className="flex items-center gap-3">
                  <Icon size={20} className={account.enabled ? 'text-port-accent' : 'text-gray-600'} />
                  <div>
                    <div className="text-sm font-medium text-white">{account.name}</div>
                    <div className="text-xs text-gray-500">
                      {TYPE_LABELS[account.type]} · {account.email || 'No email set'}
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
                    onClick={() => handleClearCache(account.id)}
                    disabled={clearingCache === account.id}
                    className={`px-2 py-1 rounded text-xs transition-colors ${
                      confirmClear === account.id
                        ? 'bg-port-error/20 text-port-error'
                        : 'bg-port-warning/10 text-port-warning hover:bg-port-warning/20'
                    } disabled:opacity-50`}
                    onBlur={() => setConfirmClear(null)}
                    title="Clear cached messages for this account"
                  >
                    {clearingCache === account.id ? 'Clearing...' : confirmClear === account.id ? 'Are you sure?' : 'Clear Cache'}
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
            );
          })}
        </div>
      </section>

      {/* AI Provider & Model */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">AI Provider & Model</h2>
        <p className="text-sm text-gray-500 mb-3">
          Configure separate AI providers for email triage (classification) and reply generation.
        </p>
        <div className="space-y-3">
          {renderProviderSection(
            'Triage',
            'Classifies emails as reply/archive/delete/review with priority. A fast, cheap model works well here.',
            triage
          )}
          {renderProviderSection(
            'Reply Generation',
            'Generates draft email replies. A more capable model produces better responses.',
            reply
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold text-white mb-3">Digital Twin Voice</h2>
        <div className="p-4 bg-port-card rounded-lg border border-port-border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <User size={20} className={config?.voiceMode ? 'text-purple-400' : 'text-gray-600'} />
              <div>
                <div className="text-sm font-medium text-white">Voice Mode</div>
                <div className="text-xs text-gray-500">
                  Draft replies in your voice using Digital Twin personality documents (Soul, Communication, Personality, Values, Social)
                </div>
              </div>
            </div>
            <button
              onClick={() => { setConfig(prev => ({ ...prev, voiceMode: !prev.voiceMode })); setConfigDirty(true); }}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                config?.voiceMode
                  ? 'bg-purple-500/20 text-purple-400'
                  : 'bg-gray-700 text-gray-400'
              }`}
            >
              {config?.voiceMode ? 'Enabled' : 'Disabled'}
            </button>
          </div>
        </div>
      </section>

      {/* Prompt Templates */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">Prompt Templates</h2>
        <p className="text-sm text-gray-500 mb-3">
          Templates used when generating AI draft replies. Use {'{{variable}}'} syntax for substitution.
          Available: {'{{from}}'}, {'{{subject}}'}, {'{{body}}'}, {'{{instructions}}'}.
        </p>
        {configLoading ? (
          <RefreshCw size={16} className="text-port-accent animate-spin" />
        ) : (
          <div className="space-y-4">
            <div className="p-4 bg-port-card rounded-lg border border-port-border">
              <label className="block text-sm font-medium text-gray-300 mb-2">Reply Template</label>
              <textarea
                value={config.replyTemplate}
                onChange={(e) => updateTemplate('replyTemplate', e.target.value)}
                rows={8}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white font-mono placeholder-gray-500 focus:outline-none focus:border-port-accent resize-y"
              />
            </div>
            <div className="p-4 bg-port-card rounded-lg border border-port-border">
              <label className="block text-sm font-medium text-gray-300 mb-2">Forward Template</label>
              <textarea
                value={config.forwardTemplate}
                onChange={(e) => updateTemplate('forwardTemplate', e.target.value)}
                rows={6}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white font-mono placeholder-gray-500 focus:outline-none focus:border-port-accent resize-y"
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleSaveConfig}
                disabled={!configDirty}
                className="flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 transition-colors disabled:opacity-50"
              >
                <Save size={14} /> Save Config
              </button>
              {configDirty && <span className="text-xs text-port-warning">Unsaved changes</span>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
