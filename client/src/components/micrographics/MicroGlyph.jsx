import { useId, memo } from 'react';
import './micrographics.css';

const polarDots = (count, radius) =>
  Array.from({ length: count }, (_, i) => {
    const angle = (Math.PI * 2 * i) / count - Math.PI / 2;
    return { x: 32 + Math.cos(angle) * radius, y: 32 + Math.sin(angle) * radius };
  });

const DOTS_8 = polarDots(8, 22);
const DOTS_12 = polarDots(12, 23);
const MATRIX_DOTS = Array.from({ length: 25 }, (_, i) => ({
  x: 16 + (i % 5) * 8,
  y: 16 + Math.floor(i / 5) * 8,
  index: i,
}));

const SIGNAL_BARS = [
  { x: 19, baseY: 25, baseH: 14, mod: 1 },
  { x: 26, baseY: 17, baseH: 30, mod: 2 },
  { x: 33, baseY: 11, baseH: 42, mod: 3 },
  { x: 40, baseY: 20, baseH: 24, mod: 4 },
];

function OrbitGlyph() {
  return (
    <>
      <circle className="port-microglyph__line port-microglyph__muted" cx="32" cy="32" r="24" />
      <circle className="port-microglyph__line port-microglyph__ghost" cx="32" cy="32" r="14" />
      <g className="port-microglyph__orbit">
        <path className="port-microglyph__line" d="M32 8a24 24 0 0 1 22 14" />
        <circle className="port-microglyph__fill" cx="53" cy="21" r="3" />
      </g>
      <g className="port-microglyph__counter-orbit">
        <path className="port-microglyph__line port-microglyph__muted" d="M12 45a24 24 0 0 1-3-17" />
        <circle className="port-microglyph__fill port-microglyph__dim" cx="10" cy="45" r="2" />
      </g>
      <circle className="port-microglyph__fill port-microglyph__core" cx="32" cy="32" r="3.5" />
    </>
  );
}

function SignalGlyph({ level }) {
  const driven = typeof level === 'number';
  return (
    <>
      <path className="port-microglyph__line port-microglyph__muted" d="M9 32h8m30 0h8" />
      <g>
        {SIGNAL_BARS.map((b, i) => {
          if (driven) {
            const k = Math.max(0, Math.min(1, level)) * (0.5 + (i % 3) * 0.25);
            const h = Math.max(4, b.baseH * (0.4 + k * 0.6));
            const y = 53 - h;
            return (
              <rect
                key={i}
                className="port-microglyph__fill"
                x={b.x}
                y={y}
                width="4"
                height={h}
                rx="2"
                style={{ transition: 'y 0.08s linear, height 0.08s linear' }}
              />
            );
          }
          return (
            <rect
              key={i}
              className={`port-microglyph__fill port-microglyph__bar port-microglyph__bar-${b.mod}`}
              x={b.x}
              y={b.baseY}
              width="4"
              height={b.baseH}
              rx="2"
            />
          );
        })}
      </g>
      <path className="port-microglyph__line port-microglyph__ghost" d="M17 49c10-7 20-7 30 0" />
    </>
  );
}

function NodeGlyph() {
  return (
    <>
      <g className="port-microglyph__nodes">
        {DOTS_8.map((dot, i) => (
          <line
            key={`l${i}`}
            className="port-microglyph__line port-microglyph__ghost"
            x1="32" y1="32" x2={dot.x} y2={dot.y}
          />
        ))}
        {DOTS_8.map((dot, i) => (
          <circle
            key={`d${i}`}
            className={i % 3 === 0 ? 'port-microglyph__fill' : 'port-microglyph__fill port-microglyph__dim'}
            cx={dot.x} cy={dot.y} r={i % 3 === 0 ? 2.5 : 1.8}
          />
        ))}
      </g>
      <circle className="port-microglyph__line" cx="32" cy="32" r="7" />
      <circle className="port-microglyph__fill port-microglyph__core" cx="32" cy="32" r="2.5" />
    </>
  );
}

function MatrixGlyph({ intensity }) {
  return (
    <>
      <rect className="port-microglyph__line port-microglyph__muted" x="12" y="12" width="40" height="40" rx="4" />
      <g>
        {MATRIX_DOTS.map((dot) => {
          const driven = Array.isArray(intensity);
          const opacity = driven
            ? Math.max(0.15, Math.min(1, intensity[dot.index] ?? 0.2))
            : undefined;
          return (
            <circle
              key={`m${dot.index}`}
              className={
                driven
                  ? 'port-microglyph__fill'
                  : `port-microglyph__fill port-microglyph__matrix-dot port-microglyph__matrix-dot-${dot.index % 5}`
              }
              cx={dot.x}
              cy={dot.y}
              r={driven ? 1.6 : (dot.index % 2 === 0 ? 1.8 : 1.25)}
              style={driven ? { opacity } : undefined}
            />
          );
        })}
      </g>
      <path className="port-microglyph__line" d="M18 46h28" />
    </>
  );
}

