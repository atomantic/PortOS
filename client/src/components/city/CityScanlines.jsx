import { useState, useEffect } from 'react';

// CSS CRT overlay (scanlines + neon edge-glow + vignette) for the city scene.
// Each piece is opted in per theme via the `crt` profile (see deriveCrtProfile in
// cityConstants) — scanlines and neon glow are cyber/terminal affectations, not
// universal, so clean themes (e.g. glass) get little or nothing. Glow color comes
// from the live --port-accent var so it tracks the active theme. All layers sit
// at z-10, below the HUD (z-20), so they only treat the 3D scene, not the panels.
export default function CityScanlines({ settings, crt }) {
  const profile = crt || { scanlines: true, glow: true, vignette: true };
  // The user toggle can only switch scanlines OFF for a theme that supports them;
  // it can't force them onto a non-terminal theme (they'd be off-style there).
  const scanlines = profile.scanlines && (settings?.scanlineOverlay ?? true);

  // Random subtle brightness flicker like a CRT monitor (only while scanlines on)
  const [flicker, setFlicker] = useState(1);
  useEffect(() => {
    if (!scanlines) return;
    const interval = setInterval(() => {
      setFlicker(0.97 + Math.random() * 0.03);
    }, 150);
    return () => clearInterval(interval);
  }, [scanlines]);

  return (
    <>
      {scanlines && (
        <div
          className="absolute inset-0 pointer-events-none z-10"
          style={{
            backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.05) 0px, rgba(0,0,0,0.05) 1px, transparent 1px, transparent 3px)',
            backgroundSize: '100% 3px',
            mixBlendMode: 'multiply',
            opacity: flicker,
          }}
        />
      )}

      {profile.vignette && (
        <div
          className="absolute inset-0 pointer-events-none z-10"
          style={{
            background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.35) 100%)',
          }}
        />
      )}

      {profile.glow && (
        <>
          {/* Chromatic-aberration-style edge glow, tinted to the theme accent */}
          <div
            className="absolute inset-0 pointer-events-none z-10 opacity-[0.025]"
            style={{
              boxShadow: 'inset 0 0 120px 30px rgb(var(--port-accent) / 0.4), inset 0 0 60px 12px rgb(var(--port-accent) / 0.2)',
            }}
          />
          {/* Top + bottom neon strips */}
          <div
            className="absolute top-0 left-0 right-0 h-px pointer-events-none z-10"
            style={{
              background: 'linear-gradient(90deg, transparent, rgb(var(--port-accent) / 0.15) 30%, rgb(var(--port-accent) / 0.3) 50%, rgb(var(--port-accent) / 0.15) 70%, transparent)',
            }}
          />
          <div
            className="absolute bottom-0 left-0 right-0 h-px pointer-events-none z-10"
            style={{
              background: 'linear-gradient(90deg, transparent, rgb(var(--port-accent) / 0.1) 30%, rgb(var(--port-accent) / 0.22) 50%, rgb(var(--port-accent) / 0.1) 70%, transparent)',
            }}
          />
        </>
      )}
    </>
  );
}
