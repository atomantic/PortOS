/**
 * Kurt Vonnegut's eight story shapes — the rendering side.
 *
 * Server validates `series.arc.shape` against `ARC_SHAPE_IDS` in
 * `server/lib/storyArc.js`. This file owns the display metadata: label,
 * one-line description, and a 7-point series in [-1, 1] (where +1 is
 * "good fortune" and -1 is "ill fortune") that drives the SVG sparkline.
 *
 * To add a shape: add an entry here AND to `ARC_SHAPE_IDS` on the server.
 */

export const STORY_SHAPES = [
  {
    id: 'rags-to-riches',
    label: 'Rags to Riches',
    description: 'Steady rise from misfortune to triumph.',
    points: [-1, -0.7, -0.4, -0.1, 0.3, 0.7, 1],
  },
  {
    id: 'tragedy',
    label: 'Tragedy',
    description: 'Steady fall from good fortune to ruin.',
    points: [1, 0.7, 0.4, 0.1, -0.3, -0.7, -1],
  },
  {
    id: 'man-in-hole',
    label: 'Man in Hole',
    description: 'Falls into trouble, climbs out better than before.',
    points: [0.4, 0, -0.6, -1, -0.5, 0.3, 0.9],
  },
  {
    id: 'icarus',
    label: 'Icarus',
    description: 'Soars high, then crashes.',
    points: [-0.4, 0.2, 0.7, 1, 0.5, -0.2, -1],
  },
  {
    id: 'cinderella',
    label: 'Cinderella',
    description: 'Rises, suffers a setback, soars to the highest peak.',
    points: [-0.7, -0.3, 0.2, 0.5, -0.3, 0.4, 1],
  },
  {
    id: 'oedipus',
    label: 'Oedipus',
    description: 'Falls, briefly recovers, falls again to the worst.',
    points: [0.3, -0.2, -0.7, 0.2, 0.5, 0, -1],
  },
  {
    id: 'boy-meets-girl',
    label: 'Boy Meets Girl',
    description: 'Gets the thing, loses it, gets it back for good.',
    points: [0, 0.6, 0.9, 0.2, -0.5, 0.3, 0.9],
  },
  {
    id: 'creation-story',
    label: 'Creation Story',
    description: 'Stepped ascent — each plateau a new world.',
    points: [-1, -1, -0.4, -0.4, 0.3, 0.3, 1],
  },
];

const SHAPES_BY_ID = new Map(STORY_SHAPES.map((s) => [s.id, s]));

export function getStoryShape(id) {
  return SHAPES_BY_ID.get(id) || null;
}

/**
 * Render a single story-shape curve as an inline SVG sparkline.
 * `points` is a [-1, 1] series; the renderer maps it into the viewBox and
 * draws the good-fortune midline behind the curve.
 */
export function ArcShapeSparkline({ shape, width = 64, height = 24, className = '', stroke = 'currentColor' }) {
  const def = typeof shape === 'string' ? getStoryShape(shape) : shape;
  if (!def) return null;
  const { points } = def;
  const n = points.length;
  const padX = 2;
  const padY = 3;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  // Map v in [-1, 1] to y in [height - padY, padY] (invert for SVG).
  const toX = (i) => padX + (i / (n - 1)) * innerW;
  const toY = (v) => padY + ((1 - v) / 2) * innerH;
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(2)} ${toY(v).toFixed(2)}`).join(' ');
  const midY = padY + innerH / 2;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label={`${def.label} story shape`}
    >
      <line x1={padX} x2={width - padX} y1={midY} y2={midY} stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Grid of selectable shape chips. Each chip shows the mini sparkline + label
 * and toggles selection on click. `value === null` means no shape chosen.
 */
export function ArcShapePicker({ value, onChange, disabled = false }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase tracking-wider text-gray-500">Story shape (Vonnegut)</label>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        {STORY_SHAPES.map((s) => {
          const selected = value === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onChange(selected ? null : s.id)}
              disabled={disabled}
              title={s.description}
              className={`flex flex-col items-start gap-1 px-2 py-1.5 rounded border text-left transition-colors disabled:opacity-40 ${
                selected
                  ? 'border-port-accent bg-port-accent/10 text-port-accent'
                  : 'border-port-border bg-port-bg text-gray-300 hover:border-port-accent/40 hover:text-white'
              }`}
            >
              <ArcShapeSparkline shape={s} width={72} height={22} />
              <span className="text-[10px] uppercase tracking-wider truncate w-full">{s.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