function ScanGlyph() {
  return (
    <>
      <path className="port-microglyph__line port-microglyph__muted" d="M14 16h36M14 48h36M16 14v12M48 38v12" />
      <path className="port-microglyph__line" d="M20 34h24" />
      <path className="port-microglyph__line port-microglyph__scan-sweep" d="M16 24h32" />
      <circle className="port-microglyph__line port-microglyph__ghost" cx="32" cy="32" r="15" />
      <circle className="port-microglyph__fill port-microglyph__core" cx="32" cy="32" r="2.5" />
    </>
  );
}

function SparkGlyph() {
  return (
    <>
      <g className="port-microglyph__spark">
        <path className="port-microglyph__line" d="M32 8v48M8 32h48M15 15l34 34M49 15 15 49" />
      </g>
      <circle className="port-microglyph__line port-microglyph__ghost" cx="32" cy="32" r="16" />
      <circle className="port-microglyph__fill port-microglyph__core" cx="32" cy="32" r="4" />
    </>
  );
}

function ReticleGlyph() {
  return (
    <>
      <circle className="port-microglyph__line port-microglyph__muted" cx="32" cy="32" r="22" />
      <circle className="port-microglyph__line" cx="32" cy="32" r="10" />
      <path className="port-microglyph__line" d="M32 6v10M32 48v10M6 32h10M48 32h10" />
      <path className="port-microglyph__line port-microglyph__ghost" d="M24 24l16 16M40 24 24 40" />
    </>
  );
}

function ProgressGlyph({ progress = 0.66 }) {
  const normalized = Math.max(0, Math.min(1, progress));
  return (
    <>
      <circle className="port-microglyph__line port-microglyph__muted" cx="32" cy="32" r="24" />
      <circle
        className="port-microglyph__line port-microglyph__progress-ring"
        cx="32" cy="32" r="24"
        style={{ '--port-micro-progress': normalized }}
      />
      <g>
        {DOTS_12.map((dot, i) => (
          <circle
            key={`p${i}`}
            className={i / 12 <= normalized ? 'port-microglyph__fill' : 'port-microglyph__fill port-microglyph__dim'}
            cx={dot.x} cy={dot.y} r="1.5"
          />
        ))}
      </g>
      <path className="port-microglyph__line" d="M23 33l6 6 13-16" />
    </>
  );
}

function PulseDotGlyph() {
  return (
    <>
      <circle className="port-microglyph__line port-microglyph__muted" cx="32" cy="32" r="22" />
      <g className="port-microglyph__pulse">
        <circle className="port-microglyph__fill port-microglyph__core" cx="32" cy="32" r="6" />
      </g>
    </>
  );
}

function WarningTriGlyph() {
  return (
    <g className="port-microglyph__warn-blink">
      <path
        className="port-microglyph__line"
        d="M32 9 L57 51 L7 51 Z"
        strokeLinejoin="miter"
      />
      <path className="port-microglyph__line" d="M32 24v14" />
      <circle className="port-microglyph__fill" cx="32" cy="44" r="2" />
    </g>
  );
}

function CheckTickGlyph() {
  return (
    <>
      <circle className="port-microglyph__line port-microglyph__muted" cx="32" cy="32" r="24" />
      <path className="port-microglyph__line" d="M21 33l8 8 14-18" />
    </>
  );
}

function BracketPairGlyph() {
  return (
    <>
      <path className="port-microglyph__line" d="M14 14h-4v36h4" />
      <path className="port-microglyph__line" d="M50 14h4v36h-4" />
      <circle className="port-microglyph__fill port-microglyph__dim" cx="22" cy="32" r="1.6" />
      <circle className="port-microglyph__fill" cx="32" cy="32" r="2" />
      <circle className="port-microglyph__fill port-microglyph__dim" cx="42" cy="32" r="1.6" />
    </>
  );
}

const GLYPHS = {
  orbit: OrbitGlyph,
  signal: SignalGlyph,
  node: NodeGlyph,
  matrix: MatrixGlyph,
  scan: ScanGlyph,
  spark: SparkGlyph,
  reticle: ReticleGlyph,
  progress: ProgressGlyph,
  'pulse-dot': PulseDotGlyph,
  'warning-tri': WarningTriGlyph,
  'check-tick': CheckTickGlyph,
  'bracket-pair': BracketPairGlyph,
};

const VALID_STATES = new Set(['idle', 'active', 'success', 'warn', 'error', 'accent', 'muted']);

function MicroGlyph({
  variant = 'orbit',
  size = 16,
  animated = false,
  state,
  progress,
  level,
  intensity,
  className = '',
  title,
}) {
  const titleId = useId();
  const Glyph = GLYPHS[variant] ?? OrbitGlyph;
  const stateClass = VALID_STATES.has(state) ? `port-microglyph--${state}` : '';
  const accessibility = title
    ? { role: 'img', 'aria-labelledby': titleId }
    : { 'aria-hidden': 'true' };
  const classes = [
    'port-microglyph',
    `port-microglyph--${variant}`,
    animated ? 'port-microglyph--animated' : '',
    stateClass,
    className,
  ].filter(Boolean).join(' ');

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={classes}
      fill="none"
      focusable="false"
      {...accessibility}
    >
      {title && <title id={titleId}>{title}</title>}
      <Glyph progress={progress} level={level} intensity={intensity} />
    </svg>
  );
}

export default memo(MicroGlyph);

export const GLYPH_VARIANTS = Object.keys(GLYPHS);
