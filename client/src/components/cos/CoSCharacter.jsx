import { AGENT_STATES } from './constants';

export default function CoSCharacter({ state, speaking }) {
  const stateConfig = AGENT_STATES[state] || AGENT_STATES.sleeping;

  return (
    <div className="relative w-44 h-56 md:w-56 md:h-72">
      <svg viewBox="0 0 200 240" className="cos-character w-full h-auto">
        <defs>
          <linearGradient id="bodyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#1e293b" />
            <stop offset="100%" stopColor="#0f172a" />
          </linearGradient>
          <linearGradient id="screenGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={stateConfig.color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={stateConfig.color} stopOpacity="0.1" />
          </linearGradient>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
          <filter id="innerGlow">
            <feGaussianBlur stdDeviation="2" result="blur"/>
            <feComposite in="SourceGraphic" in2="blur" operator="over"/>
          </filter>
        </defs>

        {/* Particles */}
        <g className={`particles particles-${state}`}>
          {[
            { cx: 30, cy: 50 },
            { cx: 170, cy: 60 },
            { cx: 25, cy: 130 },
            { cx: 175, cy: 140 },
            { cx: 40, cy: 200 },
            { cx: 160, cy: 190 }
          ].map((pos, i) => (
            <circle
              key={i}
              cx={pos.cx}
              cy={pos.cy}
              r="2"
              fill={stateConfig.color}
              opacity="0.6"
              className={`cos-particle cos-particle-${i}`}
            />
          ))}
        </g>

        {/* Body */}
        <rect x="50" y="90" width="100" height="120" rx="20" fill="url(#bodyGrad)" stroke="#334155" strokeWidth="2" />

        {/* Chest Screen */}
        <rect x="60" y="100" width="80" height="50" rx="8" fill="#0f172a" stroke={stateConfig.color} strokeWidth="1" opacity="0.8" />
        <rect x="65" y="105" width="70" height="40" rx="5" fill="url(#screenGrad)" />

        {/* Chest Display Content */}
        <g className="chest-display">
          {state === 'coding' && (
            <g className="code-lines">
              {[0, 1, 2, 3].map(i => (
                <rect key={i} x="70" y={110 + i * 8} width={30 + (i % 2) * 15} height="3" rx="1" fill={stateConfig.color} opacity="0.8" className={`code-line code-line-${i}`} />
              ))}
            </g>
          )}
          {state === 'thinking' && (
            <g className="thinking-dots">
              {[0, 1, 2].map(i => (
                <circle key={i} cx={85 + i * 15} cy="125" r="4" fill={stateConfig.color} className={`thinking-dot thinking-dot-${i}`} />
              ))}
            </g>
          )}
          {state === 'planning' && (
            <g className="plan-grid">
              {[0, 1, 2].map(row =>
                [0, 1, 2].map(col => (
                  <rect key={`${row}-${col}`} x={72 + col * 20} y={108 + row * 12} width="15" height="8" rx="2" fill={stateConfig.color} opacity={0.4 + ((row + col) % 3) * 0.2} className="plan-cell" />
                ))
              )}
            </g>
          )}
          {state === 'investigating' && (
            <g className="scan-line-group">
              <line x1="70" y1="125" x2="130" y2="125" stroke={stateConfig.color} strokeWidth="2" className="scan-line" />
            </g>
          )}
          {state === 'reviewing' && (
            <g className="review-checks">
              {[0, 1, 2].map(i => (
                <path key={i} d={`M${75 + i * 20},125 l4,4 l8,-8`} stroke={stateConfig.color} strokeWidth="2" fill="none" className={`check check-${i}`} />
              ))}
            </g>
          )}
          {state === 'ideating' && (
            <g className="lightbulb">
              <ellipse cx="100" cy="120" rx="12" ry="15" fill={stateConfig.color} opacity="0.3" className="bulb-glow" />
              <ellipse cx="100" cy="120" rx="8" ry="10" fill={stateConfig.color} className="bulb" />
            </g>
          )}
          {state === 'sleeping' && (
            <g className="zzz">
              <text x="80" y="130" fill={stateConfig.color} fontSize="16" fontFamily="monospace" className="cos-z cos-z-1">Z</text>
              <text x="95" y="120" fill={stateConfig.color} fontSize="12" fontFamily="monospace" className="cos-z cos-z-2">z</text>
              <text x="105" y="112" fill={stateConfig.color} fontSize="8" fontFamily="monospace" className="cos-z cos-z-3">z</text>
            </g>
          )}
        </g>

        {/* Arms */}
        <rect x="30" y="100" width="18" height="60" rx="9" fill="url(#bodyGrad)" stroke="#334155" strokeWidth="2" className={`arm arm-left arm-${state}`} />
        <rect x="152" y="100" width="18" height="60" rx="9" fill="url(#bodyGrad)" stroke="#334155" strokeWidth="2" className={`arm arm-right arm-${state}`} />

        {/* Hands */}
        <circle cx="39" cy="165" r="10" fill="url(#bodyGrad)" stroke="#334155" strokeWidth="2" className={`hand hand-left hand-${state}`} />
        <circle cx="161" cy="165" r="10" fill="url(#bodyGrad)" stroke="#334155" strokeWidth="2" className={`hand hand-right hand-${state}`} />

        {/* Head */}
        <rect x="55" y="20" width="90" height="75" rx="15" fill="url(#bodyGrad)" stroke="#334155" strokeWidth="2" />

        {/* Face Screen */}
        <rect x="62" y="28" width="76" height="55" rx="10" fill="#0f172a" stroke={stateConfig.color} strokeWidth="1.5" filter="url(#innerGlow)" />

        {/* Eyes */}
        <g className={`eyes eyes-${state}`}>
          {state === 'sleeping' ? (
            <>
              <line x1="75" y1="50" x2="90" y2="50" stroke={stateConfig.color} strokeWidth="3" strokeLinecap="round" />
              <line x1="110" y1="50" x2="125" y2="50" stroke={stateConfig.color} strokeWidth="3" strokeLinecap="round" />
            </>
          ) : (
            <>
              <ellipse cx="82" cy="48" rx="10" ry={state === 'investigating' ? 12 : 8} fill={stateConfig.color} filter="url(#glow)" className="eye eye-left" />
              <ellipse cx="118" cy="48" rx="10" ry={state === 'investigating' ? 12 : 8} fill={stateConfig.color} filter="url(#glow)" className="eye eye-right" />
              <circle cx="82" cy="48" r="3" fill="#0f172a" className="pupil pupil-left" />
              <circle cx="118" cy="48" r="3" fill="#0f172a" className="pupil pupil-right" />
            </>
          )}
        </g>

        {/* Mouth */}
        <g className={`mouth mouth-${state} ${speaking ? 'speaking' : ''}`}>
          {speaking ? (
            <ellipse cx="100" cy="70" rx="12" ry="6" fill={stateConfig.color} opacity="0.8" className="mouth-open" />
          ) : state === 'sleeping' ? (
            <ellipse cx="100" cy="68" rx="8" ry="3" fill={stateConfig.color} opacity="0.5" />
          ) : (
            <path d="M88,68 Q100,78 112,68" stroke={stateConfig.color} strokeWidth="2" fill="none" strokeLinecap="round" />
          )}
        </g>

        {/* Antenna */}
        <line x1="100" y1="20" x2="100" y2="5" stroke="#334155" strokeWidth="3" />
        <circle cx="100" cy="5" r="5" fill={stateConfig.color} filter="url(#glow)" className="antenna-light" />

        {/* Status Light */}
        <circle cx="148" cy="35" r="4" fill={stateConfig.color} filter="url(#glow)" className="status-light" />
      </svg>
    </div>
  );
}
