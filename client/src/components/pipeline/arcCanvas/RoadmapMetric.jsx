export default function RoadmapMetric({ label, value, sub, tone, title }) {
  return (
    <div className="rounded border border-port-border bg-port-bg/60 px-2 py-2 min-w-0" title={title}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`mt-1 text-xs font-medium truncate ${tone}`}>{value}</div>
      {sub ? <div className="text-[10px] text-gray-600 truncate">{sub}</div> : null}
    </div>
  );
}
