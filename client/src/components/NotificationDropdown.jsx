import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, X, CheckCheck, Trash2, Brain, ListTodo, AlertTriangle, Code } from 'lucide-react';

const NOTIFICATION_TYPE_CONFIG = {
  memory_approval: {
    icon: Brain,
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/20'
  },
  task_approval: {
    icon: ListTodo,
    color: 'text-yellow-400',
    bgColor: 'bg-yellow-500/20'
  },
  code_review: {
    icon: Code,
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/20'
  },
  health_issue: {
    icon: AlertTriangle,
    color: 'text-red-400',
    bgColor: 'bg-red-500/20'
  }
};

const PRIORITY_COLORS = {
  low: 'border-gray-500/30',
  medium: 'border-yellow-500/30',
  high: 'border-orange-500/50',
  critical: 'border-red-500/50'
};

function formatTimeAgo(timestamp) {
  const now = new Date();
  const date = new Date(timestamp);
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function NotificationDropdown({
  notifications,
  unreadCount,
  onMarkAsRead,
  onMarkAllAsRead,
  onRemove,
  onClearAll,
  position = 'bottom' // 'bottom' opens upward, 'top' opens downward
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);
  const navigate = useNavigate();

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleNotificationClick = (notification) => {
    if (!notification.read) {
      onMarkAsRead(notification.id);
    }
    if (notification.link) {
      navigate(notification.link);
      setIsOpen(false);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell button with badge */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 rounded-lg hover:bg-port-card transition-colors focus:outline-none focus:ring-2 focus:ring-port-accent focus:ring-offset-2 focus:ring-offset-port-bg"
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        <Bell className={`w-5 h-5 ${unreadCount > 0 ? 'text-yellow-400' : 'text-gray-400'}`} aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold rounded-full bg-yellow-500 text-black px-1" aria-hidden="true">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel - position determines direction */}
      {isOpen && (
        <div
          role="menu"
          aria-label="Notifications menu"
          className={`absolute w-80 bg-port-card border border-port-border rounded-lg shadow-xl z-50 overflow-hidden ${
            position === 'bottom'
              ? 'left-0 bottom-full mb-2'  // Opens upward from sidebar footer
              : 'right-0 top-full mt-2'     // Opens downward from header
          }`}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-port-border">
            <span className="font-medium text-white">Notifications</span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={onMarkAllAsRead}
                  className="p-1.5 rounded hover:bg-port-border transition-colors focus:outline-none focus:ring-2 focus:ring-port-accent"
                  title="Mark all as read"
                  aria-label="Mark all notifications as read"
                >
                  <CheckCheck className="w-4 h-4 text-gray-400" aria-hidden="true" />
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  onClick={onClearAll}
                  className="p-1.5 rounded hover:bg-port-border transition-colors focus:outline-none focus:ring-2 focus:ring-port-accent"
                  title="Clear all"
                  aria-label="Clear all notifications"
                >
                  <Trash2 className="w-4 h-4 text-gray-400" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {/* Notification list */}
          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500">
                No notifications
              </div>
            ) : (
              notifications.slice(0, 10).map(notification => {
                const config = NOTIFICATION_TYPE_CONFIG[notification.type] || NOTIFICATION_TYPE_CONFIG.task_approval;
                const Icon = config.icon;

                return (
                  <div
                    key={notification.id}
                    role="menuitem"
                    tabIndex={0}
                    className={`
                      px-4 py-3 border-b border-port-border last:border-b-0 cursor-pointer
                      hover:bg-port-border/50 transition-colors focus:outline-none focus:bg-port-border/50
                      ${!notification.read ? 'bg-port-border/30' : ''}
                      border-l-2 ${PRIORITY_COLORS[notification.priority] || PRIORITY_COLORS.medium}
                    `}
                    onClick={() => handleNotificationClick(notification)}
                    onKeyDown={(e) => e.key === 'Enter' && handleNotificationClick(notification)}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`p-1.5 rounded ${config.bgColor}`} aria-hidden="true">
                        <Icon className={`w-4 h-4 ${config.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className={`text-sm font-medium ${!notification.read ? 'text-white' : 'text-gray-300'}`}>
                            {notification.title}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onRemove(notification.id);
                            }}
                            className="p-1 rounded hover:bg-port-border transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-port-accent"
                            aria-label={`Remove notification: ${notification.title}`}
                          >
                            <X className="w-3 h-3 text-gray-500" aria-hidden="true" />
                          </button>
                        </div>
                        {notification.description && (
                          <p className="text-xs text-gray-500 mt-0.5 truncate">
                            {notification.description}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] text-gray-600">
                            {formatTimeAgo(notification.timestamp)}
                          </span>
                          {!notification.read && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onMarkAsRead(notification.id);
                              }}
                              className="text-[10px] text-port-accent hover:underline"
                            >
                              Mark read
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer */}
          {notifications.length > 10 && (
            <div className="px-4 py-2 border-t border-port-border text-center">
              <span className="text-xs text-gray-500">
                +{notifications.length - 10} more notifications
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
