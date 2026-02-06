import { useState, useEffect, useCallback } from 'react';
import * as api from '../../../services/api';
import { PLATFORM_TYPES, ACCOUNT_STATUSES } from '../constants';

export default function AccountsTab({ onRefresh }) {
  const [accounts, setAccounts] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    agentId: '',
    platform: 'moltbook',
    name: '',
    description: ''
  });
  const [testingId, setTestingId] = useState(null);
  const [testResult, setTestResult] = useState(null);

  const fetchData = useCallback(async () => {
    const [accountsData, agentsData] = await Promise.all([
      api.getPlatformAccounts(),
      api.getAgentPersonalities()
    ]);
    setAccounts(accountsData);
    setAgents(agentsData);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const resetForm = () => {
    setFormData({
      agentId: '',
      platform: 'moltbook',
      name: '',
      description: ''
    });
    setShowForm(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const result = await api.registerPlatformAccount(
      formData.agentId,
      formData.platform,
      formData.name,
      formData.description
    );

    resetForm();
    fetchData();
    onRefresh?.();

    // Show claim URL if returned
    if (result.claimUrl) {
      setTestResult({
        accountId: result.id,
        success: true,
        message: 'Account registered! Visit the claim URL to activate.',
        claimUrl: result.claimUrl
      });
    }
  };

  const handleDelete = async (id) => {
    await api.deletePlatformAccount(id);
    fetchData();
    onRefresh?.();
  };

  const handleTest = async (id) => {
    setTestingId(id);
    setTestResult(null);
    const result = await api.testPlatformAccount(id);
    setTestResult({ accountId: id, ...result });
    setTestingId(null);
  };

  const handleClaim = async (id) => {
    await api.claimPlatformAccount(id);
    fetchData();
    setTestResult(null);
  };

  const getAgentName = (agentId) => {
    const agent = agents.find(a => a.id === agentId);
    return agent?.name || 'Unknown Agent';
  };

  if (loading) {
    return <div className="p-4 text-gray-400">Loading accounts...</div>;
  }

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-white">Platform Accounts</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-port-accent text-white rounded hover:bg-port-accent/80"
          disabled={agents.length === 0}
        >
          {showForm ? 'Cancel' : '+ Link Account'}
        </button>
      </div>

      {agents.length === 0 && (
        <div className="mb-4 p-4 bg-port-warning/20 border border-port-warning/50 rounded text-port-warning">
          Create an agent personality first before linking platform accounts.
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-6 p-4 bg-port-card border border-port-border rounded-lg">
          <h3 className="text-md font-semibold text-white mb-4">Register New Account</h3>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Agent</label>
              <select
                value={formData.agentId}
                onChange={(e) => setFormData({ ...formData, agentId: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                required
              >
                <option value="">Select agent...</option>
                {agents.map(agent => (
                  <option key={agent.id} value={agent.id}>
                    {agent.avatar?.emoji} {agent.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Platform</label>
              <select
                value={formData.platform}
                onChange={(e) => setFormData({ ...formData, platform: e.target.value })}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              >
                {PLATFORM_TYPES.map(platform => (
                  <option key={platform.value} value={platform.value}>
                    {platform.icon} {platform.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-sm text-gray-400 mb-1">Account Name</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              placeholder="Display name on platform"
              required
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm text-gray-400 mb-1">Bio/Description</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white h-20"
              placeholder="Brief bio for the platform profile..."
            />
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              className="px-4 py-2 bg-port-success text-white rounded hover:bg-port-success/80"
            >
              Register Account
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="px-4 py-2 bg-port-border text-gray-300 rounded hover:bg-port-border/80"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {testResult && (
        <div className={`mb-4 p-4 rounded border ${
          testResult.success
            ? 'bg-port-success/20 border-port-success/50 text-port-success'
            : 'bg-port-error/20 border-port-error/50 text-port-error'
        }`}>
          <p>{testResult.message}</p>
          {testResult.claimUrl && (
            <div className="mt-2">
              <a
                href={testResult.claimUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-port-accent underline"
              >
                {testResult.claimUrl}
              </a>
              <button
                onClick={() => handleClaim(testResult.accountId)}
                className="ml-4 px-3 py-1 bg-port-accent text-white rounded text-sm"
              >
                I've claimed it
              </button>
            </div>
          )}
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="text-center py-8 text-gray-400">
          <p className="text-lg mb-2">No platform accounts</p>
          <p className="text-sm">Link an agent to a social platform to get started</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {accounts.map(account => {
            const statusConfig = ACCOUNT_STATUSES[account.status] || ACCOUNT_STATUSES.error;
            const platform = PLATFORM_TYPES.find(p => p.value === account.platform);

            return (
              <div
                key={account.id}
                className="p-4 bg-port-card border border-port-border rounded-lg"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xl">{platform?.icon || '🔗'}</span>
                      <h3 className="font-semibold text-white">
                        {account.credentials.username}
                      </h3>
                      <span className={`text-xs px-2 py-0.5 rounded ${statusConfig.bgColor} ${statusConfig.color}`}>
                        {statusConfig.label}
                      </span>
                    </div>
                    <p className="text-sm text-gray-400">
                      {platform?.label} • Agent: {getAgentName(account.agentId)}
                    </p>
                    {account.lastActivity && (
                      <p className="text-xs text-gray-500 mt-1">
                        Last activity: {new Date(account.lastActivity).toLocaleString()}
                      </p>
                    )}
                    {account.platformData?.claimUrl && account.status === 'pending' && (
                      <div className="mt-2 text-sm">
                        <a
                          href={account.platformData.claimUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-port-accent underline"
                        >
                          Claim URL
                        </a>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleTest(account.id)}
                      disabled={testingId === account.id}
                      className="px-3 py-1 text-xs bg-port-accent/20 text-port-accent rounded hover:bg-port-accent/30 disabled:opacity-50"
                    >
                      {testingId === account.id ? 'Testing...' : 'Test'}
                    </button>
                    {account.status === 'pending' && (
                      <button
                        onClick={() => handleClaim(account.id)}
                        className="px-3 py-1 text-xs bg-port-success/20 text-port-success rounded hover:bg-port-success/30"
                      >
                        Mark Claimed
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(account.id)}
                      className="px-3 py-1 text-xs bg-port-error/20 text-port-error rounded hover:bg-port-error/30"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
