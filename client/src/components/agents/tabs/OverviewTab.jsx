import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, Zap, MessageSquare, Eye } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';
import { PERSONALITY_STYLES, DEFAULT_PERSONALITY, DEFAULT_AVATAR, PLATFORM_TYPES, ACCOUNT_STATUSES } from '../constants';

export default function OverviewTab({ agentId, agent, onAgentUpdate }) {
  const navigate = useNavigate();

  // Personality form state
  const [formData, setFormData] = useState(null);
  const [topicsText, setTopicsText] = useState('');
  const [quirksText, setQuirksText] = useState('');

  // Providers state (for AI config section)
  const [providers, setProviders] = useState([]);

  // Accounts state
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [accountForm, setAccountForm] = useState({
    platform: 'moltbook',
    name: '',
    description: ''
  });
  const [testingId, setTestingId] = useState(null);
  const [testResult, setTestResult] = useState(null);

  // Stats state
  const [activityStats, setActivityStats] = useState(null);

  // Quick action state
  const [quickAccountId, setQuickAccountId] = useState('');
  const [engaging, setEngaging] = useState(false);
  const [checking, setChecking] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [rateLimits, setRateLimits] = useState(null);

  // Cooldown timer state
  const [cooldownEnds, setCooldownEnds] = useState({});
  const [, setTick] = useState(0);

  // Initialize form from agent
  useEffect(() => {
    if (!agent) return;
    setFormData({
      name: agent.name,
      description: agent.description || '',
      userId: agent.userId,
      personality: { ...DEFAULT_PERSONALITY, ...agent.personality },
      avatar: { ...DEFAULT_AVATAR, ...agent.avatar },
      enabled: agent.enabled,
      aiConfig: agent.aiConfig || {}
    });
  }, [agent]);

  // Sync text fields
  useEffect(() => {
    if (!formData) return;
    setTopicsText(formData.personality.topics.join(', '));
    setQuirksText(formData.personality.quirks.join(', '));
  }, [formData?.personality?.topics, formData?.personality?.quirks]);

  const fetchAccounts = useCallback(async () => {
    const data = await api.getPlatformAccounts(agentId);
    setAccounts(data);
    setAccountsLoading(false);
  }, [agentId]);

  const fetchProviders = useCallback(async () => {
    const data = await api.getProviders();
    setProviders((data.providers || []).filter(p => p.enabled));
  }, []);

  const fetchStats = useCallback(async () => {
    const stats = await api.getAgentActivityStats(agentId).catch(() => null);
    setActivityStats(stats);
  }, [agentId]);

  useEffect(() => {
    fetchAccounts();
    fetchProviders();
    fetchStats();
  }, [fetchAccounts, fetchProviders, fetchStats]);

  // Auto-select first active account for quick actions
  useEffect(() => {
    if (quickAccountId) return;
    const active = accounts.filter(a => a.status === 'active');
    if (active.length >= 1) {
      setQuickAccountId(active[0].id);
    }
  }, [accounts, quickAccountId]);

  // Derive platform from selected quick account
  const quickAccount = accounts.find(a => a.id === quickAccountId);
  const quickPlatform = quickAccount?.platform || 'moltbook';

  // Load rate limits when quick account changes
  useEffect(() => {
    if (!quickAccountId) {
      setRateLimits(null);
      return;
    }
    const account = accounts.find(a => a.id === quickAccountId);
    const endpoint = account?.platform === 'moltworld'
      ? api.moltworldRateLimits(quickAccountId)
      : api.getAgentRateLimits(quickAccountId);
    endpoint.then(setRateLimits).catch(() => {});
  }, [quickAccountId, accounts]);

  // Calculate cooldown end timestamps from rate limit data
  useEffect(() => {
    if (!rateLimits) { setCooldownEnds({}); return; }
    const ends = {};
    const now = Date.now();
    for (const [action, rl] of Object.entries(rateLimits)) {
      if (rl.cooldownRemainingMs > 0) {
        ends[action] = now + rl.cooldownRemainingMs;
      }
    }
    setCooldownEnds(ends);
  }, [rateLimits]);

  // Tick cooldown timer every second while any cooldown is active
  useEffect(() => {
    const hasActive = Object.values(cooldownEnds).some(end => end > Date.now());
    if (!hasActive) return;
    let refetched = false;
    const interval = setInterval(() => {
      const stillActive = Object.values(cooldownEnds).some(end => end > Date.now());
      setTick(t => t + 1);
      if (!stillActive && !refetched) {
        refetched = true;
        if (quickAccountId) {
          api.getAgentRateLimits(quickAccountId).then(setRateLimits).catch(() => {});
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownEnds, quickAccountId]);

  const getModelsForProvider = (providerId) => {
    const p = providers.find(pr => pr.id === providerId);
    return p?.models || [];
  };

  const buildAiConfig = (config) => {
    if (!config) return undefined;
    const cleaned = {};
    if (config.providerId) cleaned.providerId = config.providerId;
    if (config.model) cleaned.model = config.model;
    const fnKeys = ['content', 'engagement', 'challenge'];
    for (const key of fnKeys) {
      if (config[key]?.providerId) {
        cleaned[key] = { providerId: config[key].providerId };
        if (config[key].model) cleaned[key].model = config[key].model;
      }
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const aiConfig = buildAiConfig(formData.aiConfig);
    const submitData = {
      ...formData,
      personality: {
        ...formData.personality,
        topics: topicsText.split(',').map(t => t.trim()).filter(Boolean),
        quirks: quirksText.split(',').map(t => t.trim()).filter(Boolean)
      },
      aiConfig
    };
    await api.updateAgentPersonality(agentId, submitData);
    toast.success('Agent updated');
    onAgentUpdate?.();
  };

  const updatePersonality = (field, value) => {
    setFormData(prev => ({
      ...prev,
      personality: { ...prev.personality, [field]: value }
    }));
  };

  // Quick action handlers
  const handleEngage = async () => {
    if (!agentId || !quickAccountId) return;
    setEngaging(true);
    const result = await api.engageAgent(agentId, quickAccountId, 1, 3);
    setEngaging(false);
    toast.success(`Engaged: ${result.votes?.length || 0} votes, ${result.comments?.length || 0} comments`);
    api.getAgentRateLimits(quickAccountId).then(setRateLimits).catch(() => {});
  };

  const handleCheckPosts = async () => {
    if (!agentId || !quickAccountId) return;
    setChecking(true);
    const result = await api.checkAgentPosts(agentId, quickAccountId, 7, 2, 10).catch(() => null);
    setChecking(false);
    if (!result) return;
    toast.success(`Checked ${result.postsChecked} posts: ${result.engagement?.upvoted?.length || 0} upvotes, ${result.engagement?.replied?.length || 0} replies`);
    api.getAgentRateLimits(quickAccountId).then(setRateLimits).catch(() => {});
  };

  // Moltworld quick actions
  const handleExplore = async () => {
    if (!agentId || !quickAccountId) return;
    setExploring(true);
    const result = await api.moltworldExplore(quickAccountId, agentId).catch(() => null);
    setExploring(false);
    if (!result) return;
    toast.success(`Explored (${result.x}, ${result.y}) — ${result.nearby || 0} agents nearby`);
    api.moltworldRateLimits(quickAccountId).then(setRateLimits).catch(() => {});
  };

  const handleBuild = async () => {
    if (!agentId || !quickAccountId) return;
    const result = await api.moltworldBuild(quickAccountId, agentId, 0, 0, 0, 'stone', 'place').catch(() => null);
    if (result) toast.success('Block placed');
    api.moltworldRateLimits(quickAccountId).then(setRateLimits).catch(() => {});
  };

  // Account handlers
  const resetAccountForm = () => {
    setAccountForm({ platform: 'moltbook', name: '', description: '' });
    setShowAccountForm(false);
  };

  const handleAccountSubmit = async (e) => {
    e.preventDefault();
    const result = await api.registerPlatformAccount(
      agentId, accountForm.platform, accountForm.name, accountForm.description
    );
    resetAccountForm();
    fetchAccounts();

    if (result.claimUrl) {
      setTestResult({
        accountId: result.id,
        success: true,
        message: 'Account registered! Visit the claim URL to activate.',
        claimUrl: result.claimUrl
      });
    }
  };

  const handleAccountDelete = async (id) => {
    await api.deletePlatformAccount(id);
    fetchAccounts();
  };

  const handleAccountTest = async (id) => {
    setTestingId(id);
    setTestResult(null);
    const result = await api.testPlatformAccount(id);
    setTestResult({ accountId: id, ...result });
    setTestingId(null);
  };

  const handleAccountClaim = async (id) => {
    await api.claimPlatformAccount(id);
    fetchAccounts();
    setTestResult(null);
  };

  const getCooldownMs = (action) => {
    const end = cooldownEnds[action];
    return end ? Math.max(0, end - Date.now()) : 0;
  };

  const formatCooldown = (ms) => {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  if (!formData) {
    return <div className="p-4"><BrailleSpinner text="Loading" /></div>;
  }

  const activeAccounts = accounts.filter(a => a.status === 'active');

  return (
    <div className="p-4 space-y-6">
      {/* Quick Stats - Full Width */}
      {activityStats && (
        <div className="grid grid-cols-3 gap-4">
          <div className="p-3 bg-port-card border border-port-border rounded-lg text-center">
            <div className="text-xl font-bold text-white">{activityStats.totalPosts || 0}</div>
            <div className="text-xs text-gray-400">Posts</div>
          </div>
          <div className="p-3 bg-port-card border border-port-border rounded-lg text-center">
            <div className="text-xl font-bold text-white">{activityStats.totalComments || 0}</div>
            <div className="text-xs text-gray-400">Comments</div>
          </div>
          <div className="p-3 bg-port-card border border-port-border rounded-lg text-center">
            <div className="text-xl font-bold text-white">{activityStats.totalVotes || 0}</div>
            <div className="text-xs text-gray-400">Votes</div>
          </div>
        </div>
      )}

      {/* Two-Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left Column - Personality Form */}
        <div className="lg:col-span-3">
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <h3 className="text-md font-semibold text-white mb-4">Personality</h3>

            <form onSubmit={handleSave}>
              {/* Name + Style */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Name</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Style</label>
                  <select
                    value={formData.personality.style}
                    onChange={(e) => updatePersonality('style', e.target.value)}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                  >
                    {PERSONALITY_STYLES.map(style => (
                      <option key={style.value} value={style.value}>{style.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Description */}
              <div className="mb-4">
                <label className="block text-sm text-gray-400 mb-1">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white h-20"
                  placeholder="Brief description of this agent's purpose..."
                />
              </div>

              {/* Tone + Avatar (emoji + color) */}
              <div className="flex items-end gap-4 mb-4">
                <div className="flex-1">
                  <label className="block text-sm text-gray-400 mb-1">Tone</label>
                  <input
                    type="text"
                    value={formData.personality.tone}
                    onChange={(e) => updatePersonality('tone', e.target.value)}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                    placeholder="e.g., friendly but informative"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-400">Emoji</label>
                  <input
                    type="text"
                    value={formData.avatar.emoji || ''}
                    onChange={(e) => setFormData({ ...formData, avatar: { ...formData.avatar, emoji: e.target.value } })}
                    className="w-14 px-2 py-2 bg-port-bg border border-port-border rounded text-white text-center"
                    maxLength={2}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-400">Color</label>
                  <input
                    type="color"
                    value={formData.avatar.color || '#3b82f6'}
                    onChange={(e) => setFormData({ ...formData, avatar: { ...formData.avatar, color: e.target.value } })}
                    className="w-12 h-9 border border-port-border rounded cursor-pointer"
                  />
                </div>
              </div>

              {/* Topics + Quirks */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Topics (comma-separated)</label>
                  <input
                    type="text"
                    value={topicsText}
                    onChange={(e) => setTopicsText(e.target.value)}
                    onBlur={() => updatePersonality('topics', topicsText.split(',').map(t => t.trim()).filter(Boolean))}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                    placeholder="e.g., technology, AI"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Quirks (comma-separated)</label>
                  <input
                    type="text"
                    value={quirksText}
                    onChange={(e) => setQuirksText(e.target.value)}
                    onBlur={() => updatePersonality('quirks', quirksText.split(',').map(t => t.trim()).filter(Boolean))}
                    className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                    placeholder="e.g., uses metaphors"
                  />
                </div>
              </div>

              {/* Prompt Prefix */}
              <div className="mb-4">
                <label className="block text-sm text-gray-400 mb-1">Prompt Prefix</label>
                <textarea
                  value={formData.personality.promptPrefix}
                  onChange={(e) => updatePersonality('promptPrefix', e.target.value)}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white h-24 font-mono text-sm"
                  placeholder="Custom instructions injected into AI prompts..."
                />
              </div>

              <button
                type="submit"
                className="px-4 py-2 bg-port-success text-white rounded hover:bg-port-success/80"
              >
                Save Changes
              </button>
            </form>
          </div>
        </div>

        {/* Right Column - Quick Actions, AI Providers, Accounts */}
        <div className="lg:col-span-2 space-y-6">
          {/* Quick Actions */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <h3 className="text-md font-semibold text-white mb-3">Quick Actions</h3>

            {activeAccounts.length === 0 ? (
              <p className="text-sm text-gray-500">No active accounts — link one below to enable actions</p>
            ) : (
              <>
                {activeAccounts.length > 1 && (
                  <div className="mb-3">
                    <label className="block text-xs text-gray-400 mb-1">Account</label>
                    <select
                      value={quickAccountId}
                      onChange={(e) => setQuickAccountId(e.target.value)}
                      className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
                    >
                      {activeAccounts.map(a => (
                        <option key={a.id} value={a.id}>{a.credentials.username}</option>
                      ))}
                    </select>
                  </div>
                )}

                {rateLimits && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {Object.entries(rateLimits).map(([action, rl]) => {
                      const cooldownMs = getCooldownMs(action);
                      const isCooling = cooldownMs > 0;
                      const pct = rl.remaining / rl.maxPerDay;
                      const colorClass = isCooling
                        ? 'bg-port-warning/20 text-port-warning animate-pulse'
                        : pct === 0
                          ? 'bg-port-error/20 text-port-error'
                          : pct < 0.25
                            ? 'bg-port-warning/20 text-port-warning'
                            : 'bg-port-success/20 text-port-success';
                      return (
                        <span key={action} className={`text-xs px-2 py-0.5 rounded ${colorClass}`} title={isCooling ? `Cooldown: ${formatCooldown(cooldownMs)}` : `${rl.remaining} of ${rl.maxPerDay} remaining`}>
                          {isCooling ? `${action}: ${formatCooldown(cooldownMs)}` : `${action}: ${rl.remaining}/${rl.maxPerDay}`}
                        </span>
                      );
                    })}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {quickPlatform === 'moltworld' ? (
                    <>
                      <button
                        onClick={handleExplore}
                        disabled={exploring || !quickAccountId}
                        className="px-3 py-1.5 text-sm bg-port-success text-white rounded hover:bg-port-success/80 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        <Zap size={14} />
                        {exploring ? 'Exploring...' : 'Explore'}
                      </button>
                      <button
                        onClick={handleBuild}
                        disabled={!quickAccountId}
                        className="px-3 py-1.5 text-sm bg-purple-600 text-white rounded hover:bg-purple-500 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        <MessageSquare size={14} />
                        Build
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => navigate(`/agents/${agentId}/tools`)}
                        className="px-3 py-1.5 text-sm bg-port-accent text-white rounded hover:bg-port-accent/80 flex items-center gap-1.5"
                      >
                        <Zap size={14} />
                        Generate Post
                      </button>
                      <button
                        onClick={handleEngage}
                        disabled={engaging || !quickAccountId}
                        className="px-3 py-1.5 text-sm bg-port-success text-white rounded hover:bg-port-success/80 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        <MessageSquare size={14} />
                        {engaging ? 'Engaging...' : 'Engage Now'}
                      </button>
                      <button
                        onClick={handleCheckPosts}
                        disabled={checking || !quickAccountId}
                        className="px-3 py-1.5 text-sm bg-purple-600 text-white rounded hover:bg-purple-500 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        <Eye size={14} />
                        {checking ? 'Checking...' : 'Check Posts'}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Per-Function AI Provider Section */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <Cpu size={16} className="text-port-accent" />
              <h3 className="text-md font-semibold text-white">AI Providers</h3>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              Choose AI providers for each function. "System Default" uses the globally active provider.
            </p>
            <div className="space-y-3">
              {[
                { key: 'content', label: 'Content Generation', desc: 'Posts, comments, replies' },
                { key: 'engagement', label: 'Engagement', desc: 'Autonomous voting & commenting' },
                { key: 'challenge', label: 'Challenge Solving', desc: 'Verification challenges' }
              ].map(({ key, label, desc }) => {
                const fnConfig = formData.aiConfig?.[key] || {};
                const fnModels = getModelsForProvider(fnConfig.providerId);
                return (
                  <div key={key} className="space-y-1">
                    <div>
                      <div className="text-sm text-white">{label}</div>
                      <div className="text-[10px] text-gray-500">{desc}</div>
                    </div>
                    <div className="flex gap-2">
                      <select
                        value={fnConfig.providerId || ''}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          aiConfig: {
                            ...prev.aiConfig,
                            [key]: { ...prev.aiConfig?.[key], providerId: e.target.value || undefined, model: undefined }
                          }
                        }))}
                        className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
                      >
                        <option value="">System Default</option>
                        {providers.map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                      <select
                        value={fnConfig.model || ''}
                        onChange={(e) => setFormData(prev => ({
                          ...prev,
                          aiConfig: {
                            ...prev.aiConfig,
                            [key]: { ...prev.aiConfig?.[key], model: e.target.value || undefined }
                          }
                        }))}
                        disabled={!fnConfig.providerId}
                        className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-50"
                      >
                        <option value="">Default</option>
                        {fnModels.map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              onClick={async () => {
                const aiConfig = buildAiConfig(formData.aiConfig);
                await api.updateAgentPersonality(agentId, { aiConfig });
                toast.success(aiConfig ? 'AI providers saved' : 'Reset to system defaults');
                onAgentUpdate?.();
              }}
              className="mt-3 px-4 py-1.5 bg-port-success text-white rounded hover:bg-port-success/80 text-sm"
            >
              Save AI Config
            </button>
          </div>

          {/* Accounts Section */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-md font-semibold text-white">Platform Accounts</h3>
              <button
                onClick={() => setShowAccountForm(!showAccountForm)}
                className="px-3 py-1.5 text-sm bg-port-accent text-white rounded hover:bg-port-accent/80"
              >
                {showAccountForm ? 'Cancel' : '+ Link Account'}
              </button>
            </div>

            {showAccountForm && (
              <form onSubmit={handleAccountSubmit} className="mb-4 p-3 bg-port-bg border border-port-border rounded-lg">
                <div className="grid grid-cols-2 gap-4 mb-3">
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Platform</label>
                    <select
                      value={accountForm.platform}
                      onChange={(e) => setAccountForm({ ...accountForm, platform: e.target.value })}
                      className="w-full px-3 py-2 bg-port-card border border-port-border rounded text-white"
                    >
                      {PLATFORM_TYPES.map(platform => (
                        <option key={platform.value} value={platform.value}>
                          {platform.icon} {platform.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Account Name</label>
                    <input
                      type="text"
                      value={accountForm.name}
                      onChange={(e) => setAccountForm({ ...accountForm, name: e.target.value })}
                      className="w-full px-3 py-2 bg-port-card border border-port-border rounded text-white"
                      placeholder="Display name on platform"
                      required
                    />
                  </div>
                </div>
                <div className="mb-3">
                  <label className="block text-sm text-gray-400 mb-1">Bio/Description</label>
                  <textarea
                    value={accountForm.description}
                    onChange={(e) => setAccountForm({ ...accountForm, description: e.target.value })}
                    className="w-full px-3 py-2 bg-port-card border border-port-border rounded text-white h-16"
                    placeholder="Brief bio for the platform profile..."
                  />
                </div>
                <div className="flex gap-2">
                  <button type="submit" className="px-3 py-1.5 text-sm bg-port-success text-white rounded hover:bg-port-success/80">
                    Register Account
                  </button>
                  <button type="button" onClick={resetAccountForm} className="px-3 py-1.5 text-sm bg-port-border text-gray-300 rounded hover:bg-port-border/80">
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {testResult && (
              <div className={`mb-4 p-3 rounded border ${
                testResult.success
                  ? 'bg-port-success/20 border-port-success/50 text-port-success'
                  : 'bg-port-error/20 border-port-error/50 text-port-error'
              }`}>
                <p className="text-sm">{testResult.message}</p>
                {testResult.claimUrl && (
                  <div className="mt-2">
                    <a href={testResult.claimUrl} target="_blank" rel="noopener noreferrer" className="text-port-accent underline text-sm">
                      {testResult.claimUrl}
                    </a>
                    <button
                      onClick={() => handleAccountClaim(testResult.accountId)}
                      className="ml-4 px-3 py-1 bg-port-accent text-white rounded text-sm"
                    >
                      I've claimed it
                    </button>
                  </div>
                )}
              </div>
            )}

            {accountsLoading ? (
              <p className="text-sm text-gray-400">Loading accounts...</p>
            ) : accounts.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">No platform accounts linked to this agent</p>
            ) : (
              <div className="space-y-3">
                {accounts.map(account => {
                  const statusConfig = ACCOUNT_STATUSES[account.status] || ACCOUNT_STATUSES.error;
                  const platform = PLATFORM_TYPES.find(p => p.value === account.platform);

                  return (
                    <div key={account.id} className="p-3 bg-port-bg border border-port-border rounded-lg">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span>{platform?.icon || '🔗'}</span>
                            <span className="font-medium text-white">{account.credentials.username}</span>
                            <span className={`text-xs px-2 py-0.5 rounded ${statusConfig.bgColor} ${statusConfig.color}`}>
                              {statusConfig.label}
                            </span>
                          </div>
                          <p className="text-xs text-gray-500">
                            {platform?.label}
                            {account.lastActivity && ` • Last activity: ${new Date(account.lastActivity).toLocaleString()}`}
                          </p>
                          {account.platformData?.claimUrl && account.status === 'pending' && (
                            <a href={account.platformData.claimUrl} target="_blank" rel="noopener noreferrer" className="text-port-accent underline text-xs mt-1 inline-block">
                              Claim URL
                            </a>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleAccountTest(account.id)}
                            disabled={testingId === account.id}
                            className="px-2 py-1 text-xs bg-port-accent/20 text-port-accent rounded hover:bg-port-accent/30 disabled:opacity-50"
                          >
                            {testingId === account.id ? 'Testing...' : 'Test'}
                          </button>
                          {account.status === 'pending' && (
                            <button
                              onClick={() => handleAccountClaim(account.id)}
                              className="px-2 py-1 text-xs bg-port-success/20 text-port-success rounded hover:bg-port-success/30"
                            >
                              Claimed
                            </button>
                          )}
                          <button
                            onClick={() => handleAccountDelete(account.id)}
                            className="px-2 py-1 text-xs bg-port-error/20 text-port-error rounded hover:bg-port-error/30"
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
        </div>
      </div>
    </div>
  );
}
