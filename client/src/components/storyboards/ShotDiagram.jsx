import { useId } from 'react';

// One stick figure in "figure units": 100 tall, centered on x=0, head top at y=0,
// waist at y=55, feet at y=100. Each framing places it with a scale and offset so
// every framing draws the same person at a different distance.
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

// Side view for the angle diagrams: a small movie camera at (x, y) aimed at a
// point on the standing figure, with its sight line dashed.
function Camera({ x, y, aimX, aimY }) {
  const deg = (Math.atan2(aimY - y, aimX - x) * 180) / Math.PI;
  return (
    <>
      <path className="stroke-gray-500" strokeWidth="1" strokeDasharray="3 3" fill="none" d={`M${x} ${y}L${aimX} ${aimY}`} />
      <g transform={`translate(${x} ${y}) rotate(${deg})`} className="fill-port-accent/30 stroke-port-accent" strokeWidth="1.5" strokeLinejoin="round">
        <rect x="-11" y="-5" width="12" height="10" rx="1.5" />
        <path d="M1 -3L8 -6V6L1 3Z" />
      </g>
    </>
  );
}

const StandingSubject = () => (
  <>
    <Horizon y={84} />
    <Figure x={112} top={24} scale={0.6} />
  </>
);

// Top view for the facing diagrams: shoulders, head and nose, turned `deg`
// away from the camera at the bottom of the frame.
const TopDownSubject = ({ deg }) => (
  <>
    <Camera x={80} y={80} aimX={80} aimY={52} />
    <g transform={`translate(80 36) rotate(${deg}) scale(1.4)`} className="fill-port-card stroke-current" strokeWidth="1.5" strokeLinejoin="round">
      <ellipse rx="24" ry="8" />
      <circle r="9" />
      <path d="M-3.5 8L0 14L3.5 8" />
    </g>
  </>
);

// Frame view for the composition diagrams: rule-of-thirds guides and a
// waist-up figure placed at `x` (and `top`, for low in frame).
const Placed = ({ x, top = 12 }) => (
  <>
    <path className="stroke-gray-600" strokeWidth="0.75" strokeDasharray="2 3" fill="none" d="M53.3 0V90M106.7 0V90M0 30H160M0 60H160" />
    <Figure x={x} top={top} scale={1.4} />
  </>
);

// An accent arrow along `d`, its head at (x, y) pointing `deg` degrees (0 = right).
const Arrow = ({ d, x, y, deg }) => (
  <g className="stroke-port-accent" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
    <path d={d} />
    <path transform={`translate(${x} ${y}) rotate(${deg})`} d="M-5 -4L0 0L-5 4" />
  </g>
);

// Top view for the lens diagrams: the camera's field of view as a wedge
// `half` degrees either side of straight up.
const FieldOfView = ({ half }) => {
  const rad = (half * Math.PI) / 180;
  const dx = Math.tan(rad) * 70;
  return (
    <>
      <path className="fill-port-accent/10 stroke-port-accent" strokeWidth="1" strokeLinejoin="round" d={`M80 78L${80 - dx} 8L${80 + dx} 8Z`} />
      <Camera x={80} y={84} aimX={80} aimY={60} />
      <circle cx="80" cy="34" r="5" className="fill-port-card stroke-current" strokeWidth="1.5" />
    </>
  );
};

// Close face for the eyeline diagrams, its pupils shifted by (dx, dy).
const Eyes = ({ dx = 0, dy = 0 }) => (
  <g className="fill-port-card stroke-current" strokeWidth="1.5" strokeLinecap="round">
    <circle cx="80" cy="50" r="36" />
    <ellipse cx="66" cy="44" rx="8" ry="5.5" />
    <ellipse cx="94" cy="44" rx="8" ry="5.5" />
    <circle cx={66 + dx} cy={44 + dy} r="3" className="fill-current" stroke="none" />
    <circle cx={94 + dx} cy={44 + dy} r="3" className="fill-current" stroke="none" />
    <path fill="none" d="M70 68Q80 72 90 68" />
  </g>
);

