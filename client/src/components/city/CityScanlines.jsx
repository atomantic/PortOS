import { useState, useEffect } from 'react';

// CSS-based CRT scanline + vignette overlay for cyberpunk atmosphere
export default function CityScanlines({ settings }) {
  const [flicker, setFlicker] = useState(1);
  const enabled = settings?.scanlineOverlay ?? true;

  // Random subtle brightness flicker like a CRT monitor
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      setFlicker(0.97 + Math.random() * 0.03);
    }, 150);
    return () => clearInterval(interval);
  }, [enabled]);

  if (!enabled) {
    // Still render vignette and edge glow even when scanlines are off
    return (
      <>
        <div
          className="absolute inset-0 pointer-events-none z-10"
          style={{
            background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.5) 100%)',
          }}
        />
        <div
          className="absolute top-0 left-0 right-0 h-px pointer-events-none z-10"
          style={{
            background: 'linear-gradient(90deg, transparent, rgba(6,182,212,0.15) 30%, rgba(6,182,212,0.3) 50%, rgba(6,182,212,0.15) 70%, transparent)',
          }}
        />
        <div
          className="absolute bottom-0 left-0 right-0 h-px pointer-events-none z-10"
          style={{
            background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.15) 30%, rgba(139,92,246,0.3) 50%, rgba(139,92,246,0.15) 70%, transparent)',
          }}
        />
      </>
    );
  }

  return (
    <>
      {/* Scanline overlay */}
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{
          backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.05) 0px, rgba(0,0,0,0.05) 1px, transparent 1px, transparent 3px)',
          backgroundSize: '100% 3px',
          mixBlendMode: 'multiply',
          opacity: flicker,
        }}
      />
      {/* Vignette effect - stronger */}
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.5) 100%)',
        }}
      />
      {/* Chromatic aberration glow at edges */}
      <div
        className="absolute inset-0 pointer-events-none z-10 opacity-[0.025]"
        style={{
          boxShadow: 'inset 0 0 120px 30px rgba(6, 182, 212, 0.4), inset 0 0 80px 15px rgba(139, 92, 246, 0.3), inset 0 0 40px 10px rgba(236, 72, 153, 0.15)',
        }}
      />
      {/* Edge glow lines - top and bottom neon strips */}
      <div
        className="absolute top-0 left-0 right-0 h-px pointer-events-none z-10"
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(6,182,212,0.15) 30%, rgba(6,182,212,0.3) 50%, rgba(6,182,212,0.15) 70%, transparent)',
        }}
      />
      <div
        className="absolute bottom-0 left-0 right-0 h-px pointer-events-none z-10"
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.15) 30%, rgba(139,92,246,0.3) 50%, rgba(139,92,246,0.15) 70%, transparent)',
        }}
      />
    </>
  );
}
