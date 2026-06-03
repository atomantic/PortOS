import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';

/**
 * Workflow-teaching empty state.
 *
 * A "no data" state should not just say "Nothing here" — it should name the
 * next action that unlocks the feature, e.g. "Configure one API provider to
 * enable autonomous CoS" or "Connect calendar to unlock schedule-aware goals".
 *
 * Props:
 *   icon        — Lucide component for the centered glyph (default: Info)
 *   title       — optional bold heading (the "what's missing")
 *   message     — the teaching hint that names the next action
 *   actionTo    — internal route for the call-to-action Link
 *   actionLabel — text for the call-to-action
 *   onAction    — render a <button> instead of a Link (in-page action)
 */
export default function EmptyState({
  icon: Icon = Info,
  title,
  message,
  actionTo,
  actionLabel,
  onAction,
}) {
  const actionClass =
    'mt-4 px-4 py-2 rounded-lg text-sm font-medium bg-port-accent/10 text-port-accent hover:bg-port-accent/20 transition-colors';

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {Icon && <Icon size={32} className="text-gray-600 mb-3" />}
      {title && <h3 className="text-white font-semibold mb-1">{title}</h3>}
      {message && <p className="text-gray-400 text-sm max-w-xs">{message}</p>}
      {actionLabel && (onAction ? (
        <button type="button" onClick={onAction} className={actionClass}>
          {actionLabel}
        </button>
      ) : actionTo ? (
        <Link to={actionTo} className={actionClass}>
          {actionLabel}
        </Link>
      ) : null)}
    </div>
  );
}
