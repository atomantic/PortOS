import { useState } from 'react';
import { Plus, Trash2, RefreshCw, Mail, Globe, MessageSquare } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../services/api';

const TYPE_ICONS = { gmail: Mail, outlook: Globe, teams: MessageSquare };
const TYPE_LABELS = { gmail: 'Gmail (MCP)', outlook: 'Outlook (Playwright)', teams: 'Teams (Playwright)' };

export default function AccountsTab({ accounts, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'gmail', email: '' });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const handleCreate = async () => {
    if (!form.name) return toast.error('Name is required');
    setSaving(true);
    const result = await api.createMessageAccount(form).catch(() => null);
    setSaving(false);
    if (!result) return toast.error('Failed to create account');
    setShowForm(false);
    setForm({ name: '', type: 'gmail', email: '' });
    toast.success('Account created');
    onRefresh();
  };

  const handleDelete = async (id) => {
    setDeleting(id);
    const result = await api.deleteMessageAccount(id).catch(() => null);
    setDeleting(null);
    if (result === null) return toast.error('Failed to delete account');
    toast.success('Account deleted');
    onRefresh();
  };

  const handleToggle = async (account) => {
    const result = await api.updateMessageAccount(account.id, { enabled: !account.enabled }).catch(() => null);
    if (!result) return toast.error('Failed to update account');
    toast.success(account.enabled ? 'Account disabled' : 'Account enabled');
    onRefresh();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Accounts</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-3 py-2 bg-port-accent text-white rounded-lg text-sm hover:bg-port-accent/80 transition-colors"
        >
          <Plus size={16} />
          Add Account
        </button>
      </div>

      {showForm && (
        <div className="p-4 bg-port-card rounded-lg border border-port-border space-y-3">
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
              <option value="gmail">Gmail (MCP)</option>
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
    </div>
  );
}
