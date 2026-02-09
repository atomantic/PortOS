import { useState, useEffect, useCallback } from 'react';
import * as api from '../../../services/api';

const formatRelativeTime = (dateStr) => {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
};

export default function PublishedTab({ agentId }) {
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [published, setPublished] = useState({ posts: [], comments: [] });
  const [publishedLoading, setPublishedLoading] = useState(false);
  const [publishedDays, setPublishedDays] = useState(7);
  const [loading, setLoading] = useState(true);

  const fetchAccounts = useCallback(async () => {
    const data = await api.getPlatformAccounts(agentId);
    const active = data.filter(a => a.status === 'active');
    setAccounts(active);
    // Auto-select first account
    if (active.length > 0 && !selectedAccountId) {
      setSelectedAccountId(active[0].id);
    }
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const loadPublished = useCallback(async () => {
    if (!agentId || !selectedAccountId) {
      setPublished({ posts: [], comments: [] });
      return;
    }
    setPublishedLoading(true);
    const data = await api.getAgentPublished(agentId, selectedAccountId, publishedDays);
    setPublished(data);
    setPublishedLoading(false);
  }, [agentId, selectedAccountId, publishedDays]);

  useEffect(() => {
    loadPublished();
  }, [loadPublished]);

  if (loading) {
    return <div className="p-4 text-gray-400">Loading...</div>;
  }

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex flex-wrap items-end gap-4 mb-6 p-4 bg-port-card border border-port-border rounded-lg">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Account</label>
          <select
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className="px-3 py-2 bg-port-bg border border-port-border rounded text-white min-w-[200px]"
          >
            <option value="">Select account...</option>
            {accounts.map(account => (
              <option key={account.id} value={account.id}>
                {account.credentials.username}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <select
            value={publishedDays}
            onChange={(e) => setPublishedDays(parseInt(e.target.value, 10))}
            className="px-2 py-1 text-sm bg-port-bg border border-port-border rounded text-white"
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
          </select>
          <button
            onClick={loadPublished}
            disabled={publishedLoading}
            className="px-3 py-1 text-sm bg-port-accent/20 text-port-accent rounded hover:bg-port-accent/30 disabled:opacity-50"
          >
            {publishedLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {!selectedAccountId && (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg mb-2">Select an account to view published content</p>
        </div>
      )}

      {selectedAccountId && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <div className="flex items-center gap-3 mb-4">
            <h3 className="font-semibold text-white">Published Content</h3>
            {published.posts.length > 0 && (
              <span className="text-xs px-2 py-0.5 rounded bg-port-accent/20 text-port-accent">
                {published.posts.length} post{published.posts.length !== 1 ? 's' : ''}
              </span>
            )}
            {published.comments.length > 0 && (
              <span className="text-xs px-2 py-0.5 rounded bg-port-success/20 text-port-success">
                {published.comments.length} comment{published.comments.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {publishedLoading && published.posts.length === 0 && published.comments.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-4">Loading published content...</p>
          )}

          {/* Posts Table */}
          {published.posts.length > 0 && (
            <div className="mb-4">
              <h4 className="text-sm font-medium text-gray-400 mb-2">Posts</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-port-border">
                      <th className="pb-2 pr-4">Title</th>
                      <th className="pb-2 pr-4">Submolt</th>
                      <th className="pb-2 pr-4 text-right">Score</th>
                      <th className="pb-2 pr-4 text-right">Comments</th>
                      <th className="pb-2 pr-4">Published</th>
                      <th className="pb-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {published.posts.map(post => (
                      <tr key={post.postId} className="border-b border-port-border/50 hover:bg-port-bg/50">
                        <td className="py-2 pr-4 max-w-[250px]">
                          <span className="text-white truncate block" title={post.title}>
                            {post.title}
                          </span>
                        </td>
                        <td className="py-2 pr-4">
                          <span className="text-port-accent text-xs">/{post.submolt}</span>
                        </td>
                        <td className="py-2 pr-4 text-right">
                          {post.score !== null ? (
                            <span className={post.score > 0 ? 'text-port-success' : 'text-gray-500'}>
                              {post.score}
                            </span>
                          ) : (
                            <span className="text-gray-600">-</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-right text-gray-400">
                          {post.commentCount ?? '-'}
                        </td>
                        <td className="py-2 pr-4 text-gray-500 whitespace-nowrap" title={new Date(post.publishedAt).toLocaleString()}>
                          {formatRelativeTime(post.publishedAt)}
                        </td>
                        <td className="py-2">
                          <a
                            href={post.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-port-accent hover:text-port-accent/80"
                            title="Open on Moltbook"
                          >
                            ↗
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Comments Table */}
          {published.comments.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-400 mb-2">Comments</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-port-border">
                      <th className="pb-2 pr-4">Post</th>
                      <th className="pb-2 pr-4">Type</th>
                      <th className="pb-2 pr-4">Published</th>
                      <th className="pb-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {published.comments.map(comment => (
                      <tr key={comment.commentId} className="border-b border-port-border/50 hover:bg-port-bg/50">
                        <td className="py-2 pr-4 max-w-[350px]">
                          <span className="text-white truncate block" title={comment.postTitle}>
                            {comment.postTitle}
                          </span>
                        </td>
                        <td className="py-2 pr-4">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${
                            comment.isReply
                              ? 'bg-purple-500/20 text-purple-400'
                              : 'bg-port-accent/20 text-port-accent'
                          }`}>
                            {comment.isReply ? 'reply' : 'comment'}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-gray-500 whitespace-nowrap" title={new Date(comment.publishedAt).toLocaleString()}>
                          {formatRelativeTime(comment.publishedAt)}
                        </td>
                        <td className="py-2">
                          <a
                            href={comment.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-port-accent hover:text-port-accent/80"
                            title="Open on Moltbook"
                          >
                            ↗
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!publishedLoading && published.posts.length === 0 && published.comments.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-4">
              No published content in the last {publishedDays} days
            </p>
          )}
        </div>
      )}
    </div>
  );
}
