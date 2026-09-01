import { Link } from 'react-router';
import { History, Lightbulb, BookOpen, NotebookPen } from 'lucide-react';

// "On this day" memory lane — journal entries, memories, and ideas written on
// this calendar date in previous years. Reads the shared `brainOnThisDay`
// slice of dashboardState (populated from GET /api/brain/on-this-day — the
// server owns the timezone-correct date key, so this never re-derives it).
// The registry gate (`total > 0`) keeps this off the grid on days with no
// lookbacks, so a mounted widget always has rows — no empty state needed.
const ROW_META = {
  journal: { icon: NotebookPen, label: 'Daily Log', link: (item) => `/brain/daily-log?date=${item.date}` },
  memory: { icon: BookOpen, label: 'Memory', link: () => '/brain/memory' },
  idea: { icon: Lightbulb, label: 'Idea', link: () => '/brain/ideas' },
};

const yearsAgoLabel = (yearsAgo) => (yearsAgo === 1 ? '1 year ago' : `${yearsAgo} years ago`);

export default function OnThisDayWidget({ dashboardState }) {
  const data = dashboardState?.brainOnThisDay;
  if (!data) return null;

  const items = Array.isArray(data.items) ? data.items : [];

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 h-full">
      <div className="flex items-center gap-2 mb-3">
        <History size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-white">On This Day</h3>
      </div>

      <ul className="space-y-2">
        {items.map((item) => {
          const meta = ROW_META[item.type] || ROW_META.memory;
          const Icon = meta.icon;
          return (
            <li key={`${item.type}:${item.id}`}>
              <Link to={meta.link(item)} className="group flex items-start gap-2 text-xs">
                <Icon size={14} className="shrink-0 mt-0.5 text-gray-500" />
                <span className="min-w-0">
                  <span className="block text-gray-500">
                    {yearsAgoLabel(item.yearsAgo)} · {meta.label}
                  </span>
                  <span className="block truncate text-gray-300 group-hover:text-white" title={item.title || item.snippet}>
                    {item.title || item.snippet}
                  </span>
                  {item.title && item.snippet && (
                    <span className="block truncate text-gray-500">{item.snippet}</span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {data.total > items.length && (
        <div className="text-xs text-gray-500 mt-2">+{data.total - items.length} more</div>
      )}
    </div>
  );
}
