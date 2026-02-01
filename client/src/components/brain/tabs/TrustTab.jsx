import { useState, useEffect, useCallback } from 'react';
import * as api from '../../../services/api';
import {
  RefreshCw,
  Shield,
  ChevronDown,
  ChevronRight,
  Eye,
  Settings
} from 'lucide-react';
import toast from 'react-hot-toast';

import {
  DESTINATIONS,
  STATUS_COLORS,
  getConfidenceColor,
  formatRelativeTime
} from '../constants';

export default function TrustTab({ onRefresh }) {
  const [entries, setEntries] = useState([]);
  const [counts, setCounts] = useState({});
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [editingSettings, setEditingSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState({});

  const fetchData = useCallback(async () => {
    const [inboxData, settingsData] = await Promise.all([
      api.getBrainInbox({ status: statusFilter || undefined, limit: 100 }).catch(() => ({ entries: [], counts: {} })),
      api.getBrainSettings().catch(() => null)
    ]);

    setEntries(inboxData.entries || []);
    setCounts(inboxData.counts || {});
    setSettings(settingsData);
    setSettingsForm(settingsData || {});
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSaveSettings = async () => {
    const threshold = parseFloat(settingsForm.confidenceThreshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      toast.error('Confidence threshold must be a number between 0 and 1');
      return;
    }

    const result = await api.updateBrainSettings({
      confidenceThreshold: threshold,
      dailyDigestTime: settingsForm.dailyDigestTime,
      weeklyReviewTime: settingsForm.weeklyReviewTime,
      weeklyReviewDay: settingsForm.weeklyReviewDay
    }).catch(err => {
      toast.error(err.message || 'Failed to save settings');
      return null;
    });

    if (result) {
      toast.success('Settings saved');
      setEditingSettings(false);
      setSettings(result);
      onRefresh?.();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with stats */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="w-6 h-6 text-port-accent" />
          <div>
            <h2 className="text-lg font-semibold text-white">Trust Panel</h2>
            <p className="text-sm text-gray-500">Audit trail and system settings</p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-sm">
          <span className="text-gray-500">Total: {counts.total || 0}</span>
          <span className="text-port-success">Filed: {counts.filed || 0}</span>
          <span className="text-port-warning">Review: {counts.needs_review || 0}</span>
          <span className="text-blue-400">Corrected: {counts.corrected || 0}</span>
          <span className="text-port-error">Errors: {counts.error || 0}</span>
        </div>
      </div>

      {/* Settings Section */}
      <div className="p-4 bg-port-card border border-port-border rounded-lg">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium text-white flex items-center gap-2">
            <Settings size={16} />
            Settings
          </h3>
          {!editingSettings && (
            <button
              onClick={() => setEditingSettings(true)}
              className="text-sm text-port-accent hover:underline"
            >
              Edit
            </button>
          )}
        </div>

        {editingSettings ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Confidence Threshold</label>
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={settingsForm.confidenceThreshold || 0.6}
                  onChange={(e) => setSettingsForm({ ...settingsForm, confidenceThreshold: e.target.value })}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Items below this threshold go to "needs review" (0-1)
                </p>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Daily Digest Time</label>
                <input
                  type="time"
                  value={settingsForm.dailyDigestTime || '09:00'}
                  onChange={(e) => setSettingsForm({ ...settingsForm, dailyDigestTime: e.target.value })}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Weekly Review Day</label>
                <select
                  value={settingsForm.weeklyReviewDay || 'sunday'}
                  onChange={(e) => setSettingsForm({ ...settingsForm, weeklyReviewDay: e.target.value })}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                >
                  <option value="sunday">Sunday</option>
                  <option value="monday">Monday</option>
                  <option value="tuesday">Tuesday</option>
                  <option value="wednesday">Wednesday</option>
                  <option value="thursday">Thursday</option>
                  <option value="friday">Friday</option>
                  <option value="saturday">Saturday</option>
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Weekly Review Time</label>
                <input
                  type="time"
                  value={settingsForm.weeklyReviewTime || '16:00'}
                  onChange={(e) => setSettingsForm({ ...settingsForm, weeklyReviewTime: e.target.value })}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleSaveSettings}
                className="px-3 py-1.5 bg-port-accent/20 text-port-accent rounded hover:bg-port-accent/30"
              >
                Save
              </button>
              <button
                onClick={() => { setEditingSettings(false); setSettingsForm(settings || {}); }}
                className="px-3 py-1.5 text-gray-400 hover:text-white"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Confidence Threshold:</span>
              <span className="text-white ml-2">{Math.round((settings?.confidenceThreshold || 0.6) * 100)}%</span>
            </div>
            <div>
              <span className="text-gray-500">Daily Digest:</span>
              <span className="text-white ml-2">{settings?.dailyDigestTime || '09:00'}</span>
            </div>
            <div>
              <span className="text-gray-500">Weekly Review:</span>
              <span className="text-white ml-2">{settings?.weeklyReviewDay || 'Sunday'} {settings?.weeklyReviewTime || '16:00'}</span>
            </div>
            <div>
              <span className="text-gray-500">Provider:</span>
              <span className="text-white ml-2">{settings?.defaultProvider || 'lmstudio'}</span>
            </div>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-500">Filter by status:</span>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-1.5 bg-port-card border border-port-border rounded text-sm text-white"
        >
          <option value="">All</option>
          <option value="filed">Filed</option>
          <option value="needs_review">Needs Review</option>
          <option value="corrected">Corrected</option>
          <option value="error">Error</option>
        </select>

        <button
          onClick={fetchData}
          className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-400 hover:text-white"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Audit Log */}
      <div className="space-y-2">
        {entries.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No entries found.</p>
        ) : (
          entries.map(entry => {
            const isExpanded = expandedId === entry.id;
            const destInfo = DESTINATIONS[entry.classification?.destination || 'unknown'];
            const DestIcon = destInfo.icon;
            const confidence = entry.classification?.confidence || 0;

            return (
              <div
                key={entry.id}
                className="p-3 bg-port-card border border-port-border rounded-lg"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-white truncate">{entry.capturedText}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className={`px-2 py-0.5 text-xs rounded border ${STATUS_COLORS[entry.status]}`}>
                        {entry.status}
                      </span>
                      <span className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded border ${destInfo.color}`}>
                        <DestIcon size={10} />
                        {destInfo.label}
                      </span>
                      <span className={`text-xs ${getConfidenceColor(confidence)}`}>
                        {Math.round(confidence * 100)}%
                      </span>
                      <span className="text-xs text-gray-500">
                        {formatRelativeTime(entry.capturedAt)}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-port-border/50"
                    title="View details"
                  >
                    {isExpanded ? <ChevronDown size={16} /> : <Eye size={16} />}
                  </button>
                </div>

                {isExpanded && (
                  <div className="mt-3 p-3 bg-port-bg rounded-lg">
                    <h4 className="text-xs font-medium text-gray-400 mb-2">Full Classification Data</h4>
                    <pre className="text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap">
                      {JSON.stringify({
                        id: entry.id,
                        capturedAt: entry.capturedAt,
                        source: entry.source,
                        status: entry.status,
                        classification: entry.classification,
                        filed: entry.filed,
                        correction: entry.correction,
                        error: entry.error,
                        ai: entry.ai
                      }, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