// Background for the focus diagrams: a tree line behind the subject, blurred by `filter`.
const Backdrop = ({ filter }) => (
  <g filter={filter} className="fill-gray-600 stroke-gray-500" strokeWidth="1">
    <path d="M12 74L26 30L40 74ZM118 74L134 22L150 74Z" />
    <Figure x={100} top={46} scale={0.28} />
  </g>
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
  group: () => (
    <>
      <Figure x={24} top={22} scale={0.95} />
      <Figure x={62} top={18} scale={0.95} />
      <Figure x={100} top={20} scale={0.95} />
      <Figure x={138} top={16} scale={0.95} />
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

  // Angles: where the camera sits relative to the subject.
  'eye-level': () => (<><StandingSubject /><Camera x={32} y={29} aimX={112} aimY={29} /></>),
  high: () => (<><StandingSubject /><Camera x={36} y={10} aimX={112} aimY={40} /></>),
  low: () => (<><StandingSubject /><Camera x={36} y={74} aimX={112} aimY={40} /></>),
  'birds-eye': () => (<><StandingSubject /><Camera x={112} y={11} aimX={112} aimY={40} /></>),
  'worms-eye': () => (<><StandingSubject /><Camera x={70} y={78} aimX={112} aimY={30} /></>),
  'ground-level': () => (<><StandingSubject /><Camera x={36} y={79} aimX={112} aimY={79} /></>),
  // Compositions: where the subject sits in the frame.
  center: () => <Placed x={80} />,
  'left-third': () => <Placed x={53.3} />,
  'right-third': () => <Placed x={106.7} />,
  'cut-left': () => <Placed x={6} />,
  'cut-right': () => <Placed x={154} />,
  'low-in-frame': () => <Placed x={80} top={50} />,
  'frame-within-frame': () => (
    <>
      <path className="fill-gray-700 stroke-gray-500" strokeWidth="1" fillRule="evenodd" d="M0 0H160V90H0ZM58 12H102V90H58Z" />
      <Figure x={80} top={36} scale={0.54} />
    </>
  ),
  'foreground-object': () => (
    <>
      <Figure x={104} top={12} scale={1.4} />
      <ellipse cx="26" cy="66" rx="34" ry="40" className="fill-gray-600" opacity="0.85" />
    </>
  ),
  // Camera moves: what the camera does over the clip.
  static: () => (
    <>
      <StandingSubject />
      <path className="stroke-gray-500" strokeWidth="1.5" strokeLinecap="round" fill="none" d="M30 34L20 84M30 34L30 84M30 34L40 84" />
      <Camera x={32} y={29} aimX={112} aimY={29} />
    </>
  ),
  'push-in': () => (<><StandingSubject /><Camera x={30} y={40} aimX={112} aimY={40} /><Arrow d="M44 56H82" x={82} y={56} deg={0} /></>),
  'pull-out': () => (<><StandingSubject /><Camera x={56} y={40} aimX={112} aimY={40} /><Arrow d="M70 56H22" x={22} y={56} deg={180} /></>),
  pan: () => (
    <>
      <Figure x={80} top={8} scale={0.42} />
      <Camera x={80} y={80} aimX={80} aimY={60} />
      <Arrow d="M50 64Q80 40 110 64" x={110} y={64} deg={40} />
      <Arrow d="M110 64Q80 40 50 64" x={50} y={64} deg={140} />
    </>
  ),
  tilt: () => (
    <>
      <StandingSubject />
      <Camera x={40} y={50} aimX={112} aimY={50} />
      <Arrow d="M62 24Q76 50 62 76" x={62} y={76} deg={115} />
      <Arrow d="M62 76Q76 50 62 24" x={62} y={24} deg={245} />
    </>
  ),
  tracking: () => (
    <>
      <Horizon y={84} />
      <Figure x={80} top={24} scale={0.6} />
      <Arrow d="M96 52H126" x={126} y={52} deg={0} />
      <Camera x={60} y={74} aimX={80} aimY={64} />
      <Arrow d="M74 82H126" x={126} y={82} deg={0} />
    </>
  ),
  handheld: () => (
    <>
      <StandingSubject />
      <g transform="rotate(-8 32 40)"><Camera x={32} y={40} aimX={112} aimY={40} /></g>
      <path className="stroke-port-accent" strokeWidth="1.2" strokeLinecap="round" fill="none" d="M14 24Q18 20 22 24M36 22Q40 18 44 22M14 58Q18 62 22 58M36 60Q40 64 44 60" />
    </>
  ),
  crane: () => (
    <>
      <StandingSubject />
      <path className="stroke-gray-500" strokeWidth="2" strokeLinecap="round" fill="none" d="M14 84L20 70L46 22" />
      <Camera x={46} y={18} aimX={112} aimY={46} />
      <Arrow d="M30 70L52 36" x={52} y={36} deg={-57} />
    </>
  ),
  orbit: () => (
    <>
      <ellipse cx="80" cy="44" rx="56" ry="28" className="stroke-gray-500" strokeWidth="1" strokeDasharray="3 3" fill="none" />
      <circle cx="80" cy="44" r="8" className="fill-port-card stroke-current" strokeWidth="1.5" />
      <Camera x={80} y={78} aimX={80} aimY={52} />
      <Arrow d="M112 69Q130 62 135 48" x={135} y={48} deg={-70} />
    </>
  ),
  // Lenses: the field of view, seen from above.
  'wide-angle': () => <FieldOfView half={40} />,
  normal: () => <FieldOfView half={22} />,
  telephoto: () => <FieldOfView half={8} />,
  // Focus: is the background sharp?
  'shallow-focus': ({ blurId }) => (
    <>
      <filter id={blurId}><feGaussianBlur stdDeviation="2.5" /></filter>
      <Horizon y={74} />
      <Backdrop filter={`url(#${blurId})`} />
      <Figure x={56} top={14} scale={1.15} />
    </>
  ),
  'deep-focus': () => (
    <>
      <Horizon y={74} />
      <Backdrop />
      <Figure x={56} top={14} scale={1.15} />
    </>
  ),
  // Eyelines: where the subject looks.
  'into-lens': () => <Eyes />,
  'off-left': () => <Eyes dx={-4.5} />,
  'off-right': () => <Eyes dx={4.5} />,
  'looking-down': () => <Eyes dy={2.5} />,
  'looking-up': () => <Eyes dy={-2.5} />,
  // Facings: which way the subject turns, seen from above.
  front: () => <TopDownSubject deg={0} />,
  'three-quarter': () => <TopDownSubject deg={45} />,
  profile: () => <TopDownSubject deg={90} />,
  'three-quarter-back': () => <TopDownSubject deg={135} />,
  back: () => <TopDownSubject deg={180} />,
  dutch: () => (
    <g transform="rotate(-14 80 45)">
      <path className="stroke-gray-500" strokeWidth="1" fill="none" d="M-40 70H200" />
      <Figure x={80} top={14} scale={1.2} />
    </g>
  ),
};

/**
 * Code-drawn concept sketch of one storyboard shot-grammar value: a framing,
 * angle, facing, composition, camera move, lens, focus or eyeline from
 * `shotGrammar.js`. The vocabularies share no value, so `kind` alone picks the
 * scene. An unknown kind draws an empty frame.
 */
export default function ShotDiagram({ kind, className = '' }) {
  const Scene = SCENES[kind];
  // Several diagrams render on one page, so a filter id must be unique.
  const blurId = useId();
  // The svg viewport clips the oversized close-up figures.
  return (
    <svg viewBox="0 0 160 90" className={className} aria-hidden="true" focusable="false">
      <rect width="160" height="90" rx="4" className="fill-port-bg" />
      {Scene ? <Scene blurId={blurId} /> : null}
      <rect x="1" y="1" width="158" height="88" rx="3.5" fill="none" strokeWidth="2"
        className={Scene ? 'stroke-gray-500' : 'stroke-gray-600'} strokeDasharray={Scene ? undefined : '6 5'} />
    </svg>
  );
}
