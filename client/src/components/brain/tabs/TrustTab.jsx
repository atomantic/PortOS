import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router';
import useLatestRequest from '../../../hooks/useLatestRequest.js';
import { getBrainInbox, getBrainSettings } from '../../../services/apiBrain.js';
import {
  RefreshCw,
  Shield,
  ChevronDown,
  Eye,
  Settings
} from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import toast from '../../ui/Toast';
import ListLoadError from '../../ui/ListLoadError';

import {
  STATUS_COLORS,
  destinationInfo
} from '../constants';
import ConfidenceBadge from '../ConfidenceBadge';
import { timeAgo } from '../../../utils/formatters';

export default function TrustTab({ onRefresh }) {
  const [entries, setEntries] = useState([]);
  const [counts, setCounts] = useState({});
  const [settings, setSettings] = useState(null);
  const [inboxError, setInboxError] = useState(null);
  const [settingsError, setSettingsError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const beginLoad = useLatestRequest();

  const fetchData = useCallback(async () => {
    const isCurrent = beginLoad();
    const asError = (error) => (error instanceof Error ? error : new Error('Request failed'));
    // The rows own their error UI (silent), and a failure is carried as a
    // value so it never reads as an empty log or as default settings.
    const [inboxResult, settingsResult] = await Promise.all([
      getBrainInbox({ status: statusFilter || undefined, limit: 100, silent: true })
        .then((data) => ({ data }), (error) => ({ error: asError(error) })),
      getBrainSettings({ silent: true })
        .then((data) => ({ data }), (error) => ({ error: asError(error) })),
    ]);
    if (!isCurrent()) return;

    setInboxError(inboxResult.error || null);
    if (inboxResult.data) {
      setEntries(inboxResult.data.entries || []);
      setCounts(inboxResult.data.counts || {});
    }
    setSettingsError(settingsResult.error || null);
    if (settingsResult.data) {
      setSettings(settingsResult.data);
    }
    setLoading(false);
  }, [statusFilter, beginLoad]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with stats */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Shield className="w-6 h-6 text-port-accent shrink-0" />
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-white">Trust Panel</h2>
            <p className="text-sm text-gray-500">Audit trail and system settings</p>
          </div>
        </div>

        {!inboxError && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="text-gray-500">Total: {counts.total || 0}</span>
            <span className="text-port-success">Filed: {counts.filed || 0}</span>
            <span className="text-port-warning">Review: {counts.needs_review || 0}</span>
            <span className="text-blue-400">Corrected: {counts.corrected || 0}</span>
            <span className="text-port-error">Errors: {counts.error || 0}</span>
          </div>
        )}
      </div>

      {/* Settings Section — read-only; ConfigTab owns editing */}
      <div className="p-4 bg-port-card border border-port-border rounded-lg">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium text-white flex items-center gap-2">
            <Settings size={16} />
            Settings
          </h3>
          {!settingsError && (
            <Link
              to="/brain/config"
              className="px-3 py-1.5 text-sm bg-port-accent/20 text-port-accent rounded hover:bg-port-accent/30"
            >
              Edit in Config
            </Link>
          )}
        </div>

        {settingsError ? (
          <ListLoadError what="Brain settings" error={settingsError} onRetry={fetchData} />
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Confidence Threshold:</span>
              <span className="text-white ml-2">{Math.round((settings?.confidenceThreshold ?? 0.6) * 100)}%</span>
            </div>
            <div>
              <span className="text-gray-500">Scheduled Reviews:</span>
              <span className="text-white ml-2">{settings?.scheduledReviewsEnabled === true ? `On (digest ${settings?.dailyDigestTime || "09:00"}, review ${settings?.weeklyReviewDay || "sunday"} ${settings?.weeklyReviewTime || "16:00"})` : "Off"}</span>
            </div>
            <div>
              <span className="text-gray-500">Provider:</span>
              <span className="text-white ml-2">{settings?.defaultProvider || "Not configured"}</span>
            </div>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-sm text-gray-500">Filter by status:</span>
        <select
          aria-label="Filter by status"
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
        {inboxError ? (
          <ListLoadError what="the audit log" error={inboxError} onRetry={fetchData} />
        ) : entries.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No entries found.</p>
        ) : (
          entries.map(entry => {
            const isExpanded = expandedId === entry.id;
            const destInfo = destinationInfo(entry);
            const DestIcon = destInfo.icon;
            // Absent for an entry no model classified (a URL filed to Links).
            const confidence = entry.classification?.confidence;

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
                      <ConfidenceBadge confidence={confidence} />
                      <span className="text-xs text-gray-500">
                        {timeAgo(entry.capturedAt)}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-white rounded hover:bg-port-border/50"
                    title={isExpanded ? 'Hide details' : 'View details'}
                    aria-label={isExpanded ? 'Hide details' : 'View details'}
                  >
                    {isExpanded ? <ChevronDown size={16} /> : <Eye size={16} />}
                  </button>
                </div>

                {isExpanded && (
                  <div className="mt-3 p-3 bg-port-bg rounded-lg">
                    <h4 className="text-xs font-medium text-gray-400 mb-2">Full Classification Data</h4>
                    <pre className="text-xs text-gray-300 overflow-x-auto whitespace-pre-wrap break-all">
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
