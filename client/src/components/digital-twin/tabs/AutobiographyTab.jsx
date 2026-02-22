import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BookOpen,
  PenLine,
  Clock,
  ChevronDown,
  ChevronUp,
  Trash2,
  Save,
  RefreshCw,
  Send,
  Settings,
  SkipForward,
  X
} from 'lucide-react';
import * as api from '../../../services/api';
import toast from 'react-hot-toast';

export default function AutobiographyTab({ onRefresh }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [stats, setStats] = useState(null);
  const [stories, setStories] = useState([]);
  const [themes, setThemes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterTheme, setFilterTheme] = useState(null);

  // Writing state
  const [currentPrompt, setCurrentPrompt] = useState(null);
  const [writing, setWriting] = useState(false);
  const [storyContent, setStoryContent] = useState('');
  const [saving, setSaving] = useState(false);

  // Config state
  const [showConfig, setShowConfig] = useState(false);
  const [config, setConfig] = useState(null);

  // Edit state
  const [editingStory, setEditingStory] = useState(null);
  const [editContent, setEditContent] = useState('');

  // Expanded story
  const [expandedStory, setExpandedStory] = useState(null);

  const loadData = useCallback(async () => {
    const [statsData, storiesData, themesData, configData] = await Promise.all([
      api.getAutobiographyStats().catch(() => null),
      api.getAutobiographyStories(filterTheme).catch(() => []),
      api.getAutobiographyThemes().catch(() => []),
      api.getAutobiographyConfig().catch(() => null)
    ]);
    setStats(statsData);
    setStories(storiesData);
    setThemes(themesData);
    setConfig(configData);
    setLoading(false);
  }, [filterTheme]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-load prompt from URL param (when arriving from notification)
  useEffect(() => {
    const promptParam = searchParams.get('prompt');
    if (promptParam && !loading) {
      loadPromptById(promptParam);
      setSearchParams({}, { replace: true });
    }
  }, [loading, searchParams]);

  const loadPromptById = async (promptId) => {
    const prompt = await api.getAutobiographyPromptById(promptId).catch(() => null);
    if (prompt) {
      setCurrentPrompt(prompt);
      setWriting(true);
      setStoryContent('');
    }
  };

  const startWriting = async () => {
    const prompt = await api.getAutobiographyPrompt().catch((err) => {
      toast.error(err.message);
      return null;
    });
    if (prompt) {
      setCurrentPrompt(prompt);
      setWriting(true);
      setStoryContent('');
    }
  };

  const skipPrompt = async () => {
    const prompt = await api.getAutobiographyPrompt().catch(() => null);
    if (prompt && prompt.id !== currentPrompt?.id) {
      setCurrentPrompt(prompt);
      setStoryContent('');
    } else {
      toast('No more prompts available right now', { icon: 'ℹ️' });
    }
  };

  const saveStory = async () => {
    if (!storyContent.trim()) {
      toast.error('Write something before saving');
      return;
    }
    setSaving(true);
    const result = await api.saveAutobiographyStory(currentPrompt.id, storyContent.trim())
      .catch((err) => { toast.error(err.message); return null; });

    if (result) {
      toast.success(`Story saved (${result.wordCount} words)`);
      setWriting(false);
      setCurrentPrompt(null);
      setStoryContent('');
      loadData();
      onRefresh?.();
    }
    setSaving(false);
  };

  const handleUpdateStory = async (storyId) => {
    if (!editContent.trim()) return;
    const result = await api.updateAutobiographyStory(storyId, editContent.trim())
      .catch((err) => { toast.error(err.message); return null; });
    if (result) {
      toast.success('Story updated');
      setEditingStory(null);
      setEditContent('');
      loadData();
    }
  };

  const handleDeleteStory = async (storyId) => {
    const result = await api.deleteAutobiographyStory(storyId)
      .catch((err) => { toast.error(err.message); return null; });
    if (result) {
      toast.success('Story deleted');
      loadData();
    }
  };

  const handleConfigUpdate = async (updates) => {
    const result = await api.updateAutobiographyConfig(updates)
      .catch((err) => { toast.error(err.message); return null; });
    if (result) {
      setConfig(result);
      toast.success('Settings updated');
    }
  };

  const wordCount = storyContent.split(/\s+/).filter(Boolean).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header Stats */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-amber-400" />
          <span className="text-lg font-semibold text-white">Autobiography</span>
        </div>
        {stats && (
          <div className="flex flex-wrap gap-3 text-sm text-gray-400">
            <span>{stats.totalStories} stories</span>
            <span>{stats.totalWords.toLocaleString()} words</span>
            <span>{stats.promptsRemaining} prompts remaining</span>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowConfig(!showConfig)}
            className="p-2 rounded text-gray-400 hover:text-white hover:bg-port-card transition-colors"
            title="Settings"
          >
            <Settings size={16} />
          </button>
          <button
            onClick={startWriting}
            className="flex items-center gap-2 px-3 py-2 bg-port-accent text-white rounded text-sm font-medium hover:bg-port-accent/80 transition-colors"
          >
            <PenLine size={14} />
            Write a Story
          </button>
        </div>
      </div>

      {/* Config Panel */}
      {showConfig && config && (
        <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-medium text-white">Prompt Settings</h3>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => handleConfigUpdate({ enabled: e.target.checked })}
                className="rounded border-port-border"
              />
              Enable automatic prompts
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              Prompt every
              <select
                value={config.intervalHours}
                onChange={(e) => handleConfigUpdate({ intervalHours: parseInt(e.target.value, 10) })}
                className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
              >
                <option value="12">12 hours</option>
                <option value="24">24 hours</option>
                <option value="48">2 days</option>
                <option value="72">3 days</option>
                <option value="168">Weekly</option>
              </select>
            </label>
          </div>
          {config.lastPromptAt && (
            <p className="text-xs text-gray-500">
              Last prompt: {new Date(config.lastPromptAt).toLocaleString()}
            </p>
          )}
        </div>
      )}

      {/* Writing Mode */}
      {writing && currentPrompt && (
        <div className="bg-port-card border border-port-accent/30 rounded-lg p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <span className="text-xs font-medium text-port-accent uppercase tracking-wide">
                {currentPrompt.themeLabel}
              </span>
              <p className="text-white text-lg mt-1">{currentPrompt.text}</p>
            </div>
            <button
              onClick={() => { setWriting(false); setCurrentPrompt(null); setStoryContent(''); }}
              className="p-1 text-gray-500 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>

          <textarea
            value={storyContent}
            onChange={(e) => setStoryContent(e.target.value)}
            placeholder="Start writing your story... Take about 5 minutes."
            className="w-full h-64 bg-port-bg border border-port-border rounded-lg p-4 text-white text-sm resize-y focus:outline-none focus:border-port-accent/50 placeholder-gray-600"
            autoFocus
          />

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 text-sm text-gray-400">
              <span>{wordCount} words</span>
              <Clock size={14} />
              <span>~{Math.max(1, Math.round(wordCount / 150))} min read</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={skipPrompt}
                className="flex items-center gap-1 px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                title="Get a different prompt"
              >
                <SkipForward size={14} />
                Skip
              </button>
              <button
                onClick={saveStory}
                disabled={saving || !storyContent.trim()}
                className="flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded text-sm font-medium hover:bg-port-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
                Save Story
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Theme Filter */}
      {stories.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setFilterTheme(null)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              !filterTheme
                ? 'bg-port-accent text-white'
                : 'bg-port-card text-gray-400 hover:text-white border border-port-border'
            }`}
          >
            All
          </button>
          {themes.map((theme) => (
            <button
              key={theme.id}
              onClick={() => setFilterTheme(filterTheme === theme.id ? null : theme.id)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                filterTheme === theme.id
                  ? 'bg-port-accent text-white'
                  : 'bg-port-card text-gray-400 hover:text-white border border-port-border'
              }`}
            >
              {theme.label}
              {stats?.byTheme?.[theme.id] ? ` (${stats.byTheme[theme.id]})` : ''}
            </button>
          ))}
        </div>
      )}

      {/* Stories List */}
      {stories.length === 0 && !writing && (
        <div className="text-center py-12 text-gray-500">
          <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p className="text-lg">No stories yet</p>
          <p className="text-sm mt-1">Click "Write a Story" to get your first prompt</p>
        </div>
      )}

      {stories.map((story) => {
        const isExpanded = expandedStory === story.id;
        const isEditing = editingStory === story.id;

        return (
          <div
            key={story.id}
            className="bg-port-card border border-port-border rounded-lg overflow-hidden"
          >
            <button
              onClick={() => setExpandedStory(isExpanded ? null : story.id)}
              className="w-full flex items-center justify-between p-4 text-left hover:bg-port-bg/50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-port-accent">{story.themeLabel}</span>
                  <span className="text-xs text-gray-500">{story.wordCount} words</span>
                  <span className="text-xs text-gray-600">
                    {new Date(story.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="text-sm text-gray-300 truncate">{story.promptText}</p>
              </div>
              {isExpanded ? <ChevronUp size={16} className="text-gray-500 flex-shrink-0" /> : <ChevronDown size={16} className="text-gray-500 flex-shrink-0" />}
            </button>

            {isExpanded && (
              <div className="border-t border-port-border p-4 space-y-3">
                {isEditing ? (
                  <>
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="w-full h-48 bg-port-bg border border-port-border rounded p-3 text-white text-sm resize-y focus:outline-none focus:border-port-accent/50"
                    />
                    <div className="flex items-center gap-2 justify-end">
                      <button
                        onClick={() => { setEditingStory(null); setEditContent(''); }}
                        className="px-3 py-1.5 text-sm text-gray-400 hover:text-white"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleUpdateStory(story.id)}
                        className="flex items-center gap-1 px-3 py-1.5 bg-port-accent text-white rounded text-sm hover:bg-port-accent/80"
                      >
                        <Save size={12} />
                        Save
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-white whitespace-pre-wrap leading-relaxed">
                      {story.content}
                    </p>
                    <div className="flex items-center gap-2 justify-end pt-2 border-t border-port-border/50">
                      <button
                        onClick={() => { setEditingStory(story.id); setEditContent(story.content); }}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors"
                      >
                        <PenLine size={12} />
                        Edit
                      </button>
                      <button
                        onClick={() => handleDeleteStory(story.id)}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-red-400 transition-colors"
                      >
                        <Trash2 size={12} />
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
