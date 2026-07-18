import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { computeAgeView, diffXp, birthDateCta } from '../../utils/characterXp';

// CyberCity character HUD badge (roadmap 2.11; reframed in #2673). A compact floating panel
// showing the current **age-based level** (life experience = age) and a progress bar =
// fractional part of the current year of life (progress toward the next birthday), plus HP
// when known. useCityData polls the character on an interval; this component still diffs
// successive snapshots and fires a transient flash on XP gain (xp survives as a cumulative
// stat) — a louder, longer celebratory flash when the level ticks up (a birthday).
//
// Animations are self-contained (transient state + inline transition) so the component
// stays standalone and doesn't depend on global keyframes.
export default function CityXpBadge({ character }) {
  const navigate = useNavigate();
  const view = useMemo(() => computeAgeView(character), [character]);

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
    // Fire on an XP gain (cyan) OR a birthday age-level tick (amber) — a birthday rarely
    // coincides with an XP gain, so it must be able to burst on its own.
    if (gained <= 0 && !leveledUp) return;

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
  // No usable level → show a prompt instead of NaN and send the click to the age editor (where
  // the birth-date field lives). The CTA distinguishes a genuinely unset date ("set") from a
  // present-but-unusable one ("fix" — invalid/future/unreadable), so we never tell the user to
  // set a date they already entered (#2757).
  const cta = view.hasBirthDate ? null : birthDateCta(view.birthDateStatus);
  const levelLabel = view.hasBirthDate ? `LV ${view.level}` : cta.badgeLabel;
  const target = view.hasBirthDate ? '/character' : cta.path;
  // A present-but-unusable date (invalid/future/unreadable) renders in the warning color, matching
  // the CharacterSheet "fix" prompt and the changelog's promise (#2757). Never true while leveling.
  const fixState = cta?.kind === 'fix';

  return (
    <div className="absolute bottom-16 right-3 pointer-events-auto">
      <button
        type="button"
        onClick={() => navigate(target)}
        title={view.hasBirthDate ? 'Open character sheet' : cta.title}
        className={`relative block w-40 sm:w-48 bg-black/85 backdrop-blur-sm border rounded-lg px-3 py-2.5 overflow-hidden text-left transition-all duration-300 hover:bg-cyan-500/10 ${
          leveling
            ? 'border-amber-400/70 shadow-[0_0_16px_rgba(245,158,11,0.5)]'
            : fixState
              ? 'border-port-warning/60 shadow-[0_0_12px_rgba(245,158,11,0.35)]'
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
              className={`font-pixel text-base tracking-wider ${leveling ? 'text-amber-300' : fixState ? 'text-port-warning' : 'text-cyan-300'}`}
              style={{ textShadow: leveling ? '0 0 10px rgba(245,158,11,0.7)' : fixState ? '0 0 8px rgba(245,158,11,0.5)' : '0 0 8px rgba(6,182,212,0.5)' }}
            >
              {levelLabel}
            </span>
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

        {/* Progress bar toward the next birthday (fractional part of the current year) */}
        <div className="relative mt-1.5 w-full h-1.5 bg-gray-800/70 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${pct}%`,
              backgroundColor: barColor,
              boxShadow: `0 0 6px ${barColor}`,
            }}
          />
        </div>

        <div className="relative flex items-center justify-between mt-1">
          <span className="font-pixel text-[8px] text-gray-500 tracking-wider">
            {view.hasBirthDate ? `${pct}% TO NEXT` : cta.badgeCaption}
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
