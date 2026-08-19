import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Eye, Hand, LogOut, Zap } from 'lucide-react';

const STICK_TRAVEL = 32;

function clearMobileInput(mobileInputRef) {
  if (!mobileInputRef.current) return;
  mobileInputRef.current.moveX = 0;
  mobileInputRef.current.moveY = 0;
  mobileInputRef.current.lookDeltaX = 0;
  mobileInputRef.current.lookDeltaY = 0;
  mobileInputRef.current.boost = false;
  mobileInputRef.current.jump = false;
}

function HoldButton({ label, hint, icon: Icon, onStart, onEnd, wide = false }) {
  const finish = (event) => {
    event.preventDefault();
    onEnd?.();
  };

  return (
    <button
      type="button"
      aria-label={label}
      className={`openworld-mobile-action ${wide ? 'openworld-mobile-action--wide' : ''}`}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onStart?.();
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onContextMenu={(event) => event.preventDefault()}
    >
      <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
      <span>{label}</span>
      {hint && <small>{hint}</small>}
    </button>
  );
}

export default function OpenWorldMobileControls({
  mobileInputRef,
  playerActionRef,
  onToggleCameraView,
  onToggleExploration,
}) {
  const joystickRef = useRef(null);
  const lookPointRef = useRef(null);
  const [stick, setStick] = useState({ x: 0, y: 0 });

  const writeMovement = useCallback((clientX, clientY) => {
    const bounds = joystickRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const centerX = bounds.left + bounds.width / 2;
    const centerY = bounds.top + bounds.height / 2;
    const radius = Math.max(1, Math.min(bounds.width, bounds.height) / 2 - 24);
    const x = clientX - centerX;
    const y = clientY - centerY;
    const distance = Math.min(radius, Math.hypot(x, y));
    const angle = Math.atan2(y, x);
    const next = {
      x: Math.cos(angle) * distance / radius,
      y: Math.sin(angle) * distance / radius,
    };
    if (distance < radius * 0.12) {
      next.x = 0;
      next.y = 0;
    }
    setStick(next);
    if (mobileInputRef.current) {
      mobileInputRef.current.moveX = next.x;
      mobileInputRef.current.moveY = next.y;
    }
  }, [mobileInputRef]);

  const resetMovement = useCallback(() => {
    setStick({ x: 0, y: 0 });
    if (mobileInputRef.current) {
      mobileInputRef.current.moveX = 0;
      mobileInputRef.current.moveY = 0;
    }
  }, [mobileInputRef]);

  const handleJoystickDown = (event) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    writeMovement(event.clientX, event.clientY);
  };

  const handleLookDown = (event) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    lookPointRef.current = { x: event.clientX, y: event.clientY };
  };

  const handleLookMove = (event) => {
    const previous = lookPointRef.current;
    if (!previous || !mobileInputRef.current) return;
    mobileInputRef.current.lookDeltaX += event.clientX - previous.x;
    mobileInputRef.current.lookDeltaY += event.clientY - previous.y;
    lookPointRef.current = { x: event.clientX, y: event.clientY };
  };

  const handleLookEnd = () => {
    lookPointRef.current = null;
  };

  const setBoost = (active) => {
    if (mobileInputRef.current) mobileInputRef.current.boost = active;
  };

  const setJump = (active) => {
    if (mobileInputRef.current) mobileInputRef.current.jump = active;
  };

  useEffect(() => () => clearMobileInput(mobileInputRef), [mobileInputRef]);

  return (
    <div className="openworld-mobile-controls absolute inset-0 z-30 pointer-events-none" aria-label="Mobile free roam controls">
      <div
        className="openworld-mobile-look-zone"
        role="group"
        aria-label="Drag to look around"
        onPointerDown={handleLookDown}
        onPointerMove={handleLookMove}
        onPointerUp={handleLookEnd}
        onPointerCancel={handleLookEnd}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className="openworld-mobile-look-hint">DRAG TO LOOK</span>
      </div>

      <div
        ref={joystickRef}
        className="openworld-mobile-joystick"
        role="group"
        aria-label="Movement joystick"
        onPointerDown={handleJoystickDown}
        onPointerMove={(event) => writeMovement(event.clientX, event.clientY)}
        onPointerUp={resetMovement}
        onPointerCancel={resetMovement}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span
          className="openworld-mobile-joystick-knob"
          style={{ transform: `translate(calc(-50% + ${stick.x * STICK_TRAVEL}px), calc(-50% + ${stick.y * STICK_TRAVEL}px))` }}
          aria-hidden="true"
        />
        <span className="openworld-mobile-joystick-label" aria-hidden="true">DRIVE</span>
      </div>

      <div className="openworld-mobile-actions pointer-events-auto" role="toolbar" aria-label="Mobile game actions">
        <HoldButton label="BOOST" hint="HOLD" icon={Zap} onStart={() => setBoost(true)} onEnd={() => setBoost(false)} />
        <HoldButton label="JUMP" icon={ArrowUp} onStart={() => setJump(true)} onEnd={() => setJump(false)} />
        <button
          type="button"
          aria-label="Interact with nearby building or warp pad"
          className="openworld-mobile-action openworld-mobile-action--wide"
          onClick={() => playerActionRef.current?.interact?.()}
        >
          <Hand size={18} strokeWidth={1.9} aria-hidden="true" />
          <span>ACTION</span>
        </button>
        <button
          type="button"
          aria-label="Switch camera view"
          className="openworld-mobile-action"
          onClick={onToggleCameraView}
        >
          <Eye size={18} strokeWidth={1.9} aria-hidden="true" />
          <span>VIEW</span>
        </button>
        <button
          type="button"
          aria-label="Fly out to orbital view"
          className="openworld-mobile-action openworld-mobile-action--exit"
          onClick={onToggleExploration}
        >
          <LogOut size={17} strokeWidth={1.9} aria-hidden="true" />
          <span>EXIT</span>
        </button>
      </div>
    </div>
  );
}
