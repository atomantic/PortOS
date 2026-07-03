import { Link } from 'react-router-dom';
import { Rss, ArrowRight } from 'lucide-react';

// Glanceable RSS/Atom unread digest. Reads the shared `feeds` slice of
// dashboardState (populated from the existing getFeedStats wrapper — the
// server owns unread computation, so this never re-derives it) and deep-links
// into Brain → Feeds. Gated off until the user has subscribed to a feed.
export default function FeedsWidget({ dashboardState }) {
  const feeds = dashboardState?.feeds;
  if (!feeds) return null;

  const unread = feeds.unreadItems ?? 0;
  const topUnread = Array.isArray(feeds.topUnread) ? feeds.topUnread : [];

  return (
    <Link
      to="/brain/feeds"
      className="bg-port-card border border-port-border rounded-xl p-4 h-full block hover:border-gray-600 transition-colors"
    >
      <div className="flex items-center gap-2 mb-3">
        <Rss size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-white">Feeds</h3>
        <span className="ml-auto flex items-center gap-1 text-xs text-port-accent">
          Open <ArrowRight size={12} />
        </span>
      </div>

      <div className="flex items-center gap-3 mb-3">
        <div className="text-2xl" aria-hidden="true">{unread > 0 ? '📬' : '📭'}</div>
        <div>
          <div className="text-xl font-bold text-white">
            {unread} unread
          </div>
          <div className="text-xs text-gray-500">
            {feeds.totalFeeds ?? 0} feed{(feeds.totalFeeds ?? 0) !== 1 ? 's' : ''} subscribed
          </div>
        </div>
      </div>

      {topUnread.length > 0 ? (
        <ul className="space-y-1">
          {topUnread.map((f) => (
            <li key={f.id} className="flex items-center gap-2 text-xs">
              <span className="flex-1 truncate text-gray-300" title={f.title}>
                {f.title || 'Untitled feed'}
              </span>
              <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-port-accent/20 text-port-accent font-semibold">
                {f.unread}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-xs text-gray-500">All caught up 🎉</div>
      )}
    </Link>
  );
}
