import { useState, useEffect, useCallback } from 'react';
import * as api from '../../../services/api';
import {
  RefreshCw,
  Play,
  Calendar,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  CheckCircle,
  Clock
} from 'lucide-react';
import toast from 'react-hot-toast';

import { formatRelativeTime } from '../constants';

export default function DigestTab({ onRefresh }) {
  const [latestDigest, setLatestDigest] = useState(null);
  const [latestReview, setLatestReview] = useState(null);
  const [digestHistory, setDigestHistory] = useState([]);
  const [reviewHistory, setReviewHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [runningDigest, setRunningDigest] = useState(false);
  const [runningReview, setRunningReview] = useState(false);
  const [showDigestHistory, setShowDigestHistory] = useState(false);
  const [showReviewHistory, setShowReviewHistory] = useState(false);

  const fetchData = useCallback(async () => {
    const [digest, review, digests, reviews] = await Promise.all([
      api.getBrainLatestDigest().catch(() => null),
      api.getBrainLatestReview().catch(() => null),
      api.getBrainDigests().catch(() => []),
      api.getBrainReviews().catch(() => [])
    ]);

    setLatestDigest(digest);
    setLatestReview(review);
    setDigestHistory(digests.slice(1)); // Exclude latest
    setReviewHistory(reviews.slice(1)); // Exclude latest
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRunDigest = async () => {
    setRunningDigest(true);
    const result = await api.runBrainDigest().catch(err => {
      toast.error(err.message || 'Failed to generate digest');
      return null;
    });
    setRunningDigest(false);

    if (result) {
      toast.success('Daily digest generated');
      fetchData();
      onRefresh?.();
    }
  };

  const handleRunReview = async () => {
    setRunningReview(true);
    const result = await api.runBrainReview().catch(err => {
      toast.error(err.message || 'Failed to generate review');
      return null;
    });
    setRunningReview(false);

    if (result) {
      toast.success('Weekly review generated');
      fetchData();
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
    <div className="space-y-8 max-w-3xl mx-auto">
      {/* Daily Digest Section */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-port-accent" />
            <h2 className="text-lg font-semibold text-white">Daily Digest</h2>
          </div>
          <button
            onClick={handleRunDigest}
            disabled={runningDigest}
            className="flex items-center gap-2 px-3 py-1.5 bg-port-accent/20 text-port-accent rounded-lg text-sm hover:bg-port-accent/30 disabled:opacity-50"
          >
            {runningDigest ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
            Generate Now
          </button>
        </div>

        {latestDigest ? (
          <div className="p-4 bg-port-card border border-port-border rounded-lg">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-gray-500">
                Generated {formatRelativeTime(latestDigest.generatedAt)}
              </span>
            </div>

            <p className="text-white mb-4">{latestDigest.digestText}</p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
              {/* Top Actions */}
              <div className="p-3 bg-port-bg rounded-lg">
                <h4 className="text-xs font-medium text-port-accent mb-2 flex items-center gap-1">
                  <CheckCircle size={12} />
                  Top Actions
                </h4>
                <ul className="space-y-1">
                  {latestDigest.topActions?.map((action, i) => (
                    <li key={i} className="text-sm text-gray-300">• {action}</li>
                  ))}
                </ul>
              </div>

              {/* Stuck Thing */}
              <div className="p-3 bg-port-bg rounded-lg">
                <h4 className="text-xs font-medium text-port-warning mb-2 flex items-center gap-1">
                  <AlertCircle size={12} />
                  Stuck
                </h4>
                <p className="text-sm text-gray-300">{latestDigest.stuckThing || 'Nothing stuck'}</p>
              </div>

              {/* Small Win */}
              <div className="p-3 bg-port-bg rounded-lg">
                <h4 className="text-xs font-medium text-port-success mb-2 flex items-center gap-1">
                  <CheckCircle size={12} />
                  Small Win
                </h4>
                <p className="text-sm text-gray-300">{latestDigest.smallWin || 'Keep going!'}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-8 bg-port-card border border-port-border rounded-lg text-center">
            <Calendar className="w-12 h-12 text-gray-500 mx-auto mb-3" />
            <p className="text-gray-500">No daily digest yet.</p>
            <p className="text-gray-600 text-sm mt-1">Click "Generate Now" to create your first digest.</p>
          </div>
        )}

        {/* Digest History */}
        {digestHistory.length > 0 && (
          <div className="mt-3">
            <button
              onClick={() => setShowDigestHistory(!showDigestHistory)}
              className="flex items-center gap-2 text-sm text-gray-400 hover:text-white"
            >
              {showDigestHistory ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Previous digests ({digestHistory.length})
            </button>

            {showDigestHistory && (
              <div className="mt-2 space-y-2">
                {digestHistory.map(digest => (
                  <div key={digest.id} className="p-3 bg-port-card/50 border border-port-border rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-gray-500">
                        {formatRelativeTime(digest.generatedAt)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-300">{digest.digestText}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Weekly Review Section */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-purple-400" />
            <h2 className="text-lg font-semibold text-white">Weekly Review</h2>
          </div>
          <button
            onClick={handleRunReview}
            disabled={runningReview}
            className="flex items-center gap-2 px-3 py-1.5 bg-purple-500/20 text-purple-400 rounded-lg text-sm hover:bg-purple-500/30 disabled:opacity-50"
          >
            {runningReview ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
            Generate Now
          </button>
        </div>

        {latestReview ? (
          <div className="p-4 bg-port-card border border-port-border rounded-lg">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-gray-500">
                Generated {formatRelativeTime(latestReview.generatedAt)}
              </span>
            </div>

            <p className="text-white mb-4">{latestReview.reviewText}</p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              {/* What Happened */}
              <div className="p-3 bg-port-bg rounded-lg">
                <h4 className="text-xs font-medium text-blue-400 mb-2">What Happened</h4>
                <ul className="space-y-1">
                  {latestReview.whatHappened?.map((item, i) => (
                    <li key={i} className="text-sm text-gray-300">• {item}</li>
                  ))}
                </ul>
              </div>

              {/* Suggested Actions */}
              <div className="p-3 bg-port-bg rounded-lg">
                <h4 className="text-xs font-medium text-port-accent mb-2">Actions Next Week</h4>
                <ul className="space-y-1">
                  {latestReview.suggestedActionsNextWeek?.map((action, i) => (
                    <li key={i} className="text-sm text-gray-300">• {action}</li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Open Loops */}
            {latestReview.biggestOpenLoops?.length > 0 && (
              <div className="p-3 bg-port-warning/10 border border-port-warning/30 rounded-lg mb-4">
                <h4 className="text-xs font-medium text-port-warning mb-2">Biggest Open Loops</h4>
                <ul className="space-y-1">
                  {latestReview.biggestOpenLoops.map((loop, i) => (
                    <li key={i} className="text-sm text-gray-300">• {loop}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Recurring Theme */}
            {latestReview.recurringTheme && (
              <div className="p-3 bg-purple-500/10 border border-purple-500/30 rounded-lg">
                <h4 className="text-xs font-medium text-purple-400 mb-1">Pattern Noticed</h4>
                <p className="text-sm text-gray-300">{latestReview.recurringTheme}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="p-8 bg-port-card border border-port-border rounded-lg text-center">
            <Clock className="w-12 h-12 text-gray-500 mx-auto mb-3" />
            <p className="text-gray-500">No weekly review yet.</p>
            <p className="text-gray-600 text-sm mt-1">Click "Generate Now" to create your first review.</p>
          </div>
        )}

        {/* Review History */}
        {reviewHistory.length > 0 && (
          <div className="mt-3">
            <button
              onClick={() => setShowReviewHistory(!showReviewHistory)}
              className="flex items-center gap-2 text-sm text-gray-400 hover:text-white"
            >
              {showReviewHistory ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Previous reviews ({reviewHistory.length})
            </button>

            {showReviewHistory && (
              <div className="mt-2 space-y-2">
                {reviewHistory.map(review => (
                  <div key={review.id} className="p-3 bg-port-card/50 border border-port-border rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-gray-500">
                        {formatRelativeTime(review.generatedAt)}
                      </span>
                    </div>
                    <p className="text-sm text-gray-300">{review.reviewText}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
