import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { computeXpView, diffXp } from '../../utils/characterXp';

// CyberCity character XP HUD badge (roadmap 2.11). A compact floating panel showing the
// current level + an XP progress bar toward the next level (and HP when known). Since
// there's no XP-gain socket event, useCityData polls the character on an interval; this
// component diffs successive snapshots and fires a transient flash on XP gain — a louder,
// longer celebratory flash on level-up.
//
// Animations are self-contained (transient state + inline transition) so the component
// stays standalone and doesn't depend on global keyframes.
export default function CityXpBadge({ character }) {
  const navigate = useNavigate();
  const view = useMemo(() => computeXpView(character), [character]);

  const prevCharRef = useRef(null);
  // burst.kind: null | 'gain' | 'levelup' — drives the flash overlay; burst.seq forces a
  // re-trigger even when two consecutive bursts are the same kind.
  const [burst, setBurst] = useState({ kind: null, seq: 0, gained: 0 });
  const burstTimerRef = useRef(null);

  useEffect(() => {
    const prev = prevCharRef.current;
    prevCharRef.current = character;
    if (!character) return;

    const { gained, leveledUp } = diffXp(prev, character);
    if (gained <= 0) return;

    setBurst(b => ({ kind: leveledUp ? 'levelup' : 'gain', seq: b.seq + 1, gained }));
    clearTimeout(burstTimerRef.current);
    burstTimerRef.current = setTimeout(
      () => setBurst(b => ({ ...b, kind: null })),
      leveledUp ? 2200 : 1100,
    );
  }, [character]);

  // Clear the pending flash timer on unmount so it can't fire into a dead component.
  useEffect(() => () => clearTimeout(burstTimerRef.current), []);

  // Render nothing until we have a real character — avoids a flash of a zeroed badge
  // before the first poll lands (absent vs. a legitimate level-1 zero-XP character).
  if (!character) return null;

  const leveling = burst.kind === 'levelup';
  const gaining = burst.kind !== null;
  const barColor = leveling ? '#f59e0b' : '#06b6d4';
  const pct = Math.round(view.progress * 100);

  return (
    <div className="absolute bottom-16 right-3 pointer-events-auto">
      <button
        type="button"
        onClick={() => navigate('/character')}
        title="Open character sheet"
        className={`relative block w-40 sm:w-48 bg-black/85 backdrop-blur-sm border rounded-lg px-3 py-2.5 overflow-hidden text-left transition-all duration-300 hover:bg-cyan-500/10 ${
          leveling
            ? 'border-amber-400/70 shadow-[0_0_16px_rgba(245,158,11,0.5)]'
            : gaining
              ? 'border-cyan-400/70 shadow-[0_0_12px_rgba(6,182,212,0.45)]'
              : 'border-cyan-500/30'
        }`}
      >
        {/* Transient flash overlay keyed on burst.seq so it re-mounts each gain */}
        {gaining && (
          <div
            key={burst.seq}
            className="absolute inset-0 pointer-events-none"
            style={{
              background: leveling
                ? 'radial-gradient(circle at 50% 50%, rgba(245,158,11,0.45), transparent 70%)'
                : 'radial-gradient(circle at 50% 50%, rgba(6,182,212,0.35), transparent 70%)',
              animation: leveling ? 'cos-pulse 0.55s ease-in-out 3' : 'cos-pulse 0.5s ease-in-out 2',
            }}
          />
        )}

        <div className="relative flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={`font-pixel text-base tracking-wider ${leveling ? 'text-amber-300' : 'text-cyan-300'}`}
              style={{ textShadow: leveling ? '0 0 10px rgba(245,158,11,0.7)' : '0 0 8px rgba(6,182,212,0.5)' }}
            >
              LV {view.level}
            </span>
            {view.atMax && (
              <span className="font-pixel text-[8px] text-amber-400/80 tracking-wider">MAX</span>
            )}
          </div>
          {gaining && burst.gained > 0 && (
            <span
              className={`font-pixel text-[10px] tracking-wide ${leveling ? 'text-amber-300' : 'text-emerald-400'}`}
              style={{ textShadow: '0 0 6px currentColor' }}
            >
              +{burst.gained}
            </span>
          )}
        </div>

        {/* XP progress bar toward next level */}
        <div className="relative mt-1.5 w-full h-1.5 bg-gray-800/70 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${view.atMax ? 100 : pct}%`,
              backgroundColor: barColor,
              boxShadow: `0 0 6px ${barColor}`,
            }}
          />
        </div>

        <div className="relative flex items-center justify-between mt-1">
          <span className="font-pixel text-[8px] text-gray-500 tracking-wider">
            {view.atMax ? 'MAX LEVEL' : `${view.xpIntoLevel}/${view.xpForNextLevel} XP`}
          </span>
          {view.hp != null && view.maxHp != null && (
            <span
              className={`font-pixel text-[8px] tracking-wider ${
                view.maxHp > 0 && view.hp / view.maxHp <= 0.25 ? 'text-red-400' : 'text-rose-300/70'
              }`}
            >
              {view.hp}/{view.maxHp} HP
            </span>
          )}
        </div>
      </button>
    </div>
  );
}
