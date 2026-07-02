import { Link } from 'react-router-dom';
import { Users, ArrowRight } from 'lucide-react';

// Surfaces who in the Tribe is overdue for contact on the dashboard. Reads the
// server-computed care summary from dashboardState (no duplicate fetch — the
// overdue/cadence logic is a single server-side source of truth in
// server/services/tribe.js). Gated in the registry to hide when the Tribe has
// no people; renders a positive "all caught up" state when nobody is overdue.
export default function TribeCareWidget({ dashboardState }) {
  const care = dashboardState?.tribeCare;
  if (!care?.hasPeople) return null;

  const overdue = care.overdue || [];
  const remaining = care.overdueCount - overdue.length;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3">
        <Users size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-white">Tribe Care</h3>
        <Link to="/tribe" className="ml-auto flex items-center gap-1 text-xs text-port-accent hover:underline">
          Open <ArrowRight size={12} />
        </Link>
      </div>

      {care.overdueCount === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-2 text-center">
          <div className="text-2xl" aria-hidden="true">🤝</div>
          <div className="mt-1 text-sm text-port-success">All caught up</div>
          <div className="text-xs text-gray-500">No overdue check-ins across {care.peopleCount} {care.peopleCount === 1 ? 'person' : 'people'}</div>
        </div>
      ) : (
        <>
          <div className="mb-2 text-sm text-gray-300">
            <span className="font-semibold text-port-warning">{care.overdueCount}</span>{' '}
            {care.overdueCount === 1 ? 'person needs' : 'people need'} care
          </div>
          <ul className="flex flex-col gap-1">
            {overdue.map((person) => (
              <li key={person.id}>
                <Link
                  to="/tribe"
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-port-bg transition-colors"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-white">{person.name}</span>
                  <span className={`shrink-0 text-xs ${person.state === 'missing' ? 'text-gray-400' : 'text-port-error'}`}>
                    {person.state === 'missing' ? 'no touchpoint' : `${person.daysOverdue}d overdue`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {remaining > 0 && (
            <Link to="/tribe" className="mt-2 text-xs text-gray-500 hover:text-gray-300">
              +{remaining} more overdue
            </Link>
          )}
        </>
      )}
    </div>
  );
}
