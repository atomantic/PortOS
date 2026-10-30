// One stick figure in "figure units": 100 tall, centered on x=0, head top at y=0,
// waist at y=55, feet at y=100. Each framing places it with a scale and offset so
// every diagram draws the same person at a different distance.
function Figure({ x, top, scale, back = false }) {
  return (
    <g transform={`translate(${x} ${top}) scale(${scale})`}
      className={back ? 'fill-gray-600 stroke-gray-400' : 'fill-port-card stroke-current'}
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path vectorEffect="non-scaling-stroke" d="M-14 25Q-14 21-10 21L10 21Q14 21 14 25L11 55L-11 55Z" />
      <path vectorEffect="non-scaling-stroke" fill="none" d="M-14 25L-17 52M14 25L17 52M-8 55L-9 100M8 55L9 100" />
      <circle vectorEffect="non-scaling-stroke" cx="0" cy="9" r="9" />
      {back ? null : (
        <g className="fill-current" stroke="none">
          <circle cx="-3.2" cy="8" r="1.1" />
          <circle cx="3.2" cy="8" r="1.1" />
        </g>
      )}
    </g>
  );
}

const Horizon = ({ y }) => (
  <path className="stroke-gray-500" strokeWidth="1" fill="none" d={`M0 ${y}H160`} />
);

const SCENES = {
  'extreme-wide': () => (
    <>
      <path className="stroke-gray-500" strokeWidth="1" fill="none" strokeLinejoin="round" d="M0 58L28 34L50 50L78 26L104 48L126 36L160 56" />
      <Horizon y={66} />
      <Figure x={98} top={58} scale={0.12} />
    </>
  ),
  wide: () => (
    <>
      <Horizon y={80} />
      <path className="stroke-gray-500" strokeWidth="1" fill="none" d="M8 80V30H48V80M24 80V58H34V80M112 80V38H154V80M122 50H132V60H122ZM138 50H148V60H138Z" />
      <Figure x={80} top={47} scale={0.33} />
    </>
  ),
  full: () => (
    <>
      <Horizon y={86} />
      <Figure x={80} top={6} scale={0.8} />
    </>
  ),
  'medium-wide': () => <Figure x={80} top={8} scale={1.05} />,
  medium: () => <Figure x={80} top={10} scale={1.45} />,
  'medium-close': () => <Figure x={80} top={10} scale={2} />,
  close: () => <Figure x={80} top={10} scale={2.65} />,
  'extreme-close': () => (
    <g className="fill-port-card stroke-current" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path fill="none" d="M34 26Q80 4 126 24" />
      <path d="M22 54Q80 4 138 54Q80 92 22 54Z" />
      <circle cx="80" cy="52" r="20" fill="none" />
      <circle cx="80" cy="52" r="8" className="fill-current" stroke="none" />
    </g>
  ),
  insert: () => (
    <g className="fill-port-card stroke-current" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path className="stroke-gray-500" fill="none" strokeWidth="1" d="M0 78H160" />
      <path d="M58 30H102V72Q102 80 94 80H66Q58 80 58 72Z" />
      <path fill="none" d="M102 40Q120 40 120 52Q120 64 102 64" />
      <path className="stroke-gray-500" fill="none" d="M70 22Q66 16 70 10M80 22Q76 16 80 10M90 22Q86 16 90 10" />
    </g>
  ),
  'over-the-shoulder': () => (
    <>
      <Figure x={112} top={16} scale={2} />
      <Figure x={28} top={20} scale={2.8} back />
    </>
  ),
  'two-shot': () => (
    <>
      <Figure x={52} top={14} scale={1.35} />
      <Figure x={108} top={16} scale={1.32} />
    </>
  ),
  pov: () => (
    <>
      <Horizon y={62} />
      <Figure x={80} top={34} scale={0.3} />
      <g className="fill-port-card stroke-current" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 92L44 66Q50 61 55 66L58 70Q60 74 55 77L28 96Z" />
        <path d="M146 92L116 66Q110 61 105 66L102 70Q100 74 105 77L132 96Z" />
      </g>
    </>
  ),
};

/**
 * Code-drawn concept sketch of a storyboard framing (a `SHOT_TYPES` value): what
 * the camera sees at that distance. Unknown or empty framing draws an empty frame.
 */
export default function FramingDiagram({ framing, className = '' }) {
  const Scene = SCENES[framing];
  // The svg viewport clips the oversized close-up figures.
  return (
    <svg viewBox="0 0 160 90" className={className} aria-hidden="true" focusable="false">
      <rect width="160" height="90" rx="4" className="fill-port-bg" />
      {Scene ? <Scene /> : null}
      <rect x="1" y="1" width="158" height="88" rx="3.5" fill="none" strokeWidth="2"
        className={Scene ? 'stroke-gray-500' : 'stroke-gray-600'} strokeDasharray={Scene ? undefined : '6 5'} />
    </svg>
  );
}
