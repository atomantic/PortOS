import { useState, useEffect, useCallback } from 'react';
import { Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import { PERSONALITY_STYLES, DEFAULT_PERSONALITY, DEFAULT_AVATAR } from '../constants';

export default function PersonalitiesTab({ onRefresh }) {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    userId: 'default',
    personality: { ...DEFAULT_PERSONALITY },
    avatar: { ...DEFAULT_AVATAR },
    enabled: true
  });

  // AI generation state
  const [providers, setProviders] = useState([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [generating, setGenerating] = useState(false);

  // Raw text state for comma-separated fields (parsed on blur)
  const [topicsText, setTopicsText] = useState('');
  const [quirksText, setQuirksText] = useState('');

  const fetchAgents = useCallback(async () => {
    const data = await api.getAgentPersonalities();
    setAgents(data);
    setLoading(false);
  }, []);

  const fetchProviders = useCallback(async () => {
    const data = await api.getProviders();
    setProviders((data.providers || []).filter(p => p.enabled));
  }, []);

  useEffect(() => {
    fetchAgents();
    fetchProviders();
  }, [fetchAgents, fetchProviders]);

  // Sync raw text fields when formData changes (edit, generate, reset)
  useEffect(() => {
    setTopicsText(formData.personality.topics.join(', '));
    setQuirksText(formData.personality.quirks.join(', '));
  }, [formData.personality.topics, formData.personality.quirks]);

  // Get available models for selected provider
  const selectedProvider = providers.find(p => p.id === selectedProviderId);
  const availableModels = selectedProvider?.models || [];

  const handleGenerate = async () => {
    setGenerating(true);
    // Send current form data as seed for AI to build upon
    // Use raw text values in case user hasn't blurred the fields yet
    const seedData = {
      name: formData.name.trim(),
      description: formData.description.trim(),
      personality: {
        style: formData.personality.style,
        tone: formData.personality.tone,
        topics: topicsText.split(',').map(t => t.trim()).filter(Boolean),
        quirks: quirksText.split(',').map(t => t.trim()).filter(Boolean),
        promptPrefix: formData.personality.promptPrefix.trim()
      },
      avatar: {
        emoji: formData.avatar.emoji,
        color: formData.avatar.color
      }
    };
    const generated = await api.generateAgentPersonality(
      seedData,
      selectedProviderId || null,
      selectedModel || null
    ).catch(() => null);
    setGenerating(false);

    if (!generated) return;

    // Apply generated data to form (including name if generated)
    setFormData(prev => ({
      ...prev,
      name: generated.name || prev.name,
      description: generated.description || prev.description,
      personality: {
        style: generated.personality?.style || prev.personality.style,
        tone: generated.personality?.tone || prev.personality.tone,
        topics: generated.personality?.topics || prev.personality.topics,
        quirks: generated.personality?.quirks || prev.personality.quirks,
        promptPrefix: generated.personality?.promptPrefix || prev.personality.promptPrefix
      },
      avatar: {
        emoji: generated.avatar?.emoji || prev.avatar.emoji,
        color: generated.avatar?.color || prev.avatar.color
      }
    }));

    toast.success(`Generated: ${generated.name || 'personality'}`);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      userId: 'default',
      personality: { ...DEFAULT_PERSONALITY },
      avatar: { ...DEFAULT_AVATAR },
      enabled: true
    });
    setEditingAgent(null);
    setShowForm(false);
  };

  const handleEdit = (agent) => {
    setFormData({
      name: agent.name,
      description: agent.description || '',
      userId: agent.userId,
      personality: { ...DEFAULT_PERSONALITY, ...agent.personality },
      avatar: { ...DEFAULT_AVATAR, ...agent.avatar },
      enabled: agent.enabled
    });
    setEditingAgent(agent);
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Build clean data with parsed topics/quirks (in case user hasn't blurred)
    const submitData = {
      ...formData,
      personality: {
        ...formData.personality,
        topics: topicsText.split(',').map(t => t.trim()).filter(Boolean),
        quirks: quirksText.split(',').map(t => t.trim()).filter(Boolean)
      }
    };

    if (editingAgent) {
      await api.updateAgentPersonality(editingAgent.id, submitData);
    } else {
      await api.createAgentPersonality(submitData);
    }

    resetForm();
    fetchAgents();
    onRefresh?.();
  };

  const handleDelete = async (id) => {
    await api.deleteAgentPersonality(id);
    fetchAgents();
    onRefresh?.();
  };

  const handleToggle = async (id, enabled) => {
    await api.toggleAgentPersonality(id, enabled);
    fetchAgents();
  };

  const updatePersonality = (field, value) => {
    setFormData(prev => ({
      ...prev,
      personality: { ...prev.personality, [field]: value }
    }));
  };

  if (loading) {
    return <div className="p-4 text-gray-400">Loading agents...</div>;
  }

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-white">Agent Personalities</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-port-accent text-white rounded hover:bg-port-accent/80"
        >
          {showForm ? 'Cancel' : '+ New Agent'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-6 p-4 bg-port-card border border-port-border rounded-lg">
          <h3 className="text-md font-semibold text-white mb-4">
            {editingAgent ? 'Edit Agent' : 'Create New Agent'}
          </h3>

          {/* AI Generation Section - at top */}
          {!editingAgent && (
            <div className="mb-4 p-3 bg-port-bg border border-port-accent/30 rounded-lg">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles size={16} className="text-port-accent" />
                <span className="text-sm font-medium text-white">Generate with AI</span>
              </div>
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label className="block text-xs text-gray-400 mb-1">Provider</label>
                  <select
                    value={selectedProviderId}
                    onChange={(e) => {
                      setSelectedProviderId(e.target.value);
                      setSelectedModel('');
                    }}
                    disabled={generating}
                    className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
                  >
                    <option value="">Default (active)</option>
                    {providers.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-gray-400 mb-1">Model</label>
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    disabled={generating}
                    className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
                  >
                    <option value="">Default</option>
                    {availableModels.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={generating}
                  className="px-4 py-1.5 bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {generating ? (
                    <>
                      <span className="animate-spin">⚡</span>
                      Generating...
                    </>
                  ) : (
                    <>
                      <Sparkles size={14} />
                      Generate
                    </>
                  )}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Generate a complete personality including name, style, topics, and avatar
              </p>
            </div>
          )}

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

          <div className="mb-4">
            <label className="block text-sm text-gray-400 mb-1">Description</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white h-20"
              placeholder="Brief description of this agent's purpose..."
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm text-gray-400 mb-1">Tone</label>
            <input
              type="text"
              value={formData.personality.tone}
              onChange={(e) => updatePersonality('tone', e.target.value)}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              placeholder="e.g., friendly but informative"
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm text-gray-400 mb-1">Topics (comma-separated)</label>
            <input
              type="text"
              value={topicsText}
              onChange={(e) => setTopicsText(e.target.value)}
              onBlur={() => updatePersonality('topics', topicsText.split(',').map(t => t.trim()).filter(Boolean))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              placeholder="e.g., technology, AI, philosophy"
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm text-gray-400 mb-1">Quirks (comma-separated)</label>
            <input
              type="text"
              value={quirksText}
              onChange={(e) => setQuirksText(e.target.value)}
              onBlur={() => updatePersonality('quirks', quirksText.split(',').map(t => t.trim()).filter(Boolean))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              placeholder="e.g., uses metaphors, asks follow-up questions"
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm text-gray-400 mb-1">Prompt Prefix</label>
            <textarea
              value={formData.personality.promptPrefix}
              onChange={(e) => updatePersonality('promptPrefix', e.target.value)}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white h-24 font-mono text-sm"
              placeholder="Custom instructions injected into AI prompts..."
            />
          </div>

          <div className="flex items-center gap-4 mb-4">
            <label className="block text-sm text-gray-400">Avatar Emoji</label>
            <input
              type="text"
              value={formData.avatar.emoji || ''}
              onChange={(e) => setFormData({ ...formData, avatar: { ...formData.avatar, emoji: e.target.value } })}
              className="w-16 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-center"
              maxLength={2}
            />
            <label className="block text-sm text-gray-400">Color</label>
            <input
              type="color"
              value={formData.avatar.color || '#3b82f6'}
              onChange={(e) => setFormData({ ...formData, avatar: { ...formData.avatar, color: e.target.value } })}
              className="w-12 h-8 border border-port-border rounded cursor-pointer"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              className="px-4 py-2 bg-port-success text-white rounded hover:bg-port-success/80"
            >
              {editingAgent ? 'Update Agent' : 'Create Agent'}
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

      {agents.length === 0 ? (
        <div className="text-center py-8 text-gray-400">
          <p className="text-lg mb-2">No agents yet</p>
          <p className="text-sm">Create your first AI agent to get started</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {agents.map(agent => (
            <div
              key={agent.id}
              className={`p-4 bg-port-card border rounded-lg ${agent.enabled ? 'border-port-border' : 'border-port-border/50 opacity-60'}`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center text-2xl"
                    style={{ backgroundColor: agent.avatar?.color || '#3b82f6' }}
                  >
                    {agent.avatar?.emoji || '🤖'}
                  </div>
                  <div>
                    <h3 className="font-semibold text-white">{agent.name}</h3>
                    <p className="text-sm text-gray-400">{agent.description || 'No description'}</p>
                    <div className="flex gap-2 mt-1">
                      <span className="text-xs px-2 py-0.5 bg-port-accent/20 text-port-accent rounded">
                        {PERSONALITY_STYLES.find(s => s.value === agent.personality?.style)?.label || agent.personality?.style}
                      </span>
                      {agent.personality?.topics?.slice(0, 3).map(topic => (
                        <span key={topic} className="text-xs px-2 py-0.5 bg-port-border text-gray-300 rounded">
                          {topic}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleToggle(agent.id, !agent.enabled)}
                    className={`px-3 py-1 text-xs rounded ${
                      agent.enabled
                        ? 'bg-port-success/20 text-port-success'
                        : 'bg-port-border text-gray-400'
                    }`}
                  >
                    {agent.enabled ? 'Enabled' : 'Disabled'}
                  </button>
                  <button
                    onClick={() => handleEdit(agent)}
                    className="px-3 py-1 text-xs bg-port-border text-gray-300 rounded hover:bg-port-border/80"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(agent.id)}
                    className="px-3 py-1 text-xs bg-port-error/20 text-port-error rounded hover:bg-port-error/30"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {agent.personality?.promptPrefix && (
                <div className="mt-3 p-2 bg-port-bg rounded text-xs text-gray-400 font-mono">
                  {agent.personality.promptPrefix.slice(0, 200)}
                  {agent.personality.promptPrefix.length > 200 && '...'}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
