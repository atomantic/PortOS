import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';

// What a usage row says: "Music video · Example Song · Shot 4".
export const usageText = (u) => [u.label, u.title, u.role].filter(Boolean).join(' · ');

/**
 * The records using one media file, each a link to where it is used (the shot,
 * panel or record tab). `onNavigate` lets a viewer close itself on the way.
 */
export default function MediaUsageList({ usages, onNavigate, className = '' }) {
  if (!Array.isArray(usages) || usages.length === 0) return null;
  return (
    <ul className={`space-y-1 ${className}`}>
      {usages.map((u) => {
        const text = usageText(u);
        const key = `${u.source}:${u.id}:${u.role || ''}`;
        return (
          <li key={key}>
            {u.href ? (
              <Link to={u.href} onClick={onNavigate}
                className="min-h-[44px] flex items-center justify-between gap-1 rounded px-2 bg-port-bg/60 hover:bg-port-border/60 text-gray-200">
                <span className="min-w-0 break-words">{text}</span>
                <ChevronRight className="w-3.5 h-3.5 shrink-0 text-gray-500" aria-hidden="true" />
              </Link>
            ) : (
              <span className="min-h-[44px] flex items-center rounded px-2 bg-port-bg/60 text-gray-300 break-words">{text}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
