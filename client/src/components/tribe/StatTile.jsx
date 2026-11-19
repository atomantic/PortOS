// A tile that names the user's task (`Needs Care`) is the fastest route into it,
// so tiles with an `onClick` render as real buttons that filter the list; the
// rest stay inert text (#3791).
export default function StatTile({ icon: Icon, label, value, detail, onClick, active = false, className = '' }) {
  const body = (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
        <p className="mt-1 text-xl font-semibold text-white sm:text-2xl">{value}</p>
        {detail && <p className="mt-1 text-xs text-gray-500 truncate">{detail}</p>}
      </div>
      <Icon size={20} className="shrink-0 text-port-accent" aria-hidden="true" />
    </div>
  );
  const base = `rounded p-3 min-w-0 text-left sm:p-4 bg-port-card border ${className}`;

  if (!onClick) {
    return <div className={`${base} border-port-border`}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${base} w-full transition-colors ${active ? 'border-port-accent/70 ring-1 ring-port-accent/30' : 'border-port-border hover:border-port-accent/50'}`}
    >
      {body}
    </button>
  );
}
