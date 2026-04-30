import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../../../services/api';
import {
  Rss,
  Send,
  RefreshCw,
  ExternalLink,
  Trash2,
  CheckCheck,
  Circle,
  ChevronRight,
  X
} from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import toast from '../../ui/Toast';
import { timeAgo } from '../../../utils/formatters';

export default function FeedsTab({ onRefresh }) {
  const [inputUrl, setInputUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [feeds, setFeeds] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedFeedId, setSelectedFeedId] = useState(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const inputRef = useRef(null);

  const fetchFeeds = useCallback(async () => {
    const data = await api.getFeeds().catch(() => []);
    setFeeds(data);
  }, []);

  const fetchItems = useCallback(async () => {
    const data = await api.getFeedItems({
      feedId: selectedFeedId,
      unreadOnly
    }).catch(() => []);
    setItems(data);
  }, [selectedFeedId, unreadOnly]);

  useEffect(() => {
    Promise.all([fetchFeeds(), fetchItems()]).then(() => setLoading(false));
  }, [fetchFeeds, fetchItems]);

  const handleAddFeed = async (e) => {
    e.preventDefault();
    if (!inputUrl.trim() || adding) return;

    let url = inputUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    setAdding(true);
    const result = await api.addFeed(url).catch(() => null);
    setAdding(false);

    if (result) {
      toast.success(`Subscribed to ${result.title}`);
      setInputUrl('');
      fetchFeeds();
      fetchItems();
      onRefresh?.();
    }
  };

  const handleRemoveFeed = async (id) => {
    await api.removeFeed(id).catch(() => null);
    toast.success('Feed removed');
    setConfirmingDeleteId(null);
    setFeeds(prev => prev.filter(f => f.id !== id));
    setItems(prev => prev.filter(i => i.feedId !== id));
    if (selectedFeedId === id) setSelectedFeedId(null);
    onRefresh?.();
  };

  const handleRefreshAll = async () => {
    setRefreshing(true);
    const result = await api.refreshAllFeeds().catch(() => null);
    setRefreshing(false);
    if (result) {
      toast.success(`Refreshed ${result.refreshed} feeds (+${result.newItems} new)`);
      fetchFeeds();
      fetchItems();
    }
  };

  const handleRefreshFeed = async (id) => {
    const result = await api.refreshFeed(id).catch(() => null);
    if (result) {
      toast.success(`+${result.newCount} new items`);
      fetchFeeds();
      fetchItems();
    }
  };

  const handleMarkRead = async (itemId) => {
    await api.markFeedItemRead(itemId).catch(() => null);
    // Track which feed to update before modifying items state
    setItems(prev => {
      const item = prev.find(i => i.id === itemId);
      if (item && !item.read) {
        setFeeds(fPrev => fPrev.map(f =>
          f.id === item.feedId ? { ...f, unreadCount: Math.max(0, f.unreadCount - 1) } : f
        ));
      }
      return prev.map(i => i.id === itemId ? { ...i, read: true } : i);
    });
  };

  const handleMarkAllRead = async () => {
    await api.markAllFeedItemsRead(selectedFeedId).catch(() => null);
    setItems(prev => prev.map(i => {
      if (!selectedFeedId || i.feedId === selectedFeedId) return { ...i, read: true };
      return i;
    }));
    setFeeds(prev => prev.map(f => {
      if (!selectedFeedId || f.id === selectedFeedId) return { ...f, unreadCount: 0 };
      return f;
    }));
    toast.success('Marked all as read');
  };

  const handleItemClick = async (item) => {
    if (!item.read) handleMarkRead(item.id);
    window.open(item.link, '_blank', 'noopener,noreferrer');
  };

  const totalUnread = feeds.reduce((sum, f) => sum + (f.unreadCount || 0), 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full max-w-5xl mx-auto">
      {/* Quick-add input */}
      <form onSubmit={handleAddFeed} className="mb-4">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="Paste an RSS or Atom feed URL..."
            className="flex-1 px-4 py-3 bg-port-card border border-port-border rounded-lg text-white placeholder-gray-500 focus:outline-hidden focus:border-port-accent"
            disabled={adding}
          />
          <button
            type="submit"
            disabled={adding || !inputUrl.trim()}
            className="px-4 py-3 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 min-h-[48px]"
            title={adding ? 'Subscribing...' : 'Subscribe to feed'}
          >
            {adding ? (
              <BrailleSpinner />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
      </form>

      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSelectedFeedId(null)}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors min-h-[36px] ${
              !selectedFeedId
                ? 'bg-port-accent/20 text-port-accent border border-port-accent/30'
                : 'bg-port-card text-gray-400 hover:text-white border border-port-border'
            }`}
          >
            All feeds
            {totalUnread > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-port-accent/30 rounded-full">{totalUnread}</span>
            )}
          </button>
          <button
            onClick={() => setUnreadOnly(!unreadOnly)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors min-h-[36px] ${
              unreadOnly
                ? 'bg-port-warning/20 text-port-warning border border-port-warning/30'
                : 'bg-port-card text-gray-400 hover:text-white border border-port-border'
            }`}
          >
            <Circle size={12} className={unreadOnly ? 'fill-current' : ''} />
            Unread
          </button>
        </div>
        <div className="flex items-center gap-2">
          {items.some(i => !i.read) && (
            <button
              onClick={handleMarkAllRead}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white bg-port-card border border-port-border rounded-lg transition-colors min-h-[36px]"
              title="Mark all as read"
            >
              <CheckCheck size={14} />
              <span className="hidden sm:inline">Mark all read</span>
            </button>
          )}
          {feeds.length > 0 && (
            <button
              onClick={handleRefreshAll}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white bg-port-card border border-port-border rounded-lg transition-colors disabled:opacity-50 min-h-[36px]"
              title="Refresh all feeds"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          )}
        </div>
      </div>

      {feeds.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <Rss className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>No feeds subscribed yet.</p>
          <p className="text-sm mt-1">Paste an RSS or Atom feed URL above to get started.</p>
        </div>
      ) : (
        <div className="flex gap-4 flex-1 min-h-0">
          {/* Feed sidebar */}
          <div className="w-56 shrink-0 space-y-1 overflow-y-auto hidden md:block">
            {feeds.map(feed => (
              <div key={feed.id} className="group relative">
                <button
                  onClick={() => setSelectedFeedId(selectedFeedId === feed.id ? null : feed.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${
                    selectedFeedId === feed.id
                      ? 'bg-port-accent/20 text-port-accent'
                      : 'text-gray-400 hover:text-white hover:bg-port-card'
                  }`}
                  title={feed.title}
                >
                  <Rss size={12} className="shrink-0" />
                  <span className="truncate flex-1">{feed.title}</span>
                  {feed.unreadCount > 0 && (
                    <span className="text-xs px-1.5 py-0.5 bg-port-accent/30 text-port-accent rounded-full shrink-0">
                      {feed.unreadCount}
                    </span>
                  )}
                </button>
                {/* Feed actions on hover */}
                <div className="absolute right-0 top-0 h-full flex items-center gap-0.5 pr-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRefreshFeed(feed.id); }}
                    className="p-1 text-gray-500 hover:text-white rounded"
                    title="Refresh feed"
                  >
                    <RefreshCw size={10} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmingDeleteId(feed.id); }}
                    className="p-1 text-gray-500 hover:text-port-error rounded"
                    title="Remove feed"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>

                {/* Delete confirmation */}
                {confirmingDeleteId === feed.id && (
                  <div className="absolute left-0 top-full z-10 mt-1 p-2 bg-port-card border border-port-error/30 rounded-lg shadow-lg min-w-[200px]">
                    <p className="text-xs text-white mb-2">Remove this feed?</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleRemoveFeed(feed.id)}
                        className="px-2 py-1 text-xs bg-port-error text-white rounded hover:bg-port-error/80"
                      >
                        Remove
                      </button>
                      <button
                        onClick={() => setConfirmingDeleteId(null)}
                        className="px-2 py-1 text-xs text-gray-400 hover:text-white"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Mobile feed selector */}
          <div className="md:hidden mb-3 w-full">
            <select
              value={selectedFeedId || ''}
              onChange={(e) => setSelectedFeedId(e.target.value || null)}
              className="w-full px-3 py-2 bg-port-card border border-port-border rounded-lg text-white text-sm"
            >
              <option value="">All feeds</option>
              {feeds.map(f => (
                <option key={f.id} value={f.id}>
                  {f.title} {f.unreadCount > 0 ? `(${f.unreadCount})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Items list */}
          <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
            {items.length === 0 ? (
              <div className="text-center py-8 text-gray-500 text-sm">
                {unreadOnly ? 'No unread items' : 'No items yet — try refreshing your feeds'}
              </div>
            ) : (
              items.map(item => {
                const feedName = feeds.find(f => f.id === item.feedId)?.title;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleItemClick(item)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors group ${
                      item.read
                        ? 'bg-port-card/50 border-port-border/50'
                        : 'bg-port-card border-port-border hover:border-port-accent/50'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {/* Unread dot */}
                      <div className="mt-1.5 shrink-0">
                        {!item.read ? (
                          <div className="w-2 h-2 rounded-full bg-port-accent" />
                        ) : (
                          <div className="w-2 h-2" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <h4 className={`text-sm font-medium truncate ${item.read ? 'text-gray-500' : 'text-white'}`}>
                          {item.title || 'Untitled'}
                        </h4>
                        {item.description && (
                          <p className="text-xs text-gray-500 mt-1 line-clamp-2 leading-relaxed">
                            {item.description}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-600">
                          {!selectedFeedId && feedName && (
                            <>
                              <span className="truncate max-w-[120px]">{feedName}</span>
                              <span>·</span>
                            </>
                          )}
                          {item.author && (
                            <>
                              <span className="truncate max-w-[100px]">{item.author}</span>
                              <span>·</span>
                            </>
                          )}
                          <span>{item.pubDate ? timeAgo(item.pubDate) : timeAgo(item.fetchedAt)}</span>
                        </div>
                      </div>

                      <ExternalLink size={14} className="mt-1 shrink-0 text-gray-600 group-hover:text-port-accent transition-colors" />
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
