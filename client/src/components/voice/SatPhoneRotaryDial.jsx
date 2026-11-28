import { useRef } from 'react';

const MIN_ANGLE = -135;
const MAX_ANGLE = 135;
const PIP_COUNT = 11;

const clampPercent = (value) => Math.max(0, Math.min(100, Math.round(value)));

/**
 * Tactile machined rotary volume dial for the PortOS Sat-Phone Transceiver.
 * Controls real Web Audio output gain (0-100%) via pointer drag, scroll wheel,
 * or keyboard arrows; double-clicking toggles mute.
 */
export default function SatPhoneRotaryDial({
  volume,
  muted,
  onVolumeChange,
  onToggleMute,
  size = 'md',
}) {
  const dragRef = useRef(null);
  const percent = clampPercent(volume * 100);
  const effectivePercent = muted ? 0 : percent;
  const angle = MIN_ANGLE + (effectivePercent / 100) * (MAX_ANGLE - MIN_ANGLE);
  const isCompact = size === 'sm';
  const ringSize = isCompact ? 62 : 74;
  const knobSize = isCompact ? 42 : 50;
  const pipRadius = isCompact ? 28 : 33;

  const commitPercent = (nextPct) => {
    const clamped = clampPercent(nextPct);
    if (muted && clamped > 0 && onToggleMute) onToggleMute(false);
    onVolumeChange(clamped / 100);
  };

  const handlePointerDown = (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus();
    dragRef.current = { startY: event.clientY, startX: event.clientX, startPct: percent };
  };

  const handlePointerMove = (event) => {
    if (!dragRef.current) return;
    const dy = dragRef.current.startY - event.clientY;
    const dx = event.clientX - dragRef.current.startX;
    // Vertical drag is primary; small horizontal assist makes diagonal drags feel natural.
    const delta = Math.round((dy + dx * 0.35) * 0.8);
    commitPercent(dragRef.current.startPct + delta);
  };

  const handlePointerEnd = (event) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleWheel = (event) => {
    event.preventDefault();
    const step = event.deltaY < 0 ? 5 : -5;
    commitPercent(percent + step);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
      event.preventDefault();
      commitPercent(percent + 5);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
      event.preventDefault();
      commitPercent(percent - 5);
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      commitPercent(percent + 15);
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      commitPercent(percent - 15);
    } else if (event.key === 'Home') {
      event.preventDefault();
      commitPercent(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      commitPercent(100);
    } else if (event.key === 'm' || event.key === 'M') {
      event.preventDefault();
      onToggleMute?.();
    }
  };

  const pips = Array.from({ length: PIP_COUNT }, (_, idx) => {
    const ratio = idx / (PIP_COUNT - 1);
    const pipAngle = (MIN_ANGLE + ratio * (MAX_ANGLE - MIN_ANGLE) - 90) * (Math.PI / 180);
    const cx = ringSize / 2 + Math.cos(pipAngle) * pipRadius;
    const cy = ringSize / 2 + Math.sin(pipAngle) * pipRadius;
    const lit = !muted && effectivePercent >= ratio * 100 && effectivePercent > 0;
    return { idx, cx, cy, lit };
  });

  return (
    <div className="flex flex-col items-center gap-1 select-none shrink-0">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Output volume"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={effectivePercent}
        aria-valuetext={muted ? 'Muted' : `${percent}%`}
        title={muted ? 'Output muted — drag, scroll, or double-click to unmute' : `Output volume ${percent}% — drag, scroll, or double-click to mute`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onDoubleClick={() => onToggleMute?.()}
        style={{ width: ringSize, height: ringSize }}
        className="touch-none relative flex items-center justify-center rounded-full cursor-ns-resize focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent"
      >
        {/* Calibrated radial LED pip arc */}
        <svg
          aria-hidden="true"
          width={ringSize}
          height={ringSize}
          viewBox={`0 0 ${ringSize} ${ringSize}`}
          className="pointer-events-none absolute inset-0"
        >
          {pips.map((pip) => (
            <circle
              key={pip.idx}
              cx={pip.cx}
              cy={pip.cy}
              r={pip.lit ? 2.1 : 1.5}
              className={pip.lit ? 'fill-port-accent' : 'fill-port-border'}
              opacity={pip.lit ? 0.95 : 0.7}
            />
          ))}
        </svg>

        {/* Knurled rotating machined dial */}
        <div
          aria-hidden="true"
          style={{
            width: knobSize,
            height: knobSize,
            transform: `rotate(${angle}deg)`,
          }}
          className="satphone-dial-body relative rounded-full border transition-transform duration-75"
        >
          {/* Inner recessed face */}
          <div className="absolute inset-1.5 rounded-full border border-port-border/50" />
          {/* Luminous position indicator notch */}
          <span
            className={`absolute left-1/2 top-1.5 h-3 w-1 -translate-x-1/2 rounded-full ${
              muted ? 'bg-port-error/80' : 'bg-port-accent shadow-[0_0_6px_rgb(var(--port-accent)/0.8)]'
            }`}
          />
        </div>
      </div>
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-port-text-muted">
        {muted ? 'MUTE' : `VOL ${percent}`}
      </span>
    </div>
  );
}
