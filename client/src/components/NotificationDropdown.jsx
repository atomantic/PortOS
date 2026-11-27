import { useState, useRef, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { Bell, X, CheckCheck, Trash2, Brain, ListTodo, AlertTriangle, Code, HelpCircle, BellRing, Film, Sparkles, AlarmClock, Share2, GitPullRequest } from 'lucide-react';
import { timeAgo, formatCount } from '../utils/formatters';
import { useActionQueue } from '../hooks/useActionQueue';
import ActionQueuePreview from './ActionQueuePreview';
import { isHttpUrl } from '../utils/urlNormalize';
import { useEscLayer } from './ui/Modal';
import useFocusTrap from '../hooks/useFocusTrap.js';
import useClickOutside from '../hooks/useClickOutside.js';
import usePopoverPosition, { VIEWPORT_PADDING } from '../hooks/usePopoverPosition.js';

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
  },
  plan_question: {
    icon: HelpCircle,
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/20'
  },
  agent_warning: {
    icon: AlertTriangle,
    color: 'text-yellow-400',
    bgColor: 'bg-yellow-500/20'
  },
  daily_post_reminder: {
    icon: BellRing,
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/20'
  },
  creative_commission: {
    icon: Sparkles,
    color: 'text-port-accent',
    bgColor: 'bg-port-accent/20'
  },
  music_video_attention: {
    icon: Film,
    color: 'text-orange-400',
    bgColor: 'bg-orange-500/20'
  },
  action_due: {
    icon: AlarmClock,
    color: 'text-port-accent',
    bgColor: 'bg-port-accent/20'
  },
  share_blocked: {
    icon: Share2,
    color: 'text-orange-400',
    bgColor: 'bg-orange-500/20'
  },
  github_audit: {
    icon: GitPullRequest,
    color: 'text-gray-300',
    bgColor: 'bg-gray-500/20'
  },
  media_delete_failed: {
    icon: Trash2,
    color: 'text-red-400',
    bgColor: 'bg-red-500/20'
  }
};

const COLLAPSED_LIMIT = 10;
const PANEL_WIDTH = 320;

const PRIORITY_COLORS = {
  low: 'border-gray-500/30',
  medium: 'border-yellow-500/30',
  high: 'border-orange-500/50',
  critical: 'border-red-500/50'
};

const PRIORITY_LABELS = {
  high: { text: "High priority", cls: "bg-orange-500/20 text-orange-300" },
  critical: { text: "Critical", cls: "bg-red-500/20 text-red-300" }
};

