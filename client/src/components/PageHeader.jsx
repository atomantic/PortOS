// Shared title bar for tabbed top-level pages (Brain, MeatSpace, Settings,
// Goals, Calendar, Insights, …). Before this existed each page hand-rolled its
// own header with different padding and title scales, so navigating between
// sections produced visual jitter (issue #1182). This standardizes the bar:
// compact `px-3 py-2 sm:px-4 sm:py-3` padding (keeps actionable content above
// the fold), a `text-lg sm:text-xl font-bold` title, and the shared
// `border-b border-port-border`.
//
// Slots:
//   icon       — a lucide-react component (passed as the component, not an element)
//   iconColor  — Tailwind color class for the icon (default `text-port-accent`;
//                MeatSpace passes `text-port-error`)
//   title      — string, the page name
//   subtitle   — optional descriptive tagline (hidden below `sm` to save space)
//   actions    — optional ReactNode rendered right-aligned on the title row
//                (counts, badges, buttons, or a compact tab control)
//   className  — merged onto the outer bar (e.g. Goals' `bg-port-card`,
//                MeatSpace's `print:hidden`)
//
// PageHeader owns ONLY the title bar. Pages with a full tab strip render the
// shared `TabPills` immediately below it (see Brain/Calendar/MeatSpace/Insights)
// rather than nesting tabs inside the header, so every page keeps one
// consistent border + padding regardless of how it lays out its tabs.
export default function PageHeader({
  icon: Icon,
  iconColor = 'text-port-accent',
  title,
  subtitle,
  actions,
  className = '',
}) {
  return (
    <div className={`shrink-0 px-3 py-2 sm:px-4 sm:py-3 border-b border-port-border ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          {Icon && <Icon className={`w-6 h-6 sm:w-7 sm:h-7 shrink-0 ${iconColor}`} aria-hidden="true" />}
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-white leading-tight">{title}</h1>
            {subtitle && (
              <p className="hidden sm:block text-sm text-gray-500 leading-tight">{subtitle}</p>
            )}
          </div>
        </div>

        {actions && (
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap justify-end">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
