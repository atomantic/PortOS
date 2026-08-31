import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Hand, Zap } from 'lucide-react';

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
      onLostPointerCapture={finish}
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
}) {
  const joystickRef = useRef(null);
  const joystickPointerRef = useRef(null);
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

  const resetMovement = useCallback((event) => {
    if (event && joystickPointerRef.current !== event.pointerId) return;
    joystickPointerRef.current = null;
    setStick({ x: 0, y: 0 });
    if (mobileInputRef.current) {
      mobileInputRef.current.moveX = 0;
      mobileInputRef.current.moveY = 0;
    }
  }, [mobileInputRef]);

  const handleJoystickDown = (event) => {
    event.preventDefault();
    if (joystickPointerRef.current !== null) return;
    joystickPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    writeMovement(event.clientX, event.clientY);
  };

  const handleJoystickMove = (event) => {
    if (joystickPointerRef.current !== event.pointerId) return;
    writeMovement(event.clientX, event.clientY);
  };

  const handleLookDown = (event) => {
    event.preventDefault();
    if (lookPointRef.current) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    lookPointRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const handleLookMove = (event) => {
    const previous = lookPointRef.current;
    if (!previous || previous.pointerId !== event.pointerId || !mobileInputRef.current) return;
    mobileInputRef.current.lookDeltaX += event.clientX - previous.x;
    mobileInputRef.current.lookDeltaY += event.clientY - previous.y;
    lookPointRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const handleLookEnd = (event) => {
    if (event && lookPointRef.current?.pointerId !== event.pointerId) return;
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
        onLostPointerCapture={handleLookEnd}
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
        onPointerMove={handleJoystickMove}
        onPointerUp={resetMovement}
        onPointerCancel={resetMovement}
        onLostPointerCapture={resetMovement}
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
      </div>
    </div>
  );
}