export default function NotificationDropdown({
  notifications,
  unreadCount,
  onMarkAsRead,
  onMarkAllAsRead,
  onRemove,
  onClearAll,
  position = 'above' // 'above' prefers opening upward, 'below' downward
}) {
  const actionQueue = useActionQueue();
  const requiredCount = actionQueue.data?.items.filter((item) => item.required === true).length;
  const partialCount = actionQueue.data?.partial || Boolean(actionQueue.error);
  const sources = Object.values(actionQueue.data?.sources || {});
  const onlyUnverifiedChecks = !actionQueue.error && actionQueue.data?.partial && sources.some(source => source.incomplete)
    && sources.every(source => !source.error && !source.truncation && source.availability !== 'unavailable' && source.available !== false);
  const actionCountLabel = requiredCount == null
    ? (actionQueue.error ? 'actions unavailable' : 'loading actions')
    : `${partialCount ? 'at least ' : ''}${formatCount(requiredCount)} required action${requiredCount === 1 ? '' : 's'}`;
  const [isOpen, setIsOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const containerRef = useRef(null);
  const closeRef = useRef(null);
  const navigate = useNavigate();
  const titleId = useId();
  const panelId = useId();

  // Cap the portaled panel to the space next to either bell so the history
  // can scroll without moving the header or expansion control.
  const { triggerRef, popoverRef, style: panelStyle } = usePopoverPosition({
    open: isOpen,
    width: PANEL_WIDTH,
    minWidth: 260,
    position,
    constrainHeight: true,
    contentDeps: [showAll, notifications.length]
  });

  // Wait until positioning makes the portal visible before moving focus into it.
  useFocusTrap(isOpen && !!panelStyle, popoverRef);

  // Read/remove/clear and expansion can unmount the focused action. Keep the
  // next Tab inside the panel by moving to its persistent dismiss control.
  useEffect(() => {
    if (isOpen && panelStyle && document.activeElement === document.body) {
      closeRef.current?.focus();
    }
  }, [isOpen, panelStyle, notifications, unreadCount, showAll]);

  // Both refs: the panel lives outside the trigger's subtree once portaled, so a
  // trigger-only containment check would read clicks on the panel as outside.
  useClickOutside([containerRef, popoverRef], isOpen, () => setIsOpen(false));

  // On the shared Esc stack so it dismisses before the mobile nav drawer holding it.
  useEscLayer(isOpen, () => setIsOpen(false));

  // Collapse back to the first page each time the panel is dismissed
  useEffect(() => {
    if (!isOpen) setShowAll(false);
  }, [isOpen]);

  const handleNotificationClick = (notification) => {
    if (!notification.read) {
      onMarkAsRead(notification.id);
    }
    if (notification.link) {
      if (isHttpUrl(notification.link)) {
        window.open(notification.link, '_blank', 'noopener,noreferrer');
      } else {
        navigate(notification.link);
      }
      setIsOpen(false);
    }
  };

  const visible = showAll ? notifications : notifications.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = notifications.length - visible.length;

  return (
    <div className="relative" ref={containerRef}>
      {/* Bell button with badge */}
      <button
        ref={triggerRef}
        onClick={() => {
          // Pointer activation does not focus buttons in every browser.
          triggerRef.current?.focus();
          setIsOpen(!isOpen);
        }}
        className="relative inline-flex items-center justify-center min-w-[44px] min-h-[44px] pointer-fine:lg:min-w-0 pointer-fine:lg:min-h-0 lg:p-1.5 p-1.5 rounded-lg text-gray-500 hover:text-white transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent"
        title="Notifications"
        aria-label={`Notifications (${actionCountLabel})`}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-controls={isOpen ? panelId : undefined}
      >
        <Bell size={18} className={requiredCount > 0 ? 'text-yellow-400' : 'text-gray-500'} aria-hidden="true" />
        {(requiredCount > 0 || (partialCount && !onlyUnverifiedChecks)) && (
          <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] flex items-center justify-center text-[9px] font-bold rounded-full bg-port-warning text-port-on-warning px-0.5" aria-hidden="true">
            {requiredCount == null ? '?' : `${formatCount(requiredCount)}${partialCount ? '+' : ''}`}
          </span>
        )}
      </button>

      {isOpen && createPortal(
        <div
          ref={popoverRef}
          id={panelId}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="fixed flex flex-col bg-port-card border border-port-border rounded-lg shadow-xl z-[100] overflow-hidden"
          style={{
            left: panelStyle?.left ?? `${VIEWPORT_PADDING}px`,
            top: panelStyle?.top ?? `${VIEWPORT_PADDING}px`,
            width: panelStyle?.width ?? `${PANEL_WIDTH}px`,
            maxHeight: panelStyle?.maxHeight,
            visibility: panelStyle ? 'visible' : 'hidden'
          }}
        >
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between px-4 py-3 border-b border-port-border">
            <h2 id={titleId} className="font-medium text-white">Notifications</h2>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={onMarkAllAsRead}
                  className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded hover:bg-port-border transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent pointer-fine:sm:min-w-0 pointer-fine:sm:min-h-0 sm:p-1.5"
                  title="Mark all as read"
                  aria-label="Mark all notifications as read"
                >
                  <CheckCheck className="w-4 h-4 text-gray-400" aria-hidden="true" />
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  type="button"
                  onClick={onClearAll}
                  className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded hover:bg-port-border transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent pointer-fine:sm:min-w-0 pointer-fine:sm:min-h-0 sm:p-1.5"
                  title="Clear all"
                  aria-label="Clear all notifications"
                >
                  <Trash2 className="w-4 h-4 text-gray-400" aria-hidden="true" />
                </button>
              )}
              {/* Keep a dismiss target available even when the notification list is empty. */}
              <button
                type="button"
                ref={closeRef}
                onClick={() => setIsOpen(false)}
                className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded hover:bg-port-border transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent pointer-fine:sm:min-w-0 pointer-fine:sm:min-h-0 sm:p-1.5"
                title="Close"
                aria-label="Close notifications"
              >
                <X className="w-4 h-4 text-gray-400" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Notification list */}
          <div className="min-h-0 max-h-[60dvh] overflow-y-auto sm:max-h-96">
            <ActionQueuePreview compact queue={actionQueue} onSelect={() => setIsOpen(false)} />
            <h2 className="px-4 py-2 text-sm text-port-text-muted">Notification history</h2>
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500">
                No notifications
              </div>
            ) : (
              <ul aria-label="Notifications list">
                {visible.map(notification => {
                  const config = NOTIFICATION_TYPE_CONFIG[notification.type] || NOTIFICATION_TYPE_CONFIG.task_approval;
                  const Icon = config.icon;

                  return (
                    <li
                      key={notification.id}
                      className={`
                      group flex items-start gap-2 px-4 py-3 border-b border-port-border last:border-b-0
                      hover:bg-port-border/50 transition-colors
                      ${!notification.read ? 'bg-port-border/30' : ''}
                      border-l-2 ${PRIORITY_COLORS[notification.priority] || PRIORITY_COLORS.medium}
                    `}
                    >
                      <button
                        type="button"
                        onClick={() => handleNotificationClick(notification)}
                        className="flex min-w-0 flex-1 items-start gap-3 rounded text-left focus:outline-hidden focus:ring-2 focus:ring-port-accent"
                      >
                        <span className={`p-1.5 rounded ${config.bgColor}`} aria-hidden="true">
                          <Icon className={`w-4 h-4 ${config.color}`} />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className={`block text-sm font-medium break-words ${!notification.read ? 'text-white' : 'text-gray-300'}`}>
                            {!notification.read && <span className="sr-only">Unread: </span>}
                            {notification.title}
                            {PRIORITY_LABELS[notification.priority] && (
                              <span className={`ml-2 align-middle rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${PRIORITY_LABELS[notification.priority].cls}`}>
                                {PRIORITY_LABELS[notification.priority].text}
                              </span>
                            )}
                          </span>
                          {notification.description && (
                            <span className="block text-xs text-gray-500 mt-0.5 line-clamp-2">
                              {notification.description}
                            </span>
                          )}
                          <span className="block text-[10px] text-gray-600 mt-1">
                            {timeAgo(notification.timestamp)}
                          </span>
                        </span>
                      </button>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <button
                          type="button"
                          onClick={() => onRemove(notification.id)}
                          className="inline-flex shrink-0 items-center justify-center min-w-[44px] min-h-[44px] -my-2 rounded hover:bg-port-border transition-colors group-focus-within:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-port-accent notification-action"
                          aria-label={`Remove notification: ${notification.title}`}
                        >
                          <X className="w-4 h-4 text-gray-500 sm:w-3 sm:h-3" aria-hidden="true" />
                        </button>
                        {!notification.read && (
                          <button
                            type="button"
                            onClick={() => onMarkAsRead(notification.id)}
                            className="min-h-[44px] text-[10px] text-port-accent hover:underline -my-2 notification-mark-read"
                            aria-label={`Mark notification as read: ${notification.title}`}
                          >
                            Mark read
                          </button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {hiddenCount > 0 && (
            <div className="shrink-0 border-t border-port-border text-center">
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="w-full px-4 py-3 text-xs text-port-accent hover:bg-port-border/50 transition-colors focus:outline-hidden focus:ring-2 focus:ring-port-accent sm:py-2"
              >
                Show {hiddenCount} more notification{hiddenCount === 1 ? '' : 's'}
              </button>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
