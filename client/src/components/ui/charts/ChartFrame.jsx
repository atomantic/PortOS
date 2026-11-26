import { cloneElement, createContext, isValidElement, useContext, useEffect, useId, useRef, useState } from 'react';

const FrameSize = createContext({ width: 640, height: 300 });

export function ResponsiveContainer({ width = '100%', height = '100%', children }) {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 640, height: typeof height === 'number' ? height : 300 });
  useEffect(() => {
    function measure({ width, height }) {
      if (width > 0 && height > 0) setSize(old => old.width === width && old.height === height ? old : { width, height });
    }
    measure(ref.current.getBoundingClientRect());
    if (!globalThis.ResizeObserver) return;
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} style={{ width, height, minWidth: 0 }}><FrameSize.Provider value={size}>{children}</FrameSize.Provider></div>;
}

export function useFrameSize() { return useContext(FrameSize); }

function TooltipCard({ config, point }) {
  const { payload, label } = point;
  const props = { active: true, payload, label };
  if (isValidElement(config.content)) return cloneElement(config.content, props);
  if (typeof config.content === 'function') return config.content(props);
  return <div className="rounded border border-port-border bg-port-card p-2 text-sm text-port-text shadow" style={config.contentStyle}>
    <div style={config.labelStyle}>{config.labelFormatter ? config.labelFormatter(label) : label}</div>
    {payload.map(item => {
      const formatted = config.formatter?.(item.value, item.name, item);
      const [value, name] = Array.isArray(formatted) ? formatted : [formatted ?? item.value, item.name];
      return <div key={item.dataKey} style={{ color: item.color }}>{name}: {value}</div>;
    })}
  </div>;
}

export default function ChartFrame({ title, desc, points, tooltip, legend, series, children }) {
  const id = useId();
  const { width, height } = useFrameSize();
  const [selection, select] = useState(null);
  const point = points[selection];
  const keyboard = (event) => {
    if (!points.length) return;
    if (event.key === 'Escape') return select(null);
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : (selection ?? 0) + (event.key === 'ArrowRight' ? 1 : -1);
    select(Math.max(0, Math.min(points.length - 1, index)));
  };
  const nearest = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) * width / (rect.width || width);
    const y = (event.clientY - rect.top) * height / (rect.height || height);
    let best = Infinity;
    let index = null;
    points.forEach((point, i) => {
      const distance = (point.trackY ? 0 : (point.x - x) ** 2) + (point.trackX ? 0 : (point.y - y) ** 2);
      if (distance < best) { best = distance; index = i; }
    });
    select(index);
  };
  return <div className="relative h-full w-full">
    <svg role="img" aria-labelledby={id} aria-describedby={id + '-desc'} tabIndex={points.length && tooltip ? 0 : undefined}
      width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} onPointerMove={tooltip ? nearest : undefined}
      onPointerLeave={() => select(null)} onFocus={() => select(0)} onBlur={() => select(null)} onKeyDown={keyboard}>
      <title id={id}>{title}</title><desc id={id + '-desc'}>{desc}</desc>
      {children}
      {point && tooltip && !point.trackX && !point.trackY && <circle cx={point.x} cy={point.y} r={5} fill="none" stroke="currentColor" />}
    </svg>
    {legend && <div className="absolute inset-x-0 bottom-0 flex flex-wrap justify-center gap-x-3 text-xs" style={legend.wrapperStyle}>
      {series.map(item => <span key={item.dataKey ?? item.name}><span style={{ color: item.fill ?? item.stroke }}>■</span> {item.name ?? item.dataKey}</span>)}
    </div>}
    {point && tooltip && <div role="status" className="pointer-events-none absolute z-10 max-h-full max-w-full overflow-auto"
      style={{ [point.x > width / 2 ? 'right' : 'left']: 4, [point.y > height / 2 ? 'top' : 'bottom']: legend ? 24 : 4 }}>
      <TooltipCard point={point} config={tooltip} />
    </div>}
  </div>;
}
