// Real roadmap chart. `points` are the analyzed issues only, each carrying a
// `frac` (0..1) x-position within the full ordered issue list so spacing
// reflects arc position; unanalyzed gaps are skipped (the line bridges them).
export default function ArcRoadmapChart({ points }) {
  const width = 320;
  const height = 132;
  const toPolyline = (key) => points.map((point) => {
    const x = point.frac * width;
    const y = height - ((point[key] / 100) * height);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <div className="h-full grid grid-rows-[1fr_auto] gap-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible" role="img" aria-label="Editorial roadmap chart">
        {[0.25, 0.5, 0.75].map((n) => (
          <line key={n} x1="0" x2={width} y1={height * n} y2={height * n} stroke="rgba(148,163,184,0.16)" strokeWidth="1" />
        ))}
        <polyline points={toPolyline('plot')} fill="none" stroke="rgb(96,165,250)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={toPolyline('character')} fill="none" stroke="rgb(110,231,183)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={toPolyline('reader')} fill="none" stroke="rgb(251,191,36)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="6 5" opacity="0.85" />
        {points.map((point, idx) => (
          <circle key={`${point.label}-${idx}`} cx={point.frac * width} cy={height - ((point.plot / 100) * height)} r={point.stale ? 3 : 2.5} fill={point.stale ? 'rgb(245,158,11)' : 'rgb(96,165,250)'} stroke={point.stale ? 'rgb(245,158,11)' : 'none'}>
            <title>{point.label}: {point.title}{point.primaryEmotion ? ` — reader feels ${point.primaryEmotion}` : ''}{point.stale ? ' (stale — content changed since analysis)' : ''}</title>
          </circle>
        ))}
      </svg>
      <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-gray-500">
        <span className="inline-flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-400 rounded" /> Plot</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-0.5 bg-emerald-300 rounded" /> Character</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-0.5 border-t border-dashed border-amber-300" /> Reader</span>
      </div>
    </div>
  );
}
