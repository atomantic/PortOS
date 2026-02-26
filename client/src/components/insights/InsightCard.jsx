export default function InsightCard({ title, subtitle, badge, children, sources, className = '' }) {
  return (
    <div className={`bg-port-card border border-port-border rounded-lg p-4 ${className}`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-white truncate">{title}</h3>
          {subtitle && (
            <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
          )}
        </div>
        {badge && <div className="flex-shrink-0">{badge}</div>}
      </div>

      {sources && sources.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2 mb-3">
          {sources.map((src, i) => (
            <span
              key={i}
              className="px-1.5 py-0.5 bg-gray-800 text-gray-400 rounded text-[10px] font-medium"
            >
              {src}
            </span>
          ))}
        </div>
      )}

      {children}
    </div>
  );
}
